# Drop-in handoff for an already-running coding agent

**Do not replace the existing repo with this ZIP.** The user has approved Python-first Vision Lens design, but substantial work already exists on `feat/visual-lens` (and additional local work may be unpushed).

## What to do now

1. Read `00-ADOPTION-NO-OVERWRITE.md`, `01-REPO-STATE-2026-11-11.md`, `02-ARCHITECTURE-DECISION.md`, the accepted repository ADR-005 through ADR-010, and local untracked specs.
2. Inspect `git status`, branches, unpublished artifacts, package contents, current tests, benchmark split semantics, tracked dataset license and CI. **Do not** assume the current branch equals the public `feat/visual-lens`.
3. Create a non-destructive reconciliation document with KEEP/AMEND/DEFER/CONFLICT status and exact paths. Existing work shipped in F0 stays shipped; never reset or rename just to match a diagram.
4. Present a short proposed delta to maintainer. Integrate this package under `docs/vnext/` first. Approve ADR-011 and subsequent decisions before altering architecture.
5. Execute one next ticket. Recommended: `VLN-001`, then `VLN-002`, then `VLN-003`/`VLN-004`; investigate split blocker `VLN-007` before any scientific improvement claim.
6. Work on a dedicated feature branch. Add contract and regression tests and no unrelated files. Document what was actually tested.

## A stop list

- Do not `git reset --hard`, delete untracked spec-kit, force-push, or rewrite main.
- Do not remove existing `@vision-lens/core`, `@vision-lens/sdk`, CLI aliases, Zod contracts, SQLite store, tests or VisA artifacts.
- Do not silently edit old data migration or accepted ADR in place; supersede with new ADR.
- Do not call the 700 VisA evaluation "held-out accuracy"; it is an all-train baseline according to branch docs.
- Do not claim npm/PyPI package availability or MPS/CUDA test coverage without checking.

## What to return after first pass

Branch and HEAD SHA; local git status; component progress table; existing accepted ADR conflicts; detected blockers (especially split); baseline test evidence; proposed smallest next PR with files to touch and 3–5 concrete acceptance checks.
