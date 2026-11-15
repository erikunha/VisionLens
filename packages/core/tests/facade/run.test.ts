import { describe, expect, it } from 'vitest';
import { FacadeRun, FacadeRunLedger, type FacadeRunTransition } from '../../src/facade/run.js';
import { FacadeError } from '../../src/facade/errors.js';

/**
 * The run record of the facade: the lifecycle is legal, a terminal state is
 * immutable, the budget fails closed, and a key that was already used
 * returns the first run.
 */
function run(overrides: Partial<ConstructorParameters<typeof FacadeRun>[0]> = {}): FacadeRun {
  return new FacadeRun({
    id: 'run-0001',
    operation: 'vision.embed',
    idempotencyKey: 'key-0001',
    inputFingerprint: 'fp2:0123456789abcdef',
    budget: { maxSeconds: 300 },
    ...overrides,
  });
}

describe('the run of the facade', () => {
  it('starts queued and records every transition', () => {
    const record = run();
    expect(record.state).toBe('queued');
    record.start();
    record.succeed({ ok: true });
    expect(record.state).toBe('succeeded');
    expect(record.transitions.map((transition) => transition.to)).toEqual([
      'queued',
      'running',
      'succeeded',
    ]);
    expect(record.transitions[1]?.from).toBe('queued');
    expect(record.attempt).toBe(1);
  });

  it('hands the history out as a copy, so a transition cannot be forged', () => {
    const record = run();
    record.start();
    const history = record.transitions as FacadeRunTransition[];
    history.push({ from: 'running', to: 'succeeded', reason: 'forged' });
    expect(record.transitions.map((transition) => transition.to)).toEqual([
      'queued',
      'running',
    ]);
  });

  it('refuses a run without an id, without a key or without a fingerprint', () => {
    expect(() => run({ id: '' })).toThrowError(FacadeError);
    expect(() => run({ idempotencyKey: '' })).toThrowError(FacadeError);
    expect(() => run({ inputFingerprint: '' })).toThrowError(FacadeError);
  });

  it('refuses a run without a budget of at least one second', () => {
    expect(() => run({ budget: { maxSeconds: 0 } })).toThrowError(FacadeError);
  });

  it('refuses an idempotency key that is not a bounded name', () => {
    expect(() => run({ idempotencyKey: 'key\nwith a newline' })).toThrowError(FacadeError);
    expect(() => run({ idempotencyKey: 'a'.repeat(129) })).toThrowError(FacadeError);
    expect(() => run({ idempotencyKey: 'key with spaces' })).toThrowError(FacadeError);
  });

  it('keeps a terminal state immutable', () => {
    const record = run();
    record.start();
    record.succeed({ ok: true });
    expect(() => record.fail('WORKER_CRASHED', 'a late failure')).toThrowError(FacadeError);
    expect(record.state).toBe('succeeded');
    expect(record.result).toEqual({ ok: true });
  });

  it('discards a late result of a cancelled run', () => {
    const record = run();
    record.start();
    record.cancel('the operator cancelled the run');
    expect(record.state).toBe('cancelled');
    expect(record.failure?.code).toBe('CANCELLED');
    expect(record.failure?.partial).toBe(true);
  });

  it('fails closed when the budget elapsed', () => {
    const record = run({ budget: { maxSeconds: 10 } });
    record.start();
    record.failOnDeadline(11);
    expect(record.state).toBe('failed');
    expect(record.failure?.code).toBe('DEADLINE_EXCEEDED');
    expect(record.failure?.partial).toBe(true);
  });

  it('does not fail a run whose budget has not elapsed', () => {
    const record = run({ budget: { maxSeconds: 10 } });
    record.start();
    record.failOnDeadline(9);
    expect(record.state).toBe('running');
  });

  it('records the failure of a run', () => {
    const record = run();
    record.start();
    record.fail('WORKER_CRASHED', 'the worker died');
    expect(record.state).toBe('failed');
    expect(record.failure?.code).toBe('WORKER_CRASHED');
    expect(record.failure?.retryable).toBe(true);
  });
});

describe('the ledger of the runs of the facade', () => {
  it('returns the first run for a key used with the same input', () => {
    const ledger = new FacadeRunLedger();
    const first = run();
    ledger.register('local', first);
    const found = ledger.find('local', 'key-0001', 'fp2:0123456789abcdef');
    expect(found).toBe(first);
    expect(ledger.size).toBe(1);
  });

  it('finds nothing for a key that was never used', () => {
    const ledger = new FacadeRunLedger();
    expect(ledger.find('local', 'key-9999', 'fp2:0123456789abcdef')).toBeUndefined();
  });

  it('refuses a key that was used for another input', () => {
    const ledger = new FacadeRunLedger();
    ledger.register('local', run());
    let thrown: unknown;
    try {
      ledger.find('local', 'key-0001', 'fp2:fedcba9876543210');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(FacadeError);
    expect((thrown as FacadeError).code).toBe('OPERATION_UNSUPPORTED');
    expect((thrown as FacadeError).message).toContain('key-0001');
  });

  it('keeps the runs of two workspaces apart', () => {
    const ledger = new FacadeRunLedger();
    ledger.register('local', run());
    expect(ledger.find('other', 'key-0001', 'fp2:0123456789abcdef')).toBeUndefined();
    expect(ledger.find('local', 'key-0001', 'fp2:0123456789abcdef')).toBeDefined();
  });
});
