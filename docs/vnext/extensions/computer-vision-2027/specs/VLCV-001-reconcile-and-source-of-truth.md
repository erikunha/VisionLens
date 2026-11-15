# VLCV-001 — Reconciliation + non-destructive admission of Phase II

**State:** PROPOSED. **Priority:** P0. **Dependencies:** original `VLN-001`/R0 reconciliation status, repo inspected; no dependency on pretrained weights. **Size:** S/M.

## User outcome

A maintainer knows precisely what Phase II changes, what already exists and which first PR is safe. The new docs can live alongside existing ADRs/specs without losing work or misrepresenting implementation.

## In-scope

Read-only inventory of current branch, SHA, uncommitted changes, existing specs/ADRs, `packages/contracts`, `packages/core`, `services/`, `python/`, `apps/`, tests and CI. Compare actual state against original ZIP and Phase II. File-level matrix `KEEP`, `AMEND`, `DEFER`, `SUPERSEDE_WITH_ADR`, `CONFLICT`. Preserve original manifest, ZIP and non-owned files. Add docs only to a *new* branch after agreeing destination; cite exact code paths.

## Out-of-scope

No model download, PyTorch installation, package rename, dataset migration, parser rewrite, DB schema change, new deployment, secret scanning that accesses credentials, model/prompt experiments.

## Deliverables

`docs/migration/visionlens-cv-phase2-reconciliation.md` (if no conflicting document), a compatibility matrix for CLI/SDK/worker/Zod/SQLite, a decision on whether `CapabilityPack` abstraction already exists and one smallest-next-PR proposal.

## Acceptance

1. Actual HEAD/branch/status captured; no claims about uninspected local work.
2. Existing `VLN-*` tasks mapped to statuses with test evidence; implemented ≠ documented.
3. Diff path inventory of new docs, no overwrite of unrelated data.
4. Matrix includes each lab 09–16, source of truth for existing entity and proposed delta.
5. All blockers tagged `BLOCKER / RESEARCH / DEFER`, first PR with no more than one independently testable vertical slice.
6. Script `validation/validate_pack.py` on original pack reports result; failures not concealed.

## Rollback

Remove only explicitly added Phase II docs on feature branch; do not alter original commit history. No data migration.
