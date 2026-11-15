"""The trainer of the M0 rung and the loader of the frozen features.

The trainer is the loop of the first rung: it trains on the `train`
partition, it selects on the `val` partition, it publishes a checkpoint at
every interval of epochs and it records the device, the curve, the
throughput and the read. These tests cover the properties the ticket names
(FR-003, FR-015, FR-016 and FR-025): the run never reads the test
partition, the checkpoint lands at the interval, the device is recorded with
the reason of its fallback, the cold and the warm read are reported
separately, and the frozen artifact of features is REUSED and checked
against the recipe.

The fixture is the TRACKED split of the repository, with the vectors the
fixture needs: every class of the gold vocabulary gets its own unit vector,
so the classes are separable and the fit reaches a hundred percent of the
train and of the validation accuracy. The artifact of features carries the
vectors of the train and of the validation items ONLY, so a trainer that
asked for the test items would be refused instead of silently training on
them.
"""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path
from typing import Any, Dict, List, Tuple

import pytest

from visionlens.inference.artifact import (
    VECTORS_FILE_NAME,
    EmbeddingRunManifest,
    write_embedding_artifact,
)
from visionlens.training.checkpoint import MANIFEST_SUFFIX, read_checkpoint
from visionlens.training.features import FeatureError, FeatureSet, load_features
from visionlens.training.recipe import (
    TrainRecipe,
    default_class_weights,
    label_key_of,
    recipe_fingerprint,
    resolve_recipe,
)
from visionlens.training.trainer import (
    SELECTION_PARTITIONS,
    SplitItem,
    TrainerError,
    split_items_of,
    train,
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

#: The epochs of the fixture and the interval of its checkpoints.
EPOCHS = 3
CHECKPOINT_INTERVAL = 2


def _assignments() -> List[Dict[str, Any]]:
    """The assignments of the tracked split."""
    split = json.loads(TRACKED_SPLIT.read_text(encoding="utf-8"))
    return list(split["assignments"])


def _label_keys_of_split() -> List[str]:
    """The label keys of the tracked split."""
    return sorted(
        {
            label_key_of(assignment["class"], assignment["anomaly"])
            for assignment in _assignments()
        }
    )


def fixture_recipe() -> TrainRecipe:
    """The recipe of the fixture.

    The recipe is the tracked one, narrowed to the epochs and to the
    dimension of the fixture, so the trainer runs against a recipe the
    resolver really produced.
    """
    recipe = resolve_recipe(
        registry_path=str(TRACKED_REGISTRY),
        model_id=MODEL_ID,
        split_path=str(TRACKED_SPLIT),
        class_weights=default_class_weights(_label_keys_of_split()),
        hyperparameters=HYPERPARAMETERS,
    )
    dimension = len(_label_keys_of_split())
    narrowed = replace(
        recipe,
        encoder=replace(recipe.encoder, output_shape={"dimension": dimension}),
        hyperparameters={"C": 1.0, "maxIterations": EPOCHS, "solver": "lbfgs"},
        max_epochs=EPOCHS,
        checkpoint_interval=CHECKPOINT_INTERVAL,
    )
    return replace(narrowed, fingerprint=recipe_fingerprint(narrowed))


def fixture_items() -> Tuple[SplitItem, ...]:
    """The items of the tracked split: 420 train, 140 validation, 140 test."""
    return split_items_of(_assignments())


def _selected_items() -> Tuple[SplitItem, ...]:
    """The items the trainer is allowed to read."""
    return tuple(
        item for item in fixture_items() if item.partition in SELECTION_PARTITIONS
    )


def _vector_of(
    label_key: str, label_keys: Tuple[str, ...], dimension: int
) -> Tuple[float, ...]:
    """The unit vector of the class of an item."""
    index = label_keys.index(label_key)
    unit = tuple(1.0 if position == index else 0.0 for position in range(len(label_keys)))
    if dimension <= len(unit):
        return unit[:dimension]
    return unit + (0.0,) * (dimension - len(unit))


def write_feature_artifact(
    root: Path,
    items: Tuple[SplitItem, ...],
    *,
    revision: str,
    preprocessing: str,
    dimension: int,
    label_keys: Tuple[str, ...],
    run_id: str = "fixture-run",
) -> Path:
    """Writes the artifact of features of the fixture items."""
    vectors = [_vector_of(item.label_key, label_keys, dimension) for item in items]
    manifest = EmbeddingRunManifest(
        embedding_run_id=run_id,
        model_id=MODEL_ID,
        revision=revision,
        source_uri="file:///fixture",
        weights_digest="0" * 64,
        preprocessing_fingerprint=preprocessing,
        preprocessing_components={},
        snapshot_id="fixture-snapshot",
        asset_sha256=tuple(item.digest for item in items),
        count=len(vectors),
        dimension=dimension,
        dtype="float32",
        vectors_file_digest="",
        device="cpu",
        runtime_versions={},
        created_at="2026-01-01T00:00:00Z",
        latency={},
        peak_memory_bytes=None,
        license="apache-2.0",
        calibration_status="unknown",
    )
    return write_embedding_artifact(root, manifest, vectors).directory


def feature_directory(tmp_path: Path, recipe: TrainRecipe) -> Path:
    """The artifact of features that agrees with the recipe."""
    return write_feature_artifact(
        tmp_path / "features",
        _selected_items(),
        revision=recipe.encoder.revision,
        preprocessing=recipe.encoder.preprocessing_fingerprint,
        dimension=recipe.encoder.output_shape["dimension"],
        label_keys=tuple(_label_keys_of_split()),
    )


# --- the loop ----------------------------------------------------------------


def test_the_run_trains_on_train_and_selects_on_val(tmp_path: Path) -> None:
    """The curve carries the accuracy of the train and of the validation."""
    recipe = fixture_recipe()
    run = train(
        recipe,
        fixture_items(),
        [feature_directory(tmp_path, recipe)],
        tmp_path / "checkpoints",
    )

    assert len(run.curve) == EPOCHS
    assert [point.epoch for point in run.curve] == [1, 2, 3]
    for point in run.curve:
        assert point.train_accuracy == 1.0
        assert point.val_accuracy == 1.0


def test_the_run_never_reads_the_test_partition(tmp_path: Path) -> None:
    """The items the run read are the train and the validation ones.

    The artifact of features carries NO vector of the test partition, so a
    trainer that asked for the test items would have been refused. The run
    completing is the proof that it never asked.
    """
    recipe = fixture_recipe()
    run = train(
        recipe,
        fixture_items(),
        [feature_directory(tmp_path, recipe)],
        tmp_path / "checkpoints",
    )

    read = set(run.read_items)
    assert read == {item.item_id for item in _selected_items()}
    assert not any(
        item.partition == "test" for item in fixture_items() if item.item_id in read
    )


def test_an_item_the_recipe_does_not_pin_is_refused(tmp_path: Path) -> None:
    """A run over items nobody pinned is a run nobody can reproduce."""
    recipe = fixture_recipe()
    items = list(fixture_items())
    items[0] = replace(items[0], item_id="a-item-the-recipe-does-not-pin")

    with pytest.raises(TrainerError) as failure:
        train(
            recipe,
            tuple(items),
            [feature_directory(tmp_path, recipe)],
            tmp_path / "checkpoints",
        )

    assert failure.value.code == "TRAINER_PARTITION_MISMATCH"
    assert "partitions.train" in failure.value.field


def test_an_item_of_the_test_partition_in_the_selection_is_refused(
    tmp_path: Path,
) -> None:
    """The selection code and the evaluation code are separate modules."""
    recipe = fixture_recipe()
    items = list(fixture_items())
    locked = next(item for item in items if item.partition == "test")
    first_train = next(item for item in items if item.partition == "train")
    items[items.index(first_train)] = replace(
        first_train, item_id=locked.item_id, digest=locked.digest
    )

    with pytest.raises(TrainerError) as failure:
        train(
            recipe,
            tuple(items),
            [feature_directory(tmp_path, recipe)],
            tmp_path / "checkpoints",
        )

    assert failure.value.code == "TRAINER_PARTITION_MISMATCH"


def test_the_checkpoint_lands_at_the_interval_and_at_the_last_epoch(
    tmp_path: Path,
) -> None:
    """One checkpoint every interval of epochs, and one at the last epoch."""
    recipe = fixture_recipe()
    checkpoints = tmp_path / "checkpoints"
    run = train(
        recipe,
        fixture_items(),
        [feature_directory(tmp_path, recipe)],
        checkpoints,
    )

    assert len(run.checkpoints) == 2
    assert run.final_checkpoint == run.checkpoints[-1]
    assert len(set(run.checkpoints)) == 2

    manifests = sorted(checkpoints.glob("*" + MANIFEST_SUFFIX))
    assert len(manifests) == 2
    loaded = [read_checkpoint(path) for path in manifests]
    assert [item.epoch for item in loaded] == [CHECKPOINT_INTERVAL, EPOCHS]
    assert tuple(item.manifest.checkpoint_sha256 for item in loaded) == run.checkpoints
    for item in loaded:
        assert (checkpoints / item.manifest.checkpoint_file).is_file()


def test_the_run_records_the_device_and_the_reason_of_the_fallback(
    tmp_path: Path,
) -> None:
    """The device of the run and the reason of the fallback are recorded."""
    recipe = replace(fixture_recipe(), device_policy="auto")
    recipe = replace(recipe, fingerprint=recipe_fingerprint(recipe))

    run = train(
        recipe,
        fixture_items(),
        [feature_directory(tmp_path, recipe)],
        tmp_path / "checkpoints",
    )

    assert run.device == "cpu"
    assert run.requested_device == "auto"
    assert "cpu" in run.device_reason.lower()
    assert "cpu" in run.fallback_reason.lower()


def test_a_device_the_build_does_not_admit_is_refused(tmp_path: Path) -> None:
    """An explicit device nobody admits is refused, never substituted."""
    recipe = replace(fixture_recipe(), device_policy="mps")
    recipe = replace(recipe, fingerprint=recipe_fingerprint(recipe))

    with pytest.raises(TrainerError) as failure:
        train(
            recipe,
            fixture_items(),
            [feature_directory(tmp_path, recipe)],
            tmp_path / "checkpoints",
        )

    assert failure.value.code == "TRAINER_DEVICE_UNSUPPORTED"
    assert "mps" in failure.value.reason
    assert "cpu" in failure.value.reason


def test_the_cold_and_the_warm_read_are_reported_separately(tmp_path: Path) -> None:
    """The first read and the percentiles of the rest are separate numbers."""
    recipe = fixture_recipe()
    run = train(
        recipe,
        fixture_items(),
        [feature_directory(tmp_path, recipe)],
        tmp_path / "checkpoints",
    )

    assert run.cold_read_ms > 0.0
    assert run.warm_read_p50_ms > 0.0
    assert run.warm_read_p95_ms > 0.0
    wire = run.to_dict()
    assert wire["coldReadMs"] == run.cold_read_ms
    assert wire["warmReadP50Ms"] == run.warm_read_p50_ms
    assert wire["warmReadP95Ms"] == run.warm_read_p95_ms


def test_the_run_records_the_throughput_and_the_peak_memory(tmp_path: Path) -> None:
    """The run carries the numbers the hardware matrix asks for."""
    recipe = fixture_recipe()
    run = train(
        recipe,
        fixture_items(),
        [feature_directory(tmp_path, recipe)],
        tmp_path / "checkpoints",
    )

    assert run.throughput_per_second > 0.0
    assert run.peak_memory_bytes is not None
    assert run.to_dict()["throughputPerSecond"] == run.throughput_per_second


def test_the_feature_artifact_is_reused_and_never_recomputed(tmp_path: Path) -> None:
    """The vectors on the disk are the ones the run trained on."""
    recipe = fixture_recipe()
    directory = feature_directory(tmp_path, recipe)
    before = (directory / VECTORS_FILE_NAME).read_bytes()

    run = train(
        recipe,
        fixture_items(),
        [directory],
        tmp_path / "checkpoints",
    )

    assert (directory / VECTORS_FILE_NAME).read_bytes() == before
    assert len(run.feature_digests) == 1
    assert len(run.feature_digests[0]) == 64


def test_an_empty_train_partition_is_refused(tmp_path: Path) -> None:
    """A probe over no train item is a probe over nothing."""
    recipe = fixture_recipe()
    items = tuple(item for item in fixture_items() if item.partition != "train")

    with pytest.raises(TrainerError) as failure:
        train(
            recipe,
            items,
            [feature_directory(tmp_path, recipe)],
            tmp_path / "checkpoints",
        )

    assert failure.value.code == "TRAINER_PARTITION_MISMATCH"


def test_the_early_stopping_of_the_next_rung_is_refused(tmp_path: Path) -> None:
    """A criterion this rung does not apply is refused, never ignored."""
    recipe = replace(fixture_recipe(), early_stopping={"patience": 2})
    recipe = replace(recipe, fingerprint=recipe_fingerprint(recipe))

    with pytest.raises(TrainerError) as failure:
        train(
            recipe,
            fixture_items(),
            [feature_directory(tmp_path, recipe)],
            tmp_path / "checkpoints",
        )

    assert failure.value.code == "TRAINER_EARLY_STOPPING_UNSUPPORTED"


def test_a_recipe_with_a_wrong_fingerprint_is_refused(tmp_path: Path) -> None:
    """A recipe whose address is not its own is refused."""
    recipe = replace(fixture_recipe(), fingerprint="fp2:0000000000000000")

    with pytest.raises(TrainerError) as failure:
        train(
            recipe,
            fixture_items(),
            [feature_directory(tmp_path, recipe)],
            tmp_path / "checkpoints",
        )

    assert failure.value.code == "TRAINER_RECIPE_FINGERPRINT_MISMATCH"


# --- the loader of the frozen features ---------------------------------------


def test_the_loader_pairs_the_vectors_by_the_digest_of_the_image(
    tmp_path: Path,
) -> None:
    """A vector and an item are the same thing when their digests are."""
    recipe = fixture_recipe()
    items = _selected_items()

    feature_set: FeatureSet = load_features(
        [feature_directory(tmp_path, recipe)],
        recipe,
        [(item.item_id, item.digest) for item in items],
    )

    assert feature_set.item_ids == tuple(item.item_id for item in items)
    assert feature_set.dimension == recipe.encoder.output_shape["dimension"]
    assert feature_set.revision == recipe.encoder.revision
    assert feature_set.preprocessing_fingerprint == (
        recipe.encoder.preprocessing_fingerprint
    )
    assert feature_set.missing == ()


def test_an_artifact_of_another_revision_is_refused_naming_both_sides(
    tmp_path: Path,
) -> None:
    """The refusal names the revision of the artifact and the pinned one."""
    recipe = fixture_recipe()
    directory = write_feature_artifact(
        tmp_path / "features",
        _selected_items(),
        revision="another-revision",
        preprocessing=recipe.encoder.preprocessing_fingerprint,
        dimension=recipe.encoder.output_shape["dimension"],
        label_keys=tuple(_label_keys_of_split()),
    )

    with pytest.raises(FeatureError) as failure:
        load_features(
            [directory],
            recipe,
            [(item.item_id, item.digest) for item in _selected_items()],
        )

    assert failure.value.code == "FEATURES_REVISION_MISMATCH"
    assert "another-revision" in failure.value.reason
    assert recipe.encoder.revision in failure.value.reason


def test_an_artifact_of_another_preprocessing_is_refused_naming_both_sides(
    tmp_path: Path,
) -> None:
    """The refusal names the preprocessing of the artifact and the pinned one."""
    recipe = fixture_recipe()
    directory = write_feature_artifact(
        tmp_path / "features",
        _selected_items(),
        revision=recipe.encoder.revision,
        preprocessing="another-preprocessing",
        dimension=recipe.encoder.output_shape["dimension"],
        label_keys=tuple(_label_keys_of_split()),
    )

    with pytest.raises(FeatureError) as failure:
        load_features(
            [directory],
            recipe,
            [(item.item_id, item.digest) for item in _selected_items()],
        )

    assert failure.value.code == "FEATURES_PREPROCESSING_MISMATCH"
    assert "another-preprocessing" in failure.value.reason
    assert recipe.encoder.preprocessing_fingerprint in failure.value.reason


def test_an_artifact_of_another_dimension_is_refused_naming_both_sides(
    tmp_path: Path,
) -> None:
    """Vectors of two dimensions are not comparable, and both are named."""
    recipe = fixture_recipe()
    items = _selected_items()
    directory = write_feature_artifact(
        tmp_path / "features",
        items,
        revision=recipe.encoder.revision,
        preprocessing=recipe.encoder.preprocessing_fingerprint,
        dimension=recipe.encoder.output_shape["dimension"] + 1,
        label_keys=tuple(_label_keys_of_split()),
    )

    with pytest.raises(FeatureError) as failure:
        load_features(
            [directory],
            recipe,
            [(item.item_id, item.digest) for item in items],
        )

    assert failure.value.code == "FEATURES_DIMENSION_MISMATCH"
    assert str(recipe.encoder.output_shape["dimension"] + 1) in failure.value.reason
    assert str(recipe.encoder.output_shape["dimension"]) in failure.value.reason


def test_an_artifact_that_mixes_two_revisions_is_refused_naming_the_two(
    tmp_path: Path,
) -> None:
    """Two revisions in one run are vectors that are not comparable."""
    recipe = fixture_recipe()
    items = _selected_items()
    half = len(items) // 2
    first = write_feature_artifact(
        tmp_path / "features",
        items[:half],
        revision=recipe.encoder.revision,
        preprocessing=recipe.encoder.preprocessing_fingerprint,
        dimension=recipe.encoder.output_shape["dimension"],
        label_keys=tuple(_label_keys_of_split()),
        run_id="first-run",
    )
    second = write_feature_artifact(
        tmp_path / "features",
        items[half:],
        revision="another-revision",
        preprocessing=recipe.encoder.preprocessing_fingerprint,
        dimension=recipe.encoder.output_shape["dimension"],
        label_keys=tuple(_label_keys_of_split()),
        run_id="second-run",
    )

    with pytest.raises(FeatureError) as failure:
        load_features(
            [first, second],
            recipe,
            [(item.item_id, item.digest) for item in items],
        )

    assert failure.value.code == "FEATURES_MIXED_REVISION"
    assert "another-revision" in failure.value.reason
    assert recipe.encoder.revision in failure.value.reason


def test_an_artifact_that_mixes_two_preprocessings_is_refused_naming_the_two(
    tmp_path: Path,
) -> None:
    """Two preprocessing pipelines in one run are not comparable."""
    recipe = fixture_recipe()
    items = _selected_items()
    half = len(items) // 2
    first = write_feature_artifact(
        tmp_path / "features",
        items[:half],
        revision=recipe.encoder.revision,
        preprocessing=recipe.encoder.preprocessing_fingerprint,
        dimension=recipe.encoder.output_shape["dimension"],
        label_keys=tuple(_label_keys_of_split()),
        run_id="first-run",
    )
    second = write_feature_artifact(
        tmp_path / "features",
        items[half:],
        revision=recipe.encoder.revision,
        preprocessing="another-preprocessing",
        dimension=recipe.encoder.output_shape["dimension"],
        label_keys=tuple(_label_keys_of_split()),
        run_id="second-run",
    )

    with pytest.raises(FeatureError) as failure:
        load_features(
            [first, second],
            recipe,
            [(item.item_id, item.digest) for item in items],
        )

    assert failure.value.code == "FEATURES_MIXED_PREPROCESSING"
    assert "another-preprocessing" in failure.value.reason
    assert recipe.encoder.preprocessing_fingerprint in failure.value.reason


def test_an_artifact_of_another_dimension_beside_the_first_is_refused(
    tmp_path: Path,
) -> None:
    """Every artifact of the run is checked, not only the first one."""
    recipe = fixture_recipe()
    items = _selected_items()
    half = len(items) // 2
    first = write_feature_artifact(
        tmp_path / "features",
        items[:half],
        revision=recipe.encoder.revision,
        preprocessing=recipe.encoder.preprocessing_fingerprint,
        dimension=recipe.encoder.output_shape["dimension"],
        label_keys=tuple(_label_keys_of_split()),
        run_id="first-run",
    )
    second = write_feature_artifact(
        tmp_path / "features",
        items[half:],
        revision=recipe.encoder.revision,
        preprocessing=recipe.encoder.preprocessing_fingerprint,
        dimension=recipe.encoder.output_shape["dimension"] + 1,
        label_keys=tuple(_label_keys_of_split()),
        run_id="second-run",
    )

    with pytest.raises(FeatureError) as failure:
        load_features(
            [first, second],
            recipe,
            [(item.item_id, item.digest) for item in items],
        )

    assert failure.value.code == "FEATURES_DIMENSION_MISMATCH"


def test_a_digest_that_names_two_items_is_refused(tmp_path: Path) -> None:
    """A vector that belongs to two items is a vector nobody can pair."""
    recipe = fixture_recipe()
    items = _selected_items()
    shared = items[0].digest

    with pytest.raises(FeatureError) as failure:
        load_features(
            [feature_directory(tmp_path, recipe)],
            recipe,
            [(items[0].item_id, shared), (items[1].item_id, shared)],
        )

    assert failure.value.code == "FEATURES_ITEM_AMBIGUOUS"
    assert shared in failure.value.reason


def test_an_item_without_a_vector_is_recorded_as_missing(tmp_path: Path) -> None:
    """An item the artifact does not carry is a missing prediction."""
    recipe = fixture_recipe()
    items = _selected_items()
    absent = ("absent-item", "f" * 64)

    feature_set = load_features(
        [feature_directory(tmp_path, recipe)],
        recipe,
        [(items[0].item_id, items[0].digest), absent],
    )

    assert feature_set.missing == ("absent-item",)
    assert "absent-item" not in feature_set.item_ids


def test_the_loader_refuses_a_run_that_names_no_artifact() -> None:
    """A probe over no vector is a probe over nothing."""
    recipe = fixture_recipe()

    with pytest.raises(FeatureError) as failure:
        load_features([], recipe, [])

    assert failure.value.code == "FEATURES_ARTIFACT_MISSING"


# --- the items of the split --------------------------------------------------


def test_the_split_items_carry_the_label_key_of_the_taxonomy() -> None:
    """The label of an item is the one the taxonomy names."""
    items = split_items_of(
        [
            {
                "id": "a",
                "sha256": "a" * 64,
                "class": "candle",
                "anomaly": "defect",
                "split": "train",
            },
            {
                "id": "b",
                "sha256": "b" * 64,
                "class": "candle",
                "anomaly": "normal",
                "split": "val",
            },
        ]
    )

    assert items[0].label_key == "defect:candle"
    assert items[1].label_key == "normal"
    assert items[0].partition == "train"
    assert items[1].partition == "val"


def test_an_assignment_without_a_digest_is_refused() -> None:
    """A vector is paired with an item by its digest."""
    with pytest.raises(TrainerError) as failure:
        split_items_of(
            [
                {
                    "id": "a",
                    "class": "candle",
                    "anomaly": "defect",
                    "split": "train",
                }
            ]
        )

    assert failure.value.code == "TRAINER_SPLIT_INVALID"
    assert "sha256" in failure.value.field


def test_the_trainer_reads_only_the_selection_partitions() -> None:
    """The test partition is not one of the partitions the trainer reads."""
    assert SELECTION_PARTITIONS == ("train", "val")
    assert "test" not in SELECTION_PARTITIONS
