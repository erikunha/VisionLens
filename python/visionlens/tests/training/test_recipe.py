"""The pinned recipe of a training run.

The recipe is the reproducibility contract of the training surface: a run
that does not carry every field that decided it cannot be reproduced, and a
recipe whose fingerprint is the digest of a name proves nothing. These tests
cover the resolver, the four refusals it owes and the fingerprint.

The tests that read the TRACKED registry and the TRACKED split prove that
the recipe resolves against the data the repository actually ships, and not
against a fixture that agrees with itself.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any, Dict

import pytest

from visionlens.runtime.fingerprint import fingerprint_v2
from visionlens.training.recipe import (
    RECIPE_FIELDS,
    RecipeError,
    TrainRecipe,
    default_class_weights,
    label_key_of,
    ontology_version_of,
    partition_fingerprint_of,
    recipe_fingerprint,
    recipe_from_record,
    resolve_recipe,
)

REPO_ROOT = Path(__file__).resolve().parents[4]
TRACKED_REGISTRY = REPO_ROOT / "datasets" / "registry.json"
TRACKED_SPLIT = REPO_ROOT / "benchmarks" / "splits" / "visa-subset.v2.gold.json"

MODEL_ID = "siglip2-base"

HYPERPARAMETERS: Dict[str, Any] = {
    "C": 1.0,
    "maxIterations": 200,
    "solver": "lbfgs",
}


def label_keys_of_split() -> list:
    """The label keys of the tracked split."""
    split = json.loads(TRACKED_SPLIT.read_text(encoding="utf-8"))
    return sorted(
        {
            label_key_of(assignment["class"], assignment["anomaly"])
            for assignment in split["assignments"]
        }
    )


def resolve_tracked(**overrides: Any) -> TrainRecipe:
    """Resolves the recipe of the tracked registry and the tracked split."""
    options: Dict[str, Any] = {
        "registry_path": str(TRACKED_REGISTRY),
        "model_id": MODEL_ID,
        "split_path": str(TRACKED_SPLIT),
        "class_weights": default_class_weights(label_keys_of_split()),
        "hyperparameters": HYPERPARAMETERS,
    }
    options.update(overrides)
    return resolve_recipe(**options)


def write_registry(tmp_path: Path, models: list) -> str:
    """Writes a registry file that carries the given model records."""
    registry = json.loads(TRACKED_REGISTRY.read_text(encoding="utf-8"))
    target = tmp_path / "registry.json"
    target.write_text(
        json.dumps({**registry, "models": models}),
        encoding="utf-8",
    )
    return str(target)


def tracked_model() -> Dict[str, Any]:
    """The tracked record of the encoder, as the file carries it."""
    registry = json.loads(TRACKED_REGISTRY.read_text(encoding="utf-8"))
    for model in registry["models"]:
        if model["modelId"] == MODEL_ID:
            return copy.deepcopy(model)
    raise AssertionError("the tracked registry carries no record of " + MODEL_ID)


def test_the_resolved_recipe_carries_every_registry_field_unchanged() -> None:
    """Every field of the record travels unchanged, except the notes.

    The pin is the record seen by the run, so a field of the record that
    the pin drops is a field of the encoder the run does not pin.
    """
    recipe = resolve_tracked()
    record = tracked_model()
    pin = recipe.encoder.to_dict()

    for name, value in record.items():
        if name == "notes":
            # The notes are the provenance of the record, not a decision of
            # the run, and they travel with the record.
            continue
        assert name in pin, f"the pin drops the field {name}"
        assert pin[name] == value, f"the pin changes the field {name}"
    assert set(pin) == set(record) - {"notes"}


def test_the_recipe_carries_the_data_the_split_pins() -> None:
    recipe = resolve_tracked()
    split = json.loads(TRACKED_SPLIT.read_text(encoding="utf-8"))

    assert recipe.dataset.dataset_id == split["datasetId"]
    assert recipe.dataset.split_id == split["id"]
    assert recipe.dataset.snapshot_fingerprint == split["partitionFingerprint"]
    assert recipe.dataset.manifest_hash == split["manifestHash"]
    assert len(recipe.partitions["train"]) == 420
    assert len(recipe.partitions["val"]) == 140
    assert len(recipe.partitions["test"]) == 140


def test_the_fingerprint_is_the_digest_of_the_whole_configuration() -> None:
    recipe = resolve_tracked()

    assert recipe.fingerprint == fingerprint_v2(recipe.to_dict())
    assert recipe.fingerprint.startswith("fp2:")
    assert len(recipe.fingerprint) == len("fp2:") + 16


def test_the_fingerprint_changes_when_a_single_component_changes() -> None:
    base = resolve_tracked()
    other = resolve_tracked(seed=base.seed + 1)

    assert other.fingerprint != base.fingerprint
    assert recipe_fingerprint(other) == other.fingerprint


def test_the_fingerprint_changes_when_a_hyperparameter_changes() -> None:
    base = resolve_tracked()
    changed = resolve_tracked(hyperparameters={**HYPERPARAMETERS, "C": 2.0})

    assert changed.fingerprint != base.fingerprint


def test_the_record_carries_the_fingerprint_and_the_whole_recipe() -> None:
    recipe = resolve_tracked()
    record = recipe.to_record()

    for name in RECIPE_FIELDS:
        assert name in record
    assert record["fingerprint"] == recipe.fingerprint

    rebuilt = recipe_from_record(record)
    assert rebuilt.fingerprint == recipe.fingerprint
    assert rebuilt.to_dict() == recipe.to_dict()


def test_a_record_without_an_address_is_refused() -> None:
    """A recipe with no address is a recipe nobody can verify.

    The other side refuses a record whose address is missing, and this side
    refuses it too: a record the two sides judge differently is a record
    that crosses the boundary by luck.
    """
    recipe = resolve_tracked()
    record = recipe.to_record()
    record["fingerprint"] = ""

    with pytest.raises(RecipeError) as failure:
        recipe_from_record(record)

    assert failure.value.code == "RECIPE_RECORD_INVALID"
    assert failure.value.field == "fingerprint"


def test_a_numeric_weight_survives_the_round_trip_through_the_wire_form() -> None:
    """A weight the run chose is still a number when the recipe is read back.

    The wire form is what the other side validates, so a weight that came
    back as the text of a number would be refused by the very side the
    recipe was published for.
    """
    weights = default_class_weights(label_keys_of_split())
    chosen = sorted(weights)[0]
    weights[chosen] = 2

    recipe = resolve_tracked(class_weights=weights)
    rebuilt = recipe_from_record(json.loads(json.dumps(recipe.to_record())))

    assert rebuilt.to_dict() == recipe.to_dict()
    assert rebuilt.to_record()["classWeights"][chosen] == 2


def test_a_record_whose_address_is_not_the_digest_of_its_body_is_refused() -> None:
    """The declared address is checked, not trusted.

    A record that claims one configuration and hashes another is a record
    nobody can reproduce, and the recipe refuses it instead of keeping the
    address it was handed.
    """
    recipe = resolve_tracked()
    record = recipe.to_record()
    record["fingerprint"] = "fp2:0123456789abcdef"

    with pytest.raises(RecipeError) as failure:
        recipe_from_record(record)

    assert failure.value.code == "RECIPE_FINGERPRINT_MISMATCH"
    assert failure.value.field == "fingerprint"


def test_a_record_whose_body_was_edited_is_refused() -> None:
    """Changing one field of the body breaks the address of the record."""
    recipe = resolve_tracked()
    record = recipe.to_record()
    record["seed"] = 43

    with pytest.raises(RecipeError) as failure:
        recipe_from_record(record)

    assert failure.value.code == "RECIPE_FINGERPRINT_MISMATCH"


def test_the_leakage_guard_refuses_and_names_the_shared_items(tmp_path: Path) -> None:
    split = json.loads(TRACKED_SPLIT.read_text(encoding="utf-8"))
    leaking = copy.deepcopy(split)
    train_item = next(a for a in leaking["assignments"] if a["split"] == "train")
    moved = train_item["id"]
    # The same item id sits in two partitions: that is the leak.
    leaking["assignments"].append({**train_item, "split": "test"})
    target = tmp_path / "leaking.json"
    target.write_text(json.dumps(leaking), encoding="utf-8")

    with pytest.raises(RecipeError) as failure:
        resolve_tracked(split_path=str(target))

    assert failure.value.code == "RECIPE_PARTITION_LEAKAGE"
    assert failure.value.field == "partitions.train/test"
    assert moved in failure.value.reason


def test_the_leakage_guard_refuses_a_val_item_that_sits_in_test(
    tmp_path: Path,
) -> None:
    split = json.loads(TRACKED_SPLIT.read_text(encoding="utf-8"))
    leaking = copy.deepcopy(split)
    val_item = next(a for a in leaking["assignments"] if a["split"] == "val")
    leaking["assignments"].append({**val_item, "split": "test"})
    target = tmp_path / "leaking-val.json"
    target.write_text(json.dumps(leaking), encoding="utf-8")

    with pytest.raises(RecipeError) as failure:
        resolve_tracked(split_path=str(target))

    assert failure.value.code == "RECIPE_PARTITION_LEAKAGE"
    assert failure.value.field == "partitions.val/test"


def test_the_leakage_guard_refuses_an_item_that_hides_in_the_case(tmp_path: Path) -> None:
    """An item that differs only in the case is the same item.

    A leak that hides in a difference of the letters is a leak nobody sees
    in the metrics, and the guard compares the ids in their normalized
    form.
    """
    split = json.loads(TRACKED_SPLIT.read_text(encoding="utf-8"))
    leaking = copy.deepcopy(split)
    train_item = next(a for a in leaking["assignments"] if a["split"] == "train")
    leaking["assignments"].append(
        {**train_item, "id": train_item["id"].swapcase(), "split": "test"}
    )
    target = tmp_path / "leaking-case.json"
    target.write_text(json.dumps(leaking), encoding="utf-8")

    with pytest.raises(RecipeError) as failure:
        resolve_tracked(split_path=str(target))

    assert failure.value.code == "RECIPE_PARTITION_LEAKAGE"
    assert failure.value.field == "partitions.train/test"


def test_the_leakage_guard_refuses_an_item_that_hides_in_the_whitespace(
    tmp_path: Path,
) -> None:
    split = json.loads(TRACKED_SPLIT.read_text(encoding="utf-8"))
    leaking = copy.deepcopy(split)
    train_item = next(a for a in leaking["assignments"] if a["split"] == "train")
    leaking["assignments"].append(
        {**train_item, "id": train_item["id"] + " ", "split": "test"}
    )
    target = tmp_path / "leaking-space.json"
    target.write_text(json.dumps(leaking), encoding="utf-8")

    with pytest.raises(RecipeError) as failure:
        resolve_tracked(split_path=str(target))

    assert failure.value.code == "RECIPE_PARTITION_LEAKAGE"
    assert failure.value.field == "partitions.train/test"


def test_a_partition_with_no_item_is_refused(tmp_path: Path) -> None:
    """A recipe may not pin a partition that is empty.

    The other side refuses a partition with no item, and a recipe the
    other side refuses is a recipe that never reaches a trainer.
    """
    split = json.loads(TRACKED_SPLIT.read_text(encoding="utf-8"))
    emptied = copy.deepcopy(split)
    emptied["assignments"] = [
        a for a in emptied["assignments"] if a["split"] != "test"
    ]
    target = tmp_path / "empty-test.json"
    target.write_text(json.dumps(emptied), encoding="utf-8")

    with pytest.raises(RecipeError) as failure:
        resolve_tracked(split_path=str(target))

    assert failure.value.code == "RECIPE_SPLIT_INVALID"
    assert failure.value.field == "partitions.test"


def test_a_split_that_names_a_snapshot_it_does_not_have_is_refused(
    tmp_path: Path,
) -> None:
    """The fingerprint of the partition is recomputed, not taken on trust.

    The recipe holds the ids of the partition, so it can tell whether the
    snapshot the split names is the snapshot the split holds.
    """
    split = json.loads(TRACKED_SPLIT.read_text(encoding="utf-8"))
    tampered = copy.deepcopy(split)
    moved = next(a for a in tampered["assignments"] if a["split"] == "val")
    moved["split"] = "train"
    target = tmp_path / "tampered.json"
    target.write_text(json.dumps(tampered), encoding="utf-8")

    with pytest.raises(RecipeError) as failure:
        resolve_tracked(split_path=str(target))

    assert failure.value.code == "RECIPE_SNAPSHOT_MISMATCH"
    assert failure.value.field == "dataset.snapshotFingerprint"


def test_the_snapshot_fingerprint_of_the_recipe_is_the_digest_of_the_partition() -> None:
    """The recipe pins the partition the split holds, not the name of it."""
    split = json.loads(TRACKED_SPLIT.read_text(encoding="utf-8"))

    recipe = resolve_tracked()

    assert recipe.dataset.snapshot_fingerprint == partition_fingerprint_of(
        split["assignments"]
    )
    assert recipe.dataset.snapshot_fingerprint == split["partitionFingerprint"]


def test_a_split_without_the_fingerprint_of_its_snapshot_is_refused(
    tmp_path: Path,
) -> None:
    """The data pin names the snapshot, and a recipe may not invent it."""
    split = json.loads(TRACKED_SPLIT.read_text(encoding="utf-8"))
    without = copy.deepcopy(split)
    del without["partitionFingerprint"]
    target = tmp_path / "without-fingerprint.json"
    target.write_text(json.dumps(without), encoding="utf-8")

    with pytest.raises(RecipeError) as failure:
        resolve_tracked(split_path=str(target))

    assert failure.value.code == "RECIPE_DATASET_FIELD_MISSING"
    assert failure.value.field == "dataset.snapshotFingerprint"


def test_a_record_with_an_empty_field_the_pin_needs_is_refused() -> None:
    """A pin field with no value is a field the run does not pin.

    The other side refuses such a recipe, and the read-back path refuses
    it too, so the two sides judge the same wire form the same way.
    """
    recipe = resolve_tracked()
    record = recipe.to_record()
    record["encoder"]["featureExtractor"] = ""

    with pytest.raises(RecipeError) as failure:
        recipe_from_record(record)

    assert failure.value.code == "RECIPE_ENCODER_FIELD_MISSING"
    assert failure.value.field == "encoder.featureExtractor"


def test_the_floating_revision_is_refused_and_names_the_field(tmp_path: Path) -> None:
    record = tracked_model()
    record["revision"] = "latest"
    registry = write_registry(tmp_path, [record])

    with pytest.raises(RecipeError) as failure:
        resolve_tracked(registry_path=registry)

    # The record owns the rule of the floating revision and the recipe
    # inherits the refusal, naming the field it is about.
    assert failure.value.code == "RECIPE_ENCODER_FIELD_INVALID"
    assert failure.value.field == "models.0.revision"
    assert "latest" in failure.value.reason


def test_a_record_without_a_field_the_recipe_needs_is_refused(tmp_path: Path) -> None:
    record = tracked_model()
    del record["preprocessingFingerprint"]
    registry = write_registry(tmp_path, [record])

    with pytest.raises(RecipeError) as failure:
        resolve_tracked(registry_path=registry)

    assert failure.value.code == "RECIPE_ENCODER_FIELD_INVALID"
    assert failure.value.field == "models.0.preprocessingFingerprint"
    assert "does not carry this field" in failure.value.reason


def test_a_model_whose_usage_restrictions_are_empty_is_pinned(
    tmp_path: Path,
) -> None:
    """The pin inherits the exemption of the record.

    The record lets the usage restrictions be empty, because a model may
    forbid nothing, and a rule the recipe holds to a stricter shape than
    the record refuses a model the platform is allowed to run.
    """
    record = tracked_model()
    record["usageRestrictions"] = ""
    registry = write_registry(tmp_path, [record])

    recipe = resolve_tracked(registry_path=registry)

    assert recipe.encoder.usage_restrictions == ""


def test_a_record_with_a_field_nobody_knows_is_refused() -> None:
    """A field nobody knows is refused, not dropped.

    The other side refuses a record with a field nobody knows, and a field
    this side drops quietly is a field the two sides judge differently
    without saying so.
    """
    recipe = resolve_tracked()
    record = recipe.to_record()
    record["gpuTier"] = "a100"

    with pytest.raises(RecipeError) as failure:
        recipe_from_record(record)

    assert failure.value.code == "RECIPE_RECORD_UNKNOWN_FIELD"
    assert failure.value.field == "gpuTier"
    assert "gpuTier" in failure.value.reason


def test_a_run_without_epochs_is_refused() -> None:
    """The other side refuses a ceiling of zero epochs, and so does this one."""
    with pytest.raises(RecipeError) as failure:
        resolve_tracked(max_epochs=0)

    assert failure.value.code == "RECIPE_EPOCHS_INVALID"
    assert failure.value.field == "maxEpochs"


def test_a_run_with_a_ceiling_of_a_fraction_is_refused() -> None:
    with pytest.raises(RecipeError) as failure:
        resolve_tracked(max_epochs=1.5)

    assert failure.value.code == "RECIPE_EPOCHS_INVALID"


def test_a_run_without_checkpoints_is_refused() -> None:
    with pytest.raises(RecipeError) as failure:
        resolve_tracked(checkpoint_interval=0)

    assert failure.value.code == "RECIPE_CHECKPOINT_INTERVAL_INVALID"
    assert failure.value.field == "checkpointInterval"


def test_a_run_without_an_optimizer_is_refused() -> None:
    with pytest.raises(RecipeError) as failure:
        resolve_tracked(optimizer="")

    assert failure.value.code == "RECIPE_FIELD_INVALID"
    assert failure.value.field == "optimizer"


def test_a_run_with_an_empty_augmentation_is_refused() -> None:
    with pytest.raises(RecipeError) as failure:
        resolve_tracked(augmentation=["flip", ""])

    assert failure.value.code == "RECIPE_AUGMENTATION_INVALID"
    assert failure.value.field == "augmentation.1"


def test_a_seed_the_other_side_cannot_hold_exactly_is_refused() -> None:
    """A seed above the safe range reaches the other side rounded."""
    with pytest.raises(RecipeError) as failure:
        resolve_tracked(seed=9007199254740993)

    assert failure.value.code == "RECIPE_SEED_INVALID"
    assert failure.value.field == "seed"


def test_a_class_without_a_documented_weight_is_refused() -> None:
    weights = default_class_weights(label_keys_of_split())
    missing = sorted(weights)[0]
    del weights[missing]

    with pytest.raises(RecipeError) as failure:
        resolve_tracked(class_weights=weights)

    assert failure.value.code == "RECIPE_CLASS_WEIGHT_MISSING"
    assert failure.value.field == f"classWeights.{missing}"


def test_a_weight_for_a_class_the_ontology_does_not_have_is_refused() -> None:
    weights = default_class_weights(label_keys_of_split())
    weights["defect:not-a-class"] = "none"

    with pytest.raises(RecipeError) as failure:
        resolve_tracked(class_weights=weights)

    assert failure.value.code == "RECIPE_CLASS_WEIGHT_UNKNOWN"
    assert "defect:not-a-class" in failure.value.reason


def test_a_weight_that_is_neither_a_number_nor_none_is_refused() -> None:
    weights = default_class_weights(label_keys_of_split())
    weights[sorted(weights)[0]] = "heavy"

    with pytest.raises(RecipeError) as failure:
        resolve_tracked(class_weights=weights)

    assert failure.value.code == "RECIPE_CLASS_WEIGHT_INVALID"


def test_a_numeric_weight_is_published_as_a_number() -> None:
    """A weight the run chose is a number, not the text of a number.

    The other side accepts a number or the word 'none', so a weight written
    as the text of a number is a weight the other side has to refuse.
    """
    weights = default_class_weights(label_keys_of_split())
    chosen = sorted(weights)[0]
    weights[chosen] = 2

    recipe = resolve_tracked(class_weights=weights)

    published = recipe.to_record()["classWeights"]
    assert published[chosen] == 2
    assert isinstance(published[chosen], (int, float))
    assert not isinstance(published[chosen], str)


def test_a_device_the_record_does_not_support_is_refused() -> None:
    with pytest.raises(RecipeError) as failure:
        resolve_tracked(device_policy="cuda")

    assert failure.value.code == "RECIPE_DEVICE_UNSUPPORTED"
    assert failure.value.field == "devicePolicy"
    assert "cpu" in failure.value.reason


def test_the_ontology_version_is_the_digest_of_the_class_space() -> None:
    keys = label_keys_of_split()

    assert ontology_version_of(keys) == ontology_version_of(list(reversed(keys)))
    assert ontology_version_of(keys).startswith("fp2:")
    assert ontology_version_of(keys) != ontology_version_of(keys[:-1])


def test_the_label_key_rule_matches_the_scored_one() -> None:
    assert label_key_of("candle", "normal") == "normal"
    assert label_key_of("candle", "anomalous") == "defect:candle"
