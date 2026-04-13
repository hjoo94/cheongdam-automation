const fs = require('fs');
const path = require('path');
require('dotenv').config();

const { log } = require('../utils/logger');
const { waitForEnter, sleep, cleanLines } = require('../utils/common');
const { classifyReview } = require('../utils/reviewClassifier');
const { getLogDir, getCoupangProfileDir, ensureDir } = require('../utils/runtimePaths');
const {
  appendUniqueBlindReviewLog,
  getMonthlyBlindReviewLogFilename,
} = require('../utils/reviewLogManager');
const { buildReviewLogText } = require('../utils/reviewLogFormatter');
const { launchPersistentChromiumWithFallback } = require('../utils/browserLauncher');
const { clickNextCoupangReviewPage } = require('../utils/coupangPagination');
const { appendUserError } = require('../utils/errorCollector');

const MAX_REVIEWS = Number(process.env.MAX_REVIEWS || 9999);
const REVIEW_REFRESH_BATCH = 5;
const MAX_IDLE_ROUNDS = 5;

const COUPANG_PROFILE_DIR = getCoupangProfileDir();
const COUPANG_REVIEW_CARE_URL =
  process.env.COUPANG_REVIEW_CARE_URL ||
  'https://design.happytalkio.com/chatting?siteId=4000002553&siteName=%EC%BF%A0%ED%8C%A1%EC%9D%B4%EC%B8%A0&categoryId=154858&divisionId=155774&partnerId=&shopId=&params=';
const COUPANG_STORE_ID = process.env.COUPANG_STORE_ID || process.env.STORE_ID || '';
const COUPANG_BIZ_NO = process.env.COUPANG_BIZ_NO || process.env.BIZ_NO || '';
const AUTO_SUBMIT_REVIEW_CARE =
  String(process.env.AUTO_SUBMIT_REVIEW_CARE).toLowerCase() === 'true';
const HAPPYTALK_ACTION_DELAY_MS = Number(process.env.HAPPYTALK_ACTION_DELAY_MS || 350);
const HAPPYTALK_RETRY_INTERVAL_MS = Number(process.env.HAPPYTALK_RETRY_INTERVAL_MS || 120);
const COUPANG_BLIND_TRACE =
  String(process.env.COUPANG_BLIND_TRACE || 'false').toLowerCase() === 'true';

function ensureDataDir() {
  const dir = getLogDir();
  ensureDir(dir);
  return dir;
}

function saveJson(filename, data) {
  const dir = ensureDataDir();
  const file = path.join(dir, filename);
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  return file;
}

function appendJsonl(filename, data) {
  const dir = ensureDataDir();
  const file = path.join(dir, filename);
  fs.appendFileSync(file, JSON.stringify(data) + '\n', 'utf8');
  return file;
}

function safeFilename(text = '') {
  return String(text || '')
    .replace(/[^a-z0-9가-힣_.-]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 90) || 'unknown';
}

async function saveHappyTalkDebugArtifacts(page, reason = 'unknown', context = {}) {
  const dir = ensureDataDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = `coupang-happytalk-${stamp}-${safeFilename(reason)}`;
  const screenshotPath = path.join(dir, `${base}.png`);
  const jsonPath = path.join(dir, `${base}.json`);

  const data = await page.evaluate(() => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const nodes = Array.from(document.querySelectorAll('button, a, [role="button"], textarea, input, [contenteditable="true"], div[role="textbox"], div, span'));
    const candidates = nodes
      .map((el, index) => {
        const rect = el.getBoundingClientRect();
        return {
          index,
          tag: el.tagName,
          text: normalize(el.innerText || el.textContent || '').slice(0, 200),
          aria: normalize(el.getAttribute('aria-label') || ''),
          title: normalize(el.getAttribute('title') || ''),
          placeholder: normalize(el.getAttribute('placeholder') || ''),
          role: normalize(el.getAttribute('role') || ''),
          className: normalize(el.className || '').slice(0, 200),
          visible: isVisible(el),
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        };
      })
      .filter((item) => item.visible && (item.text || item.aria || item.title || item.placeholder || item.role))
      .slice(0, 250);

    return {
      url: location.href,
      title: document.title,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      bodyText: normalize(document.body?.innerText || '').slice(0, 8000),
      candidates,
    };
  }).catch((error) => ({ error: error.message }));

  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(async () => {
    await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => {});
  });

  fs.writeFileSync(jsonPath, JSON.stringify({
    reason,
    savedAt: new Date().toISOString(),
    context,
    ...data,
  }, null, 2), 'utf8');

  return { screenshotPath, jsonPath };
}

async function traceHappyTalk(page, label, context = {}) {
  if (!COUPANG_BLIND_TRACE) return null;
  const startedAt = Date.now();
  const dump = await saveHappyTalkDebugArtifacts(page, label, context).catch((error) => ({
    error: error.message,
  }));
  const elapsedMs = Date.now() - startedAt;
  const timingPath = appendJsonl('coupang-blind-happytalk-timing.jsonl', {
    at: new Date().toISOString(),
    label,
    elapsedMs,
    screenshotPath: dump?.screenshotPath || '',
    jsonPath: dump?.jsonPath || '',
    error: dump?.error || '',
    context,
  });
  log(`[쿠팡 블라인드 TRACE] ${label} ${elapsedMs}ms screenshot=${dump?.screenshotPath || '(none)'} timing=${timingPath}`);
  return { ...dump, elapsedMs, timingPath };
}

async function timedHappyTalkAction(page, label, action, context = {}) {
  const startedAt = Date.now();
  await traceHappyTalk(page, `${label}-before`, context);
  try {
    const result = await action();
    const elapsedMs = Date.now() - startedAt;
    await traceHappyTalk(page, `${label}-after`, { ...context, elapsedMs, ok: true });
    appendJsonl('coupang-blind-happytalk-timing.jsonl', {
      at: new Date().toISOString(),
      label,
      elapsedMs,
      ok: true,
      context,
    });
    log(`[쿠팡 블라인드 TIMER] ${label} 완료 ${elapsedMs}ms`);
    return result;
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    await traceHappyTalk(page, `${label}-error`, { ...context, elapsedMs, error: error.message });
    appendJsonl('coupang-blind-happytalk-timing.jsonl', {
      at: new Date().toISOString(),
      label,
      elapsedMs,
      ok: false,
      error: error.message,
      context,
    });
    log(`[쿠팡 블라인드 TIMER] ${label} 실패 ${elapsedMs}ms: ${error.message}`);
    throw error;
  }
}

function normalizeText(value = '') {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(text = '') {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = String(text || '').match(pattern);
    if (match) return match[1] || match[0] || '';
  }
  return '';
}

function parseOrderNumberAndDate(value = '') {
  const text = normalizeText(value);
  const number = firstMatch(text, [
    /([A-Z0-9]{8,})/,
    /주문번호\s*[:：]?\s*([A-Z0-9-]+)/i,
  ]);
  const date = firstMatch(text, [
    /(\d{4}[-./]\d{1,2}[-./]\d{1,2})/,
    /(\d{4}\s*년\s*\d{1,2}\s*월\s*\d{1,2}\s*일)/,
  ]);
  return { number, date };
}

function normalizeOrderNumber(value = '') {
  const text = String(value || '').toUpperCase();
  const match = text.match(/[A-Z0-9]{5,}/);
  return match ? match[0] : text.replace(/[^A-Z0-9]/g, '');
}

function normalizeOrderDate(value = '') {
  const text = normalizeText(value);
  let match = text.match(/(\d{4})[-./](\d{1,2})[-./](\d{1,2})/);
  if (!match) {
    match = text.match(/(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/);
  }
  if (!match) return text;
  const [, y, m, d] = match;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function buildCoupangOrderLookupText(review = {}) {
  const orderNumber = normalizeOrderNumber(review.orderNumber || '');
  const orderDate = normalizeOrderDate(review.orderDate || review.date || '');
  if (!orderNumber || !orderDate) {
    throw new Error('쿠팡 주문번호/작성일 제출값을 만들 수 없습니다.');
  }
  return `${orderNumber}/${orderDate}`;
}

function parseCoupangReviewCardLines(lines) {
  const text = normalizeText(lines.join('\n'));
  let customerName = '';
  let date = '';
  let reviewText = '';
  let orderMenu = '';
  let orderNumber = '';
  let orderDate = '';
  let receiveType = '';

  for (let i = 0; i < lines.length; i++) {
    const line = normalizeText(lines[i]);
    const next = normalizeText(lines[i + 1] || '');

    if (!customerName) {
      const match = line.match(/^(.+?)(?:\d+\s*회\s*주문|\d+.*주문)$/);
      if (match) customerName = normalizeText(match[1]);
    }

    if (!date && /^\d{4}[-./]\d{1,2}[-./]\d{1,2}$/.test(line)) {
      date = line;
    }

    if (!orderMenu && /주문\s*메뉴/.test(line) && next) {
      orderMenu = next;
    }

    if (!orderNumber && /주문\s*번호/.test(line) && next) {
      const parsed = parseOrderNumberAndDate(next);
      orderNumber = parsed.number || next;
      orderDate = parsed.date || '';
    }

    if (!receiveType && /수령|배달|포장/.test(line) && next && !/주문|리뷰/.test(line)) {
      receiveType = next;
    }
  }

  const parsedOrder = parseOrderNumberAndDate(text);
  if (!orderNumber) orderNumber = parsedOrder.number;
  if (!orderDate) orderDate = parsedOrder.date;

  const bodyCandidates = lines
    .map(normalizeText)
    .filter((line) => {
      if (!line) return false;
      if (line === customerName || line === orderMenu || line === receiveType) return false;
      if (line.includes(orderNumber) && orderNumber) return false;
      if (/^\d{4}[-./]\d{1,2}[-./]\d{1,2}$/.test(line)) return false;
      if (/주문\s*메뉴|주문\s*번호|수령\s*방식|사장님|등록|취소|리뷰\s*작성일|리뷰\s*내용/.test(line)) return false;
      if (/^\d+\s*회\s*주문/.test(line)) return false;
      return true;
    });

  reviewText = bodyCandidates[0] || '';

  return {
    customerName,
    date,
    reviewText,
    orderMenu,
    orderNumber,
    orderDate,
    receiveType,
  };
}

async function getReviewCardHandles(page) {
  const cards = [];
  const selectors = [
    'tr:has-text("주문번호")',
    'tr:has-text("주문메뉴")',
    '[class*="review"]:has-text("주문번호")',
    'div:has-text("주문번호")',
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const handle = await locator.nth(i).elementHandle().catch(() => null);
      if (handle) cards.push(handle);
    }
    if (cards.length) break;
  }

  return cards;
}

async function extractRatingFromCard(cardHandle) {
  try {
    const rating = await cardHandle.evaluate((node) => {
      const text = node.innerText || '';
      const numberMatch = text.match(/(?:별점|평점)\s*[:：]?\s*([1-5])/);
      if (numberMatch) return Number(numberMatch[1]);

      const allEls = [node, ...node.querySelectorAll('*')];
      const stars = [];
      const isYellowLike = (colorText) => {
        const lower = String(colorText || '').toLowerCase();
        if (lower.includes('yellow') || lower.includes('gold') || lower.includes('orange')) return true;
        const m = lower.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (!m) return false;
        const r = Number(m[1]);
        const g = Number(m[2]);
        const b = Number(m[3]);
        return r >= 200 && g >= 140 && b <= 180;
      };

      for (const el of allEls) {
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0 || rect.width > 40 || rect.height > 40) continue;
        const style = window.getComputedStyle(el);
        const textContent = (el.textContent || '').trim();
        const looksLikeStar =
          /★|별|star|rating|score/i.test(textContent) ||
          /star|rating|score|icon/i.test(String(el.className || '')) ||
          ['svg', 'path', 'polygon', 'img', 'i'].includes((el.tagName || '').toLowerCase());
        if (!looksLikeStar) continue;
        if (
          isYellowLike(style.color) ||
          isYellowLike(style.fill) ||
          isYellowLike(style.stroke) ||
          isYellowLike(style.backgroundColor)
        ) {
          stars.push({ left: rect.left, top: rect.top });
        }
      }

      if (!stars.length) return null;
      stars.sort((a, b) => (Math.abs(a.top - b.top) > 8 ? a.top - b.top : a.left - b.left));
      const top = stars[0].top;
      const sameRow = stars.filter((v) => Math.abs(v.top - top) <= 10);
      return sameRow.length >= 1 && sameRow.length <= 5 ? sameRow.length : null;
    });

    return rating >= 1 && rating <= 5 ? rating : null;
  } catch {
    return null;
  }
}

async function extractSingleReviewFromCard(cardHandle) {
  const text = await cardHandle.evaluate((node) => node.innerText || '');
  const lines = cleanLines(text);
  const parsed = parseCoupangReviewCardLines(lines);
  const rating = await extractRatingFromCard(cardHandle);

  return {
    platform: 'coupang_eats',
    ...parsed,
    rating,
    hasPhoto: false,
    reviewType: classifyReview({
      reviewText: parsed.reviewText,
      hasPhoto: false,
    }),
    rawLines: lines,
  };
}

function appendBlindReviewLog(review) {
  const reviewId = review.orderNumber || review.__key || '';
  const text = buildReviewLogText({
    platform: 'coupang_eats',
    platformLabel: 'Coupang Eats Blind',
    featureKey: 'coupangBlind',
    customerName: review.customerName,
    reviewDate: review.date || review.orderDate,
    reviewId,
    rating: review.rating,
    reviewType: 'low_rating_report',
    orderMenu: review.orderMenu,
    body: review.reviewText,
    action: 'review_care_submitted',
    actionLabel: 'blind request submitted',
  });

  return appendUniqueBlindReviewLog({
    dateText: review.date || review.orderDate || '',
    reviewId,
    text,
  });
}

async function getAllSearchRoots(page) {
  const roots = [page];
  try {
    for (const frame of page.frames()) {
      if (frame !== page.mainFrame()) roots.push(frame);
    }
  } catch {
    // ignore
  }
  return roots;
}

async function clickTextAnywhere(page, targetText, options = {}) {
  const timeout = options.timeout || 8000;
  const retryInterval = options.retryInterval || HAPPYTALK_RETRY_INTERVAL_MS;
  const verifyChange = options.verifyChange === true;
  const start = Date.now();
  const normalizedTarget = normalizeText(targetText);
  const targetRegex = new RegExp(escapeRegExp(normalizedTarget), 'i');

  while (Date.now() - start < timeout) {
    const roots = await getAllSearchRoots(page);
    for (const root of roots) {
      const beforeText = verifyChange ? await getHappyTalkBodyText(page).catch(() => '') : '';
      const fastClicked = await root.evaluate((target) => {
        const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const isVisible = (el) => {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const clickableSelector = [
          'button',
          'a',
          '[role="button"]',
          'label',
          '[onclick]',
          '[class*="button"]',
          '[class*="Button"]',
          '[class*="btn"]',
          '[class*="Btn"]',
        ].join(',');
        const nodes = Array.from(document.querySelectorAll(clickableSelector));
        const exact = [];
        const partial = [];
        for (const node of nodes) {
          if (!isVisible(node)) continue;
          const text = normalize(node.innerText || node.textContent || node.getAttribute('aria-label') || node.getAttribute('title') || '');
          if (!text) continue;
          if (text === target) exact.push(node);
          else if (text.includes(target)) partial.push(node);
        }
        const picked = exact[0] || partial[0];
        if (!picked) return false;
        picked.scrollIntoView({ block: 'center', inline: 'center' });
        picked.click();
        return true;
      }, normalizedTarget).catch(() => false);

      if (fastClicked) {
        await sleep(HAPPYTALK_ACTION_DELAY_MS);
        if (!verifyChange) return true;
        const verifyStart = Date.now();
        while (Date.now() - verifyStart < 900) {
          const textNow = await getHappyTalkBodyText(page).catch(() => '');
          if (textNow !== beforeText || !textNow.includes(normalizedTarget)) return true;
          await sleep(100);
        }
      }

      const candidates = [
        root.getByRole('button', { name: targetRegex }),
        root.getByRole('link', { name: targetRegex }),
        root.getByText(targetRegex),
        root.locator('button'),
        root.locator('a'),
        root.locator('[role="button"]'),
        root.locator('div'),
        root.locator('span'),
      ];

      for (const locator of candidates) {
        const count = await locator.count().catch(() => 0);
        for (let i = 0; i < count; i++) {
          const el = locator.nth(i);
          try {
            if (!(await el.isVisible().catch(() => false))) continue;
            const text = normalizeText(await el.innerText().catch(() => ''));
            const aria = normalizeText(await el.getAttribute('aria-label').catch(() => ''));
            const title = normalizeText(await el.getAttribute('title').catch(() => ''));
            if (!text.includes(normalizedTarget) && !aria.includes(normalizedTarget) && !title.includes(normalizedTarget)) {
              continue;
            }
            const clickableHandle = await el.elementHandle().then((handle) => {
              if (!handle) return null;
              return handle.evaluateHandle((node) => {
                const selector = [
                  'button',
                  'a',
                  '[role="button"]',
                  'label',
                  '[onclick]',
                  'input',
                  'textarea',
                  '[contenteditable="true"]',
                  '[class*="button"]',
                  '[class*="Button"]',
                  '[class*="btn"]',
                  '[class*="Btn"]',
                ].join(',');
                const direct = node.closest(selector);
                if (direct) return direct;

                let current = node;
                for (let depth = 0; current && depth < 6; depth += 1) {
                  const style = window.getComputedStyle(current);
                  const rect = current.getBoundingClientRect();
                  if (style.cursor === 'pointer' && rect.width > 0 && rect.height > 0) {
                    return current;
                  }
                  current = current.parentElement;
                }
                return null;
              }).catch(() => null);
            }).catch(() => null);
            const clickable = clickableHandle?.asElement?.();
            if (!clickable) continue;

            const beforeText = verifyChange ? await getHappyTalkBodyText(page).catch(() => '') : '';
            await clickable.scrollIntoViewIfNeeded().catch(() => {});
            await sleep(50);
            await clickable.click({ timeout: 900 }).catch(async () => {
              const box = await clickable.boundingBox().catch(() => null);
              if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
            });
            await sleep(HAPPYTALK_ACTION_DELAY_MS);
            if (verifyChange) {
              let changed = false;
              const verifyStart = Date.now();
              while (Date.now() - verifyStart < 1200) {
                const textNow = await getHappyTalkBodyText(page).catch(() => '');
                if (textNow !== beforeText || !textNow.includes(normalizedTarget)) {
                  changed = true;
                  break;
                }
                await sleep(150);
              }
              if (!changed) continue;
            }
            return true;
          } catch {
            // next
          }
        }
      }
    }
    await sleep(retryInterval);
  }

  return false;
}

async function clickAnyText(page, targetTexts, options = {}) {
  const timeout = options.timeout || 8000;
  const retryInterval = options.retryInterval || HAPPYTALK_RETRY_INTERVAL_MS;
  const verifyChange = options.verifyChange === true;
  const targets = (targetTexts || []).map(normalizeText).filter(Boolean);
  const start = Date.now();

  while (targets.length && Date.now() - start < timeout) {
    const roots = await getAllSearchRoots(page);
    for (const root of roots) {
      const beforeText = verifyChange ? await getHappyTalkBodyText(page).catch(() => '') : '';
      const matched = await root.evaluate((items) => {
        const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const isVisible = (el) => {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const findClickable = (node) => {
          const selector = [
            'button',
            'a',
            '[role="button"]',
            'label',
            '[onclick]',
            '[class*="button"]',
            '[class*="Button"]',
            '[class*="btn"]',
            '[class*="Btn"]',
          ].join(',');
          return node.closest(selector) || node;
        };
        const nodes = Array.from(document.querySelectorAll('button,a,[role="button"],label,[onclick],div,span'));
        const exact = [];
        const partial = [];
        for (const node of nodes) {
          if (!isVisible(node)) continue;
          const text = normalize(node.innerText || node.textContent || node.getAttribute('aria-label') || node.getAttribute('title') || '');
          if (!text) continue;
          for (const target of items) {
            if (text === target) exact.push({ node, target });
            else if (text.includes(target)) partial.push({ node, target });
          }
        }
        const picked = exact[0] || partial[0];
        if (!picked) return '';
        const clickable = findClickable(picked.node);
        clickable.scrollIntoView({ block: 'center', inline: 'center' });
        clickable.click();
        return picked.target;
      }, targets).catch(() => '');

      if (matched) {
        await sleep(HAPPYTALK_ACTION_DELAY_MS);
        if (!verifyChange) return { ok: true, matched };
        const verifyStart = Date.now();
        while (Date.now() - verifyStart < 900) {
          const textNow = await getHappyTalkBodyText(page).catch(() => '');
          if (textNow !== beforeText || !textNow.includes(matched)) return { ok: true, matched };
          await sleep(100);
        }
      }
    }
    await sleep(retryInterval);
  }

  for (const text of targetTexts) {
    const ok = await clickTextAnywhere(page, text, { ...options, timeout: 1200, retryInterval: 150 });
    if (ok) return { ok: true, matched: text };
  }
  return { ok: false, matched: null };
}

async function waitForAnyHappyTalkText(page, targetTexts = [], timeout = 5000) {
  const targets = (targetTexts || []).map(normalizeText).filter(Boolean);
  const start = Date.now();

  while (targets.length && Date.now() - start < timeout) {
    const text = await getHappyTalkBodyText(page).catch(() => '');
    const matched = targets.find((target) => text.includes(target));
    if (matched) return { ok: true, matched };
    await sleep(120);
  }

  return { ok: false, matched: null };
}

async function clickHappyTalkStep(page, step, index, review) {
  const choices = step.choices || [];
  const nextChoices = step.nextChoices || [];

  if (nextChoices.length) {
    const alreadyNext = await waitForAnyHappyTalkText(page, nextChoices, 450);
    if (alreadyNext.ok) {
      return { ok: true, matched: alreadyNext.matched, skipped: true };
    }
  }

  const result = await clickAnyText(page, choices, {
    timeout: step.timeout || 10000,
    verifyChange: step.verifyChange !== false,
  });

  if (!result.ok) return result;

  if (nextChoices.length) {
    const reached = await waitForAnyHappyTalkText(page, nextChoices, step.nextTimeout || 12000);
    if (!reached.ok) {
      return {
        ok: false,
        matched: result.matched,
        error: `다음 단계 문구 미감지: ${nextChoices.join(' / ')}`,
      };
    }
    return { ok: true, matched: result.matched, reached: reached.matched };
  }

  return result;
}

async function fastFillChatInputAndSend(page, text) {
  const roots = await getAllSearchRoots(page);
  for (const root of roots) {
    const ok = await root.evaluate((value) => {
      const isVisible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const inputs = Array.from(document.querySelectorAll('textarea,input[type="text"],[contenteditable="true"],div[role="textbox"]'))
        .filter(isVisible);
      const input = inputs[inputs.length - 1];
      if (!input) return false;

      input.scrollIntoView({ block: 'center', inline: 'center' });
      input.focus();
      if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        input.textContent = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.textContent = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }

      const normalize = (v) => String(v || '').replace(/\s+/g, ' ').trim();
      const buttons = Array.from(document.querySelectorAll('button,a,[role="button"],[onclick],div,span'))
        .filter(isVisible);
      const sendButton = buttons.find((el) => /^(전송|보내기|>)$/.test(normalize(el.innerText || el.textContent || el.getAttribute('aria-label') || '')));
      if (sendButton) {
        sendButton.click();
        return true;
      }
      return 'filled';
    }, text).catch(() => false);

    if (ok === true) return true;
    if (ok === 'filled') {
      await page.keyboard.press('Enter').catch(() => {});
      return true;
    }
  }
  return false;
}

async function fillChatInputAndSend(page, value) {
  const text = String(value || '').trim();
  if (!text) throw new Error('해피톡 입력값이 비어 있습니다.');

  if (await fastFillChatInputAndSend(page, text)) {
    await sleep(HAPPYTALK_ACTION_DELAY_MS);
    return;
  }

  const start = Date.now();
  let filled = false;

  while (Date.now() - start < 8000 && !filled) {
    const roots = await getAllSearchRoots(page);
    for (const root of roots) {
      const inputs = [
        root.locator('textarea'),
        root.locator('input[type="text"]'),
        root.locator('[contenteditable="true"]'),
        root.locator('div[role="textbox"]'),
      ];

      for (const locator of inputs) {
        const count = await locator.count().catch(() => 0);
        for (let i = count - 1; i >= 0; i--) {
          const el = locator.nth(i);
          try {
            if (!(await el.isVisible().catch(() => false))) continue;
            const tag = await el.evaluate((node) => node.tagName.toLowerCase()).catch(() => '');
            await el.scrollIntoViewIfNeeded().catch(() => {});
            await el.click({ timeout: 1000 }).catch(() => {});
            if (tag === 'textarea' || tag === 'input') {
              await el.fill('');
              await sleep(100);
              await el.fill(text);
            } else {
              await el.evaluate((node, val) => {
                node.focus();
                node.textContent = '';
                node.dispatchEvent(new Event('input', { bubbles: true }));
                node.textContent = val;
                node.dispatchEvent(new Event('input', { bubbles: true }));
                node.dispatchEvent(new Event('change', { bubbles: true }));
              }, text);
            }
            filled = true;
            break;
          } catch {
            // next
          }
        }
        if (filled) break;
      }
      if (filled) break;
    }
    if (!filled) await sleep(200);
  }

  if (!filled) throw new Error('해피톡 입력창을 찾지 못했습니다.');
  await sleep(150);

  const sent = await clickAnyText(page, ['전송', '보내기', '>'], {
    timeout: 2000,
    retryInterval: 150,
  });
  if (!sent.ok) {
    await page.keyboard.press('Enter').catch(() => {});
    await sleep(HAPPYTALK_ACTION_DELAY_MS);
  }
}

async function waitForHappyTalkReady(page, timeout = 20000) {
  const READY_KEYWORDS = [
    '신규 상담',
    '신규상담',
    '상담 시작',
    '시작하기',
    '리뷰',
    '블라인드',
    '게시중단',
    '접수',
    '쿠팡',
    '해피톡',
    '문의',
    '채팅',
    '상담',
  ];
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const roots = await getAllSearchRoots(page);
    for (const root of roots) {
      const text = normalizeText(await root.locator('body').innerText().catch(() => ''));
      if (READY_KEYWORDS.some((keyword) => text.includes(keyword))) return true;
    }
    await sleep(220);
  }
  return false;
}

async function getHappyTalkBodyText(page) {
  const roots = await getAllSearchRoots(page);
  const chunks = [];
  for (const root of roots) {
    const text = await root.locator('body').innerText().catch(() => '');
    if (text) chunks.push(text);
  }
  return normalizeText(chunks.join('\n'));
}

async function waitForHappyTalkSubmitConfirmation(page, timeout = 12000) {
  const start = Date.now();
  const successPatterns = [
    /접수\s*(?:완료|되었습니다|됐습니다|되었어요)/,
    /신청\s*(?:완료|되었습니다|됐습니다|되었어요)/,
    /정상\s*접수/,
    /상담.*접수/,
    /접수해드렸/,
    /완료되었습니다/,
  ];
  const pendingPatterns = [
    /접수하기|신청하기|제출하기/,
    /주문번호|주문일자|사업자|스토어/,
  ];

  while (Date.now() - start < timeout) {
    const text = await getHappyTalkBodyText(page);
    if (successPatterns.some((pattern) => pattern.test(text))) {
      return { ok: true, text };
    }
    if (!pendingPatterns.some((pattern) => pattern.test(text)) && /완료|접수/.test(text)) {
      return { ok: true, text };
    }
    await sleep(140);
  }

  return { ok: false, text: await getHappyTalkBodyText(page).catch(() => '') };
}

async function openCoupangHappyTalkPage(context) {
  const page = await context.newPage();
  const openedAt = Date.now();
  await page.goto(COUPANG_REVIEW_CARE_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await sleep(900);
  const ready = await waitForHappyTalkReady(page, 20000);
  await traceHappyTalk(page, 'open-ready', {
    elapsedMs: Date.now() - openedAt,
    url: COUPANG_REVIEW_CARE_URL,
  });
  if (!ready) {
    const dump = await saveHappyTalkDebugArtifacts(page, 'not-ready-after-open', {
      url: COUPANG_REVIEW_CARE_URL,
    }).catch(() => null);
    if (dump) {
      log(`쿠팡 해피톡 준비 실패 스크린샷 저장: ${dump.screenshotPath}`);
      log(`쿠팡 해피톡 준비 실패 후보 JSON 저장: ${dump.jsonPath}`);
    }
    throw new Error('쿠팡 해피톡 화면이 준비되지 않았습니다.');
  }
  return page;
}

async function submitCoupangBlind(context, review) {
  if (!COUPANG_STORE_ID) throw new Error('COUPANG_STORE_ID가 없어 쿠팡 블라인드 접수를 진행할 수 없습니다.');
  if (!COUPANG_BIZ_NO) throw new Error('COUPANG_BIZ_NO 또는 BIZ_NO가 없어 쿠팡 블라인드 접수를 진행할 수 없습니다.');
  if (!review.orderNumber) throw new Error('주문번호가 없어 쿠팡 블라인드 접수를 진행할 수 없습니다.');
  if (!review.orderDate && !review.date) throw new Error('주문일자가 없어 쿠팡 블라인드 접수를 진행할 수 없습니다.');

  const carePage = await openCoupangHappyTalkPage(context);
  try {
    log(`쿠팡 블라인드 접수 시작: ${review.orderNumber}`);
    await traceHappyTalk(carePage, 'submit-start', {
      orderNumber: review.orderNumber,
      orderDate: review.orderDate || review.date || '',
    });

    const steps = [
      {
        choices: ['신규 상담 시작하기', '신규상담 시작하기', '상담 시작하기', '새 상담 시작하기', '상담시작', '시작하기', '새 상담', '상담 시작'],
        nextChoices: ['리뷰 블라인드', '리뷰 게시중단', '게시중단요청', '게시중단 요청', '리뷰 신고', '블라인드', '리뷰관련', '리뷰 관련'],
        timeout: 15000,
        nextTimeout: 15000,
        verifyChange: false,
      },
      {
        choices: ['리뷰 블라인드/게시중단 요청', '리뷰 블라인드', '리뷰 게시중단', '게시중단요청', '게시중단 요청', '리뷰 신고', '블라인드/게시중단', '블라인드 요청', '게시중단', '리뷰블라인드'],
        nextChoices: ['블라인드만 신청', '블라인드 신청', '블라인드만', '게시중단 요청만 신청', '게시중단요청만 신청', '블라인드만신청', '블라인드신청'],
        timeout: 12000,
        nextTimeout: 12000,
        verifyChange: false,
      },
      {
        choices: ['블라인드만 신청', '블라인드 신청', '블라인드만', '게시중단 요청만 신청', '게시중단요청만 신청', '블라인드만신청', '블라인드신청'],
        nextChoices: ['본인 신청', '본인이 신청', '직접 신청', '직접 접수', '본인신청', '직접신청'],
        timeout: 12000,
        nextTimeout: 12000,
        verifyChange: false,
      },
      {
        choices: ['본인 신청', '본인이 신청', '직접 신청', '직접 접수', '본인신청', '직접신청'],
        nextChoices: ['간편하게 접수하기', '간편 접수', '간편하게 접수', '접수하기', '간편접수', '간편하게접수하기'],
        timeout: 12000,
        nextTimeout: 12000,
        verifyChange: false,
      },
      {
        choices: ['간편하게 접수하기', '간편 접수', '간편하게 접수', '접수하기', '간편접수', '간편하게접수하기'],
        nextChoices: ['계속신청하기', '계속 신청하기', '이어서 진행하기', '계속 진행', '계속진행', '이어서진행하기'],
        timeout: 12000,
        nextTimeout: 12000,
        verifyChange: false,
      },
      {
        choices: ['계속신청하기', '계속 신청하기', '이어서 진행하기', '계속 진행', '계속진행', '이어서진행하기'],
        nextChoices: ['스토어', '사업자', '가게', '매장', '아이디', '스토어 아이디', '쿠팡이츠 스토어'],
        timeout: 12000,
        nextTimeout: 18000,
        verifyChange: false,
      },
    ];

    for (let i = 0; i < steps.length; i += 1) {
      const step = steps[i];
      const choices = step.choices;
      const result = await timedHappyTalkAction(
        carePage,
        `step-${i + 1}-${safeFilename(choices[0])}`,
        () => clickHappyTalkStep(carePage, step, i, review),
        { choices, reviewOrderNumber: review.orderNumber }
      );
      if (!result.ok) {
        const dump = await saveHappyTalkDebugArtifacts(carePage, `step-${i + 1}-click-failed`, {
          choices,
          review,
        }).catch(() => null);
        if (dump) {
          log(`쿠팡 해피톡 단계 실패 스크린샷 저장: ${dump.screenshotPath}`);
          log(`쿠팡 해피톡 단계 실패 후보 JSON 저장: ${dump.jsonPath}`);
        }
        throw new Error(`해피톡 단계 클릭 실패: ${choices.join(' / ')}${result.error ? ` (${result.error})` : ''}`);
      }
      if (result.skipped) {
        log(`쿠팡 해피톡 단계 이미 통과: ${result.matched}`);
      } else if (result.reached) {
        log(`쿠팡 해피톡 단계 클릭 완료: ${result.matched} -> ${result.reached}`);
      } else {
        log(`쿠팡 해피톡 단계 클릭 완료: ${result.matched}`);
      }
    }

    await timedHappyTalkAction(
      carePage,
      'input-store-id',
      () => fillChatInputAndSend(carePage, COUPANG_STORE_ID),
      { valueKind: 'storeId', valueLength: String(COUPANG_STORE_ID).length }
    );
    log(`쿠팡 스토어 아이디 입력 완료: ${COUPANG_STORE_ID}`);

    await timedHappyTalkAction(
      carePage,
      'input-biz-no',
      () => fillChatInputAndSend(carePage, COUPANG_BIZ_NO),
      { valueKind: 'bizNo', valueLength: String(COUPANG_BIZ_NO).length }
    );
    log('쿠팡 사업자번호 입력 완료');

    const continueResult = await timedHappyTalkAction(
      carePage,
      'click-continue-after-biz',
      () => clickAnyText(carePage, ['일치하며 이어서 진행하기', '이어서 진행하기'], {
        timeout: 10000,
      }),
      { choices: ['일치하며 이어서 진행하기', '이어서 진행하기'] }
    );
    if (!continueResult.ok) throw new Error('해피톡: 일치하며 이어서 진행하기 클릭 실패');

    const orderLookupText = buildCoupangOrderLookupText(review);
    await timedHappyTalkAction(
      carePage,
      'input-order-lookup',
      () => fillChatInputAndSend(carePage, orderLookupText),
      { valueKind: 'orderLookup', value: orderLookupText }
    );
    log(`쿠팡 주문번호/작성일 입력 완료: ${orderLookupText}`);

    if (!AUTO_SUBMIT_REVIEW_CARE) {
      log('AUTO_SUBMIT_REVIEW_CARE=false -> 접수 직전 중단');
      return;
    }

    const noDeleteCommentResult = await timedHappyTalkAction(
      carePage,
      'click-no-delete-comment',
      () => clickAnyText(carePage, ['아니오', '아니요', '댓글 삭제 안함', '삭제 안함'], {
        timeout: 10000,
        verifyChange: true,
      }),
      { choices: ['아니오', '아니요', '댓글 삭제 안함', '삭제 안함'] }
    );
    if (!noDeleteCommentResult.ok) throw new Error('해피톡 사장님 댓글 삭제 처리 여부 "아니오" 클릭 실패');
    log(`쿠팡 사장님 댓글 삭제 처리 여부 선택 완료: ${noDeleteCommentResult.matched}`);

    const submitResult = await timedHappyTalkAction(
      carePage,
      'click-final-submit',
      () => clickAnyText(carePage, ['동의하고 접수하기', '동의하고 접수', '접수하기', '신청하기', '제출하기', '완료'], {
        timeout: 10000,
      }),
      { choices: ['동의하고 접수하기', '동의하고 접수', '접수하기', '신청하기', '제출하기', '완료'] }
    );
    if (!submitResult.ok) throw new Error('해피톡 최종 접수 버튼 클릭 실패');

    const confirmResult = await timedHappyTalkAction(
      carePage,
      'wait-submit-confirmation',
      () => waitForHappyTalkSubmitConfirmation(carePage, 12000),
      {}
    );
    if (!confirmResult.ok) {
      throw new Error('해피톡 최종 접수 완료 확인 실패');
    }

    log(`쿠팡 블라인드 접수 완료: ${review.orderNumber}`);
  } catch (error) {
    const dump = await saveHappyTalkDebugArtifacts(carePage, 'submit-failed', {
      error: error.message,
      review,
    }).catch(() => null);
    if (dump) {
      log(`쿠팡 해피톡 오류 스크린샷 저장: ${dump.screenshotPath}`);
      log(`쿠팡 해피톡 오류 후보 JSON 저장: ${dump.jsonPath}`);
    }
    throw error;
  } finally {
    await sleep(500);
    await carePage.close().catch(() => {});
  }
}

async function clickSearchButton(page) {
  const candidates = [
    page.getByRole('button', { name: /조회|검색|Search/i }),
    page.locator('button:has-text("조회")'),
    page.locator('button:has-text("검색")'),
  ];

  for (const locator of candidates) {
    const count = await locator.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const el = locator.nth(i);
      try {
        if (!(await el.isVisible().catch(() => false))) continue;
        await el.click();
        await sleep(1400);
        return true;
      } catch {
        // next
      }
    }
  }

  return false;
}

async function clickNextReviewPage(page) {
  return clickNextCoupangReviewPage(page, {
    log,
    reason: 'coupang-blind-next-page',
  });
}
async function processAllReviews(page, context) {
  const processed = new Set();
  const collected = [];
  let blindCount = 0;
  let idleRounds = 0;

  while (blindCount < MAX_REVIEWS) {
    await sleep(800);
    const cards = await getReviewCardHandles(page);
    log(`현재 감지된 쿠팡 리뷰 카드 수: ${cards.length}, 블라인드 접수건수: ${blindCount}`);

    let foundNew = false;

    for (const card of cards) {
      let review = null;
      try {
        review = await extractSingleReviewFromCard(card);
        const key = review.orderNumber || `${review.customerName}-${review.date}-${review.reviewText}`;
        if (!key || processed.has(key)) continue;

        foundNew = true;
        processed.add(key);
        review.__key = key;

        if (typeof review.rating !== 'number' || review.rating > 3) {
          log(`쿠팡 블라인드 제외: 별점 ${review.rating ?? '(없음)'}`);
          continue;
        }

        log('\n====================================');
        log('[쿠팡이츠 블라인드] 3점 이하 리뷰 감지');
        log(`고객명: ${review.customerName || '(없음)'}`);
        log(`별점: ${review.rating}`);
        log(`작성일: ${review.date || '(없음)'}`);
        log(`리뷰내용: ${review.reviewText || '(없음)'}`);
        log(`주문메뉴: ${review.orderMenu || '(없음)'}`);
        log(`주문번호: ${review.orderNumber || '(없음)'}`);
        log(`주문일자: ${review.orderDate || '(없음)'}`);

        await submitCoupangBlind(context, review);
        appendBlindReviewLog(review);
        collected.push(review);
        blindCount += 1;

        if (blindCount % REVIEW_REFRESH_BATCH === 0) {
          await clickSearchButton(page);
        }

        if (MAX_REVIEWS > 0 && blindCount >= MAX_REVIEWS) break;
      } catch (error) {
        if (review?.__key) processed.add(review.__key);
        appendUserError('coupang.blind_happytalk_failed', error, {
          review,
        });
        log(`쿠팡 블라인드 처리 실패: ${error.message}`);
      }
    }

    if (!foundNew) {
      idleRounds += 1;
      log(`새 쿠팡 리뷰 없음 -> 조회/스크롤 재시도 ${idleRounds}/${MAX_IDLE_ROUNDS}`);
      log(`쿠팡 현재 페이지 스캔 완료 -> 다음 페이지 이동 시도 ${idleRounds}/${MAX_IDLE_ROUNDS}`);
      const movedNext = await clickNextReviewPage(page);
      if (movedNext) {
        log('쿠팡 블라인드 다음 페이지 이동 완료');
        idleRounds = 0;
        continue;
      }
      log('쿠팡 다음 페이지 버튼을 찾지 못해 조회/스크롤 재시도');
      await clickSearchButton(page);
      await page.mouse.wheel(0, 2500).catch(() => {});
      await sleep(1200);
    } else {
      idleRounds = 0;
    }

    if (idleRounds >= MAX_IDLE_ROUNDS) break;
  }

  const file = saveJson(`coupang-blind-processed-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, collected);
  log(`쿠팡 블라인드 접수 완료 건수: ${blindCount}`);
  log(`처리 JSON 저장: ${file}`);
  log(`블라인드 TXT 로그: logs/${getMonthlyBlindReviewLogFilename(new Date().toISOString())}`);
}

function isCoupangFrontendDataErrorText(text) {
  if (!text) return false;
  const normalized = String(text).toLowerCase();
  return (
    normalized.includes('cannot read properties of undefined') ||
    normalized.includes("reading 'data'") ||
    normalized.includes('reading "data"')
  );
}

async function hasCoupangFrontendDataError(page) {
  const bodyText = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
  return isCoupangFrontendDataErrorText(bodyText);
}

async function clearCoupangStorage(page) {
  await page
    .evaluate(() => {
      try {
        localStorage.clear();
      } catch {}
      try {
        sessionStorage.clear();
      } catch {}
    })
    .catch(() => {});
}

async function goToCoupangMerchantHome(page) {
  await page.goto('https://store.coupangeats.com/', {
    waitUntil: 'domcontentloaded',
    timeout: 0,
  });
  await sleep(2500);
}

async function openReviewsPageSafely(page) {
  await page.goto('https://store.coupangeats.com/merchant/management/reviews', {
    waitUntil: 'domcontentloaded',
    timeout: 0,
  });
  await sleep(2500);
}

async function ensureReadyReviewPage(page) {
  if (await hasCoupangFrontendDataError(page)) {
    throw new Error('쿠팡 프론트 data 오류 화면이 감지되었습니다.');
  }

  const url = page.url();
  const bodyText = await page.locator('body').innerText().catch(() => '');
  const looksReady =
    url.includes('/merchant/management/reviews') ||
    bodyText.includes('주문메뉴') ||
    bodyText.includes('주문번호') ||
    bodyText.includes('리뷰');

  if (!looksReady) {
    log('현재 화면이 쿠팡 리뷰관리 화면으로 보이지 않습니다. 사용자가 맞춘 상태라면 계속 진행합니다.');
  }
}

async function launchPersistentCoupangContext() {
  ensureDir(COUPANG_PROFILE_DIR);

  const context = await launchPersistentChromiumWithFallback(COUPANG_PROFILE_DIR, {
    headless: false,
    slowMo: 50,
    viewport: { width: 1440, height: 1100 },
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-sync',
      '--disable-features=Translate,BackForwardCache,AcceptCHFrame,MediaRouter',
    ],
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
    });
  });

  return context;
}

async function runCoupangEats() {
  let context;

  try {
    context = await launchPersistentCoupangContext();
    const page = context.pages()[0] || await context.newPage();

    log('쿠팡 블라인드 수동 로그인 모드 시작');
    log('1. 쿠팡이츠 스토어 로그인 후 리뷰관리 화면으로 이동하세요.');
    log('2. 3점 이하 리뷰의 주문번호와 주문일자를 해피톡에 순서대로 접수합니다.');
    log('3. 준비되면 UI에서 시작 버튼 또는 터미널 Enter를 누르세요.');

    await goToCoupangMerchantHome(page);

    if (await hasCoupangFrontendDataError(page)) {
      log('쿠팡 data 오류 감지 -> 저장소 초기화 후 새로고침');
      await clearCoupangStorage(page);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 0 }).catch(() => {});
      await sleep(2000);
    }

    await waitForEnter();

    const currentUrlBefore = page.url();
    log(`시작 시점 URL: ${currentUrlBefore}`);

    if (!currentUrlBefore.includes('/merchant/management/reviews')) {
      log('리뷰관리 URL이 아니어서 리뷰 페이지로 1회 자동 이동합니다.');
      await openReviewsPageSafely(page);
    }

    await ensureReadyReviewPage(page);
    await processAllReviews(page, context);

    log('쿠팡 블라인드 모드 종료');
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

async function runCoupangReply() {
  throw new Error('coupangAnswered.js는 쿠팡 블라인드 전용입니다. 쿠팡 답글은 coupangEats.js를 사용하세요.');
}

module.exports = {
  runCoupangBlind: runCoupangEats,
  runCoupangAnswered: runCoupangEats,
  runCoupangEats,
  runCoupangReply,
  submitCoupangBlind,
  _test: {
    clickAnyText,
    clickTextAnywhere,
    waitForHappyTalkSubmitConfirmation,
  },
};

