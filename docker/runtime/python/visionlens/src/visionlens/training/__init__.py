"""The training surface of the package.

The modules of this package are the training side of the platform: the
pinned recipe of a run, the frozen features it consumes, the estimator of
the M0 rung, the checkpoint it writes, the report it publishes and the
trainer that ties them together.

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
from .features import (
    FeatureError,
    FeatureSet,
    features_of,
    load_features,
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
from .trainer import (
    SELECTION_PARTITIONS,
    EpochPoint,
    SplitItem,
    TrainerError,
    TrainingRun,
    split_items_of,
    train,
)

__all__ = [
    "CHECKPOINT_VERSION",
    "MIN_CLASS_SUPPORT",
    "NO_WEIGHT",
    "RECIPE_VERSION",
    "REQUIRED_EXTRA",
    "SELECTION_PARTITIONS",
    "CheckpointError",
    "CheckpointManifest",
    "ClassMap",
    "EpochPoint",
    "FeatureError",
    "FeatureSet",
    "LoadedCheckpoint",
    "ProbeError",
    "ProbeModel",
    "RecipeError",
    "SplitItem",
    "TrainRecipe",
    "TrainerError",
    "TrainingRun",
    "checkpoint_digest",
    "class_map_from_recipe",
    "default_class_weights",
    "features_of",
    "fit_probe",
    "fit_probe_from_recipe",
    "load_features",
    "ontology_version_of",
    "partition_fingerprint_of",
    "read_checkpoint",
    "recipe_fingerprint",
    "recipe_from_record",
    "resolve_recipe",
    "split_items_of",
    "train",
    "write_checkpoint",
]
