import { describe, expect, it } from 'vitest';
import * as sdk from '../src/index.js';

/**
 * The frozen export list of the SDK.
 *
 * The root entrypoint of the SDK is the public surface of the package, and
 * the list below is the baseline it had before the Python facade landed.
 * The facade lives behind the subpath `@vision-lens/core/facade` and is NOT
 * re-exported from here, so a consumer that imports the root today keeps
 * importing exactly the same names.
 *
 * The list is a BASELINE and not a snapshot of whatever the module happens
 * to export: a new export has to be a deliberate change of the public
 * surface, and this test is where that change is noticed.
 */
const FROZEN_ROOT_EXPORTS = [
  'AzureBlobFileRepository',
  'CACHE_SCHEMA_VERSION',
  'GCSFileRepository',
  'MemoryFileRepository',
  'NodeFileRepository',
  'PLUGIN_API_VERSION',
  'S3FileRepository',
  'analyzeBatch',
  'buildSessions',
  'buildSystemPrompt',
  'buildUserPrompt',
  'classifyAndSort',
  'cosineSimilarity',
  'createFileRepository',
  'createLLMClient',
  'diffCaches',
  'elements',
  'generateEmbeddings',
  'imageLinks',
  'images',
  'loadConfig',
  'normalizeCategory',
  'rankResults',
  'runBatch',
  'runConsensus',
  'runDiff',
  'runReorder',
  'runReport',
  'runSearch',
  'runSingle',
  'runSuggestCategories',
  'runWatch',
  'runs',
  'searchKeyword',
  'searchSemantic',
  'suggestCategories',
];

describe('the frozen export list of the SDK', () => {
  it('exports exactly the names of the baseline', () => {
    expect(Object.keys(sdk).sort()).toEqual(FROZEN_ROOT_EXPORTS);
  });

  it('does not re-export the facade', () => {
    const names = Object.keys(sdk);
    expect(names).not.toContain('PythonWorkerAdapter');
    expect(names).not.toContain('VisionOperationPort');
    expect(names).not.toContain('FacadeError');
  });
});
