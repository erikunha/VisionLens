# Proposed consumer examples (not working against snapshot)

These files are illustrative **future usage** for the proposed SDK/API; none is validated against a deployed VisionLens API or a released package. They are not a runnable reference app yet. After implementation, replace placeholder model/asset IDs and base URLs with permitted fixture identifiers, run integration tests and update truth status.

- `python-local.py`: local ML runner, CPU, pinned model; requires Python implementation + `[vision]` extra.
- `python-remote.py`: synchronous HTTP client; requires Fastify and a scoped token; no Torch on client.
- `python-async.py`: Python asyncio job submit/wait; client wait cancellation does not automatically cancel server job.
- `typescript-remote.ts`: browser/Node HTTP client, no native ML packages.
- `typescript-node-local.ts`: explicit Node-only worker bridge; never imported from `/client`.
- `http-example.sh`: HTTP request and polling with explicit idempotency; assumes asset pre-staged by authorized upload.

All shown APIs **may be renamed** if reconciliation with current `@vision-lens/contracts` requires it.
