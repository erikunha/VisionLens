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
  type RecordedVisionEmbedSuccess,
  type WorkerClientOptions,
} from '../worker/index.js';
import type { PythonRouteConfig } from '../config/index.js';
import {
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
    let route: ReturnType<typeof requireFacadeRoute>;
    try {
      route = requireFacadeRoute('vision.embed', this.options.route);
    } catch (error) {
      return this.refusal(error);
    }
    void route;

    const fingerprint = fingerprintOfRequest(request);
    let previous: FacadeRun | undefined;
    try {
      previous = this.ledger.find(request.idempotencyKey, fingerprint);
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
    this.ledger.register(run);
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

      const validated = await validateEmbeddingArtifact({
        artifactRoot: this.options.route?.artifactRoot ?? '',
        embeddingRunId: success.result.embeddingRunId,
        sha256: success.result.artifactSha256,
        count: success.result.count,
        dimensions: success.result.dimensions,
        dtype: success.result.dtype,
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
        transformFingerprint,
        contractVersion: this.options.contractVersion ?? CONTRACTS_VERSION,
        protocolVersion: client.hello.protocolVersion,
      };

      if (this.options.sink) {
        const commit: FacadeArtifactCommit = {
          kind: 'embedding',
          sourceAssetIds: request.assets.map((asset) => asset.assetId),
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
   * Launches the worker.
   *
   * The artifact root travels to the worker in its environment, so the root
   * the facade validates the artifact under and the root the worker writes
   * under are the same root by construction.
   */
  private async launch(): Promise<WorkerClient> {
    const artifactRoot = this.options.route?.artifactRoot ?? '';
    const env: NodeJS.ProcessEnv = { ...this.options.env };
    if (artifactRoot.length > 0) {
      env[WORKER_ARTIFACT_ROOT_ENV] = artifactRoot;
    }
    const options: WorkerClientOptions = {
      env,
      ...(this.options.interpreter !== undefined
        ? { interpreter: this.options.interpreter }
        : {}),
      ...(this.options.scriptPath !== undefined ? { scriptPath: this.options.scriptPath } : {}),
      ...(this.options.scriptArgs !== undefined ? { scriptArgs: this.options.scriptArgs } : {}),
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
        return {
          ok: false,
          error: new FacadeError(
            'ARTIFACT_INVALID',
            `the result of the run does not have the shape the operation promises: ${error.message}`,
            { cause: error },
          ),
        };
      }
      return { ok: false, error: this.failureOf(error) };
    }
  }

  /**
   * Maps a failure of the LAUNCH to a typed error.
   *
   * A worker that could not be started, or that never answered its hello,
   * is UNAVAILABLE: nothing the worker said was wrong, the channel itself
   * failed. A hello that broke the wire contract keeps its own code, because
   * that is a fact about the worker and not about the machine.
   */
  private launchFailureOf(error: unknown): FacadeError {
    if (error instanceof FacadeError) return error;
    if (error instanceof WorkerProtocolError) {
      return new FacadeError(error.code, error.message, { cause: error });
    }
    return new FacadeError(
      'WORKER_UNAVAILABLE',
      `the worker process could not be started: ${messageOf(error)}`,
      { cause: error },
    );
  }

  /** Maps a failure of the channel or of the worker to a typed error. */
  private failureOf(error: unknown): FacadeError {
    if (error instanceof FacadeError) return error;
    if (error instanceof WorkerProtocolError) {
      return new FacadeError(error.code, error.message, { cause: error });
    }
    if (error instanceof WorkerDeadlineError) {
      return new FacadeError('DEADLINE_EXCEEDED', error.message, { cause: error });
    }
    if (error instanceof WorkerLaunchError) {
      return new FacadeError('WORKER_UNAVAILABLE', error.message, { cause: error });
    }
    return new FacadeError('WORKER_CRASHED', messageOf(error), { cause: error });
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
  const assets = request.assets
    .map((asset) => ({ assetId: asset.assetId, path: asset.path }))
    .sort((left, right) => (left.assetId < right.assetId ? -1 : 1));
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
 * The outcome of a run that already ended.
 *
 * A repeated key returns the FIRST outcome, whether it was a success or a
 * failure: the work is done once, and a key that names two different
 * requests is a refusal rather than a second run.
 */
function outcomeOf(run: FacadeRun): FacadeEmbeddingOutcome {
  if (run.state === 'succeeded') {
    return { ok: true, result: run.result as FacadeEmbeddingResult, run };
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
