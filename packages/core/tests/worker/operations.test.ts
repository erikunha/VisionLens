import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseRecordedVisionEmbedSuccess,
  parseSimulatedVisionEmbedSuccess,
  parseVisionEmbedSuccess,
  runRecordedVisionEmbed,
  runVisionEmbed,
  tryRecordedVisionEmbed,
  tryVisionEmbed,
  VISION_EMBED_BRIDGE,
  VISION_EMBED_OPERATION,
  WORKER_OPERATION_BRIDGES,
  WorkerOperationContractError,
  workerErrorResult,
  WorkerClient,
  WORKER_INTERPRETER_ENV,
  type RecordedVisionEmbedInput,
  type VisionEmbedClient,
  type VisionEmbedInput,
  type VisionEmbedSuccess,
} from '../../src/worker/index.js';
import { WorkerDeadlineError, WorkerLaunchError, WorkerProtocolError } from '../../src/worker/errors.js';
import { teardown, track } from './helpers.js';

vi.setConfig({ testTimeout: 15_000 });

/**
 * The bridge of the `vision.embed` operation (task 2.11).
 *
 * The operation is registered with a typed success result and a typed error
 * result. Two success shapes exist and both are tracked: the recorded one
 * (the run id and the digest of the artifact, the vectors on disk) and the
 * simulated one (the vectors in the line), so the tests pin both and the
 * refusal of a payload that is neither.
 */

const SHA256 = 'a'.repeat(64);
const FINGERPRINT = 'fp2:0123456789abcdef';
const WORKSPACE = 'ws-bridge';
const BUDGET = { maxSeconds: 30, maxUsdMicro: 0 } as const;

/** The recorded payload, field by field, as the pack's example carries it. */
const RECORDED_PAYLOAD = {
  embeddingRunId: 'embed_demo_001',
  count: 5,
  dimensions: 768,
  dtype: 'float32',
  artifactSha256: SHA256,
  errorSamples: [],
} as const;

/** The simulated payload, field by field, as the frozen worker answers it. */
const SIMULATED_PAYLOAD = {
  model: 'siglip2-base',
  dimension: 2,
  dtype: 'float32',
  count: 2,
  vectors: [
    [0.1, -0.2],
    [0.3, 0.4],
  ],
  artifactSha256: SHA256,
  preprocessingFingerprint: FINGERPRINT,
  device: 'cpu',
} as const;

function embedInput(overrides: Partial<VisionEmbedInput> = {}): VisionEmbedInput {
  return {
    workspaceId: WORKSPACE,
    images: ['asset-a', 'asset-b'],
    model: 'siglip2-base',
    budget: BUDGET,
    ...overrides,
  };
}

/** A client that answers with the given payload or fails with the given error. */
function stubClient(payload?: unknown, failure?: unknown): VisionEmbedClient {
  return {
    request: async () => {
      if (failure !== undefined) throw failure;
      return {
        requestId: 'r-bridge',
        seq: 1,
        result: payload as never,
      };
    },
  };
}

describe('the vision.embed bridge', () => {
  it('is registered under the frozen operation code', () => {
    expect(VISION_EMBED_OPERATION).toBe('vision.embed');
    expect(VISION_EMBED_BRIDGE.operation).toBe('vision.embed');
    expect(WORKER_OPERATION_BRIDGES.get('vision.embed')).toBe(VISION_EMBED_BRIDGE);
  });

  it('sends the model, the images and the device the caller asked for', () => {
    const params = VISION_EMBED_BRIDGE.buildParams(embedInput({ device: 'auto' }));

    expect(params).toEqual({ images: ['asset-a', 'asset-b'], model: 'siglip2-base', device: 'auto' });
  });

  it('sends no device at all when the caller named none', () => {
    const params = VISION_EMBED_BRIDGE.buildParams(embedInput());

    expect(params).not.toHaveProperty('device');
  });

  it('refuses a request with no image at all, before the worker is asked', () => {
    try {
      VISION_EMBED_BRIDGE.buildParams(embedInput({ images: [] }));
      expect.unreachable('the request should have been refused');
    } catch (error) {
      expect((error as WorkerOperationContractError).field).toBe('images');
    }
  });

  it('parses the recorded success field by field', () => {
    const parsed = parseRecordedVisionEmbedSuccess(RECORDED_PAYLOAD);

    expect(parsed).toEqual({
      kind: 'recorded',
      embeddingRunId: 'embed_demo_001',
      count: 5,
      dimensions: 768,
      dtype: 'float32',
      artifactSha256: SHA256,
      errorSamples: [],
    });
  });

  it('parses the simulated success field by field', () => {
    const parsed = parseSimulatedVisionEmbedSuccess(SIMULATED_PAYLOAD);

    expect(parsed).toEqual({
      kind: 'simulated',
      model: 'siglip2-base',
      dimension: 2,
      dtype: 'float32',
      count: 2,
      vectors: [
        [0.1, -0.2],
        [0.3, 0.4],
      ],
      artifactSha256: SHA256,
      preprocessingFingerprint: FINGERPRINT,
      device: 'cpu',
    });
  });

  it('names the shape that answered', () => {
    expect(parseVisionEmbedSuccess(RECORDED_PAYLOAD).kind).toBe('recorded');
    expect(parseVisionEmbedSuccess(SIMULATED_PAYLOAD).kind).toBe('simulated');
  });

  it('carries the fallback reason of a simulated run when there is one', () => {
    const parsed = parseVisionEmbedSuccess({ ...SIMULATED_PAYLOAD, fallbackReason: 'no mps' });

    expect(parsed.kind).toBe('simulated');
    expect(parsed.kind === 'simulated' ? parsed.fallbackReason : undefined).toBe('no mps');
  });

  it('refuses a payload that is neither shape, and names the field', () => {
    expect(() => parseVisionEmbedSuccess({ count: 1 })).toThrowError(WorkerOperationContractError);

    try {
      parseVisionEmbedSuccess({ count: 1 });
      expect.unreachable('the payload should have been refused');
    } catch (error) {
      const failure = error as WorkerOperationContractError;
      expect(failure.field).toBe('result');
      expect(failure.operation).toBe('vision.embed');
    }
  });

  it('refuses a recorded payload with no run id, and names the field', () => {
    const withoutRunId: Record<string, unknown> = { ...RECORDED_PAYLOAD };
    delete withoutRunId.embeddingRunId;

    try {
      parseRecordedVisionEmbedSuccess(withoutRunId);
      expect.unreachable('the payload should have been refused');
    } catch (error) {
      expect((error as WorkerOperationContractError).field).toBe('embeddingRunId');
    }
  });

  it('refuses a payload that names neither shape as a whole', () => {
    try {
      parseVisionEmbedSuccess({ count: 1 });
      expect.unreachable('the payload should have been refused');
    } catch (error) {
      expect((error as WorkerOperationContractError).field).toBe('result');
    }
  });

  it('refuses a digest that is not a sha256, and names the field', () => {
    try {
      parseVisionEmbedSuccess({ ...RECORDED_PAYLOAD, artifactSha256: 'not-a-digest' });
      expect.unreachable('the payload should have been refused');
    } catch (error) {
      expect((error as WorkerOperationContractError).field).toBe('artifactSha256');
    }
  });

  it('refuses a dtype that is not float32, and names the field', () => {
    try {
      parseVisionEmbedSuccess({ ...RECORDED_PAYLOAD, dtype: 'float16' });
      expect.unreachable('the payload should have been refused');
    } catch (error) {
      expect((error as WorkerOperationContractError).field).toBe('dtype');
    }
  });

  it('refuses a count that is not an integer, and names the field', () => {
    try {
      parseVisionEmbedSuccess({ ...RECORDED_PAYLOAD, count: 5.5 });
      expect.unreachable('the payload should have been refused');
    } catch (error) {
      expect((error as WorkerOperationContractError).field).toBe('count');
    }
  });

  it('refuses an error sample with no asset, and names the field', () => {
    try {
      parseVisionEmbedSuccess({
        ...RECORDED_PAYLOAD,
        errorSamples: [{ code: 'IMAGE_METADATA_UNREADABLE', message: 'broken' }],
      });
      expect.unreachable('the payload should have been refused');
    } catch (error) {
      expect((error as WorkerOperationContractError).field).toBe('errorSamples[0].assetId');
    }
  });

  it('refuses a preprocessing fingerprint that is not of the fp2 form', () => {
    try {
      parseVisionEmbedSuccess({ ...SIMULATED_PAYLOAD, preprocessingFingerprint: 'sha256:abc' });
      expect.unreachable('the payload should have been refused');
    } catch (error) {
      expect((error as WorkerOperationContractError).field).toBe('preprocessingFingerprint');
    }
  });

  it('refuses a payload that names both shapes, and names the field', () => {
    // A worker that answers with the vectors of a simulation under the
    // name of a recorded run would have its vectors dropped, and the
    // caller told to look on the disk.
    try {
      parseVisionEmbedSuccess({ ...SIMULATED_PAYLOAD, ...RECORDED_PAYLOAD });
      expect.unreachable('the payload should have been refused');
    } catch (error) {
      expect((error as WorkerOperationContractError).field).toBe('result');
    }
  });

  it('refuses a vector that is not a finite number', () => {
    for (const poison of [Number.NaN, Number.POSITIVE_INFINITY]) {
      try {
        parseVisionEmbedSuccess({
          ...SIMULATED_PAYLOAD,
          vectors: [[poison, 0.2], [0.3, 0.4]],
        });
        expect.unreachable('the payload should have been refused');
      } catch (error) {
        expect((error as WorkerOperationContractError).field).toBe('vectors[0]');
      }
    }
  });

  it('refuses a vector that does not carry the dimensions the result declares', () => {
    try {
      parseVisionEmbedSuccess({ ...SIMULATED_PAYLOAD, vectors: [[0.1], [0.3, 0.4]] });
      expect.unreachable('the payload should have been refused');
    } catch (error) {
      expect((error as WorkerOperationContractError).field).toBe('vectors[0]');
    }
  });

  it('refuses a count that does not match the vectors', () => {
    try {
      parseVisionEmbedSuccess({ ...SIMULATED_PAYLOAD, count: 9 });
      expect.unreachable('the payload should have been refused');
    } catch (error) {
      expect((error as WorkerOperationContractError).field).toBe('vectors');
    }
  });

  it('refuses a count that is negative', () => {
    try {
      parseVisionEmbedSuccess({ ...SIMULATED_PAYLOAD, count: -1 });
      expect.unreachable('the payload should have been refused');
    } catch (error) {
      expect((error as WorkerOperationContractError).field).toBe('count');
    }
  });

  it('refuses a count and a dimension of zero, because a run embeds at least one image', () => {
    // The producer refuses a run that embedded nothing, so a result that
    // counts zero contradicts the very run it claims to answer.
    for (const payload of [
      { ...SIMULATED_PAYLOAD, count: 0 },
      { ...SIMULATED_PAYLOAD, dimension: 0 },
      { ...RECORDED_PAYLOAD, count: 0 },
      { ...RECORDED_PAYLOAD, dimensions: 0 },
    ]) {
      try {
        parseVisionEmbedSuccess(payload);
        expect.unreachable('the payload should have been refused');
      } catch (error) {
        expect(['count', 'dimension', 'dimensions']).toContain(
          (error as WorkerOperationContractError).field,
        );
      }
    }
  });

  it('refuses a payload that names both shapes in the parser of each shape', () => {
    // The two parsers of a shape are exported, so the exclusivity of the
    // shapes has to hold in each of them and not only in the parser that
    // chooses between them.
    for (const parse of [parseRecordedVisionEmbedSuccess, parseSimulatedVisionEmbedSuccess]) {
      try {
        parse({ ...SIMULATED_PAYLOAD, ...RECORDED_PAYLOAD });
        expect.unreachable('the payload should have been refused');
      } catch (error) {
        expect((error as WorkerOperationContractError).field).toBe('result');
      }
    }
  });

  it('accepts the recorded payload of the pack example, which carries no error sample', () => {
    // The pack's own example of a successful result carries no error
    // sample, so the bridge accepts it and reads the samples as none.
    const parsed = parseVisionEmbedSuccess({
      embeddingRunId: 'embed_demo_001',
      count: 5,
      dimensions: 768,
      dtype: 'float32',
      artifactSha256: SHA256,
      source: 'synthetic-example-not-a-real-run',
    });

    expect(parsed.kind).toBe('recorded');
    expect(parsed.kind === 'recorded' ? parsed.errorSamples : undefined).toEqual([]);
  });

  it('refuses a payload that is not an object at all', () => {
    expect(() => parseVisionEmbedSuccess('vectors')).toThrowError(WorkerOperationContractError);
    expect(() => parseVisionEmbedSuccess([1, 2, 3])).toThrowError(WorkerOperationContractError);
  });

  it('runs the operation and returns the typed success', async () => {
    const outcome = await runVisionEmbed(stubClient(SIMULATED_PAYLOAD), embedInput());

    expect(outcome.kind).toBe('simulated');
    expect(outcome.kind === 'simulated' ? outcome.count : 0).toBe(2);
  });

  it('reports a refusal of the worker as the typed error, with the frozen flag', async () => {
    const failure = new WorkerProtocolError('MISSING_EXTRA', 'the model needs the vision extra');
    const outcome = await tryVisionEmbed(stubClient(undefined, failure), embedInput());

    expect(outcome.ok).toBe(false);
    if (outcome.ok) expect.unreachable('the request should have failed');
    expect(outcome.error.code).toBe('MISSING_EXTRA');
    expect(outcome.error.retryable).toBe(false);
    expect(outcome.error.message).toContain('vision extra');
  });

  it('reports a retryable failure with the frozen retryable flag', () => {
    const outcome = workerErrorResult(new WorkerProtocolError('WORKER_CRASHED', 'boom'));

    expect(outcome.code).toBe('WORKER_CRASHED');
    expect(outcome.retryable).toBe(true);
  });

  it('reports a deadline with the frozen code of the deadline', () => {
    const outcome = workerErrorResult(new WorkerDeadlineError('r-bridge', 30));

    expect(outcome.code).toBe('DEADLINE_EXCEEDED');
    expect(outcome.retryable).toBe(false);
    expect(outcome.message).toContain('r-bridge');
  });

  it('reports a failure of the channel with the flag the host itself uses', () => {
    // The host decides whether a launch is worth retrying, so the bridge
    // reports the flag the host uses and not the one of a proxy code.
    const spawnFailure = workerErrorResult(new WorkerLaunchError('spawn-error', 'no python'));
    const death = workerErrorResult(new WorkerLaunchError('worker-died', 'the worker died'));

    expect(spawnFailure.code).toBe('WORKER_CRASHED');
    expect(spawnFailure.retryable).toBe(false);
    expect(death.retryable).toBe(true);
  });

  it('reports a code outside the frozen vocabulary as a crash of the worker', () => {
    // The code travels on the wire, so a code the platform does not know
    // has no retryable flag of its own.
    const outcome = workerErrorResult(
      new WorkerProtocolError('NOT_A_FROZEN_CODE' as never, 'the worker invented a code'),
    );

    expect(outcome.code).toBe('WORKER_CRASHED');
    expect(outcome.retryable).toBe(true);
    expect(outcome.message).toContain('NOT_A_FROZEN_CODE');
  });

  it('reports a code of the prototype chain as a crash of the worker', () => {
    // The frozen table is a plain object, so a lookup finds the members
    // of the prototype chain too. A code named `toString` would inherit
    // the function of the chain, and a flag that is a function is a flag
    // nobody can act on.
    for (const code of ['toString', 'constructor', 'valueOf', '__proto__', 'hasOwnProperty']) {
      const outcome = workerErrorResult(
        new WorkerProtocolError(code as never, 'the worker named a code of the chain'),
      );

      expect(outcome.code).toBe('WORKER_CRASHED');
      expect(outcome.retryable).toBe(true);
      expect(outcome.message).toContain(code);
    }
  });

  it('throws for a payload that breaks the contract, even in the tolerant call', async () => {
    await expect(tryVisionEmbed(stubClient({ count: 1 }), embedInput())).rejects.toThrowError(
      WorkerOperationContractError,
    );
  });

  it('keeps the two success shapes apart in the type of the result', () => {
    const recorded: VisionEmbedSuccess = parseVisionEmbedSuccess(RECORDED_PAYLOAD);
    const simulated: VisionEmbedSuccess = parseVisionEmbedSuccess(SIMULATED_PAYLOAD);

    expect(recorded.kind).toBe('recorded');
    expect(simulated.kind).toBe('simulated');
    expect('embeddingRunId' in recorded).toBe(true);
    expect('vectors' in recorded).toBe(false);
  });
});

/**
 * The RECORDED shape of the bridge.
 *
 * The request names the shape it asks for: an input that carries `assets`
 * asks for the recorded run, and one that carries `images` asks for the
 * simulated one. A request that carries both is refused before the worker
 * is asked.
 */
describe('the recorded shape of the vision.embed bridge', () => {
  function recordedInput(
    overrides: Partial<RecordedVisionEmbedInput> = {},
  ): RecordedVisionEmbedInput {
    return {
      workspaceId: WORKSPACE,
      assets: [{ assetId: 'asset-a', path: 'a.jpg' }],
      snapshotId: 'snapshot-1',
      model: 'siglip2-base',
      budget: BUDGET,
      ...overrides,
    };
  }

  it('sends the assets, the snapshot and the model of a recorded run', () => {
    const params = VISION_EMBED_BRIDGE.buildParams(recordedInput({ device: 'auto' }));

    expect(params).toEqual({
      assets: [{ assetId: 'asset-a', path: 'a.jpg' }],
      snapshotId: 'snapshot-1',
      model: 'siglip2-base',
      device: 'auto',
    });
  });

  it('sends no device at all when the caller named none', () => {
    const params = VISION_EMBED_BRIDGE.buildParams(recordedInput());

    expect(params).not.toHaveProperty('device');
  });

  it('refuses a request that names both shapes, before the worker is asked', () => {
    try {
      VISION_EMBED_BRIDGE.buildParams({
        ...recordedInput(),
        images: ['asset-a'],
      } as never);
      expect.unreachable('the request should have been refused');
    } catch (error) {
      expect((error as WorkerOperationContractError).field).toBe('assets');
      expect((error as WorkerOperationContractError).message).toContain('images');
    }
  });

  it('refuses a request that names both shapes on the recorded entry point too', async () => {
    // Every entry point of the operation refuses an ambiguous request the
    // same way, and not only the builder of the params.
    await expect(
      runRecordedVisionEmbed(stubClient(RECORDED_PAYLOAD), {
        ...recordedInput(),
        images: ['asset-a'],
      } as never),
    ).rejects.toThrowError(WorkerOperationContractError);
    await expect(
      tryRecordedVisionEmbed(stubClient(RECORDED_PAYLOAD), {
        ...recordedInput(),
        images: ['asset-a'],
      } as never),
    ).rejects.toThrowError(WorkerOperationContractError);
  });

  it('refuses a recorded input with no assets at all, and not with a crash', async () => {
    // A caller that is not TypeScript may hand an input with no assets.
    // The refusal is a CONTRACT refusal: a request that can never
    // succeed is not a failure worth retrying.
    try {
      VISION_EMBED_BRIDGE.buildParams({
        ...recordedInput(),
        assets: undefined,
      } as never);
      expect.unreachable('the request should have been refused');
    } catch (error) {
      expect((error as WorkerOperationContractError).field).toBe('assets');
    }
    await expect(
      tryRecordedVisionEmbed(stubClient(RECORDED_PAYLOAD), {
        ...recordedInput(),
        assets: undefined,
      } as never),
    ).rejects.toThrowError(WorkerOperationContractError);
  });

  it('refuses a recorded request with no asset at all', () => {
    try {
      VISION_EMBED_BRIDGE.buildParams(recordedInput({ assets: [] }));
      expect.unreachable('the request should have been refused');
    } catch (error) {
      expect((error as WorkerOperationContractError).field).toBe('assets');
    }
  });

  it('refuses a recorded request with no snapshot', () => {
    try {
      VISION_EMBED_BRIDGE.buildParams(recordedInput({ snapshotId: '' }));
      expect.unreachable('the request should have been refused');
    } catch (error) {
      expect((error as WorkerOperationContractError).field).toBe('snapshotId');
    }
  });

  it('refuses an asset with no id and an asset with no path', () => {
    try {
      VISION_EMBED_BRIDGE.buildParams(
        recordedInput({ assets: [{ assetId: '', path: 'a.jpg' }] }),
      );
      expect.unreachable('the request should have been refused');
    } catch (error) {
      expect((error as WorkerOperationContractError).field).toBe('assets[0].assetId');
    }
    try {
      VISION_EMBED_BRIDGE.buildParams(
        recordedInput({ assets: [{ assetId: 'asset-a', path: '' }] }),
      );
      expect.unreachable('the request should have been refused');
    } catch (error) {
      expect((error as WorkerOperationContractError).field).toBe('assets[0].path');
    }
  });

  it('runs the recorded operation and returns the recorded success', async () => {
    const outcome = await runRecordedVisionEmbed(stubClient(RECORDED_PAYLOAD), recordedInput());

    expect(outcome.kind).toBe('recorded');
    expect(outcome.embeddingRunId).toBe('embed_demo_001');
    expect(outcome.count).toBe(5);
    expect(outcome.dimensions).toBe(768);
    expect(outcome.artifactSha256).toBe(SHA256);
  });

  it('refuses a worker that answers a recorded request with a simulation', async () => {
    // The caller asked for a recorded run, so the vectors of a simulation
    // are a broken contract and not a success.
    await expect(
      runRecordedVisionEmbed(stubClient(SIMULATED_PAYLOAD), recordedInput()),
    ).rejects.toThrowError(WorkerOperationContractError);
  });

  it('reports the refusal of the worker as the typed error, with the frozen flag', async () => {
    const failure = new WorkerProtocolError(
      'MALFORMED_FRAME',
      'this worker does not serve the recorded shape of vision.embed',
    );
    const outcome = await tryRecordedVisionEmbed(stubClient(undefined, failure), recordedInput());

    expect(outcome.ok).toBe(false);
    if (outcome.ok) expect.unreachable('the request should have been refused');
    expect(outcome.error.code).toBe('MALFORMED_FRAME');
    expect(outcome.error.retryable).toBe(false);
  });
});

/**
 * The bridge against the REAL Python worker.
 *
 * The bridge is not a description of the wire: it has to speak it. The
 * suite below launches the real worker and asks it for an embedding, so
 * the typed success of the bridge is proven against the frames a real
 * process emits, not against a hand-written payload.
 */
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const PYTHON_SRC = path.join(REPO_ROOT, 'python', 'visionlens', 'src');
const WORKER_ENTRY = path.join(PYTHON_SRC, 'visionlens', 'worker.py');
const PYTHON_AVAILABLE = spawnSync('python3', ['--version'], { encoding: 'utf8' }).status === 0;
const WORKER_RESOLVED = existsSync(WORKER_ENTRY);

function pythonWorkerEnv(): NodeJS.ProcessEnv {
  const existing = process.env.PYTHONPATH;
  return {
    PYTHONPATH: existing ? PYTHON_SRC + path.delimiter + existing : PYTHON_SRC,
  };
}

afterEach(async () => {
  await teardown();
});

describe.skipIf(!PYTHON_AVAILABLE || !WORKER_RESOLVED)('the bridge against the real worker', () => {
  it('reads the typed success of a real vision.embed request', async () => {
    const client = track(
      await WorkerClient.launch({
        interpreter: process.env[WORKER_INTERPRETER_ENV] ?? 'python3',
        scriptPath: '-m',
        scriptArgs: ['visionlens.worker'],
        env: pythonWorkerEnv(),
      }),
    );

    const outcome = await runVisionEmbed(client, {
      workspaceId: 'ws-bridge',
      images: ['golden-alpha', 'golden-beta'],
      model: 'siglip2-base',
      budget: { maxSeconds: 30, maxUsdMicro: 0 },
    });

    expect(outcome.kind).toBe('simulated');
    if (outcome.kind !== 'simulated') expect.unreachable('the run should have been simulated');
    expect(outcome.count).toBe(2);
    expect(outcome.dimension).toBe(768);
    expect(outcome.dtype).toBe('float32');
    expect(outcome.device).toBe('cpu');
    expect(outcome.vectors).toHaveLength(2);
    expect(outcome.artifactSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(outcome.preprocessingFingerprint).toMatch(/^fp2:[0-9a-f]{16}$/);
  });

  it('reports the refusal of the real worker as the typed error', async () => {
    const client = track(
      await WorkerClient.launch({
        interpreter: process.env[WORKER_INTERPRETER_ENV] ?? 'python3',
        scriptPath: '-m',
        scriptArgs: ['visionlens.worker'],
        env: pythonWorkerEnv(),
      }),
    );

    const outcome = await tryVisionEmbed(client, {
      workspaceId: 'ws-bridge',
      images: ['golden-alpha'],
      model: 'no-such-model',
      budget: { maxSeconds: 30, maxUsdMicro: 0 },
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) expect.unreachable('the request should have been refused');
    expect(outcome.error.code).toBe('MALFORMED_FRAME');
    expect(outcome.error.retryable).toBe(false);
    expect(outcome.error.message).toContain('no-such-model');
  });
});

/**
 * The RECORDED shape against the REAL Python worker.
 *
 * The recorded shape is served by the CPU adapter, so the run needs the
 * `vision` extra and the weights in the local cache. The suite below runs
 * when the machine has both, and it is skipped when it has not: a test
 * that cannot run anywhere is a test that proves nothing, and a test
 * that fails for a missing download is a test that fails for the wrong
 * reason.
 */
const REGISTRY_PATH = path.join(REPO_ROOT, 'datasets', 'registry.json');
const MODEL_ROOT = path.join(os.homedir(), '.cache', 'visionlens', 'models');
const FIXTURES_PATH = path.join(REPO_ROOT, 'packages', 'core', 'tests', 'fixtures', 'images');
const VENV_BIN = path.join(REPO_ROOT, 'python', 'visionlens', '.venv', 'bin');

function weightsAvailable(): boolean {
  try {
    const registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) as {
      models?: { modelId: string; revision: string }[];
    };
    const record = registry.models?.find((model) => model.modelId === 'siglip2-base');
    if (!record) return false;
    return existsSync(
      path.join(MODEL_ROOT, record.modelId, record.revision, 'model.safetensors'),
    );
  } catch {
    return false;
  }
}

/**
 * The interpreter of the recorded run.
 *
 * The host launches the worker from a FIXED allowlist of names, so the
 * environment of the machine is what decides: the virtual environment of
 * the package goes first on the PATH, and `python3` resolves to it. The
 * name stays `python3`, because a path the caller names is exactly what
 * the allowlist refuses.
 */
function recordedPath(): string | undefined {
  if (!existsSync(VENV_BIN)) return undefined;
  return VENV_BIN + path.delimiter + (process.env.PATH ?? '');
}

const RECORDED_AVAILABLE = weightsAvailable() && recordedPath() !== undefined;

describe.skipIf(!RECORDED_AVAILABLE)('the recorded shape against the real worker', () => {
  it('reads the recorded success of a real vision.embed request', async () => {
    const artifactRoot = mkdtempSync(path.join(tmpdir(), 'visionlens-recorded-'));
    const client = track(
      await WorkerClient.launch({
        interpreter: process.env[WORKER_INTERPRETER_ENV] ?? 'python3',
        scriptPath: '-m',
        scriptArgs: ['visionlens.worker'],
        env: {
          ...pythonWorkerEnv(),
          PATH: recordedPath(),
          VISIONLENS_WORKER_REGISTRY: REGISTRY_PATH,
          VISIONLENS_WORKER_MODEL_ROOT: MODEL_ROOT,
          VISIONLENS_WORKER_ASSET_ROOT: FIXTURES_PATH,
          VISIONLENS_WORKER_ARTIFACT_ROOT: artifactRoot,
        },
      }),
    );

    const assets = readdirSync(FIXTURES_PATH)
      .filter((name) => name.endsWith('.jpg'))
      .sort()
      .map((name) => ({ assetId: name, path: name }));

    const outcome = await runRecordedVisionEmbed(client, {
      workspaceId: 'ws-recorded',
      assets,
      snapshotId: 'fixtures-2026-11-14',
      model: 'siglip2-base',
      budget: { maxSeconds: 600, maxUsdMicro: 0 },
    });

    expect(outcome.kind).toBe('recorded');
    expect(outcome.count).toBe(assets.length);
    expect(outcome.dimensions).toBe(768);
    expect(outcome.dtype).toBe('float32');
    expect(outcome.artifactSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(outcome.errorSamples).toEqual([]);
    expect('vectors' in outcome).toBe(false);
  }, 300_000);
});
