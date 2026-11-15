import { createHash } from 'node:crypto';
import { constants, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { CONTRACTS_VERSION, fingerprintV2 } from '@vision-lens/contracts';
import {
  EMBEDDING_CONTENT_FIELDS,
  embeddingContentDigest,
  validateEmbeddingManifest,
} from '../adapter/embedding-manifest.js';
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
 * The list is NOT a second list: it is the one the repository already ships
 * (`packages/core/src/adapter/embedding-manifest.ts:95`), which is the one
 * the Python side covers as well. A digest that covers another set of fields
 * is another address, so there is exactly one list in the repository and the
 * facade points at it.
 */
export const FACADE_ARTIFACT_CONTENT_FIELDS = EMBEDDING_CONTENT_FIELDS;

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

/**
 * The transform that produced the artifact.
 *
 * The transform is the encoder and the configuration it ran with: the model,
 * the revision and the preprocessing. The run id, the timestamp, the device
 * and the latency describe the RUN and not the transform, so they are not
 * part of it.
 */
export interface FacadeArtifactTransform {
  /** The id of the model that produced the vectors. */
  readonly modelId: string;
  /** The revision of the model. */
  readonly revision: string;
  /** The fingerprint of the preprocessing the run used. */
  readonly preprocessingFingerprint: string;
}

/** A validated artifact: the reference of it and the transform behind it. */
export interface FacadeValidatedArtifact {
  /** The reference the facade publishes. */
  readonly reference: FacadeArtifactReference;
  /** The transform that produced the artifact. */
  readonly transform: FacadeArtifactTransform;
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
  /**
   * The digests of the assets the run was supposed to embed.
   *
   * The check is OPTIONAL because the digests are the sha256 of the bytes of
   * the assets, and the facade can only compute them when it knows the root
   * the worker resolves the paths against. When the digests are known, the
   * manifest must name exactly those assets: a run that embedded other
   * images is not the run that was asked for.
   */
  readonly expectedAssetDigests?: readonly string[];
}

/**
 * The relative path of the artifact of a run.
 *
 * The run id comes from the wire, so it is NOT trusted: an id that carries a
 * separator, a parent reference, a control character or anything outside the
 * bounded alphabet is refused here, before any path is resolved. The layout
 * is the one of the store
 * (`docs/vnext/08-DOMAIN-STORE-AND-PROVENANCE.md:35`).
 */
export function artifactRelativePath(embeddingRunId: string): string {
  if (typeof embeddingRunId !== 'string' || embeddingRunId.length === 0) {
    throw new FacadeError(
      'ARTIFACT_INVALID',
      'the result of the run carries no embeddingRunId, and the artifact has no name without it',
    );
  }
  if (!FACADE_RUN_ID_PATTERN.test(embeddingRunId)) {
    throw new FacadeError(
      'ARTIFACT_INVALID',
      `the embeddingRunId "${embeddingRunId}" is not a bounded name, and a name that reaches a path or a log must carry only letters, digits, dots, dashes and underscores`,
    );
  }
  return `artifacts/${FACADE_ARTIFACT_KIND}/${embeddingRunId}`;
}

/**
 * The bounded alphabet of a run id.
 *
 * The id must START with a letter or a digit: an id that starts with a dot
 * could be `.` or `..`, and a name that names a directory must not be a
 * parent reference.
 */
const FACADE_RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The bounded alphabet of the model id and of the revision of a manifest. */
const FACADE_MODEL_FIELD_PATTERN = /^[A-Za-z0-9._:@-]{1,64}$/;

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
 *
 * The directory that comes back is the REAL one, so the files under it are
 * opened through resolved paths and not through the names the caller used.
 */
async function resolveArtifactDirectory(
  artifactRoot: string,
  relativePath: string,
): Promise<{ root: string; target: string }> {
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
  return { root: realRoot, target: realTarget };
}

/**
 * Reads one file of an artifact, refusing a file that is a link.
 *
 * The file is opened with `O_NOFOLLOW`, so a symlink placed where the file
 * is expected fails the open instead of being followed: a worker that
 * points its vectors at a file outside the approved root gets a refusal and
 * not the bytes of that file. The path handed here is the RESOLVED one, so
 * no component of it is a link either.
 */
async function readArtifactFile(path: string, what: string, relativePath: string): Promise<Buffer> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new FacadeError(
      'ARTIFACT_INVALID',
      `the ${what} of "${relativePath}" is not a regular file under the approved artifact root`,
    );
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new FacadeError(
        'ARTIFACT_INVALID',
        `the ${what} of "${relativePath}" is not a regular file under the approved artifact root`,
      );
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/**
 * Reads the manifest of an artifact and refuses a shape that is not a JSON
 * object.
 */
async function readManifest(
  path: string,
  relativePath: string,
): Promise<Record<string, unknown>> {
  const raw = (await readArtifactFile(path, 'manifest', relativePath)).toString('utf8');
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
): Promise<FacadeValidatedArtifact> {
  const relativePath = artifactRelativePath(claim.embeddingRunId);
  const { target: directory } = await resolveArtifactDirectory(claim.artifactRoot, relativePath);

  const raw = await readManifest(join(directory, FACADE_MANIFEST_FILE), relativePath);

  // The manifest is validated with the schema the repository already ships
  // (`packages/core/src/adapter/embedding-manifest.ts:150`), the same one
  // the Python side validates against: the two languages have to refuse the
  // same payloads, and a second validator in the facade would refuse a
  // different set.
  const validation = validateEmbeddingManifest(raw);
  if (!validation.ok) {
    throw new FacadeError(
      'ARTIFACT_INVALID',
      `the manifest of "${relativePath}" is not a valid manifest: ${validation.issues.join('; ')}`,
    );
  }
  const manifest = validation.manifest as unknown as Record<string, unknown>;

  // The manifest names the run it belongs to, and the name must be the one
  // the run claimed: a manifest that names another run is a manifest of
  // another artifact.
  const manifestRunId = manifest['embeddingRunId'];
  if (manifestRunId !== claim.embeddingRunId) {
    throw new FacadeError(
      'ARTIFACT_INVALID',
      `the manifest of "${relativePath}" names the run ${String(manifestRunId)} while the run claimed ${claim.embeddingRunId}`,
    );
  }

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

  if (claim.expectedAssetDigests !== undefined) {
    requireSameAssets(manifest, claim.expectedAssetDigests, relativePath);
  }

  const vectorsDigest = manifest['vectorsFileDigest'];
  if (typeof vectorsDigest !== 'string' || !/^[0-9a-f]{64}$/.test(vectorsDigest)) {
    throw new FacadeError(
      'ARTIFACT_INVALID',
      `the manifest of "${relativePath}" carries no vectorsFileDigest, and the bytes of the vectors cannot be checked without it`,
    );
  }

  const vectors = await readArtifactFile(
    join(directory, FACADE_VECTORS_FILE),
    'vectors',
    relativePath,
  );
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
    reference: {
      kind: FACADE_ARTIFACT_KIND,
      relativePath,
      sha256: declared,
      bytes: vectors.byteLength,
    },
    transform: {
      modelId: requireBoundedString(manifest, 'modelId', relativePath),
      revision: requireBoundedString(manifest, 'revision', relativePath),
      preprocessingFingerprint: requireString(
        manifest,
        'preprocessingFingerprint',
        relativePath,
      ),
    },
  };
}

/**
 * The name of the transform that produced an artifact.
 *
 * The name says which encoder ran and at which revision, and it is stable:
 * the audit walk reaches the encoder of an embedding through it.
 */
export function transformNameOf(transform: FacadeArtifactTransform): string {
  return `vision.embed/${transform.modelId}@${transform.revision}`;
}

/**
 * The fingerprint of the transform that produced an artifact.
 *
 * The fingerprint covers the encoder, the revision, the preprocessing and the
 * snapshot the run belongs to, so two runs that differ in any of them have
 * different fingerprints. The form is the one of the platform, `fp2:` and
 * sixteen hex characters (`packages/contracts/src/fingerprint.ts:51`).
 */
export function transformFingerprintOf(
  transform: FacadeArtifactTransform,
  snapshotId: string,
): string {
  return fingerprintV2({
    model: transform.modelId,
    promptTemplate: 'embedding',
    taxonomy: [],
    preprocessing: {
      revision: transform.revision,
      fingerprint: transform.preprocessingFingerprint,
    },
    dataVersion: snapshotId,
    contractsVersion: CONTRACTS_VERSION,
  });
}

/**
 * The digest of the content of a manifest.
 *
 * The computation is the shipped one
 * (`packages/core/src/adapter/embedding-manifest.ts:120`), over the canonical
 * JSON of the content fields, which is the form the two languages write
 * identically. The facade does not carry a second implementation of a
 * digest: a second implementation is a second address.
 */
export function digestOfContent(manifest: Record<string, unknown>): string {
  for (const field of FACADE_ARTIFACT_CONTENT_FIELDS) {
    if (!(field in manifest)) {
      throw new FacadeError(
        'ARTIFACT_INVALID',
        `the manifest carries no ${field}, and the content of the artifact cannot be addressed without it`,
      );
    }
  }
  return embeddingContentDigest(manifest);
}

/**
 * The digest of the bytes of one asset, as the worker computed it.
 *
 * The asset path is resolved against the approved root of the assets, with
 * the same three refusals as the artifact: a traversal, a link that leaves
 * the root and a file that is not a regular file. The digest is the sha256
 * of the bytes, which is the form the manifest carries.
 */
export async function digestOfAsset(
  assetRoot: string,
  assetPath: string,
): Promise<string> {
  if (typeof assetRoot !== 'string' || assetRoot.trim().length === 0) {
    throw new FacadeError(
      'ARTIFACT_INVALID',
      'no asset root is configured, so the assets of the run cannot be checked',
    );
  }
  const root = resolve(assetRoot);
  const target = resolve(root, assetPath);
  const fromRoot = relative(root, target);
  if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
    throw new FacadeError(
      'ARTIFACT_INVALID',
      `the asset "${assetPath}" resolves outside the approved asset root`,
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
      `the asset "${assetPath}" is not on disk under the approved asset root`,
    );
  }
  const fromRealRoot = relative(realRoot, realTarget);
  if (fromRealRoot.startsWith('..') || isAbsolute(fromRealRoot)) {
    throw new FacadeError(
      'ARTIFACT_INVALID',
      `the asset "${assetPath}" leaves the approved asset root through a link`,
    );
  }
  const bytes = await readArtifactFile(realTarget, 'asset', assetPath);
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Requires that the manifest names exactly the assets the run was asked for.
 *
 * The manifest carries the sha256 of every asset it embedded. The facade
 * computes the same digests from the bytes it asked for, and the two sets
 * must be the same: a run that embedded other images, or the same images
 * twice and others not at all, is not the run the caller asked for.
 */
function requireSameAssets(
  manifest: Record<string, unknown>,
  expected: readonly string[],
  relativePath: string,
): void {
  const declared = manifest['assetSha256'];
  if (!Array.isArray(declared) || declared.some((value) => typeof value !== 'string')) {
    throw new FacadeError(
      'ARTIFACT_INVALID',
      `the manifest of "${relativePath}" carries no list of asset digests, and the assets of the run cannot be checked without it`,
    );
  }
  const declaredSorted = [...(declared as string[])].sort();
  const expectedSorted = [...expected].sort();
  if (declaredSorted.length !== expectedSorted.length ||
    declaredSorted.some((value, index) => value !== expectedSorted[index])) {
    throw new FacadeError(
      'ARTIFACT_INVALID',
      `the artifact "${relativePath}" embedded ${declaredSorted.length} assets while the run asked for ${expectedSorted.length}, and a run that embedded other images is not the run that was asked for`,
    );
  }
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

/** Requires that a field of the manifest is a non-empty string. */
function requireString(
  manifest: Record<string, unknown>,
  field: string,
  relativePath: string,
): string {
  const value = manifest[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new FacadeError(
      'ARTIFACT_INVALID',
      `the manifest of "${relativePath}" carries no ${field}, and the transform of the run cannot be named without it`,
    );
  }
  return value;
}

/**
 * Requires that a field of the manifest is a bounded name.
 *
 * The model id and the revision of the manifest reach the transform name,
 * which is persisted in the domain and printed in the logs. A worker that
 * puts a newline or an escape sequence in them would forge a log line, so
 * the alphabet is bounded before the value is used anywhere.
 */
function requireBoundedString(
  manifest: Record<string, unknown>,
  field: string,
  relativePath: string,
): string {
  const value = requireString(manifest, field, relativePath);
  if (!FACADE_MODEL_FIELD_PATTERN.test(value)) {
    throw new FacadeError(
      'ARTIFACT_INVALID',
      `the ${field} of "${relativePath}" is not a bounded name, and a name that reaches a row or a log must carry only letters, digits, dots, dashes, colons and at signs`,
    );
  }
  return value;
}
