# Phase II — Execution, sequencing and gates

**Orientação:** trabalho de capacidade nova **em paralelo controlado** ao plano R0–R9 canônico; não redefinir marcos como feitos. `VLN-001..012` do ZIP original prevalecem como prioridades do núcleo até que o repo real prove avanço. IDs novos prefixados `VLCV`.

## 1. Sequenciamento recomendado

### Gate zero — reconciliação, data rights e contrato

Não iniciar trabalho de modelo pesado sem:

- Branch/worktree e diffs reais registrados, testes executados ou falhas evidenciadas (`00-ADOPTION-NO-OVERWRITE.md`).
- `VLN-007` ou equivalente: split VisA auditado, sem avaliação chamada holdout com partição all-train.
- Pacote Python e JSONL bridge mínimo (`VLN-003..006` ou implementação equivalente do repo real) para não gerar código isolado de plataforma.
- Test suite de avaliação com ground truth separado e código de erro explícito quando não comparável.
- `Dataset/ModelLicenseRecord` com revisão humana e política de publicação definida; dados não baixados automaticamente.

### CV0 — primeiro PR: preparação da task suite

**Tickets:** `VLCV-001` (reconciliation), `VLCV-002` (data/license governance), `VLCV-003` (task contract audit), `VLCV-004` (Oxford Pets manifest). **Output:** uma fixture licenciada, não dataset inteiro. Um `TaskEvaluationSuite` demonstrável sem migração de DB.

**Definition of Done:** audit document com paths e SHAs, descrição de compatibilidade, spec aceita, nenhum arquivo canônico antigo reescrito, teste com fixture local e licença revisada.

### CV1 — primeiro vertical slice interconectado

**Tickets:** `VLCV-005..013`. **Labs:** 09, 14, 15. Começar 09 baseline `frozen embedding + linear probe`, usar mesmo backbone para 14 retrieval, adicionar 15 com máscara/trimap (sem confundir matting). Fazer 3 painéis em uma tela, não 3 apps. Entrypoints Python + CLI/worker + Studio read-only. Registrar notebooks exploratórios como artefatos, não criar produto de notebooks isolado.

**DoD de release:** (1) snapshot com treino/val/test e IDs disjuntos; (2) classification F1; (3) retrieval Recall@k; (4) segmentation/mask mIoU; (5) timestamp e modelo fingerprint em todos os resultados; (6) medição p95/RAM no hardware real, ou estado `NOT_MEASURED`; (7) limite explícito do experimento no README; (8) endpoints externos ainda opt-in.

### CV2 — object-centric intelligence

**Tickets:** `VLCV-014..020`. **Labs:** 10 e 13. RT-DETR primeiro se licença/weights forem mais simples que YOLO; YOLO entra com gate AGPL/Enterprise. Construir import COCO de boxes reais, AP, error slices e PPE ternário; `not observable` e *review* não são opcionais para EPI.

**DoD:** two-backend comparison real ou um backend + comparador indisponível explicitamente; AP/recall por classe; classes de oclusão; licença de todos os pesos/dados; PPE sem compliance claims.

### CV3 — video/event/OCR

**Tickets:** `VLCV-021..027`. **Labs:** 12 e 11. Timestamps, track event engine determinístico e OCR region pipeline. Priorizar contagem de objetos em vídeo com clips próprios antes de contar pessoas. ALPR fica synthetic-by-default, research-only com dados reais.

**DoD:** contagem por eventos com teste sem duplicações; vídeo offline e política de retenção; OCR exact/CER incluindo misses; sem identificadores em logs.

### CV4 — research frontier

**Tickets:** `VLCV-028..033`. **Labs:** 16 e capacidades experimentais. Include open-vocabulary and video segmentation, temporal RAG, defect/anomaly, data-centric synthetic, edge on target devices. Health lab requer DUA/ética, isolated research. Foco comercial só após pilotos.

**DoD:** pelo menos um experimento com hipótese falsificável e controle; risco e custo quantificados ou rotulados `unknown`; decisão `PROMOTE/ITERATE/STOP` baseada em benchmark real.

## 2. Matriz de prioridade e trade-offs

| Pack | Aprendizado técnico | Dependência infra | Risco de direitos/segurança | Demo pública | Recomendação |
|---|---|---|---|---|---|
| 09 classificação | treino, transfer, calibração | média | baixo/moderado | muito boa | **começar** |
| 14 retrieval | embeddings, ANN, relevância | média | baixo/moderado | excelente | **começar** |
| 15 background | segment, matte, asset handling | média | médio (weights/dados) | excelente | primeira sequência |
| 10 detection | geometry, COCO AP, backends | média/alta | médio (AGPL/dados) | boa | segunda sequência |
| 13 PPE | association, safety-aware CV | alta | alto (FP/FN/pessoas) | limitada | pesquisa aplicada após detector |
| 12 video count | state, tracking, temporal | alta | moderado/alto | com clip consentido | após detector |
| 11 plates OCR | localization, OCR, normalization | alta | alto (PII/restrição UFPR) | somente sintético | adiar |
| 16 raio-X | medical data/eval, cohort shift | muito alta | **crítico** | não com dados sensíveis | pesquisa restrita; não MVP |

**A escolha da ordem tem justificativa:** 09/14/15 reutilizam uma base real e recursos da arquitetura do ZIP; 10 habilita 12/13; 11 e 16 têm atrito legal e pouca vantagem estratégica como demonstração comercial inicial.

## 3. Capacidade de computação e orçamentação (orientação, não estimativas medidas)

- Tier L: CPU-only local fixtures, tarefas de validação, pHash, probes simples, comparação de schemas — devem rodar na CI e sem downloads grandes.
- Tier M: Apple MPS ou CPU maior para embeddings e segmentation com orçamento explícito de minutos, RAM e disk; testar compatibilidade das ops reais.
- Tier H: GPU CUDA para treinamento e SAM3.1, somente research worker isolado. A instalação padrão não deve depender desse tier.
- Tier X: API/VLM paga com BYOK e approval gate, limite monetário e token budget. `maxUsdMicro=0` em fixtures/CI.

Backlogs estimam **tamanho relativo** (`S/M/L`) e dependência, não duração/velocidade fictícia.

## 4. Modelo de entrega de PR

Cada PR:

1. **problema e prova** de que não existe solução no repo local;
2. **contrato** e migration decision (nonbreaking / breaking + ADR);
3. **experimento/scientific baseline** e data source/license evidence;
4. **testes reais executados** e hardware/seed especificados;
5. **risk matrix** (imagem, pesos, egress, custo, privacidade);
6. **telemetria** e artifact lineage;
7. **rollout/rollback** (feature flag, schema gate, migrations separadas);
8. **handoff de agente** com diff limitado e tarefas subsequentes.

Agente não transforma todos os tickets em código automaticamente. Quando encontrar trabalho local não commitado, interrompe **aquele arquivo** e documenta conflito; segue em caminhos independentes.

## 5. Kill / go criteria de produto

| Decisão | Sinal observável | Ação |
|---|---|---|
| continuamos com capability pack? | 2 tarefas novas usam 70%+ do workflow comum **medido por operações/contratos, não linhas de código** | consolidar abstração após evidência |
| novo detector vale a pena? | melhora quality-vs-p95 em test travado e licença compatível | adicionar adapter opcional |
| FAISS é necessário? | exact search não atende p95/volume observado | adicionar índice ANN, medir recall perdida |
| VLM é custo-efetivo? | corrigiu erros que local+human não cobria no mesmo orçamento | manter como escalation, não default |
| precisar de vídeo real time? | demanda de cliente e playback offline provam valor primeiro | novo ADR com quotas/retention |
| melhorar EPI automaticamente? | critical-class recall e false alerts por ambiente aprovados por dono do risco | piloto supervisionado; nunca único controle |
| raio-X evolui para saúde clínica? | validação clínica independente, legal/compliance e especialistas disponíveis | projeto regulado separado, não release geral |
| projeto está se tornando genérico demais? | 3 packs inacabados, nenhum benchmark/usuário demonstra valor | congelar novos packs, concluir um vertical slice |

Os números como “70%” são **heurísticas de governança sugeridas**, não meta científica e podem ser substituídos pelo maintainer. Nenhum threshold de quality é inventado sem baseline e aprovação do domínio.

## 6. Decisões e perguntas que o agent deve retornar antes do primeiro PR

- O que mudou desde o ZIP de 11/11/2026 no repositório local? Quais `VLN-*` estão DONE com teste?
- Já existe `task` discriminator, geometry schema, video timestamp model, model registry e UI overlay? Evitar reimplementação.
- Qual fixture pequena pode ser distribuída legalmente, ou apenas downloader com hash+attrib?
- O projeto consegue executar PyTorch CPU local e worker JSONL com budget=0 sem baixar pesos?
- Há alguma matriz de baseline/hardware do host real? Quais claims devem ficar `NOT_MEASURED`?
- Um público-alvo e um workflow mais estreito dariam melhor portfólio do que suportar oito módulos simultâneos?

## 7. Exemplos de aceitação para os primeiros quatro tickets

O diretório [specs/](specs/) contém quatro specs independentes: `VLCV-001` reconciliation, `VLCV-002` dataset licensing, `VLCV-003` task evaluator design, `VLCV-004` starter suite. `backlog.csv` detalha 33 tickets e suas dependências. O gate final de CV1 requer evidência de **uma decisão real entre dois métodos** com comparabilidade científica e rastreabilidade, não 8 demos cosméticas.
