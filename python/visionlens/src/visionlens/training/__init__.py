"""The training surface of the package.

The modules of this package are the training side of the platform: the
pinned recipe of a run, the frozen features it consumes, the estimator of
the M0 rung, the checkpoint it writes and the report it publishes.

The recipe imports nothing heavy: it reads two files and computes a digest,
so the base install of the package stays free of scikit-learn and numpy.
The heavy stack of the estimator (scikit-learn, numpy) lands with the
estimator itself, behind the `training` extra, and the imports of that stack
are lazy: importing the training surface never imports the heavy stack.
"""

from __future__ import annotations

from .checkpoint import (
    CHECKPOINT_VERSION,
    CheckpointError,
    CheckpointManifest,
    LoadedCheckpoint,
    checkpoint_digest,
    read_checkpoint,
    write_checkpoint,
)
from .probe import (
    MIN_CLASS_SUPPORT,
    NO_WEIGHT,
    REQUIRED_EXTRA,
    ClassMap,
    ProbeError,
    ProbeModel,
    class_map_from_recipe,
    fit_probe,
    fit_probe_from_recipe,
)
from .recipe import (
    RECIPE_VERSION,
    RecipeError,
    TrainRecipe,
    default_class_weights,
    ontology_version_of,
    partition_fingerprint_of,
    recipe_fingerprint,
    recipe_from_record,
    resolve_recipe,
)

__all__ = [
    "CHECKPOINT_VERSION",
    "MIN_CLASS_SUPPORT",
    "NO_WEIGHT",
    "RECIPE_VERSION",
    "REQUIRED_EXTRA",
    "CheckpointError",
    "CheckpointManifest",
    "ClassMap",
    "LoadedCheckpoint",
    "ProbeError",
    "ProbeModel",
    "RecipeError",
    "TrainRecipe",
    "checkpoint_digest",
    "class_map_from_recipe",
    "default_class_weights",
    "fit_probe",
    "fit_probe_from_recipe",
    "ontology_version_of",
    "partition_fingerprint_of",
    "read_checkpoint",
    "recipe_fingerprint",
    "recipe_from_record",
    "resolve_recipe",
    "write_checkpoint",
]
