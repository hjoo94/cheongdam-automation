const fs = require('fs');
const path = require('path');
const { getLogDir, ensureDir } = require('./runtimePaths');

let maskSensitive = (value, depth = 0) => value;
try {
  const security = require('../app/security');
  maskSensitive = (value, depth = 0) => security.maskSensitive(value, depth);
} catch (e) {
  console.warn('[errorCollector] security module load failed:', e.message);
}

function getErrorLogPath() {
  const month = new Date().toISOString().slice(0, 7);
  return path.join(getLogDir(), `user-errors-${month}.jsonl`);
}

function sanitize(value, depth = 0) {
  return maskSensitive(value, depth);
}

function appendUserError(area, error, context = {}) {
  try {
    ensureDir(getLogDir());
    fs.appendFileSync(
      getErrorLogPath(),
      JSON.stringify({
        at: new Date().toISOString(),
        area,
        error: sanitize(error),
        context: sanitize(context),
      }) + '\n',
      'utf8'
    );
  } catch {}
}

module.exports = {
  appendUserError,
  getErrorLogPath,
};
