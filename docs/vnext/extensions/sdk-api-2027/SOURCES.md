# Fontes, evidências e limitações — VisionLens Phase III

**Data da checagem externa:** 2026-11-15. Este suplemento contém design técnico proposto. Uma URL oficial citada fundamenta uma capacidade de *framework/standard*, não comprova que o VisionLens implementou a funcionalidade.

## Materiais internos inspecionados

| Evidência | Conclusão limitada |
|---|---|
| `VisionLens (1).zip` — `VisionLens_2027_Canonical_Spec` (65 arquivos, snapshot 2026-11-11) | Python-first CV, TS application/domain ownership, worker JSONL v1, Zod, proposed contracts, `apps/api` placeholder, dual SDK already proposed |
| `VisionLens_2027_Expanded_Phase_II.zip` (Phase II aditiva, 09–16) | Capability packs task-aware, proveniência, avaliação, direitos/licenças, roadmap CV; não prova código implementado |
| canonical `05-PYTHON-CORE-AND-PYPI.md` | Python >=3.11 e um pacote PyPI `visionlens` candidato; `services` devem ser preservados até migração incremental |
| canonical `06-NPM-SDK-CLI-COMPATIBILITY.md` | root npm SDK existente no branch histórico reexportava legado; não presumir mesma situação no branch atual |
| canonical `07-CONTRACTS-PROTOCOL.md`, JSON Schemas worker propostos | JSONL v1 e `contractVersion` são candidatos explícitos; scripts não podem alterar suas semânticas sem reconciliation |
| canonical `18-FASTIFY-API-AUTH-DEPLOY.md` | `apps/api` descrito como placeholder na fotografia 2026-11-11; rotas deste suplemento não são APIs verificadas |

O repositório de trabalho **não** foi inspecionado por este pacote; antes de codificar, verificar `HEAD`, alterações não commitadas, versões efetivas e branches. Arquivos do ZIP não são evidência de status atual em 2027.

## Referências primárias de tecnologia / padrões

1. Fastify v5 migration (Node.js 20+, full JSON schemas): https://fastify.dev/docs/latest/Guides/Migration-Guide-V5/
2. Fastify validation & serialization warning for user schemas: https://fastify.dev/docs/v5.8.x/Reference/Validation-and-Serialization/
3. PyPA `pyproject.toml` metadata and optional dependencies: https://packaging.python.org/en/latest/guides/writing-pyproject-toml/
4. PyPI Trusted Publishing (OIDC): https://docs.pypi.org/trusted-publishers/
5. npm Trusted Publishing (OIDC, npm CLI/Node CI minimum, provenance conditions): https://docs.npmjs.com/trusted-publishers/
6. OpenAPI version index (3.1 and 3.2 supported as separate specifications): https://spec.openapis.org/oas/
7. RFC 9457 `application/problem+json`: https://www.rfc-editor.org/rfc/rfc9457
8. JSON Schema draft 2020-12: https://json-schema.org/draft/2020-12
9. Pydantic v2 TypeAdapter API: https://docs.pydantic.dev/latest/api/type_adapter/
10. HTTPX async, clients and streaming: https://www.python-httpx.org/async/
11. MDN Server-sent events and reconnection: https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events
12. OWASP API Security Top 10 2023: https://owasp.org/API-Security/editions/2023/en/0x11-t10/
13. OpenTelemetry semantic conventions: https://opentelemetry.io/docs/specs/semconv/
14. SPDX license list: https://spdx.org/licenses/
15. PyTorch MPS backend: https://docs.pytorch.org/docs/stable/notes/mps.html

## Ambiguidade tecnológica registrada

- **OAS 3.1 como baseline candidata**, não “última versão”: o índice oficial inclui OAS 3.2. Fixar 3.1 durante a primeira API se geradores, Fastify/Swagger e clientes forem testados com 3.1; avaliar migração 3.2 depois de CI.
- **Fastify v5 Node >=20** não equivale a Node de publicação npm OIDC; configure runtime de CI do publish conforme exigência vigente de npm.
- O Fastify normalmente valida/serializa por JSON Schema Draft 7 com Ajv por padrão; um contrato OpenAPI 3.1 / JSON Schema Draft 2020-12 **não pode ser presumido plug-and-play como schema de rota**. É necessário conversão/dialeto aceito, testes e ADR de geração/validação.
- Schemas propostos podem divergir de Zod implementado; após reconciliação, os gerados substituem *apenas* os artefatos do repositório com PR/migration explícitos.
- Python ML extra/platform compatibility e licenças de pesos e datasets são verificações por versão/modelo, não garantias estabelecidas por docs de PyTorch ou pelos pacotes.
