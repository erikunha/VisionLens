import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

// Each test spawns up to one bin process (~4.6s each in coverage mode);
// the vitest 5s default would flake. 30s holds even on slow CI runners.
vi.setConfig({ testTimeout: 30_000 });

/**
 * Golden help-parity test (spec 001, task 3.2).
 *
 * Pre-migration behavior (captured from the single-package CLI at the
 * feat/visual-lens baseline): `--help` exits 1 with exactly
 * "error: unknown option '--help'" on stderr, because the program is
 * registered with `.helpOption(false)` (help text lives in `help.ts` and is
 * printed by the action handler, not by Commander's built-in --help).
 *
 * The migration contract is PARITY, not the specific bytes:
 *   - `vision-lens --help` (dist/index.js) stays byte-identical to pre-migration output
 *   - the exit code stays the same
 *
 * The compatibility bin that used to print the same output plus one
 * deprecation line is gone, and its three assertions went with it: they
 * asserted the behavior of a bin this repository no longer ships. The
 * parity of the canonical bin is still asserted here, because that is the
 * property the migration promised.
 *
 * Requires built binaries. Skips (fast unit runs) when dist is missing; the
 * integration entry point is: pnpm --filter @vision-lens/cli test:bins
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_BIN = path.join(__dirname, '..', 'dist', 'index.js');
const BINS_BUILT = existsSync(INDEX_BIN);

interface BinResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number;
}

function runBin(bin: string): BinResult {
  const result = spawnSync(process.execPath, [bin, '--help'], {
    encoding: 'utf8',
  });
  expect(result.error).toBeUndefined();
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? -1,
  };
}

describe.skipIf(!BINS_BUILT)(
  'golden help parity: vision-lens (dist/index.js), requires built dist (pnpm --filter @vision-lens/cli test:bins)',
  () => {
    it('vision-lens --help matches the captured pre-migration output byte-for-byte', () => {
      const index = runBin(INDEX_BIN);
      expect(index.stdout).toBe('');
      expect(index.stderr).toBe('error: unknown option \'--help\'\n');
      expect(index.status).toBe(1);
    });
  },
);
