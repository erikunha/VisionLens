import type { DerivedArtifact, ModelVersion } from '@vision-lens/contracts';

import { findModel, type DatasetRegistry, type ModelRegistryEntry } from '../benchmark/registry.js';
import { newEntityId } from '../store/ids.js';
import type { Repositories } from '../store/repositories/index.js';

import { validateEmbeddingManifest } from './embedding-manifest.js';

/**
 * The single-writer commit of one embedding run.
 *
 * The Python runtime writes the artifact and never writes a domain row:
 * the store is the sole writer of the domain, and this module is the
 * TypeScript side of that boundary
 * (`docs/vnext/08-DOMAIN-STORE-AND-PROVENANCE.md:46`). It takes the
 * manifest the Python side wrote and commits what the store owns: the
 * model version of the encoder and the derived artifact of the run.
 *
 * Every refusal happens BEFORE the first write, so a commit that is
 * refused leaves the store exactly as it was: an invalid manifest, a
 * model the registry does not record, a manifest of another revision,
 * and an asset the store does not know are four refusals and no row.
 *
 * The registry is the switch: a model that is not in
 * `datasets/registry.json` cannot be committed, so removing the entry
 * disables the adapter (`docs/vnext/specs/VLN-005-python-cpu-vision-adapter.md:30`).
 */

/** The kind of the derived artifact an embedding run produces. */
export const EMBEDDING_ARTIFACT_KIND = 'embedding' as const;

/** The transform of an embedding run: the model and the revision it ran. */
export function embeddingTransform(modelId: string, revision: string): string {
  return `embed:${modelId}@${revision}`;
}

/** The result of a commit: what was written, or why nothing was. */
export type EmbeddingCommitResult =
  | {
      readonly ok: true;
      /** The derived artifact of the run. */
      readonly artifact: DerivedArtifact;
      /** The id of the model version of the encoder. */
      readonly modelVersionId: string;
      /** The assets the embedding was derived from. */
      readonly sourceAssetIds: readonly string[];
    }
  | {
      readonly ok: false;
      /** Every refusal, in the order they were found. */
      readonly issues: readonly string[];
    };

/** What the commit needs: the manifest, the store and the registry. */
export interface EmbeddingCommitInput {
  /** The manifest of the run, as the Python side wrote it. */
  readonly manifest: unknown;
  /** The repositories of the store that owns the domain rows. */
  readonly repositories: Repositories;
  /** The registry the model record comes from. */
  readonly registry: DatasetRegistry;
  /** The clock, injectable so the tests are deterministic. */
  readonly now?: () => string;
  /** The id factory, injectable so the tests are deterministic. */
  readonly newId?: () => string;
}

/**
 * Commit the embedding run of one manifest.
 *
 * The commit is refused, and nothing is written, when:
 *
 *  - the manifest does not validate against the ratified schema;
 *  - the registry does not record the model (the rollback switch);
 *  - the manifest names another revision or another digest than the
 *    record, so it is the manifest of another model;
 *  - the store does not know one of the assets the run embedded, so the
 *    lineage would point at nothing.
 */
export function commitEmbeddingRun(input: EmbeddingCommitInput): EmbeddingCommitResult {
  const validation = validateEmbeddingManifest(input.manifest);
  if (!validation.ok) {
    return { ok: false, issues: validation.issues };
  }
  const manifest = validation.manifest;

  let record: ModelRegistryEntry;
  try {
    record = findModel(input.registry, manifest.modelId);
  } catch (error) {
    // The registry is the switch, so a model nobody recorded is a
    // refusal of the commit and not a crash of the caller.
    return {
      ok: false,
      issues: [
        error instanceof Error ? error.message : `the registry records no model '${manifest.modelId}'`,
      ],
    };
  }
  if (record.revision !== manifest.revision) {
    return {
      ok: false,
      issues: [
        `revision: the manifest carries ${manifest.revision} and the registry records ${record.revision}`,
      ],
    };
  }
  if (record.sourceDigest !== manifest.weightsDigest) {
    return {
      ok: false,
      issues: [
        `weightsDigest: the manifest carries ${manifest.weightsDigest} and the registry records ${record.sourceDigest}`,
      ],
    };
  }

  const sourceAssetIds: string[] = [];
  for (const digest of manifest.assetSha256) {
    const asset = input.repositories.assets.findBySha256(digest);
    if (asset === undefined) {
      return {
        ok: false,
        issues: [
          `assetSha256: the store knows no asset with the digest ${digest}, and a derived artifact cannot point at an asset that does not exist`,
        ],
      };
    }
    sourceAssetIds.push(asset.id);
  }
  if (sourceAssetIds.length === 0) {
    return {
      ok: false,
      issues: ['assetSha256: the run embedded no asset, and a derived artifact needs a source'],
    };
  }

  const now = input.now ?? (() => new Date().toISOString());
  const newId = input.newId ?? (() => newEntityId());
  const modelVersion = ensureModelVersion(input.repositories, record.modelId, record.revision, {
    now,
    newId,
  });

  const snapshot = input.repositories.snapshots.getById(manifest.snapshotId);
  const artifact = input.repositories.derivedArtifacts.insert(
    {
      id: newId(),
      kind: EMBEDDING_ARTIFACT_KIND,
      sourceAssetIds,
      ...(snapshot === undefined ? {} : { sourceSnapshotId: snapshot.id }),
      transform: embeddingTransform(record.modelId, record.revision),
      transformFingerprint: manifest.preprocessingFingerprint,
      createdAt: now(),
    },
    { encoderModelVersionId: modelVersion.id },
  );

  return {
    ok: true,
    artifact,
    modelVersionId: modelVersion.id,
    sourceAssetIds,
  };
}

/**
 * The model version of the encoder, registered once.
 *
 * The recipe of the version IS the registry record, so the auditor walk
 * from an artifact reaches the model, the revision and the digest of the
 * weights that produced it. A version that is already registered is
 * reused: the record is immutable, and a second row would be a second
 * truth about the same encoder.
 */
function ensureModelVersion(
  repositories: Repositories,
  modelId: string,
  revision: string,
  clock: { now: () => string; newId: () => string },
): ModelVersion {
  const existing = repositories.models.findByNameAndVersion(modelId, revision);
  if (existing !== undefined) {
    return existing;
  }
  return repositories.models.insert({
    id: clock.newId(),
    name: modelId,
    version: revision,
    registryState: 'registered',
    recipe: { modelId, revision },
    createdAt: clock.now(),
  });
}
