#!/usr/bin/env bash
set -euo pipefail

URL="${1:-http://127.0.0.1:4300/health}"
HTTP_CODE="$(curl -fsS -o /tmp/chungdam-health.json -w '%{http_code}' "$URL")"

if [ "$HTTP_CODE" != "200" ]; then
  echo "healthcheck failed: $HTTP_CODE"
  exit 1
fi

cat /tmp/chungdam-health.json
