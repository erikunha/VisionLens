# SDK TypeScript/npm — browser, Node, compatibilidade e modo local

**Status:** proposta aditiva. **Namespace existente no ZIP original:** `@vision-lens/sdk`; root já reexporta APIs de `@vision-lens/core` no snapshot observado. **Nunca trocar esse root por HTTP-only em release minor.** O fato de existir no branch não prova publicação npm.

## 1. Quatro pontos de entrada, dois executores

| Import | Ambiente | Natureza | Disponibilidade proposta |
|---|---|---|---|
| `@vision-lens/sdk/client` | Browser, Node, edge com fetch/Streams | cliente HTTP typed | P3-MVP, primeiro |
| `@vision-lens/sdk` | Node (segundo legados) | exports existentes de core/legacy | **preservar** |
| `@vision-lens/sdk/legacy` | Node, quando relevante | alias explícito para workflow legado | deprecação gradual |
| `@vision-lens/sdk/node` | Node somente | gerenciamento de worker Python local e façade | P3-later, após bridge estável |
| `@vision-lens/sdk/types` (opcional) | qualquer TS | tipos públicos sem runtime | adicionar só se justificar |

`/client` não contém implementações de classificadores/detectores nem carrega Python. `@vision-lens/sdk/node` **não** duplica os algoritmos, apenas orquestra um Python worker JSONL e serviços TS. Import `@vision-lens/sdk/client` em Next.js Client Components e browser não pode puxar `node:fs`, `sharp`, `child_process`, `@vision-lens/core`, variáveis secretas ou OpenTelemetry server SDK. Em Next.js Server Components/server actions pode usar o mesmo cliente com token restrito ao servidor.

### 1.1 Tipos de uso

```typescript
// Exemplo FUTURO de cliente universal, não implementado neste suplemento.
import { VisionLensClient } from '@vision-lens/sdk/client';

const client = new VisionLensClient({
  baseUrl: 'https://example.invalid',
  getAccessToken: async () => runtimeToken,
  fetch: globalThis.fetch,
  timeoutMs: 30_000,
});

const capabilities = await client.capabilities.get();
const asset = await client.assets.upload(file);  // Blob/File browser; stream adapter Node
const job = await client.jobs.submit({
  operation: 'vision.predict',
  params: { taskKind: 'image.classification', assetId: asset.assetId, modelId: 'approved@rev1' },
  budget: { maxSeconds: 120, maxUsdMicro: 0 },
  idempotencyKey: 'demo-001',
});
const done = await client.jobs.wait(job.jobId, { signal: abortController.signal });
if (done.status === 'succeeded') {
  const run = await client.jobs.result(done.jobId);
  console.log(run.artifacts);
}
```

`client.jobs.wait` abortado por `AbortSignal` **não** cancela o job no servidor. `client.jobs.cancel` é outra chamada explícita e autorizada.

### 1.2 Node-only local: nenhuma VM embutida nem pseudo TS ML

```typescript
// EXEMPLO DE ENTRYPOINT FUTURO; requer JSONL supervisor implementado.
import { createLocalVisionLens } from '@vision-lens/sdk/node';

await using vision = await createLocalVisionLens({
  workspaceDir: './.visionlens',
  pythonExecutable: '/opt/venvs/visionlens/bin/python', // configurável, validado
  device: 'cpu',
  allowModelDownloads: false,
});
const run = await vision.predict({
  taskKind: 'image.detection',
  inputPath: './fixtures/warehouse.jpg',
  modelId: 'model-verified@rev1',
});
console.log(run.artifacts);
```

**Nota:** `await using` depende da versão/target TypeScript e da implementação de `Symbol.asyncDispose`; aceitar alternativa `try/finally { await vision.close(); }` como baseline mais portátil. Executável Python não pode vir de input HTTP/agent, usar allowlist + `spawn(cmd, args, { shell: false })`, handshake e limites de processos; falha `PYTHON_WORKER_UNAVAILABLE` com diagnóstico. O Node bridge só pode escrever no store TS via aplicação canônica e não acessa SQLite Python side.

## 2. API object model — ergonomia sem esconder semântica

```ts
// Modelagem conceitual; gerar/deduzir schemas dos contratos aceitos.
export type JobStatus = 'queued' | 'preparing' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'expired';

export type JobSubmit = {
  operation: 'vision.predict' | 'vision.embed' | 'dataset.audit' | 'eval.run' | 'model.train';
  params: Record<string, unknown>; // substituir por discriminated union versionada
  budget: { maxSeconds: number; maxUsdMicro: number; maxTokens?: number };
  idempotencyKey: string;
};

export type VisionLensClientConfig = {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  getAccessToken?: () => Promise<string> | string;
  timeoutMs?: number;
  retry?: { maxAttempts: number; maxElapsedMs: number };
};

export type VisionLensApi = {
  capabilities: { get(): Promise<Capabilities> };
  assets: { upload(file: Blob | File, opts?: UploadOptions): Promise<Asset> };
  jobs: {
    submit(request: JobSubmit): Promise<Job>;
    get(id: string): Promise<Job>;
    wait(id: string, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<Job>;
    events(id: string, options?: { after?: number; signal?: AbortSignal }): AsyncIterable<JobEvent>;
    cancel(id: string): Promise<Job>;
    result(id: string): Promise<JobResult>;
  };
  models: { list(query?: ModelQuery): Promise<Page<ModelDescriptor>> };
  datasets: { get(id: string): Promise<Dataset> };
  evaluations: { get(id: string): Promise<EvaluationRun> };
  artifacts: { download(id: string): Promise<Response | Blob> };
};
```

`Capabilities`, `Asset`, `Job`, `JobEvent`, `ModelDescriptor`, `Dataset`, `EvaluationRun` e `JobResult` acima dependem dos schemas canônicos existentes; o pseudo-TS omite suas definições por **não haver evidência** de que sejam equivalentes às definições locais. Não introduzir `Record<string,unknown>` como tipo estável para `params`: gerá-lo como discriminated union ao estabilizar `taskKind` e a avaliação de diferentes packs.

### 2.1 API ergonômica opcional

Após o contrato estar estável, aceitar atalhos que **só transformam input**:

```ts
client.vision.classify({ assetId, modelId, topK: 3 });
client.vision.detect({ assetId, modelId, minScore: 0.45 });
client.vision.ocr({ assetId, modelId, languageHint: 'pt-BR' });
client.video.count({ videoAssetId, modelId, crossingLine: [p1, p2] });
client.vision.retrieve({ queryAssetId, indexId, limit: 10 });
client.vision.segment({ assetId, modelId, mode: 'alpha' });
```

Todas essas chamadas são futuras e retornam `Job` assíncrono HTTP. Não criar `.diagnose()` para raio-X. O SDK não decide o modelo, license, safety policy nem threshold clínico implicitamente.

## 3. Organização de pacotes e build

```text
packages/sdk/                          # existing, preserve current exports
  package.json
  src/
    index.ts                          # exports atuais, snapshots de compatibilidade
    client/
      index.ts                        # only public browser/Node SDK exports
      client.ts                       # typed fetch wrapper; injected fetch
      auth.ts                         # token callback, safe header policy
      transport.ts                    # retries and timeouts
      events.ts                       # robust SSE parser with reconnection
      assets.ts                       # browser Blob/FormData, streamed options
      errors.ts                       # typed problem details
    node/
      index.ts                        # Node-only, opt-in, future
      worker-supervisor.ts            # child process, health, cancellation
      local-store-adapter.ts          # TS domain single-writer access
    generated/
      api.openapi.d.ts                # auto-generated, no hand edits
    legacy.ts                         # compatibility exports
  test/
    browser/
    node/
    contract/
```

`package.json` desired exports example (merge with existing, do not overwrite):

```json
{
  "name": "@vision-lens/sdk",
  "type": "module",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
    "./client": { "types": "./dist/client/index.d.ts", "import": "./dist/client/index.js" },
    "./legacy": { "types": "./dist/legacy.d.ts", "import": "./dist/legacy.js" },
    "./node": { "types": "./dist/node/index.d.ts", "node": "./dist/node/index.js" }
  },
  "sideEffects": false
}
```

`node` conditions must be *tested* in supported bundlers; adding only `node` may need `default`/explicit error stub for unsupported environments, depending resolver. `sideEffects:false` is correct only after a side-effect audit. Generated code should not be in manually maintained public `index.ts` if it causes import graph surprises. A future breaking root migration requires major + migration tool, not a casual alias change.

## 4. Typed HTTP from OpenAPI, not handwritten divergent clients

- Accept route schema on TS backend first (`packages/contracts` Zod and generated OpenAPI). Validate resulting OpenAPI specification structurally, check schema diff against previous version.
- Use `openapi-typescript` to emit path/types, optionally `openapi-fetch` or an intentionally small wrapper around `fetch` to implement transport; compare DX + runtime bundle rather than assume one library is essential.
- OpenAPI-generated **TypeScript types do not validate runtime JSON**. Parse critical status/discriminators/errors at runtime (reused shared Zod schemas or small generated validators) without dragging the full TS domain/store into browser bundle.
- TS `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` where compatible with mono-repo; no auto coercion of model outputs, binary masks or dates.
- Test OpenAPI generator drift in CI. Generated `.d.ts` never edited by hand; verification fails if a clean generator invocation changes git output.
- Browser cache optional: ETag/conditional GET for read endpoints; never cache private artifact URLs in public CDN by default.

## 5. Retry, request safety e AbortSignal

Default candidates (numbers subject to test): `maxAttempts=3`, `maxElapsedMs=30_000`, exponential backoff full jitter, honor `Retry-After` bounded. Retry GET/HEAD and `POST /v1/jobs` **only** with valid Idempotency-Key; never auto-retry `POST /v1/annotations/{id}/review` or model promotions. Treat 408/429/502/503/504 plus transport failures as retry candidates only when safe and server contract supports it. A 429 `Problem` includes retryable bool and optional `Retry-After`.

A per-request `AbortSignal` aborts HTTP attempt and pending backoff but never sends server cancellation implicitly. `wait` polls `GET /v1/jobs/{id}` with jitter and terminal condition; SSE is preferred for progressive UI, with fallback on unsupported proxies.

### 5.1 SSE/streaming authentication issue

Native browser `EventSource` cannot set arbitrary `Authorization` headers directly. Therefore prefer **`fetch` response streaming** to `GET /v1/jobs/{id}/events` with Bearer header and an SSE parser compatible with chunk boundaries (`event:`, `id:`, `data:`, comments, multiline data). On reconnection set `Last-Event-ID` header or accepted `after` cursor; never encode bearer token in URL. Cookies + CSRF are an independent authentication profile, not a shortcut.

SSE guarantees ordered events within a job only when read from a durable per-job seq log, not from ad-hoc Python stdout. Dedupe on `(jobId, seq)`; strict event size and JSON schema; heartbeat frames are not progress. If cursor expired return explicit `EVENT_CURSOR_EXPIRED` and recover via `GET job`, not infinite retry.

## 6. Assets and browser memory model

- `client.assets.upload(blob|file)` makes streaming/presigned upload over backend's approved flow. File names are untrusted labels; MIME from browser is an assertion, not proof.
- For files above simple-upload limit, use server-defined upload sessions (`POST /v1/assets/uploads`) and chunk/part hashes after separate ADR; do not buffer 4K video in memory.
- JavaScript `Blob` may represent bytes in-memory/on-disk; SDK must not call `.arrayBuffer()` unconditionally on large assets. Use `FormData` where appropriate or browser-native `fetch` body with explicit content type and length handling.
- Browser is forbidden to send filesystem path strings to backend. Node local path allowed only for explicitly local operation and bounded directory policy.
- Download returns scoped streaming handle/Response to avoid RAM explosion; optional helper `toBlob` for small payload and `saveToFile` Node-only adapter.

## 7. Runtime errors e types

Proposed error classes:

```ts
class VisionLensError extends Error {
  readonly code!: string;
  readonly requestId?: string;
  readonly status?: number;
  readonly retryable!: boolean;
}
class AuthenticationError extends VisionLensError {}
class AuthorizationError extends VisionLensError {}
class ValidationError extends VisionLensError {}
class VersionMismatchError extends VisionLensError {}
class BudgetExceededError extends VisionLensError {}
class ModelUnavailableError extends VisionLensError {}
class JobFailedError extends VisionLensError {}
class ArtifactIntegrityError extends VisionLensError {}
```

Wire problem implements RFC 9457 candidate + `code/requestId/retryable`; HTTP fetch failures get `TransportError` (no presumed job state). No English-language parsing; no `console.error()` containing token/full signed URL/body by default.

For result union, use `taskKind` as discriminator with exhaustive `switch` and `assertNever`; masks and embeddings are typed `ArtifactRef`, not giant arrays. TS `number` cannot represent arbitrarily large integer counters exactly: cap event `seq` to safe integer or serialize as string if unbounded, with explicit contract choice.

## 8. Compatibility, semver e distribution

- Root exports **existing** tested snapshot. `@vision-lens/sdk/client` experimental release can ship in same npm package under a minor *only if no existing subpath collision*. Otherwise new prerelease/major.
- `@vision-lens/sdk/legacy` added as alias with controlled deprecation; must not throw warnings on normal import in production unless migration policy decided.
- Use `exports` allowlist, `.d.ts`, ESM format, `files` allowlist, `npm pack --dry-run` and installation in external fixture consumer. Verify browser/Next.js bundling, Next server, Node maintained LTS and TS compiler minimum recorded.
- `@vision-lens/react` optional future hooks as **thin adapter to client and TanStack Query**, no requirement for core and not first milestone; no app-specific JSX inside general npm client.
- Auth examples show server-side token handling; browser token only scoped, short-lived, never hardcoded, not in `NEXT_PUBLIC_*` secrets.
- npm provenance and trusted publishing in CI, explicit release gates; include documented API vs SDK version compatibility matrix.

## 9. TS conformance and safety test plan

| Test group | Precise check |
|---|---|
| Type-level | tsc errors on wrong task params once union generated; strict nullability/unknown enum |
| Bundle | `/client` uses no `node:*`, `child_process`, `sharp`, `torch` or root `@vision-lens/core` transitive imports |
| Consumer | clean npm install, `import { VisionLensClient } .../client` Node; browser bundling; Next client/server fixtures |
| HTTP | injected mock `fetch`, auth provider, 202/Problem/Retry-After, timestamps/IDs, json schema runtime guard |
| Idempotency | duplicate POST same key/body => one job; changed body => 409; network drop after accepted request |
| Stream | arbitrary chunk boundary splits, UTF-8 split, multiline data, seq gap, reconnect, replay dedup |
| Local Node | worker timeout/crash/invalid JSONL/bridge version mismatch, no shell, one terminal event, cleanup |
| Migration | regression snapshots for root/legacy CLI exports and old TypeScript consumers |
| Model | CPU fixture equality with Python local/server, tolerance pinned by evaluator; artifact sha256 |
| Security | no access token in URL/log, malicious signed URL/SSRF protection, untrusted error details escaped |

## 10. Trade-offs, alternatives e exit criteria

**Alternative A — all-in TS with ONNX/WASM:** attractive for some inference/browser use cases, but not parity for training/many CV models; offer later as optional *backend implementation of selected models* with exact model digest, profiling and threshold gates, not a blanket replacement for Python.

**Alternative B — one npm SDK local-only:** breaks browser/remote/edge and couples shipping to heavy native dependencies. Rejected.

**Alternative C — completely separate packages `@vision-lens/client` and `@vision-lens/sdk`:** may reduce import graph, but creates compatibility and release overhead; keep subpath `/client` until `npm pack`/bundle smoke proves separation impractical.

**Definition of done TS:** browser/Node can call the same job API with typed results, bundled dependency surface small/isolated, old public exports preserved, network failures safe, conformance green, and Node-local bridge uses Python rather than duplicating ML.
