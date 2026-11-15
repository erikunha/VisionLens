# Contract proposals — not canonical

`capability-pack.v0.schema.json` and `capability-pack.example.json` are architecture **proposals**. They are **not** production schemas and have no authority over `packages/contracts`, Zod, the SQLite store or JSONL. The `$id` domain is deliberately invalid to avoid suggesting deployment.

A coding agent must inspect actual schemas and accepted ADRs, run a compatibility analysis and only then adapt/reject these illustrative fields in a versioned PR. JSON-schema validates proposal structure; it does not validate code runtime or dataset licenses.
