# VLCV-003 — Versioned task evaluation suite, without schema fork

**State:** PROPOSED. **Priority:** P0. **Dependencies:** VLCV-001; contract inventory; canonical `VLN-007/008` outcome for real ML claims. **Size:** M/L.

## User outcome

New tasks can be evaluated scientifically without duplicating APIs, silently changing JSONL and corrupting old predictions.

## Design first

Find canonical `Prediction`/`Annotation`, `Experiment`, `EvaluationRun` and worker operation types. Propose `TaskKind` discriminant **only if not represented**. Support task-specific suite registries (classification, detection, OCR, retrieval, segmentation, temporal) with `suiteDigest`, scoring version and explicit `NO_GROUND_TRUTH` / `INVALID_SPLIT` outcomes. Never compare unrelated metrics as a single winner.

## Scope

Implementation of one CPU-friendly suite type and one second evaluator scaffold, exact fixtures, API/worker parity tests and a read-only evaluation report. Predictions separate from approved annotations; held-out split proof; failures remain in denominator.

## Non-goals

No generic architecture rewrite, no metric for every task, no UI redesign, no new database/server. No claim of mAP from only full-image classification labels.

## Test matrix

1. `TaskKind` unknown -> typed unsupported error, no write.
2. Same fixture and scorer revision -> stable output digest where deterministic.
3. Missing GT -> inconclusive evaluation, not 0 or 100%.
4. Different suite/preprocess/ontology -> `NOT_COMPARABLE`, no auto winner.
5. Stale model/index/checkpoint hash -> block evaluation or explicit missing artifact error.
6. Failures/timeouts included according to recorded denominator policy.
7. Geometry invalid/rotated EXIF handled or rejected explicitly.
8. Zod↔Python validator parity passes for actual shipped schema; no unchecked examples copied from docs.

## Acceptance

PR exposes one versioned scorecard on fixture data and a compatibility report showing old CLI/SDK/SQLite behaviors unchanged. If new wire field requires protocol major/minor, accept ADR before implementation.

## Rollback

Feature flag evaluator registration; existing artifacts preserve old decoding semantics and no destructive schema migration.
