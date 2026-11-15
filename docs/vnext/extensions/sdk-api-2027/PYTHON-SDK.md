# SDK Python de primeira classe — design de API, runtime, packaging e avaliação

**Status:** proposto. **Nome de distribuição:** `visionlens` (validar disponibilidade no PyPI); **import:** `visionlens`; **Python mínimo sugerido:** `>=3.11`, conforme 05-PYTHON-CORE-AND-PYPI do ZIP original. **Não publicado/implementado por este documento.**

## 1. Uma distribuição, duas formas de uso

O usuário não deve instalar dois projetos distintos sem necessidade. A distribuição `visionlens` contém: (a) **cliente remoto leve**, síncrono e assíncrono, utilizável sem GPU ou Node; (b) **runtime local opcional** via extras, com I/O e inferência in-process. A biblioteca expõe fachadas com objetos explicitamente diferentes para que custo, side effects e garantias não sejam confusos.

| Superfície Python | Runtime | Principais retornos | Requisitos | Persistência |
|---|---|---|---|---|
| `VisionLens.local(config)` | Python no processo atual | `PredictionRun`, `EvaluationRun`, `ArtifactRef` | `visionlens[vision]` e extras por tarefa; dispositivo compatível | manifest/CAS local independente |
| `VisionLensClient(base_url, ...)` | HTTP sync para Fastify | `JobHandle`, `Job`, typed results | instalação base + HTTP | backend TS store, refs remotas |
| `AsyncVisionLensClient(base_url, ...)` | HTTP async (`asyncio`) | `JobHandle`, async events, downloads | instalação base + HTTP | backend TS store |
| `visionlens.runtime.*` | extensões internas locais | tensores/model handles | opt-in, adaptadores | sem acesso irrestrito à store TS |

A interface local **nunca** chama Fastify automaticamente se uma operação não tiver dependência local. Erro `MISSING_EXTRA` indica como instalar, erro `UNSUPPORTED_DEVICE` identifica capabilities; **não** mudar silenciosamente para um provedor remoto pago. O cliente remoto **nunca** tenta instalar torch ou iniciar um processo Node quando falta o backend.

## 2. API pública sugerida, com exemplos de ergonomia

### 2.1 Primeira inferência CPU local (proposta)

```python
# EXEMPLO DE API FUTURA — requer implementação e um modelo aprovado.
from pathlib import Path
from visionlens import VisionLens, LocalConfig

cfg = LocalConfig(
    device="cpu",                         # "auto" opcional, mas sempre auditável
    workspace_dir=Path("./visionlens-runs"),
    offline=True,                         # proíbe downloads/egress implícitos
    model_downloads="deny",              # versão/arquivo fornecidos explicitamente
    max_input_megabytes=20,
)
with VisionLens.local(cfg) as lens:
    print(lens.capabilities())
    run = lens.vision.predict(
        input=Path("./samples/cat.jpg"),
        task_kind="image.classification",
        model="example-classifier@sha256:...",  # placeholder; real revision pinned
        options={"top_k": 3},
    )
    print(run.run_id, run.predictions, run.provenance.model_digest)
    print(run.artifact_manifest_path)
```

`model_downloads="deny"` e `offline=True` representam uma mesma intenção em dois níveis: a configuração pública deve evitar controles duplicados se o agente constatar redundância; manter um *único* `NetworkPolicy` ou flag após validação. O exemplo enfatiza comportamento, não nomes definitivos.

### 2.2 Operação Python HTTP sync com job durável

```python
# EXEMPLO FUTURO — sem Torch, sem Node local.
from visionlens import VisionLensClient

with VisionLensClient(base_url="https://example.invalid", token="<runtime-token>") as vl:
    capabilities = vl.capabilities.get()
    uploaded = vl.assets.upload_file("./samples/cat.jpg")
    job = vl.jobs.submit(
        operation="vision.predict",
        params={
            "taskKind": "image.classification",
            "assetId": uploaded.asset_id,
            "modelId": "approved-model@rev1",
        },
        budget={"maxSeconds": 120, "maxUsdMicro": 0},
        idempotency_key="my-experiment-001",
    )
    completed = vl.jobs.wait(job.job_id, timeout=180)
    if completed.status != "succeeded":
        raise RuntimeError(completed.status)
    result = vl.jobs.result(completed.job_id)
    print(result.artifacts)
```

O `wait(timeout)` controla **tempo máximo do cliente**, não `budget.maxSeconds` do servidor. Timeout no cliente não cancela o job; `vl.jobs.cancel(job_id)` é ação explícita. `submit()` exige idempotency key para ativar retries seguros de POST.

### 2.3 Python HTTP async e streaming

```python
# EXEMPLO FUTURO — API async não depende do runtime local.
import asyncio
from visionlens import AsyncVisionLensClient

async def run_job() -> None:
    async with AsyncVisionLensClient(base_url="https://example.invalid", token="<token>") as vl:
        job = await vl.jobs.submit(
            operation="vision.predict",
            params={"assetId": "asset_01", "modelId": "approved@rev1", "taskKind": "image.detection"},
            budget={"maxSeconds": 300, "maxUsdMicro": 0},
            idempotency_key="detector-2027-001",
        )
        async for event in vl.jobs.events(job.job_id, after=0):
            if event.kind == "progress":
                print(event.completed, event.total)
            if event.kind in ("result", "error"):
                break
        final_job = await vl.jobs.get(job.job_id)
        print(final_job.status)

asyncio.run(run_job())
```

SSE deve manter cursor `{jobId, seq}` para deduplicação e replay. Quando uma corrotina é cancelada, liberar conexão/recursos sem enviar `cancelJob` automaticamente, porque outros clientes podem acompanhar o mesmo processamento. `AsyncVisionLensClient` deve ser totalmente nativo async, sem `asyncio.run()` dentro de uma função que já roda no event loop (Jupyter/FastAPI).

## 3. Interface pública candidata (protocol skeleton)

```python
# Assinaturas conceituais, não arquivo implantado.
from dataclasses import dataclass
from pathlib import Path
from typing import Any, AsyncIterator, Literal, Mapping, Protocol

Device = Literal["auto", "cpu", "mps", "cuda"]
TaskKind = Literal[
    "image.classification", "image.detection", "image.ocr",
    "video.counting", "image.ppe", "image.retrieval",
    "image.matting", "image.medical_research",
]

@dataclass(frozen=True)
class ArtifactRef:
    artifact_id: str
    media_type: str
    sha256: str
    byte_length: int

@dataclass(frozen=True)
class PredictionRun:
    run_id: str
    task_kind: TaskKind
    predictions: tuple[Any, ...]
    provenance: Mapping[str, Any]
    artifacts: tuple[ArtifactRef, ...]

class LocalVisionOperations(Protocol):
    def predict(self, *, input: Path | bytes, task_kind: TaskKind, model: str, options: Mapping[str, Any] | None = None) -> PredictionRun: ...

class RemoteJobs(Protocol):
    def submit(self, *, operation: str, params: Mapping[str, Any], budget: Mapping[str, int], idempotency_key: str) -> Any: ...
    def wait(self, job_id: str, *, timeout: float | None = None) -> Any: ...
    def cancel(self, job_id: str) -> Any: ...

class AsyncRemoteJobs(Protocol):
    async def submit(self, *, operation: str, params: Mapping[str, Any], budget: Mapping[str, int], idempotency_key: str) -> Any: ...
    async def events(self, job_id: str, *, after: int | None = None) -> AsyncIterator[Any]: ...
```

A versão concretizada deve evitar `Any` nos objetos de domínio. O uso temporário na interface exploratória permite conciliar com os `Prediction`/`Annotation` implementados no repositório; após ADR e schemas, substituí-los por classes/tipos gerados.

## 4. Arquitetura interna proposta

```text
python/visionlens/                      # diretório do ZIP canônico, ainda a conferir no repo
  pyproject.toml
  README.md
  src/visionlens/
    __init__.py                      # exports estáveis; import leve
    py.typed
    api.py                           # VisionLens.local; context manager
    config.py                        # validate LocalConfig/NetworkPolicy
    errors.py                        # stable error subclasses, retry metadata
    typing.py                        # public protocols, TaskKinds
    client/
      sync.py                        # VisionLensClient, httpx.Client injection
      async_.py                      # AsyncVisionLensClient, httpx.AsyncClient
      transport.py                   # auth, retry, handshake, idempotency
      sse.py                         # parse/reconnect/cursor/dedupe
      assets.py                      # secure streaming uploads/downloads
    local/
      session.py                     # LocalVisionContext lifecycle
      manifest.py                    # readonly immutable run manifests
      artifacts.py                   # CAS writer, atomic move, SHA256
      dataset.py                     # immutable dataset & split descriptors
    registry/
      model.py                       # license/preprocessing/backend/deps
      task.py                        # allowlisted adapters; no arbitrary imports from input
    cv/
      classification.py
      detection.py
      ocr.py
      tracking.py
      ppe.py
      retrieval.py
      matting.py
      medical_research.py            # research-only policy gates
    evaluation/
      suite.py                        # task-specific evaluation plugins
      metrics.py
    training/
      recipes.py                     # optional extras; no implicit network
    bridge/
      worker.py                      # supervised JSONL server, from canonical v1
      handshake.py
  tests/...
```

Diretórios novos são proposta, não instrução para mover os serviços Python já existentes. `services/{vision,training,agents}` permanecem adapters finos até haver evidência/ADR para fusão. `__init__` não importa `cv/`, `torch` ou `transformers` avidamente. O pacote é typed (`py.typed`), sem native extensions na base.

## 5. Python local persistence versus workspace gerenciado

Esse é o ponto mais fácil de errar. Em modo standalone, Python pode gerar:

```text
workspace_dir/
  manifest.version.json
  blobs/sha256/ab/abcdef...           # bytes imutáveis, streaming
  runs/<run-id>/run.json              # manifest imutável + links para CAS
  indexes/<index-fingerprint>/        # embeddings/search, versionados
  cache/                              # derivado, descartável
```

**Não** reutilizar `packages/core/src/store` via SQLite direto. Em workspace gerenciado, Python worker deve receber somente IDs/scoped refs e entregar resultados ao TS domain through defined commit interface; se for necessário usar Python local e depois Studio, criar `POST /v1/imports/local-runs` *em fase posterior* com bundle assinado/hash auditado e idempotência, evitando sync implícito. A forma exata do manifesto requer ADR e conformance com entities já existentes.

## 6. Device planner e controle de recursos

- Base CPU sempre suportada na *test fixture*; não afirmar performance real-time. `mps`/`cuda` são capacidades explícitas por adapter+model+operator, não garantias de PyTorch por plataforma.
- Resolver `DevicePlan` com `{requested, selected, reason, fallback_used, precision, batch_size, env_fingerprint}`. Sem licença/hardware, erro tipado antes do download.
- `torch.inference_mode()` quando suportado, gestão de memory/batches, model cache com LRU e leases, backpressure quando limite de RAM/VRAM exceder; Apple Silicon MPS e CUDA testados apenas nos runners que possuírem hardware real.
- Modelo com pesos externos: usuário faz pin exato por revision/digest, license manifest, checksum; proibir execução de pickle/checkpoints arbitrários sem trust review. Bibliotecas `safetensors`/formats seguros quando disponíveis.
- Offline test garante: nenhum DNS/HTTP no import e na inferência com pesos já instalados. Logging não inclui imagem/EXIF, tokens ou path do usuário por padrão.
- Cancelamento in-process cooperativo com token; long op interrompe entre batches e limpa parcial. Não prometer matar threads Python de modo seguro.

## 7. Adapter registry e os oito labs

`TaskAdapter` define `task_kind`, `input_spec`, `model_capabilities`, `predict`, `evaluate`, `artifact_schema`, `license_policy`. Registry recebe IDs declarativos de modelos e adapters verificados; configs não podem importar módulos Python arbitrários por string. Preprocessamento/revision hash são parte do resultado.

| Lab | API ergonômica local proposta | Extra candidato | Tipos de saída |
|---|---|---|---|
| 09 | `lens.vision.classify(path, model=...)` | `[vision]` | `ClassPrediction` |
| 10 | `lens.vision.detect(path, model=...)` | `[cv-detection]` | `BoundingBox` + `Detection` |
| 11 | `lens.vision.ocr(path, model=...)` | `[cv-ocr]` | `TextRegion` + `TextObservation` |
| 12 | `lens.video.count(clip, line=..., model=...)` | `[cv-video]` | `TrackEvent` + `CountSummary` |
| 13 | `lens.vision.inspect_ppe(path, model=...)` | `[cv-detection]` | `PPEObservation`, `unobservable` |
| 14 | `lens.retrieval.query(image, index=..., k=...)` | `[vision]` | `RetrievalHit` + `indexFingerprint` |
| 15 | `lens.vision.remove_background(path, model=...)` | `[cv-matting]` | `AlphaMaskRef`, `CompositedImageRef` |
| 16 | `lens.research.analyze_xray(path, suite=...)` | opt-in/research only | research scorecard + uncertain labels |

**As funções ergonômicas só aparecem na documentação pública quando implementadas/testadas.** Backend canônico permanece `vision.predict` e workflows assíncronos; `image.retrieval` pode mapear `vision.embed` + busca versionada, conforme ADR. Módulo 16 não oferece método `diagnose` e não produz laudo clínico.

## 8. Packaging realista: `pyproject.toml`

A base instala apenas o necessário para validação e cliente HTTP. Uma referência TOML em `examples/pyproject.reference.toml` fornece metadados para adaptação. Política sugerida:

```toml
[project]
name = "visionlens"                       # nome candidato, validar PyPI
version = "0.0.0"                        # placeholder, não release
requires-python = ">=3.11"
dependencies = ["pydantic>=2,<3", "httpx>=0.27,<1"]

[project.optional-dependencies]
vision = ["numpy", "Pillow", "torch"]
training = ["scikit-learn", "torch"]
cv-detection = ["torch", "Pillow"]
cv-ocr = ["Pillow"]
cv-video = ["numpy"]
cv-matting = ["torch", "Pillow"]
agents = []
server = []
```

Esse snippet demonstra **separação de extras**, não um conjunto suficiente de dependências: versões exatas de adapters de YOLO/OCR/video, e compatibilidade de `torch`/Python/macos/CUDA precisam ser decididas com lockfiles por perfil, audit de licença e tested installs. Não publicar extras vazios e `all` artificial. Preferir conjunto mínimo para primeira entrega: `[vision]`, `[training]`, `[agents]`, `[server]`, alinhado ao ZIP canônico; adicionar `[cv-*]` somente quando implementados.

Regras:
- PEP 621 metadata e `[build-system]` explícito. Wheel puro, sdist, licença e `py.typed`; sem datasets/checkpoints/keys.
- `uv.lock` no repositório para desenvolvimento; *wheel* testado em venv limpo e sem `tool.uv.sources` local; `uv build`, `uv build --no-sources` quando aplicável.
- Unit test Python 3.11/3.12; 3.13 somente após prova de compatibilidade de torch/adapters. Dispositivos específicos em jobs opt-in.
- Distinguish `packageVersion` vs `contractVersion` vs `workerProtocolVersion` vs `modelRevision`. Aumento de versão do SDK não implica schema v2.
- Evitar ter `visionlens` e outro pacote SDK Python HTTP separado enquanto não houver razão técnica: duplicaria release/confusão de namespaces.

## 9. Error taxonomy e transport

Classes base sugeridas: `VisionLensError(code, request_id, retryable, details)`, `ValidationError`, `AuthenticationError`, `AuthorizationError`, `CapabilityUnavailable`, `MissingExtraError`, `ModelLicenseError`, `BudgetExceededError`, `RateLimitError`, `VersionMismatchError`, `ArtifactIntegrityError`, `JobFailedError`.

- HTTP error `RFC9457` → classe Python mapeada por `code`, sem parsing de `detail` em inglês; `ProblemDetails` com `type/status/title/detail/instance/code/requestId/retryable` e detalhes redigidos.
- Transport exception (`httpx.ConnectError`, `ReadTimeout`) é mapeada para `TransportError`, não significa que server-side job falhou. Para POST com idempotency key, tentar `GET` ou submit again com mesma key após reconectar.
- Async `CancelledError` é reerguido; não transformá-lo em sucesso/cancelamento de job remoto.
- `403` capability prohibited vs `424` model extra missing? Política: erros de policy com 403; indisponibilidade de hardware/model/capability 422/503 dependendo causa; mapear em catálogo, sem escolher status a partir de strings.
- Resultado com `unknown`/`unobservable` é válido e deve preservar a diferença de `None`, `False`, `0` e lista vazia.

## 10. Contrato de transport Python, isolamento e segurança

- `httpx.Client`/`AsyncClient` injetáveis, timeout por etapa, transport mock em teste, TLS verificado por padrão, proxies somente configurados conscientemente, token provider e `User-Agent` sem PII.
- `assets.upload_file` faz stream e calcula sha256 sem acumular arquivos gigantes em RAM; verifica tamanho, MIME permitido, EXIF sanitization policy do backend; client não dita authoritative MIME apenas por extensão.
- Upload não aceita `file://` ou URLs livres no backend; Python local `Path.resolve()` e symlink checks para política de diretórios, mas caller local é confiável dentro do processo.
- `artifacts.download(..., destination=...)`: stream para arquivo temporário em diretório permitido; verificar `digest` e `length` antes de atomic rename; nunca aceitar nome de path do response diretamente.
- Pagination vira iterador/async iterador com limites para evitar paginação infinita; SSE mantém dedupe seq.
- Logs de modelo configuráveis; `TraceContext` propaga request IDs, mas desabilitar rastreamento de payloads sensíveis.

## 11. Testes e release gates específicos Python

1. Import em venv limpo sem Torch, MLflow, Transformers e sem Node presente; `python -c 'import visionlens'` passa sem I/O de rede.
2. Build wheel+sdist, inspecionar conteúdo (nada de checkpoints), instalar ambos numa instalação isolada; `py.typed` incluído; `mypy`/`pyright` sobre consumidor real.
3. Contract fixtures JSON: Python `TypeAdapter.validate_json(...)` aceita payloads válidos e rejeita inválidos; comparar wire canonical com TS Zod.
4. `httpx.MockTransport` ou equivalente: auth header, 202, 400, 401, 403, 409, 429, 503, retries, ETag, pagination, timeouts e idempotency.
5. Async Test: stream parcial, reconnect cursor, cancel consumer, 2 consumers do mesmo job, `_close` resource leak, timeout vs job cancel.
6. Local CPU golden: imagem sintética/licenciada, seed/pipeline, model pinned, deterministic contract; memória e CPU bounds; sem downloads surpresa.
7. Scientific gates fora de fast CI: held-out split por sujeito/clip, avaliação classification/detection/OCR/tracking/retrieval/matting tasks, MPS/CUDA smoke quando hardware existir.
8. Security: malicious path, zip bomb, corrupt EXIF, model download blocked, prohibited patient/plate data route, sensitive logs redacted.
9. Release only after package name ownership validated, license review, docs/examples executed against built artifact, signed CI/tag and rollback proof.

## 12. Ambiguidades a fechar no ADR do primeiro PR

- **Standalone output contract:** se usará `run.json` + CAS próprio ou snapshot import compatível; não escrever canonical SQLite.
- **Model IDs:** se a convenção de revision será `model@rev` vs objeto `{id, revision}`; preferir objeto tipado se o repositório já usar.
- **Image input:** `Path|bytes|PIL|numpy` no core local, sem tornar PIL/Numpy dependências base; heavy types só em submodules.
- **TS ↔ Python coordinate frames:** normalização EXIF e `bbox` pixels/normalized; não estimar shapes a partir da string da classe.
- **Public package name:** validar PyPI e domínio; `visionlens` é provisório.
- **Torch version matrix:** não fixar sem resolver ambiente 3.11/3.12 macOS/CPU/CUDA e licenças.

**Termo de aceite:** Python tem real uso standalone, não é apenas uma casca HTTP de outro serviço; e ao mesmo tempo oferece um cliente HTTP leve coerente com o SDK TypeScript e o backend.
