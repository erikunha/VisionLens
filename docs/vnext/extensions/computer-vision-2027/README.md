# VisionLens — Phase II: Computer Vision Capability Packs (2027+)

**Preparado em:** 2026-11-15  
**Status:** proposta complementar para avaliação/adoção; **não representa funcionalidades implementadas, PRs abertos ou testes executados no repositório**.  
**Base analisada:** `VisionLens (1).zip` → `VisionLens_2027_Canonical_Spec/`, versão 2026-11-11.

Este pacote incorpora a lista de exercícios de visão computacional **9–16** (PyTorch/transfer learning, YOLO, OCR de placas, contagem de pessoas, máscara/EPI, busca visual, remoção de fundo e radiografias) e amplia o roteiro para visão multimodal, vídeo, grounding, segmentação, inspeção, anomalias e avaliação científica.

## Documentos

1. [MASTER-SPEC.md](MASTER-SPEC.md) — tese, estratégia, arquitetura, extensões de domínio, métricas, roadmap e gates.
2. [LABS-09-16.md](LABS-09-16.md) — requisitos implementáveis de cada um dos oito laboratórios, com hipóteses, dados, pipelines, benchmarks e DoD.
3. [RESEARCH-RADAR-2027.md](RESEARCH-RADAR-2027.md) — pesquisa de modelos/técnicas, apostas e armadilhas.
4. [DATA-MODEL-LICENSES.md](DATA-MODEL-LICENSES.md) — matriz de fontes/datasets/modelos, licenças, dados pessoais e decisões de publicação.
5. [ARCHITECTURE-ADDENDUM.md](ARCHITECTURE-ADDENDUM.md) — proposta de extensão compatível, sem editar os contratos/ADRs existentes.
6. [EXECUTION-PLAN.md](EXECUTION-PLAN.md) — prioridades, dependências, milestones, kill gates e integração com R0–R9.
7. [AGENT-HANDOFF.md](AGENT-HANDOFF.md) — instrução pronta para Claude Code/Codex trabalhar sobre o repositório real.
8. [SOURCES.md](SOURCES.md) — fontes primárias, links e notas de confiança.
9. `backlog.csv` — tickets `VLCV-*` priorizados, adicionados sem reutilizar os `VLN-*` já existentes.
10. `specs/` — primeiras quatro especificações para execução.
11. `contracts-proposed/` — contrato ilustrativo **não aprovado**; não substitui Zod, SQLite, JSONL nem OpenAPI.

## Regras de integração

- Ler antes o `00-ADOPTION-NO-OVERWRITE.md`, o `01-REPO-STATE-2026-11-11.md`, `02-ARCHITECTURE-DECISION.md` e `23-RELEASE-ROADMAP.md` do pacote original.
- Estado do working tree local e contratos implementados prevalecem sobre hipóteses deste suplemento.
- Preservar **todos** os arquivos originais. Este add-on não altera o `MANIFEST.sha256` canônico, specs `VLN-001..012`, ADRs existentes ou a avaliação VisA.
- O principal bloqueio científico do baseline continua sendo construir splits de verdade e avaliações locked holdout; Phase II **não contorna** R0, R1, R2 e R4.
- Nenhum modelo/dataset é baixado, executado ou redistribuído neste pacote. URLs foram pesquisadas em 2026-11-15; licenças devem ser reconfirmadas na revisão de aquisição e na publicação.
- Exemplo executável mais atraente: **Oxford-IIIT Pet** compartilhado entre classificação, retrieval e segmentação, sujeito a política de licenciamento e integridade dos splits.

## Como adotar

1. Extrair este add-on dentro de `docs/vnext/extensions/computer-vision-2027/` **após inspecionar mudanças locais**, mantendo o conteúdo como documentação proposta.
2. Fazer uma reconciliação `KEEP/AMEND/DEFER/CONFLICT` no repo real.
3. Aceitar explicitamente a decisão de capability packs e quais contratos merecem ADR.
4. Liberar apenas `VLCV-001` após o baseline do roadmap canônico; avançar por gates, não por volume de features.

**Nota sobre os ZIPs:** existe um ZIP somente deste suplemento e um ZIP combinado, que mantém os 65 arquivos originais byte a byte e acrescenta este material em `extensions/`.
