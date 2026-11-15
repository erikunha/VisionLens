"""PROPOSED API EXAMPLE ONLY. Client-side cancellation is not server job cancellation."""
import asyncio
import os
from visionlens.remote import AsyncVisionLensClient  # Proposed import


async def main() -> None:
    async with AsyncVisionLensClient(base_url=os.environ["VISIONLENS_URL"], token=os.environ["VISIONLENS_TOKEN"]) as client:
        job = await client.jobs.submit(
            operation="vision.predict",
            params={"taskKind": "image.classification", "assetId": "asset_fixture", "modelId": "classifier@locked"},
            budget={"maxSeconds": 120, "maxUsdMicro": 0},
            idempotency_key="tutorial-classify-async-v1",
        )
        # Cancelling wait only stops the local coroutine. Call jobs.cancel explicitly to cancel server work.
        done = await client.jobs.wait(job.data.job_id, timeout_seconds=180)
        print(done.data.status)


if __name__ == "__main__":
    asyncio.run(main())
