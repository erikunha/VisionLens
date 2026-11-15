import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { WorkerHelloFrame } from '@vision-lens/contracts';
import { PythonWorkerAdapter } from '../../src/facade/adapter.js';
import type {
  FacadeArtifactCommit,
  FacadeEmbeddingRequest,
} from '../../src/facade/port.js';
import {
  WorkerDeadlineError,
  WorkerLaunchError,
  WorkerProtocolError,
  type WorkerClient,
  type WorkerRequestInput,
} from '../../src/worker/index.js';

/**
 * The adapter of the facade, against a fake worker.
 *
 * The fake answers the channel the way the real worker does, and every
 * refusal of the adapter is checked at the place where it happens: the
 * route before the process, the capability before the request, the artifact
 * before the row.
 */
const FIXTURE_ROOT = join(
  fileURLToPath(new URL('.', import.meta.url)),
  'fixtures',
  'artifact',
);

const FIXTURE_DIGEST =
  '4f706336517e10f7194963241c623af1d5039f4fc74fb3bc9c7479bfeaaf586a';

const FIXTURE_RUN_ID = 'embed-23961656d069411baecac8e1d638b47f';

const ROUTE = {
  enabled: true,
  workspaceId: 'local',
  artifactRoot: FIXTURE_ROOT,
  assetRoot: '',
  maxSeconds: 300,
};

const REQUEST: FacadeEmbeddingRequest = {
  snapshotId: 'snapshot-fixture-0001',
  assets: [{ assetId: 'red', path: 'images/red.jpg' }],
  model: 'siglip2-base',
  workspaceId: 'local',
  budget: { maxSeconds: 300, maxUsdMicro: 0 },
  idempotencyKey: 'key-0001',
};

/** A hello the fake worker speaks. */
function hello(supportedOperations: string[] = ['vision.embed']): WorkerHelloFrame {
  return {
    protocol: 'visionlens.worker.v1',
    kind: 'hello',
    protocolVersion: '1.0.0',
    contractVersion: '1.0.0',
    supportedOperations: supportedOperations as WorkerHelloFrame['supportedOperations'],
    capabilities: { device: 'cpu', extras: ['vision'], models: ['siglip2-base'] },
    maxFrameBytes: 1_048_576,
  };
}

/** The payload of a recorded run. */
function recordedResult(): Record<string, unknown> {
  return {
    embeddingRunId: FIXTURE_RUN_ID,
    count: 6,
    dimensions: 768,
    dtype: 'float32',
    artifactSha256: FIXTURE_DIGEST,
    errorSamples: [],
  };
}

/** A fake worker client that reports every request it received. */
function fakeClient(options?: {
  readonly supportedOperations?: string[];
  readonly result?: Record<string, unknown>;
  readonly onRequest?: (params: Record<string, unknown>) => void;
}): { client: WorkerClient } {
  const client = {
    hello: hello(options?.supportedOperations ?? ['vision.embed']),
    async request(input: WorkerRequestInput) {
      options?.onRequest?.(input.params);
      return {
        requestId: 'request-0001',
        seq: 0,
        result: options?.result ?? recordedResult(),
      };
    },
    async close() {
      return undefined;
    },
  };
  return { client: client as unknown as WorkerClient };
}

/**
 * A gate the test opens by hand.
 *
 * The promise is pending until the test resolves it, and the resolver is
 * captured by the executor of the promise itself, so the holder is a plain
 * function instead of a variable the control flow analysis would narrow to
 * null at the place where the test opens it.
 */
function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = () => {
      done();
    };
  });
  return { promise, resolve };
}

/** A counter of the requests the fake received. */
function counter(): { value: number } {
  return { value: 0 };
}

describe('the adapter of the facade', () => {
  it('refuses the run when the route is off, and starts no process', async () => {
    let launched = 0;
    const adapter = new PythonWorkerAdapter({
      route: { ...ROUTE, enabled: false },
      clientFactory: async () => {
        launched += 1;
        return fakeClient().client;
      },
    });

    const outcome = await adapter.runEmbedding(REQUEST);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('the run should not have succeeded');
    expect(outcome.error.code).toBe('ROUTE_DISABLED');
    expect(outcome.error.exitCode).toBe(3);
    expect(launched).toBe(0);
  });

  it('answers a typed success with a relative, content addressed artifact', async () => {
    const commits: FacadeArtifactCommit[] = [];
    const adapter = new PythonWorkerAdapter({
      route: ROUTE,
      sink: {
        async commit(commit) {
          commits.push(commit);
        },
      },
      clientFactory: async () => fakeClient().client,
    });

    const outcome = await adapter.runEmbedding(REQUEST);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('the run should have succeeded');
    expect(outcome.result.operation).toBe('vision.embed');
    expect(outcome.result.embeddingRunId).toBe(FIXTURE_RUN_ID);
    expect(outcome.result.count).toBe(6);
    expect(outcome.result.dimensions).toBe(768);
    expect(outcome.result.dtype).toBe('float32');
    expect(outcome.result.artifact.relativePath).toBe(
      `artifacts/embedding/${FIXTURE_RUN_ID}`,
    );
    expect(outcome.result.artifact.sha256).toBe(FIXTURE_DIGEST);
    expect(outcome.result.transformFingerprint).toMatch(/^fp2:[0-9a-f]{16}$/);
    expect(outcome.result.protocolVersion).toBe('1.0.0');

    expect(commits).toHaveLength(1);
    expect(commits[0]?.sourceAssetIds).toEqual(['red']);
    expect(commits[0]?.sourceSnapshotId).toBe('snapshot-fixture-0001');
    expect(commits[0]?.transform).toBe(
      'vision.embed/siglip2-base@75de2d55ec2d0b4efc50b3e9ad70dba96a7b2fa2',
    );
  });

  it('asks the worker once for a key that was already used', async () => {
    const seen = counter();
    const adapter = new PythonWorkerAdapter({
      route: ROUTE,
      runIdFactory: () => 'run-fixed',
      clientFactory: async () => {
        const fake = fakeClient({
          onRequest: () => {
            seen.value += 1;
          },
        });
        return fake.client;
      },
    });

    const first = await adapter.runEmbedding(REQUEST);
    const second = await adapter.runEmbedding(REQUEST);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(seen.value).toBe(1);
    if (!first.ok || !second.ok) throw new Error('the run should have succeeded');
    expect(second.result).toEqual(first.result);
    expect(second.run.id).toBe(first.run.id);
  });

  it('refuses a key that was used for another input', async () => {
    const adapter = new PythonWorkerAdapter({
      route: ROUTE,
      clientFactory: async () => fakeClient().client,
    });

    await adapter.runEmbedding(REQUEST);
    const outcome = await adapter.runEmbedding({
      ...REQUEST,
      snapshotId: 'snapshot-other',
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('the run should not have succeeded');
    expect(outcome.error.code).toBe('OPERATION_UNSUPPORTED');
  });

  it('refuses an operation the worker did not announce, before it runs', async () => {
    const seen = counter();
    const adapter = new PythonWorkerAdapter({
      route: ROUTE,
      clientFactory: async () =>
        fakeClient({
          supportedOperations: ['vision.predict'],
          onRequest: () => {
            seen.value += 1;
          },
        }).client,
    });

    const outcome = await adapter.runEmbedding(REQUEST);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('the run should not have succeeded');
    expect(outcome.error.code).toBe('OPERATION_UNSUPPORTED');
    expect(seen.value).toBe(0);
  });

  it('answers WORKER_UNAVAILABLE when the worker cannot be launched', async () => {
    const adapter = new PythonWorkerAdapter({
      route: ROUTE,
      clientFactory: async () => {
        throw new Error('spawn python3 ENOENT');
      },
    });

    const outcome = await adapter.runEmbedding(REQUEST);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('the run should not have succeeded');
    expect(outcome.error.code).toBe('WORKER_UNAVAILABLE');
    // A worker that could not be STARTED is a broken install: the same
    // command fails the same way, so the refusal is not retryable.
    expect(outcome.error.retryable).toBe(false);
    expect(outcome.error.exitCode).toBe(3);
  });

  it('refuses an artifact that does not match, and commits nothing', async () => {
    const commits: FacadeArtifactCommit[] = [];
    const adapter = new PythonWorkerAdapter({
      route: ROUTE,
      sink: {
        async commit(commit) {
          commits.push(commit);
        },
      },
      clientFactory: async () =>
        fakeClient({
          result: { ...recordedResult(), artifactSha256: 'f'.repeat(64) },
        }).client,
    });

    const outcome = await adapter.runEmbedding(REQUEST);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('the run should not have succeeded');
    expect(outcome.error.code).toBe('ARTIFACT_INVALID');
    expect(commits).toHaveLength(0);
  });

  it('refuses a result that does not have the shape of a recorded run', async () => {
    const adapter = new PythonWorkerAdapter({
      route: ROUTE,
      clientFactory: async () =>
        fakeClient({ result: { count: 2 } }).client,
    });

    const outcome = await adapter.runEmbedding(REQUEST);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('the run should not have succeeded');
    // A payload that breaks the contract of the operation is a
    // MALFORMED_FRAME: the artifact was never written, so it is not an
    // artifact problem.
    expect(outcome.error.code).toBe('MALFORMED_FRAME');
  });

  it('answers STORE_WRITE_FAILED when the row was not committed', async () => {
    const adapter = new PythonWorkerAdapter({
      route: ROUTE,
      sink: {
        async commit() {
          throw new Error('the store is busy');
        },
      },
      clientFactory: async () => fakeClient().client,
    });

    const outcome = await adapter.runEmbedding(REQUEST);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('the run should not have succeeded');
    expect(outcome.error.code).toBe('STORE_WRITE_FAILED');
    expect(outcome.error.retryable).toBe(true);
  });

  it('sends the recorded shape, with the assets and the snapshot', async () => {
    let seen: Record<string, unknown> | null = null;
    const adapter = new PythonWorkerAdapter({
      route: ROUTE,
      clientFactory: async () =>
        fakeClient({
          onRequest: (params) => {
            seen = params;
          },
        }).client,
    });

    await adapter.runEmbedding(REQUEST);
    expect(seen).toMatchObject({
      assets: [{ assetId: 'red', path: 'images/red.jpg' }],
      snapshotId: 'snapshot-fixture-0001',
      model: 'siglip2-base',
    });
  });

  it('hands the artifact root to the worker, so the two roots are the same root', async () => {
    let seen: NodeJS.ProcessEnv | undefined;
    const adapter = new PythonWorkerAdapter({
      route: ROUTE,
      interpreter: 'python3',
      scriptPath: 'worker.py',
      contractVersion: '1.0.0',
      clientFactory: async (options) => {
        seen = options.env;
        return fakeClient().client;
      },
    });

    await adapter.runEmbedding(REQUEST);
    expect(seen?.['VISIONLENS_WORKER_ARTIFACT_ROOT']).toBe(FIXTURE_ROOT);
  });

  it('keeps the code of a refusal the worker reported', async () => {
    const adapter = new PythonWorkerAdapter({
      route: ROUTE,
      clientFactory: async () => {
        const fake = fakeClient();
        const client = {
          hello: fake.client.hello,
          async request() {
            throw new WorkerProtocolError(
              'MISSING_EXTRA',
              'the python build lacks the vision extra',
            );
          },
          async close() {
            return undefined;
          },
        };
        return client as unknown as WorkerClient;
      },
    });

    const outcome = await adapter.runEmbedding(REQUEST);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('the run should not have succeeded');
    expect(outcome.error.code).toBe('MISSING_EXTRA');
    expect(outcome.error.exitCode).toBe(4);
  });

  it('answers DEADLINE_EXCEEDED when the budget elapsed', async () => {
    const adapter = new PythonWorkerAdapter({
      route: ROUTE,
      clientFactory: async () => {
        const fake = fakeClient();
        const client = {
          hello: fake.client.hello,
          async request() {
            throw new WorkerDeadlineError('request-0001', 300);
          },
          async close() {
            return undefined;
          },
        };
        return client as unknown as WorkerClient;
      },
    });

    const outcome = await adapter.runEmbedding(REQUEST);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('the run should not have succeeded');
    expect(outcome.error.code).toBe('DEADLINE_EXCEEDED');
    expect(outcome.error.retryable).toBe(false);
  });

  it('answers HANDSHAKE_FAILED when the worker never answered its hello', async () => {
    const adapter = new PythonWorkerAdapter({
      route: ROUTE,
      clientFactory: async () => {
        throw new WorkerLaunchError('handshake-timeout', 'the worker did not answer');
      },
    });

    const outcome = await adapter.runEmbedding(REQUEST);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('the run should not have succeeded');
    expect(outcome.error.code).toBe('HANDSHAKE_FAILED');
    expect(outcome.error.retryable).toBe(true);
    expect(outcome.error.exitCode).toBe(3);
  });

  it('answers WORKER_CRASHED when the worker died', async () => {
    const adapter = new PythonWorkerAdapter({
      route: ROUTE,
      clientFactory: async () => {
        throw new WorkerLaunchError('worker-died', 'the worker died');
      },
    });

    const outcome = await adapter.runEmbedding(REQUEST);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('the run should not have succeeded');
    expect(outcome.error.code).toBe('WORKER_CRASHED');
    expect(outcome.error.retryable).toBe(true);
  });

  it('refuses a request that names no asset', async () => {
    const adapter = new PythonWorkerAdapter({
      route: ROUTE,
      clientFactory: async () => fakeClient().client,
    });

    const outcome = await adapter.runEmbedding({ ...REQUEST, assets: [] });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('the run should not have succeeded');
    expect(outcome.error.code).toBe('MALFORMED_FRAME');
  });

  it('refuses a route without an artifact root, and starts no process', async () => {
    let launched = 0;
    const adapter = new PythonWorkerAdapter({
      route: { ...ROUTE, artifactRoot: '' },
      clientFactory: async () => {
        launched += 1;
        return fakeClient().client;
      },
    });

    const outcome = await adapter.runEmbedding(REQUEST);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('the run should not have succeeded');
    expect(outcome.error.code).toBe('REQUEST_INVALID');
    expect(outcome.error.exitCode).toBe(2);
    expect(launched).toBe(0);
  });

  it('answers a typed refusal instead of throwing when the request is invalid', async () => {
    const adapter = new PythonWorkerAdapter({
      route: ROUTE,
      clientFactory: async () => fakeClient().client,
    });

    const outcome = await adapter.runEmbedding({
      ...REQUEST,
      budget: { maxSeconds: 0, maxUsdMicro: 0 },
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('the run should not have succeeded');
    expect(outcome.error.code).toBe('REQUEST_INVALID');
  });

  it('answers RUN_IN_PROGRESS when the same key is already in flight', async () => {
    const gate = deferred();
    const adapter = new PythonWorkerAdapter({
      route: ROUTE,
      clientFactory: async () => {
        const fake = fakeClient();
        const client = {
          hello: fake.client.hello,
          async request(input: WorkerRequestInput) {
            await gate.promise;
            return fake.client.request(input);
          },
          async close() {
            return undefined;
          },
        };
        return client as unknown as WorkerClient;
      },
    });

    const first = adapter.runEmbedding(REQUEST);
    // The second call lands while the first is still in flight.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await adapter.runEmbedding(REQUEST);
    gate.resolve();

    const firstOutcome = await first;
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('the second run should not have succeeded');
    expect(second.error.code).toBe('RUN_IN_PROGRESS');
    expect(firstOutcome.ok).toBe(true);
  });

  it('launches the worker as a module of the Python package by default', async () => {
    const launches: { scriptPath?: string; scriptArgs?: readonly string[] }[] = [];
    const adapter = new PythonWorkerAdapter({
      route: ROUTE,
      clientFactory: async (options) => {
        launches.push({ scriptPath: options.scriptPath, scriptArgs: options.scriptArgs });
        return fakeClient().client;
      },
    });

    await adapter.runEmbedding(REQUEST);
    expect(launches[0]?.scriptPath).toBe('-m');
    expect(launches[0]?.scriptArgs).toEqual(['visionlens.worker']);
  });
});
