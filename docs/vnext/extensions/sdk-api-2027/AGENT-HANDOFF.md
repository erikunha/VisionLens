# VisionLens Phase III — Handoff para Claude Code / Codex

> **Status:** prompt de implementação sobre o repositório REAL. Este documento não afirma que SDKs ou endpoints estão prontos. Importar junto com canonical spec e Phase II, preservando as fontes e trabalho existente.

## Prompt mestre para executar no diretório do repositório

Você é o lead engineer encarregado de transformar o VisionLens em uma plataforma integrável em três interfaces: Python SDK (local + HTTP sync/async), TypeScript SDK (HTTP browser/Node + Node local opt-in) e Backend Fastify `/v1`. Seu objetivo principal é uma vertical executável, correta, reprodutível e testada; não “gerar muito código”.

**Leia obrigatoriamente, nesta ordem:**

1. `VisionLens_2027_Canonical_Spec/00-ADOPTION-NO-OVERWRITE.md`, `01-REPO-STATE-2026-11-11.md`, `02-ARCHITECTURE-DECISION.md`, `05-PYTHON-CORE-AND-PYPI.md`, `06-NPM-SDK-CLI-COMPATIBILITY.md`, `07-CONTRACTS-PROTOCOL.md`, `18-FASTIFY-API-AUTH-DEPLOY.md`, `21-TEST-AND-QUALITY-PLAN.md`, `adrs/ADR-011..018` e `AGENTS-HANDOFF.md`.
2. Phase II `extensions/computer-vision-2027/README.md`, `ARCHITECTURE-ADDENDUM.md`, `LABS-09-16.md`, `EXECUTION-PLAN.md` e `AGENT-HANDOFF.md`.
3. Phase III `extensions/sdk-api-2027/README.md`, `MASTER-SPEC.md`, `PYTHON-SDK.md`, `TYPESCRIPT-SDK.md`, `BACKEND-API.md`, `CONTRACTS-AND-CONFORMANCE.md`, `IMPLEMENTATION-PLAN.md`, `SECURITY-THREAT-MODEL.md`, `adrs/*.md`, `contracts-proposed/README.md` e `backlog.csv`.
4. Repositório atual: `git status`, `git log`, `package.json`, monorepo graph, `packages/contracts`, `packages/core`, `packages/sdk`, `apps/api`, CLI, Python services, scripts, CI, migrations, tests, assets. **A realidade atual e o trabalho não commitado têm precedência.**

**Regras invioláveis:**

- Nunca sobrescreva mudanças do usuário, migrations, schemas ou OpenAPI existente só porque um arquivo deste ZIP propõe outro contrato. Propostas em `contracts-proposed/` são exemplos, não fonte de verdade.
- Python é autoridade ML; não reimplemente classificação, detecção, OCR, métricas ou treino em TypeScript para satisfazer o SDK. TS é domínio gerenciado, single-writer store, orquestração, API e UX. Python standalone não grava SQLite TS.
- Preserve os exports npm root e aliases CLI legados. Adicione primeiro `/client`. `/node` é uma camada opcional; não entra no bundle browser.
- Construa uma única operação completa (`vision.predict`/classificação CPU) antes de adicionar todas as tasks 09–16. Se o contrato atual não admite `taskKind`, escreva ADR + migração leitores-antes-de-escritores.
- Asserte direitos/licenças de modelos/datasets; no automatic network/weights download; nenhuma PHI/PII real em fixtures. Lab 16 pesquisa, nunca diagnóstico.
- HTTP managed exige auth, scoped resource access, budgets, idempotency, durable 202, SSE cursor replay, cancel e artifact hash. Worker JSONL v1 faz handshake e não recebe shell strings ou paths arbitrários. Erros tipados e sanitizados.
- Nunca apresente code generation, typing, unit test mock ou API snapshot como prova de inferência real e publicada. Afirmar status apenas quando comprovado por comandos executados e artefatos gerados.

## Etapa 0 — Reconciliar (sem escrever código de produto)

Produza tabela no repositório `docs/visionlens-adoption/P3-reconciliation.md`: `{Requirement, original spec source, actual implementation path/hash, current behavior, KEEP|AMEND|DEFER|CONFLICT, risk, test, migration, rollback}`. Descubra e execute somente os testes existentes relevantes. Examine também `git diff` e dependências; não descarte trabalho local.

Compare explicitamente:

- `@vision-lens/sdk` root exports, package version, client existing, browser imports, `/node`, `legacy`, docs e bin aliases.
- `packages/contracts` Zod classes, generated OpenAPI pipeline, enum/task kinds, predictions vs annotations, worker envelope major, domain store migrations.
- `apps/api` placeholder vs any implementation new since snapshot; `packages/core` store ownership, event log, CAS and auth primitives.
- `python/visionlens` and `services/{vision,training,agents}` structure, current pyproject and Python version requirements.
- Phase II code already implemented by other agents, model registry/adapters, device matrix and license catalog.

Ask for approval only if change is destructive, paid, externally published or fundamentally changes contract ownership; proceed with small reversible additive PRs under existing authorization.

## Etapa 1 — Escolher vertical and contracts

Prioritize `VLSDK-001..015`. Freeze synthetic/authorized CPU classification fixture; exact input hash, model revision and preprocessing fingerprint. Define one `vision.predict` canonical semantic output, plus job/provenance/artifact ref. Decide API status semantics and ProblemDetails after checking existing public error handling. Generate OpenAPI **from actual accepted routes**, not by copying `openapi.phase3.candidate.yaml`. Cross-language fixtures must be accepted by Zod and Pydantic/TypeAdapter, with malformed input rejected.

## Etapa 2 — Python local package

Implement `VLSDK-005..010` as additive modules. Test `python -c "import visionlens"` with only base dependencies, no Node/Torch, no network; small CPU deterministic fixture under `[vision]`; immutable local manifest and digest; typed MissingExtra/UnsupportedDevice/LicenseBlocked errors; local contextual resource budget. Python standalone may use Python manifest/CAS, but **not TS SQLite**. Avoid importing GPU/tensor libs until a task is invoked. Build wheel and sdist from clean venv.

## Etapa 3 — Fastify managed API

Implement `VLSDK-016..025`: DI `buildApp()` with `fastify.inject()` tests; loopback auth; assets staging/CAS; transactional `POST /v1/jobs` + idempotency; persistent queue/lease; fixed-command Python supervisor; JSONL v1 handshake/schema; bounded frame/timeout; persistent events; `GET .../events` SSE replay; `cancel` semantics; artifact metadata/download; typed problem errors; tracing. The first true end-to-end path is *same CPU fixture* through the API. Inject worker crash, server crash after CAS write and before commit, SSE reconnect and concurrent duplicate POST.

## Etapa 4 — Remote SDKs, no drift

Implement `VLSDK-026..032`: Python `VisionLensClient` and `AsyncVisionLensClient` (`httpx`), browser-safe TS `VisionLensClient` in `@vision-lens/sdk/client`, shared conformance fixtures, backoff only idempotent requests, `Retry-After`, AbortSignal/cancel-wait semantics, typed errors, token redaction, SSE parser with Last-Event-ID. Preserve root legacy export snapshots. Test consumer install outside monorepo. Node local bridge is later `VLSDK-033` after supervisor stable.

## Etapa 5 — Expansion, operational and release gates

Implement `VLSDK-034..040`; demand real sample data rights, model weights license, locked evaluation split and validity of metrics. Publish package artifacts only under an explicitly approved protected release workflow. OIDC trusted publishers for PyPI/npm are proposed, do not create public project/account or expose service without user authorization.

## Required final report for every PR

1. Scope and why this PR exists (ticket IDs).
2. Files inspected and changed; changes preserved; diagrams/ADRs if contract affected.
3. Commands actually executed and results (green/red), unit/integration/security/consumer smoke vs not executed.
4. Python ↔ TS ↔ HTTP contract diffs and golden conformance evidence; artifact/model fingerprints.
5. Performance numbers only with hardware, sample counts, warmup, method, model/pipeline revision and caveats.
6. Known gaps, risks, reversible rollback and next bounded PR.

**Stop conditions:** unknown current repo state, detected contract break without migration, unsafe auth/exposure, privileged agent action without approval, unlicensed model distribution, unsupported platform falsely advertised, medical diagnosis surface, broken tests not isolated.

**Critical first action:** inspect repo then produce reconciliation matrix, not generate a new parallel scaffold or rewrite.
