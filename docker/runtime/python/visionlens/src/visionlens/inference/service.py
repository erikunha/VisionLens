"""The service that serves the RECORDED shape of `vision.embed`.

The worker of the frozen protocol serves the SIMULATED shape of
`vision.embed`: deterministic vectors derived from the model record, in
the line, with no model and no weights. The CPU adapter of the ticket
(VLN-005) is a LIBRARY: it decodes the images, embeds them and writes a
content-addressed artifact, and nothing in the worker reaches it.

This module is the seam. It assembles the adapter from the environment of
the worker, runs it, and returns the RECORDED shape: the run id, the
count, the dimension, the dtype, the digest of the artifact and the error
samples. The vectors never travel in the line: they are in the artifact,
in a binary file, beside the manifest that describes them
(`docs/vnext/specs/VLN-005-python-cpu-vision-adapter.md:14`).

The runtime is OPT IN. A worker that was not configured with it serves
the simulated shape only, and it SAYS so, because a worker that quietly
answers with a simulation when a real run was asked for is a worker that
answers with something nobody asked for.

The environment names four things, and all four are needed:

- `VISIONLENS_WORKER_REGISTRY`: the capability registry, the file that
  carries the pinned records (`datasets/registry.json`);
- `VISIONLENS_WORKER_MODEL_ROOT`: the cache of the weights, the directory
  the loader writes (`~/.cache/visionlens/models`);
- `VISIONLENS_WORKER_ASSET_ROOT`: the approved root every asset path
  resolves inside;
- `VISIONLENS_WORKER_ARTIFACT_ROOT`: the root the artifacts are written
  under.

A variable that is absent is a refusal, and the refusal NAMES it: an
operator who meant to configure the runtime learns which variable is
missing instead of guessing.

Nothing of the runtime reaches the network. The weights are read from the
cache of the local machine, the record pins their digest and the adapter
verifies it before it builds the model
(`python/visionlens/src/visionlens/encoders/siglip2.py:1`).
"""

from __future__ import annotations

import json
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Dict, Mapping, Optional, Tuple

from ..encoders.base import Encoder
from ..encoders.siglip2 import Siglip2Encoder
from ..encoders.weights import model_directory
from ..errors import LibraryErrorCode, ModelRunFailedError
from ..io.decode import DecodeService
from ..io.preprocess import PreprocessingSpec, spec_of_record
from ..registry.loader import ModelCapabilityRegistry, ModelRegistryError, load_model_registry
from ..registry.record import ModelRecord, ModelRecordError
from ..runtime.device import DevicePlan, DevicePlanner
from .batching import BatchScheduler
from .embedder import EmbedAsset, EmbedRequest, EmbedResult, VisionEmbedder

#: The environment variable that names the capability registry file.
REGISTRY_ENV = "VISIONLENS_WORKER_REGISTRY"

#: The environment variable that names the cache of the weights.
MODEL_ROOT_ENV = "VISIONLENS_WORKER_MODEL_ROOT"

#: The environment variable that names the approved root of the assets.
ASSET_ROOT_ENV = "VISIONLENS_WORKER_ASSET_ROOT"

#: The environment variable that names the root of the artifacts.
ARTIFACT_ROOT_ENV = "VISIONLENS_WORKER_ARTIFACT_ROOT"

#: The variables the runtime needs, in the order the refusal names them.
RUNTIME_ENV_VARS: Tuple[str, ...] = (
    REGISTRY_ENV,
    MODEL_ROOT_ENV,
    ASSET_ROOT_ENV,
    ARTIFACT_ROOT_ENV,
)

#: The message of an error sample, per library code.
#:
#: A message that crosses the wire names the CONDITION and never the path:
#: the logs and the traces of this platform record hashes and ids instead
#: of the local paths of the user
#: (`docs/vnext/19-SECURITY-PRIVACY-SUPPLY-CHAIN.md:16`). The code of the
#: sample says exactly what happened, so the message adds the reason in
#: words and not the place on the disk.
SAMPLE_MESSAGES: Mapping[str, str] = {
    LibraryErrorCode.PATH_NOT_FOUND.value: "the asset does not name a readable file",
    LibraryErrorCode.PATH_OUTSIDE_ROOT.value: "the asset resolves outside the approved root",
    LibraryErrorCode.MIME_MISMATCH.value: "the bytes of the asset contradict its name",
    LibraryErrorCode.UNSUPPORTED_FILE_TYPE.value: "the asset is not one of the accepted image types",
    LibraryErrorCode.IMAGE_METADATA_UNREADABLE.value: "the metadata of the asset could not be read",
    LibraryErrorCode.IMAGE_DIMENSIONS_EXCEEDED.value: "the declared size of the asset is over the caps",
    LibraryErrorCode.NON_NUMERIC_PIXEL.value: "the pixels of the asset are not numbers",
}

#: The message of an error sample of a code this module does not name.
UNKNOWN_SAMPLE_MESSAGE = "the asset could not be embedded"


class EmbedRuntimeError(ModelRunFailedError):
    """A failure of the runtime of the recorded shape, with its reason.

    The REASON is the stable name of the condition, and it carries no
    path. The message of the library error names the path of the machine,
    so the refusal that crosses the wire names the condition instead: the
    logs and the traces of this platform record hashes and ids and never
    the local paths of the user
    (`docs/vnext/19-SECURITY-PRIVACY-SUPPLY-CHAIN.md:16`).
    """

    def __init__(self, reason: str, message: str) -> None:
        super().__init__(message)
        self.reason = reason


def sample_message(code: str) -> str:
    """The message of an error sample, without the path of the asset.

    @param code: the library code of the refusal.
    """
    return SAMPLE_MESSAGES.get(code, UNKNOWN_SAMPLE_MESSAGE)


@dataclass(frozen=True)
class EmbedRuntimeConfig:
    """Where the real runtime finds what it needs."""

    #: The capability registry, the file that carries the pinned records.
    registry_path: Path

    #: The cache of the weights, the directory the loader writes.
    model_root: Path

    #: The approved root every asset path resolves inside.
    asset_root: Path

    #: The root the artifacts are written under.
    artifact_root: Path

    #: The device a run uses when the request names none.
    device: str = "auto"


def config_from_environment(
    env: Mapping[str, str]
) -> Tuple[Optional[EmbedRuntimeConfig], Tuple[str, ...]]:
    """The runtime configuration the environment names, and what is missing.

    A variable that is absent or empty is a variable that is MISSING, and
    the refusal names it, so an operator learns which one to set.

    @param env: the environment of the worker.
    @returns the configuration and the names of the missing variables, or
        no configuration and the names of the missing variables.
    """
    registry = env.get(REGISTRY_ENV, "").strip()
    model_root = env.get(MODEL_ROOT_ENV, "").strip()
    asset_root = env.get(ASSET_ROOT_ENV, "").strip()
    artifact_root = env.get(ARTIFACT_ROOT_ENV, "").strip()
    missing = tuple(
        name
        for name, value in (
            (REGISTRY_ENV, registry),
            (MODEL_ROOT_ENV, model_root),
            (ASSET_ROOT_ENV, asset_root),
            (ARTIFACT_ROOT_ENV, artifact_root),
        )
        if not value
    )
    if missing:
        return None, missing
    return (
        EmbedRuntimeConfig(
            registry_path=Path(registry),
            model_root=Path(model_root),
            asset_root=Path(asset_root),
            artifact_root=Path(artifact_root),
        ),
        (),
    )


#: The factory of the adapter of one model: the record, the directory of
#: the weights and the device of the run.
EncoderFactory = Callable[[ModelRecord, Path, DevicePlan], Encoder]


def _siglip2_encoder(record: ModelRecord, model_dir: Path, plan: DevicePlan) -> Encoder:
    """The adapter of the SigLIP2 family of models."""
    return Siglip2Encoder(record, model_dir, plan)


#: The adapter of each feature extractor of the registry.
#:
#: The record names the extractor it runs on, and the extractor names the
#: adapter, so a model that this build does not serve is refused instead
#: of being run by the adapter of another model.
ENCODER_FACTORIES: Mapping[str, EncoderFactory] = {
    "siglip_vision_model": _siglip2_encoder,
}


class VisionEmbedService:
    """The runtime that serves the recorded shape of `vision.embed`.

    The service owns what is expensive and what is shared: the registry
    is read once, and the model is built once and reused by the runs that
    follow. The mutex of the service guards the CACHE, and the adapter
    guards the LOAD of the model: the two are different locks, because
    the load of the model happens inside the adapter and not inside the
    service. The worker serves a request in a thread of its own, and two
    requests that arrive at the same time must not build two models.
    """

    def __init__(
        self,
        config: EmbedRuntimeConfig,
        *,
        encoder_factories: Optional[Mapping[str, EncoderFactory]] = None,
        planner: Optional[DevicePlanner] = None,
        registry: Optional[ModelCapabilityRegistry] = None,
        scheduler: Optional[BatchScheduler] = None,
    ) -> None:
        self._config = config
        self._factories = dict(
            encoder_factories if encoder_factories is not None else ENCODER_FACTORIES
        )
        self._planner = planner
        self._registry = registry
        self._scheduler = scheduler
        self._lock = threading.Lock()
        self._encoders: Dict[Tuple[str, str, str], Encoder] = {}
        self._specs: Dict[Tuple[str, str], PreprocessingSpec] = {}

    @property
    def config(self) -> EmbedRuntimeConfig:
        """The configuration the service was built with."""
        return self._config

    def _device_planner(self) -> DevicePlanner:
        """The planner of the device, built on the first run.

        The planner ASKS the machine, and the question imports torch when
        torch is there. A worker that never runs a real model never pays
        for that import, so the planner is built when a run asks for it.
        """
        if self._planner is not None:
            return self._planner
        with self._lock:
            if self._planner is None:
                self._planner = DevicePlanner()
            return self._planner

    def embed(
        self,
        model_id: str,
        request: EmbedRequest,
        *,
        device: Optional[str] = None,
        progress: Optional[Callable[[int, int], None]] = None,
        checkpoint: Optional[Callable[[], None]] = None,
    ) -> EmbedResult:
        """Embed the assets of the request and write the artifact.

        @param model_id: the model the registry resolves.
        @param request: the assets and the snapshot of the run.
        @param device: the device the run asks for, or None for the one of
            the configuration.
        @param progress: the progress of the run, if the caller reports one.
        @param checkpoint: the cancellation and the deadline of the run, if
            the caller owns them.
        @raises ModelRunFailedError when the model cannot be built.
        """
        record = self.resolve(model_id)
        plan = self._device_planner().plan(
            device if device is not None else self._config.device
        )
        embedder = VisionEmbedder(
            record=record,
            encoder=self._encoder(record, plan),
            spec=self._spec(record),
            decoder=DecodeService(self._config.asset_root),
            device=plan,
            artifact_root=self._config.artifact_root,
            scheduler=self._scheduler,
            snapshot_id=request.snapshot_id,
            progress=progress,
            checkpoint=checkpoint,
        )
        return embedder.embed(request)

    def resolve(self, model_id: str) -> ModelRecord:
        """The record of a model of the capability registry.

        @raises ModelNotFoundError when no record carries that id.
        @raises ModelRegistryError when the registry cannot be read.
        """
        registry = self._registry
        if registry is None:
            with self._lock:
                # The registry is read once, even when two requests arrive
                # at the same time: the file is read under the lock, so
                # the second thread waits for the first and not for the
                # file.
                registry = self._registry
                if registry is None:
                    registry = load_model_registry(str(self._config.registry_path))
                    self._registry = registry
        return registry.resolve(model_id)

    def model_ids(self) -> Tuple[str, ...]:
        """The model ids of the capability registry, sorted.

        A registry that cannot be read names NONE: the hello of the worker
        must never fail because a file of the environment is broken. The
        refusal of a run that needs the registry comes later, and it names
        the condition.
        """
        try:
            registry = self._registry
            if registry is None:
                registry = load_model_registry(str(self._config.registry_path))
                self._registry = registry
            return registry.model_ids()
        except (ModelRegistryError, ModelRecordError, OSError):
            return ()

    def _encoder(self, record: ModelRecord, plan: DevicePlan) -> Encoder:
        """The adapter of a record, built once and reused.

        The cache is keyed by the DEVICE too: an adapter carries the
        device it was built for, and an adapter built for another device
        would run the model somewhere else than the run asked for.

        @raises ModelRunFailedError when this build has no adapter for the
            feature extractor of the record.
        """
        factory = self._factories.get(record.feature_extractor)
        if factory is None:
            raise EmbedRuntimeError(
                "this build has no adapter for the feature extractor of the model, "
                "and a model without an adapter is a model that cannot be run",
                "this build has no adapter for the feature extractor '"
                + record.feature_extractor
                + "' of the model '"
                + record.model_id
                + "', and a model without an adapter is a model that cannot be run",
            )
        key = (record.model_id, record.revision, plan.device)
        with self._lock:
            encoder = self._encoders.get(key)
            if encoder is None:
                encoder = factory(record, self._model_dir(record), plan)
                self._encoders[key] = encoder
            return encoder

    def _spec(self, record: ModelRecord) -> PreprocessingSpec:
        """The preprocessing of a record, read once and reused.

        The specification is the one of the RECORD: the record names the
        fingerprint of the preprocessing it was measured with, and a
        directory whose configuration carries another one is refused
        instead of being run. The weights are verified by the adapter
        and the configuration by this method, and a model is the two of
        them.

        @raises ModelRunFailedError when the model directory carries no
            preprocessing configuration, or one that the record does not
            pin.
        """
        key = (record.model_id, record.revision)
        with self._lock:
            spec = self._specs.get(key)
            if spec is not None:
                return spec
        path = self._model_dir(record) / "preprocessor_config.json"
        try:
            payload = json.loads(path.read_text(encoding="utf8"))
        except OSError as exc:
            raise EmbedRuntimeError(
                "the model directory carries no readable preprocessing "
                "configuration, and a run without a preprocessing is not a run",
                "the model directory carries no readable preprocessing "
                "configuration, and a run without a preprocessing is not a run",
            ) from exc
        except ValueError as exc:
            raise EmbedRuntimeError(
                "the preprocessing configuration of the model is not valid JSON, "
                "and a run without a preprocessing is not a run",
                "the preprocessing configuration of the model is not valid JSON, "
                "and a run without a preprocessing is not a run",
            ) from exc
        try:
            spec = spec_of_record(record, payload)
        except (AssertionError, KeyError, TypeError, ValueError) as exc:
            raise EmbedRuntimeError(
                "the preprocessing of the model directory is not the preprocessing "
                "the record pins, and a run with another preprocessing is not the "
                "run the record describes",
                str(exc),
            ) from exc
        with self._lock:
            self._specs[key] = spec
        return spec

    def _model_dir(self, record: ModelRecord) -> Path:
        """The directory the weights of a record live in."""
        return model_directory(self._config.model_root, record.model_id, record.revision)


@dataclass(frozen=True)
class EmbedRuntime:
    """The runtime of the recorded shape, and the reason it may be absent.

    A runtime that is not configured is not an error of the worker: the
    worker serves the simulated shape, and it refuses the recorded one
    with the reason it cannot serve it.
    """

    #: The service, when the worker was configured with one.
    service: Optional[VisionEmbedService] = None

    #: The names of the environment variables that are missing.
    missing: Tuple[str, ...] = ()

    @property
    def available(self) -> bool:
        """Whether this worker can serve the recorded shape."""
        return self.service is not None

    def model_ids(self) -> Tuple[str, ...]:
        """The model ids the recorded shape may serve, sorted.

        They are the models of the capability registry, and they are the
        ones the hello of the worker advertises: a worker that serves a
        model nobody was told about is a worker that serves a surprise.
        """
        if self.service is None:
            return ()
        return self.service.model_ids()

    def refusal(self) -> str:
        """Why this worker cannot serve the recorded shape."""
        if self.missing:
            return (
                "this worker does not serve the recorded shape of vision.embed: it "
                "was not configured with "
                + ", ".join(self.missing)
            )
        return (
            "this worker does not serve the recorded shape of vision.embed: it "
            "was started without the environment of the real runtime"
        )


def runtime_from_environment(env: Mapping[str, str]) -> EmbedRuntime:
    """The runtime the environment describes.

    @param env: the environment of the worker.
    """
    config, missing = config_from_environment(env)
    if config is None:
        return EmbedRuntime(missing=missing)
    return EmbedRuntime(service=VisionEmbedService(config))


def recorded_result(result: EmbedResult) -> Dict[str, object]:
    """The recorded shape of a run, as the wire carries it.

    The vectors are NOT here: they are in the artifact, and this payload
    carries the digest that proves which bytes they are. The error
    samples name the asset and the reason, and never the path of the
    asset.
    """
    return {
        "embeddingRunId": result.run_id,
        "count": result.count,
        "dimensions": result.dimension,
        "dtype": result.dtype,
        "artifactSha256": result.artifact_sha256,
        "errorSamples": [
            {
                "assetId": error.asset_id,
                "code": error.code,
                "message": sample_message(error.code),
            }
            for error in result.errors
        ],
    }
