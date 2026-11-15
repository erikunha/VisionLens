# ADR 022 - The pinned recipe of a training run

| Field    | Value      |
| -------- | ---------- |
| Status   | Accepted   |
| Date     | 2026-11-15 |
| Deciders | @erikunha  |

## Context

VLN-009 asks for the first rung of the training maturity ladder: the frozen
embeddings of one local encoder feed a scikit-learn logistic regression
probe, the probe is trained on the `train` partition of the tracked
leakage-resistant split, selected on `val`, evaluated once on the locked
`test` partition, recorded as an attributed artifact and registered as a
model version (`docs/vnext/specs/VLN-009-encoder-probe-training.md:6`).

The local spec of the ticket was written against a tree that did not exist
yet, and it says so: "`python/` is absent from the tree", "`services/training/`
is a skeleton that exports a name constant", "no `mlflow`, `torch`,
`scikit-learn` or `sklearn` reference exists anywhere under `packages/`,
`services/` or `scripts/`"
(`specs/023-encoder-probe-training/plan.md`, the section "Technical
Context"). Since then three of the things the spec waited for landed: the
`python/visionlens` distribution with its `vision` extra, the model
capability registry with the pinned `siglip2-base` record (ADR-011 and the
amendment of 2026-11-14), and the tracked v2 VisA split with its
leakage-resistant partitions.

The recipe is the first piece of the ticket to land, because everything
else consumes it: the features are read with the revision and the
preprocessing it pins, the probe is trained with the hyperparameters and the
seed it names, the report is about the partitions it lists, and the
fingerprint of the recipe is what makes a run reproducible.

Two facts decide the shape of the implementation:

- The Python side OWNS the resolution. It reads the registry and the split,
  it knows the label keys of the ontology and the partition ids, and it is
  the side that will train.
- The TypeScript side OWNS the contract. The domain store is the sole
  writer of the domain rows (`docs/vnext/08-DOMAIN-STORE-AND-PROVENANCE.md:46`),
  so the TypeScript side validates what the Python side published and
  commits it, exactly like the manifest of the VLN-005 adapter.

## Decision

**The recipe is resolved in Python, validated in TypeScript, and addressed by
a fingerprint both sides compute.** This lands the first story of VLN-009
(the pinned recipe) with the shape the spec asks for and with the divergence
of the tree recorded below.

1. The resolver is `python/visionlens/src/visionlens/training/recipe.py`.
   It reads the model capability registry and the tracked split, and it
   produces a recipe that carries every field that decides the run: the
   pinned encoder (the exact revision, the digest of the weights, the
   source URI, the licence, the usage restrictions, the required extras, the
   tasks, the preprocessing fingerprint, the supported devices, the size of
   the input, the feature extractor, the shape of the output, the profile of
   the latency and the cost, the status of the calibration, the trust policy
   and the attribution), the pinned data (the dataset, the split, the
   fingerprint of the partition and the hash of the manifest), the item ids of
   the three partitions, the version of the ontology, the class weight of
   every class, the estimator, the optimizer, the hyperparameters, the seed,
   the device policy, the augmentation pipeline, the ceiling of the epochs,
   the early stopping criterion, the interval of the checkpoints, the
   resources, the budget and the version of the contracts.
   The encoder pin carries EVERY field of the registry record except the
   notes, under the name the record gives it, so a field of the record that
   the pin drops is a field of the encoder the run does not pin. The notes
   are the provenance of the record and not a decision of the run, and they
   travel with the record.
2. The recipe is IMMUTABLE and its fingerprint is the `fp2:` digest of
   every field but the fingerprint itself. A recipe whose fingerprint is the
   digest of a name is a promise that nothing is pinned, and a fingerprint
   that changes when a single hyperparameter changes is the proof that it
   covers the configuration and not a label of it.
3. The two sides compute the fingerprint with the SAME algorithm: the
   canonical serialisation of `packages/contracts/src/fingerprint.ts` and its
   Python mirror `visionlens/runtime/fingerprint.py`, which agree byte for
   byte. The parity gate (`scripts/training/recipe-parity.ts`) resolves the
   recipe over the TRACKED registry and the TRACKED split, validates it
   against the TypeScript schema, recomputes the fingerprint and compares
   the two addresses. A fingerprint only one side can recompute proves
   nothing, so the claim has a command and not a sentence. The gate runs over
   BOTH regimes of class weight, the default one where every class is weighted
   `none` and the numeric one where every class carries a number: a gate that
   looked at one regime would let the other one rot, and a weight that
   crosses the boundary as the text of a number satisfies the regime of
   `none` perfectly.
4. The schema of the TypeScript side is STRICT, like the manifest of the
   adapter: a recipe with a field nobody knows is a recipe nobody
   maintains, and a field one side knows and the other does not is a hole in
   the contract. The schema is a zod schema in
   `packages/core/src/training/train-recipe.ts`, behind its own subpath
   `@vision-lens/core/training`.
5. The refusals name the field they are about, and each of them is owned by
   the place that owns the rule:
   - the record of the registry refuses a record that does not carry a field
     a run needs, and refuses the floating revision `latest`, because a
     saved run may never name a floating revision. The recipe inherits both
     refusals and names the path of the field IN THE REGISTRY FILE, so a
     caller learns what to fix.
   - the recipe refuses a SPLIT whose partitions share an item id, and it
     names the partitions that touch and the items they share. The ids are
     compared in their normalized form, so an item that hides in a
     difference of case or of whitespace is caught too. The leak is the one
     thing that makes every number of a run a number of the training set,
     and it is invisible in the metrics.
   - the recipe refuses a PARTITION that holds no item, because the other
     side refuses one and a recipe the other side refuses is a recipe that
     never reaches a trainer.
   - the recipe refuses a CLASS whose weight is not documented, and it
     refuses a weight for a class the ontology does not have. A weight may
     be `none`, and `none` is a documented decision and not a missing one. A
     weight that is a number stays a NUMBER in the wire form, because the
     schema of the other side accepts a number or the word `none` and a
     weight written as the text of a number is a weight the other side
     refuses.
   - the recipe refuses a RECORD whose declared address is not the digest of
     its own body. The address is checked and not trusted: a record that
     claims one configuration and hashes another is a record nobody can
     reproduce, and the read-back path recomputes the digest instead of
     keeping the address it was handed.
   - the recipe refuses a DEVICE the record does not support. The CPU is
     the reference device and a silent fallback is forbidden
     (`docs/vnext/adrs/ADR-017-local-first-hardware.md:9`).
   - the recipe refuses a pin field that carries no value, and it inherits
     the exemption of the record for the fields the record lets be empty. A
     rule the recipe holds to a stricter shape than the record is a rule
     that refuses a model the platform is allowed to run. The check lives
     with the pin, so the resolver and the reader judge the same field the
     same way.
6. The ontology version is the digest of the CLASS SPACE: the sorted label
   keys of the ontology, which the probe answers with. It is not the digest
   of the taxonomy prose: the prose is the concern of the prompt of the
   benchmark, the class space is the concern of the probe, and the two
   languages must not carry a copy of a paragraph of English to agree on an
   address.
7. The `train` extra lands with the ESTIMATOR and not with the recipe. The
   recipe needs nothing heavy: it reads two files and computes a digest, so
   the base install of the package stays free of scikit-learn and numpy
   until the probe needs them. The spec lists the extra with the recipe
   (task 1.5 of the ticket), and the tree says otherwise: an extra that
   carries the whole scikit-learn closure for a module that imports none of
   it is a download nobody asked for.
8. The training surface is inside the enforced module boundary: the
   boundary table of `AGENTS.md` gained a row, the eslint zone gained the
   rule, and the boundary gate plants a violating training fixture and
   proves the rule fires.

## Consequences

**Positive:**

- A run that names its recipe can be reproduced, and the fingerprint of the
  recipe is the address of that configuration.
- The two languages agree on the recipe before anything is trained, so the
  failure of a mismatch is a refusal at the gate and not a wrong number in
  a report.
- The leakage between the partitions is refused by the recipe itself, so a
  split that leaks never reaches a trainer.

**Negative:**

- The recipe pins a run; it does not run one. The probe, the checkpoint, the
  holdout evaluation, the arena comparison and the promotion gate are the
  stories that follow, and none of them has landed yet.
- The class weights are a decision of the operator, and the recipe only
  proves they are DOCUMENTED. It does not say whether they are right.
- The label keys of the ontology come from the split, so a recipe over a
  split with a different vocabulary is a different recipe. That is the
  point of the fingerprint, and it is also a coupling.
- The extra `train` is still empty, so the estimator lands with its pins and
  the lock grows with the whole scikit-learn closure at that moment.

## Reversibility

The recipe is additive: a new module in the Python package, a new module in
the core behind a new subpath, a new command and a new gate. Removing them
is a revert, and nothing that existed before depends on them. The schema
may tighten, because no run has been recorded with it yet, and the
fingerprint may change with it, because nothing depends on the address of a
recipe that no run carries.
