#!/usr/bin/env node
/**
 * One-off: set missing or invalid licenseHash on each license (same algorithm as server.js buildLicenseHash).
 * Usage: node repair-license-hashes.js [path/to/licenses.json]
 */
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const target = path.resolve(process.argv[2] || path.join(__dirname, '../data/licenses.json'));
const raw = fs.readFileSync(target, 'utf8');
const licenses = JSON.parse(raw);
if (!Array.isArray(licenses)) {
  console.error('Expected array in', target);
  process.exit(1);
}

function buildLicenseHash(license) {
  const source = JSON.stringify({
    licenseKey: license.licenseKey,
    customerName: license.customerName,
    issuedAt: license.issuedAt,
    expiresAt: license.expiresAt,
    isEnabled: license.isEnabled,
    deviceFingerprint: license.deviceFingerprint || '',
    features: license.features || {},
  });
  return crypto.createHash('sha256').update(source).digest('hex');
}

let fixed = 0;
for (const license of licenses) {
  const next = buildLicenseHash(license);
  if (!license.licenseHash || license.licenseHash !== next) {
    license.licenseHash = next;
    fixed += 1;
  }
}

if (fixed > 0) {
  fs.writeFileSync(target, JSON.stringify(licenses, null, 2), 'utf8');
}
console.log(JSON.stringify({ file: target, total: licenses.length, hashesWrittenOrUpdated: fixed }));
