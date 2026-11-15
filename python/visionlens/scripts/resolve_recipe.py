#!/usr/bin/env python3
"""Resolves the pinned recipe of a training run and prints it.

The recipe is the reproducibility contract of a training run, and this
command is how a reader obtains one: it reads the model capability registry
and the tracked split, resolves the recipe and prints the record the
TypeScript side validates.

The recipe it prints carries the fingerprint of the whole configuration,
and the fingerprint is recomputable by the other side: the two languages
agree on the address of a configuration or the promise means nothing.

Usage:
  resolve_recipe.py --registry <registry.json> --split <split.gold.json> \
                    [--model <model-id>] [--class-weights <weights.json>]

The class weights are a JSON object that maps every class of the ontology
onto a number or onto the word `none`. Without the file, every class of
the ontology is weighted `none`, which is a documented decision.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, List

SRC = Path(__file__).resolve().parents[1] / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from visionlens.training.recipe import (  # noqa: E402
    RecipeError,
    default_class_weights,
    label_key_of,
    resolve_recipe,
)


def label_keys_of(split_path: str) -> List[str]:
    """The label keys of the ontology of a split."""
    with open(split_path, "r", encoding="utf-8") as handle:
        split = json.load(handle)
    keys = {
        label_key_of(assignment["class"], assignment["anomaly"])
        for assignment in split["assignments"]
    }
    return sorted(keys)


def main(argv: List[str]) -> int:
    """Resolves the recipe and prints it."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--registry", required=True, help="the registry file")
    parser.add_argument("--split", required=True, help="the split file")
    parser.add_argument("--model", default="siglip2-base", help="the encoder to resolve")
    parser.add_argument("--class-weights", default="", help="the class weights file")
    parser.add_argument("--seed", type=int, default=42, help="the seed of the run")
    parser.add_argument("--max-epochs", type=int, default=200, help="the epochs ceiling")
    options = parser.parse_args()

    weights: Dict[str, Any] = default_class_weights(label_keys_of(options.split))
    if options.class_weights:
        with open(options.class_weights, "r", encoding="utf-8") as handle:
            weights = json.load(handle)

    try:
        recipe = resolve_recipe(
            registry_path=options.registry,
            model_id=options.model,
            split_path=options.split,
            class_weights=weights,
            hyperparameters={
                "C": 1.0,
                "maxIterations": options.max_epochs,
                "solver": "lbfgs",
            },
            seed=options.seed,
            max_epochs=options.max_epochs,
        )
    except RecipeError as error:
        print(str(error), file=sys.stderr)
        return 1

    print(json.dumps(recipe.to_record(), indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
