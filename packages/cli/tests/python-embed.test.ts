import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  formatPythonEmbedOutput,
  formatPythonEmbedSummary,
  parseAssetFlags,
} from '../src/commands/python-embed.js';

// The integration case spawns the built bin; the vitest 5s default would
// flake on a slow CI runner.
vi.setConfig({ testTimeout: 30_000 });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_BIN = path.join(__dirname, '..', 'dist', 'index.js');
const BINS_BUILT = existsSync(INDEX_BIN);

/**
 * The new Python surface of the CLI.
 *
 * The command is ADDITIVE: it is a new subcommand, and the flags of the
 * legacy commands are untouched. The refusal of a route that is off names the
 * key that turns it on, and the exit code is the one of the facade.
 */
describe('the python embed command', () => {
  it('parses the assets of the run', () => {
    expect(parseAssetFlags(['asset-1=images/red.jpg', 'asset-2=images/blue.jpg'])).toEqual([
      { assetId: 'asset-1', path: 'images/red.jpg' },
      { assetId: 'asset-2', path: 'images/blue.jpg' },
    ]);
  });

  it('refuses an asset flag that carries no id or no path', () => {
    expect(() => parseAssetFlags(['red.jpg'])).toThrow(/--asset/);
    expect(() => parseAssetFlags(['=images/red.jpg'])).toThrow(/--asset/);
    expect(() => parseAssetFlags(['asset-1='])).toThrow(/--asset/);
  });

  it('prints the lines of a successful run', () => {
    const lines = formatPythonEmbedSummary(
      {
        embeddingRunId: 'run-0001',
        count: 2,
        dimensions: 3,
        dtype: 'float32',
        artifact: {
          relativePath: 'artifacts/embedding/run-0001',
          sha256: 'a'.repeat(64),
          bytes: 24,
        },
        transformFingerprint: 'fp2:0123456789abcdef',
      },
      { written: false },
    );
    expect(lines.join('\n')).toContain('embedding run:   run-0001');
    expect(lines.join('\n')).toContain('artifact:        artifacts/embedding/run-0001');
    expect(lines.join('\n')).toContain('artifact row:    not written (no --db)');
  });

  it('prints nothing at all when the format is none', () => {
    // The help of the command promises the format, so the format has to be
    // real: a command that was asked for no output prints no output.
    const output = formatPythonEmbedOutput(
      {
        embeddingRunId: 'run-0001',
        count: 2,
        dimensions: 3,
        dtype: 'float32',
        artifact: {
          relativePath: 'artifacts/embedding/run-0001',
          sha256: 'a'.repeat(64),
          bytes: 24,
        },
        transformFingerprint: 'fp2:0123456789abcdef',
      },
      { written: false, outputFormat: 'none' },
    );
    expect(output).toBeNull();
  });

  it('prints the json of the run when the format is json', () => {
    const output = formatPythonEmbedOutput(
      {
        embeddingRunId: 'run-0001',
        count: 2,
        dimensions: 3,
        dtype: 'float32',
        artifact: {
          relativePath: 'artifacts/embedding/run-0001',
          sha256: 'a'.repeat(64),
          bytes: 24,
        },
        transformFingerprint: 'fp2:0123456789abcdef',
      },
      { written: false, outputFormat: 'json' },
    );
    expect(output).not.toBeNull();
    expect(JSON.parse(output ?? '{}')).toMatchObject({
      embeddingRunId: 'run-0001',
      count: 2,
      dimensions: 3,
      dtype: 'float32',
    });
  });
});

describe.skipIf(!BINS_BUILT)(
  'the python embed command in the built bin',
  () => {
    it('refuses the run when the route is off, and names the key that turns it on', () => {
      const result = spawnSync(
        process.execPath,
        [INDEX_BIN, 'python', 'embed', '--snapshot', 'snap-1', '--asset', 'a-1=images/red.jpg'],
        {
          encoding: 'utf8',
          env: { ...process.env, VISION_LENS_PYTHON_ROUTE: '' },
        },
      );
      expect(result.status).toBe(3);
      expect(`${result.stdout}${result.stderr}`).toContain('ROUTE_DISABLED');
      expect(`${result.stdout}${result.stderr}`).toContain('VISION_LENS_PYTHON_ROUTE');
    });

    it('refuses a run with no asset', () => {
      const result = spawnSync(
        process.execPath,
        [INDEX_BIN, 'python', 'embed', '--snapshot', 'snap-1'],
        { encoding: 'utf8', env: { ...process.env, VISION_LENS_PYTHON_ROUTE: '' } },
      );
      expect(result.status).toBe(2);
      expect(`${result.stdout}${result.stderr}`).toContain('--asset');
    });

    it('prints the help of the python group without touching the worker', () => {
      const result = spawnSync(process.execPath, [INDEX_BIN, 'python'], {
        encoding: 'utf8',
        env: { ...process.env, VISION_LENS_PYTHON_ROUTE: '' },
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('embed');
    });

    it('keeps the legacy help unchanged', () => {
      const result = spawnSync(process.execPath, [INDEX_BIN, '--help'], {
        encoding: 'utf8',
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toBe('error: unknown option \'--help\'\n');
    });
  },
);
