"""The recipe, validated against the JSON Schema of the contract.

The recipe of a training run is a contract between two languages: the
Python side resolves it and the TypeScript side validates it. The schema
is generated from the same Zod schema the TypeScript side validates with
(`packages/core/src/training/train-recipe.ts`), and the validator here
reads the generated file, so the two languages cannot drift.

The recipe the Python side publishes is validated against that file
before it is published, so a recipe the other side refuses is refused
here instead of crossing the boundary and being refused there.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional

from ..jsonschema import validate_against_schema

__all__ = [
    "load_recipe_schema",
    "recipe_schema_path",
    "validate_recipe_against_schema",
    "validate_recipe_file",
]


def recipe_schema_path(repo_root: Path) -> Path:
    """The path of the generated recipe schema in the repository."""
    return (
        Path(repo_root)
        / "packages"
        / "core"
        / "src"
        / "training"
        / "train-recipe.schema.json"
    )


def load_recipe_schema(path: Path) -> Dict[str, Any]:
    """The JSON Schema of the recipe, read from the generated file.

    @raises ValueError when the file is not a JSON object.
    """
    payload = json.loads(Path(path).read_text(encoding="utf8"))
    if not isinstance(payload, dict):
        raise ValueError("the recipe schema is not a JSON object")
    return payload


def validate_recipe_against_schema(
    payload: Any, schema: Optional[Dict[str, Any]] = None
) -> List[str]:
    """The issues of a recipe against the generated schema.

    The schema is read from the repository when it is not handed over, so
    a caller that validates a recipe needs nothing but the recipe.
    """
    the_schema = schema if schema is not None else load_recipe_schema(
        recipe_schema_path(Path.cwd())
    )
    return validate_against_schema(payload, the_schema)


def validate_recipe_file(path: Path, schema_path: Optional[Path] = None) -> List[str]:
    """The issues of a recipe file against the generated schema."""
    schema_file = schema_path or recipe_schema_path(Path.cwd())
    schema = load_recipe_schema(schema_file)
    payload = json.loads(Path(path).read_text(encoding="utf8"))
    return validate_against_schema(payload, schema)
