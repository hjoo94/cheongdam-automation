#!/usr/bin/env bash
set -euo pipefail
VER="${1:?version}"
FILE="${2:?installer file name}"
ROOT="${HOME}/cheongdam-automation"
ENV="${ROOT}/03_license_server/.env"
cd "$ROOT"
git pull --ff-only
upsert() {
  local key="$1"
  local val="$2"
  if grep -q "^${key}=" "$ENV"; then
    sed -i "s#^${key}=.*#${key}=${val}#" "$ENV"
  else
    printf '\n%s=%s\n' "$key" "$val" >> "$ENV"
  fi
}
upsert CLIENT_APP_VERSION "$VER"
upsert CLIENT_APP_FILE "$FILE"
pm2 restart server --update-env
sleep 2
curl -sS "http://127.0.0.1:4300/api/updates/client/latest" | head -c 500
echo
