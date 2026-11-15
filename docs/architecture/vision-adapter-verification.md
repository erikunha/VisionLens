# The verification of the CPU vision adapter

The record of the verification of the CPU vision adapter (VLN-005, story 6).
Every claim below is a command, the exit code it returned and the output
it printed, on the machine and at the SHA named here. A summary that says
"passing" is not a record: the command is the evidence.

The adapter itself is described in `docs/architecture/vision-adapter.md`,
and the decision that a run which embedded nothing is not a run is in the
amendment of 2026-11-14 of `docs/adr/011-python-first-ml-runtime.md`.

## The environment

| what | value |
|---|---|
| the machine | macOS 26.6.2 (Darwin 25.6.0), arm64, Apple M2 |
| Node | v24.22.1 |
| pnpm | 11.0.8 |
| Python | 3.14.6 |
| torch / transformers / Pillow / safetensors | 2.15.0 / 4.57.6 / 13.0.0 / 0.8.0 |
| the branch | `feat/r1-vision-runtime` (the sections 6.1 to 6.7), `feat/r1-ts-python-facade` (the section 6.8) |
| the base | `origin/main` at `5d8c1de` (the sections 6.1 to 6.7), `4d5fb82` (the section 6.8) |
| the tree | `ffc0fa76494458eb39057e14f22e948d470d9b59` (the sections 6.1 to 6.7), `c3fb246e44aa49ee9979effca96046780e459094` (the section 6.8) |
| the date | 2026-11-14 |

The commands below were run from the root of a worktree of the repository, and the Python ones
from the `python/visionlens` directory of that same worktree, unless the row says otherwise.

## 6.1 The CPU run, end to end

The command runs the REAL model over the committed fixtures, writes the artifact into a
temporary directory, reads it back and compares it with the committed golden set. It never
writes into the tracked golden file or the tracked artifact: the golden is the pinned fact, and
a verification run that edited the thing it verifies would prove nothing.

```bash
cd python/visionlens && uv run --extra vision --group dev python scripts/verify_vision_run.py
```

Exit 0. The output:

```text
images: 6
count: 6
dimension: 768
dtype: float32
device: cpu
errors: 0
cold artifact digest: 4f706336517e10f7194963241c623af1d5039f4fc74fb3bc9c7479bfeaaf586a
warm artifact digest: 4f706336517e10f7194963241c623af1d5039f4fc74fb3bc9c7479bfeaaf586a
artifact digest: 4f706336517e10f7194963241c623af1d5039f4fc74fb3bc9c7479bfeaaf586a
artifact digest on disk: 4f706336517e10f7194963241c623af1d5039f4fc74fb3bc9c7479bfeaaf586a
vectors file digest: 0859460709829bae5db526776df2dbfcc96492055b3134a2da4f2793aa8445a8
vectors digest of the set: 33cf54e30375a47dd703e25cbc1369b441ceffc911ba8c5fac2950966a12670c
vectors digest of the golden: 33cf54e30375a47dd703e25cbc1369b441ceffc911ba8c5fac2950966a12670c
preprocessing fingerprint: fp2:83adc4ef99979644
config fingerprint: fp2:a81b8074dbee1eb8
tolerance: {
  "maxAbsoluteDifference": 0.001,
  "minCosineSimilarity": 0.9999,
  "reason": "measured on the CPU run of 2026-11-14: the same images embedded in one batch and one image at a time differ by at most 1.383e-05 with a cosine similarity of at least 1.000000000. The bound carries a margin of an order of magnitude over the measured variation, and widening it is a visible diff."
}
peak memory bytes: 758071296
latency (warm run): {"count": 6, "p50Ms": 534.589, "p95Ms": 534.589, "totalMs": 3207.532}
runtime versions: {"pillow": "13.0.0", "safetensors": "0.8.0", "torch": "2.15.0", "transformers": "4.57.6"}
the run is green: the artifact on disk carries the digest its manifest names, and the vectors are the golden ones
```

What the output proves, row by row:

- the run is GREEN end to end: six images embedded, 768 dimensions, `float32`, on the CPU, with
  no error sample;
- the artifact ON DISK carries the digest its OWN manifest names
  (`4f706336517e10f7194963241c623af1d5039f4fc74fb3bc9c7479bfeaaf586a` in both places);
- the COLD run and the WARM run carry the SAME digest: the digest is the address of the
  content, and the run id, the timestamp and the latency are not part of it;
- the vectors of this run are the vectors of the committed golden set, digest for digest.

The spec asks for the five committed fixtures; the tree carries SIX of them
(`packages/core/tests/fixtures/images/`), and the recorded run embedded the six. The count in
the record is the count of the run.

The latency and the peak memory of this run are the WARM ones: the first run of the script
pays for the load of the model, and the second one is the run that is quoted. Both are
measurements of THAT run and neither is part of the artifact digest, so a run on another
machine, or on a machine that was busy, reports its own numbers and the same digest. The recorded measurement of the adapter
(`docs/architecture/vision-adapter.md`) carries 543 ms per image and 3.3 s for the six; this run
measured 534.6 ms per image and 3.21 s for the six. The SAME script measured 1169 ms per image
while another suite was running on the same machine, and 881.9 ms on a machine that was busy
with another run, which is the honest measure of how much the load of the machine moves the
number. The latency is NOT part of the artifact digest, so
every one of those runs agrees on the content and differs on the speed, exactly as the design
says.

## 6.2 The three parity tiers, in both languages

```bash
pnpm exec tsx scripts/benchmarks/vision-parity.ts
```

Exit 0:

```text
config-fingerprint: ok
manifest: ok
vectors: ok
images: 6
tolerance: 0.001 / 0.9999
vision parity passed: the artifact and the golden file agree
```

The Python side reads the same golden file, so a change on one side alone breaks one of the
two runs:

```bash
cd python/visionlens && uv run --group dev pytest tests/test_vision_parity.py tests/test_fingerprint_parity.py -q
```

Exit 0 (23 passed). The generated manifest schema is in sync with the Zod schema the
TypeScript side validates with:

```bash
pnpm exec tsx scripts/benchmarks/generate-manifest-schema.ts --check
```

Exit 0: `manifest schema is in sync with the Zod schema`.

The two readers of the registry agree on every accept and every refusal:

```bash
pnpm exec tsx scripts/registry/parity-check.ts
```

Exit 0:

```text
cases: 257
outcome disagreements: 0
naming differences: 8
registry parity passed: the two readers agree on every accept and every refusal
```

The eight naming differences are the ones the two readers document in
`docs/architecture/model-registry.md`: they are the difference between the path the file uses and
the field the reader names, and they never change an outcome.

## 6.3 The failure matrix

```bash
cd python/visionlens && uv run --group dev pytest tests/test_failure_modes.py -q
```

Exit 0 (16 passed). The matrix is one row per failure path. Every row asserts ONE
typed refusal: the rows that go through the library assert a typed error of the library
vocabulary, and the rows that go through the loader assert the reason of the refusal, which is
the code of the gate that refused. The rows that run the embedder also assert that a failed
run published no artifact, and the last row asserts that the process is still serving.

| the failure | the row | the code |
|---|---|---|
| a corrupt image | an error sample that names the file, and the other images still embed | `IMAGE_METADATA_UNREADABLE` |
| a pixel bomb | refused before the pixels are allocated | `IMAGE_DIMENSIONS_EXCEEDED` |
| a MIME mismatch | the magic bytes contradict the name of the file | `MIME_MISMATCH` |
| missing weights | no permission was granted, and no byte moved | `PERMISSION_MISSING` |
| a digest mismatch | the refusal names BOTH digests | `DIGEST_MISMATCH` |
| an unsupported device | the reason names the device | `UNSUPPORTED_DEVICE` |
| an out of memory | a bounded back off and then a typed refusal | `RESOURCE_EXHAUSTED` |
| a traversal attempt | the path leaves the approved root | `PATH_OUTSIDE_ROOT` |
| a symlink escape | the resolved path leaves the approved root | `PATH_OUTSIDE_ROOT` |
| a pickle attempt | the checkpoint is not safetensors | `UNSAFE_FORMAT` |
| a run in which every image was refused | ONE typed error, and no artifact | `EMBEDDING_RUN_EMPTY` |
| a run that carried no image at all | ONE typed error, and no artifact | `EMBEDDING_RUN_EMPTY` |
| an encoder that answers with fewer vectors | the run is refused, and no artifact | `MODEL_RUN_FAILED` |

The two rows of the run that embedded nothing are the ones that changed the behaviour of the
adapter: a run in which every image was refused used to write an empty artifact and answer with
a success, and a run that carried no image at all did the same. The decision is in the
amendment of 2026-11-14 of `docs/adr/011-python-first-ml-runtime.md`, and the test that
asserted the old behaviour was split in two, with the reason in the commit.

The last row closes the other half of the same hole: an encoder that answers with fewer
vectors than the run prepared is a refusal and not a short answer, and the run that carries it
publishes no artifact either.

## 6.4 Every executed run

Every gate of the tree, with the command that ran it and the exit code it returned. The output
artifact of each one is the console output quoted above or the file it names.

| Gate | Command | Exit |
|---|---|---|
| Python suite | `cd python/visionlens && uv run --group dev pytest tests -q` | 0 (424 passed with the `vision` extra installed; the CI runs it without the extra and reports 423 passed and 1 skipped) |
| Python types | `cd python/visionlens && uv run --group dev --extra vision mypy src/visionlens` | 0 (36 files, no issues) |
| Node suite | `pnpm exec vitest run` | 0 (111 files, 1302 passed, 3 skipped) |
| Lint | `pnpm run lint` | 0 |
| Type check | `pnpm run typecheck` | 0 (9 of 9 tasks) |
| Boundary check | `pnpm run check:boundaries` | 0 |
| Owner boundary check | `pnpm run check:owner-boundaries` | 0 (72 Python files, 8 worker host files) |
| Doc drift | `pnpm run docs:check` | 0 |
| Container vendor | `node scripts/check-docker-vendor.mjs` | 0 |
| Vision parity | `pnpm exec tsx scripts/benchmarks/vision-parity.ts` | 0 (3 tiers) |
| Registry parity | `pnpm exec tsx scripts/registry/parity-check.ts` | 0 (257 cases, 0 disagreements) |
| Manifest schema | `pnpm exec tsx scripts/benchmarks/generate-manifest-schema.ts --check` | 0 |
| The CPU run | `cd python/visionlens && uv run --extra vision --group dev python scripts/verify_vision_run.py` | 0 |
| Release gate | `cd python/visionlens && python3 scripts/release_gate.py` | 0 (14 passed, 0 failed, 0 not run) |

The evidence file of the release gate is written under `python/visionlens/release/gate/`, and
that directory is ignored by the repository because the records embed machine-local paths. The
run of this record was made on a COPY of the package in a temporary directory, so the evidence
artifact of that run is a machine-local path and is not committed. The gate printed:

```text
visionlens release gate, started 2026-11-14T22:25:46+00:00
[PASS] build: visionlens-0.1.0-py3-none-any.whl + visionlens-0.1.0.tar.gz
[PASS] metadata-validation
[PASS] artifact-scan: no checkpoint, dataset, credential or absolute path
[PASS] clean-venv-install (wheel): node on PATH: absent
[PASS] clean-venv-install (sdist): node on PATH: absent
[PASS] extras-resolution [vision]
[PASS] extras-resolution [training]
[PASS] extras-resolution [agents]
[PASS] extras-resolution [server]
[PASS] extras-resolution [all]
[PASS] extras-resolution [all combined]
[PASS] release-records
[PASS] lock-compatibility: lock pins satisfy the published pyproject ranges
[PASS] dependency-scan: 0 finding(s) recorded with severity; none blocking

steps: 14 passed, 0 failed, 0 not run
```

The gate prints one line after the summary: it names the evidence artifact, whose path is the
machine-local path of the copy the run was made on. That line is not quoted here, because a
tracked document carries no path of a machine.

## 6.5 The review pass

The surfaces this ticket may not touch, and the command that shows they were not touched:

```bash
git diff --name-only origin/main...HEAD -- \
  packages/core/src/analyzer \
  packages/core/src/store/migrations \
  packages/contracts/src/entities \
  packages/contracts/src/openapi \
  docs/vnext
```

The output is EMPTY: the analyzer, the migrations, the entity schemas of the contract package,
the OpenAPI snapshot and the tracked pack files are exactly as the base left them.

The Python side of the platform is what changed, and the TypeScript side of the domain is what
did not: the store stays the sole domain writer, and the commit of the derived artifact lives
in `packages/core/src/adapter/embedding-commit.ts` with its own suite.

## 6.6 What is NOT proven

The record states the unverified parts as plainly as the verified ones:

- the platform has NOT run the model on a GPU. This ticket is the CPU reference path, the
  device planner admits the CPU only and refuses an accelerator this build does not run, and
  every number above is a CPU number;
- the embeddings are NOT calibrated. The record says `uncalibrated`, no calibrator was fitted,
  and the similarities of the model are not probabilities;
- the golden vectors are a comparison of the manifest, of the fingerprint and of the vectors
  against a committed file. They are NOT a two-language encoder comparison: the TypeScript side
  of this platform embeds TEXT, not images, so the encoder of this ticket is the Python one and
  the golden file pins what it produced;
- the `latencyCostProfile` of the record is still `unknown`: the runs above measured a latency
  and the record was not rewritten with it;
- the throughput numbers are the numbers of ONE machine on ONE day, and the load of the machine
  moves them: the same six images measured 543 ms per image on the recorded run, 555.7 ms on an
  534.6 ms on the verification run of this document, 881.9 ms on a busy machine, and 1169 ms
  while another suite was running;
- the provenance of the pinned weights digest is the LFS oid the model hub reports for the
  pinned revision. It was not verified against a second independent source;
- the network guard was exercised against a local listener and against the worker process, and
  NOT against the real repository: the fetch of the weights was never performed inside a
  guarded worker in this ticket, because the weights were already in the cache;
- the guard does NOT reach a SUBPROCESS that EXECS, because an exec replaces the patched
  process with a new one. A FORK inherits the patched socket layer, so the child refuses the
  network too, and it starts with no allowance of its own. The isolation of a worker that must
  not reach the network is the sandbox that runs it, and the guard is the in-process defense
  inside that sandbox;
- the guard does NOT reach a RAW socket of the C module that was created before it was
  installed. A socket of the Python class that was created before is refused, because the patch
  lives on the class and the class is looked up at the moment of the call;
- the adapter does NO OCR and extracts no text. The text of a file is dropped by the decoder
  and the input of the model accepts numbers only, so no text of an image is ever read, let
  alone obeyed.

## 6.7 The documents that name the shipped adapter

- the roadmap entry of VLN-005 names the adapter, the single-writer commit, the failure paths
  and this record (`ROADMAP.md`);
- `docs/adr/011-python-first-ml-runtime.md` carries the amendments of 2026-11-14 that decided
  the packaging, the device planner, the network guard and the empty run;
- `docs/architecture/vision-adapter.md` describes the pipeline, the refusals, the bridge, the
  failure matrix and the recorded run;
- `docs/architecture/python-owner-map.md` names the modules that moved to Python and the
  boundaries they stand behind;
- the pack files under `docs/vnext/` were NOT edited: they are the verbatim source of the
  requirements, and this ticket changed no line of them.

## 6.8 The recorded run over the worker channel

The adapter was a library until the increment of this section: the run existed, it was measured
and it was committed by the TypeScript side, and nothing in the worker reached it. The worker
served only the SIMULATED shape, and the golden transcript of the package pinned that byte for
byte. The worker serves the RECORDED shape now, and the gate below is the run over the channel.

The command starts the REAL worker as a process, configures it with the environment of the real
runtime, asks it for the recorded shape and reads the artifact back. It never writes into the
tracked golden file or the tracked artifact.

```bash
cd python/visionlens && uv run --extra vision --group dev python scripts/verify_worker_embed.py
```

Exit 0, on the branch `feat/r1-ts-python-facade`, at the tree
`c3fb246e44aa49ee9979effca96046780e459094`, with the same machine and the same versions the
environment table names. The output:

```text
images: 6
count: 6
dimensions: 768
dtype: float32
embedding run id: embed-b87b292b54134e1b900c36b8414fe8d9
artifact digest: 4f706336517e10f7194963241c623af1d5039f4fc74fb3bc9c7479bfeaaf586a
error samples: 0
progress frames: 2
vectors digest of the set: 33cf54e30375a47dd703e25cbc1369b441ceffc911ba8c5fac2950966a12670c
the run is green: the worker answered the recorded shape over the channel, the artifact on disk carries the digest the frame names, and the vectors are the golden ones
```

What the output proves, row by row:

- the worker answered the RECORDED shape over the JSONL channel: the run id, the count, the
  dimension, the dtype, the digest of the artifact and the error samples, and NO vector in the
  line;
- the digest the frame names is `4f706336517e10f7194963241c623af1d5039f4fc74fb3bc9c7479bfeaaf586a`,
  the SAME content address the run over the library produced in 6.1. Two different paths, one
  content;
- the vectors of this run are the vectors of the committed golden set, digest for digest;
- the run reported its progress: two progress frames, the first at zero and the last at six.

The TypeScript side is proven against the same real worker, with the same real model and the
same committed fixtures, by the suite of the bridge
(`packages/core/tests/worker/operations.test.ts`): the suite launches the worker, asks it for
the recorded shape and reads the typed success of the answer. It is skipped when the machine has
not the `vision` extra and the weights in the local cache, because a test that fails for a
missing download fails for the wrong reason.

The golden transcript did not move. The simulated shape is answered by exactly the same code as
before, and the transcript of the package is byte for byte the one that was committed:
`python/visionlens/tests/test_golden.py` regenerates it and compares it byte for byte, in
process and over a real subprocess.

## 6.9 What the increment over the channel does NOT prove

- NO TypeScript caller launches a worker configured with the runtime yet. The bridge can BUILD
  the params of the recorded shape and can READ the answer, and the Python worker serves the
  shape, but the facade that starts the worker with the environment of the runtime is the next
  ticket (VLN-006). The capability is proven over the channel and not from the CLI;
- the runtime is read ONCE, at the start of the worker, from four environment variables. A
  worker that was started without them serves the simulated shape only, and it refuses the
  recorded one with a message that names what is missing. A worker whose environment changes
  while it runs does NOT see the change;
- the run over the channel was measured on ONE machine on ONE day, with the same caveat of
  every measurement of this record: the digest of the artifact is the address of the content and
  does not move with the load of the machine;
- the refusal of the recorded shape by a worker without the runtime is proven in the Python
  suite and not over the wire, because the TypeScript suite of the bridge does not start a
  worker without the runtime;
- the weights were read from the local cache. The fetch of the weights was NOT performed inside
  a worker, for the reason the 6.6 section names.

### The gates of the tree of this increment

Every gate of the tree of the section 6.8, with the command that ran it and the exit code it
returned.

| Gate | Command | Exit |
|---|---|---|
| Python suite | `cd python/visionlens && uv run --group dev pytest tests -q` | 0 (446 passed and 1 skipped without the `vision` extra; 447 passed with it) |
| Python types | `cd python/visionlens && uv run --group dev --extra vision --locked mypy src/visionlens` | 0 (37 files, no issues) |
| Node suite | `pnpm exec vitest run` | 0 (111 files, 1312 passed, 3 skipped) |
| Lint | `pnpm run lint` | 0 |
| Type check | `pnpm run typecheck` | 0 (9 of 9 tasks) |
| Boundary check | `pnpm run check:boundaries` | 0 |
| Owner boundary check | `pnpm run check:owner-boundaries` | 0 (75 Python files, 8 worker host files) |
| Doc drift | `pnpm run docs:check` | 0 (56 fields, 53 in the fixture) |
| Container vendor | `node scripts/check-docker-vendor.mjs` | 0 |
| Vision parity | `pnpm exec tsx scripts/benchmarks/vision-parity.ts` | 0 (3 tiers) |
| Registry parity | `pnpm exec tsx scripts/registry/parity-check.ts` | 0 (257 cases, 0 disagreements) |
| The recorded run over the channel | `cd python/visionlens && uv run --extra vision --group dev python scripts/verify_worker_embed.py` | 0 |
