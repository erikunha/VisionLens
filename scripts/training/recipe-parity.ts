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
 * The check runs over BOTH regimes of class weight, because a weight is
 * either the word `none` or a number, and the two regimes travel through
 * different code:
 *
 *   - the DEFAULT regime, where every class of the ontology is weighted
 *     `none`;
 *   - the NUMERIC regime, where every class carries a number, half of them
 *     whole and half of them fractional.
 *
 * A gate that only looked at one regime would let the other one rot: a
 * weight published as the text of a number satisfies a regime of `none`
 * perfectly and is refused by the schema of the other side.
 *
 * Run: `pnpm exec tsx scripts/training/recipe-parity.ts`
 *
 * It exits 1 when the two sides disagree.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ontologyVersionOf,
  trainRecipeFingerprint,
  validateTrainRecipe,
} from '../../packages/core/src/training/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const REGISTRY = path.join(repoRoot, 'datasets', 'registry.json');
const SPLIT = path.join(repoRoot, 'benchmarks', 'splits', 'visa-subset.v2.gold.json');
const RESOLVER = path.join(repoRoot, 'python', 'visionlens', 'scripts', 'resolve_recipe.py');

/** The recipe the Python side published, or why it could not publish one. */
type Resolution =
  | { readonly ok: true; readonly recipe: Record<string, unknown> }
  | { readonly ok: false; readonly reason: string };

/**
 * Resolves the recipe on the Python side.
 *
 * The weights are optional: without them every class of the ontology is
 * weighted `none`.
 */
function resolveOnPython(weightsFile?: string): Resolution {
  const args = [RESOLVER, '--registry', REGISTRY, '--split', SPLIT];
  if (weightsFile) args.push('--class-weights', weightsFile);
  const python = spawnSync('python3', args, { cwd: repoRoot, encoding: 'utf8' });
  if (python.status !== 0) {
    return { ok: false, reason: `the Python resolver failed:\n${python.stderr}` };
  }
  try {
    return { ok: true, recipe: JSON.parse(python.stdout) as Record<string, unknown> };
  } catch (error) {
    return {
      ok: false,
      reason: `the Python resolver did not print a recipe: ${String(error)}`,
    };
  }
}

/**
 * Checks the recipe the Python side published against the TypeScript side.
 *
 * The shape and the address are two different promises, and the check
 * proves both before it moves on.
 */
function checkRecipe(label: string, recipe: Record<string, unknown>): boolean {
  const validation = validateTrainRecipe(recipe);
  if (!validation.ok) {
    console.error(`the TypeScript side refused the recipe of the ${label} regime:`);
    for (const issue of validation.issues) console.error(`  ${issue}`);
    return false;
  }
  console.log(
    `ok: the recipe of the ${label} regime satisfies the schema of the TypeScript side`,
  );

  const recomputed = trainRecipeFingerprint(recipe);
  const declared = String(recipe['fingerprint']);
  if (recomputed !== declared) {
    console.error(
      `the two sides disagree about the address of the ${label} configuration: the ` +
        `Python side computed ${declared} and the TypeScript side computed ${recomputed}`,
    );
    return false;
  }
  console.log(`ok: both sides compute the address ${declared} of the ${label} regime`);

  // The ontology version is the digest of the class space, and the class
  // space is the set of the keys of the class weights the recipe carries.
  // The TypeScript side recomputes it, so a version nobody can recompute
  // is caught here instead of being taken on trust.
  const classWeights = recipe['classWeights'];
  if (typeof classWeights !== 'object' || classWeights === null) {
    console.error(`the recipe of the ${label} regime carries no class weights`);
    return false;
  }
  const recomputedOntology = ontologyVersionOf(Object.keys(classWeights));
  const declaredOntology = String(recipe['ontologyVersion']);
  if (recomputedOntology !== declaredOntology) {
    console.error(
      `the two sides disagree about the ontology of the ${label} regime: the ` +
        `Python side declared ${declaredOntology} and the TypeScript side computed ` +
        `${recomputedOntology} over the class space of the recipe`,
    );
    return false;
  }
  console.log(
    `ok: both sides compute the ontology ${declaredOntology} of the ${label} regime`,
  );
  return true;
}

/**
 * The weights of the numeric regime: every class carries a number.
 *
 * The numbers are not all the same, and half of them are fractional, so a
 * weight that arrives as the text of a number is caught whichever way it
 * was written.
 */
function numericWeights(labelKeys: readonly string[]): Record<string, number> {
  const weights: Record<string, number> = {};
  labelKeys.forEach((labelKey, index) => {
    weights[labelKey] = index % 2 === 0 ? index + 1 : index + 0.5;
  });
  return weights;
}

function main(): number {
  const defaults = resolveOnPython();
  if (!defaults.ok) {
    console.error(defaults.reason);
    return 1;
  }
  if (!checkRecipe('default', defaults.recipe)) return 1;

  const classWeights = defaults.recipe['classWeights'];
  if (typeof classWeights !== 'object' || classWeights === null) {
    console.error('the recipe of the Python side carries no class weights');
    return 1;
  }
  const labelKeys = Object.keys(classWeights);
  if (labelKeys.length === 0) {
    console.error('the recipe of the Python side weighs no class at all');
    return 1;
  }

  const scratch = mkdtempSync(path.join(tmpdir(), 'visionlens-recipe-parity-'));
  try {
    const weightsFile = path.join(scratch, 'class-weights.json');
    writeFileSync(
      weightsFile,
      JSON.stringify(numericWeights(labelKeys)),
      'utf8',
    );

    const numeric = resolveOnPython(weightsFile);
    if (!numeric.ok) {
      console.error(numeric.reason);
      return 1;
    }
    if (!checkRecipe('numeric', numeric.recipe)) return 1;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  return 0;
}

process.exit(main());
