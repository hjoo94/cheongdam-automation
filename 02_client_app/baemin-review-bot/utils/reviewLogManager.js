const fs = require('fs');
const path = require('path');
const { getLogDir, ensureDir } = require('./runtimePaths');

const DEFAULT_YEAR = new Date().getFullYear();

function normalizeText(value = '') {
  return String(value)
    .replace(/\r/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractYearMonth(dateText = '') {
  const text = normalizeText(dateText);
  const patterns = [
    /(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/,
    /(\d{4})-(\d{1,2})-(\d{1,2})/,
    /(\d{4})\.(\d{1,2})\.(\d{1,2})/,
    /(\d{4})\/(\d{1,2})\/(\d{1,2})/,
  ];

  for (const pattern of patterns) {
    const m = text.match(pattern);
    if (m) {
      return {
        year: Number(m[1]),
        month: Number(m[2]),
      };
    }
  }

  return {
    year: DEFAULT_YEAR,
    month: new Date().getMonth() + 1,
  };
}

function getSafeYearMonth(dateText = '') {
  const parsed = extractYearMonth(dateText);
  let month = Number(parsed.month) || new Date().getMonth() + 1;
  if (month < 1 || month > 12) {
    month = new Date().getMonth() + 1;
  }
  const year = Number(parsed.year) || DEFAULT_YEAR;
  return { year, month };
}

function getMonthlyReviewLogFilename(dateText = '') {
  const { year, month } = getSafeYearMonth(dateText);
  return `review-log-${year}-${String(month).padStart(2, '0')}.txt`;
}

function getMonthlyBlindReviewLogFilename(dateText = '') {
  const { year, month } = getSafeYearMonth(dateText);
  return `review-log-blind-${year}-${String(month).padStart(2, '0')}.txt`;
}

function getMonthlyReviewLogPath(dateText = '') {
  const dir = getLogDir();
  ensureDir(dir);
  return path.join(dir, getMonthlyReviewLogFilename(dateText));
}

function getMonthlyBlindReviewLogPath(dateText = '') {
  const dir = getLogDir();
  ensureDir(dir);
  return path.join(dir, getMonthlyBlindReviewLogFilename(dateText));
}

function listManagedReviewLogFiles() {
  const dir = getLogDir();
  ensureDir(dir);
  if (!fs.existsSync(dir)) return [];

  return fs
    .readdirSync(dir)
    .filter((name) => /^review-log-\d{4}-\d{2}\.txt$/i.test(name))
    .sort()
    .map((name) => path.join(dir, name));
}

function hasDuplicateReview(filePath, reviewId = '') {
  if (!reviewId) return false;
  if (!fs.existsSync(filePath)) return false;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const pattern = new RegExp(`리뷰번호:\\s*${String(reviewId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`);
    return pattern.test(raw);
  } catch {
    return false;
  }
}

function appendUniqueReviewLog({ dateText = '', reviewId = '', text = '' } = {}) {
  const filePath = getMonthlyReviewLogPath(dateText);
  ensureDir(path.dirname(filePath));

  if (hasDuplicateReview(filePath, reviewId)) {
    return {
      ok: true,
      skipped: true,
      reason: 'duplicate_review_id',
      filePath,
    };
  }

  const payload = String(text || '').trim();
  if (!payload) {
    return {
      ok: false,
      skipped: true,
      reason: 'empty_payload',
      filePath,
    };
  }

  fs.appendFileSync(filePath, `${payload}\n\n`, 'utf8');
  return {
    ok: true,
    skipped: false,
    filePath,
  };
}

function appendUniqueBlindReviewLog({ dateText = '', reviewId = '', text = '' } = {}) {
  const filePath = getMonthlyBlindReviewLogPath(dateText);
  ensureDir(path.dirname(filePath));

  if (hasDuplicateReview(filePath, reviewId)) {
    return {
      ok: true,
      skipped: true,
      reason: 'duplicate_review_id',
      filePath,
    };
  }

  const payload = String(text || '').trim();
  if (!payload) {
    return {
      ok: false,
      skipped: true,
      reason: 'empty_payload',
      filePath,
    };
  }

  fs.appendFileSync(filePath, `${payload}\n\n`, 'utf8');
  return {
    ok: true,
    skipped: false,
    filePath,
  };
}

function hasDuplicateReviewAcrossLogs(reviewId = '') {
  if (!reviewId) return false;
  return listManagedReviewLogFiles().some((filePath) => hasDuplicateReview(filePath, reviewId));
}

module.exports = {
  normalizeText,
  getMonthlyReviewLogFilename,
  getMonthlyBlindReviewLogFilename,
  getMonthlyReviewLogPath,
  getMonthlyBlindReviewLogPath,
  listManagedReviewLogFiles,
  appendUniqueReviewLog,
  appendUniqueBlindReviewLog,
  hasDuplicateReviewAcrossLogs,
};
