/**
 * 로컬에서 고객 앱 NSIS 설치 파일을 03_license_server/downloads 로 복사하고
 * .env 의 CLIENT_APP_VERSION / CLIENT_APP_FILE 을 맞춥니다.
 * (Lightsail 등 운영 서버에 배포하기 전에 한 번 실행)
 *
 * 사용: node scripts/sync-client-installer.js
 */
const fs = require('fs');
const path = require('path');

const SERVER_ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.join(__dirname, '..', '..');
const DOWNLOADS = path.join(SERVER_ROOT, 'downloads');
const DIST = path.join(REPO_ROOT, '02_client_app', 'baemin-review-bot', 'dist');
const PATCH_DIR = path.join(REPO_ROOT, '패치파일_EXE_여기');
const ENV_PATH = path.join(SERVER_ROOT, '.env');

function parseSemverFromName(name) {
  const m = String(name).match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return [0, 0, 0];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compareSemver(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function findLatestClientExe() {
  const names = new Set();
  for (const dir of [DIST, PATCH_DIR]) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (/^Cheongdam Bot Setup \d+\.\d+\.\d+\.exe$/i.test(name)) {
        names.add(path.join(dir, name));
      }
    }
  }
  let best = '';
  let bestVer = [0, 0, 0];
  for (const full of names) {
    const base = path.basename(full);
    const ver = parseSemverFromName(base);
    if (!best || compareSemver(ver, bestVer) > 0) {
      best = full;
      bestVer = ver;
    }
  }
  return best;
}

function upsertEnvLine(lines, key, value) {
  const next = [];
  let hit = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      next.push(line);
      continue;
    }
    const idx = trimmed.indexOf('=');
    if (idx < 0) {
      next.push(line);
      continue;
    }
    const k = trimmed.slice(0, idx).trim();
    if (k === key) {
      next.push(`${key}=${value}`);
      hit = true;
    } else {
      next.push(line);
    }
  }
  if (!hit) {
    if (next.length && next[next.length - 1].trim() !== '') next.push('');
    next.push(`${key}=${value}`);
  }
  return next;
}

function main() {
  const src = findLatestClientExe();
  if (!src) {
    console.error('Cheongdam Bot Setup x.y.z.exe 파일을 dist 또는 패치파일_EXE_여기 에서 찾지 못했습니다.');
    process.exit(1);
  }

  const fileName = path.basename(src);
  const ver = parseSemverFromName(fileName);
  const versionStr = `${ver[0]}.${ver[1]}.${ver[2]}`;

  fs.mkdirSync(DOWNLOADS, { recursive: true });
  const dest = path.join(DOWNLOADS, fileName);
  fs.copyFileSync(src, dest);
  console.log(`복사 완료: ${src} -> ${dest}`);

  let lines = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/) : [];
  lines = upsertEnvLine(lines, 'CLIENT_APP_VERSION', versionStr);
  lines = upsertEnvLine(lines, 'CLIENT_APP_FILE', fileName);
  const body = `${lines.join('\n').replace(/\s+$/, '')}\n`;
  fs.writeFileSync(ENV_PATH, body, 'utf8');
  console.log(`업데이트: ${ENV_PATH} -> CLIENT_APP_VERSION=${versionStr}, CLIENT_APP_FILE=${fileName}`);
  console.log('다음: server.js 기본 manifest 버전이 exe와 다르면 맞추고, 운영 서버에 downloads·.env·server.js 를 반영한 뒤 systemctl restart 하세요.');
}

main();
