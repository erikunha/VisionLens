# ADR-P3-005 — Durable jobs, event replay and supervised JSONL worker

**Status:** Proposed; implementation details depend on existing TS store/migration. **Date:** 2026-11-15. **Relates to:** canonical ADR-013, ADR-014 and job resilience spec.

## Decision proposed

- The TS app service owns admission, idempotency, scopes, durable job state, leases, audit and artifact-reference commit. Worker receives only approved operation, assets, bounded budgets and a `visionlens.worker.v1` JSONL request.
- Persistent job states: `queued`, `preparing`, `running`, `succeeded`, `failed`, `cancelled`, `expired` (actual accepted enums to reconcile). Cancellation request is distinct from the eventual terminal cancellation event.
- `POST /v1/jobs` returns `202 + Location` only after transaction commits job+idempotency key+created event. Same key/body/actor/workspace within TTL returns existing job; same key different canonical body gets 409.
- Supervisor validates `hello` protocol major, supported operations, installed extras, device and limits. Fixed executable command without shell; stdout JSONL only; stderr structured/redacted logs. Bounded frame length, timeouts, progress sequence, process RSS/CPU budget and kill-on-timeout. Do not expose client supplied paths.
- Results pass schema validation and artifact hash checks before atomic DB commit to `succeeded`; crash between CAS blob and DB commit leaves orphan cleanup, not a false success. Re-execution uses dedupe/lease; side-effecting operation never auto-retries without explicit policy.
- SSE streams persistent events with stable `(jobId,seq)` cursor. `Last-Event-ID` replays within retention; expired cursor errors explicitly; client `AbortSignal` only cancels waiting, not the job.

## Alternatives rejected

Use memory-only queue as durable state; treat worker as HTTP microservice with independent auth/persistence; stream raw JSONL to SSE; assume HTTP client retries are safe for non-idempotent POST; use browser disconnect as cancellation.

## Required fault injection

Crash before 202 commit; crash after acceptance before dispatch; worker invalid hello/oversized line/partial frame; worker SIGKILL mid-run; duplicate HTTP job create concurrently; expiry/cancel races; artifact corruption after write; re-connect stream from cursor; restart and retain correct outcome.
