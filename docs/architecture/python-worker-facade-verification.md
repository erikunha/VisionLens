# The verification of the TypeScript facade over the Python worker

The record of the verification of the facade (VLN-006). Every claim below is a command, the exit
code it returned and the output it printed, on the machine and at the SHA named here. A summary
that says "passing" is not a record: the command is the evidence.

The facade itself is described in `docs/adr/021-python-worker-facade.md`, and the adapter it
wraps is described in `docs/architecture/vision-adapter.md`.

## The environment

| what | value |
|---|---|
| the machine | macOS 26.6.2 (Darwin 25.6.0), arm64, Apple M2 |
| Node | v24.22.1 |
| pnpm | 11.0.8 (the version the repository pins in `packageManager`) |
| Python (the virtual environment of the package) | 3.14.6 |
| torch / transformers | 2.15.0 / 4.57.6 |
| the branch | `feat/r1-ts-python-facade` |
| the base | `origin/main` at `4d5fb82` |
| the commit | `998cf6b` |
| the tree | `68c78487472abd74a6f4d8f89f14ca04adbda5d2` |
| the date | 2026-11-15 |

The commands below were run from the root of a worktree of the repository, and the Python ones
from the `python/visionlens` directory of that same worktree, unless the row says otherwise.

## 7.1 The facade against the real worker

The command drives the facade end to end: the route is on, the worker is launched as a module of
the Python package, the handshake completes, the request goes over the frozen channel, the
Python side writes the artifact, the facade validates it on disk and publishes a relative,
content addressed reference. The command lives in the repository
(`scripts/facade/embed-run.ts`) and resolves every path from its own location, so a reader runs it
without editing it and without the path of the machine that wrote it. The artifact is written
under a temporary root OUTSIDE the tree, and the root is removed when the command ends: the
evidence of the run is the output of the command, not a directory that accumulates on the machine
of the reader.

```bash
pnpm exec tsx scripts/facade/embed-run.ts
```

Exit 0. The output:

```text
{
  "embeddingRunId": "embed-4c951363162142908a41f956c863453c",
  "count": 6,
  "dimensions": 768,
  "dtype": "float32",
  "artifact": {
    "kind": "embedding",
    "relativePath": "artifacts/embedding/embed-4c951363162142908a41f956c863453c",
    "sha256": "4f706336517e10f7194963241c623af1d5039f4fc74fb3bc9c7479bfeaaf586a",
    "bytes": 18432
  },
  "transformFingerprint": "fp2:3e97408e9b0b5549",
  "contractVersion": "1.0.0",
  "protocolVersion": "1.0.0",
  "errorSamples": [],
  "runId": "run-ad48dd40-abca-48e1-b33f-861ae5a33c11",
  "transitions": ["queued", "running", "succeeded"]
}
```

What the output proves, row by row:

- `count` is 6 and `dimensions` is 768: the run embedded the six committed fixtures with the real
  siglip2-base model, on the CPU, over the channel.
- `artifact.relativePath` is RELATIVE: no absolute path of the machine crosses the boundary.
- `artifact.bytes` is 18432, which is 6 vectors of 768 float32 values: the byte count of the
  vectors is the one the manifest declares.
- `artifact.sha256` is `4f706336517e10f7194963241c623af1d5039f4fc74fb3bc9c7479bfeaaf586a`, and it
  is the address the LIBRARY run published over the same fixtures
  (`docs/architecture/vision-adapter-verification.md`, the section 6.1) and the address of the
  committed golden artifact (`benchmarks/parity/vision-embed.artifact/manifest.json`). The facade
  recomputed it from the manifest the Python side wrote, over the canonical JSON both languages
  agree on, and the three runs name the same content. The snapshot is part of the content, so the
  command embeds the snapshot of the golden artifact: a different snapshot is a different address,
  and an address that matches by accident would prove nothing.
- `embeddingRunId` and `runId` are fresh on every run: they name the run, not the content, and the
  content address above is the one that names the vectors.
- `errorSamples` is empty: the run refused no image, and the lineage of the row names the six
  assets the artifact was derived from.
- `transformFingerprint` is the `fp2:` form of the platform, over the encoder, the revision, the
  preprocessing and the snapshot.
- `transitions` is the lifecycle of the run: queued, running, succeeded. A terminal state is
  immutable, and the first outcome stands.

The suite drives the SAME path over the real worker, and it SKIPS when the machine has neither the
weights nor the virtual environment: `packages/core/tests/facade/python-integration.test.ts`. The
run of the suite embeds the snapshot `fixtures-2026-11-15`, and the snapshot is part of the
content, so that run publishes an address of its own and not the one recorded above.

```bash
PATH="$PWD/python/visionlens/.venv/bin:$PATH" pnpm exec vitest run packages/core/tests/facade/python-integration.test.ts
```

Exit 0. The output:

```text
 Test Files  1 passed (1)
      Tests  2 passed (2)
```

## 7.2 The gates of the increment

Every gate of the repository, at the commit named above.

| gate | command | exit | what it printed |
|---|---|---|---|
| lint | `pnpm run lint` | 0 | no finding |
| typecheck | `pnpm run typecheck` | 0 | `Tasks: 9 successful, 9 total` |
| the suite | `pnpm run test:coverage` | 0 | `Test Files 121 passed \| 1 skipped (122)`, `Tests 1413 passed \| 3 skipped (1416)` |
| the coverage of the facade | the same run | 0 | `facade 90.72% statements, 80.81% branches, 94.11% functions, 91.95% lines`; the repository `92.48% / 81.81% / 95.09% / 93.64%` against the thresholds of the config (`lines 75`, `functions 85`, `branches 75`) |
| the module boundary | `pnpm run check:boundaries` | 0 | `boundary check passed: LLM SDK, worker and facade violating fixtures caught, clean fixtures green` |
| the owner boundary | `pnpm run check:owner-boundaries` | 0 | `owner boundary check passed: 75 Python files import no TypeScript, 8 worker host files stay on the protocol, the visionlens.worker.v1 vocabulary is identical on both sides, and the self-proof fired on every planted violation` |
| the documentation drift | `pnpm run docs:check` | 0 | `ok: the documented makeConfig() matches the Config interface (55 fields, 53 in the fixture)` |
| the vendored container | `node scripts/check-docker-vendor.mjs` | 0 | `docker vendor check passed: docker/runtime/python/visionlens matches python/visionlens (wheel source subset)` |
| the schema of the manifest | `pnpm exec tsx scripts/benchmarks/generate-manifest-schema.ts --check` | 0 | `manifest schema is in sync with the Zod schema` |
| the Python suite | `uv run --group dev pytest tests -q` | 0 | `449 passed in 34.63s` |
| the types of the Python side | `uv run --group dev --extra vision --locked mypy src/visionlens` | 0 | `Success: no issues found in 37 source files` |
| the golden parity | `pnpm exec tsx scripts/benchmarks/vision-parity.ts` | 0 | `vision parity passed: the artifact and the golden file agree` |
| the registry parity | `pnpm exec tsx scripts/registry/parity-check.ts` | 0 | `registry parity passed: the two readers agree on every accept and every refusal` |
| the release gate | `python3 scripts/release_gate.py` | 0 | `steps: 14 passed, 0 failed, 0 not run` |

The release gate ran on a copy of the package in a temporary directory, because the gate packs the
tests into the sdist and the gate must not write into the tree:

```bash
rm -rf /tmp/vlgate-facade3 && cp -R python/visionlens /tmp/vlgate-facade3 && cd /tmp/vlgate-facade3 && python3 scripts/release_gate.py
```

## 7.3 The refusals, one by one

Each refusal was produced by the built bin or by the suite, and each carries a code, a retryable
flag and an exit code. The map is COMPLETE: the facade can answer with the eight codes it owns
and with the ten codes of the frozen vocabulary of the worker, and every one of them has a place
here.

The codes the facade owns (`packages/core/src/facade/errors.ts`, `OWN_CODES`):

| what | code | retryable | exit | where |
|---|---|---|---|---|
| the route is off | `ROUTE_DISABLED` | no | 3 | the command |
| the operation is not one the facade routes | `OPERATION_UNSUPPORTED` | no | 2 | the registry and the route |
| the request is invalid (no asset, no budget, no artifact root) | `REQUEST_INVALID` | no | 2 | the run and the route |
| the same key is already in flight | `RUN_IN_PROGRESS` | yes | 5 | the ledger |
| the worker could not be started | `WORKER_UNAVAILABLE` | no | 3 | the launch |
| the worker never answered its hello | `HANDSHAKE_FAILED` | yes | 3 | the launch |
| the bytes on disk do not match the manifest | `ARTIFACT_INVALID` | no | 5 | the artifact |
| the row was not committed | `STORE_WRITE_FAILED` | yes | 5 | the sink |

The codes the WORKER reports, with the exit code the facade assigns to them
(`WORKER_EXIT_CODES`) and the retryable flag of the frozen table
(`WORKER_ERROR_RETRYABLE`, `packages/contracts/src/worker/protocol.ts`):

| what the worker reported | code | retryable | exit | where |
|---|---|---|---|---|
| the protocol of the worker is not the one of the host | `UNSUPPORTED_PROTOCOL` | no | 4 | the channel |
| the build of the worker lacks the extra the model needs | `MISSING_EXTRA` | no | 4 | the worker |
| the payload is not the shape the operation promises | `MALFORMED_FRAME` | no | 5 | the bridge |
| the contract of the worker is not the one of the host | `PROTOCOL_MISMATCH` | no | 4 | the handshake |
| the worker does not serve the operation | `UNSUPPORTED_OPERATION` | no | 2 | the capability |
| the run was cancelled | `CANCELLED` | no | 5 | the channel |
| the budget of the request elapsed | `DEADLINE_EXCEEDED` | no | 5 | the channel |
| the budget of the request was exhausted | `BUDGET_EXCEEDED` | no | 5 | the channel |
| the worker died | `WORKER_CRASHED` | yes | 5 | the launch and the channel |
| the worker cannot reach the provider it needs | `PROVIDER_UNAVAILABLE` | yes | 3 | the worker |

The two refusals the command prints, from the built bin:

```bash
node packages/cli/dist/index.js python embed --snapshot snap-1 --asset a-1=images/red.jpg
```

Exit 3:

```text
[ROUTE_DISABLED] the python route is not enabled; set VISION_LENS_PYTHON_ROUTE=enabled to send this operation to the Python worker
```

```bash
node packages/cli/dist/index.js python embed --snapshot snap-1
```

Exit 2:

```text
[error] --asset is required: a run with no asset embedded nothing
```

The flag of a code the WORKER reported is never guessed: it is read from the frozen table
(`packages/contracts/src/worker/protocol.ts`, `WORKER_ERROR_RETRYABLE`), and the suite asserts
the ten codes one by one.

## 7.4 The review of the increment

The increment was reviewed by four specialists that ran in parallel, each with one lens: the
routing and the refusals, the security of the boundary, the cross language contract and the
truth of the documentation. The verdicts were FAIL on three lenses and FAIL on the fourth, and
the findings were fixed before the increment was pushed.

| finding | severity | what it was | what changed |
|---|---|---|---|
| a symlinked FILE inside the artifact directory escaped the approved root | blocker | the guard proved the DIRECTORY was inside the root and the files were read through the unresolved path | the files are read through the resolved path and opened with `O_NOFOLLOW`, and the directory is resolved before the files are read |
| the child inherited the whole environment of the host | major | the worker received the keys of a paid provider | the child inherits an allowlist, and the configuration of the worker travels by name |
| the artifact root was validated AFTER the worker ran | major | a route without a root ran the whole embedding and refused at the end | the route is checked before the process is launched |
| the legacy path read new environment variables, and a new variable could break every legacy command | major | the route was resolved inside `loadConfig` | the legacy path does not resolve the route at all |
| the facade carried a WEAKER copy of the manifest contract | major | it accepted a manifest the validator the repository ships refuses | the facade calls `validateEmbeddingManifest` and `embeddingContentDigest` |
| the facade could not launch the worker at all | blocker | `scriptArgs` was never plumbed and the host resolved the script against the working directory, where the package ships no `worker.py` (the worker is the module `python/visionlens/src/visionlens/worker.py`) | the launch defaults to `python3 -m visionlens.worker` |
| an operation the facade does not route was refused with the code of the route | major | two codes for one condition | the two refusals are different facts and carry different codes |
| the retryable flag of `WORKER_UNAVAILABLE` was a guess | major | every launch failure was retryable | the kind of the failure decides the flag, and the codes of the worker keep the flags of the frozen table |
| the port threw instead of answering a typed outcome | major | an invalid request raised an exception | the port answers a refusal |
| the artifact of a run was never tied to the assets of the request | major | the manifest could name other assets | the facade computes the digests of the assets it asked for and compares them |
| the error samples of a run were parsed and thrown away | major | a run that refused five of six images was reported as a success | the result carries the samples, and the lineage names only the images the artifact was derived from |
| the fixture of the test claimed a provenance it did not have | major | the fixture was fabricated | the fixture is the golden artifact of the repository, written by the Python side |
| the request fingerprint was order insensitive while the worker pairs by position | major | a reordered request was the same run | the assets are fingerprinted in the order of the request |
| the rule of the boundary did not name the barrel of the core | minor | a facade could reach the store through the barrel | the rule names the barrel and the gate plants a fixture for it |
| the transition history could be forged | minor | the array was handed out by reference | the history is a copy |
| a code of the published vocabulary was never produced | minor | `NO_PAID_FALLBACK` named a policy that has no path | the code is gone, and the policy is stated in the ADR |

### 7.4.1 The second pass, over the gates and over the record

The four specialists reviewed the implementation. A second pass, over the gates and over this
record, found four more things, and every one of them was a fact the record itself carried wrong.

| finding | severity | what it was | what changed |
|---|---|---|---|
| the suite of the facade did not typecheck | blocker | the fake worker of the adapter declared a request of its own shape, and the gate that covers the suite of the facade was a cache hit that hid it | the fake takes the input the worker client takes, and the gate the test opens by hand is a plain function |
| the command of the record lived outside the repository | major | the verification cited a script in a temporary directory, so a reader could not run it | the command is `scripts/facade/embed-run.ts`, it resolves every path from its own location and it carries no path of a machine |
| the address of the run was not the address of the library | major | the run embedded the snapshot `fixtures-2026-11-15` and the golden artifact carries `fixtures-2026-11-14`, and the snapshot is part of the content | the command embeds the snapshot of the golden artifact, and the run publishes `4f706336517e10f7194963241c623af1d5039f4fc74fb3bc9c7479bfeaaf586a`, the address the library published and the address of the committed golden artifact |

### 7.4.2 The third pass, over the increment and over the record

Three specialists reviewed the increment with three lenses: the truth of the documentation, the
code and the security of the new command, and the claims of the pull request. The verdicts were
PARTIAL on the first, PASS on the second and FAIL on the third. Every finding below was fixed
before the increment was pushed, and every fix carries its own guard.

| finding | severity | what it was | what changed |
|---|---|---|---|
| the map of the refusals was not complete | major | the map named the eight codes of the facade and two of the worker, and the facade can answer with all ten codes of the frozen vocabulary, including the only codes of the exit 4 | the map of the record carries the eighteen codes, and the codes of the worker are separated from the codes of the facade |
| the facade reached a module of the adapter that the boundary did not name | major | the facade imports the contract of the manifest, and neither the boundary table nor the owner map named it | the boundary names the contract of the manifest, the rule of the facade refuses every other module of the adapter, and the gate enumerates the modules of the adapter and proves that every one of them but the contract is refused |
| the pull request said that the adapter did not change | major | the adapter of the Python package changed in this increment, to serve the recorded shape | the pull request says what did not change, and the change of the adapter is named |
| the environment of the record named the pnpm of the machine | minor | the pnpm that runs the gates is the one the repository pins (`packageManager`), and the record had named another | the table names `11.0.8`, the pinned version |
| the thresholds of the coverage were four, and there are three | minor | the config carries `lines 75`, `functions 85` and `branches 75`, and the record listed a threshold of statements that does not exist | the table names the three thresholds of the config |
| the format `none` was advertised and not implemented | minor | the help of the command and the README offered `pretty`, `json` and `none`, and every format but `json` printed the summary | the format `none` prints nothing, the decision is a pure function and the suite asserts it |
| the environment of the command was not complete | minor | the README listed the variables of the route and not the variable that names the interpreter of the worker | the table names `VISION_LENS_WORKER_INTERPRETER` |
| the vocabulary of the jobs has seven states | minor | the ADR said six, and the vocabulary carries seven since the migration that added `cancel_requested` | the ADR says seven |
| the run of the suite was not the run of the record | minor | the sentence said the same run, and the suite embeds a snapshot of its own | the sentence says that the suite drives the same path and publishes an address of its own |
| the command left a temporary directory on every run | minor | the root of the artifact was never removed, and a failed run left one that looked like the evidence of a run that worked | the root is removed when the command ends, on the failure path too |
| the command did not say what the environment it needs is | minor | without the virtual environment the run answered with a refusal that named a capability, and the reader had no way to know what to create | the command checks the environment before the run and names the command that creates it |
| the root of the artifact was not checked against the tree | minor | the root came from the temporary directory of the environment, and a machine whose TMPDIR points inside the working directory would have written the evidence into the tracked tree | the command refuses to run when the root is inside the repository |

## 7.5 What the increment did NOT prove

- The idempotency key holds WITHIN one process. The ledger is in memory, so two invocations of
  the CLI are two runs. A durable key is a store table, which is the migration the job queue
  needs.
- The domain row does not carry the content address. The entity `DerivedArtifact` is frozen and
  has no field for a digest or a path, and adding one is a breaking change of the contract
  surface. The address lives in the result envelope, in the run record and in the output of the
  command.
- The run record is not durable. The shipped store has no jobs table, so the run lives in the
  facade and the widening of the job vocabulary is a separate ticket with a numbered migration.
- Only one operation is routed. `vision.predict` and the other codes of the wire stay
  unreachable from TypeScript.
- No run wrote a row into a REAL store. The sink of the facade is exercised with a fake, and the
  command that supplies the real one was never driven against a migrated database: the store
  wants the lineage of the row to exist first, and no fixture of this increment creates an asset
  and a snapshot for it.
- The run was measured on one machine, on the CPU, with one model. There is no accelerator in the
  matrix and no calibration of the embeddings. The latency of the ADAPTER over the same six
  fixtures is recorded in `docs/architecture/vision-adapter-verification.md`, and it is the
  latency of one machine on one day; the facade run of this record carries no latency number of
  its own.
