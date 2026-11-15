# Shared contracts & conformance — Python ↔ TypeScript ↔ HTTP ↔ worker

**Design status:** proposal. **Supreme source at implementation time:** current `packages/contracts/src` implemented Zod + existing `openapi.snapshot.json` + `contracts/proposed` from canonical, reconciled against live branch; examples in this supplement are not authoritative.

## 1. Source of truth and generation direction

```text
TS domain Zod schemas (existing implementation)
  ├── canonical JSON Schema snapshots (versioned, build output)
  │      └── Python Pydantic adapters/validators (generated/checked)
  ├── Fastify accepted route schemas
  │      └── OpenAPI 3.1 snapshot (generated, compatibility diff gate)
  │             ├── @vision-lens/sdk/client generated TS path types
  │             └── Python HTTP client request/response typed models (generated/checked)
  └── fixtures/golden/v1/*.json (schema + semantic conformance)
                  ├── TS Zod parse and serialize
                  ├── Python TypeAdapter parse/serialize
                  ├── Fastify inject() HTTP response
                  └── JSONL worker adapter where relevant
```

**No competing schema sources.** Python can own internal tensor/model/training types and export schema proposal to TS for acceptance, but crossing HTTP or JSONL requires accepted canonical schema. OpenAPI cannot safely be "generated from Python server" in parallel while Fastify already owns HTTP routing. Pipeline must be deterministic, with a single checked artifact. Generated TypeScript type definitions alone are compile-time only and must be paired with runtime schema validation at trust boundaries.

### 1.1 Concrete mapping

| Concept | Wire JSON | TS | Python |
|---|---|---|---|
| operation | `operation: "vision.predict"` | discriminated literal enum | `Literal["vision.predict"]` / Enum |
| CV task | `params.taskKind: "image.detection"` | discriminated union | union typed model with alias |
| job id | `jobId` opaque string | branded type optional | `str` validated |
| model id/revision | explicit ref/digest | domain `ModelDescriptor` | typed `ModelRef` |
| timestamp | RFC3339 UTC string | branded iso string (not auto Date by default) | timezone-aware `datetime` after validation |
| box | `xyxyPixels: [x1,y1,x2,y2]` | 4-tuple | 4-length tuple of float (validated) |
| mask/embedding | `ArtifactRef` | typed ref | typed ref |
| unknown values | nullable enum state e.g. `"unobservable"` | exact literal | Enum |
| scores | raw float + `calibratedProbability: null|0..1` | numeric, optional? explicit null | `float | None` |
| errors | ProblemDetails + `code` | typed Error class | typed exception |
| artifact hash | sha256 lowercase hex | string with validator | `str` with digest parser |
| version | `contractVersion`, `workerProtocolVersion`, `packageVersion` distinct | semver string | semver string |

Semantics must be recorded in schema descriptions, not just field type. For example boxes are **absolute pixels in correctly oriented image coordinate frame**, not normalized coordinates; OCR `textRaw` and `textNormalized` are separate fields; `trackId` scoped to one `clipId`. A prediction cannot become ground truth via serialization.

## 2. Version architecture

### 2.1 Independent versions

| Layer | Example | Breaking rule |
|---|---|---|
| Python package | `visionlens` 0.x (placeholder) | SemVer of import surface; pre-1.0 changes documented |
| TypeScript npm package | `@vision-lens/sdk` existing branch | `exports`/function shape incompatible => major |
| HTTP API | `/v1` | semantically breaking wire route/resource => `/v2` migration |
| Zod domain schema | `contractVersion=1.0.0` from canonical example | domain changes schema major and migration |
| JSONL worker | `visionlens.worker.v1` | worker frame negotiation; major mismatch = fail |
| CV task output | `taskOutputVersion` *candidate* | geometry/ontology/metric behavior might require version |
| model/pipeline | exact immutable model/weights/preprocess hashes | run results always pinned |

Do not calculate compatibility from npm/Python package versions alone. `GET /v1/capabilities` returns server supported API/contract/worker majors and feature flags (coarse public subset; avoid leaking internal security info). Client sends desired contract major optionally via header `X-VisionLens-Contract-Version`; exact mechanism requires ADR. Unsupported major produces typed `VERSION_MISMATCH` with supported range, not silent coercion.

### 2.2 Unknown field policy

- Major version 1 receivers may ignore **documented optional additions** where their validators are configured for forward compatibility, but existing Zod strict() usage may reject them: do not assume ignore-by-default.
- New required fields or changes to enum meaning are breaking unless dual-reader migration has been rolled out.
- Unknown enum variants map to an explicit `Unknown` representation **only if accepted contract allows it**; otherwise throw `UNSUPPORTED_TASK_KIND` rather than fake a prediction.
- Historical fixtures for v1/v2 coexist during migration. Writers use current schema, readers accept a constrained compatibility window, persistent records migrate through audited mechanism.

## 3. Candidate operation request envelope (after repository reconciliation)

The canonical ZIP already has a proposed worker envelope. HTTP job submission must NOT force public clients to provide the worker-only `workspaceId`/`requestId`, or expose Python output directories. HTTP-to-worker translation is a protected domain operation.

```json
{
  "operation": "vision.predict",
  "params": {
    "taskKind": "image.detection",
    "assetId": "asset_abcd",
    "modelId": "approved_model_rev1",
    "options": { "minScore": 0.45 }
  },
  "budget": { "maxSeconds": 120, "maxUsdMicro": 0, "maxTokens": 0 }
}
```

**Requested-shape rules:**
1. `params` is per-operation union, not arbitrary JSON long-term; images identified by scoped asset ID in HTTP; Python local accepts Path/bytes only in its separate in-process API.
2. `maxSeconds` 1..86400, `maxUsdMicro>=0`, `maxTokens>=0` inherited from proposed worker schema; API may enforce lower caps per role.
3. `taskKind` only for `vision.predict` (new optional in existing params if supported); retrieval may require different operation ID after model/IndexSnapshot schema analysis.
4. `modelId` must resolve to a locked revision at job acceptance; never float during run.
5. Server derives workspaceId, actor, policy scope; signs/validates artifact refs. Invalid job receives 422 `VALIDATION_ERROR`; not a Python traceback.

## 4. Candidate result discriminated union

Rather than embed all outputs in one generic `Prediction`, define task-aware payloads **only if existing Prediction schema is inadequate**. A possible `TaskPrediction` union:

```ts
// PROPOSED ONLY: coordinate, task and provenance semantics matter.
type TaskPrediction =
  | { taskKind: 'image.classification'; sampleId: string; classes: Array<{ labelId: string; rawScore: number; calibratedProbability: number | null }> }
  | { taskKind: 'image.detection'; sampleId: string; boxes: Array<{ labelId: string; xyxyPixels: [number,number,number,number]; rawScore: number }> }
  | { taskKind: 'image.ocr'; sampleId: string; regions: Array<{ xyxyPixels: [number,number,number,number]; textRaw: string; textNormalized: string | null }> }
  | { taskKind: 'video.counting'; clipId: string; events: Array<{ trackId: string; eventType: 'cross_in' | 'cross_out'; timestampMs: number }> }
  | { taskKind: 'image.ppe'; sampleId: string; observations: Array<{ equipment: string; state: 'present' | 'absent' | 'unobservable' }> }
  | { taskKind: 'image.retrieval'; queryAssetId: string; indexFingerprint: string; hits: Array<{ assetId: string; score: number }> }
  | { taskKind: 'image.matting'; sampleId: string; alphaMask: ArtifactRef }
  | { taskKind: 'image.medical_research'; sampleId: string; researchOnly: true; uncertainOrMissingLabels: string[]; predictions: unknown[] };
```

**Issue ledger before adoption:** task kind may be stored at run level rather than per prediction; retrieval is index operation, not a prediction; masks can have multiple geometry encodings; OCR boxes may need polygons/rotation; medical uncertainty may require multilabel mask. Refine based on actual Phase II output requirements and existing Zod. These examples capture non-negotiable semantics, **not final field names**.

### 4.1 Cross-language serialization

- Reject `NaN`, `Infinity`, `-Infinity` and unbounded floats in JSON; use `null`/typed error where metric uncomputable, with separate reason.
- Numeric floating point score is not calibrated probability. Do not clamp uncalibrated scores to [0,1] simply because JS UI assumes confidence.
- Preserve Unicode OCR literal; normalization policy with version and locale stored in provenance, never generic `.lower()` across all scripts.
- Videos timestamps as integer milliseconds relative to clip timeline, paired with frame/timebase metadata. Ensure JS safe integer range or `string` representation before shipping.
- Images EXIF applied consistently before bounding box axes; include oriented `width/height` and transformation fingerprint.
- Missingness is first-class: `unobservable` and `not_evaluated` cannot turn into `absent` or false.
- `ArtifactRef` returned with mediaType, digest, length and access tier; signed URL is an *access link*, not a stable artifact identity.

## 5. Capability negotiation schema (proposal)

Example response:

```json
{
  "data": {
    "apiVersion": "v1",
    "contractVersion": "1.0.0",
    "features": [{
      "taskKind": "image.classification",
      "supportedByCode": true,
      "installed": true,
      "runnableOnDevice": true,
      "allowedByPolicy": true,
      "device": "cpu",
      "reasonCode": null
    }]
  },
  "meta": { "requestId": "req_00" }
}
```

A remote backend should publish aggregate public capability availability for authorized actor, not raw worker PIDs, memory addresses, paths or installed secrets. Capabilities can change between check and execution; final authorization/admission happens at `POST /v1/jobs`, preventing time-of-check/time-of-use vulnerabilities.

## 6. Stable error-code catalog (candidate)

| Code | HTTP candidate | Retryable | Meaning/action |
|---|---|---|---|
| `VALIDATION_ERROR` | 422 | no | invalid request/schema/task params |
| `AUTHENTICATION_REQUIRED` | 401 | no | new/valid token required |
| `FORBIDDEN` | 403 | no | actor missing scope |
| `POLICY_APPROVAL_REQUIRED` | 403/409 | no | explicit human gate |
| `LICENSE_BLOCKED` | 403 | no | dataset/model rights disallow action |
| `DATA_EGRESS_FORBIDDEN` | 403 | no | remote provider prohibited |
| `NOT_FOUND` | 404 | no | missing or hidden scoped resource |
| `IDEMPOTENCY_CONFLICT` | 409 | no | same key, different effective payload |
| `JOB_NOT_READY` | 409 | later | result requested before terminal success |
| `VERSION_MISMATCH` | 426/409 | no | client/worker contract major incompatible |
| `MISSING_EXTRA` | 422/503 | no until installed | Python optional dependency absent |
| `UNSUPPORTED_DEVICE` | 422/503 | no | model impossible on hardware |
| `MODEL_UNAVAILABLE` | 503 | conditional | model not loaded/installed/eligible |
| `BUDGET_EXCEEDED` | 422/403 | no | hard cap from actor/job |
| `RATE_LIMITED` | 429 | yes with Retry-After | request quota |
| `RESOURCE_EXHAUSTED` | 503 | conditional | queue/GPU/memory capacity |
| `EVENT_CURSOR_EXPIRED` | 410 | no; poll | event log no longer replayable |
| `ARTIFACT_INTEGRITY_FAILED` | 500/422 | no | hash/length corruption |
| `INTERNAL_ERROR` | 500 | conditional | hide internal exception details |

**Candidate mappings, not final status contract.** Pick one status mapping per code in accepted ADR based on existing API conventions, document and test it. RFC9457 standard fields `type/title/status/detail/instance` plus typed extensions `code/requestId/retryable`. SDK error class resolution is by `code`, never by English `title`/`detail`.

## 7. Golden fixtures and cross-transport parity

Golden fixture must include:

1. `hello.worker.v1.json`: protocol negotiation (when handshake schema accepted).
2. `job-submit.vision-classification.v1.json` and 202 response.
3. `job-status.running.v1.json`, `job-status.succeeded.v1.json`, `job-status.failed.v1.json`.
4. `problem.validation.v1.json`, `problem.version-mismatch.v1.json`, `problem.idempotency-conflict.v1.json`.
5. `event.progress.v1.json`, `event.result.v1.json`, `event.error.v1.json` including seq/cursor.
6. `prediction.classification.v1.json`, `prediction.detection.v1.json`, `prediction.ocr.v1.json`, `prediction.video-count.v1.json`, `prediction.retrieval.v1.json`, `prediction.matting.v1.json` after accepted domain schema.
7. `artifact-ref.v1.json` and malicious variations (path traversal, nested metadata, huge array).
8. Fuzzed request JSON with invalid enum, `NaN` equivalent, enormous strings, oversized nested `params`, duplicate keys, unknown major.

### 7.1 Parity oracle

```text
Input: same immutable dataset/split digest, asset bytes, model weights,
       preprocess fingerprint, task/ontology revision, inference settings,
       evaluation suite digest, device profile where numeric equality expected.

Python.local -> canonicalize semantic result
Python.remote -> API -> job result -> canonicalize
TS.remote -> API -> job result -> canonicalize
CLI/MCP -> same domain execution -> canonicalize

Compare exact: IDs/fingerprints/dimensions/classes/schema/errors/provenance refs
Compare with tolerance: logits/probabilities/coords when device/backends vary
Exclude volatile: request ID, timestamps, duration, generated job ID, worker PID
```

A Python local run has its **own** run ID and maybe local artifact ID, so the exact-match set refers to stable input/model/suite and **semantic hash/asset content**, not literal server-generated run IDs. To compare local vs remote, seed fixture IDs or map volatile IDs to normalized refs. Do not hide meaningful differences by over-normalizing.

### 7.2 Metrics by CV family

| Task | Evaluation semantics | Common failure |
|---|---|---|
| Classification | macro F1, top1/topk, ECE/abstention | class imbalance, train/test leakage |
| Detection | AP/IoU, area, false positives | coordinate frame, NMS settings |
| OCR | CER, exact plate match where policy permits | Unicode normalization, regional format bias |
| Tracking/counting | HOTA/IDF1 where tracker GT, event MAE | re-identification/duplicated crossing |
| PPE | per-class detection + observable-state precision/recall | occluded gear marked absent |
| Retrieval | recall@k, mAP/nDCG by relevance labels | stale embeddings index vs encoder |
| Matting | alpha accuracy/gradient/edge metrics | binary mask compared against alpha GT |
| Medical research | AUROC/PR with patient-level split, uncertainty policy | clinical claims without external validation |

The API should never declare a 'best model' from incomparable `suite_digest`, ontology/split/provenance, or hardware profiles; same as Phase II Arena rules.

## 8. Version skew and migration tests

Test combinations: `{SDK N-1, API N}`, `{SDK N, API N-1}`, `{worker v1, app v1}`, `{worker v2, app v1}`, old persisted artifact consumed by new SDK, new unknown task consumed by old SDK. Expected behavior is **documented compatibility or explicit typed error**, never silent mutation. For breaking migration, readers first, writers second, then migration, then old-path deprecation.

## 9. Reference machine-readable artifacts included

`contracts-proposed/job-submit.v1.schema.json`, `job-resource.v1.schema.json`, `problem-details.v1.schema.json`, and `openapi.phase3.candidate.yaml` are **implementation aids**. They must validate with JSON Schema / YAML parser in this package, but they are NOT formally approved domain contracts, nor replacements for `worker-request.v1.schema.json` or the original OpenAPI snapshot. The published API must be generated from the implemented TS route/domain schema after reconciliation.

## 10. Definition of done de conformance

- Shared contract fixtures parse in TS and Python, reject invalid variants consistently.
- HTTP API and both remote clients agree on auth, job lifecycle, ProblemDetails, cursor/retry semantics, artifact reference format and operation enumeration.
- Python local and service ML logic share numerical code and protocol adapters, without separate label/metric semantics.
- License, approval and privacy policy are applied at the correct server boundary and are not bypassable through SDK convenience wrappers.
- A change to any public schema includes version effect, fixtures, generator diff and migration tests before release.
