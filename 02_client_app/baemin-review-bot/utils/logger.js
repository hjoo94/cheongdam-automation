const fs = require('fs');
const path = require('path');
const { getLogDir } = require('./runtimePaths');
const { maskLogMessage } = require('../app/security');

const LOG_TO_FILE =
  String(process.env.LOG_TO_FILE || 'true').toLowerCase() !== 'false';

const LOG_DIR = getLogDir();
const LOG_FILE = path.join(
  LOG_DIR,
  `run-${new Date().toISOString().replace(/[:.]/g, '-')}.log`
);

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function log(...args) {
  const message = maskLogMessage(...args);

  console.log(message);

  if (LOG_TO_FILE) {
    ensureLogDir();
    fs.appendFileSync(LOG_FILE, message + '\n', 'utf8');
  }
}

module.exports = {
  log,
};
