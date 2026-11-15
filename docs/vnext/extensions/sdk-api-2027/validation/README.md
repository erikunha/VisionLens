# Phase III artifact validation (offline)

Run at the addon root (after installing Python dependencies `jsonschema` and `PyYAML` in a validation environment):

```bash
python validation/validate_phase3.py
```

This validates SHA-256 manifests, candidate JSON Schemas, seven positive fixtures, two negative fixtures, candidate OpenAPI references/structure, 40-ticket backlog dependencies, Markdown relative links and Python sample syntax. It **does not** establish OpenAPI standards completeness, runtime Fastify behavior, PyPI/npm package availability, CV model correctness, license status, performance or security. Those require current-repo CI and integration/acceptance tests described in `IMPLEMENTATION-PLAN.md`.
