const fs = require('fs');
const path = require('path');
const { generateReviewCareApology } = require('../gptClient');
const { getLogDir, getBundledAssetPath, ensureDir } = require('../utils/runtimePaths');
const { launchChromiumWithFallback } = require('../utils/browserLauncher');
const { appendUserError } = require('../utils/errorCollector');

const REVIEW_LOG_DIR = getLogDir();
const REVIEW_LOG_PREFIX = 'review-log-';
const BLIND_REVIEW_LOG_PREFIX = 'review-log-blind-';
const REVIEW_LOG_EXT = '.txt';

function resolveIdCardPath() {
  const raw =
    process.env.ID_CARD_PATH ||
    process.env.IDCARD_PATH ||
    process.env.ID_CARD_FILE ||
    getBundledAssetPath('idcard.jpg');

  return String(raw || '').trim().replace(/^"|"$/g, '');
}

const TARGET_MAIL_SUBJECT = '리뷰게시 중단 신청 안내';
const UNKNOWN_NICKNAME = '';
const MAX_NAVER_MAILS = Number(process.env.MAX_NAVER_MAILS || 5000);
const NAVER_INBOX_URL = 'https://mail.naver.com/v2/folders/0';
const PROCESSED_MAIL_KEYS_FILE = path.join(REVIEW_LOG_DIR, 'naver-processed-mail-keys.json');

function dlog(title, value = '') {
  try {
    if (typeof value === 'string') {
      console.log(`[DEBUG] ${title}: ${value}`);
    } else {
      console.log(`[DEBUG] ${title}:`, value);
    }
  } catch {
    console.log(`[DEBUG] ${title}`);
  }
}

function appendTextLog(filename, text) {
  ensureDir(REVIEW_LOG_DIR);
  const file = path.join(REVIEW_LOG_DIR, filename);
  fs.appendFileSync(file, String(text) + '\n', 'utf8');
  return file;
}

function writeMailTrace(title, payload = '') {
  try {
    const stamp = new Date().toISOString();
    appendTextLog(
      `mail-trace-${stamp.slice(0, 7)}.log`,
      `[${stamp}] ${title}: ${typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)}`
    );
  } catch {}
}

function loadProcessedMailKeys() {
  try {
    if (!fs.existsSync(PROCESSED_MAIL_KEYS_FILE)) return new Set();
    const raw = fs.readFileSync(PROCESSED_MAIL_KEYS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.keys)) return new Set();
    return new Set(parsed.keys.map((item) => String(item || '').trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

function saveProcessedMailKeys(keys) {
  ensureDir(REVIEW_LOG_DIR);
  const list = Array.from(keys || []).map((item) => String(item || '').trim()).filter(Boolean).sort();
  fs.writeFileSync(
    PROCESSED_MAIL_KEYS_FILE,
    JSON.stringify({ updatedAt: new Date().toISOString(), keys: list }, null, 2),
    'utf8'
  );
}

function markProcessedMailKey(keys, mailKey = '', meta = {}) {
  const key = String(mailKey || '').trim();
  if (!key) return;
  keys.add(key);
  saveProcessedMailKeys(keys);
  writeMailTrace('mail.processed.marked', { mailKey: key, meta });
}

async function captureMailDebug(pageOrFrame, label = 'debug') {
  try {
    const page = getOwnerPage(pageOrFrame);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(REVIEW_LOG_DIR, `naver-${label}-${stamp}.png`);
    await page.screenshot({ path: file, fullPage: true }).catch(() => page.screenshot({ path: file }));
    writeMailTrace(`${label}.screenshot`, file);
    return file;
  } catch {
    return '';
  }
}

function normalizeText(text = '') {
  return String(text)
    .replace(/\r/g, '')
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeReviewText(text = '') {
  const normalized = normalizeText(text);

  if (!normalized) return '(없음)';
  if (/^\(없음\)$/i.test(normalized)) return '(없음)';
  if (/^없음$/i.test(normalized)) return '(없음)';
  if (/^null$/i.test(normalized)) return '(없음)';
  if (/^undefined$/i.test(normalized)) return '(없음)';

  return normalized;
}

function isUsableReviewText(text = '') {
  const normalized = normalizeReviewText(text);
  if (!normalized || normalized === '(없음)') return false;
  if (normalized.length > 1200) return false;
  if (/NAVER\s*메일|받은메일함|전체 메일|메일 제목|보낸사람|메일 목록|환경설정/.test(normalized)) return false;
  if (/신청서 제출하기|배달의민족입니다|해당 신청서는 수신한 일시/.test(normalized) && normalized.length > 200) return false;
  return true;
}

function pickUsableReviewText(...values) {
  for (const value of values) {
    const text = normalizeReviewText(value || '');
    if (isUsableReviewText(text)) return text;
  }
  return '(없음)';
}

function tokenizeForCompare(text = '') {
  return normalizeReviewText(text)
    .replace(/[^가-힣A-Za-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function computeTokenSimilarity(a = '', b = '') {
  const left = new Set(tokenizeForCompare(a));
  const right = new Set(tokenizeForCompare(b));
  if (!left.size || !right.size) return 0;
  let hit = 0;
  for (const token of left) {
    if (right.has(token)) hit += 1;
  }
  return hit / Math.max(left.size, right.size);
}

function parseKoreanDate(text = '') {
  const m = String(text).match(/(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/);
  if (!m) return '';
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

function parseIsoDate(text = '') {
  const m = String(text).match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return '';
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

function parseDottedDate(text = '') {
  const m = String(text).match(/(\d{4})\.(\d{1,2})\.(\d{1,2})/);
  if (!m) return '';
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

function parseSlashedDate(text = '') {
  const m = String(text).match(/(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (!m) return '';
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

function normalizeDateToIso(text = '') {
  return (
    parseKoreanDate(text) ||
    parseIsoDate(text) ||
    parseDottedDate(text) ||
    parseSlashedDate(text) ||
    ''
  );
}

function extractYearMonth(text = '') {
  const normalized = normalizeDateToIso(text) || normalizeText(text);
  const m = String(normalized).match(/(\d{4})-(\d{2})-\d{2}/);
  if (!m) return '';
  return `${m[1]}-${m[2]}`;
}

function getMonthlyReviewLogPathsByReviewDate(reviewDate = '') {
  const yearMonth = extractYearMonth(reviewDate);
  if (!yearMonth) return [];

  return [
    path.join(REVIEW_LOG_DIR, `${BLIND_REVIEW_LOG_PREFIX}${yearMonth}${REVIEW_LOG_EXT}`),
    path.join(REVIEW_LOG_DIR, `${REVIEW_LOG_PREFIX}${yearMonth}${REVIEW_LOG_EXT}`),
  ];
}

function getAllMonthlyReviewLogPaths() {
  if (!fs.existsSync(REVIEW_LOG_DIR)) return [];

  return fs
    .readdirSync(REVIEW_LOG_DIR)
    .filter((name) => /^review-log(?:-blind)?-\d{4}-\d{2}\.txt$/i.test(name))
    .map((name) => path.join(REVIEW_LOG_DIR, name))
    .sort();
}

function extractDateFromText(text = '') {
  const normalized = normalizeText(text);

  const korean = normalized.match(/\d{4}\s*년\s*\d{1,2}\s*월\s*\d{1,2}\s*일/);
  if (korean) return korean[0];

  const iso = normalized.match(/\d{4}-\d{1,2}-\d{1,2}/);
  if (iso) return iso[0];

  const dotted = normalized.match(/\d{4}\.\d{1,2}\.\d{1,2}/);
  if (dotted) return dotted[0];

  const slashed = normalized.match(/\d{4}\/\d{1,2}\/\d{1,2}/);
  if (slashed) return slashed[0];

  return '';
}

function extractReviewIdFromText(text = '') {
  const normalized = normalizeText(text);

  const patterns = [
    /리뷰\s*번호[:：]?\s*(\d{6,})/i,
    /리뷰번호[:：]?\s*(\d{6,})/i,
    /게시물\s*번호[:：]?\s*(\d{6,})/i,
    /reviewId[:：]?\s*([A-Za-z0-9_-]+)/i,
    /ID[:：]?\s*(\d{6,})/i,
    /No\.?\s*[:：]?\s*(\d{6,})/i,
  ];

  for (const re of patterns) {
    const m = normalized.match(re);
    if (m && m[1]) return normalizeText(m[1]);
  }

  const longNums = normalized.match(/\b20\d{10,}\b/g);
  if (longNums && longNums.length > 0) {
    return normalizeText(longNums[0]);
  }

  return '';
}

function extractReviewIdFromHrefs(hrefs = []) {
  for (const href of hrefs) {
    const m = String(href).match(/(\d{12,})/);
    if (m && m[1]) return normalizeText(m[1]);
  }
  return '';
}

function extractPostedContentFromMailText(text = '') {
  const normalized = String(text).replace(/\r/g, '');

  const patterns = [
    /게시물\s*내용[:：]?\s*([^\n]+)/i,
    /리뷰\s*내용[:：]?\s*([^\n]+)/i,
    /본문[:：]?\s*([^\n]+)/i,
  ];

  for (const re of patterns) {
    const m = normalized.match(re);
    if (m && m[1] != null) {
      return pickUsableReviewText(m[1]);
    }
  }

  return '(없음)';
}

function parseLogEntriesFromText(content = '') {
  const normalized = String(content).replace(/\r/g, '');
  const lines = normalized.split('\n');

  const entries = [];
  let current = null;

  const pushCurrent = () => {
    if (!current) return;

    current.nickname = normalizeText(current.nickname || '');
    current.reviewDateRaw = normalizeText(current.reviewDateRaw || '');
    current.reviewDate =
      normalizeDateToIso(current.reviewDateRaw) ||
      normalizeText(current.reviewDateRaw || '');
    current.reviewId = normalizeText(current.reviewId || '');
    current.reviewText = normalizeReviewText(current.reviewText || '');

    if (
      current.nickname ||
      current.reviewDate ||
      current.reviewId ||
      current.reviewText
    ) {
      entries.push({ ...current });
    }

    current = null;
  };

  for (const rawLine of lines) {
    const line = String(rawLine || '');

    if (!normalizeText(line)) continue;

    if (line.startsWith('=== REVIEW ENTRY ===')) {
      pushCurrent();
      current = {
        nickname: '',
        reviewDateRaw: '',
        reviewDate: '',
        reviewId: '',
        reviewText: '',
      };
      continue;
    }

    if (line.startsWith('고객명:') || line.startsWith('고객명：')) {
      pushCurrent();
      current = {
        nickname: line.replace(/^고객명[:：]\s*/, ''),
        reviewDateRaw: '',
        reviewDate: '',
        reviewId: '',
        reviewText: '',
      };
      continue;
    }

    if (!current) continue;

    if (/^고객명\s+/.test(line) && !/^고객명[:：]/.test(line)) {
      current.nickname = normalizeText(line.replace(/^고객명\s+/, ''));
      continue;
    }

    if (/^customerName:/i.test(line)) {
      current.nickname = line.replace(/^customerName:\s*/i, '');
      continue;
    }

    if (line.startsWith('리뷰작성일:') || line.startsWith('리뷰작성일：')) {
      current.reviewDateRaw = line.replace(/^리뷰작성일[:：]\s*/, '');
      continue;
    }

    if (/^리뷰작성일\s+/.test(line) && !/^리뷰작성일[:：]/.test(line)) {
      current.reviewDateRaw = normalizeText(line.replace(/^리뷰작성일\s+/, ''));
      continue;
    }

    if (/^reviewDate:/i.test(line)) {
      current.reviewDateRaw = line.replace(/^reviewDate:\s*/i, '');
      continue;
    }

    if (line.startsWith('리뷰번호:') || line.startsWith('리뷰번호：')) {
      current.reviewId = line.replace(/^리뷰번호[:：]\s*/, '');
      continue;
    }

    if (/^리뷰번호\s+/.test(line) && !/^리뷰번호[:：]/.test(line)) {
      current.reviewId = normalizeText(line.replace(/^리뷰번호\s+/, ''));
      continue;
    }

    if (/^reviewId:/i.test(line)) {
      current.reviewId = line.replace(/^reviewId:\s*/i, '');
      continue;
    }

    if (line.startsWith('본문:')) {
      current.reviewText = line.replace(/^본문:\s*/, '');
      continue;
    }

    if (/^body:/i.test(line)) {
      current.reviewText = line.replace(/^body:\s*/i, '');
      continue;
    }
  }

  pushCurrent();
  return entries;
}

function pickLatestByFileAndOrder(matches = []) {
  if (!matches.length) return null;

  return matches.sort((a, b) => {
    if ((a.mtimeMs || 0) !== (b.mtimeMs || 0)) {
      return (a.mtimeMs || 0) - (b.mtimeMs || 0);
    }
    return (a.orderIndex || 0) - (b.orderIndex || 0);
  })[matches.length - 1];
}

async function findBestLogMatch(reviewMeta = {}) {
  const targetReviewDate = normalizeDateToIso(reviewMeta.reviewDate || '') || '';
  const targetReviewId = normalizeText(reviewMeta.reviewId || '');
  const targetReviewText = normalizeReviewText(reviewMeta.reviewText || '');
  const targetReviewTexts = Array.from(new Set([
    targetReviewText,
    normalizeReviewText(reviewMeta.mailMeta?.reviewText || ''),
    normalizeReviewText(reviewMeta.formReviewText || ''),
    normalizeReviewText(reviewMeta.formMeta?.reviewText || ''),
  ].filter((text) => text && text !== '(없음)')));

  dlog('매칭 시작 - 리뷰작성일', targetReviewDate || '(없음)');
  dlog('매칭 시작 - 리뷰번호', targetReviewId || '(없음)');
  dlog('매칭 시작 - 리뷰내용', targetReviewText);
  writeMailTrace('match.start', { targetReviewDate, targetReviewId, targetReviewText });

  const primaryPaths = [];
  const secondaryPaths = [];

  if (targetReviewDate) {
    primaryPaths.push(...getMonthlyReviewLogPathsByReviewDate(targetReviewDate));
  }

  for (const p of getAllMonthlyReviewLogPaths()) {
    if (!primaryPaths.includes(p)) secondaryPaths.push(p);
  }

  const candidatePaths = [...primaryPaths, ...secondaryPaths];
  const exactMatches = [];
  const fuzzyMatches = [];
  const dateOnlyMatches = [];
  const idStrongMatches = [];
  const anyNicknameEntries = [];
  const FUZZY_MIN = (() => {
    const textLen = targetReviewTexts.reduce((max, t) => Math.max(max, t.length), 0);
    if (textLen <= 10) return 0.2;
    if (textLen <= 20) return 0.3;
    if (textLen <= 40) return 0.4;
    return 0.48;
  })();
  const diagnostics = {
    scannedFiles: 0,
    scannedEntries: 0,
    sameDate: 0,
    sameText: 0,
    sameReviewId: 0,
    fuzzyText: 0,
  };

  for (const logPath of candidatePaths) {
    if (!fs.existsSync(logPath)) continue;

    try {
      const stat = fs.statSync(logPath);
      const content = fs.readFileSync(logPath, 'utf8');
      const entries = parseLogEntriesFromText(content);

      const enriched = entries.map((entry, index) => ({
        ...entry,
        fileName: path.basename(logPath),
        fullPath: logPath,
        mtimeMs: stat.mtimeMs,
        orderIndex: index,
      }));

      diagnostics.scannedFiles += 1;
      diagnostics.scannedEntries += enriched.length;

      for (const item of enriched) {
        const itemDate = normalizeDateToIso(item.reviewDate) || normalizeText(item.reviewDate);
        const itemText = normalizeReviewText(item.reviewText);
        const itemReviewId = normalizeText(item.reviewId);
        const hasNickname = !!normalizeText(item.nickname);
        if (hasNickname) anyNicknameEntries.push(item);
        const sameDate = !!targetReviewDate && itemDate === targetReviewDate;
        const sameText = targetReviewTexts.includes(itemText);
        const sameReviewId = !!targetReviewId && itemReviewId === targetReviewId;
        const bestTextSimilarity = targetReviewTexts.reduce(
          (best, text) => Math.max(best, computeTokenSimilarity(text, itemText)),
          0
        );

        if (sameDate) diagnostics.sameDate += 1;
        if (sameText) diagnostics.sameText += 1;
        if (sameReviewId) diagnostics.sameReviewId += 1;
        if (bestTextSimilarity >= FUZZY_MIN) diagnostics.fuzzyText += 1;

        if (sameReviewId && targetReviewId) {
          idStrongMatches.push({
            ...item,
            matchBy: 'reviewIdStrong',
            similarity: 1,
          });
        }

        if (!hasNickname && !sameReviewId && !sameText && bestTextSimilarity < FUZZY_MIN) continue;
        if (sameText || (sameReviewId && hasNickname)) {
          exactMatches.push({
            ...item,
            matchBy: sameText ? (sameDate ? 'date+text' : 'text') : 'reviewId',
            similarity: 1,
          });
          continue;
        }

        if (sameDate && bestTextSimilarity >= FUZZY_MIN) {
          fuzzyMatches.push({
            ...item,
            matchBy: 'date+similarText',
            similarity: bestTextSimilarity,
          });
          continue;
        }

        if (sameDate) {
          dateOnlyMatches.push({
            ...item,
            matchBy: 'dateOnlyUnique',
            similarity: 0,
          });
        }
      }
    } catch (e) {
      console.log(`${path.basename(logPath)} 분석 실패:`, e.message);
    }
  }

  let matched = null;
  let strategy = 'none';

  if (exactMatches.length > 0) {
    matched = pickLatestByFileAndOrder(exactMatches);
    strategy = matched?.matchBy || 'date+exact';
  } else if (idStrongMatches.length > 0) {
    const withNick = idStrongMatches.filter((item) => !!normalizeText(item.nickname));
    const pool = withNick.length ? withNick : idStrongMatches;
    matched = pickLatestByFileAndOrder(pool);
    strategy = 'reviewIdStrong';
  } else if (fuzzyMatches.length > 0) {
    const bestScore = Math.max(...fuzzyMatches.map((item) => item.similarity || 0));
    matched = pickLatestByFileAndOrder(
      fuzzyMatches.filter((item) => Math.abs((item.similarity || 0) - bestScore) < 0.001)
    );
    strategy = matched?.matchBy || 'date+similarText';
  } else if (!targetReviewId && targetReviewTexts.length === 0 && dateOnlyMatches.length === 1) {
    matched = dateOnlyMatches[0];
    strategy = 'dateOnlyUnique';
  } else if (anyNicknameEntries.length > 0 && targetReviewDate) {
    const sameMonthEntries = anyNicknameEntries.filter((item) => {
      const itemMonth = extractYearMonth(item.reviewDate || '');
      const targetMonth = extractYearMonth(targetReviewDate);
      return itemMonth && targetMonth && itemMonth === targetMonth;
    });
    if (sameMonthEntries.length > 0) {
      matched = pickLatestByFileAndOrder(sameMonthEntries);
      strategy = 'latestNicknameFallback';
    }
  }

  writeMailTrace('match.result', {
    strategy,
    diagnostics,
    matched: matched
      ? {
          nickname: matched.nickname || '',
          reviewDate: matched.reviewDate || '',
          reviewId: matched.reviewId || '',
          reviewText: matched.reviewText || '',
          fileName: matched.fileName || '',
          similarity: matched.similarity || 0,
        }
      : null,
  });

  if (!matched) {
    const error = new Error('작성일자와 리뷰 본문이 일치하는 리뷰 로그를 찾지 못했습니다.');
    appendUserError('naver.log_exact_match_failed', error, {
      targetReviewDate,
      targetReviewId,
      targetReviewText,
      diagnostics,
    });
    throw error;
  }

  return matched;
}

function getFrameUrl(frameOrPage) {
  try {
    return typeof frameOrPage.url === 'function' ? frameOrPage.url() : 'main-page';
  } catch {
    return 'unknown';
  }
}

function isPageLike(target) {
  return !!target && typeof target.goto === 'function' && typeof target.frames === 'function';
}

function getOwnerPage(frameOrPage) {
  if (isPageLike(frameOrPage)) return frameOrPage;
  if (frameOrPage && typeof frameOrPage.page === 'function') return frameOrPage.page();
  throw new Error('page/frame 객체를 판별하지 못했습니다.');
}

async function waitForTimeoutSafe(frameOrPage, ms) {
  const page = getOwnerPage(frameOrPage);
  await page.waitForTimeout(ms);
}

async function goToNaverInbox(page, timeout = 30000) {
  console.log('네이버 메일 기본 받은메일함으로 이동:', NAVER_INBOX_URL);
  await page.goto(NAVER_INBOX_URL, {
    waitUntil: 'domcontentloaded',
    timeout,
  });
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(2000);
}

async function openFirstTargetMail(page, options = {}) {
  const timeout = options.timeout == null ? 0 : options.timeout;
  console.log('리뷰게시 중단 신청 메일 찾는중... 네이버 로그인이 필요하면 완료될 때까지 대기합니다.');

  const mail = page.locator(`text=${TARGET_MAIL_SUBJECT}`).first();
  try {
    await mail.waitFor({ state: 'visible', timeout });
  } catch {
    return false;
  }
  await mail.click();

  console.log('메일 클릭 완료');
  await page.waitForTimeout(3000);
  return true;
}

async function getCurrentMailSubject(page) {
  const selectors = [
    'h3.mail_title',
    '.mail_title_wrap h3',
    '.mail_title_area h3',
    'strong:has-text("리뷰게시 중단 신청 안내")',
    'h3',
  ];

  for (const selector of selectors) {
    try {
      const loc = page.locator(selector).first();
      if ((await loc.count()) > 0) {
        const text = normalizeText(await loc.innerText().catch(() => ''));
        if (text) return text;
      }
    } catch {}
  }

  try {
    const text = await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll('h1, h2, h3, strong, div, span'));
      const found = candidates.find((el) =>
        (el.innerText || '').includes('리뷰게시 중단 신청 안내')
      );
      return found ? found.innerText : '';
    });
    return normalizeText(text || '');
  } catch {
    return '';
  }
}

async function clickMailNextArrow(page) {
  console.log('네이버 메일 목록 옆 아래 화살표 클릭 시도');

  try {
    const arrowInfo = await page.evaluate(() => {
      const normalize = (s) => (s || '').replace(/\s+/g, ' ').trim();

      const visible = (el) => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return (
          style.visibility !== 'hidden' &&
          style.display !== 'none' &&
          rect.width > 0 &&
          rect.height > 0
        );
      };

      const all = Array.from(document.querySelectorAll('*'));
      const listNode = all.find((el) => normalize(el.innerText) === '목록');

      if (!listNode) {
        return { ok: false, reason: '목록 텍스트를 찾지 못함' };
      }

      const listRect = listNode.getBoundingClientRect();

      const candidates = all
        .filter((el) => {
          if (!visible(el) || el === listNode) return false;

          const rect = el.getBoundingClientRect();
          if (rect.left < listRect.right - 10) return false;
          if (rect.left > listRect.right + 120) return false;
          if (Math.abs(rect.top - listRect.top) > 25) return false;
          if (rect.width > 60 || rect.height > 60) return false;

          const txt = normalize(el.innerText);
          const cls = (el.className || '').toString();
          const aria = normalize(el.getAttribute?.('aria-label') || '');
          const title = normalize(el.getAttribute?.('title') || '');
          const tag = el.tagName;

          const hasArrowHint =
            txt === '' ||
            txt === '∨' ||
            txt === '⌄' ||
            txt === '˅' ||
            /arrow|ico|icon|fold|more|toggle|drop|down/i.test(cls) ||
            /다음|아래|펼치기|more|down/i.test(aria) ||
            /다음|아래|펼치기|more|down/i.test(title);

          return hasArrowHint && ['BUTTON', 'A', 'SPAN', 'I', 'EM', 'SVG', 'DIV'].includes(tag);
        })
        .map((el) => {
          const rect = el.getBoundingClientRect();
          return {
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
          };
        })
        .sort((a, b) => b.left - a.left);

      return {
        ok: candidates.length > 0,
        candidates,
      };
    });

    if (arrowInfo.ok && arrowInfo.candidates.length > 0) {
      const target = arrowInfo.candidates[0];
      await page.mouse.click(target.left + target.width / 2, target.top + target.height / 2);
      console.log('좌표 기반 아래 화살표 클릭 완료');
      return true;
    }
  } catch (e) {
    console.log('후보 탐색 방식 실패:', e.message);
  }

  try {
    const listLoc = page.getByText('목록', { exact: true }).first();
    await listLoc.waitFor({ state: 'visible', timeout: 5000 });
    const box = await listLoc.boundingBox();

    if (box) {
      const clickX = box.x + box.width + 34;
      const clickY = box.y + box.height / 2;
      await page.mouse.click(clickX, clickY);
      console.log(`목록 오른쪽 고정좌표 클릭 완료 (${clickX}, ${clickY})`);
      return true;
    }
  } catch (e) {
    console.log('목록 오른쪽 고정좌표 클릭 실패:', e.message);
  }

  return false;
}

async function waitForMailSubjectChange(page, previousSubject = '', timeout = 12000) {
  const start = Date.now();
  const prev = normalizeText(previousSubject);

  while (Date.now() - start < timeout) {
    await page.waitForTimeout(500);

    const current = normalizeText(await getCurrentMailSubject(page));
    if (current && current !== prev) {
      console.log(`메일 제목 변경 감지: "${prev}" -> "${current}"`);
      return true;
    }
  }

  console.log('메일 제목 변경 대기 timeout');
  return false;
}

async function clickMailNextArrowAndWait(page, previousSubject = '') {
  await page.bringToFront().catch(() => {});
  await page.waitForTimeout(1000);

  const clicked = await clickMailNextArrow(page);
  if (!clicked) return false;

  return await waitForMailSubjectChange(page, previousSubject, 12000);
}

async function moveToApplicationForm(mailPage, context) {
  let link = mailPage.locator('a:has-text("신청서 제출하기")').first();
  let hasLink = false;
  try {
    await link.waitFor({ state: 'visible', timeout: 12000 });
    hasLink = true;
  } catch {
    // 아래 대체 전략으로 진행
  }

  if (!hasLink) {
    try {
      const fallback = mailPage.locator('a[href*="review"][href*="blind"], a[href*="apply"], a[href*="form"]').first();
      if ((await fallback.count()) > 0) {
        link = fallback;
        await link.waitFor({ state: 'visible', timeout: 5000 });
        hasLink = true;
      }
    } catch {}
  }

  let popup = null;

  if (hasLink) try {
    [popup] = await Promise.all([
      context.waitForEvent('page', { timeout: 10000 }),
      link.click({ button: 'left', force: true }),
    ]);

    await popup.waitForLoadState('domcontentloaded');
    console.log('새 탭으로 신청서 열기 성공');
    return popup;
  } catch (e) {
    console.log('직접 클릭 새 탭 실패:', e.message);
  }

  try {
    let href = hasLink ? await link.getAttribute('href') : '';
    if (!href) {
      const mailMeta = await readMailMeta(mailPage).catch(() => ({}));
      href = Array.isArray(mailMeta?.hrefs)
        ? mailMeta.hrefs.find((item) => /review|blind|apply|form/i.test(String(item || ''))) || ''
        : '';
    }
    if (!href) throw new Error('href 없음');

    const newPage = await context.newPage();
    await newPage.goto(href, { waitUntil: 'domcontentloaded' });
    console.log('href로 새 탭 열기 성공');
    return newPage;
  } catch (e) {
    console.log('href 새 탭 열기 실패:', e.message);
  }

  throw new Error('"신청서 제출하기" 새 탭 열기 실패');
}

async function findFrameWithText(page, text) {
  const candidates = [page, ...page.frames()];

  for (const frame of candidates) {
    try {
      if ((await frame.locator(`text=${text}`).count()) > 0) {
        return frame;
      }
    } catch {}
  }

  return null;
}

async function waitForFormStepFrame(page, timeout = 10000) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    const candidates = [page, ...page.frames()];

    for (const frame of candidates) {
      try {
        const hasAgree = (await frame.locator('text=동의').count()) > 0;
        const hasYes = (await frame.locator('text=네').count()) > 0;
        const hasPostedContent =
          (await frame.locator('text=게시물 내용').count()) > 0 ||
          (await frame.locator('textarea').count()) > 0 ||
          (await frame.locator('text=신분증을 첨부해 주세요').count()) > 0;

        if (hasAgree || hasYes || hasPostedContent) {
          return frame;
        }
      } catch {}
    }

    await page.waitForTimeout(500);
  }

  return null;
}

async function safeClickByText(frame, text) {
  try {
    const button = frame.getByRole('button', { name: text }).first();
    if ((await button.count()) > 0) {
      await button.click({ force: true });
      return;
    }
  } catch {}

  try {
    const locator = frame.locator(`text=${text}`).first();
    if ((await locator.count()) > 0) {
      await locator.click({ force: true });
      return;
    }
  } catch {}

  const ok = await frame.evaluate((targetText) => {
    const nodes = Array.from(document.querySelectorAll('button, div, span, a, label'));
    const target = nodes.find((el) => (el.innerText || '').includes(targetText));
    if (!target) return false;
    target.click();
    return true;
  }, text);

  if (!ok) {
    throw new Error(`"${text}" 클릭 실패`);
  }
}

async function clickIdentityButton(page) {
  console.log('"신분증 제출로 진행하기" 클릭 시도');

  const directForm = await waitForFormStepFrame(page, 4000).catch(() => null);
  if (directForm) {
    console.log('이미 신청서 폼으로 진입된 상태라 신분증 제출 버튼 단계는 건너뜁니다.');
    return;
  }

  const frame = await findFrameWithText(page, '신분증 제출로 진행하기');
  if (!frame) {
    throw new Error('"신분증 제출로 진행하기" 버튼을 찾지 못했습니다.');
  }

  await safeClickByText(frame, '신분증 제출로 진행하기');
}

async function clickYes(frame) {
  console.log('2단계: "네" 클릭');

  try {
    const label = frame.locator('label:has-text("네")').first();
    if ((await label.count()) > 0) {
      await label.scrollIntoViewIfNeeded().catch(() => {});
      await label.click({ force: true });
      console.log('"네" label 클릭 완료');
      return;
    }
  } catch (e) {
    console.log('네 label 실패:', e.message);
  }

  try {
    const radios = frame.locator('input[type="radio"]');
    const count = await radios.count();
    if (count >= 1) {
      const yesRadio = radios.nth(0);
      await yesRadio.scrollIntoViewIfNeeded().catch(() => {});
      await yesRadio.check({ force: true });
      console.log('"네" radio 체크 완료');
      return;
    }
  } catch (e) {
    console.log('네 radio 실패:', e.message);
  }

  const ok = await frame.evaluate(() => {
    const el = Array.from(document.querySelectorAll('label, div, span'))
      .find((node) => (node.innerText || '').trim() === '네');

    if (el) {
      el.click();
      return true;
    }

    const radios = document.querySelectorAll('input[type="radio"]');
    if (radios.length > 0) {
      radios[0].click();
      return true;
    }

    return false;
  });

  if (!ok) throw new Error('"네" 클릭 실패');
}

async function clickAgree(frame) {
  console.log('3단계: "동의" 클릭');

  try {
    const checkbox = frame.locator('input[type="checkbox"]').first();
    if ((await checkbox.count()) > 0) {
      await checkbox.scrollIntoViewIfNeeded().catch(() => {});
      await checkbox.check({ force: true });
      console.log('"동의" 체크 완료');
      return;
    }
  } catch (e) {
    console.log('동의 checkbox 실패:', e.message);
  }

  try {
    const label = frame.locator('label:has-text("동의")').first();
    if ((await label.count()) > 0) {
      await label.scrollIntoViewIfNeeded().catch(() => {});
      await label.click({ force: true });
      console.log('"동의" label 클릭 완료');
      return;
    }
  } catch (e) {
    console.log('동의 label 실패:', e.message);
  }

  const ok = await frame.evaluate(() => {
    const el = Array.from(document.querySelectorAll('label, div, span'))
      .find((node) => (node.innerText || '').trim() === '동의');

    if (el) {
      el.click();
      return true;
    }

    const cb = document.querySelector('input[type="checkbox"]');
    if (cb) {
      cb.click();
      return true;
    }

    return false;
  });

  if (!ok) throw new Error('"동의" 클릭 실패');
}

async function readPostedContent(frame) {
  console.log('게시물 내용 읽는중...');

  try {
    const textareas = frame.locator('textarea');
    const count = await textareas.count();

    dlog('폼 textarea 개수', count);

    for (let i = 0; i < count; i++) {
      const ta = textareas.nth(i);
      const value = normalizeText((await ta.inputValue().catch(() => '')) || '');
      dlog(`폼 textarea[${i}] 값`, value || '(없음)');
      if (isUsableReviewText(value)) {
        return value;
      }
    }
  } catch (e) {
    console.log('textarea 값 읽기 실패:', e.message);
  }

  try {
    const text = await frame.evaluate(() => {
      const labels = Array.from(document.querySelectorAll('div, label, p, span'));
      const title = labels.find((el) => (el.innerText || '').trim() === '게시물 내용');
      if (!title) return '';

      let node = title.parentElement;
      for (let depth = 0; depth < 4 && node; depth++) {
        const ta = node.querySelector('textarea');
        if (ta && ta.value) return ta.value;
        node = node.parentElement;
      }

      const allTa = Array.from(document.querySelectorAll('textarea'));
      const filled = allTa.find((t) => (t.value || '').trim());
      return filled ? filled.value : '';
    });

    dlog('JS로 읽은 게시물 내용', text || '(없음)');
    return isUsableReviewText(text) ? normalizeText(text || '') : '';
  } catch (e) {
    console.log('게시물 내용 JS 읽기 실패:', e.message);
  }

  return '';
}

async function readFormReviewMeta(frame) {
  try {
    const data = await frame.evaluate(() => {
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const isVisible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const valueOf = (el) => normalize(el?.value || el?.innerText || el?.textContent || '');
      const findByLabel = (labelPatterns, options = {}) => {
        const labels = Array.from(document.querySelectorAll('label, div, p, span, dt, th, strong'))
          .filter(isVisible);

        for (const label of labels) {
          const labelText = normalize(label.innerText || label.textContent || '');
          if (!labelText || !labelPatterns.some((pattern) => pattern.test(labelText))) continue;

          let node = label;
          for (let depth = 0; depth < 5 && node; depth += 1) {
            const fields = Array.from(node.querySelectorAll('textarea, input, [contenteditable="true"]'))
              .filter(isVisible)
              .map(valueOf)
              .filter(Boolean);
            if (fields.length) return options.longest ? fields.sort((a, b) => b.length - a.length)[0] : fields[0];

            const text = normalize(node.innerText || node.textContent || '');
            const withoutLabel = normalize(text.replace(labelText, ''));
            if (withoutLabel && withoutLabel !== text && withoutLabel.length < 1200) return withoutLabel;

            let sibling = node.nextElementSibling;
            while (sibling) {
              const siblingText = valueOf(sibling);
              if (siblingText) return siblingText;
              sibling = sibling.nextElementSibling;
            }
            node = node.parentElement;
          }
        }

        return '';
      };

      const allText = normalize(document.body?.innerText || '');
      const textareas = Array.from(document.querySelectorAll('textarea'))
        .filter(isVisible)
        .map((el) => normalize(el.value || el.innerText || ''))
        .filter(Boolean)
        .sort((a, b) => b.length - a.length);

      return {
        bodyText: allText,
        reviewText:
          findByLabel([/게시물\s*내용/, /리뷰\s*내용/, /본문/], { longest: true }) ||
          textareas[0] ||
          '',
        reviewId:
          findByLabel([/리뷰\s*번호/, /게시물\s*번호/]) ||
          '',
        reviewDateRaw:
          findByLabel([/리뷰\s*작성일/, /작성\s*일자/, /작성일/]) ||
          '',
      };
    });

    const bodyText = normalizeText(data?.bodyText || '');
    const reviewId = extractReviewIdFromText(data?.reviewId || '') || extractReviewIdFromText(bodyText);
    const reviewDateRaw = extractDateFromText(data?.reviewDateRaw || '') || extractDateFromText(bodyText);
    const reviewText = pickUsableReviewText(data?.reviewText || '', extractPostedContentFromMailText(bodyText));

    const result = { reviewId, reviewDateRaw, reviewText, bodyText };
    dlog('폼 리뷰 메타 추출 결과', result);
    writeMailTrace('form.meta', {
      reviewId,
      reviewDateRaw,
      reviewText,
      bodyTextSample: bodyText.slice(0, 1000),
    });
    return result;
  } catch (e) {
    console.log('폼 리뷰 메타 읽기 실패:', e.message);
    return {
      reviewId: '',
      reviewDateRaw: '',
      reviewText: '(없음)',
      bodyText: '',
    };
  }
}

async function fillNickname(frame, nickname) {
  console.log('작성자 닉네임 입력:', nickname);

  try {
    const input = frame.locator('input[placeholder*="닉네임"]').first();
    if ((await input.count()) > 0) {
      await input.scrollIntoViewIfNeeded().catch(() => {});
      await input.fill('');
      await input.fill(nickname);
      console.log('닉네임 입력 완료');
      return;
    }
  } catch {}

  try {
    const ok = await frame.evaluate((value) => {
      const inputs = Array.from(document.querySelectorAll('input'));
      const target =
        inputs.find((el) => (el.placeholder || '').includes('닉네임')) ||
        inputs.find((el) => /닉네임|작성자/i.test(el.getAttribute('aria-label') || '')) ||
        inputs.find((el) => /닉네임|작성자/i.test((el.name || '') + ' ' + (el.id || '')));
      if (!target) return false;
      target.focus();
      target.value = '';
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.value = value;
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, nickname);

    if (ok) {
      console.log('닉네임 JS 입력 완료');
      return;
    }
  } catch {}

  throw new Error('작성자 닉네임 입력 실패');
}

async function fillReason(frame, text) {
  console.log('권리침해 사유 입력');

  try {
    const textarea = frame.locator('textarea[placeholder*="권리 침해 사유"]').first();
    if ((await textarea.count()) > 0) {
      await textarea.scrollIntoViewIfNeeded().catch(() => {});
      await textarea.fill('');
      await textarea.fill(text);
      console.log('권리침해 사유 입력 완료');
      return;
    }
  } catch {}

  try {
    const ok = await frame.evaluate((value) => {
      const areas = Array.from(document.querySelectorAll('textarea'));
      const target =
        areas.find((el) => (el.placeholder || '').includes('권리 침해 사유')) ||
        areas[areas.length - 1];

      if (!target) return false;
      target.focus();
      target.value = '';
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.value = value;
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, text);

    if (ok) {
      console.log('권리침해 사유 JS 입력 완료');
      return;
    }
  } catch {}

  throw new Error('권리침해 사유 입력 실패');
}

async function findFrameContainingIdentitySection(page) {
  const candidates = [page, ...page.frames()];

  for (const frame of candidates) {
    try {
      const bodyText = normalizeText(await frame.locator('body').innerText({ timeout: 1000 }).catch(() => ''));
      if (
        bodyText.includes('신분증을 첨부해 주세요') ||
        bodyText.includes('신분증') ||
        bodyText.includes('첨부해 주세요')
      ) {
        return frame;
      }
    } catch {}
  }

  return null;
}

async function debugIdentitySection(frame) {
  try {
    const snapshot = await frame.evaluate(() => {
      const normalize = (s) => (s || '').replace(/\s+/g, ' ').trim();

      const buttons = Array.from(document.querySelectorAll('button, label, a, div, span'))
        .map((el) => normalize(el.innerText))
        .filter(Boolean)
        .filter((txt) => /파일|첨부|업로드|신분증|\+|0\/1|추가|선택/i.test(txt))
        .slice(0, 40);

      const fileInputs = Array.from(document.querySelectorAll('input[type="file"]')).map((el, idx) => ({
        index: idx,
        accept: el.getAttribute('accept') || '',
        id: el.id || '',
        name: el.name || '',
        multiple: !!el.multiple,
        hidden:
          el.hidden ||
          el.type === 'hidden' ||
          window.getComputedStyle(el).display === 'none' ||
          window.getComputedStyle(el).visibility === 'hidden',
      }));

      return { buttons, fileInputs };
    });

    dlog('신분증 섹션 버튼 후보', snapshot.buttons);
    dlog('신분증 섹션 file input 후보', snapshot.fileInputs);
    writeMailTrace('idcard.debug', snapshot);
  } catch (e) {
    console.log('신분증 디버그 수집 실패:', e.message);
  }
}

async function getIdentityFileInputCandidates(frame) {
  return await frame.evaluate(() => {
    const normalize = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return (
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        rect.width >= 0 &&
        rect.height >= 0
      );
    };

    const allNodes = Array.from(document.querySelectorAll('*'));
    const allFileInputs = Array.from(document.querySelectorAll('input[type="file"]'));

    const titleNode = allNodes.find((el) =>
      normalize(el.innerText).includes('신분증을 첨부해 주세요')
    );

    const titleRect = titleNode ? titleNode.getBoundingClientRect() : null;
    const titleBottom = titleRect ? titleRect.bottom : -999999;

    const nextSectionNode = allNodes.find((el) => {
      const txt = normalize(el.innerText);
      const rect = el.getBoundingClientRect();

      if (rect.top <= titleBottom + 5) return false;

      return (
        txt.includes('신청서에 기재된 이메일') ||
        txt.includes('필수 항목입니다') ||
        txt.includes('삭제/임시조치') ||
        txt.includes('첨부해 주세요') ||
        txt.includes('이메일 주소')
      );
    });

    const nextTop = nextSectionNode
      ? nextSectionNode.getBoundingClientRect().top
      : Number.POSITIVE_INFINITY;

    return allFileInputs
      .map((input, index) => {
        const rect = input.getBoundingClientRect();
        const parent = input.parentElement;
        const label = input.id
          ? document.querySelector(`label[for="${CSS.escape(input.id)}"]`)
          : null;

        const anchorEl = label || parent || input;
        const anchorRect = anchorEl ? anchorEl.getBoundingClientRect() : rect;
        const inputText = normalize(anchorEl?.innerText || parent?.innerText || input.getAttribute('aria-label') || '');

        const inRangeBySection = titleNode
          ? (
              (anchorRect.top >= titleBottom - 50 && anchorRect.top <= nextTop + 50) ||
              (rect.top >= titleBottom - 50 && rect.top <= nextTop + 50)
            )
          : /신분증|첨부|파일|업로드|\+|0\/1/i.test(inputText);

        return {
          index,
          top: rect.top || anchorRect.top || 0,
          bottom: rect.bottom || anchorRect.bottom || 0,
          width: rect.width || anchorRect.width || 0,
          height: rect.height || anchorRect.height || 0,
          inRange: inRangeBySection,
          connected: input.isConnected,
          disabled: !!input.disabled,
          hidden: !visible(input),
          accept: input.getAttribute('accept') || '',
          inputText,
        };
      })
      .filter((item) => item.connected && !item.disabled && item.inRange)
      .sort((a, b) => a.top - b.top);
  });
}

async function clickIdentityUploadTrigger(frame) {
  console.log('신분증 업로드 트리거 클릭 시도');

  const triggerTexts = [
    '파일 첨부',
    '파일첨부',
    '첨부',
    '업로드',
    '파일 선택',
    '파일선택',
    '추가',
    '신분증 첨부',
    '신분증 업로드',
    '파일 첨부',
    '파일첨부',
    '첨부',
    '업로드',
    '파일 선택',
    '파일선택',
    '추가',
    '신분증 첨부',
    '신분증 업로드',
  ];

  for (const text of triggerTexts) {
    try {
      const locator = frame.getByText(text, { exact: true }).first();
      if ((await locator.count()) > 0) {
        await locator.scrollIntoViewIfNeeded().catch(() => {});
        await locator.click({ force: true, timeout: 2000 });
        console.log(`신분증 업로드 트리거 클릭 완료(text=${text})`);
        return;
      }
    } catch {}
  }

  try {
    const clicked = await frame.evaluate(() => {
      const normalize = (s) => (s || '').replace(/\s+/g, ' ').trim();

      const nodes = Array.from(document.querySelectorAll('button, label, a, div, span'));
      const preferred = nodes.filter((el) => {
        const txt = normalize(el.innerText);
        return (
          txt.includes('파일 첨부') ||
          txt.includes('첨부') ||
          txt.includes('업로드') ||
          txt.includes('파일 선택') ||
          txt.includes('추가') ||
          txt.includes('0/1') ||
          txt === '+' ||
          txt.startsWith('+')
        );
      });

      if (preferred.length === 0) return false;

      const target = preferred[preferred.length - 1];
      target.scrollIntoView({ block: 'center' });
      target.click();
      return true;
    });

    if (clicked) {
      console.log('신분증 업로드 텍스트 트리거 클릭 완료');
      return;
    }
  } catch (e) {
    console.log('신분증 트리거 evaluate 클릭 실패:', e.message);
  }

  throw new Error('신분증 업로드 트리거 클릭 실패');
}

async function verifyIdCardUploaded(frame, expectedPath = '') {
  const expectedName = normalizeText(path.basename(expectedPath || ''));

  try {
    const uploaded = await frame.evaluate((name) => {
      const normalize = (s) => (s || '').replace(/\s+/g, ' ').trim();

      const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
      if (inputs.some((input) => input.files && input.files.length > 0)) {
        return true;
      }

      const bodyText = normalize(document.body?.innerText || '');
      if (name && bodyText.includes(name)) {
        return true;
      }

      return false;
    }, expectedName);

    return uploaded;
  } catch {
    return false;
  }
}

async function uploadByDirectInputs(frame, idCardPath) {
  const candidates = await getIdentityFileInputCandidates(frame);
  console.log(`신분증 file input 후보 개수: ${candidates.length}`);
  writeMailTrace('idcard.directCandidates', candidates);

  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const candidate = candidates[i];
      const locator = frame.locator('input[type="file"]').nth(candidate.index);
      await locator.setInputFiles(idCardPath, { timeout: 5000 });

      const ok = await verifyIdCardUploaded(frame, idCardPath);
      console.log(`신분증 direct input 업로드 완료 (candidate index=${candidate.index}), 확인=${ok}`);
      if (ok) return true;
    } catch (e) {
      console.log(`candidate ${candidates[i].index} direct 업로드 실패:`, e.message);
    }
  }

  return false;
}

async function uploadByAllFileInputs(frame, idCardPath) {
  const count = await frame.locator('input[type="file"]').count().catch(() => 0);
  console.log(`전체 file input fallback 후보 개수: ${count}`);
  writeMailTrace('idcard.allFileInputCount', count);

  for (let i = count - 1; i >= 0; i -= 1) {
    try {
      const locator = frame.locator('input[type="file"]').nth(i);
      await locator.setInputFiles(idCardPath, { timeout: 5000 });
      const ok = await verifyIdCardUploaded(frame, idCardPath);
      console.log(`전체 file input fallback 업로드 완료 (index=${i}), 확인=${ok}`);
      if (ok) return true;
    } catch (e) {
      console.log(`전체 file input fallback 실패 (index=${i}):`, e.message);
      writeMailTrace('idcard.allInputFailed', { index: i, message: e.message });
    }
  }

  return false;
}

async function uploadByFileChooser(frame, idCardPath) {
  const ownerPage = getOwnerPage(frame);

  try {
    const [chooser] = await Promise.all([
      ownerPage.waitForEvent('filechooser', { timeout: 7000 }),
      clickIdentityUploadTrigger(frame),
    ]);

    await chooser.setFiles(idCardPath);

    const ok = await verifyIdCardUploaded(frame, idCardPath);
    console.log(`신분증 filechooser 업로드 완료, 확인=${ok}`);
    return ok;
  } catch (e) {
    console.log('신분증 filechooser 방식 실패:', e.message);
    return false;
  }
}

async function uploadIdCardToIdentitySection(frame) {
  console.log('신분증 섹션 업로드 시작');

  let workingFrame = frame;
  const ownerPage = getOwnerPage(frame);

  try {
    const moreAccurateFrame = await findFrameContainingIdentitySection(ownerPage);
    if (moreAccurateFrame) {
      workingFrame = moreAccurateFrame;
    }
  } catch {}

  const idCardPath = resolveIdCardPath();
  const resolvedPath = path.resolve(idCardPath || '');
  console.log(`사용할 신분증 경로: ${resolvedPath}`);
  writeMailTrace('idcard.path', resolvedPath);
  await captureMailDebug(ownerPage, 'idcard-before-upload');

  if (!resolvedPath || !fs.existsSync(resolvedPath)) {
    throw new Error(`신분증 파일이 없습니다: ${resolvedPath || '(빈 경로)'}`);
  }

  await debugIdentitySection(workingFrame);

  try {
    const directOk = await uploadByDirectInputs(workingFrame, resolvedPath);
    if (directOk) return;
  } catch (e) {
    console.log('신분증 direct input 1차 실패:', e.message);
  }

  try {
    const allInputOk = await uploadByAllFileInputs(workingFrame, resolvedPath);
    if (allInputOk) return;
  } catch (e) {
    console.log('신분증 전체 input fallback 업로드 실패:', e.message);
  }

  try {
    const chooserOk = await uploadByFileChooser(workingFrame, resolvedPath);
    if (chooserOk) return;
  } catch (e) {
    console.log('신분증 filechooser 1차 실패:', e.message);
  }

  try {
    await clickIdentityUploadTrigger(workingFrame);
    await waitForTimeoutSafe(workingFrame, 1200);

    const directOk = await uploadByDirectInputs(workingFrame, resolvedPath);
    if (directOk) return;
  } catch (e) {
    console.log('신분증 fallback direct 업로드 실패:', e.message);
  }

  await debugIdentitySection(workingFrame);
  const screenshot = await captureMailDebug(ownerPage, 'idcard-upload-failed');
  const error = new Error('신분증 업로드 실패');
  appendUserError('naver.idcard_upload_failed', error, {
    idCardPath: resolvedPath,
    screenshot,
  });
  throw error;
}

async function clickFinalSubmitModal(page) {
  console.log('최종 제출 확인 팝업 찾는중...');

  const candidates = [page, ...page.frames()];

  for (const target of candidates) {
    try {
      const hasPopupTitle =
        (await target.locator('text=신청서를 제출할게요').count()) > 0 ||
        (await target.locator('text=제출 완료 시 신청서 수정이 불가하며').count()) > 0;

      if (!hasPopupTitle) continue;

      console.log('최종 제출 확인 팝업 발견:', getFrameUrl(target));

      try {
        const submitBtn = target.getByRole('button', { name: '제출' }).last();
        if ((await submitBtn.count()) > 0) {
          await submitBtn.click({ force: true });
          console.log('팝업 내 최종 "제출" 클릭 완료');
          return;
        }
      } catch (e) {
        console.log('팝업 role 제출 클릭 실패:', e.message);
      }

      try {
        const submitBtn = target.locator('button:has-text("제출")').last();
        if ((await submitBtn.count()) > 0) {
          await submitBtn.click({ force: true });
          console.log('팝업 내 button 제출 클릭 완료');
          return;
        }
      } catch (e) {
        console.log('팝업 button 제출 클릭 실패:', e.message);
      }

      try {
        const ok = await target.evaluate(() => {
          const normalize = (s) => (s || '').replace(/\s+/g, ' ').trim();
          const nodes = Array.from(document.querySelectorAll('button, div, span, a'));
          const targetNode = nodes.find((el) => normalize(el.innerText) === '제출');
          if (!targetNode) return false;
          targetNode.click();
          return true;
        });

        if (ok) {
          console.log('팝업 evaluate 최종 "제출" 클릭 완료');
          return;
        }
      } catch (e) {
        console.log('팝업 evaluate 제출 클릭 실패:', e.message);
      }
    } catch {}
  }

  console.log('최종 제출 확인 팝업을 못 찾았거나 자동으로 넘어감');
}

async function submitFormConfirmAndClose(page, frame) {
  console.log('"제출" 버튼 클릭 시도');

  let submitted = false;

  try {
    const btn = frame.getByRole('button', { name: '제출' }).first();
    if ((await btn.count()) > 0) {
      await btn.scrollIntoViewIfNeeded().catch(() => {});
      await btn.click({ force: true });
      submitted = true;
    }
  } catch (e) {
    console.log('제출 role button 실패:', e.message);
  }

  if (!submitted) {
    try {
      const btn = frame.locator('text=제출').last();
      if ((await btn.count()) > 0) {
        await btn.scrollIntoViewIfNeeded().catch(() => {});
        await btn.click({ force: true });
        submitted = true;
      }
    } catch (e) {
      console.log('제출 text 클릭 실패:', e.message);
    }
  }

  if (!submitted) {
    try {
      submitted = await frame.evaluate(() => {
        const normalize = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const nodes = Array.from(document.querySelectorAll('button, div, span, a'));
        const target = nodes.find((el) => normalize(el.innerText) === '제출');
        if (!target) return false;
        target.scrollIntoView({ block: 'center' });
        target.click();
        return true;
      });
    } catch (e) {
      console.log('제출 evaluate 클릭 실패:', e.message);
    }
  }

  if (!submitted) {
    throw new Error('"제출" 버튼 클릭 실패');
  }

  console.log('1차 "제출" 클릭 완료');
  await page.waitForTimeout(1200);

  await clickFinalSubmitModal(page);

  await page.waitForTimeout(2000);

  try {
    console.log('현재 폼 탭 종료 시도');
    await page.close({ runBeforeUnload: true }).catch(() => page.close());
    console.log('폼 탭 종료 완료');
  } catch (e) {
    console.log('폼 탭 종료 실패:', e.message);
  }

  writeMailTrace('form.submit.closed', { at: new Date().toISOString() });
}

async function readMailMeta(mailPage) {
  try {
    const fullText = normalizeText(
      await mailPage.evaluate(() => document.body?.innerText || '')
    );

    const html = await mailPage.content().catch(() => '');
    const hrefs = await mailPage.evaluate(() => {
      return Array.from(document.querySelectorAll('a'))
        .map((a) => a.href || '')
        .filter(Boolean);
    }).catch(() => []);

    const reviewText = extractPostedContentFromMailText(fullText);

    const reviewDateRaw =
      (isUsableReviewText(reviewText)
        ? extractDateFromText(fullText) || extractDateFromText(html)
        : '') ||
      extractDateFromText(fullText) ||
      extractDateFromText(html);

    const reviewId =
      extractReviewIdFromText(fullText) ||
      extractReviewIdFromText(html) ||
      extractReviewIdFromHrefs(hrefs);

    dlog('메일에서 추출한 작성일', reviewDateRaw || '(없음)');
    dlog('메일에서 추출한 리뷰번호', reviewId || '(없음)');
    dlog('메일에서 추출한 게시물내용', reviewText || '(없음)');

    return {
      fullText,
      reviewDateRaw,
      reviewId,
      reviewText,
      hrefs,
    };
  } catch (e) {
    console.log('메일 메타 읽기 실패:', e.message);
    return {
      fullText: '',
      reviewDateRaw: '',
      reviewId: '',
      reviewText: '(없음)',
      hrefs: [],
    };
  }
}

async function processOneMail(mailPage, context, reviewMeta = {}) {
  await closeAllPagesExcept(context, mailPage);
  await mailPage.bringToFront().catch(() => {});

  const mailMeta = await readMailMeta(mailPage);
  dlog('메일 메타 추출 결과', mailMeta);

  console.log('"신청서 제출하기" 새 탭 열기 시도...');
  const formPage = await moveToApplicationForm(mailPage, context);

  console.log('폼 페이지 이동 완료:', formPage.url());
  await formPage.waitForTimeout(3000);

  await clickIdentityButton(formPage);
  console.log('"신분증 제출로 진행하기" 클릭 완료');
  await formPage.waitForTimeout(2000);

  let formFrame = await waitForFormStepFrame(formPage);
  if (!formFrame) {
    throw new Error('신분증 제출 후 폼 프레임을 찾지 못했습니다.');
  }

  console.log('신분증 제출 후 폼 프레임 찾음:', getFrameUrl(formFrame));

  await clickYes(formFrame);
  await formPage.waitForTimeout(1000);

  formFrame = await waitForFormStepFrame(formPage);
  if (!formFrame) {
    throw new Error('"네" 클릭 후 폼 프레임을 찾지 못했습니다.');
  }

  await clickAgree(formFrame);
  await formPage.waitForTimeout(1000);

  formFrame = await waitForFormStepFrame(formPage);
  if (!formFrame) {
    throw new Error('"동의" 클릭 후 폼 프레임을 찾지 못했습니다.');
  }

  console.log('최종 폼 프레임:', getFrameUrl(formFrame));

  console.log('게시물 내용 읽는중...');
  const formReviewText = await readPostedContent(formFrame);
  const formMeta = await readFormReviewMeta(formFrame);

  const normalizedReviewText = pickUsableReviewText(
    formReviewText,
    formMeta.reviewText,
    reviewMeta.reviewText,
    mailMeta.reviewText
  );

  const normalizedReviewDate =
    normalizeDateToIso(reviewMeta.reviewDate || '') ||
    normalizeDateToIso(formMeta.reviewDateRaw || '') ||
    normalizeDateToIso(mailMeta.reviewDateRaw || '') ||
    '';

  const normalizedReviewId =
    normalizeText(reviewMeta.reviewId || '') ||
    normalizeText(formMeta.reviewId || '') ||
    normalizeText(mailMeta.reviewId || '');

  dlog('최종 매칭용 리뷰내용', normalizedReviewText);
  dlog('최종 매칭용 리뷰작성일', normalizedReviewDate || '(없음)');
  dlog('최종 매칭용 리뷰번호', normalizedReviewId || '(없음)');

  const matched = await findBestLogMatch({
    ...reviewMeta,
    reviewDate: normalizedReviewDate,
    reviewId: normalizedReviewId,
    reviewText: normalizedReviewText,
    formReviewText: normalizedReviewText,
    mailMeta,
    formMeta,
  });

  dlog('로그 매칭 결과', matched);

  const finalNickname = normalizeText(matched?.nickname || '');
  if (!finalNickname) {
    console.log('[경고] 매칭된 로그에 닉네임이 없음. 로그 기록 후 skip 처리');
    writeMailTrace('nickname.missing', {
      reviewId: normalizedReviewId,
      reviewDate: normalizedReviewDate,
      reviewText: normalizedReviewText,
      matched,
    });
    appendUserError('naver.nickname_exact_match_failed', new Error('닉네임 없음'), {
      reviewDate: normalizedReviewDate,
      reviewId: normalizedReviewId,
      reviewText: normalizedReviewText,
      matched,
    });
    throw new Error('정확히 매칭된 리뷰 로그에 닉네임이 없습니다.');
  }

  writeMailTrace('nickname.final', {
    finalNickname,
    matched: !!matched,
    reviewDate: matched?.reviewDate || normalizedReviewDate || '',
    reviewId: matched?.reviewId || normalizedReviewId || '',
    reviewText: matched?.reviewText || normalizedReviewText || '',
    fileName: matched?.fileName || '',
  });

  console.log('최종 닉네임 입력값:', {
    finalNickname,
    matched: !!matched,
    reviewDate: matched?.reviewDate || normalizedReviewDate || '',
    reviewId: matched?.reviewId || normalizedReviewId || '',
    reviewText: matched?.reviewText || normalizedReviewText || '',
    fileName: matched?.fileName || '',
  });

  await fillNickname(formFrame, finalNickname);
  await formPage.waitForTimeout(500);

  const apology = await generateReviewCareApology({
    reviewText: normalizedReviewText,
    storeName: process.env.STORE_NAME || '매장',
  });

  console.log('생성 사과문:', apology);

  await fillReason(formFrame, apology);
  await formPage.waitForTimeout(700);

  await uploadIdCardToIdentitySection(formFrame);
  await formPage.waitForTimeout(1500);

  await submitFormConfirmAndClose(formPage, formFrame);

  await closeAllPagesExcept(context, mailPage);
  await mailPage.bringToFront().catch(() => {});
  await mailPage.waitForTimeout(1500);

  writeMailTrace('naver.mail.form_done', {
    reviewId: normalizedReviewId,
    reviewDate: normalizedReviewDate,
    fileName: matched?.fileName || '',
  });

  return {
    matchedLog: matched,
    apology,
    formReviewText: normalizedReviewText,
    finalNickname,
    submitted: true,
  };
}

function isSkippableLogMatchError(error) {
  const message = String(error?.message || error || '');
  return (
    message.includes('리뷰 로그를 찾지 못했습니다') ||
    message.includes('리뷰 로그에 닉네임이 없습니다')
  );
}

function buildMailProcessKey(subject = '', mailMeta = {}) {
  const reviewId = normalizeText(mailMeta.reviewId || '');
  if (reviewId) return `reviewId:${reviewId}`;

  const date = normalizeDateToIso(mailMeta.reviewDateRaw || '') || normalizeText(mailMeta.reviewDateRaw || '');
  const reviewText = normalizeReviewText(mailMeta.reviewText || '');
  const hrefKey = Array.isArray(mailMeta.hrefs) ? mailMeta.hrefs.slice(0, 3).join('|') : '';

  return normalizeText([
    'subject',
    normalizeText(subject || ''),
    'date',
    date,
    'text',
    reviewText,
    'href',
    hrefKey,
  ].join(':'));
}

async function closeAllPagesExcept(context, keepPage) {
  const pages = (context.pages && context.pages()) || [];
  for (const p of pages) {
    if (p === keepPage) continue;
    if (typeof p.isClosed === 'function' && p.isClosed()) continue;
    try {
      await p.close({ runBeforeUnload: true }).catch(() => {});
    } catch {
      try {
        await p.close();
      } catch {}
    }
  }
}

async function deleteCurrentMailWithRetry(page, previousSubject = '', attempts = 4) {
  for (let i = 0; i < attempts; i += 1) {
    if (await deleteCurrentMail(page, previousSubject)) return true;
    await page.waitForTimeout(700);
  }
  return false;
}

async function deleteCurrentMail(page, previousSubject = '') {
  console.log('처리 완료 메일 삭제 시도');

  const selectors = [
    'button:has-text("삭제")',
    'a:has-text("삭제")',
    '[role="button"]:has-text("삭제")',
    '[aria-label*="삭제"]',
    '[title*="삭제"]',
  ];

  for (const selector of selectors) {
    try {
      const loc = page.locator(selector).first();
      if ((await loc.count()) > 0) {
        await loc.click({ force: true, timeout: 3000 });
        await page.waitForTimeout(1200);
        console.log(`메일 삭제 클릭 완료(selector=${selector})`);
        return true;
      }
    } catch (e) {
      console.log(`메일 삭제 selector 실패(${selector}):`, e.message);
    }
  }

  try {
    const clicked = await page.evaluate(() => {
      const normalize = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const visible = (el) => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const nodes = Array.from(document.querySelectorAll('button, a, span, div'));
      const target = nodes.find((el) => {
        if (!visible(el)) return false;
        const text = normalize(el.innerText || '');
        const aria = normalize(el.getAttribute?.('aria-label') || '');
        const title = normalize(el.getAttribute?.('title') || '');
        return text === '삭제' || aria.includes('삭제') || title.includes('삭제');
      });
      if (!target) return false;
      target.click();
      return true;
    });

    if (clicked) {
      await page.waitForTimeout(1200);
      console.log('메일 삭제 클릭 완료(evaluate)');
      return true;
    }
  } catch (e) {
    console.log('메일 삭제 evaluate 실패:', e.message);
  }

  console.log('메일 삭제 버튼을 찾지 못했습니다. 다음 메일 이동으로 대체합니다.');
  writeMailTrace('mail.delete.failed', { previousSubject });
  return false;
}

async function openNaverMail(reviewMeta = {}) {
  console.log('네이버 메일 접속중...');

  const browser = await launchChromiumWithFallback({
    headless: false,
    channel: 'chrome',
    slowMo: 80,
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(NAVER_INBOX_URL, {
    waitUntil: 'domcontentloaded',
  });

  console.log('메일 페이지 열림');
  await page.waitForTimeout(5000);

  await openFirstTargetMail(page, { timeout: 0 });

  let processedCount = 0;
  const processedMailKeys = loadProcessedMailKeys();

  while (true) {
    await page.bringToFront().catch(() => {});
    await page.waitForTimeout(1500);

    const currentSubject = await getCurrentMailSubject(page);
    console.log('현재 메일 제목:', currentSubject || '(제목없음)');

    if (!currentSubject || !normalizeText(currentSubject).includes(TARGET_MAIL_SUBJECT)) {
      console.log('대상 메일이 아니므로 종료');
      break;
    }

    console.log(`=== ${processedCount + 1}번째 대상 메일 처리 시작 ===`);

    const mailMetaForKey = await readMailMeta(page).catch(() => ({}));
    const mailKey = buildMailProcessKey(currentSubject, mailMetaForKey);
    if (mailKey && processedMailKeys.has(mailKey)) {
      console.log('이미 처리 완료 기록이 있는 네이버 메일이라서 건너뜀:', mailKey);
      writeMailTrace('mail.skip.already_processed', { currentSubject, mailKey, mailMetaForKey });
      const deleted = await deleteCurrentMail(page, currentSubject);
      if (deleted) {
        await goToNaverInbox(page).catch(() => {});
        const opened = await openFirstTargetMail(page, { timeout: 5000 });
        if (opened) continue;
      }

      const moved = await clickMailNextArrowAndWait(page, currentSubject);
      if (moved) continue;

      console.log('이미 처리한 메일을 벗어나지 못해 종료');
      break;
    }

    let processOk = false;
    try {
      await processOneMail(page, context, {
        ...reviewMeta,
        reviewId: reviewMeta.reviewId || mailMetaForKey.reviewId || '',
        reviewDate: reviewMeta.reviewDate || mailMetaForKey.reviewDateRaw || '',
        reviewText: reviewMeta.reviewText || mailMetaForKey.reviewText || '',
        nickname: reviewMeta.nickname || mailMetaForKey.nickname || '',
      });
      processOk = true;
      processedCount += 1;
      markProcessedMailKey(processedMailKeys, mailKey, mailMetaForKey);
      console.log(`=== ${processedCount}번째 대상 메일 처리 완료 ===`);
    } catch (error) {
      if (!isSkippableLogMatchError(error)) throw error;
      console.log(`로그 매칭 실패로 현재 메일 건너뜀: ${error.message}`);
      appendUserError('naver.mail_skipped_no_log_match', error, {
        currentSubject,
        mailKey,
        mailMetaForKey,
        logDir: REVIEW_LOG_DIR,
      });
    }

    if (MAX_NAVER_MAILS > 0 && processedCount >= MAX_NAVER_MAILS) {
      console.log(`MAX_NAVER_MAILS(${MAX_NAVER_MAILS}) 도달 -> 종료`);
      break;
    }

    let moved = false;
    if (processOk) {
      await closeAllPagesExcept(context, page);
      await page.bringToFront().catch(() => {});

      const deletedOk = await deleteCurrentMailWithRetry(page, currentSubject, 5);
      if (!deletedOk) {
        writeMailTrace('mail.delete.all_retries_failed', { currentSubject });
        console.log('메일 삭제 재시도에도 실패했습니다. 수신함으로 돌아가 다음 메일을 다시 찾습니다.');
      } else {
        console.log('처리 완료 메일 삭제됨');
      }

      await goToNaverInbox(page).catch(() => {});
      await page.waitForTimeout(1200);
      moved = await openFirstTargetMail(page, { timeout: 25000 });
    }

    if (!moved) {
      moved = await clickMailNextArrowAndWait(page, currentSubject);
    }

    if (!moved) {
      await goToNaverInbox(page).catch(() => {});
      await page.waitForTimeout(800);
      moved = await openFirstTargetMail(page, { timeout: 12000 });
    }

    if (!moved) {
      console.log('다음 대상 메일을 찾지 못해 종료합니다.');
      break;
    }

    const nextSubject = await getCurrentMailSubject(page);
    console.log('이동 후 메일 제목:', nextSubject || '(제목없음)');

    if (!nextSubject || !normalizeText(nextSubject).includes(TARGET_MAIL_SUBJECT)) {
      console.log('다음 메일이 더 이상 대상 메일이 아니므로 종료');
      break;
    }
  }

  return {
    browser,
    context,
    page,
    processedCount,
  };
}

async function runNaverMailProcess() {
  console.log('네이버 메일 자동화 시작');
  console.log(`사용 로그 폴더: ${REVIEW_LOG_DIR}`);
  const idCardPath = resolveIdCardPath();
  console.log(`사용 신분증 경로: ${idCardPath}`);

  if (!idCardPath || !fs.existsSync(idCardPath)) {
    throw new Error(`UI에 입력한 신분증 파일을 찾지 못했습니다: ${idCardPath || '(빈 경로)'}`);
  }

  let session = null;
  try {
    session = await openNaverMail({
      storeName: process.env.STORE_NAME || '매장',
    });
  } catch (error) {
    appendUserError('naver.mail_process_failed', error, {
      idCardPath,
      logDir: REVIEW_LOG_DIR,
    });
    throw error;
  }

  console.log('네이버 메일 자동화 종료');
  if (session?.browser) {
    await session.browser.close().catch(() => {});
  }
}

async function runNaverMail() {
  console.log('네이버 메일 실행');
  await runNaverMailProcess();
}

module.exports = { runNaverMail };


