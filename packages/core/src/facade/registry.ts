import {
  CONTRACTS_VERSION,
  WORKER_PROTOCOL_MAJOR,
  WORKER_PROTOCOL_VERSION,
} from '@vision-lens/contracts';
import { FacadeError } from './errors.js';

/**
 * The operation registry of the facade.
 *
 * The facade routes ONE operation to Python, and this file is where that
 * operation is written down. Every entry names the seven things a caller
 * needs before it may send the operation:
 *
 *  - the code, which is the frozen wire code;
 *  - the effect tier, which says what the operation costs;
 *  - the side effects, which say what the operation leaves behind;
 *  - the schema source, which says where the payload shape is defined;
 *  - the owner, which says who computes and who writes the domain row;
 *  - the idempotency, which says how a repeated request is recognised;
 *  - the version, which says which contract and which protocol the request
 *    was built against.
 *
 * The registry is LOCAL to the facade on purpose: the central typed registry
 * of ADR-016 does not exist yet, and a facade that pretended to be it would
 * be a second source of truth. The shape of an entry is the one the central
 * registry can absorb later without a rewrite.
 *
 * The tier vocabulary is the one the pack uses, and it is NOT the one the
 * shipped code uses: the shipped `AGENT_TOOL_TIERS` has five members and none
 * of them is `bounded compute`
 * (`packages/contracts/src/enums.ts:63`). The entry records the pack's tier
 * and the conflict, instead of silently picking one of the two.
 */

/** The operation codes the facade routes. */
export const FACADE_OPERATION_CODES = ['vision.embed'] as const;

/** One of the operation codes the facade routes. */
export type FacadeOperationCode = (typeof FACADE_OPERATION_CODES)[number];

/** The effect tier the pack gives the operation. */
export type FacadeEffectTier = 'bounded compute';

/** The side effect the pack gives the operation. */
export type FacadeSideEffect = 'derived artifacts';

/** Who computes the operation and who writes the domain row. */
export interface FacadeOperationOwner {
  /** The side that computes the result: Python, always. */
  readonly computation: 'python';
  /** The side that writes the domain metadata: TypeScript, always. */
  readonly domainWrite: 'typescript';
}

/** How a repeated request is recognised. */
export interface FacadeIdempotency {
  /** The key the caller supplies, scoped to the workspace. */
  readonly key: string;
  /** What the key is compared against to decide that two requests are the same. */
  readonly equality: string;
}

/** The contract and the protocol the request was built against. */
export interface FacadeOperationVersion {
  /** The contract semver the request carries. */
  readonly contract: string;
  /** The protocol version the host speaks. */
  readonly protocol: string;
  /** The protocol major the host speaks. */
  readonly protocolMajor: number;
}

/** One entry of the operation registry. */
export interface FacadeOperationEntry {
  /** The frozen operation code. */
  readonly code: FacadeOperationCode;
  /** What the operation costs. */
  readonly effectTier: FacadeEffectTier;
  /** What the operation leaves behind. */
  readonly sideEffects: FacadeSideEffect;
  /** Where the shape of the payload is defined. */
  readonly schemaSource: string;
  /** Who computes and who writes. */
  readonly owner: FacadeOperationOwner;
  /** How a repeated request is recognised. */
  readonly idempotency: FacadeIdempotency;
  /** The versions the request was built against. */
  readonly version: FacadeOperationVersion;
}

/**
 * The entry of `vision.embed`.
 *
 * The schema source names the ratified frames of `@vision-lens/contracts` and
 * the payload of the operation, which is the bridge of
 * `packages/core/src/worker/operations.ts`. The idempotency key is the one the
 * caller supplies, and the equality is the fingerprint of the request input,
 * so two requests with the same key and the same input are the same run and
 * two requests with the same key and a different input are a refusal.
 */
export const VISION_EMBED_ENTRY: FacadeOperationEntry = {
  code: 'vision.embed',
  effectTier: 'bounded compute',
  sideEffects: 'derived artifacts',
  schemaSource: '@vision-lens/contracts worker frames plus the vision.embed operation payload',
  owner: { computation: 'python', domainWrite: 'typescript' },
  idempotency: {
    key: 'the idempotency key the caller supplies, scoped to the workspace',
    equality: 'the fingerprint of the request input',
  },
  version: {
    contract: CONTRACTS_VERSION,
    protocol: WORKER_PROTOCOL_VERSION,
    protocolMajor: WORKER_PROTOCOL_MAJOR,
  },
};

/** Every operation the facade routes, by its frozen code. */
export const FACADE_OPERATION_REGISTRY: ReadonlyMap<FacadeOperationCode, FacadeOperationEntry> =
  new Map<FacadeOperationCode, FacadeOperationEntry>([['vision.embed', VISION_EMBED_ENTRY]]);

/**
 * Whether a code is one the facade routes.
 *
 * The check is written against the registry and not against a hardcoded
 * list, so a second operation enters the facade by being REGISTERED and not
 * by being added to two places.
 */
export function isFacadeOperation(code: string): code is FacadeOperationCode {
  return FACADE_OPERATION_REGISTRY.has(code as FacadeOperationCode);
}

/**
 * The entry of an operation the facade routes.
 *
 * @throws FacadeError with the code `OPERATION_UNSUPPORTED` when the
 *     operation is not registered. The facade never guesses the payload of
 *     an operation it does not know.
 */
export function requireOperationEntry(code: string): FacadeOperationEntry {
  const entry = FACADE_OPERATION_REGISTRY.get(code as FacadeOperationCode);
  if (!entry) {
    throw new FacadeError(
      'OPERATION_UNSUPPORTED',
      `the operation "${code}" is not in the registry of the facade, which routes only ${[
        ...FACADE_OPERATION_REGISTRY.keys(),
      ].join(', ')}`,
    );
  }
  return entry;
}
