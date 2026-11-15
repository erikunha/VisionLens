"""The estimator of the M0 rung: a logistic regression over frozen features.

The M0 rung is a frozen encoder plus a logistic regression, and nothing more
(`docs/vnext/12-TRAINING-EXPERIMENTS-MLFLOW.md:5`). The estimator here is
exactly that: it fits the frozen vectors of the `train` partition, it carries
the class map of the run, and it records what the fit decided so the run can
be reproduced.

Three properties of this module are the reason it exists:

- The CLASS MAP is the authority of the class space. It is built from the
  gold vocabulary of the run, and a label outside it cannot be represented:
  a label that is not in the map is a hard error, never a coercion
  (`docs/vnext/21-TEST-AND-QUALITY-PLAN.md:28`). The probe answers with the
  label keys of the map, so the answer of the model is a label of the
  ontology and not an index nobody can read.
- The CLASS WEIGHTS are documented for every class, `none` included. The word
  `none` means the class is not weighted, and it does NOT mean a weight of
  zero: a zero weight would drop the class, and a dropped class is a class
  the run never reports (`docs/vnext/12-TRAINING-EXPERIMENTS-MLFLOW.md:5`).
  The support of every class is recorded, so a class with too few items is
  visible in the record instead of being lost in the fit.
- The FIT is deterministic given the seed and the pinned configuration. The
  same recipe and the same features produce the same parameters, and the
  seed of the recipe is the seed of the estimator.

The heavy stack (scikit-learn, numpy) is imported INSIDE the fit, so the
base install of the package never imports it and a caller that has no extra
installed gets an actionable error instead of an `ImportError`
(`docs/vnext/05-PYTHON-CORE-AND-PYPI.md:35`, the base-install policy of
the pack).

The fitted model is PLAIN DATA: the coefficient matrix, the intercepts, the
class map and what the fit recorded. It is not a pickled estimator, so the
checkpoint of a run is a JSON document that anybody can read, that two
machines write byte for byte the same, and that loads without executing code
that came with the file.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Any, Dict, List, Mapping, Sequence, Tuple

from ..errors import MissingExtraError
from ..runtime.fingerprint import utf16_order
from .recipe import M0_ESTIMATOR, TrainRecipe, ontology_version_of

#: The extra the estimator needs, and the command that provides it.
REQUIRED_EXTRA = "training"

#: The install command that provides the extra.
INSTALL_COMMAND = "pip install visionlens[training]"

#: The weight that documents a class the run does not weight.
NO_WEIGHT = "none"

#: The smallest support a class needs to be a class the fit can learn from.
#: A class with fewer items than this is recorded as a class with an
#: insufficient support, and it is never dropped from the class map.
MIN_CLASS_SUPPORT = 2

#: The hyperparameters the estimator accepts, and the default of each one.
#: A hyperparameter nobody knows is a decision the run did not pin, so it is
#: refused instead of ignored.
ACCEPTED_HYPERPARAMETERS: Tuple[str, ...] = (
    "C",
    "tol",
    "fitIntercept",
    "maxIterations",
    "solver",
)

#: The default of every accepted hyperparameter.
DEFAULT_HYPERPARAMETERS: Mapping[str, Any] = {
    "C": 1.0,
    "tol": 1e-4,
    "fitIntercept": True,
    "maxIterations": 200,
    "solver": "lbfgs",
}


class ProbeError(Exception):
    """Raised when a probe cannot be fitted or cannot be read.

    The error carries the CODE of the refusal, the FIELD it is about and the
    reason, so a caller can act on it and a reader can see what the probe
    refused and why. It is the library-level vocabulary of the training
    surface and it never crosses the wire.
    """

    def __init__(self, code: str, field: str, reason: str) -> None:
        super().__init__(f"[{code}] {field}: {reason}")
        self.code = code
        self.field = field
        self.reason = reason


@dataclass(frozen=True)
class ClassMap:
    """The classes of a run: the label key of every class and its index.

    The map is built from the gold vocabulary of the run, and the index of a
    class is its position in the vocabulary, sorted over the UTF-16 code
    units the way the ontology version is sorted
    (`training/recipe.py`, `ontology_version_of`). Two sides that sort the
    same way give the same class the same index, and the index of a class is
    the index of the class map of the checkpoint.
    """

    entries: Tuple[Tuple[str, int], ...]

    @property
    def label_keys(self) -> Tuple[str, ...]:
        """The label keys of the map, in the order of the indices."""
        return tuple(label_key for label_key, _ in self.entries)

    @property
    def index_of(self) -> Dict[str, int]:
        """The index of every class of the map."""
        return {label_key: index for label_key, index in self.entries}

    @staticmethod
    def of(label_keys: Sequence[str]) -> "ClassMap":
        """The class map of a gold vocabulary.

        @raises ProbeError when the vocabulary is empty or carries a label
            that is not a name.
        """
        keys = []
        for label_key in label_keys:
            if not isinstance(label_key, str) or label_key == "":
                raise ProbeError(
                    "PROBE_CLASS_SPACE_INVALID",
                    "classMap.labelKeys",
                    f"a class of the ontology names itself with a label key, got {label_key!r}",
                )
            if label_key not in keys:
                keys.append(label_key)
        if not keys:
            raise ProbeError(
                "PROBE_CLASS_SPACE_EMPTY",
                "classMap.labelKeys",
                "the run has no class, and a probe over no class is a probe over nothing",
            )
        ordered = sorted(keys, key=utf16_order)
        return ClassMap(
            entries=tuple((label_key, index) for index, label_key in enumerate(ordered))
        )

    @staticmethod
    def from_dict(record: Mapping[str, Any]) -> "ClassMap":
        """The class map, read back from the wire form.

        The wire form carries the labels AND the index of every class, so a
        reader can see the indices without recomputing them. A form whose
        indices do not agree with the order of the labels is refused: a map
        that describes two different class spaces at once is a map nobody can
        read back.

        @raises ProbeError when the form is not a class map.
        """
        if not isinstance(record, Mapping):
            raise ProbeError(
                "PROBE_CLASS_SPACE_INVALID",
                "classMap",
                "the class map is not an object",
            )
        label_keys = record.get("labelKeys")
        index_of = record.get("indexOf")
        if not isinstance(label_keys, list) or not isinstance(index_of, Mapping):
            raise ProbeError(
                "PROBE_CLASS_SPACE_INVALID",
                "classMap",
                "the class map carries no label keys or no indices",
            )
        for label_key in label_keys:
            if not isinstance(label_key, str) or label_key == "":
                raise ProbeError(
                    "PROBE_CLASS_SPACE_INVALID",
                    "classMap.labelKeys",
                    f"a class of the ontology names itself with a label key, got "
                    f"{label_key!r}",
                )
        expected = ClassMap.of(label_keys)
        for label_key, index in expected.entries:
            if label_key not in index_of:
                raise ProbeError(
                    "PROBE_CLASS_SPACE_INVALID",
                    f"classMap.indexOf.{label_key}",
                    "the class map carries no index for this class",
                )
            if index_of[label_key] != index:
                raise ProbeError(
                    "PROBE_CLASS_SPACE_INVALID",
                    f"classMap.indexOf.{label_key}",
                    f"the class map gives the index {index_of[label_key]!r} to a class that "
                    f"is the class {index} of the vocabulary",
                )
        return expected

    def to_dict(self) -> Dict[str, Any]:
        """The class map as the wire form."""
        return {
            "labelKeys": list(self.label_keys),
            "indexOf": self.index_of,
        }

    def index_of_label(self, label_key: str) -> int:
        """The index of one class of the map.

        @raises ProbeError when the class is not in the map.
        """
        for name, index in self.entries:
            if name == label_key:
                return index
        raise ProbeError(
            "PROBE_LABEL_UNKNOWN",
            f"classMap.{label_key}",
            f"the label '{label_key}' is not a class of the gold vocabulary of the run, and "
            "a prediction outside the vocabulary is a hard error and never a coercion",
        )


def _checked_parameter(value: float, field_path: str) -> None:
    """A parameter of a model, checked to be a finite number.

    A parameter that is a NaN or an infinity answers with a score nobody can
    read, and a model that carries one is a model nobody can use.

    @raises ProbeError when the parameter is not a finite number.
    """
    if value != value or value in (float("inf"), float("-inf")):
        raise ProbeError(
            "PROBE_MODEL_INVALID",
            field_path,
            f"the parameter carries {value!r}, and a parameter that is not a finite number "
            "answers with a score nobody can read",
        )


@dataclass(frozen=True)
class ProbeModel:
    """The fitted probe: the parameters of the model and what the fit recorded.

    The model is plain data. It carries the class map, so a reader of a
    checkpoint knows the label of every class without loading anything, and
    it carries the support of every class, so a class with too few items is
    visible in the record of the run.
    """

    estimator: str
    solver: str
    seed: int
    dimension: int
    class_map: ClassMap
    coefficients: Tuple[Tuple[float, ...], ...]
    intercepts: Tuple[float, ...]
    class_support: Mapping[str, int]
    insufficient_support: Tuple[str, ...]
    class_weights: Mapping[str, Any]
    hyperparameters: Mapping[str, Any]
    max_epochs: int
    train_accuracy: float

    def to_dict(self) -> Dict[str, Any]:
        """The model as the wire form."""
        return {
            "estimator": self.estimator,
            "solver": self.solver,
            "seed": self.seed,
            "dimension": self.dimension,
            "classMap": self.class_map.to_dict(),
            "coefficients": [list(row) for row in self.coefficients],
            "intercepts": list(self.intercepts),
            "classSupport": dict(sorted(self.class_support.items())),
            "insufficientSupport": list(self.insufficient_support),
            "classWeights": dict(sorted(self.class_weights.items())),
            "hyperparameters": dict(sorted(self.hyperparameters.items())),
            "maxEpochs": self.max_epochs,
            "trainAccuracy": self.train_accuracy,
        }

    @staticmethod
    def from_dict(record: Mapping[str, Any]) -> "ProbeModel":
        """The model, read back from the wire form.

        @raises ProbeError when the form is not a model of a probe.
        """
        if not isinstance(record, Mapping):
            raise ProbeError("PROBE_MODEL_INVALID", "model", "the model is not an object")
        try:
            coefficients = tuple(
                tuple(float(value) for value in row) for row in record["coefficients"]
            )
            intercepts = tuple(float(value) for value in record["intercepts"])
            class_map = ClassMap.from_dict(record["classMap"])
            dimension = int(record["dimension"])
            seed = int(record["seed"])
            max_epochs = int(record["maxEpochs"])
            train_accuracy = float(record["trainAccuracy"])
            class_support = {
                str(key): int(value)
                for key, value in dict(record["classSupport"]).items()
            }
            class_weights = {
                str(key): value for key, value in dict(record["classWeights"]).items()
            }
            hyperparameters = dict(record["hyperparameters"])
            insufficient_support = tuple(
                str(key) for key in record["insufficientSupport"]
            )
        except (KeyError, TypeError, ValueError) as error:
            # Every conversion of the wire form is inside the guard, so a
            # model that carries a field of the wrong shape is refused by
            # the model and not by the language.
            raise ProbeError(
                "PROBE_MODEL_INVALID",
                "model",
                f"the model does not carry the shape of a fitted probe: {error}",
            ) from error
        for index, row in enumerate(coefficients):
            for position, value in enumerate(row):
                _checked_parameter(value, f"model.coefficients.{index}.{position}")
        for index, value in enumerate(intercepts):
            _checked_parameter(value, f"model.intercepts.{index}")
        _checked_parameter(train_accuracy, "model.trainAccuracy")
        if max_epochs <= 0:
            raise ProbeError(
                "PROBE_MODEL_INVALID",
                "model.maxEpochs",
                f"the model declares the ceiling of {max_epochs} epochs and a fitted model "
                "declares a ceiling above zero",
            )
        unknown_support = sorted(set(class_support) - set(class_map.label_keys))
        if unknown_support:
            raise ProbeError(
                "PROBE_MODEL_INVALID",
                "model.classSupport",
                f"the model carries the support of {len(unknown_support)} class(es) it does "
                f"not have: {', '.join(unknown_support)}",
            )
        unknown_weights = sorted(set(class_weights) - set(class_map.label_keys))
        if unknown_weights:
            raise ProbeError(
                "PROBE_MODEL_INVALID",
                "model.classWeights",
                f"the model carries the weight of {len(unknown_weights)} class(es) it does "
                f"not have: {', '.join(unknown_weights)}",
            )
        if len(coefficients) != len(class_map.entries) or len(intercepts) != len(
            class_map.entries
        ):
            raise ProbeError(
                "PROBE_MODEL_INVALID",
                "model.coefficients",
                f"the model carries {len(coefficients)} coefficient rows and "
                f"{len(intercepts)} intercepts for {len(class_map.entries)} classes",
            )
        if dimension <= 0:
            raise ProbeError(
                "PROBE_MODEL_INVALID",
                "model.dimension",
                f"the model declares the dimension {dimension} and a fitted model declares "
                "the dimension of the vectors it was fitted over",
            )
        for index, row in enumerate(coefficients):
            if len(row) != dimension:
                raise ProbeError(
                    "PROBE_MODEL_INVALID",
                    f"model.coefficients.{index}",
                    f"the row carries {len(row)} values and the model declares the dimension "
                    f"{dimension}; the rows of a model and the vectors of the run share one "
                    "dimension",
                )
        return ProbeModel(
            estimator=str(record.get("estimator", M0_ESTIMATOR)),
            solver=str(record.get("solver", "lbfgs")),
            seed=seed,
            dimension=dimension,
            class_map=class_map,
            coefficients=coefficients,
            intercepts=intercepts,
            class_support=class_support,
            insufficient_support=insufficient_support,
            class_weights=class_weights,
            hyperparameters=hyperparameters,
            max_epochs=max_epochs,
            train_accuracy=train_accuracy,
        )

    def scores(self, features: Sequence[float]) -> Tuple[float, ...]:
        """The score of every class for one vector of features.

        The score of a class is the dot product of the vector with the row of
        the class plus the intercept of the class, and the answer of the
        model is the class with the highest score. The rows are stored per
        class, so the answer does not depend on the order the estimator
        happened to fit its classes in.
        """
        if len(features) != self.dimension:
            raise ProbeError(
                "PROBE_FEATURE_DIMENSION_INVALID",
                "features",
                f"the vector carries {len(features)} values and the model was fitted over "
                f"{self.dimension} of them",
            )
        return tuple(
            sum(weight * float(value) for weight, value in zip(row, features)) + intercept
            for row, intercept in zip(self.coefficients, self.intercepts)
        )

    def predict(self, features: Sequence[float]) -> str:
        """The label key the model answers for one vector of features.

        The answer is a label key of the gold vocabulary and never an index
        nobody can read.
        """
        scores = self.scores(features)
        best = 0
        for index in range(1, len(scores)):
            if scores[index] > scores[best]:
                best = index
        return self.class_map.label_keys[best]


def _checked_hyperparameters(
    hyperparameters: Mapping[str, Any],
    solver: str,
    max_epochs: int,
) -> Dict[str, Any]:
    """The hyperparameters of the fit, checked against the ones the run pins.

    The recipe carries the optimizer and the ceiling of the epochs, and the
    hyperparameters carry the rest. A hyperparameter that names a solver or
    a ceiling that the recipe names too must AGREE with the recipe: two
    ceilings that disagree are two runs, and the run that fits is the one the
    recipe pins.

    @raises ProbeError when a hyperparameter is unknown, carries a value of
        the wrong shape, or disagrees with the recipe.
    """
    unknown = sorted(set(hyperparameters) - set(ACCEPTED_HYPERPARAMETERS))
    if unknown:
        raise ProbeError(
            "PROBE_HYPERPARAMETER_UNKNOWN",
            f"hyperparameters.{unknown[0]}",
            f"the recipe carries hyperparameters the estimator does not know: "
            f"{', '.join(unknown)}; a hyperparameter nobody applies is a decision nobody "
            "pinned",
        )
    checked = dict(DEFAULT_HYPERPARAMETERS)
    checked.update(hyperparameters)
    if not isinstance(checked["C"], (int, float)) or isinstance(checked["C"], bool):
        raise ProbeError(
            "PROBE_HYPERPARAMETER_INVALID",
            "hyperparameters.C",
            f"the inverse of the regularization strength is a number, got {checked['C']!r}",
        )
    if float(checked["C"]) <= 0:
        raise ProbeError(
            "PROBE_HYPERPARAMETER_INVALID",
            "hyperparameters.C",
            f"the inverse of the regularization strength is above zero, got {checked['C']!r}",
        )
    if not isinstance(checked["tol"], (int, float)) or isinstance(checked["tol"], bool):
        raise ProbeError(
            "PROBE_HYPERPARAMETER_INVALID",
            "hyperparameters.tol",
            f"the tolerance of the solver is a number, got {checked['tol']!r}",
        )
    if float(checked["tol"]) <= 0:
        raise ProbeError(
            "PROBE_HYPERPARAMETER_INVALID",
            "hyperparameters.tol",
            f"the tolerance of the solver is above zero, got {checked['tol']!r}",
        )
    if not isinstance(checked["fitIntercept"], bool):
        raise ProbeError(
            "PROBE_HYPERPARAMETER_INVALID",
            "hyperparameters.fitIntercept",
            f"the fit of the intercept is a yes or a no, got {checked['fitIntercept']!r}",
        )
    if not isinstance(checked["maxIterations"], int) or isinstance(
        checked["maxIterations"], bool
    ):
        raise ProbeError(
            "PROBE_HYPERPARAMETER_INVALID",
            "hyperparameters.maxIterations",
            f"the ceiling of the iterations is a whole number, got {checked['maxIterations']!r}",
        )
    if int(checked["maxIterations"]) <= 0:
        raise ProbeError(
            "PROBE_HYPERPARAMETER_INVALID",
            "hyperparameters.maxIterations",
            f"the ceiling of the iterations is above zero, got {checked['maxIterations']!r}",
        )
    if int(checked["maxIterations"]) != int(max_epochs):
        raise ProbeError(
            "PROBE_HYPERPARAMETER_DISAGREEMENT",
            "hyperparameters.maxIterations",
            f"the recipe pins {max_epochs} epochs and the hyperparameters pin "
            f"{checked['maxIterations']} iterations; two ceilings that disagree are two "
            "runs",
        )
    if str(checked["solver"]) != str(solver):
        raise ProbeError(
            "PROBE_HYPERPARAMETER_DISAGREEMENT",
            "hyperparameters.solver",
            f"the recipe pins the optimizer '{solver}' and the hyperparameters pin the "
            f"solver '{checked['solver']}'; two solvers that disagree are two runs",
        )
    return checked


def _checked_features(
    features: Sequence[Sequence[float]], labels: Sequence[str]
) -> int:
    """The features and the labels of a fit, checked before the fit.

    The check refuses a run whose vectors do not share one dimension, a run
    whose labels and vectors do not match, and a vector that carries a value
    no estimator can use: a NaN or an infinity in a feature is a broken
    artifact, and an estimator that consumes it produces a number nobody can
    reproduce.

    @raises ProbeError when the run is not fit.
    """
    if len(features) != len(labels):
        raise ProbeError(
            "PROBE_FIT_INVALID",
            "features",
            f"the run carries {len(features)} vectors and {len(labels)} labels, and a fit "
            "needs one label for every vector",
        )
    if not features:
        raise ProbeError(
            "PROBE_FIT_INVALID",
            "features",
            "the run carries no vector, and a fit over no vector is a fit over nothing",
        )
    dimension = len(features[0])
    if dimension == 0:
        raise ProbeError(
            "PROBE_FEATURE_DIMENSION_INVALID",
            "features",
            "the vectors of the run carry no value",
        )
    for index, vector in enumerate(features):
        if len(vector) != dimension:
            raise ProbeError(
                "PROBE_FEATURE_DIMENSION_INVALID",
                f"features.{index}",
                f"the vector carries {len(vector)} values and the first one carries "
                f"{dimension}; the vectors of one fit share one dimension",
            )
        for position, value in enumerate(vector):
            if not isinstance(value, (int, float)) or isinstance(value, bool):
                raise ProbeError(
                    "PROBE_FEATURE_INVALID",
                    f"features.{index}.{position}",
                    f"a feature is a number, got {value!r}",
                )
            if value != value or value in (float("inf"), float("-inf")):
                raise ProbeError(
                    "PROBE_FEATURE_INVALID",
                    f"features.{index}.{position}",
                    f"the feature carries {value!r}, and a vector with a NaN or an infinity "
                    "produces a number nobody can reproduce",
                )
    return dimension


def _effective_weights(
    class_map: ClassMap,
    class_weights: Mapping[str, Any] | None,
) -> Dict[str, Any]:
    """The documented weight of every class, checked and in the wire form.

    Every class of the class map needs a documented weight, `none` included:
    an undocumented weight is a weight nobody chose, and the probe cannot
    tell it apart from a forgotten one. A weight of `none` is the weight of a
    class the run does not weight, and it is NOT a weight of zero: a zero
    weight would drop the class, and a dropped class is a class the run
    never reports.

    @raises ProbeError when a class has no documented weight or when the
        weight is neither a number nor the word `none`.
    """
    weights = class_weights or {}
    documented: Dict[str, Any] = {}
    for label_key in class_map.label_keys:
        if label_key not in weights:
            raise ProbeError(
                "PROBE_CLASS_WEIGHT_MISSING",
                f"classWeights.{label_key}",
                "every class of the run needs a documented class weight, and 'none' is a "
                "documented weight",
            )
        value = weights[label_key]
        if isinstance(value, str):
            if value != NO_WEIGHT:
                raise ProbeError(
                    "PROBE_CLASS_WEIGHT_INVALID",
                    f"classWeights.{label_key}",
                    f"the only documented weight that is not a number is '{NO_WEIGHT}', got "
                    f"'{value}'",
                )
            documented[label_key] = NO_WEIGHT
            continue
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ProbeError(
                "PROBE_CLASS_WEIGHT_INVALID",
                f"classWeights.{label_key}",
                "a class weight is a number or the word 'none'",
            )
        if value < 0:
            raise ProbeError(
                "PROBE_CLASS_WEIGHT_INVALID",
                f"classWeights.{label_key}",
                f"a class weight may not be negative, got {value!r}",
            )
        if value == 0:
            raise ProbeError(
                "PROBE_CLASS_WEIGHT_INVALID",
                f"classWeights.{label_key}",
                f"a class weight of zero drops the class from the fit, and a dropped class "
                f"is a class the run never reports; document the class as '{NO_WEIGHT}' "
                "instead",
            )
        documented[label_key] = value if isinstance(value, int) else float(value)
    unknown = sorted(set(weights) - set(class_map.label_keys))
    if unknown:
        raise ProbeError(
            "PROBE_CLASS_WEIGHT_UNKNOWN",
            "classWeights",
            f"the recipe carries a weight for a class the run does not have: "
            f"{', '.join(unknown)}",
        )
    return documented


def _class_weights_for_the_estimator(
    class_map: ClassMap, documented: Mapping[str, Any]
) -> Dict[int, float] | None:
    """The weights the estimator receives, by class index.

    The estimator weights a class that the map does not weight with the
    default of one, so a class with the documented weight `none` is left out
    of the dictionary instead of being given a weight of zero: a zero weight
    would drop the class from the fit.
    """
    weighted = {
        class_map.index_of_label(label_key): float(value)
        for label_key, value in documented.items()
        if not isinstance(value, str)
    }
    if not weighted:
        return None
    return weighted


def fit_probe(
    *,
    features: Sequence[Sequence[float]],
    labels: Sequence[str],
    class_map: ClassMap,
    seed: int,
    hyperparameters: Mapping[str, Any] | None = None,
    solver: str = "lbfgs",
    max_epochs: int = 200,
    class_weights: Mapping[str, Any] | None = None,
) -> ProbeModel:
    """Fits the probe of the M0 rung over the frozen features of a run.

    The fit is the logistic regression of scikit-learn over the vectors of
    the `train` partition, with the seed, the optimizer, the hyperparameters,
    the ceiling of the epochs and the documented class weights of the recipe.

    @raises MissingExtraError when the heavy stack is not installed.
    @raises ProbeError when the run cannot be fitted.
    """
    dimension = _checked_features(features, labels)
    checked_hyperparameters = _checked_hyperparameters(
        hyperparameters or {}, solver, max_epochs
    )

    support: Dict[str, int] = {label_key: 0 for label_key in class_map.label_keys}
    indices: List[int] = []
    for index, label_key in enumerate(labels):
        if not isinstance(label_key, str):
            raise ProbeError(
                "PROBE_LABEL_INVALID",
                f"labels.{index}",
                f"a label is the key of a class, got {label_key!r}",
            )
        position = class_map.index_of_label(label_key)
        support[class_map.label_keys[position]] += 1
        indices.append(position)
    empty = [label_key for label_key, count in support.items() if count == 0]
    if empty:
        raise ProbeError(
            "PROBE_CLASS_UNSUPPORTED",
            "classMap.labelKeys",
            f"the class space carries {len(empty)} class(es) the run does not train on: "
            f"{', '.join(sorted(empty))}; a class without a single item has no coefficient, "
            "and a class the model cannot answer is a class the run never reports",
        )

    documented = _effective_weights(class_map, class_weights)
    estimator_weights = _class_weights_for_the_estimator(class_map, documented)

    try:
        import numpy as np
        # scikit-learn ships no type information, so the import is marked as
        # untyped on purpose: the estimator is used through its own
        # parameters and its own results, and the run never reads an
        # attribute the package does not document.
        from sklearn.linear_model import (  # type: ignore[import-untyped]
            LogisticRegression,
        )
    except ImportError as exc:
        raise MissingExtraError(
            "the probe needs the '"
            + REQUIRED_EXTRA
            + "' extra, which this environment does not have: "
            + INSTALL_COMMAND
        ) from exc

    matrix = np.asarray(features, dtype=float)
    targets = np.asarray(indices, dtype=int)
    estimator = LogisticRegression(
        C=float(checked_hyperparameters["C"]),
        tol=float(checked_hyperparameters["tol"]),
        fit_intercept=bool(checked_hyperparameters["fitIntercept"]),
        solver=str(checked_hyperparameters["solver"]),
        max_iter=int(checked_hyperparameters["maxIterations"]),
        random_state=int(seed),
        class_weight=estimator_weights,
    )
    estimator.fit(matrix, targets)

    coefficients, intercepts = _symmetric_parameters(estimator, class_map, dimension)
    model = ProbeModel(
        estimator=M0_ESTIMATOR,
        solver=str(checked_hyperparameters["solver"]),
        seed=int(seed),
        dimension=dimension,
        class_map=class_map,
        coefficients=coefficients,
        intercepts=intercepts,
        class_support=dict(sorted(support.items())),
        insufficient_support=tuple(
            label_key
            for label_key, count in sorted(support.items())
            if count < MIN_CLASS_SUPPORT
        ),
        class_weights=dict(sorted(documented.items())),
        hyperparameters=dict(sorted(checked_hyperparameters.items())),
        max_epochs=int(max_epochs),
        train_accuracy=0.0,
    )
    correct = 0
    for vector, label_key in zip(features, labels):
        if model.predict(vector) == label_key:
            correct += 1
    return replace(model, train_accuracy=correct / len(features))


def _symmetric_parameters(
    estimator: Any, class_map: ClassMap, dimension: int
) -> Tuple[Tuple[Tuple[float, ...], ...], Tuple[float, ...]]:
    """The parameters of the fit, one row per class of the class map.

    The estimator of two classes fits ONE separator, and the score of the
    second class is the score of the first one negated. The parameters are
    therefore stored per class, so the answer of the model is the highest
    score among the classes and it does not depend on the shape the estimator
    happened to use.
    """
    raw_coefficients = estimator.coef_
    raw_intercepts = estimator.intercept_
    rows: List[Tuple[float, ...]] = []
    offsets: List[float] = []
    classes = len(class_map.entries)
    if classes == 2:
        row = tuple(float(value) for value in raw_coefficients[0])
        offset = float(raw_intercepts[0])
        rows.append(tuple(-value for value in row))
        offsets.append(-offset)
        rows.append(row)
        offsets.append(offset)
    else:
        for index in range(classes):
            row = tuple(float(value) for value in raw_coefficients[index])
            if len(row) != dimension:
                raise ProbeError(
                    "PROBE_MODEL_INVALID",
                    "model.coefficients",
                    f"the estimator fitted {len(row)} values per class and the vectors of the "
                    f"run carry {dimension}",
                )
            rows.append(row)
            offsets.append(float(raw_intercepts[index]))
    for row in rows:
        if len(row) != dimension:
            raise ProbeError(
                "PROBE_MODEL_INVALID",
                "model.coefficients",
                f"a coefficient row carries {len(row)} values and the vectors of the run "
                f"carry {dimension}",
            )
    return tuple(rows), tuple(offsets)


def class_map_from_recipe(recipe: TrainRecipe) -> ClassMap:
    """The class map of a pinned recipe.

    The class space of a run is the vocabulary its recipe documents, and the
    version of the ontology is the address of that vocabulary: a recipe whose
    class weights and whose ontology version disagree is a recipe whose class
    space nobody can name.

    @raises ProbeError when the recipe disagrees with itself.
    """
    class_map = ClassMap.of(sorted(recipe.class_weights))
    computed = ontology_version_of(class_map.label_keys)
    if computed != recipe.ontology_version:
        raise ProbeError(
            "PROBE_ONTOLOGY_MISMATCH",
            "ontologyVersion",
            f"the recipe declares the ontology {recipe.ontology_version} and its own class "
            f"space digests to {computed}; a run whose class space nobody can name is a run "
            "nobody can reproduce",
        )
    return class_map


def fit_probe_from_recipe(
    recipe: TrainRecipe,
    features: Sequence[Sequence[float]],
    labels: Sequence[str],
) -> ProbeModel:
    """Fits the probe of a pinned recipe.

    Everything the fit is decided by comes from the recipe: the class space,
    the seed, the optimizer, the hyperparameters, the ceiling of the epochs
    and the documented class weights.

    @raises MissingExtraError when the heavy stack is not installed.
    @raises ProbeError when the run cannot be fitted.
    """
    if recipe.estimator != M0_ESTIMATOR:
        raise ProbeError(
            "PROBE_ESTIMATOR_UNSUPPORTED",
            "estimator",
            f"the M0 rung fits a '{M0_ESTIMATOR}' and the recipe pins '{recipe.estimator}'",
        )
    return fit_probe(
        features=features,
        labels=labels,
        class_map=class_map_from_recipe(recipe),
        seed=recipe.seed,
        hyperparameters=recipe.hyperparameters,
        solver=recipe.optimizer,
        max_epochs=recipe.max_epochs,
        class_weights=recipe.class_weights,
    )
