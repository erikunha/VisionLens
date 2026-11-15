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
    recipe = resolve_tracked()
    record = tracked_model()

    assert recipe.encoder.model_id == record["modelId"]
    assert recipe.encoder.revision == record["revision"]
    assert recipe.encoder.source_uri == record["sourceUri"]
    assert recipe.encoder.weights_digest == record["sourceDigest"]
    assert recipe.encoder.license == record["license"]
    assert recipe.encoder.license_url == record["licenseUrl"]
    assert recipe.encoder.commercial_use is record["commercialUse"]
    assert recipe.encoder.usage_restrictions == record["usageRestrictions"]
    assert list(recipe.encoder.required_extras) == record["requiredExtras"]
    assert list(recipe.encoder.tasks) == record["tasks"]
    assert recipe.encoder.preprocessing_fingerprint == record["preprocessingFingerprint"]
    assert list(recipe.encoder.device_support) == record["deviceSupport"]
    assert recipe.encoder.output_dimension == record["outputShape"]["dimension"]
    assert recipe.encoder.trust_policy == record["trustPolicy"]
    assert recipe.encoder.attribution == record["attribution"]


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


def test_a_recipe_rebuilt_from_its_record_keeps_its_fingerprint() -> None:
    recipe = resolve_tracked()
    record = recipe.to_record()
    record["fingerprint"] = ""

    rebuilt = recipe_from_record(record)
    assert rebuilt.fingerprint == recipe.fingerprint


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
