#!/usr/bin/env node
/**
 * Generate the JSON Schema of the recipe of a training run.
 *
 * The recipe is a contract between two languages: the Python side resolves
 * it and the TypeScript side validates it. The schema is generated from the
 * same Zod schema the TypeScript side validates with, so the two can never
 * drift, and the Python side validates against the generated file.
 *
 * The file travels WITH the Python package, because the side that reads it
 * is the side that resolves the recipe: a validator that needs a path the
 * wheel does not carry is a validator that only runs in the repository.
 *
 * It is the same mechanism the manifest of the adapter uses
 * (`scripts/benchmarks/generate-manifest-schema.ts`), for the recipe.
 *
 * Run: `pnpm exec tsx scripts/training/generate-recipe-schema.ts`
 *
 * With `--check` the command compares the generated schema with the
 * committed one and exits 1 when they differ. That is the gate: the
 * committed file is never rewritten by a test.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { trainRecipeJsonSchema } from '../../packages/core/src/training/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const schemaPath = path.join(
  repoRoot,
  'python',
  'visionlens',
  'src',
  'visionlens',
  'training',
  'train-recipe.schema.json',
);

function main(): number {
  const generated = JSON.stringify(trainRecipeJsonSchema(), null, 2);
  const payload = generated + '\n';

  if (process.argv.includes('--check')) {
    let committed = '';
    try {
      committed = readFileSync(schemaPath, 'utf8');
    } catch {
      console.error(`the recipe schema is not committed at ${schemaPath}`);
      return 1;
    }
    if (committed !== payload) {
      console.error(
        'the committed recipe schema differs from the one the Zod schema generates: run pnpm exec tsx scripts/training/generate-recipe-schema.ts',
      );
      return 1;
    }
    console.log('recipe schema is in sync with the Zod schema');
    return 0;
  }

  writeFileSync(schemaPath, payload, 'utf8');
  console.log(`recipe schema written: ${schemaPath}`);
  return 0;
}

process.exit(main());
