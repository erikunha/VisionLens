import type { WorkerBudget } from '@vision-lens/contracts';
import type { FacadeArtifactReference } from './artifacts.js';
import type { FacadeError } from './errors.js';
import type { FacadeRun } from './run.js';

/**
 * The seam of the facade.
 *
 * Every surface that wants Python ML talks to {@link VisionOperationPort}
 * and never to the worker client. The port is the reason a second
 * implementation (a remote worker, a mock, a recorder) is a new class and
 * not a new call site, and it is the reason the CLI, the API and the MCP
 * surface of a later ticket will not each grow their own way of asking for
 * an embedding.
 *
 * The port returns a TYPED OUTCOME and never throws for a refusal: a
 * caller has to look at the outcome to know whether the work happened, and
 * a facade that answers with an exception and a facade that answers with a
 * refusal are two different contracts.
 */

/** The request of an embedding run. */
export interface FacadeEmbeddingRequest {
  /** The snapshot the run belongs to. */
  readonly snapshotId: string;
  /** The assets to embed, named and located against the approved root. */
  readonly assets: readonly { readonly assetId: string; readonly path: string }[];
  /** The model to embed with. */
  readonly model: string;
  /** The workspace the request belongs to. */
  readonly workspaceId: string;
  /** The budget of the request. */
  readonly budget: WorkerBudget;
  /** The key that makes the request idempotent. */
  readonly idempotencyKey: string;
}

/** One image the run could not embed, and why. */
export interface FacadeErrorSample {
  /** The asset the sample belongs to. */
  readonly assetId: string;
  /** Why the image was refused. */
  readonly code: string;
  /** The human-readable form of the refusal. */
  readonly message: string;
}

/** The success of an embedding run. */
export interface FacadeEmbeddingResult {
  /** The operation the result is about. */
  readonly operation: 'vision.embed';
  /** The id of the run. */
  readonly embeddingRunId: string;
  /** The number of vectors. */
  readonly count: number;
  /** The dimension of the vectors. */
  readonly dimensions: number;
  /** The dtype of the vectors. */
  readonly dtype: string;
  /** The artifact, relative and content addressed. */
  readonly artifact: FacadeArtifactReference;
  /**
   * The images the run could not embed.
   *
   * A run that refused some of its images is a PARTIAL run: the artifact
   * covers the images that succeeded, and the refusals are named here so
   * that nobody reads the count of the artifact as the count of the
   * request.
   */
  readonly errorSamples: readonly FacadeErrorSample[];
  /** The fingerprint of the transform that produced the artifact. */
  readonly transformFingerprint: string;
  /** The contract version the request was built against. */
  readonly contractVersion: string;
  /** The protocol version the worker speaks. */
  readonly protocolVersion: string;
}

/** The outcome of an embedding run: a typed success or a typed failure. */
export type FacadeEmbeddingOutcome =
  | { readonly ok: true; readonly result: FacadeEmbeddingResult; readonly run: FacadeRun }
  | { readonly ok: false; readonly error: FacadeError; readonly run?: FacadeRun };

/**
 * What the facade asks the store to commit.
 *
 * The facade never writes to the database itself: it hands the record to a
 * sink, and the sink is the one that knows the store. The record carries the
 * lineage the store makes structural, because a derived artifact without
 * lineage cannot be created at all.
 */
export interface FacadeArtifactCommit {
  /** The kind of the artifact. */
  readonly kind: 'embedding';
  /** The assets the artifact was derived from. */
  readonly sourceAssetIds: readonly string[];
  /** The snapshot the assets belong to. */
  readonly sourceSnapshotId: string;
  /** The name of the transform that produced the artifact. */
  readonly transform: string;
  /** The fingerprint of that transform. */
  readonly transformFingerprint: string;
  /** The relative path of the artifact. */
  readonly relativePath: string;
  /** The digest of the content of the artifact. */
  readonly sha256: string;
  /** The number of bytes of the artifact. */
  readonly bytes: number;
}

/**
 * The sink that commits the artifact of a run.
 *
 * The sink is a port for the same reason the facade is: the domain write
 * belongs to the TypeScript store and to nothing else, and the facade
 * reaches it without importing a database handle.
 */
export interface FacadeArtifactSink {
  /** Commits one artifact. */
  commit(commit: FacadeArtifactCommit): Promise<void>;
}

/** The seam every surface talks to. */
export interface VisionOperationPort {
  /** Runs one embedding and answers a typed outcome. */
  runEmbedding(request: FacadeEmbeddingRequest): Promise<FacadeEmbeddingOutcome>;
}
