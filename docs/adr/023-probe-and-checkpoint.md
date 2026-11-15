# ADR 023 - The probe of the M0 rung and the digest-pinned checkpoint

| Field    | Value      |
| -------- | ---------- |
| Status   | Accepted   |
| Date     | 2026-11-15 |
| Deciders | @erikunha  |

## Context

VLN-009 asks for the first rung of the training maturity ladder: the frozen
embeddings of one local encoder feed a scikit-learn logistic regression
probe, and the run produces a checkpoint whose digest is pinned, whose
coefficients differ from the initialization, and whose class map loads back
(`docs/vnext/specs/VLN-009-encoder-probe-training.md:6`, `:22`).

The recipe landed first, because everything else consumes it
(`docs/adr/022-training-recipe.md`). The recipe pins the encoder, the
partitions, the ontology, the class weights, the hyperparameters, the seed
and the device, and it refuses a run that is not pinned. It does not train
anything: it is the configuration a run consumes.

The estimator and the checkpoint are the next piece, and they are the piece
that decides whether a run is EVIDENCE or a promise. A run that trains
without publishing an artifact nobody can verify is a run that cannot be
reproduced, and a checkpoint that is not addressed by its own content is a
file that a reader has to trust.

Two facts decide the shape of the implementation:

- The M0 rung is a frozen encoder plus a logistic regression, and nothing
  more (`docs/vnext/12-TRAINING-EXPERIMENTS-MLFLOW.md:5`). There is no
  autograd, no device kernel and no GPU, which is what makes the CPU
  reference path real.
- The heavy stack belongs to the estimator and not to the recipe. The recipe
  reads two files and computes a digest, so the base install of the
  distribution stays free of scikit-learn and numpy
  (`docs/vnext/05-PYTHON-CORE-AND-PYPI.md:34`).

## Decision

**The estimator is fitted inside the `training` extra and the checkpoint is
a JSON document addressed by its own digest.** This lands the second story
of VLN-009 (the probe and the checkpoint) with the shape the spec asks for
and with the divergence of the tree recorded below.

1. The estimator is `python/visionlens/src/visionlens/training/probe.py`.
   It fits the scikit-learn logistic regression over the frozen vectors of
   the `train` partition, with the seed, the optimizer, the hyperparameters
   and the documented class weights of the recipe. The heavy stack is
   imported INSIDE the fit, so importing the training surface never imports
   scikit-learn, and a caller whose environment does not have the extra
   gets an actionable `MissingExtraError` with the command that provides
   it instead of an `ImportError`.
2. The CLASS MAP is the authority of the class space. It is built from the
   gold vocabulary of the run, the index of a class is its position in the
   vocabulary sorted over the UTF-16 code units, and the version of the
   ontology of the recipe is the digest of that vocabulary. A label that is
   not in the map is a HARD ERROR and never a coercion
   (`docs/vnext/21-TEST-AND-QUALITY-PLAN.md:28`): the answer of the probe is
   a label key of the ontology and not an index nobody can read. The probe
   refuses a recipe whose class weights and whose ontology version
   disagree, because a run whose class space nobody can name is a run
   nobody can reproduce.
3. The CLASS WEIGHTS are documented for every class, `none` included, and
   `none` means the class is NOT WEIGHTED. The weight that is left out of
   the estimator is the default of one and never a zero: a zero weight
   would drop the class from the fit, and a dropped class is a class the
   run never reports. The pack asks for the class weights to be DOCUMENTED
   (`docs/vnext/12-TRAINING-EXPERIMENTS-MLFLOW.md:5`); what the word `none`
   MEANS is the decision of this ADR, and it is the decision of the module
   that owns the fit (`python/visionlens/src/visionlens/training/probe.py`,
   the function that checks the documented weights).
   The SUPPORT of every class is recorded in the model, and a class whose
   support is below the documented minimum is recorded as a class with an
   insufficient support instead of being lost in the fit. The probe refuses
   a class space class that the run does not train on, because a class
   without a single item has no coefficient and a class the model cannot
   answer is a class the run never reports. The documented weight is
   applied as it is: the probe does not second-guess the decision of the
   operator, and the support of the class travels with the model, so a
   report can see a class that was weighted with one item behind it.
4. The HYPERPARAMETERS are a closed set. A hyperparameter nobody knows is
   refused, because a hyperparameter nobody applies is a decision nobody
   pinned. A hyperparameter that names the solver or the ceiling of the
   iterations and disagrees with the recipe is refused too: two ceilings
   that disagree are two runs, and the run that fits is the one the recipe
   pins.
5. The fitted model is PLAIN DATA: one coefficient row per class, the
   intercepts, the class map, the support of every class, the effective
   weights, the hyperparameters and the accuracy of the fit. The rows are
   stored per class, so the answer of the model is the highest score among
   the classes and it does not depend on the shape the estimator happened
   to fit its classes in. The prediction is plain arithmetic over the
   stored rows, so a reader of a checkpoint needs no library to answer
   with it.
6. The checkpoint is `python/visionlens/src/visionlens/training/checkpoint.py`
   and it is CONTENT ADDRESSED: the manifest carries the sha256 of the
   checkpoint file, the class map of the run and the epoch it was written
   at, and a reader that hashes the file and finds another digest REFUSES
   the checkpoint instead of loading it (`docs/vnext/specs/VLN-009-encoder-probe-training.md:22`,
   the acceptance criterion of the checkpoint). The digest
   is checked BEFORE the file is parsed, so a checkpoint whose bytes are
   not the bytes the manifest names is never loaded at all.
7. The PUBLICATION is atomic and it is ordered. The checkpoint file is
   written to a temporary name in the same directory, it is flushed to the
   disk, it is renamed to the name of its OWN DIGEST, and only then is the
   manifest written and renamed into place. The directory of the
   publication is flushed as well, so the name of the artifact survives a
   crash of the machine and not only the bytes of the file. The manifest
   is the publication: a checkpoint without a manifest is not published, a run
   that dies in the middle leaves a file nobody points at, and a cancelled
   run publishes nothing. Two different checkpoints of one epoch are
   refused, because two runs are not one run
   (`docs/vnext/08-DOMAIN-STORE-AND-PROVENANCE.md:26`).
8. The EPOCH of the manifest is the RESUME STATE. A run that was
   interrupted continues after the epoch the last checkpoint was written
   at, and the epoch of the checkpoint and the epoch of its manifest have to
   agree, because a manifest that describes another epoch is a manifest
   nobody can resume from.
9. The checkpoint file is a JSON document and NOT a pickled estimator. The
   spec names the FORMAT of the checkpoint nowhere: the acceptance criterion
   asks for the sha256 of the checkpoint file and for the class map, and the
   pins of the
   `training` extra name joblib among the packages of the extra. The format
   is a decision of this ADR, and JSON is it because the bytes of two
   machines are the same bytes, so the digest of a run is reproducible
   everywhere; because the artifact is readable without running anything;
   and because loading it never executes code that came with the file. The
   parameters of the probe are plain numbers, so there is nothing a pickle
   would carry that JSON cannot. The pin of joblib stays in the extra
   because joblib is the reader of the frozen feature artifact, which is
   the next piece of the ticket. Joblib arrives with scikit-learn anyway,
   and the explicit pin of the extra only narrows its range.
10. A published artifact carries the permissions of the temporary file it
    was written from, which are the permissions of its owner alone. An
    artifact of a run may carry the data of a run, and an operator that
    shares the directory of the run loosens the permissions on purpose.
11. The REFUSALS of the checkpoint speak the vocabulary of the checkpoint.
    A payload that carries no model, a write that fails and a manifest
    that names a file outside the directory of the run are refusals of the
    checkpoint and not of the probe and not of the operating system: a
    caller of the checkpoint catches one vocabulary and not the other. The
    name of a checkpoint is a NAME and not a path, so a reader never hashes
    a file the run never published.
12. The rows of a model and the vectors of the run share one dimension, and
    a model that does not say so is refused when it is read back. A model
    whose rows are shorter than the dimension it declares answers with a
    score computed over half of the vector.
13. The `all` extra is the aggregate of the capability extras, so it
    carries the `training` extra from now on.

## Consequences

**Positive:**

- The probe overfits the tiny fixture to a hundred percent of train
  accuracy and the coefficients differ from the initialization, so the
  estimator is proved to fit and not to predict a constant.
- The checkpoint of a run is addressed by its own content, so a reader can
  prove that the artifact on the disk is the artifact the run published,
  and a checkpoint whose bytes changed is refused before it is loaded.
- The base install of the distribution stays free of the heavy stack, and
  the release gate proves it in a clean environment.

**Negative:**

- The trainer, the loader of the frozen features, the resume and the
  cancel paths, the locked holdout evaluation, the arena comparison, the
  experiment record, the registration of the model version and the promotion
  gate are still open. The probe fits a matrix the trainer has not read yet,
  and the checkpoint is published by a call the trainer has not made yet.
  The module of the checkpoint carries the epoch that a resume will read,
  and it refuses a publication that a cancel did not ask for, but the paths
  themselves belong to the trainer.
- The joblib pin of the extra is carried by the feature artifact, which
  lands with the next piece of the ticket.
- The metrics of a run are reported by the shipped scorer and not by this
  module, so the numbers of a run are not yet in a report.

## Reversibility

The probe and the checkpoint are additive: two new modules in the Python
package and one extra that the estimator needs. Removing them is a
revert, and nothing that existed before depends on them. The shape of the
checkpoint may change while no run has been recorded with it, and the
digest of a checkpoint that no run carries is not an address anybody
depends on yet.

## Amendment 2026-11-15: the trainer and the loader landed

The trainer and the loader of the frozen features are not open anymore: the
trainer of the M0 rung and the loader of the frozen feature artifact landed
with `docs/adr/024-trainer-and-frozen-features.md`, and the trainer publishes
the checkpoints this ADR describes. The probe fits a matrix the trainer reads
now, and the checkpoint is published by a call the trainer makes.

What this ADR decides does not move: the estimator is a scikit-learn logistic
regression fitted inside the `training` extra, the class map is the authority
of the class space, and the checkpoint is a JSON document addressed by its own
digest. The resume and the cancel paths, the locked holdout evaluation, the
arena comparison, the experiment record, the registration of the model
version and the promotion gate are still open.
