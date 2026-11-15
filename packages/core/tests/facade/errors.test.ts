import { describe, expect, it } from 'vitest';
import {
  exitCodeOf,
  FACADE_EXIT_CODES,
  FacadeError,
  isFacadeOwnCode,
} from '../../src/facade/errors.js';

/**
 * The typed errors of the facade: the codes the facade owns carry their own
 * flag, and the codes the worker reported keep the flag of the frozen
 * table, because a consumer must not have to know which of the ten codes
 * may be retried.
 */
describe('the errors of the facade', () => {
  it('carries the retryable flag of the frozen table for a worker code', () => {
    expect(new FacadeError('WORKER_CRASHED', 'the worker died').retryable).toBe(true);
    expect(new FacadeError('PROVIDER_UNAVAILABLE', 'the provider is down').retryable).toBe(true);
    expect(new FacadeError('MALFORMED_FRAME', 'the frame is invalid').retryable).toBe(false);
    expect(new FacadeError('UNSUPPORTED_PROTOCOL', 'another protocol').retryable).toBe(false);
  });

  it('carries the flag the facade decided for its own codes', () => {
    expect(new FacadeError('ROUTE_DISABLED', 'the route is off').retryable).toBe(false);
    expect(new FacadeError('WORKER_UNAVAILABLE', 'no worker').retryable).toBe(true);
    expect(new FacadeError('ARTIFACT_INVALID', 'bad artifact').retryable).toBe(false);
    expect(new FacadeError('STORE_WRITE_FAILED', 'the store refused').retryable).toBe(true);
  });

  it('maps every code to an exit code', () => {
    expect(exitCodeOf('ROUTE_DISABLED')).toBe(FACADE_EXIT_CODES.unavailable);
    expect(exitCodeOf('OPERATION_UNSUPPORTED')).toBe(FACADE_EXIT_CODES.validation);
    expect(exitCodeOf('UNSUPPORTED_PROTOCOL')).toBe(FACADE_EXIT_CODES.policy);
    expect(exitCodeOf('NO_PAID_FALLBACK')).toBe(FACADE_EXIT_CODES.policy);
    expect(exitCodeOf('WORKER_CRASHED')).toBe(FACADE_EXIT_CODES.runtime);
    expect(exitCodeOf('PROVIDER_UNAVAILABLE')).toBe(FACADE_EXIT_CODES.unavailable);
  });

  it('tells a facade code from a worker code', () => {
    expect(isFacadeOwnCode('ROUTE_DISABLED')).toBe(true);
    expect(isFacadeOwnCode('WORKER_CRASHED')).toBe(false);
    expect(isFacadeOwnCode('toString')).toBe(false);
  });

  it('keeps the cause of a failure', () => {
    const cause = new Error('the disk is full');
    const error = new FacadeError('STORE_WRITE_FAILED', 'the row was not written', { cause });
    expect(error.cause).toBe(cause);
  });
});
