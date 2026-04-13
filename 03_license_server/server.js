const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ENV_PATH = path.join(__dirname, '.env');
const DATA_DIR = path.join(__dirname, 'data');
const LICENSES_PATH = path.join(DATA_DIR, 'licenses.json');
const MOBILE_STATE_PATH = path.join(DATA_DIR, 'mobile-state.json');
const MOBILE_COMMANDS_PATH = path.join(DATA_DIR, 'mobile-commands.json');
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'http://43.203.124.132:4300';
const UPDATE_MANIFEST = {
  client: {
    version: process.env.CLIENT_APP_VERSION || '1.0.26',
    fileName: process.env.CLIENT_APP_FILE || 'Cheongdam Bot Setup 1.0.26.exe',
    notes: '설치 패키지 용량 최적화·업데이트 무결성(대용량 SHA)·전역 오류 로깅',
  },
  admin: {
    version: process.env.ADMIN_APP_VERSION || '1.0.7',
    fileName: process.env.ADMIN_APP_FILE || 'Cheongdam License Admin Setup 1.0.7.exe',
    notes: '일반/고급 답글 라이센스 선택 및 자동 업데이트 안정화',
  },
};

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, 'utf8');
  raw.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const idx = trimmed.indexOf('=');
    if (idx < 0) return;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  });
}

loadEnvFile(ENV_PATH);

const PORT = Number(process.env.PORT || 4300);
const HOST = process.env.HOST || '127.0.0.1';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'change-this-admin-secret';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL_ADVANCED = process.env.OPENAI_MODEL_ADVANCED || 'gpt-4.1';
const OPENAI_MODEL_BASIC = process.env.OPENAI_MODEL_BASIC || 'gpt-4.1-mini';

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(LICENSES_PATH)) {
    fs.writeFileSync(LICENSES_PATH, '[]', 'utf8');
  }
  if (!fs.existsSync(MOBILE_STATE_PATH)) {
    fs.writeFileSync(MOBILE_STATE_PATH, '{}', 'utf8');
  }
  if (!fs.existsSync(MOBILE_COMMANDS_PATH)) {
    fs.writeFileSync(MOBILE_COMMANDS_PATH, '[]', 'utf8');
  }
}

function readLicenses() {
  ensureDataFile();
  try {
    return JSON.parse(fs.readFileSync(LICENSES_PATH, 'utf8'));
  } catch {
    return [];
  }
}

function writeLicenses(licenses) {
  ensureDataFile();
  fs.writeFileSync(LICENSES_PATH, JSON.stringify(licenses, null, 2), 'utf8');
}

function readMobileState() {
  ensureDataFile();
  try {
    return JSON.parse(fs.readFileSync(MOBILE_STATE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeMobileState(state) {
  ensureDataFile();
  fs.writeFileSync(MOBILE_STATE_PATH, JSON.stringify(state || {}, null, 2), 'utf8');
}

function readMobileCommands() {
  ensureDataFile();
  try {
    const parsed = JSON.parse(fs.readFileSync(MOBILE_COMMANDS_PATH, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeMobileCommands(items) {
  ensureDataFile();
  fs.writeFileSync(MOBILE_COMMANDS_PATH, JSON.stringify(Array.isArray(items) ? items : [], null, 2), 'utf8');
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN || 'null',
    'Access-Control-Allow-Headers': 'Content-Type, x-admin-secret',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(payload);
}

function sendText(res, statusCode, body) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN || 'null',
    'Access-Control-Allow-Headers': 'Content-Type, x-admin-secret',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(body);
}

function sendFile(req, res, filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    sendText(res, 404, 'Not Found');
    return;
  }

  const stat = fs.statSync(filePath);
  const fileName = path.basename(filePath);
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': stat.size,
    'Content-Disposition': `attachment; filename="${encodeURIComponent(fileName)}"`,
    'Access-Control-Allow-Origin': '*',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
  stream.on('error', () => {
    if (!res.headersSent) {
      sendText(res, 500, 'Download failed');
    } else {
      res.destroy();
    }
  });
}

function sha256File(filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return '';
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    let pos = 0;
    let read;
    while ((read = fs.readSync(fd, buf, 0, buf.length, pos)) > 0) {
      hash.update(buf.subarray(0, read));
      pos += read;
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function buildUpdateManifestResponse(appName) {
  const manifest = UPDATE_MANIFEST[appName];
  if (!manifest) return null;
  const installerPath = path.join(DOWNLOADS_DIR, manifest.fileName);
  const sha256 = sha256File(installerPath);
  const installerReady = /^[a-f0-9]{64}$/i.test(sha256);
  return {
    ok: true,
    app: appName,
    version: manifest.version,
    url: `${PUBLIC_BASE_URL}/downloads/${encodeURIComponent(manifest.fileName)}`,
    fileName: manifest.fileName,
    sha256: installerReady ? sha256 : '',
    installerReady,
    notes: manifest.notes,
  };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 2 * 1024 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function randomPart(length = 4) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

function generateLicenseKey() {
  return `CDM-${randomPart(4)}-${randomPart(4)}-${randomPart(4)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function addDays(days = 30) {
  return new Date(Date.now() + Number(days || 0) * 24 * 60 * 60 * 1000).toISOString();
}

function normalizeFeatureMap(features = {}) {
  const hasBaeminReplyTier =
    Object.prototype.hasOwnProperty.call(features, 'baeminReplyBasic') ||
    Object.prototype.hasOwnProperty.call(features, 'baeminReplyPremium');
  const hasCoupangReplyTier =
    Object.prototype.hasOwnProperty.call(features, 'coupangReplyBasic') ||
    Object.prototype.hasOwnProperty.call(features, 'coupangReplyPremium');
  const baeminReplyBasic = hasBaeminReplyTier ? !!features.baeminReplyBasic : !!features.baeminReply;
  const baeminReplyPremium = hasBaeminReplyTier ? !!features.baeminReplyPremium : !!features.baeminReply;
  const coupangReplyBasic = hasCoupangReplyTier ? !!features.coupangReplyBasic : !!features.coupangReply;
  const coupangReplyPremium = hasCoupangReplyTier ? !!features.coupangReplyPremium : !!features.coupangReply;

  const financeAnalysis = !!features.financeAnalysis;
  return {
    baeminReply: baeminReplyBasic || baeminReplyPremium,
    baeminReplyBasic,
    baeminReplyPremium,
    baeminBlind: !!features.baeminBlind,
    coupangReply: coupangReplyBasic || coupangReplyPremium,
    coupangReplyBasic,
    coupangReplyPremium,
    coupangBlind: !!features.coupangBlind,
    naverMail: !!features.naverMail,
    financeAnalysis,
    threadsMarketing: !!features.threadsMarketing || financeAnalysis,
  };
}

function verifyAdminSecret(req) {
  return String(req.headers['x-admin-secret'] || '') === ADMIN_SECRET;
}

function getFeatureErrorMessage(featureKey) {
  const messages = {
    baeminReply: '라이센스에 배민 답글 기능이 포함되어 있지 않습니다.',
    baeminReplyBasic: '라이센스에 배민 기본 답글 기능이 포함되어 있지 않습니다.',
    baeminReplyPremium: '라이센스에 배민 프리미엄 답글 기능이 포함되어 있지 않습니다.',
    baeminBlind: '라이센스에 배민 블라인드 기능이 포함되어 있지 않습니다.',
    coupangReply: '라이센스에 쿠팡 답글 기능이 포함되어 있지 않습니다.',
    coupangReplyBasic: '라이센스에 쿠팡 기본 답글 기능이 포함되어 있지 않습니다.',
    coupangReplyPremium: '라이센스에 쿠팡 프리미엄 답글 기능이 포함되어 있지 않습니다.',
    coupangBlind: '라이센스에 쿠팡 블라인드 기능이 포함되어 있지 않습니다.',
    naverMail: '라이센스에 네이버 메일 기능이 포함되어 있지 않습니다.',
    financeAnalysis: '라이센스에 재무 분석 기능이 포함되어 있지 않습니다.',
    threadsMarketing: '라이센스에 스레드 초안(GPT) 기능이 포함되어 있지 않습니다.',
  };
  return messages[featureKey] || '라이센스 기능 권한이 없습니다.';
}

function validateLicenseFeature(license, featureKey) {
  if (!featureKey) return { ok: true };
  const raw = license?.features || {};
  const normalized = normalizeFeatureMap(raw);
  const legacyMap = {
    baeminReplyBasic: 'baeminReply',
    baeminReplyPremium: 'baeminReply',
    coupangReplyBasic: 'coupangReply',
    coupangReplyPremium: 'coupangReply',
  };
  const hasExplicitTier = Object.prototype.hasOwnProperty.call(raw, featureKey);
  if (!hasExplicitTier && legacyMap[featureKey] && raw[legacyMap[featureKey]]) {
    return { ok: true };
  }
  if (normalized[featureKey] !== true) {
    return { ok: false, error: getFeatureErrorMessage(featureKey) };
  }
  return { ok: true };
}

function buildLicenseHash(license) {
  const source = JSON.stringify({
    licenseKey: license.licenseKey,
    customerName: license.customerName,
    issuedAt: license.issuedAt,
    expiresAt: license.expiresAt,
    isEnabled: license.isEnabled,
    deviceFingerprint: license.deviceFingerprint || '',
    features: license.features || {},
  });
  return crypto.createHash('sha256').update(source).digest('hex');
}

function buildLegacyLicenseHash(license) {
  const source = JSON.stringify({
    licenseKey: license.licenseKey,
    customerName: license.customerName,
    issuedAt: license.issuedAt,
    expiresAt: license.expiresAt,
    isEnabled: license.isEnabled,
    features: license.features || {},
  });
  return crypto.createHash('sha256').update(source).digest('hex');
}

function findLicense(licenses, licenseKey) {
  return licenses.find((item) => String(item.licenseKey || '').trim() === String(licenseKey || '').trim());
}

function validateLicenseForUse(license, deviceFingerprint) {
  if (!license) {
    return { ok: false, error: '라이센스를 찾을 수 없습니다.' };
  }
  if (license.isEnabled === false) {
    return { ok: false, error: '비활성화된 라이센스입니다.' };
  }

  const expiresAt = new Date(license.expiresAt || '').getTime();
  if (!Number.isNaN(expiresAt) && Date.now() > expiresAt) {
    return { ok: false, error: '만료된 라이센스입니다.' };
  }

  const expectedHash = buildLicenseHash(license);
  const legacyHash = buildLegacyLicenseHash(license);
  if (!license.licenseHash || (license.licenseHash !== expectedHash && license.licenseHash !== legacyHash)) {
    return { ok: false, error: '라이센스 데이터가 손상되었습니다.' };
  }

  if (license.deviceFingerprint && !deviceFingerprint) {
    return { ok: false, error: '기기 인증 정보가 누락되었습니다.' };
  }

  if (license.deviceFingerprint && license.deviceFingerprint !== deviceFingerprint) {
    return { ok: false, error: '다른 기기에 바인딩된 라이센스입니다.' };
  }

  return { ok: true };
}

function buildMobileKey(licenseKey = '', deviceFingerprint = '') {
  return `${String(licenseKey || '').trim()}::${String(deviceFingerprint || '').trim()}`;
}

function authMobileClient(body = {}) {
  const licenseKey = String(body.licenseKey || '').trim();
  const deviceFingerprint = String(body.deviceFingerprint || body.deviceId || '').trim();
  if (!licenseKey || !deviceFingerprint) {
    return { ok: false, error: 'licenseKey 또는 deviceFingerprint가 없습니다.' };
  }
  const licenses = readLicenses();
  const license = findLicense(licenses, licenseKey);
  const validation = validateLicenseForUse(license, deviceFingerprint);
  if (!validation.ok) return validation;
  return { ok: true, licenseKey, deviceFingerprint, license };
}

function buildReplyPrompt({
  storeName,
  reviewRule,
  rating,
  reviewText,
  orderMenu,
  customerName,
  reviewType,
  toneGuide,
  modelTier,
}) {
  return [
    '너는 배달 매장 사장님을 대신해 고객 리뷰 답글을 작성하는 도우미다.',
    '답글은 한국어로 작성한다.',
    '과한 마케팅 문구, 과장, 변명은 금지한다.',
    '리뷰 텍스트가 짧아도 답글은 자연스럽고 실제 사람 말투처럼 작성한다.',
    `답변 모드: ${modelTier === 'basic' ? '일반' : '고급'}`,
    `매장명: ${storeName || '매장'}`,
    `고객명: ${customerName || '(없음)'}`,
    `평점: ${rating}`,
    `리뷰 유형: ${reviewType || '(없음)'}`,
    `메뉴: ${orderMenu || '(없음)'}`,
    `톤 가이드: ${toneGuide || ''}`,
    `추가 규칙:\n${reviewRule || '(없음)'}`,
    `리뷰 본문:\n${reviewText || '(없음)'}`,
    '출력은 답글 본문만 반환한다. 따옴표, 제목, 설명 없이 답글만 쓴다.',
    modelTier === 'basic'
      ? [
          '기본 모드 작성 규칙:',
          '짧고 명확하게 작성한다.',
          '별점에 맞춰 감사, 공감, 사과, 개선 약속의 강도를 조절한다.',
        ].join('\n')
      : [
          '고급 모드 작성 규칙:',
          '사용자가 입력한 추가 규칙을 최우선으로 따른다.',
          '별점, 리뷰 키워드, 주문 메뉴, 고객 불만/칭찬 포인트를 각각 반영해 답글을 세분화한다.',
          '1점은 강한 사과와 재발 방지, 2점은 사과와 개선 약속, 3점은 아쉬움 공감과 보완 약속, 4점은 감사와 보완 언급, 5점은 감사와 재주문 기대 중심으로 작성한다.',
          '사용자 규칙에 300~400글자 등 글자 수 지시가 있으면 반드시 그 범위를 맞춘다.',
          '쿠팡이츠 답글은 사장님이 직접 남기는 자연스러운 한국어 답글 본문만 작성한다.',
        ].join('\n'),
  ].join('\n\n');
}

function buildApologyPrompt({ storeName, reviewText }) {
  return [
    '너는 리뷰 게시중단 또는 고객 응대 사유에 들어갈 짧은 사과문을 작성한다.',
    '한국어로 2문장 이내로 작성한다.',
    '사과와 재발방지 약속은 포함하되 변명은 금지한다.',
    `매장명: ${storeName || '매장'}`,
    `리뷰 본문: ${reviewText || '(없음)'}`,
    '출력은 사과문 본문만 반환한다.',
  ].join('\n\n');
}

function buildNaverBlindApologyPrompt({ storeName, reviewText }) {
  return [
    '너는 네이버 리뷰게시 중단 신청 사유에 들어갈 매장 사과문을 작성한다.',
    '고객의 리뷰 내용을 근거로 하되 고객을 탓하거나 반박하지 않는다.',
    '매장의 책임을 100% 인정하는 표현으로 작성한다.',
    '고객이 기분 나쁘게 느낄 수 있는 표현, 변명, 법적 위협, 삭제 요구 표현은 금지한다.',
    '한국어로 2~3문장만 작성한다.',
    `매장명: ${storeName || '매장'}`,
    `고객 리뷰 본문:\n${reviewText || '(없음)'}`,
    '출력은 사과문 본문만 반환한다.',
  ].join('\n\n');
}

function buildFinanceClassifyPrompt({ transactions = [] }) {
  return [
    '너는 음식점 통장 입출금 내역을 재무제표용 분류로 정리하는 도우미다.',
    '아래 거래를 식자재, 인건비, 임대료, 공과금, 플랫폼/배달수수료, 마케팅, 소모품, 세금, 카드대금, 대출/이자, 환불/취소, 계좌이체/자금이동, 기타지출, 기타수입 중 하나로 분류한다.',
    'type은 income, expense, transfer, other 중 하나만 쓴다.',
    'JSON 배열만 출력한다. 설명 문장 금지.',
    '각 항목은 description, counterparty, category, type, confidence 필드를 가진다.',
    JSON.stringify(transactions.map((item) => ({
      description: item.description || '',
      counterparty: item.counterparty || '',
      amount: item.amount || 0,
      direction: item.direction || '',
    })), null, 2),
  ].join('\n\n');
}

function fallbackReply({ storeName, rating, reviewText }) {
  const issue = String(reviewText || '').trim();
  if (Number(rating || 0) <= 3) {
    return `${storeName || '매장'} 이용에 불편을 드려 정말 죄송합니다. 남겨주신 말씀을 바로 점검해 같은 문제가 반복되지 않도록 개선하겠습니다.`;
  }
  if (issue) {
    return `${storeName || '매장'}를 이용해 주셔서 감사합니다. 남겨주신 리뷰에 감사드리며 다음 주문에도 만족하실 수 있도록 정성껏 준비하겠습니다.`;
  }
  return `${storeName || '매장'}를 이용해 주셔서 감사합니다. 다음에도 만족하실 수 있도록 정성껏 준비하겠습니다.`;
}

function fallbackApology({ storeName, reviewText }) {
  const issue = String(reviewText || '').trim();
  if (!issue) {
    return `${storeName || '매장'} 이용에 불편을 드려 죄송합니다. 같은 문제가 반복되지 않도록 개선하겠습니다.`;
  }
  return `${storeName || '매장'} 이용에 불편을 드려 죄송합니다. 남겨주신 내용을 확인해 재발하지 않도록 개선하겠습니다.`;
}

function buildStoreClickAnalysisPrompt(body = {}) {
  return [
    '배민 우리가게클릭 성과 데이터를 사장님이 바로 실행할 수 있게 분석하세요.',
    '반드시 한국어로 작성하고, 과장하지 말고 숫자 근거를 먼저 보세요.',
    '분석 항목: 노출수, 클릭수, 주문수, 주문금액, 광고지출, CTR, CVR, ROAS, CPC, 시간대별 ON/OFF와 클릭당 희망 광고금액 조정 방향.',
    '답변 형식:',
    '1. 핵심 진단 3줄',
    '2. 증액/유지/감액 또는 OFF 판단',
    '3. 다음 실험안',
    '',
    '로컬 계산값:',
    JSON.stringify(body.localAnalysis || {}, null, 2),
    '',
    '원본 표:',
    String(body.tableText || '').slice(0, 12000),
  ].join('\n');
}

function buildThreadsDraftPrompt(body = {}) {
  const sourcePosts = Array.isArray(body.sourcePosts) ? body.sourcePosts.slice(0, 8) : [];
  const safeKeywords = Array.isArray(body.keywords)
    ? body.keywords.map((k) => String(k || '').trim()).filter(Boolean).slice(0, 12)
    : [];
  const safeDirection = String(body.direction || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const safeStoreName = String(body.storeName || '우리 가게').replace(/\s+/g, ' ').trim().slice(0, 40);
  const blockedTerms = [
    '폭력 조장',
    '테러/살인',
    '극단적 선택 미화',
    '혐오/차별 선동',
    '불법 도박/마약',
    '보이스피싱/사기 유도',
    '정치 선동/가짜뉴스 단정',
  ];
  return [
    '너는 자영업자 대상 Threads 글을 만드는 마케팅 보조자다.',
    '목표는 참고 글을 베끼는 것이 아니라, 자영업자가 공감할 만한 새 글을 만드는 것이다.',
    '원문 문장, 고유 사례, 닉네임, 매장명, 개인정보는 절대 복사하지 않는다.',
    '각 글은 한국어로 250자 이내, 사장님이 직접 올리는 자연스러운 말투로 작성한다.',
    '조회수/반응이 높은 글의 감정, 문제의식, 호흡만 참고한다.',
    '참고 항목의 source가 review-reply이면 배민·쿠팡 등 리뷰와 사장님 답글에서 나오는 감사·공감·담백한 호흡만 추출해 반영한다. 실제 주문 내용·닉네임·식별 가능한 표현은 쓰지 않는다.',
    '사용자가 모자이크한 리뷰 캡처 이미지와 함께 올릴 수 있으므로, 첫 문장에 짧은 훅을 두어 스크롤을 멈추게 하는 방식을 상황에 맞게 섞어도 된다.',
    '과장 광고, 돈 자랑, 특정 플랫폼 비난, 법적 분쟁처럼 보이는 표현은 피한다.',
    `사회적 이슈를 유발할 수 있는 금지 표현(${blockedTerms.join(', ')})은 절대 사용하지 않는다.`,
    '댓글을 부르는 질문 또는 사장님끼리 공감할 만한 마무리를 섞는다.',
    '출력은 JSON 배열만 반환한다. 설명 문장 금지.',
    '',
    `매장명: ${safeStoreName || '우리 가게'}`,
    `키워드: ${safeKeywords.join(', ')}`,
    `추가 방향: ${safeDirection || '(없음)'}`,
    '',
    '참고 글:',
    JSON.stringify(sourcePosts.map((post) => ({
      text: String(post.text || '').replace(/\s+/g, ' ').trim().slice(0, 500),
      source: String(post.source || '').replace(/\s+/g, ' ').trim().slice(0, 40),
      likeCount: post.likeCount || 0,
      replyCount: post.replyCount || 0,
      repostCount: post.repostCount || 0,
      quoteCount: post.quoteCount || 0,
      viewCount: post.viewCount || 0,
      score: post.score || 0,
    })), null, 2),
  ].join('\n');
}

function fallbackThreadsDrafts(body = {}) {
  const storeName = body.storeName || '우리 가게';
  const keyword = Array.isArray(body.keywords) && body.keywords.length ? body.keywords[0] : '자영업';
  return [
    `${storeName} 운영하면서 느낀 건, 매출보다 먼저 챙겨야 하는 게 하루 루틴이라는 점입니다. ${keyword} 하시는 사장님들은 이번 주에 어떤 것부터 점검하고 계신가요?`,
    '장사하다 보면 대단한 전략보다 작은 기준 하나가 더 오래 갑니다. 오늘은 주문 몰리는 시간, 쉬는 시간, 응대 멘트부터 다시 보고 있습니다.',
    `이번 주 ${keyword} 이야기를 보다 보니 다들 비슷한 고민을 하고 있었습니다. 저도 오늘은 욕심내기보다 안 새는 비용 하나부터 줄여보려고 합니다.`,
  ];
}

async function callOpenAI({ prompt, model }) {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      input: prompt,
      temperature: 0.7,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI error ${response.status}: ${text}`);
  }

  const data = await response.json();
  const outputText = extractOpenAIText(data);
  return sanitizeGeneratedText(outputText, prompt);
}

function extractOpenAIText(data = {}) {
  if (typeof data.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }

  if (Array.isArray(data.output)) {
    const text = data.output
      .flatMap((item) => item.content || [])
      .map((item) => {
        if (typeof item.text === 'string') return item.text;
        if (typeof item.output_text === 'string') return item.output_text;
        if (typeof item.content === 'string') return item.content;
        return '';
      })
      .join('')
      .trim();

    if (text) return text;
  }

  const choiceText = data.choices?.[0]?.message?.content || data.choices?.[0]?.text || '';
  return String(choiceText || '').trim();
}

function sanitizeGeneratedText(text = '', prompt = '') {
  const value = String(text || '').trim();
  if (!value) return '';

  const compactValue = value.replace(/\s+/g, ' ').trim();
  const compactPrompt = String(prompt || '').replace(/\s+/g, ' ').trim();

  if (compactPrompt && compactValue === compactPrompt) return '';
  if (compactValue.includes('출력은') && compactValue.includes('리뷰 본문')) return '';
  if (compactValue.includes('異쒕젰') && compactValue.includes('由щ럭')) return '';

  return value
    .replace(/^```(?:text|markdown)?\s*/i, '')
    .replace(/```$/i, '')
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .trim();
}

async function generateReply(body) {
  if (!OPENAI_API_KEY) {
    return fallbackReply(body);
  }

  const model = body.modelTier === 'basic' ? OPENAI_MODEL_BASIC : OPENAI_MODEL_ADVANCED;
  const prompt = buildReplyPrompt(body);
  const reply = await callOpenAI({ prompt, model });
  return reply || fallbackReply(body);
}

async function generateApology(body) {
  if (!OPENAI_API_KEY) {
    return fallbackApology(body);
  }

  const prompt = buildNaverBlindApologyPrompt(body);
  const apology = await callOpenAI({ prompt, model: OPENAI_MODEL_BASIC });
  return apology || fallbackApology(body);
}

async function classifyFinanceTransactions(body) {
  const transactions = Array.isArray(body.transactions) ? body.transactions.slice(0, 30) : [];
  if (!transactions.length || !OPENAI_API_KEY) return [];

  const prompt = buildFinanceClassifyPrompt({ transactions });
  const text = await callOpenAI({ prompt, model: OPENAI_MODEL_BASIC });
  const jsonText = String(text || '').replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
  try {
    const parsed = JSON.parse(jsonText);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function analyzeStoreClickPerformance(body) {
  if (!OPENAI_API_KEY) return '';
  const prompt = buildStoreClickAnalysisPrompt(body);
  return callOpenAI({ prompt, model: OPENAI_MODEL_BASIC });
}

async function generateThreadsDrafts(body) {
  if (!OPENAI_API_KEY) return fallbackThreadsDrafts(body);
  const prompt = buildThreadsDraftPrompt(body);
  const text = await callOpenAI({ prompt, model: OPENAI_MODEL_BASIC });
  const drafts = parseDraftList(text);
  return drafts.length ? drafts : fallbackThreadsDrafts(body);
}

function parseDraftList(text = '') {
  const cleaned = String(text || '')
    .replace(/^```(?:json|text|markdown)?\s*/i, '')
    .replace(/```$/i, '')
    .trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) {
      return parsed.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 8);
    }
    if (Array.isArray(parsed?.drafts)) {
      return parsed.drafts.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 8);
    }
  } catch {
    // plain text fallback below
  }

  return cleaned
    .split(/\n+/)
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').trim())
    .filter((line) => line.length >= 20)
    .slice(0, 8);
}

async function handleAdminCreateLicense(req, res) {
  if (!verifyAdminSecret(req)) {
    sendJson(res, 403, { ok: false, error: '관리자 인증 실패' });
    return;
  }

  const body = await readJsonBody(req);
  const customerName = String(body.customerName || '').trim();
  const days = Number(body.days || 0);
  if (!customerName) {
    sendJson(res, 400, { ok: false, error: '고객명을 입력해주세요.' });
    return;
  }
  if (!Number.isFinite(days) || days <= 0) {
    sendJson(res, 400, { ok: false, error: '사용일수는 1 이상이어야 합니다.' });
    return;
  }

  const licenses = readLicenses();
  const license = {
    licenseKey: generateLicenseKey(),
    customerName,
    issuedAt: nowIso(),
    expiresAt: addDays(days),
    isEnabled: true,
    deviceFingerprint: '',
    features: normalizeFeatureMap(body.features),
  };
  license.licenseHash = buildLicenseHash(license);
  licenses.push(license);
  writeLicenses(licenses);

  sendJson(res, 200, { ok: true, license });
}

async function handleAdminList(req, res) {
  if (!verifyAdminSecret(req)) {
    sendJson(res, 403, { ok: false, error: '관리자 인증 실패' });
    return;
  }

  const licenses = readLicenses().sort((a, b) => String(b.issuedAt || '').localeCompare(String(a.issuedAt || '')));
  sendJson(res, 200, { ok: true, licenses });
}

async function handleAdminToggle(req, res) {
  if (!verifyAdminSecret(req)) {
    sendJson(res, 403, { ok: false, error: '관리자 인증 실패' });
    return;
  }

  const body = await readJsonBody(req);
  const licenses = readLicenses();
  const license = findLicense(licenses, body.licenseKey);
  if (!license) {
    sendJson(res, 404, { ok: false, error: '라이센스를 찾을 수 없습니다.' });
    return;
  }

  license.isEnabled = !!body.isEnabled;
  license.licenseHash = buildLicenseHash(license);
  writeLicenses(licenses);
  sendJson(res, 200, { ok: true, license });
}

async function handleAdminExtend(req, res) {
  if (!verifyAdminSecret(req)) {
    sendJson(res, 403, { ok: false, error: '관리자 인증 실패' });
    return;
  }

  const body = await readJsonBody(req);
  const days = Number(body.days || 0);
  const licenses = readLicenses();
  const license = findLicense(licenses, body.licenseKey);
  if (!license) {
    sendJson(res, 404, { ok: false, error: '라이센스를 찾을 수 없습니다.' });
    return;
  }
  if (!Number.isFinite(days) || days <= 0) {
    sendJson(res, 400, { ok: false, error: '연장일수는 1 이상이어야 합니다.' });
    return;
  }

  const base = new Date(license.expiresAt || nowIso()).getTime();
  const next = new Date(Math.max(base, Date.now()) + days * 24 * 60 * 60 * 1000);
  license.expiresAt = next.toISOString();
  license.licenseHash = buildLicenseHash(license);
  writeLicenses(licenses);

  sendJson(res, 200, { ok: true, license });
}

async function handleAdminDelete(req, res) {
  if (!verifyAdminSecret(req)) {
    sendJson(res, 403, { ok: false, error: '관리자 인증 실패' });
    return;
  }

  const body = await readJsonBody(req);
  const licenseKey = String(body.licenseKey || '').trim();
  const licenses = readLicenses();
  const next = licenses.filter((item) => String(item.licenseKey || '').trim() !== licenseKey);

  if (!licenseKey || next.length === licenses.length) {
    sendJson(res, 404, { ok: false, error: '라이센스를 찾을 수 없습니다.' });
    return;
  }

  writeLicenses(next);
  sendJson(res, 200, { ok: true, licenseKey });
}

async function handleLicenseVerify(req, res) {
  const body = await readJsonBody(req);
  const licenseKey = String(body.licenseKey || '').trim();
  const deviceFingerprint = String(body.deviceFingerprint || body.deviceId || '').trim();
  const appVersion = String(body.appVersion || '').trim();
  const platform = String(body.platform || body.osPlatform || body.clientPlatform || '').trim();
  const integrity = Array.isArray(body.integrity)
    ? body.integrity.slice(0, 20).map((item) => ({
        name: String(item?.name || '').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 80),
        sha256: /^[a-f0-9]{64}$/i.test(String(item?.sha256 || '')) ? String(item.sha256).toLowerCase() : '',
      })).filter((item) => item.name && item.sha256)
    : [];
  if (!licenseKey) {
    sendJson(res, 400, { ok: false, error: '라이센스 키를 입력해주세요.' });
    return;
  }
  if (!deviceFingerprint) {
    sendJson(res, 400, { ok: false, error: '기기 인증 정보가 누락되었습니다.' });
    return;
  }

  const licenses = readLicenses();
  const license = findLicense(licenses, licenseKey);
  const validation = validateLicenseForUse(license, deviceFingerprint);
  if (!validation.ok) {
    sendJson(res, 200, { ok: false, error: validation.error });
    return;
  }

  if (!license.deviceFingerprint && deviceFingerprint) {
    license.deviceFingerprint = deviceFingerprint;
    license.lastVerifiedAt = nowIso();
    license.lastAppVersion = appVersion;
    license.lastPlatform = platform;
    license.lastIntegrity = integrity;
    license.licenseHash = buildLicenseHash(license);
    writeLicenses(licenses);
  } else {
    license.lastVerifiedAt = nowIso();
    license.lastAppVersion = appVersion;
    license.lastPlatform = platform;
    license.lastIntegrity = integrity;
    license.licenseHash = buildLicenseHash(license);
    writeLicenses(licenses);
  }

  sendJson(res, 200, {
    ok: true,
    customerName: license.customerName,
    expiresAt: license.expiresAt,
    features: normalizeFeatureMap(license.features || {}),
    deviceBound: true,
    nextCheckAt: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
  });
}

async function handleGptReply(req, res) {
  const body = await readJsonBody(req);
  const licenses = readLicenses();
  const license = findLicense(licenses, body.licenseKey);
  const validation = validateLicenseForUse(license, String(body.deviceFingerprint || body.deviceId || '').trim());
  if (!validation.ok) {
    sendJson(res, 200, { ok: false, error: validation.error });
    return;
  }
  const featureValidation = validateLicenseFeature(license, String(body.featureKey || '').trim());
  if (!featureValidation.ok) {
    sendJson(res, 200, { ok: false, error: featureValidation.error });
    return;
  }

  const reply = await generateReply(body);
  sendJson(res, 200, { ok: true, reply });
}

async function handleGptApology(req, res) {
  const body = await readJsonBody(req);
  const licenses = readLicenses();
  const license = findLicense(licenses, body.licenseKey);
  const validation = validateLicenseForUse(license, String(body.deviceFingerprint || body.deviceId || '').trim());
  if (!validation.ok) {
    sendJson(res, 200, { ok: false, error: validation.error });
    return;
  }
  const featureValidation = validateLicenseFeature(license, String(body.featureKey || '').trim());
  if (!featureValidation.ok) {
    sendJson(res, 200, { ok: false, error: featureValidation.error });
    return;
  }

  const apology = await generateApology(body);
  sendJson(res, 200, { ok: true, apology });
}

async function handleGptFinanceClassify(req, res) {
  const body = await readJsonBody(req);
  const licenses = readLicenses();
  const license = findLicense(licenses, body.licenseKey);
  const validation = validateLicenseForUse(license, String(body.deviceFingerprint || body.deviceId || '').trim());
  if (!validation.ok) {
    sendJson(res, 200, { ok: false, error: validation.error });
    return;
  }
  const featureValidation = validateLicenseFeature(license, String(body.featureKey || '').trim());
  if (!featureValidation.ok) {
    sendJson(res, 200, { ok: false, error: featureValidation.error });
    return;
  }

  const categories = await classifyFinanceTransactions(body);
  sendJson(res, 200, { ok: true, categories });
}

async function handleGptStoreClickAnalysis(req, res) {
  const body = await readJsonBody(req);
  const licenses = readLicenses();
  const license = findLicense(licenses, body.licenseKey);
  const validation = validateLicenseForUse(license, String(body.deviceFingerprint || body.deviceId || '').trim());
  if (!validation.ok) {
    sendJson(res, 200, { ok: false, error: validation.error });
    return;
  }
  const featureValidation = validateLicenseFeature(license, String(body.featureKey || '').trim());
  if (!featureValidation.ok) {
    sendJson(res, 200, { ok: false, error: featureValidation.error });
    return;
  }

  const analysis = await analyzeStoreClickPerformance(body);
  sendJson(res, 200, { ok: true, analysis });
}

async function handleGptThreadsDrafts(req, res) {
  const body = await readJsonBody(req);
  const licenses = readLicenses();
  const license = findLicense(licenses, body.licenseKey);
  const validation = validateLicenseForUse(license, String(body.deviceFingerprint || body.deviceId || '').trim());
  if (!validation.ok) {
    sendJson(res, 200, { ok: false, error: validation.error });
    return;
  }
  const featureValidation = validateLicenseFeature(license, String(body.featureKey || '').trim());
  if (!featureValidation.ok) {
    sendJson(res, 200, { ok: false, error: featureValidation.error });
    return;
  }

  const drafts = await generateThreadsDrafts(body);
  sendJson(res, 200, { ok: true, drafts });
}

async function handleMobileStateUpdate(req, res) {
  const body = await readJsonBody(req);
  const auth = authMobileClient(body);
  if (!auth.ok) {
    sendJson(res, 200, { ok: false, error: auth.error });
    return;
  }
  const key = buildMobileKey(auth.licenseKey, auth.deviceFingerprint);
  const now = nowIso();
  const state = readMobileState();
  const prev = state[key] || {};
  const next = {
    ...prev,
    licenseKey: auth.licenseKey,
    deviceFingerprint: auth.deviceFingerprint,
    appVersion: String(body.appVersion || prev.appVersion || ''),
    platform: String(body.platform || prev.platform || ''),
    customerName: String(auth.license?.customerName || ''),
    status: body.status && typeof body.status === 'object' ? body.status : (prev.status || {}),
    updatedAt: now,
  };
  state[key] = next;
  writeMobileState(state);
  sendJson(res, 200, { ok: true, updatedAt: now });
}

async function handleMobileStateGet(req, res) {
  const body = await readJsonBody(req);
  const auth = authMobileClient(body);
  if (!auth.ok) {
    sendJson(res, 200, { ok: false, error: auth.error });
    return;
  }
  const key = buildMobileKey(auth.licenseKey, auth.deviceFingerprint);
  const state = readMobileState();
  sendJson(res, 200, { ok: true, state: state[key] || null });
}

async function handleMobileCommandCreate(req, res) {
  const body = await readJsonBody(req);
  const auth = authMobileClient(body);
  if (!auth.ok) {
    sendJson(res, 200, { ok: false, error: auth.error });
    return;
  }
  const commandType = String(body.commandType || '').trim();
  if (!commandType) {
    sendJson(res, 400, { ok: false, error: 'commandType이 필요합니다.' });
    return;
  }
  const allowed = new Set(['threads_emergency_stop', 'feature_toggle', 'threads_policy_update']);
  if (!allowed.has(commandType)) {
    sendJson(res, 400, { ok: false, error: '지원하지 않는 commandType 입니다.' });
    return;
  }
  const payload = body.payload && typeof body.payload === 'object' ? body.payload : {};
  if (commandType === 'feature_toggle') {
    const allowedFeature = new Set(['baeminReply', 'baeminBlind', 'coupangReply', 'coupangBlind', 'naverMail', 'threadsMarketing']);
    const featureKey = String(payload.featureKey || '').trim();
    if (!allowedFeature.has(featureKey)) {
      sendJson(res, 400, { ok: false, error: 'feature_toggle payload.featureKey가 유효하지 않습니다.' });
      return;
    }
  }
  if (commandType === 'threads_policy_update') {
    const limit = Number(payload.threadsDailyLimit ?? 10);
    if (!Number.isFinite(limit) || limit < 1 || limit > 20) {
      sendJson(res, 400, { ok: false, error: 'threadsDailyLimit은 1~20 범위여야 합니다.' });
      return;
    }
  }
  const commands = readMobileCommands();
  const id = `cmd_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  commands.push({
    id,
    key: buildMobileKey(auth.licenseKey, auth.deviceFingerprint),
    commandType,
    payload,
    createdAt: nowIso(),
    consumedAt: '',
  });
  writeMobileCommands(commands);
  sendJson(res, 200, { ok: true, id });
}

async function handleMobileCommandPull(req, res) {
  const body = await readJsonBody(req);
  const auth = authMobileClient(body);
  if (!auth.ok) {
    sendJson(res, 200, { ok: false, error: auth.error });
    return;
  }
  const key = buildMobileKey(auth.licenseKey, auth.deviceFingerprint);
  const commands = readMobileCommands();
  const pending = commands.filter((c) => c.key === key && !c.consumedAt).slice(0, 10);
  const now = nowIso();
  const updated = commands.map((c) => (
    pending.some((p) => p.id === c.id) ? { ...c, consumedAt: now } : c
  ));
  if (pending.length) writeMobileCommands(updated);
  sendJson(res, 200, {
    ok: true,
    commands: pending.map((item) => ({
      id: item.id,
      commandType: item.commandType,
      payload: item.payload || {},
      createdAt: item.createdAt || '',
    })),
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      sendJson(res, 200, { ok: true });
      return;
    }

    const requestUrl = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
    const pathname = requestUrl.pathname;

    if (req.method === 'GET' && pathname === '/health') {
      sendJson(res, 200, { ok: true, status: 'healthy' });
      return;
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && pathname.startsWith('/downloads/')) {
      const fileName = decodeURIComponent(pathname.replace('/downloads/', ''));
      const safeName = path.basename(fileName);
      sendFile(req, res, path.join(DOWNLOADS_DIR, safeName));
      return;
    }

    if (req.method === 'GET' && pathname.startsWith('/api/updates/')) {
      const appName = pathname.split('/').filter(Boolean)[2];
      const payload = buildUpdateManifestResponse(appName);
      if (!payload) {
        sendJson(res, 404, { ok: false, error: 'Unknown app' });
        return;
      }

      sendJson(res, 200, payload);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/admin/licenses') {
      await handleAdminList(req, res);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/admin/licenses') {
      await handleAdminCreateLicense(req, res);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/admin/licenses/toggle') {
      await handleAdminToggle(req, res);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/admin/licenses/extend') {
      await handleAdminExtend(req, res);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/admin/licenses/delete') {
      await handleAdminDelete(req, res);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/license/verify') {
      await handleLicenseVerify(req, res);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/gpt/reply') {
      await handleGptReply(req, res);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/gpt/review-care-apology') {
      await handleGptApology(req, res);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/gpt/finance-classify') {
      await handleGptFinanceClassify(req, res);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/gpt/store-click-analysis') {
      await handleGptStoreClickAnalysis(req, res);
      return;
    }
    if (req.method === 'POST' && pathname === '/api/gpt/threads-drafts') {
      await handleGptThreadsDrafts(req, res);
      return;
    }
    if (req.method === 'POST' && pathname === '/api/mobile/state/update') {
      await handleMobileStateUpdate(req, res);
      return;
    }
    if (req.method === 'POST' && pathname === '/api/mobile/state/get') {
      await handleMobileStateGet(req, res);
      return;
    }
    if (req.method === 'POST' && pathname === '/api/mobile/commands/create') {
      await handleMobileCommandCreate(req, res);
      return;
    }
    if (req.method === 'POST' && pathname === '/api/mobile/commands/pull') {
      await handleMobileCommandPull(req, res);
      return;
    }

    sendText(res, 404, 'Not Found');
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error.message || String(error) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[chungdam-server] listening on http://${HOST}:${PORT}`);
});

