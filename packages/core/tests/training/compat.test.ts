import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as core from '../../src/index.js';

/**
 * The compatibility of the training surface with the shipped surface.
 *
 * The training surface is ADDITIVE in the same way the facade is: it lives
 * behind its own subpath, the root export list of the core does not grow,
 * and a consumer that imports the root today keeps importing the same
 * names.
 */

/** The root export list of the core, frozen. */
const CORE_ROOT_EXPORTS = [
  'WorkerClient',
  'WorkerDeadlineError',
  'WorkerLaunchError',
  'WorkerProtocolError',
  'computeAnalysisFingerprint',
  'runBatch',
  'runDiff',
  'runReorder',
  'runReport',
  'runSearch',
  'runSingle',
  'runSuggestCategories',
  'runWatch',
];

describe('the compatibility of the training surface with the shipped surface', () => {
  it('does not change the root export list of the core', () => {
    expect(Object.keys(core).sort()).toEqual(CORE_ROOT_EXPORTS);
  });

  it('does not re-export the training surface from the root', () => {
    const names = Object.keys(core);
    expect(names).not.toContain('TrainRecipeSchema');
    expect(names).not.toContain('validateTrainRecipe');
    expect(names).not.toContain('trainRecipeFingerprint');
  });

  it('publishes the training surface behind its own subpath', async () => {
    const manifest = JSON.parse(
      await readFile(
        join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'package.json'),
        'utf-8',
      ),
    ) as { exports: Record<string, string> };
    expect(manifest.exports['./training']).toBe('./dist/training/index.js');
  });
});
