#!/usr/bin/env node
/**
 * The parity check between the two sides of the recipe of a training run.
 *
 * The Python side RESOLVES the recipe
 * (`python/visionlens/src/visionlens/training/recipe.py`) and the
 * TypeScript side VALIDATES it
 * (`packages/core/src/training/train-recipe.ts`). The two sides have to
 * agree about two things, and this command proves both:
 *
 *   1. the SHAPE: the recipe the Python side publishes satisfies the
 *      schema the TypeScript side enforces, and the schema is strict, so a
 *      field one side knows and the other does not is a failure;
 *   2. the ADDRESS: the fingerprint the Python side computed over the
 *      configuration is the fingerprint the TypeScript side recomputes
 *      over the same fields.
 *
 * A fingerprint only one side can recompute proves nothing, and a shape
 * only one side accepts is a contract with a hole in it.
 *
 * Run: `pnpm exec tsx scripts/training/recipe-parity.ts`
 *
 * It exits 1 when the two sides disagree.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  trainRecipeFingerprint,
  validateTrainRecipe,
} from '../../packages/core/src/training/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const REGISTRY = path.join(repoRoot, 'datasets', 'registry.json');
const SPLIT = path.join(repoRoot, 'benchmarks', 'splits', 'visa-subset.v2.gold.json');
const RESOLVER = path.join(repoRoot, 'python', 'visionlens', 'scripts', 'resolve_recipe.py');

function main(): number {
  const python = spawnSync(
    'python3',
    [RESOLVER, '--registry', REGISTRY, '--split', SPLIT],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  if (python.status !== 0) {
    console.error('the Python resolver failed:\n' + python.stderr);
    return 1;
  }

  let recipe: Record<string, unknown>;
  try {
    recipe = JSON.parse(python.stdout) as Record<string, unknown>;
  } catch (error) {
    console.error(`the Python resolver did not print a recipe: ${String(error)}`);
    return 1;
  }

  const validation = validateTrainRecipe(recipe);
  if (!validation.ok) {
    console.error('the TypeScript side refused the recipe of the Python side:');
    for (const issue of validation.issues) console.error(`  ${issue}`);
    return 1;
  }
  console.log('ok: the recipe of the Python side satisfies the schema of the TypeScript side');

  const recomputed = trainRecipeFingerprint(recipe);
  const declared = String(recipe['fingerprint']);
  if (recomputed !== declared) {
    console.error(
      `the two sides disagree about the address of the configuration: the Python side ` +
        `computed ${declared} and the TypeScript side computed ${recomputed}`,
    );
    return 1;
  }
  console.log(`ok: both sides compute the address ${declared}`);

  return 0;
}

process.exit(main());
