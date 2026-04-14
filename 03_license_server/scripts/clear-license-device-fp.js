#!/usr/bin/env node
/** Clear deviceFingerprint for a license key (e.g. after accidental test bind). Re-hash with repair-license-hashes.js after. */
const fs = require('fs');
const path = require('path');

const key = process.argv[2];
const file = path.resolve(process.argv[3] || path.join(__dirname, '../data/licenses.json'));
if (!key) {
  console.error('Usage: node clear-license-device-fp.js <licenseKey> [licenses.json]');
  process.exit(1);
}
const licenses = JSON.parse(fs.readFileSync(file, 'utf8'));
let n = 0;
for (const L of licenses) {
  if (String(L.licenseKey || '').trim() === key) {
    L.deviceFingerprint = '';
    n += 1;
  }
}
if (!n) {
  console.error('Key not found:', key);
  process.exit(1);
}
fs.writeFileSync(file, JSON.stringify(licenses, null, 2), 'utf8');
console.log(JSON.stringify({ cleared: n, file }));
