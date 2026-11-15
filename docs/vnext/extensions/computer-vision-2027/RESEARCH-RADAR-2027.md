# Research radar 2027–2030 — visão computacional e Applied Visual AI

**Regra:** `OBSERVADO EM FONTE` ≠ `VALIDADO NO VISIONLENS` ≠ `PROMETIDO EM PRODUÇÃO`. O radar identifica candidatos a spikes, não backlog obrigatório.

## 1. Mudança estrutural: modelo-base multimodal + especialização verificável

Há uma tensão produtiva entre **modelos generalistas** (que entendem múltiplas tarefas por prompts) e **modelos especializados pequenos** (com melhor controle de latência, custo e avaliação). A hipótese VisionLens deve ser demonstrar quantitativamente **em quais regimes cada arquitetura domina**:

- **Traditional CV / heurística:** hashes, cor, geometria, OCR clássico, optical flow; muito baratos, limitações claras, excelente baseline.
- **Encoders visuais:** SigLIP2 para embeddings texto-imagem multilíngues e zero-shot [S03](SOURCES.md#s03); DINOv3 para representação visual densamente transferível, sob licença específica [S17](SOURCES.md#s17). Aplicar linear probes antes de fine-tuning.
- **Detectors:** YOLO26 e RT-DETR como representantes de família CNN/híbrida/Transformer, comparados sob contrato geométrico comum, com atenção ao AGPL/Enterprise do YOLO [S04](SOURCES.md#s04), [S05](SOURCES.md#s05).
- **Open-vocabulary localization:** Grounding DINO associa prompts textuais a boxes [S26](SOURCES.md#s26); melhorar recall de classes novas sem afirmar equivalência a detector treinado.
- **Promptable segmentation:** SAM 2 para imagem/vídeo Apache-2.0 [S15](SOURCES.md#s15), SAM 3/3.1 para segmentação e tracking a partir de conceitos de texto/visuais, mas com licença própria e requisitos CUDA explícitos [S16](SOURCES.md#s16).
- **VLM reasoning:** Qwen3-VL 2B/4B/8B como família para pesquisa local condicionada a hardware/model card; avaliar grounding com regiões para evitar alucinações, nunca confiar no texto livre para geometria/controle [S18](SOURCES.md#s18).
- **OCR especializado:** PaddleOCR PP-OCRv6; vantagem potencial de modelo pequeno para texto em cenas, mas resultado publicado pelo autor é ponto de partida, não benchmark do projeto [S07](SOURCES.md#s07).

**Decisão de produto:** o modelo não define a UI, a API ou o banco. O `TaskEvaluationSuite` define o que é sucesso e o registry escolhe implementações válidas.

## 2. Mapa de oportunidades (priorização conceitual)

| Tese | Primeiro experimento falseável | Métricas/sinal de valor | Prioridade relativa |
|---|---|---|---|
| **Visual Quality Operations** | Inspeção de defeitos e falsos alarmes com revisão | recall crítico + custo por defeito real encontrado | **A** |
| **Product Catalog Intelligence** | Classificar + remover fundo + similaridade em um dataset com direitos | horas humanas poupadas, quality score, batch throughput | **A** |
| **Visual Evidence Retrieval** | recuperar imagem/objeto/região a partir de consulta com evidência ancorada | Recall@k, citation correctness, hallucination rate | **A** |
| **Document Extraction QA** | OCR/layout → campos estruturados revisáveis | field-level F1, schema validity, custo por campo | **B** |
| **Time-aware Video Analytics** | tracking e linha de contagem offline | MAE de eventos, IDF1/HOTA, throughput | **B** |
| **Vision Test Engineering for SaaS** | detectar regressões visuais reais em UI com semântica e pixel | false positive per PR, true regressions caught | **B** |
| **Synthetic Failure Lab** | sintetizar raros defeitos para treino e medir em holdout real | Δ recall crítico, review cost, artefato de provenance | **B** |
| **Open-world object discovery** | comparar promptable detector vs especializado em classes nunca vistas | novel-class recall / false positives | **C** |
| **3D/spatial/embodied perception** | depth/pose/calibration em dados com GT; sem atuação física | geometry error, drift e resource footprint | **C / pesquisa** |
| **Medical/biometric use cases** | auditoria científica restrita, não produto | generalização externa, falhas e conformidade | **restrito** |

*A/B/C são hipóteses de oportunidade, não valores de mercado empiricamente estimados.*

## 3. Quinze trilhas técnicas para brainstorm

### F01 — Visual Evidence Graph (aplicação diferencial)

Transformar `asset → region → detection/OCR/track → claim → reviewer decision → experiment` em um DAG de evidências tipadas. VLM pode formular hipótese “parece uma etiqueta de preço”, mas o claim tem que apontar para regiões, modelo e versão. Consultas: “quais erros de OCR aparecem em itens com reflexo?”, “qual modelo introduziu regressão nesta classe?”. **Guardrail:** implementar primeiro com store/SQL e índices; criar grafo dedicado somente se consultas exigirem.

### F02 — Open-vocabulary text-to-box-to-mask

Grounding DINO → bounding boxes → SAM 2 masks → revisão. Hipótese: reduzir tempo de anotação para classes raras vs anotação manual. Falsificação: medir minutos/label corrigido, IoU e review burden; comparar com boxes feitas por especialista. Licenças dependem de pesos/artefatos além do código [S15](SOURCES.md#s15), [S26](SOURCES.md#s26).

### F03 — Episódios visuais e temporal RAG

Indexar *frames-chave e eventos com timestamp*, não todos os frames sem necessidade. Pipeline: video shot segmentation → keyframes → detections/OCR → semantic clip representation → query por janela temporal → response com **timecodes auditáveis**. Evals: temporal localization IoU, Recall@k, taxonomia de alucinação e custo por minuto de vídeo.

### F04 — Tiny model first, large model only for uncertainty

Roteamento local cheap model → verifier/strong model → human review sob threshold calibrado. Testar se a cascata **reduz custo total** mantendo recall crítico em holdout, não apenas tokens. Custos incluem revisão humana e operações de hardware. Herda a policy da especificação canônica.

### F05 — Region-level representation / crop-aware retrieval

Usar bbox/seg mask como query; comparar retrieval de imagem inteira vs região em cenas multifocais. Evitar métrica inflada por objetos idênticos em query/test. Índice separado por encoder/version.

### F06 — Defect & anomaly learning

Comparar *one-class anomaly detection* / patch embeddings com classificador supervisionado em classes raras. Dados MVTec/VisA são candidatos sujeitos a split/licença; o VisA atual do repo **não tem holdout válido segundo a spec canônica**. A análise deve ser por lote/câmera/defeito, com false-alarm rate realista.

### F07 — Human correction as training signal

Revisão gera exemplos difíceis; priorizar correções via uncertainty, diversity, cost-aware selection e classes críticas. Experimento A/B com budget de revisão fixo, random sampling como controle e test intocado. **Não** treinar em correções de protected test.

### F08 — Synthetic data factory (somente com real holdout)

Criar dados sintéticos para blur, fundo, defeitos, iluminação e objetos incomuns. Registrar gerador, prompt, seed, licença, conversão e política de uso. **Gate:** demonstrar Δ no test real separado; aumento em test sintético não evidencia generalização. Avaliar se sintetização introduz artefatos que facilitam atalhos.

### F09 — Document OCR + layout + VLM auditor

OCR especializado local para extração de textos/regiões; VLM como *schema extraction* restrito e auditor; cada campo precisa citar box/trecho/origem. Comparar output com ground truth: per-field precision/recall, WER/CER, schema validity, annotation cost. Ideal como integração aplicada além de imagens fotográficas. PaddleOCR dispõe de famílias layout/VL [S07](SOURCES.md#s07).

### F10 — Video analytics com identidade transitória

Detecção + tracking + contagem de objetos, pessoas ou veículos agregada; uso recomendado prioriza peças/produtos antes de pessoas. Tratamento de camera motion, re-ID efêmero, oclusão e reentrada. **Não criar cross-camera identity matching** por conveniência.

### F11 — Visual regression testing para produtos de software

Comparar screenshot perceptual/pixel diff e evidência semântica (componentes, texto e regiões) em PRs. Hipótese: reduzir falsos positivos de diff ao mesmo tempo em que encontra regressões funcionais reais. Dataset: screenshots próprios e mudanças controladas, sem necessidade de fotos licenciadas. Métricas por PR, componente, viewport, tema e linguagem; foco acesso/a11y.

### F12 — OBB e inspeção em logística

Detector com oriented bounding boxes para caixas/etiquetas/peças inclinadas. Comparar OBB-vs-axis-aligned em imagens com rotação. Evitar adicionar novo modelo/tabela antes de demonstrar ganho em benchmark e adequar coordinate system.

### F13 — Mobile/edge export

Piloto CPU/MPS → ONNX Runtime em dispositivo alvo e, sob necessidade, Core ML/quantização com profiling real. Risco: change de precisão, operadores indisponíveis, divergência entre export e PyTorch. Gate de paridade de outputs + quality loss + peak memory + cold start, por dispositivo.

### F14 — 3D, depth e pose (investigação)

Explorar metric depth, 2D/3D pose, multi-view geometry e sensor fusion, mas exigem calibração/ground truth e implicam novos contratos. SAM 3D pode servir como revisão de estado da arte, não como promessa de precisão física. Sem controle de robôs, drones ou equipamento industrial em loop fechado.

### F15 — Spatial understanding no e-commerce/arquitetura

Estimativa de dimensões e enquadramento, detecção de superfícies, scene layout. Não deduzir medidas métricas de uma única foto sem referência de escala/câmera calibrada. Produto futuro somente se benchmarks sustentarem precisão suficiente.

## 4. Dúvidas não óbvias que devem orientar pesquisa de 2027+

1. O ganho de um encoder foundation se mantém quando **captura/câmera/site são novos**? Isso importa mais que benchmark médio.
2. O resultado “mais inteligente” economiza operações ou aumenta revisão manual devido a alucinação/baixa estabilidade?
3. Quando OCR especializado supera VLM grande em **per-character correctness**, inclusive textos raros ou desfocados?
4. O grounding multimodal oferece *evidence references* válidas em nível de região, ou apenas respostas plausíveis?
5. A diversificação dos dados de treinamento gera melhoria real versus adicionar mais parâmetros?
6. Distillation/quantization conserva **recall crítico** e calibration, ou só acurácia média?
7. Qual é o custo marginal para ativar mais um domínio sem criar esquema/tabela/serviço novo?
8. Qual subconjunto de feature extraction pode rodar totalmente local sem bloquear uma sessão de edição do Studio?
9. Quanto tempo humano será necessário para corrigir *pseudo-labels* versus anotar do zero?
10. O modelo é mais robusto a adversários simples (watermark, texto, reflexo) ou apenas à distribuição conhecida?
11. O uso de máscaras e croppings melhora retrieval ou induz perda de contexto semântico?
12. A política de direitos autorais por imagem limita o dataset mesmo quando o *dataset card* diz CC BY?
13. É possível demonstrar ganho no custo por erro corretamente resolvido, não apenas ganho de acurácia?
14. Quais outputs exigem *abstention*, human review e auditoria antes de automação?
15. Quais operações de visão seriam úteis como **MCP tools determinísticas** para agentes sem dar acesso irrestrito a arquivos?

## 5. Matriz de maturidade de tecnologias (verificações em 15/11/2026)

| Família | Fonte/estado confirmado | Default recomendado | Condição de spike |
|---|---|---|---|
| PyTorch/Torchvision | tutoriais de transfer e detection [S01](SOURCES.md#s01), [S25](SOURCES.md#s25) | baseline em CPU | cobertura de fixture e treino mínimo |
| SigLIP2 | release/model card [S03](SOURCES.md#s03) | retrieval / zero-shot candidata | perfil memória e licença exata do checkpoint |
| DINOv3 | Meta 2025, licença DINO própria [S17](SOURCES.md#s17) | comparador opcional | audit de uso e benefício em slice |
| Ultralytics YOLO26 | docs atuais + AGPL/Enterprise [S05](SOURCES.md#s05) | **opcional**, não único detector | licenciamento aprovado |
| RT-DETR | repositório Apache-2.0 [S04](SOURCES.md#s04) | detector comparador | peso/checkpoint compatíveis |
| SAM 2 | repo+checkpoints Apache-2.0 [S15](SOURCES.md#s15) | segmentation research adapter | medições MPS/CPU/CUDA |
| SAM 3/3.1 | SAM License, CUDA explícito [S16](SOURCES.md#s16) | **não** baseline local obrigatório | CUDA disponível + licença + ROI |
| Grounding DINO | official Apache-2.0 code [S26](SOURCES.md#s26) | prompts→boxes experimental | estabilidade e threshold em holdout |
| PaddleOCR PP-OCRv6 | release Jun/2026 [S07](SOURCES.md#s07) | OCR especializado candidata | benchmark do alfabeto alvo, weights/license |
| Qwen3-VL | modelos 2B/4B/8B, repo Apache-2.0 [S18](SOURCES.md#s18) | VLM tester opcional | model card, device profiling, structured output eval |
| FAISS | biblioteca MIT [S22](SOURCES.md#s22) | index local se exact NN não escalar | melhoria medida com Recall@k e p95 |
| BiRefNet / rembg | modelos e pesos múltiplos; direitos heterogêneos [S12](SOURCES.md#s12) | segmentation/matting opcional | qualidade e licença específica |

## 6. Kill gates que mantêm o projeto excelente

- **Não treinar foundation model do zero.** Provar primeiro head/probe/fine-tuning + data-centric improvement.
- **Não abrir sete microsserviços.** Uma biblioteca Python + adapters/worker existentes resolvem a maior parte até dados sugerirem outra coisa.
- **Não subir novos bancos de vetores.** Index exato local + FAISS se necessário.
- **Não criar 8 telas desacopladas.** 1 Task Gallery + 1 Evaluation Arena + task-specific overlays.
- **Não usar API paga por default.** BYOK sob aprovação e budget; benchmark local público reprodutível.
- **Não transformar pesquisa clínica ou reconhecimento individual em produto generalista.** Legal, ética, dados e risco próprios.
- **Não copiar resultados ou claims de benchmark do fornecedor.** Comparar em fixture VisionLens, mesmo hardware/split.
- **Não forçar o novo roadmap a bloquear R0–R8.** Se o core não estiver estável, manter Phase II em research mode.
