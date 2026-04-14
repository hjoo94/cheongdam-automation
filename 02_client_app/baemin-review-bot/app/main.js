  const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, session, Notification } = require('electron');
  const path = require('path');
  const fs = require('fs');
  const os = require('os');
  const crypto = require('crypto');
  const { execSync, spawn } = require('child_process');
  const { Readable } = require('stream');
  const { pipeline } = require('stream/promises');
  const { getSelectedFeatureKeys, getFeatureMeta } = require('../bot/actions');
  const { getReviewAnalysisData: collectReviewAnalysisData } = require('../utils/reviewAnalysis');
  const { analyzeFinanceFile } = require('../utils/financeAnalyzer');
  const { classifyFinanceTransactions, analyzeStoreClickWithGpt, generateThreadsDrafts } = require('../gptClient');
  const { analyzeStoreClickText } = require('../utils/storeClickAnalyzer');
  const { collectThreadsMarketingSources } = require('../utils/threadsMarketing');
  const { filterUnsafeThreadsDrafts } = require('../utils/threadsSafety');
  const { appendUserError } = require('../utils/errorCollector');
  const { appendSecurityAudit, hashValue } = require('../utils/securityAudit');
  const { compareVersions } = require('../utils/versionCompare');
  const {
    DEFAULT_SERVER_BASE_URL,
    migrateServerBaseUrl,
    normalizeUrlText,
    isLegacyServerBaseUrl,
  } = require('./config');
  const {
    normalizeSecureServerBaseUrl,
    isTrustedHttpLicenseServer,
    maskLogMessage,
    encryptSettingsSecrets,
    decryptSettingsSecrets,
    sha256File,
    constantTimeEqualHex,
  } = require('./security');

  let mainWindow;
  let preparedState = null;
  let hasStarted = false;
  let autoUpdateInterval = null;
  let mobileSyncInterval = null;

  // featureKey -> child process
  const preparedChildren = new Map();
  const featureRestartAttempts = new Map();
  let isIntentionalShutdown = false;

  // ===== 저장 경로 =====
  const userDataPath = app.getPath('userData');
  const settingsPath = path.join(userDataPath, 'settings.json');
  const licensePath = path.join(userDataPath, 'license.json');
  const runtimePath = path.join(userDataPath, 'runtime.json');
  const financeMemoryPath = path.join(userDataPath, 'finance-category-memory.json');
  process.env.RUNTIME_PATH = runtimePath;

  // ===== 서버 주소 =====
  const SERVER_BASE_URL = process.env.CHUNGDAM_SERVER_URL || DEFAULT_SERVER_BASE_URL;
  const UPDATE_APP_ID = 'client';
  const UPDATE_REQUEST_RETRY_COUNT = 2;
  const UPDATE_REQUEST_RETRY_DELAY_MS = 3000;
  const UPDATE_REQUEST_TIMEOUT_MS = 10000;
  const LICENSE_RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
  const FEATURE_RESTART_MAX_ATTEMPTS = 2;
  const FEATURE_RESTART_DELAY_MS = 2500;
  const AUTO_RELAUNCH_WINDOW_MS = 5 * 60 * 1000;
  const AUTO_RELAUNCH_MAX_COUNT = 2;
  const autoRelaunchStatePath = path.join(userDataPath, 'auto-relaunch-state.json');

  function clearUnsafeProxyEnv() {
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
      const value = String(process.env[key] || '');
      if (/127\.0\.0\.1:9|localhost:9/i.test(value)) {
        delete process.env[key];
      }
    }
  }

  clearUnsafeProxyEnv();

  // ===== 기본 빈 값 =====
  const EMPTY_LICENSE = {
    licenseKey: '',
    customerName: '',
    expiresAt: '',
    features: {},
    statusText: '미확인',
    statusType: 'idle',
    verifiedAt: '',
    deviceFingerprint: '',
  };

  const EMPTY_SETTINGS = {
    serverBaseUrl: SERVER_BASE_URL,
    storeName: '',
    reviewRule: '',
    baeminStoreId: '',
    coupangStoreId: '',
    bizNo: '',
    idCardPath: '',
    financeFilePath: '',
    financeFilePaths: [],
    financeDepositFilePaths: [],
    financeWithdrawalFilePaths: [],
    vatMode: 'general',
    settlementStartDay: 5,
    threadsAccessToken: '',
    threadsApiBaseUrl: 'https://graph.threads.net/v1.0',
    threadsKeywords: '자영업자이야기, 자영업, 소상공인, 장사, 매출, 배민, 쿠팡이츠',
    threadsDraftDirection: '',
    threadsUseThreadsApiSearch: true,
    threadsReviewReplyExamples: '',
    threadsEmergencyStop: false,
    threadsDailyLimit: 10,
    threadsPlan: 'basic',
    mobileFeatureToggles: {
      baeminReply: true,
      baeminBlind: true,
      coupangReply: true,
      coupangBlind: true,
      naverMail: true,
      threadsMarketing: true,
    },
    baeminReplyMode: 'advanced',
    coupangReplyMode: 'advanced',
  };

  function safeWriteJson(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  function safeReadJson(filePath, fallback = {}) {
    try {
      if (!fs.existsSync(filePath)) return fallback;
      const raw = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  function normalizeServerBaseUrl(value) {
    return normalizeSecureServerBaseUrl(migrateServerBaseUrl(value), SERVER_BASE_URL, {
      isPackaged: app.isPackaged,
      throwOnInsecure: app.isPackaged,
    });
  }

  function assertHttpsDownloadUrl(url, licenseServerBaseUrl = '') {
    const parsed = new URL(String(url || ''));
    if (parsed.protocol === 'https:') return;

    let baseParsed = null;
    try {
      baseParsed = new URL(String(licenseServerBaseUrl || '').trim().replace(/\/+$/, ''));
    } catch {
      baseParsed = null;
    }
    if (baseParsed && parsed.origin === baseParsed.origin) return;

    if (isTrustedHttpLicenseServer(parsed)) return;

    throw new Error(
      '업데이트 다운로드 URL이 HTTPS가 아닙니다. 설정의 서버 주소와 같은 호스트이거나, CHUNGDAM_HTTP_TRUST_HOSTS에 호스트를 추가하세요.'
    );
  }

  function resolveUpdateDownloadUrl(manifestUrl = '', licenseServerBaseUrl = '') {
    const raw = String(manifestUrl || '').trim();
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw)) return raw;
    try {
      const base = String(licenseServerBaseUrl || '').trim().replace(/\/+$/, '');
      return new URL(raw.startsWith('/') ? raw : `/${raw}`, `${base}/`).toString();
    } catch {
      return raw;
    }
  }

  function explainFetchFailure(error, serverBaseUrl, contextLabel = '서버') {
    const message = String(error?.message || error || '');
    const url = String(serverBaseUrl || '');
    const isNetwork =
      error?.name === 'AbortError' ||
      /fetch failed|network|timeout|ECONN|ENOTFOUND|ETIMEDOUT|request timeout/i.test(message);
    if (isNetwork) {
      if (url.startsWith('https://')) {
        return `${contextLabel}에 연결할 수 없습니다: ${url} (서버가 꺼져 있거나 TLS 인증서를 확인하세요.)`;
      }
      return `${contextLabel}에 연결할 수 없습니다: ${url} (업데이트 서버에 연결할 수 없습니다. 네트워크를 확인하거나 관리자에게 문의하세요.)`;
    }
    return message;
  }

  async function fetchWithTimeout(url, options = {}, timeoutMs = UPDATE_REQUEST_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1500, Number(timeoutMs) || 9000));
    try {
      return await fetch(url, {
        ...(options || {}),
        signal: controller.signal,
      });
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error(`request timeout after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  function buildUpdateServerCandidates() {
    const settings = safeReadJson(settingsPath, EMPTY_SETTINGS);
    const single = normalizeServerBaseUrl(settings.serverBaseUrl || SERVER_BASE_URL);
    return [single];
  }

  async function fetchLatestManifestFromAnyServer() {
    const candidates = buildUpdateServerCandidates();
    const primaryUrl = candidates[0] || normalizeServerBaseUrl(SERVER_BASE_URL);

    for (const baseUrl of candidates) {
      const url = `${baseUrl}/api/updates/${UPDATE_APP_ID}/latest`;
      for (let attempt = 1; attempt <= UPDATE_REQUEST_RETRY_COUNT; attempt += 1) {
        try {
          const response = await fetchWithTimeout(url, {}, UPDATE_REQUEST_TIMEOUT_MS);
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
          const manifest = await response.json();
          return { baseUrl, manifest };
        } catch (error) {
          if (attempt >= UPDATE_REQUEST_RETRY_COUNT) {
            throw new Error(
              `[업데이트] 서버 연결 실패: ${primaryUrl}\n(업데이트 서버에 연결할 수 없습니다. 네트워크를 확인하거나 관리자에게 문의하세요.)`
            );
          }
          await new Promise((resolve) => setTimeout(resolve, UPDATE_REQUEST_RETRY_DELAY_MS));
        }
      }
    }
    throw new Error(
      `[업데이트] 서버 연결 실패: ${primaryUrl}\n(업데이트 서버에 연결할 수 없습니다. 네트워크를 확인하거나 관리자에게 문의하세요.)`
    );
  }

  function persistWorkingServerBaseUrl(baseUrl = '') {
    const normalized = normalizeServerBaseUrl(String(baseUrl || '').trim());
    if (!normalized) return;
    const current = safeReadJson(settingsPath, EMPTY_SETTINGS);
    if (String(current.serverBaseUrl || '').trim() === normalized) return;
    saveSettingsJson({
      ...EMPTY_SETTINGS,
      ...current,
      serverBaseUrl: normalized,
    });
    sendLog(`[업데이트] 연결 가능한 서버 주소로 자동 보정: ${normalized}`);
  }

  function migrateStoredServerBaseUrl() {
    if (!fs.existsSync(settingsPath)) return;
    const encrypted = safeReadJson(settingsPath, EMPTY_SETTINGS);
    const settings = decryptSettingsSecrets(safeStorage, encrypted);
    const current = normalizeUrlText(settings.serverBaseUrl || '');
    if (!current) return;
    if (!isLegacyServerBaseUrl(current)) return;

    const migrated = normalizeServerBaseUrl(current);
    const merged = {
      ...EMPTY_SETTINGS,
      ...settings,
      serverBaseUrl: migrated,
    };
    safeWriteJson(settingsPath, encryptSettingsSecrets(safeStorage, merged));
    sendLog(`[MIGRATE] serverBaseUrl 구IP → 신IP 자동 교체 완료 (${current} -> ${migrated})`);
  }

  const MIN_UPDATE_FREE_BYTES = 300 * 1024 * 1024;

  function getFreeDiskSpaceBytesForPath(targetPath) {
    if (process.platform !== 'win32') return null;
    try {
      const root = path.parse(path.resolve(targetPath)).root;
      const m = root.match(/^([A-Za-z]:)/);
      const devId = m ? m[1] : 'C:';
      const out = execSync(`wmic logicaldisk where "DeviceID='${devId}'" get FreeSpace /value`, {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 12000,
      });
      const match = out.match(/FreeSpace=(\d+)/);
      return match ? parseInt(match[1], 10) : null;
    } catch {
      return null;
    }
  }

  function cleanupStaleUpdateArtifacts(updatesDir, tmpRoot) {
    try {
      if (updatesDir && fs.existsSync(updatesDir)) {
        for (const name of fs.readdirSync(updatesDir)) {
          if (
            name.endsWith('.download') ||
            name.startsWith('chungdam-install-wrap-') ||
            name.endsWith('.exe.tmp')
          ) {
            try {
              fs.unlinkSync(path.join(updatesDir, name));
              sendLog(`[업데이트] 임시 정리(updates): ${name}`);
            } catch {}
          }
        }
      }
    } catch {}
    try {
      if (!tmpRoot || !fs.existsSync(tmpRoot)) return;
      for (const f of fs.readdirSync(tmpRoot)) {
        const hit =
          f.startsWith('cheongdam-update') ||
          f.endsWith('.exe.tmp') ||
          /baemin-review-bot-setup|chungdam-bot-setup|Cheongdam Bot Setup.*\.tmp$/i.test(f);
        if (!hit) continue;
        try {
          fs.unlinkSync(path.join(tmpRoot, f));
          sendLog(`[업데이트] 임시 정리(tmp): ${f}`);
        } catch {}
      }
    } catch {}
  }

  async function downloadFile(url, targetPath, expectedSha256 = '', licenseServerBaseUrl = '') {
    assertHttpsDownloadUrl(url, licenseServerBaseUrl);
    const updatesDir = path.join(userDataPath, 'updates');
    cleanupStaleUpdateArtifacts(updatesDir, os.tmpdir());
    const freeBytes = getFreeDiskSpaceBytesForPath(targetPath);
    if (freeBytes !== null && freeBytes < MIN_UPDATE_FREE_BYTES) {
      const freeMB = Math.floor(freeBytes / 1024 / 1024);
      const msg = `[업데이트] 디스크 공간 부족: 여유 ${freeMB}MB (최소 약 300MB 필요). 임시·오래된 설치 파일을 정리한 뒤 다시 시도하세요.`;
      sendLog(msg);
      throw new Error(msg);
    }
    let response;
    try {
      response = await fetch(url);
    } catch (error) {
      throw new Error(explainFetchFailure(error, url, '업데이트 서버'));
    }
    if (!response.ok) {
      throw new Error(`업데이트 다운로드 실패 (${response.status})`);
    }
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const tempPath = `${targetPath}.download`;
    try {
      if (response.body) {
        const ws = fs.createWriteStream(tempPath);
        ws.on('error', (err) => {
          try {
            fs.rmSync(tempPath, { force: true });
          } catch {}
          appendUserError('update.download_stream', err, { url });
          sendLog(`[업데이트] 다운로드 스트림 오류: ${err.message}`);
        });
        await pipeline(Readable.fromWeb(response.body), ws);
      } else {
        const buffer = Buffer.from(await response.arrayBuffer());
        fs.writeFileSync(tempPath, buffer);
      }

      const expectedLength = Number(response.headers.get('content-length') || 0);
      const actualLength = fs.statSync(tempPath).size;
      if (expectedLength > 0 && actualLength !== expectedLength) {
        throw new Error(`다운로드 파일 크기 불일치 (${actualLength}/${expectedLength})`);
      }

      const normalizedHash = String(expectedSha256 || '').trim().toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(normalizedHash)) {
        throw new Error('업데이트 매니페스트에 유효한 sha256 해시가 없습니다.');
      }

      const actualHash = sha256File(tempPath);
      if (!constantTimeEqualHex(actualHash, normalizedHash)) {
        throw new Error('업데이트 파일 무결성 검증에 실패했습니다.');
      }

      fs.renameSync(tempPath, targetPath);
    } catch (error) {
      try { fs.rmSync(tempPath, { force: true }); } catch {}
      throw error;
    }
  }

  async function runInstaller(installerPath) {
    cleanupPreparedChildren();
    try {
      mainWindow?.destroy();
    } catch {}

    const resolved = path.resolve(String(installerPath || ''));
    if (!resolved || !fs.existsSync(resolved)) {
      await shell.openPath(String(installerPath || ''));
      return;
    }

    if (process.platform === 'win32') {
      isIntentionalShutdown = true;
      const wrapPath = path.join(userDataPath, 'updates', `chungdam-install-wrap-${Date.now()}.cmd`);
      const setupForSet = resolved.replace(/%/g, '%%');
      const lines = [
        '@echo off',
        'setlocal',
        'REM 본 프로세스가 완전히 내려간 뒤 설치기를 올려 파일 잠금·구버전 제거 실패를 줄입니다.',
        'ping 127.0.0.1 -n 10 >nul',
        'taskkill /F /IM "Cheongdam Bot.exe" /T 1>nul 2>nul',
        'ping 127.0.0.1 -n 6 >nul',
        'taskkill /F /IM "Cheongdam Bot.exe" /T 1>nul 2>nul',
        'ping 127.0.0.1 -n 10 >nul',
        `set "CHUNGDAM_SETUP=${setupForSet}"`,
        'start "" /wait "%CHUNGDAM_SETUP%" /S',
      ];
      fs.mkdirSync(path.dirname(wrapPath), { recursive: true });
      fs.writeFileSync(wrapPath, lines.join('\r\n'), 'utf8');
      try {
        spawn(process.env.ComSpec || 'cmd.exe', ['/c', 'start', '/min', '', wrapPath], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        }).unref();
      } catch {
        await shell.openPath(resolved);
        return;
      }
      app.quit();
      return;
    }

    try {
      const child = spawn(resolved, ['/S'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
      app.quit();
    } catch {
      await shell.openPath(resolved);
    }
  }

  async function checkAndInstallUpdate() {
    const { baseUrl: serverBaseUrl, manifest } = await fetchLatestManifestFromAnyServer();
    persistWorkingServerBaseUrl(serverBaseUrl);
    if (!manifest?.ok || !manifest.version || !manifest.url) {
      return { ok: true, updated: false };
    }
    const sha256Raw = String(manifest.sha256 || '').trim();
    const sha256Ok = /^[a-f0-9]{64}$/i.test(sha256Raw);
    const installerReady = manifest.installerReady !== false;

    const versionCmp = compareVersions(manifest.version, app.getVersion());
    if (versionCmp <= 0) {
      if (versionCmp < 0) {
        sendLog(
          `[업데이트] 서버가 안내하는 버전(${manifest.version})이 지금 앱(${app.getVersion()})보다 낮습니다. ` +
            '라이센스 서버에 최신 설치 파일을 올리고 CLIENT_APP_VERSION(또는 배포된 server.js)을 맞춰야 새 버전으로 자동 업데이트됩니다.'
        );
      } else {
        sendLog(`[업데이트] 이미 최신 버전입니다 (앱·서버 안내 ${app.getVersion()}).`);
      }
      return { ok: true, updated: false };
    }

    if (!installerReady || !sha256Ok) {
      sendLog(
        `[업데이트] 서버에 ${manifest.version} 설치 파일이 없거나 sha256이 비어 있습니다. ` +
          '라이센스 서버의 downloads 폴더에 exe를 올리고 서비스를 재시작한 뒤 다시 확인하세요.'
      );
      return { ok: true, updated: false, reason: 'installer_not_ready' };
    }

    const downloadUrl = resolveUpdateDownloadUrl(manifest.url, serverBaseUrl);
    if (!downloadUrl) {
      sendLog('[업데이트] 매니페스트에 다운로드 URL이 없습니다.');
      return { ok: true, updated: false };
    }

    sendLog(`[업데이트] 새 버전 ${manifest.version} 다운로드를 시작합니다.`);
    const installerPath = path.join(userDataPath, 'updates', manifest.fileName || `update-${manifest.version}.exe`);
    try {
      await downloadFile(downloadUrl, installerPath, sha256Raw, serverBaseUrl);
    } catch (error) {
      error.updateStage = '다운로드';
      throw error;
    }
    sendLog('[업데이트] 다운로드 완료. 자동 설치를 시작합니다.');
    try {
      await runInstaller(installerPath);
    } catch (error) {
      error.updateStage = '설치 실행';
      throw error;
    }
    return { ok: true, updated: true, version: manifest.version, installerPath };
  }

  function getServerBaseUrl(overrideValue = '') {
    const overrideText = String(overrideValue || '').trim();
    if (overrideText) {
      return normalizeServerBaseUrl(overrideText);
    }

    const settings = safeReadJson(settingsPath, EMPTY_SETTINGS);
    return normalizeServerBaseUrl(settings.serverBaseUrl || SERVER_BASE_URL);
  }

  function buildLicenseIntegrity(data = {}) {
    const source = JSON.stringify({
      licenseKey: String(data.licenseKey || '').trim(),
      customerName: String(data.customerName || '').trim(),
      expiresAt: String(data.expiresAt || '').trim(),
      features: data.features || {},
      deviceFingerprint: String(data.deviceFingerprint || '').trim(),
      verifiedAt: String(data.verifiedAt || '').trim(),
      nextCheckAt: String(data.nextCheckAt || '').trim(),
    });

    return crypto.createHash('sha256').update(source).digest('hex');
  }

  function withLicenseIntegrity(data = {}) {
    return {
      ...data,
      integrityHash: buildLicenseIntegrity(data),
    };
  }

  function hasValidLicenseIntegrity(license = {}) {
    if (!license?.integrityHash) return false;
    return license.integrityHash === buildLicenseIntegrity(license);
  }

  function getWindowsMachineGuid() {
    try {
      if (process.platform !== 'win32') return '';
      const output = execSync(
        'reg query "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid',
        { encoding: 'utf8' }
      );
      const match = output.match(/MachineGuid\s+REG_SZ\s+([^\r\n]+)/i);
      return match ? String(match[1]).trim() : '';
    } catch {
      return '';
    }
  }

  function getPrimaryMacs() {
    try {
      const nets = os.networkInterfaces();
      const macs = [];

      Object.values(nets).forEach((items) => {
        (items || []).forEach((item) => {
          if (!item) return;
          if (item.internal) return;
          if (!item.mac || item.mac === '00:00:00:00:00:00') return;
          macs.push(item.mac);
        });
      });

      return Array.from(new Set(macs)).sort();
    } catch {
      return [];
    }
  }

  function buildDeviceFingerprint() {
    const raw = JSON.stringify({
      platform: process.platform,
      arch: process.arch,
      hostname: os.hostname(),
      machineGuid: getWindowsMachineGuid(),
      macs: getPrimaryMacs(),
    });

    return crypto.createHash('sha256').update(raw).digest('hex');
  }

  const DEVICE_FINGERPRINT = buildDeviceFingerprint();

  function createBlankRuntime() {
    return {
      serverBaseUrl: getServerBaseUrl(),
      licenseKey: '',
      customerName: '',
      expiresAt: '',
      features: {},
      storeName: '',
      reviewRule: '',
      baeminStoreId: '',
      coupangStoreId: '',
      bizNo: '',
      idCardPath: '',
      financeFilePath: '',
      financeFilePaths: [],
      financeDepositFilePaths: [],
      financeWithdrawalFilePaths: [],
      vatMode: 'general',
      settlementStartDay: 5,
      baeminReplyMode: 'advanced',
      coupangReplyMode: 'advanced',
      deviceFingerprint: DEVICE_FINGERPRINT,
      syncedAt: new Date().toISOString(),
    };
  }

  function initializeLocalState() {
    if (!fs.existsSync(settingsPath)) {
      safeWriteJson(settingsPath, encryptSettingsSecrets(safeStorage, EMPTY_SETTINGS));
    } else {
      const settings = decryptSettingsSecrets(safeStorage, safeReadJson(settingsPath, EMPTY_SETTINGS));
      const normalizedServerBaseUrl = normalizeServerBaseUrl(settings.serverBaseUrl);
      const encryptedSettings = encryptSettingsSecrets(safeStorage, {
          ...EMPTY_SETTINGS,
          ...settings,
          serverBaseUrl: normalizedServerBaseUrl,
        });
      if (settings.serverBaseUrl !== normalizedServerBaseUrl || JSON.stringify(safeReadJson(settingsPath, {})) !== JSON.stringify(encryptedSettings)) {
        safeWriteJson(settingsPath, encryptedSettings);
      }
    }

    if (!fs.existsSync(licensePath)) {
      safeWriteJson(licensePath, EMPTY_LICENSE);
    }

    if (!fs.existsSync(runtimePath)) {
      safeWriteJson(runtimePath, createBlankRuntime());
    }
  }

  function createWindow() {
    mainWindow = new BrowserWindow({
      width: 1400,
      height: 900,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        devTools: !app.isPackaged,
      },
    });

    mainWindow.once('ready-to-show', () => mainWindow.show());
    mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      try {
        const parsed = new URL(url);
        if (parsed.protocol === 'https:' && parsed.hostname === 'open.kakao.com') {
          shell.openExternal(url);
        }
      } catch {}
      return { action: 'deny' };
    });
    if (app.isPackaged) {
      mainWindow.webContents.on('devtools-opened', () => mainWindow.webContents.closeDevTools());
      mainWindow.webContents.on('before-input-event', (event, input) => {
        if (input.key === 'F12' || (input.control && input.shift && String(input.key || '').toLowerCase() === 'i')) {
          event.preventDefault();
        }
      });
    }

    mainWindow.loadFile(path.join(__dirname, 'index.html'));
    mainWindow.webContents.once('did-finish-load', () => {
      sendLog(`[업데이트] 현재 버전 ${app.getVersion()} / 자동 업데이트 확인 준비`);
    });
  }

  function installSecurityHeaders() {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: file:; connect-src https: http://127.0.0.1:* http://localhost:*; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'",
          ],
          'X-Content-Type-Options': ['nosniff'],
          'Referrer-Policy': ['no-referrer'],
        },
      });
    });
  }

  app.whenReady().then(() => {
    isIntentionalShutdown = false;
    installSecurityHeaders();
    initializeLocalState();
    migrateStoredServerBaseUrl();
    createWindow();
    syncRuntimeFile();
    const runSilentUpdateCheck = () => {
      sendLog('[업데이트] 자동 확인 실행');
      checkAndInstallUpdate().catch((error) => {
        const stage = error.updateStage || '확인';
        sendLog(`[업데이트] ${stage} 실패: ${error.message}`);
      });
    };

    setTimeout(runSilentUpdateCheck, 800);
    setTimeout(runSilentUpdateCheck, 45000);
    if (autoUpdateInterval) clearInterval(autoUpdateInterval);
    autoUpdateInterval = setInterval(runSilentUpdateCheck, 3 * 60 * 60 * 1000);
    pushMobileRuntimeState({ phase: 'ready' }).catch(() => {});
    if (mobileSyncInterval) clearInterval(mobileSyncInterval);
    mobileSyncInterval = setInterval(() => {
      pullMobileCommands().catch(() => {});
      pushMobileRuntimeState({ phase: 'heartbeat' }).catch(() => {});
    }, 90 * 1000);
    setTimeout(() => {
      writeAutoRelaunchState({ windowStartAt: 0, count: 0, lastReason: 'stable' });
    }, 60 * 1000);
  });

  app.on('window-all-closed', () => {
    cleanupPreparedChildren();
    if (autoUpdateInterval) {
      clearInterval(autoUpdateInterval);
      autoUpdateInterval = null;
    }
    if (mobileSyncInterval) {
      clearInterval(mobileSyncInterval);
      mobileSyncInterval = null;
    }
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    isIntentionalShutdown = true;
    cleanupPreparedChildren();
    if (autoUpdateInterval) {
      clearInterval(autoUpdateInterval);
      autoUpdateInterval = null;
    }
    if (mobileSyncInterval) {
      clearInterval(mobileSyncInterval);
      mobileSyncInterval = null;
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      initializeLocalState();
      createWindow();
      syncRuntimeFile();
    }
  });

  function saveJson(filePath, data) {
    safeWriteJson(filePath, data);
  }

  function loadJson(filePath, fallback = {}) {
    return safeReadJson(filePath, fallback);
  }

  function saveSettingsJson(settings) {
    saveJson(settingsPath, encryptSettingsSecrets(safeStorage, settings));
  }

  function loadSettingsJson() {
    return decryptSettingsSecrets(safeStorage, loadJson(settingsPath, EMPTY_SETTINGS));
  }

  function sendLog(message) {
    const safeMessage = maskLogMessage(message);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('log', String(safeMessage));
    }
  }

  function notifyUser(title, body) {
    try {
      if (!Notification.isSupported()) return;
      const n = new Notification({
        title: String(title || '청담봇 알림'),
        body: String(body || '').slice(0, 140),
        silent: false,
      });
      n.show();
    } catch {}
  }

  function readAutoRelaunchState() {
    return loadJson(autoRelaunchStatePath, {
      windowStartAt: 0,
      count: 0,
    });
  }

  function writeAutoRelaunchState(next) {
    saveJson(autoRelaunchStatePath, next || { windowStartAt: 0, count: 0 });
  }

  function resetFeatureRestartAttempts(featureKey = '') {
    if (featureKey) {
      featureRestartAttempts.delete(featureKey);
      return;
    }
    featureRestartAttempts.clear();
  }

  function scheduleAppRelaunch(reason = 'unknown', error = null) {
    if (isIntentionalShutdown) return false;
    const now = Date.now();
    const state = readAutoRelaunchState();
    const withinWindow = Number(state.windowStartAt || 0) > 0 && (now - Number(state.windowStartAt || 0)) < AUTO_RELAUNCH_WINDOW_MS;
    const nextCount = withinWindow ? Number(state.count || 0) + 1 : 1;
    const nextState = {
      windowStartAt: withinWindow ? Number(state.windowStartAt || now) : now,
      count: nextCount,
      lastReason: String(reason || 'unknown'),
      lastAt: new Date(now).toISOString(),
    };
    writeAutoRelaunchState(nextState);

    if (nextCount > AUTO_RELAUNCH_MAX_COUNT) {
      sendLog(`[복구] 자동 재실행 제한 초과(${AUTO_RELAUNCH_MAX_COUNT}회/${Math.floor(AUTO_RELAUNCH_WINDOW_MS / 60000)}분)로 재실행 중단`);
      appendUserError('app.auto_relaunch_limit_exceeded', error || new Error(`relaunch blocked: ${reason}`), {
        reason,
        nextState,
      });
      return false;
    }

    appendUserError('app.auto_relaunch_scheduled', error || new Error(`relaunch: ${reason}`), {
      reason,
      nextState,
    });
    sendLog(`[복구] 치명 오류 감지 -> 앱 자동 재실행 예약 (${nextCount}/${AUTO_RELAUNCH_MAX_COUNT})`);
    notifyUser('청담봇 복구 모드', '오류가 감지되어 앱을 자동으로 다시 실행합니다.');

    isIntentionalShutdown = true;
    try {
      app.relaunch();
    } catch (relaunchError) {
      appendUserError('app.auto_relaunch_failed', relaunchError, { reason });
      return false;
    }
    setTimeout(() => {
      try {
        app.exit(0);
      } catch {}
    }, 250);
    return true;
  }

  function normalizeMobileFeatureToggles(value = {}) {
    const src = value && typeof value === 'object' ? value : {};
    return {
      baeminReply: src.baeminReply !== false,
      baeminBlind: src.baeminBlind !== false,
      coupangReply: src.coupangReply !== false,
      coupangBlind: src.coupangBlind !== false,
      naverMail: src.naverMail !== false,
      threadsMarketing: src.threadsMarketing !== false,
    };
  }

  async function pushMobileRuntimeState(status = {}) {
    try {
      const runtime = buildRuntimeData();
      const settings = sanitizeThreadsSecuritySettings(loadSettingsJson());
      if (!runtime.licenseKey || !runtime.deviceFingerprint) return;
      await fetch(`${runtime.serverBaseUrl}/api/mobile/state/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          licenseKey: runtime.licenseKey,
          deviceFingerprint: runtime.deviceFingerprint,
          appVersion: runtime.appVersion,
          platform: runtime.platform,
          status: {
            ...(status || {}),
            mobileFeatureToggles: settings.mobileFeatureToggles,
            threadsPolicy: {
              threadsPlan: settings.threadsPlan,
              threadsDailyLimit: settings.threadsDailyLimit,
              threadsEmergencyStop: settings.threadsEmergencyStop === true,
            },
          },
        }),
      });
    } catch {}
  }

  function applyThreadsEmergencyStop(value) {
    const current = loadSettingsJson();
    const next = sanitizeThreadsSecuritySettings({
      ...current,
      threadsEmergencyStop: value === true,
    });
    saveSettingsJson({
      ...EMPTY_SETTINGS,
      ...next,
    });
    syncRuntimeFile();
    return next;
  }

  function applyMobileFeatureToggle(featureKey, enabled) {
    const current = sanitizeThreadsSecuritySettings(loadSettingsJson());
    const nextToggles = normalizeMobileFeatureToggles(current.mobileFeatureToggles || {});
    if (Object.prototype.hasOwnProperty.call(nextToggles, featureKey)) {
      nextToggles[featureKey] = enabled === true;
    }
    const next = sanitizeThreadsSecuritySettings({
      ...current,
      mobileFeatureToggles: nextToggles,
    });
    saveSettingsJson({ ...EMPTY_SETTINGS, ...next });
    syncRuntimeFile();
    return next;
  }

  function applyThreadsPolicyPatch(payload = {}) {
    const current = sanitizeThreadsSecuritySettings(loadSettingsJson());
    const next = sanitizeThreadsSecuritySettings({
      ...current,
      threadsPlan: payload?.threadsPlan || current.threadsPlan,
      threadsDailyLimit: payload?.threadsDailyLimit ?? current.threadsDailyLimit,
      threadsEmergencyStop: payload?.threadsEmergencyStop ?? current.threadsEmergencyStop,
    });
    saveSettingsJson({ ...EMPTY_SETTINGS, ...next });
    syncRuntimeFile();
    return next;
  }

  async function pullMobileCommands() {
    try {
      const runtime = buildRuntimeData();
      if (!runtime.licenseKey || !runtime.deviceFingerprint) return;
      const response = await fetch(`${runtime.serverBaseUrl}/api/mobile/commands/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          licenseKey: runtime.licenseKey,
          deviceFingerprint: runtime.deviceFingerprint,
        }),
      });
      if (!response.ok) return;
      const result = await response.json();
      if (!result?.ok || !Array.isArray(result.commands) || !result.commands.length) return;
      for (const command of result.commands) {
        if (command.commandType === 'threads_emergency_stop') {
          const stopOn = command?.payload?.enabled === true;
          applyThreadsEmergencyStop(stopOn);
          sendLog(`[모바일연동] 원격 명령 적용: threadsEmergencyStop=${stopOn ? 'ON' : 'OFF'}`);
          notifyUser('모바일 원격 제어', `스레드 긴급중지가 ${stopOn ? 'ON' : 'OFF'}으로 변경되었습니다.`);
          appendSecurityAudit('mobile', 'threads_emergency_stop_command', {
            commandId: command.id || '',
            enabled: stopOn,
          });
        }
        if (command.commandType === 'feature_toggle') {
          const featureKey = String(command?.payload?.featureKey || '').trim();
          const enabled = command?.payload?.enabled === true;
          const next = applyMobileFeatureToggle(featureKey, enabled);
          sendLog(`[모바일연동] 원격 명령 적용: ${featureKey}=${enabled ? 'ON' : 'OFF'}`);
          notifyUser('모바일 원격 제어', `${featureKey} 기능이 ${enabled ? 'ON' : 'OFF'}으로 변경되었습니다.`);
          appendSecurityAudit('mobile', 'feature_toggle_command', {
            commandId: command.id || '',
            featureKey,
            enabled,
          });
          await pushMobileRuntimeState({
            phase: 'mobile_feature_toggle',
            featureKey,
            enabled,
            toggles: next.mobileFeatureToggles,
          });
        }
        if (command.commandType === 'threads_policy_update') {
          const next = applyThreadsPolicyPatch(command?.payload || {});
          sendLog(`[모바일연동] 원격 명령 적용: threadsPlan=${next.threadsPlan}, dailyLimit=${next.threadsDailyLimit}`);
          notifyUser('모바일 원격 제어', `스레드 정책이 ${next.threadsPlan}/${next.threadsDailyLimit}회로 변경되었습니다.`);
          appendSecurityAudit('mobile', 'threads_policy_command', {
            commandId: command.id || '',
            threadsPlan: next.threadsPlan,
            threadsDailyLimit: next.threadsDailyLimit,
            threadsEmergencyStop: next.threadsEmergencyStop === true,
          });
          await pushMobileRuntimeState({
            phase: 'mobile_threads_policy_update',
            threadsPlan: next.threadsPlan,
            threadsDailyLimit: next.threadsDailyLimit,
            threadsEmergencyStop: next.threadsEmergencyStop === true,
          });
        }
      }
    } catch {}
  }

  function normalizeThreadsDailyLimit(value) {
    const n = Number(value || 10);
    if (!Number.isFinite(n)) return 10;
    return Math.max(1, Math.min(20, Math.round(n)));
  }

  function resolveThreadsPlanLimit(settings = {}) {
    const plan = String(settings.threadsPlan || 'basic').trim().toLowerCase();
    if (plan === 'pro') return 16;
    if (plan === 'enterprise') return 20;
    return 10;
  }

  function sanitizeThreadsSecuritySettings(data = {}) {
    const plan = String(data?.threadsPlan || 'basic').trim().toLowerCase();
    const safePlan = ['basic', 'pro', 'enterprise'].includes(plan) ? plan : 'basic';
    return {
      ...data,
      threadsPlan: safePlan,
      threadsEmergencyStop: data?.threadsEmergencyStop === true,
      threadsDailyLimit: normalizeThreadsDailyLimit(
        data?.threadsDailyLimit ?? resolveThreadsPlanLimit({ threadsPlan: safePlan }),
      ),
      mobileFeatureToggles: normalizeMobileFeatureToggles(data?.mobileFeatureToggles || {}),
    };
  }

  function isFeatureEnabledByMobile(featureKey, settings = {}) {
    const toggles = normalizeMobileFeatureToggles(settings.mobileFeatureToggles || {});
    return toggles[featureKey] !== false;
  }

  function checkThreadsDailyRateLimit(maxPerDay = 10) {
    const stamp = new Date().toISOString().slice(0, 10);
    const filePath = path.join(userDataPath, 'threads-usage.json');
    const fallback = { day: stamp, count: 0 };
    const raw = loadJson(filePath, fallback);
    const day = String(raw?.day || '');
    const count = Number(raw?.count || 0);
    const next = day === stamp ? { day: stamp, count } : fallback;
    if (next.count >= maxPerDay) {
      return {
        ok: false,
        count: next.count,
        maxPerDay,
        message: `보안 정책상 스레드 초안은 하루 ${maxPerDay}회까지만 생성됩니다.`,
      };
    }
    return { ok: true, state: next };
  }

  function increaseThreadsDailyRateLimit(state) {
    const next = {
      day: String(state?.day || new Date().toISOString().slice(0, 10)),
      count: Number(state?.count || 0) + 1,
    };
    saveJson(path.join(userDataPath, 'threads-usage.json'), next);
    return next;
  }

  let processErrorGuardsInstalled = false;
  function installProcessErrorGuards() {
    if (processErrorGuardsInstalled) return;
    processErrorGuardsInstalled = true;
    process.on('unhandledRejection', (reason) => {
      const err = reason instanceof Error ? reason : new Error(String(reason));
      try {
        appendUserError('process.unhandledRejection', err, { phase: 'main' });
      } catch {}
      try {
        sendLog(`[시스템] 처리되지 않은 Promise 오류: ${err.message}`);
      } catch {
        console.error('[unhandledRejection]', err);
      }
    });
    process.on('uncaughtException', (error) => {
      try {
        appendUserError('process.uncaughtException', error, { phase: 'main' });
      } catch {}
      try {
        sendLog(`[시스템] 처리되지 않은 예외: ${error?.message || error}`);
      } catch {
        console.error('[uncaughtException]', error);
      }
      scheduleAppRelaunch('uncaughtException', error);
    });
  }
  installProcessErrorGuards();

  function resolveReplyModeFromLicense(features = {}, platform = 'baemin') {
    const basicKey = platform === 'coupang' ? 'coupangReplyBasic' : 'baeminReplyBasic';
    const premiumKey = platform === 'coupang' ? 'coupangReplyPremium' : 'baeminReplyPremium';
    const legacyKey = platform === 'coupang' ? 'coupangReply' : 'baeminReply';
    const hasExplicitTier =
      Object.prototype.hasOwnProperty.call(features || {}, basicKey) ||
      Object.prototype.hasOwnProperty.call(features || {}, premiumKey);

    if (features[premiumKey] === true) return 'advanced';
    if (features[basicKey] === true) return 'basic';
    if (!hasExplicitTier && features[legacyKey] === true) return 'advanced';
    return 'advanced';
  }

  function applyLicensedReplyModes(settings = {}, features = {}) {
    return {
      ...settings,
      baeminReplyMode: resolveReplyModeFromLicense(features, 'baemin'),
      coupangReplyMode: resolveReplyModeFromLicense(features, 'coupang'),
    };
  }

  function buildRuntimeData() {
    const settings = loadSettingsJson();
    const license = loadJson(licensePath, EMPTY_LICENSE);
    const licensedSettings = applyLicensedReplyModes(settings, license.features || {});
    const serverBaseUrl = getServerBaseUrl(settings.serverBaseUrl);

    return {
      serverBaseUrl,
      licenseKey: String(license.licenseKey || '').trim(),
      customerName: String(license.customerName || '').trim(),
      expiresAt: license.expiresAt || '',
      features: license.features || {},
      storeName: String(licensedSettings.storeName || '').trim(),
      reviewRule: String(licensedSettings.reviewRule || '').trim(),
      baeminStoreId: String(licensedSettings.baeminStoreId || '').trim(),
      coupangStoreId: String(licensedSettings.coupangStoreId || '').trim(),
      bizNo: String(licensedSettings.bizNo || '').trim(),
      idCardPath: String(licensedSettings.idCardPath || '').trim(),
      financeFilePath: String(licensedSettings.financeFilePath || '').trim(),
      financeFilePaths: Array.isArray(licensedSettings.financeFilePaths)
        ? licensedSettings.financeFilePaths.map((item) => String(item || '').trim()).filter(Boolean)
        : [],
      financeDepositFilePaths: Array.isArray(licensedSettings.financeDepositFilePaths)
        ? licensedSettings.financeDepositFilePaths.map((item) => String(item || '').trim()).filter(Boolean)
        : [],
      financeWithdrawalFilePaths: Array.isArray(licensedSettings.financeWithdrawalFilePaths)
        ? licensedSettings.financeWithdrawalFilePaths.map((item) => String(item || '').trim()).filter(Boolean)
        : [],
      vatMode: String(licensedSettings.vatMode || 'general').trim(),
      settlementStartDay: Number(licensedSettings.settlementStartDay || 5),
      baeminReplyMode: String(licensedSettings.baeminReplyMode || 'advanced').trim(),
      coupangReplyMode: String(licensedSettings.coupangReplyMode || 'advanced').trim(),
      deviceFingerprint: DEVICE_FINGERPRINT,
      deviceId: DEVICE_FINGERPRINT,
      appVersion: app.getVersion(),
      platform: process.platform,
      syncedAt: new Date().toISOString(),
    };
  }

  function syncRuntimeFile() {
    try {
      const runtime = buildRuntimeData();
      saveJson(runtimePath, runtime);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  function validateFeatureAccess(selected = {}, features = {}, settings = null) {
    const currentSettings = settings || applyLicensedReplyModes(loadSettingsJson(), features);
    if (selected.baeminReply) {
      const mode = String(currentSettings.baeminReplyMode || resolveReplyModeFromLicense(features, 'baemin'));
      const featureKey = mode === 'basic' ? 'baeminReplyBasic' : 'baeminReplyPremium';
      const hasExplicitTier = Object.prototype.hasOwnProperty.call(features || {}, featureKey);
      if (features[featureKey] !== true && (hasExplicitTier || features.baeminReply !== true)) {
        return mode === 'basic'
          ? '라이센스에 배민 기본 답글 기능이 포함되어 있지 않습니다.'
          : '라이센스에 배민 프리미엄 답글 기능이 포함되어 있지 않습니다.';
      }
    }

    if (selected.baeminBlind && features.baeminBlind !== true) {
      return '라이센스에 배민 블라인드 기능이 포함되어 있지 않습니다.';
    }

    if (selected.coupangReply) {
      const mode = String(currentSettings.coupangReplyMode || resolveReplyModeFromLicense(features, 'coupang'));
      const featureKey = mode === 'basic' ? 'coupangReplyBasic' : 'coupangReplyPremium';
      const hasExplicitTier = Object.prototype.hasOwnProperty.call(features || {}, featureKey);
      if (features[featureKey] !== true && (hasExplicitTier || features.coupangReply !== true)) {
        return mode === 'basic'
          ? '라이센스에 쿠팡 기본 답글 기능이 포함되어 있지 않습니다.'
          : '라이센스에 쿠팡 프리미엄 답글 기능이 포함되어 있지 않습니다.';
      }
    }

    if (selected.coupangBlind && features.coupangBlind !== true) {
      return '라이센스에 쿠팡 블라인드 기능이 포함되어 있지 않습니다.';
    }

    if (selected.naverMail && features.naverMail !== true) {
      return '라이센스에 네이버 메일 기능이 포함되어 있지 않습니다.';
    }

    return null;
  }

  function validatePreparedSettings(settings = {}, selected = {}) {
    const selectedCount = Object.values(selected).filter(Boolean).length;
    if (selectedCount > 1) {
      return '실행 기능은 한 번에 1가지만 선택할 수 있습니다.';
    }

    if (!Object.values(selected).some(Boolean)) {
      return '실행할 기능을 1개 이상 선택해주세요.';
    }

    if (!settings.storeName) {
      return '매장명을 입력해주세요.';
    }

    if ((selected.baeminReply || selected.baeminBlind || selected.naverMail) && !settings.baeminStoreId) {
      return '배민 스토어 아이디를 입력해주세요.';
    }

    if ((selected.coupangReply || selected.coupangBlind) && !settings.coupangStoreId) {
      return '쿠팡 스토어 아이디를 입력해주세요.';
    }

    if ((selected.coupangReply || selected.coupangBlind) && !settings.bizNo) {
      return '사업자등록번호를 입력해주세요.';
    }

    if (selected.naverMail && !settings.idCardPath) {
      return '네이버 메일용 신분증 이미지 경로를 선택해주세요.';
    }

    return null;
  }

  function hasVerifiedLicense(license) {
    if (!license?.licenseKey) return false;
    if (!license?.verifiedAt) return false;
    if (!license?.deviceFingerprint) return false;
    if (license.deviceFingerprint !== DEVICE_FINGERPRINT) return false;
    if (!hasValidLicenseIntegrity(license)) return false;
    return true;
  }

  function buildIntegrityReport() {
    const targets = [];
    try {
      if (app.isPackaged) {
        targets.push(path.join(process.resourcesPath, 'app.asar'));
        targets.push(path.join(getPackagedBaseDir(), 'bot', 'runner.js'));
        targets.push(path.join(getPackagedBaseDir(), 'gptClient.js'));
      } else {
        targets.push(path.join(__dirname, 'main.js'));
        targets.push(path.join(__dirname, 'preload.js'));
        targets.push(path.join(__dirname, '..', 'gptClient.js'));
        targets.push(path.join(__dirname, '..', 'bot', 'runner.js'));
      }
    } catch {}

    return targets
      .filter((filePath) => fs.existsSync(filePath) && fs.statSync(filePath).isFile())
      .map((filePath) => ({
        name: path.basename(filePath),
        sha256: sha256File(filePath),
      }));
  }

  async function verifyLicenseWithServer(licenseKey, serverBaseUrl = getServerBaseUrl()) {
    const url = `${serverBaseUrl}/api/license/verify`;
    let response;
    try {
      response = await fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            licenseKey: String(licenseKey || '').trim(),
            deviceFingerprint: DEVICE_FINGERPRINT,
            deviceId: DEVICE_FINGERPRINT,
            appVersion: app.getVersion(),
            platform: process.platform,
            integrity: buildIntegrityReport(),
          }),
        },
        20000
      );
    } catch (error) {
      throw new Error(explainFetchFailure(error, serverBaseUrl, '라이센스 서버'));
    }

    if (!response.ok) {
      throw new Error(`라이센스 서버 응답 오류 (${response.status})`);
    }

    const result = await response.json();
    if (!result.ok) {
      throw new Error(result.error || '라이센스 검증 실패');
    }

    const payload = withLicenseIntegrity({
      ...EMPTY_LICENSE,
      licenseKey: String(licenseKey || '').trim(),
      customerName: result.customerName || '-',
      expiresAt: result.expiresAt || '',
      features: result.features || {},
      statusText: '정상',
      statusType: 'ok',
      verifiedAt: new Date().toISOString(),
      nextCheckAt: result.nextCheckAt || new Date(Date.now() + LICENSE_RECHECK_INTERVAL_MS).toISOString(),
      deviceFingerprint: DEVICE_FINGERPRINT,
      savedAt: new Date().toISOString(),
    });

    saveJson(licensePath, payload);
    syncRuntimeFile();
    return payload;
  }

  async function requireFreshLicense() {
    const savedLicense = loadJson(licensePath, EMPTY_LICENSE);
    if (!hasVerifiedLicense(savedLicense)) {
      throw new Error('서버 검증된 라이센스가 아닙니다. 확인 버튼으로 서버 검증을 먼저 완료해주세요.');
    }

    const nextCheckTime = new Date(savedLicense.nextCheckAt || savedLicense.verifiedAt || '').getTime();
    if (!Number.isFinite(nextCheckTime) || Date.now() >= nextCheckTime) {
      return verifyLicenseWithServer(savedLicense.licenseKey);
    }

    return savedLicense;
  }

  function cleanupPreparedChildren() {
    for (const [, child] of preparedChildren.entries()) {
      try {
        child.stdin?.end();
      } catch {}

      try {
        if (process.platform === 'win32' && child.pid) {
          try {
            execSync(`taskkill /PID ${child.pid} /F /T`, { stdio: 'ignore', windowsHide: true });
          } catch {}
        } else if (!child.killed) {
          child.kill('SIGKILL');
        }
      } catch {}
    }

    preparedChildren.clear();
    resetFeatureRestartAttempts();
    hasStarted = false;
  }

  function getPackagedBaseDir() {
    return path.join(process.resourcesPath, 'app.asar.unpacked');
  }

  function getSourceBaseDir() {
    return app.isPackaged ? getPackagedBaseDir() : path.join(__dirname, '..');
  }

  function getRuntimeBaseDir() {
    return userDataPath;
  }

  function getRunnerPath() {
    const baseDir = getSourceBaseDir();
    return path.join(baseDir, 'bot', 'runner.js');
  }

  function scheduleFeatureRestart(featureKey, cause = {}) {
    if (!hasStarted) return;
    if (!preparedState?.selected?.[featureKey]) return;
    if (isIntentionalShutdown) return;

    const attempts = Number(featureRestartAttempts.get(featureKey) || 0);
    if (attempts >= FEATURE_RESTART_MAX_ATTEMPTS) {
      sendLog(`[복구] ${featureKey} 자동 재시작 한도 도달 (${attempts}/${FEATURE_RESTART_MAX_ATTEMPTS})`);
      notifyUser('기능 복구 실패', `${featureKey} 기능 재시작 한도에 도달했습니다. 확인이 필요합니다.`);
      return;
    }

    const nextAttempt = attempts + 1;
    featureRestartAttempts.set(featureKey, nextAttempt);
    sendLog(`[복구] ${featureKey} 비정상 종료 감지 -> ${FEATURE_RESTART_DELAY_MS}ms 후 재시작 (${nextAttempt}/${FEATURE_RESTART_MAX_ATTEMPTS})`);
    setTimeout(() => {
      if (isIntentionalShutdown) return;
      if (!hasStarted) return;
      if (!preparedState?.selected?.[featureKey]) return;
      if (preparedChildren.has(featureKey)) return;

      try {
        spawnPreparedFeature(featureKey, preparedState.settings || loadSettingsJson());
        sendEnterToPreparedChildren();
      } catch (error) {
        appendUserError('feature.auto_restart_failed', error, {
          featureKey,
          attempt: nextAttempt,
          cause,
        });
        sendLog(`[복구] ${featureKey} 자동 재시작 실패: ${error.message}`);
      }
    }, FEATURE_RESTART_DELAY_MS);
  }

  function spawnPreparedFeature(featureKey, settings) {
    const featureMeta = getFeatureMeta(featureKey);
    if (!featureMeta) {
      throw new Error(`알 수 없는 기능입니다: ${featureKey}`);
    }

    const runtimeBaseDir = getRuntimeBaseDir();
    const sourceBaseDir = getSourceBaseDir();
    const runnerPath = getRunnerPath();
    const nodeModulesPath = path.join(sourceBaseDir, 'node_modules');

    if (!fs.existsSync(runnerPath)) {
      throw new Error(`runner.js 파일이 없습니다: ${runnerPath}`);
    }

    const payload = Buffer.from(
      JSON.stringify({
        featureKey,
        settings,
      }),
      'utf-8'
    ).toString('base64');

    const child = spawn(process.execPath, [runnerPath, payload], {
      cwd: sourceBaseDir,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        NODE_PATH: nodeModulesPath,
        RUNTIME_PATH: runtimePath,
        CHUNGDAM_RUNTIME_DIR: runtimeBaseDir,
        SERVER_BASE_URL: getServerBaseUrl(),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: false,
    });

    child.stdout.on('data', (chunk) => {
      const text = String(chunk || '');
      text.split(/\r?\n/).forEach((line) => {
        if (line.trim()) {
          sendLog(`[${featureMeta.label}] ${line}`);
        }
      });
    });

    child.stderr.on('data', (chunk) => {
      const text = String(chunk || '');
      text.split(/\r?\n/).forEach((line) => {
        if (line.trim()) {
          sendLog(`[${featureMeta.label}][에러] ${line}`);
        }
      });
    });

    child.on('exit', (code, signal) => {
      preparedChildren.delete(featureKey);
      sendLog(`[${featureMeta.label}] 프로세스 종료 (code=${code}, signal=${signal || 'none'})`);
      const normalExit = Number(code || 0) === 0 && !signal;
      if (normalExit) {
        resetFeatureRestartAttempts(featureKey);
        return;
      }
      appendUserError('feature.process_exit_abnormal', new Error(`${featureMeta.label} exited`), {
        featureKey,
        code,
        signal: signal || '',
        started: hasStarted,
      });
      scheduleFeatureRestart(featureKey, { code, signal: signal || '' });
    });

    child.on('error', (error) => {
      preparedChildren.delete(featureKey);
      sendLog(`[${featureMeta.label}] 프로세스 실행 실패: ${error.message}`);
      appendUserError('feature.process_spawn_error', error, {
        featureKey,
        started: hasStarted,
      });
      scheduleFeatureRestart(featureKey, { error: error.message });
    });

    preparedChildren.set(featureKey, child);
    sendLog(`[${featureMeta.label}] 준비 프로세스 시작`);
  }

  function sendEnterToPreparedChildren() {
    for (const [featureKey, child] of preparedChildren.entries()) {
      const featureMeta = getFeatureMeta(featureKey);

      try {
        child.stdin.write('\n');
        sendLog(`[${featureMeta.label}] 시작 신호 전달`);
      } catch (error) {
        sendLog(`[${featureMeta.label}] 시작 신호 전달 실패: ${error.message}`);
      }
    }
  }

  function removePathIfExists(targetPath, deletedPaths = []) {
    if (!targetPath) return;

    try {
      if (!fs.existsSync(targetPath)) return;

      fs.rmSync(targetPath, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 200,
      });

      deletedPaths.push(targetPath);
    } catch (error) {
      throw new Error(`삭제 실패: ${targetPath} (${error.message})`);
    }
  }

  function resetPreparedState() {
    cleanupPreparedChildren();
    preparedState = null;
    hasStarted = false;
  }

  function listLogFilesByPrefix(prefix = '') {
    const logsDir = path.join(getRuntimeBaseDir(), 'logs');
    if (!fs.existsSync(logsDir)) return [];
    return fs.readdirSync(logsDir)
      .filter((name) => name.startsWith(prefix))
      .map((name) => path.join(logsDir, name))
      .sort();
  }

  function summarizeErrorLogs() {
    const logsDir = path.join(getRuntimeBaseDir(), 'logs');
    const errorFiles = listLogFilesByPrefix('user-errors-').filter((file) => file.endsWith('.jsonl'));
    const screenshotFiles = listLogFilesByPrefix('coupang-happytalk-').filter((file) => file.endsWith('.png'));
    const debugJsonFiles = listLogFilesByPrefix('coupang-happytalk-').filter((file) => file.endsWith('.json'));
    const byArea = new Map();
    const byMessage = new Map();
    const recent = [];

    for (const file of errorFiles) {
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        let item = null;
        try {
          item = JSON.parse(line);
        } catch {
          continue;
        }

        const area = String(item.area || 'unknown');
        const message = String(item.error?.message || item.error || 'unknown');
        byArea.set(area, (byArea.get(area) || 0) + 1);
        byMessage.set(message, (byMessage.get(message) || 0) + 1);
        recent.push({
          at: item.at || '',
          area,
          message,
          orderNumber: item.context?.review?.orderNumber || item.context?.orderNumber || '',
          customerName: item.context?.review?.customerName || item.context?.customerName || '',
        });
      }
    }

    const sortEntries = (map) => Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
    const lines = [];
    lines.push(`[오류 요약] ${new Date().toLocaleString('ko-KR')}`);
    lines.push(`로그 폴더: ${logsDir}`);
    lines.push(`오류 로그 파일: ${errorFiles.length}개`);
    lines.push(`해피톡 스크린샷: ${screenshotFiles.length}개`);
    lines.push(`해피톡 후보 JSON: ${debugJsonFiles.length}개`);
    lines.push('');
    lines.push('[문제 영역 TOP]');
    sortEntries(byArea).slice(0, 12).forEach(([area, count]) => lines.push(`- ${area}: ${count}건`));
    if (!byArea.size) lines.push('- 기록된 오류가 없습니다.');
    lines.push('');
    lines.push('[오류 메시지 TOP]');
    sortEntries(byMessage).slice(0, 12).forEach(([message, count]) => lines.push(`- ${message}: ${count}건`));
    if (!byMessage.size) lines.push('- 기록된 오류 메시지가 없습니다.');
    lines.push('');
    lines.push('[최근 오류]');
    recent.slice(-10).reverse().forEach((item) => {
      const reviewText = [item.customerName, item.orderNumber].filter(Boolean).join(' / ');
      lines.push(`- ${item.at} / ${item.area} / ${item.message}${reviewText ? ` / ${reviewText}` : ''}`);
    });
    if (!recent.length) lines.push('- 최근 오류가 없습니다.');
    lines.push('');
    lines.push('[최근 해피톡 캡처]');
    screenshotFiles.slice(-5).reverse().forEach((file) => lines.push(`- ${file}`));
    if (!screenshotFiles.length) lines.push('- 해피톡 캡처가 없습니다.');

    return {
      ok: true,
      logsDir,
      text: lines.join('\n'),
      counts: {
        errorFiles: errorFiles.length,
        screenshots: screenshotFiles.length,
        debugJson: debugJsonFiles.length,
        errors: recent.length,
      },
    };
  }



  function normalizeAnalysisText(value = '') {
    return String(value || '')
      .replace(/\r/g, '')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function buildReviewCategoryList(text = '') {
    const source = normalizeAnalysisText(text).toLowerCase();
    const rules = [
      { key: '맛', patterns: ['맛없', '별로', '싱겁', '짜', '달', '맵', '쓴맛', '비리', '느끼', '불맛', '간이', '향이'] },
      { key: '양', patterns: ['양이', '적다', '적어요', '푸짐', '양 많', '양이 많', '부족'] },
      { key: '누락/구성', patterns: ['누락', '빠졌', '안왔', '없어요', '소스', '국물', '구성', '추가', '덜 왔'] },
      { key: '포장/배달상태', patterns: ['쏟', '흘', '식었', '포장', '배달', '눅눅', '새서', '터졌'] },
      { key: '면/밥 식감', patterns: ['면이', '불었', '퍼졌', '고슬고슬', '질', '떡졌', '딱딱', '식감', '눅눅'] },
      { key: '위생', patterns: ['머리카락', '이물', '위생', '더럽', '벌레', '수세미'] },
      { key: '서비스/응대', patterns: ['불친절', '응대', '전화', '서비스', '대응', '친절'] },
      { key: '가격/가성비', patterns: ['비싸', '가성비', '가격', '돈 아깝'] },
    ];

    const found = rules
      .filter((rule) => rule.patterns.some((pattern) => source.includes(pattern)))
      .map((rule) => rule.key);

    return found.length ? found : ['기타'];
  }

  function parseReviewLogEntries(raw = '') {
    const normalized = String(raw || '').replace(/\r/g, '');
    const blocks = normalized
      .split(/\n\s*\n+/)
      .map((block) => block.trim())
      .filter(Boolean)
      .filter((block) => block.includes('리뷰번호:'));

    return blocks.map((block) => {
      const entry = {
        raw: block,
        reviewId: '',
        date: '',
        rating: null,
        reviewType: '',
        orderMenu: '',
        body: '',
      };

      block.split('\n').forEach((line) => {
        const idx = line.indexOf(':');
        if (idx < 0) return;
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim();

        if (key === '리뷰번호') entry.reviewId = value;
        if (key === '리뷰작성일') entry.date = value;
        if (key === '별점') {
          const num = Number(String(value).replace(/[^0-9.]/g, ''));
          entry.rating = Number.isFinite(num) ? num : null;
        }
        if (key === '유형') entry.reviewType = value;
        if (key === '주문메뉴') entry.orderMenu = value;
        if (key === '본문') entry.body = value;
      });

      entry.body = entry.body || '(없음)';
      entry.orderMenu = entry.orderMenu || '(없음)';
      entry.categories = buildReviewCategoryList(entry.body);
      return entry;
    });
  }

  function createEmptyAnalysis() {
    return {
      summary: {
        totalReviews: 0,
        lowRatingReviews: 0,
        complaintReviews: 0,
        files: [],
      },
      byRating: {},
      byCategory: {},
      byMenu: {},
      lowRatingMenus: {},
      lowRatingCategories: {},
      recentLowRatingReviews: [],
    };
  }

  function sortCountObject(obj = {}) {
    return Object.fromEntries(
      Object.entries(obj).sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        return String(a[0]).localeCompare(String(b[0]), 'ko');
      })
    );
  }

  function getReviewAnalysisData() {
    return collectReviewAnalysisData();
    const logsDir = path.join(getRuntimeBaseDir(), 'logs');
    const analysis = createEmptyAnalysis();

    if (!fs.existsSync(logsDir)) {
      return analysis;
    }

    const files = fs
      .readdirSync(logsDir)
      .filter((name) => /^review-log-\d{4}-(03|04|05)\.txt$/i.test(name))
      .sort();

    analysis.summary.files = files;

    const dedupe = new Set();
    const entries = [];

    for (const name of files) {
      const filePath = path.join(logsDir, name);
      const raw = fs.readFileSync(filePath, 'utf8');
      for (const entry of parseReviewLogEntries(raw)) {
        const key = entry.reviewId || `${name}:${entry.date}:${entry.body}`;
        if (dedupe.has(key)) continue;
        dedupe.add(key);
        entries.push(entry);
      }
    }

    analysis.summary.totalReviews = entries.length;

    for (const entry of entries) {
      const ratingKey = entry.rating == null ? '미확인' : `${entry.rating}점`;
      analysis.byRating[ratingKey] = (analysis.byRating[ratingKey] || 0) + 1;

      const menuKey = entry.orderMenu || '(없음)';
      analysis.byMenu[menuKey] = (analysis.byMenu[menuKey] || 0) + 1;

      const isLowRating = typeof entry.rating === 'number' && entry.rating <= 3;
      if (isLowRating) {
        analysis.summary.lowRatingReviews += 1;
        analysis.lowRatingMenus[menuKey] = (analysis.lowRatingMenus[menuKey] || 0) + 1;
      }

      let hasComplaint = false;
      for (const category of entry.categories) {
        analysis.byCategory[category] = (analysis.byCategory[category] || 0) + 1;
        if (isLowRating) {
          analysis.lowRatingCategories[category] = (analysis.lowRatingCategories[category] || 0) + 1;
        }
        if (category !== '기타') hasComplaint = true;
      }

      if (hasComplaint) {
        analysis.summary.complaintReviews += 1;
      }

      if (isLowRating) {
        analysis.recentLowRatingReviews.push({
          reviewId: entry.reviewId || '(없음)',
          date: entry.date || '(없음)',
          rating: entry.rating,
          orderMenu: menuKey,
          body: entry.body || '(없음)',
          categories: entry.categories,
        });
      }
    }

    analysis.byRating = sortCountObject(analysis.byRating);
    analysis.byCategory = sortCountObject(analysis.byCategory);
    analysis.byMenu = sortCountObject(analysis.byMenu);
    analysis.lowRatingMenus = sortCountObject(analysis.lowRatingMenus);
    analysis.lowRatingCategories = sortCountObject(analysis.lowRatingCategories);
    analysis.recentLowRatingReviews = analysis.recentLowRatingReviews.slice(-8).reverse();

    return analysis;
  }

  function getCoupangResetTargets() {
    const baseDir = getRuntimeBaseDir();
    const targets = [
      path.join(baseDir, 'chrome-profile-coupang'),
      path.join(baseDir, 'chrome-profile-coupang-real'),
      path.join(baseDir, 'auth', 'coupang-storage.json'),
    ];

    return {
      baseDir,
      targets,
      authDir: path.join(baseDir, 'auth'),
    };
  }

  // ===== 설정 저장 =====
  ipcMain.handle('save-settings', async (_, data) => {
    try {
      const savedLicense = loadJson(licensePath, EMPTY_LICENSE);
      const safeInput = sanitizeThreadsSecuritySettings(data || {});
      saveSettingsJson({
        ...EMPTY_SETTINGS,
        ...safeInput,
        ...applyLicensedReplyModes(safeInput, savedLicense.features || {}),
        serverBaseUrl: getServerBaseUrl(safeInput?.serverBaseUrl),
      });
      syncRuntimeFile();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('load-settings', async () => {
    const savedLicense = loadJson(licensePath, EMPTY_LICENSE);
    const settings = loadSettingsJson();
    return {
      ...EMPTY_SETTINGS,
      ...settings,
      ...applyLicensedReplyModes(settings, savedLicense.features || {}),
      serverBaseUrl: getServerBaseUrl(),
    };
  });

  ipcMain.handle('check-server-connection', async (_, payload) => {
    try {
      const serverBaseUrl = getServerBaseUrl(payload?.serverBaseUrl);
      const response = await fetchWithTimeout(`${serverBaseUrl}/health`, { method: 'GET' }, 15000);

      if (!response.ok) {
        return { ok: false, error: `서버 응답 오류 (${response.status})` };
      }

      return {
        ok: true,
        serverBaseUrl,
        data: await response.json(),
      };
    } catch (error) {
      return { ok: false, error: explainFetchFailure(error, getServerBaseUrl(payload?.serverBaseUrl), '라이센스 서버') };
    }
  });

  ipcMain.handle('check-app-update', async () => {
    try {
      return await checkAndInstallUpdate();
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  // ===== 라이센스 저장 =====
ipcMain.handle('save-license', async (_, data) => {
  try {
    const licenseKey = String(data?.licenseKey || '').trim();
    const serverBaseUrl = getServerBaseUrl(data?.serverBaseUrl);
    const previousLicense = loadJson(licensePath, EMPTY_LICENSE);

    if (!licenseKey) {
      return { ok: false, error: '라이센스 키를 입력해주세요.' };
    }

    // 1. 저장
    const next = {
      ...EMPTY_LICENSE,
      licenseKey,
      statusText: '확인중',
      statusType: 'loading',
      verifiedAt: '',
      deviceFingerprint: '',
      savedAt: new Date().toISOString(),
    };

    saveJson(licensePath, next);
    syncRuntimeFile();

    sendLog(`[라이센스] 자동 검증 시작: ${hashValue(licenseKey)}`);
    appendSecurityAudit('license', 'save_license_requested', {
      keyHash: hashValue(licenseKey),
      serverBaseUrl,
    });

    // 2. 자동 검증 (🔥 핵심)
    let response;
    try {
      response = await fetchWithTimeout(
        `${serverBaseUrl}/api/license/verify`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            licenseKey,
            deviceFingerprint: DEVICE_FINGERPRINT,
            deviceId: DEVICE_FINGERPRINT,
            appVersion: app.getVersion(),
            platform: process.platform,
            integrity: buildIntegrityReport(),
          }),
        },
        20000
      );
    } catch (error) {
      throw new Error(explainFetchFailure(error, serverBaseUrl, '라이센스 서버'));
    }

    if (!response.ok) {
      if (hasVerifiedLicense(previousLicense)) {
        saveJson(licensePath, previousLicense);
        syncRuntimeFile();
      }
      return { ok: false, error: `서버 응답 오류 (${response.status})` };
    }

    const result = await response.json();

    if (!result.ok) {
      if (hasVerifiedLicense(previousLicense)) {
        saveJson(licensePath, previousLicense);
        syncRuntimeFile();
      }
      return { ok: false, error: result.error || '라이센스 검증 실패' };
    }

    // 3. 검증 완료 저장
    const payload = withLicenseIntegrity({
      ...EMPTY_LICENSE,
      licenseKey,
      customerName: result.customerName || '-',
      expiresAt: result.expiresAt || '',
      features: result.features || {},
      statusText: '정상',
      statusType: 'ok',
      verifiedAt: new Date().toISOString(),
      nextCheckAt: result.nextCheckAt || new Date(Date.now() + LICENSE_RECHECK_INTERVAL_MS).toISOString(),
      deviceFingerprint: DEVICE_FINGERPRINT,
      savedAt: new Date().toISOString(),
    });

    saveJson(licensePath, payload);
    syncRuntimeFile();

    sendLog('[라이센스] 자동 검증 완료');
    appendSecurityAudit('license', 'save_license_verified', {
      keyHash: hashValue(licenseKey),
      customerName: payload.customerName || '',
    });

    return { ok: true, data: payload };
  } catch (error) {
    appendSecurityAudit('license', 'save_license_failed', {
      message: error?.message || String(error),
    });
    const previousLicense = loadJson(licensePath, EMPTY_LICENSE);
    if (hasVerifiedLicense(previousLicense)) {
      saveJson(licensePath, previousLicense);
      syncRuntimeFile();
    }
    return {
      ok: false,
      error: `라이센스 저장/검증 실패: ${error.message}`,
    };
  }
});

  // ===== 라이센스 불러오기 =====
  ipcMain.handle('load-license', async () => {
    return loadJson(licensePath, EMPTY_LICENSE);
  });

  // ===== 라이센스 서버 검증 =====
  ipcMain.handle('verify-license', async (_, data) => {
    try {
      const licenseKey = String(data?.licenseKey || '').trim();
      const serverBaseUrl = getServerBaseUrl(data?.serverBaseUrl);

      if (!licenseKey) {
        return { ok: false, error: '라이센스 키를 입력해주세요.' };
      }

      sendLog(`[라이센스] 서버 확인 요청: ${hashValue(licenseKey)}`);

      let response;
      try {
        response = await fetchWithTimeout(
          `${serverBaseUrl}/api/license/verify`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              licenseKey,
              deviceFingerprint: DEVICE_FINGERPRINT,
              deviceId: DEVICE_FINGERPRINT,
              appVersion: app.getVersion(),
              platform: process.platform,
              integrity: buildIntegrityReport(),
            }),
          },
          20000
        );
      } catch (error) {
        return { ok: false, error: explainFetchFailure(error, serverBaseUrl, '라이센스 서버') };
      }

      if (!response.ok) {
        return { ok: false, error: `서버 응답 오류 (${response.status})` };
      }

      const result = await response.json();

      if (!result.ok) {
        return { ok: false, error: result.error || '라이센스 검증 실패' };
      }

      const payload = withLicenseIntegrity({
        ...EMPTY_LICENSE,
        licenseKey,
        customerName: result.customerName || '-',
        expiresAt: result.expiresAt || '',
        features: result.features || {},
        statusText: '정상',
        statusType: 'ok',
        verifiedAt: new Date().toISOString(),
        nextCheckAt: result.nextCheckAt || new Date(Date.now() + LICENSE_RECHECK_INTERVAL_MS).toISOString(),
        deviceFingerprint: DEVICE_FINGERPRINT,
        savedAt: new Date().toISOString(),
      });

      saveJson(licensePath, payload);
      syncRuntimeFile();

      sendLog('[라이센스] 확인 완료');
      return { ok: true, data: payload };
    } catch (error) {
      return {
        ok: false,
        error: `라이센스 서버 연결 실패: ${error.message}`,
      };
    }
  });

  // ===== 준비 =====
  ipcMain.handle('prepare-bot', async (_, data) => {
    try {
      sendLog('[시스템] 준비 시작');

      const selected = data?.selected || {};
      const settings = data?.settings || {};
      let savedLicense = await requireFreshLicense();
      const licensedSettings = applyLicensedReplyModes(settings, savedLicense.features || {});

      if (!hasVerifiedLicense(savedLicense)) {
        return { ok: false, error: '라이센스를 저장만 한 상태입니다. 확인 버튼으로 서버 검증을 먼저 완료해주세요.' };
      }

      const expiresTime = new Date(savedLicense.expiresAt || '').getTime();
      if (!Number.isNaN(expiresTime) && Date.now() > expiresTime) {
        return { ok: false, error: '만료된 라이센스입니다.' };
      }

      const featureError = validateFeatureAccess(selected, savedLicense.features || {}, licensedSettings);
      if (featureError) {
        return { ok: false, error: featureError };
      }

      const settingsError = validatePreparedSettings(licensedSettings, selected);
      if (settingsError) {
        return { ok: false, error: settingsError };
      }
      const toggleMap = [
        ['baeminReply', 'baeminReply'],
        ['baeminBlind', 'baeminBlind'],
        ['coupangReply', 'coupangReply'],
        ['coupangBlind', 'coupangBlind'],
        ['naverMail', 'naverMail'],
      ];
      for (const [selectedKey, toggleKey] of toggleMap) {
        if (selected[selectedKey] && !isFeatureEnabledByMobile(toggleKey, licensedSettings)) {
          return { ok: false, error: `모바일 원격제어에서 ${selectedKey} 기능이 OFF 상태입니다.` };
        }
      }

      saveSettingsJson({
        ...EMPTY_SETTINGS,
        ...(licensedSettings || {}),
      });
      syncRuntimeFile();

      cleanupPreparedChildren();

      const featureKeys = getSelectedFeatureKeys(selected);
      if (!featureKeys.length) {
        return { ok: false, error: '실행할 기능을 1개 이상 선택해주세요.' };
      }

      preparedState = {
        selected,
        settings: licensedSettings,
        preparedAt: new Date().toISOString(),
      };
      hasStarted = false;

      sendLog('[시스템] 선택 기능: ' + JSON.stringify(selected));
      sendLog('[시스템] 매장 설정 불러옴: ' + JSON.stringify({
        storeName: licensedSettings.storeName || '',
        baeminStoreId: licensedSettings.baeminStoreId || '',
        coupangStoreId: licensedSettings.coupangStoreId || '',
        bizNo: licensedSettings.bizNo || '',
        hasReviewRule: !!licensedSettings.reviewRule,
        hasIdCardPath: !!licensedSettings.idCardPath,
        baeminReplyMode: licensedSettings.baeminReplyMode,
        coupangReplyMode: licensedSettings.coupangReplyMode,
      }));
      sendLog('[시스템] runtime.json 동기화 완료');

      for (const featureKey of featureKeys) {
        spawnPreparedFeature(featureKey, licensedSettings);
      }

      sendLog('[시스템] 준비 완료');
      sendLog('[시스템] 브라우저에서 로그인/필터 설정 후 시작 버튼을 눌러주세요.');
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  // ===== 시작 =====
  ipcMain.handle('start-bot', async () => {
    try {
      if (!preparedState) {
        return { ok: false, error: '먼저 준비 버튼을 눌러주세요.' };
      }

      if (!preparedChildren.size) {
        return { ok: false, error: '준비된 브라우저 프로세스가 없습니다. 다시 준비를 눌러주세요.' };
      }

      if (hasStarted) {
        return { ok: false, error: '이미 시작 신호를 보냈습니다.' };
      }

      const savedLicense = await requireFreshLicense();

      if (!hasVerifiedLicense(savedLicense)) {
        return { ok: false, error: '서버 검증된 라이센스가 아닙니다. 확인 버튼을 다시 눌러주세요.' };
      }

      const expiresTime = new Date(savedLicense.expiresAt || '').getTime();
      if (!Number.isNaN(expiresTime) && Date.now() > expiresTime) {
        return { ok: false, error: '만료된 라이센스입니다.' };
      }

      const featureError = validateFeatureAccess(
        preparedState.selected,
        savedLicense.features || {},
        applyLicensedReplyModes(preparedState.settings || {}, savedLicense.features || {})
      );
      if (featureError) {
        return { ok: false, error: featureError };
      }
      const currentSettings = sanitizeThreadsSecuritySettings(loadSettingsJson());
      const toggleMap = [
        ['baeminReply', 'baeminReply'],
        ['baeminBlind', 'baeminBlind'],
        ['coupangReply', 'coupangReply'],
        ['coupangBlind', 'coupangBlind'],
        ['naverMail', 'naverMail'],
      ];
      for (const [selectedKey, toggleKey] of toggleMap) {
        if (preparedState.selected?.[selectedKey] && !isFeatureEnabledByMobile(toggleKey, currentSettings)) {
          return { ok: false, error: `모바일 원격제어에서 ${selectedKey} 기능이 OFF 상태입니다.` };
        }
      }

      hasStarted = true;
      for (const featureKey of getSelectedFeatureKeys(preparedState.selected || {})) {
        resetFeatureRestartAttempts(featureKey);
      }
      sendLog('[시스템] 시작 요청 수신');
      sendLog('[시스템] 준비된 브라우저에 시작 신호 전달');

      sendEnterToPreparedChildren();

      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });


  // ===== 중지 =====
  ipcMain.handle('stop-bot', async () => {
    try {
      const running = preparedChildren.size;
      resetPreparedState();
      sendLog(`[시스템] 중지 요청 수신`);
      sendLog(`[시스템] 실행/대기 프로세스 ${running}개 정리 완료`);
      sendLog('[시스템] 준비상태로 복귀');
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  // ===== 쿠팡 리셋 =====
  ipcMain.handle('reset-coupang', async () => {
    try {
      sendLog('[쿠팡 리셋] 요청 수신');

      // ===== 1. 프로세스 강제 종료 =====
      try { execSync('taskkill /F /IM chrome.exe /T'); } catch {}
      try { execSync('taskkill /F /IM msedge.exe /T'); } catch {}
      try { execSync('taskkill /F /IM playwright.exe /T'); } catch {}
      try { execSync('taskkill /F /IM node.exe /T'); } catch {}

      sendLog('[쿠팡 리셋] 브라우저 프로세스 종료 완료');

      // ===== 2. 기존 준비 상태 초기화 =====
      resetPreparedState();

      // ===== 3. 기존 삭제 로직 =====
      const { targets, authDir } = getCoupangResetTargets();
      const deletedPaths = [];

      for (const target of targets) {
        removePathIfExists(target, deletedPaths);
      }

      // ===== 4. auth 폴더 정리 =====
      try {
        if (fs.existsSync(authDir)) {
          const remain = fs.readdirSync(authDir);
          if (!remain.length) {
            fs.rmSync(authDir, {
              recursive: true,
              force: true,
              maxRetries: 3,
              retryDelay: 200,
            });
            deletedPaths.push(authDir);
          }
        }
      } catch (error) {
        throw new Error(`auth 폴더 정리 실패: ${error.message}`);
      }

      // ===== 5. temp 캐시 제거 (추가) =====
      try {
        const tempDir = path.join(os.tmpdir(), 'playwright');
        if (fs.existsSync(tempDir)) {
          fs.rmSync(tempDir, { recursive: true, force: true });
          deletedPaths.push(tempDir);
          sendLog('[쿠팡 리셋] playwright temp 삭제 완료');
        }
      } catch {}

      if (!deletedPaths.length) {
        sendLog('[쿠팡 리셋] 삭제할 쿠팡 데이터 없음');
        return { ok: true, deletedPaths: [] };
      }

      deletedPaths.forEach((p) => {
        sendLog(`[쿠팡 리셋] 삭제 완료: ${p}`);
      });

      sendLog('[쿠팡 리셋] 완료 (재부팅 없이 초기화 성공)');
      return { ok: true, deletedPaths };

    } catch (error) {
      sendLog(`[쿠팡 리셋][에러] ${error.message}`);
      return { ok: false, error: error.message };
    }
  });


  // ===== 리뷰 분석 =====
  ipcMain.handle('get-review-analysis', async () => {
    try {
      return { ok: true, data: getReviewAnalysisData() };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  // ===== 신분증 선택 =====
  ipcMain.handle('pick-idcard', async () => {
    try {
      const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [
          { name: '이미지', extensions: ['jpg', 'jpeg', 'png', 'webp'] },
          { name: '모든 파일', extensions: ['*'] },
        ],
      });

      if (result.canceled || !result.filePaths?.length) {
        return { ok: false, error: '파일 선택 취소' };
      }

      return { ok: true, path: result.filePaths[0] };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('pick-finance-file', async () => {
    try {
      const result = await dialog.showOpenDialog({
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: '거래파일', extensions: ['xlsx', 'xls', 'csv', 'txt'] },
          { name: '모든 파일', extensions: ['*'] },
        ],
      });

      if (result.canceled || !result.filePaths?.length) {
        return { ok: false, error: '파일 선택 취소' };
      }

      return { ok: true, path: result.filePaths[0], paths: result.filePaths };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  async function pickFinanceFiles() {
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '거래파일', extensions: ['xlsx', 'xls', 'csv', 'txt'] },
        { name: '모든 파일', extensions: ['*'] },
      ],
    });

    if (result.canceled || !result.filePaths?.length) {
      return { ok: false, error: '파일 선택 취소' };
    }

    return { ok: true, path: result.filePaths[0], paths: result.filePaths };
  }

  ipcMain.handle('pick-finance-deposit-files', async () => {
    try {
      return await pickFinanceFiles();
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('pick-finance-withdrawal-files', async () => {
    try {
      return await pickFinanceFiles();
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('analyze-finance-file', async (_, payload) => {
    try {
      const savedLicense = loadJson(licensePath, EMPTY_LICENSE);
      if (savedLicense.features?.financeAnalysis !== true) {
        return { ok: false, error: '라이센스에 재무 분석 기능이 포함되어 있지 않습니다.' };
      }

      const depositFilePaths = Array.isArray(payload?.depositFilePaths)
        ? payload.depositFilePaths.map((item) => String(item || '').trim()).filter(Boolean)
        : [];
      const withdrawalFilePaths = Array.isArray(payload?.withdrawalFilePaths)
        ? payload.withdrawalFilePaths.map((item) => String(item || '').trim()).filter(Boolean)
        : [];
      const filePaths = Array.isArray(payload?.filePaths)
        ? payload.filePaths.map((item) => String(item || '').trim()).filter(Boolean)
        : [];
      const filePath = String(payload?.filePath || '').trim();
      const depositText = String(payload?.depositText || '').trim();
      const withdrawalText = String(payload?.withdrawalText || '').trim();
      const vatMode = String(payload?.vatMode || 'general').trim();
      const settlementStartDay = Number(payload?.settlementStartDay || 5);
      const targets = depositFilePaths.length || withdrawalFilePaths.length
        ? [...depositFilePaths, ...withdrawalFilePaths]
        : (filePaths.length ? filePaths : (filePath ? [filePath] : []));

      if (!targets.length && !depositText && !withdrawalText) {
        return { ok: false, error: '분석할 거래 파일 또는 표준 붙여넣기 데이터를 입력해주세요.' };
      }

      const input = depositFilePaths.length || withdrawalFilePaths.length || depositText || withdrawalText
        ? { depositFilePaths, withdrawalFilePaths, depositText, withdrawalText }
        : targets;
      const baseOptions = {
        vatMode,
        settlementStartDay,
        workDir: app.getPath('temp'),
        memoryPath: financeMemoryPath,
      };

      let data = analyzeFinanceFile(input, baseOptions);
      if (Array.isArray(data.uncategorized) && data.uncategorized.length) {
        const categories = await classifyFinanceTransactions({ transactions: data.uncategorized });
        if (categories.length) {
          data = analyzeFinanceFile(input, {
            ...baseOptions,
            gptCategories: categories,
          });
        }
      }

      return { ok: true, data };
    } catch (error) {
      appendUserError('finance.analysis_failed', error, {
        filePath: payload?.filePath || '',
        filePaths: payload?.filePaths || [],
        depositFilePaths: payload?.depositFilePaths || [],
        withdrawalFilePaths: payload?.withdrawalFilePaths || [],
        hasDepositText: !!payload?.depositText,
        hasWithdrawalText: !!payload?.withdrawalText,
      });
      return { ok: false, error: error.message };
    }
  });

  // ===== 문의 링크 =====
  ipcMain.handle('analyze-store-click', async (_, payload) => {
    try {
      const tableText = String(payload?.tableText || '').trim();
      if (!tableText) {
        return { ok: false, error: '우리가게클릭 성과 표를 붙여넣어 주세요.' };
      }

      const localAnalysis = analyzeStoreClickText(tableText);
      const gptAnalysis = await analyzeStoreClickWithGpt({
        tableText,
        localAnalysis,
      });

      return {
        ok: true,
        data: {
          ...localAnalysis,
          gptAnalysis,
        },
      };
    } catch (error) {
      appendUserError('store_click.analysis_failed', error, {
        hasTableText: !!payload?.tableText,
      });
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('analyze-threads-marketing', async (_, payload) => {
    try {
      const savedLicense = loadJson(licensePath, EMPTY_LICENSE);
      const feats = savedLicense.features || {};
      if (feats.threadsMarketing !== true && feats.financeAnalysis !== true) {
        appendSecurityAudit('threads', 'blocked_by_license', {
          featureKeys: Object.keys(feats || {}),
        });
        return { ok: false, error: '라이센스에 스레드 GPT 초안(또는 재무 분석) 권한이 없습니다.' };
      }

      const settings = sanitizeThreadsSecuritySettings(loadSettingsJson());
      if (!isFeatureEnabledByMobile('threadsMarketing', settings)) {
        appendSecurityAudit('threads', 'blocked_by_mobile_toggle', { featureKey: 'threadsMarketing' });
        return { ok: false, error: '모바일 원격제어에서 스레드 기능이 OFF 상태입니다.' };
      }
      if (settings.threadsEmergencyStop === true) {
        appendSecurityAudit('threads', 'blocked_by_emergency_stop', {
          customerName: savedLicense.customerName || '',
        });
        notifyUser('스레드 긴급중지', '긴급중지 상태라 초안 생성을 차단했습니다.');
        return { ok: false, error: '긴급중지 상태입니다. 설정에서 스레드 긴급중지를 해제하세요.' };
      }
      const dailyLimit = normalizeThreadsDailyLimit(
        payload?.threadsDailyLimit ?? settings.threadsDailyLimit ?? resolveThreadsPlanLimit(settings),
      );
      const limitCheck = checkThreadsDailyRateLimit(dailyLimit);
      if (!limitCheck.ok) {
        appendSecurityAudit('threads', 'blocked_by_daily_limit', {
          maxPerDay: limitCheck.maxPerDay,
          usedCount: limitCheck.count,
        });
        notifyUser('스레드 제한 도달', limitCheck.message);
        return { ok: false, error: limitCheck.message };
      }
      const useThreadsApiSearch = payload?.useThreadsApiSearch !== false;
      const options = {
        accessToken: String(payload?.accessToken || settings.threadsAccessToken || '').trim(),
        apiBaseUrl: String(payload?.apiBaseUrl || settings.threadsApiBaseUrl || 'https://graph.threads.net/v1.0').trim(),
        keywords: payload?.keywords || settings.threadsKeywords || '',
        manualPosts: String(payload?.manualPosts || '').trim(),
        reviewReplyExamples: String(payload?.reviewReplyExamples ?? settings.threadsReviewReplyExamples ?? '').trim(),
        useThreadsApiSearch,
        direction: String(payload?.direction || settings.threadsDraftDirection || '').trim(),
        days: 7,
        limit: 20,
      };

      const threadsReviewImagePaths = Array.isArray(payload?.threadsReviewImagePaths)
        ? payload.threadsReviewImagePaths.map((p) => String(p || '').trim()).filter(Boolean).slice(0, 8)
        : [];

      const { processReviewCaptureImages } = require('../utils/reviewCaptureMosaic');
      const mosaicDir = path.join(userDataPath, 'threads-mosaic-export');
      const { outputs: mosaicOutputs, errors: mosaicErrors } = processReviewCaptureImages(
        threadsReviewImagePaths,
        mosaicDir,
        { blockPixels: 12, maxInputDimension: 2400 },
      );

      const sources = await collectThreadsMarketingSources(options);
      const drafts = await generateThreadsDrafts({
        storeName: payload?.storeName || settings.storeName || '',
        keywords: sources.keywords,
        sourcePosts: sources.posts,
        direction: options.direction,
      });
      const filteredDrafts = filterUnsafeThreadsDrafts(drafts);
      const usage = increaseThreadsDailyRateLimit(limitCheck.state);
      appendSecurityAudit('threads', 'generate_success', {
        useThreadsApiSearch,
        sourcePostCount: sources.posts.length,
        draftCount: filteredDrafts.drafts.length,
        blockedDraftCount: filteredDrafts.blockedCount,
        reviewImageCount: threadsReviewImagePaths.length,
        tokenHash: hashValue(options.accessToken),
        usageToday: usage.count,
        dailyLimit,
      });
      saveJson(path.join(userDataPath, 'threads-automation-state.json'), {
        at: new Date().toISOString(),
        ok: true,
        usageToday: usage.count,
        dailyLimit,
        drafts: filteredDrafts.drafts.length,
      });
      pushMobileRuntimeState({
        phase: 'threads_success',
        usageToday: usage.count,
        dailyLimit,
        drafts: filteredDrafts.drafts.length,
      }).catch(() => {});

      return {
        ok: true,
        data: {
          ...sources,
          drafts: filteredDrafts.drafts,
          safetyBlockedCount: filteredDrafts.blockedCount,
          mosaicOutputs,
          mosaicErrors,
        },
      };
    } catch (error) {
      appendUserError('threads.marketing_failed', error, {
        hasToken: !!payload?.accessToken,
        hasManualPosts: !!payload?.manualPosts,
        hasReviewImages: Array.isArray(payload?.threadsReviewImagePaths) && payload.threadsReviewImagePaths.length > 0,
      });
      appendSecurityAudit('threads', 'generate_failed', {
        message: error?.message || String(error),
        hasToken: !!payload?.accessToken,
      });
      saveJson(path.join(userDataPath, 'threads-automation-state.json'), {
        at: new Date().toISOString(),
        ok: false,
        error: String(error?.message || error),
      });
      pushMobileRuntimeState({
        phase: 'threads_failed',
        error: String(error?.message || error),
      }).catch(() => {});
      notifyUser('스레드 초안 생성 실패', String(error?.message || '알 수 없는 오류'));
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('open-threads-mosaic-folder', async () => {
    try {
      const mosaicDir = path.join(userDataPath, 'threads-mosaic-export');
      if (!fs.existsSync(mosaicDir)) {
        fs.mkdirSync(mosaicDir, { recursive: true });
      }
      await shell.openPath(mosaicDir);
      return { ok: true, path: mosaicDir };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.on('open-support', async () => {
    await shell.openExternal('https://open.kakao.com/o/gjDTy5ni');
  });

  ipcMain.handle('open-log-folder', async () => {
    try {
      const logsDir = path.join(getRuntimeBaseDir(), 'logs');
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
      }
      await shell.openPath(logsDir);
      return { ok: true, path: logsDir };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('summarize-error-logs', async () => {
    try {
      return summarizeErrorLogs();
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
