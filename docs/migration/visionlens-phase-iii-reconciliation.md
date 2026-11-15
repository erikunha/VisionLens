# VisionLens Phase III: the dual SDKs and the backend API, reconciled

**Date:** 2026-11-15. **Subject:** the extension `docs/vnext/extensions/sdk-api-2027/`, delivered
on 2026-11-15 with the upstream ZIP. **Tree reconciled:** `main` at `b77cef3`.

This is the third report of the series. It EXTENDS the canonical reconciliation
(`docs/migration/vision-lens-vnext-reconciliation.md`) and the reconciliation of the Phase II
extension (`docs/migration/visionlens-phase-ii-reconciliation.md`); it replaces neither. The
extension asks for its ledger at `docs/visionlens-adoption/P3-reconciliation.md`. The house home
of a reconciliation is `docs/migration/`, so the ledger is here and the path of the pack is named
as a divergence.

## 1. What arrived

One delivery of 2026-11-15, with 58 tracked files under
`docs/vnext/extensions/sdk-api-2027/`:

- 16 documents of the specification (`MASTER-SPEC.md`, `PYTHON-SDK.md`, `TYPESCRIPT-SDK.md`,
  `BACKEND-API.md`, `CONTRACTS-AND-CONFORMANCE.md`, `DISTRIBUTION-AND-DX.md`,
  `IMPLEMENTATION-PLAN.md`, `SECURITY-THREAT-MODEL.md`, `SOURCES.md`, `AGENT-HANDOFF.md`,
  `README.md` and `VISIONLENS_PHASE_III_FULL.md`),
- 5 proposed ADRs (`adrs/ADR-P3-001` to `ADR-P3-005`),
- 12 ticket specs (`specs/VLSDK-001.md` to `specs/VLSDK-012.md`),
- a backlog of 40 tickets (`backlog.csv`) in 8 epics, from G0 Reconciliation to G6 CV packs,
- 7 candidate schemas and 9 candidate fixtures under `contracts-proposed/` and `examples/`,
- the validator of the pack (`validation/validate_phase3.py`) and the manifest
  (`MANIFEST-PHASE-III.sha256`).

The manifest covers 57 of the 58 files, and the validator of the pack reports zero errors over
the 40 tickets, the 7 schemas and the 9 fixtures:

```
$ (cd docs/vnext/extensions/sdk-api-2027 && shasum -c MANIFEST-PHASE-III.sha256 | grep -c ": OK")
57
$ python3 docs/vnext/extensions/sdk-api-2027/validation/validate_phase3.py
Phase III candidate: files=64 schemas=7 fixtures=9 tickets=40 errors=0
```

The canonical manifest does not move. The extension carries its own manifest, and the pack covers
its own files. The files were copied verbatim from the ZIP, and the only edit this repository
made to the delivered content is the one this report and the roadmap carry: the roadmap names the
gates, the epics, the tickets and the prohibitions in the words of the repository.

## 2. The method

The method is the one of the canonical reconciliation and of the reconciliation of the Phase II
extension: the live tree is read before the proposal is judged, the verdict vocabulary is the one
the repository already uses (KEEP, AMEND, DEFER, CONFLICT), and every verdict names the path of
the evidence. The reading was orchestrated on the AgentHub board, session `20261115-130523`,
with four lenses: the digest of the master spec and of the backend, the reconciliation of the
tickets of G0 to G3 and of G4 to G6, and the check of the claims of the contracts, of the
security and of the release.

`KEEP` means the shipped tree is the answer and the proposal agrees. `AMEND` means the proposal
is right in substance and needs a named change. `DEFER` means the proposal is correct and is not
the next thing to build. `CONFLICT` means the proposal contradicts a decision the repository
already took.

## 3. The state of the tree the tickets meet

The extension declares three products and six execution paths. What the tree holds today:

| Concern of the extension | What exists in the tree today |
|---|---|
| the Python package, importable without Node and without Torch | `python/visionlens/`, base install with `pillow` and `pydantic` only, `py.typed` present, documented in `docs/adr/011-python-first-ml-runtime.md` |
| the local facade of the Python package | `python/visionlens/src/visionlens/api.py`, with `VisionLens.local()` at `:47` |
| the model registry and the device planner | `python/visionlens/src/visionlens/registry/loader.py` and `python/visionlens/src/visionlens/runtime/device.py`, with `DevicePlanner.plan` at `:142` |
| the immutable artifact and the manifest | `python/visionlens/src/visionlens/inference/artifact.py` |
| the typed errors and the missing extra | `python/visionlens/src/visionlens/errors.py`, with `MissingExtraError` at `:191` |
| the contracts, the Zod source and the OpenAPI | `packages/contracts/src/`, the generator `packages/contracts/scripts/generate-openapi.ts`, the committed snapshot and the worker schemas |
| the worker channel and the handshake | `packages/core/src/worker/`, with the major comparison in `packages/core/src/worker/handshake.ts:81` |
| the facade over the worker | `packages/core/src/facade/`, decided by `docs/adr/021-python-worker-facade.md` |
| the durable store, the cancel and the migrations | `packages/core/src/store/`, with `0003_job_cancel_requested.sql` |
| the npm client | `packages/sdk/`, with the root export and `./cli` in `packages/sdk/package.json:7-10` and the frozen export snapshot in `packages/sdk/tests/exports.test.ts` |
| the API | `apps/api/src/index.ts:2`, a PLACEHOLDER for the spec 009, and nothing else |
| the Studio | `apps/studio/src/index.ts`, a placeholder |
| the retrieval index | `packages/core/src/search/index.ts`, over the embeddings of the providers, with the model and the dimension in the file to detect a switch (`packages/core/src/analyzer/embeddings.ts:80-81`) |

What does NOT exist: a job entity in `packages/contracts/src/entities/`, a `taskKind` in the
implemented contracts, a `/client` or a `/node` subpath in the npm package, an SSE parser, a
Python HTTP client, a `tasks/` package in Python, an observability substrate, and any published
package: the npm names and the PyPI name of the extension return nothing on the registry.

## 4. Classification per ticket

| Ticket | Verdict | Evidence in the live tree | Note |
|---|---|---|---|
| VLSDK-001 | AMEND | `docs/migration/visionlens-phase-ii-reconciliation.md` | the target `docs/visionlens-adoption/` does not exist in the tracked tree; the ledger is this report, under the house path |
| VLSDK-002 | DEFER | `packages/sdk/tests/exports.test.ts` | the root exports, the export map and the single bin are already baselined; only the bin map is missing |
| VLSDK-003 | DEFER | `packages/contracts/src/openapi.ts:19` | the Zod source, the generated OpenAPI, the committed snapshot and the worker schemas exist; the baseline is recorded |
| VLSDK-004 | AMEND | `AGENTS.md:6` | the tracked ADR home is `docs/adr/`, and the five proposals are numbered `ADR-P3-001` to `ADR-P3-005`; they must not land next to ADR-011 to ADR-018 as if they were accepted |
| VLSDK-005 | DEFER | `python/visionlens/pyproject.toml:10` | the isolated package ships, with the base import free of Torch and of Node |
| VLSDK-006 | DEFER | `python/visionlens/src/visionlens/api.py:38` | the local facade exists; only the name `vision.predict` has to be reconciled with the shipped surface |
| VLSDK-007 | AMEND | `python/visionlens/src/visionlens/runtime/device.py:120` | the registry is at `registry/`, not at `runtime/`; the ticket has to be split and repointed |
| VLSDK-008 | AMEND | `python/visionlens/src/visionlens/inference/artifact.py` | the immutable sink with the digest exists; `io/` holds the decode and the preprocess, not the store |
| VLSDK-009 | AMEND | `python/visionlens/src/visionlens/errors.py:191` | the missing extra and the unsupported device exist; a blocked licence does not, and it has to be added |
| VLSDK-010 | DEFER | `python/visionlens/tests/test_wheel_contents.py` | the wheel and the sdist are built and gated; the clean consumer smoke of 3.12 is the part that is open |
| VLSDK-011 | KEEP | `packages/contracts/src/entities/` | no job shape exists, so the ticket is additive to the single owner of the public entities, and it lands as Zod there |
| VLSDK-012 | AMEND | `packages/contracts/src/worker/protocol.ts:97` | the repository already has ONE frozen error vocabulary, with the code and the retryable flag of every code; a second taxonomy is not shipped beside it |
| VLSDK-013 | AMEND | `packages/contracts/scripts/generate-openapi.ts:24` | the generator is schema-only because the API is a placeholder; the route wiring comes with the backend, and the snapshot is never hand-edited |
| VLSDK-014 | AMEND | `packages/contracts/tests/worker/golden-fixtures.test.ts` | the goldens exist in the contracts and in Python; the target `contracts/golden/` is not discovered by `vitest.config.ts:7` |
| VLSDK-015 | AMEND | `packages/core/src/worker/handshake.ts:81` | both majors are validated and the guard exists; the target `tests/contracts/` is not discovered by `vitest.config.ts:7`, so the gate lands inside a package that is |
| VLSDK-016 | AMEND | `apps/api/package.json:2` | the package is a placeholder with a no-op build; it becomes the Fastify app with the factory that the tests inject |
| VLSDK-017 | KEEP | `packages/contracts/src/entities/model-version.ts:1` | the model domain and its store repository exist, and the distinction between installed, runnable and allowed contradicts no tracked decision |
| VLSDK-018 | KEEP | `docs/adr/007-local-first-infra.md` | the content addressed ingest matches the tracked local rule |
| VLSDK-019 | KEEP | `packages/core/src/store/` | no HTTP idempotency exists, and the 202 with the location after the commit fits the single writer rule |
| VLSDK-020 | AMEND | `packages/core/src/store/` | the queue is the SQLite lease and the polling of the tracked tree; the Redis queue that the pack mentions is not the tree, and the ticket has to say which one it means |
| VLSDK-021 | AMEND | `docs/adr/021-python-worker-facade.md:23` | the JSONL wire is frozen and the host implements it; the supervisor REUSES that host and never re-implements the protocol |
| VLSDK-022 | KEEP | `packages/core/src/store/` | no SSE and no `Last-Event-ID` exist, and the cursor contradicts no tracked decision |
| VLSDK-023 | KEEP | `packages/core/src/store/migrations/0003_job_cancel_requested.sql:1` | the cancel request and its rollback exist, and the abort that cancels only the wait is the rule |
| VLSDK-024 | AMEND | `packages/core/src/store/migrations/0001_init.sql:1` | the artifacts exist but the store has no workspace column; the ticket has to name the isolation model or to scope itself to the single user local case |
| VLSDK-025 | KEEP | `apps/api/src/index.ts:2` | the vertical is new and it is the right first vertical; the target `tests/integration/` is not discovered by `vitest.config.ts:7`, so it lands under `apps/api/tests/` |
| VLSDK-026 | AMEND | `python/visionlens/src/visionlens/__init__.py` | the client does not exist; the home is `client/`, not `remote/`, and the base install stays free of an HTTP dependency or it is behind a new extra |
| VLSDK-027 | AMEND | `python/visionlens/src/visionlens/__init__.py` | the async client and the SSE parser have no home; they land in the same package, and a cancelled coroutine never cancels the job of the server |
| VLSDK-028 | AMEND | `AGENTS.md:104` | `packages/sdk/src/` holds re-exports only; the fetch client is implemented in the core and re-exported as `./client` |
| VLSDK-029 | AMEND | `AGENTS.md:104` | the retry, the token and the abort rules are acceptable, and the module moves with the client into the core |
| VLSDK-030 | AMEND | `packages/contracts/src/worker/event.ts` | no SSE parser exists; the file belongs to the core, and the event of the worker is the JSONL event, not a stream to reuse |
| VLSDK-031 | AMEND | `packages/contracts/tests/cross-parse.test.ts` | the parity lands in the contracts, reusing the existing fixtures and the golden session of Python; the tree has no top level `tests/` |
| VLSDK-032 | AMEND | `packages/sdk/package.json:7-10` | the root and `./cli` exist and are preserved; the amendment is to add `./client` and to keep it out of the stable root barrel |
| VLSDK-033 | CONFLICT | `docs/adr/021-python-worker-facade.md:21-24` | a bridge in `packages/sdk/src/node/` would be a second implementation of the frozen `visionlens.worker.v1` channel, and it would place implementation logic where `AGENTS.md:104` forbids it; it lives in `packages/core/src/facade/` behind the existing port and route |
| VLSDK-034 | AMEND | `packages/sdk/tests/exports.test.ts` | the directory of the tests is `tests/`, not `test/`; the cross runtime smoke lands at `packages/sdk/tests/browser/` |
| VLSDK-035 | AMEND | `.github/workflows/release.yml:64-76` | the npm publish is deliberately disabled behind the decision of the publishing identity, and the Python workflow never publishes; the ticket is a dry run and it waits for that decision |
| VLSDK-036 | DEFER | `apps/api/src/index.ts:2` | two of the four guides cannot be written against an alpha that does not exist; only the guide of the local Python can move |
| VLSDK-037 | DEFER | `apps/api/tests/api.test.ts` | the auth, the IDOR, the upload bomb, the CSRF and the quota criteria all need the real service; the suite waits for the backend and lands in the layout of the packages |
| VLSDK-038 | DEFER | `docker/runtime/Dockerfile` | there is no observability substrate, no exporter and no restore drill in the tree, so the ticket cannot produce its evidence |
| VLSDK-039 | AMEND | `docs/adr/022-training-recipe.md:53-67` | the classification lab does not create a `tasks/` package; it resolves through the pinned recipe of the ADR and reports through the scorecard, or it becomes a second unpinned training path |
| VLSDK-040 | CONFLICT | `packages/core/src/search/index.ts:20-31` | the only index of the tree is the cosine index over the embeddings of the providers, with the model and the dimension recorded to detect a switch; the encoder of the lab is a different vector space, so the index of the lab is a content addressed artifact of Python and never the index of the core |

The matrix is deliberately flat, and that is the finding: of the 40 tickets, SEVEN are KEEP (the
job shapes, the model endpoints, the CAS ingest, the durable job, the SSE, the cancel and the
first vertical), TWENTY-THREE are AMEND, EIGHT are DEFER and TWO are CONFLICT. The KEEP tickets
are the ones the tree already answers. The extension is not a backlog the repository can run
next: it is a scope, an order and a standard.

## 5. The conflicting decisions

Two places where the extension contradicts what the repository already decided. Each one needs an
explicit decision of the maintainer, and none of them may be resolved by an edit of the extension.

1. **The Node local bridge.** The extension proposes a bridge in `packages/sdk/src/node/` that
   starts the managed Python worker (`VLSDK-033`). ADR-021 fixed the seam of the worker: the
   channel `visionlens.worker.v1` is frozen and the facade over the worker client is the only
   implementation of it. A second implementation of a frozen channel is a divergence of the wire,
   and `AGENTS.md:104` forbids the implementation logic in `packages/sdk/src/` in any case. The
   ticket needs an ADR that supersedes ADR-021, or it moves to the facade that already exists.
2. **The index of the retrieval lab.** The extension proposes the rebuild of the index for the
   lab 14 (`VLSDK-040`). The only index of the tree is the cosine index of the core over the
   embeddings of the providers, and its file carries the model and the dimension precisely to
   detect a switch of the provider. The encoder of the lab is a different vector space, so the
   index of the lab cannot be the index of the core. A Python owned index is a content addressed
   artifact under the single writer rule of ADR-014, and the ticket has to say so.

## 6. The divergences inside the extension

Four places where the extension disagrees with itself or with the tree. They are recorded because
a proposal that contradicts itself cannot be executed as it is written.

1. **The two numbering systems.** `MASTER-SPEC.md:209-215` numbers the gates 0 to 6, and
   `IMPLEMENTATION-PLAN.md:15-21` numbers the epics G0 to G6. They agree on the gate 0 and they
   disagree after it: the gate 2 of the master is the Fastify backend and the G2 of the plan is
   the contract spine; the gate 4 of the master is the CV and the G4 of the plan is the HTTP SDK.
   The roadmap carries the numbering of the plan, because the tickets carry it.
2. **The domain of the contracts.** `BACKEND-API.md:112` says that `visionlens.dev` is a
   placeholder domain and that no link may imply the ownership of it. The contracts of the tree
   already carry it as their identifier
   (`packages/contracts/contracts/worker-request.v1.schema.json:121`), and the snapshot test
   asserts it (`packages/contracts/tests/worker/schema-generation.test.ts:44`). The advice of the
   extension applies to a domain the repository already published in its own schemas.
3. **The paths of the targets.** The backlog names `docs/visionlens-adoption/`, `docs/adrs/`,
   `python/visionlens/src/visionlens/api.py`, `python/visionlens/src/visionlens/io/`,
   `python/visionlens/src/visionlens/runtime/`, `python/visionlens/src/visionlens/remote/`,
   `python/visionlens/src/visionlens/tasks/`, `packages/sdk/src/client/`,
   `packages/sdk/src/node/`, `contracts/golden/`, `tests/contracts/`, `tests/integration/`,
   `tests/contract/`, `tests/security/`, `ci/release/` and `ops/`. Of these, `docs/adrs/` is not
   tracked, the four test roots are not discovered by `vitest.config.ts:7`, `ci/release/` is
   `.github/workflows/`, the registry of Python is at `registry/` and not at `runtime/`, and the
   artifacts are at `inference/artifact.py` and not at `io/`. The ticket of the baseline records
   the difference.
4. **The specs stop at twelve.** The folder `specs/` of the extension carries `VLSDK-001.md` to
   `VLSDK-012.md` and nothing else, so the intent of the 28 tickets that follow exists only in
   the cells of `backlog.csv` and in the prose of the pack. The 12 specs that exist are template
   boilerplate and they do not carry the acceptance criteria of the rows.

## 7. The candidates against the frozen wire

The folder `contracts-proposed/` holds seven candidate schemas. They are candidates and the pack
says so, but their distance from the wire of the tree is worth measuring, because a candidate
that is already a second wire is a candidate that will be copied.

| Candidate of the pack | What the tree owns | The distance |
|---|---|---|
| `job-submit.v1.schema.json` | `packages/contracts/contracts/worker-request.v1.schema.json` | the candidate requires `operation`, `params` and `budget`; the frozen wire requires EIGHT fields: `protocol`, `kind`, `requestId`, `operation`, `contractVersion`, `workspaceId`, `params`, `budget`. The candidate drops five of them, and four of the five are what makes a request traceable and versioned |
| `artifact-ref.v1.schema.json` | `packages/contracts/src/entities/derived-artifact.ts:24-34` | the candidate names `artifactId`, `mediaType`, `sha256`, `byteLength` and `accessTier`; the entity of the tree names `kind`, `sourceAssetIds` and `transform`. Two different shapes for the same word |
| `capabilities.v1.schema.json` | `packages/core/src/facade/capabilities.ts:29` | the candidate is the HTTP envelope `{data, meta}`; the report of the tree is the worker level `FacadeWorkerCapabilities`. The endpoint that would serve it does not exist |
| `problem-details.v1.schema.json` | `packages/contracts/src/worker/protocol.ts:97-118` | the candidate requires `code`, `requestId` and `retryable`, and that IS the vocabulary of the tree: the frozen `WorkerErrorCode` and the map `WORKER_ERROR_RETRYABLE`. Here the proposal does NOT fork the error vocabulary |
| `job-resource.v1.schema.json`, `job-result.v1.schema.json` | `packages/contracts/src/entities/` | no job entity exists, so these two are additive; they land as Zod in the owner of the public entities |
| `job-event.v1.schema.json` | `packages/contracts/src/worker/event.ts` | the candidate carries `jobId`, `seq` and `kind`; the event of the tree is the JSONL event of the frozen wire, and it is not a stream to reuse |

Two controls that the extension assumes and the tree does not have:

- the store has NO workspace column and NO ACL column
  (`packages/core/src/store/migrations/0001_init.sql`), so the cross workspace read that the
  ticket of the artifact download forbids (`VLSDK-024`) has no substrate to forbid, and the
  ticket has to name the isolation model or to scope itself to the single user local case;
- the publication is nowhere. The npm names of the extension return nothing on the registry,
  the PyPI name returns nothing, the npm publish of this repository is disabled behind the
  decision of the publishing identity (`.github/workflows/release.yml:64-76`) and the Python
  workflow publishes nothing at all (`.github/workflows/python-package.yml:6-9`).

## 8. What the extension does not change

The extension is explicit that it does not supersede ADR-011 to ADR-018, that it does not change
the persistence of `packages/core`, the outputs of `@vision-lens/contracts`, the snapshots, the
major version of the JSONL wire, the compatibility of the exports of `@vision-lens/sdk`, the
VisA data sets and the scripts. Its own order of the sources says the same
(`docs/vnext/extensions/sdk-api-2027/README.md:25`): the working tree is above the branch, and
the branch is above the supplement. The ownership of the concern is what decides the shape: the
Zod schemas of `packages/contracts` own the public entities, the Python package owns the
algorithms and the device, the TypeScript services own the durable state, the artifact layer owns
the bytes and the API owns the URLs.

The five ADRs of the extension are PROPOSALS. None of them overrides ADR-011 to ADR-018, and
none of them is accepted by the integration of the pack.

## 9. What this report does not claim

- It does not claim that any SDK, any endpoint, any package or any wheel of the extension
  exists. None of them does, and the extension says so itself.
- It does not claim that the extension is approved. It is a proposal and this report reconciles
  it; the decision to adopt the capability packs, and which of them deserve an ADR, is the
  maintainer's.
- It does not claim that the packages of the extension may be published. The npm publish is
  disabled behind the decision of the publishing identity
  (`.github/workflows/release.yml:64-76`), and the PyPI name is a name to verify.
- It does not claim a performance number. The extension states targets and not measurements, and
  this report keeps them as targets.
- It does not claim that the runtime behaviour of the tree was observed. The verdicts come from
  the files of the tree and from the ADRs, not from an execution of the API, which is a
  placeholder.
- It does not claim that the datasets, the weights or the models of the extension may be
  downloaded. Nothing of the extension was downloaded, and the licences have to be reconfirmed at
  the acquisition review.
