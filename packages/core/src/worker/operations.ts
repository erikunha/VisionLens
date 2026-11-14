import {
  WORKER_ERROR_RETRYABLE,
  type WorkerBudget,
  type WorkerErrorCode,
  type WorkerOperation,
} from '@vision-lens/contracts';
import { WorkerDeadlineError, WorkerLaunchError, WorkerProtocolError } from './errors.js';
import type { WorkerRequestInput, WorkerRequestResult } from './client.js';

/**
 * The bridge: the operation registry of the TypeScript side of the worker.
 *
 * The wire contract freezes the FRAMES and the operation codes, and it leaves
 * the payload of a result to the operation
 * (`packages/contracts/src/worker/event.ts`: the result is free-form JSON but
 * "must be stable per operation"). This module is where that stability is
 * written down: for every operation it names the code, the params it sends,
 * the typed success it accepts and the typed error it reports.
 *
 * ## The two shapes of the result of `vision.embed`
 *
 * The repository carries two of them, and both are tracked:
 *
 * - the RECORDED shape, which is the one the adapter of this ticket produces
 *   and the one the pack's own example carries
 *   (`docs/vnext/contracts/proposed/examples/worker-result.example.json` and
 *   `packages/contracts/tests/fixtures/worker/result.golden.json`): the run
 *   id, the count, the dimension, the dtype, the digest of the artifact and
 *   the error samples. The vectors are on disk and never in the line
 *   (`docs/vnext/specs/VLN-005-python-cpu-vision-adapter.md:14`);
 * - the SIMULATED shape, which is the one the deterministic runtime of the
 *   frozen protocol answers and which the golden transcript of the Python
 *   package pins byte for byte (the transcript is named in
 *   `docs/architecture/python-owner-map.md`): the model, the dimension, the
 *   dtype, the count, the vectors, the digest, the preprocessing fingerprint
 *   and the device.
 *
 * The bridge accepts both and NAMES which one answered, so a caller can
 * never mistake a simulated vector for a recorded run. The wire is not
 * redesigned here: the frozen frames and the frozen vocabulary stay exactly
 * as they are, and this module only says what a caller may do with what
 * arrives.
 *
 * ## No dependency outside the worker
 *
 * The validators here are written by hand instead of with Zod, because the
 * owner boundary of `packages/core/src/worker/` allows the Node stdlib, the
 * contracts package, this directory and `packages/core/src/utils/`, and
 * nothing else (`docs/architecture/python-owner-map.md`). A boundary that is
 * widened for a convenience is a boundary that is not enforced.
 */

/** The frozen operation code of the embedding. */
export const VISION_EMBED_OPERATION: WorkerOperation = 'vision.embed';

/** The dtype every embed result reports. */
export const VISION_EMBED_DTYPE = 'float32';

/** A sha256 digest, in the lower case hex form the platform writes. */
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** The fingerprint form of the platform: `fp2:` and sixteen hex characters. */
const FINGERPRINT_PATTERN = /^fp2:[0-9a-f]{16}$/;

/**
 * A failure of the contract of an operation: the payload is not the shape
 * the operation promises.
 *
 * The error names the FIELD that broke the promise, because a payload that
 * does not match is a fact about a field and not about the payload.
 */
export class WorkerOperationContractError extends Error {
  /** The operation whose result broke the contract. */
  readonly operation: WorkerOperation;
  /** The field that broke it. */
  readonly field: string;

  constructor(operation: WorkerOperation, field: string, message: string) {
    super(message);
    this.name = 'WorkerOperationContractError';
    this.operation = operation;
    this.field = field;
  }
}

/** One image the run could not embed, and why. */
export interface VisionEmbedErrorSample {
  /** The asset the sample belongs to. */
  readonly assetId: string;
  /** Why the image was refused. */
  readonly code: string;
  /** The human-readable form of the refusal. */
  readonly message: string;
}

/**
 * The success of a RECORDED run: the vectors are in the artifact and the
 * line names the artifact.
 */
export interface RecordedVisionEmbedSuccess {
  readonly kind: 'recorded';
  readonly embeddingRunId: string;
  readonly count: number;
  readonly dimensions: number;
  readonly dtype: 'float32';
  readonly artifactSha256: string;
  /**
   * The images the run could not embed. A run that reports none may omit
   * the field: the pack's own example of a successful result carries
   * none, and a missing list reads as the empty one.
   */
  readonly errorSamples: readonly VisionEmbedErrorSample[];
}

/**
 * The success of a SIMULATED run: the vectors travel in the line, because
 * the deterministic runtime has no artifact to point at.
 */
export interface SimulatedVisionEmbedSuccess {
  readonly kind: 'simulated';
  readonly model: string;
  readonly dimension: number;
  readonly dtype: 'float32';
  readonly count: number;
  readonly vectors: readonly (readonly number[])[];
  readonly artifactSha256: string;
  readonly preprocessingFingerprint: string;
  readonly device: string;
  /** Present when the run fell back from the device it asked for. */
  readonly fallbackReason?: string;
}

/** The typed success of the `vision.embed` operation. */
export type VisionEmbedSuccess = RecordedVisionEmbedSuccess | SimulatedVisionEmbedSuccess;

/**
 * The typed error of an operation: the frozen code, the message and the
 * retryable flag.
 *
 * A failure the WORKER reported carries the frozen flag of its code, read
 * from the frozen table and never guessed. A failure of the CHANNEL (the
 * process did not start, the deadline elapsed) carries the flag the HOST
 * itself uses, because the host is the one that decides whether to retry.
 */
export interface WorkerOperationErrorResult {
  readonly code: WorkerErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

/** The outcome of an operation: a typed success or a typed error. */
export type WorkerOperationOutcome<T> =
  | { readonly ok: true; readonly result: T }
  | { readonly ok: false; readonly error: WorkerOperationErrorResult };

/** What an operation bridge knows: the code, the params and the result. */
export interface WorkerOperationBridge<TInput, TSuccess> {
  /** The frozen operation code. */
  readonly operation: WorkerOperation;
  /** The params of the request, built from the caller's input. */
  readonly buildParams: (input: TInput) => Record<string, unknown>;
  /** The typed success of the operation, parsed from the wire payload. */
  readonly parseSuccess: (result: unknown) => TSuccess;
}

/** The input of the `vision.embed` operation. */
export interface VisionEmbedInput {
  /** The workspace the request belongs to. */
  readonly workspaceId: string;
  /** The asset references to embed. */
  readonly images: readonly string[];
  /** The model to embed with. */
  readonly model: string;
  /** The device to ask for; the worker resolves `auto` to the CPU. */
  readonly device?: 'auto' | 'cpu';
  /** The budget of the request. */
  readonly budget: WorkerBudget;
  /** The id of the request; the client generates one when it is absent. */
  readonly requestId?: string;
}

/** The part of the worker client the bridge uses. */
export interface VisionEmbedClient {
  request(input: WorkerRequestInput): Promise<WorkerRequestResult>;
}

// ----------------------------------------------------------------------
// Field readers. Every refusal names the field that broke the contract.
// ----------------------------------------------------------------------

function asRecord(result: unknown): Record<string, unknown> {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    throw new WorkerOperationContractError(
      VISION_EMBED_OPERATION,
      'result',
      'the result of vision.embed is not a JSON object',
    );
  }
  return result as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new WorkerOperationContractError(
      VISION_EMBED_OPERATION,
      field,
      `the result of vision.embed carries no ${field}`,
    );
  }
  return value;
}

function requireInteger(
  record: Record<string, unknown>,
  field: string,
  minimum: number = 0,
): number {
  const value = record[field];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) {
    throw new WorkerOperationContractError(
      VISION_EMBED_OPERATION,
      field,
      `the result of vision.embed carries no integer ${field} of at least ${minimum}`,
    );
  }
  return value;
}

function requireDigest(record: Record<string, unknown>, field: string): string {
  const value = requireString(record, field);
  if (!SHA256_PATTERN.test(value)) {
    throw new WorkerOperationContractError(
      VISION_EMBED_OPERATION,
      field,
      `the ${field} of vision.embed is not a sha256 digest in the lower case hex form`,
    );
  }
  return value;
}

function requireFingerprint(record: Record<string, unknown>, field: string): string {
  const value = requireString(record, field);
  if (!FINGERPRINT_PATTERN.test(value)) {
    throw new WorkerOperationContractError(
      VISION_EMBED_OPERATION,
      field,
      `the ${field} of vision.embed is not a fingerprint of the fp2 form`,
    );
  }
  return value;
}

function requireDtype(record: Record<string, unknown>): 'float32' {
  const value = requireString(record, 'dtype');
  if (value !== VISION_EMBED_DTYPE) {
    throw new WorkerOperationContractError(
      VISION_EMBED_OPERATION,
      'dtype',
      `the dtype of vision.embed is "${value}" and this operation reports float32`,
    );
  }
  return 'float32';
}

function requireVectors(
  record: Record<string, unknown>,
  dimension: number,
): readonly (readonly number[])[] {
  const value = record.vectors;
  if (!Array.isArray(value)) {
    throw new WorkerOperationContractError(
      VISION_EMBED_OPERATION,
      'vectors',
      'the result of vision.embed carries no vectors array',
    );
  }
  if (value.length !== record.count) {
    throw new WorkerOperationContractError(
      VISION_EMBED_OPERATION,
      'vectors',
      `the result of vision.embed carries ${value.length} vectors and counts ${String(record.count)} images`,
    );
  }
  return value.map((vector, index) => {
    if (!Array.isArray(vector) || vector.length !== dimension) {
      throw new WorkerOperationContractError(
        VISION_EMBED_OPERATION,
        `vectors[${index}]`,
        `a vector of vision.embed does not carry the ${dimension} dimensions the result declares`,
      );
    }
    // A NaN or an infinity is a number to JavaScript and a poison to a
    // float32: it serialises as null and it breaks every comparison.
    if (vector.some((item) => typeof item !== 'number' || !Number.isFinite(item))) {
      throw new WorkerOperationContractError(
        VISION_EMBED_OPERATION,
        `vectors[${index}]`,
        'a vector of vision.embed carries a value that is not a finite number',
      );
    }
    return vector as number[];
  });
}

function requireErrorSamples(
  record: Record<string, unknown>,
): readonly VisionEmbedErrorSample[] {
  const value = record.errorSamples;
  if (value === undefined) {
    // The pack's own example of a successful result carries no error
    // sample, so the field is OPTIONAL and a run that reports none reads
    // as the empty list. A run that reports one carries it.
    return [];
  }
  if (!Array.isArray(value)) {
    throw new WorkerOperationContractError(
      VISION_EMBED_OPERATION,
      'errorSamples',
      'the errorSamples of vision.embed is not an array',
    );
  }
  return value.map((sample, index) => {
    if (typeof sample !== 'object' || sample === null || Array.isArray(sample)) {
      throw new WorkerOperationContractError(
        VISION_EMBED_OPERATION,
        `errorSamples[${index}]`,
        'an error sample of vision.embed is not an object',
      );
    }
    const entry = sample as Record<string, unknown>;
    for (const field of ['assetId', 'code', 'message'] as const) {
      if (typeof entry[field] !== 'string' || (entry[field] as string).length === 0) {
        throw new WorkerOperationContractError(
          VISION_EMBED_OPERATION,
          `errorSamples[${index}].${field}`,
          `an error sample of vision.embed carries no ${field}`,
        );
      }
    }
    return {
      assetId: entry.assetId as string,
      code: entry.code as string,
      message: entry.message as string,
    };
  });
}

// ----------------------------------------------------------------------
// The two shapes of the success
// ----------------------------------------------------------------------

/**
 * Refuses a payload that claims to be a recorded run and a simulated one at
 * the same time.
 *
 * A payload that carries BOTH markers claims two shapes at once. A worker
 * that answers with the vectors of a simulation under the name of a recorded
 * run would have its vectors dropped and the caller told to look on the
 * disk, so the payload is refused instead of believed.
 */
function refuseBothShapes(record: Record<string, unknown>): void {
  const recorded = record.embeddingRunId !== undefined;
  const simulated = record.vectors !== undefined;
  if (!recorded || !simulated) return;
  throw new WorkerOperationContractError(
    VISION_EMBED_OPERATION,
    'result',
    'the result of vision.embed carries the markers of BOTH shapes ' +
      '(embeddingRunId and vectors), and a result that claims both is refused',
  );
}

/**
 * Parses the RECORDED shape: the run id, the count, the dimension, the
 * dtype, the digest of the artifact and the error samples.
 */
export function parseRecordedVisionEmbedSuccess(result: unknown): RecordedVisionEmbedSuccess {
  const record = asRecord(result);
  refuseBothShapes(record);
  return {
    kind: 'recorded',
    embeddingRunId: requireString(record, 'embeddingRunId'),
    count: requireInteger(record, 'count', 1),
    dimensions: requireInteger(record, 'dimensions', 1),
    dtype: requireDtype(record),
    artifactSha256: requireDigest(record, 'artifactSha256'),
    errorSamples: requireErrorSamples(record),
  };
}

/**
 * Parses the SIMULATED shape: the model, the dimension, the dtype, the
 * count, the vectors, the digest, the preprocessing fingerprint and the
 * device.
 */
export function parseSimulatedVisionEmbedSuccess(result: unknown): SimulatedVisionEmbedSuccess {
  const record = asRecord(result);
  refuseBothShapes(record);
  const fallbackReason = record.fallbackReason;
  if (fallbackReason !== undefined && typeof fallbackReason !== 'string') {
    throw new WorkerOperationContractError(
      VISION_EMBED_OPERATION,
      'fallbackReason',
      'the fallbackReason of vision.embed is not a string',
    );
  }
  const parsed: SimulatedVisionEmbedSuccess = {
    kind: 'simulated',
    model: requireString(record, 'model'),
    dimension: requireInteger(record, 'dimension', 1),
    dtype: requireDtype(record),
    count: requireInteger(record, 'count', 1),
    vectors: requireVectors(record, requireInteger(record, 'dimension', 1)),
    artifactSha256: requireDigest(record, 'artifactSha256'),
    preprocessingFingerprint: requireFingerprint(record, 'preprocessingFingerprint'),
    device: requireString(record, 'device'),
    ...(fallbackReason === undefined ? {} : { fallbackReason }),
  };
  return parsed;
}

/**
 * Parses the typed success of `vision.embed`.
 *
 * The two shapes are told apart by the run id: a payload that names one is
 * a recorded run, and a payload that carries vectors is a simulated one. A
 * payload that is neither is a refusal, not a guess, and a payload that
 * claims both is a refusal too.
 */
export function parseVisionEmbedSuccess(result: unknown): VisionEmbedSuccess {
  const record = asRecord(result);
  const recorded = record.embeddingRunId !== undefined;
  const simulated = record.vectors !== undefined;
  refuseBothShapes(record);
  if (recorded) return parseRecordedVisionEmbedSuccess(record);
  if (simulated) return parseSimulatedVisionEmbedSuccess(record);
  throw new WorkerOperationContractError(
    VISION_EMBED_OPERATION,
    'result',
    'the result of vision.embed is neither a recorded run (embeddingRunId) nor a ' +
      'simulated one (vectors)',
  );
}

/**
 * The typed error of an operation.
 *
 * A failure that carries a frozen code keeps it and its frozen retryable
 * flag. A failure of the CHANNEL (the process did not start, the deadline
 * elapsed) is reported with the code that names it: `DEADLINE_EXCEEDED`
 * for the deadline, and `WORKER_CRASHED` for a worker that could not be
 * used at all, because the frozen vocabulary has no other code for it and
 * the bridge never invents one.
 */
export function workerErrorResult(failure: unknown): WorkerOperationErrorResult {
  if (failure instanceof WorkerProtocolError) {
    // The code travels on the wire, so it is checked against the frozen
    // vocabulary before it is believed: a code the platform does not
    // know has no retryable flag, and a result with no flag is not a
    // result the caller can act on. The table is checked with `hasOwn`
    // and not with a lookup, because a lookup finds the members of the
    // prototype chain too, and a code named `toString` would inherit
    // the function of the chain instead of the flag of a frozen code.
    if (!Object.hasOwn(WORKER_ERROR_RETRYABLE, failure.code)) {
      return {
        code: 'WORKER_CRASHED',
        message:
          `the worker reported the code ${failure.code}, which is not one of the frozen codes: ` +
          failure.message,
        retryable: WORKER_ERROR_RETRYABLE.WORKER_CRASHED,
      };
    }
    return {
      code: failure.code,
      message: failure.message,
      retryable: WORKER_ERROR_RETRYABLE[failure.code],
    };
  }
  if (failure instanceof WorkerDeadlineError) {
    return {
      code: 'DEADLINE_EXCEEDED',
      message: failure.message,
      retryable: WORKER_ERROR_RETRYABLE.DEADLINE_EXCEEDED,
    };
  }
  if (failure instanceof WorkerLaunchError) {
    // The channel failed, not the worker: the flag is the one the HOST
    // itself uses to decide whether a launch is worth retrying, because
    // the host is the one that decides.
    return {
      code: 'WORKER_CRASHED',
      message: failure.message,
      retryable: failure.retryable,
    };
  }
  const message = failure instanceof Error ? failure.message : String(failure);
  return {
    code: 'WORKER_CRASHED',
    message,
    retryable: WORKER_ERROR_RETRYABLE.WORKER_CRASHED,
  };
}

// ----------------------------------------------------------------------
// The registry
// ----------------------------------------------------------------------

/** The bridge of the `vision.embed` operation. */
export const VISION_EMBED_BRIDGE: WorkerOperationBridge<VisionEmbedInput, VisionEmbedSuccess> = {
  operation: VISION_EMBED_OPERATION,
  buildParams: (input: VisionEmbedInput) => {
    if (input.images.length === 0) {
      // A run with no image embedded nothing, and a run that embedded
      // nothing is not a run: the request is refused here, before the
      // worker is asked, so no empty artifact is ever produced.
      throw new WorkerOperationContractError(
        VISION_EMBED_OPERATION,
        'images',
        'the operation vision.embed needs at least one image, and the request carried none',
      );
    }
    const params: Record<string, unknown> = {
      images: [...input.images],
      model: input.model,
    };
    if (input.device !== undefined) params.device = input.device;
    return params;
  },
  parseSuccess: parseVisionEmbedSuccess,
};

/** Every operation the bridge knows, by its frozen code. */
export const WORKER_OPERATION_BRIDGES: ReadonlyMap<WorkerOperation, WorkerOperationBridge<never, unknown>> =
  new Map<WorkerOperation, WorkerOperationBridge<never, unknown>>([
    [VISION_EMBED_OPERATION, VISION_EMBED_BRIDGE as WorkerOperationBridge<never, unknown>],
  ]);

/**
 * Runs `vision.embed` and returns the typed success.
 *
 * @throws WorkerOperationContractError when the payload is not the shape
 *     the operation promises.
 */
export async function runVisionEmbed(
  client: VisionEmbedClient,
  input: VisionEmbedInput,
): Promise<VisionEmbedSuccess> {
  const outcome = await client.request({
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    operation: VISION_EMBED_BRIDGE.operation,
    workspaceId: input.workspaceId,
    params: VISION_EMBED_BRIDGE.buildParams(input),
    budget: input.budget,
  });
  return VISION_EMBED_BRIDGE.parseSuccess(outcome.result);
}

/**
 * Runs `vision.embed` and returns the typed success or the typed error, and
 * never throws for a failure the operation reported.
 */
export async function tryVisionEmbed(
  client: VisionEmbedClient,
  input: VisionEmbedInput,
): Promise<WorkerOperationOutcome<VisionEmbedSuccess>> {
  try {
    const result = await runVisionEmbed(client, input);
    return { ok: true, result };
  } catch (failure) {
    if (failure instanceof WorkerOperationContractError) throw failure;
    return { ok: false, error: workerErrorResult(failure) };
  }
}
