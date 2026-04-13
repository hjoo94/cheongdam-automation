const fs = require('fs');
const path = require('path');
const { getLogDir } = require('./runtimePaths');

const PLATFORM_LABELS = {
  all: '전체',
  unknown: '미분류',
  baemin: '배민',
  coupang: '쿠팡이츠',
  naver: '네이버 메일',
};

function normalizeText(value = '') {
  return String(value || '')
    .replace(/\r/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseDateToMonth(value = '') {
  const text = normalizeText(value);
  const patterns = [
    /(\d{4})[-./](\d{1,2})[-./](\d{1,2})/,
    /(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return `${match[1]}-${String(Number(match[2])).padStart(2, '0')}`;
    }
  }

  return '';
}

function monthLabel(monthKey = '') {
  const match = String(monthKey).match(/^(\d{4})-(\d{2})$/);
  if (!match) return monthKey || '전체';
  return `${match[1]}년 ${Number(match[2])}월`;
}

function createBucket() {
  return {
    summary: {
      totalReviews: 0,
      lowRatingReviews: 0,
      complaintReviews: 0,
      files: [],
      platformCounts: {},
    },
    byRating: {},
    byCategory: {},
    byMenu: {},
    lowRatingMenus: {},
    lowRatingCategories: {},
    recentLowRatingReviews: [],
  };
}

function sortCountObject(obj = {}) {
  return Object.fromEntries(
    Object.entries(obj).sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return String(a[0]).localeCompare(String(b[0]), 'ko');
    })
  );
}

function normalizePlatform(raw = '') {
  const text = normalizeText(raw).toLowerCase();
  if (!text) return 'unknown';
  if (text.includes('baemin') || text.includes('배민')) return 'baemin';
  if (text.includes('coupang') || text.includes('쿠팡')) return 'coupang';
  if (text.includes('naver') || text.includes('메일')) return 'naver';
  return 'unknown';
}

function buildReviewCategoryList(text = '') {
  const source = normalizeText(text).toLowerCase();
  const rules = [
    { key: '맛', patterns: ['맛없', '별로', '싱겁', '짜', '맵', '냄새', '비리', '탄', '눅눅'] },
    { key: '양', patterns: ['적어', '양이', '양 적', '부족', '적음'] },
    { key: '포장/구성', patterns: ['포장', '구성', '샜', '터졌', '누락', '덜 왔'] },
    { key: '배송/상태', patterns: ['배송', '배달', '늦', '식었', '쏟', '상태'] },
    { key: '재료/식감', patterns: ['질기', '딱딱', '눅눅', '차갑', '식감'] },
    { key: '위생', patterns: ['위생', '머리카락', '벌레', '이물질'] },
    { key: '서비스', patterns: ['서비스', '응대', '친절', '불친절', '태도'] },
    { key: '가격', patterns: ['비싸', '가성비', '가격'] },
  ];

  const found = rules
    .filter((rule) => rule.patterns.some((pattern) => source.includes(pattern)))
    .map((rule) => rule.key);

  return found.length ? found : ['기타'];
}

function parseStructuredBlock(block = '') {
  const lines = String(block).split('\n').map((line) => line.trim()).filter(Boolean);
  const entry = {
    platform: 'unknown',
    platformLabel: '',
    customerName: '',
    date: '',
    reviewId: '',
    rating: null,
    reviewType: '',
    orderMenu: '',
    body: '',
    categories: [],
    raw: block,
  };

  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;

    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();

    if (key === 'platform') entry.platform = normalizePlatform(value);
    if (key === 'platformLabel') entry.platformLabel = value;
    if (key === 'customerName') entry.customerName = value;
    if (key === 'reviewDate') entry.date = value;
    if (key === 'reviewId') entry.reviewId = value;
    if (key === 'reviewType') entry.reviewType = value;
    if (key === 'orderMenu') entry.orderMenu = value;
    if (key === 'body') entry.body = value;
    if (key === 'rating') {
      const rating = Number(String(value).replace(/[^0-9.]/g, ''));
      entry.rating = Number.isFinite(rating) ? rating : null;
    }
  }

  entry.body = entry.body || '(없음)';
  entry.orderMenu = entry.orderMenu || '(없음)';
  entry.categories = buildReviewCategoryList(entry.body);
  return entry;
}

function parseLegacyBlock(block = '') {
  const lines = String(block).split('\n').map((line) => line.trim()).filter(Boolean);
  const entry = {
    platform: normalizePlatform(block),
    platformLabel: '',
    customerName: '',
    date: '',
    reviewId: '',
    rating: null,
    reviewType: '',
    orderMenu: '',
    body: '',
    categories: [],
    raw: block,
  };

  for (const line of lines) {
    if (line.startsWith('고객명 ')) entry.customerName = line.slice('고객명 '.length).trim();
    if (line.startsWith('리뷰작성일 ')) entry.date = line.slice('리뷰작성일 '.length).trim();
    if (line.startsWith('리뷰번호:')) entry.reviewId = line.slice('리뷰번호:'.length).trim();
    if (line.startsWith('별점:')) {
      const rating = Number(line.slice('별점:'.length).replace(/[^0-9.]/g, '').trim());
      entry.rating = Number.isFinite(rating) ? rating : null;
    }
    if (line.startsWith('유형:')) entry.reviewType = line.slice('유형:'.length).trim();
    if (line.startsWith('주문메뉴:')) entry.orderMenu = line.slice('주문메뉴:'.length).trim();
    if (line.startsWith('본문:')) entry.body = line.slice('본문:'.length).trim();
  }

  entry.body = entry.body || '(없음)';
  entry.orderMenu = entry.orderMenu || '(없음)';
  entry.categories = buildReviewCategoryList(entry.body);
  return entry;
}

function parseLogEntries(raw = '') {
  const normalized = String(raw || '').replace(/\r/g, '');
  const blocks = normalized
    .split(/\n\s*\n+/)
    .map((block) => block.trim())
    .filter(Boolean);

  return blocks
    .map((block) => {
      if (block.includes('=== REVIEW ENTRY ===') || block.includes('platform:')) {
        return parseStructuredBlock(block);
      }
      if (block.includes('리뷰번호:') || block.includes('본문:')) {
        return parseLegacyBlock(block);
      }
      return null;
    })
    .filter(Boolean);
}

function pushCount(target, key) {
  const normalizedKey = normalizeText(key) || '(없음)';
  target[normalizedKey] = (target[normalizedKey] || 0) + 1;
}

function addEntry(bucket, entry, fileName) {
  bucket.summary.totalReviews += 1;
  if (!bucket.summary.files.includes(fileName)) {
    bucket.summary.files.push(fileName);
  }

  pushCount(bucket.summary.platformCounts, entry.platform || 'unknown');
  pushCount(bucket.byRating, entry.rating == null ? '미확인' : `${entry.rating}점`);
  pushCount(bucket.byMenu, entry.orderMenu || '(없음)');

  const isLowRating = typeof entry.rating === 'number' && entry.rating <= 3;
  if (isLowRating) {
    bucket.summary.lowRatingReviews += 1;
    pushCount(bucket.lowRatingMenus, entry.orderMenu || '(없음)');
  }

  let hasComplaint = false;
  for (const category of entry.categories || ['기타']) {
    pushCount(bucket.byCategory, category);
    if (category !== '기타') hasComplaint = true;
    if (isLowRating) {
      pushCount(bucket.lowRatingCategories, category);
    }
  }

  if (hasComplaint) {
    bucket.summary.complaintReviews += 1;
  }

  if (isLowRating) {
    bucket.recentLowRatingReviews.push({
      platform: entry.platform,
      platformLabel: PLATFORM_LABELS[entry.platform] || entry.platformLabel || '미분류',
      reviewId: entry.reviewId || '(없음)',
      date: entry.date || '(없음)',
      rating: entry.rating,
      orderMenu: entry.orderMenu || '(없음)',
      body: entry.body || '(없음)',
      categories: entry.categories || ['기타'],
    });
  }
}

function finalizeBucket(bucket) {
  bucket.summary.files = [...bucket.summary.files].sort();
  bucket.summary.platformCounts = sortCountObject(bucket.summary.platformCounts);
  bucket.byRating = sortCountObject(bucket.byRating);
  bucket.byCategory = sortCountObject(bucket.byCategory);
  bucket.byMenu = sortCountObject(bucket.byMenu);
  bucket.lowRatingMenus = sortCountObject(bucket.lowRatingMenus);
  bucket.lowRatingCategories = sortCountObject(bucket.lowRatingCategories);
  bucket.recentLowRatingReviews = bucket.recentLowRatingReviews.slice(-12).reverse();
  return bucket;
}

function createMonthNode(monthKey) {
  return {
    label: monthLabel(monthKey),
    overview: createBucket(),
    platforms: {},
  };
}

function getReviewAnalysisData() {
  const logsDir = getLogDir();
  const overview = createBucket();
  const byMonth = {};
  const platformSet = new Set(['all']);

  if (!fs.existsSync(logsDir)) {
    return {
      months: [],
      platforms: [{ key: 'all', label: PLATFORM_LABELS.all }],
      overview: finalizeBucket(overview),
      byMonth: {},
    };
  }

  const files = fs
    .readdirSync(logsDir)
    .filter((name) => /^review-log-\d{4}-\d{2}\.txt$/i.test(name))
    .sort();

  const dedupe = new Set();

  for (const fileName of files) {
    const filePath = path.join(logsDir, fileName);
    const raw = fs.readFileSync(filePath, 'utf8');
    const fileMonth = (fileName.match(/^review-log-(\d{4}-\d{2})\.txt$/i) || [])[1] || '';
    const entries = parseLogEntries(raw);

    if (!byMonth[fileMonth]) {
      byMonth[fileMonth] = createMonthNode(fileMonth);
    }

    for (const entry of entries) {
      const reviewMonth = parseDateToMonth(entry.date) || fileMonth;
      if (!byMonth[reviewMonth]) {
        byMonth[reviewMonth] = createMonthNode(reviewMonth);
      }

      const dedupeKey = `${reviewMonth}|${entry.platform}|${entry.reviewId}|${entry.date}|${entry.body}`;
      if (dedupe.has(dedupeKey)) continue;
      dedupe.add(dedupeKey);

      platformSet.add(entry.platform || 'unknown');
      addEntry(overview, entry, fileName);
      addEntry(byMonth[reviewMonth].overview, entry, fileName);

      if (!byMonth[reviewMonth].platforms[entry.platform]) {
        byMonth[reviewMonth].platforms[entry.platform] = createBucket();
      }
      addEntry(byMonth[reviewMonth].platforms[entry.platform], entry, fileName);
    }
  }

  const finalizedByMonth = {};
  for (const [monthKey, monthNode] of Object.entries(byMonth)) {
    finalizedByMonth[monthKey] = {
      label: monthNode.label,
      overview: finalizeBucket(monthNode.overview),
      platforms: Object.fromEntries(
        Object.entries(monthNode.platforms).map(([platformKey, bucket]) => [
          platformKey,
          finalizeBucket(bucket),
        ])
      ),
    };
  }

  const months = Object.keys(finalizedByMonth)
    .sort()
    .map((key) => ({
      key,
      label: finalizedByMonth[key].label,
      totalReviews: finalizedByMonth[key].overview.summary.totalReviews,
      lowRatingReviews: finalizedByMonth[key].overview.summary.lowRatingReviews,
    }));

  const platforms = Array.from(platformSet)
    .sort()
    .map((key) => ({
      key,
      label: PLATFORM_LABELS[key] || key,
    }));

  return {
    months,
    platforms,
    overview: finalizeBucket(overview),
    byMonth: finalizedByMonth,
  };
}

module.exports = {
  getReviewAnalysisData,
  PLATFORM_LABELS,
};
