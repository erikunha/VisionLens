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
 * The artifact is written under a temporary root OUTSIDE the tree, and the
 * root is removed when the command ends, on the failure path too. The
 * evidence of the run is the output of the command, not a directory that
 * accumulates on the machine of the reader.
 *
 * Run: pnpm exec tsx scripts/facade/embed-run.ts
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PythonWorkerAdapter } from '../../packages/core/src/facade/adapter.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The committed images the run embeds. */
const fixtures = path.join(repoRoot, 'packages', 'core', 'tests', 'fixtures', 'images');

/** The virtual environment of the Python package, which carries the encoder. */
const venv = path.join(repoRoot, 'python', 'visionlens', '.venv', 'bin');

/**
 * The root the worker writes its artifact under, outside the tree.
 *
 * The root is a temporary directory, and the script REMOVES it when the run
 * is over: a command a reader runs again and again may not leave a root
 * behind on every run, and a failed run may not leave one that looks like
 * the evidence of a successful run.
 */
const artifactRoot = mkdtempSync(path.join(os.tmpdir(), 'visionlens-facade-'));

// The artifact of a run is evidence, and evidence does not live in the
// tracked tree. A machine whose TMPDIR points inside the working directory
// would write it there, so the invariant is checked instead of assumed.
if (path.resolve(artifactRoot).startsWith(path.resolve(repoRoot) + path.sep)) {
  console.error(
    `FAILED the temporary directory of the run is inside the repository (${artifactRoot}); set TMPDIR to a directory outside the tree`,
  );
  process.exit(1);
}

// The interpreter of the worker is the one of the virtual environment of the
// package, and the environment without it answers with a refusal that names
// a capability instead of the environment that is missing. The preflight
// names what the reader has to create.
if (!existsSync(path.join(venv, 'python3'))) {
  console.error(
    `FAILED the virtual environment of the package is missing (${venv}); create it with "cd python/visionlens && uv sync --extra vision --group dev"`,
  );
  process.exit(1);
}

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

let exitCode = 0;
try {
  const outcome = await adapter.runEmbedding({
    // The snapshot of the golden artifact, so the content address of the run
    // is the address the library run produced over the same fixtures. The
    // snapshot is part of the content, and a different snapshot is a
    // different address.
    snapshotId: 'fixtures-2026-11-14',
    assets,
    model: 'siglip2-base',
    workspaceId: 'ws-facade',
    budget: { maxSeconds: 600, maxUsdMicro: 0 },
    idempotencyKey: 'facade-doc-0001',
  });

  if (!outcome.ok) {
    console.error(`FAILED ${outcome.error.code} ${outcome.error.message}`);
    exitCode = 1;
  } else {
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
  }
} finally {
  // The temporary root is removed when the command ends, on the failure path
  // too: a run that failed may not leave a root behind that looks like the
  // evidence of a run that worked.
  rmSync(artifactRoot, { recursive: true, force: true });
}

process.exitCode = exitCode;
