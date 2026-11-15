import { describe, expect, it } from 'vitest';
import { WORKER_PROTOCOL_VERSION, type WorkerHelloFrame } from '@vision-lens/contracts';
import {
  capabilitiesFromHello,
  FacadeCapabilityRegistry,
} from '../../src/facade/capabilities.js';
import { FacadeError } from '../../src/facade/errors.js';

/**
 * The capability gate of the facade: a capability exists only because a
 * hello frame was validated, and an operation the worker did not announce
 * is refused before it runs.
 */
function hello(overrides: Partial<WorkerHelloFrame> = {}): WorkerHelloFrame {
  return {
    protocol: 'visionlens.worker.v1',
    kind: 'hello',
    protocolVersion: WORKER_PROTOCOL_VERSION,
    contractVersion: '1.0.0',
    supportedOperations: ['vision.embed'],
    capabilities: { device: 'cpu', extras: ['vision'], models: ['siglip2-base'] },
    maxFrameBytes: 1_048_576,
    ...overrides,
  };
}

describe('the capability of the worker', () => {
  it('reads the capabilities out of a hello', () => {
    const capabilities = capabilitiesFromHello(hello());
    expect(capabilities.protocolMajor).toBe(1);
    expect(capabilities.device).toBe('cpu');
    expect(capabilities.extras).toEqual(['vision']);
    expect(capabilities.models).toEqual(['siglip2-base']);
    expect(capabilities.supportedOperations).toEqual(['vision.embed']);
    expect(capabilities.maxFrameBytes).toBe(1_048_576);
  });

  it('refuses a hello of another protocol major', () => {
    let thrown: unknown;
    try {
      capabilitiesFromHello(hello({ protocolVersion: '2.0.0' }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(FacadeError);
    expect((thrown as FacadeError).code).toBe('UNSUPPORTED_PROTOCOL');
  });

  it('refuses a hello of another contract major', () => {
    let thrown: unknown;
    try {
      capabilitiesFromHello(hello({ contractVersion: '2.0.0' }));
    } catch (error) {
      thrown = error;
    }
    expect((thrown as FacadeError).code).toBe('UNSUPPORTED_PROTOCOL');
    expect((thrown as FacadeError).message).toContain('contract major');
  });

  it('refuses a hello that carries an unknown field', () => {
    let thrown: unknown;
    try {
      capabilitiesFromHello({ ...hello(), surprise: true } as unknown as WorkerHelloFrame);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as FacadeError).code).toBe('MALFORMED_FRAME');
  });

  it('has no capability before a hello is registered', () => {
    const registry = new FacadeCapabilityRegistry();
    expect(registry.current()).toBeNull();
    expect(registry.supports('vision.embed')).toBe(false);
  });

  it('registers the capability from a hello', () => {
    const registry = new FacadeCapabilityRegistry();
    registry.register(hello());
    expect(registry.current()?.device).toBe('cpu');
    expect(registry.supports('vision.embed')).toBe(true);
  });

  it('refuses an operation the worker did not announce', () => {
    const registry = new FacadeCapabilityRegistry();
    registry.register(hello({ supportedOperations: ['vision.predict'] }));
    let thrown: unknown;
    try {
      registry.requireOperation('vision.embed');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(FacadeError);
    expect((thrown as FacadeError).code).toBe('OPERATION_UNSUPPORTED');
    expect((thrown as FacadeError).exitCode).toBe(2);
    expect((thrown as FacadeError).message).toContain('vision.predict');
  });

  it('refuses an operation when no worker ever answered', () => {
    const registry = new FacadeCapabilityRegistry();
    let thrown: unknown;
    try {
      registry.requireOperation('vision.embed');
    } catch (error) {
      thrown = error;
    }
    expect((thrown as FacadeError).code).toBe('OPERATION_UNSUPPORTED');
    expect((thrown as FacadeError).message).toContain('announced no operation');
  });

  it('accepts an operation the worker announced', () => {
    const registry = new FacadeCapabilityRegistry();
    registry.register(hello());
    expect(() => registry.requireOperation('vision.embed')).not.toThrow();
  });
});
