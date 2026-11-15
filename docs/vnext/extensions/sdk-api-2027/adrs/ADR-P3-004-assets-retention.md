# ADR-P3-004 — Ingestion, artifact identity and retention

**Status:** Proposed. **Date:** 2026-11-15. **Relates to:** canonical data model/provenance docs and Phase II data rights.

## Decision proposed

- The API accepts media through streamed, size- and dimension-bounded `POST /v1/assets`, validates magic bytes, MIME and image/video decoder constraints; stages in a restricted directory and records SHA-256 before atomic CAS commit. Reject absolute paths, symlinks, untrusted URL imports and web-supplied command arguments.
- `Asset` and `ArtifactRef` are scoped opaque identifiers; immutable source bytes stay immutable. A **derived sanitized asset** is created for previews/exports where EXIF/PII removed; never silently overwrite original bytes.
- `GET /v1/artifacts/{id}` returns metadata, separately `/download` authorized streaming or expiring scoped URL, with server-side hash/ETag and non-cacheable private content as appropriate. No raw server paths or binary payload in job JSON/SSE.
- Local Python runs use a separate CAS + manifest under explicit user directory; importing to managed workspace requires server permission and content/rights reconciliation.
- Retention defaults are set by deployment/workspace policy. Active jobs, legal holds and referenced immutable evaluation runs pin blobs; expired/orphaned content GC is audited and restorable where feasible.

## Consequences

Single-asset ingest is alpha; large video multi-part session and time-bound upload URLs are later ADR. Authorized access is checked before metadata lookup and download; link expiration does not itself change artifact identity.

## Required validation

Magic-byte mismatch, decompression bombs, EXIF GPS in previews, upload abort, duplicate hash across distinct workspaces with ACL isolation, symlink attack, orphaned CAS after crash, integrity mismatch and TTL/GC/legal-hold exercises.
