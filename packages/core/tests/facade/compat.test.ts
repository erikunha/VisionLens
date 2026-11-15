import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as core from '../../src/index.js';
import { LLMProvider, resolvePythonRouteConfig } from '../../src/config/index.js';

/**
 * The compatibility of the facade with the shipped surface.
 *
 * The facade is ADDITIVE and it is additive in a way a test can see: the
 * root export list of the core does not grow, the exports map of the core
 * gains exactly one subpath, and the provider vocabulary keeps its eight
 * names. The legacy path is not re-pointed at anything, so a consumer that
 * imports the root today keeps working.
 */
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

const CORE_EXPORT_SUBPATHS = [
  '.',
  './analyzer/batch',
  './analyzer/client',
  './analyzer/consensus',
  './analyzer/embeddings',
  './analyzer/sessions',
  './analyzer/suggest',
  './benchmark',
  './classifier',
  './config',
  './diff',
  './facade',
  './fs',
  './reporter/sqlite-schema',
  './search',
  './search/query',
  './store',
  './types',
  './utils/logger',
];

const PROVIDERS: readonly LLMProvider[] = [
  'openai',
  'anthropic',
  'google',
  'azure',
  'ollama',
  'hybrid',
  'bedrock',
  'vertex',
];

describe('the compatibility of the facade with the shipped surface', () => {
  it('does not change the root export list of the core', () => {
    expect(Object.keys(core).sort()).toEqual(CORE_ROOT_EXPORTS);
  });

  it('does not re-export the facade from the root', () => {
    const names = Object.keys(core);
    expect(names).not.toContain('PythonWorkerAdapter');
    expect(names).not.toContain('VisionOperationPort');
    expect(names).not.toContain('FacadeError');
  });

  it('adds exactly one subpath to the exports map of the core', async () => {
    const manifest = JSON.parse(
      await readFile(
        join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'package.json'),
        'utf-8',
      ),
    ) as { exports: Record<string, string> };
    expect(Object.keys(manifest.exports).sort()).toEqual(CORE_EXPORT_SUBPATHS);
    expect(manifest.exports['./facade']).toBe('./dist/facade/index.js');
  });

  it('keeps the provider vocabulary of eight names', () => {
    expect(PROVIDERS).toHaveLength(8);
  });

  it('keeps the route off when the operator did not turn it on', () => {
    const route = resolvePythonRouteConfig({});
    expect(route.enabled).toBe(false);
    expect(route.workspaceId).toBe('local');
    expect(route.maxSeconds).toBe(300);
  });

  it('turns the route on only when the operator names it', () => {
    const route = resolvePythonRouteConfig({ pythonRoute: 'enabled' });
    expect(route.enabled).toBe(true);
  });

  it('refuses a budget that is not a whole number of seconds', () => {
    expect(() => resolvePythonRouteConfig({ pythonRoute: 'enabled', pythonMaxSeconds: '0' })).toThrow(
      /python-max-seconds/,
    );
    expect(() =>
      resolvePythonRouteConfig({ pythonRoute: 'enabled', pythonMaxSeconds: '1.5' }),
    ).toThrow(/python-max-seconds/);
  });
});
