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
 * A gate that only looked at one regime would let the other one rot: the
 * regime of `none` says nothing about the regime of a number, and a weight
 * published as the text of a number satisfies the regime of `none`
 * perfectly. The numeric regime also carries a whole number the other side
 * cannot hold exactly, because a number JavaScript rounds reaches the other
 * side rounded and the two sides have to write the SAME text for it.
 *
 * The gate proves a third thing as well: the address of a recipe does not
 * depend on the order of the ids of a partition, because a partition is a
 * SET of ids. The ids of the recipe the Python side publishes are sorted,
 * so the order is turned around here instead of being assumed.
 *
 * Run: `pnpm exec tsx scripts/training/recipe-parity.ts`
 *
 * It exits 1 when the two sides disagree.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson } from '../../packages/contracts/src/fingerprint.js';
import {
  canonicalTrainRecipe,
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
 * The address of a recipe, computed with the SOURCE of the canonical
 * serialisation.
 *
 * The core reaches the canonical serialisation through the package, so the
 * function it uses is the one of the BUILD. The gate computes the address
 * with the SOURCE as well, so a build that is older than the source is
 * caught here instead of being certified: the gate proves the address of
 * the committed source, and not of whatever the build directory holds.
 */
function fingerprintOfSource(recipe: Readonly<Record<string, unknown>>): string {
  const digest = createHash('sha256')
    .update(canonicalJson(canonicalTrainRecipe(recipe)), 'utf8')
    .digest('hex');
  return `fp2:${digest.slice(0, 16)}`;
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
  const fromSource = fingerprintOfSource(recipe);
  const declared = String(recipe['fingerprint']);
  if (recomputed !== fromSource) {
    console.error(
      `the build of the contracts and its committed source disagree about the address of ` +
        `the ${label} configuration: the build computed ${recomputed} and the source ` +
        `computed ${fromSource}; the gate proves the source, so run pnpm build`,
    );
    return false;
  }
  if (recomputed !== declared) {
    console.error(
      `the two sides disagree about the address of the ${label} configuration: the ` +
        `Python side computed ${declared} and the TypeScript side computed ${recomputed}`,
    );
    return false;
  }
  console.log(`ok: both sides compute the address ${declared} of the ${label} regime`);

  // A partition is a SET of item ids, so the address of the recipe does not
  // depend on the order the ids arrived in. The recipe the Python side
  // publishes carries them sorted, so the order is turned around here to
  // prove the property instead of assuming it.
  const partitions = recipe['partitions'];
  if (typeof partitions === 'object' && partitions !== null) {
    const reversed: Record<string, unknown> = {};
    for (const [name, ids] of Object.entries(partitions)) {
      reversed[name] = Array.isArray(ids) ? [...ids].reverse() : ids;
    }
    const shuffled = { ...recipe, partitions: reversed };
    const addressOfShuffled = trainRecipeFingerprint(shuffled);
    if (addressOfShuffled !== declared) {
      console.error(
        `the address of the ${label} configuration depends on the order of the ids of a ` +
          `partition: the declared address is ${declared} and the shuffled one is ` +
          `${addressOfShuffled}; a partition is a set of ids`,
      );
      return false;
    }
    console.log(
      `ok: the address of the ${label} regime does not depend on the order of the ids`,
    );
  }

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
 * The weights of the numeric regime, as the TEXT the resolver reads.
 *
 * The text is written by hand because a number that JavaScript cannot hold
 * exactly is a number JavaScript rounds before it writes it: the regime
 * needs the exact integer to reach the Python side, or the two sides never
 * see the number the regime is about.
 *
 * The numbers are not all the same, half of them are fractional, and one of
 * them is an integer that is not exactly a double, so a weight that arrives
 * as the text of a number is caught whichever way it was written and a
 * number that the other side rounds is caught too.
 */
function numericWeightsText(labelKeys: readonly string[]): string {
  const parts = labelKeys.map((labelKey, index) => {
    const value =
      index === 0
        ? // 2**53 + 1 is not exactly a double: JavaScript holds it as
          // 9007199254740992, so the two sides have to write the same text
          // for it or they compute two addresses for one configuration.
          '9007199254740993'
        : String(index % 2 === 0 ? index + 1 : index + 0.5);
    return `${JSON.stringify(labelKey)}: ${value}`;
  });
  return `{${parts.join(', ')}}`;
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
    writeFileSync(weightsFile, numericWeightsText(labelKeys), 'utf8');

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
