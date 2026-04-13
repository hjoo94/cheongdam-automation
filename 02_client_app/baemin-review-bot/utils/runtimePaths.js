const fs = require('fs');
const path = require('path');

function ensureDir(dirPath) {
  if (!dirPath) return dirPath;
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  return dirPath;
}

function getBundledBaseDir() {
  return path.resolve(__dirname, '..');
}

function getRuntimeRootDir() {
  const runtimePath = String(process.env.RUNTIME_PATH || '').trim();
  if (runtimePath) {
    return path.dirname(runtimePath);
  }

  const appData = String(process.env.APPDATA || '').trim();
  if (appData) {
    return path.join(appData, 'chungdam-bot');
  }

  return process.cwd();
}

function getLogDir() {
  return ensureDir(path.join(getRuntimeRootDir(), 'logs'));
}

function getBrowserProfilesDir() {
  return ensureDir(path.join(getRuntimeRootDir(), 'browser-profiles'));
}

function getCoupangProfileDir() {
  return ensureDir(path.join(getBrowserProfilesDir(), 'chrome-profile-coupang'));
}

function getAuthDir() {
  return ensureDir(path.join(getRuntimeRootDir(), 'auth'));
}

function getBundledAssetPath(filename) {
  return path.join(getBundledBaseDir(), 'assets', filename);
}

module.exports = {
  ensureDir,
  getRuntimeRootDir,
  getLogDir,
  getBrowserProfilesDir,
  getCoupangProfileDir,
  getAuthDir,
  getBundledBaseDir,
  getBundledAssetPath,
};
