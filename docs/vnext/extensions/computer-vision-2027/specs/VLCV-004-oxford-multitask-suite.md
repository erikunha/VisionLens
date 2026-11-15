# VLCV-004 — Licensed starter suite for classification, retrieval and segmentation

**State:** PROPOSED. **Priority:** P0. **Dependencies:** VLCV-001, VLCV-002, canonical split gate (`VLN-007`), evaluator audit VLCV-003. **Size:** M.

## User outcome

One real dataset provides reproducible classification, retrieval and mask examples across the Studio and Python runtime, avoiding three unrelated demos. Rights, labels and original byte provenance remain traceable.

## Chosen candidate

[Oxford-IIIT Pet](https://www.robots.ox.ac.uk/~vgg/data/pets/): 37 breeds, head ROI, trimaps. This is a **candidate**, not automatically approved for image distribution. The University of Oxford site indicates CC BY-SA 4.0 and original image copyright holders. Dataset manifest must retain rights review, attribution and per-asset evidence. Default CI uses synthetic bytes/fixtures; real dataset is fetched by explicit, license-reviewed workflow.

## Task split and outputs

- `classification`: breed label; train/val/test by duplicate/capture group; macro F1.
- `retrieval`: query-image/corpus with relevance annotations distinguishing breed vs image identity; Recall@k/mAP@k; no leakage via exact same image.
- `segmentation`: trimap foreground mask vs semantic segmentation; mIoU; never call trimap a photographic soft alpha truth.
- `detection`: optional head ROI as **head bbox only**, not full-animal label, for later Lab 10.

## Required artifacts

Dataset card, license record, manifest with digests and source URL, ontology class map, task-specific evaluation suites, partition assignments with leakage report, sample derived masks/crops and provenance, README tutorial. No model checkpoint or raw dataset in source repo by default.

## Failure cases and tests

1. Duplicate same photo across splits -> split audit fails.
2. Same breed label but different individual does not imply same-image retrieval relevance.
3. Trimap pixel mapping and orientation preserved through preprocessing.
4. Head ROI beyond bounds -> geometry validator error.
5. Dataset missing offline -> clean `DATA_NOT_AVAILABLE` with setup instruction and zero network requests in CI.
6. Public fixture publish with rights unreviewed -> policy gate stops.
7. Corrupt/truncated image quarantined; input hash unchanged.
8. Manifest stats and metric denominators reproducible from pinned subset IDs.

## Acceptance

At least one sample each task can be ingested locally with a validated manifest **after rights clearance**, a held-out split is nonempty and leakage-audited, and evaluator scaffolds return typed evidence; no training or quality metric is invented before models run. Existing VisA is left untouched.

## Rollback

Remove new dataset card and optional local cached assets with user's consent. Do not delete pre-existing dataset indices or rewrite schema.
