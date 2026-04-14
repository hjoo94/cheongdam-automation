const DEFAULT_SERVER_BASE_URL = 'http://43.202.181.184:4300';
const LEGACY_IP_HOSTS = ['43.201.84.136', '43.203.124.132'];
const CURRENT_IP_HOST = '43.202.181.184';
const LEGACY_SERVER_BASE_URLS = [
  'http://43.203.124.132:4300',
  'http://43.201.84.136:4300',
  'https://43.203.124.132:4300',
  'https://43.201.84.136:4300',
];

function normalizeUrlText(value = '') {
  return String(value || '').trim().replace(/\/+$/, '');
}

function migrateLegacyIpsInUrl(value = '') {
  let s = String(value || '');
  for (const ip of LEGACY_IP_HOSTS) {
    if (s.includes(ip)) {
      console.warn(`[config] Legacy IP migrated: ${ip} → ${CURRENT_IP_HOST}`);
      s = s.split(ip).join(CURRENT_IP_HOST);
    }
  }
  return s;
}

function isLegacyServerBaseUrl(value = '') {
  const normalized = normalizeUrlText(value);
  if (!normalized) return false;
  return LEGACY_SERVER_BASE_URLS.some((item) => normalizeUrlText(item) === normalized);
}

function migrateServerBaseUrl(value = '') {
  const normalized = normalizeUrlText(value);
  if (!normalized) return DEFAULT_SERVER_BASE_URL;
  if (isLegacyServerBaseUrl(value)) return DEFAULT_SERVER_BASE_URL;
  return normalizeUrlText(migrateLegacyIpsInUrl(value)) || DEFAULT_SERVER_BASE_URL;
}

module.exports = {
  DEFAULT_SERVER_BASE_URL,
  LEGACY_SERVER_BASE_URLS,
  LEGACY_IP_HOSTS,
  CURRENT_IP_HOST,
  isLegacyServerBaseUrl,
  migrateServerBaseUrl,
  migrateLegacyIpsInUrl,
  normalizeUrlText,
};
