# ADR-P3-003 — Package surfaces, compatibility and publishing

**Status:** Proposed. **Date:** 2026-11-15. **Relates to:** canonical ADR-012 and `06-NPM-SDK-CLI-COMPATIBILITY.md`.

## Decision proposed

1. One Python distribution `visionlens` with lightweight base and opt-in ML extras. Python >=3.11 initially. No automatic model downloads or bundled weights. `__init__` lazy modules; `py.typed` included.
2. Add `@vision-lens/sdk/client` browser-safe subpath without changing existing root exports. Add `/node` optional after worker handshake stable. Legacy exports retain API surface as long as supported.
3. Publish release artifacts only after clean-room wheel and npm pack smoke, license/model rights review, OIDC CI trusted publishing, API conformance and security review. Python package, npm package, HTTP API and worker protocol version independently.
4. Compatibility matrix: root TS legacy, `/client` and `/node` separately; Python local/remote and async separately; browsers versus server runtimes separately.

## Rejected alternatives

- New npm major without testing consumers and migration guide.
- Base Python install pulls Torch, CUDA wheels or all training dependencies.
- Publish from developers' laptops with permanent tokens.
- Bundle reference datasets or checkpoints without auditing license/data-use agreements.

## Decision gate

Do not claim name/scope ownership or publication until registry and package metadata verified. CI publisher runtime must meet current registry OIDC requirements; consumer minimums depend on independent compatibility tests. Compare public package APIs with previous release before SemVer decision.
