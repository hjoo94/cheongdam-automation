#!/usr/bin/env bash
set -euo pipefail
KEY="${1:-CDM-BKT8-WB77-VTSN}"
node -e "require('fs').writeFileSync('/tmp/lv.json', JSON.stringify({licenseKey:process.argv[1],deviceFingerprint:'test-fp-verify-123',appVersion:'1.0.33',platform:'win32'}));" "$KEY"
curl -sS -X POST http://127.0.0.1:4300/api/license/verify -H 'Content-Type: application/json' --data-binary @/tmp/lv.json
echo
