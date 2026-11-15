# Validation summary and commands

All documents in this pack are proposals; no ML inference was run. The packaging validation checks SHA-256, markdown local links, proposed JSON Schema and backlog dependencies. It does **not** guarantee that any linked external model license will remain valid or that code in the user's live repo builds.

For the combined ZIP, the original 65 entries retain byte-identical **uncompressed file contents**. The original canonical `MANIFEST.sha256` is preserved without editing. The canonical `validation/validate_pack.py` can be run on the combined ZIP after extraction. It checks known original hashes and markdown links.

The add-on's `MANIFEST-PHASE-II.sha256` records all Phase II files generated before `VERIFYING.md`. A simple integrity check can read hashes from the manifest.
