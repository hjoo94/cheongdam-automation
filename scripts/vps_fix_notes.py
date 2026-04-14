from pathlib import Path
import re

TARGET = Path("/home/ubuntu/cheongdam-automation/03_license_server/server.js")
FIXED_NOTES = "asarUnpack 및 app/config.js 경로 수정 (외부 리소스 로드 및 프로세스 간 require 호환)"

text = TARGET.read_text(encoding="utf-8")
pattern = r"(client:\s*\{[\s\S]*?notes:\s*)'[^']*'"
match = re.search(pattern, text)
if not match:
    raise SystemExit("client notes field not found")

before = match.group(0)
after = match.group(1) + "'" + FIXED_NOTES + "'"
updated = re.sub(pattern, after, text, count=1)
TARGET.write_text(updated, encoding="utf-8")

print("BEFORE=" + before)
print("AFTER=" + after)
