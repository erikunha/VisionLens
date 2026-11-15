import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  artifactRelativePath,
  digestOfContent,
  validateEmbeddingArtifact,
} from '../../src/facade/artifacts.js';
import { FacadeError } from '../../src/facade/errors.js';

/**
 * The artifact of the facade: the reference is relative and content
 * addressed, the digest of the content is recomputed and compared with what
 * the worker declared, and an artifact that leaves the approved root is
 * refused.
 *
 * The fixture is a REAL artifact: the Python side wrote it, and its digest
 * was computed by the Python side. The test that reads it proves that the
 * two languages agree on the canonical form of the digest, which is what
 * lets the facade check the bytes the worker wrote.
 */
const FIXTURE_ROOT = join(
  fileURLToPath(new URL('.', import.meta.url)),
  'fixtures',
  'artifact',
);

/** The digest the Python side computed for the fixture. */
const FIXTURE_DIGEST =
  '771aadcbc610c566165d9b247627af460b05c3f6263fb5fc3c862b54f66dd117';

const FIXTURE_RUN_ID = 'run-fixture-0001';

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'visionlens-facade-'));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe('the artifact of the facade', () => {
  it('names the artifact relative to the approved root', () => {
    expect(artifactRelativePath(FIXTURE_RUN_ID)).toBe(
      'artifacts/embedding/run-fixture-0001',
    );
  });

  it('refuses a run id that carries a path separator', () => {
    expect(() => artifactRelativePath('../escape')).toThrowError(FacadeError);
    expect(() => artifactRelativePath('a/b')).toThrowError(FacadeError);
    expect(() => artifactRelativePath('..')).toThrowError(FacadeError);
    expect(() => artifactRelativePath('')).toThrowError(FacadeError);
  });

  it('recomputes the digest of a manifest the Python side wrote', async () => {
    const raw = await readFile(
      join(FIXTURE_ROOT, 'artifacts', 'embedding', FIXTURE_RUN_ID, 'manifest.json'),
      'utf-8',
    );
    const digest = digestOfContent(JSON.parse(raw) as Record<string, unknown>);
    expect(digest).toBe(FIXTURE_DIGEST);
  });

  it('validates the real artifact and returns a relative reference', async () => {
    const reference = await validateEmbeddingArtifact({
      artifactRoot: FIXTURE_ROOT,
      embeddingRunId: FIXTURE_RUN_ID,
      sha256: FIXTURE_DIGEST,
      count: 2,
      dimensions: 3,
      dtype: 'float32',
    });

    expect(reference.kind).toBe('embedding');
    expect(reference.relativePath).toBe('artifacts/embedding/run-fixture-0001');
    expect(reference.relativePath.startsWith('/')).toBe(false);
    expect(reference.sha256).toBe(FIXTURE_DIGEST);
    expect(reference.bytes).toBe(2 * 3 * 4);
  });

  it('refuses a digest the worker did not declare', async () => {
    const error = await refusal({
      artifactRoot: FIXTURE_ROOT,
      embeddingRunId: FIXTURE_RUN_ID,
      sha256: 'f'.repeat(64),
      count: 2,
      dimensions: 3,
      dtype: 'float32',
    });
    expect(error.code).toBe('ARTIFACT_INVALID');
    expect(error.message).toContain(FIXTURE_DIGEST);
  });

  it('refuses a shape the manifest does not match', async () => {
    const error = await refusal({
      artifactRoot: FIXTURE_ROOT,
      embeddingRunId: FIXTURE_RUN_ID,
      sha256: FIXTURE_DIGEST,
      count: 5,
      dimensions: 3,
      dtype: 'float32',
    });
    expect(error.code).toBe('ARTIFACT_INVALID');
    expect(error.message).toContain('count');
  });

  it('refuses a dtype the manifest does not match', async () => {
    const error = await refusal({
      artifactRoot: FIXTURE_ROOT,
      embeddingRunId: FIXTURE_RUN_ID,
      sha256: FIXTURE_DIGEST,
      count: 2,
      dimensions: 3,
      dtype: 'float16',
    });
    expect(error.code).toBe('ARTIFACT_INVALID');
    expect(error.message).toContain('dtype');
  });

  it('refuses an artifact that is not on disk', async () => {
    const error = await refusal({
      artifactRoot: FIXTURE_ROOT,
      embeddingRunId: 'run-that-never-happened',
      sha256: FIXTURE_DIGEST,
      count: 2,
      dimensions: 3,
      dtype: 'float32',
    });
    expect(error.code).toBe('ARTIFACT_INVALID');
    expect(error.message).toContain('not on disk');
  });

  it('refuses an artifact root that was never configured', async () => {
    const error = await refusal({
      artifactRoot: '',
      embeddingRunId: FIXTURE_RUN_ID,
      sha256: FIXTURE_DIGEST,
      count: 2,
      dimensions: 3,
      dtype: 'float32',
    });
    expect(error.code).toBe('ARTIFACT_INVALID');
    expect(error.message).toContain('no artifact root');
  });

  it('refuses vectors whose bytes do not match the digest of the manifest', async () => {
    const root = join(scratch, 'root');
    const directory = join(root, 'artifacts', 'embedding', FIXTURE_RUN_ID);
    await mkdir(directory, { recursive: true });
    const manifest = JSON.parse(
      await readFile(
        join(FIXTURE_ROOT, 'artifacts', 'embedding', FIXTURE_RUN_ID, 'manifest.json'),
        'utf-8',
      ),
    ) as Record<string, unknown>;
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
    await writeFile(join(directory, 'vectors.f32'), Buffer.alloc(2 * 3 * 4, 7));

    const error = await refusal({
      artifactRoot: root,
      embeddingRunId: FIXTURE_RUN_ID,
      sha256: FIXTURE_DIGEST,
      count: 2,
      dimensions: 3,
      dtype: 'float32',
    });
    expect(error.code).toBe('ARTIFACT_INVALID');
    expect(error.message).toContain('hash to');
  });

  it('refuses a manifest whose own content does not hash to its digest', async () => {
    const root = join(scratch, 'root');
    const directory = join(root, 'artifacts', 'embedding', FIXTURE_RUN_ID);
    await mkdir(directory, { recursive: true });
    const manifest = JSON.parse(
      await readFile(
        join(FIXTURE_ROOT, 'artifacts', 'embedding', FIXTURE_RUN_ID, 'manifest.json'),
        'utf-8',
      ),
    ) as Record<string, unknown>;
    await writeFile(
      join(directory, 'manifest.json'),
      JSON.stringify({ ...manifest, count: 7 }),
    );
    await writeFile(
      join(directory, 'vectors.f32'),
      await readFile(join(FIXTURE_ROOT, 'artifacts', 'embedding', FIXTURE_RUN_ID, 'vectors.f32')),
    );

    const error = await refusal({
      artifactRoot: root,
      embeddingRunId: FIXTURE_RUN_ID,
      sha256: FIXTURE_DIGEST,
      count: 2,
      dimensions: 3,
      dtype: 'float32',
    });
    expect(error.code).toBe('ARTIFACT_INVALID');
    expect(error.message).toContain('hashes to');
  });

  it('refuses an artifact that leaves the approved root through a link', async () => {
    const outside = join(scratch, 'outside');
    const directory = join(outside, 'artifacts', 'embedding', FIXTURE_RUN_ID);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'manifest.json'),
      await readFile(
        join(FIXTURE_ROOT, 'artifacts', 'embedding', FIXTURE_RUN_ID, 'manifest.json'),
      ),
    );
    await writeFile(
      join(directory, 'vectors.f32'),
      await readFile(join(FIXTURE_ROOT, 'artifacts', 'embedding', FIXTURE_RUN_ID, 'vectors.f32')),
    );

    const root = join(scratch, 'root');
    await mkdir(join(root, 'artifacts', 'embedding'), { recursive: true });
    await symlink(outside, join(root, 'artifacts', 'embedding', FIXTURE_RUN_ID));

    const error = await refusal({
      artifactRoot: root,
      embeddingRunId: FIXTURE_RUN_ID,
      sha256: FIXTURE_DIGEST,
      count: 2,
      dimensions: 3,
      dtype: 'float32',
    });
    expect(error.code).toBe('ARTIFACT_INVALID');
    expect(error.message).toContain('leaves the approved artifact root');
  });
});

/** Runs the validation and returns the error it raised. */
async function refusal(claim: Parameters<typeof validateEmbeddingArtifact>[0]): Promise<FacadeError> {
  try {
    await validateEmbeddingArtifact(claim);
  } catch (error) {
    if (error instanceof FacadeError) return error;
    throw error;
  }
  throw new Error('the validation refused nothing');
}
