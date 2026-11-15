# Phase III machine-readable contract proposals — NOT authoritative

This folder is a **design aid** and validator fixture set only. The existing TS Zod schemas, route wiring, OpenAPI snapshot and canonical worker JSONL v1 must be inspected and reconciled first. Do not drop these JSON schemas into the repository as replacements; do not claim deployed HTTP routes exist.

## Candidate artifacts

| File | Purpose | Scope |
|---|---|---|
| `job-submit.v1.schema.json` | bounded request to submit one ML operation | deliberately **alpha only** `vision.predict` + `image.classification` |
| `job-resource.v1.schema.json` | 202 response and GET job status | durable job state + metadata + optional result ref |
| `job-result.v1.schema.json` | result metadata and immutable provenance/artifact refs | alpha classification only; bytes fetched separately |
| `job-event.v1.schema.json` | one event JSON body carried in SSE `data:` | distinct from worker stdout JSONL |
| `artifact-ref.v1.schema.json` | content digest/length/access tier | no server file paths or tokens |
| `capabilities.v1.schema.json` | installed/runnable/policy-aware features | lists future task kinds without claiming they run |
| `problem-details.v1.schema.json` | RFC 9457 extension candidate | status/code/request ID/retryability |
| `openapi.phase3.candidate.yaml` | *partial* OpenAPI 3.1 document for jobs/capabilities | not generated from current Fastify/Zod and not full planned API |

The model for `image.detection`, video, OCR, retrieval, matting and PPE requires separate task-specific request/result variants and feature gates; Phase III's docs describe expansion, **not** a claim that the narrow MVP schema already supports them. The canonical Phase II `capability-pack.v0.schema.json` remains separate.

## Fixtures

`examples/*.json` has valid positive fixtures and two deliberately invalid submissions (`missing-asset`, `unsupported-task`). `validation/validate_phase3.py` validates schemas, fixtures and candidates. Schema passing does not imply semantic conformance, auth correctness, model availability or production readiness.

## Versioning and dialect

- These files use JSON Schema draft 2020-12. The candidate OAS uses 3.1, although official OpenAPI 3.2 is available. The *chosen* deployment version depends on tested generators/client compatibility.
- Fastify default Ajv often uses Draft 7 configuration; don't feed 2020-12 schemas unchanged without compatible validator or explicit dialect conversion. Compare semantics and validate route inputs/outputs at runtime.
- Worker `visionlens.worker.v1` JSONL is a separate internal protocol. Public API must not expose its `workspaceId`, worker output directories or internal device handles.
