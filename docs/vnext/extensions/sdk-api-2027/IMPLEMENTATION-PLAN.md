# Phase III — Implementation roadmap, epics, quality gates and critical path

**Status:** prioritized engineering execution plan. It is not a report of committed code. **Prerequisite:** repository reconciliation; preserve unrelated WIP and original ADRs.

## 1. Cutline: ship vertical integration rather than three unfinished libraries

**Definition of success for first alpha:** one reproducible `vision.predict` classification CPU path shared across (a) Python local, (b) Python remote, (c) TypeScript HTTP and (d) Fastify job/worker. `POST 202`, hash-pinned asset/model, provenance, error schema, idempotency, durable status and artifact read must all work. A UI and production GPU fleet are not release blockers.

Do not attempt all eight CV labs, full multi-tenancy, realtime streaming video and ML training as prerequisites to the SDK release. 09 classification is a good first task. Lab 14 retrieval is next because both can share encoders; labs 10/15/13/12/11 follow Phase II's dependency order. Lab 16 remains research-only.

## 2. Epics, dependencies and deliverables

| Gate | Epic | Ticket slice | Objective / tangible artifact | Blocking acceptance |
|---|---|---|---|---|
| G0 | Scope + compatibility | VLSDK-001..004 | current repo inventory, ADR decisions, fixtures, compatibility map | working branch reconciled, no existing source overwritten |
| G1 | Python local API | VLSDK-005..010 | package skeleton, CPU predictor, CAS manifest, device/errors, packaging | wheel imports without Node/Torch; deterministic fixture; model pinned |
| G2 | Contract spine | VLSDK-011..015 | Zod/OpenAPI mapping, canonical job/response/errors, golden fixtures | Python + TS parse same fixtures and reject invalids |
| G3 | Backend job vertical | VLSDK-016..025 | Fastify routes, auth, assets, durable jobs, queue, JSONL worker, SSE, artifacts | idempotent 202 to terminal artifacts after controlled crash/restart |
| G4 | SDK HTTP integration | VLSDK-026..032 | Python sync/async; TS `/client`; fetch/HTTPX SSE and retry | both remote SDKs same integration suite; no regressions at npm root |
| G5 | Distribution & hardening | VLSDK-033..038 | local Node bridge, browser tests, release workflow, docs, security | clean consumer smoke; CI signed publish setup; incident drills |
| G6 | First CV expansion | VLSDK-039..040 | Phase II pack 09/14 vertical tests; scorecard | immutable dataset/model/suite parity, no unsupported scientific claims |

**Overall dependency chain:** `G0 -> contract spine (+ parallel Python CPU) -> backend durable job -> HTTP SDKs -> distribution`. Some standalone Python work can run in parallel after G0. Release engineering and security tests start as early gates, not an afterthought.

## 3. Granular backlog

The machine-readable [backlog.csv](backlog.csv) contains all 40 tickets with priority, estimates (relative complexity only), dependencies and acceptance checks. The `specs/` folder expands the first 12 stories. All estimates are **hypotheses**, not delivery commitments or time promises.

### PR sequence with isolated rollback

1. **PR-A (G0):** document current `HEAD`, package graphs, API placeholder status, worker proto, root public npm symbols; no source modification. Approve ADRs against observed implementation.
2. **PR-B (G1):** Python `visionlens` import surface + pure CPU synthetic adapter + minimal `LocalRunManifest`; no filesystem write outside user-scoped local workspace, no GPU required.
3. **PR-C (G2):** propose discriminated contract extensions in `packages/contracts`, JSON Schema generation/diff and fixture suite; readers first if migration necessary. No OpenAPI snapshot hand edits.
4. **PR-D (G3):** Fastify `buildApp` auth capability/jobs routes and job store backed by existing core. Tests with fake workers, SQLite in temp directory.
5. **PR-E (G3):** safe media ingest + CAS; worker handshake supervisor, leases, cancel/retry, transactional commits; single CPU inference integration fixture.
6. **PR-F (G3):** SSE replay, cursor retention, artifact access and consistent typed errors; integration test after simulated kill/restart.
7. **PR-G (G4):** Python remote sync/async client; no optional ML import; timeout/retry/error classification and event parser tests.
8. **PR-H (G4):** TS browser/client exports + compatibility snapshots; clean Next/browser/Node consumer builds, timeout/retry/event tests.
9. **PR-I (G5):** `@vision-lens/sdk/node` opt-in local bridge, optional and only if semantics proved by real test; no CLI regression.
10. **PR-J (G5/G6):** docs, model/dataset rights, full pack tests, release artifacts, alpha publication approval. Phase II CV expansion behind capability flags.

## 4. Definition of done by component

### Python

`pytest` fixtures + failure injection; import `visionlens` without ML extras; static typing smoke; wheel+sdist clean install; CPU tiny deterministic model; CPU→MPS fallback explicit; model hash, preprocess fingerprint and run manifest; no writes to TS SQLite; no hidden outbound network.

### TypeScript

Browser-safe HTTP subpath, abort handling and optional typed auth callback; no `node:*` in `/client` dependency graph; root API equality snapshots; `/node` explicit; TypeScript strict and declarations; parity with Python/HTTP over golden fixtures; no raw server filesystem addresses.

### Fastify backend

Scoped auth, quota/idempotency, `202` job, event log and terminal result consistency; bounded/validated upload to CAS; one TS store writer; supervising Python worker with JSONL handshake; replay SSE and cancellation; no implicit model downloads; request audit/trace correlation; chaos crash/restart test.

### Security, legal and scientific

Allowed models and rights; PHI/PII not shipped as sample data; plate/person/medical tasks gated appropriately; unknown != absent; no synthetic data presented as real; scope check before resource lookup; experiment comparisons only on comparable immutable suites; no automatic promotion by agents.

## 5. Traps and explicit alternative decisions

| Concern | Default choice | Revisit only if |
|---|---|---|
| FastAPI separate service | NO; Fastify canonical public API | new Python-only use case cannot be met through Python library + Fastify |
| Postgres/Redis/Kafka | NO in first local product | real collaborative/distributed workload and measured queue bottleneck |
| Duplicated TS CV inference | NO | isolated WASM/WebGPU inference capability merits independent engine with parity evidence |
| Automatic model checkpoint download | NO | opt-in model acquisition flow with rights/hash approvals |
| Python standalone managed sync | explicit import later | stable lineage, collision and access-control rules |
| Worker transport gRPC | NO initially; JSONL v1 existing | measured protobuf/bidirectional/high-volume demands with migration plan |
| Direct browser uploads of GB videos | deferred resumable upload path | video-specific needs and storage quota design |
| Token/cost budget = mere UI setting | NO | not revisitable: server/worker enforcement mandatory |

## 6. Evidence and migration ledger (first PR output)

Create `docs/visionlens-adoption/P3-reconciliation.md` with each row `{source path, old behavior, new requirement, KEEP|AMEND|DEFER|CONFLICT, reason, owner, test evidence, rollback}`. Especially evaluate `packages/contracts`, `@vision-lens/sdk` root exports, package graph, `apps/api`, worker JSONL, `services/vision`, `services/training`, `@vision-lens/cli` aliases. For disputed shape, record an ADR and defer change until a golden fixture exists.

## 7. Acceptance demonstration script for alpha

1. From clean Python venv import only base package; show `pip freeze` has no Torch and `visionlens` imports without Node.
2. Install CPU extra, run approved fixture classification, inspect immutable manifest with SHA-256 + model revision.
3. Launch local API authenticated on `127.0.0.1`, upload same fixture, submit job with idempotency key, replay same request and observe same job ID, change body with same key and observe `409`.
4. Restart API/worker mid job, verify eventual correct recovery or explicit failure without double result. Retrieve job via TypeScript SDK and Python remote SDK.
5. Subscribe twice to SSE with cursor, reconnect, replay exactly once at client abstraction, fetch artifact hash and verify bytes match metadata.
6. Attempt unauthorized cross-workspace asset read, out-of-policy model, huge upload, invalid job/task, expired cursor; verify typed and redacted errors.
7. Run golden parity for same model/input/revision with documented numerical tolerances. Produce evidence file with versions, hardware, counts and timings *measured in that run*.

**Release stop:** any consumer cannot install from produced artifacts, extra imports leak into browser/base Python, worker can bypass policy, idempotency duplicates paid compute, or essential provenance fields are missing.
