"""The trainer of the M0 rung: the loop, the curves, the device and the read.

The trainer trains on the `train` partition ONLY and it selects on the `val`
partition ONLY (`docs/vnext/13-EVALUATION-SCIENCE.md:11`, FR-003 of the
ticket). The test partition is not read here: the selection code and the
evaluation code are separate modules, and a module that can see both is a
module that can leak (`specs/023-encoder-probe-training/plan.md`, "The
selection code and the evaluation code are separate modules"). The run
RECORDS the items it read, so the absence of a test read is observable and
not a promise.

The features are NOT computed here: the trainer consumes the frozen artifact
of the encoder and reuses it (`training/features.py`). A trainer that
recomputed the vectors would train on a pipeline nobody pinned, and the
vectors of the training and of the inference would not be the same vectors.

The EARLY STOPPING is the M2 rung, not this one: the pack puts the early
stopping criterion with the fine tuning and its schedulers
(`docs/vnext/12-TRAINING-EXPERIMENTS-MLFLOW.md:7`) and this ticket is the M0
rung, whose non-goals name the early stopping of the M2
(`specs/023-encoder-probe-training/spec.md`, "No PyTorch linear head, no
fine-tuning, no partial unfreezing, no SGD loop with early stopping"). A
recipe that carries a criterion is therefore REFUSED with the reason, and
never silently ignored: a decision nobody applied is not a decision.

Four things are recorded, because the pack asks for them and a run that does
not record them cannot be reproduced:

- the DEVICE the run used, the device the recipe asked for, and the reason
  of the fallback when they are not the same. A run that quietly ran
  somewhere else is a run nobody can reproduce
  (`docs/vnext/adrs/ADR-017-local-first-hardware.md:12`). The CPU is the
  reference device, and an explicit device this build does not admit is
  REFUSED with the reason, never substituted.
- the CURVE of the run: the accuracy of the train and of the validation
  partition at every epoch. The curve of the M0 rung is flat, and that is a
  property of the rung and not a defect of the measurement: a logistic
  regression over frozen vectors converges at once.
- the CHECKPOINTS: one every interval of epochs, each one addressed by its
  own digest.
- the READ of the model: the cold read (the first prediction of the run)
  and the warm read (the median of the rest) are reported SEPARATELY,
  because a number that averages the two is a number nobody can use
  (`docs/vnext/11-VISION-MODEL-REGISTRY-INFERENCE.md:35`).
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Mapping, Sequence, Tuple

from ..runtime.device import ADMITTED_DEVICES
from .checkpoint import write_checkpoint
from .features import FeatureSet, load_features
from .probe import ProbeModel, fit_probe_from_recipe
from .recipe import TrainRecipe, label_key_of, recipe_fingerprint

#: The partitions the trainer reads. The test partition is NOT one of them.
SELECTION_PARTITIONS: Tuple[str, ...] = ("train", "val")


class TrainerError(Exception):
    """Raised when a run cannot be trained.

    The error carries the CODE of the refusal, the FIELD it is about and
    the reason, so a caller can act on it and a reader can see what the run
    refused and why.
    """

    def __init__(self, code: str, field: str, reason: str) -> None:
        super().__init__(f"[{code}] {field}: {reason}")
        self.code = code
        self.field = field
        self.reason = reason


@dataclass(frozen=True)
class SplitItem:
    """One item of the split: what it is, where it is and what it is called."""

    item_id: str
    digest: str
    label_key: str
    partition: str


@dataclass(frozen=True)
class EpochPoint:
    """One epoch of the curve of a run."""

    epoch: int
    train_accuracy: float
    val_accuracy: float


@dataclass(frozen=True)
class TrainingRun:
    """What a run of the trainer produced, and what it recorded."""

    recipe_fingerprint: str
    device: str
    requested_device: str
    fallback_reason: str
    feature_digest: str
    curve: Tuple[EpochPoint, ...]
    checkpoints: Tuple[str, ...]
    final_checkpoint: str
    read_items: Tuple[str, ...]
    cold_read_ms: float
    warm_read_p50_ms: float

    def to_dict(self) -> Dict[str, Any]:
        """The run as the wire form."""
        return {
            "recipeFingerprint": self.recipe_fingerprint,
            "device": self.device,
            "requestedDevice": self.requested_device,
            "fallbackReason": self.fallback_reason,
            "featureDigest": self.feature_digest,
            "curve": [
                {
                    "epoch": point.epoch,
                    "trainAccuracy": point.train_accuracy,
                    "valAccuracy": point.val_accuracy,
                }
                for point in self.curve
            ],
            "checkpoints": list(self.checkpoints),
            "finalCheckpoint": self.final_checkpoint,
            "readItems": list(self.read_items),
            "coldReadMs": self.cold_read_ms,
            "warmReadP50Ms": self.warm_read_p50_ms,
        }


def split_items_of(assignments: Sequence[Mapping[str, Any]]) -> Tuple[SplitItem, ...]:
    """The items of a split, with their label key and their digest.

    @raises TrainerError when an assignment does not carry what an item
        needs.
    """
    items: List[SplitItem] = []
    for index, assignment in enumerate(assignments):
        item_id = assignment.get("id")
        digest = assignment.get("sha256")
        class_name = assignment.get("class")
        anomaly = assignment.get("anomaly")
        partition = assignment.get("split")
        if not isinstance(item_id, str) or item_id == "":
            raise TrainerError(
                "TRAINER_SPLIT_INVALID",
                f"assignments.{index}.id",
                f"an item names itself with an id, got {item_id!r}",
            )
        if not isinstance(digest, str) or digest == "":
            raise TrainerError(
                "TRAINER_SPLIT_INVALID",
                f"assignments.{index}.sha256",
                f"the item '{item_id}' carries no digest, and a vector is paired with an "
                "item by its digest",
            )
        if not isinstance(class_name, str) or not isinstance(anomaly, str):
            raise TrainerError(
                "TRAINER_SPLIT_INVALID",
                f"assignments.{index}.class",
                f"the item '{item_id}' carries no class and no anomaly, and a label is "
                "built from the two",
            )
        if not isinstance(partition, str):
            raise TrainerError(
                "TRAINER_SPLIT_INVALID",
                f"assignments.{index}.split",
                f"the item '{item_id}' names no partition",
            )
        items.append(
            SplitItem(
                item_id=item_id,
                digest=digest,
                label_key=label_key_of(class_name, anomaly),
                partition=partition,
            )
        )
    return tuple(items)


def _device_of(policy: str) -> Tuple[str, str]:
    """The device the run uses, and the reason of the fallback.

    An explicit device this build does not admit is REFUSED with the
    reason: a silent substitution is forbidden
    (`docs/vnext/adrs/ADR-017-local-first-hardware.md:12`).

    @raises TrainerError when the device is not admitted.
    """
    if policy == "auto":
        return (
            ADMITTED_DEVICES[0],
            f"auto resolves to the first admitted device, '{ADMITTED_DEVICES[0]}'",
        )
    if policy in ADMITTED_DEVICES:
        return policy, ""
    raise TrainerError(
        "TRAINER_DEVICE_UNSUPPORTED",
        "devicePolicy",
        f"the device '{policy}' is not admitted by this build, and a run that ran "
        f"somewhere else is a run nobody can reproduce; the admitted devices are "
        f"{', '.join(ADMITTED_DEVICES)}",
    )


def _no_early_stopping(criterion: Mapping[str, Any]) -> None:
    """The early stopping of the M2 rung, refused at the M0 rung.

    The criterion is a decision of the recipe, and the M0 trainer does not
    apply it: applying it silently would run a different experiment than the
    recipe describes, and refusing it names the reason.

    @raises TrainerError when the recipe carries a criterion.
    """
    if criterion:
        raise TrainerError(
            "TRAINER_EARLY_STOPPING_UNSUPPORTED",
            "earlyStopping",
            f"the recipe carries an early stopping criterion ({', '.join(sorted(criterion))}) "
            "and this trainer runs the M0 rung, which does not stop early; the criterion is "
            "the M2 rung, and a run that stopped without the recipe asking for it is a run "
            "nobody can reproduce",
        )


def _accuracy_of(
    model: ProbeModel,
    vectors: Sequence[Sequence[float]],
    labels: Sequence[str],
) -> float:
    """The accuracy of the model over a partition."""
    if not vectors:
        return 0.0
    correct = 0
    for vector, label in zip(vectors, labels):
        if model.predict(vector) == label:
            correct += 1
    return correct / len(vectors)


def _median(values: Sequence[float]) -> float:
    """The median of a sequence of numbers."""
    if not values:
        return 0.0
    ordered = sorted(values)
    middle = len(ordered) // 2
    if len(ordered) % 2 == 1:
        return ordered[middle]
    return (ordered[middle - 1] + ordered[middle]) / 2


def _selected(items: Sequence[SplitItem]) -> Tuple[List[SplitItem], List[SplitItem]]:
    """The items of the train and of the validation partition.

    The test partition is not here: the trainer may not read it.
    """
    train = [item for item in items if item.partition == "train"]
    val = [item for item in items if item.partition == "val"]
    return train, val


def _fingerprint_of(recipe: TrainRecipe) -> str:
    """The fingerprint of the recipe, checked.

    The recipe owns its fingerprint: the run records the address of the
    configuration that decided it, and a recipe that carries an address
    which is not its own is a recipe nobody can reproduce.

    @raises TrainerError when the recipe carries a wrong fingerprint.
    """
    computed = recipe_fingerprint(recipe)
    if recipe.fingerprint and recipe.fingerprint != computed:
        raise TrainerError(
            "TRAINER_RECIPE_FINGERPRINT_MISMATCH",
            "fingerprint",
            f"the recipe carries the fingerprint '{recipe.fingerprint}' and its own "
            f"configuration digests to '{computed}'",
        )
    return computed


def _checked_epochs(recipe: TrainRecipe) -> Tuple[int, int]:
    """The ceiling of the epochs and the interval of the checkpoints.

    @raises TrainerError when either of them is not a whole number above
        zero.
    """
    epochs = recipe.max_epochs
    if not isinstance(epochs, int) or isinstance(epochs, bool) or epochs <= 0:
        raise TrainerError(
            "TRAINER_EPOCHS_INVALID",
            "maxEpochs",
            f"the ceiling of the epochs is a whole number above zero, got {epochs!r}",
        )
    interval = recipe.checkpoint_interval
    if not isinstance(interval, int) or isinstance(interval, bool) or interval <= 0:
        raise TrainerError(
            "TRAINER_CHECKPOINT_INTERVAL_INVALID",
            "checkpointInterval",
            f"the interval of the checkpoints is a whole number above zero, got {interval!r}",
        )
    return epochs, interval


def train(
    recipe: TrainRecipe,
    items: Sequence[SplitItem],
    feature_directories: Sequence[Path],
    checkpoint_directory: Path,
) -> TrainingRun:
    """Trains the probe of a recipe over the frozen features of the run.

    The run trains on the `train` partition, it selects on the `val`
    partition, it publishes a checkpoint every interval of epochs, and it
    records the device, the curve, the checkpoints and the read.

    @raises TrainerError when the run cannot be trained.
    @raises FeatureError when the features cannot be used by the run.
    """
    device, fallback_reason = _device_of(recipe.device_policy)
    _no_early_stopping(recipe.early_stopping)
    fingerprint = _fingerprint_of(recipe)
    max_epochs, checkpoint_interval = _checked_epochs(recipe)

    train_items, val_items = _selected(items)
    if not train_items:
        raise TrainerError(
            "TRAINER_PARTITION_EMPTY",
            "partitions.train",
            "the train partition holds no item, and a probe over no item is a probe over "
            "nothing",
        )

    # The loader is asked for the SELECTED items only. The test partition is
    # not even named here: a loader that never receives an identity cannot
    # leak it.
    selected = train_items + val_items
    feature_set: FeatureSet = load_features(
        feature_directories,
        recipe,
        [(item.item_id, item.digest) for item in selected],
    )
    if feature_set.missing:
        raise TrainerError(
            "TRAINER_FEATURE_MISSING",
            "features.missing",
            f"{len(feature_set.missing)} selected item(s) carry no vector: "
            f"{', '.join(feature_set.missing[:5])}; a missing prediction is an error and "
            "never a deleted sample",
        )
    if len(feature_set.item_ids) != len(selected):
        raise TrainerError(
            "TRAINER_FEATURE_INCOMPLETE",
            "features.itemIds",
            f"the loader paired {len(feature_set.item_ids)} vectors and the run selected "
            f"{len(selected)} items; an item nobody paired is an item nobody trained on",
        )

    train_vectors = [feature_set.vector_of(item.item_id) for item in train_items]
    train_labels = [item.label_key for item in train_items]
    val_vectors = [feature_set.vector_of(item.item_id) for item in val_items]
    val_labels = [item.label_key for item in val_items]

    curve: List[EpochPoint] = []
    checkpoints: List[str] = []
    final_checkpoint = ""
    model: ProbeModel | None = None

    for epoch in range(1, max_epochs + 1):
        model = fit_probe_from_recipe(recipe, train_vectors, train_labels)
        curve.append(
            EpochPoint(
                epoch=epoch,
                train_accuracy=_accuracy_of(model, train_vectors, train_labels),
                val_accuracy=_accuracy_of(model, val_vectors, val_labels),
            )
        )
        if epoch % checkpoint_interval == 0 or epoch == max_epochs:
            manifest = write_checkpoint(
                Path(checkpoint_directory),
                model,
                epoch=epoch,
                recipe_fingerprint=fingerprint,
            )
            checkpoints.append(manifest.checkpoint_sha256)
            final_checkpoint = manifest.checkpoint_sha256

    if model is None or not checkpoints:
        raise TrainerError(
            "TRAINER_NO_CHECKPOINT",
            "checkpointInterval",
            "the run published no checkpoint, and a run without an artifact is a run "
            "nobody can resume",
        )

    cold_read, warm_read = _read_of(model, val_vectors)

    return TrainingRun(
        recipe_fingerprint=fingerprint,
        device=device,
        requested_device=recipe.device_policy,
        fallback_reason=fallback_reason,
        feature_digest=feature_set.artifact_digest,
        curve=tuple(curve),
        checkpoints=tuple(checkpoints),
        final_checkpoint=final_checkpoint,
        read_items=tuple(item.item_id for item in selected),
        cold_read_ms=cold_read,
        warm_read_p50_ms=warm_read,
    )


def _read_of(
    model: ProbeModel, vectors: Sequence[Sequence[float]]
) -> Tuple[float, float]:
    """The cold read and the warm read of the model, in milliseconds.

    The cold read is the FIRST prediction of the run and the warm read is
    the median of the rest: the two are reported separately, because a
    number that averages them is a number nobody can use.
    """
    if not vectors:
        return 0.0, 0.0
    timings: List[float] = []
    for vector in vectors:
        started = time.perf_counter()
        model.predict(vector)
        timings.append((time.perf_counter() - started) * 1000.0)
    cold = timings[0]
    warm = _median(timings[1:]) if len(timings) > 1 else cold
    return cold, warm
