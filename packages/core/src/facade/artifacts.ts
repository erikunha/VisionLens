import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { canonicalJson } from '@vision-lens/contracts';
import { FacadeError } from './errors.js';

/**
 * The artifact of the facade.
 *
 * The Python side writes the bytes and the facade validates them. The
 * artifact of an embedding run is a DIRECTORY under the approved root:
 *
 *   <root>/artifacts/embedding/<run-id>/manifest.json
 *   <root>/artifacts/embedding/<run-id>/vectors.f32
 *
 * The manifest is the descriptor and the vectors are the content. The
 * manifest carries the digest of the vectors, and the artifact digest covers
 * the CONTENT of the run: the model, the revision, the preprocessing, the
 * snapshot, the assets, the shape and the digest of the vectors. The run id,
 * the timestamp, the latency, the device and the runtime versions describe
 * the RUN and not the content, so two runs of the same content share the
 * address.
 *
 * ## The reference is relative and content addressed
 *
 * The facade never emits an absolute path and never accepts one back. The
 * reference it returns names the artifact RELATIVE to the approved root and
 * carries the digest of the content, so the same digest always names the
 * same bytes.
 *
 * ## The bytes are checked before the store row is written
 *
 * The facade recomputes the artifact digest from the manifest, recomputes the
 * digest of the vectors file and compares both with what the worker
 * declared. A mismatch is `ARTIFACT_INVALID` and nothing is committed: a
 * manifest that cannot be verified is a claim, not an artifact.
 *
 * ## The two languages agree on the canonical form
 *
 * The digest is computed over the canonical JSON of the content fields, and
 * the canonical form is the one the TypeScript side writes
 * (`packages/contracts/src/fingerprint.ts:33`) and the Python side copies
 * (`python/visionlens/src/visionlens/runtime/fingerprint.py:38`). The two
 * implementations agree byte for byte, which is what lets the facade
 * recompute a digest the worker computed.
 */

/** The kind of the artifact of an embedding run. */
export const FACADE_ARTIFACT_KIND = 'embedding';

/** The name of the vectors file inside the artifact directory. */
export const FACADE_VECTORS_FILE = 'vectors.f32';

/** The name of the manifest inside the artifact directory. */
export const FACADE_MANIFEST_FILE = 'manifest.json';

/**
 * The fields the artifact digest covers.
 *
 * The list is the one of the Python side
 * (`python/visionlens/src/visionlens/inference/artifact.py:52`): the content
 * of the run, and nothing that describes the run itself.
 */
export const FACADE_ARTIFACT_CONTENT_FIELDS = [
  'schemaVersion',
  'modelId',
  'revision',
  'sourceUri',
  'weightsDigest',
  'preprocessingFingerprint',
  'preprocessingComponents',
  'snapshotId',
  'assetSha256',
  'count',
  'dimension',
  'dtype',
  'vectorsFileDigest',
] as const;

/** A reference to an artifact: relative, content addressed, never absolute. */
export interface FacadeArtifactReference {
  /** The kind of the artifact. */
  readonly kind: typeof FACADE_ARTIFACT_KIND;
  /** The path of the artifact, relative to the approved root. */
  readonly relativePath: string;
  /** The digest of the content of the artifact. */
  readonly sha256: string;
  /** The number of bytes of the vectors file. */
  readonly bytes: number;
}

/** What the worker claimed about the artifact it wrote. */
export interface FacadeArtifactClaim {
  /** The approved root the artifacts live under. */
  readonly artifactRoot: string;
  /** The id of the run, which names the directory of the artifact. */
  readonly embeddingRunId: string;
  /** The digest the worker declared. */
  readonly sha256: string;
  /** The number of vectors the worker declared. */
  readonly count: number;
  /** The dimension of the vectors the worker declared. */
  readonly dimensions: number;
  /** The dtype the worker declared. */
  readonly dtype: string;
}

/**
 * The relative path of the artifact of a run.
 *
 * The run id comes from the wire, so it is NOT trusted: an id that carries a
 * separator or a parent reference is refused here, before any path is
 * resolved. The layout is the one of the store
 * (`docs/vnext/08-DOMAIN-STORE-AND-PROVENANCE.md:35`).
 */
export function artifactRelativePath(embeddingRunId: string): string {
  if (typeof embeddingRunId !== 'string' || embeddingRunId.length === 0) {
    throw new FacadeError(
      'ARTIFACT_INVALID',
      'the result of the run carries no embeddingRunId, and the artifact has no name without it',
    );
  }
  if (embeddingRunId.includes('\0')) {
    throw new FacadeError(
      'ARTIFACT_INVALID',
      'the embeddingRunId of the run carries a null byte',
    );
  }
  if (embeddingRunId.includes('/') || embeddingRunId.includes('\\')) {
    throw new FacadeError(
      'ARTIFACT_INVALID',
      `the embeddingRunId "${embeddingRunId}" carries a path separator, and an id names a directory without being a path`,
    );
  }
  if (embeddingRunId === '.' || embeddingRunId === '..') {
    throw new FacadeError(
      'ARTIFACT_INVALID',
      `the embeddingRunId "${embeddingRunId}" is a parent reference`,
    );
  }
  return `artifacts/${FACADE_ARTIFACT_KIND}/${embeddingRunId}`;
}

/**
 * Resolves the directory of an artifact against the approved root.
 *
 * Three things are checked, in this order, and each of them refuses:
 *
 *  - the resolved directory is INSIDE the root, which refuses a traversal;
 *  - the real path of the directory is inside the real path of the root,
 *    which refuses a symlink that escapes;
 *  - the directory exists, because an artifact that is not there is not an
 *    artifact.
 */
async function resolveArtifactDirectory(
  artifactRoot: string,
  relativePath: string,
): Promise<string> {
  if (typeof artifactRoot !== 'string' || artifactRoot.trim().length === 0) {
    throw new FacadeError(
      'ARTIFACT_INVALID',
      'no artifact root is configured, so the artifact of the run cannot be resolved',
    );
  }
  const root = resolve(artifactRoot);
  const target = resolve(root, relativePath);

  const fromRoot = relative(root, target);
  if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
    throw new FacadeError(
      'ARTIFACT_INVALID',
      `the artifact "${relativePath}" resolves outside the approved artifact root`,
    );
  }

  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = await realpath(root);
    realTarget = await realpath(target);
  } catch {
    throw new FacadeError(
      'ARTIFACT_INVALID',
      `the artifact "${relativePath}" is not on disk under the approved artifact root`,
    );
  }
  const fromRealRoot = relative(realRoot, realTarget);
  if (fromRealRoot.startsWith('..') || isAbsolute(fromRealRoot)) {
    throw new FacadeError(
      'ARTIFACT_INVALID',
      `the artifact "${relativePath}" leaves the approved artifact root through a link`,
    );
  }
  return target;
}

/**
 * Validates the artifact of a run and returns the reference of it.
 *
 * The reference is relative, carries the digest of the content and the
 * number of bytes of the vectors file.
 *
 * @throws FacadeError with the code `ARTIFACT_INVALID` when the artifact is
 *     missing, when it leaves the approved root, when the digest the worker
 *     declared is not the digest of the manifest, when the manifest does not
 *     match the shape the worker declared, or when the bytes on disk do not
 *     match the digest of the manifest.
 */
export async function validateEmbeddingArtifact(
  claim: FacadeArtifactClaim,
): Promise<FacadeArtifactReference> {
  const relativePath = artifactRelativePath(claim.embeddingRunId);
  const directory = await resolveArtifactDirectory(claim.artifactRoot, relativePath);

  const manifest = await readManifest(join(directory, FACADE_MANIFEST_FILE), relativePath);

  const declared = manifest['artifactDigest'];
  if (typeof declared !== 'string' || !/^[0-9a-f]{64}$/.test(declared)) {
    throw new FacadeError(
      'ARTIFACT_INVALID',
      `the manifest of "${relativePath}" carries no artifactDigest, and a result that cannot be attributed is not a result`,
    );
  }
  if (declared !== claim.sha256) {
    throw new FacadeError(
      'ARTIFACT_INVALID',
      `the artifact "${relativePath}" declares the digest ${declared} while the run declared ${claim.sha256}`,
    );
  }

  const recomputed = digestOfContent(manifest);
  if (recomputed !== declared) {
    throw new FacadeError(
      'ARTIFACT_INVALID',
      `the manifest of "${relativePath}" declares the digest ${declared} while its own content hashes to ${recomputed}`,
    );
  }

  requireMatchingNumber(manifest, 'count', claim.count, relativePath);
  requireMatchingNumber(manifest, 'dimension', claim.dimensions, relativePath);
  const dtype = manifest['dtype'];
  if (dtype !== claim.dtype) {
    throw new FacadeError(
      'ARTIFACT_INVALID',
      `the artifact "${relativePath}" declares the dtype ${String(dtype)} while the run declared ${claim.dtype}`,
    );
  }

  const vectorsDigest = manifest['vectorsFileDigest'];
  if (typeof vectorsDigest !== 'string' || !/^[0-9a-f]{64}$/.test(vectorsDigest)) {
    throw new FacadeError(
      'ARTIFACT_INVALID',
      `the manifest of "${relativePath}" carries no vectorsFileDigest, and the bytes of the vectors cannot be checked without it`,
    );
  }

  const vectors = await readFile(join(directory, FACADE_VECTORS_FILE)).catch(() => {
    throw new FacadeError(
      'ARTIFACT_INVALID',
      `the vectors of "${relativePath}" are not on disk under the approved artifact root`,
    );
  });
  const actual = createHash('sha256').update(vectors).digest('hex');
  if (actual !== vectorsDigest) {
    throw new FacadeError(
      'ARTIFACT_INVALID',
      `the vectors of "${relativePath}" hash to ${actual} while the manifest declares ${vectorsDigest}`,
    );
  }

  const expectedBytes = claim.count * claim.dimensions * 4;
  if (vectors.byteLength !== expectedBytes) {
    throw new FacadeError(
      'ARTIFACT_INVALID',
      `the vectors of "${relativePath}" carry ${vectors.byteLength} bytes while ${claim.count} vectors of ${claim.dimensions} float32 values carry ${expectedBytes}`,
    );
  }

  return {
    kind: FACADE_ARTIFACT_KIND,
    relativePath,
    sha256: declared,
    bytes: vectors.byteLength,
  };
}

/** Reads the manifest of an artifact and refuses a shape that is not a JSON object. */
async function readManifest(path: string, relativePath: string): Promise<Record<string, unknown>> {
  const raw = await readFile(path, 'utf-8').catch(() => {
    throw new FacadeError(
      'ARTIFACT_INVALID',
      `the manifest of "${relativePath}" is not on disk under the approved artifact root`,
    );
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new FacadeError(
      'ARTIFACT_INVALID',
      `the manifest of "${relativePath}" is not valid JSON`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new FacadeError(
      'ARTIFACT_INVALID',
      `the manifest of "${relativePath}" is not a JSON object`,
    );
  }
  return parsed as Record<string, unknown>;
}

/**
 * The digest of the content of a manifest.
 *
 * The content fields are the ones the Python side covers
 * (`FACADE_ARTIFACT_CONTENT_FIELDS`), and they are hashed over the canonical
 * JSON, which is the form the two languages write identically.
 */
export function digestOfContent(manifest: Record<string, unknown>): string {
  const content: Record<string, unknown> = {};
  for (const field of FACADE_ARTIFACT_CONTENT_FIELDS) {
    if (!(field in manifest)) {
      throw new FacadeError(
        'ARTIFACT_INVALID',
        `the manifest carries no ${field}, and the content of the artifact cannot be addressed without it`,
      );
    }
    content[field] = manifest[field];
  }
  return createHash('sha256').update(canonicalJson(content), 'utf8').digest('hex');
}

/** Requires that a number of the manifest is the number the run declared. */
function requireMatchingNumber(
  manifest: Record<string, unknown>,
  field: string,
  expected: number,
  relativePath: string,
): void {
  const value = manifest[field];
  if (value !== expected) {
    throw new FacadeError(
      'ARTIFACT_INVALID',
      `the artifact "${relativePath}" declares the ${field} ${String(value)} while the run declared ${expected}`,
    );
  }
}
