"""The training surface of the package.

The modules of this package are the training side of the platform: the
pinned recipe of a run, the frozen features it consumes, the estimator of
the M0 rung, the checkpoint it writes and the report it publishes.

The recipe imports nothing heavy: it reads two files and computes a digest,
so the base install of the package stays free of scikit-learn and numpy.
The heavy stack of the estimator (scikit-learn, numpy) lands with the
estimator itself, behind the `train` extra, and the imports of that stack
are lazy: importing the training surface never imports the heavy stack.
"""

from __future__ import annotations

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
    "RECIPE_VERSION",
    "RecipeError",
    "TrainRecipe",
    "default_class_weights",
    "ontology_version_of",
    "partition_fingerprint_of",
    "recipe_fingerprint",
    "recipe_from_record",
    "resolve_recipe",
]
