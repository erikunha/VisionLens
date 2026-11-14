"""Verify one CPU run of the vision adapter, end to end (task 6.1).

The script runs the REAL model over the committed fixtures, writes the
artifact into a temporary directory, reads it back and proves two things:

  - the artifact on disk carries the digest its OWN manifest names, so the
    manifest and the bytes agree;
  - the vectors of this run are the vectors of the committed golden set,
    so the run is reproducible and the golden is not a one-off.

The script NEVER writes into the tracked golden file or the tracked
artifact. The golden is the pinned fact, and a verification run that
edited the thing it verifies would prove nothing.

    uv run --extra vision --group dev python scripts/verify_vision_run.py

It exits 0 when every check passes and 1 when one of them fails, and it
prints the measured numbers so the record of the run can quote them.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import sys
from pathlib import Path
from typing import Any, Dict, List

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = PACKAGE_ROOT.parents[1]
sys.path.insert(0, str(PACKAGE_ROOT / "src"))

from visionlens.encoders.siglip2 import Siglip2Encoder  # noqa: E402
from visionlens.inference.artifact import read_embedding_artifact  # noqa: E402
from visionlens.inference.batching import BatchScheduler  # noqa: E402
from visionlens.inference.embedder import (  # noqa: E402
    EmbedAsset,
    EmbedRequest,
    VisionEmbedder,
)
from visionlens.io.decode import DecodeService  # noqa: E402
from visionlens.io.preprocess import PreprocessingSpec  # noqa: E402
from visionlens.registry.loader import load_model_registry  # noqa: E402
from visionlens.runtime.device import DevicePlanner  # noqa: E402

#: The fixtures of the golden set: the committed images.
FIXTURES_DIR = REPO_ROOT / "packages" / "core" / "tests" / "fixtures" / "images"

#: The committed golden file, the pinned fact this run is compared with.
GOLDEN_PATH = REPO_ROOT / "benchmarks" / "parity" / "vision-embed.golden.json"

#: Where the run of this script writes. It is never inside the repository.
WORKDIR = Path("/tmp/visionlens-verify")

#: The snapshot the run belongs to: the same one the golden carries.
SNAPSHOT_ID = "fixtures-2026-11-14"


def vectors_digest(fixtures: List[Path], vectors: List[List[float]]) -> str:
    """The digest of the golden set, computed the way the golden computes it.

    The digest covers the name and the file digest of every image and the
    float32 BYTES of its vector, because the bytes of a float32 are the
    same in both languages and the JSON of the numbers is not. The vector
    is ROUNDED to six decimals first, exactly as the golden file rounds
    it: the digest has to cover the fact the golden asserts, and the
    golden asserts the rounded vector.
    """
    import array
    import sys as _sys

    payload = bytearray()
    for path, vector in zip(fixtures, vectors):
        payload += path.name.encode("utf8") + b"\x00"
        payload += hashlib.sha256(path.read_bytes()).hexdigest().encode("utf8") + b"\x00"
        packed = array.array("f", (round(float(value), 6) for value in vector))
        if _sys.byteorder != "little":
            packed.byteswap()
        payload += packed.tobytes()
    return hashlib.sha256(bytes(payload)).hexdigest()


def vectors_of(artifact_dir: Path) -> List[List[float]]:
    """The vectors of an artifact, in the order of the images."""
    import array

    artifact = read_embedding_artifact(artifact_dir)
    payload = array.array("f")
    payload.frombytes(artifact.vectors_path.read_bytes())
    dimension = artifact.manifest.dimension
    return [
        list(payload[index * dimension : (index + 1) * dimension])
        for index in range(len(payload) // dimension)
    ]


def main() -> int:
    """Run the model, verify the artifact and compare it with the golden."""
    record = load_model_registry(REPO_ROOT / "datasets" / "registry.json").resolve("siglip2-base")
    model_dir = Path.home() / ".cache" / "visionlens" / "models" / record.model_id / record.revision
    if not (model_dir / "model.safetensors").is_file():
        raise SystemExit(
            "the model is not in the cache: run the weights loader for the record first"
        )
    spec = PreprocessingSpec.from_preprocessor_config(
        json.loads((model_dir / "preprocessor_config.json").read_text(encoding="utf8"))
    )

    shutil.rmtree(WORKDIR, ignore_errors=True)
    fixtures = sorted(FIXTURES_DIR.glob("*.jpg"))
    plan = DevicePlanner().plan("cpu")

    def run_once(root: Path) -> Any:
        """One embedding run of the committed fixtures."""
        embedder = VisionEmbedder(
            record=record,
            encoder=Siglip2Encoder(record, model_dir, plan),
            spec=spec,
            decoder=DecodeService(FIXTURES_DIR),
            device=plan,
            artifact_root=root,
            scheduler=BatchScheduler(max_batch_size=8, min_batch_size=1),
            snapshot_id=SNAPSHOT_ID,
        )
        outcome = embedder.embed(
            EmbedRequest(
                snapshot_id=SNAPSHOT_ID,
                assets=tuple(EmbedAsset(asset_id=path.name, path=path) for path in fixtures),
            )
        )
        if outcome.errors:
            raise SystemExit("the run reported errors: " + str(outcome.errors))
        return outcome

    # The FIRST run pays for the load of the model, so the latency of that
    # run is the cold one. The second run is the warm one, and it is the
    # one the record of the adapter quotes. Both runs write their own
    # artifact, and the content address of the two is the same: the digest
    # is the address of the CONTENT, and the run id, the timestamp and the
    # latency are not part of it.
    cold = run_once(WORKDIR / "cold")
    warm = run_once(WORKDIR / "warm")
    result = warm

    failures: List[str] = []
    if cold.artifact_sha256 != warm.artifact_sha256:
        failures.append(
            "the cold run carries the digest "
            + cold.artifact_sha256
            + " and the warm run carries "
            + warm.artifact_sha256
            + "; two runs of the same content share one address"
        )

    # The artifact on disk, read back through the reader of the artifact.
    artifact = read_embedding_artifact(result.artifact_path)
    manifest = artifact.manifest

    failures: List[str] = []
    if artifact.artifact_digest != result.artifact_sha256:
        failures.append(
            "the digest of the artifact on disk is "
            + artifact.artifact_digest
            + " and the run reported "
            + result.artifact_sha256
        )
    if manifest.count != len(fixtures):
        failures.append(
            "the manifest counts " + str(manifest.count) + " images and the run had " + str(len(fixtures))
        )
    if manifest.dimension != result.dimension:
        failures.append("the manifest names another dimension than the run")

    vectors = vectors_of(result.artifact_path)
    digest = vectors_digest(fixtures, vectors)
    golden = json.loads(GOLDEN_PATH.read_text(encoding="utf8"))
    if digest != golden["vectorsDigest"]:
        failures.append(
            "the vectors of this run carry the digest "
            + digest
            + " and the golden carries "
            + str(golden["vectorsDigest"])
        )

    print("images:", len(fixtures))
    print("count:", result.count)
    print("dimension:", result.dimension)
    print("dtype:", result.dtype)
    print("device:", result.device)
    print("errors:", len(result.errors))
    print("cold artifact digest:", cold.artifact_sha256)
    print("warm artifact digest:", warm.artifact_sha256)
    print("artifact digest:", result.artifact_sha256)
    print("artifact digest on disk:", artifact.artifact_digest)
    print("vectors file digest:", manifest.vectors_file_digest)
    print("vectors digest of the set:", digest)
    print("vectors digest of the golden:", golden["vectorsDigest"])
    print("preprocessing fingerprint:", manifest.preprocessing_fingerprint)
    print("config fingerprint:", golden["configFingerprint"])
    print("tolerance:", json.dumps(golden["tolerance"], indent=2))
    print("peak memory bytes:", manifest.peak_memory_bytes)
    print("latency (warm run):", json.dumps(manifest.latency))
    print("runtime versions:", json.dumps(manifest.runtime_versions))

    for failure in failures:
        print("FAILED:", failure)
    if failures:
        return 1
    print("the run is green: the artifact on disk carries the digest its manifest names, and the vectors are the golden ones")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
