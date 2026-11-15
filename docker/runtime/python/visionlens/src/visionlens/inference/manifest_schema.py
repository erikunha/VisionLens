"""The manifest, validated against the JSON Schema of the contract.

The manifest of a run is a contract between two languages: the Python
runtime writes it and the TypeScript side validates it. The schema is
generated from the same Zod schema the TypeScript side validates with
(`packages/core/src/adapter/embedding-manifest.ts`), and the validator
here reads the generated file, so the two languages cannot drift
(`docs/vnext/07-CONTRACTS-PROTOCOL.md:5`, `:74`).

The validator itself lives in `visionlens/jsonschema.py`, because the
recipe of a training run validates against a generated schema the same
way, and a validator that is written twice is a validator that drifts.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional

from ..jsonschema import (
    SUPPORTED_KEYWORDS,
    UnsupportedSchemaError,
    validate_against_schema,
)

__all__ = [
    "SUPPORTED_KEYWORDS",
    "UnsupportedSchemaError",
    "load_manifest_schema",
    "manifest_schema_path",
    "validate_against_schema",
    "validate_manifest_file",
]


def load_manifest_schema(path: Path) -> Dict[str, Any]:
    """The JSON Schema of the manifest, read from the generated file.

    @raises ValueError when the file is not a JSON object.
    """
    payload = json.loads(Path(path).read_text(encoding="utf8"))
    if not isinstance(payload, dict):
        raise ValueError("the manifest schema is not a JSON object")
    return payload


def manifest_schema_path(repo_root: Path) -> Path:
    """The path of the generated manifest schema in the repository."""
    return (
        Path(repo_root)
        / "packages"
        / "core"
        / "src"
        / "adapter"
        / "embedding-manifest.schema.json"
    )


def validate_manifest_file(path: Path, schema_path: Optional[Path] = None) -> List[str]:
    """The issues of a manifest file against the generated schema."""
    schema_file = schema_path or manifest_schema_path(Path.cwd())
    schema = load_manifest_schema(schema_file)
    payload = json.loads(Path(path).read_text(encoding="utf8"))
    return validate_against_schema(payload, schema)
