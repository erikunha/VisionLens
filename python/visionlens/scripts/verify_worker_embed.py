"""Verify one recorded run of `vision.embed` over the worker channel.

The script starts the REAL worker as a subprocess, configures it with the
environment of the real runtime, and asks it for the RECORDED shape of
`vision.embed`: the run id, the count, the dimension, the dtype, the
digest of the artifact and the error samples. It then proves two things:

  - the frame the worker answered carries the recorded shape and no
    vector, because the vectors are on disk and not in the line;
  - the artifact on disk carries the digest the frame names, and its
    vectors are the vectors of the committed golden set, so the run over
    the channel produced the same content as the run over the library.

The script NEVER writes into the tracked golden file or the tracked
artifact. The golden is the pinned fact, and a verification run that
edited the thing it verifies would prove nothing.

    uv run --extra vision --group dev python scripts/verify_worker_embed.py

It exits 0 when every check passes and 1 when one of them fails, and it
prints the measured numbers so the record of the run can quote them.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Tuple

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = PACKAGE_ROOT.parents[1]
SRC = PACKAGE_ROOT / "src"

#: The fixtures of the golden set: the committed images.
FIXTURES_DIR = REPO_ROOT / "packages" / "core" / "tests" / "fixtures" / "images"

#: The committed golden file, the pinned fact this run is compared with.
GOLDEN_PATH = REPO_ROOT / "benchmarks" / "parity" / "vision-embed.golden.json"

#: Where the run of this script writes. It is never inside the repository.
WORKDIR = Path("/tmp/visionlens-verify-worker")

#: The snapshot the run belongs to: the same one the golden carries.
SNAPSHOT_ID = "fixtures-2026-11-14"

#: The wire protocol the worker speaks.
PROTOCOL = "visionlens.worker.v1"


def worker_environment(model_root: Path) -> Dict[str, str]:
    """The environment that configures the real runtime of the worker."""
    env = dict(os.environ)
    existing = env.get("PYTHONPATH")
    env["PYTHONPATH"] = str(SRC) if not existing else str(SRC) + os.pathsep + existing
    env["VISIONLENS_WORKER_REGISTRY"] = str(REPO_ROOT / "datasets" / "registry.json")
    env["VISIONLENS_WORKER_MODEL_ROOT"] = str(model_root)
    env["VISIONLENS_WORKER_ASSET_ROOT"] = str(FIXTURES_DIR)
    env["VISIONLENS_WORKER_ARTIFACT_ROOT"] = str(WORKDIR / "artifacts")
    return env


def drive_worker(env: Dict[str, str], assets: List[Dict[str, str]]) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    """Ask the worker for the recorded shape and return its answer.

    @returns the result frame and every frame the worker emitted.
    """
    process = subprocess.Popen(
        [sys.executable, "-m", "visionlens.worker"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
    )
    assert process.stdin is not None and process.stdout is not None

    def send(frame: Dict[str, Any]) -> None:
        process.stdin.write((json.dumps(frame, separators=(",", ":")) + "\n").encode("utf-8"))
        process.stdin.flush()

    hello = json.loads(process.stdout.readline().decode("utf-8"))
    send(
        {
            "protocol": PROTOCOL,
            "kind": "hello",
            "protocolVersion": "1.0.0",
            "contractVersion": "1.0.0",
        }
    )
    send(
        {
            "protocol": PROTOCOL,
            "kind": "request",
            "requestId": "r-verify",
            "operation": "vision.embed",
            "contractVersion": "1.0.0",
            "workspaceId": "ws-verify",
            "params": {
                "model": "siglip2-base",
                "snapshotId": SNAPSHOT_ID,
                "assets": assets,
            },
            "budget": {"maxSeconds": 600, "maxUsdMicro": 0},
        }
    )

    frames: List[Dict[str, Any]] = [hello]
    while True:
        line = process.stdout.readline()
        if not line:
            break
        frame = json.loads(line.decode("utf-8"))
        frames.append(frame)
        if frame.get("kind") in ("result", "error"):
            break
    process.stdin.close()
    process.wait(timeout=60)
    stderr = process.stderr.read().decode("utf-8", errors="replace") if process.stderr else ""
    for frame in frames:
        if frame.get("kind") == "error":
            print("the worker answered with an error:", json.dumps(frame))
            print(stderr)
            raise SystemExit(1)
    result = next(frame for frame in frames if frame.get("kind") == "result")
    return result, frames


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

    from visionlens.inference.artifact import read_embedding_artifact

    artifact = read_embedding_artifact(artifact_dir)
    payload = array.array("f")
    payload.frombytes(artifact.vectors_path.read_bytes())
    dimension = artifact.manifest.dimension
    return [
        list(payload[index * dimension : (index + 1) * dimension])
        for index in range(len(payload) // dimension)
    ]


def main() -> int:
    """Run the worker over the channel and verify what it answered."""
    sys.path.insert(0, str(SRC))

    from visionlens.registry.loader import load_model_registry

    record = load_model_registry(REPO_ROOT / "datasets" / "registry.json").resolve("siglip2-base")
    model_root = Path.home() / ".cache" / "visionlens" / "models"
    model_dir = model_root / record.model_id / record.revision
    if not (model_dir / "model.safetensors").is_file():
        raise SystemExit(
            "the model is not in the cache: run the weights loader for the record first"
        )

    shutil.rmtree(WORKDIR, ignore_errors=True)
    fixtures = sorted(FIXTURES_DIR.glob("*.jpg"))
    assets = [{"assetId": path.name, "path": path.name} for path in fixtures]

    result, frames = drive_worker(worker_environment(model_root), assets)
    payload = result["result"]

    failures: List[str] = []
    for field in ("embeddingRunId", "count", "dimensions", "dtype", "artifactSha256"):
        if field not in payload:
            failures.append("the result of the worker carries no " + field)
    if "vectors" in payload:
        failures.append(
            "the result of the worker carries the vectors of the run in the line, "
            "and the recorded shape carries them on disk"
        )
    if payload.get("count") != len(fixtures):
        failures.append(
            "the worker counts "
            + str(payload.get("count"))
            + " images and the run had "
            + str(len(fixtures))
        )
    if payload.get("dimensions") != record.output_dimension:
        failures.append(
            "the worker answers a dimension of "
            + str(payload.get("dimensions"))
            + " and the record declares "
            + str(record.output_dimension)
        )

    artifact_dir = (
        WORKDIR / "artifacts" / "artifacts" / "embedding" / str(payload.get("embeddingRunId"))
    )
    digest = ""
    if artifact_dir.is_dir():
        from visionlens.inference.artifact import read_embedding_artifact

        artifact = read_embedding_artifact(artifact_dir)
        digest = vectors_digest(fixtures, vectors_of(artifact_dir))
        if artifact.artifact_digest != payload.get("artifactSha256"):
            failures.append(
                "the digest of the artifact on disk is "
                + artifact.artifact_digest
                + " and the worker answered "
                + str(payload.get("artifactSha256"))
            )
        golden = json.loads(GOLDEN_PATH.read_text(encoding="utf8"))
        if digest != golden["vectorsDigest"]:
            failures.append(
                "the vectors of this run carry the digest "
                + digest
                + " and the golden carries "
                + str(golden["vectorsDigest"])
            )
    else:
        failures.append("the worker wrote no artifact at " + str(artifact_dir))

    progress = [frame for frame in frames if frame.get("kind") == "progress"]
    print("images:", len(fixtures))
    print("count:", payload.get("count"))
    print("dimensions:", payload.get("dimensions"))
    print("dtype:", payload.get("dtype"))
    print("embedding run id:", payload.get("embeddingRunId"))
    print("artifact digest:", payload.get("artifactSha256"))
    print("error samples:", len(payload.get("errorSamples", [])))
    print("progress frames:", len(progress))
    for frame in progress:
        print("progress:", frame.get("completed"), "of", frame.get("total"))
    print("vectors digest of the set:", digest)

    for failure in failures:
        print("FAILED:", failure)
    if failures:
        return 1
    print(
        "the run is green: the worker answered the recorded shape over the channel, "
        "the artifact on disk carries the digest the frame names, and the vectors "
        "are the golden ones"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
