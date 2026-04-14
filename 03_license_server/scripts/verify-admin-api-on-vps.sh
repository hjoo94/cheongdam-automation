#!/usr/bin/env bash
set -euo pipefail
ENV="${HOME}/cheongdam-automation/03_license_server/.env"
if ! grep -q '^ADMIN_SECRET=' "$ENV"; then
  echo "ADMIN_SECRET: MISSING in $ENV"
  exit 1
fi
echo "ADMIN_SECRET: present"
SECRET="$(grep '^ADMIN_SECRET=' "$ENV" | head -1 | sed 's/^ADMIN_SECRET=//')"
CODE="$(curl -sS -o /tmp/al.json -w '%{http_code}' -H "x-admin-secret: ${SECRET}" http://127.0.0.1:4300/api/admin/licenses)"
echo "HTTP ${CODE}"
head -c 200 /tmp/al.json
echo
