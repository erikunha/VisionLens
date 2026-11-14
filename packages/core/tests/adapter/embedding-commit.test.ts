import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { commitEmbeddingRun, embeddingTransform } from '../../src/adapter/embedding-commit.js';
import { embeddingContentDigest } from '../../src/adapter/embedding-manifest.js';
import { DatasetRegistrySchema } from '../../src/benchmark/registry.js';
import { assetFixture, createTestStore, FAKE_SHA256 } from '../store/helpers.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/** The tracked registry, the file that carries the model record. */
const registryPath = path.join(repoRoot, 'datasets', 'registry.json');

/** The model the registry records. */
const MODEL_ID = 'siglip2-base';

/** The revision the registry records. */
const REVISION = '75de2d55ec2d0b4efc50b3e9ad70dba96a7b2fa2';

/** The digest of the weights the registry records. */
const WEIGHTS_DIGEST = '612923381c76ec5a9bed335d1c48827e3f2e506ac31b044b63b2031fadee6a0b';

/** A manifest of one run over one asset. */
function manifestFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const manifest: Record<string, unknown> = {
    schemaVersion: 1,
    embeddingRunId: 'embed-0123456789abcdef',
    modelId: MODEL_ID,
    revision: REVISION,
    sourceUri: `https://huggingface.co/google/${MODEL_ID}/resolve/${REVISION}/model.safetensors`,
    weightsDigest: WEIGHTS_DIGEST,
    preprocessingFingerprint: 'fp2:83adc4ef99979644',
    preprocessingComponents: { interpolation: 'bilinear' },
    snapshotId: 'snapshot-1',
    assetSha256: [FAKE_SHA256],
    count: 1,
    dimension: 4,
    dtype: 'float32',
    vectorsFileDigest: 'b'.repeat(64),
    device: 'cpu',
    runtimeVersions: { pillow: '13.0.0' },
    createdAt: '2026-11-14T18:00:00.000Z',
    latency: { count: 1, p50Ms: 12, p95Ms: 12, totalMs: 12 },
    peakMemoryBytes: 1024,
    license: 'apache-2.0',
    calibrationStatus: 'uncalibrated',
    ...overrides,
  };
  // The digest of the manifest is the ADDRESS of its content, so the
  // fixture carries the one its own content hashes to. A fixture that
  // names another digest keeps it, because the commit has to refuse it.
  if (typeof manifest.artifactDigest === 'string') return manifest;
  return { ...manifest, artifactDigest: embeddingContentDigest(manifest) };
}

/** The tracked registry, parsed by the reader that validates it. */
function trackedRegistry(): ReturnType<typeof DatasetRegistrySchema.parse> {
  return DatasetRegistrySchema.parse(JSON.parse(readFileSync(registryPath, 'utf8')));
}

describe('the single-writer commit of an embedding run', () => {
  it('commits a derived artifact of kind embedding with the lineage of the run', async () => {
    // Task 5.1: the commit writes the artifact the manifest describes,
    // with the sources it was derived from, the transform that produced
    // it and the fingerprint of that transform.
    const store = await createTestStore();
    try {
      const asset = store.repos.assets.insert(assetFixture({ sha256: FAKE_SHA256 }));

      const result = commitEmbeddingRun({
        manifest: manifestFixture(),
        repositories: store.repos,
        registry: trackedRegistry(),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.artifact.kind).toBe('embedding');
      expect(result.artifact.sourceAssetIds).toEqual([asset.id]);
      expect(result.artifact.transform).toBe(`embed:${MODEL_ID}@${REVISION}`);
      expect(result.artifact.transformFingerprint).toBe('fp2:83adc4ef99979644');
      expect(result.artifact.transformFingerprint).toMatch(/^fp2:[0-9a-f]{16}$/);
    } finally {
      store.cleanup();
    }
  });

  it('resolves the committed artifact to the model version of the encoder', async () => {
    // Task 5.3: an artifact that does not resolve to a model version
    // cannot be audited, so the encoder link is the store-owned column
    // and the version is registered with the record as its recipe.
    const store = await createTestStore();
    try {
      store.repos.assets.insert(assetFixture({ sha256: FAKE_SHA256 }));

      const result = commitEmbeddingRun({
        manifest: manifestFixture(),
        repositories: store.repos,
        registry: trackedRegistry(),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const modelVersion = store.repos.models.getById(result.modelVersionId);
      expect(modelVersion).toBeDefined();
      expect(modelVersion?.name).toBe(MODEL_ID);
      expect(modelVersion?.version).toBe(REVISION);
      expect(store.repos.derivedArtifacts.listByEncoder(result.modelVersionId)).toHaveLength(1);
    } finally {
      store.cleanup();
    }
  });

  it('writes no row when the manifest names an asset the store does not know', async () => {
    // Task 5.2: the lineage of a derived artifact must point at assets
    // that exist, so a manifest with an unknown source writes nothing.
    const store = await createTestStore();
    try {
      const result = commitEmbeddingRun({
        manifest: manifestFixture({ assetSha256: ['d'.repeat(64)] }),
        repositories: store.repos,
        registry: trackedRegistry(),
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues.join(' ')).toContain('assetSha256');
      expect(store.repos.derivedArtifacts.listBySnapshot('snapshot-1')).toHaveLength(0);
      expect(store.repos.models.findByNameAndVersion(MODEL_ID, REVISION)).toBeUndefined();
    } finally {
      store.cleanup();
    }
  });

  it('writes no row when the manifest does not validate', async () => {
    const store = await createTestStore();
    try {
      const result = commitEmbeddingRun({
        manifest: manifestFixture({ dimension: 'seven hundred' }),
        repositories: store.repos,
        registry: trackedRegistry(),
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues.join(' ')).toContain('dimension');
      expect(store.repos.models.findByNameAndVersion(MODEL_ID, REVISION)).toBeUndefined();
    } finally {
      store.cleanup();
    }
  });

  it('refuses a manifest of another revision than the record', async () => {
    const store = await createTestStore();
    try {
      store.repos.assets.insert(assetFixture({ sha256: FAKE_SHA256 }));

      const result = commitEmbeddingRun({
        manifest: manifestFixture({ revision: '0'.repeat(40) }),
        repositories: store.repos,
        registry: trackedRegistry(),
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues.join(' ')).toContain('revision');
    } finally {
      store.cleanup();
    }
  });

  it('is disabled by removing the model from the registry', async () => {
    // Task 5.5: the registry is the switch. A registry without the model
    // refuses the commit, so the adapter is disabled without a code
    // change.
    const store = await createTestStore();
    try {
      store.repos.assets.insert(assetFixture({ sha256: FAKE_SHA256 }));
      const registry = trackedRegistry();
      const withoutTheModel = { ...registry, models: [] };

      const result = commitEmbeddingRun({
        manifest: manifestFixture(),
        repositories: store.repos,
        registry: withoutTheModel,
      });

      expect(result.ok).toBe(false);
      expect(store.repos.derivedArtifacts.listBySnapshot('snapshot-1')).toHaveLength(0);
    } finally {
      store.cleanup();
    }
  });

  it('names the transform of a run the way the domain names it', () => {
    expect(embeddingTransform(MODEL_ID, REVISION)).toBe(`embed:${MODEL_ID}@${REVISION}`);
  });

  it('refuses a manifest whose digest is not the address of its own content', async () => {
    // The pack asks that a new result artifact becomes visible only after
    // its checksum, and a digest that is not the checksum of the content
    // is not a checksum.
    const store = await createTestStore();
    try {
      store.repos.assets.insert(assetFixture({ sha256: FAKE_SHA256 }));

      const result = commitEmbeddingRun({
        manifest: manifestFixture({ artifactDigest: 'c'.repeat(64) }),
        repositories: store.repos,
        registry: trackedRegistry(),
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues.join(' ')).toContain('artifactDigest');
      expect(store.repos.models.findByNameAndVersion(MODEL_ID, REVISION)).toBeUndefined();
      expect(store.repos.derivedArtifacts.listBySnapshot('snapshot-1')).toHaveLength(0);
    } finally {
      store.cleanup();
    }
  });

  it('commits the same content once, and a second commit writes no second row', async () => {
    // The pack asks that a transaction across repositories uses an
    // idempotency key: the key here is the content itself.
    const store = await createTestStore();
    try {
      store.repos.assets.insert(assetFixture({ sha256: FAKE_SHA256 }));

      const first = commitEmbeddingRun({
        manifest: manifestFixture(),
        repositories: store.repos,
        registry: trackedRegistry(),
      });
      const second = commitEmbeddingRun({
        manifest: manifestFixture({ embeddingRunId: 'embed-another-run' }),
        repositories: store.repos,
        registry: trackedRegistry(),
      });

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (!first.ok || !second.ok) return;
      expect(second.artifact.id).toBe(first.artifact.id);
      expect(store.repos.derivedArtifacts.listByEncoder(first.modelVersionId)).toHaveLength(1);
    } finally {
      store.cleanup();
    }
  });

  it('accepts the manifest the Python side really wrote', async () => {
    // The committed artifact of the recorded run: the digest in it was
    // computed by the Python side, and the TypeScript side recomputes the
    // same address over the same canonical JSON.
    const manifestPath = path.join(
      repoRoot,
      'benchmarks',
      'parity',
      'vision-embed.artifact',
      'manifest.json',
    );
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;

    expect(embeddingContentDigest(manifest)).toBe(manifest.artifactDigest);

    const store = await createTestStore();
    try {
      for (const digest of manifest.assetSha256 as string[]) {
        store.repos.assets.insert(assetFixture({ sha256: digest }));
      }

      const result = commitEmbeddingRun({
        manifest,
        repositories: store.repos,
        registry: trackedRegistry(),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.artifact.sourceAssetIds).toHaveLength(
        (manifest.assetSha256 as string[]).length,
      );
    } finally {
      store.cleanup();
    }
  });
});

describe('the Python runtime holds no database dependency', () => {
  it('never imports a database driver', () => {
    // Task 5.4: the Python side writes no domain row, so it holds no
    // database dependency at all.
    const pythonRoot = path.join(repoRoot, 'python', 'visionlens', 'src', 'visionlens');
    const offenders: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory)) {
        const full = path.join(directory, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!full.endsWith('.py')) continue;
        const source = readFileSync(full, 'utf8');
        if (/^\s*(import|from)\s+(sqlite3|sqlalchemy|psycopg)\b/m.test(source)) {
          offenders.push(path.relative(repoRoot, full));
        }
      }
    };
    walk(pythonRoot);

    expect(offenders).toEqual([]);
  });
});
