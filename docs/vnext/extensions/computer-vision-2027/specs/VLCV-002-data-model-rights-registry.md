# VLCV-002 — Dataset/model rights gate for CV research

**State:** PROPOSED. **Priority:** P0. **Dependencies:** VLCV-001. **Size:** M.

## User outcome

Before import, VisionLens distinguishes approved rights, research-only datasets, unknown/colliding licenses and forbidden raw-data redistribution. Dataset/model provenance follows all artifacts. No clinical/plate/personal data accidentally appear in showcase or telemetry.

## In-scope

Read current dataset registry and licensing fields. Decide whether to reuse existing manifest extension vs create new record. Add minimal fields/tags only if absent: source, authoritative license evidence, exact checkpoint/dataset hash, accepted use, source rights review, annotation vs image licenses, publish permission, review timestamp. `BLOCKED` on unknown/research-only when the operation is commercial/public. Support a local synthetic fixture with no external calls and verify gate behavior.

## Out-of-scope

Automated legal determination, scraping/dataset download, broad database migrations, assigning CC/Apache license to arbitrary images from source repo code, opening access to health/plate data.

## Tests

- Dataset with unknown rights is rejected for `publish`, and no network request occurs.
- UFPR-ALPR research-only data cannot be exported into a public demo.
- DIS5K conflicting mirror license is `LICENSE_CONFLICT` instead of Apache-2.0.
- Oxford Pets can be proposed for local research but public bundle requires review and attribution.
- License fields round-trip through existing store schema or explicitly versioned backward-compatible artifact; old records remain readable as `UNKNOWN` not invented `VERIFIED`.
- Tests check that logs and traces contain hashes, not raw plate/X-ray data.

## Acceptance

An evidence report covers source, image ownership, license of weight/code/data, rights review and artifact lineage, with exact source URLs. All unknowns block commercial publication. Existing repo tests are preserved.

## Rollback

Disable new publish gate behind a policy version with compatibility fallback to **deny** unknown publication, not permissive acceptance. No destructive migration.
