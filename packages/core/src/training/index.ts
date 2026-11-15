/**
 * The training surface of the core.
 *
 * The training side of the platform is a TypeScript VALIDATION surface and
 * a Python EXECUTION surface: the Python side resolves the recipe, trains
 * the probe and publishes the manifest, and this side validates what the
 * Python side published and commits the domain rows
 * (`docs/vnext/08-DOMAIN-STORE-AND-PROVENANCE.md:46`).
 *
 * The module lives behind its own subpath, so a consumer that imports the
 * root of `@vision-lens/core` today keeps importing the same names.
 */

export {
  ClassWeightSchema,
  DatasetPinSchema,
  EncoderPinSchema,
  PartitionsSchema,
  TRAIN_RECIPE_SCHEMA_VERSION,
  TrainRecipeSchema,
  canonicalTrainRecipe,
  ontologyVersionOf,
  trainRecipeFingerprint,
  trainRecipeJsonSchema,
  validateTrainRecipe,
  type TrainRecipeValidation,
} from './train-recipe.js';
