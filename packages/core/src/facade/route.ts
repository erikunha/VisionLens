import {
  PYTHON_ROUTE_ENABLED_VALUE,
  PYTHON_ROUTE_ENV,
  type PythonRouteConfig,
} from '../config/index.js';
import { FacadeError } from './errors.js';
import { isFacadeOperation } from './registry.js';

/**
 * The route table of the facade.
 *
 * The route is a CONFIGURATION DECISION and never an inference. The facade
 * does not look at the machine to decide whether Python is installed, and it
 * does not look at the legacy provider selection either: a route that appears
 * by itself is exactly the silent provider change the ticket forbids.
 *
 * The table has two targets and no third:
 *
 *  - `python`: the operation goes to the Python worker;
 *  - `disabled`: the operation does not run, and the refusal says why.
 *
 * There is no `typescript` target. The ML calculation is not replicated in
 * TypeScript (`docs/vnext/specs/VLN-006-ts-python-facade.md:14`), so a
 * TypeScript target for `vision.embed` would be a promise the facade cannot
 * keep. The legacy classification path is not in this table at all: it has
 * its own provider routing (`packages/core/src/analyzer/client.ts:89`) and
 * nothing here re-points it.
 */

/** Where an operation goes. */
export type FacadeRouteTarget = 'python' | 'disabled';

/** The decision the route table returns. */
export interface FacadeRouteDecision {
  /** The operation the decision is about. */
  readonly operation: string;
  /** Where the operation goes. */
  readonly target: FacadeRouteTarget;
  /** Why the decision is what it is. The refusal names the fix. */
  readonly reason: string;
}

/**
 * Resolves the route of an operation.
 *
 * The order of the rules is the order of the refusals: an operation the
 * facade does not route is refused as such, and only then the route
 * configuration is read. A caller that asks for an operation nobody serves
 * gets told that, and not told to turn on a route that would not help.
 */
export function resolveFacadeRoute(
  operation: string,
  route: PythonRouteConfig | undefined,
): FacadeRouteDecision {
  if (!isFacadeOperation(operation)) {
    return {
      operation,
      target: 'disabled',
      reason: `the facade routes only vision.embed in this ticket, and "${operation}" is not one of them`,
    };
  }
  if (!route || !route.enabled) {
    return {
      operation,
      target: 'disabled',
      reason:
        `the python route is not enabled; set ${PYTHON_ROUTE_ENV}=${PYTHON_ROUTE_ENABLED_VALUE} ` +
        'to send this operation to the Python worker',
    };
  }
  return {
    operation,
    target: 'python',
    reason: `the python route is enabled for "${operation}"`,
  };
}

/**
 * The route of an operation, or a refusal.
 *
 * @throws FacadeError with the code `ROUTE_DISABLED` when the route is
 *     disabled. The message names the configuration key that turns it on,
 *     because a refusal that cannot be acted on wastes the reader's time.
 */
export function requireFacadeRoute(
  operation: string,
  route: PythonRouteConfig | undefined,
): FacadeRouteDecision {
  const decision = resolveFacadeRoute(operation, route);
  if (decision.target === 'disabled') {
    throw new FacadeError('ROUTE_DISABLED', decision.reason);
  }
  return decision;
}

/**
 * The refusal of a failed route when no paid fallback was enabled.
 *
 * The facade never falls back to a cloud provider on its own: a fallback
 * that nobody asked for is a bill nobody agreed to. The refusal is REPORTED
 * even when a fallback is enabled, because the fallback is a fact the
 * operator has to see.
 */
export function paidFallbackRefusal(reason: string, fallbackEnabled: boolean): FacadeError {
  if (fallbackEnabled) {
    return new FacadeError(
      'NO_PAID_FALLBACK',
      `${reason}; a paid fallback was enabled explicitly and was not used by the facade`,
    );
  }
  return new FacadeError(
    'NO_PAID_FALLBACK',
    `${reason}; no paid fallback is enabled, so the run stopped here`,
  );
}
