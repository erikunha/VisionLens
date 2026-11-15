# VisionLens — Phase III: Dual SDKs + Backend API (2027+)

**Data:** 2026-11-15. **Status:** especificação técnica proposta, não código implementado. **Público:** solo founder, engenheiros/agents Python/TypeScript, integradores de API, DevRel, Applied AI/CV. **Escopo:** complementa a especificação canônica de 2026-11-11 e a Phase II de visão computacional de 2026-11-15.

## Resultado de produto

O VisionLens será consumível por três canais públicos equivalentes no domínio, mas **não** necessariamente idênticos na forma de execução:

1. `visionlens` (PyPI, nome a verificar): **Python SDK in-process** independente de Node e **Python SDK HTTP** síncrono/assíncrono. Operações locais pesadas somente com extras e hardware explicitamente compatíveis.
2. `@vision-lens/sdk` (npm, existência/publicação a verificar): **cliente TypeScript HTTP** universal (browser/Node), sem dependências ML; **adaptador Node local** opcional usando o worker Python e compatibilidade preservada com os exports atuais de `@vision-lens/sdk`.
3. `apps/api` (Fastify): **HTTP REST `/v1`**, ingestão de assets, jobs duráveis, SSE, model registry, datasets, evaluation, artifacts e permissões, servido sobre a mesma camada de domínio TypeScript e Python ML runtime.

**Não construir três engines de machine learning.** Python é o dono dos algoritmos CV; TypeScript é o dono do domínio TS, orchestration API, store existente e DX JS. O wire contract é único. Os consumidores obtêm o mesmo resultado semântico quando executam o mesmo `snapshot/model/preprocess/config/suite`, mas cada modo possui limites de IO, segurança e runtime próprios.

## Compatibilidade com o material já recebido

| Origem | Ponto obrigatório preservado | Phase III acrescenta |
|---|---|---|
| `02-ARCHITECTURE-DECISION.md` | Python-first ML; TS-first platform; sem big-bang rewrite | arquitetura de *três produtos*, seis caminhos de execução, ownership |
| `05-PYTHON-CORE-AND-PYPI.md` e `VLN-003` | pacote Python importável sem Node/GPU | API local + remoto, sync/async, lifecycle, extensibilidade, distribuição |
| `06-NPM-SDK-CLI-COMPATIBILITY.md` e `VLN-010` | preservar root/legacy; `/client` leve | Node local explícito, browser/Edge, packaging, erros e eventos |
| `07-CONTRACTS-PROTOCOL.md` | Zod implementado e JSONL v1 são fonte existente | catálogo detalhado de schemas, OpenAPI derivado, compatibilidade e conformidade |
| `18-FASTIFY-API-AUTH-DEPLOY.md` | API ainda placeholder no snapshot | superfície `/v1`, ingest, auth, lifecycle jobs, observabilidade, deployment |
| Phase II `ARCHITECTURE-ADDENDUM.md` | capability packs 09–16; `vision.predict` | matriz de suporte por SDK, geometrias/temporalidade, flows end-to-end |

**Fonte de verdade: repositório de trabalho real > branch atual > este suplemento.** Nenhum diretório, endpoint, pacote, nome PyPI, desempenho, hardware, release ou licença é apresentado como implementado/publicado. Os schemas e exemplos são *candidatos*: não os copiar por cima de `packages/contracts` ou `openapi.snapshot.json`.

## Mapa de arquivos

**Documento integral:** [VISIONLENS_PHASE_III_FULL.md](VISIONLENS_PHASE_III_FULL.md) reúne o projeto técnico em um único Markdown (proposta, não implementação).

| Documento | Uso |
|---|---|
| [MASTER-SPEC.md](MASTER-SPEC.md) | decisões, modos de uso, arquitetura em camadas, invariantes e roadmap executivo |
| [PYTHON-SDK.md](PYTHON-SDK.md) | API Python local/remote/async, tipos, adapters CV, wheel, exemplos, testes |
| [TYPESCRIPT-SDK.md](TYPESCRIPT-SDK.md) | API npm browser/Node/local, compatibilidade, streams, build, testes |
| [BACKEND-API.md](BACKEND-API.md) | endpoints Fastify, jobs, upload, auth, worker, filas, deployment, segurança |
| [CONTRACTS-AND-CONFORMANCE.md](CONTRACTS-AND-CONFORMANCE.md) | schemas, semântica, fingerprint, error taxonomy, parity matrix |
| [DISTRIBUTION-AND-DX.md](DISTRIBUTION-AND-DX.md) | PyPI/npm, CI/CD, documentação, semver, adoção, benchmark, release gates |
| [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md) | milestones, dependências, 40 tickets `VLSDK-*`, DoD e ordem de implementação |
| [AGENT-HANDOFF.md](AGENT-HANDOFF.md) | prompt pronto para Claude Code/Codex reconciliar antes de implementar |
| [SECURITY-THREAT-MODEL.md](SECURITY-THREAT-MODEL.md) | fronteiras de confiança, abuso e controles de PII/PHI/modelos |
| [SOURCES.md](SOURCES.md) | referências normativas e documentação oficial consultada |
| `adrs/` | cinco ADRs propostos (P3-001 a P3-005), nenhum aceita sem revisão |
| `contracts-proposed/` | tipos OpenAPI/JSON Schema de proposta, não código para substituir contratos existentes |
| `examples/` | esboços de consumo Python/TypeScript/cURL, explicitamente não executáveis contra o snapshot atual |
| `specs/` | primeiros tickets com aceites implementáveis |
| `backlog.csv` | plano granular para ingestion por agentes/Linear/GitHub |
| `validation/` | integridade interna do pacote, não testes do repositório |

## Como adicionar ao ZIP/repositório

Extraia este diretório sob `docs/vnext/extensions/sdk-api-2027/` **somente após comparar com docs existentes**. Recomenda-se importar o ZIP combinado **apenas para leitura** e usar o `AGENT-HANDOFF.md` como instrução de execução. Não sobrescrever schemas, specs nem `MANIFEST.sha256` históricos.

## Fora de escopo explícito

Sem SaaS multitenant, cobrança, WebRTC em tempo real, marketplace de modelos, APIs públicas de diagnóstico médico, processamento silencioso de dados privados, Kubernetes/distributed inference sem evidência, plug-ins não confiáveis que executam código arbitrário, sincronização bidirecional automática entre lojas locais independentes.
