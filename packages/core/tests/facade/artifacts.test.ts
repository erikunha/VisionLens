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
 * The fixture is a REAL artifact: it is the golden artifact of the
 * repository (`benchmarks/parity/vision-embed.artifact/`), written by the
 * Python side over the committed fixtures, with the digest the Python side
 * computed. The test that reads it proves that the two languages agree on
 * the canonical form of the digest, which is what lets the facade check the
 * bytes the worker wrote.
 */
const FIXTURE_ROOT = join(
  fileURLToPath(new URL('.', import.meta.url)),
  'fixtures',
  'artifact',
);

/** The digest the Python side computed for the fixture. */
const FIXTURE_DIGEST =
  '4f706336517e10f7194963241c623af1d5039f4fc74fb3bc9c7479bfeaaf586a';

const FIXTURE_RUN_ID = 'embed-23961656d069411baecac8e1d638b47f';

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
      `artifacts/embedding/${FIXTURE_RUN_ID}`,
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
      count: 6,
      dimensions: 768,
      dtype: 'float32',
    });

    expect(reference.reference.kind).toBe('embedding');
    expect(reference.reference.relativePath).toBe(
      `artifacts/embedding/${FIXTURE_RUN_ID}`,
    );
    expect(reference.reference.relativePath.startsWith('/')).toBe(false);
    expect(reference.reference.sha256).toBe(FIXTURE_DIGEST);
    expect(reference.reference.bytes).toBe(6 * 768 * 4);
    expect(reference.transform).toEqual({
      modelId: 'siglip2-base',
      revision: '75de2d55ec2d0b4efc50b3e9ad70dba96a7b2fa2',
      preprocessingFingerprint: 'fp2:83adc4ef99979644',
    });
  });

  it('refuses a digest the worker did not declare', async () => {
    const error = await refusal({
      artifactRoot: FIXTURE_ROOT,
      embeddingRunId: FIXTURE_RUN_ID,
      sha256: 'f'.repeat(64),
      count: 6,
      dimensions: 768,
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
      count: 6,
      dimensions: 768,
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
      count: 6,
      dimensions: 768,
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
      count: 6,
      dimensions: 768,
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
      count: 6,
      dimensions: 768,
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
      count: 6,
      dimensions: 768,
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
      count: 6,
      dimensions: 768,
      dtype: 'float32',
    });
    expect(error.code).toBe('ARTIFACT_INVALID');
    expect(error.message).toContain('leaves the approved artifact root');
  });

  it('refuses a vectors file that is a link out of the approved root', async () => {
    const root = join(scratch, 'root');
    const directory = join(root, 'artifacts', 'embedding', FIXTURE_RUN_ID);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'manifest.json'),
      await readFile(
        join(FIXTURE_ROOT, 'artifacts', 'embedding', FIXTURE_RUN_ID, 'manifest.json'),
      ),
    );
    const outside = join(scratch, 'outside.bin');
    await writeFile(
      outside,
      await readFile(join(FIXTURE_ROOT, 'artifacts', 'embedding', FIXTURE_RUN_ID, 'vectors.f32')),
    );
    await symlink(outside, join(directory, 'vectors.f32'));

    const error = await refusal({
      artifactRoot: root,
      embeddingRunId: FIXTURE_RUN_ID,
      sha256: FIXTURE_DIGEST,
      count: 6,
      dimensions: 768,
      dtype: 'float32',
    });
    expect(error.code).toBe('ARTIFACT_INVALID');
    expect(error.message).toContain('not a regular file');
  });

  it('refuses a manifest that is a link out of the approved root', async () => {
    const root = join(scratch, 'root');
    const directory = join(root, 'artifacts', 'embedding', FIXTURE_RUN_ID);
    await mkdir(directory, { recursive: true });
    const outside = join(scratch, 'outside.json');
    await writeFile(
      outside,
      await readFile(
        join(FIXTURE_ROOT, 'artifacts', 'embedding', FIXTURE_RUN_ID, 'manifest.json'),
      ),
    );
    await symlink(outside, join(directory, 'manifest.json'));
    await writeFile(
      join(directory, 'vectors.f32'),
      await readFile(join(FIXTURE_ROOT, 'artifacts', 'embedding', FIXTURE_RUN_ID, 'vectors.f32')),
    );

    const error = await refusal({
      artifactRoot: root,
      embeddingRunId: FIXTURE_RUN_ID,
      sha256: FIXTURE_DIGEST,
      count: 6,
      dimensions: 768,
      dtype: 'float32',
    });
    expect(error.code).toBe('ARTIFACT_INVALID');
    expect(error.message).toContain('not a regular file');
  });

  it('refuses a manifest that names another run', async () => {
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
      JSON.stringify({ ...manifest, embeddingRunId: 'run-other' }),
    );
    await writeFile(
      join(directory, 'vectors.f32'),
      await readFile(join(FIXTURE_ROOT, 'artifacts', 'embedding', FIXTURE_RUN_ID, 'vectors.f32')),
    );

    const error = await refusal({
      artifactRoot: root,
      embeddingRunId: FIXTURE_RUN_ID,
      sha256: FIXTURE_DIGEST,
      count: 6,
      dimensions: 768,
      dtype: 'float32',
    });
    expect(error.code).toBe('ARTIFACT_INVALID');
    expect(error.message).toContain('names the run');
  });

  it('refuses a manifest whose model id carries an escape sequence', async () => {
    const root = join(scratch, 'root');
    const directory = join(root, 'artifacts', 'embedding', FIXTURE_RUN_ID);
    await mkdir(directory, { recursive: true });
    const manifest = JSON.parse(
      await readFile(
        join(FIXTURE_ROOT, 'artifacts', 'embedding', FIXTURE_RUN_ID, 'manifest.json'),
        'utf-8',
      ),
    ) as Record<string, unknown>;
    // The worker signs the manifest it wrote, so the digest of the tampered
    // manifest is consistent: the check that refuses it is the one on the
    // alphabet of the name, not the one on the digest.
    const tampered = { ...manifest, modelId: 'evil\nrm -rf /' };
    const digest = digestOfContent(tampered);
    await writeFile(
      join(directory, 'manifest.json'),
      JSON.stringify({ ...tampered, artifactDigest: digest }),
    );
    await writeFile(
      join(directory, 'vectors.f32'),
      await readFile(join(FIXTURE_ROOT, 'artifacts', 'embedding', FIXTURE_RUN_ID, 'vectors.f32')),
    );

    const error = await refusal({
      artifactRoot: root,
      embeddingRunId: FIXTURE_RUN_ID,
      sha256: digest,
      count: 6,
      dimensions: 768,
      dtype: 'float32',
    });
    expect(error.code).toBe('ARTIFACT_INVALID');
    expect(error.message).toContain('bounded name');
  });

  it('refuses an artifact that embedded other assets', async () => {
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
    await writeFile(
      join(directory, 'vectors.f32'),
      await readFile(join(FIXTURE_ROOT, 'artifacts', 'embedding', FIXTURE_RUN_ID, 'vectors.f32')),
    );

    const error = await refusal({
      artifactRoot: root,
      embeddingRunId: FIXTURE_RUN_ID,
      sha256: FIXTURE_DIGEST,
      count: 6,
      dimensions: 768,
      dtype: 'float32',
      expectedAssetDigests: ['a'.repeat(64), 'b'.repeat(64)],
    });
    expect(error.code).toBe('ARTIFACT_INVALID');
    expect(error.message).toContain('embedded');
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
