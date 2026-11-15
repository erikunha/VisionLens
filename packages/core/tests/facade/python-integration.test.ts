import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { PythonWorkerAdapter } from '../../src/facade/adapter.js';

/**
 * The facade against the REAL Python worker.
 *
 * The suite drives the facade end to end: the route is on, the worker is
 * launched, the handshake completes, the request goes over the frozen
 * channel, the artifact is written by the Python side, the facade validates
 * it on disk and publishes a relative, content addressed reference.
 *
 * The suite SKIPS when the machine has neither the weights nor the virtual
 * environment: a test that cannot run anywhere proves nothing, and a test
 * that fails for a missing download fails for the wrong reason.
 */
vi.setConfig({ testTimeout: 300_000 });

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const PYTHON_SRC = path.join(REPO_ROOT, 'python', 'visionlens', 'src');
const REGISTRY_PATH = path.join(REPO_ROOT, 'datasets', 'registry.json');
const MODEL_ROOT = path.join(os.homedir(), '.cache', 'visionlens', 'models');
const FIXTURES_PATH = path.join(REPO_ROOT, 'packages', 'core', 'tests', 'fixtures', 'images');
const VENV_BIN = path.join(REPO_ROOT, 'python', 'visionlens', '.venv', 'bin');

/** Whether the weights of the pinned model are in the local cache. */
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
 * The PATH of the recorded run.
 *
 * The host launches the worker from a FIXED allowlist of names, so the
 * environment of the machine is what decides: the virtual environment of the
 * package goes first on the PATH and `python3` resolves to it. The name
 * stays `python3`, because a path the caller names is exactly what the
 * allowlist refuses.
 */
function recordedPath(): string | undefined {
  if (!existsSync(VENV_BIN)) return undefined;
  return VENV_BIN + path.delimiter + (process.env.PATH ?? '');
}

const RECORDED_AVAILABLE = weightsAvailable() && recordedPath() !== undefined;

const scratch: string[] = [];

afterAll(() => {
  for (const directory of scratch) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe.skipIf(!RECORDED_AVAILABLE)('the facade against the real worker', () => {
  it('embeds the fixtures and publishes a relative, content addressed reference', async () => {
    const artifactRoot = mkdtempSync(path.join(os.tmpdir(), 'visionlens-facade-'));
    scratch.push(artifactRoot);

    const adapter = new PythonWorkerAdapter({
      route: {
        enabled: true,
        workspaceId: 'ws-facade',
        artifactRoot,
        maxSeconds: 600,
      },
      interpreter: 'python3',
      scriptPath: '-m',
      scriptArgs: ['visionlens.worker'],
      env: {
        PYTHONPATH: PYTHON_SRC,
        PATH: recordedPath(),
        VISIONLENS_WORKER_REGISTRY: REGISTRY_PATH,
        VISIONLENS_WORKER_MODEL_ROOT: MODEL_ROOT,
        VISIONLENS_WORKER_ASSET_ROOT: FIXTURES_PATH,
      },
    });

    const assets = readdirSync(FIXTURES_PATH)
      .filter((name) => name.endsWith('.jpg'))
      .sort()
      .map((name) => ({ assetId: name, path: name }));

    const outcome = await adapter.runEmbedding({
      snapshotId: 'fixtures-2026-11-15',
      assets,
      model: 'siglip2-base',
      workspaceId: 'ws-facade',
      budget: { maxSeconds: 600, maxUsdMicro: 0 },
      idempotencyKey: 'facade-real-0001',
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(`the run should have succeeded: ${outcome.error.message}`);
    expect(outcome.result.count).toBe(assets.length);
    expect(outcome.result.dimensions).toBe(768);
    expect(outcome.result.dtype).toBe('float32');
    expect(outcome.result.artifact.relativePath.startsWith('/')).toBe(false);
    expect(outcome.result.artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(outcome.result.transformFingerprint).toMatch(/^fp2:[0-9a-f]{16}$/);

    // The artifact is on disk, under the root, and its manifest carries the
    // digest the facade published.
    const directory = path.join(artifactRoot, outcome.result.artifact.relativePath);
    const manifest = JSON.parse(
      readFileSync(path.join(directory, 'manifest.json'), 'utf-8'),
    ) as { artifactDigest: string; count: number; dimension: number };
    expect(manifest.artifactDigest).toBe(outcome.result.artifact.sha256);
    expect(manifest.count).toBe(assets.length);
    expect(manifest.dimension).toBe(768);
  });

  it('does the work once for a key that was already used', async () => {
    const artifactRoot = mkdtempSync(path.join(os.tmpdir(), 'visionlens-facade-'));
    scratch.push(artifactRoot);

    const adapter = new PythonWorkerAdapter({
      route: {
        enabled: true,
        workspaceId: 'ws-facade',
        artifactRoot,
        maxSeconds: 600,
      },
      interpreter: 'python3',
      scriptPath: '-m',
      scriptArgs: ['visionlens.worker'],
      env: {
        PYTHONPATH: PYTHON_SRC,
        PATH: recordedPath(),
        VISIONLENS_WORKER_REGISTRY: REGISTRY_PATH,
        VISIONLENS_WORKER_MODEL_ROOT: MODEL_ROOT,
        VISIONLENS_WORKER_ASSET_ROOT: FIXTURES_PATH,
      },
    });

    const assets = readdirSync(FIXTURES_PATH)
      .filter((name) => name.endsWith('.jpg'))
      .sort()
      .map((name) => ({ assetId: name, path: name }));

    const request = {
      snapshotId: 'fixtures-2026-11-15',
      assets,
      model: 'siglip2-base',
      workspaceId: 'ws-facade',
      budget: { maxSeconds: 600, maxUsdMicro: 0 },
      idempotencyKey: 'facade-real-0002',
    };

    const first = await adapter.runEmbedding(request);
    const second = await adapter.runEmbedding(request);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error('the run should have succeeded');
    expect(second.result.embeddingRunId).toBe(first.result.embeddingRunId);
    expect(second.run.id).toBe(first.run.id);
  });
});
