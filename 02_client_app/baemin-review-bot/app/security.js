const fs = require('fs');
const crypto = require('crypto');

const ENCRYPTED_PREFIX = 'enc:v1:';
const SECRET_SETTING_KEYS = new Set(['threadsAccessToken']);
const SENSITIVE_KEY_PATTERN = /(token|secret|password|passwd|pwd|authorization|api[_-]?key|license[_-]?key|access[_-]?token|refresh[_-]?token|cookie|set-cookie)/i;

/** 이전 Lightsail 공인 IP — 더 이상 서비스하지 않으면 신규 호스트로 치환한다. */
const LEGACY_LICENSE_SERVER_HOST = '43.201.84.136';

function migrateLegacyLicenseServerUrl(value) {
  const trimmed = String(value || '').trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  try {
    const u = new URL(trimmed);
    if (u.hostname === LEGACY_LICENSE_SERVER_HOST) {
      u.hostname = '43.203.124.132';
      return u.toString().replace(/\/+$/, '');
    }
  } catch {
    return trimmed;
  }
  return trimmed;
}

function parseTrustedHttpHosts() {
  const defaults = ['43.203.124.132', '43.201.84.136', '127.0.0.1', 'localhost'];
  const extra = String(process.env.CHUNGDAM_HTTP_TRUST_HOSTS || '')
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set([...defaults, ...extra]);
}

function isTrustedHttpLicenseServer(parsed) {
  if (!parsed || parsed.protocol !== 'http:') return false;
  if (process.env.CHUNGDAM_ALLOW_HTTP_SERVER === 'false') return false;
  return parseTrustedHttpHosts().has(parsed.hostname);
}

function normalizeSecureServerBaseUrl(value, fallback, options = {}) {
  const text = String(value || '').trim();
  const fallbackText = String(fallback || '').trim().replace(/\/+$/, '');
  const chosen = (text || fallbackText).replace(/\/+$/, '');
  const candidate = (migrateLegacyLicenseServerUrl(chosen) || chosen).replace(/\/+$/, '');

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return fallbackText;
  }

  const isLocalhost = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
  if (parsed.protocol === 'https:') return candidate;
  if (!options.isPackaged && parsed.protocol === 'http:' && isLocalhost) return candidate;
  if (isTrustedHttpLicenseServer(parsed)) return candidate;

  // 운영 빌드에서 HTTP를 허용하면 license/GPT 요청을 중간자 공격으로 조작할 수 있다.
  if (options.throwOnInsecure) {
    throw new Error('운영 환경에서는 HTTPS 서버 주소만 사용할 수 있습니다.');
  }

  return fallbackText;
}

function redactString(value) {
  let out = String(value || '');
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer [REDACTED]');
  out = out.replace(/sk-[A-Za-z0-9_-]{12,}/g, 'sk-[REDACTED]');
  out = out.replace(/\bCDM-[A-Z0-9-]{8,}\b/gi, 'CDM-[REDACTED]');
  out = out.replace(/([?&](?:access_token|token|api_key|key|secret)=)[^&\s]+/gi, '$1[REDACTED]');
  return out;
}

function maskSensitive(value, depth = 0) {
  if (depth > 6) return '[depth-limit]';
  if (value == null) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message || ''),
      stack: redactString(value.stack || ''),
    };
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => maskSensitive(item, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 100)) {
      out[key] = SENSITIVE_KEY_PATTERN.test(key) ? '[REDACTED]' : maskSensitive(item, depth + 1);
    }
    return out;
  }
  return value;
}

function maskLogMessage(...args) {
  return args
    .map((item) => {
      if (typeof item === 'string') return redactString(item);
      try {
        return JSON.stringify(maskSensitive(item));
      } catch {
        return '[unserializable]';
      }
    })
    .join(' ');
}

function encryptValue(safeStorage, value) {
  const text = String(value || '');
  if (!text) return '';
  if (text.startsWith(ENCRYPTED_PREFIX)) return text;
  if (!safeStorage?.isEncryptionAvailable?.()) {
    // 비밀값을 평문으로 저장하지 않기 위해 저장 자체를 중단한다.
    throw new Error('Windows 보안 저장소(DPAPI)를 사용할 수 없어 민감정보를 저장하지 않았습니다.');
  }
  return ENCRYPTED_PREFIX + safeStorage.encryptString(text).toString('base64');
}

function decryptValue(safeStorage, value) {
  const text = String(value || '');
  if (!text.startsWith(ENCRYPTED_PREFIX)) return text;
  if (!safeStorage?.isEncryptionAvailable?.()) return '';
  try {
    return safeStorage.decryptString(Buffer.from(text.slice(ENCRYPTED_PREFIX.length), 'base64'));
  } catch {
    return '';
  }
}

function encryptSettingsSecrets(safeStorage, settings = {}) {
  const out = { ...(settings || {}) };
  for (const key of SECRET_SETTING_KEYS) {
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      out[key] = encryptValue(safeStorage, out[key]);
    }
  }
  return out;
}

function decryptSettingsSecrets(safeStorage, settings = {}) {
  const out = { ...(settings || {}) };
  for (const key of SECRET_SETTING_KEYS) {
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      out[key] = decryptValue(safeStorage, out[key]);
    }
  }
  return out;
}

function sha256File(filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return '';
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    let pos = 0;
    let read;
    while ((read = fs.readSync(fd, buf, 0, buf.length, pos)) > 0) {
      hash.update(buf.subarray(0, read));
      pos += read;
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function constantTimeEqualHex(left, right) {
  const a = Buffer.from(String(left || '').toLowerCase(), 'hex');
  const b = Buffer.from(String(right || '').toLowerCase(), 'hex');
  if (!a.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = {
  ENCRYPTED_PREFIX,
  migrateLegacyLicenseServerUrl,
  normalizeSecureServerBaseUrl,
  isTrustedHttpLicenseServer,
  maskSensitive,
  maskLogMessage,
  encryptSettingsSecrets,
  decryptSettingsSecrets,
  sha256File,
  constantTimeEqualHex,
};
