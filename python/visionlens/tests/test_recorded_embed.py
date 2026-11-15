"""The recorded shape of `vision.embed`: the routing, the result, the refusals.

The worker serves TWO shapes of `vision.embed` and the params of the
request name which one it asks for. The SIMULATED shape is pinned byte for
byte by the golden transcript of the package; this file pins the RECORDED
one: the run id, the count, the dimension, the dtype, the digest of the
artifact and the error samples.

The encoder of these tests is a stub that implements the protocol, so the
suite proves the shape and the refusals without the heavy stack. The real
model runs in the recorded measurement, not in every test run.
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import sys
import threading
import time
import types
from pathlib import Path
from typing import Any, Sequence

import pytest

from helpers import SRC  # noqa: F401  (path setup)
from helpers import encode, host_hello, request, run_session, terminal

from visionlens.encoders.base import EncoderOutput
from visionlens.errors import ErrorCode, WorkerError
from visionlens.inference.artifact import read_embedding_artifact
from visionlens.inference.batching import BatchScheduler
from visionlens.inference.embedder import EmbedAsset, EmbedRequest
from visionlens.inference.service import (
    ARTIFACT_ROOT_ENV,
    ASSET_ROOT_ENV,
    MODEL_ROOT_ENV,
    REGISTRY_ENV,
    RUNTIME_ENV_VARS,
    EmbedRuntime,
    EmbedRuntimeConfig,
    VisionEmbedService,
    config_from_environment,
    recorded_result,
    runtime_from_environment,
)
from visionlens.registry.loader import record_from_mapping
from visionlens.runtime.device import DevicePlanner

#: The repository root, from this file.
REPO_ROOT = Path(__file__).resolve().parents[3]

#: The committed fixture images.
FIXTURES_DIR = REPO_ROOT / "packages" / "core" / "tests" / "fixtures" / "images"

#: The tracked registry, the file that carries the record.
TRACKED_REGISTRY = REPO_ROOT / "datasets" / "registry.json"

#: The preprocessing configuration of the pinned model, field by field. The
#: values are the ones of the record, so the specification built from them
#: carries the fingerprint the record pins.
PREPROCESSOR_CONFIG = {
    "do_convert_rgb": None,
    "do_normalize": True,
    "do_rescale": True,
    "do_resize": True,
    "image_mean": [0.5, 0.5, 0.5],
    "image_std": [0.5, 0.5, 0.5],
    "processor_class": "SiglipProcessor",
    "image_processor_type": "SiglipImageProcessor",
    "resample": 2,
    "rescale_factor": 0.00392156862745098,
    "size": {"height": 224, "width": 224},
}

#: A preprocessing configuration that is NOT the one of the record: the
#: resample of another code gives the specification another fingerprint.
TAMPERED_PREPROCESSOR_CONFIG = dict(PREPROCESSOR_CONFIG, resample=3)


class _StubEncoder:
    """An encoder that implements the protocol without a model."""

    model_id = "siglip2-base"
    revision = "stub-revision"
    dimension = 4
    dtype = "float32"

    def __init__(self, delay_seconds: float = 0.0) -> None:
        self.delay_seconds = delay_seconds
        self.calls: list[int] = []

    def embed(self, images: Sequence[Any]) -> EncoderOutput:
        self.calls.append(len(images))
        if self.delay_seconds:
            time.sleep(self.delay_seconds)
        return EncoderOutput(
            vectors=tuple(tuple(float(index) for index in range(4)) for _ in images),
            dimension=self.dimension,
            dtype=self.dtype,
        )


def _record():
    registry = json.loads(TRACKED_REGISTRY.read_text(encoding="utf8"))
    entry = next(item for item in registry["models"] if item["modelId"] == "siglip2-base")
    return record_from_mapping(entry)


def _asset_root(tmp_path: Path, names: Sequence[str]) -> Path:
    """An approved root that carries copies of the committed fixtures."""
    root = tmp_path / "assets"
    root.mkdir(parents=True, exist_ok=True)
    for name in names:
        shutil.copyfile(FIXTURES_DIR / name, root / name)
    return root


def _runtime(
    tmp_path: Path,
    *,
    asset_root: Path,
    encoder: Any = None,
    scheduler: Any = None,
    preprocessing: Any = None,
) -> EmbedRuntime:
    """A runtime that serves the recorded shape, with a stub encoder."""
    record = _record()
    model_root = tmp_path / "models"
    model_dir = model_root / record.model_id / record.revision
    model_dir.mkdir(parents=True, exist_ok=True)
    (model_dir / "preprocessor_config.json").write_text(
        json.dumps(PREPROCESSOR_CONFIG if preprocessing is None else preprocessing),
        encoding="utf8",
    )
    stub = encoder if encoder is not None else _StubEncoder()
    config = EmbedRuntimeConfig(
        registry_path=TRACKED_REGISTRY,
        model_root=model_root,
        asset_root=asset_root,
        artifact_root=tmp_path / "artifacts",
    )
    service = VisionEmbedService(
        config,
        encoder_factories={
            "siglip_vision_model": lambda record, model_dir, plan: stub,
        },
        planner=DevicePlanner(available={"cpu": True}),
        scheduler=scheduler,
    )
    return EmbedRuntime(service=service)


def _params(names: Sequence[str], **extra: Any) -> dict[str, Any]:
    """The params of a recorded run."""
    params: dict[str, Any] = {
        "model": "siglip2-base",
        "snapshotId": "snapshot-recorded",
        "assets": [{"assetId": name, "path": name} for name in names],
    }
    params.update(extra)
    return params


def _run(
    runtime: EmbedRuntime,
    params: dict[str, Any],
    *,
    request_id: str = "r-recorded",
    max_seconds: int = 60,
) -> list[dict[str, Any]]:
    """Drive one request through an in-memory worker."""
    frames, _, _ = run_session(
        [
            encode(host_hello()),
            encode(request(request_id, "vision.embed", params, max_seconds=max_seconds)),
        ],
        embed_runtime=runtime,
    )
    return frames


# ----------------------------------------------------------------------
# The routing between the two shapes
# ----------------------------------------------------------------------


def test_a_request_with_assets_is_answered_with_the_recorded_shape(tmp_path: Path) -> None:
    root = _asset_root(tmp_path, ["red.jpg", "blue.jpg"])
    frames = _run(_runtime(tmp_path, asset_root=root), _params(["red.jpg", "blue.jpg"]))

    terminal_frame = terminal(frames, "r-recorded")
    assert terminal_frame["kind"] == "result"
    assert terminal_frame["result"]["embeddingRunId"].startswith("embed-")


def test_a_request_with_images_is_answered_with_the_simulated_shape(tmp_path: Path) -> None:
    frames = _run(
        EmbedRuntime(),
        {"model": "siglip2-base", "images": ["golden-alpha"], "device": "cpu"},
        request_id="r-simulated",
    )

    terminal_frame = terminal(frames, "r-simulated")
    assert terminal_frame["kind"] == "result"
    payload = terminal_frame["result"]
    assert payload["model"] == "siglip2-base"
    assert payload["count"] == 1
    assert payload["dimension"] == 768
    assert len(payload["vectors"]) == 1
    assert len(payload["vectors"][0]) == 768
    # The simulated shape carries the vectors in the line, and the recorded
    # one does not: the two shapes are told apart by the markers they carry.
    assert "embeddingRunId" not in payload


def test_a_request_that_names_both_shapes_is_refused(tmp_path: Path) -> None:
    root = _asset_root(tmp_path, ["red.jpg"])
    params = _params(["red.jpg"])
    params["images"] = ["red.jpg"]

    frames = _run(_runtime(tmp_path, asset_root=root), params)

    terminal_frame = terminal(frames, "r-recorded")
    assert terminal_frame["kind"] == "error"
    assert terminal_frame["code"] == ErrorCode.MALFORMED_FRAME.value
    assert "images" in terminal_frame["message"] and "assets" in terminal_frame["message"]


def test_a_request_that_names_no_shape_is_refused(tmp_path: Path) -> None:
    frames = _run(_runtime(tmp_path, asset_root=_asset_root(tmp_path, ["red.jpg"])), {"model": "siglip2-base"})

    terminal_frame = terminal(frames, "r-recorded")
    assert terminal_frame["kind"] == "error"
    assert terminal_frame["code"] == ErrorCode.MALFORMED_FRAME.value


def test_a_recorded_request_to_a_worker_without_the_runtime_is_refused(tmp_path: Path) -> None:
    root = _asset_root(tmp_path, ["red.jpg"])
    runtime = EmbedRuntime(missing=(REGISTRY_ENV, MODEL_ROOT_ENV))

    frames = _run(runtime, _params(["red.jpg"]))

    terminal_frame = terminal(frames, "r-recorded")
    assert terminal_frame["kind"] == "error"
    assert terminal_frame["code"] == ErrorCode.MALFORMED_FRAME.value
    assert REGISTRY_ENV in terminal_frame["message"]
    assert MODEL_ROOT_ENV in terminal_frame["message"]


# ----------------------------------------------------------------------
# The recorded result
# ----------------------------------------------------------------------


def test_the_recorded_result_carries_the_run_the_count_and_the_digest(tmp_path: Path) -> None:
    root = _asset_root(tmp_path, ["red.jpg", "blue.jpg"])
    frames = _run(_runtime(tmp_path, asset_root=root), _params(["red.jpg", "blue.jpg"]))

    payload = terminal(frames, "r-recorded")["result"]
    assert payload["count"] == 2
    assert payload["dimensions"] == 4
    assert payload["dtype"] == "float32"
    assert re.fullmatch(r"[0-9a-f]{64}", payload["artifactSha256"])
    assert payload["errorSamples"] == []


def test_the_recorded_result_carries_no_vector(tmp_path: Path) -> None:
    root = _asset_root(tmp_path, ["red.jpg"])
    frames = _run(_runtime(tmp_path, asset_root=root), _params(["red.jpg"]))

    payload = terminal(frames, "r-recorded")["result"]
    assert "vectors" not in payload
    assert "preprocessingFingerprint" not in payload


def test_the_artifact_on_disk_carries_the_digest_the_result_names(tmp_path: Path) -> None:
    root = _asset_root(tmp_path, ["red.jpg", "blue.jpg"])
    frames = _run(_runtime(tmp_path, asset_root=root), _params(["red.jpg", "blue.jpg"]))

    payload = terminal(frames, "r-recorded")["result"]
    directory = (
        tmp_path / "artifacts" / "artifacts" / "embedding" / payload["embeddingRunId"]
    )
    artifact = read_embedding_artifact(directory)
    assert artifact.artifact_digest == payload["artifactSha256"]
    assert artifact.manifest.count == 2
    assert artifact.manifest.snapshot_id == "snapshot-recorded"


def test_the_run_reports_its_progress(tmp_path: Path) -> None:
    root = _asset_root(tmp_path, ["red.jpg", "blue.jpg"])
    frames = _run(_runtime(tmp_path, asset_root=root), _params(["red.jpg", "blue.jpg"]))

    progress = [
        frame
        for frame in frames
        if frame.get("kind") == "progress" and frame.get("requestId") == "r-recorded"
    ]
    assert progress, "a recorded run reports its progress"
    assert progress[0]["completed"] == 0
    assert progress[0]["total"] == 2
    assert progress[-1]["completed"] == 2


# ----------------------------------------------------------------------
# The error samples
# ----------------------------------------------------------------------


def test_an_asset_that_is_not_an_image_is_an_error_sample_and_the_others_embed(
    tmp_path: Path,
) -> None:
    root = _asset_root(tmp_path, ["red.jpg"])
    (root / "broken.jpg").write_bytes(b"this is not an image at all")
    frames = _run(
        _runtime(tmp_path, asset_root=root), _params(["red.jpg", "broken.jpg"])
    )

    payload = terminal(frames, "r-recorded")["result"]
    assert payload["count"] == 1
    assert len(payload["errorSamples"]) == 1
    sample = payload["errorSamples"][0]
    assert sample["assetId"] == "broken.jpg"
    assert sample["code"] == "UNSUPPORTED_FILE_TYPE"
    assert sample["message"]


def test_an_error_sample_carries_no_path(tmp_path: Path) -> None:
    root = _asset_root(tmp_path, ["red.jpg"])
    (root / "broken.jpg").write_bytes(b"this is not an image at all")
    frames = _run(
        _runtime(tmp_path, asset_root=root), _params(["red.jpg", "broken.jpg"])
    )

    sample = terminal(frames, "r-recorded")["result"]["errorSamples"][0]
    assert str(root) not in sample["message"]
    assert "broken.jpg" not in sample["message"]


def test_a_run_in_which_every_asset_was_refused_fails_with_one_typed_error(
    tmp_path: Path,
) -> None:
    root = _asset_root(tmp_path, [])
    (root / "broken.jpg").write_bytes(b"this is not an image at all")
    frames = _run(_runtime(tmp_path, asset_root=root), _params(["broken.jpg"]))

    terminal_frame = terminal(frames, "r-recorded")
    assert terminal_frame["kind"] == "error"
    assert terminal_frame["code"] == ErrorCode.MALFORMED_FRAME.value
    # A run that embedded nothing writes no artifact at all.
    assert not (tmp_path / "artifacts" / "artifacts").exists()


def test_an_asset_outside_the_approved_root_is_an_error_sample(tmp_path: Path) -> None:
    root = _asset_root(tmp_path, ["red.jpg"])
    frames = _run(
        _runtime(tmp_path, asset_root=root),
        _params(["red.jpg", "../escaped.jpg"]),
    )

    payload = terminal(frames, "r-recorded")["result"]
    assert payload["count"] == 1
    assert payload["errorSamples"][0]["code"] == "PATH_OUTSIDE_ROOT"


# ----------------------------------------------------------------------
# The refusals of the params
# ----------------------------------------------------------------------


def test_an_asset_without_an_id_is_refused(tmp_path: Path) -> None:
    root = _asset_root(tmp_path, ["red.jpg"])
    params = {"model": "siglip2-base", "snapshotId": "s", "assets": [{"path": "red.jpg"}]}

    frames = _run(_runtime(tmp_path, asset_root=root), params)

    terminal_frame = terminal(frames, "r-recorded")
    assert terminal_frame["code"] == ErrorCode.MALFORMED_FRAME.value
    assert "assetId" in terminal_frame["message"]


def test_an_asset_with_an_unknown_field_is_refused(tmp_path: Path) -> None:
    root = _asset_root(tmp_path, ["red.jpg"])
    params = {
        "model": "siglip2-base",
        "snapshotId": "s",
        "assets": [{"assetId": "red.jpg", "path": "red.jpg", "bytes": "..."}],
    }

    frames = _run(_runtime(tmp_path, asset_root=root), params)

    terminal_frame = terminal(frames, "r-recorded")
    assert terminal_frame["code"] == ErrorCode.MALFORMED_FRAME.value
    assert "bytes" in terminal_frame["message"]


def test_a_run_without_a_snapshot_is_refused(tmp_path: Path) -> None:
    root = _asset_root(tmp_path, ["red.jpg"])
    params = {"model": "siglip2-base", "assets": [{"assetId": "red.jpg", "path": "red.jpg"}]}

    frames = _run(_runtime(tmp_path, asset_root=root), params)

    terminal_frame = terminal(frames, "r-recorded")
    assert terminal_frame["code"] == ErrorCode.MALFORMED_FRAME.value
    assert "snapshotId" in terminal_frame["message"]


def test_a_model_the_registry_does_not_carry_is_refused(tmp_path: Path) -> None:
    root = _asset_root(tmp_path, ["red.jpg"])
    params = _params(["red.jpg"])
    params["model"] = "no-such-model"

    frames = _run(_runtime(tmp_path, asset_root=root), params)

    terminal_frame = terminal(frames, "r-recorded")
    assert terminal_frame["kind"] == "error"
    assert terminal_frame["code"] == ErrorCode.MALFORMED_FRAME.value


def test_a_preprocessing_that_the_record_does_not_pin_is_refused(tmp_path: Path) -> None:
    # The record names the fingerprint of the preprocessing it was measured
    # with, and the directory of the model carries a configuration. A
    # configuration that gives another fingerprint is refused: the model is
    # the weights AND the configuration, and one of the two is not it.
    root = _asset_root(tmp_path, ["red.jpg"])
    frames = _run(
        _runtime(
            tmp_path,
            asset_root=root,
            preprocessing=TAMPERED_PREPROCESSOR_CONFIG,
        ),
        _params(["red.jpg"]),
    )

    terminal_frame = terminal(frames, "r-recorded")
    assert terminal_frame["kind"] == "error"
    assert terminal_frame["code"] == ErrorCode.WORKER_CRASHED.value
    assert "preprocessing" in terminal_frame["message"]
    assert not (tmp_path / "artifacts" / "artifacts").exists()


# ----------------------------------------------------------------------
# The deadline and the cancellation
# ----------------------------------------------------------------------


def test_the_deadline_of_the_request_stops_a_recorded_run(tmp_path: Path) -> None:
    root = _asset_root(tmp_path, ["red.jpg", "blue.jpg"])
    encoder = _StubEncoder(delay_seconds=1.1)
    frames = _run(
        _runtime(
            tmp_path,
            asset_root=root,
            encoder=encoder,
            scheduler=BatchScheduler(max_batch_size=1),
        ),
        _params(["red.jpg", "blue.jpg"]),
        max_seconds=1,
    )

    terminal_frame = terminal(frames, "r-recorded")
    assert terminal_frame["kind"] == "error"
    assert terminal_frame["code"] == ErrorCode.DEADLINE_EXCEEDED.value


def test_a_checkpoint_keeps_its_own_code_when_it_travels_out_of_the_run(
    tmp_path: Path,
) -> None:
    root = _asset_root(tmp_path, ["red.jpg"])
    service = _runtime(tmp_path, asset_root=root).service
    assert service is not None

    def checkpoint() -> None:
        raise WorkerError(ErrorCode.CANCELLED, "request cancelled by the host")

    from visionlens.inference.embedder import EmbedAsset, EmbedRequest

    try:
        service.embed(
            "siglip2-base",
            EmbedRequest(
                snapshot_id="s",
                assets=(EmbedAsset(asset_id="red.jpg", path=Path("red.jpg")),),
            ),
            checkpoint=checkpoint,
        )
    except WorkerError as failure:
        assert failure.code == ErrorCode.CANCELLED
    else:
        raise AssertionError("the checkpoint did not stop the run")


# ----------------------------------------------------------------------
# The concurrency of the load of the model
# ----------------------------------------------------------------------


class _FakeModel:
    """A model that answers with vectors and counts its builds."""

    builds = 0

    def eval(self) -> "_FakeModel":
        return self

    def to(self, device: str) -> "_FakeModel":
        return self

    def get_image_features(self, pixel_values: Any) -> list[list[float]]:
        return [[0.5] * 768 for _ in pixel_values]


def test_two_runs_at_the_same_time_build_the_model_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The model weighs more than a gigabyte, and two of them do not fit
    # in the memory of the machine. The worker serves a request in a
    # thread of its own, so two requests that arrive at the same time
    # must not build two models.
    from visionlens.encoders.siglip2 import Siglip2Encoder

    weights = b"not the real weights, and not heavy at all"
    record = _record()
    model_dir = tmp_path / "models" / record.model_id / record.revision
    model_dir.mkdir(parents=True)
    (model_dir / "model.safetensors").write_bytes(weights)
    (model_dir / "preprocessor_config.json").write_text(
        json.dumps(PREPROCESSOR_CONFIG), encoding="utf8"
    )

    payload = json.loads(TRACKED_REGISTRY.read_text(encoding="utf8"))
    for entry in payload["models"]:
        if entry["modelId"] == "siglip2-base":
            entry["sourceDigest"] = hashlib.sha256(weights).hexdigest()
    registry_path = tmp_path / "registry.json"
    registry_path.write_text(json.dumps(payload), encoding="utf8")
    pinned = record_from_mapping(
        next(item for item in payload["models"] if item["modelId"] == "siglip2-base")
    )

    class _FakeBatch:
        """The batch of the fake torch: it carries the values and nothing else."""

        def __init__(self, values: Any) -> None:
            self.values = values

        def reshape(self, *shape: Any) -> "_FakeBatch":
            return self

        def to(self, device: str) -> "_FakeBatch":
            return self

        def __iter__(self) -> Any:
            return iter(self.values)

        def __len__(self) -> int:
            return len(self.values)

    class _FakeTorch:
        float32 = "float32"

        @staticmethod
        def tensor(values: Any, **kwargs: Any) -> Any:
            return _FakeBatch(values)

        @staticmethod
        def inference_mode() -> Any:
            import contextlib

            return contextlib.nullcontext()

    class _FakeAutoModel:
        @staticmethod
        def from_pretrained(directory: str, **kwargs: Any) -> _FakeModel:
            _FakeModel.builds += 1
            return _FakeModel()

    monkeypatch.setitem(sys.modules, "torch", _FakeTorch)
    monkeypatch.setitem(
        sys.modules, "transformers", types.SimpleNamespace(AutoModel=_FakeAutoModel)
    )

    config = EmbedRuntimeConfig(
        registry_path=registry_path,
        model_root=tmp_path / "models",
        asset_root=_asset_root(tmp_path, ["red.jpg"]),
        artifact_root=tmp_path / "artifacts",
    )
    service = VisionEmbedService(
        config,
        planner=DevicePlanner(available={"cpu": True}),
    )
    adapter = Siglip2Encoder(
        pinned, model_dir, DevicePlanner(available={"cpu": True}).plan("cpu")
    )
    service._encoders[(pinned.model_id, pinned.revision, "cpu")] = adapter

    barrier = threading.Barrier(2)
    failures: list[Exception] = []

    def run_one() -> None:
        try:
            barrier.wait(timeout=10)
            service.embed(
                "siglip2-base",
                EmbedRequest(
                    snapshot_id="s",
                    assets=(EmbedAsset(asset_id="red.jpg", path=Path("red.jpg")),),
                ),
            )
        except Exception as exc:  # pragma: no cover - the failure is asserted
            failures.append(exc)

    threads = [threading.Thread(target=run_one) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=60)

    assert failures == []
    assert _FakeModel.builds == 1


# ----------------------------------------------------------------------
# The environment of the runtime
# ----------------------------------------------------------------------


def test_an_environment_without_the_four_variables_names_what_is_missing() -> None:
    config, missing = config_from_environment({REGISTRY_ENV: "/tmp/registry.json"})

    assert config is None
    assert missing == (MODEL_ROOT_ENV, ASSET_ROOT_ENV, ARTIFACT_ROOT_ENV)


def test_an_environment_with_the_four_variables_configures_the_runtime() -> None:
    env = {
        REGISTRY_ENV: str(TRACKED_REGISTRY),
        MODEL_ROOT_ENV: "/tmp/models",
        ASSET_ROOT_ENV: "/tmp/assets",
        ARTIFACT_ROOT_ENV: "/tmp/artifacts",
    }

    config, missing = config_from_environment(env)

    assert missing == ()
    assert config is not None
    assert config.registry_path == TRACKED_REGISTRY
    assert config.asset_root == Path("/tmp/assets")
    assert config.artifact_root == Path("/tmp/artifacts")


def test_the_runtime_of_an_empty_environment_is_not_available() -> None:
    runtime = runtime_from_environment({})

    assert not runtime.available
    assert runtime.service is None
    for name in RUNTIME_ENV_VARS:
        assert name in runtime.refusal()


def test_the_recorded_result_of_a_run_carries_the_samples_without_their_paths() -> None:
    from visionlens.inference.embedder import EmbedError, EmbedResult

    result = EmbedResult(
        run_id="embed-1",
        model_id="siglip2-base",
        revision="rev",
        dimension=4,
        dtype="float32",
        count=1,
        artifact_sha256="a" * 64,
        artifact_path=Path("/srv/visionlens/artifacts/embed-1"),
        device="cpu",
        errors=(
            EmbedError(
                asset_id="broken.jpg",
                path="/srv/visionlens/assets/broken.jpg",
                code="PATH_NOT_FOUND",
                message="the path '/srv/visionlens/assets/broken.jpg' does not name a readable file",
            ),
        ),
    )

    payload = recorded_result(result)

    assert payload["errorSamples"] == [
        {
            "assetId": "broken.jpg",
            "code": "PATH_NOT_FOUND",
            "message": "the asset does not name a readable file",
        }
    ]
    assert "/srv/visionlens" not in json.dumps(payload)
