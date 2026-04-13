/**
 * Compare semver-like x.y.z strings. Ignores leading "v". Non-numeric parts become 0.
 * @returns 1 if a > b, -1 if a < b, 0 if equal
 */
function compareVersions(a = '0.0.0', b = '0.0.0') {
  const strip = (v) => String(v || '').trim().replace(/^v/i, '');
  const pa = strip(a).split('.').map((n) => Number(n) || 0);
  const pb = strip(b).split('.').map((n) => Number(n) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

module.exports = { compareVersions };
