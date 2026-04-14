const { app, BrowserWindow, ipcMain, clipboard, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');

function loadLocalEnv() {
  const candidates = [
    path.join(__dirname, '../../03_license_server/.env'),
    path.join(__dirname, '../.env'),
  ];

  for (const envPath of candidates) {
    if (!fs.existsSync(envPath)) continue;
    const raw = fs.readFileSync(envPath, 'utf8');
    raw.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const idx = trimmed.indexOf('=');
      if (idx < 0) return;
      const key = trimmed.slice(0, idx).trim();
      const value = trimmed.slice(idx + 1).trim();
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    });
    break;
  }
}

loadLocalEnv();

const userDataPath = app.getPath('userData');
const adminConfigPath = path.join(userDataPath, 'admin-config.json');
const DEFAULT_SERVER_BASE_URL = process.env.CHUNGDAM_SERVER_URL || 'http://43.202.181.184:4300';
const DEFAULT_ADMIN_SECRET = process.env.ADMIN_SECRET || 'change-this-admin-secret';
const PLACEHOLDER_ADMIN_SECRET = 'change-this-admin-secret';
const UPDATE_APP_ID = 'admin';

function safeReadJson(filePath, fallback = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function safeWriteJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function migrateLegacyAdminServerUrl(value) {
  const trimmed = String(value || '').trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  const legacyToCurrent = {
    '43.201.84.136': '43.202.181.184',
    '43.203.124.132': '43.202.181.184',
  };
  try {
    const u = new URL(trimmed);
    const nextHost = legacyToCurrent[u.hostname];
    if (nextHost) {
      u.hostname = nextHost;
      return u.toString().replace(/\/+$/, '');
    }
  } catch {
    return trimmed;
  }
  return trimmed;
}

function normalizeServerBaseUrl(value) {
  const text = String(value || '').trim();
  if (!text) return DEFAULT_SERVER_BASE_URL;
  return migrateLegacyAdminServerUrl(text).replace(/\/+$/, '');
}

function getDefaultAdminConfig() {
  return {
    serverBaseUrl: DEFAULT_SERVER_BASE_URL,
    adminSecret: DEFAULT_ADMIN_SECRET,
  };
}

function loadAdminConfig() {
  const config = safeReadJson(adminConfigPath, getDefaultAdminConfig());
  if (!config.serverBaseUrl || config.serverBaseUrl === 'http://127.0.0.1:4300') {
    config.serverBaseUrl = DEFAULT_SERVER_BASE_URL;
  }
  if (
    (!config.adminSecret || config.adminSecret === PLACEHOLDER_ADMIN_SECRET) &&
    DEFAULT_ADMIN_SECRET !== PLACEHOLDER_ADMIN_SECRET
  ) {
    config.adminSecret = DEFAULT_ADMIN_SECRET;
  }

  const prevUrl = String(config.serverBaseUrl || '').trim().replace(/\/+$/, '');
  const serverBaseUrl = normalizeServerBaseUrl(config.serverBaseUrl);
  const adminSecret = String(config.adminSecret || DEFAULT_ADMIN_SECRET).trim();

  if (serverBaseUrl !== prevUrl) {
    safeWriteJson(adminConfigPath, { serverBaseUrl, adminSecret });
  }

  return { serverBaseUrl, adminSecret };
}

function saveAdminConfig(input = {}) {
  const next = {
    ...getDefaultAdminConfig(),
    ...loadAdminConfig(),
    ...input,
  };

  const normalized = {
    serverBaseUrl: normalizeServerBaseUrl(next.serverBaseUrl),
    adminSecret: String(next.adminSecret || '').trim(),
  };

  safeWriteJson(adminConfigPath, normalized);
  return normalized;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1380,
    height: 920,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, 'index.html'));
  win.webContents.once('did-finish-load', () => {
    checkAndInstallUpdate().then((result) => {
      if (result?.ok && result.updated) {
        win.webContents.send('admin-update-status', '새 버전을 다운로드했습니다. 설치 화면을 열었습니다.');
      }
    });
  });
}

app.whenReady().then(() => {
  if (!fs.existsSync(adminConfigPath)) {
    saveAdminConfig(getDefaultAdminConfig());
  }
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

async function postJson(pathname, body) {
  const config = loadAdminConfig();
  const url = `${config.serverBaseUrl}${pathname}`;
  let res;
  try {
    res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-secret': config.adminSecret,
      },
      body: JSON.stringify(body || {}),
    });
  } catch (error) {
    throw new Error(formatAdminFetchError(error, url));
  }

  return readJsonResponse(res);
}

async function getJson(pathname) {
  const config = loadAdminConfig();
  const url = `${config.serverBaseUrl}${pathname}`;
  let res;
  try {
    res = await fetchWithTimeout(url, {
      method: 'GET',
      headers: {
        'x-admin-secret': config.adminSecret,
      },
    });
  } catch (error) {
    throw new Error(formatAdminFetchError(error, url));
  }

  return readJsonResponse(res);
}

function compareVersions(a = '0.0.0', b = '0.0.0') {
  const strip = (v) => String(v || '').trim().replace(/^v/i, '');
  const pa = strip(a).split('.').map((n) => Number(n) || 0);
  const pb = strip(b).split('.').map((n) => Number(n) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

function assertAdminDownloadUrl(url, serverBaseUrl) {
  const parsed = new URL(String(url || ''));
  if (parsed.protocol === 'https:') return;
  let base;
  try {
    base = new URL(String(serverBaseUrl || '').trim().replace(/\/+$/, ''));
  } catch {
    base = null;
  }
  if (base && parsed.origin === base.origin) return;
  const trusted = new Set(['43.202.181.184', '43.203.124.132', '43.201.84.136', '127.0.0.1', 'localhost']);
  const extra = String(process.env.CHUNGDAM_HTTP_TRUST_HOSTS || '')
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const h of extra) trusted.add(h);
  if (parsed.protocol === 'http:' && trusted.has(parsed.hostname) && process.env.CHUNGDAM_ALLOW_HTTP_SERVER !== 'false') {
    return;
  }
  throw new Error('업데이트 다운로드는 HTTPS 이거나 신뢰된 HTTP 호스트여야 합니다.');
}

const ADMIN_FETCH_TIMEOUT_MS = Math.max(5000, Number(process.env.CHUNGDAM_ADMIN_FETCH_TIMEOUT_MS) || 20000);

function formatAdminFetchError(error, requestUrl) {
  const url = String(requestUrl || '').trim();
  if (error?.name === 'AbortError') {
    return `요청 시간 초과 (${ADMIN_FETCH_TIMEOUT_MS}ms) · ${url}`;
  }
  const cause = error?.cause;
  const code = cause && (cause.code || cause.errno);
  const msg = String(error?.message || error || '');
  if (code) {
    return `${msg} (${code}) · ${url}`;
  }
  if (/fetch failed/i.test(msg)) {
    return `연결 실패(서버·방화벽·주소 확인): ${url} — 기본 라이센스 서버는 http://43.202.181.184:4300 입니다.`;
  }
  return `${msg} · ${url}`;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = ADMIN_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const ms = Math.max(3000, Number(timeoutMs) || ADMIN_FETCH_TIMEOUT_MS);
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...(options || {}), signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readJsonResponse(res) {
  const text = await res.text();
  try {
    return JSON.parse(text || '{}');
  } catch {
    const preview = String(text || '').replace(/\s+/g, ' ').slice(0, 240);
    throw new Error(
      preview
        ? `서버가 JSON이 아닌 응답을 반환했습니다 (${res.status}): ${preview}`
        : `서버가 JSON이 아닌 응답을 반환했습니다 (${res.status})`
    );
  }
}

function resolveAdminUpdateUrl(manifestUrl, serverBaseUrl) {
  const raw = String(manifestUrl || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  try {
    const base = String(serverBaseUrl || '').trim().replace(/\/+$/, '');
    return new URL(raw.startsWith('/') ? raw : `/${raw}`, `${base}/`).toString();
  } catch {
    return raw;
  }
}

function sha256FileSync(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

async function downloadFile(url, targetPath, serverBaseUrl, expectedSha256 = '') {
  assertAdminDownloadUrl(url, serverBaseUrl);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`업데이트 다운로드 실패 (${response.status})`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, buffer);
  const want = String(expectedSha256 || '').trim().toLowerCase();
  if (/^[a-f0-9]{64}$/.test(want)) {
    const got = sha256FileSync(targetPath).toLowerCase();
    if (got !== want) {
      try {
        fs.unlinkSync(targetPath);
      } catch {}
      throw new Error('업데이트 파일 sha256 검증에 실패했습니다.');
    }
  }
}

async function runInstaller(installerPath) {
  try {
    const child = spawn(installerPath, ['/S'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    app.quit();
  } catch {
    await shell.openPath(installerPath);
  }
}

async function checkAndInstallUpdate() {
  const config = loadAdminConfig();
  const baseUrl = String(config.serverBaseUrl || DEFAULT_SERVER_BASE_URL).replace(/\/+$/, '');
  const manifestUrl = `${baseUrl}/api/updates/${UPDATE_APP_ID}/latest`;
  let response;
  try {
    response = await fetchWithTimeout(manifestUrl, { method: 'GET' });
  } catch {
    return { ok: false, error: '업데이트 확인 네트워크 실패' };
  }
  if (!response.ok) return { ok: false, error: `업데이트 확인 실패 (${response.status})` };
  let manifest;
  try {
    manifest = await readJsonResponse(response);
  } catch {
    return { ok: false, error: '업데이트 매니페스트 JSON 파싱 실패' };
  }
  if (!manifest?.ok || !manifest.version || !manifest.url) return { ok: true, updated: false };

  const versionCmp = compareVersions(manifest.version, app.getVersion());
  if (versionCmp <= 0) return { ok: true, updated: false };

  const sha256Raw = String(manifest.sha256 || '').trim();
  const sha256Ok = /^[a-f0-9]{64}$/i.test(sha256Raw);
  const installerReady = manifest.installerReady !== false;
  if (!installerReady || !sha256Ok) {
    return { ok: true, updated: false, reason: 'installer_not_ready' };
  }

  const downloadUrl = resolveAdminUpdateUrl(manifest.url, baseUrl);
  if (!downloadUrl) return { ok: true, updated: false };

  const installerPath = path.join(userDataPath, 'updates', manifest.fileName || `update-${manifest.version}.exe`);
  await downloadFile(downloadUrl, installerPath, baseUrl, sha256Raw);
  await runInstaller(installerPath);
  return { ok: true, updated: true, version: manifest.version, installerPath };
}

ipcMain.handle('load-admin-config', async () => {
  try {
    return { ok: true, config: loadAdminConfig() };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('save-admin-config', async (_, payload) => {
  try {
    return { ok: true, config: saveAdminConfig(payload || {}) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('check-admin-server', async (_, payload) => {
  try {
    const nextConfig = saveAdminConfig(payload || {});
    const url = `${nextConfig.serverBaseUrl}/api/admin/licenses`;
    let response;
    try {
      response = await fetchWithTimeout(url, {
        method: 'GET',
        headers: {
          'x-admin-secret': nextConfig.adminSecret,
        },
      });
    } catch (error) {
      return { ok: false, error: formatAdminFetchError(error, url) };
    }

    if (!response.ok) {
      const errorText = response.status === 403
        ? '관리자 인증 실패'
        : `서버 응답 오류 (${response.status})`;
      return { ok: false, error: errorText };
    }

    let data;
    try {
      data = await readJsonResponse(response);
    } catch (error) {
      return { ok: false, error: error.message };
    }

    return {
      ok: true,
      config: nextConfig,
      data,
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('get-licenses', async () => {
  try {
    return await getJson('/api/admin/licenses');
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('create-license', async (_, data) => {
  try {
    return await postJson('/api/admin/licenses', data);
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('toggle-license-enabled', async (_, payload) => {
  try {
    return await postJson('/api/admin/licenses/toggle', payload);
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('extend-license-days', async (_, payload) => {
  try {
    return await postJson('/api/admin/licenses/extend', payload);
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('delete-license', async (_, payload) => {
  try {
    return await postJson('/api/admin/licenses/delete', payload);
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('check-admin-update', async () => {
  try {
    return await checkAndInstallUpdate();
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('copy-text', async (_, text) => {
  try {
    clipboard.writeText(String(text || ''));
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});
