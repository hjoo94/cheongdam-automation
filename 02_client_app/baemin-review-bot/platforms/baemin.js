const fs = require('fs');
const path = require('path');
require('dotenv').config();
const { generateReply, hasRuntimeFeature } = require('../gptClient');
const { submitReviewCare } = require('./baeminAnswered');
const { log } = require('../utils/logger');
const { waitForEnter, sleep, cleanLines } = require('../utils/common');
const { classifyReview } = require('../utils/reviewClassifier');
const { getLogDir, ensureDir } = require('../utils/runtimePaths');
const { appendUniqueReviewLog, appendUniqueBlindReviewLog } = require('../utils/reviewLogManager');
const { buildReviewLogText } = require('../utils/reviewLogFormatter');
const { launchChromiumWithFallback } = require('../utils/browserLauncher');
const { appendUserError } = require('../utils/errorCollector');

const STORE_ID =
  process.env.BAEMIN_STORE_ID ||
  process.env.STORE_ID ||
  '14827944';

const AUTO_SUBMIT_REPLY =
  String(process.env.AUTO_SUBMIT_REPLY).toLowerCase() === 'true';

const MAX_REVIEWS = Number(process.env.MAX_REVIEWS || 500000);
const BAEMIN_RELOAD_RECOVERY_ROUNDS = Number(process.env.BAEMIN_RELOAD_RECOVERY_ROUNDS || 3);
const AUTO_BLIND_LOW_RATING_UNANSWERED =
  String(process.env.AUTO_BLIND_LOW_RATING_UNANSWERED || 'true').toLowerCase() !== 'false';
const BADWORDS_PATH = path.resolve(__dirname, '../badwords.json');
let runtimeBadwords = [];

function loadBadwords() {
  try {
    if (!fs.existsSync(BADWORDS_PATH)) {
      log('[PATCH-04] badwords.json 없음 - 빈 배열로 실행');
      runtimeBadwords = [];
      return;
    }

    const raw = fs.readFileSync(BADWORDS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const words = Array.isArray(parsed?.badwords)
      ? parsed.badwords.map((item) => String(item || '').trim()).filter(Boolean)
      : [];
    runtimeBadwords = words;
    log(`[PATCH-04] badwords.json 로드 완료 - ${runtimeBadwords.length}개 금지어 적용`);
  } catch (error) {
    runtimeBadwords = [];
    log(`[PATCH-04] badwords.json 파싱 실패 - 빈 배열로 실행 (${error.message})`);
  }
}

function appendUnifiedReviewLog(review, replyText) {
  return appendUniqueReviewLog({
    dateText: review?.date || '',
    reviewId: review?.reviewNumber || '',
    text: buildReviewLogText({
      platform: 'baemin',
      platformLabel: '배민 답글',
      featureKey: 'baeminReply',
      customerName: review?.customerName,
      reviewDate: review?.date,
      reviewId: review?.reviewNumber,
      rating: review?.rating,
      reviewType: review?.reviewType,
      orderMenu: Array.isArray(review?.menus) ? review.menus.join(', ') : '',
      body: review?.reviewText,
      replyText,
      action: 'reply_submitted',
      actionLabel: '답글 등록 완료',
    }),
  });
}

function appendBaeminBlindLog(review, actionLabel = '블라인드 요청 접수 완료') {
  return appendUniqueBlindReviewLog({
    dateText: review?.date || review?.reviewDate || '',
    reviewId: review?.reviewNumber || '',
    text: buildReviewLogText({
      platform: 'baemin',
      platformLabel: '배민 블라인드',
      featureKey: 'baeminBlind',
      customerName: review?.customerName,
      reviewDate: review?.date || review?.reviewDate,
      reviewId: review?.reviewNumber,
      rating: review?.rating,
      reviewType: review?.reviewType || 'low_rating_report',
      orderMenu: Array.isArray(review?.menus) ? review.menus.join(', ') : (review?.orderMenu || ''),
      body: review?.reviewText,
      action: 'review_care_submitted',
      actionLabel,
    }),
  });
}

function isDateLine(line) {
  return /^\d{4}년\s*\d{1,2}월\s*\d{1,2}일/.test(line);
}

function isOrderCountLine(line) {
  return /\d+회 주문 고객/.test(line);
}

function isDeliveryTypeLine(line) {
  return ['한집배달', '알뜰배달', '가게배달'].includes(line);
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
        for (let depth = 0; depth < 12; depth++) {
          if (!node || !node.parentElement) break;
          node = node.parentElement;

          const text = (node.innerText || '').trim();
          if (
            text.includes('리뷰번호') &&
            text.includes('주문메뉴') &&
            text.includes('사장님 댓글 등록하기')
          ) {
            return node;
          }
        }
        return el.parentElement || el;
      });

      cards.push(handle);
    } catch {
      // ignore
    }
  }

  return cards;
}

async function getCardLines(cardHandle) {
  const text = await cardHandle.evaluate((node) => node.innerText || '');
  return cleanLines(text);
}

async function extractRatingFromCard(cardHandle) {
  try {
    const rating = await cardHandle.evaluate((node) => {
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
          return r >= 200 && g >= 140 && b <= 160;
        }

        return false;
      };

      const cardRect = node.getBoundingClientRect();
      const topLimit = cardRect.top + 100;
      const allEls = [node, ...node.querySelectorAll('*')];

      const starTextSet = new Set();

      for (const el of allEls) {
        const text = (el.textContent || '').trim();
        if (!text) continue;

        const rect = el.getBoundingClientRect();
        if (rect.top > topLimit) continue;

        const stars = text.match(/[★⭐]/g);
        if (stars && stars.length >= 1 && stars.length <= 5) {
          const key = `${Math.round(rect.left)}-${Math.round(rect.top)}`;
          starTextSet.add(key + ':' + stars.length);
        }
      }

      let maxStarText = 0;
      for (const item of starTextSet) {
        const parts = item.split(':');
        const cnt = Number(parts[1] || 0);
        if (cnt > maxStarText) maxStarText = cnt;
      }

      if (maxStarText >= 1 && maxStarText <= 5) {
        return maxStarText;
      }

      const candidates = [];

      for (const el of allEls) {
        const rect = el.getBoundingClientRect();
        if (rect.top > topLimit) continue;
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

      candidates.sort((a, b) => a.left - b.left);

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

      if (merged.length >= 1 && merged.length <= 5) {
        return merged.length;
      }

      const topMost = Math.min(...merged.map((v) => v.top));
      const sameTopRow = merged.filter((v) => Math.abs(v.top - topMost) <= 8);

      if (sameTopRow.length >= 1 && sameTopRow.length <= 5) {
        return sameTopRow.length;
      }

      return null;
    });

    if (rating >= 1 && rating <= 5) return rating;
    return null;
  } catch {
    return null;
  }
}

async function extractPhotoYnFromCard(cardHandle) {
  try {
    const hasPhoto = await cardHandle.evaluate((node) => {
      const imgs = Array.from(node.querySelectorAll('img'));
      if (imgs.length === 0) return false;

      const meaningful = imgs.filter((img) => {
        const w = img.clientWidth || 0;
        const h = img.clientHeight || 0;
        const alt = (img.getAttribute('alt') || '').toLowerCase();
        const src = (img.getAttribute('src') || '').toLowerCase();

        if (w < 30 || h < 30) return false;
        if (
          alt.includes('logo') ||
          alt.includes('icon') ||
          alt.includes('profile')
        ) {
          return false;
        }
        if (
          src.includes('logo') ||
          src.includes('icon') ||
          src.includes('sprite')
        ) {
          return false;
        }

        return true;
      });

      return meaningful.length > 0;
    });

    return hasPhoto;
  } catch {
    return false;
  }
}

function parseCardLines(lines) {
  let deliveryType = '';
  let customerName = '';
  let date = '';
  let reviewNumber = '';
  let orderCount = '';
  let reviewText = '';
  const menus = [];

  const reviewNumberIndex = lines.findIndex((line) =>
    /^리뷰번호\s*\d+/.test(line)
  );
  const menuIndex = lines.findIndex((line) => line === '주문메뉴');

  const reviewNumberLine = lines.find((line) => /^리뷰번호\s*\d+/.test(line));
  if (reviewNumberLine) {
    const m = reviewNumberLine.match(/^리뷰번호\s*(\d+)/);
    if (m) reviewNumber = m[1];
  }

  const dateLine = lines.find((line) => isDateLine(line));
  if (dateLine) date = dateLine;

  const deliveryTypeLine = lines.find((line) => isDeliveryTypeLine(line));
  if (deliveryTypeLine) deliveryType = deliveryTypeLine;

  const orderCountLine = lines.find((line) => isOrderCountLine(line));
  if (orderCountLine) orderCount = orderCountLine;

  const dateIndex = lines.findIndex((line) => line === date);
  if (dateIndex > 0) {
    const candidate = lines[dateIndex - 1];
    if (
      candidate &&
      !isDateLine(candidate) &&
      !isOrderCountLine(candidate) &&
      !/^리뷰번호/.test(candidate) &&
      candidate !== '주문메뉴' &&
      candidate !== '배달리뷰' &&
      candidate !== '포장리뷰'
    ) {
      customerName = candidate;
    }
  }

  if (!customerName && reviewNumberIndex > 0) {
    for (let i = Math.max(0, reviewNumberIndex - 3); i < reviewNumberIndex; i++) {
      const line = lines[i];
      if (
        line &&
        !isDateLine(line) &&
        !isOrderCountLine(line) &&
        !/^리뷰번호/.test(line) &&
        !isDeliveryTypeLine(line)
      ) {
        customerName = line;
      }
    }
  }

  if (reviewNumberIndex !== -1) {
    const endIndex = menuIndex !== -1 ? menuIndex : lines.length;
    const bodyCandidates = [];

    for (let i = reviewNumberIndex + 1; i < endIndex; i++) {
      const line = lines[i];

      if (
        !line ||
        isDateLine(line) ||
        isOrderCountLine(line) ||
        isDeliveryTypeLine(line) ||
        line === '(최근 6개월 누적 주문)' ||
        line === '좋아요' ||
        line === '배달리뷰' ||
        line === '포장리뷰' ||
        line.includes('사장님 댓글 등록하기') ||
        line === '주문메뉴'
      ) {
        continue;
      }

      bodyCandidates.push(line);
    }

    reviewText = bodyCandidates.join(' ').trim();
  }

  if (menuIndex !== -1) {
    for (let i = menuIndex + 1; i < lines.length; i++) {
      const line = lines[i];

      if (
        line === '배달리뷰' ||
        line === '포장리뷰' ||
        line.includes('사장님 댓글 등록하기') ||
        /^리뷰번호\s*\d+/.test(line)
      ) {
        break;
      }

      if (
        line &&
        line !== '좋아요' &&
        line !== '(최근 6개월 누적 주문)'
      ) {
        menus.push(line);
      }
    }
  }

  return {
    deliveryType,
    customerName,
    date,
    reviewNumber,
    orderCount,
    reviewText,
    menus,
  };
}

async function extractSingleReviewFromCard(cardHandle) {
  const lines = await getCardLines(cardHandle);
  const parsed = parseCardLines(lines);
  const rating = await extractRatingFromCard(cardHandle);
  const hasPhoto = await extractPhotoYnFromCard(cardHandle);

  return {
    platform: 'baemin',
    ...parsed,
    rating,
    hasPhoto,
    reviewType: classifyReview({
      reviewText: parsed.reviewText,
      hasPhoto,
    }),
    rawLines: lines,
  };
}

async function openReplyEditor(cardHandle) {
  const root = cardHandle.asElement();
  if (!root) {
    throw new Error('리뷰 카드 element를 찾지 못했습니다.');
  }

  const btn = await root.$('text=사장님 댓글 등록하기');
  if (!btn) {
    throw new Error('사장님 댓글 등록하기 버튼을 찾지 못했습니다.');
  }

  await btn.click();
  await sleep(250);
}

async function fillReplyAndSubmit(cardHandle, replyText) {
  await openReplyEditor(cardHandle);

  const root = cardHandle.asElement();
  if (!root) {
    throw new Error('리뷰 카드 element를 찾지 못했습니다.');
  }

  async function fillText(value) {
    const textareaSelectors = [
    'textarea',
    '[contenteditable="true"]',
    'div[role="textbox"]',
    'input[type="text"]',
    ];

    let filled = false;

    for (const selector of textareaSelectors) {
      const el = await root.$(selector);
      if (!el) continue;

      try {
        const tag = await el.evaluate((node) => node.tagName.toLowerCase());

        if (tag === 'textarea' || tag === 'input') {
          await el.fill(value);
        } else {
          await el.click();
          await el.evaluate((node, nextValue) => {
            node.focus();
            node.textContent = nextValue;
            node.dispatchEvent(new Event('input', { bubbles: true }));
            node.dispatchEvent(new Event('change', { bubbles: true }));
          }, value);
        }

        filled = true;
        break;
      } catch {
        // next
      }
    }

    if (!filled) {
      throw new Error('답글 입력창을 찾지 못했습니다.');
    }
  }

  await fillText(replyText);

  if (!AUTO_SUBMIT_REPLY) {
    log('AUTO_SUBMIT_REPLY=false → 입력만 하고 등록 생략');
    return;
  }

  const submitTexts = ['등록', '댓글 등록', '작성 완료', '저장'];
  const ownerFrame = await root.ownerFrame();
  const ownerPage = ownerFrame.page();

  async function tryClickSubmit() {
    for (const text of submitTexts) {
      const btn = await root.$(`text=${text}`);
      if (!btn) continue;

      try {
        const dialogPromise = ownerPage.waitForEvent('dialog', { timeout: 1800 }).catch(() => null);
        await btn.click();
        const dialog = await dialogPromise;
        if (dialog) {
          const message = dialog.message();
          await dialog.accept().catch(() => {});
          return { ok: false, dialogMessage: message };
        }

        await sleep(500);
        const pageText = await ownerPage.locator('body').innerText({ timeout: 1000 }).catch(() => '');
        if (String(pageText).includes('키워드는 입력하실 수 없습니다')) {
          const okBtn = ownerPage.getByRole('button', { name: '확인' }).last();
          await okBtn.click({ force: true, timeout: 1500 }).catch(() => {});
          return { ok: false, dialogMessage: pageText };
        }

        return { ok: true };
      } catch {
        // next
      }
    }

    throw new Error('답글 등록 버튼을 찾지 못했습니다.');
  }

  const firstTry = await tryClickSubmit();
  if (firstTry.ok) return;

  const safeReply = buildSafeReplyText(replyText, firstTry.dialogMessage);
  log(`배민 금칙어 감지 → 확인 후 안전 답글로 재등록: ${firstTry.dialogMessage || ''}`);
  appendUserError('baemin.forbidden_keyword_retry', new Error(firstTry.dialogMessage || 'forbidden keyword'), {
    originalReply: replyText,
    safeReply,
  });

  await fillText(safeReply);
  const secondTry = await tryClickSubmit();
  if (secondTry.ok) return;

  throw new Error(`배민 금칙어 재시도 실패: ${secondTry.dialogMessage || 'unknown'}`);
}

function buildSafeReplyText(original = '', dialogMessage = '') {
  const bannedWords = Array.from(String(dialogMessage || '').matchAll(/'([^']+)'/g)).map((m) => m[1]).filter(Boolean);
  const mergedBadwords = Array.from(new Set([...bannedWords, ...runtimeBadwords]));
  let text = String(original || '').trim();

  for (const word of mergedBadwords) {
    if (!word) continue;
    text = text.split(word).join('');
  }

  text = text
    .replace(/\s+/g, ' ')
    .trim();

  if (text.length < 20 || mergedBadwords.some((word) => text.includes(word))) {
    return '소중한 리뷰 감사합니다. 앞으로도 더 좋은 맛과 서비스로 보답하겠습니다. 다시 찾아주시면 정성껏 준비하겠습니다.';
  }

  return text;
}

async function waitForReplyCardRemoval(cardHandle, timeout = 8000) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    try {
      const stillConnected = await cardHandle.evaluate((node) => node.isConnected);
      if (!stillConnected) return true;

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

async function scrollReviewsList(page) {
  await page.mouse.wheel(0, 1200);
  await sleep(1000);

  await page.evaluate(() => {
    window.scrollBy(0, 1200);
  }).catch(() => {});

  await sleep(1000);
}

async function tryReviveBaeminReviewList(page, attempts = BAEMIN_RELOAD_RECOVERY_ROUNDS) {
  for (let i = 0; i < attempts; i += 1) {
    log(`미답변 목록 새로고침 후 재탐색 (${i + 1}/${attempts})`);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await sleep(2800);

    let cards = await getReviewCardHandles(page);
    if (cards.length) return true;

    await scrollReviewsList(page);
    cards = await getReviewCardHandles(page);
    if (cards.length) return true;
  }
  return false;
}

async function processAllReviews(page, context) {
  const processedReviewNumbers = new Set();
  let processedCount = 0;
  let idleRounds = 0;

  while (processedCount < MAX_REVIEWS) {
    await sleep(700);

    let cards = await getReviewCardHandles(page);

    if (!cards.length) {
      idleRounds += 1;
      log(`리뷰 카드 없음. 스크롤 시도 ${idleRounds}`);
      await scrollReviewsList(page);

      cards = await getReviewCardHandles(page);

      if (!cards.length && idleRounds >= 3) {
        if (await tryReviveBaeminReviewList(page)) {
          log('새로고침 후 미답변 리뷰를 다시 찾았습니다. 계속 진행합니다.');
          idleRounds = 0;
          continue;
        }
        log('더 이상 처리할 리뷰가 없는 것으로 판단되어 종료합니다.');
        break;
      }
      continue;
    }

    idleRounds = 0;

    let targetCard = null;
    let review = null;

    for (const card of cards) {
      try {
        const candidate = await extractSingleReviewFromCard(card);
        if (!candidate.reviewNumber) continue;
        if (processedReviewNumbers.has(candidate.reviewNumber)) continue;

        targetCard = card;
        review = candidate;
        break;
      } catch {
        // next
      }
    }

    if (!targetCard || !review) {
      idleRounds += 1;
      log(`새 리뷰를 찾지 못함. 스크롤 시도 ${idleRounds}`);
      await scrollReviewsList(page);

      if (idleRounds >= 5) {
        if (await tryReviveBaeminReviewList(page)) {
          log('새로고침 후 처리할 리뷰를 다시 찾았습니다. 계속 진행합니다.');
          idleRounds = 0;
          continue;
        }
        log('반복 스크롤·새로고침 후에도 새 리뷰가 없어 종료합니다.');
        break;
      }
      continue;
    }

    log('\n====================================');
    log(`처리순번: ${processedCount + 1}`);
    log(`고객명: ${review.customerName || '(없음)'}`);
    log(`리뷰작성일: ${review.date || '(없음)'}`);
    log(`리뷰번호: ${review.reviewNumber || '(없음)'}`);
    log(`별점: ${review.rating ?? '(없음)'}`);
    log(`유형: ${review.reviewType}`);
    log(`본문: ${review.reviewText || '(없음)'}`);

    try {
      if (
        AUTO_BLIND_LOW_RATING_UNANSWERED &&
        typeof review.rating === 'number' &&
        review.rating <= 3 &&
        review.reviewNumber &&
        hasRuntimeFeature('baeminBlind')
      ) {
        await submitReviewCare(context, { ...review, reviewDate: review.date });
        appendBaeminBlindLog(review);
        log('미답변 3점 이하 리뷰 블라인드 신청 완료');
      }

      const replyText = await generateReply({
        ...review,
        storeName: process.env.STORE_NAME || '',
        reviewRule: process.env.REVIEW_RULE || '',
      });

      log(`생성 답글: ${replyText}`);

      await fillReplyAndSubmit(targetCard, replyText);
      log('답글 등록 완료');

      appendUnifiedReviewLog(review, replyText);

      processedReviewNumbers.add(review.reviewNumber);
      processedCount += 1;

      await waitForReplyCardRemoval(targetCard, 8000);
      await sleep(500);
    } catch (e) {
      processedReviewNumbers.add(review.reviewNumber);
      appendUserError('baemin.review_process_failed', e, {
        reviewNumber: review.reviewNumber,
        customerName: review.customerName,
        rating: review.rating,
        reviewType: review.reviewType,
        reviewText: review.reviewText,
      });
      log(`리뷰 처리 실패: ${e.message}`);
      await sleep(800);
    }
  }

  log(`총 처리 완료 건수: ${processedCount}`);
}

async function runBaemin() {
  loadBadwords();
  const browser = await launchChromiumWithFallback({
    headless: false,
    slowMo: 120,
  });

  const context = await browser.newContext({
    viewport: { width: 1400, height: 1100 },
  });

  const page = await context.newPage();

  await page.goto('https://self.baemin.com/', {
    waitUntil: 'domcontentloaded',
  });

  log('배민 사이트 열림');
  log('직접 로그인 후 "리뷰관리 > 미답변 리뷰" 화면까지 이동하세요.');
  log('이동이 끝나면 UI에서 시작 버튼을 눌러주세요.');

  await waitForEnter();
  await sleep(1000);

  await processAllReviews(page, context);

  log('\n전체 작업 종료');
}

async function runBaeminReply() {
  console.log('배민 답글 실행');
  await runBaemin();
}

module.exports = { runBaeminReply, runBaemin };
