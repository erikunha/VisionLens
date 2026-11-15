"""The pinned recipe of a training run.

A training run is reproducible only if everything that decided it is written
down BEFORE it starts: the encoder and the exact bytes of its weights, the
preprocessing that produced the vectors, the partitions of the data, the
ontology the labels live in, the estimator and its hyperparameters, the seed,
the device, the budget and the class weights. This module is that written
down form, and the fingerprint of the recipe is the `fp2:` digest of the
whole configuration: a recipe whose fingerprint is the digest of a NAME is
a promise that nothing is pinned.

The resolver reads two files the repository already ships and refuses every
condition that leaves the run unpinned, and every refusal names the field it
is about:

- a registry record that does not carry a field the recipe needs;
- a floating revision, because `latest` can never back a saved run;
- a partition that touches another partition, because the leak makes every
  number of the run a number of the training set;
- a class whose weight is not documented, or a weight for a class the ontology
  does not have, because an undocumented weight is a weight nobody chose;
- a device the record does not support, because a silent fallback is
  forbidden;
- a split that carries no assignment, no partition or no value for a field of
  the data pin;
- a file that cannot be read;
- a record whose declared address is not the digest of its own body, because a
  record that claims one configuration and hashes another is a record nobody
  can reproduce.

The recipe does not train anything and it does not read the weights: it is
the pinned configuration, and the run that consumes it is a later module.
The digest of the configuration is computed with the SAME `fp2:` algorithm
the TypeScript side computes with
(`packages/contracts/src/fingerprint.ts`), so the two languages agree on
the address of a configuration or the promise means nothing.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any, Dict, Mapping, Sequence, Tuple

from ..protocol import CONTRACT_VERSION
from ..registry.loader import ModelRegistryError, ModelNotFoundError, resolve_model
from ..registry.loader import load_model_registry
from ..registry.record import ModelRecord, ModelRecordError
from ..runtime.fingerprint import canonical_json, fingerprint_v2, utf16_order

#: The version of the shape of the recipe itself.
RECIPE_VERSION = "1.0.0"

#: The label key of a specimen without a defect.
NORMAL_LABEL_KEY = "normal"

#: The prefix of the label key of a defective specimen.
DEFECT_LABEL_PREFIX = "defect:"

#: The estimator of the M0 rung. It is the only one the rung allows.
M0_ESTIMATOR = "logistic-regression"

#: The device policy of the reference run. The CPU is the reference device
#: and a silent fallback is forbidden (docs/vnext/adrs/ADR-017-local-first-hardware.md:9).
REFERENCE_DEVICE_POLICY = "cpu"

#: The fields a recipe carries. The list is the contract: a recipe with a
#: field that is not here is a recipe nobody wrote.
RECIPE_FIELDS: Tuple[str, ...] = (
    "recipeVersion",
    "encoder",
    "dataset",
    "partitions",
    "ontologyVersion",
    "classWeights",
    "estimator",
    "optimizer",
    "hyperparameters",
    "seed",
    "devicePolicy",
    "augmentation",
    "maxEpochs",
    "earlyStopping",
    "checkpointInterval",
    "resources",
    "budget",
    "contractsVersion",
)

#: The fields the encoder pin carries, and nothing else.
#:
#: The list is the record's own list of fields, minus the NOTES: the notes
#: are the provenance of the record, not a decision of the run, and they
#: travel with the record. Every other field of the record travels
#: unchanged, under the name the record gives it.
ENCODER_PIN_FIELDS: Tuple[str, ...] = (
    "modelId",
    "revision",
    "sourceUri",
    "sourceDigest",
    "license",
    "licenseUrl",
    "commercialUse",
    "usageRestrictions",
    "requiredExtras",
    "tasks",
    "preprocessingFingerprint",
    "deviceSupport",
    "inputImageSize",
    "featureExtractor",
    "outputShape",
    "latencyCostProfile",
    "calibrationStatus",
    "trustPolicy",
    "attribution",
)

#: The pin fields whose value may be empty, because the record lets them be
#: empty. The record owns the rule, and the pin inherits it.
EMPTY_ALLOWED_PIN_FIELDS: Tuple[str, ...] = ("usageRestrictions",)

#: The fields the dataset pin carries, and nothing else.
DATASET_PIN_FIELDS: Tuple[str, ...] = (
    "datasetId",
    "splitId",
    "snapshotFingerprint",
    "manifestHash",
)

#: The partitions a recipe names.
PARTITION_NAMES: Tuple[str, ...] = ("train", "val", "test")


class RecipeError(Exception):
    """Raised when a recipe cannot be resolved.

    The error carries the CODE of the refusal, the FIELD it is about and the
    reason, so a caller can act on it and a reader can see what the recipe
    refused and why. The code is the library-level vocabulary of the training
    surface; it never crosses the wire.
    """

    def __init__(self, code: str, field_path: str, reason: str) -> None:
        super().__init__(f"[{code}] {field_path}: {reason}")
        self.code = code
        self.field = field_path
        self.reason = reason


@dataclass(frozen=True)
class EncoderPin:
    """The encoder of a run, pinned to the exact bytes it will use."""

    model_id: str
    revision: str
    source_uri: str
    source_digest: str
    license: str
    license_url: str
    commercial_use: bool
    usage_restrictions: str
    required_extras: Tuple[str, ...]
    tasks: Tuple[str, ...]
    preprocessing_fingerprint: str
    device_support: Tuple[str, ...]
    input_image_size: Mapping[str, int]
    feature_extractor: str
    output_shape: Mapping[str, int]
    latency_cost_profile: str
    calibration_status: str
    trust_policy: str
    attribution: str

    def to_dict(self) -> Dict[str, Any]:
        """The pin as the wire form of the recipe."""
        return {
            "modelId": self.model_id,
            "revision": self.revision,
            "sourceUri": self.source_uri,
            "sourceDigest": self.source_digest,
            "license": self.license,
            "licenseUrl": self.license_url,
            "commercialUse": self.commercial_use,
            "usageRestrictions": self.usage_restrictions,
            "requiredExtras": list(self.required_extras),
            "tasks": list(self.tasks),
            "preprocessingFingerprint": self.preprocessing_fingerprint,
            "deviceSupport": list(self.device_support),
            "inputImageSize": dict(self.input_image_size),
            "featureExtractor": self.feature_extractor,
            "outputShape": dict(self.output_shape),
            "latencyCostProfile": self.latency_cost_profile,
            "calibrationStatus": self.calibration_status,
            "trustPolicy": self.trust_policy,
            "attribution": self.attribution,
        }


@dataclass(frozen=True)
class DatasetPin:
    """The data of a run, pinned to the split it was measured on."""

    dataset_id: str
    split_id: str
    snapshot_fingerprint: str
    manifest_hash: str

    def to_dict(self) -> Dict[str, Any]:
        """The pin as the wire form of the recipe."""
        return {
            "datasetId": self.dataset_id,
            "splitId": self.split_id,
            "snapshotFingerprint": self.snapshot_fingerprint,
            "manifestHash": self.manifest_hash,
        }


@dataclass(frozen=True)
class TrainRecipe:
    """The pinned configuration of a training run.

    The recipe is immutable: a run that changes a component of the recipe
    is a different run, and the fingerprint says so. The FINGERPRINT field
    is the digest of every other field, so the two languages can recompute
    it and compare.
    """

    encoder: EncoderPin
    dataset: DatasetPin
    partitions: Mapping[str, Tuple[str, ...]]
    ontology_version: str
    class_weights: Mapping[str, str]
    estimator: str
    optimizer: str
    hyperparameters: Mapping[str, Any]
    seed: int
    device_policy: str
    augmentation: Tuple[str, ...]
    max_epochs: int
    early_stopping: Mapping[str, Any]
    checkpoint_interval: int
    resources: Mapping[str, Any]
    budget: Mapping[str, Any]
    contracts_version: str = CONTRACT_VERSION
    recipe_version: str = RECIPE_VERSION
    fingerprint: str = field(default="")

    def to_dict(self) -> Dict[str, Any]:
        """The recipe as the wire form, WITHOUT the fingerprint.

        The fingerprint is the digest of this dictionary, so it is not part
        of what it digests. The TS side computes the digest over exactly
        this shape.
        """
        return {
            "recipeVersion": self.recipe_version,
            "encoder": self.encoder.to_dict(),
            "dataset": self.dataset.to_dict(),
            "partitions": {
                name: list(ids) for name, ids in sorted(self.partitions.items())
            },
            "ontologyVersion": self.ontology_version,
            "classWeights": dict(sorted(self.class_weights.items())),
            "estimator": self.estimator,
            "optimizer": self.optimizer,
            "hyperparameters": dict(self.hyperparameters),
            "seed": self.seed,
            "devicePolicy": self.device_policy,
            "augmentation": list(self.augmentation),
            "maxEpochs": self.max_epochs,
            "earlyStopping": dict(self.early_stopping),
            "checkpointInterval": self.checkpoint_interval,
            "resources": dict(self.resources),
            "budget": dict(self.budget),
            "contractsVersion": self.contracts_version,
        }

    def to_record(self) -> Dict[str, Any]:
        """The recipe as the wire form, WITH the fingerprint."""
        record = self.to_dict()
        record["fingerprint"] = self.fingerprint
        return record


def recipe_fingerprint(recipe: TrainRecipe) -> str:
    """The `fp2:` digest of the whole configuration of a recipe."""
    return fingerprint_v2(recipe.to_dict())


def label_key_of(class_name: str, anomaly: str) -> str:
    """The label key one assignment of the split is scored under.

    The rule is the rule of the TypeScript side
    (`packages/core/src/benchmark/taxonomy.ts`, `labelKeyOf`): a normal
    specimen is `normal` and a defective one is `defect:<object class>`.
    """
    if anomaly == "normal":
        return NORMAL_LABEL_KEY
    return DEFECT_LABEL_PREFIX + class_name


def ontology_version_of(label_keys: Sequence[str]) -> str:
    """The identity of the ontology the labels live in.

    The ontology of a probe is its CLASS SPACE: the set of label keys the
    run may answer with. The digest covers the sorted keys, so a recipe
    whose class space changed has another fingerprint.
    """
    return fingerprint_v2({"labelKeys": sorted(set(label_keys))})


def partition_fingerprint_of(assignments: Sequence[Mapping[str, Any]]) -> str:
    """The fingerprint of the partition of a split, recomputed.

    The fingerprint is the sha256 over the canonical JSON of the sorted
    `id -> split` pairs, and it is the address of the partition alone: which
    item sits in which split.

    The TypeScript side computes the same digest over the same pairs
    (`packages/core/src/benchmark/splits.ts`, `computePartitionFingerprint`),
    and the recipe recomputes it because it holds the ids the split claims:
    a split whose declared fingerprint does not describe its own assignments
    is a split that names a snapshot it does not have.
    """
    pairs = [[str(item["id"]), str(item["split"])] for item in assignments]
    pairs.sort(key=lambda pair: utf16_order(pair[0]))
    return hashlib.sha256(canonical_json(pairs).encode("utf-8")).hexdigest()


def _require(condition: bool, code: str, field_path: str, reason: str) -> None:
    if not condition:
        raise RecipeError(code, field_path, reason)


def _read_json(path: str) -> Any:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError as error:
        raise RecipeError(
            "RECIPE_FILE_MISSING", path, f"the file does not exist: {error.filename}"
        ) from error
    except json.JSONDecodeError as error:
        raise RecipeError(
            "RECIPE_FILE_INVALID", path, f"the file is not valid JSON: {error}"
        ) from error


def _checked_pin(pin: EncoderPin) -> EncoderPin:
    """The pin, checked against the fields it has to carry.

    A pin field with no value is a field of the encoder the run does not
    pin, and the other side refuses such a recipe. The fields the record
    lets be empty are exempt, because a rule the recipe holds to a
    stricter shape than the record refuses a model the platform may run.
    """
    for name in ENCODER_PIN_FIELDS:
        if name in EMPTY_ALLOWED_PIN_FIELDS:
            continue
        value = pin.to_dict()[name]
        _require(
            value not in (None, "", [], (), {}),
            "RECIPE_ENCODER_FIELD_MISSING",
            f"encoder.{name}",
            "the record carries no value for this field, and a recipe may not invent one",
        )
    return pin


def _encoder_pin_of(record: ModelRecord) -> EncoderPin:
    """The pin of a resolved registry record.

    Every field of the record that decides the run travels unchanged, under
    the name the record gives it: the recipe does not decide what a model
    is, it decides what a run will use. The NOTES of the record are the
    provenance of the record itself, and they travel with the record.
    """
    # The floating revision is refused by the RECORD, in one place, and the
    # recipe inherits that refusal: a rule that is checked twice is a rule
    # that is checked in two places and drifts.
    width, height = record.input_image_size
    return _checked_pin(
        EncoderPin(
            model_id=record.model_id,
            revision=record.revision,
            source_uri=record.source_uri,
            source_digest=record.source_digest,
            license=record.license,
            license_url=record.license_url,
            commercial_use=record.commercial_use,
            usage_restrictions=record.usage_restrictions,
            required_extras=tuple(record.required_extras),
            tasks=tuple(record.tasks),
            preprocessing_fingerprint=record.preprocessing_fingerprint,
            device_support=tuple(record.device_support),
            input_image_size={"width": width, "height": height},
            feature_extractor=record.feature_extractor,
            output_shape={"dimension": record.output_dimension},
            latency_cost_profile=record.latency_cost_profile,
            calibration_status=record.calibration_status,
            trust_policy=record.trust_policy,
            attribution=record.attribution,
        )
    )


def _partitions_of(split: Mapping[str, Any]) -> Dict[str, Tuple[str, ...]]:
    """The item ids of the three partitions of a split."""
    assignments = split.get("assignments")
    if not isinstance(assignments, list) or len(assignments) == 0:
        raise RecipeError(
            "RECIPE_SPLIT_INVALID",
            "split.assignments",
            "the split carries no assignment, so it has no partition",
        )
    partitions: Dict[str, list] = {name: [] for name in PARTITION_NAMES}
    for index, assignment in enumerate(assignments):
        _require(
            isinstance(assignment, Mapping),
            "RECIPE_SPLIT_INVALID",
            f"split.assignments.{index}",
            "an assignment is not an object",
        )
        split_name = assignment.get("split")
        item_id = assignment.get("id")
        _require(
            split_name in partitions,
            "RECIPE_SPLIT_INVALID",
            f"split.assignments.{index}.split",
            f"expected one of {'|'.join(PARTITION_NAMES)}, got '{split_name}'",
        )
        _require(
            isinstance(item_id, str) and item_id != "",
            "RECIPE_SPLIT_INVALID",
            f"split.assignments.{index}.id",
            "an assignment must name its item",
        )
        partitions[split_name].append(item_id)
    for name, ids in partitions.items():
        _require(
            len(ids) > 0,
            "RECIPE_SPLIT_INVALID",
            f"partitions.{name}",
            f"the partition holds no item, and a recipe may not pin a partition that "
            "is empty",
        )
    return {name: tuple(ids) for name, ids in partitions.items()}


def _normalized_id(item_id: str) -> str:
    """The id of an item, in the form two partitions are compared by.

    Two ids that name the same item differ in the whitespace around them
    and in the case of the letters, and a leak that hides in that
    difference is a leak nobody sees.
    """
    return item_id.strip().casefold()


def _refuse_leakage(partitions: Mapping[str, Tuple[str, ...]]) -> None:
    """Refuses a split whose partitions share an item.

    The leak is the one thing that makes every number of a run a number of
    the training set, and it is invisible in the metrics. The refusal names
    the partitions that touch and the items they share.
    """
    for first, second in (("train", "test"), ("val", "test"), ("train", "val")):
        # The ids are compared in their normalized form, so an item that
        # hides in a difference of case or of whitespace is caught too, and
        # the refusal names the id as the split carries it.
        of_second = {_normalized_id(item_id) for item_id in partitions[second]}
        shared = sorted(
            item_id
            for item_id in partitions[first]
            if _normalized_id(item_id) in of_second
        )
        if shared:
            shown = ", ".join(shared[:5])
            more = "" if len(shared) <= 5 else f" (and {len(shared) - 5} more)"
            raise RecipeError(
                "RECIPE_PARTITION_LEAKAGE",
                f"partitions.{first}/{second}",
                f"the partitions share {len(shared)} item(s): {shown}{more}; a recipe whose "
                "partitions touch is a recipe whose numbers are numbers of the training set",
            )


def _label_keys_of(split: Mapping[str, Any]) -> Tuple[str, ...]:
    """The label keys of the ontology, taken from the assignments."""
    keys = []
    for assignment in split.get("assignments", []):
        class_name = assignment.get("class")
        anomaly = assignment.get("anomaly")
        _require(
            isinstance(class_name, str) and class_name != "",
            "RECIPE_SPLIT_INVALID",
            "split.assignments.class",
            "an assignment must name its class",
        )
        _require(
            isinstance(anomaly, str) and anomaly != "",
            "RECIPE_SPLIT_INVALID",
            "split.assignments.anomaly",
            "an assignment must name its anomaly",
        )
        keys.append(label_key_of(class_name, anomaly))
    return tuple(sorted(set(keys)))


def _checked_weight(label_key: str, value: Any) -> Any:
    """The weight of one class, checked and in the form the wire carries.

    A weight is a number or the word `none`, and a number STAYS a number:
    the schema of the other side accepts a number or the word `none`, and
    a weight written as the text of a number is a weight the other side
    has to refuse.
    """
    if isinstance(value, str):
        _require(
            value == "none",
            "RECIPE_CLASS_WEIGHT_INVALID",
            f"classWeights.{label_key}",
            f"the only documented weight that is not a number is 'none', got '{value}'",
        )
        return "none"
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise RecipeError(
            "RECIPE_CLASS_WEIGHT_INVALID",
            f"classWeights.{label_key}",
            "a class weight is a number or the word 'none'",
        )
    _require(
        value >= 0,
        "RECIPE_CLASS_WEIGHT_INVALID",
        f"classWeights.{label_key}",
        "a class weight may not be negative",
    )
    return value if isinstance(value, int) else float(value)


def _class_weights_of(
    class_weights: Mapping[str, Any], label_keys: Sequence[str]
) -> Dict[str, Any]:
    """The documented class weights of every class of the ontology.

    A class weight may be `none`, which means the class is not weighted,
    but it has to be DOCUMENTED: an undocumented weight is a weight nobody
    chose, and the recipe cannot tell it apart from a forgotten one.
    """
    weights: Dict[str, Any] = {}
    for label_key in label_keys:
        if label_key not in class_weights:
            raise RecipeError(
                "RECIPE_CLASS_WEIGHT_MISSING",
                f"classWeights.{label_key}",
                "every class of the ontology needs a documented class weight, and 'none' is "
                "a documented weight",
            )
        value = class_weights[label_key]
        weights[label_key] = _checked_weight(label_key, value)
    unknown = sorted(set(class_weights) - set(label_keys))
    if unknown:
        raise RecipeError(
            "RECIPE_CLASS_WEIGHT_UNKNOWN",
            "classWeights",
            f"the recipe carries a weight for a class the ontology does not have: "
            f"{', '.join(unknown)}",
        )
    return weights


def resolve_recipe(
    *,
    registry_path: str,
    model_id: str,
    split_path: str,
    class_weights: Mapping[str, Any],
    hyperparameters: Mapping[str, Any],
    optimizer: str = "lbfgs",
    seed: int = 42,
    device_policy: str = REFERENCE_DEVICE_POLICY,
    augmentation: Sequence[str] = (),
    max_epochs: int = 200,
    early_stopping: Mapping[str, Any] | None = None,
    checkpoint_interval: int = 10,
    resources: Mapping[str, Any] | None = None,
    budget: Mapping[str, Any] | None = None,
    contracts_version: str = CONTRACT_VERSION,
) -> TrainRecipe:
    """Resolves the pinned recipe of a run.

    The resolver reads the registry and the split, and it refuses a recipe
    that is not pinned: a record without a field the run needs, a floating
    revision, partitions that touch, a class without a documented weight, a
    device the record does not support, a split that carries no partition and
    a file that cannot be read.

    @raises RecipeError when the recipe cannot be resolved.
    """
    try:
        registry = load_model_registry(registry_path)
        record = resolve_model(registry, model_id)
    except ModelRecordError as error:
        # The record named the field it refused, and the field is the path
        # of that field IN THE REGISTRY FILE: a caller learns what to fix
        # instead of guessing which rule fired.
        raise RecipeError(
            "RECIPE_ENCODER_FIELD_INVALID", error.field, error.reason
        ) from error
    except (ModelRegistryError, ModelNotFoundError) as error:
        raise RecipeError(
            "RECIPE_ENCODER_UNRESOLVED", f"encoder.{model_id}", str(error)
        ) from error

    encoder = _encoder_pin_of(record)

    _require(
        device_policy in encoder.device_support,
        "RECIPE_DEVICE_UNSUPPORTED",
        "devicePolicy",
        f"the record of '{encoder.model_id}' does not support '{device_policy}'; it "
        f"supports {'|'.join(encoder.device_support)}",
    )

    split = _read_json(split_path)
    _require(
        isinstance(split, Mapping),
        "RECIPE_SPLIT_INVALID",
        "split",
        "the split is not an object",
    )
    partitions = _partitions_of(split)
    _refuse_leakage(partitions)

    label_keys = _label_keys_of(split)
    weights = _class_weights_of(class_weights, label_keys)

    dataset = DatasetPin(
        dataset_id=str(split.get("datasetId", "")),
        split_id=str(split.get("id", "")),
        snapshot_fingerprint=str(split.get("partitionFingerprint", "")),
        manifest_hash=str(split.get("manifestHash", "")),
    )
    for name in DATASET_PIN_FIELDS:
        value = dataset.to_dict()[name]
        _require(
            value not in (None, ""),
            "RECIPE_DATASET_FIELD_MISSING",
            f"dataset.{name}",
            "the split carries no value for this field, and a recipe may not invent one",
        )

    # The snapshot the recipe pins is the partition the split holds, and the
    # recipe holds the ids of that partition, so the recipe recomputes the
    # fingerprint of the partition instead of taking the declared one on
    # trust: a split that names a snapshot it does not have is a split whose
    # snapshot is a name.
    recomputed_snapshot = partition_fingerprint_of(split["assignments"])
    _require(
        dataset.snapshot_fingerprint == recomputed_snapshot,
        "RECIPE_SNAPSHOT_MISMATCH",
        "dataset.snapshotFingerprint",
        f"the split declares the fingerprint {dataset.snapshot_fingerprint} and its own "
        f"assignments digest to {recomputed_snapshot}; a split that names a snapshot it "
        "does not have is a split whose snapshot is a name",
    )

    recipe = TrainRecipe(
        encoder=encoder,
        dataset=dataset,
        partitions=partitions,
        ontology_version=ontology_version_of(label_keys),
        class_weights=weights,
        estimator=M0_ESTIMATOR,
        optimizer=optimizer,
        hyperparameters=dict(hyperparameters),
        seed=seed,
        device_policy=device_policy,
        augmentation=tuple(augmentation),
        max_epochs=max_epochs,
        early_stopping=dict(early_stopping or {}),
        checkpoint_interval=checkpoint_interval,
        resources=dict(resources or {}),
        budget=dict(budget or {}),
        contracts_version=contracts_version,
    )
    fingerprint = recipe_fingerprint(recipe)
    return TrainRecipe(**{**recipe.__dict__, "fingerprint": fingerprint})


def recipe_from_record(record: Mapping[str, Any]) -> TrainRecipe:
    """Rebuilds a recipe from the wire form it was published in.

    The wire form is what the TypeScript side validates, so the recipe that
    a run consumed can be read back without the files it came from.

    The address of the record is CHECKED and not trusted: the digest of the
    body is recomputed, and a record whose declared address is not the
    digest of its own body is refused, because a record that claims one
    configuration and hashes another is a record nobody can reproduce.
    """
    _require(
        isinstance(record, Mapping),
        "RECIPE_RECORD_INVALID",
        "recipe",
        "the recipe record is not an object",
    )
    for name in RECIPE_FIELDS:
        _require(
            name in record,
            "RECIPE_RECORD_INVALID",
            name,
            "the recipe record carries no such field",
        )
    encoder = _checked_pin(
        EncoderPin(
            model_id=str(record["encoder"]["modelId"]),
            revision=str(record["encoder"]["revision"]),
            source_uri=str(record["encoder"]["sourceUri"]),
            source_digest=str(record["encoder"]["sourceDigest"]),
            license=str(record["encoder"]["license"]),
            license_url=str(record["encoder"]["licenseUrl"]),
            commercial_use=bool(record["encoder"]["commercialUse"]),
            usage_restrictions=str(record["encoder"]["usageRestrictions"]),
            required_extras=tuple(record["encoder"]["requiredExtras"]),
            tasks=tuple(record["encoder"]["tasks"]),
            preprocessing_fingerprint=str(record["encoder"]["preprocessingFingerprint"]),
            device_support=tuple(record["encoder"]["deviceSupport"]),
            input_image_size={
                "width": int(record["encoder"]["inputImageSize"]["width"]),
                "height": int(record["encoder"]["inputImageSize"]["height"]),
            },
            feature_extractor=str(record["encoder"]["featureExtractor"]),
            output_shape={
                "dimension": int(record["encoder"]["outputShape"]["dimension"])
            },
            latency_cost_profile=str(record["encoder"]["latencyCostProfile"]),
            calibration_status=str(record["encoder"]["calibrationStatus"]),
            trust_policy=str(record["encoder"]["trustPolicy"]),
            attribution=str(record["encoder"]["attribution"]),
        )
    )
    dataset = DatasetPin(
        dataset_id=str(record["dataset"]["datasetId"]),
        split_id=str(record["dataset"]["splitId"]),
        snapshot_fingerprint=str(record["dataset"]["snapshotFingerprint"]),
        manifest_hash=str(record["dataset"]["manifestHash"]),
    )
    partitions = {
        name: tuple(str(item) for item in ids)
        for name, ids in record["partitions"].items()
    }
    recipe = TrainRecipe(
        encoder=encoder,
        dataset=dataset,
        partitions=partitions,
        ontology_version=str(record["ontologyVersion"]),
        class_weights={
            str(label_key): _checked_weight(str(label_key), value)
            for label_key, value in record["classWeights"].items()
        },
        estimator=str(record["estimator"]),
        optimizer=str(record["optimizer"]),
        hyperparameters=dict(record["hyperparameters"]),
        seed=int(record["seed"]),
        device_policy=str(record["devicePolicy"]),
        augmentation=tuple(str(item) for item in record["augmentation"]),
        max_epochs=int(record["maxEpochs"]),
        early_stopping=dict(record["earlyStopping"]),
        checkpoint_interval=int(record["checkpointInterval"]),
        resources=dict(record["resources"]),
        budget=dict(record["budget"]),
        contracts_version=str(record["contractsVersion"]),
        recipe_version=str(record["recipeVersion"]),
    )
    computed = recipe_fingerprint(recipe)
    declared = str(record.get("fingerprint", ""))
    if declared:
        _require(
            declared == computed,
            "RECIPE_FINGERPRINT_MISMATCH",
            "fingerprint",
            f"the record declares the address {declared} and its own body digests to "
            f"{computed}; a record that claims one configuration and hashes another is "
            "a record nobody can reproduce",
        )
    return TrainRecipe(**{**recipe.__dict__, "fingerprint": computed})


def default_class_weights(label_keys: Sequence[str]) -> Dict[str, str]:
    """The documented class weights of a run that weights no class.

    Every class of the ontology is listed with the word `none`, which is a
    documented decision and not a missing one.
    """
    return {label_key: "none" for label_key in label_keys}
