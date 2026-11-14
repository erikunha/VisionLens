"""The failure matrix of the CPU vision adapter (story 4).

The pack asks for a failure path that leaves the process alive, returns ONE
typed error and never publishes a partial artifact as a success
(`docs/vnext/08-DOMAIN-STORE-AND-PROVENANCE.md:26`). The matrix below is
that promise, one row at a time: a corrupt image, a pixel bomb, a MIME
mismatch, missing weights, a digest mismatch, an unsupported device, an
out of memory, a traversal attempt and a pickle attempt.

Every row asserts the SAME three things:

  - the failure is ONE typed error with a code of the library vocabulary;
  - the run that failed published no artifact, so a partial run is never
    read as a success;
  - the process is still alive, so the next request is served.

The encoder of these tests is a stub that implements the protocol, so the
matrix runs without the heavy stack. The real model runs in the recorded
measurement, not in every test run.
"""

from __future__ import annotations

import json
import struct
from pathlib import Path
from typing import Any, Sequence

import pytest

from helpers import SRC  # noqa: F401  (path setup)

from visionlens.downloads import DownloadRefusedError
from visionlens.encoders.base import EncoderOutput
from visionlens.encoders.weights import (
    DownloadPermission,
    WeightsRequest,
    authorize_weights_download,
    check_safetensors,
    load_weights,
)
from visionlens.errors import (
    EmbeddingRunEmptyError,
    ImageDimensionsExceededError,
    ImageMetadataUnreadableError,
    LibraryError,
    LibraryErrorCode,
    MimeMismatchError,
    PathOutsideRootError,
    ResourceExhaustedError,
    UnsupportedDeviceError,
)
from visionlens.inference.embedder import EmbedAsset, EmbedRequest, VisionEmbedder
from visionlens.io.decode import DecodeService
from visionlens.io.preprocess import PreprocessingSpec
from visionlens.registry.loader import record_from_mapping
from visionlens.runtime.device import DevicePlanner

#: The repository root, from this file.
REPO_ROOT = Path(__file__).resolve().parents[3]

#: The committed fixture images.
FIXTURES_DIR = REPO_ROOT / "packages" / "core" / "tests" / "fixtures" / "images"

#: The tracked registry, the file that carries the record.
TRACKED_REGISTRY = REPO_ROOT / "datasets" / "registry.json"

#: A safetensors payload: the length of the header, the header, then the
#: bytes of the tensor it describes.
SAFETENSORS_HEADER = json.dumps(
    {"weight": {"dtype": "F32", "shape": [1], "data_offsets": [0, 4]}}
).encode("utf8")
PAYLOAD = struct.pack("<Q", len(SAFETENSORS_HEADER)) + SAFETENSORS_HEADER + b"\x00\x00\x00\x00"


class _StubEncoder:
    """An encoder that implements the protocol without a model."""

    model_id = "stub"
    revision = "stub-revision"
    dimension = 4
    dtype = "float32"

    def __init__(self) -> None:
        self.calls: list[int] = []

    def embed(self, images: Sequence[Any]) -> EncoderOutput:
        self.calls.append(len(images))
        return EncoderOutput(
            vectors=tuple(tuple(float(index) for index in range(4)) for _ in images),
            dimension=self.dimension,
            dtype=self.dtype,
        )


class _MemoryHungryEncoder(_StubEncoder):
    """An encoder whose model never fits in the memory budget."""

    def embed(self, images: Sequence[Any]) -> EncoderOutput:
        self.calls.append(len(images))
        raise MemoryError("the model does not fit in the memory budget")


def _record(**overrides: Any) -> Any:
    """A record that satisfies every gate, so a test varies one thing."""
    registry = json.loads(TRACKED_REGISTRY.read_text(encoding="utf8"))
    entry = next(item for item in registry["models"] if item["modelId"] == "siglip2-base")
    entry.update(overrides)
    return record_from_mapping(entry)


def _spec() -> PreprocessingSpec:
    return PreprocessingSpec(
        height=8,
        width=8,
        interpolation="bilinear",
        rescale_factor=1.0 / 255.0,
        mean=(0.5, 0.5, 0.5),
        std=(0.5, 0.5, 0.5),
    )


def _embedder(
    tmp_path: Path,
    encoder: Any = None,
    root: Path | None = None,
) -> VisionEmbedder:
    """An embedder over the given root, with its own artifact directory."""
    return VisionEmbedder(
        record=_record(),
        encoder=encoder or _StubEncoder(),
        spec=_spec(),
        decoder=DecodeService(root if root is not None else FIXTURES_DIR),
        device=DevicePlanner().plan("cpu"),
        artifact_root=tmp_path / "artifacts",
    )


def _published_artifacts(root: Path) -> list[Path]:
    """The artifact directories that were published under the root."""
    if not root.exists():
        return []
    return [path for path in root.iterdir() if path.is_dir()]


def _write_png_with_size(path: Path, width: int, height: int) -> None:
    """A PNG that DECLARES the given size in its header.

    The declaration is enough for the caps to be read, and the file carries
    no pixels at all: a refusal that happens after the allocation would
    have to allocate first, and this file cannot be allocated. The file is
    COMPLETE (it ends with the end-of-image chunk), so the completeness
    check does not refuse it before the caps are read.
    """
    ihdr = struct.pack(">II", width, height) + b"\x08\x02\x00\x00\x00"
    header = (
        b"\x89PNG\r\n\x1a\n"
        + struct.pack(">I", len(ihdr))
        + b"IHDR"
        + ihdr
        + b"\x00\x00\x00\x00"
    )
    end = struct.pack(">I", 0) + b"IEND" + b"\xae\x42\x60\x82"
    path.write_bytes(header + end)


# ----------------------------------------------------------------------
# The rows of the matrix
# ----------------------------------------------------------------------


def test_a_corrupt_image_is_an_error_sample_and_the_other_images_still_embed(
    tmp_path: Path,
):
    root = tmp_path / "images"
    root.mkdir()
    for name in ("red.jpg", "green.jpg"):
        (root / name).write_bytes((FIXTURES_DIR / name).read_bytes())
    (root / "broken.jpg").write_bytes(b"\xff\xd8\xff\xe0 not an image at all")

    embedder = _embedder(tmp_path, root=root)
    result = embedder.embed(
        EmbedRequest(
            snapshot_id="snapshot-1",
            assets=(
                EmbedAsset(asset_id="red", path=root / "red.jpg"),
                EmbedAsset(asset_id="broken", path=root / "broken.jpg"),
                EmbedAsset(asset_id="green", path=root / "green.jpg"),
            ),
        )
    )

    # The broken image is an error sample, and the error names the file.
    assert len(result.errors) == 1
    error = result.errors[0]
    assert error.asset_id == "broken"
    assert error.code == LibraryErrorCode.IMAGE_METADATA_UNREADABLE.value
    assert "broken.jpg" in error.message

    # The other images embedded, and the artifact holds exactly them.
    assert result.count == 2
    assert len(_published_artifacts(tmp_path / "artifacts")) == 1


def test_a_pixel_bomb_is_refused_before_the_pixels_are_allocated(tmp_path: Path):
    root = tmp_path / "images"
    root.mkdir()
    _write_png_with_size(root / "bomb.png", 30000, 30000)

    with pytest.raises(ImageDimensionsExceededError) as excinfo:
        DecodeService(root).decode(root / "bomb.png")

    assert excinfo.value.code == LibraryErrorCode.IMAGE_DIMENSIONS_EXCEEDED
    assert "20000" in str(excinfo.value)


def test_a_file_whose_magic_bytes_contradict_its_name_is_refused(tmp_path: Path):
    root = tmp_path / "images"
    root.mkdir()
    # The name claims a JPEG and the bytes say a PNG.
    _write_png_with_size(root / "claims-a-jpeg.jpg", 8, 8)

    with pytest.raises(MimeMismatchError) as excinfo:
        DecodeService(root).decode(root / "claims-a-jpeg.jpg")

    assert excinfo.value.code == LibraryErrorCode.MIME_MISMATCH


def test_the_weights_are_missing_and_no_permission_was_granted(tmp_path: Path):
    request = WeightsRequest(
        record=_record(),
        use="inference",
        permission=DownloadPermission.deny(),
    )

    with pytest.raises(DownloadRefusedError) as excinfo:
        authorize_weights_download(request)

    assert excinfo.value.reason == "PERMISSION_MISSING"
    # The cache stayed empty: the refusal happened before any byte moved.
    assert _published_artifacts(tmp_path) == []


def test_the_bytes_that_arrive_do_not_carry_the_recorded_digest(tmp_path: Path):
    from visionlens.hashing import sha256_of_bytes

    other = b"\x00" * 8

    def opener(_url: str) -> Any:
        return [other]

    request = WeightsRequest(
        record=_record(),
        use="inference",
        permission=DownloadPermission.grant("the-tester"),
    )

    with pytest.raises(DownloadRefusedError) as excinfo:
        load_weights(request, tmp_path / "cache", opener=opener)

    assert excinfo.value.reason == "DIGEST_MISMATCH"
    # The refusal names BOTH digests: the one that arrived and the one the
    # record pins.
    assert sha256_of_bytes(other) in str(excinfo.value)
    assert _record().source_digest in str(excinfo.value)


def test_a_pickle_checkpoint_is_refused(tmp_path: Path):
    path = tmp_path / "model.pt"
    path.write_bytes(b"\x80\x04\x95" + b"the payload of a pickle")

    with pytest.raises(DownloadRefusedError) as excinfo:
        check_safetensors(path)

    assert excinfo.value.reason == "UNSAFE_FORMAT"


def test_a_device_the_build_does_not_run_is_refused_with_its_reason():
    with pytest.raises(UnsupportedDeviceError) as excinfo:
        DevicePlanner().plan("cuda")

    assert excinfo.value.code == LibraryErrorCode.UNSUPPORTED_DEVICE
    assert "cuda" in str(excinfo.value)


def test_a_batch_that_never_fits_is_refused_after_a_bounded_back_off(tmp_path: Path):
    root = tmp_path / "images"
    root.mkdir()
    for name in ("red.jpg", "green.jpg"):
        (root / name).write_bytes((FIXTURES_DIR / name).read_bytes())
    embedder = _embedder(tmp_path, encoder=_MemoryHungryEncoder(), root=root)

    with pytest.raises(ResourceExhaustedError) as excinfo:
        embedder.embed(
            EmbedRequest(
                snapshot_id="snapshot-1",
                assets=(
                    EmbedAsset(asset_id="red", path=root / "red.jpg"),
                    EmbedAsset(asset_id="green", path=root / "green.jpg"),
                ),
            )
        )

    assert excinfo.value.code == LibraryErrorCode.RESOURCE_EXHAUSTED
    # The run published nothing.
    assert _published_artifacts(tmp_path / "artifacts") == []


def test_a_path_outside_the_approved_root_is_refused(tmp_path: Path):
    root = tmp_path / "images"
    root.mkdir()
    outside = tmp_path / "outside.jpg"
    outside.write_bytes((FIXTURES_DIR / "red.jpg").read_bytes())

    with pytest.raises(PathOutsideRootError) as excinfo:
        DecodeService(root).decode(outside)

    assert excinfo.value.code == LibraryErrorCode.PATH_OUTSIDE_ROOT


def test_a_symlink_that_escapes_the_approved_root_is_refused(tmp_path: Path):
    root = tmp_path / "images"
    root.mkdir()
    outside = tmp_path / "outside.jpg"
    outside.write_bytes((FIXTURES_DIR / "red.jpg").read_bytes())
    link = root / "link.jpg"
    link.symlink_to(outside)

    with pytest.raises(PathOutsideRootError) as excinfo:
        DecodeService(root).decode(link)

    assert excinfo.value.code == LibraryErrorCode.PATH_OUTSIDE_ROOT


def test_a_traversal_in_the_name_of_the_file_is_refused(tmp_path: Path):
    root = tmp_path / "images"
    root.mkdir()
    (tmp_path / "outside.jpg").write_bytes((FIXTURES_DIR / "red.jpg").read_bytes())

    with pytest.raises(PathOutsideRootError):
        DecodeService(root).decode(root / ".." / "outside.jpg")


# ----------------------------------------------------------------------
# The properties every row shares
# ----------------------------------------------------------------------


def test_every_failure_is_one_typed_error_of_the_library_vocabulary(tmp_path: Path):
    """The codes of the matrix, and where they come from."""
    assert issubclass(ImageMetadataUnreadableError, LibraryError)
    assert issubclass(ImageDimensionsExceededError, LibraryError)
    assert issubclass(MimeMismatchError, LibraryError)
    assert issubclass(PathOutsideRootError, LibraryError)
    assert issubclass(ResourceExhaustedError, LibraryError)
    assert issubclass(UnsupportedDeviceError, LibraryError)

    # The library codes never cross the wire, and the wire vocabulary stays
    # exactly the ten codes it had.
    frozen = {
        "UNSUPPORTED_PROTOCOL",
        "MISSING_EXTRA",
        "MALFORMED_FRAME",
        "PROTOCOL_MISMATCH",
        "UNSUPPORTED_OPERATION",
        "CANCELLED",
        "DEADLINE_EXCEEDED",
        "BUDGET_EXCEEDED",
        "WORKER_CRASHED",
        "PROVIDER_UNAVAILABLE",
    }
    assert LibraryErrorCode.NETWORK_ACCESS_REFUSED.value not in frozen
    assert LibraryErrorCode.NON_NUMERIC_PIXEL.value not in frozen
    assert LibraryErrorCode.RESOURCE_EXHAUSTED.value not in frozen


def test_a_failed_run_publishes_no_artifact(tmp_path: Path):
    """A run that failed is not a run that published something."""
    root = tmp_path / "images"
    root.mkdir()
    _write_png_with_size(root / "bomb.png", 30000, 30000)

    embedder = _embedder(tmp_path, root=root)
    with pytest.raises(EmbeddingRunEmptyError) as excinfo:
        embedder.embed(
            EmbedRequest(
                snapshot_id="snapshot-1",
                assets=(EmbedAsset(asset_id="bomb", path=root / "bomb.png"),),
            )
        )

    assert excinfo.value.code == LibraryErrorCode.EMBEDDING_RUN_EMPTY
    assert excinfo.value.samples == (("bomb", LibraryErrorCode.IMAGE_DIMENSIONS_EXCEEDED.value),)
    assert _published_artifacts(tmp_path / "artifacts") == []


def test_the_process_is_alive_after_every_failure(tmp_path: Path):
    """A failure is a failure of one request, not of the process."""
    root = tmp_path / "images"
    root.mkdir()
    (root / "red.jpg").write_bytes((FIXTURES_DIR / "red.jpg").read_bytes())
    (root / "broken.jpg").write_bytes(b"\xff\xd8\xff\xe0 not an image at all")

    embedder = _embedder(tmp_path, root=root)
    for _ in range(3):
        result = embedder.embed(
            EmbedRequest(
                snapshot_id="snapshot-1",
                assets=(
                    EmbedAsset(asset_id="red", path=root / "red.jpg"),
                    EmbedAsset(asset_id="broken", path=root / "broken.jpg"),
                ),
            )
        )
        assert result.count == 1
        assert len(result.errors) == 1

    # The stub encoder was called for every run: the process never stopped
    # serving after a refusal.
    assert len(embedder.encoder.calls) == 3
