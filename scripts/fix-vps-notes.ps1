$key = "C:/Users/DESKTOP/Desktop/코덱스/LightsailDefaultKey-ap-northeast-2.pem"
$host = "ubuntu@43.202.181.184"
$target = "/home/ubuntu/cheongdam-automation/03_license_server/server.js"
$fixed = "asarUnpack 및 app/config.js 경로 수정 (외부 리소스 로드 및 프로세스 간 require 호환)"

$py = @'
import re
from pathlib import Path
p = Path("/home/ubuntu/cheongdam-automation/03_license_server/server.js")
t = p.read_text(encoding="utf-8")
old = "notes: 'asarUnpack에 app/config.js 포함(배민 블라인드 등 서브프로세스 require 수정)',"
new = "notes: 'asarUnpack 및 app/config.js 경로 수정 (외부 리소스 로드 및 프로세스 간 require 호환)',"
if old not in t:
    raise SystemExit("old notes string not found")
t = t.replace(old, new, 1)
p.write_text(t, encoding="utf-8")
print("OK")
'@

ssh -i "$key" $host "cp $target $target.bak-notes"
$encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($py))
ssh -i "$key" $host "python3 - <<'PY'
import base64
exec(base64.b64decode('$encoded').decode('utf-8'))
PY"
ssh -i "$key" $host "sed -n '13,22p' $target"
