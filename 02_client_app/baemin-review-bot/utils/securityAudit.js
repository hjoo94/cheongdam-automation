const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getLogDir, ensureDir } = require('./runtimePaths');
const { maskSensitive } = require('../app/security');

function getAuditLogPath() {
  const month = new Date().toISOString().slice(0, 7);
  return path.join(getLogDir(), `security-audit-${month}.jsonl`);
}

function hashValue(value = '') {
  const text = String(value || '').trim();
  if (!text) return '';
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function appendSecurityAudit(area, action, detail = {}) {
  try {
    ensureDir(getLogDir());
    fs.appendFileSync(
      getAuditLogPath(),
      JSON.stringify({
        at: new Date().toISOString(),
        area: String(area || 'unknown'),
        action: String(action || 'unknown'),
        detail: maskSensitive(detail),
      }) + '\n',
      'utf8',
    );
  } catch {}
}

module.exports = {
  appendSecurityAudit,
  getAuditLogPath,
  hashValue,
};
