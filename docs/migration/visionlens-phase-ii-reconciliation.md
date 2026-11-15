# Vision Lens Phase II reconciliation (VLCV-001)

| Field    | Value                    |
| -------- | ------------------------ |
| Status   | Proposed                 |
| Date     | 2026-11-15               |
| Deciders | @erikunha                |
| Ticket   | VLCV-001, wave CV0, role architecture |
| Design baseline | `VisionLens_2027_Canonical_Spec` (2026-11-11) with the Phase II extension of 2026-11-15, integrated at `docs/vnext/` and `docs/vnext/extensions/computer-vision-2027/` |
| This report | branch `docs/phase-ii-cv-extension` |

This report reconciles the Phase II extension with the repository as it actually is. It changes
no runtime code, it writes no domain row and it performs no destructive git operation. Its
acceptance criterion is the one of the ticket it closes: "HEAD, dirty working tree, KEEP/AMEND
matrix", with the gate "no local edits lost".

The extension is a proposal and it says so in its own first line: it does not represent
implemented features, open pull requests or executed tests. Nothing of it is shipped, and this
report does not make it shipped. What the report does is say which of the 33 proposed tickets
the repository can answer as it is, which need a named change, which are not the next thing to
build, and which contradict a decision the repository already took.

## 1. Provenance and method

Two deliveries are integrated in the repository:

- the canonical package, at `docs/vnext/`: 65 tracked files, 64 of them covered by
  `docs/vnext/MANIFEST.sha256`. The manifest of 2026-11-11 covered 63 files; the delivery of
  2026-11-15 adds the handoff and replaces the hashes of the README and of the full spec;
- the Phase II extension of 2026-11-15, at `docs/vnext/extensions/computer-vision-2027/`, 19
  files covered by its own `MANIFEST-PHASE-II.sha256`.

Both manifests hold over the tree, and the validator of the pack reports zero errors:

```
$ python3 docs/vnext/validation/validate_pack.py
WARN: jsonschema unavailable; JSON schema validation not checked
Files: 98 Manifest: 64 Errors: 0
$ (cd docs/vnext && shasum -c MANIFEST.sha256 | grep -c ": OK")
64
$ (cd docs/vnext/extensions/computer-vision-2027 && shasum -c MANIFEST-PHASE-II.sha256 | grep -c ": OK")
19
```

The validator skips the JSON schema check when `jsonschema` is not installed, so this run
verifies the manifest coverage and not the schema conformance of the pack.

The extension adds no entry to the canonical manifest: the pack covers its own files and the
extension covers its own. The canonical manifest moved only with the delivery of 2026-11-15,
which added the handoff and replaced the hashes of the README and of the full spec. The files
were copied verbatim, and the only edit this
repository made to the delivered content is the one this report and the roadmap carry: the
roadmap names the waves and the labs in the words of the repository.

The method is the one of the canonical reconciliation (`docs/migration/vision-lens-vnext-reconciliation.md`):
the live tree is read before the proposal is judged, the verdict vocabulary is the one the
repository already uses (KEEP, AMEND, DEFER, CONFLICT), and every verdict names the path or the
ticket that carries the evidence.

## 2. What the extension proposes

The extension is one decision with two halves.

The first half is the CAPABILITY PACK: a declarative record of a task kind, of the data it
accepts, of the preprocessing, of the inference strategy, of the evaluation algorithm, of the
licence policy, of the hardware profile, of the evidence schema and of the export capabilities
(`docs/vnext/extensions/computer-vision-2027/ARCHITECTURE-ADDENDUM.md:41`). A pack defines behavior options and not a competing engine.
The proposed schema carries the constant `cvpack.proposed.v0`, an `$id` on `example.invalid` and
the title "CapabilityPack proposal (not production contract)": it is illustrative, it has no
versioning rule and it has no authority over the Zod schemas, over the SQLite store or over the
JSONL protocol (`contracts-proposed/README.md`).

The second half is the SCOPE: eight computer vision labs, five waves and 33 tickets that do not
collide with the `VLN-*` of the canonical backlog. The labs are the transfer learning of lab
09, the object detection of lab 10, the plate reading of lab 11, the video counting of lab 12,
the PPE of lab 13, the visual similarity of lab 14, the background removal of lab 15 and the
chest radiograph research of lab 16 (`LABS-09-16.md`).

The third half is the STANDARD, and it is the part this repository cares about most: the metric
per task and no universal score, the split unit as the real dependency unit, the mandatory
failure slices, the inference failures inside the denominator, the separation of the score of
the model from the calibrated confidence, the threshold of the promotion defined BEFORE the
test, and the list of claims that are forbidden (`docs/vnext/extensions/computer-vision-2027/MASTER-SPEC.md:118`, `:138`).

## 3. The live tree the extension lands on

What the repository has today, by the ticket of the canonical backlog
(`docs/vnext/execution/backlog.csv`):

| Ticket | What shipped |
|---|---|
| VLN-001 | the reconciliation record of the canonical package |
| VLN-002 | the Python-first decision, its ADR (`docs/adr/011-python-first-ml-runtime.md`) and the owner map |
| VLN-003 | the public `visionlens` distribution, its extras and the release gate |
| VLN-004 | the JSONL worker protocol across the contracts, the core and the Python side |
| VLN-005 | the CPU vision adapter: the pinned `siglip2-base` record, the decoder, the canonical preprocessing, the device planner, the SigLIP2 adapter, the content-addressed embedding artifact and the golden parity gate |
| VLN-006 | the TypeScript facade over the worker client (`docs/adr/021-python-worker-facade.md`) |
| VLN-007 | the leakage-resistant split of 700 VisA items (420/140/140) with the partition fingerprint |
| VLN-008 | the evaluation scorecard, the regime gate and five suites |
| VLN-009 | the pinned recipe, the probe and the digest-pinned checkpoint; the trainer and the loader of the frozen features are in flight |
| VLN-010, VLN-011 | not started |
| VLN-012 | divergence recorded, the MCP surface does not exist |

What the extension finds here is a repository that already holds three of the four primitives
its first wave needs: an encoder and its frozen artifact (VLN-005), a split with a fingerprint
(VLN-007) and an evaluator with a regime gate (VLN-008). What it does NOT find is a second
task, a second dataset, a licence policy that covers the conflicting-rights case for data and
models, or a task-kind aware contract.

## 4. Classification per ticket

`KEEP` means the shipped tree is the answer and the proposal agrees. `AMEND` means the proposal
is right in substance and needs a named change. `DEFER` means the proposal is correct and is not
the next thing to build. `CONFLICT` means the proposal contradicts a decision the repository
already took.

| Ticket | Verdict | Evidence in the live tree | Note |
|---|---|---|---|
| VLCV-001 | AMEND | `docs/migration/vision-lens-vnext-reconciliation.md` | this report EXTENDS the canonical report and does not replace it; both are cited from the roadmap |
| VLCV-002 | AMEND | `packages/core/src/benchmark/registry.ts:17`, `datasets/registry.json:34` | the licence gate exists for the DATA and for the MODELS (`assertDatasetLicensed`, `DATASET_USAGES` with `research-only`); what is missing is the conflicting-rights case, and it extends the gate instead of forking it |
| VLCV-003 | AMEND | `packages/core/src/benchmark/scorecard.ts`, `packages/contracts/src/entities/evaluation.ts` | the scorecard IS the evaluator of one task kind; a task-kind aware suite is an extension, and the discriminated output union needs an ADR |
| VLCV-004 | AMEND | `python/visionlens/src/visionlens/registry/dataset.py:24` | the manifest schema is a CLOSED one to extend; the dataset itself is not the next thing to build, and the rights review has to happen before any fetch |
| VLCV-005 | AMEND | `python/visionlens/src/visionlens/training/probe.py` | the M0 rung exists; the majority baseline does not, and it is a one-line addition to the evaluator |
| VLCV-006 | CONFLICT | `docs/adr/023-probe-and-checkpoint.md`, `docs/vnext/12-TRAINING-EXPERIMENTS-MLFLOW.md:6` | the PyTorch head is the M1 rung, and ADR-023 decided that this rung is scikit-learn with no autograd; the ticket needs an ADR that supersedes that decision, or a change of scope |
| VLCV-007 | AMEND | `packages/core/src/benchmark/calibration.ts` | the ECE calibration exists; the Brier, the risk-coverage curve and the error explorer extend it, and the abstention is new |
| VLCV-008 | AMEND | `packages/core/src/analyzer/dedup.ts:27` | the perceptual hash and the Hamming distance exist, inside a burst scope; the pHash and the SHA reference extend them |
| VLCV-009 | AMEND | `python/visionlens/src/visionlens/encoders/siglip2.py` | the IMAGE side of the encoder exists; the text tower does not, and the extension must not fork the adapter |
| VLCV-010 | DEFER | `packages/core/src/search/index.ts` | the index of the repository is over text; the visual index is R3, which has no ticket yet |
| VLCV-011 | DEFER | none | no segmentation anywhere in the tree |
| VLCV-012 | DEFER | none | no matting and no RGBA export anywhere in the tree |
| VLCV-013 | DEFER | `apps/studio/src/index.ts` is a placeholder | the Studio is not started (R6), and the ticket of the Studio slice has to land first |
| VLCV-014 | DEFER | `docs/vnext/10-INGEST-CURATION-ANNOTATION.md:15` | the rule of the geometry is already decided; no export code exists |
| VLCV-015 | DEFER | none | no detector adapter exists |
| VLCV-016 | DEFER | none | the AGPL decision of the YOLO weights is not taken |
| VLCV-017 | DEFER | `packages/core/src/benchmark/scorecard.ts` | the scorecard has no detection family |
| VLCV-018 | DEFER | the arena of R4 has no ticket | the model arena is not started |
| VLCV-019 | DEFER | `packages/contracts/src/entities/ontology.ts`, `packages/core/src/classifier/rules.ts` | the ontology entity is generic; no PPE taxonomy and no reviewer guide exist |
| VLCV-020 | DEFER | `packages/core/src/reviewer/index.ts` | the human review path exists generically; the person-equipment association does not |
| VLCV-021 | DEFER | `packages/contracts/src/entities/reserved.ts:15` | the names `track` and `frame` are reserved and their activation is gated; no video ingest exists |
| VLCV-022 | DEFER | none | no tracking exists |
| VLCV-023 | DEFER | none | no event engine exists |
| VLCV-024 | DEFER | none | no counting evaluator exists |
| VLCV-025 | DEFER | none | no synthetic generator exists |
| VLCV-026 | DEFER | none | no OCR pipeline exists |
| VLCV-027 | DEFER | `datasets/registry.json:34` | the `research-only` usage of a dataset is a precedent of the registry; no ALPR evaluator exists |
| VLCV-028 | CONFLICT | `ROADMAP.md`, the table of what is not built | the repository EXCLUDES the medical imaging vertical; the ticket asks to enter it and needs a dated amendment of that table |
| VLCV-029 | CONFLICT | the same exclusion | the excluded vertical, a patient-level split and a multilabel evaluation; the decision is the same one as the ticket of the governance |
| VLCV-030 | DEFER | none | no grounding spike exists |
| VLCV-031 | DEFER | none | no video mask exists |
| VLCV-032 | DEFER | none | no document OCR exists |
| VLCV-033 | DEFER | the anomaly work of the active learning ticket is open | the hypothesis of the lab is research, and the research is not the next thing |

The matrix is deliberately flat, and that is the finding: of the 33 tickets, EIGHT are AMEND (the
reconciliation itself, the licence and provenance policy, the task contract audit, the dataset
manifest, the classification baseline, the calibration, the near-duplicate reference and the
embedding adapter), THREE are CONFLICT (the PyTorch head and the two tickets of the chest
radiograph) and the other TWENTY-TWO are DEFER. NONE is KEEP: there is no ticket of the
extension that the repository answers as it is today. The extension is not a backlog the
repository can run next. It is a scope, an order and a standard.

## 5. The conflicting decisions

Five places where the extension contradicts what the repository already decided. Each one needs
an explicit decision of the maintainer, and none of them may be resolved by an edit of the
extension.

1. **The MCP tool codes.** The extension proposes `dataset.inspect` as a tool of the investigator
   surface (`docs/vnext/extensions/computer-vision-2027/ARCHITECTURE-ADDENDUM.md:145`). The frozen protocol says the three catalog codes
   "MUST NOT be accepted in v1" (`packages/contracts/src/worker/protocol.ts:62`), and
   `experiment.compare` is not a code anywhere in the repository. The conflict is with the wire
   of v1, and the wire does not move without a major version.
2. **The task kinds and the evaluator families do not line up.** The evaluator section names the
   families `tracking` (HOTA and IDF1), `matting` and `medical-research`
   (`docs/vnext/extensions/computer-vision-2027/ARCHITECTURE-ADDENDUM.md:131-134`) and the
   proposed schema names the kinds `video.counting`, `image.ppe`, `image.matting` and
   `research.xray`
   (`docs/vnext/extensions/computer-vision-2027/contracts-proposed/capability-pack.v0.schema.json:33-37`).
   The coverage is the same and the names are not: no kind of the schema says `tracking`, and no
   family of the evaluator says `image.ppe`, although the master spec scores PPE as a family of
   its own (`docs/vnext/extensions/computer-vision-2027/MASTER-SPEC.md:121`). An implementer
   cannot tell which family a pack belongs to.
3. **`MISSING_EXTRA` is claimed not to exist** (`docs/vnext/extensions/computer-vision-2027/ARCHITECTURE-ADDENDUM.md:80`) and it exists in
   the frozen vocabulary (`packages/contracts/src/worker/protocol.ts:86` and
   `python/visionlens/src/visionlens/errors.py`). The extension was written against a state of
   the tree that the tree never had.
4. **`taskKind` and `outputSchemaVersion` in the envelope** are a change of the guarded wire
   shape (`docs/vnext/extensions/computer-vision-2027/ARCHITECTURE-ADDENDUM.md:101`), and the protocol requires a MAJOR `CONTRACTS_VERSION`
   bump for that.
5. **The vocabulary of the safety tier collides.** The extension uses `safetyTier` with the
   values standard, personal-data, safety-sensitive and restricted-medical, and the repository
   uses `AGENT_TOOL_TIERS` with read, analyze, propose, gated-execute and approval-required. Two
   different axes under one word, and the reader of a pack cannot tell which one it is reading.

Two more divergences, of a different kind:

6. **The CLI alias that the extension lists as unchanged is gone.** The extension names the CLI
   aliases among the things not to change now (`docs/vnext/extensions/computer-vision-2027/ARCHITECTURE-ADDENDUM.md:35`), and this
   repository removed the deprecated alias of the earlier bin name on 2026-11-15 (PR #54), because
   the CLI package was never published and no published consumer depended on it. The extension
   was written against the tree of 2026-11-11, and this repository is ahead of it.
7. **The names of the proposed entities sit next to the reserved ones.** `FrameRef` and
   `TrackEvent` sit beside the reserved entity names `frame` and `track`
   (`packages/contracts/src/entities/reserved.ts:15`), and a new name that a reader cannot tell
   from a reserved one is a name that will be read as the reserved one.

## 6. What the extension does not change

The extension is explicit that it does not supersede ADR-011 to ADR-018, that it does not change
the persistence of `packages/core`, the outputs of `@vision-lens/contracts`, the snapshots, the
major version of the JSONL wire, the compatibility of the exports of `@vision-lens/sdk`, the
VisA data sets and the scripts (`docs/vnext/extensions/computer-vision-2027/ARCHITECTURE-ADDENDUM.md:3`, `:35`). The rule of the
evolution of a contract is the one the extension states: a new discriminated variant with a
version bump, the readers migrated BEFORE the persisted data of that type is written, and a field
added only when no adequate field exists
(`docs/vnext/extensions/computer-vision-2027/ARCHITECTURE-ADDENDUM.md:60`, `:101`). The rule of
the repository is weaker and says only that a structural breaking change bumps the major and that
an additional optional field may be a minor (`docs/vnext/07-CONTRACTS-PROTOCOL.md:72`), so the
extension cannot lean on the repository to already say what it says.

Nothing of the extension is a reason to change the owner map, the boundary table or the release
gate of this repository. The seven items that the addendum says need an ADR before any code are
accepted as they are written: a persisted prediction schema with geometry, text or video; the
handling and the retention of a video; a copyleft model inside a distributed build; the
processing of health, plate or biometric data in an environment that reaches the network; a new
external service with an egress of assets; a change of a benchmark; and a change of the public
SDK or of the major version of the worker protocol.

## 7. The one next pull request

The extension asks for one scoped pull request with three to six acceptance tests and not eight
implementations (`AGENT-HANDOFF.md`). This report is that pull request for the first ticket: the
reconciliation, the pack integrated verbatim, the roadmap carrying the waves, and nothing of the
labs.

The next pull request AFTER this one is VLCV-002, the licence and provenance policy of the
models and of the data, and it is AMEND rather than a new thing: the gate of the licence of the
models exists, it refuses a record without the licence, and the data side has to extend it
instead of forking it. The extension asks the gate to fail closed on unknown rights, and the
repository asks the same of everything else.

## 8. What this report does not claim

- It does not claim that any lab, any wave or any ticket of the extension is implemented. None
  is.
- It does not claim that the extension is approved. It is a proposal and this report reconciles
  it; the decision to adopt the capability packs, and which of them deserve an ADR, is the
  maintainer's.
- It does not claim that the datasets named by the extension may be downloaded. The extension
  says the opposite: none is downloaded, executed or redistributed, and the licences have to be
  reconfirmed at the acquisition review.
- It does not claim a held-out accuracy of the extension. The VisA number of this repository is a
  regression baseline over a leakage-resistant split: the whole set of the 700 items reaches macro
  F1 0.9734 (`docs/datasets/visa.md:799`) and the held-out figure of the 140 `test` items reaches
  macro F1 0.9862 (`docs/datasets/visa.md:716`). The gate refuses to compare the two, because they
  are two regimes. What is still open is the evaluation of the locked holdout of the probe
  (`ROADMAP.md:216`).
- It does not claim that the MPS arm of the canonical ticket is reachable. The build admits the
  CPU and only the CPU, and the trainer says so instead of running somewhere else.
