"""PROPOSED API EXAMPLE ONLY. Not runnable until SDK/fixture have been implemented."""
from pathlib import Path

from visionlens import LocalConfig, VisionLens  # Proposed imports


def main() -> None:
    config = LocalConfig(device="cpu", offline=True, allow_model_downloads=False)
    with VisionLens.local(config) as vl:
        result = vl.predict(
            task_kind="image.classification",
            input=Path("./fixtures/pet.jpg"),
            model="classifier@approved-immutable-revision",
            top_k=3,
            output_dir=Path("./.visionlens/runs"),
        )
        print(result.run_id, result.provenance.input_sha256, result.predictions)
        # Python local writes only its standalone run manifest/CAS, not managed TS SQLite.


if __name__ == "__main__":
    main()
