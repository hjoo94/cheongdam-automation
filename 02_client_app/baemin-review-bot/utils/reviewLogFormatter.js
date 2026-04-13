function safeText(value = '', fallback = '(none)') {
  const text = String(value == null ? '' : value).replace(/\r/g, '').trim();
  return text || fallback;
}

function safeNumber(value, fallback = '(none)') {
  return Number.isFinite(Number(value)) ? String(Number(value)) : fallback;
}

function buildReviewLogText(entry = {}) {
  const lines = [
    '=== REVIEW ENTRY ===',
    `platform: ${safeText(entry.platform, 'unknown')}`,
    `platformLabel: ${safeText(entry.platformLabel, 'Unknown')}`,
    `featureKey: ${safeText(entry.featureKey, 'unknown')}`,
    `customerName: ${safeText(entry.customerName)}`,
    `reviewDate: ${safeText(entry.reviewDate)}`,
    `reviewId: ${safeText(entry.reviewId)}`,
    `rating: ${safeNumber(entry.rating)}`,
    `reviewType: ${safeText(entry.reviewType)}`,
    `orderMenu: ${safeText(entry.orderMenu)}`,
    `body: ${safeText(entry.body)}`,
    `replyText: ${safeText(entry.replyText)}`,
    `action: ${safeText(entry.action, 'processed')}`,
    `processedAt: ${safeText(entry.processedAt, new Date().toISOString())}`,
    '',
    `고객명 ${safeText(entry.customerName, '(없음)')}`,
    `리뷰작성일 ${safeText(entry.reviewDate, '(없음)')}`,
    `리뷰번호: ${safeText(entry.reviewId, '(없음)')}`,
    `별점: ${safeNumber(entry.rating, '(없음)')}`,
    `유형: ${safeText(entry.reviewType, '(없음)')}`,
    `주문메뉴: ${safeText(entry.orderMenu, '(없음)')}`,
    `본문: ${safeText(entry.body, '(없음)')}`,
  ];

  if (entry.replyText) {
    lines.push(`생성 답글: ${safeText(entry.replyText, '(없음)')}`);
  }

  lines.push(`처리결과: ${safeText(entry.actionLabel || entry.action, 'processed')}`);
  return lines.join('\n');
}

module.exports = {
  buildReviewLogText,
};
