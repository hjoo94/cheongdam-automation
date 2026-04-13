const fs = require('fs');
const path = require('path');
require('dotenv').config();
const { generateReply, hasRuntimeFeature } = require('../gptClient');
const { submitCoupangBlind } = require('./coupangAnswered');
const { log } = require('../utils/logger');
const { waitForEnter, sleep, cleanLines } = require('../utils/common');
const { classifyReview } = require('../utils/reviewClassifier');
const { getLogDir, getCoupangProfileDir, ensureDir } = require('../utils/runtimePaths');
const { appendUniqueReviewLog, appendUniqueBlindReviewLog } = require('../utils/reviewLogManager');
const { buildReviewLogText } = require('../utils/reviewLogFormatter');
const { launchPersistentChromiumWithFallback } = require('../utils/browserLauncher');
const { appendUserError } = require('../utils/errorCollector');
const { clickNextCoupangReviewPage } = require('../utils/coupangPagination');

const MAX_REVIEWS = Number(process.env.MAX_REVIEWS || 500000);
const COUPANG_RELOAD_RECOVERY_ROUNDS = Number(process.env.COUPANG_RELOAD_RECOVERY_ROUNDS || 3);

const AUTO_SUBMIT_REPLY =
  String(process.env.AUTO_SUBMIT_REPLY).toLowerCase() === 'true';
const AUTO_BLIND_LOW_RATING_UNANSWERED =
  String(process.env.AUTO_BLIND_LOW_RATING_UNANSWERED || 'true').toLowerCase() !== 'false';

const REVIEW_REFRESH_BATCH = 5;
const MAX_EMPTY_REFRESH = 3;

const COUPANG_PROFILE_DIR = getCoupangProfileDir();

async function tryReviveCoupangReplyList(page, attempts = COUPANG_RELOAD_RECOVERY_ROUNDS) {
  for (let i = 0; i < attempts; i += 1) {
    log(`쿠팡 미답변 목록 새로고침 후 재탐색 (${i + 1}/${attempts})`);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await sleep(2800);
    await clickSearchButton(page).catch(() => {});

    let cards = await getReviewCardHandles(page);
    if (cards.length) return true;

    await sleep(1200);
    cards = await getReviewCardHandles(page);
    if (cards.length) return true;
  }
  return false;
}

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

function appendReplyReviewLog(review, replyText) {
  return appendUniqueReviewLog({
    dateText: review.date || review.orderDate || '',
    reviewId: review.orderNumber || review.__key || '',
    text: buildReviewLogText({
      platform: 'coupang',
      platformLabel: '쿠팡이츠 답글',
      featureKey: 'coupangReply',
      customerName: review.customerName,
      reviewDate: review.date || review.orderDate,
      reviewId: review.orderNumber || review.__key,
      rating: review.rating,
      reviewType: review.reviewType,
      orderMenu: review.orderMenu,
      body: review.reviewText,
      replyText,
      action: 'reply_submitted',
      actionLabel: '답글 등록 완료',
    }),
  });
}

function appendCoupangBlindReviewLog(review) {
  const reviewId = review.orderNumber || review.__key || '';
  return appendUniqueBlindReviewLog({
    dateText: review.date || review.orderDate || '',
    reviewId,
    text: buildReviewLogText({
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
    }),
  });
}

function parseCoupangReviewCardLines(lines) {
  let customerName = '';
  let visitCountText = '';
  let date = '';
  let reviewText = '';
  let orderMenu = '';
  let orderNumber = '';
  let orderDate = '';
  let receiveType = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!customerName) {
      const m = line.match(/^(.+?)(\d+회 주문)$/);
      if (m) {
        customerName = m[1].trim();
        visitCountText = m[2].trim();
        continue;
      }
    }

    if (!date && /^\d{4}-\d{2}-\d{2}$/.test(line)) {
      date = line;
      continue;
    }

    if (!orderMenu && line === '주문메뉴' && lines[i + 1]) {
      orderMenu = lines[i + 1].trim();
      continue;
    }

    if (!orderNumber && line === '주문번호' && lines[i + 1]) {
      const next = lines[i + 1].trim();
      const m = next.match(/^([A-Z0-9]+)[ㆍ·•](.+)$/);
      if (m) {
        orderNumber = m[1].trim();
        orderDate = m[2].trim();
      } else {
        orderNumber = next;
      }
      continue;
    }

    if (!receiveType && line === '수령방식' && lines[i + 1]) {
      receiveType = lines[i + 1].trim();
      continue;
    }
  }

  const bodyCandidates = lines.filter((line) => {
    if (!line) return false;
    if (/^(.+?)(\d+회 주문)$/.test(line)) return false;
    if (/^\d{4}-\d{2}-\d{2}$/.test(line)) return false;
    if (line === '주문메뉴') return false;
    if (line === '주문번호') return false;
    if (line === '수령방식') return false;
    if (line === '사장님 댓글 등록하기') return false;
    if (line === '리뷰 작성일') return false;
    if (line === '리뷰 내용') return false;
    if (line === orderMenu) return false;
    if (line.includes(orderNumber) && orderNumber) return false;
    if (line === receiveType && receiveType) return false;
    if (line === '사장님') return false;
    if (line === '등록') return false;
    if (line === '취소') return false;
    return true;
  });

  if (bodyCandidates.length > 0) {
    reviewText = bodyCandidates[0].trim();
  }

  return {
    customerName,
    visitCountText,
    date,
    reviewText,
    orderMenu,
    orderNumber,
    orderDate,
    receiveType,
  };
}

async function getReviewCardHandles(page) {
  const buttons = page.locator('text=사장님 댓글 등록하기');
  const count = await buttons.count();
  const cards = [];

  for (let i = 0; i < count; i++) {
    const btn = buttons.nth(i);

    try {
      const handle = await btn.evaluateHandle((el) => {
        let node = el;
        while (node) {
          if (node.tagName === 'TR') {
            return node;
          }
          node = node.parentElement;
        }
        return null;
      });

      const element = handle.asElement();
      if (element) cards.push(handle);
    } catch {
      // ignore
    }
  }

  return cards;
}

async function extractRatingFromCard(cardHandle) {
  try {
    const rating = await cardHandle.evaluate((node) => {
      const firstTd = node.querySelector('td');
      if (!firstTd) return null;

      const allEls = [firstTd, ...firstTd.querySelectorAll('*')];

      const getColorString = (style, prop) => {
        try {
          return style[prop] || '';
        } catch {
          return '';
        }
      };

      const isYellowLike = (colorText) => {
        if (!colorText) return false;
        const lower = String(colorText).toLowerCase();

        if (
          lower.includes('rgb(255, 193') ||
          lower.includes('rgb(255,193') ||
          lower.includes('rgb(255, 204') ||
          lower.includes('rgb(255,204') ||
          lower.includes('yellow') ||
          lower.includes('gold') ||
          lower.includes('orange')
        ) {
          return true;
        }

        const m = lower.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (m) {
          const r = Number(m[1]);
          const g = Number(m[2]);
          const b = Number(m[3]);
          return r >= 200 && g >= 140 && b <= 180;
        }

        return false;
      };

      const candidates = [];

      for (const el of allEls) {
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        if (rect.width > 40 || rect.height > 40) continue;
        if (rect.width < 6 || rect.height < 6) continue;

        const style = window.getComputedStyle(el);
        const color = getColorString(style, 'color');
        const fill = getColorString(style, 'fill');
        const stroke = getColorString(style, 'stroke');
        const bg = getColorString(style, 'backgroundColor');

        const yellowLike =
          isYellowLike(color) ||
          isYellowLike(fill) ||
          isYellowLike(stroke) ||
          isYellowLike(bg);

        if (!yellowLike) continue;

        const tag = (el.tagName || '').toLowerCase();
        const cls = (el.className || '').toString().toLowerCase();
        const text = (el.textContent || '').trim();

        const looksLikeStar =
          text === '★' ||
          text === '⭐' ||
          tag === 'svg' ||
          tag === 'path' ||
          tag === 'polygon' ||
          tag === 'img' ||
          tag === 'i' ||
          tag === 'span' ||
          cls.includes('star') ||
          cls.includes('rating') ||
          cls.includes('score') ||
          cls.includes('icon');

        if (!looksLikeStar) continue;

        candidates.push({
          left: rect.left,
          top: rect.top,
        });
      }

      if (candidates.length === 0) return null;

      candidates.sort((a, b) => {
        if (Math.abs(a.top - b.top) > 8) return a.top - b.top;
        return a.left - b.left;
      });

      const merged = [];
      for (const c of candidates) {
        const last = merged[merged.length - 1];
        if (!last) {
          merged.push(c);
          continue;
        }

        const sameRow = Math.abs(last.top - c.top) <= 8;
        const nearX = Math.abs(last.left - c.left) <= 8;

        if (sameRow && nearX) continue;
        merged.push(c);
      }

      const topMost = Math.min(...merged.map((v) => v.top));
      const sameTopRow = merged.filter((v) => Math.abs(v.top - topMost) <= 10);

      if (sameTopRow.length >= 1 && sameTopRow.length <= 5) {
        return sameTopRow.length;
      }

      if (merged.length >= 1 && merged.length <= 5) {
        return merged.length;
      }

      return null;
    });

    if (rating >= 1 && rating <= 5) return rating;
    return null;
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

async function openReplyEditor(cardHandle) {
  const root = cardHandle.asElement();
  if (!root) {
    throw new Error('쿠팡 리뷰 카드 element를 찾지 못했습니다.');
  }

  const btn = await root.$('text=사장님 댓글 등록하기');
  if (!btn) {
    throw new Error('쿠팡 답글 버튼을 찾지 못했습니다.');
  }

  await btn.click();
  await sleep(500);
}

async function fillVisibleReplyText(page, replyText) {
  const textareas = [
    page.locator('textarea:visible'),
    page.locator('[contenteditable="true"]:visible'),
    page.locator('div[role="textbox"]:visible'),
    page.locator('input[type="text"]:visible'),
  ];

  for (const locator of textareas) {
    const count = await locator.count().catch(() => 0);
    for (let i = count - 1; i >= 0; i--) {
      const el = locator.nth(i);
      try {
        if (!(await el.isVisible().catch(() => false))) continue;
        const tag = await el.evaluate((node) => node.tagName.toLowerCase()).catch(() => '');
        if (tag === 'textarea' || tag === 'input') {
          await el.fill('');
          await el.fill(replyText);
        } else {
          await el.click();
          await el.evaluate((node, value) => {
            node.focus();
            node.textContent = '';
            node.textContent = value;
            node.dispatchEvent(new Event('input', { bubbles: true }));
            node.dispatchEvent(new Event('change', { bubbles: true }));
          }, replyText);
        }
        return true;
      } catch {
        // next
      }
    }
  }

  return false;
}

function extractForbiddenWords(message = '') {
  return Array.from(String(message || '').matchAll(/['"‘’“”]([^'"‘’“”]+)['"‘’“”]/g))
    .map((match) => String(match[1] || '').trim())
    .filter(Boolean);
}

function buildCoupangSafeReplyText(original = '', message = '') {
  const forbiddenWords = extractForbiddenWords(message);
  let text = String(original || '').trim();

  for (const word of forbiddenWords) {
    text = text.split(word).join('');
  }

  text = text
    .replace(/부족/g, '아쉬움')
    .replace(/부족한/g, '아쉬웠던')
    .replace(/불편/g, '아쉬움')
    .replace(/문제/g, '부분')
    .replace(/\s+/g, ' ')
    .trim();

  if (text.length < 30 || forbiddenWords.some((word) => text.includes(word))) {
    return '소중한 리뷰 남겨주셔서 감사합니다. 만족스럽지 못했던 부분은 깊이 새기고, 다음 이용 때는 더 좋은 맛과 서비스로 보답드릴 수 있도록 꼼꼼히 개선하겠습니다.';
  }

  return text;
}

async function detectForbiddenReplyModal(page) {
  const bodyText = await page.locator('body').innerText({ timeout: 1200 }).catch(() => '');
  const text = String(bodyText || '');
  const isForbidden =
    text.includes('댓글에 다음 단어를 포함할 수 없습니다') ||
    text.includes('포함할 수 없습니다') ||
    text.includes('금칙') ||
    text.includes('욕설');

  if (!isForbidden) return { ok: false, message: '' };

  const okButtons = [
    page.getByRole('button', { name: '확인' }),
    page.locator('button:has-text("확인")'),
    page.locator('text=확인'),
  ];

  for (const locator of okButtons) {
    const count = await locator.count().catch(() => 0);
    for (let i = count - 1; i >= 0; i--) {
      const btn = locator.nth(i);
      try {
        if (!(await btn.isVisible().catch(() => false))) continue;
        await btn.click({ force: true, timeout: 1500 }).catch(() => {});
        await sleep(500);
        return { ok: true, message: text };
      } catch {
        // next
      }
    }
  }

  await page.keyboard.press('Enter').catch(() => {});
  await sleep(500);
  return { ok: true, message: text };
}

async function fillReplyAndSubmit(page, cardHandle, replyText) {
  await openReplyEditor(cardHandle);

  const textareas = [
    page.locator('textarea:visible'),
    page.locator('[contenteditable="true"]:visible'),
    page.locator('div[role="textbox"]:visible'),
    page.locator('input[type="text"]:visible'),
  ];

  let filled = false;

  for (const locator of textareas) {
    try {
      const count = await locator.count();
      if (!count) continue;

      for (let i = count - 1; i >= 0; i--) {
        const el = locator.nth(i);

        try {
          if (!(await el.isVisible())) continue;

          const tag = await el.evaluate((node) => node.tagName.toLowerCase());

          if (tag === 'textarea' || tag === 'input') {
            await el.fill('');
            await el.fill(replyText);
          } else {
            await el.click();
            await el.evaluate((node, value) => {
              node.focus();
              node.textContent = '';
              node.textContent = value;
              node.dispatchEvent(new Event('input', { bubbles: true }));
              node.dispatchEvent(new Event('change', { bubbles: true }));
            }, replyText);
          }

          filled = true;
          break;
        } catch {
          // next
        }
      }

      if (filled) break;
    } catch {
      // next
    }
  }

  if (!filled) {
    throw new Error('쿠팡 답글 입력창을 찾지 못했습니다.');
  }

  if (!AUTO_SUBMIT_REPLY) {
    log('AUTO_SUBMIT_REPLY=false → 입력만 하고 등록 생략');
    return;
  }

  const submitCandidates = [
    page.getByRole('button', { name: '등록', exact: true }),
    page.locator('button:has-text("등록")'),
  ];

  let forbiddenRetryDone = false;

  for (const locator of submitCandidates) {
    try {
      const count = await locator.count();
      if (!count) continue;

      for (let i = count - 1; i >= 0; i--) {
        const btn = locator.nth(i);
        try {
          if (!(await btn.isVisible())) continue;
          await btn.click();
          await sleep(700);

          const forbidden = await detectForbiddenReplyModal(page);
          if (forbidden.ok) {
            if (forbiddenRetryDone) {
              throw new Error(`쿠팡 욕설/금칙어 재시도 실패: ${forbidden.message || 'unknown'}`);
            }

            forbiddenRetryDone = true;
            const safeReply = buildCoupangSafeReplyText(replyText, forbidden.message);
            log(`쿠팡 욕설/금칙어 감지 -> 확인 후 안전 답글로 재등록: ${forbidden.message || ''}`);
            appendUserError('coupang.forbidden_keyword_retry', new Error(forbidden.message || 'forbidden keyword'), {
              originalReply: replyText,
              safeReply,
            });

            const refilled = await fillVisibleReplyText(page, safeReply);
            if (!refilled) {
              throw new Error('쿠팡 금칙어 확인 후 답글 입력창을 다시 찾지 못했습니다.');
            }

            await btn.click();
            await sleep(700);
            const secondForbidden = await detectForbiddenReplyModal(page);
            if (secondForbidden.ok) {
              throw new Error(`쿠팡 욕설/금칙어 재시도 실패: ${secondForbidden.message || 'unknown'}`);
            }
          }

          await sleep(500);
          return;
        } catch {
          // next
        }
      }
    } catch {
      // next
    }
  }

  throw new Error('쿠팡 답글 등록 버튼을 찾지 못했습니다.');
}

async function waitForReplyProcessed(cardHandle, timeout = 8000) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    try {
      const text = await cardHandle.evaluate((node) => node.innerText || '');
      if (!text.includes('사장님 댓글 등록하기')) {
        return true;
      }
    } catch {
      return true;
    }

    await sleep(300);
  }

  return false;
}

async function clickSearchButton(page) {
  const candidates = [
    page.getByRole('button', { name: /조회/ }),
    page.locator('button:has-text("조회")'),
    page.locator('text=조회'),
  ];

  for (const locator of candidates) {
    try {
      const count = await locator.count();
      if (!count) continue;

      for (let i = 0; i < count; i++) {
        const el = locator.nth(i);

        try {
          if (!(await el.isVisible())) continue;
          await el.scrollIntoViewIfNeeded().catch(() => {});
          await sleep(200);
          await el.click();
          await sleep(2500);
          return true;
        } catch {
          // next
        }
      }
    } catch {
      // next
    }
  }

  return false;
}

async function processAllReviews(page, context) {
  const processed = new Set();
  const collected = [];
  let processedCount = 0;
  let emptyRefreshCount = 0;

  while (processedCount < MAX_REVIEWS) {
    await sleep(700);

    const cards = await getReviewCardHandles(page);

    if (!cards.length) {
      emptyRefreshCount += 1;
      log(`미답변 리뷰 없음 → 조회 다시 클릭 (${emptyRefreshCount}/${MAX_EMPTY_REFRESH})`);

      const searched = await clickSearchButton(page);
      if (!searched) {
        log('조회 버튼 클릭 실패 → 종료');
        break;
      }

      if (emptyRefreshCount >= MAX_EMPTY_REFRESH) {
        if (await tryReviveCoupangReplyList(page)) {
          log('쿠팡 미답변: 새로고침 후 리뷰를 다시 찾았습니다.');
          emptyRefreshCount = 0;
          continue;
        }
        log('쿠팡 미답변 현재 페이지 처리 완료 -> 다음 페이지 이동 시도');
        const movedNext = await clickNextCoupangReviewPage(page, {
          log,
          reason: 'coupang-reply-empty-next-page',
        });
        if (movedNext) {
          log('쿠팡 미답변 다음 페이지 이동 완료');
          emptyRefreshCount = 0;
          continue;
        }
        if (await tryReviveCoupangReplyList(page)) {
          log('쿠팡 미답변: 다음 페이지 실패 후 새로고침으로 목록 회복');
          emptyRefreshCount = 0;
          continue;
        }
        log('쿠팡 미답변 다음 페이지 버튼을 찾지 못해 종료합니다. logs 폴더에 페이지 후보 JSON/PNG를 저장했습니다.');
        break;
      }

      continue;
    }

    let targetCard = null;
    let review = null;

    for (const card of cards) {
      try {
        const candidate = await extractSingleReviewFromCard(card);
        const key =
          candidate.orderNumber ||
          `${candidate.customerName}-${candidate.date}-${candidate.reviewText}`;

        if (!key || processed.has(key)) continue;

        targetCard = card;
        review = candidate;
        review.__key = key;
        break;
      } catch {
        // next
      }
    }

    if (!targetCard || !review) {
      emptyRefreshCount += 1;
      log(`새 미답변 리뷰를 찾지 못함 → 조회 다시 클릭 (${emptyRefreshCount}/${MAX_EMPTY_REFRESH})`);

      const searched = await clickSearchButton(page);
      if (!searched) {
        log('조회 버튼 클릭 실패 → 종료');
        break;
      }

      if (emptyRefreshCount >= MAX_EMPTY_REFRESH) {
        if (await tryReviveCoupangReplyList(page)) {
          log('쿠팡 미답변: 새로고침 후 신규 대상을 다시 찾았습니다.');
          emptyRefreshCount = 0;
          continue;
        }
        log('쿠팡 미답변 현재 페이지 신규 대상 없음 -> 다음 페이지 이동 시도');
        const movedNext = await clickNextCoupangReviewPage(page, {
          log,
          reason: 'coupang-reply-no-target-next-page',
        });
        if (movedNext) {
          log('쿠팡 미답변 다음 페이지 이동 완료');
          emptyRefreshCount = 0;
          continue;
        }
        if (await tryReviveCoupangReplyList(page)) {
          log('쿠팡 미답변: 다음 페이지 실패 후 새로고침으로 목록 회복');
          emptyRefreshCount = 0;
          continue;
        }
        log('쿠팡 미답변 다음 페이지 버튼을 찾지 못해 종료합니다. logs 폴더에 페이지 후보 JSON/PNG를 저장했습니다.');
        break;
      }

      continue;
    }

    emptyRefreshCount = 0;

    log('\n====================================');
    log(`[쿠팡이츠] 처리순번: ${processedCount + 1}`);
    log(`고객명: ${review.customerName || '(없음)'}`);
    log(`별점: ${review.rating ?? '(없음)'}`);
    log(`작성일: ${review.date || '(없음)'}`);
    log(`리뷰내용: ${review.reviewText || '(없음)'}`);
    log(`주문메뉴: ${review.orderMenu || '(없음)'}`);
    log(`주문번호: ${review.orderNumber || '(없음)'}`);
    log(`주문일자: ${review.orderDate || '(없음)'}`);
    log(`수령방식: ${review.receiveType || '(없음)'}`);

    try {
      if (
        AUTO_BLIND_LOW_RATING_UNANSWERED &&
        typeof review.rating === 'number' &&
        review.rating <= 3 &&
        hasRuntimeFeature('coupangBlind')
      ) {
        await submitCoupangBlind(context, review);
        appendCoupangBlindReviewLog(review);
        log('쿠팡 미답변 3점 이하 리뷰 블라인드 신청 완료');
      }

      const replyText = await generateReply({
        platform: 'coupang_eats',
        customerName: review.customerName,
        rating: review.rating,
        reviewText: review.reviewText,
        menus: review.orderMenu ? [review.orderMenu] : [],
        reviewType: review.reviewType,
        storeName: process.env.STORE_NAME || '',
        reviewRule: process.env.REVIEW_RULE || '',
      });

      log(`생성 답글: ${replyText}`);

      await fillReplyAndSubmit(page, targetCard, replyText);
      log('쿠팡 답글 등록 완료');

      appendReplyReviewLog(review, replyText);

      await waitForReplyProcessed(targetCard, 8000);

      processed.add(review.__key);
      collected.push(review);
      processedCount += 1;

      if (processedCount % REVIEW_REFRESH_BATCH === 0) {
        log(`${REVIEW_REFRESH_BATCH}개 처리 완료 → 조회 버튼 클릭해서 새 미답변 불러오기`);
        const searched = await clickSearchButton(page);
        if (!searched) {
          log('조회 버튼 클릭 실패');
        }
      }

      await sleep(800);
    } catch (e) {
      processed.add(review.__key);
      log(`쿠팡 리뷰 처리 실패: ${e.message}`);
      await sleep(1000);
    }
  }

  const file = saveJson(
    `coupang-processed-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
    collected
  );

  log(`\n쿠팡 총 처리 완료 건수: ${processedCount}`);
  log(`처리 로그 저장: ${file}`);
}

function isCoupangFrontendDataErrorText(text) {
  if (!text) return false;
  const normalized = String(text).toLowerCase();
  return (
    normalized.includes("cannot read properties of undefined") ||
    normalized.includes("reading 'data'") ||
    normalized.includes('reading "data"')
  );
}

async function hasCoupangFrontendDataError(page) {
  try {
    const bodyText = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
    return isCoupangFrontendDataErrorText(bodyText);
  } catch {
    return false;
  }
}

async function clearCoupangStorage(page) {
  try {
    await page.evaluate(() => {
      try {
        localStorage.clear();
      } catch {}
      try {
        sessionStorage.clear();
      } catch {}
    });
  } catch {
    // ignore
  }
}

async function clearCoupangSession(context, page) {
  await clearCoupangStorage(page);
  try {
    await context.clearCookies();
  } catch {
    // ignore
  }
}

async function goToCoupangMerchantHome(page) {
  await page.goto('https://store.coupangeats.com/', {
    waitUntil: 'domcontentloaded',
    timeout: 0,
  });
  await sleep(2500);
}

async function goToCoupangLoginPage(page) {
  await page.goto('https://store.coupangeats.com/login', {
    waitUntil: 'domcontentloaded',
    timeout: 0,
  });
  await sleep(2500);
}

async function openUnansweredReviewsPageSafely(page) {
  await page.goto('https://store.coupangeats.com/merchant/management/reviews', {
    waitUntil: 'domcontentloaded',
    timeout: 0,
  });
  await sleep(2500);
}

async function recoverCoupangFrontendError(context, page) {
  log('쿠팡 프론트 오류 복구 시도: 저장소/쿠키 정리 후 로그인 페이지 재진입');
  await clearCoupangSession(context, page);
  await goToCoupangLoginPage(page);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 0 }).catch(() => {});
  await sleep(2000);

  if (await hasCoupangFrontendDataError(page)) {
    log('로그인 페이지에서도 오류가 남아 메인 페이지 재진입을 시도합니다.');
    await goToCoupangMerchantHome(page);
    await sleep(2000);
  }
}

async function ensureReadyReplyPage(page) {
  const currentUrl = page.url();

  if (await hasCoupangFrontendDataError(page)) {
    throw new Error('쿠팡 프론트 data 오류 화면이 감지되었습니다.');
  }

  const bodyText = await page.locator('body').innerText().catch(() => '');

  const looksLikeReplyPage =
    currentUrl.includes('/merchant/management/reviews') ||
    bodyText.includes('사장님 댓글 등록하기') ||
    bodyText.includes('주문메뉴') ||
    bodyText.includes('주문번호');

  if (!looksLikeReplyPage) {
    log('현재 페이지가 쿠팡 리뷰관리 화면으로 보이지 않음. 그래도 사용자가 직접 맞춘 상태라면 계속 진행.');
  }
}

async function launchPersistentCoupangContext() {
  ensureDir(COUPANG_PROFILE_DIR);

  const context = await launchPersistentChromiumWithFallback(COUPANG_PROFILE_DIR, {
    headless: false,
    slowMo: 200,
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

    log('쿠팡 수동 로그인 모드 시작');
    log('1. 쿠팡 홈 먼저 진입');
    log('2. 로그인 화면 오류가 나면 새로고침 1회');
    log('3. 로그인 완료 후 리뷰관리 > 미답변 리뷰 화면으로 이동');
    log('4. 준비되면 엔터');

    await goToCoupangMerchantHome(page);

    if (await hasCoupangFrontendDataError(page)) {
      await recoverCoupangFrontendError(context, page);
      if (await hasCoupangFrontendDataError(page)) {
        log('자동 복구 후에도 동일 오류 → 사용자가 직접 로그인 화면 정상화 후 엔터');
      }
    }

    await waitForEnter();

    if (await hasCoupangFrontendDataError(page)) {
      await recoverCoupangFrontendError(context, page);
    }

    if (await hasCoupangFrontendDataError(page)) {
      throw new Error('현재 화면에 "Cannot read properties of undefined (reading data)" 오류가 그대로 남아 있습니다. 쿠팡 로그인 페이지를 새로고침하거나 브라우저를 다시 띄운 뒤 엔터를 눌러주세요.');
    }

    const currentUrlBefore = page.url();
    log(`엔터 입력 시점 URL: ${currentUrlBefore}`);

    if (!currentUrlBefore.includes('/merchant/management/reviews')) {
      log('리뷰관리 URL이 아니어서 리뷰 페이지로 1회 자동 이동 시도');
      await openUnansweredReviewsPageSafely(page);
    }

    await ensureReadyReplyPage(page);

    const currentUrl = page.url();
    log(`시작 시점 URL: ${currentUrl}`);

    await processAllReviews(page, context);

    log('쿠팡이츠 전체 작업 종료');
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
  }
}

async function runCoupangReply() {
  console.log('쿠팡 답글 실행');
  await runCoupangEats();
}

module.exports = { runCoupangEats, runCoupangReply };

