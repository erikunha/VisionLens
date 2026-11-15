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

The spec names what the trainer owes (`docs/vnext/specs/VLN-009-encoder-probe-training.md:22`,
task 2.4): the loop over the `train` partition only, the `val` curve, the
checkpoint interval, the device policy with the chosen device and the reason
of the fallback recorded, and the cold and the warm read reported separately.
Task 2.5 asks for the loader of the frozen feature artifact, which refuses an
artifact whose encoder revision, preprocessing fingerprint or vector dimension
differs from the recipe, and names both sides.

Three facts decide the shape of the implementation:

- The M0 rung is a frozen encoder plus a logistic regression
  (`docs/vnext/12-TRAINING-EXPERIMENTS-MLFLOW.md:5`). The features of a run
  are produced by the encoder and REUSED, never recomputed: a trainer that
  recomputed the vectors would train on a pipeline nobody pinned, and the
  vectors of the training and of the inference would not be the same vectors
  (FR-025).
- The selection code and the evaluation code are separate modules
  (`specs/023-encoder-probe-training/plan.md`). The trainer trains on `train`
  and selects on `val`; the locked `test` partition belongs to the holdout
  evaluation, which does not exist yet (FR-003).
- The CPU is the reference behavior and a silent fallback is forbidden
  (`docs/vnext/adrs/ADR-017-local-first-hardware.md:9`, `:12`).

## Decision

**The trainer runs the loop of the M0 rung over the frozen features, and the
loader refuses an artifact that does not agree with the recipe.**

1. The trainer is `python/visionlens/src/visionlens/training/trainer.py` and
   the loader is `python/visionlens/src/visionlens/training/features.py`.
   Both import nothing heavy at module level, and the release gate now proves
   it for every module of the training surface, not only for the recipe.
2. The trainer reads the `train` and the `val` partitions ONLY. The loader is
   asked for the SELECTED items alone, so a loader that never receives an
   identity cannot leak it, and the run RECORDS the items it read. The absence
   of a test read is therefore observable and not a promise.
3. The loader compares the artifact with the recipe and refuses what does not
   agree, naming BOTH sides: the revision, the preprocessing fingerprint and
   the dimension of the vectors. It also refuses an artifact that MIXES two
   revisions or two preprocessing fingerprints, naming the two of each, and a
   digest that names two items, because a vector that belongs to two items is
   a vector nobody can pair.
4. The pairing of a vector with an item is by the DIGEST of the image: the
   manifest of the artifact carries the digest of every asset in the order of
   the vectors, and the split carries the same digest for every item. The
   pairing is therefore by content and not by position.
5. An item the artifact does not carry is RECORDED as missing and is never a
   deleted sample. The trainer refuses a run whose selected item carries no
   vector: a missing prediction is an error of the evaluation
   (`docs/vnext/12-TRAINING-EXPERIMENTS-MLFLOW.md:27`).
6. The DEVICE POLICY is refused when it cannot be honored. `auto` resolves to
   the first admitted device and the resolution is recorded; `cpu` is the cpu;
   an explicit device this build does not admit is REFUSED with the reason and
   never substituted. The run records the device, the device the recipe asked
   for and the reason of the fallback.
7. The COLD READ (the first prediction of the run) and the WARM READ (the
   median of the rest) are two numbers, reported separately. A number that
   averages them is a number nobody can use
   (`docs/vnext/11-VISION-MODEL-REGISTRY-INFERENCE.md:35`).
8. The checkpoint is published at every interval of epochs and at the last
   epoch, each one addressed by its own digest, and the run records the
   digest of the feature artifact it consumed.

## Divergence from the spec

The spec asks for the loop over the `train` partition and names the device
policy, the interval and the two reads. It does not mention the early
stopping, and it is right not to: the pack puts the early stopping criterion
with the fine tuning and its schedulers
(`docs/vnext/12-TRAINING-EXPERIMENTS-MLFLOW.md:7`), and the non-goals of the
ticket name the early stopping of the M2 explicitly. The M0 trainer therefore
REFUSES a recipe that carries a criterion, with the reason, and never ignores
it: a decision nobody applied is not a decision, and a run that stopped
without the recipe asking for it is a run nobody can reproduce.

The loop refits the estimator at every epoch and the curve of the M0 rung is
flat. That is a property of the rung and not a defect of the measurement: a
logistic regression over frozen vectors converges at once. The loop exists
because the later rungs need one, and because the interval of the checkpoints
is a property of the recipe.

## Consequences

**Positive:**

- The run cannot leak the test partition: the loader is asked for the
  selected items only, the run records the items it read, and a run that
  asked for the test items would be refused, because the artifact of the
  fixture carries no vector of them.
- The artifact of features is reused and checked. A stale artifact, an
  artifact of another encoder and an artifact of another dimension are
  refused with the two sides named, and the run records the digest of the
  artifact it consumed.
- The device of a run is recorded with the reason of its resolution, and an
  explicit device nobody admits is refused instead of substituted.
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
