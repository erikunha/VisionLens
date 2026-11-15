import {
  CONTRACTS_VERSION,
  WORKER_PROTOCOL_MAJOR,
  WorkerHelloFrameSchema,
  type WorkerHelloFrame,
} from '@vision-lens/contracts';
import { FacadeError } from './errors.js';

/**
 * The capabilities of the worker, and the gate that registers them.
 *
 * The pack's rule is that the process must not assume Python models exist
 * merely because the service imported
 * (`docs/vnext/07-CONTRACTS-PROTOCOL.md:45`). The facade turns that rule
 * into a structure: a capability exists only because a HELLO frame was
 * validated, and the only way to obtain one is {@link
 * FacadeCapabilityRegistry.register}. There is no constructor that takes a
 * capability list, so a caller cannot hand the facade a capability that no
 * worker announced.
 *
 * The handshake that produced the hello is the worker's own: the host
 * validated it when the channel opened (`packages/core/src/worker/handshake.ts`).
 * The registry validates it AGAIN, because the capability outlives the
 * handshake and a registry that keeps a value it never checked keeps a
 * promise it cannot back.
 */

/** What the worker announced about itself. */
export interface FacadeWorkerCapabilities {
  /** The protocol version the worker speaks. */
  readonly protocolVersion: string;
  /** The protocol major the worker speaks. */
  readonly protocolMajor: number;
  /** The contract version the worker speaks. */
  readonly contractVersion: string;
  /** The operations the worker implements. */
  readonly supportedOperations: readonly string[];
  /** The device the worker runs on. */
  readonly device: string;
  /** The optional extras the Python build carries. */
  readonly extras: readonly string[];
  /** The models the worker can serve. */
  readonly models: readonly string[];
  /** The maximum frame the worker accepts, in bytes. */
  readonly maxFrameBytes: number;
}

/**
 * Validates a hello frame and reads the capabilities out of it.
 *
 * The hello is parsed with the STRICT schema of the contracts package, so a
 * hello that carries an unknown field is refused, and the two majors are
 * compared with the host's, so a worker of another protocol or another
 * contract major never becomes a capability.
 */
export function capabilitiesFromHello(hello: WorkerHelloFrame): FacadeWorkerCapabilities {
  const parsed = WorkerHelloFrameSchema.safeParse(hello);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path?.join('.') ?? '(root)';
    throw new FacadeError(
      'MALFORMED_FRAME',
      `the worker hello frame is invalid at ${where}: ${issue?.message ?? 'unknown issue'}`,
    );
  }
  const frame = parsed.data;
  const protocolMajor = majorOfVersion(frame.protocolVersion);
  if (protocolMajor !== WORKER_PROTOCOL_MAJOR) {
    throw new FacadeError(
      'UNSUPPORTED_PROTOCOL',
      `the worker speaks protocol major ${protocolMajor} while the host speaks ${WORKER_PROTOCOL_MAJOR}`,
    );
  }
  const contractMajor = majorOfVersion(frame.contractVersion);
  const hostContractMajor = majorOfVersion(CONTRACTS_VERSION);
  if (contractMajor !== hostContractMajor) {
    throw new FacadeError(
      'UNSUPPORTED_PROTOCOL',
      `the worker speaks contract major ${contractMajor} while the host speaks ${hostContractMajor}`,
    );
  }
  return {
    protocolVersion: frame.protocolVersion,
    protocolMajor,
    contractVersion: frame.contractVersion,
    supportedOperations: [...frame.supportedOperations],
    device: frame.capabilities.device,
    extras: [...frame.capabilities.extras],
    models: [...frame.capabilities.models],
    maxFrameBytes: frame.maxFrameBytes,
  };
}

/** The major of a `major.minor.patch` version string. */
function majorOfVersion(version: string): number {
  const match = /^(\d+)\.\d+\.\d+$/.exec(version);
  if (!match) {
    throw new FacadeError(
      'MALFORMED_FRAME',
      `the version "${version}" is not of the form major.minor.patch`,
    );
  }
  return Number(match[1]);
}

/**
 * The registry of the capability of the worker.
 *
 * It holds AT MOST ONE capability, and it holds it only after a validated
 * hello. A registry that never registered anything has no capability, and a
 * caller that asks it for one gets the refusal instead of an assumption.
 */
export class FacadeCapabilityRegistry {
  private capabilities: FacadeWorkerCapabilities | null = null;

  /**
   * Registers the capability of the worker, from a validated hello.
   *
   * @throws FacadeError with the code `UNSUPPORTED_PROTOCOL` or
   *     `MALFORMED_FRAME` when the hello does not hold.
   */
  register(hello: WorkerHelloFrame): FacadeWorkerCapabilities {
    this.capabilities = capabilitiesFromHello(hello);
    return this.capabilities;
  }

  /** The registered capability, or null when there is none. */
  current(): FacadeWorkerCapabilities | null {
    return this.capabilities;
  }

  /**
   * Whether the worker announced an operation.
   *
   * A registry with no capability announces nothing: an operation is served
   * only when a worker said it serves it.
   */
  supports(operation: string): boolean {
    return this.capabilities?.supportedOperations.includes(operation) ?? false;
  }

  /**
   * Requires the worker to announce an operation.
   *
   * @throws FacadeError with the code `OPERATION_UNSUPPORTED` when the
   *     worker did not announce it. The refusal happens BEFORE the
   *     operation runs, so no side effect occurs.
   */
  requireOperation(operation: string): void {
    if (this.supports(operation)) return;
    const announced = this.capabilities?.supportedOperations ?? [];
    throw new FacadeError(
      'OPERATION_UNSUPPORTED',
      announced.length === 0
        ? `the worker announced no operation, and "${operation}" is not one it serves`
        : `the operation "${operation}" is not in the worker's advertised set: ${announced.join(', ')}`,
    );
  }
}
