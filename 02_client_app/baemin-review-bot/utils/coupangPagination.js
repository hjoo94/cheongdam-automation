const fs = require('fs');
const path = require('path');

const { sleep } = require('./common');
const { getLogDir, ensureDir } = require('./runtimePaths');

function safeFilename(text = '') {
  return String(text || '')
    .replace(/[^a-z0-9가-힣_.-]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'unknown';
}

async function dumpCoupangPaginationDebug(page, reason = 'not-found') {
  const dir = getLogDir();
  ensureDir(dir);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = `coupang-pagination-${stamp}-${safeFilename(reason)}`;
  const jsonPath = path.join(dir, `${base}.json`);
  const screenshotPath = path.join(dir, `${base}.png`);

  const data = await page.evaluate(() => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden'
      );
    };
    const nodes = Array.from(document.querySelectorAll('button, a, [role="button"], li, span, div'));
    const candidates = nodes
      .map((el, index) => {
        const rect = el.getBoundingClientRect();
        const text = normalize(el.innerText || el.textContent || '');
        const aria = normalize(el.getAttribute('aria-label') || '');
        const title = normalize(el.getAttribute('title') || '');
        const className = normalize(el.className || '');
        const disabled =
          !!el.disabled ||
          el.getAttribute('aria-disabled') === 'true' ||
          /\bdisabled\b|disable|dimmed/i.test(className);
        const looksLikePagination =
          /^\d+$/.test(text) ||
          /^[<>›‹»«]$/.test(text) ||
          /next|prev|pagination|page|arrow|chevron|다음|이전/i.test(
            `${text} ${aria} ${title} ${className}`
          );
        return {
          index,
          tag: el.tagName,
          text,
          aria,
          title,
          className,
          disabled,
          visible: isVisible(el),
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
          looksLikePagination,
        };
      })
      .filter((item) => item.visible && item.looksLikePagination)
      .slice(0, 200);

    return {
      url: location.href,
      title: document.title,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      scroll: { x: window.scrollX, y: window.scrollY },
      candidates,
      bodyTail: normalize(document.body?.innerText || '').slice(-5000),
    };
  }).catch((error) => ({ error: error.message }));

  fs.writeFileSync(jsonPath, JSON.stringify({ reason, ...data }, null, 2), 'utf8');
  await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => {});
  return { jsonPath, screenshotPath };
}

async function clickByHandle(page, handle) {
  await handle.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'center' })).catch(() => {});
  await sleep(150);
  const box = await handle.boundingBox().catch(() => null);
  await handle.evaluate((el) => el.click()).catch(async () => {
    if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  });
  await sleep(2500);
  return true;
}

async function clickNextCoupangReviewPage(page, options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {};
  const reason = options.reason || 'coupang-next-page';

  const before = await page.evaluate(() => ({
    url: location.href,
    scrollY: window.scrollY,
    bodyLength: document.body?.innerText?.length || 0,
    bodyHead: String(document.body?.innerText || '').slice(0, 1000),
  })).catch(() => null);

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
  await page.mouse.wheel(0, 6000).catch(() => {});
  await sleep(600);

  const pick = await page.evaluateHandle(() => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden'
      );
    };
    const isDisabled = (el) => {
      const className = normalize(el.className || '');
      return (
        !!el.disabled ||
        el.getAttribute('aria-disabled') === 'true' ||
        el.getAttribute('disabled') != null ||
        /\bdisabled\b|disable|dimmed/i.test(className)
      );
    };
    const isUnsafeAction = (item) => {
      const haystack = `${item.text} ${item.aria} ${item.title} ${item.className}`.toLowerCase();
      return /삭제|제거|지우기|닫기|취소|delete|remove|trash|bin|cancel|close/.test(haystack);
    };
    const clickableParent = (el) => el.closest('button, a, [role="button"]') || el;
    const all = Array.from(document.querySelectorAll('button, a, [role="button"], li, span, div'));
    const visible = all
      .filter((el) => isVisible(el))
      .map((el) => {
        const clickable = clickableParent(el);
        const rect = clickable.getBoundingClientRect();
        const text = normalize(el.innerText || el.textContent || '');
        const ownText = normalize(clickable.innerText || clickable.textContent || '');
        const aria = normalize(clickable.getAttribute('aria-label') || el.getAttribute('aria-label') || '');
        const title = normalize(clickable.getAttribute('title') || el.getAttribute('title') || '');
        const className = normalize(`${clickable.className || ''} ${el.className || ''}`);
        return {
          el,
          clickable,
          text: ownText || text,
          aria,
          title,
          className,
          rect,
          disabled: isDisabled(clickable) || isDisabled(el),
        };
      })
      .filter((item, index, array) => {
        if (item.disabled) return false;
        if (isUnsafeAction(item)) return false;
        if (item.rect.width <= 0 || item.rect.height <= 0) return false;
        return array.findIndex((other) => other.clickable === item.clickable) === index;
      });

    const pageNumbers = visible
      .map((item) => {
        const match = item.text.match(/^\d+$/);
        if (!match) return null;
        const pageNumber = Number(item.text);
        if (!Number.isFinite(pageNumber)) return null;
        const className = item.className.toLowerCase();
        const current =
          item.clickable.getAttribute('aria-current') === 'page' ||
          item.clickable.getAttribute('aria-selected') === 'true' ||
          /\bactive\b|selected|current|\bon\b/i.test(className) ||
          !!item.clickable.querySelector?.('[aria-current="page"], [aria-selected="true"]');
        return { ...item, pageNumber, current };
      })
      .filter(Boolean)
      .sort((a, b) => a.rect.x - b.rect.x);

    const current = pageNumbers.find((item) => item.current);

    if (current) {
      const nextNumber = pageNumbers.find(
        (item) => item.pageNumber > current.pageNumber && item.rect.x > current.rect.x - 2
      );
      if (nextNumber) return { element: nextNumber.clickable, endOfVisibleGroup: false };
    }

    const paginationY = pageNumbers.length
      ? Math.max(...pageNumbers.map((item) => item.rect.y))
      : window.innerHeight * 0.55;

    const arrowCandidates = visible
      .filter((item) => {
        const haystack = `${item.text} ${item.aria} ${item.title} ${item.className}`.toLowerCase();
        const text = item.text.trim();
        const arrowText = /^[>›»]$/.test(text);
        const keyword = /next|right|chevron|arrow|다음/.test(haystack);
        const nearPagination = Math.abs(item.rect.y - paginationY) < 90 || item.rect.y > window.innerHeight * 0.55;
        const smallPaginationButton = item.rect.width <= 90 && item.rect.height <= 90;
        const rightOfCurrent = !current || item.rect.x > current.rect.x;
        return nearPagination && smallPaginationButton && rightOfCurrent && (arrowText || keyword);
      })
      .sort((a, b) => b.rect.x - a.rect.x);

    if (arrowCandidates.length) return { element: arrowCandidates[0].clickable, endOfVisibleGroup: false };
    return { element: null, endOfVisibleGroup: !!current && pageNumbers.length > 0 };
  }).catch(() => null);

  const endOfVisibleGroup = await pick
    ?.getProperty?.('endOfVisibleGroup')
    .then((handle) => handle.jsonValue())
    .catch(() => false);
  const element = await pick?.getProperty?.('element').then((handle) => handle.asElement()).catch(() => null);

  if (!element) {
    if (endOfVisibleGroup) {
      log('쿠팡 다음 페이지 후보가 없어 현재 페이지 그룹에서 종료합니다.');
      return false;
    }
    const dump = await dumpCoupangPaginationDebug(page, reason).catch(() => null);
    if (dump) log(`쿠팡 다음 페이지 후보 저장: ${dump.jsonPath}`);
    return false;
  }

  await clickByHandle(page, element);

  const after = await page.evaluate(() => ({
    url: location.href,
    scrollY: window.scrollY,
    bodyLength: document.body?.innerText?.length || 0,
    bodyHead: String(document.body?.innerText || '').slice(0, 1000),
  })).catch(() => null);

  const moved = !!after && (
    !before ||
    after.url !== before.url ||
    after.scrollY < before.scrollY - 300 ||
    after.bodyLength !== before.bodyLength ||
    after.bodyHead !== before.bodyHead
  );

  if (!moved) {
    const dump = await dumpCoupangPaginationDebug(page, `${reason}-clicked-no-change`).catch(() => null);
    if (dump) log(`쿠팡 다음 페이지 클릭 후 변화 없음, 후보 저장: ${dump.jsonPath}`);
  }

  return moved;
}

module.exports = {
  clickNextCoupangReviewPage,
  dumpCoupangPaginationDebug,
};
