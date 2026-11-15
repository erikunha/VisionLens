"""The recipe, validated against the generated schema of the contract.

The recipe of a training run is a contract between two languages: the
Python side resolves it and the TypeScript side validates it. The schema
is generated from the same Zod schema the TypeScript side validates with
(`packages/core/src/training/train-recipe.ts`), and the committed file is
the one both sides read.

These tests prove that the recipe the Python side publishes satisfies that
file, so a recipe the other side refuses never crosses the boundary.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict

from helpers import SRC  # noqa: F401  (path setup)

from visionlens.training.recipe import (
    default_class_weights,
    label_key_of,
    recipe_from_record,
    resolve_recipe,
)
from visionlens.training.recipe_schema import (
    load_recipe_schema,
    recipe_schema_path,
    validate_recipe_against_schema,
)

#: The repository root, from this file.
REPO_ROOT = Path(__file__).resolve().parents[4]

#: The generated schema of the recipe.
SCHEMA_PATH = recipe_schema_path(REPO_ROOT)

TRACKED_REGISTRY = REPO_ROOT / "datasets" / "registry.json"
TRACKED_SPLIT = REPO_ROOT / "benchmarks" / "splits" / "visa-subset.v2.gold.json"

MODEL_ID = "siglip2-base"


def label_keys_of_split() -> list:
    """The label keys of the tracked split."""
    split = json.loads(TRACKED_SPLIT.read_text(encoding="utf-8"))
    return sorted(
        {
            label_key_of(assignment["class"], assignment["anomaly"])
            for assignment in split["assignments"]
        }
    )


def resolve_tracked(**overrides: Any) -> Dict[str, Any]:
    """The wire form of the recipe of the tracked registry and split."""
    options: Dict[str, Any] = {
        "registry_path": str(TRACKED_REGISTRY),
        "model_id": MODEL_ID,
        "split_path": str(TRACKED_SPLIT),
        "class_weights": default_class_weights(label_keys_of_split()),
        "hyperparameters": {"C": 1.0, "maxIterations": 200, "solver": "lbfgs"},
    }
    options.update(overrides)
    recipe = resolve_recipe(**options)
    return recipe.to_record()


def test_the_generated_schema_is_committed() -> None:
    assert SCHEMA_PATH.is_file(), f"the recipe schema is not committed at {SCHEMA_PATH}"


def test_the_recipe_the_resolver_publishes_satisfies_the_generated_schema() -> None:
    schema = load_recipe_schema(SCHEMA_PATH)

    issues = validate_recipe_against_schema(resolve_tracked(), schema)

    assert issues == []


def test_the_recipe_read_back_from_the_wire_satisfies_the_generated_schema() -> None:
    schema = load_recipe_schema(SCHEMA_PATH)
    record = resolve_tracked()

    rebuilt = recipe_from_record(json.loads(json.dumps(record)))

    assert validate_recipe_against_schema(rebuilt.to_record(), schema) == []


def test_the_generated_schema_refuses_a_recipe_with_a_field_nobody_knows() -> None:
    schema = load_recipe_schema(SCHEMA_PATH)
    record = resolve_tracked()
    record["gpuTier"] = "a100"

    issues = validate_recipe_against_schema(record, schema)

    assert issues, "the schema must refuse a recipe with a field nobody knows"


def test_the_generated_schema_refuses_a_recipe_without_its_address() -> None:
    schema = load_recipe_schema(SCHEMA_PATH)
    record = resolve_tracked()
    del record["fingerprint"]

    issues = validate_recipe_against_schema(record, schema)

    assert issues, "the schema must refuse a recipe with no address"
