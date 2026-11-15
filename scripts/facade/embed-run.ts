#!/usr/bin/env node
/**
 * The end to end run of the facade over the real Python worker.
 *
 * The script drives the facade the way the CLI drives it: the route is on,
 * the worker is launched as a module of the Python package, the handshake
 * completes, the request travels over the frozen channel, the Python side
 * writes the artifact, the facade validates it on disk and publishes a
 * relative, content addressed reference.
 *
 * It is the EVIDENCE of the section 7.1 of
 * `docs/architecture/python-worker-facade-verification.md`, and it lives in
 * the repository because a command that only exists in a temporary directory
 * is not a command a reader can run.
 *
 * The paths are resolved from the location of this file, so the script never
 * carries the path of the machine that ran it.
 *
 * Run: pnpm exec tsx scripts/facade/embed-run.ts
 */
import { mkdtempSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PythonWorkerAdapter } from '../../packages/core/src/facade/adapter.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The committed images the run embeds. */
const fixtures = path.join(repoRoot, 'packages', 'core', 'tests', 'fixtures', 'images');

/** The virtual environment of the Python package, which carries the encoder. */
const venv = path.join(repoRoot, 'python', 'visionlens', '.venv', 'bin');

/** The root the worker writes its artifact under, outside the tree. */
const artifactRoot = mkdtempSync(path.join(os.tmpdir(), 'visionlens-facade-'));

const adapter = new PythonWorkerAdapter({
  route: {
    enabled: true,
    workspaceId: 'ws-facade',
    artifactRoot,
    assetRoot: fixtures,
    maxSeconds: 600,
  },
  env: {
    // The package is importable by the interpreter of the virtual
    // environment, which is the one the interpreter of the PATH resolves to.
    PYTHONPATH: path.join(repoRoot, 'python', 'visionlens', 'src'),
    PATH: `${venv}${path.delimiter}${process.env['PATH'] ?? ''}`,
    VISIONLENS_WORKER_REGISTRY: path.join(repoRoot, 'datasets', 'registry.json'),
    VISIONLENS_WORKER_MODEL_ROOT: path.join(os.homedir(), '.cache', 'visionlens', 'models'),
  },
});

const assets = readdirSync(fixtures)
  .filter((name) => name.endsWith('.jpg'))
  .sort()
  .map((name) => ({ assetId: name, path: name }));

const outcome = await adapter.runEmbedding({
  // The snapshot of the golden artifact, so the content address of the run
  // is the address the library run produced over the same fixtures. The
  // snapshot is part of the content, and a different snapshot is a different
  // address.
  snapshotId: 'fixtures-2026-11-14',
  assets,
  model: 'siglip2-base',
  workspaceId: 'ws-facade',
  budget: { maxSeconds: 600, maxUsdMicro: 0 },
  idempotencyKey: 'facade-doc-0001',
});

if (!outcome.ok) {
  console.error(`FAILED ${outcome.error.code} ${outcome.error.message}`);
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      embeddingRunId: outcome.result.embeddingRunId,
      count: outcome.result.count,
      dimensions: outcome.result.dimensions,
      dtype: outcome.result.dtype,
      artifact: outcome.result.artifact,
      transformFingerprint: outcome.result.transformFingerprint,
      contractVersion: outcome.result.contractVersion,
      protocolVersion: outcome.result.protocolVersion,
      errorSamples: outcome.result.errorSamples,
      runId: outcome.run.id,
      transitions: outcome.run.transitions.map((transition) => transition.to),
    },
    null,
    2,
  ),
);
