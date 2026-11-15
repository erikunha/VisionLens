// PROPOSED API EXAMPLE ONLY. Requires implementing browser-safe /client export.
import { VisionLensClient } from '@vision-lens/sdk/client';

const vl = new VisionLensClient({
  baseUrl: process.env.VISIONLENS_URL ?? 'http://127.0.0.1:8787',
  getAccessToken: () => process.env.VISIONLENS_TOKEN ?? '', // server context ONLY; don't ship secrets in browser
});

const job = await vl.jobs.submit({
  operation: 'vision.predict',
  params: { taskKind: 'image.classification', assetId: 'asset_fixture', modelId: 'classifier@locked' },
  budget: { maxSeconds: 120, maxUsdMicro: 0 },
  idempotencyKey: 'tutorial-ts-classification-v1',
});
const finished = await vl.jobs.wait(job.data.jobId, { timeoutMs: 180_000 });
if (finished.data.status !== 'succeeded') throw new Error(`Job ended: ${finished.data.status}`);
const result = await vl.jobs.result(finished.data.jobId);
console.log(result.data.artifacts);
// In browsers obtain scoped credentials from a secure auth flow; do not expose server-side API secrets.
