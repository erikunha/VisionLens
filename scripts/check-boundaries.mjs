#!/usr/bin/env node
/**
 * Boundary-rule proof (spec 001, task 2.3 — implemented via this script).
 *
 * Lints four throwaway fixtures with eslint and proves what each one does.
 * The fixtures are NEVER written to disk: eslint reads them from stdin and
 * resolves the configuration by a VIRTUAL filename, so the path that decides
 * which rule applies is real while the file is not.
 *
 *   - packages/core/tests/…/violating.ts imports the `openai` SDK
 *     → eslint MUST fail (exit 1): the path matches the eslint.config.js
 *       `files` globs and stays outside the `packages/core/src/analyzer/providers/**`
 *       carve-out
 *   - packages/core/tests/…/clean.ts imports only node:path
 *     → eslint MUST pass (exit 0)
 *   - packages/core/src/worker/…/worker-violating.ts imports `sharp`
 *     → eslint MUST fail (exit 1): the path matches the worker-scoped
 *       boundary rule of the boundary-table row in AGENTS.md
 *   - packages/core/src/worker/…/worker-clean.ts stdlib + contracts
 *     → eslint MUST pass (exit 0)
 *   - packages/core/src/facade/…/facade-violating.ts imports the store
 *     → eslint MUST fail (exit 1): the path matches the facade-scoped
 *       boundary rule of the boundary-table row in AGENTS.md
 *   - packages/core/src/facade/…/facade-clean.ts stdlib + contracts + the
 *     worker client
 *     → eslint MUST pass (exit 0)
 *
 * Why stdin and not a file: a planted violation is a violation. While it sat
 * in the tree, every other tool that walks the tree read it as source: the
 * owner boundary checker reported `HOST-IMPORTS` on a tree that was clean,
 * and the suite failed intermittently, under load, with a message that named
 * a directory no one had written on purpose. A fixture that never touches
 * the disk cannot be read by anything, and the race disappears with it.
 *
 * Any other outcome (config errors = exit 2, crashes) fails the check.
 * Run: `pnpm run check:boundaries` (repo root). Wired into CI later.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const eslintBin = path.join(repoRoot, 'node_modules', 'eslint', 'bin', 'eslint.js');

// The virtual fixture paths. The directory name says what they are: scratch
// space that never exists on disk.
const FIXTURE_DIR = `boundary-check-tmp-${process.pid}`;

// Under packages/core/tests/ so the eslint.config.js `files` globs match;
// NOT under packages/core/src/analyzer/providers/ (the SDK carve-out).
const TESTS_VIOLATING_PATH = path.join(
  repoRoot,
  'packages',
  'core',
  'tests',
  FIXTURE_DIR,
  'violating.ts',
);
const TESTS_CLEAN_PATH = path.join(
  repoRoot,
  'packages',
  'core',
  'tests',
  FIXTURE_DIR,
  'clean.ts',
);

// Under packages/core/src/worker/ so the worker-scoped boundary rule matches.
const WORKER_VIOLATING_PATH = path.join(
  repoRoot,
  'packages',
  'core',
  'src',
  'worker',
  FIXTURE_DIR,
  'worker-violating.ts',
);
const WORKER_CLEAN_PATH = path.join(
  repoRoot,
  'packages',
  'core',
  'src',
  'worker',
  FIXTURE_DIR,
  'worker-clean.ts',
);

// Under packages/core/src/facade/, at the SAME DEPTH as the real files of
// the module: the boundary rule matches the import specifier as it is
// written, and a real facade file reaches the store as '../store/...'. A
// fixture nested one level deeper would write '../../store/...' and would
// NOT match the rule, which would prove nothing.
const FACADE_VIOLATING_PATH = path.join(
  repoRoot,
  'packages',
  'core',
  'src',
  'facade',
  'facade-violating.ts',
);
const FACADE_BARREL_VIOLATING_PATH = path.join(
  repoRoot,
  'packages',
  'core',
  'src',
  'facade',
  'facade-barrel-violating.ts',
);
const FACADE_CLEAN_PATH = path.join(
  repoRoot,
  'packages',
  'core',
  'src',
  'facade',
  'facade-clean.ts',
);

const VIOLATING = `import OpenAI from 'openai';
// Deliberate boundary violation fixture — must trip no-restricted-imports.
export const client = OpenAI;
`;

const CLEAN = `import path from 'node:path';
// Clean fixture — no LLM SDK import, must lint green.
export const joined = path.join('a', 'b');
`;

const WORKER_VIOLATING = `import sharp from 'sharp';
// Deliberate worker boundary violation fixture: Sharp inside the process
// spawning module must trip the scoped no-restricted-imports rule.
export const imaging = sharp;
`;

const WORKER_CLEAN = `import { spawn } from 'node:child_process';
import { WORKER_PROTOCOL_ID } from '@vision-lens/contracts';
// Clean worker fixture: node stdlib plus contracts, must lint green.
export const protocol = WORKER_PROTOCOL_ID;
export const spawnWorker = spawn;
`;

const FACADE_VIOLATING = `import { DerivedArtifactsRepository } from '../store/repositories/derived-artifacts.js';
// Deliberate facade boundary violation fixture: the facade may not reach the
// store directly, because the store is the domain writer and the facade
// only asks it to commit a row.
export const artifacts = DerivedArtifactsRepository;
`;

const FACADE_BARREL_VIOLATING = `import { openMigratedStore } from '../index.js';
// Deliberate facade boundary violation fixture: the barrel of the core
// re-exports the store, so a facade that reaches the barrel reaches the
// store too. The rule has to name the barrel as well.
export const store = openMigratedStore;
`;

const FACADE_CLEAN = `import { createHash } from 'node:crypto';
import { WORKER_PROTOCOL_ID } from '@vision-lens/contracts';
import { WorkerClient } from '../worker/index.js';
import type { PythonRouteConfig } from '../config/index.js';
// Clean facade fixture: node stdlib plus contracts plus the worker client
// plus the types of the route, must lint green.
export const digest = createHash('sha256');
export const protocol = WORKER_PROTOCOL_ID;
export const client = WorkerClient;
export type { PythonRouteConfig };
`;

/**
 * Lint one fixture from stdin, under a virtual filename.
 *
 * eslint resolves the configuration by the filename, so the rule that applies
 * is the one the path selects, exactly as it would be for a real file.
 */
function runEslint(content, virtualPath) {
  return spawnSync(
    process.execPath,
    [eslintBin, '--no-color', '--stdin', '--stdin-filename', virtualPath],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      input: content,
    },
  );
}

let failed = false;
try {
  const violating = runEslint(VIOLATING, TESTS_VIOLATING_PATH);
  if (violating.status !== 1) {
    failed = true;
    console.error(
      `FAIL: violating fixture should exit 1 (LLM SDK outside providers/), got ${violating.status}\n${violating.stdout}${violating.stderr}`,
    );
  } else if (
    !violating.stdout.includes('no-restricted-imports') ||
    !violating.stdout.includes('packages/core/src/analyzer/providers')
  ) {
    failed = true;
    console.error(
      `FAIL: violation reported, but not by the boundary rule:\n${violating.stdout}`,
    );
  } else {
    console.log('ok: LLM SDK import outside providers/ is rejected (no-restricted-imports)');
  }

  const clean = runEslint(CLEAN, TESTS_CLEAN_PATH);
  if (clean.status !== 0) {
    failed = true;
    console.error(`FAIL: clean fixture should exit 0, got ${clean.status}\n${clean.stdout}${clean.stderr}`);
  } else {
    console.log('ok: clean fixture (node:path only) lints green');
  }

  const workerViolating = runEslint(WORKER_VIOLATING, WORKER_VIOLATING_PATH);
  if (workerViolating.status !== 1) {
    failed = true;
    console.error(
      `FAIL: worker violating fixture should exit 1 (Sharp inside worker/), got ${workerViolating.status}\n${workerViolating.stdout}${workerViolating.stderr}`,
    );
  } else if (
    !workerViolating.stdout.includes('no-restricted-imports') ||
    !workerViolating.stdout.includes('packages/core/src/worker')
  ) {
    failed = true;
    console.error(
      `FAIL: worker violation reported, but not by the worker boundary rule:\n${workerViolating.stdout}`,
    );
  } else {
    console.log('ok: Sharp import inside worker/ is rejected (no-restricted-imports)');
  }

  const workerClean = runEslint(WORKER_CLEAN, WORKER_CLEAN_PATH);
  if (workerClean.status !== 0) {
    failed = true;
    console.error(
      `FAIL: worker clean fixture should exit 0, got ${workerClean.status}\n${workerClean.stdout}${workerClean.stderr}`,
    );
  } else {
    console.log('ok: worker clean fixture (node:child_process + contracts) lints green');
  }

  const facadeViolating = runEslint(FACADE_VIOLATING, FACADE_VIOLATING_PATH);
  if (facadeViolating.status !== 1) {
    failed = true;
    console.error(
      `FAIL: facade violating fixture should exit 1 (direct store access inside facade/), got ${facadeViolating.status}\n${facadeViolating.stdout}${facadeViolating.stderr}`,
    );
  } else if (
    !facadeViolating.stdout.includes('no-restricted-imports') ||
    !facadeViolating.stdout.includes('packages/core/src/facade')
  ) {
    failed = true;
    console.error(
      `FAIL: violation reported, but not by the facade boundary rule:\n${facadeViolating.stdout}`,
    );
  } else {
    console.log('ok: direct store access inside facade/ is rejected (no-restricted-imports)');
  }

  const facadeBarrelViolating = runEslint(FACADE_BARREL_VIOLATING, FACADE_BARREL_VIOLATING_PATH);
  if (facadeBarrelViolating.status !== 1) {
    failed = true;
    console.error(
      `FAIL: facade barrel violating fixture should exit 1 (the barrel of the core re-exports the store), got ${facadeBarrelViolating.status}\n${facadeBarrelViolating.stdout}${facadeBarrelViolating.stderr}`,
    );
  } else if (!facadeBarrelViolating.stdout.includes('no-restricted-imports')) {
    failed = true;
    console.error(
      `FAIL: violation reported, but not by the facade boundary rule:\n${facadeBarrelViolating.stdout}`,
    );
  } else {
    console.log('ok: the barrel of the core inside facade/ is rejected (no-restricted-imports)');
  }

  const facadeClean = runEslint(FACADE_CLEAN, FACADE_CLEAN_PATH);
  if (facadeClean.status !== 0) {
    failed = true;
    console.error(
      `FAIL: facade clean fixture should exit 0, got ${facadeClean.status}\n${facadeClean.stdout}${facadeClean.stderr}`,
    );
  } else {
    console.log('ok: facade clean fixture (node stdlib + contracts + worker) lints green');
  }
} catch (error) {
  failed = true;
  console.error(`FAIL: unexpected error: ${String(error)}`);
}

if (failed) {
  console.error('boundary check FAILED');
  process.exit(1);
}
console.log(
  'boundary check passed: LLM SDK, worker and facade violating fixtures caught, clean fixtures green',
);
