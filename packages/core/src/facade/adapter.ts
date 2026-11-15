import { randomUUID } from 'node:crypto';
import { CONTRACTS_VERSION, fingerprintV2 } from '@vision-lens/contracts';
import {
  buildRecordedVisionEmbedParams,
  parseRecordedVisionEmbedSuccess,
  WorkerClient,
  WorkerDeadlineError,
  WorkerLaunchError,
  WorkerOperationContractError,
  WorkerProtocolError,
  WORKER_INTERPRETER_ENV,
  type RecordedVisionEmbedSuccess,
  type WorkerClientOptions,
} from '../worker/index.js';
import type { PythonRouteConfig } from '../config/index.js';
import {
  digestOfAsset,
  transformFingerprintOf,
  transformNameOf,
  validateEmbeddingArtifact,
} from './artifacts.js';
import { FacadeCapabilityRegistry } from './capabilities.js';
import { FacadeError } from './errors.js';
import { requireFacadeRoute } from './route.js';
import { FacadeRun, FacadeRunLedger } from './run.js';
import type {
  FacadeArtifactCommit,
  FacadeArtifactSink,
  FacadeEmbeddingOutcome,
  FacadeEmbeddingRequest,
  FacadeEmbeddingResult,
  VisionOperationPort,
} from './port.js';

/**
 * The adapter that drives the Python worker.
 *
 * This is the one implementation of {@link VisionOperationPort}, and it is
 * the only place in the TypeScript side that knows how a worker is
 * launched. The order of its steps is the order of the rules of the
 * ticket:
 *
 *  1. the ROUTE is resolved, and a refused route never starts a process;
 *  2. the operation is looked up in the registry, and an unknown operation
 *     is refused instead of guessed;
 *  3. the IDEMPOTENCY key is looked up in the ledger, and a key that was
 *     already used returns the first run without asking the worker again;
 *  4. the worker is LAUNCHED, and a launch that fails is a typed refusal
 *     that names the attempt;
 *  5. the CAPABILITY is registered from the hello the worker spoke, and an
 *     operation the worker did not announce is refused before it runs;
 *  6. the REQUEST is built by the bridge of the operation and sent once;
 *  7. the ARTIFACT is validated on disk, and a mismatch commits nothing;
 *  8. the ROW is committed through the sink, and TypeScript stays the only
 *     writer of the domain.
 *
 * ## There is no paid fallback
 *
 * The adapter never calls a provider. The route failed, the run failed, and
 * the failure is reported. A fallback that nobody asked for is a bill
 * nobody agreed to.
 */

/** The environment variable the Python side reads the artifact root from. */
export const WORKER_ARTIFACT_ROOT_ENV = 'VISIONLENS_WORKER_ARTIFACT_ROOT';

/** The environment variable the Python side reads the asset root from. */
export const WORKER_ASSET_ROOT_ENV = 'VISIONLENS_WORKER_ASSET_ROOT';

/** The environment variable the Python side reads the model registry from. */
export const WORKER_REGISTRY_ENV = 'VISIONLENS_WORKER_REGISTRY';

/** The environment variable the Python side reads the model cache from. */
export const WORKER_MODEL_ROOT_ENV = 'VISIONLENS_WORKER_MODEL_ROOT';

/**
 * The default launch of the worker.
 *
 * The worker is a MODULE of the Python package, so the default is
 * `python3 -m visionlens.worker`: the interpreter comes from the fixed
 * allowlist and the module travels as argv, never through a shell. The
 * package has to be importable by that interpreter, which is what the
 * virtual environment of the package is for.
 */
export const DEFAULT_WORKER_SCRIPT = '-m';
export const DEFAULT_WORKER_ARGS: readonly string[] = ['visionlens.worker'];

/**
 * The environment of the worker that the facade hands over by name.
 *
 * The child process does NOT inherit the environment of the host: the host
 * may carry the keys of a paid provider, and the worker is a different
 * program with a different job. The facade therefore names the variables
 * the worker needs, and the host passes exactly those.
 */
export const WORKER_ENV_NAMES: readonly string[] = [
  WORKER_REGISTRY_ENV,
  WORKER_MODEL_ROOT_ENV,
];

/** The options of the adapter. */
export interface PythonWorkerAdapterOptions {
  /** The route configuration. Without it the route is off. */
  readonly route?: PythonRouteConfig;
  /** The sink that commits the artifact of a run. */
  readonly sink?: FacadeArtifactSink;
  /** The interpreter of the worker; defaults to the one of the worker host. */
  readonly interpreter?: string;
  /** The script of the worker; defaults to the one of the worker host. */
  readonly scriptPath?: string;
  /** Extra argv entries after the script path. */
  readonly scriptArgs?: readonly string[];
  /** Extra environment entries handed to the worker. */
  readonly env?: NodeJS.ProcessEnv;
  /** The contract version the requests are stamped with. */
  readonly contractVersion?: string;
  /** How the worker client is built. The tests replace it with a fake. */
  readonly clientFactory?: (options: WorkerClientOptions) => Promise<WorkerClient>;
  /** How the id of a run is made. The tests replace it with a fixed one. */
  readonly runIdFactory?: () => string;
}

/** The adapter over the Python worker. */
export class PythonWorkerAdapter implements VisionOperationPort {
  private readonly capabilities = new FacadeCapabilityRegistry();
  private readonly ledger = new FacadeRunLedger();
  private readonly options: PythonWorkerAdapterOptions;

  constructor(options: PythonWorkerAdapterOptions = {}) {
    this.options = options;
  }

  /**
   * Runs one embedding and answers a typed outcome.
   *
   * The method never throws for a refusal: the outcome carries the code and
   * the diagnostic, and a caller that ignores the outcome cannot tell a
   * success from a failure by accident.
   */
  async runEmbedding(request: FacadeEmbeddingRequest): Promise<FacadeEmbeddingOutcome> {
    try {
      return await this.execute(request);
    } catch (error) {
      // The port answers a typed outcome and never throws: a caller that
      // trusts the contract must not receive an exception where a refusal
      // belongs.
      return this.refusal(error);
    }
  }

  /** The body of the run, with every refusal answered as an outcome. */
  private async execute(request: FacadeEmbeddingRequest): Promise<FacadeEmbeddingOutcome> {
    let route: ReturnType<typeof requireFacadeRoute>;
    try {
      route = requireFacadeRoute('vision.embed', this.options.route);
    } catch (error) {
      return this.refusal(error);
    }
    void route;

    this.requireRouteConfiguration();

    const fingerprint = fingerprintOfRequest(request);
    let previous: FacadeRun | undefined;
    try {
      previous = this.ledger.find(request.workspaceId, request.idempotencyKey, fingerprint);
    } catch (error) {
      return this.refusal(error);
    }
    if (previous) {
      return outcomeOf(previous);
    }

    const run = new FacadeRun({
      id: this.options.runIdFactory?.() ?? `run-${randomUUID()}`,
      operation: 'vision.embed',
      idempotencyKey: request.idempotencyKey,
      inputFingerprint: fingerprint,
      budget: { maxSeconds: request.budget.maxSeconds },
    });
    this.ledger.register(request.workspaceId, run);
    run.start();

    let client: WorkerClient;
    try {
      client = await this.launch();
    } catch (error) {
      const failure = this.launchFailureOf(error);
      run.fail(failure.code, failure.message);
      return { ok: false, error: failure, run };
    }

    try {
      this.capabilities.register(client.hello);
      this.capabilities.requireOperation('vision.embed');

      const success = await this.embed(client, request);
      if (!success.ok) {
        run.fail(success.error.code, success.error.message, { partial: true });
        return { ok: false, error: success.error, run };
      }

      this.requireKnownErrorSamples(success.result.errorSamples, request);

      const validated = await validateEmbeddingArtifact({
        artifactRoot: this.options.route?.artifactRoot ?? '',
        embeddingRunId: success.result.embeddingRunId,
        sha256: success.result.artifactSha256,
        count: success.result.count,
        dimensions: success.result.dimensions,
        dtype: success.result.dtype,
        ...(await this.expectedAssetDigests(request, success.result.errorSamples)),
      });

      const transformFingerprint = transformFingerprintOf(
        validated.transform,
        request.snapshotId,
      );

      const result: FacadeEmbeddingResult = {
        operation: 'vision.embed',
        embeddingRunId: success.result.embeddingRunId,
        count: success.result.count,
        dimensions: success.result.dimensions,
        dtype: success.result.dtype,
        artifact: validated.reference,
        errorSamples: success.result.errorSamples.map((sample) => ({ ...sample })),
        transformFingerprint,
        contractVersion: this.options.contractVersion ?? CONTRACTS_VERSION,
        protocolVersion: client.hello.protocolVersion,
      };

      if (this.options.sink) {
        const refused = new Set(success.result.errorSamples.map((sample) => sample.assetId));
        const commit: FacadeArtifactCommit = {
          kind: 'embedding',
          // The lineage names the assets the artifact was derived from: the
          // images the run REFUSED are not the sources of the vectors.
          sourceAssetIds: request.assets
            .map((asset) => asset.assetId)
            .filter((assetId) => !refused.has(assetId)),
          sourceSnapshotId: request.snapshotId,
          transform: transformNameOf(validated.transform),
          transformFingerprint,
          relativePath: validated.reference.relativePath,
          sha256: validated.reference.sha256,
          bytes: validated.reference.bytes,
        };
        try {
          await this.options.sink.commit(commit);
        } catch (error) {
          const failure = new FacadeError(
            'STORE_WRITE_FAILED',
            `the artifact of the run was not committed: ${messageOf(error)}`,
            { cause: error },
          );
          run.fail(failure.code, failure.message);
          return { ok: false, error: failure, run };
        }
      }

      run.succeed(result);
      return { ok: true, result, run };
    } catch (error) {
      const failure = this.failureOf(error);
      run.fail(failure.code, failure.message);
      return { ok: false, error: failure, run };
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  /**
   * Requires that the error samples name the assets the run was asked for.
   *
   * A worker that reports a failure for an asset nobody asked for is
   * reporting something the caller cannot check, and a run whose successes
   * and failures do not add up to the request is not the request.
   */
  private requireKnownErrorSamples(
    samples: readonly { readonly assetId: string }[],
    request: FacadeEmbeddingRequest,
  ): void {
    const requested = new Set(request.assets.map((asset) => asset.assetId));
    for (const sample of samples) {
      if (!requested.has(sample.assetId)) {
        throw new FacadeError(
          'ARTIFACT_INVALID',
          `the run reported a failure for the asset "${sample.assetId}", which the request never asked for`,
        );
      }
    }
    if (samples.length > request.assets.length) {
      throw new FacadeError(
        'ARTIFACT_INVALID',
        `the run reported ${samples.length} failures while the request asked for ${request.assets.length} assets`,
      );
    }
  }

  /**
   * The digests of the assets the run was supposed to embed.
   *
   * The digests are computed from the bytes of the assets, resolved against
   * the approved root the worker resolves them against, so the facade and the
   * worker read the same files. The assets the worker refused are left out:
   * the manifest names only the ones it embedded.
   *
   * When the asset root is not configured the check is SKIPPED: the facade
   * cannot know the root the worker used, and a check it cannot perform is
   * not a check.
   */
  private async expectedAssetDigests(
    request: FacadeEmbeddingRequest,
    samples: readonly { readonly assetId: string }[],
  ): Promise<{ expectedAssetDigests?: readonly string[] }> {
    const assetRoot = this.options.route?.assetRoot ?? '';
    if (assetRoot.length === 0) return {};
    const refused = new Set(samples.map((sample) => sample.assetId));
    const digests: string[] = [];
    for (const asset of request.assets) {
      if (refused.has(asset.assetId)) continue;
      digests.push(await digestOfAsset(assetRoot, asset.path));
    }
    return { expectedAssetDigests: digests };
  }

  /**
   * Launches the worker.
   *
   * The artifact root travels to the worker in its environment, so the root
   * the facade validates the artifact under and the root the worker writes
   * under are the same root by construction.
   */
  private async launch(): Promise<WorkerClient> {
    const artifactRoot = this.options.route?.artifactRoot ?? '';
    const assetRoot = this.options.route?.assetRoot ?? '';
    const env: NodeJS.ProcessEnv = { ...this.options.env };
    if (artifactRoot.length > 0) {
      env[WORKER_ARTIFACT_ROOT_ENV] = artifactRoot;
    }
    if (assetRoot.length > 0) {
      env[WORKER_ASSET_ROOT_ENV] = assetRoot;
    }
    // The registry and the cache of the models are the operator's
    // configuration of the worker, and the facade hands them over by name
    // instead of letting the whole environment of the host travel down.
    for (const name of WORKER_ENV_NAMES) {
      const value = process.env[name];
      if (value !== undefined && env[name] === undefined) env[name] = value;
    }
    const options: WorkerClientOptions = {
      env,
      ...(this.options.interpreter !== undefined
        ? { interpreter: this.options.interpreter }
        : {}),
      scriptPath: this.options.scriptPath ?? DEFAULT_WORKER_SCRIPT,
      scriptArgs: this.options.scriptArgs ?? [...DEFAULT_WORKER_ARGS],
      ...(this.options.contractVersion !== undefined
        ? { contractVersion: this.options.contractVersion }
        : {}),
    };
    if (this.options.clientFactory) {
      return this.options.clientFactory(options);
    }
    return WorkerClient.launch(options);
  }

  /**
   * Sends the request and parses the result.
   *
   * The params are built by the bridge of the operation, so the request
   * carries the RECORDED shape and the shape is named by the params.
   */
  private async embed(
    client: WorkerClient,
    request: FacadeEmbeddingRequest,
  ): Promise<
    | { readonly ok: true; readonly result: RecordedVisionEmbedSuccess }
    | { readonly ok: false; readonly error: FacadeError }
  > {
    let params: Record<string, unknown>;
    try {
      params = buildRecordedVisionEmbedParams({
        workspaceId: request.workspaceId,
        assets: request.assets,
        snapshotId: request.snapshotId,
        model: request.model,
        budget: request.budget,
      });
    } catch (error) {
      return {
        ok: false,
        error: new FacadeError('MALFORMED_FRAME', messageOf(error), { cause: error }),
      };
    }

    try {
      const outcome = await client.request({
        operation: 'vision.embed',
        workspaceId: request.workspaceId,
        params,
        budget: request.budget,
      });
      const parsed = parseRecordedVisionEmbedSuccess(outcome.result);
      return { ok: true, result: parsed };
    } catch (error) {
      if (error instanceof WorkerOperationContractError) {
        // A payload that is not the shape the operation promises is a
        // MALFORMED_FRAME, the code the frozen vocabulary owns: it is not an
        // artifact problem, the artifact was never written.
        return {
          ok: false,
          error: new FacadeError(
            'MALFORMED_FRAME',
            `the result of the run does not have the shape the operation promises: ${error.message}`,
            { cause: error },
          ),
        };
      }
      return { ok: false, error: this.failureOf(error) };
    }
  }

  /**
   * Requires the configuration of the route to be complete.
   *
   * The check happens BEFORE the worker is launched: a route without an
   * artifact root cannot validate the artifact it produced, and a run that
   * ends in a refusal after the work was done cost the operator the whole
   * run and left the bytes outside the approved root.
   */
  private requireRouteConfiguration(): void {
    const artifactRoot = this.options.route?.artifactRoot ?? '';
    if (artifactRoot.length === 0) {
      throw new FacadeError(
        'REQUEST_INVALID',
        'the python route has no artifact root, so the artifact of a run could not be validated; set VISION_LENS_PYTHON_ARTIFACT_ROOT',
      );
    }
  }

  /**
   * Maps a failure of the LAUNCH to a typed error.
   *
   * The kind of the failure decides the code, and the kind is computed by
   * the worker module and never guessed here:
   *
   *  - a worker that could not be STARTED is a missing or a broken install:
   *    the same command fails the same way, so it is not retryable;
   *  - a worker that never answered its hello is a transient condition, and
   *    the caller may try again;
   *  - a worker that died is a crash, and the operation is idempotent, so
   *    the caller may try again.
   *
   * The message names the interpreter and the KIND of the failure, and
   * never the path of the script: a local path of the machine is not a fact
   * the caller of the facade needs, and it is not a fact a log should carry.
   */
  private launchFailureOf(error: unknown): FacadeError {
    if (error instanceof FacadeError) return error;
    if (error instanceof WorkerProtocolError) {
      return new FacadeError(error.code, error.message, { cause: error });
    }
    const interpreter =
      this.options.interpreter ?? process.env[WORKER_INTERPRETER_ENV] ?? 'python3';
    const kind = error instanceof WorkerLaunchError ? error.kind : 'spawn-error';
    if (kind === 'worker-died') {
      return new FacadeError(
        'WORKER_CRASHED',
        `the worker died before it could answer (${kind})`,
        { cause: error },
      );
    }
    if (kind === 'handshake-timeout') {
      return new FacadeError(
        'HANDSHAKE_FAILED',
        `the worker did not answer its hello in time (${kind}); the interpreter was "${interpreter}"`,
        { cause: error },
      );
    }
    return new FacadeError(
      'WORKER_UNAVAILABLE',
      `the worker process could not be started: the interpreter "${interpreter}" did not run the worker (${kind})`,
      { cause: error },
    );
  }

  /** Maps a failure of the channel or of the worker to a typed error. */
  private failureOf(error: unknown): FacadeError {
    if (error instanceof FacadeError) return error;
    if (error instanceof WorkerProtocolError) {
      return new FacadeError(error.code, safeMessage(error.message), { cause: error });
    }
    if (error instanceof WorkerDeadlineError) {
      return new FacadeError('DEADLINE_EXCEEDED', safeMessage(error.message), { cause: error });
    }
    if (error instanceof WorkerLaunchError) {
      return new FacadeError('WORKER_UNAVAILABLE', safeMessage(error.message), { cause: error });
    }
    return new FacadeError('WORKER_CRASHED', safeMessage(messageOf(error)), { cause: error });
  }

  /** Answers a refusal that happened before the run existed. */
  private refusal(error: unknown): FacadeEmbeddingOutcome {
    if (error instanceof FacadeError) return { ok: false, error };
    return { ok: false, error: new FacadeError('WORKER_CRASHED', messageOf(error), { cause: error }) };
  }
}

/**
 * The fingerprint of the input of a request.
 *
 * It covers everything that decides what the run produces: the snapshot, the
 * assets and their paths, the model and the workspace. Two requests with the
 * same key and the same fingerprint are the same run.
 */
export function fingerprintOfRequest(request: FacadeEmbeddingRequest): string {
  // The assets are fingerprinted in the ORDER of the request: the worker
  // pairs every vector with its asset by position, so two requests with the
  // same images in a different order are two different runs.
  const assets = request.assets.map((asset) => ({ assetId: asset.assetId, path: asset.path }));
  return fingerprintV2({
    model: request.model,
    promptTemplate: 'embedding',
    taxonomy: assets,
    preprocessing: { snapshotId: request.snapshotId, workspaceId: request.workspaceId },
    dataVersion: request.snapshotId,
    contractsVersion: CONTRACTS_VERSION,
  });
}

/** The message of a failure, without the stack. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A message that is safe to carry in a log.
 *
 * The text of the other side of the boundary reaches the logs of the caller,
 * so it is bounded and the control characters are dropped: a worker that
 * sends a newline or an escape sequence must not be able to forge a log
 * line.
 */
function safeMessage(text: string): string {
  let stripped = '';
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    stripped += code < 0x20 || code === 0x7f ? ' ' : character;
  }
  return stripped.length > 500 ? `${stripped.slice(0, 500)}...` : stripped;
}

/**
 * The outcome of a run that already exists under the same key.
 *
 * A repeated key returns the FIRST outcome, whether it was a success or a
 * failure: the work is done once, and a key that names two different
 * requests is a refusal rather than a second run.
 *
 * A run that has NOT reached a terminal state is a run IN FLIGHT, and the
 * caller is told so: a run in flight is not a crash, and the message of a
 * crash would state something false about the world.
 */
function outcomeOf(run: FacadeRun): FacadeEmbeddingOutcome {
  if (run.state === 'succeeded') {
    return { ok: true, result: run.result as FacadeEmbeddingResult, run };
  }
  if (!run.isTerminal) {
    return {
      ok: false,
      error: new FacadeError(
        'RUN_IN_PROGRESS',
        `the run ${run.id} is still ${run.state}, and the work is done once`,
      ),
      run,
    };
  }
  const failure = run.failure;
  return {
    ok: false,
    error: new FacadeError(
      failure?.code ?? 'WORKER_CRASHED',
      failure?.message ?? 'the run already ended',
    ),
    run,
  };
}
