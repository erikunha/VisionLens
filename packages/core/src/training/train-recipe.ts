import { createHash } from 'node:crypto';

import { canonicalJson } from '@vision-lens/contracts';
import { z } from 'zod';

/**
 * The recipe of one training run: the pinned configuration that decides
 * what the run produces.
 *
 * The Python side resolves the recipe
 * (`python/visionlens/src/visionlens/training/recipe.py`) and the
 * TypeScript side validates it and commits the domain rows
 * (`docs/vnext/08-DOMAIN-STORE-AND-PROVENANCE.md:46`). The schema is
 * therefore the contract between the two languages, and it is STRICT: a
 * recipe with a field nobody knows is a recipe nobody maintains, and a
 * recipe with a field the other language does not know is a recipe the two
 * languages judge differently.
 *
 * The FINGERPRINT is the `fp2:` digest of every other field of the
 * recipe, computed by the same algorithm on both sides
 * (`packages/contracts/src/fingerprint.ts`). The two languages agreeing on
 * the address of a configuration is the whole point of the field: a
 * fingerprint that only one side can recompute proves nothing.
 */

/** The version of the shape of the recipe this package validates. */
export const TRAIN_RECIPE_SCHEMA_VERSION = '1.0.0';

/** A sha256 digest, in lowercase hex. */
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** The fingerprint form of the repository: `fp2:` and sixteen hex characters. */
const FINGERPRINT_PATTERN = /^fp2:[0-9a-f]{16}$/;

/** The pin of the encoder of a run: the exact bytes the run will use. */
export const EncoderPinSchema = z
  .strictObject({
    modelId: z.string().min(1),
    revision: z.string().min(1),
    sourceUri: z.string().url(),
    sourceDigest: z.string().regex(SHA256_PATTERN),
    license: z.string().min(1),
    licenseUrl: z.string().url(),
    commercialUse: z.boolean(),
    usageRestrictions: z.string(),
    requiredExtras: z.array(z.string().min(1)).min(1),
    tasks: z.array(z.string().min(1)).min(1),
    preprocessingFingerprint: z.string().regex(FINGERPRINT_PATTERN),
    deviceSupport: z.array(z.string().min(1)).min(1),
    inputImageSize: z.strictObject({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    }),
    featureExtractor: z.string().min(1),
    outputShape: z.strictObject({
      dimension: z.number().int().positive(),
    }),
    latencyCostProfile: z.string().min(1),
    calibrationStatus: z.string().min(1),
    trustPolicy: z.string().min(1),
    attribution: z.string(),
  })
  .describe('The pinned encoder of a run.');

/** The pin of the data of a run: the split it was measured on. */
export const DatasetPinSchema = z
  .strictObject({
    datasetId: z.string().min(1),
    splitId: z.string().min(1),
    snapshotFingerprint: z.string().regex(SHA256_PATTERN),
    manifestHash: z.string().regex(SHA256_PATTERN),
  })
  .describe('The pinned data of a run.');

/** The three partitions of a run: the item ids of each one. */
export const PartitionsSchema = z
  .strictObject({
    train: z.array(z.string().min(1)).min(1),
    val: z.array(z.string().min(1)).min(1),
    test: z.array(z.string().min(1)).min(1),
  })
  .describe('The item ids of the three partitions of a run.');

/**
 * The class weight of one class.
 *
 * A class weight is a number or the word `none`, and `none` is a
 * DOCUMENTED weight: the class is not weighted. An undocumented weight is
 * a weight nobody chose, and the recipe refuses it.
 */
export const ClassWeightSchema = z.union([
  z.literal('none'),
  z.number().nonnegative(),
]);

/**
 * The recipe of a training run.
 *
 * Every field the recipe carries is here, and nothing else: the strict
 * object refuses a recipe with a field nobody knows, which is the only
 * way two languages can keep agreeing on what a recipe is.
 */
export const TrainRecipeSchema = z
  .strictObject({
    recipeVersion: z.literal(TRAIN_RECIPE_SCHEMA_VERSION),
    encoder: EncoderPinSchema,
    dataset: DatasetPinSchema,
    partitions: PartitionsSchema,
    ontologyVersion: z.string().regex(FINGERPRINT_PATTERN),
    classWeights: z.record(z.string().min(1), ClassWeightSchema),
    estimator: z.string().min(1),
    optimizer: z.string().min(1),
    hyperparameters: z.record(z.string(), z.unknown()),
    seed: z.number().int(),
    devicePolicy: z.string().min(1),
    augmentation: z.array(z.string().min(1)),
    maxEpochs: z.number().int().positive(),
    earlyStopping: z.record(z.string(), z.unknown()),
    checkpointInterval: z.number().int().positive(),
    resources: z.record(z.string(), z.unknown()),
    budget: z.record(z.string(), z.unknown()),
    contractsVersion: z.string().min(1),
    fingerprint: z.string().regex(FINGERPRINT_PATTERN),
  })
  .describe('The pinned configuration of a training run.');

/** The result of validating a recipe: the recipe, or why it was refused. */
export type TrainRecipeValidation =
  | { readonly ok: true; readonly recipe: z.infer<typeof TrainRecipeSchema> }
  | { readonly ok: false; readonly issues: readonly string[] };

/**
 * Validates a recipe against the schema.
 *
 * The refusal names every field that failed, so a caller can say what to
 * fix instead of only that something is wrong.
 */
export function validateTrainRecipe(payload: unknown): TrainRecipeValidation {
  const parsed = TrainRecipeSchema.safeParse(payload);
  if (parsed.success) {
    return { ok: true, recipe: parsed.data };
  }
  const issues = parsed.error.issues.map(
    (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
  );
  return { ok: false, issues };
}

/**
 * The fingerprint of a recipe, recomputed.
 *
 * The digest covers every field of the recipe EXCEPT the fingerprint
 * itself, and it is computed with the same canonical serialisation and the
 * same `fp2:` form the Python side uses, so the two languages agree on the
 * address of a configuration or the promise means nothing.
 */
export function trainRecipeFingerprint(
  recipe: Readonly<Record<string, unknown>>,
): string {
  const components = { ...recipe };
  delete components['fingerprint'];
  const digest = createHash('sha256')
    .update(canonicalJson(components), 'utf8')
    .digest('hex');
  return `fp2:${digest.slice(0, 16)}`;
}

/**
 * The JSON Schema of the recipe.
 *
 * The schema is generated from the Zod schema above, so the committed file
 * and the schema the TypeScript side validates with can never drift, and
 * the Python side reads the generated file to judge the recipe it
 * publishes. It is the same mechanism the manifest of the adapter uses
 * (`packages/core/src/adapter/embedding-manifest.ts`).
 */
export function trainRecipeJsonSchema(): unknown {
  return z.toJSONSchema(TrainRecipeSchema, { io: 'output' });
}

/**
 * The identity of the ontology the labels live in, recomputed.
 *
 * The ontology of a probe is its CLASS SPACE: the set of label keys the
 * run may answer with, which are the keys of the class weights of the
 * recipe. The digest covers the sorted keys, so a recipe whose class
 * space changed has another fingerprint.
 *
 * The Python side computes the same digest over the same payload
 * (`python/visionlens/src/visionlens/training/recipe.py`,
 * `ontology_version_of`), so this side can tell whether the ontology
 * version a recipe declares is the version of the class space the recipe
 * carries. A version nobody can recompute is a label and not an address.
 */
export function ontologyVersionOf(labelKeys: readonly string[]): string {
  const components = { labelKeys: [...new Set(labelKeys)].sort() };
  const digest = createHash('sha256')
    .update(canonicalJson(components), 'utf8')
    .digest('hex');
  return `fp2:${digest.slice(0, 16)}`;
}
