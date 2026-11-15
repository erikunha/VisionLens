# Phase III — Trust boundaries, threats and abuse controls

**Threat model scope:** Python wheel, npm SDK, public/local Fastify HTTP, asset ingest/CAS, Python worker, models/checkpoints, jobs and CV outputs. **Status:** proposed; deployment review required before internet exposure.

## Assets and boundaries

```text
Untrusted client/browser -> HTTP boundary -> Auth+policy+rate+idempotency -> TS application/store (single writer)
                             |                                 |
                             +-- media staging -> decoder -> CAS+ACL
                                                               |
                                                       worker supervisor
                                                               |
                                                      restricted Python ML
```

**Trust levels:** caller-supplied media, metadata, requests, prompts and model references are untrusted; SDKs are convenience clients, not trusted policy engines; worker stdout is untrusted until schema validation; model weights and Python dependencies are code/supply-chain inputs; store & CAS metadata are authoritative only after validation/commit.

## Threat register

| ID | Scenario | Prevention | Verification |
|---|---|---|---|
| T01 | arbitrary path or symlink escapes workspace | HTTP accepts asset IDs not absolute paths; worker accepts scoped pre-resolved handles; canonicalize & forbid symlink traversal | traversal/symlink tests on upload/results |
| T02 | image decompression bomb / crafted media decoder exploit | max bytes/dimensions/pixels/frame count; isolated decode process; content sniffing | fuzz/corpus, oversized media, malformed JPEG/PNG/WebP |
| T03 | malicious model weights / arbitrary pickle/code execution | allowlisted models, digests, safe weights formats, signed registries; no dynamic import string supplied by request | malicious checkpoint fixture rejected |
| T04 | auth bypass or IDOR through job IDs/assets | authorize resource workspace and action before lookup; opaque IDs not a security control | cross-tenant and guessed ID tests |
| T05 | DNS rebinding / CSRF against localhost Fastify | bind loopback; require local session secret; validate Host+Origin, CSRF where cookies, restricted CORS | rebind simulation / hostile-origin tests |
| T06 | browser tokens leak in SSE query URL | fetch streaming with Authorization header or tightly scoped cookies; never token query string | proxy/access log redaction tests |
| T07 | duplicate expensive execution / charges | idempotent job admission; durable lease and atomic result commit; budget enforced twice | same-key same-body, crash/restart, concurrent create |
| T08 | unbounded GPU/CPU cost or denial of service | quota, concurrency semaphore, worker cgroups/process limits, request deadlines, cancellation | stress tiny queue and forced OOM tests |
| T09 | data egress to external model provider | no implicit network, model/provider policies, explicit opt-in and audit, allowlisted endpoints | deny outbound and mock external provider tests |
| T10 | OCR/plate/face/person privacy leaks | scoped access, data retention, mask/redact logs and previews, explicit consent/policy, no cross-video person re-ID | redaction tests, deletion/retention exercise |
| T11 | clinical misuse / PHI exposure | lab 16 research-only, pseudonymization, patient grouping and research disclosure, forbid auto diagnosis API | reject medical auto-diagnose operation |
| T12 | prompt injection through OCR or visual agents | treat all extracted text as data, typed tool registry, permission gates, bounded context and no arbitrary code | malicious OCR prompt fixture cannot elevate permissions |
| T13 | package publish compromise | OIDC trusted publishers, protected release env, provenance where supported, SBOM/SCA, no long-lived publish tokens | dry-run publish on test registry |
| T14 | artifacts corrupted/raced or wrong-user download | content digests, atomic CAS commit, compare hash on download, scoped signed URLs | intentional corruption + concurrent write tests |
| T15 | SSE event stream leak / replay abuse | auth per stream and replay, retention cursor, no high-volume binary events, heartbeat and backpressure | expired cursor and unauthorized subscription |
| T16 | admin privileges via Python standalone import | local Python is *not* a sandbox; never share local process privileges with untrusted API users | assert no arbitrary local files accepted by API |

## Policy baseline

- **Bearer auth** remote, scoped token provider; local app session token random/rotated on launch and strictly loopback-bound. Do not accept credential in URL.
- **HTTP protection**: content length, body limits, origin/host, timeouts, consistent errors, request ID. Rate-limit protected before payload decode where possible.
- **Data minimization**: remove EXIF GPS before sharing/public demo, not silently from immutable source (retain original in controlled storage and publish derived sanitized artifact). Retention in policy; no raw plate text or patient IDs in traces.
- **Resource management**: per job predicted cost and actual CPU/GPU millis, max bytes and pixels, max queue depth, max retention, bounded model cache, blast-radius limited workers. No hidden 3rd party billing.
- **Agent privileges**: inspect/evaluate read/analyze by default; mutate/export/train/promote require explicit logged authorization and per-workspace capability.
- **Audit**: actor, workspace, operation, model revision, data-use policy, auth decision, budget, artifact refs and approval ID; exclude raw bytes/PII and tokens.

## Privacy and license decisions for Phase II labs

09 classification and 14 visual retrieval can use permissively licensed sample images after rights validation; 10 detection and 15 matting inherit model license terms; 12 counting/13 PPE require explicit privacy and anti-surveillance use policy for real footage; 11 license-plate OCR is PII-sensitive and has geographic/regulatory differences; 16 medical remains research-only and requires dataset DUA, patient leakage checks and expert oversight.

## Deployment release checklist

Before public network exposure: authenticated E2E unauthorized/cross-workspace tests; reverse proxy TLS/headers; operator runbook; secret management; log sanitization; backups+restore drill for SQLite/CAS; worker isolation; quota/cost limits; incident plan; dependency and image vulnerability scan; asset purge verification; legal review of model and dataset distribution. Do not equate a passing JSON Schema validator with sufficient protection against hostile content.
