import { describe, expect, it } from 'vitest';
import {
  FACADE_OPERATION_CODES,
  FACADE_OPERATION_REGISTRY,
  isFacadeOperation,
  requireOperationEntry,
  VISION_EMBED_ENTRY,
} from '../../src/facade/registry.js';
import { FacadeError } from '../../src/facade/errors.js';

/**
 * The registry of the facade: every entry names the seven things a caller
 * needs before it may send the operation, and an operation the facade does
 * not know is refused instead of guessed.
 */
describe('the operation registry of the facade', () => {
  it('routes exactly one operation', () => {
    expect([...FACADE_OPERATION_REGISTRY.keys()]).toEqual(['vision.embed']);
    expect(FACADE_OPERATION_CODES).toEqual(['vision.embed']);
  });

  it('names the tier, the effects, the schema, the owner, the idempotency and the version', () => {
    expect(VISION_EMBED_ENTRY.effectTier).toBe('bounded compute');
    expect(VISION_EMBED_ENTRY.sideEffects).toBe('derived artifacts');
    expect(VISION_EMBED_ENTRY.schemaSource).toContain('@vision-lens/contracts');
    expect(VISION_EMBED_ENTRY.owner).toEqual({
      computation: 'python',
      domainWrite: 'typescript',
    });
    expect(VISION_EMBED_ENTRY.idempotency.key).toContain('idempotency key');
    expect(VISION_EMBED_ENTRY.idempotency.equality).toContain('fingerprint');
    expect(VISION_EMBED_ENTRY.version.protocolMajor).toBe(1);
    expect(VISION_EMBED_ENTRY.version.contract).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('tells a registered operation from an unknown one', () => {
    expect(isFacadeOperation('vision.embed')).toBe(true);
    expect(isFacadeOperation('vision.predict')).toBe(false);
    expect(isFacadeOperation('toString')).toBe(false);
  });

  it('refuses an operation the facade does not route', () => {
    let thrown: unknown;
    try {
      requireOperationEntry('vision.predict');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(FacadeError);
    expect((thrown as FacadeError).code).toBe('OPERATION_UNSUPPORTED');
    expect((thrown as FacadeError).retryable).toBe(false);
    expect((thrown as FacadeError).exitCode).toBe(2);
    expect((thrown as FacadeError).message).toContain('vision.predict');
  });

  it('returns the entry of a registered operation', () => {
    expect(requireOperationEntry('vision.embed')).toBe(VISION_EMBED_ENTRY);
  });
});
