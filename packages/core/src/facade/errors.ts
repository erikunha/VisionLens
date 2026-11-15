import type { WorkerErrorCode } from '@vision-lens/contracts';

/**
 * The typed errors of the facade.
 *
 * The facade raises two families of errors and names both of them:
 *
 *  - the codes that belong to the FACADE, which are the route decision, the
 *    capability of the worker, the artifact and the store write. They are
 *    not wire codes: they never cross the JSONL channel, so they cannot
 *    borrow a name the frozen vocabulary owns;
 *  - the codes the WORKER reported, which are the frozen ones of the
 *    protocol (`WORKER_ERROR_RETRYABLE` in the contracts package) and
 *    keep their own retryable flag.
 *
 * Every error carries an EXIT CODE, because the CLI route is a process
 * boundary: 0 is a success, 2 a validation refusal, 3 an unavailable
 * dependency, 4 a policy refusal and 5 a runtime failure.
 */

/** The codes the facade itself raises. */
export type FacadeOwnErrorCode =
  | 'ROUTE_DISABLED'
  | 'OPERATION_UNSUPPORTED'
  | 'WORKER_UNAVAILABLE'
  | 'HANDSHAKE_FAILED'
  | 'ARTIFACT_INVALID'
  | 'STORE_WRITE_FAILED'
  | 'NO_PAID_FALLBACK';

/** Every code the facade can answer with. */
export type FacadeErrorCode = FacadeOwnErrorCode | WorkerErrorCode;

/** The exit code of each class of outcome. */
export const FACADE_EXIT_CODES = {
  success: 0,
  validation: 2,
  unavailable: 3,
  policy: 4,
  runtime: 5,
} as const;

/** One of the exit codes of the facade. */
export type FacadeExitCode = (typeof FACADE_EXIT_CODES)[keyof typeof FACADE_EXIT_CODES];

/** The retryable flag and the exit code of every code the facade owns. */
const OWN_CODES: Readonly<Record<FacadeOwnErrorCode, { retryable: boolean; exitCode: FacadeExitCode }>> =
  {
    ROUTE_DISABLED: { retryable: false, exitCode: FACADE_EXIT_CODES.unavailable },
    OPERATION_UNSUPPORTED: { retryable: false, exitCode: FACADE_EXIT_CODES.validation },
    WORKER_UNAVAILABLE: { retryable: true, exitCode: FACADE_EXIT_CODES.unavailable },
    HANDSHAKE_FAILED: { retryable: true, exitCode: FACADE_EXIT_CODES.unavailable },
    ARTIFACT_INVALID: { retryable: false, exitCode: FACADE_EXIT_CODES.runtime },
    STORE_WRITE_FAILED: { retryable: true, exitCode: FACADE_EXIT_CODES.runtime },
    NO_PAID_FALLBACK: { retryable: false, exitCode: FACADE_EXIT_CODES.policy },
  };

/** The exit code of every code the WORKER reported. */
const WORKER_EXIT_CODES: Readonly<Record<WorkerErrorCode, FacadeExitCode>> = {
  UNSUPPORTED_PROTOCOL: FACADE_EXIT_CODES.policy,
  MISSING_EXTRA: FACADE_EXIT_CODES.policy,
  MALFORMED_FRAME: FACADE_EXIT_CODES.runtime,
  PROTOCOL_MISMATCH: FACADE_EXIT_CODES.policy,
  UNSUPPORTED_OPERATION: FACADE_EXIT_CODES.validation,
  CANCELLED: FACADE_EXIT_CODES.runtime,
  DEADLINE_EXCEEDED: FACADE_EXIT_CODES.runtime,
  BUDGET_EXCEEDED: FACADE_EXIT_CODES.runtime,
  WORKER_CRASHED: FACADE_EXIT_CODES.runtime,
  PROVIDER_UNAVAILABLE: FACADE_EXIT_CODES.unavailable,
};

/**
 * The error of the facade: a code, a message, a retryable flag and an exit
 * code.
 *
 * The message is the DIAGNOSTIC: it names what failed and, when there is
 * one, the one action that fixes it. A refusal that cannot be acted on is
 * a refusal that wastes the reader's time.
 */
export class FacadeError extends Error {
  /** The code of the failure: one of the facade's own, or one of the wire's. */
  readonly code: FacadeErrorCode;
  /** Whether a caller may try again. */
  readonly retryable: boolean;
  /** The exit code of the process that reports the failure. */
  readonly exitCode: FacadeExitCode;

  constructor(code: FacadeErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'FacadeError';
    this.code = code;
    const own = OWN_CODES[code as FacadeOwnErrorCode];
    this.retryable = own?.retryable ?? false;
    this.exitCode = own?.exitCode ?? WORKER_EXIT_CODES[code as WorkerErrorCode] ?? FACADE_EXIT_CODES.runtime;
  }
}

/**
 * Whether a code belongs to the facade, as opposed to the wire.
 */
export function isFacadeOwnCode(code: FacadeErrorCode): code is FacadeOwnErrorCode {
  return Object.hasOwn(OWN_CODES, code);
}

/**
 * The exit code of a code, whether the facade owns it or the worker
 * reported it.
 */
export function exitCodeOf(code: FacadeErrorCode): FacadeExitCode {
  const own = OWN_CODES[code as FacadeOwnErrorCode];
  if (own !== undefined) return own.exitCode;
  return WORKER_EXIT_CODES[code as WorkerErrorCode] ?? FACADE_EXIT_CODES.runtime;
}
