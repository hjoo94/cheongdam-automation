const DEFAULT_SERVER_BASE_URL = 'http://43.202.181.184:4300';
const LEGACY_SERVER_BASE_URLS = [
  'http://43.203.124.132:4300',
  'http://43.201.84.136:4300',
  'https://43.203.124.132:4300',
  'https://43.201.84.136:4300',
];

function normalizeUrlText(value = '') {
  return String(value || '').trim().replace(/\/+$/, '');
}

function isLegacyServerBaseUrl(value = '') {
  const normalized = normalizeUrlText(value);
  if (!normalized) return false;
  return LEGACY_SERVER_BASE_URLS.some((item) => normalizeUrlText(item) === normalized);
}

function migrateServerBaseUrl(value = '') {
  const normalized = normalizeUrlText(value);
  if (!normalized) return DEFAULT_SERVER_BASE_URL;
  return isLegacyServerBaseUrl(normalized) ? DEFAULT_SERVER_BASE_URL : normalized;
}

module.exports = {
  DEFAULT_SERVER_BASE_URL,
  LEGACY_SERVER_BASE_URLS,
  isLegacyServerBaseUrl,
  migrateServerBaseUrl,
  normalizeUrlText,
};
