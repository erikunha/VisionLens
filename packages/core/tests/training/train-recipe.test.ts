import { describe, expect, it } from 'vitest';

import {
  TRAIN_RECIPE_SCHEMA_VERSION,
  trainRecipeFingerprint,
  validateTrainRecipe,
} from '../../src/training/index.js';

/**
 * The schema of the recipe of a training run.
 *
 * The Python side resolves the recipe and the TypeScript side validates it,
 * so the schema is a contract between two languages: it is STRICT, and the
 * fingerprint it carries is the digest of every other field, computed the
 * same way on both sides.
 */

/** A recipe that satisfies the schema, so a case varies one thing. */
function validRecipe(): Record<string, unknown> {
  return {
    recipeVersion: TRAIN_RECIPE_SCHEMA_VERSION,
    encoder: {
      modelId: 'siglip2-base',
      revision: '75de2d55ec2d0b4efc50b3e9ad70dba96a7b2fa2',
      sourceUri:
        'https://huggingface.co/google/siglip2-base-patch16-224/resolve/75de2d55ec2d0b4efc50b3e9ad70dba96a7b2fa2/model.safetensors',
      sourceDigest: '612923381c76ec5a9bed335d1c48827e3f2e506ac31b044b63b2031fadee6a0b',
      license: 'apache-2.0',
      licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0',
      commercialUse: true,
      usageRestrictions: 'The attribution travels with the weights.',
      requiredExtras: ['vision'],
      tasks: ['image-embedding'],
      preprocessingFingerprint: 'fp2:83adc4ef99979644',
      deviceSupport: ['cpu'],
      inputImageSize: { width: 224, height: 224 },
      featureExtractor: 'siglip_vision_model',
      outputShape: { dimension: 768 },
      latencyCostProfile: 'unknown',
      calibrationStatus: 'uncalibrated',
      trustPolicy: 'allowlisted-pinned-safetensors-only',
      attribution: 'The fixture authors.',
    },
    dataset: {
      datasetId: 'visa-subset',
      splitId: 'visa-subset.v2.gold',
      snapshotFingerprint:
        '4ac0940380d0283a4ac52bda0884449bc8778ea2605b27c7ef2f26f666b9c963',
      manifestHash: '503c568463739a1522d675a474a219aecc918553315e0ec4e2800c2b10b21bb5',
    },
    partitions: {
      train: ['candle/Data/Images/Anomaly/000.JPG'],
      val: ['candle/Data/Images/Anomaly/001.JPG'],
      test: ['candle/Data/Images/Normal/002.JPG'],
    },
    ontologyVersion: 'fp2:0123456789abcdef',
    classWeights: { normal: 'none', 'defect:candle': 2 },
    estimator: 'logistic-regression',
    optimizer: 'lbfgs',
    hyperparameters: { C: 1, maxIterations: 200, solver: 'lbfgs' },
    seed: 42,
    devicePolicy: 'cpu',
    augmentation: [],
    maxEpochs: 200,
    earlyStopping: {},
    checkpointInterval: 10,
    resources: {},
    budget: {},
    contractsVersion: '1.0.0',
    fingerprint: 'fp2:0123456789abcdef',
  };
}

describe('the recipe of a training run', () => {
  it('accepts a recipe that satisfies the contract', () => {
    const outcome = validateTrainRecipe(validRecipe());

    expect(outcome.ok).toBe(true);
  });

  it('refuses a recipe with a field nobody knows', () => {
    const recipe = { ...validRecipe(), somethingElse: true };

    const outcome = validateTrainRecipe(recipe);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('the recipe should have been refused');
    expect(outcome.issues.join(' ')).toContain('somethingElse');
  });

  it('refuses a recipe whose fingerprint is not the shape of the repository', () => {
    const recipe = { ...validRecipe(), fingerprint: 'not-a-fingerprint' };

    const outcome = validateTrainRecipe(recipe);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('the recipe should have been refused');
    expect(outcome.issues.join(' ')).toContain('fingerprint');
  });

  it('refuses a recipe whose encoder names a revision nobody pinned', () => {
    const recipe = validRecipe();
    recipe['encoder'] = { ...(recipe['encoder'] as object), revision: '' };

    const outcome = validateTrainRecipe(recipe);

    expect(outcome.ok).toBe(false);
  });

  it('refuses a class weight that is neither a number nor none', () => {
    const recipe = { ...validRecipe(), classWeights: { normal: 'heavy' } };

    const outcome = validateTrainRecipe(recipe);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('the recipe should have been refused');
    expect(outcome.issues.join(' ')).toContain('classWeights');
  });

  it('refuses a class weight written as the text of a number', () => {
    // The Python side publishes a weight as a NUMBER or as the word 'none',
    // and a weight that arrived as the text of a number is a weight the two
    // sides read differently.
    const recipe = { ...validRecipe(), classWeights: { normal: '2.0' } };

    const outcome = validateTrainRecipe(recipe);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('the recipe should have been refused');
    expect(outcome.issues.join(' ')).toContain('classWeights');
  });

  it('accepts a class weight that is none, which is a documented weight', () => {
    const recipe = { ...validRecipe(), classWeights: { normal: 'none' } };

    const outcome = validateTrainRecipe(recipe);

    expect(outcome.ok).toBe(true);
  });

  it('computes the fingerprint over every field but the fingerprint itself', () => {
    const recipe = validRecipe();

    const fingerprint = trainRecipeFingerprint(recipe);

    expect(fingerprint).toMatch(/^fp2:[0-9a-f]{16}$/);
    // The fingerprint is not part of what it digests: a recipe that
    // recomputes over itself would change its own address.
    expect(trainRecipeFingerprint({ ...recipe, fingerprint })).toBe(fingerprint);
  });

  it('changes the fingerprint when a single field changes', () => {
    const recipe = validRecipe();

    const changed = trainRecipeFingerprint({ ...recipe, seed: 43 });

    expect(changed).not.toBe(trainRecipeFingerprint(recipe));
  });
});
