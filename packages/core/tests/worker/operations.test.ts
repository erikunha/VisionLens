import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseRecordedVisionEmbedSuccess,
  parseSimulatedVisionEmbedSuccess,
  parseVisionEmbedSuccess,
  runVisionEmbed,
  tryVisionEmbed,
  VISION_EMBED_BRIDGE,
  VISION_EMBED_OPERATION,
  WORKER_OPERATION_BRIDGES,
  WorkerOperationContractError,
  workerErrorResult,
  WorkerClient,
  WORKER_INTERPRETER_ENV,
  type VisionEmbedClient,
  type VisionEmbedInput,
  type VisionEmbedSuccess,
} from '../../src/worker/index.js';
import { WorkerProtocolError } from '../../src/worker/errors.js';
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
  dimension: 768,
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
      dimension: 768,
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
    const outcome = workerErrorResult(new Error('deadline'));

    expect(outcome.code).toBe('WORKER_CRASHED');
    expect(outcome.retryable).toBe(true);
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
