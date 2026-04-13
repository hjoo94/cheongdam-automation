const BLOCKED_PATTERNS = [
  /폭탄/i,
  /테러/i,
  /살인/i,
  /극단적 선택/i,
  /증오/i,
  /혐오/i,
  /인종차별/i,
  /성차별/i,
  /불법\s*도박/i,
  /마약/i,
  /보이스피싱/i,
  /사기\s*방법/i,
  /정치\s*선동/i,
  /가짜뉴스/i,
];

function isUnsafeDraft(text = '') {
  const value = String(text || '').trim();
  if (!value) return true;
  return BLOCKED_PATTERNS.some((rx) => rx.test(value));
}

function filterUnsafeThreadsDrafts(drafts = []) {
  const safe = [];
  let blockedCount = 0;
  for (const draft of Array.isArray(drafts) ? drafts : []) {
    if (isUnsafeDraft(draft)) {
      blockedCount += 1;
      continue;
    }
    safe.push(String(draft || '').trim());
  }
  return {
    drafts: safe.slice(0, 8),
    blockedCount,
  };
}

module.exports = {
  BLOCKED_PATTERNS,
  isUnsafeDraft,
  filterUnsafeThreadsDrafts,
};
