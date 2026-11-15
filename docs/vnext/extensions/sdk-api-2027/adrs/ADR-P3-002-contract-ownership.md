# ADR-P3-002 — Contract authority, HTTP error representation and versioning

**Status:** Proposed; no schema is accepted solely by inclusion in this ZIP. **Date:** 2026-11-15. **Relates to:** canonical ADR-013, ADR-016, `packages/contracts`.

## Context

Canonical files include Zod implementations and a generated OpenAPI seed; JSONL v1 is separately proposed. Phase II adds heterogeneous CV outputs. Independently authored TS, Python and OpenAPI models would drift. Fastify v5 default validation and OpenAPI 3.1 use different potential JSON Schema dialects.

## Decision proposed

- Public request/response/error contracts originate in accepted TypeScript Zod/route schemas. Generate checked JSON Schema and OpenAPI for clients. Python validates using equivalent Pydantic models and golden fixtures; do not promise full automatic Pydantic generation if no generator preserves semantics.
- Start with `POST /v1/jobs`, typed `vision.predict` operation for Phase III alpha and published request, status, result and ProblemDetails. Add other operations one by one after reconciling existing core types.
- Use RFC 9457 `application/problem+json` with typed `code`, `requestId`, `retryable` extensions, after checking prior public API contracts. Never emit Python traceback, internal FS path or secrets.
- API route version `/v1`, domain `contractVersion`, JSONL `visionlens.worker.v1`, package semver, task output version and model artifact revision are independent. Negotiate supported major, reject incompatibility with `VERSION_MISMATCH` rather than silent downcasting.
- Pin generated OpenAPI to **3.1 for the first implementation** only after toolchain compatibility tests; 3.2 exists but is not the assumed MVP generator target. Validate schema dialect used by Fastify rather than passing Draft 2020-12 blindly into default AJV.

## Consequences and test obligations

Every type change requires golden fixture diff, TS Zod and Python TypeAdapter/Pydantic verification, Fastify `inject()`, OpenAPI diff and migration classification. Unknown enum meaning is not silently ignored; floating numeric parity uses explicit tolerances, while semantic hashes/input IDs must match.

## Open questions

`client->server` version header (`X-VisionLens-Contract-Version`) vs capabilities-only negotiation; `status=409` vs `426` for version mismatch; `ProblemDetails.type` stable URN vs controlled domain. Resolve before writing public API.
