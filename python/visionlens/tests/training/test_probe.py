"""The probe of the M0 rung and the checkpoint it writes.

The probe is the estimator of the first rung of the ladder: a logistic
regression over the frozen vectors of the `train` partition. These tests
cover the three properties the ticket names: the tiny fixture OVERFITS, the
coefficients DIFFER from the initialization, and the checkpoint digest
RECOMPUTES from the bytes on the disk.

The tests that read the TRACKED registry and the TRACKED split prove that
the probe runs against the data the repository actually ships, and not
against a fixture that agrees with itself.
"""

from __future__ import annotations

import json
import subprocess
import sys
from dataclasses import replace
from pathlib import Path
from typing import Any, Dict, List, Tuple

import pytest

from visionlens.errors import MissingExtraError
from visionlens.hashing import sha256_of_bytes, sha256_of_file
from visionlens.training.checkpoint import (
    CHECKPOINT_VERSION,
    CheckpointError,
    checkpoint_digest,
    read_checkpoint,
    write_checkpoint,
)
from visionlens.training.probe import (
    MIN_CLASS_SUPPORT,
    NO_WEIGHT,
    ClassMap,
    ProbeError,
    ProbeModel,
    class_map_from_recipe,
    fit_probe,
    fit_probe_from_recipe,
)
from visionlens.training.recipe import (
    TrainRecipe,
    default_class_weights,
    label_key_of,
    ontology_version_of,
    recipe_fingerprint,
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

#: The two classes of the tiny fixture.
NORMAL = "normal"
DEFECT = "defect:candle"

#: The vectors of the tiny fixture: eight items, two classes, two
#: dimensions. The two classes are far apart, so a linear estimator can
#: separate them and the fixture overfits.
TINY_FEATURES: Tuple[Tuple[float, ...], ...] = (
    (2.0, 2.0),
    (2.1, 1.9),
    (1.9, 2.1),
    (2.05, 2.05),
    (-2.0, -2.0),
    (-2.1, -1.9),
    (-1.9, -2.1),
    (-2.05, -2.05),
)

TINY_LABELS: Tuple[str, ...] = (
    NORMAL,
    NORMAL,
    NORMAL,
    NORMAL,
    DEFECT,
    DEFECT,
    DEFECT,
    DEFECT,
)


def label_keys_of_split() -> List[str]:
    """The label keys of the tracked split."""
    split = json.loads(TRACKED_SPLIT.read_text(encoding="utf-8"))
    return sorted(
        {
            label_key_of(assignment["class"], assignment["anomaly"])
            for assignment in split["assignments"]
        }
    )


def tracked_recipe() -> TrainRecipe:
    """The recipe of the tracked registry and the tracked split."""
    return resolve_recipe(
        registry_path=str(TRACKED_REGISTRY),
        model_id=MODEL_ID,
        split_path=str(TRACKED_SPLIT),
        class_weights=default_class_weights(label_keys_of_split()),
        hyperparameters=HYPERPARAMETERS,
    )


def tiny_recipe() -> TrainRecipe:
    """The recipe of the tiny fixture: two classes, both without a weight.

    The recipe is the tracked one with the class space of the fixture, so
    the probe runs against a recipe the resolver really produced.
    """
    recipe = tracked_recipe()
    weights = {NORMAL: NO_WEIGHT, DEFECT: NO_WEIGHT}
    narrowed = replace(
        recipe,
        class_weights=weights,
        ontology_version=ontology_version_of([NORMAL, DEFECT]),
        hyperparameters=dict(HYPERPARAMETERS),
    )
    return replace(narrowed, fingerprint=recipe_fingerprint(narrowed))


def test_the_tiny_fixture_overfits_to_a_hundred_percent() -> None:
    """The probe separates the eight items of the fixture perfectly.

    The test fails if the estimator is replaced by a constant predictor: a
    constant predictor reaches a third of the fixture, not all of it.
    """
    model = fit_probe_from_recipe(tiny_recipe(), TINY_FEATURES, TINY_LABELS)

    assert model.train_accuracy == 1.0
    assert len(model.coefficients) == 2
    for vector, label_key in zip(TINY_FEATURES, TINY_LABELS):
        assert model.predict(vector) == label_key


def test_the_coefficients_differ_from_the_initialization() -> None:
    """The fit moved the parameters away from the initialization.

    The estimator starts with a matrix of zeros, so a matrix that is still all
    zeros is a matrix nobody fitted.
    """
    model = fit_probe_from_recipe(tiny_recipe(), TINY_FEATURES, TINY_LABELS)

    assert any(value != 0.0 for row in model.coefficients for value in row)
    # The intercepts of this fixture are zero, and that is right: the two
    # classes sit around the origin, so the separator of the fixture passes
    # through it. The matrix of the coefficients is what the fit moves.


def test_the_class_map_is_built_from_the_gold_vocabulary() -> None:
    """The class space of the run is the vocabulary of its recipe."""
    recipe = tiny_recipe()
    class_map = class_map_from_recipe(recipe)

    assert class_map.label_keys == (DEFECT, NORMAL)
    assert class_map.index_of == {DEFECT: 0, NORMAL: 1}
    assert class_map.index_of_label(NORMAL) == 1


def test_a_label_outside_the_gold_vocabulary_is_a_hard_error() -> None:
    """A label the vocabulary does not have cannot be predicted.

    The refusal is an error and not a coercion: a label nobody chose is not
    turned into a label that exists.
    """
    labels = list(TINY_LABELS)
    labels[0] = "defect:fryum"

    with pytest.raises(ProbeError) as failure:
        fit_probe_from_recipe(tiny_recipe(), TINY_FEATURES, labels)

    assert failure.value.code == "PROBE_LABEL_UNKNOWN"
    assert "defect:fryum" in failure.value.reason


def test_every_class_needs_a_documented_weight() -> None:
    """A class without a documented weight is refused by the probe."""
    recipe = tiny_recipe()
    weights = {NORMAL: NO_WEIGHT}

    with pytest.raises(ProbeError) as failure:
        fit_probe(
            features=TINY_FEATURES,
            labels=TINY_LABELS,
            class_map=class_map_from_recipe(recipe),
            seed=recipe.seed,
            hyperparameters=recipe.hyperparameters,
            solver=recipe.optimizer,
            max_epochs=recipe.max_epochs,
            class_weights=weights,
        )

    assert failure.value.code == "PROBE_CLASS_WEIGHT_MISSING"


def test_a_class_with_an_insufficient_support_is_recorded_and_not_dropped() -> None:
    """A class with too few items is recorded, and it stays in the class map.

    The class is never dropped from the fit: a dropped class is a class the
    run never reports, and the support of every class is in the record.
    """
    recipe = tiny_recipe()
    features = TINY_FEATURES[:4] + (TINY_FEATURES[4],)
    labels = TINY_LABELS[:4] + (TINY_LABELS[4],)

    model = fit_probe_from_recipe(recipe, features, labels)

    assert model.class_support == {DEFECT: 1, NORMAL: 4}
    assert model.insufficient_support == (DEFECT,)
    assert model.class_support[DEFECT] < MIN_CLASS_SUPPORT
    assert set(model.class_map.label_keys) == {DEFECT, NORMAL}
    assert len(model.coefficients) == 2


def test_the_same_seed_fits_the_same_parameters() -> None:
    """The fit is reproducible given the seed and the pinned configuration."""
    recipe = tiny_recipe()

    first = fit_probe_from_recipe(recipe, TINY_FEATURES, TINY_LABELS)
    second = fit_probe_from_recipe(recipe, TINY_FEATURES, TINY_LABELS)

    assert first.coefficients == second.coefficients
    assert first.intercepts == second.intercepts
    assert first.train_accuracy == second.train_accuracy


def test_a_hyperparameter_the_estimator_does_not_know_is_refused() -> None:
    """A hyperparameter nobody applies is a decision nobody pinned."""
    recipe = tiny_recipe()
    hyperparameters = dict(recipe.hyperparameters)
    hyperparameters["momentum"] = 0.9

    with pytest.raises(ProbeError) as failure:
        fit_probe_from_recipe(
            replace(recipe, hyperparameters=hyperparameters), TINY_FEATURES, TINY_LABELS
        )

    assert failure.value.code == "PROBE_HYPERPARAMETER_UNKNOWN"


def test_a_hyperparameter_that_disagrees_with_the_recipe_is_refused() -> None:
    """Two ceilings that disagree are two runs."""
    recipe = tiny_recipe()
    hyperparameters = dict(recipe.hyperparameters)
    hyperparameters["maxIterations"] = 50

    with pytest.raises(ProbeError) as failure:
        fit_probe_from_recipe(
            replace(recipe, hyperparameters=hyperparameters), TINY_FEATURES, TINY_LABELS
        )

    assert failure.value.code == "PROBE_HYPERPARAMETER_DISAGREEMENT"


def test_the_missing_extra_is_actionable() -> None:
    """A caller without the extra gets the command that provides it."""
    blocked = ("sklearn", "sklearn.linear_model")
    original = {name: sys.modules.get(name) for name in blocked}
    for name in blocked:
        sys.modules[name] = None  # type: ignore[assignment]
    try:
        with pytest.raises(MissingExtraError) as failure:
            fit_probe_from_recipe(tiny_recipe(), TINY_FEATURES, TINY_LABELS)
    finally:
        for name, module in original.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module

    assert "visionlens[training]" in failure.value.message


def test_importing_the_training_surface_never_imports_the_heavy_stack() -> None:
    """The base install never imports scikit-learn.

    The estimator is imported inside the fit, so a caller that has no extra
    installed can still import the training surface of the package.
    """
    completed = subprocess.run(
        [
            sys.executable,
            "-c",
            "import sys\n"
            "import visionlens.training.probe\n"
            "import visionlens.training.checkpoint\n"
            "heavy = [name for name in ('sklearn', 'numpy', 'joblib') if name in sys.modules]\n"
            "assert not heavy, heavy\n"
            "print('CLEAN')\n",
        ],
        capture_output=True,
        text=True,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr
    assert "CLEAN" in completed.stdout


def test_the_checkpoint_digest_recomputes_from_the_bytes_on_the_disk(
    tmp_path: Path,
) -> None:
    """The digest of the manifest is the digest of the file it names."""
    recipe = tiny_recipe()
    model = fit_probe_from_recipe(recipe, TINY_FEATURES, TINY_LABELS)

    manifest = write_checkpoint(
        tmp_path, model, epoch=3, recipe_fingerprint=recipe.fingerprint
    )

    checkpoint_path = tmp_path / manifest.checkpoint_file
    assert checkpoint_path.is_file()
    assert manifest.checkpoint_sha256 == sha256_of_file(checkpoint_path)
    assert checkpoint_digest(checkpoint_path) == manifest.checkpoint_sha256
    assert manifest.version == CHECKPOINT_VERSION
    assert manifest.epoch == 3
    assert manifest.recipe_fingerprint == recipe.fingerprint
    assert manifest.class_map.to_dict() == model.class_map.to_dict()


def test_the_checkpoint_is_named_after_its_own_digest(tmp_path: Path) -> None:
    """The artifact is addressed by its content."""
    recipe = tiny_recipe()
    model = fit_probe_from_recipe(recipe, TINY_FEATURES, TINY_LABELS)

    manifest = write_checkpoint(
        tmp_path, model, epoch=1, recipe_fingerprint=recipe.fingerprint
    )

    assert manifest.checkpoint_file == manifest.checkpoint_sha256 + ".json"


def test_the_class_map_loads_back(tmp_path: Path) -> None:
    """The checkpoint carries the class map, and it loads back unchanged."""
    recipe = tiny_recipe()
    model = fit_probe_from_recipe(recipe, TINY_FEATURES, TINY_LABELS)
    manifest = write_checkpoint(
        tmp_path, model, epoch=1, recipe_fingerprint=recipe.fingerprint
    )

    loaded = read_checkpoint(tmp_path / "checkpoint-000001.manifest.json")

    assert loaded.manifest.checkpoint_sha256 == manifest.checkpoint_sha256
    assert loaded.model.class_map.to_dict() == model.class_map.to_dict()
    assert loaded.model.class_map.label_keys == model.class_map.label_keys
    for vector, label_key in zip(TINY_FEATURES, TINY_LABELS):
        assert loaded.model.predict(vector) == label_key


def test_a_checkpoint_whose_bytes_changed_is_refused(tmp_path: Path) -> None:
    """A checkpoint that was edited is refused, and it is not loaded."""
    recipe = tiny_recipe()
    model = fit_probe_from_recipe(recipe, TINY_FEATURES, TINY_LABELS)
    manifest = write_checkpoint(
        tmp_path, model, epoch=1, recipe_fingerprint=recipe.fingerprint
    )
    checkpoint_path = tmp_path / manifest.checkpoint_file
    checkpoint_path.write_text(
        json.dumps({"model": {"coefficients": [[0.0, 0.0]]}}, sort_keys=True),
        encoding="utf-8",
    )

    with pytest.raises(CheckpointError) as failure:
        read_checkpoint(tmp_path / "checkpoint-000001.manifest.json")

    assert failure.value.code == "CHECKPOINT_DIGEST_MISMATCH"
    assert manifest.checkpoint_sha256 in failure.value.reason


def test_a_manifest_that_names_another_recipe_is_refused(tmp_path: Path) -> None:
    """The manifest and the checkpoint have to agree about the recipe."""
    recipe = tiny_recipe()
    model = fit_probe_from_recipe(recipe, TINY_FEATURES, TINY_LABELS)
    write_checkpoint(tmp_path, model, epoch=1, recipe_fingerprint=recipe.fingerprint)
    manifest_path = tmp_path / "checkpoint-000001.manifest.json"
    record = json.loads(manifest_path.read_text(encoding="utf-8"))
    record["recipeFingerprint"] = "fp2:0000000000000000"
    manifest_path.write_text(json.dumps(record, sort_keys=True), encoding="utf-8")

    with pytest.raises(CheckpointError) as failure:
        read_checkpoint(manifest_path)

    assert failure.value.code == "CHECKPOINT_STATE_MISMATCH"


def test_the_epoch_of_a_checkpoint_is_the_resume_state(tmp_path: Path) -> None:
    """A run that was interrupted continues after the epoch it reached."""
    recipe = tiny_recipe()
    model = fit_probe_from_recipe(recipe, TINY_FEATURES, TINY_LABELS)
    manifest = write_checkpoint(
        tmp_path, model, epoch=3, recipe_fingerprint=recipe.fingerprint
    )

    loaded = read_checkpoint(tmp_path / "checkpoint-000003.manifest.json")

    assert loaded.epoch == 3
    assert loaded.manifest.next_epoch() == 4
    assert manifest.next_epoch() == 4


def test_two_checkpoints_of_one_epoch_with_other_bytes_are_refused(
    tmp_path: Path,
) -> None:
    """Two different checkpoints of one epoch are two runs."""
    recipe = tiny_recipe()
    model = fit_probe_from_recipe(recipe, TINY_FEATURES, TINY_LABELS)
    write_checkpoint(tmp_path, model, epoch=1, recipe_fingerprint=recipe.fingerprint)
    other = replace(
        model,
        coefficients=tuple(tuple(value + 1.0 for value in row) for row in model.coefficients),
    )

    with pytest.raises(CheckpointError) as failure:
        write_checkpoint(
            tmp_path, other, epoch=1, recipe_fingerprint=recipe.fingerprint
        )

    assert failure.value.code == "CHECKPOINT_MANIFEST_CONFLICT"


def test_a_checkpoint_without_a_manifest_is_not_published(tmp_path: Path) -> None:
    """A run that died before the manifest published nothing.

    The file of the checkpoint is written first and it is named after its own
    digest, so a reader finds it by the manifest and never by a name the run
    guessed.
    """
    recipe = tiny_recipe()
    model = fit_probe_from_recipe(recipe, TINY_FEATURES, TINY_LABELS)
    manifest = write_checkpoint(
        tmp_path, model, epoch=1, recipe_fingerprint=recipe.fingerprint
    )

    assert sorted(path.name for path in tmp_path.iterdir()) == [
        manifest.checkpoint_file,
        "checkpoint-000001.manifest.json",
    ]


def test_a_model_that_is_not_a_probe_is_refused() -> None:
    """The wire form of the model is checked before it is read back."""
    with pytest.raises(ProbeError) as failure:
        ProbeModel.from_dict({"coefficients": [[0.0, 0.0]], "intercepts": [0.0]})

    assert failure.value.code == "PROBE_MODEL_INVALID"


def test_a_class_map_whose_indices_disagree_is_refused() -> None:
    """A map that describes two class spaces at once is refused."""
    with pytest.raises(ProbeError) as failure:
        ClassMap.from_dict(
            {"labelKeys": [DEFECT, NORMAL], "indexOf": {DEFECT: 1, NORMAL: 0}}
        )

    assert failure.value.code == "PROBE_CLASS_SPACE_INVALID"

def test_a_checkpoint_that_carries_no_model_is_refused_by_the_checkpoint(
    tmp_path: Path,
) -> None:
    """The refusal of a checkpoint speaks the vocabulary of the checkpoint.

    The digest of the file is the digest of the bytes of the manifest, so
    the payload is reached with a manifest that names the payload it has.
    """
    recipe = tiny_recipe()
    model = fit_probe_from_recipe(recipe, TINY_FEATURES, TINY_LABELS)
    manifest = write_checkpoint(
        tmp_path, model, epoch=1, recipe_fingerprint=recipe.fingerprint
    )
    checkpoint_path = tmp_path / manifest.checkpoint_file
    payload = json.loads(checkpoint_path.read_text(encoding="utf-8"))
    payload.pop("model")
    body = (json.dumps(payload, sort_keys=True, indent=2) + "\n").encode("utf-8")
    checkpoint_path.write_bytes(body)
    manifest_path = tmp_path / "checkpoint-000001.manifest.json"
    record = json.loads(manifest_path.read_text(encoding="utf-8"))
    record["checkpointSha256"] = sha256_of_bytes(body)
    manifest_path.write_text(json.dumps(record, sort_keys=True), encoding="utf-8")

    with pytest.raises(CheckpointError) as failure:
        read_checkpoint(manifest_path)

    assert failure.value.code == "CHECKPOINT_FILE_INVALID"


def test_a_manifest_that_names_a_file_outside_the_run_is_refused(
    tmp_path: Path,
) -> None:
    """A checkpoint is a file of the directory of its manifest.

    A manifest that names a path would make the reader hash a file the run
    never published.
    """
    recipe = tiny_recipe()
    model = fit_probe_from_recipe(recipe, TINY_FEATURES, TINY_LABELS)
    write_checkpoint(tmp_path, model, epoch=1, recipe_fingerprint=recipe.fingerprint)
    manifest_path = tmp_path / "checkpoint-000001.manifest.json"
    record = json.loads(manifest_path.read_text(encoding="utf-8"))
    record["checkpointFile"] = "../outside.json"
    manifest_path.write_text(json.dumps(record, sort_keys=True), encoding="utf-8")

    with pytest.raises(CheckpointError) as failure:
        read_checkpoint(manifest_path)

    assert failure.value.code == "CHECKPOINT_MANIFEST_INVALID"


def test_a_model_whose_rows_carry_another_dimension_is_refused() -> None:
    """The rows of a model and the vectors of the run share one dimension."""
    model = fit_probe_from_recipe(tiny_recipe(), TINY_FEATURES, TINY_LABELS)
    record = model.to_dict()
    record["dimension"] = 3

    with pytest.raises(ProbeError) as failure:
        ProbeModel.from_dict(record)

    assert failure.value.code == "PROBE_MODEL_INVALID"


def test_a_publication_that_fails_is_refused_in_the_vocabulary_of_the_run(
    tmp_path: Path,
) -> None:
    """A write that fails is a refusal of the checkpoint and not an OSError."""
    recipe = tiny_recipe()
    model = fit_probe_from_recipe(recipe, TINY_FEATURES, TINY_LABELS)
    locked = tmp_path / "locked"
    locked.mkdir()
    locked.chmod(0o500)
    try:
        try:
            write_checkpoint(
                locked, model, epoch=1, recipe_fingerprint=recipe.fingerprint
            )
        except CheckpointError as error:
            assert error.code == "CHECKPOINT_WRITE_FAILED"
            return
    finally:
        locked.chmod(0o700)
    pytest.skip("this environment writes in a directory without the write bit")





def test_a_parameter_that_is_not_a_finite_number_is_refused() -> None:
    """A parameter that is not finite answers with a score nobody can read."""
    model = fit_probe_from_recipe(tiny_recipe(), TINY_FEATURES, TINY_LABELS)
    record = model.to_dict()
    record["coefficients"] = [[float("nan"), 0.0], [0.0, 0.0]]

    with pytest.raises(ProbeError) as failure:
        ProbeModel.from_dict(record)

    assert failure.value.code == "PROBE_MODEL_INVALID"




def test_a_model_whose_support_names_a_class_it_does_not_have_is_refused() -> None:
    """The support of a class the model does not have is not a support."""
    model = fit_probe_from_recipe(tiny_recipe(), TINY_FEATURES, TINY_LABELS)
    record = model.to_dict()
    record["classSupport"] = {**record["classSupport"], "defect:fryum": 3}

    with pytest.raises(ProbeError) as failure:
        ProbeModel.from_dict(record)

    assert failure.value.code == "PROBE_MODEL_INVALID"




def test_a_model_with_a_field_of_the_wrong_shape_is_refused_by_the_model() -> None:
    """A model that carries a field of the wrong shape is refused by it."""
    model = fit_probe_from_recipe(tiny_recipe(), TINY_FEATURES, TINY_LABELS)
    record = model.to_dict()
    record["classSupport"] = "not a mapping"

    with pytest.raises(ProbeError) as failure:
        ProbeModel.from_dict(record)

    assert failure.value.code == "PROBE_MODEL_INVALID"


def test_a_class_map_whose_label_key_is_not_a_name_is_refused() -> None:
    """A class of the ontology names itself with a label key."""
    with pytest.raises(ProbeError) as failure:
        ClassMap.from_dict({"labelKeys": [1, NORMAL], "indexOf": {1: 0, NORMAL: 1}})

    assert failure.value.code == "PROBE_CLASS_SPACE_INVALID"




def test_a_checkpoint_that_is_a_symlink_out_of_the_run_is_refused(
    tmp_path: Path,
) -> None:
    """A checkpoint is a file of the run and not a link to a file of
    somebody else."""
    recipe = tiny_recipe()
    model = fit_probe_from_recipe(recipe, TINY_FEATURES, TINY_LABELS)
    run = tmp_path / "run"
    run.mkdir()
    manifest = write_checkpoint(
        run, model, epoch=1, recipe_fingerprint=recipe.fingerprint
    )
    outside = tmp_path / "outside-checkpoint.json"
    outside.write_text("{}", encoding="utf-8")
    (run / manifest.checkpoint_file).unlink()
    (run / manifest.checkpoint_file).symlink_to(outside)

    with pytest.raises(CheckpointError) as failure:
        read_checkpoint(run / "checkpoint-000001.manifest.json")

    assert failure.value.code == "CHECKPOINT_MANIFEST_INVALID"




def test_a_manifest_that_names_another_dimension_is_refused(tmp_path: Path) -> None:
    """The manifest and the checkpoint have to agree about the model."""
    recipe = tiny_recipe()
    model = fit_probe_from_recipe(recipe, TINY_FEATURES, TINY_LABELS)
    write_checkpoint(tmp_path, model, epoch=1, recipe_fingerprint=recipe.fingerprint)
    manifest_path = tmp_path / "checkpoint-000001.manifest.json"
    record = json.loads(manifest_path.read_text(encoding="utf-8"))
    record["dimension"] = 99
    manifest_path.write_text(json.dumps(record, sort_keys=True), encoding="utf-8")

    with pytest.raises(CheckpointError) as failure:
        read_checkpoint(manifest_path)

    assert failure.value.code == "CHECKPOINT_STATE_MISMATCH"




def test_a_manifest_that_names_another_seed_is_refused(tmp_path: Path) -> None:
    """The seed of the run is part of the model the manifest describes."""
    recipe = tiny_recipe()
    model = fit_probe_from_recipe(recipe, TINY_FEATURES, TINY_LABELS)
    write_checkpoint(tmp_path, model, epoch=1, recipe_fingerprint=recipe.fingerprint)
    manifest_path = tmp_path / "checkpoint-000001.manifest.json"
    record = json.loads(manifest_path.read_text(encoding="utf-8"))
    record["seed"] = 1234
    manifest_path.write_text(json.dumps(record, sort_keys=True), encoding="utf-8")

    with pytest.raises(CheckpointError) as failure:
        read_checkpoint(manifest_path)

    assert failure.value.code == "CHECKPOINT_STATE_MISMATCH"




def test_a_manifest_of_another_version_is_refused(tmp_path: Path) -> None:
    """A manifest of another version is a manifest of another shape."""
    recipe = tiny_recipe()
    model = fit_probe_from_recipe(recipe, TINY_FEATURES, TINY_LABELS)
    write_checkpoint(tmp_path, model, epoch=1, recipe_fingerprint=recipe.fingerprint)
    manifest_path = tmp_path / "checkpoint-000001.manifest.json"
    record = json.loads(manifest_path.read_text(encoding="utf-8"))
    record["manifestVersion"] = "99.0.0"
    manifest_path.write_text(json.dumps(record, sort_keys=True), encoding="utf-8")

    with pytest.raises(CheckpointError) as failure:
        read_checkpoint(manifest_path)

    assert failure.value.code == "CHECKPOINT_MANIFEST_INVALID"




def test_a_refused_publication_leaves_no_artifact_behind(tmp_path: Path) -> None:
    """A run that cannot publish its epoch leaves the run directory as it
    was."""
    recipe = tiny_recipe()
    model = fit_probe_from_recipe(recipe, TINY_FEATURES, TINY_LABELS)
    write_checkpoint(tmp_path, model, epoch=1, recipe_fingerprint=recipe.fingerprint)
    before = sorted(path.name for path in tmp_path.iterdir())
    other = replace(
        model,
        coefficients=tuple(tuple(value + 1.0 for value in row) for row in model.coefficients),
    )

    with pytest.raises(CheckpointError) as failure:
        write_checkpoint(
            tmp_path, other, epoch=1, recipe_fingerprint=recipe.fingerprint
        )

    assert failure.value.code == "CHECKPOINT_MANIFEST_CONFLICT"
    assert sorted(path.name for path in tmp_path.iterdir()) == before




def test_a_manifest_nobody_can_read_is_not_overwritten(tmp_path: Path) -> None:
    """A manifest nobody can read is a manifest nobody may overwrite."""
    recipe = tiny_recipe()
    model = fit_probe_from_recipe(recipe, TINY_FEATURES, TINY_LABELS)
    manifest_path = tmp_path / "checkpoint-000001.manifest.json"
    manifest_path.write_text("{ not json", encoding="utf-8")

    with pytest.raises(CheckpointError) as failure:
        write_checkpoint(
            tmp_path, model, epoch=1, recipe_fingerprint=recipe.fingerprint
        )

    assert failure.value.code == "CHECKPOINT_MANIFEST_CONFLICT"
    assert manifest_path.read_text(encoding="utf-8") == "{ not json"




def test_a_class_weight_of_zero_is_refused() -> None:
    """A weight of zero would drop the class from the fit."""
    recipe = tiny_recipe()
    class_map = class_map_from_recipe(recipe)

    with pytest.raises(ProbeError) as failure:
        fit_probe(
            features=TINY_FEATURES,
            labels=TINY_LABELS,
            class_map=class_map,
            seed=recipe.seed,
            hyperparameters=recipe.hyperparameters,
            solver=recipe.optimizer,
            max_epochs=recipe.max_epochs,
            class_weights={NORMAL: 0.0, DEFECT: NO_WEIGHT},
        )

    assert failure.value.code == "PROBE_CLASS_WEIGHT_INVALID"
