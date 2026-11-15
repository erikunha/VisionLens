# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Monorepo foundation (spec 001, `feat/visual-lens`): pnpm workspaces + Turborepo —
  `packages/{core,cli,sdk,contracts}`, `apps/{api,studio}` placeholders, `services/{vision,training,agents}`
  Python skeletons; the vitest suite and root configs now run from the workspace root.
- `vision-lens` canonical bin in `@vision-lens/cli`.
- `@vision-lens/sdk` `./cli` programmatic entry (re-export of the CLI Commander program; importing it
  executes the CLI — same semantics as the pre-migration `./cli` export).
- ESLint boundary enforcement: LLM provider SDKs are rejected outside
  `packages/core/src/analyzer/providers/**` (`no-restricted-imports`; documented carve-out for
  `embeddings.ts` text-embedding SDKs) with `pnpm run check:boundaries` as an executable proof.
- Per-package `lint` and positionally-scoped `test` scripts for every workspace package.
- This CHANGELOG.

### Changed

- Renamed to Vision Lens: the product name is now **Vision Lens** and the npm scope is
  `@vision-lens`, across all six packages (`cli`, `contracts`, `core`, `sdk`,
  `api-placeholder`, `studio-placeholder`).
- The canonical CLI bin is now `vision-lens`; the previous short-form bin is removed (it was never published).
- The environment variable prefix is now `VISION_LENS_` (`VISION_LENS_DATASETS_DIR`,
  `VISION_LENS_BENCHMARK_MODEL`).
- The store home is now `VISION_LENS_HOME`, defaulting to `~/.vision-lens/store.db`.
- The applied migration files (`0001_init.sql`, `0002_legacy_import.sql`) are deliberately
  **unchanged** by the rename: the runner hashes their raw bytes into the store's migration
  ledger, so even a comment-only edit would make every store created before it unopenable. Their
  header comments therefore still mention the previous product name.
- Engines requirement raised to Node >= 20 across the root and all workspace packages
  (commander 14 requires Node 20).
- CI: least-privilege `permissions: contents: read`; CI now also runs on `feat/**` branch pushes.
- Help-parity bin tests and CLI test scripts received explicit timeouts (no more 5 s default flakes
  in coverage mode).

### Removed

- The legacy compatibility bin of the earlier CLI name, with its deprecation warning and its
  `VISION_LENS_NO_DEPRECATION` escape hatch. The CLI package was never published to npm, so no
  published consumer is affected; the canonical `vision-lens` bin is unchanged.
- Root-level `tests/` tree (migrated into `packages/*/tests/` and `apps/*/tests/`).
- Dead `pnpm.onlyBuiltDependencies` block from the root `package.json` (native build approvals live
  in `pnpm-workspace.yaml` `allowBuilds`).
