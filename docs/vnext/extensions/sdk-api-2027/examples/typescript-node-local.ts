// PROPOSED API EXAMPLE ONLY. Requires optional /node worker bridge and local ML extra.
import { createLocalVisionLens } from '@vision-lens/sdk/node';

const runner = await createLocalVisionLens({
  workspaceDir: './.visionlens',
  pythonExecutable: '/trusted/venv/bin/python',
  device: 'cpu',
  allowModelDownloads: false,
});
try {
  const run = await runner.predict({
    taskKind: 'image.classification',
    inputPath: './fixtures/pet.jpg',
    modelId: 'classifier@approved-immutable-revision',
  });
  console.log(run);
} finally {
  await runner.close();
}
