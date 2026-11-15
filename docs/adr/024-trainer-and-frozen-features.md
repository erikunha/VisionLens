# ADR 024 - The trainer of the M0 rung and the loader of the frozen features

| Field    | Value      |
| -------- | ---------- |
| Status   | Accepted   |
| Date     | 2026-11-15 |
| Deciders | @erikunha  |

## Context

The recipe landed first (`docs/adr/022-training-recipe.md`), then the
estimator and the digest-pinned checkpoint (`docs/adr/023-probe-and-checkpoint.md`).
The trainer is the piece that turns a pinned recipe and a frozen artifact into
a recorded run, and it is the piece that decides whether a run is EVIDENCE or
a promise.

The spec names what the trainer owes: "Train only on train split, tune via
validation, lock test evaluation, seed and checkpoint, record preprocessing
hash. CPU is default and MPS experimental"
(`docs/vnext/specs/VLN-009-encoder-probe-training.md:14`), and the test
strategy names the cold and the warm inference, the checkpoint resume and the
cancel (`:24`). The acceptance criteria are the parameters that change, the
digest-pinned checkpoint and the independent holdout (`:22`).

Three facts decide the shape of the implementation:

- The M0 rung is a frozen encoder plus a logistic regression
  (`docs/vnext/12-TRAINING-EXPERIMENTS-MLFLOW.md:5`). The features of a run
  are produced by the encoder and REUSED, never recomputed: a trainer that
  recomputed the vectors would train on a pipeline nobody pinned, and the
  vectors of the training and of the inference would not be the same vectors
  (FR-025 of the local spec of the ticket).
- The selection code and the evaluation code are separate modules. The
  trainer trains on `train` and selects on `val`; the locked `test` partition
  belongs to the holdout evaluation, which does not exist yet (FR-003 of the
  local spec of the ticket).
- The CPU is the reference behavior and a silent fallback is forbidden
  (`docs/vnext/adrs/ADR-017-local-first-hardware.md:9`, `:12`).

## Decision

**The trainer runs the loop of the M0 rung over the frozen features, the
partition of the run is the partition the recipe pins, and the loader refuses
an artifact that does not agree with the recipe.**

1. The trainer is `python/visionlens/src/visionlens/training/trainer.py` and
   the loader is `python/visionlens/src/visionlens/training/features.py`.
   Both import nothing heavy at module level, and the release gate now proves
   it for every module of the training surface, not only for the recipe.
2. The trainer reads the `train` and the `val` partitions ONLY. The loader is
   asked for the SELECTED items alone, so a loader that never receives an
   identity cannot leak it, and the run RECORDS the items it read. The absence
   of a test read is therefore observable and not a promise.
3. The partition of the run is the partition the RECIPE pins. The recipe
   carries the ids of the three partitions, and the trainer REFUSES a run
   whose items are not exactly the ones the recipe pins in `train` and in
   `val`, and a run that selects an item of the locked test partition. A run
   over items nobody pinned is a run nobody can reproduce, and the pin is what
   makes the claim of a train-only run a property of the run and not a
   convention of the caller.
4. The loader compares the artifact with the recipe and refuses what does not
   agree, naming BOTH sides: the revision, the preprocessing fingerprint and
   the dimension of the vectors. EVERY artifact of the run is checked, not
   only the first one, and the run records the digest of EVERY artifact it
   consumed. The loader also refuses an artifact that MIXES two revisions or
   two preprocessing fingerprints, naming the two of each, and a digest that
   names two items, because a vector that belongs to two items is a vector
   nobody can pair.
5. The pairing of a vector with an item is by the DIGEST of the image: the
   manifest of the artifact carries the digest of every asset in the order of
   the vectors, and the split carries the same digest for every item. The
   pairing is therefore by content and not by position.
6. An item the artifact does not carry is RECORDED as missing and is never a
   deleted sample. The trainer refuses a run whose selected item carries no
   vector: a missing prediction is an error of the evaluation
   (`docs/vnext/12-TRAINING-EXPERIMENTS-MLFLOW.md:27`).
7. The DEVICE is resolved by the planner of the platform, which is the only
   resolver: the report of the capabilities and the run ask the same question,
   so they cannot answer it in two different ways. `auto` resolves to the
   device the platform admits and the reason of the resolution is recorded; an
   explicit device this build does not admit is REFUSED with the reason and
   never substituted. The run records the device, the device the recipe asked
   for, the reason of the resolution and the reason of the fallback.
8. The COLD READ (the first prediction of the run) and the WARM READ (the
   p50 and the p95 of the rest, by the percentile function of the platform)
   are separate numbers. A number that averages them is a number nobody can
   use (`docs/vnext/11-VISION-MODEL-REGISTRY-INFERENCE.md:35`).
9. The run records the THROUGHPUT of the fit and the PEAK MEMORY of the
   process, so the numbers the hardware matrix asks for are in the record of
   the run and not only in the record of the report (FR-015 and FR-016 of the
   local spec of the ticket).
10. The checkpoint is published at every interval of epochs and at the last
    epoch, each one addressed by its own digest.

## Divergence from the spec

The early stopping is the first divergence. The spec does not mention it, and
it is right not to: the pack puts the early stopping criterion with the fine
tuning and its schedulers (`docs/vnext/12-TRAINING-EXPERIMENTS-MLFLOW.md:7`),
and the non-goals of the ticket name the early stopping of the M2 explicitly.
The M0 trainer therefore REFUSES a recipe that carries a criterion, with the
reason, and never ignores it: a decision nobody applied is not a decision, and
a run that stopped without the recipe asking for it is a run nobody can
reproduce. The recipe contract asks the recipe to carry the criterion
(`docs/vnext/12-TRAINING-EXPERIMENTS-MLFLOW.md:15`); at the M0 rung the
criterion is carried empty and the refusal is the honest reading of it.

The device is the second divergence. The ticket asks for a run recorded on
the CPU and on the MPS, and the pack says the MPS is optional and must carry
the memory admission and the operator compatibility checks
(`docs/vnext/11-VISION-MODEL-REGISTRY-INFERENCE.md:35`). This build admits the
CPU and only the CPU, so the trainer resolves `auto` to the CPU and records
the reason of the fallback, and an explicit `mps` is refused with the reason.
The MPS arm of the ticket is therefore NOT reachable through the trainer
until the build admits the accelerator, and the trainer says so instead of
running somewhere else.

The loop refits the estimator at every epoch and the curve of the M0 rung is
flat. That is a property of the rung and not a defect of the measurement: a
logistic regression over frozen vectors converges at once. The loop exists
because the later rungs need one, and because the interval of the checkpoints
is a property of the recipe.

## Consequences

**Positive:**

- The run cannot leak the test partition: the loader is asked for the
  selected items only, the partition of the run is the one the recipe pins,
  the run records the items it read, and a run that asked for the test items
  would be refused, because the artifact of the fixture carries no vector of
  them.
- The artifact of features is reused and checked. A stale artifact, an
  artifact of another encoder and an artifact of another dimension are
  refused with the two sides named, and the run records the digest of every
  artifact it consumed.
- The device of a run is resolved by the only resolver of the platform and
  recorded with the reason of its resolution, and an explicit device nobody
  admits is refused instead of substituted.
- The base install of the distribution stays free of the heavy stack, and the
  release gate proves it for the whole training surface.

**Negative:**

- The resume and the cancel paths are still open. The checkpoint carries the
  epoch a resume reads, and the trainer publishes a checkpoint at every
  interval, but the paths that continue and that abort a run belong to the
  next piece of the ticket.
- The lock of the holdout evaluation, the arena comparison, the experiment
  record, the registration of the model version and the promotion gate are
  still open. The trainer produces a run; nobody reads it back yet.
- The metrics of a run are reported by the shipped scorer and not by this
  module, so the numbers of a run are not yet in a report.
- The capability report of the distribution claimed that the `training` extra
  needed torch. The extra installs the estimator stack and not torch, so the
  report told a machine that installed the extra correctly that it did not
  have it. The map names the modules the extra installs now, and the test
  that proves it reads the pins of `pyproject.toml`.

## Reversibility

The trainer and the loader are additive: two new modules in the Python
package and no change to the recipe, to the estimator or to the checkpoint.
Removing them is a revert, and nothing that existed before depends on them.
The shape of the run record may change while no run has been recorded with it.
