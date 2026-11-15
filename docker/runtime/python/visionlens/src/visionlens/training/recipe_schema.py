"""The recipe, validated against the JSON Schema of the contract.

The recipe of a training run is a contract between two languages: the
Python side resolves it and the TypeScript side validates it. The schema is
generated from the same Zod schema the TypeScript side validates with
(`packages/core/src/training/train-recipe.ts`), and the committed file
travels WITH this package, so the side that resolves a recipe reads the
contract it has to satisfy in the repository and in the published wheel
alike.

The recipe the Python side publishes is validated against that file before
it is published, and the recipe it reads back is validated against it
before it is rebuilt: a recipe the other side refuses is refused here
instead of crossing the boundary and being refused there.
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


def recipe_schema_path(repo_root: Optional[Path] = None) -> Path:
    """The path of the generated recipe schema.

    The schema travels with the package, so the default is the copy that
    ships with it. The path of the repository is accepted for the callers
    that compare the shipped copy with the one the contract generates.
    """
    if repo_root is not None:
        return (
            Path(repo_root)
            / "python"
            / "visionlens"
            / "src"
            / "visionlens"
            / "training"
            / "train-recipe.schema.json"
        )
    return Path(__file__).resolve().parent / "train-recipe.schema.json"


def load_recipe_schema(path: Optional[Path] = None) -> Dict[str, Any]:
    """The JSON Schema of the recipe, read from the generated file.

    @raises ValueError when the file is not a JSON object.
    """
    the_path = path if path is not None else recipe_schema_path()
    payload = json.loads(the_path.read_text(encoding="utf8"))
    if not isinstance(payload, dict):
        raise ValueError("the recipe schema is not a JSON object")
    return payload


def validate_recipe_against_schema(
    payload: Any, schema: Optional[Dict[str, Any]] = None
) -> List[str]:
    """The issues of a recipe against the generated schema."""
    the_schema = schema if schema is not None else load_recipe_schema()
    return validate_against_schema(payload, the_schema)


def validate_recipe_file(path: Path, schema_path: Optional[Path] = None) -> List[str]:
    """The issues of a recipe file against the generated schema."""
    schema = load_recipe_schema(schema_path)
    payload = json.loads(Path(path).read_text(encoding="utf8"))
    return validate_against_schema(payload, schema)
