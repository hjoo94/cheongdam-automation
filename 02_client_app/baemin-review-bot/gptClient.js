const fs = require('fs');
const path = require('path');
const {
  DEFAULT_SERVER_BASE_URL,
  migrateServerBaseUrl,
} = require('./app/config');

function getRuntimePath() {
  if (process.env.RUNTIME_PATH && String(process.env.RUNTIME_PATH).trim()) {
    return String(process.env.RUNTIME_PATH).trim();
  }

  return path.join(__dirname, 'runtime.json');
}

function safeReadJson(filePath, fallback = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function normalizeServerBaseUrl(value = '') {
  const fallback = DEFAULT_SERVER_BASE_URL;
  const text = migrateServerBaseUrl(String(value || '').trim());
  if (!text) return fallback;
  if (/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/i.test(text)) {
    return text.replace(/\/+$/, '');
  }
  if (/^http:\/\/43\.202\.181\.184:4300\/?$/i.test(text) && process.env.CHUNGDAM_ALLOW_HTTP_SERVER !== 'false') {
    return text.replace(/\/+$/, '');
  }
  if (!/^https:\/\//i.test(text)) {
    return fallback;
  }
  return text.replace(/\/+$/, '');
}

function getRuntimeConfig() {
  const runtimePath = getRuntimePath();
  const runtime = safeReadJson(runtimePath, {});

  return {
    serverBaseUrl: normalizeServerBaseUrl(
      runtime.serverBaseUrl ||
      process.env.CHUNGDAM_SERVER_URL ||
      process.env.SERVER_BASE_URL
    ),
    licenseKey: String(runtime.licenseKey || '').trim(),
    storeName: String(runtime.storeName || '매장').trim(),
    reviewRule: String(runtime.reviewRule || '').trim(),
    baeminReplyMode: String(runtime.baeminReplyMode || process.env.BAEMIN_REPLY_MODE || 'advanced').trim(),
    coupangReplyMode: String(runtime.coupangReplyMode || process.env.COUPANG_REPLY_MODE || 'advanced').trim(),
    features: runtime.features || {},
    deviceFingerprint: String(runtime.deviceFingerprint || runtime.deviceId || '').trim(),
    deviceId: String(runtime.deviceId || runtime.deviceFingerprint || '').trim(),
    appVersion: String(runtime.appVersion || '').trim(),
    platform: String(runtime.platform || process.platform).trim(),
  };
}

function withClientAuth(runtime, body = {}) {
  return {
    ...body,
    licenseKey: runtime.licenseKey,
    deviceFingerprint: runtime.deviceFingerprint,
    deviceId: runtime.deviceId || runtime.deviceFingerprint,
    appVersion: runtime.appVersion,
    osPlatform: runtime.platform,
    clientPlatform: runtime.platform,
  };
}

function normalizeRatingTone(rating) {
  if (rating >= 5) return '감사 중심, 밝고 정돈된 톤';
  if (rating >= 4) return '감사 중심, 공감은 짧고 개선 언급은 최소화';
  if (rating >= 3) return '공감과 개선 약속을 균형 있게';
  return '사과와 개선 약속을 분명하게, 변명 금지';
}

async function postJson(url, body) {
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new Error(`서버 연결 실패: ${url} (${error.message})`);
  }

  if (!response.ok) {
    throw new Error(`서버 응답 오류 (${response.status})`);
  }

  const data = await response.json();

  if (!data?.ok) {
    throw new Error(data?.error || '서버 처리 실패');
  }

  return data;
}

function buildLocalApology(storeName, reviewText) {
  const text = String(reviewText || '').trim();
  const base = `${storeName || '매장'} 이용 중 불편을 드려 진심으로 죄송합니다. 남겨주신 내용 무겁게 받아들이고 같은 문제가 반복되지 않도록 즉시 점검하고 개선하겠습니다.`;
  if (!text) return base.slice(0, 180);

  const withIssue = `${storeName || '매장'} 이용 중 불편을 드려 진심으로 죄송합니다. 남겨주신 내용(${text.slice(0, 30)})을 확인했고 같은 문제가 반복되지 않도록 바로 점검하고 개선하겠습니다.`;
  return withIssue.slice(0, 180);
}

function getReplyMode(platform = '', runtime = {}) {
  if (platform === 'coupang_eats' || platform === 'coupang') {
    return runtime.coupangReplyMode || 'advanced';
  }
  return runtime.baeminReplyMode || 'advanced';
}

function getReplyFeatureKey(platform = '', mode = 'advanced') {
  const suffix = mode === 'basic' ? 'Basic' : 'Premium';
  if (platform === 'coupang_eats' || platform === 'coupang') {
    return `coupangReply${suffix}`;
  }
  return `baeminReply${suffix}`;
}

function buildLocalReply({ storeName = '', rating = 5, reviewText = '', reviewRule = '' }) {
  const name = String(storeName || '매장').trim();
  const rule = String(reviewRule || '').trim();
  const hasIssue = String(reviewText || '').trim().length > 0;
  const prefix = rule ? `${rule.split(/\r?\n/)[0].slice(0, 40)} ` : '';

  if (Number(rating || 0) <= 3) {
    return `${name} 이용에 불편을 드려 죄송합니다. ${prefix}남겨주신 내용을 확인해 같은 문제가 반복되지 않도록 바로 점검하겠습니다.`.slice(0, 220);
  }
  if (Number(rating || 0) === 4) {
    return `${name}를 이용해 주셔서 감사합니다. ${prefix}아쉬웠던 부분은 더 보완해서 다음에는 더 만족하실 수 있도록 준비하겠습니다.`.slice(0, 220);
  }
  return `${name}를 이용해 주셔서 감사합니다. ${prefix}${hasIssue ? '남겨주신 말씀을 참고해' : '앞으로도'} 정성껏 준비하겠습니다.`.slice(0, 220);
}

function looksLikePromptEcho(text = '') {
  const value = String(text || '');
  return (
    value.includes('리뷰 본문') ||
    value.includes('출력은') ||
    value.includes('reviewRule') ||
    value.includes('toneGuide') ||
    value.includes('異쒕젰') ||
    value.includes('由щ럭 蹂몃Ц')
  );
}

function isRemoteLicenseError(error) {
  const message = String(error?.message || error || '');
  return (
    message.includes('라이센스') ||
    message.includes('license') ||
    message.includes('권한') ||
    message.includes('만료') ||
    message.includes('찾을 수 없습니다')
  );
}

function tokenize(text = '') {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9가-힣\s]/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function parseLegacyLogBlock(block = '') {
  const lines = String(block).replace(/\r/g, '').split('\n').map((line) => line.trim()).filter(Boolean);
  const item = {
    platform: '',
    reviewId: '',
    reviewDate: '',
    rating: null,
    body: '',
    replyText: '',
  };

  for (const line of lines) {
    if (line.startsWith('platform:')) item.platform = line.slice('platform:'.length).trim();
    if (line.startsWith('reviewId:')) item.reviewId = line.slice('reviewId:'.length).trim();
    if (line.startsWith('reviewDate:')) item.reviewDate = line.slice('reviewDate:'.length).trim();
    if (line.startsWith('rating:')) {
      const rating = Number(line.slice('rating:'.length).replace(/[^0-9.]/g, '').trim());
      item.rating = Number.isFinite(rating) ? rating : null;
    }
    if (line.startsWith('body:')) item.body = line.slice('body:'.length).trim();
    if (line.startsWith('replyText:')) item.replyText = line.slice('replyText:'.length).trim();
    if (line.startsWith('리뷰번호:')) item.reviewId = line.slice('리뷰번호:'.length).trim();
    if (line.startsWith('리뷰작성일 ')) item.reviewDate = line.slice('리뷰작성일 '.length).trim();
    if (line.startsWith('별점:')) {
      const rating = Number(line.slice('별점:'.length).replace(/[^0-9.]/g, '').trim());
      item.rating = Number.isFinite(rating) ? rating : null;
    }
    if (line.startsWith('본문:')) item.body = line.slice('본문:'.length).trim();
    if (line.startsWith('생성 답글:')) item.replyText = line.slice('생성 답글:'.length).trim();
  }

  return item;
}

function getReferenceReviewExamples(platform = '', rating = 0, reviewText = '') {
  const runtimePath = getRuntimePath();
  const logsDir = path.join(path.dirname(runtimePath), 'logs');
  if (!fs.existsSync(logsDir)) return [];

  const targetTokens = new Set(tokenize(reviewText));
  const platformKey = platform === 'coupang_eats' ? 'coupang' : 'baemin';

  const files = fs.readdirSync(logsDir)
    .filter((name) => /^review-log-\d{4}-\d{2}\.txt$/i.test(name))
    .sort()
    .slice(-6);

  const candidates = [];

  for (const fileName of files) {
    const raw = fs.readFileSync(path.join(logsDir, fileName), 'utf8');
    const blocks = raw.split(/\n\s*\n+/).map((block) => block.trim()).filter(Boolean);

    for (const block of blocks) {
      const item = parseLegacyLogBlock(block);
      if (!item.body || !item.replyText) continue;
      if (item.platform && !String(item.platform).toLowerCase().includes(platformKey)) continue;

      const tokens = tokenize(item.body);
      const overlap = tokens.filter((token) => targetTokens.has(token)).length;
      const sameRatingBand =
        Number.isFinite(Number(item.rating)) &&
        Math.abs(Number(item.rating) - Number(rating || 0)) <= 1;

      if (!sameRatingBand && overlap === 0) continue;

      candidates.push({
        score: overlap + (sameRatingBand ? 2 : 0),
        body: item.body,
        replyText: item.replyText,
      });
    }
  }

  return candidates
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((item) => `- 리뷰: ${item.body}\n  참고 답글: ${item.replyText}`);
}

function buildAugmentedReviewRule({
  baseRule = '',
  mode = 'advanced',
  platform = '',
  rating = 0,
  reviewText = '',
}) {
  const parts = [];

  if (baseRule) {
    parts.push(baseRule);
  }

  parts.push(
    mode === 'advanced'
      ? '답변 모드: 고급. 문장을 더 자연스럽고 세련되게 작성하고, 공감과 브랜드 톤을 정교하게 맞춰라.'
      : '답변 모드: 일반. 짧고 명확하게 작성하고 과장 없이 안정적으로 작성하라.'
  );

  const referenceExamples = getReferenceReviewExamples(platform, rating, reviewText);
  if (referenceExamples.length) {
    parts.push(`유사 리뷰 참고 예시:\n${referenceExamples.join('\n')}`);
  }

  parts.push(
    mode === 'advanced'
      ? [
          '쿠팡이츠 고급 답글 작성 지시:',
          '사용자가 입력한 GPT 리뷰 답글 규칙을 최우선으로 따른다.',
          '별점, 리뷰 키워드, 주문 메뉴, 고객 불만/칭찬 포인트를 각각 반영해 답글을 세분화한다.',
          '1점은 강한 사과와 재발 방지, 2점은 사과와 개선 약속, 3점은 아쉬움 공감과 보완 약속, 4점은 감사와 보완 언급, 5점은 감사와 재주문 기대 중심으로 작성한다.',
          '쿠팡이츠 답글은 사장님이 직접 남기는 자연스러운 한국어 문장으로 작성한다.',
          '사용자 규칙에 글자 수가 있으면 반드시 그 글자 수 범위를 맞춘다.',
        ].join('\n')
      : [
          '쿠팡이츠 기본 답글 작성 지시:',
          '짧고 명확하게 작성하고 과장 없이 안정적으로 작성한다.',
          '별점에 맞춰 감사, 공감, 사과, 개선 약속의 강도를 조절한다.',
        ].join('\n')
  );

  return parts.join('\n\n').trim();
}

async function generateReply({
  platform = '',
  customerName = '',
  rating = 5,
  reviewText = '',
  menus = [],
  reviewType = '',
  storeName = '',
  reviewRule = '',
}) {
  const runtime = getRuntimeConfig();

  if (!runtime.licenseKey) {
    throw new Error('라이센스 키가 없습니다. 청담봇에서 라이센스를 다시 확인한 뒤 시도해 주세요.');
  }

  const finalStoreName = String(storeName || runtime.storeName || '매장').trim();
  const finalMode = getReplyMode(platform, runtime);
  if (finalMode === 'basic') {
    return buildLocalReply({
      storeName: finalStoreName,
      rating,
      reviewText,
      reviewRule: String(reviewRule || runtime.reviewRule || '').trim(),
    });
  }

  const finalReviewRule = buildAugmentedReviewRule({
    baseRule: String(reviewRule || runtime.reviewRule || '').trim(),
    mode: finalMode,
    platform,
    rating,
    reviewText,
  });
  const orderMenu = Array.isArray(menus) ? menus.join(', ') : String(menus || '').trim();

  try {
    const result = await postJson(`${runtime.serverBaseUrl}/api/gpt/reply`, withClientAuth(runtime, {
    featureKey: getReplyFeatureKey(platform, finalMode),
    platform,
    storeName: finalStoreName,
    reviewRule: finalReviewRule,
    rating,
    reviewText: reviewText || '',
    orderMenu,
    customerName,
    reviewType,
    toneGuide: normalizeRatingTone(Number(rating || 0)),
    modelTier: finalMode,
    }));

    const reply = String(result.reply || '').trim();
    if (!reply || looksLikePromptEcho(reply)) {
      return buildLocalReply({
        storeName: finalStoreName,
        rating,
        reviewText,
        reviewRule: finalReviewRule,
      });
    }
    return reply;
  } catch (error) {
    if (isRemoteLicenseError(error)) {
      throw new Error(`GPT 답글 생성 중단: ${error.message}`);
    }
    console.log(`[GPT] remote reply failed, using local fallback: ${error.message}`);
    return buildLocalReply({
      storeName: finalStoreName,
      rating,
      reviewText,
      reviewRule: finalReviewRule,
    });
  }
}

async function generateReviewCareApology({
  storeName = '',
  reviewText = '',
}) {
  const runtime = getRuntimeConfig();

  if (!runtime.licenseKey) {
    return buildLocalApology(storeName || runtime.storeName || '매장', reviewText);
  }

  const finalStoreName = String(storeName || runtime.storeName || '매장').trim();

  try {
    const result = await postJson(`${runtime.serverBaseUrl}/api/gpt/review-care-apology`, withClientAuth(runtime, {
      featureKey: 'naverMail',
      storeName: finalStoreName,
      reviewText: reviewText || '',
    }));

    return String(result.apology || '').trim();
  } catch {
    return buildLocalApology(finalStoreName, reviewText);
  }
}

async function classifyFinanceTransactions({ transactions = [] } = {}) {
  const runtime = getRuntimeConfig();
  if (!runtime.licenseKey || !Array.isArray(transactions) || !transactions.length) {
    return [];
  }

  try {
    const result = await postJson(`${runtime.serverBaseUrl}/api/gpt/finance-classify`, withClientAuth(runtime, {
      featureKey: 'financeAnalysis',
      transactions: transactions.slice(0, 30),
    }));
    return Array.isArray(result.categories) ? result.categories : [];
  } catch {
    return [];
  }
}

async function analyzeStoreClickWithGpt({ tableText = '', localAnalysis = {} } = {}) {
  const runtime = getRuntimeConfig();
  if (!runtime.licenseKey || !String(tableText || '').trim()) {
    return '';
  }

  try {
    const result = await postJson(`${runtime.serverBaseUrl}/api/gpt/store-click-analysis`, withClientAuth(runtime, {
      featureKey: 'baeminReplyPremium',
      tableText: String(tableText || '').slice(0, 12000),
      localAnalysis,
    }));
    return String(result.analysis || '').trim();
  } catch {
    return '';
  }
}

function buildLocalThreadsDrafts({ storeName = '', sourcePosts = [], keywords = [] } = {}) {
  const name = String(storeName || '우리 가게').trim();
  const keywordText = (keywords || []).slice(0, 3).join(', ') || '자영업';
  const topText = String(sourcePosts?.[0]?.text || '').replace(/\s+/g, ' ').slice(0, 80);
  return [
    `${name} 운영하면서 느낀 건, 매출보다 먼저 챙겨야 하는 게 하루 루틴이더라고요. ${keywordText} 하시는 분들은 이번 주에 어떤 걸 제일 먼저 점검하고 계신가요?`,
    `장사하다 보면 대단한 전략보다 작은 기준 하나가 더 오래 갑니다. 오늘은 주문 몰리는 시간, 쉬는 시간, 응대 멘트부터 다시 보고 있습니다.`,
    `이번 주 ${keywordText} 글들을 보다 보니 다들 비슷한 고민을 하시더라고요. 저도 오늘은 욕심내기보다 안 새는 비용 하나부터 줄여보려고 합니다.`,
    topText
      ? `요즘 사장님들 이야기에서 많이 보이는 고민이 있습니다. "${topText}" 같은 흐름인데, 결국 우리 가게에 맞게 작게 테스트하는 게 답인 것 같습니다.`
      : `${name}도 이번 주는 크게 바꾸기보다 작게 확인하고 있습니다. 반응 좋은 메뉴, 놓친 리뷰, 광고비 새는 시간부터 하나씩 정리해보겠습니다.`,
  ];
}

async function generateThreadsDrafts({ storeName = '', keywords = [], sourcePosts = [], direction = '' } = {}) {
  const runtime = getRuntimeConfig();
  const finalStoreName = String(storeName || runtime.storeName || '우리 가게').trim();
  const fallback = buildLocalThreadsDrafts({ storeName: finalStoreName, keywords, sourcePosts });

  if (!runtime.licenseKey || !Array.isArray(sourcePosts) || !sourcePosts.length) {
    return fallback;
  }

  try {
    const result = await postJson(`${runtime.serverBaseUrl}/api/gpt/threads-drafts`, withClientAuth(runtime, {
      featureKey: 'threadsMarketing',
      storeName: finalStoreName,
      keywords,
      sourcePosts: sourcePosts.slice(0, 8),
      direction,
    }));
    const drafts = Array.isArray(result.drafts) ? result.drafts.map((item) => String(item || '').trim()).filter(Boolean) : [];
    return drafts.length ? drafts : fallback;
  } catch (error) {
    console.log(`[GPT] threads drafts failed, using local fallback: ${error.message}`);
    return fallback;
  }
}

function hasRuntimeFeature(featureKey) {
  const runtime = getRuntimeConfig();
  return runtime.features?.[featureKey] === true;
}

module.exports = {
  generateReply,
  generateReviewCareApology,
  classifyFinanceTransactions,
  analyzeStoreClickWithGpt,
  generateThreadsDrafts,
  hasRuntimeFeature,
};
