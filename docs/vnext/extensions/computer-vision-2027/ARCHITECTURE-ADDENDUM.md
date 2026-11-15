# Architecture Addendum — Computer Vision capability packs

**Status:** proposed. **Constraints inherited from canonical ZIP:** Python-first numerical ML, TS application/domain owner, Zod contract source, SQLite single writer, JSONL worker versioned, Python SDK standalone, per-artifact provenance, no big-bang migration. Does not supersede ADR-011…018.

## A. Objetivo arquitetural

Adicionar oito tarefas CV e abrir espaço para extensões future-facing **sem repetir infra, sem migrar contratos à força e sem induzir serviços por modelo**. Critério de desenho: a próxima tarefa deve idealmente exigir (i) um task adapter Python, (ii) um evaluator, (iii) uma definição de geometria/output e (iv) UI overlays reutilizáveis — não uma nova plataforma.

### Component architecture (proposta)

```text
apps/studio (Next.js)                  packages/sdk (client entrypoint)
  |                                              |
  +-----------------> apps/api (Fastify) <--------+
                            |
                     packages/core
                   / contracts Zod \
            SQLite+CAS          workers JSONL v1
                                     |
                             python/visionlens
                                     |
                          TaskAdapter interface
                        /       |       |      \
                    classify  detect  retrieve  segment  ...
                       |        |        |        |
                  evaluator registry / calibration registry
                       |        |        |        |
                     Experiment + Model + Dataset artifacts

MCP tool facade -> same typed application operations, scoped and approved
```

### Não mudar agora

`packages/core` persistência atual, `@vision-lens/contracts` outputs e snapshot sem justificativa, JSONL wire v1 major, CLI aliases `vision-lens`/`ai-image-labeling`, `@vision-lens/sdk` export compatibility, datasets VisA e scripts atuais. A engenharia deve primeiro inspecionar se o repositório local já possui abstrações similares e reutilizá-las.

## B. Domain model delta proposto (não criado)

### `CapabilityPack`

Registro com nome/ID versionado, `taskKind`, suportes de input/output, `allowedModelIds`, scorer IDs, hardware/backends, licença, política de dados, preço/recursos e `safetyTier`. **É metadata/config validada**, não objeto com arbitrary Python import path. Exemplos no diretório `contracts-proposed/` não definem API estável.

### Tipos semânticos (somente após inspecionar a Zod existente)

| Aspecto | Tipo comum atual a verificar | Delta proposto | Invariantes |
|---|---|---|---|
| Imagem | `Asset`, `Sample`, `Prediction` | classificação / detections / mask refs | hash + ontology + coordinate frame |
| Texto | `Prediction` generic output | `TextRegion` | OCR literal ≠ normalização ≠ decisão |
| Tempo | ingest de vídeo é frontier no ZIP | `VideoClip`, `FrameRef`, `TrackEvent` | timestamps monotônicos, IDs por clip |
| Segurança | annotations/review separadas | `ReviewRequirement`, `Unobservable` | sem converter missing em false |
| Recuperação | embedding registry | `IndexSnapshot`, `RetrievalRun` | fingerprint encoder+preprocess+index |
| Pesquisa restrita | dataset snapshot e eval | `RestrictedResearchSuite` | sem real data egress, research-only |

`Prediction` nunca vira `Annotation` por inference. `Correctness`, `Confidence` e `Calibration` são conceitos diferentes. `TrackId` sempre scoped a `VideoClip` e não reconcilia pessoas entre gravações automaticamente.

### Estratégia de migração incremental

1. **Spike só em memória**: usar objetos internos Python e artifacts JSON com versão proposta; sem alterar SQLite.
2. **Conformidade**: teste schema Zod↔JSON Schema↔Python, golden fixtures e event stream; converter somente se os tipos existentes cobrirem output.
3. **ADR se necessário**: introduzir variante discriminada com version bump; migrar leitores antes de escrever dados persistentes desse tipo.
4. **Persistência**: preservar write-through no store TS single-writer e CAS de artefatos, nunca Python escrevendo SQLite diretamente.
5. **Rollback**: desligar capability via registry flag; manter dados gravados compreensíveis ou migráveis; preservar legacy CLI.

## C. Interface Python proposta (ilustrativa)

```python
# PSEUDOCÓDIGO — assinatura conceitual; não é implementação disponível.
from typing import Protocol

class TaskAdapter(Protocol):
    task_kind: str
    def validate_inputs(self, request: object) -> None: ...
    def run(self, request: object, context: object) -> object: ...

class TaskEvaluator(Protocol):
    task_kind: str
    def evaluate(self, predictions: object, suite: object) -> object: ...
```

O runtime recebe `context` com refs imutáveis, ModelRegistry, budget/cancellation e artifact writer. Um *adapter* não instala dependência automaticamente, não aceita caminho local fornecido arbitrariamente pelo usuário e não executa código por string. `MISSING_EXTRA`, `LICENSE_BLOCKED`, `UNSUPPORTED_DEVICE`, `UNSUPPORTED_TASK`, `INSUFFICIENT_GROUND_TRUTH`, `INVALID_SPLIT`, `INCOMPATIBLE_COORDINATE_FRAME`, `POLICY_APPROVAL_REQUIRED` são códigos de erro **propostos**, não existentes.

### Exemplo de operation envelope (conceitual)

```json
{
  "protocol": "visionlens.worker.v1",
  "operation": "vision.predict",
  "requestId": "req_cv_009",
  "contractVersion": "1.0.0",
  "workspaceId": "local",
  "params": {
    "snapshotId": "snap_oxford_pets_locked",
    "modelId": "encoder-classifier-demo",
    "taskKind": "image.classification",
    "outputSchemaVersion": "proposed.v0"
  },
  "budget": {"maxSeconds": 120, "maxTokens": 0, "maxUsdMicro": 0}
}
```

**Importante:** `taskKind` e `outputSchemaVersion` não são garantidos pelo contrato atual. O agent deve verificar `worker-request.v1.schema.json` e `packages/contracts` no repo real; só adicionar com ADR/versão se não houver campo adequado. Não copiar esse JSON direto para testes existentes como se fosse válido.

## D. Data lineage and artifact policy

Todas as variantes herdam a mesma provenance:

```text
input bytes SHA-256
 + asset orientation/decoder/preprocess fingerprint
 + original annotations and ontology revision
 + acquisition group / patient/clip/license IDs
 + dataset snapshot and split manifest digest
 + model family/checkpoint digest/tokenizer revision
 + device and kernel/backend profile
 + postprocess/threshold/calibration revision
 + runtime/code commit/contract version
 -> immutable run -> prediction artifacts -> evaluation -> reviewer decision
```

Para vídeo e dados médicos, a lineage passa por `clip_id / frame timestamp / session` e `patient pseudonym / acquisition study`, respectivamente; pseudônimos e metadados pessoais não podem vazar nos relatórios públicos.

Embeddings e masks têm ref a blob, nunca payload binário JSONL. Atualizar modelo ou preprocessamento invalida índice/cache incompatível, mesmo se a dimensão permanecer igual. Nunca adicionar API pública de auto-download de dataset com DUA.

## E. Task-aware evaluation engine

Um `EvaluationSuite` deve registrar `taskKind`, annotation geometry, split/dataset hash, taxonomia, metric family e *error slicing policy*. Não basta parametrizar uma função genérica `accuracy`.

- `classification`: top-1, macro F1, calibration; abstentions no denominador.
- `detection`: boxes/IoU matching, COCO AP e area slices; quadriláteros/OBB como extensão separada.
- `ocr`: text matching e Unicode normalization explícita; CER/sequence exact match e metrics end-to-end.
- `tracking`: associações temporais, HOTA/IDF1, event MAE; timestamps e tolerância.
- `retrieval`: relevance judgement set e ranking; different query families separate.
- `matting`: alpha versus binary segmentation; não converter GT alpha sem registrar perda de informação.
- `medical-research`: multilabel uncertain/missing labels, patient grouping, threshold-free e thresholded metrics.

Comparação só é válida para mesmo `suite_digest`, `ontology_revision`, `preprocess_policy` relevante, série de samples e política de falhas. **A Arena só mostra comparações válidas**; experimentos incomparáveis ficam lado a lado com aviso e sem “winner”.

## F. Compatibilidade Studio/API/SDK/CLI/MCP

- Studio envia job comum + `taskKind`; overlays são plugins de visualização *thin*, não donos de lógica. A11y para box/timeline/ocr via lista navegável e alternativas textuais.
- API mantém `POST /v1/jobs` e `GET /v1/jobs/{id}` com tipo de job/escopo; SSE não embute imagens.
- Python SDK: `visionlens` roda in-process; extras lazy `[cv-detection]`, `[cv-ocr]`, `[cv-video]`, `[cv-matting]` **candidatos**, após reconciliação do `pyproject` existente. Não declarar package publicado sem check.
- npm client só HTTP e typing; evitar importar Torch/Sharp/Node na versão browser. Preservar facade legacy durante migração.
- CLI opcional `vision-lens lab run --task ...` **proposto**, não alterar flags existentes sem testes de compatibilidade.
- MCP permite `dataset.inspect`, `vision.predict`, `eval.run`, `experiment.compare` como ferramentas de leitura/análise; upload de dados privados, training, export e model promotion requerem gates de aprovação do domínio. Nenhum `exec` genérico e nenhuma tradução de OCR para instruções.

## G. Hardware matrix e fallback confiável

| Device | Meta para primeira execução | Regra |
|---|---|---|
| CPU | indispensável para core tests e pequenas fixtures | baseline obrigatório, tempo real pode ser inviável |
| Apple Silicon MPS | opcional, testar kernels e memory por backend | cada fallback registrado; não inferir suporte a SAM3/quantization |
| CUDA GPU | habilita CV pesado e SAM3+ | ambiente separado com versões e license gate, não requisito de instalação base |
| ONNX / Core ML | research/export se houver demanda de edge | smoke parity + quality regression + cold start |
| Hosted VLM | optional BYOK em feature-specific route | aprovação explícita + custo + egress + fail-closed |

SAM3.1 repo atualmente requer CUDA 12.6+ [S16](SOURCES.md#s16); não vendê-lo como uma melhoria automática para usuário macOS. Cada profile é identificado pelo *hardware revision* e *batch size*; não comparar throughput heterogêneo sem rotular.

## H. Test strategy: contract, science, UI and safety

1. **Unit:** coordinate projection, OCR normalization, track events, duplicate grouping, alpha dimensions, disabled policy gates.
2. **Property-based:** boxes dentro da imagem, identidade rotacionada, timestamps ordenados, arrays malformados, merge de tracks sem contagem dupla.
3. **Golden fixtures:** 3 imagens licenciadas controladas (classification/retrieval/segmentation) mais 1 clip sintético de crossing e 1 OCR sintético.
4. **Contract:** Zod/Pydantic/JSON Schema consistency, type-safe HTTP responses, JSONL hello/progress/error/cancel, stale revisions.
5. **Scientific:** locked dataset split e avaliação real fora da CI rápida; negative control, duplicate leakage e metric suites.
6. **UX/E2E:** zoom/overlays, leitor de tela e teclado, upload com consentimento, error handling de modelo ausente.
7. **Security:** malicious images, strings OCR de prompt injection, DUA blocked, local path traversal, large video, checkpoint não confiável.
8. **Operations:** cancel/timeout/recovery sem duplicar cobranças ou resultados, cache invalidation e retirada de modelo.

## I. Decisões que exigem ADR antes de código

- Novo schema de `Prediction` com geometry, text ou vídeo persistidos.
- Novo tratamento de vídeo (`VideoClip`, timestamps, codecs) e política de retenção.
- Introdução de modelo com licença copyleft/comercialmente restrita no build distribuído.
- Processamento de saúde/placas/biometria em ambiente acessível por rede.
- Novo banco/serviço/provedor externo com egress de assets.
- Alteração do benchmark/scorecard que invalida comparabilidade histórica.
- Mudança de SDK público ou major do worker protocol.

**Acceptance do addendum:** o agente consegue descrever todas as interfaces afetadas, os invariantes preservados e um pequeno diff demonstrável antes de editar o repositório.
