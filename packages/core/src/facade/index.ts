/**
 * The facade over the Python worker.
 *
 * The facade is an APPLICATION SERVICE: it lets the shipped Node tooling
 * reach the Python ML runtime without changing how the shipped tooling
 * behaves. The route is an explicit opt in, the capability of the worker is
 * registered only after a healthy handshake, the request is built by the
 * bridge of the operation, the artifact is validated on disk and the row is
 * committed by the TypeScript store, which stays the only writer of the
 * domain.
 *
 * The surface lives behind its own subpath (`@vision-lens/core/facade`) so
 * that the historical export lists of `@vision-lens/core` and
 * `@vision-lens/sdk` do not change: a consumer that imports the root today
 * keeps working, and the facade is opt in for the consumer as well.
 */

export {
  FACADE_ARTIFACT_CONTENT_FIELDS,
  FACADE_ARTIFACT_KIND,
  FACADE_MANIFEST_FILE,
  FACADE_VECTORS_FILE,
  artifactRelativePath,
  digestOfContent,
  transformFingerprintOf,
  transformNameOf,
  validateEmbeddingArtifact,
} from './artifacts.js';
export type {
  FacadeArtifactClaim,
  FacadeArtifactReference,
  FacadeArtifactTransform,
  FacadeValidatedArtifact,
} from './artifacts.js';

export {
  capabilitiesFromHello,
  FacadeCapabilityRegistry,
} from './capabilities.js';
export type { FacadeWorkerCapabilities } from './capabilities.js';

export {
  exitCodeOf,
  FACADE_EXIT_CODES,
  FacadeError,
  isFacadeOwnCode,
} from './errors.js';
export type { FacadeErrorCode, FacadeExitCode, FacadeOwnErrorCode } from './errors.js';

export {
  fingerprintOfRequest,
  PythonWorkerAdapter,
  WORKER_ARTIFACT_ROOT_ENV,
} from './adapter.js';
export type { PythonWorkerAdapterOptions } from './adapter.js';

export {
  paidFallbackRefusal,
  requireFacadeRoute,
  resolveFacadeRoute,
} from './route.js';
export type { FacadeRouteDecision, FacadeRouteTarget } from './route.js';

export {
  FACADE_OPERATION_CODES,
  FACADE_OPERATION_REGISTRY,
  isFacadeOperation,
  requireOperationEntry,
  VISION_EMBED_ENTRY,
} from './registry.js';
export type {
  FacadeEffectTier,
  FacadeIdempotency,
  FacadeOperationCode,
  FacadeOperationEntry,
  FacadeOperationOwner,
  FacadeOperationVersion,
  FacadeSideEffect,
} from './registry.js';

export { FacadeRun, FacadeRunLedger } from './run.js';
export type {
  FacadeRunBudget,
  FacadeRunFailure,
  FacadeRunInput,
  FacadeRunState,
  FacadeRunTransition,
} from './run.js';

export type {
  FacadeArtifactCommit,
  FacadeArtifactSink,
  FacadeEmbeddingOutcome,
  FacadeEmbeddingRequest,
  FacadeEmbeddingResult,
  VisionOperationPort,
} from './port.js';
