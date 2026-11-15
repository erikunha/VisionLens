/**
 * `vision-lens python embed` — run the `vision.embed` operation on the Python
 * worker (VLN-006).
 *
 * ## What the command does
 *
 * It asks the facade for an embedding of a snapshot, and it prints the typed
 * outcome. The command itself decides nothing about the route: the route is
 * an explicit opt in of the configuration, and a route that is off refuses
 * the run with the code `ROUTE_DISABLED` and the name of the key that turns
 * it on. There is no fallback to a paid provider: a run that failed stops
 * there.
 *
 * ## The flags
 *
 *  - `--snapshot <id>` — the snapshot the run belongs to. Required.
 *  - `--asset <id>=<path>` — one asset to embed, repeatable. The id is the
 *    id of the asset in the store, and the path is where its bytes live,
 *    relative to the approved root of the worker. At least one is required.
 *  - `--model <name>` — the encoder to run. Defaults to `siglip2-base`.
 *  - `--workspace <id>` — the workspace of the run. Defaults to `local`.
 *  - `--artifact-root <dir>` — the root the worker writes its artifacts
 *    under. Defaults to the environment.
 *  - `--max-seconds <n>` — the wall-clock ceiling of the run.
 *  - `--route <value>` — `enabled` or `disabled`. Defaults to the
 *    environment.
 *  - `--idempotency-key <key>` — the key that makes the run idempotent.
 *  - `--db <path>` — the store the artifact row is written to. Without it
 *    nothing is written and the command says so.
 *
 * ## The store is imported DYNAMICALLY
 *
 * `better-sqlite3` is an OPTIONAL dependency of `@vision-lens/core` and the
 * row is written only when the operator names a store, so the command loads
 * the store only when it is asked for.
 */
import type { FacadeArtifactCommit, FacadeEmbeddingOutcome } from '@vision-lens/core/facade';
import { FacadeError, PythonWorkerAdapter } from '@vision-lens/core/facade';
import { resolvePythonRouteConfig } from '@vision-lens/core/config';
import { logger } from '@vision-lens/core/utils/logger';

/** One asset of the run, as the flag carries it. */
export interface PythonEmbedAsset {
  /** The id of the asset in the store. */
  readonly assetId: string;
  /** Where the bytes of the asset live. */
  readonly path: string;
}

/** Options of the `python embed` command. */
export interface PythonEmbedCommandOptions {
  /** The snapshot the run belongs to. */
  readonly snapshotId: string;
  /** The assets to embed. */
  readonly assets: readonly PythonEmbedAsset[];
  /** The encoder to run. */
  readonly model?: string;
  /** The workspace of the run. */
  readonly workspaceId?: string;
  /** The root the worker writes its artifacts under. */
  readonly artifactRoot?: string;
  /** The root the worker resolves the paths of the assets against. */
  readonly assetRoot?: string;
  /** The wall-clock ceiling of the run, in seconds. */
  readonly maxSeconds?: string;
  /** The route, `enabled` or `disabled`. */
  readonly route?: string;
  /** The key that makes the run idempotent. */
  readonly idempotencyKey?: string;
  /** The store the artifact row is written to. */
  readonly dbPath?: string;
  /** The output format of the command. */
  readonly outputFormat?: string;
}

/** The default encoder of the route. */
export const DEFAULT_PYTHON_EMBED_MODEL = 'siglip2-base';

/**
 * Parses the `--asset` flags.
 *
 * The flag carries the id of the asset and where its bytes live, separated
 * by an equals sign. A flag that carries no id or no path is refused here,
 * before the worker is asked: an asset that cannot be named cannot be
 * embedded, and the refusal names the flag.
 */
export function parseAssetFlags(flags: readonly string[]): PythonEmbedAsset[] {
  return flags.map((flag) => {
    const separator = flag.indexOf('=');
    const assetId = separator === -1 ? '' : flag.slice(0, separator).trim();
    const assetPath = separator === -1 ? '' : flag.slice(separator + 1).trim();
    if (assetId.length === 0 || assetPath.length === 0) {
      throw new Error(
        `[error] --asset expects an id and a path separated by "=" (got: ${flag})`,
      );
    }
    return { assetId, path: assetPath };
  });
}

/** The lines the command prints for a successful run. */
export function formatPythonEmbedSummary(outcome: {
  readonly embeddingRunId: string;
  readonly count: number;
  readonly dimensions: number;
  readonly dtype: string;
  readonly artifact: { readonly relativePath: string; readonly sha256: string; readonly bytes: number };
  readonly transformFingerprint: string;
}, options: { readonly written: boolean }): string[] {
  return [
    `embedding run:   ${outcome.embeddingRunId}`,
    `count:           ${outcome.count}`,
    `dimensions:      ${outcome.dimensions}`,
    `dtype:           ${outcome.dtype}`,
    `artifact:        ${outcome.artifact.relativePath}`,
    `artifact sha256: ${outcome.artifact.sha256}`,
    `artifact bytes:  ${outcome.artifact.bytes}`,
    `transform:       ${outcome.transformFingerprint}`,
    `artifact row:    ${options.written ? 'written' : 'not written (no --db)'}`,
  ];
}

/**
 * Runs the command and answers the exit code of the process.
 *
 * The exit codes of the facade are its own: 0 for a success, 2 for a
 * validation refusal, 3 for an unavailable dependency, 4 for a policy
 * refusal and 5 for a runtime failure. The legacy exit codes of the other
 * commands are untouched.
 */
export async function runPythonEmbed(options: PythonEmbedCommandOptions): Promise<number> {
  const route = resolvePythonRouteConfig({
    ...(options.route === undefined ? {} : { pythonRoute: options.route }),
    ...(options.workspaceId === undefined ? {} : { pythonWorkspace: options.workspaceId }),
    ...(options.artifactRoot === undefined
      ? {}
      : { pythonArtifactRoot: options.artifactRoot }),
    ...(options.assetRoot === undefined ? {} : { pythonAssetRoot: options.assetRoot }),
    ...(options.maxSeconds === undefined ? {} : { pythonMaxSeconds: options.maxSeconds }),
  });

  const store = options.dbPath === undefined ? undefined : await storeSink(options.dbPath);
  const adapter = new PythonWorkerAdapter({
    route,
    ...(store === undefined ? {} : { sink: store.sink }),
  });

  try {
    const outcome: FacadeEmbeddingOutcome = await adapter.runEmbedding({
      snapshotId: options.snapshotId,
      assets: options.assets,
      model: options.model ?? DEFAULT_PYTHON_EMBED_MODEL,
      workspaceId: route.workspaceId,
      budget: { maxSeconds: route.maxSeconds, maxUsdMicro: 0 },
      idempotencyKey: options.idempotencyKey ?? `embed-${options.snapshotId}`,
    });

    if (!outcome.ok) {
      logger.error(`[${outcome.error.code}] ${outcome.error.message}`);
      return outcome.error.exitCode;
    }

    if (options.outputFormat === 'json') {
      console.log(JSON.stringify(outcome.result, null, 2));
      return 0;
    }
    for (const line of formatPythonEmbedSummary(outcome.result, {
      written: options.dbPath !== undefined,
    })) {
      console.log(line);
    }
    return 0;
  } finally {
    store?.close();
  }
}

/**
 * The sink that writes the artifact row through the store.
 *
 * The facade never touches the database: the row is written by the
 * repository of the store, and the store stays the only writer of the
 * domain. The store is imported dynamically because the native driver is an
 * optional dependency.
 */
async function storeSink(dbPath: string): Promise<{
  sink: { commit: (commit: FacadeArtifactCommit) => Promise<void> };
  close: () => void;
}> {
  const { DerivedArtifactsRepository, newEntityId, openMigratedStore } = await import(
    '@vision-lens/core/store'
  );
  const store = await openMigratedStore(dbPath);
  const artifacts = new DerivedArtifactsRepository(store.db);
  return {
    sink: {
      async commit(commit: FacadeArtifactCommit): Promise<void> {
        try {
          artifacts.insert({
            id: newEntityId(),
            kind: commit.kind,
            sourceAssetIds: [...commit.sourceAssetIds],
            sourceSnapshotId: commit.sourceSnapshotId,
            transform: commit.transform,
            transformFingerprint: commit.transformFingerprint,
            createdAt: new Date().toISOString(),
          });
        } catch (error) {
          // A row the store REFUSES because the lineage does not exist is a
          // validation refusal and not a runtime failure: the caller has to
          // fix the ids, and no retry changes them.
          if ((error as { name?: string }).name === 'StoreValidationError') {
            throw new FacadeError('REQUEST_INVALID', String((error as Error).message), {
              cause: error,
            });
          }
          throw error;
        }
      },
    },
    close: () => store.close(),
  };
}
