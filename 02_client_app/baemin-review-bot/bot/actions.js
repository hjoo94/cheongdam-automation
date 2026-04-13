const fs = require('fs');
const path = require('path');

function applyRuntimeEnv(settings = {}) {
  process.env.STORE_NAME = settings.storeName || '';
  process.env.REVIEW_RULE = settings.reviewRule || '';

  process.env.BAEMIN_STORE_ID = settings.baeminStoreId || '';
  process.env.STORE_ID = settings.baeminStoreId || process.env.STORE_ID || '';

  process.env.COUPANG_STORE_ID = settings.coupangStoreId || '';
  process.env.COUPANG_BIZ_NO = settings.bizNo || '';
  process.env.BIZ_NO = settings.bizNo || '';

  process.env.ID_CARD_PATH = settings.idCardPath || '';
  process.env.IDCARD_PATH = settings.idCardPath || '';
  process.env.ID_CARD_FILE = settings.idCardPath || '';
  process.env.BAEMIN_REPLY_MODE = settings.baeminReplyMode || process.env.BAEMIN_REPLY_MODE || 'advanced';
  process.env.COUPANG_REPLY_MODE = settings.coupangReplyMode || process.env.COUPANG_REPLY_MODE || 'advanced';

  if (!process.env.AUTO_SUBMIT_REPLY) {
    process.env.AUTO_SUBMIT_REPLY = 'true';
  }

  if (!process.env.AUTO_SUBMIT_REVIEW_CARE) {
    process.env.AUTO_SUBMIT_REVIEW_CARE = 'true';
  }

  if (!process.env.REVIEW_CARE_URL) {
    process.env.REVIEW_CARE_URL =
      'https://design.happytalkio.com/chatting?siteId=4000000024&siteName=%EC%9A%B0%EC%95%84%ED%95%9C%ED%98%95%EC%A0%9C%EB%93%A4&categoryId=200691&divisionId=200692&partnerId=&shopId=&params=';
  }

  if (!process.env.COUPANG_REVIEW_CARE_URL) {
    process.env.COUPANG_REVIEW_CARE_URL = '';
  }

  if (!process.env.MAX_REVIEWS) {
    process.env.MAX_REVIEWS = '9999';
  }
}

const FEATURE_MAP = {
  baeminReply: {
    label: '배민 답글',
    moduleFile: 'baemin.js',
    exportNames: ['runBaeminReply', 'runBaemin'],
  },
  baeminBlind: {
    label: '배민 블라인드',
    moduleFile: 'baeminAnswered.js',
    exportNames: ['runBaeminBlind', 'runBaeminAnswered'],
  },
  coupangReply: {
    label: '쿠팡 답글',
    moduleFile: 'coupangEats.js',
    exportNames: ['runCoupangReply', 'runCoupangEats'],
  },
  coupangBlind: {
    label: '쿠팡 블라인드',
    moduleFile: 'coupangAnswered.js',
    exportNames: ['runCoupangBlind', 'runCoupangAnswered'],
  },
  naverMail: {
    label: '네이버 메일',
    moduleFile: 'naverMail.js',
    exportNames: ['runNaverMail'],
  },
};

function getFeatureMeta(featureKey) {
  return FEATURE_MAP[featureKey] || null;
}

function getSelectedFeatureKeys(selected = {}) {
  return Object.keys(FEATURE_MAP).filter((key) => !!selected[key]);
}

function fileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function buildCandidatePaths(moduleFile) {
  const candidates = [];

  // 개발환경
  candidates.push(path.resolve(__dirname, '../platforms', moduleFile));

  // 설치본 - unpacked 기준
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'platforms', moduleFile));
    candidates.push(path.join(process.resourcesPath, 'platforms', moduleFile));
    candidates.push(path.join(process.resourcesPath, 'app.asar', 'platforms', moduleFile));
  }

  return candidates;
}

function resolveModulePath(moduleFile) {
  const candidates = buildCandidatePaths(moduleFile);

  for (const candidate of candidates) {
    if (fileExists(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    [
      `실행 모듈을 찾지 못했습니다: ${moduleFile}`,
      '확인한 경로:',
      ...candidates.map((v) => `- ${v}`),
    ].join('\n')
  );
}

function clearRequireByResolvedPath(resolvedPath) {
  try {
    delete require.cache[require.resolve(resolvedPath)];
  } catch {
    // ignore
  }
}

function resolveFeatureRunner(featureKey) {
  const meta = getFeatureMeta(featureKey);
  if (!meta) return null;

  const resolvedModulePath = resolveModulePath(meta.moduleFile);
  clearRequireByResolvedPath(resolvedModulePath);

  const mod = require(resolvedModulePath);

  for (const exportName of meta.exportNames) {
    if (typeof mod[exportName] === 'function') {
      return mod[exportName];
    }
  }

  throw new Error(
    `${resolvedModulePath} 에서 실행 함수를 찾지 못했습니다. 기대한 export: ${meta.exportNames.join(', ')}`
  );
}

module.exports = {
  applyRuntimeEnv,
  getFeatureMeta,
  getSelectedFeatureKeys,
  resolveFeatureRunner,
};
