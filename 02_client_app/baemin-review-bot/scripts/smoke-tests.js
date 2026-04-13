/**
 * Headless smoke checks (no Electron): version compare, security helpers, small-file SHA.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { strict: assert } = require('node:assert');

const { compareVersions } = require('../utils/versionCompare');
const {
  constantTimeEqualHex,
  normalizeSecureServerBaseUrl,
  isTrustedHttpLicenseServer,
  sha256File,
} = require('../app/security');

function tmpFile(name) {
  return path.join(os.tmpdir(), `chungdam-smoke-${process.pid}-${name}`);
}

assert.equal(compareVersions('1.0.26', '1.0.25'), 1);
assert.equal(compareVersions('v1.2.3', '1.2.3'), 0);
assert.equal(compareVersions('1.0.9', '1.0.10'), -1);

const trustedLegacy = new URL('http://43.201.84.136:4300');
assert.equal(isTrustedHttpLicenseServer(trustedLegacy), true);

const trustedCurrent = new URL('http://43.203.124.132:4300');
assert.equal(isTrustedHttpLicenseServer(trustedCurrent), true);

const httpMigrated = normalizeSecureServerBaseUrl('http://43.201.84.136:4300', 'http://127.0.0.1:4300', {
  isPackaged: true,
  throwOnInsecure: true,
});
assert.equal(httpMigrated, 'http://43.203.124.132:4300');

const httpProd = normalizeSecureServerBaseUrl('http://43.203.124.132:4300', 'http://127.0.0.1:4300', {
  isPackaged: true,
  throwOnInsecure: true,
});
assert.equal(httpProd, 'http://43.203.124.132:4300');

assert.equal(constantTimeEqualHex('00', '11'), false);
assert.equal(constantTimeEqualHex('aa', 'aa'), true);
assert.equal(constantTimeEqualHex('00'.repeat(32), '00'.repeat(32)), true);

const samplePath = tmpFile('sha.bin');
const body = Buffer.from('chungdam-smoke');
fs.writeFileSync(samplePath, body);
try {
  const got = sha256File(samplePath);
  const want = crypto.createHash('sha256').update(body).digest('hex');
  assert.equal(got, want);
} finally {
  try {
    fs.unlinkSync(samplePath);
  } catch {}
}

console.log('smoke-tests: ok');
