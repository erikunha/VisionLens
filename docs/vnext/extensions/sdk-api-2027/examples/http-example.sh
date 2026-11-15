#!/usr/bin/env bash
# PROPOSED API EXAMPLE ONLY. Does not upload media or provide a running server.
set -euo pipefail
: "${VISIONLENS_URL:?Set base API URL}"
: "${VISIONLENS_TOKEN:?Set scoped bearer token}"
: "${VISIONLENS_ASSET_ID:?Upload an authorized asset first}"
: "${VISIONLENS_MODEL_ID:?Use an approved immutable model revision}"
# Requires curl, jq. Token stays in header not query string.
curl -fsS "$VISIONLENS_URL/v1/capabilities" -H "Authorization: Bearer $VISIONLENS_TOKEN" | jq '.data.features'
job_json=$(jq -n --arg asset "$VISIONLENS_ASSET_ID" --arg model "$VISIONLENS_MODEL_ID" '{operation:"vision.predict",params:{taskKind:"image.classification",assetId:$asset,modelId:$model},budget:{maxSeconds:120,maxUsdMicro:0}}')
curl -fsS -X POST "$VISIONLENS_URL/v1/jobs" \
  -H "Authorization: Bearer $VISIONLENS_TOKEN" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: tutorial-classification-v1' -d "$job_json" | jq '.'
# Follow Location/status and SSE with an authorized client. Do not assume 202 means completed.
