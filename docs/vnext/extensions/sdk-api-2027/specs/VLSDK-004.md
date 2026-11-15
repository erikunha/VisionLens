# VLSDK-004 — Approve Phase III boundary ADRs

**Status:** to implement (proposal). **Epic:** G0 Reconciliation. **Priority:** P0. **Relative size:** M. **Dependencies:** 001;002;003. **Target code scope:** `docs/adrs/`.

## Objective

Approve Phase III boundary ADRs. This is an additive change to the current VisionLens repository; first inspect existing code and only add missing behavior. Don't overwrite the canonical pack, live migrations, root npm public exports, or uncommitted user edits.

## Scope and implementation contract

1. Record the actual source owner and existing behavior in the P3 reconciliation ledger; preserve the existing public contract where possible.
2. Implement the smallest vertical slice that satisfies the outcome; prefer typed application services, explicit configuration, fail-closed policy and dependency injection.
3. If a schema, storage or public interface is affected, add runtime validators, golden fixtures, migration/version notes and CI conformance diff before enabling writers.
4. Capture immutable asset/model/config/suite fingerprints where a task creates predictions, evaluations or derived artifacts; do not invent values or use mutable aliases.
5. Avoid silent network/model downloads, unbounded resource use and side effects from simple imports, dry runs or capability checks.

## Acceptance criteria

- [ ] Five ADR decisions accepted amended or explicitly deferred with tests.
- [ ] Positive test and at least one negative or fault-injection test, named with exact input and expected typed outcome.
- [ ] Existing Python/TS public API regression and original pack validator pass where applicable.
- [ ] No secret, PII, checkpoint, patient or license-restricted data included in tests or source control.
- [ ] Changelog/ADR/backlog and runnable usage example updated if user-visible surface changed.

## Verification evidence to attach to PR

Record executed commands, runtime/OS versions, fixture hashes, changed files, test names/results, known compatibility limitations and rollback steps. A successful type check is insufficient proof of a running GPU model or HTTP implementation. Keep output deterministic and avoid metrics claimed without measurement.

## Rollback

Disable new capability/route via a feature flag or revert the additive adapter; keep existing stored data readable. Schema migration rollback must be separately reviewed; never drop columns or destroy local user experiments automatically.
