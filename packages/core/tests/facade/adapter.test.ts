import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { WorkerHelloFrame } from '@vision-lens/contracts';
import { PythonWorkerAdapter } from '../../src/facade/adapter.js';
import type {
  FacadeArtifactCommit,
  FacadeEmbeddingRequest,
} from '../../src/facade/port.js';
import type { WorkerClient } from '../../src/worker/index.js';

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
  '771aadcbc610c566165d9b247627af460b05c3f6263fb5fc3c862b54f66dd117';

const FIXTURE_RUN_ID = 'run-fixture-0001';

const ROUTE = {
  enabled: true,
  workspaceId: 'local',
  artifactRoot: FIXTURE_ROOT,
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
    count: 2,
    dimensions: 3,
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
    async request(input: { params: Record<string, unknown> }) {
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
    expect(outcome.result.count).toBe(2);
    expect(outcome.result.dimensions).toBe(3);
    expect(outcome.result.dtype).toBe('float32');
    expect(outcome.result.artifact.relativePath).toBe(
      'artifacts/embedding/run-fixture-0001',
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
    expect(outcome.error.retryable).toBe(true);
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
    expect(outcome.error.code).toBe('ARTIFACT_INVALID');
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
});
