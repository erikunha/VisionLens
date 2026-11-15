"""The frozen feature artifact of a run, read back and checked against the
recipe.

The trainer NEVER recomputes the features: the vectors of a run come from
the artifact of the encoder, and the artifact is REUSED as it is
(`docs/vnext/11-VISION-MODEL-REGISTRY-INFERENCE.md:23`, and the M0 rung of
`docs/vnext/12-TRAINING-EXPERIMENTS-MLFLOW.md:5`). Training and inference may not see two different preprocessing
pipelines, and the place where that is proved is here: the loader compares
the artifact with the recipe and refuses what does not agree.

Every refusal names BOTH sides, so a caller learns which of the two to
change and not only that something did not agree:

- the REVISION of the artifact is not the revision the recipe pins, because
  two revisions produce vectors that are not comparable;
- the PREPROCESSING FINGERPRINT is not the one the recipe pins, for the
  same reason;
- the DIMENSION of the vectors is not the dimension the recipe pins, and
  the vectors are not comparable either;
- the artifact MIXES two revisions or two preprocessing fingerprints, and
  the refusal names the two of each.

The vectors of the artifact are paired with the ITEMS of the split by the
digest of the image: the manifest of the artifact carries the digest of
every asset in the order of the vectors, and the split carries the same
digest for every item. The pairing is therefore by content and not by
position, and a digest that belongs to two items is refused: an ambiguous
pairing is a pairing nobody can trust.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Sequence, Tuple

from ..inference.artifact import EmbeddingArtifact, read_embedding_artifact
from .recipe import TrainRecipe

#: The number of bytes of one float32 value.
FLOAT_BYTES = 4


class FeatureError(Exception):
    """Raised when a feature artifact cannot be used by a run.

    The error carries the CODE of the refusal, the FIELD it is about and
    the reason, so a caller can act on it and a reader can see what the
    loader refused and why.
    """

    def __init__(self, code: str, field: str, reason: str) -> None:
        super().__init__(f"[{code}] {field}: {reason}")
        self.code = code
        self.field = field
        self.reason = reason


@dataclass(frozen=True)
class FeatureSet:
    """The frozen vectors of a run, and the identity of the artifact.

    The set carries the items it holds and the items it does NOT hold: an
    item the artifact does not carry is a missing prediction, and a missing
    prediction is an error of the evaluation and never a deleted sample
    (`docs/vnext/12-TRAINING-EXPERIMENTS-MLFLOW.md:27`).
    """

    item_ids: Tuple[str, ...]
    vectors: Tuple[Tuple[float, ...], ...]
    dimension: int
    revision: str
    preprocessing_fingerprint: str
    artifact_digests: Tuple[str, ...]
    missing: Tuple[str, ...] = ()

    def vector_of(self, item_id: str) -> Tuple[float, ...]:
        """The vector of one item.

        @raises FeatureError when the item is not in the set.
        """
        for index, name in enumerate(self.item_ids):
            if name == item_id:
                return self.vectors[index]
        raise FeatureError(
            "FEATURES_ITEM_UNKNOWN",
            f"items.{item_id}",
            f"the item '{item_id}' carries no vector, and a vector nobody has is a "
            "prediction nobody can make",
        )


def _read_artifacts(
    directories: Sequence[Path],
) -> Tuple[EmbeddingArtifact, ...]:
    """The artifacts of the run, read back.

    @raises FeatureError when an artifact cannot be read.
    """
    if not directories:
        raise FeatureError(
            "FEATURES_ARTIFACT_MISSING",
            "featureDirectories",
            "the run names no artifact of features, and a probe over no vector is a probe "
            "over nothing",
        )
    artifacts = []
    for directory in directories:
        try:
            artifacts.append(read_embedding_artifact(Path(directory)))
        except (OSError, TypeError, ValueError) as error:
            raise FeatureError(
                "FEATURES_ARTIFACT_INVALID",
                str(directory),
                f"the artifact of features cannot be read: {error}",
            ) from error
    return tuple(artifacts)


def _checked_identity(
    artifacts: Sequence[EmbeddingArtifact], recipe: TrainRecipe
) -> Tuple[str, str]:
    """The revision and the preprocessing of the artifacts, checked.

    The artifacts of one run carry ONE revision and ONE preprocessing: two
    revisions or two preprocessings in one run are vectors that are not
    comparable, and the refusal names the two of each.

    @raises FeatureError when the artifacts disagree with each other or
        with the recipe.
    """
    revisions = sorted({artifact.manifest.revision for artifact in artifacts})
    preprocessings = sorted(
        {artifact.manifest.preprocessing_fingerprint for artifact in artifacts}
    )
    if len(revisions) > 1:
        raise FeatureError(
            "FEATURES_MIXED_REVISION",
            "featureDirectories",
            f"the artifacts of the run carry {len(revisions)} revisions: "
            f"{' and '.join(revisions)}; vectors of two revisions are not comparable",
        )
    if len(preprocessings) > 1:
        raise FeatureError(
            "FEATURES_MIXED_PREPROCESSING",
            "featureDirectories",
            f"the artifacts of the run carry {len(preprocessings)} preprocessing "
            f"fingerprints: {' and '.join(preprocessings)}; vectors of two preprocessing "
            "pipelines are not comparable",
        )
    revision = revisions[0]
    preprocessing = preprocessings[0]
    if revision != recipe.encoder.revision:
        raise FeatureError(
            "FEATURES_REVISION_MISMATCH",
            "encoder.revision",
            f"the artifact of features was produced with the revision '{revision}' and the "
            f"recipe pins the revision '{recipe.encoder.revision}'; vectors of two "
            "revisions are not comparable",
        )
    if preprocessing != recipe.encoder.preprocessing_fingerprint:
        raise FeatureError(
            "FEATURES_PREPROCESSING_MISMATCH",
            "encoder.preprocessingFingerprint",
            f"the artifact of features was produced with the preprocessing "
            f"'{preprocessing}' and the recipe pins the preprocessing "
            f"'{recipe.encoder.preprocessing_fingerprint}'; vectors of two preprocessing "
            "pipelines are not comparable",
        )
    return revision, preprocessing


def _pinned_dimension(recipe: TrainRecipe) -> int:
    """The dimension the recipe pins.

    @raises FeatureError when the recipe pins no dimension.
    """
    shape = recipe.encoder.output_shape
    dimension = shape.get("dimension") if hasattr(shape, "get") else None
    if not isinstance(dimension, int) or isinstance(dimension, bool) or dimension <= 0:
        raise FeatureError(
            "FEATURES_DIMENSION_UNPINNED",
            "encoder.outputShape.dimension",
            "the recipe pins no dimension of the vectors, and vectors of no dimension are "
            "not comparable with anything",
        )
    return dimension


def _vectors_of(artifact: EmbeddingArtifact) -> Tuple[Tuple[float, ...], ...]:
    """The vectors of an artifact, read from the bytes of the file.

    The file is a run of float32 values, and the manifest says how many
    vectors it holds and how many values each of them carries.

    @raises FeatureError when the file does not carry what the manifest
        names.
    """
    manifest = artifact.manifest
    import array

    values = array.array("f")
    if values.itemsize != FLOAT_BYTES:
        raise FeatureError(
            "FEATURES_ARTIFACT_INVALID",
            str(artifact.vectors_path),
            f"a float of this platform is {values.itemsize} bytes and the artifact was "
            f"written with floats of {FLOAT_BYTES} bytes; the file is not the file the "
            "manifest names",
        )

    payload = artifact.vectors_path.read_bytes()
    if len(payload) % FLOAT_BYTES != 0:
        raise FeatureError(
            "FEATURES_ARTIFACT_INVALID",
            str(artifact.vectors_path),
            f"the vectors file carries {len(payload)} bytes and a float of this platform is "
            f"{FLOAT_BYTES} bytes; the file is not the file the manifest names",
        )
    values.frombytes(payload)
    if len(values) != manifest.count * manifest.dimension:
        raise FeatureError(
            "FEATURES_ARTIFACT_INVALID",
            str(artifact.vectors_path),
            f"the vectors file carries {len(values)} values and the manifest names "
            f"{manifest.count} vectors of {manifest.dimension} values",
        )
    vectors = tuple(
        tuple(
            float(value)
            for value in values[index * manifest.dimension : (index + 1) * manifest.dimension]
        )
        for index in range(manifest.count)
    )
    for index, vector in enumerate(vectors):
        for position, value in enumerate(vector):
            if value != value or value in (float("inf"), float("-inf")):
                raise FeatureError(
                    "FEATURES_VECTOR_NOT_FINITE",
                    str(artifact.vectors_path),
                    f"the vector {index} carries a value that is not a number at the "
                    f"position {position}; a vector of NaN or of infinity is not a "
                    "measurement",
                )
    return vectors


def load_features(
    directories: Sequence[Path],
    recipe: TrainRecipe,
    items: Sequence[Tuple[str, str]],
) -> FeatureSet:
    """The frozen vectors of the run, for the items of the split.

    The items are the pairs of the item id and the digest of its image, and
    the pairing with the vectors is by the digest: the artifact carries the
    digest of every asset in the order of the vectors, so a vector and an
    item are the same thing when their digests are.

    @raises FeatureError when the artifact cannot be used by the run.
    """
    artifacts = _read_artifacts(directories)
    revision, preprocessing = _checked_identity(artifacts, recipe)

    # The pairing is refused BEFORE it happens: a digest that names two items
    # is a digest nobody can pair, and the refusal happens while the run can
    # still say so.
    digests = [digest for _, digest in items]
    if len(set(digests)) != len(digests):
        repeated = sorted({digest for digest in digests if digests.count(digest) > 1})
        raise FeatureError(
            "FEATURES_ITEM_AMBIGUOUS",
            "items",
            f"{len(repeated)} digest(s) name two items: {', '.join(repeated[:5])}; a vector "
            "that belongs to two items is a vector nobody can pair",
        )

    by_digest: Dict[str, Tuple[float, ...]] = {}
    for artifact in artifacts:
        artifact_vectors = _vectors_of(artifact)
        asset_digests = artifact.manifest.asset_sha256
        if len(asset_digests) != len(artifact_vectors):
            raise FeatureError(
                "FEATURES_ARTIFACT_INVALID",
                str(artifact.manifest_path),
                f"the manifest names {len(asset_digests)} assets and the file carries "
                f"{len(artifact_vectors)} vectors; a vector and an asset are paired by position",
            )
        for digest, vector in zip(asset_digests, artifact_vectors):
            if digest in by_digest:
                raise FeatureError(
                    "FEATURES_ARTIFACT_DUPLICATE",
                    "items",
                    f"the digest '{digest}' is carried by two artifacts, and a vector that "
                    "belongs to two assets is a vector nobody can pair",
                )
            by_digest[digest] = vector

    dimension = artifacts[0].manifest.dimension
    pinned = _pinned_dimension(recipe)
    for artifact in artifacts:
        carried = artifact.manifest.dimension
        if carried != pinned:
            raise FeatureError(
                "FEATURES_DIMENSION_MISMATCH",
                "encoder.outputShape.dimension",
                f"the artifact of features carries vectors of {carried} values and the "
                f"recipe pins a dimension of {pinned}; vectors of two dimensions are not "
                "comparable",
            )
    for artifact in artifacts:
        if artifact.manifest.dimension != dimension:
            raise FeatureError(
                "FEATURES_DIMENSION_MIXED",
                "featureDirectories",
                f"the artifacts of the run carry the dimensions {dimension} and "
                f"{artifact.manifest.dimension}; vectors of two dimensions are not "
                "comparable",
            )

    item_ids: list[str] = []
    paired: list[Tuple[float, ...]] = []
    missing: list[str] = []
    seen: set[str] = set()
    for item_id, digest in items:
        if item_id in seen:
            raise FeatureError(
                "FEATURES_ITEM_DUPLICATE",
                "items",
                f"the item '{item_id}' is named twice, and a vector that belongs to two "
                "items is a vector nobody can pair",
            )
        seen.add(item_id)
        found = by_digest.get(digest)
        if found is None:
            missing.append(item_id)
            continue
        item_ids.append(item_id)
        paired.append(found)

    return FeatureSet(
        item_ids=tuple(item_ids),
        vectors=tuple(paired),
        dimension=dimension,
        revision=revision,
        preprocessing_fingerprint=preprocessing,
        artifact_digests=tuple(artifact.artifact_digest for artifact in artifacts),
        missing=tuple(missing),
    )


def features_of(
    feature_set: FeatureSet, item_ids: Sequence[str]
) -> Tuple[Tuple[str, ...], Tuple[Tuple[float, ...], ...]]:
    """The vectors of the items named, in the order they were named.

    @raises FeatureError when an item carries no vector.
    """
    selected: list[str] = []
    vectors: list[Tuple[float, ...]] = []
    for item_id in item_ids:
        selected.append(item_id)
        vectors.append(feature_set.vector_of(item_id))
    return tuple(selected), tuple(vectors)
