# ADR 021 - The TypeScript facade over the Python worker

| Field    | Value      |
| -------- | ---------- |
| Status   | Accepted   |
| Date     | 2026-11-15 |
| Deciders | @erikunha  |

## Context

VLN-006 asks for an application service that lets the shipped Node tooling reach the Python ML
runtime "as a new option without altering the old `vision-lens` behaviour"
(`docs/vnext/specs/VLN-006-ts-python-facade.md:6`). The local spec of the ticket, which lives
outside the tracked tree under `specs/020-ts-python-facade/`, was written against a tree where
the facade did not exist, and it records its own divergence: the `packages/core/src/worker/`
module it designed landed as-built with a different shape, and the facade module it named
(`packages/core/src/facade/`) never existed.

Three facts decide the shape of the implementation:

- The worker host client already landed and it is the only thing that knows how to speak the
  frozen `visionlens.worker.v1` channel (`packages/core/src/worker/client.ts`). A facade that
  spoke the channel on its own would be a second implementation of a frozen protocol.
- The TypeScript store is the single writer of the domain (ADR-014), and Python writes
  content-addressed artifacts and returns manifests. The facade therefore has to validate a
  manifest and commit one row, and it has to do it through the repository, never through a
  database handle.
- The legacy surface is frozen: the provider vocabulary, the export lists of `@vision-lens/core`
  and `@vision-lens/sdk`, the two bins and every flag of the root command.

The route is the sharp edge of the ticket. A facade that decides on its own whether Python is
installed is a silent provider change, which is exactly what the ticket forbids. A facade that
falls back to a cloud provider when the worker is down turns a local failure into a bill.

## Decision

**The facade is a port with one adapter, the route is an explicit opt in, and nothing about the
legacy surface changes.** This implements VLN-006 as-built, over the worker client that landed.

1. The seam is `VisionOperationPort` (`packages/core/src/facade/port.ts`), with one method,
   `runEmbedding`, and one implementation, `PythonWorkerAdapter`. Every surface talks to the
   port and never to the worker client, so a second implementation is a new class and not a new
   call site. The port answers a typed outcome and never throws: a caller that trusts the
   contract must not receive an exception where a refusal belongs.
2. The route is a configuration decision and never an inference. The targets are `python` and
   `disabled`; there is no `typescript` target, because the ML calculation is not replicated in
   TypeScript. A route that is off refuses with `ROUTE_DISABLED` and names the environment
   variable that turns it on, and it starts no process. An operation the facade does not route
   is a DIFFERENT fact and carries `OPERATION_UNSUPPORTED`, because no configuration turns it on.
3. The configuration of the route is checked BEFORE the worker is launched. A route without an
   artifact root cannot validate the artifact it produced, and a run that ends in a refusal after
   the work was done cost the operator the whole run.
4. The capability of the worker is registered only after a handshake that validates the protocol
   major, the contract major and the shape of the hello. An operation the worker did not
   announce is refused before it runs.
5. The registry of the facade names, for the one operation it routes, the code, the effect tier,
   the side effects, the schema source, the owner, the idempotency and the version. It is local
   to the facade because the central registry of ADR-016 does not exist yet.
6. The artifact is validated with the contract the repository already ships
   (`packages/core/src/adapter/embedding-manifest.ts`): the same schema and the same content
   digest the Python side covers, so the two languages refuse the same payloads and there is
   exactly one address in the repository. The facade reaches that contract and NOTHING else of
   the adapter: the commit of the artifact and the parity gate are the work of the adapter, not
   of the application service over the worker, and the rule of the boundary proves it by
   enumerating the modules of the adapter and refusing every one of them but the contract.
   The files are read through the resolved path and
   opened with `O_NOFOLLOW`, so a worker that points its vectors at a file outside the approved
   root gets a refusal and not the bytes of that file. The reference the facade publishes is
   relative to the approved root and content addressed, the run id and the names of the manifest
   are bounded before they reach a row or a log, the manifest must name the run that claimed it,
   and the assets it names must be the assets the run was asked for.
7. TypeScript stays the only writer of the domain. The facade asks a sink to commit the row, and
   the surface that owns the store supplies the sink. The facade itself never imports the store.
8. There is no paid fallback. The route table has no third target, and a failed route stops.
9. The worker process inherits an ALLOWLIST of the environment and not the environment of the
   host, which may carry the keys of a paid provider. The configuration of the worker travels by
   name. The default launch is `python3 -m visionlens.worker`: the interpreter comes from the
   fixed allowlist and the module travels as argv, never through a shell.
10. The surface is additive: a new subpath `@vision-lens/core/facade`, a new CLI group
    (`vision-lens python embed`), and no change to the root export lists, to the provider
    vocabulary or to any existing flag. The facade is behind its own subpath, so a consumer that
    imports the root today keeps importing the same names.
11. The facade is inside the enforced module boundary: the boundary table gains a facade row, the
    eslint zone gains the rule, and the boundary gate plants a violating facade fixture and
    proves the rule fires.

## Consequences

**Positive:**

- The Python runtime is reachable from the shipped tooling without a second implementation of
  the frozen protocol and without touching the legacy path.
- Every refusal of the facade carries a code, a retryable flag and an exit code, so the CLI route
  is a process boundary with a documented map: 0 success, 2 validation, 3 unavailable, 4 policy,
  5 runtime. The flag is never a guess: the kind of a failure decides it, and the codes the
  worker reported keep the flags of the frozen table.
- The artifact of a run is attributable: the digest the worker declared is checked against the
  bytes on disk before a row is committed, and the row carries the lineage the store makes
  structural.
- The divergence between the local spec and the tree is closed in the direction of the tree: the
  spec named a shape that never landed, and the implementation is written over the module that
  did.

**Negative:**

- The facade routes one operation. `vision.predict` and the other codes of the wire stay
  unreachable from TypeScript until a ticket routes them.
- The durable job queue is not here. The run record lives in the facade, the shipped job
  vocabulary has seven states and the shipped store has no jobs table, so the widening of the
  vocabulary and the migration are a separate ticket with a numbered migration and a rollback.
- The idempotency ledger is IN MEMORY: the key makes the work happen once WITHIN one process,
  and two invocations of the CLI are two runs. A durable key is a store table, which is the same
  migration the job queue needs.
- The domain row does not carry the content address. The entity `DerivedArtifact` is frozen and
  has no field for a digest or a path, and adding one is a breaking change of the contract
  surface. The address therefore lives in the result envelope, in the run record and in the
  output of the command, and the row that the store will accept carries the lineage.
- No run wrote a row into a REAL store yet. The sink of the facade is exercised with a fake, and
  the command that supplies the real one was never driven against a migrated database: the store
  wants the lineage of the row to exist first, and a run that names assets and a snapshot that
  the store does not know is refused with `REQUEST_INVALID`.
- The effect tier of the registry entry is the one the pack uses and not the one the shipped
  code uses. The entry records the pack tier and the conflict instead of silently picking one.

## Reversibility

The rollback is a configuration change: turn the route off, or remove the entry of the operation
from the registry. The legacy path keeps working either way, because it never touched the facade.
Removing the module and the subpath is a revert, and the SDK root export list and the CLI
surface return to the state they had before it.
