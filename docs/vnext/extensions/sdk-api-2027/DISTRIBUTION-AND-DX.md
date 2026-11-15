# Distribution, Developer Experience & Release Engineering — Phase III

**Status:** specification / release plan, not evidence of a published package. **Date:** 2026-11-15. Builds on canonical `22-PUBLISHING-DEVELOPER-EXPERIENCE.md` and `ADR-012-dual-sdks.md` without replacing them.

## 1. Three independent release products; one compatibility promise

| Product | Candidate identifier | Primary audience | Artifact | Prerequisite to publish |
|---|---|---|---|---|
| Python library | PyPI `visionlens` (availability must be verified) | notebooks, Python apps, ML engineers | universal wheel + sdist, `py.typed` | CPU import/smoke, `vision` extra, license check |
| TypeScript SDK | npm `@vision-lens/sdk` (`./client` initially) | React/Next.js, Node, other JS runtimes | ESM + `.d.ts`, export map | browser/Node integration, root legacy compatibility |
| Backend API | self-hostable `apps/api` | all SDKs, CLI, external integrations | image or runnable distribution *later* | authentication, job consistency, media safety, observability, API schema |

Package versions, API versions, wire-contract versions and model revisions are **independent**. Do not derive server compatibility merely from semver of installed clients. Before registry publication verify name/scope ownership, distribution rights, license compatibility, malware/typosquatting concerns and valid repo metadata.

## 2. Minimal first-use journeys (future, once corresponding releases exist)

### Python (local, no Node)

```bash
python3.11 -m venv .venv && source .venv/bin/activate
python -m pip install 'visionlens[vision]'
python examples/python-local.py    # future API; requires approved local model fixture
```

### Python (HTTP, no heavy ML dependencies)

```bash
python -m pip install visionlens
export VISIONLENS_URL=https://<your-server>
export VISIONLENS_TOKEN=<scoped-token>
python examples/python-remote.py    # future API and server required
```

### TypeScript (web/Node HTTP, no Python dependency on client)

```bash
pnpm add @vision-lens/sdk
# import only '@vision-lens/sdk/client', not root legacy barrel
```

### HTTP (any programming language)

```bash
curl -sS "${VISIONLENS_URL}/v1/capabilities" -H "Authorization: Bearer ${VISIONLENS_TOKEN}"
# job create requires scoped asset ID and Idempotency-Key; consult API reference
```

**Do not copy placeholder commands into production setup as if packages were released.** A reproducible local demo must ship with a fixture, an approved downloadable model or an explicit model setup step, a pinned lock/constraints and an offline smoke path.

## 3. Python packaging and dependency isolation

- Python baseline **3.11** (per original spec), CI 3.11/3.12; add 3.13 only when all extras pass. `pyproject.toml` under `python/visionlens` uses PEP 621 metadata and version sourced once.
- Installation base: typed client (`httpx`, Pydantic models, lightweight config, error types), plus pure-stdlib local inspection when feasible. No mandatory `torch`, `transformers`, `opencv`, heavy native wheel, model weights or transitive GPU dependency.
- Extras by capability and release gating: `vision`, `detection`, `ocr`, `video`, `matting`, `train`, `agents`. Never publish broad `all` until platform compatibility is tested and dependency resolution is tractable. Use `importlib.util.find_spec`/guarded imports only at feature entry points, raising `MISSING_EXTRA` with exact install advice.
- Model artifact retrieval is opt-in, version and SHA-pinned, policy/egress controlled and license checked. Data-use rights for pretrained weights are independent of package license. `torch.load` of untrusted pickle must not be the default; prefer verified safer formats/loaders.
- `python -m build` or `uv build` -> check sdist/wheel contents and metadata -> install each from a clean venv -> `python -c "import visionlens"` with no CUDA/Python service credentials -> type-check `.pyi`/`py.typed` -> API smoke with fake server and local fixture.
- CI caches may accelerate tests, but clean consumer installs cannot rely on workspace internal imports or monorepo symlinks. Release artifact contains no `samples/` with private data, checkpoints, keys or mutable caches.

### Candidate `pyproject.toml` metadata (adapt after repo inspection)

```toml
[build-system]
requires = ["hatchling>=1.25,<2"]
build-backend = "hatchling.build"

[project]
name = "visionlens" # tentative; verify ownership
version = "0.1.0" # proposal, not existing published version
requires-python = ">=3.11"
dependencies = ["httpx>=0.27,<1", "pydantic>=2,<3"]

[project.optional-dependencies]
vision = ["torch>=2", "pillow>=10", "numpy>=1.26"]
detection = ["visionlens[vision]"] # add verified adapter dependencies after license check
ocr = ["visionlens[vision]"]
video = ["visionlens[vision]"]
matting = ["visionlens[vision]"]
train = ["visionlens[vision]"]

[tool.hatch.build.targets.wheel]
packages = ["src/visionlens"]
```

The precise dependency pins above are **illustrative**, not claims that all ML backends support every OS/Python combination; production metadata must derive from reproducible lock matrices. `visionlens[vision]` self-references in extras are allowed by current Python packaging specifications, but verify the wheel resolver behavior on all target installers.

## 4. TypeScript distribution and dual entry points

- Preserve existing `@vision-lens/sdk` root exports for compatibility; `/client` is fetch-only, ESM and browser-safe; `/node` is optional Node-only; `/legacy` re-exports old functions with tests before deprecation.
- Explicit `exports` map with `types`, `import`, declared `files` allowlist, `sideEffects` value carefully audited, `engines` only after runtime tests. Never let `/client` accidentally import native `sharp`, `node:fs`, `node:child_process`, direct SQLite or developer credentials.
- `pnpm pack` with package unpack inspection. Smoke `node --input-type=module` and a bundled browser/edge consumer. `tsc --noEmit` type tests, API contract fixtures and abort/retry tests. Avoid compatibility claims for Edge platforms where streaming/connection semantics differ until tested.
- `@vision-lens/react` is optional Phase III+ DX: hooks can live as separate package later and must not become runtime SDK dependency.

## 5. OpenAPI + SDK docs pipeline

```text
accepted TS Zod routes/domains + tests
    │
    ├─> exported JSON Schema and fixtures (versioned)
    └─> OpenAPI document (generated from real Fastify route wiring)
            ├─> checked TS HTTP types or client helper generation
            ├─> Python remote typed request/response validators
            ├─> API reference / examples / code snippets
            └─> compatibility diff + consumer smoke matrix
```

- Ship openapi.json only after the backend implementation produces it. The `contracts-proposed/` documents here are candidate design inputs, **not** authoritative generated OpenAPI.
- Contract drift gate flags removed/changed fields, incompatible enum expansion, new required fields, changed status/error semantics, default behavior, auth scopes and paths. Classify schema-compatible but semantically breaking changes manually (e.g. bbox units).
- `x-codeSamples`, examples and markdown must be generated or checked against a live contract fixture. Documentation examples should fail CI if they call nonexistent routes.

## 6. Release CI stages (proposed)

1. **Source gate:** formatting, lint, secrets scan, dependency resolution, SCA and model/dataset license inventory.
2. **Unit gate:** TS core, Python standalone and SDK isolated tests. Python import without `torch` and `node` is a hard acceptance test.
3. **Contract gate:** JSON Schema + golden fixtures in both languages; Fastify `inject()` for every MVP route; OpenAPI diff from accepted snapshot.
4. **Integration gate:** ephemeral API + fake worker + SQLite + CAS for reliable deterministic tests; one genuine CPU CV fixture separate from mock tests.
5. **Resilience gate:** worker crash, post-commit crash, idempotency conflict, cursor replay, unreadable artifact, 429/503, cancellation and migration smoke.
6. **Consumer gate:** install wheel/sdist and `.tgz` into clean separate apps; Python 3.11/3.12, Node version chosen by Fastify and npm publishing, Chromium-compatible browser bundle smoke.
7. **Security gate:** local loopback auth, SSRF/path traversal/media bombs, scope enumeration, secret redaction, model download allowlist, provenance/SBOM.
8. **Publish gate:** manual review of changelog, SemVer, sample outputs, license/SPDX, docs, OIDC trusted publisher config and prerelease channel. Release from protected tag/environment only.
9. **Postpublish verification:** independently install exact published versions, verify metadata/signatures/provenance where available, import/smoke from external consumers and rollback via deprecation/patch, not by silently mutating artifacts.

PyPI's Trusted Publishing and npm Trusted Publishers both support OIDC-based CI publishing. Current npm documentation requires npm CLI >=11.5.1 and Node >=22.14.0 for OIDC; **publishing workflow runtime** can be stricter than supported SDK consumer runtime. Public npm provenance generation additionally has documented prerequisites; do not promise it on private repos. Pin action versions by reviewed commit digest in production CI, after checking current releases.

## 7. API service shipping profiles

| Profile | Realization | Constraints |
|---|---|---|
| `local` | Fastify bind `127.0.0.1`; SQLite+CAS; one supervised Python worker | local session token, no publicly exposed port, single writer |
| `demo` | HTTPS API; read-only fixture-first; per-IP/account caps; precomputed heavy outputs | no arbitrary model URLs, no hidden cloud costs |
| `self-hosted` | external auth, backup/restore, quota, metrics, owner-scoped workspaces | team mode only after tenancy design and threat model |
| `gpu` (deferred) | private authenticated scheduler + CUDA worker pool | require telemetry and delivery/business justification |

Never treat “container runs” as adequate for production safety; set kernel/OS resource controls, filesystem policies, execution limits, secret scoping and incident runbooks before internet exposure.

## 8. Docs & DevRel release artifacts

Release documentation must provide Quickstart Python local, Quickstart Python remote, Quickstart TypeScript, HTTP/cURL, an offline demo, task-specific guides for Phase II labs 09–16, error guide, hardware matrix, model/data rights, privacy posture, performance methodology, reproducibility manifest, upgrade guide, changelog and troubleshooting (`vision-lens doctor`).

Each sample has a truth status label: `runnable in released version`, `runnable after fixture setup`, or `proposed API`. Avoid screenshots and numbers claiming measured ML accuracy/latency until benchmark conditions, datasets, model hashes, sample counts and hardware are published.

## 9. Verification sources (checked 2026-11-15)

- PyPA packaging project metadata and extras: https://packaging.python.org/en/latest/guides/writing-pyproject-toml/
- PyPI OIDC trusted publishing: https://docs.pypi.org/trusted-publishers/
- npm trusted publishing requirements/provenance: https://docs.npmjs.com/trusted-publishers/
- Fastify v5 Node runtime and route schemas: https://fastify.dev/docs/latest/Guides/Migration-Guide-V5/
- OpenAPI version index and schema dialects: https://spec.openapis.org/oas/
