const fs = require('fs');
const path = require('path');
const { getLogDir, ensureDir } = require('./runtimePaths');
const { maskSensitive } = require('../app/security');

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
