#!/usr/bin/env python3
import json
import sys

path = "/home/ubuntu/cheongdam-automation/03_license_server/data/licenses.json"
key = sys.argv[1] if len(sys.argv) > 1 else ""
with open(path, encoding="utf-8") as f:
    data = json.load(f)
matches = [x for x in data if str(x.get("licenseKey", "")).strip() == key]
print("found", len(matches))
if not matches:
    sys.exit(0)
x = matches[0]
print("isEnabled", x.get("isEnabled"))
print("expiresAt", x.get("expiresAt"))
fp = str(x.get("deviceFingerprint") or "")
print("deviceFingerprint_set", bool(fp))
print("deviceFingerprint_len", len(fp))
print("has_licenseHash", bool(x.get("licenseHash")))
