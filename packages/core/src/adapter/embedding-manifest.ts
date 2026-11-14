import { createHash } from 'node:crypto';

import { canonicalJson } from '@vision-lens/contracts';
import { z } from 'zod';

/**
 * The manifest of one embedding run: the descriptor of the artifact the
 * Python side wrote.
 *
 * The Python runtime emits the manifest and the TypeScript side
 * validates it and commits it
 * (`docs/vnext/08-DOMAIN-STORE-AND-PROVENANCE.md:46`). The schema is
 * therefore the contract between the two languages, and it is strict: a
 * manifest with a field nobody knows is a manifest nobody maintains.
 *
 * A value that does not exist is the string `unknown` and never a zero
 * (`docs/vnext/08-DOMAIN-STORE-AND-PROVENANCE.md:24`), so the schema
 * accepts the literal `unknown` wherever a measurement may be missing.
 */

/** The schema version of the manifest this package validates. */
export const EMBEDDING_MANIFEST_SCHEMA_VERSION = 1;

/** The value a measurement that does not exist carries. */
export const UNKNOWN = 'unknown';

/** A sha256 digest, in lowercase hex. */
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** The fingerprint form of the repository: `fp2:` and sixteen hex characters. */
const FINGERPRINT_PATTERN = /^fp2:[0-9a-f]{16}$/;

/** A measurement that may not exist. */
const MeasuredSchema = z.union([z.number(), z.literal(UNKNOWN)]);

/**
 * The latency block of a run: the count of the images that were
 * embedded, the percentiles per image and the total.
 *
 * The object is STRICT, like the manifest itself: a latency that carries
 * a field nobody knows is a latency the two validators would judge
 * differently, and the two languages have to refuse the same payloads.
 */
export const EmbeddingLatencySchema = z.strictObject({
  count: z.number().int().nonnegative(),
  p50Ms: MeasuredSchema,
  p95Ms: MeasuredSchema,
  totalMs: MeasuredSchema,
}).describe('The latency of a run: the percentiles per image and the total.');

/**
 * The manifest of one embedding run.
 *
 * Every field of FR-011 is here. The vectors themselves are NOT: they
 * live in a binary file beside this manifest, and the digest of that
 * file is what proves which bytes they are.
 */
export const EmbeddingRunManifestSchema = z.strictObject({
  schemaVersion: z.literal(EMBEDDING_MANIFEST_SCHEMA_VERSION),
  embeddingRunId: z.string().min(1),
  modelId: z.string().min(1),
  revision: z.string().min(1),
  sourceUri: z.string().url(),
  weightsDigest: z.string().regex(SHA256_PATTERN),
  preprocessingFingerprint: z.string().regex(FINGERPRINT_PATTERN),
  preprocessingComponents: z.record(z.string(), z.unknown()),
  snapshotId: z.string().min(1),
  assetSha256: z.array(z.string().regex(SHA256_PATTERN)),
  count: z.number().int().nonnegative(),
  dimension: z.number().int().positive(),
  dtype: z.literal('float32'),
  vectorsFileDigest: z.string().regex(SHA256_PATTERN),
  artifactDigest: z.string().regex(SHA256_PATTERN),
  device: z.string().min(1),
  runtimeVersions: z.record(z.string(), z.string()),
  createdAt: z.string().min(1),
  latency: EmbeddingLatencySchema,
  peakMemoryBytes: z.union([z.number().int().nonnegative(), z.literal(UNKNOWN)]),
  license: z.string().min(1),
  calibrationStatus: z.string().min(1),
});

export type EmbeddingRunManifest = z.infer<typeof EmbeddingRunManifestSchema>;

/**
 * The fields the artifact digest covers: the CONTENT of the artifact.
 *
 * The run id, the timestamp, the latency, the peak memory, the runtime
 * versions and the device describe the RUN and not the content, and two
 * runs of the same content share the address. The list is the one the
 * Python side uses (`python/visionlens/src/visionlens/inference/artifact.py`),
 * and the two must stay identical: a digest that covers another set of
 * fields is another address.
 */
export const EMBEDDING_CONTENT_FIELDS = [
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

/**
 * The content address of a manifest, recomputed.
 *
 * The digest the Python side wrote is recomputed here over the same
 * canonical JSON, so the two languages agree on the address of a content.
 * The pack asks that a new result artifact becomes visible only after its
 * checksum (`docs/vnext/08-DOMAIN-STORE-AND-PROVENANCE.md:26`), and a
 * manifest whose digest does not match its own content is not a checksum.
 */
export function embeddingContentDigest(manifest: Record<string, unknown>): string {
  const content: Record<string, unknown> = {};
  for (const field of EMBEDDING_CONTENT_FIELDS) {
    content[field] = manifest[field];
  }
  return createHash('sha256').update(canonicalJson(content), 'utf8').digest('hex');
}

/**
 * The JSON Schema of the manifest, generated from the schema above.
 *
 * The Python side validates the manifest against this file, and the
 * file is generated from the same Zod schema the TypeScript side
 * validates with, so the two can never drift.
 */
export function embeddingManifestJsonSchema(): unknown {
  return z.toJSONSchema(EmbeddingRunManifestSchema, { io: 'output' });
}

/** The result of validating a manifest: the manifest, or why it failed. */
export type ManifestValidation =
  | { readonly ok: true; readonly manifest: EmbeddingRunManifest }
  | { readonly ok: false; readonly issues: readonly string[] };

/**
 * Validate a manifest against the schema.
 *
 * The refusal names every field that failed, so a caller can say what
 * to fix instead of only that something is wrong.
 */
export function validateEmbeddingManifest(payload: unknown): ManifestValidation {
  const parsed = EmbeddingRunManifestSchema.safeParse(payload);
  if (parsed.success) {
    return { ok: true, manifest: parsed.data };
  }
  const issues = parsed.error.issues.map(
    (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
  );
  return { ok: false, issues };
}
