import { WORKER_ERROR_RETRYABLE, type WorkerErrorCode } from '@vision-lens/contracts';

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
  | 'REQUEST_INVALID'
  | 'RUN_IN_PROGRESS'
  | 'WORKER_UNAVAILABLE'
  | 'HANDSHAKE_FAILED'
  | 'ARTIFACT_INVALID'
  | 'STORE_WRITE_FAILED';

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

/**
 * The retryable flag and the exit code of every code the facade owns.
 *
 * The flag says whether a caller MAY try again, and it is never a guess:
 *
 *  - a route that is off is a configuration decision, and no retry changes
 *    it;
 *  - a worker that could not be STARTED is a missing or a broken install,
 *    and a retry of the same command fails the same way;
 *  - a worker that never answered its hello is a transient condition, and
 *    the caller may try again;
 *  - a request the facade refuses on its own terms is a deterministic
 *    invalid input, and no retry changes it.
 */
const OWN_CODES: Readonly<Record<FacadeOwnErrorCode, { retryable: boolean; exitCode: FacadeExitCode }>> =
  {
    ROUTE_DISABLED: { retryable: false, exitCode: FACADE_EXIT_CODES.unavailable },
    OPERATION_UNSUPPORTED: { retryable: false, exitCode: FACADE_EXIT_CODES.validation },
    REQUEST_INVALID: { retryable: false, exitCode: FACADE_EXIT_CODES.validation },
    RUN_IN_PROGRESS: { retryable: true, exitCode: FACADE_EXIT_CODES.runtime },
    WORKER_UNAVAILABLE: { retryable: false, exitCode: FACADE_EXIT_CODES.unavailable },
    HANDSHAKE_FAILED: { retryable: true, exitCode: FACADE_EXIT_CODES.unavailable },
    ARTIFACT_INVALID: { retryable: false, exitCode: FACADE_EXIT_CODES.runtime },
    STORE_WRITE_FAILED: { retryable: true, exitCode: FACADE_EXIT_CODES.runtime },
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
    // The flag of a code the WORKER reported is read from the frozen table
    // and never guessed: the table ships with the vocabulary so that a
    // consumer does not have to know which of the ten codes may be
    // retried. The lookup uses `hasOwn` because a lookup finds the
    // members of the prototype chain too.
    this.retryable =
      own?.retryable ??
      (Object.hasOwn(WORKER_ERROR_RETRYABLE, code)
        ? WORKER_ERROR_RETRYABLE[code as WorkerErrorCode]
        : false);
    this.exitCode = exitCodeOf(code);
  }
}

/**
 * Whether a code belongs to the facade, as opposed to the wire.
 *
 * The argument is a plain string, because a code that arrives from the wire
 * is a string and not a member of the union, and the check must be safe
 * against a name the prototype chain carries.
 */
export function isFacadeOwnCode(code: string): code is FacadeOwnErrorCode {
  return Object.hasOwn(OWN_CODES, code);
}

/**
 * The exit code of a code, whether the facade owns it or the worker
 * reported it.
 *
 * Both lookups use `hasOwn`: a plain lookup finds the members of the
 * prototype chain too, so a code named `toString` would inherit the
 * function of the chain instead of an exit code.
 */
export function exitCodeOf(code: FacadeErrorCode): FacadeExitCode {
  const own = OWN_CODES[code as FacadeOwnErrorCode];
  if (own !== undefined) return own.exitCode;
  if (Object.hasOwn(WORKER_EXIT_CODES, code)) {
    return WORKER_EXIT_CODES[code as WorkerErrorCode];
  }
  return FACADE_EXIT_CODES.runtime;
}
