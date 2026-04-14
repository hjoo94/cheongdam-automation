#!/usr/bin/env bash
# One-time / ops: copy ADMIN_SECRET from legacy chungdam-server .env into active cheongdam .env.
set -euo pipefail
SRC="${HOME}/chungdam-server/.env"
DST="${HOME}/cheongdam-automation/03_license_server/.env"
if [[ ! -f "$SRC" ]]; then echo "missing $SRC"; exit 1; fi
if [[ ! -f "$DST" ]]; then echo "missing $DST"; exit 1; fi
if grep -q '^ADMIN_SECRET=' "$DST"; then
  echo "ADMIN_SECRET already set in $DST"
  exit 0
fi
LINE="$(grep '^ADMIN_SECRET=' "$SRC" | head -1)"
VAL="${LINE#ADMIN_SECRET=}"
VAL="${VAL#"${VAL%%[![:space:]]*}"}"
VAL="${VAL%"${VAL##*[![:space:]]}"}"
if [[ "$VAL" == \'*\' ]]; then VAL="${VAL:1:${#VAL}-2}"; fi
printf '\nADMIN_SECRET=%s\n' "$VAL" >> "$DST"
echo "Appended ADMIN_SECRET to $DST"
pm2 restart server --update-env
