const fs = require('fs');
const path = require('path');
require('dotenv').config();

const { log } = require('../utils/logger');
const { waitForEnter, sleep, cleanLines } = require('../utils/common');
const { getLogDir, ensureDir } = require('../utils/runtimePaths');
const {
  appendUniqueBlindReviewLog,
  getMonthlyBlindReviewLogFilename,
} = require('../utils/reviewLogManager');
const { buildReviewLogText } = require('../utils/reviewLogFormatter');
const { launchChromiumWithFallback } = require('../utils/browserLauncher');

const REVIEW_CARE_URL = process.env.REVIEW_CARE_URL;
const STORE_ID =
  process.env.BAEMIN_STORE_ID ||
  process.env.STORE_ID ||
  '14827944';

const AUTO_SUBMIT_REVIEW_CARE =
  String(process.env.AUTO_SUBMIT_REVIEW_CARE).toLowerCase() === 'true';

const MAX_REVIEWS = Number(process.env.MAX_REVIEWS || 999999);
const getMonthlyUnifiedLogFilename = getMonthlyBlindReviewLogFilename;

function appendTextLog(filename, text) {
  const dir = getLogDir();
  ensureDir(dir);
  const file = path.join(dir, filename);
  fs.appendFileSync(file, text + '\n', 'utf8');
  return file;
}

function appendUnifiedReviewLogByDate(review, text) {
  return appendUniqueBlindReviewLog({
    dateText: review?.reviewDate || '',
    reviewId: review?.reviewNumber || '',
    text,
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

function cleanReviewTextLine(line) {
  return String(line || '').trim();
}

function normalizeText(text) {
  return String(text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function getAllSearchRoots(page) {
  const roots = [page];

  try {
    const frames = page.frames();
    for (const frame of frames) {
      if (frame !== page.mainFrame()) {
        roots.push(frame);
      }
    }
  } catch {
    // ignore
  }

  return roots;
}

async function waitForHappyTalkReady(page, timeout = 20000) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    try {
      const roots = await getAllSearchRoots(page);

      for (const root of roots) {
        const body = root.locator('body');
        const bodyCount = await body.count().catch(() => 0);
        if (!bodyCount) continue;

        const txt = normalizeText(await body.innerText().catch(() => ''));
        if (
          txt.includes('리뷰') ||
          txt.includes('게시중단') ||
          txt.includes('리뷰케어') ||
          txt.includes('시작하기') ||
          txt.includes('확인했어요') ||
          txt.includes('대표자') ||
          txt.includes('이메일')
        ) {
          return true;
        }
      }
    } catch {
      // ignore
    }

    await sleep(500);
  }

  return false;
}

async function dumpHappyTalkDebug(page, reviewNumber = '') {
  try {
    appendTextLog(
      'happytalk-debug.txt',
      `\n==============================\n[${new Date().toISOString()}] review=${reviewNumber}\n`
    );

    const pageUrl = page.url();
    appendTextLog('happytalk-debug.txt', `URL: ${pageUrl}`);

    const roots = await getAllSearchRoots(page);

    for (let i = 0; i < roots.length; i++) {
      try {
        const bodyText = await roots[i].locator('body').innerText().catch(() => '');
        appendTextLog(
          'happytalk-debug.txt',
          `[FRAME ${i}] BODY:\n${normalizeText(bodyText).slice(0, 5000)}\n`
        );
      } catch {
        // ignore
      }
    }

    try {
      const html = await page.content();
      appendTextLog('happytalk-debug.txt', `[HTML]\n${String(html).slice(0, 8000)}\n`);
    } catch {
      // ignore
    }

    try {
      const dir = getLogDir();
      ensureDir(dir);
      const file = path.join(
        dir,
        `happytalk-debug-${reviewNumber || 'unknown'}-${Date.now()}.png`
      );
      await page.screenshot({ path: file, fullPage: true });
      appendTextLog('happytalk-debug.txt', `screenshot: ${file}`);
    } catch {
      // ignore
    }
  } catch {
    // ignore
  }
}

async function clickLocatorSafely(page, el) {
  try {
    await el.scrollIntoViewIfNeeded().catch(() => {});
    await sleep(150);

    try {
      await el.click({ timeout: 1500 });
      return true;
    } catch {
      const box = await el.boundingBox().catch(() => null);
      if (!box) return false;
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      return true;
    }
  } catch {
    return false;
  }
}

async function clickTextAnywhere(page, targetText, options = {}) {
  const timeout = options.timeout || 15000;
  const retryInterval = options.retryInterval || 500;
  const start = Date.now();
  const normalizedTarget = normalizeText(targetText);
  const targetRegex = new RegExp(escapeRegExp(normalizedTarget), 'i');

  while (Date.now() - start < timeout) {
    const roots = await getAllSearchRoots(page);

    for (const root of roots) {
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
        try {
          const count = await locator.count().catch(() => 0);
          if (!count) continue;

          for (let i = 0; i < count; i++) {
            const el = locator.nth(i);

            try {
              if (!(await el.isVisible().catch(() => false))) continue;

              const text = normalizeText(await el.innerText().catch(() => ''));
              const aria = normalizeText(await el.getAttribute('aria-label').catch(() => ''));
              const title = normalizeText(await el.getAttribute('title').catch(() => ''));

              const matched =
                text.includes(normalizedTarget) ||
                aria.includes(normalizedTarget) ||
                title.includes(normalizedTarget);

              if (!matched) continue;

              const clicked = await clickLocatorSafely(page, el);
              if (clicked) {
                await sleep(1200);
                return true;
              }
            } catch {
              // next
            }
          }
        } catch {
          // next
        }
      }
    }

    await sleep(retryInterval);
  }

  return false;
}

async function clickAnyText(page, targetTexts, options = {}) {
  for (const text of targetTexts) {
    const ok = await clickTextAnywhere(page, text, options);
    if (ok) return { ok: true, matched: text };
  }
  return { ok: false, matched: null };
}

async function fillChatInputAndSend(page, value) {
  const start = Date.now();
  const timeout = 15000;
  let filled = false;

  while (Date.now() - start < timeout && !filled) {
    const roots = await getAllSearchRoots(page);

    for (const root of roots) {
      const inputCandidates = [
        root.locator('textarea'),
        root.locator('input[type="text"]'),
        root.locator('[contenteditable="true"]'),
        root.locator('div[role="textbox"]'),
      ];

      for (const locator of inputCandidates) {
        try {
          const count = await locator.count().catch(() => 0);
          if (!count) continue;

          for (let i = count - 1; i >= 0; i--) {
            const el = locator.nth(i);

            try {
              if (!(await el.isVisible().catch(() => false))) continue;

              const tag = await el
                .evaluate((node) => node.tagName.toLowerCase())
                .catch(() => '');

              await el.scrollIntoViewIfNeeded().catch(() => {});
              await el.click({ timeout: 1000 }).catch(() => {});

              if (tag === 'textarea' || tag === 'input') {
                await el.fill('');
                await el.fill(value);
              } else {
                await el.evaluate((node, val) => {
                  node.focus();
                  node.textContent = '';
                  node.textContent = val;
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

          if (filled) break;
        } catch {
          // next
        }
      }

      if (filled) break;
    }

    if (!filled) {
      await sleep(500);
    }
  }

  if (!filled) {
    throw new Error('해피톡 입력창을 찾지 못했습니다.');
  }

  await sleep(700);

  const roots = await getAllSearchRoots(page);

  for (const root of roots) {
    const sendCandidates = [
      root.locator('button'),
      root.locator('[role="button"]'),
    ];

    for (const locator of sendCandidates) {
      try {
        const count = await locator.count().catch(() => 0);
        if (!count) continue;

        for (let i = count - 1; i >= 0; i--) {
          const btn = locator.nth(i);

          try {
            if (!(await btn.isVisible().catch(() => false))) continue;

            const text = normalizeText(await btn.innerText().catch(() => ''));
            const aria = normalizeText(await btn.getAttribute('aria-label').catch(() => ''));

            if (
              text === '>' ||
              text === '➤' ||
              text === '▶' ||
              text === '▸' ||
              aria.toLowerCase().includes('send') ||
              aria.includes('전송')
            ) {
              await btn.click().catch(() => {});
              await sleep(1200);
              return;
            }
          } catch {
            // next
          }
        }
      } catch {
        // next
      }
    }
  }

  await page.keyboard.press('Enter').catch(() => {});
  await sleep(1200);
}

async function getBaeminReviewCardHandles(page) {
  const reviewNoLoc = page.locator('text=/리뷰번호\\s*\\d+/');
  const count = await reviewNoLoc.count();
  const cards = [];

  for (let i = 0; i < count; i++) {
    const item = reviewNoLoc.nth(i);

    try {
      const handle = await item.evaluateHandle((el) => {
        let node = el;
        for (let depth = 0; depth < 15; depth++) {
          if (!node || !node.parentElement) break;
          node = node.parentElement;

          const text = (node.innerText || '').trim();
          if (text.includes('리뷰번호') && text.includes('주문메뉴')) {
            return node;
          }
        }
        return el.parentElement || el;
      });

      const element = handle.asElement();
      if (element) cards.push(handle);
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
      const topLimit = cardRect.top + 110;
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

function parseCardLines(lines) {
  let customerName = '';
  let reviewDate = '';
  let reviewNumber = '';
  let reviewText = '';

  const reviewNumberLine = lines.find((line) => /^리뷰번호\s*\d+/.test(line));
  if (reviewNumberLine) {
    const m = reviewNumberLine.match(/^리뷰번호\s*(\d+)/);
    if (m) reviewNumber = m[1];
  }

  const dateLine = lines.find((line) => isDateLine(line));
  if (dateLine) reviewDate = dateLine;

  const dateIndex = lines.findIndex((line) => line === reviewDate);
  if (dateIndex > 0) {
    const candidate = lines[dateIndex - 1];
    if (
      candidate &&
      !isDateLine(candidate) &&
      !isOrderCountLine(candidate) &&
      !/^리뷰번호/.test(candidate) &&
      !isDeliveryTypeLine(candidate) &&
      candidate !== '배달리뷰' &&
      candidate !== '포장리뷰' &&
      candidate !== '주문메뉴'
    ) {
      customerName = candidate;
    }
  }

  const reviewNumberIndex = lines.findIndex((line) =>
    /^리뷰번호\s*\d+/.test(line)
  );
  const menuIndex = lines.findIndex((line) => line === '주문메뉴');

  if (reviewNumberIndex !== -1) {
    const endIndex = menuIndex !== -1 ? menuIndex : lines.length;
    const bodyCandidates = [];

    for (let i = reviewNumberIndex + 1; i < endIndex; i++) {
      const line = cleanReviewTextLine(lines[i]);

      if (!line) continue;
      if (isDateLine(line)) continue;
      if (isOrderCountLine(line)) continue;
      if (isDeliveryTypeLine(line)) continue;
      if (line === '배달리뷰' || line === '포장리뷰') continue;
      if (line.includes('사장님 댓글')) continue;
      if (line === '주문메뉴') continue;
      if (line.includes('수정') || line.includes('삭제')) continue;
      if (line === '(최근 6개월 누적 주문)') continue;

      bodyCandidates.push(line);
    }

    reviewText = bodyCandidates.join(' ').trim();
  }

  return {
    customerName,
    reviewDate,
    reviewNumber,
    reviewText,
  };
}

async function extractSingleReview(cardHandle) {
  const lines = await getCardLines(cardHandle);
  const parsed = parseCardLines(lines);
  const rating = await extractRatingFromCard(cardHandle);

  return {
    ...parsed,
    rating,
    rawLines: lines,
  };
}

async function openHappyTalkPage(context) {
  if (!REVIEW_CARE_URL) {
    throw new Error('REVIEW_CARE_URL이 .env에 없습니다.');
  }

  const page = await context.newPage();

  await page.goto(REVIEW_CARE_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });

  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await sleep(3000);

  const ready = await waitForHappyTalkReady(page, 15000);
  if (!ready) {
    log('해피톡 초기 텍스트 확인 실패 → 추가 대기 진행');
    await sleep(5000);
  }

  return page;
}

async function clickHappyTalkExit(page, reviewNumber) {
  await sleep(2500);

  const exitResult = await clickAnyText(
    page,
    ['종료하기', '상담 종료', '닫기', '확인', '완료'],
    { timeout: 12000, retryInterval: 600 }
  );

  if (exitResult.ok) {
    log(`해피톡 마지막 버튼 클릭 성공: ${exitResult.matched}`);
    await sleep(1500);
    return true;
  }

  log('해피톡 마지막 종료 버튼을 찾지 못함 → 디버그 저장');
  await dumpHappyTalkDebug(page, reviewNumber);
  return false;
}

async function submitReviewCare(context, review) {
  if (!review.reviewNumber) {
    throw new Error('리뷰번호가 없어 배민 게시중단 접수를 진행할 수 없습니다.');
  }

  const carePage = await openHappyTalkPage(context);

  try {
    log(`배민 게시중단 시작: ${review.reviewNumber}`);

    const step1 = await clickTextAnywhere(carePage, '리뷰게시중단/리뷰케어 신청', {
      timeout: 20000,
    });
    if (!step1) {
      await dumpHappyTalkDebug(carePage, review.reviewNumber);
      throw new Error('해피톡: 리뷰게시중단/리뷰케어 신청 클릭 실패');
    }

    const step2 = await clickTextAnywhere(carePage, '리뷰게시중단 신청', {
      timeout: 15000,
    });
    if (!step2) {
      await dumpHappyTalkDebug(carePage, review.reviewNumber);
      throw new Error('해피톡: 리뷰게시중단 신청 클릭 실패');
    }

    const step3 = await clickTextAnywhere(carePage, '시작하기', {
      timeout: 15000,
    });
    if (!step3) {
      await dumpHappyTalkDebug(carePage, review.reviewNumber);
      throw new Error('해피톡: 시작하기 클릭 실패');
    }

    const step4 = await clickTextAnywhere(carePage, '확인했어요', {
      timeout: 15000,
    });
    if (!step4) {
      await dumpHappyTalkDebug(carePage, review.reviewNumber);
      throw new Error('해피톡: 확인했어요 클릭 실패');
    }

    await fillChatInputAndSend(carePage, STORE_ID);
    log(`해피톡 가게번호 입력 완료: ${STORE_ID}`);

    await fillChatInputAndSend(carePage, review.reviewNumber);
    log(`해피톡 리뷰번호 입력 완료: ${review.reviewNumber}`);

    const step5 = await clickTextAnywhere(carePage, '대표자', {
      timeout: 12000,
    });
    if (!step5) {
      await dumpHappyTalkDebug(carePage, review.reviewNumber);
      throw new Error('해피톡: 대표자 클릭 실패');
    }

    const step6 = await clickTextAnywhere(carePage, '이메일', {
      timeout: 12000,
    });
    if (!step6) {
      await dumpHappyTalkDebug(carePage, review.reviewNumber);
      throw new Error('해피톡: 이메일 클릭 실패');
    }

    if (!AUTO_SUBMIT_REVIEW_CARE) {
      log('AUTO_SUBMIT_REVIEW_CARE=false → 접수 직전 중단');
      return;
    }

    const step7 = await clickTextAnywhere(carePage, '접수하기', {
      timeout: 12000,
    });
    if (!step7) {
      await dumpHappyTalkDebug(carePage, review.reviewNumber);
      throw new Error('해피톡: 접수하기 클릭 실패');
    }

    log(`배민 게시중단 접수 완료: ${review.reviewNumber}`);

    await sleep(3500);

    await clickHappyTalkExit(carePage, review.reviewNumber);
  } finally {
    await sleep(1000);
    await carePage.close().catch(() => {});
    log('배민 해피톡 탭 종료 완료');
  }
}

async function scrollBaeminReviewList(page) {
  await page.mouse.wheel(0, 3000).catch(() => {});
  await sleep(1500);

  await page
    .evaluate(() => {
      window.scrollBy(0, 3000);
    })
    .catch(() => {});

  await sleep(1500);
}

async function processAnsweredReviews(page, context) {
  const processed = new Set();
  let blindCount = 0;
  let idleRounds = 0;

  while (true) {
    await sleep(1000);

    const cards = await getBaeminReviewCardHandles(page);
    log(`현재 감지된 배민 리뷰 카드 수: ${cards.length}, 처리건수: ${blindCount}`);

    let foundNewOnThisRound = false;

    for (const card of cards) {
      try {
        const review = await extractSingleReview(card);
        if (!review.reviewNumber) continue;
        if (processed.has(review.reviewNumber)) continue;

        foundNewOnThisRound = true;
        processed.add(review.reviewNumber);

        if (typeof review.rating !== 'number' || review.rating > 3) {
          continue;
        }

        log('\n====================================');
        log('[배민 전체리뷰] 저평점 리뷰 감지');
        log(`고객명: ${review.customerName || '(없음)'}`);
        log(`리뷰작성일: ${review.reviewDate || '(없음)'}`);
        log(`리뷰번호: ${review.reviewNumber}`);
        log(`별점: ${review.rating}`);
        log(`본문: ${review.reviewText || '(없음)'}`);

        await submitReviewCare(context, review);

        const unifiedLogText = buildReviewLogText({
          platform: 'baemin',
          platformLabel: '배민 블라인드',
          featureKey: 'baeminBlind',
          customerName: review.customerName,
          reviewDate: review.reviewDate,
          reviewId: review.reviewNumber,
          rating: review.rating,
          reviewType: 'low_rating_report',
          orderMenu: review.orderMenu,
          body: review.reviewText,
          action: 'review_care_submitted',
          actionLabel: '블라인드 요청 접수 완료',
        });

        appendUnifiedReviewLogByDate(review, unifiedLogText);

        blindCount += 1;

        if (MAX_REVIEWS > 0 && blindCount >= MAX_REVIEWS) {
          log(`MAX_REVIEWS(${MAX_REVIEWS}) 도달 → 종료`);
          log(`배민 전체리뷰 저평점 게시중단 완료 건수: ${blindCount}`);
          log(
            `배민 전체리뷰 TXT 로그 저장: logs/${getMonthlyUnifiedLogFilename(
              review.reviewDate
            )}`
          );
          return;
        }
      } catch (e) {
        log(`배민 전체리뷰 처리 실패: ${e.message}`);
      }
    }

    if (!foundNewOnThisRound) {
      idleRounds += 1;
      log(`새 리뷰 없음 → 스크롤 시도 ${idleRounds}`);
    } else {
      idleRounds = 0;
    }

    await scrollBaeminReviewList(page);

    if (idleRounds >= 5) {
      log('여러 번 스크롤해도 새 리뷰가 없어 종료');
      break;
    }
  }

  log(`배민 전체리뷰 저평점 게시중단 완료 건수: ${blindCount}`);
  log('배민 전체리뷰 월별 TXT 로그 저장 완료');
}

async function runBaeminAnswered() {
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
  log('직접 로그인 후 "리뷰관리 > 답변완료 또는 전체리뷰" 화면까지 이동하세요.');
  log('이동이 끝나면 UI에서 시작 버튼을 눌러주세요.');

  await waitForEnter();
  await sleep(1000);

  await processAnsweredReviews(page, context);

  log('배민 답변완료 블라인드 모드 종료');
}

async function runBaeminBlind() {
  console.log('배민 블라인드 실행');
  await runBaeminAnswered();
}

module.exports = { runBaeminBlind, runBaeminAnswered, submitReviewCare };
