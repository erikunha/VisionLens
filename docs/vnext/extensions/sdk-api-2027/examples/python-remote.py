"""PROPOSED API EXAMPLE ONLY. Requires future client, deployed API and authorized asset."""
import os

from visionlens.remote import VisionLensClient  # Proposed import; no Torch needed


def main() -> None:
    with VisionLensClient(base_url=os.environ["VISIONLENS_URL"], token=os.environ["VISIONLENS_TOKEN"]) as client:
        capabilities = client.capabilities.get()
        print(capabilities.data.contract_version)
        job = client.jobs.submit(
            operation="vision.predict",
            params={"taskKind": "image.classification", "assetId": "asset_fixture", "modelId": "classifier@locked"},
            budget={"maxSeconds": 120, "maxUsdMicro": 0},
            idempotency_key="tutorial-classify-v1",  # stable for this logical action only
        )
        completed = client.jobs.wait(job.data.job_id, timeout_seconds=180)
        if completed.data.status != "succeeded":
            raise RuntimeError(f"Job ended as {completed.data.status}")
        print(client.jobs.result(completed.data.job_id))


if __name__ == "__main__":
    main()
