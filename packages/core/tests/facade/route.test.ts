import { describe, expect, it } from 'vitest';
import { PYTHON_ROUTE_ENV, type PythonRouteConfig } from '../../src/config/index.js';
import {
  paidFallbackRefusal,
  requireFacadeRoute,
  resolveFacadeRoute,
} from '../../src/facade/route.js';
import { FacadeError } from '../../src/facade/errors.js';

/**
 * The route table of the facade: the route is an explicit opt in, the
 * refusal names the configuration key that turns it on, and the facade never
 * falls back to a paid API on its own.
 */
const ENABLED: PythonRouteConfig = {
  enabled: true,
  workspaceId: 'local',
  artifactRoot: '/srv/visionlens/artifacts',
  maxSeconds: 300,
};

describe('the route of the facade', () => {
  it('sends the operation to Python when the route is enabled', () => {
    const decision = resolveFacadeRoute('vision.embed', ENABLED);
    expect(decision.target).toBe('python');
    expect(decision.reason).toContain('vision.embed');
  });

  it('refuses the operation when no route is configured, and names the key that turns it on', () => {
    const decision = resolveFacadeRoute('vision.embed', undefined);
    expect(decision.target).toBe('disabled');
    expect(decision.reason).toContain(PYTHON_ROUTE_ENV);
  });

  it('refuses the operation when the route is off', () => {
    const decision = resolveFacadeRoute('vision.embed', { ...ENABLED, enabled: false });
    expect(decision.target).toBe('disabled');
    expect(decision.reason).toContain(PYTHON_ROUTE_ENV);
  });

  it('refuses an operation the facade does not route, and says so', () => {
    const decision = resolveFacadeRoute('vision.predict', ENABLED);
    expect(decision.target).toBe('disabled');
    expect(decision.reason).toContain('vision.predict');
    expect(decision.reason).toContain('vision.embed');
  });

  it('raises ROUTE_DISABLED when the route is refused', () => {
    let thrown: unknown;
    try {
      requireFacadeRoute('vision.embed', undefined);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(FacadeError);
    expect((thrown as FacadeError).code).toBe('ROUTE_DISABLED');
    expect((thrown as FacadeError).retryable).toBe(false);
    expect((thrown as FacadeError).exitCode).toBe(3);
    expect((thrown as FacadeError).message).toContain(PYTHON_ROUTE_ENV);
  });

  it('returns the decision when the route is enabled', () => {
    expect(requireFacadeRoute('vision.embed', ENABLED).target).toBe('python');
  });

  it('reports that no paid fallback was used', () => {
    const refusal = paidFallbackRefusal('the worker died', false);
    expect(refusal.code).toBe('NO_PAID_FALLBACK');
    expect(refusal.exitCode).toBe(4);
    expect(refusal.message).toContain('no paid fallback is enabled');
  });

  it('reports the refusal even when a fallback was enabled explicitly', () => {
    const refusal = paidFallbackRefusal('the worker died', true);
    expect(refusal.code).toBe('NO_PAID_FALLBACK');
    expect(refusal.message).toContain('was not used');
  });
});
