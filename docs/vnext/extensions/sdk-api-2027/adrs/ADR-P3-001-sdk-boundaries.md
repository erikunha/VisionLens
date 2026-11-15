# ADR-P3-001 — Python standalone, TS managed workspace and two public SDKs

**Status:** Proposed, requires repository reconciliation. **Date:** 2026-11-15. **Relates to:** canonical ADR-011, ADR-012, ADR-014.

## Context

Users want a Python library capable of in-process PyTorch/NumPy workflows, a browser/Node TypeScript SDK and a backend reachable by arbitrary clients. The canonical design already owns ML in Python and domain state in TS. Direct Python writes to the TS SQLite schema would introduce two writers and operational drift.

## Decision proposed

1. `visionlens` Python is a standalone in-process ML API and remote sync/async HTTP SDK. In-process mode emits a local run manifest+content hashes; it never writes TS-managed SQLite directly.
2. `@vision-lens/sdk/client` is a lightweight HTTP client; `/node` may spawn a managed Python worker on the same host with canonical TS domain owner. Legacy exports remain until migration.
3. `apps/api` Fastify is the only public HTTP authority for managed workspaces: authentication, policy, idempotency, job state and audit.
4. Public operation semantics derive from accepted TS Zod schemas and immutable model/task metadata. Python internal tensors are not HTTP/JSONL contracts.
5. Explicit import/sync of standalone Python run manifests into managed workspaces is future work with content hash, identity, conflict and lineage checks.

## Consequences

Pros: portable Python, JS DX, one store writer, parity; cons: two persistence contexts (local manifest vs managed workspace), extra HTTP hop for remote, worker orchestration. No transparent two-way sync; users must opt into importing local results.

## Alternatives rejected

A. Port all CV to TS: duplicates numerical stack and evaluators. B. Make FastAPI + Fastify competing public servers: duplicate auth/policy and codegen. C. Force Python local to launch Node: breaks expected Python library ergonomics. D. Let Python write managed SQLite: violates single-writer invariant.

## Acceptance / reconsideration

A plain Python import works without Node and Torch; local run has SHA/provenance; Python remote and TS HTTP pass identical wire golden fixtures; TS store write tests verify no Python direct connection. Reopen only if actual evaluated user workflow cannot meet this separation.
