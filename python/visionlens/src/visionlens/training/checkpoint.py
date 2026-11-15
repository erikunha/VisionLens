"""The checkpoint of a training run: content addressed and published atomically.

A checkpoint is an artifact, and an artifact that is not addressed by its own
content is an artifact nobody can verify. The manifest of a checkpoint
carries the sha256 of the checkpoint file, the class map of the run and the
epoch it was written at, and a reader that hashes the file and finds
another digest REFUSES the checkpoint instead of loading it
(`docs/vnext/08-DOMAIN-STORE-AND-PROVENANCE.md:26`, FR-006 of the ticket).

The publication is ATOMIC and it is ordered: the checkpoint file is written
to a temporary name, hashed, renamed to the name of its own digest, and only
then is the manifest written and renamed into place. A run that dies in the
middle leaves a file nobody points at, and never a manifest that points at a
half written file. The manifest is the publication: a checkpoint without a
manifest is not published, and a cancelled run publishes nothing at all.

The checkpoint file is a JSON document and not a pickled estimator. Three
properties follow from it, and all three are wanted here: the bytes of two
machines are the same bytes, so the digest of a run is reproducible
everywhere; the artifact is readable without running anything; and loading it
never executes code that came with the file. The parameters of the probe are
plain numbers, so there is nothing a pickle would carry that JSON cannot.

The resume state is the EPOCH of the manifest: a run that was interrupted
continues after the epoch the last checkpoint was written at, and the epoch
of the checkpoint and the epoch of its manifest must agree, because a
manifest that describes another epoch is a manifest nobody can resume from.
"""

from __future__ import annotations

import json
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Mapping, Tuple

from ..hashing import sha256_of_bytes, sha256_of_file
from .probe import ClassMap, ProbeError, ProbeModel

#: The version of the shape of a checkpoint and of its manifest.
CHECKPOINT_VERSION = "1.0.0"

#: The suffix of the file of a checkpoint.
CHECKPOINT_SUFFIX = ".json"

#: The suffix of the file of a manifest.
MANIFEST_SUFFIX = ".manifest.json"

#: The name of the manifest of an epoch.
MANIFEST_NAME_TEMPLATE = "checkpoint-{epoch:06d}" + MANIFEST_SUFFIX


class CheckpointError(Exception):
    """Raised when a checkpoint cannot be written or cannot be read.

    The error carries the CODE of the refusal, the FIELD it is about and the
    reason, so a caller can act on it and a reader can see what the
    checkpoint refused and why.
    """

    def __init__(self, code: str, field: str, reason: str) -> None:
        super().__init__(f"[{code}] {field}: {reason}")
        self.code = code
        self.field = field
        self.reason = reason


@dataclass(frozen=True)
class CheckpointManifest:
    """What the manifest of a checkpoint says.

    The manifest is the published description of a checkpoint: which file it
    is, what the digest of that file is, which classes the run may answer
    with, at which epoch the run was, and which recipe decided the run.
    """

    version: str
    checkpoint_file: str
    checkpoint_sha256: str
    class_map: ClassMap
    epoch: int
    recipe_fingerprint: str
    estimator: str
    seed: int
    dimension: int

    def to_dict(self) -> Dict[str, Any]:
        """The manifest as the wire form."""
        return {
            "manifestVersion": self.version,
            "checkpointFile": self.checkpoint_file,
            "checkpointSha256": self.checkpoint_sha256,
            "classMap": self.class_map.to_dict(),
            "epoch": self.epoch,
            "recipeFingerprint": self.recipe_fingerprint,
            "estimator": self.estimator,
            "seed": self.seed,
            "dimension": self.dimension,
        }

    @staticmethod
    def from_dict(record: Mapping[str, Any]) -> "CheckpointManifest":
        """The manifest, read back from the wire form.

        @raises CheckpointError when the form is not a manifest.
        """
        if not isinstance(record, Mapping):
            raise CheckpointError(
                "CHECKPOINT_MANIFEST_INVALID",
                "manifest",
                "the manifest is not an object",
            )
        try:
            class_map = ClassMap.from_dict(record["classMap"])
            epoch = int(record["epoch"])
            dimension = int(record["dimension"])
            seed = int(record["seed"])
        except (KeyError, TypeError, ValueError) as error:
            raise CheckpointError(
                "CHECKPOINT_MANIFEST_INVALID",
                "manifest",
                f"the manifest does not carry the shape of a checkpoint: {error}",
            ) from error
        except ProbeError as error:
            # The refusal is a refusal of the MANIFEST and not of the probe:
            # a caller of the checkpoint catches one vocabulary and not the
            # other.
            raise CheckpointError(
                "CHECKPOINT_MANIFEST_INVALID",
                "manifest.classMap",
                f"the manifest carries no class map it can read: {error.reason}",
            ) from error
        return CheckpointManifest(
            version=str(record.get("manifestVersion", CHECKPOINT_VERSION)),
            checkpoint_file=str(record.get("checkpointFile", "")),
            checkpoint_sha256=str(record.get("checkpointSha256", "")),
            class_map=class_map,
            epoch=epoch,
            recipe_fingerprint=str(record.get("recipeFingerprint", "")),
            estimator=str(record.get("estimator", "")),
            seed=seed,
            dimension=dimension,
        )

    def next_epoch(self) -> int:
        """The epoch a run continues at when it resumes from this checkpoint."""
        return self.epoch + 1


@dataclass(frozen=True)
class LoadedCheckpoint:
    """A checkpoint that was read back and verified."""

    manifest: CheckpointManifest
    model: ProbeModel

    @property
    def epoch(self) -> int:
        """The epoch the checkpoint was written at."""
        return self.manifest.epoch


def _written_atomically(path: Path, payload: bytes) -> None:
    """Writes the bytes of a file and renames it into place.

    The bytes go to a temporary file in the SAME directory, they are flushed
    to the disk, and only then the file is renamed into place. The rename is
    the publication: a reader sees either the old file or the new one, and
    never a half written one.
    """
    directory = path.parent
    handle, temporary = tempfile.mkstemp(
        dir=str(directory), prefix=path.name + ".", suffix=".tmp"
    )
    try:
        with os.fdopen(handle, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    except BaseException:
        # The temporary file is removed when the write fails: a half written
        # file that nobody points at is still a file nobody wants.
        if os.path.exists(temporary):
            os.unlink(temporary)
        raise
    _flushed_directory(directory)


def _flushed_directory(directory: Path) -> None:
    """Flushes the directory of a publication, so the rename survives a crash.

    The rename is atomic for a READER: it sees the old file or the new one.
    It is the flush of the DIRECTORY that makes the new name survive a crash
    of the machine, and a checkpoint that vanishes with the crash is a
    checkpoint the run never published.

    A platform that refuses to flush a directory still published the file,
    so the refusal is not an error of the publication and it is not raised.
    """
    try:
        handle = os.open(str(directory), os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(handle)
    except OSError:
        return
    finally:
        os.close(handle)


def write_checkpoint(
    directory: Path,
    model: ProbeModel,
    *,
    epoch: int,
    recipe_fingerprint: str,
) -> CheckpointManifest:
    """Writes the checkpoint of a run and publishes its manifest.

    The checkpoint file is named after its own digest, so the artifact is
    addressed by its content, and the manifest that points at it is published
    last.

    @raises CheckpointError when the checkpoint cannot be published.
    """
    if not isinstance(epoch, int) or isinstance(epoch, bool) or epoch < 0:
        raise CheckpointError(
            "CHECKPOINT_EPOCH_INVALID",
            "epoch",
            f"the epoch of a checkpoint is a whole number that is not negative, got {epoch!r}",
        )
    if not isinstance(recipe_fingerprint, str) or not recipe_fingerprint:
        raise CheckpointError(
            "CHECKPOINT_RECIPE_FINGERPRINT_INVALID",
            "recipeFingerprint",
            "a checkpoint carries the address of the recipe that decided it, and a "
            "checkpoint nobody can bind to a recipe is a checkpoint nobody can reproduce",
        )
    target = Path(directory)
    try:
        target.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        raise CheckpointError(
            "CHECKPOINT_DIRECTORY_INVALID",
            "directory",
            f"the directory of the checkpoint cannot be created: {error}",
        ) from error

    payload = {
        "checkpointVersion": CHECKPOINT_VERSION,
        "epoch": epoch,
        "recipeFingerprint": recipe_fingerprint,
        "model": model.to_dict(),
    }
    body = (
        json.dumps(payload, sort_keys=True, indent=2, ensure_ascii=False) + "\n"
    ).encode("utf-8")
    digest = sha256_of_bytes(body)

    # The conflict of the epoch is checked BEFORE the file is published: a
    # refused publication leaves no artifact behind, and a run that cannot
    # publish its epoch does not leave a file nobody points at.
    manifest_path = target / MANIFEST_NAME_TEMPLATE.format(epoch=epoch)
    existing = _existing_manifest(manifest_path)
    if existing is not None and existing.checkpoint_sha256 != digest:
        raise CheckpointError(
            "CHECKPOINT_MANIFEST_CONFLICT",
            "manifest.epoch",
            f"the epoch {epoch} was already published with the digest "
            f"{existing.checkpoint_sha256} and this run publishes another digest with it; "
            "two checkpoints of one epoch are two runs",
        )

    checkpoint_path = target / (digest + CHECKPOINT_SUFFIX)
    _published(checkpoint_path, body)

    manifest = CheckpointManifest(
        version=CHECKPOINT_VERSION,
        checkpoint_file=checkpoint_path.name,
        checkpoint_sha256=digest,
        class_map=model.class_map,
        epoch=epoch,
        recipe_fingerprint=recipe_fingerprint,
        estimator=model.estimator,
        seed=model.seed,
        dimension=model.dimension,
    )
    _published(
        manifest_path,
        (
            json.dumps(manifest.to_dict(), sort_keys=True, indent=2, ensure_ascii=False)
            + "\n"
        ).encode("utf-8"),
    )
    return manifest


def _published(path: Path, payload: bytes) -> None:
    """Publishes a file, and refuses the failure in the vocabulary of the run.

    @raises CheckpointError when the file cannot be written.
    """
    try:
        _written_atomically(path, payload)
    except OSError as error:
        raise CheckpointError(
            "CHECKPOINT_WRITE_FAILED",
            "checkpoint",
            f"the file '{path.name}' cannot be published: {error}",
        ) from error


def _existing_manifest(manifest_path: Path) -> CheckpointManifest | None:
    """The manifest already published at a path, if there is one.

    A manifest that EXISTS and cannot be read is a manifest of the epoch, and
    the epoch is not free: it is refused. A manifest nobody can read is a
    manifest nobody may overwrite, because overwriting it would publish a
    second run under the name of the first one.

    @raises CheckpointError when the manifest exists and cannot be read.
    """
    if not manifest_path.is_file():
        return None
    try:
        record = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise CheckpointError(
            "CHECKPOINT_MANIFEST_CONFLICT",
            "manifest.epoch",
            f"the epoch already carries a manifest and the manifest cannot be read: {error}; "
            "a manifest nobody can read is a manifest nobody may overwrite",
        ) from error
    try:
        return CheckpointManifest.from_dict(record)
    except CheckpointError as error:
        raise CheckpointError(
            "CHECKPOINT_MANIFEST_CONFLICT",
            "manifest.epoch",
            f"the epoch already carries a manifest and the manifest is not one: "
            f"{error.reason}",
        ) from error


def _checkpoint_file_of(manifest: CheckpointManifest) -> str:
    """The name of the file of a checkpoint, checked.

    A checkpoint is a file of the directory of its manifest, so the name is a
    NAME and not a path: a manifest that names a file outside the directory
    would make the reader hash a file the run never published, and the
    directory of the run is the only place a checkpoint of the run can be.

    @raises CheckpointError when the name is not a name.
    """
    name = manifest.checkpoint_file
    if (
        not name
        or "/" in name
        or "\\" in name
        or name in (".", "..")
        or Path(name).name != name
    ):
        raise CheckpointError(
            "CHECKPOINT_MANIFEST_INVALID",
            "manifest.checkpointFile",
            f"the manifest names the checkpoint '{name}' and a checkpoint is a file of the "
            "directory of the manifest, never a path outside it",
        )
    return name


def _checked_inside(directory: Path, candidate: Path) -> None:
    """Refuses a checkpoint that leaves the directory of the run.

    A checkpoint is a file of the directory of the run, and a symlink inside
    that directory can point anywhere: a reader that follows it reads a file
    the run never published, and the digest it compares is the digest of a
    file of somebody else.

    @raises CheckpointError when the checkpoint is a link or leaves the run.
    """
    if candidate.is_symlink():
        raise CheckpointError(
            "CHECKPOINT_MANIFEST_INVALID",
            "manifest.checkpointFile",
            f"the checkpoint '{candidate.name}' is a symlink, and a checkpoint is a file of "
            "the directory of the run and not a link to a file of somebody else",
        )
    root = directory.resolve()
    resolved = candidate.resolve()
    if resolved != root and root not in resolved.parents:
        raise CheckpointError(
            "CHECKPOINT_MANIFEST_INVALID",
            "manifest.checkpointFile",
            f"the checkpoint '{candidate.name}' resolves outside the directory of the run",
        )


def read_checkpoint(manifest_path: Path) -> LoadedCheckpoint:
    """Reads a checkpoint back and refuses the ones that do not verify.

    The digest is checked BEFORE the file is parsed, so a checkpoint whose
    bytes are not the bytes the manifest names is refused without being
    loaded at all.

    @raises CheckpointError when the checkpoint cannot be read.
    """
    path = Path(manifest_path)
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise CheckpointError(
            "CHECKPOINT_MANIFEST_MISSING",
            "manifest",
            f"the manifest does not exist: {error.filename}",
        ) from error
    except (OSError, json.JSONDecodeError) as error:
        raise CheckpointError(
            "CHECKPOINT_MANIFEST_INVALID",
            "manifest",
            f"the manifest cannot be read: {error}",
        ) from error
    manifest = CheckpointManifest.from_dict(record)
    if manifest.version != CHECKPOINT_VERSION:
        raise CheckpointError(
            "CHECKPOINT_MANIFEST_INVALID",
            "manifest.manifestVersion",
            f"the manifest declares the version '{manifest.version}' and this build speaks "
            f"the version '{CHECKPOINT_VERSION}'",
        )

    checkpoint_path = path.parent / _checkpoint_file_of(manifest)
    _checked_inside(path.parent, checkpoint_path)
    if not checkpoint_path.is_file():
        raise CheckpointError(
            "CHECKPOINT_FILE_MISSING",
            "manifest.checkpointFile",
            f"the manifest names the checkpoint '{manifest.checkpoint_file}' and the file "
            "does not exist",
        )
    digest = sha256_of_file(checkpoint_path)
    if digest != manifest.checkpoint_sha256:
        raise CheckpointError(
            "CHECKPOINT_DIGEST_MISMATCH",
            "manifest.checkpointSha256",
            f"the checkpoint '{manifest.checkpoint_file}' hashes to {digest} and the "
            f"manifest names {manifest.checkpoint_sha256}; a checkpoint whose bytes are not "
            "the bytes the manifest names is a checkpoint nobody can reproduce",
        )
    try:
        payload = json.loads(checkpoint_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise CheckpointError(
            "CHECKPOINT_FILE_INVALID",
            "manifest.checkpointFile",
            f"the checkpoint cannot be read: {error}",
        ) from error
    if not isinstance(payload, Mapping):
        raise CheckpointError(
            "CHECKPOINT_FILE_INVALID",
            "manifest.checkpointFile",
            "the checkpoint is not an object",
        )
    try:
        model = ProbeModel.from_dict(payload.get("model", {}))
    except ProbeError as error:
        # The refusal is a refusal of the CHECKPOINT and not of the probe:
        # a caller of the checkpoint catches one vocabulary and not the other.
        raise CheckpointError(
            "CHECKPOINT_FILE_INVALID",
            "manifest.checkpointFile",
            f"the checkpoint does not carry a model of a probe: {error.reason}",
        ) from error
    epoch = payload.get("epoch")
    fingerprint = payload.get("recipeFingerprint")
    if epoch != manifest.epoch:
        raise CheckpointError(
            "CHECKPOINT_STATE_MISMATCH",
            "manifest.epoch",
            f"the checkpoint was written at the epoch {epoch!r} and the manifest names "
            f"{manifest.epoch}; a manifest that describes another epoch is a manifest "
            "nobody can resume from",
        )
    if fingerprint != manifest.recipe_fingerprint:
        raise CheckpointError(
            "CHECKPOINT_STATE_MISMATCH",
            "manifest.recipeFingerprint",
            f"the checkpoint was written by the recipe {fingerprint!r} and the manifest "
            f"names {manifest.recipe_fingerprint}; a checkpoint of another recipe is a "
            "checkpoint of another run",
        )
    if model.class_map.to_dict() != manifest.class_map.to_dict():
        raise CheckpointError(
            "CHECKPOINT_CLASS_MAP_MISMATCH",
            "manifest.classMap",
            "the class map of the checkpoint and the class map of the manifest are not the "
            "same one; a manifest that describes other classes is a manifest nobody can "
            "read back",
        )
    if model.dimension != manifest.dimension:
        raise CheckpointError(
            "CHECKPOINT_STATE_MISMATCH",
            "manifest.dimension",
            f"the checkpoint was fitted over {model.dimension} values and the manifest names "
            f"{manifest.dimension}; a manifest that describes another model is a manifest "
            "nobody can reproduce",
        )
    if model.seed != manifest.seed:
        raise CheckpointError(
            "CHECKPOINT_STATE_MISMATCH",
            "manifest.seed",
            f"the checkpoint was fitted with the seed {model.seed} and the manifest names "
            f"{manifest.seed}; a manifest that describes another model is a manifest nobody "
            "can reproduce",
        )
    return LoadedCheckpoint(manifest=manifest, model=model)


def checkpoint_digest(path: Path) -> str:
    """The sha256 of the bytes of a checkpoint file.

    It is the digest the manifest carries, recomputed from the bytes on the
    disk, so a reader can prove that the artifact on the disk is the artifact
    the run published.

    @raises CheckpointError when the file cannot be read.
    """
    try:
        return sha256_of_file(Path(path))
    except OSError as error:
        raise CheckpointError(
            "CHECKPOINT_FILE_MISSING",
            "checkpoint",
            f"the checkpoint cannot be read: {error}",
        ) from error


def class_map_of(manifest: CheckpointManifest) -> Tuple[str, ...]:
    """The label keys the checkpoint may answer with."""
    return manifest.class_map.label_keys
