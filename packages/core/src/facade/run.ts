import { FacadeError, type FacadeErrorCode } from './errors.js';

/**
 * The run record of the facade.
 *
 * A run has an identity, a lifecycle, a budget and a way to stop. The
 * shipped store has no jobs table and the shipped job vocabulary has six
 * states (`packages/contracts/src/enums.ts:26`), so the facade keeps its own
 * record and maps its states onto the shipped ones instead of inventing a
 * migration:
 *
 *   | the facade | the shipped state | note |
 *   |---|---|---|
 *   | `queued` | `queued` | direct |
 *   | `running` | `running` | the lease is an internal detail of this record |
 *   | `succeeded` | `succeeded` | direct |
 *   | `failed` | `failed` | a partial run is a failure with a partial report |
 *   | `cancelled` | `cancelled` | direct |
 *
 * A terminal state is IMMUTABLE: the first outcome stands. A late result of
 * a cancelled run is discarded, and a run that already failed is never
 * rewritten into a success.
 *
 * The ledger below is the idempotency mechanism: a key that was already used
 * returns the first run, and a key that was used for a DIFFERENT input is a
 * refusal, because a key that names two different requests names nothing.
 */

/** The states of a run of the facade. */
export type FacadeRunState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

/** One transition of a run. */
export interface FacadeRunTransition {
  /** The state the run was in, or null for the first transition. */
  readonly from: FacadeRunState | null;
  /** The state the run entered. */
  readonly to: FacadeRunState;
  /** Why the run entered it. */
  readonly reason?: string;
}

/** The budget of a run: the wall-clock ceiling of the operation. */
export interface FacadeRunBudget {
  /** The ceiling in seconds. */
  readonly maxSeconds: number;
}

/** How a run ended badly. */
export interface FacadeRunFailure {
  /** The code of the failure. */
  readonly code: FacadeErrorCode;
  /** The diagnostic of the failure. */
  readonly message: string;
  /** Whether a caller may try again. */
  readonly retryable: boolean;
  /** Whether the run stopped with work undone. */
  readonly partial: boolean;
}

/** What a run needs to exist. */
export interface FacadeRunInput {
  /** The id of the run. */
  readonly id: string;
  /** The operation the run performs. */
  readonly operation: string;
  /** The key that makes the run idempotent. */
  readonly idempotencyKey: string;
  /** The fingerprint of the input of the run. */
  readonly inputFingerprint: string;
  /** The budget of the run. */
  readonly budget: FacadeRunBudget;
}

/** The states a run may not leave. */
const TERMINAL_STATES: ReadonlySet<FacadeRunState> = new Set<FacadeRunState>([
  'succeeded',
  'failed',
  'cancelled',
]);

/** The transitions the lifecycle allows. */
const ALLOWED_TRANSITIONS: Readonly<Record<FacadeRunState, readonly FacadeRunState[]>> = {
  queued: ['running', 'failed', 'cancelled'],
  running: ['succeeded', 'failed', 'cancelled'],
  succeeded: [],
  failed: [],
  cancelled: [],
};

/**
 * The bounded alphabet of an idempotency key.
 *
 * The key reaches a log line and the ledger of the facade, so it is bounded
 * in length and in alphabet: a key with a newline in it would forge a log
 * line, and a key with a megabyte in it would be a megabyte in the log.
 */
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** The bounded alphabet of the id of a run. */
const RUN_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * One run of the facade.
 *
 * The record is the only thing that knows how the run ended, and it is
 * append only: every transition is kept, in order, so the run can be
 * explained after the fact.
 */
export class FacadeRun {
  readonly id: string;
  readonly operation: string;
  readonly idempotencyKey: string;
  readonly inputFingerprint: string;
  readonly budget: FacadeRunBudget;

  private currentState: FacadeRunState = 'queued';
  private readonly recorded: FacadeRunTransition[] = [];
  private currentFailure: FacadeRunFailure | null = null;
  private currentResult: unknown = null;
  private attemptCount = 0;

  constructor(input: FacadeRunInput) {
    if (typeof input.id !== 'string' || !RUN_ID_PATTERN.test(input.id)) {
      throw new FacadeError('REQUEST_INVALID', 'a run needs a bounded id');
    }
    if (
      typeof input.idempotencyKey !== 'string' ||
      !IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey)
    ) {
      throw new FacadeError(
        'REQUEST_INVALID',
        'a run needs a bounded idempotency key of letters, digits, dots, dashes, colons and underscores',
      );
    }
    if (typeof input.inputFingerprint !== 'string' || input.inputFingerprint.length === 0) {
      throw new FacadeError('REQUEST_INVALID', 'a run needs the fingerprint of its input');
    }
    if (!Number.isInteger(input.budget?.maxSeconds) || input.budget.maxSeconds < 1) {
      throw new FacadeError('REQUEST_INVALID', 'a run needs a budget of at least one second');
    }
    this.id = input.id;
    this.operation = input.operation;
    this.idempotencyKey = input.idempotencyKey;
    this.inputFingerprint = input.inputFingerprint;
    this.budget = input.budget;
    this.recorded.push({ from: null, to: 'queued', reason: 'the run was created' });
  }

  /** The state the run is in. */
  get state(): FacadeRunState {
    return this.currentState;
  }

  /** Whether the run ended, one way or another. */
  get isTerminal(): boolean {
    return TERMINAL_STATES.has(this.currentState);
  }

  /** How many times the run was attempted. */
  get attempt(): number {
    return this.attemptCount;
  }

  /**
   * Every transition of the run, in order.
   *
   * The list is a COPY: the history of a run is append only, and a caller
   * that could push onto it could forge a transition the run never made.
   */
  get transitions(): readonly FacadeRunTransition[] {
    return [...this.recorded];
  }

  /** The failure of the run, when it failed. */
  get failure(): FacadeRunFailure | null {
    return this.currentFailure;
  }

  /** The result of the run, when it succeeded. */
  get result(): unknown {
    return this.currentResult;
  }

  /**
   * Moves the run into the running state.
   *
   * A run that is retried after a transient failure enters the running state
   * again, and the attempt counter says how many times the work was tried.
   */
  start(): void {
    this.move('running', 'the run started');
    this.attemptCount += 1;
  }

  /** Ends the run with a result. */
  succeed(result: unknown): void {
    this.move('succeeded', 'the run finished');
    this.currentResult = result;
  }

  /**
   * Ends the run with a failure.
   *
   * A partial run is a failure that names what was not completed: the budget
   * ran out, or the work was cancelled halfway.
   */
  fail(code: FacadeErrorCode, message: string, options?: { partial?: boolean }): void {
    const error = new FacadeError(code, message);
    this.move('failed', message);
    this.currentFailure = {
      code,
      message,
      retryable: error.retryable,
      partial: options?.partial ?? false,
    };
  }

  /** Ends the run as cancelled. */
  cancel(reason: string): void {
    this.move('cancelled', reason);
    this.currentFailure = {
      code: 'CANCELLED',
      message: reason,
      retryable: false,
      partial: true,
    };
  }

  /**
   * Fails the run when the wall-clock ceiling passed.
   *
   * The budget fails CLOSED: the run ends, the work that was not finished is
   * named, and no result is published as a success.
   */
  failOnDeadline(nowSeconds: number): void {
    if (!this.isTerminal && nowSeconds > this.budget.maxSeconds) {
      this.fail(
        'DEADLINE_EXCEEDED',
        `the budget of ${this.budget.maxSeconds} seconds elapsed and the run was stopped`,
        { partial: true },
      );
    }
  }

  /**
   * Moves the run into a state, and refuses a move the lifecycle forbids.
   *
   * A terminal state is immutable: the first outcome stands, and a late
   * result of a run that already ended is discarded instead of rewriting the
   * history.
   */
  private move(to: FacadeRunState, reason: string): void {
    if (this.isTerminal) {
      throw new FacadeError(
        'ARTIFACT_INVALID',
        `the run ${this.id} already ended in the state ${this.currentState}, and a terminal state is immutable`,
      );
    }
    if (!ALLOWED_TRANSITIONS[this.currentState].includes(to)) {
      throw new FacadeError(
        'ARTIFACT_INVALID',
        `the run ${this.id} cannot move from ${this.currentState} to ${to}`,
      );
    }
    this.recorded.push({ from: this.currentState, to, reason });
    this.currentState = to;
  }
}

/**
 * The ledger of the runs of the facade.
 *
 * The ledger is the idempotency mechanism, and it is keyed by the key the
 * caller supplies. A key that comes back with the SAME fingerprint of the
 * input returns the first run, so the work is done once. A key that comes
 * back with a DIFFERENT fingerprint is a refusal: a key that names two
 * different requests names nothing, and answering one of them would be a
 * guess.
 */
export class FacadeRunLedger {
  private readonly runs = new Map<string, FacadeRun>();

  /**
   * Records a run under its key, in the scope it belongs to.
   *
   * The scope is the workspace: the registry names the key as scoped to the
   * workspace, and two workspaces that share a key are two different runs.
   *
   * A key that is already registered is a REFUSAL: the ledger never
   * replaces a run silently, because a replaced run is a run nobody can
   * explain afterwards.
   *
   * @throws FacadeError with the code `OPERATION_UNSUPPORTED` when the key
   *     is already used for another input.
   */
  register(scope: string, run: FacadeRun): void {
    const key = ledgerKey(scope, run.idempotencyKey);
    const existing = this.runs.get(key);
    if (existing && existing.inputFingerprint !== run.inputFingerprint) {
      throw new FacadeError(
        'OPERATION_UNSUPPORTED',
        `the idempotency key "${run.idempotencyKey}" was already used for another input, and a key that names two requests names none`,
      );
    }
    this.runs.set(key, run);
  }

  /**
   * The run a key names, when the key was used for the same input.
   *
   * @throws FacadeError with the code `OPERATION_UNSUPPORTED` when the key
   *     was used for a different input. The code is the one the registry
   *     uses for a request nobody can serve, because a key that names two
   *     requests is a request nobody can serve.
   */
  find(
    scope: string,
    idempotencyKey: string,
    inputFingerprint: string,
  ): FacadeRun | undefined {
    const run = this.runs.get(ledgerKey(scope, idempotencyKey));
    if (!run) return undefined;
    if (run.inputFingerprint !== inputFingerprint) {
      throw new FacadeError(
        'OPERATION_UNSUPPORTED',
        `the idempotency key "${idempotencyKey}" was already used for another input, and a key that names two requests names none`,
      );
    }
    return run;
  }

  /** How many runs the ledger holds. */
  get size(): number {
    return this.runs.size;
  }
}

/** The key of a run in the ledger: the scope and the key, never mixed. */
function ledgerKey(scope: string, idempotencyKey: string): string {
  return `${scope}\u0000${idempotencyKey}`;
}
