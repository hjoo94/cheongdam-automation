const fs = require('fs');
const path = require('path');

function tryLoadDotenv() {
  let dotenv = null;
  try {
    dotenv = require('dotenv');
  } catch {
    console.log('[ENV CHECK] dotenv module not found, continuing without .env');
    return null;
  }

  const envPathCandidates = [
    process.resourcesPath ? path.join(process.resourcesPath, '.env') : '',
    process.env.RUNTIME_PATH ? path.join(path.dirname(process.env.RUNTIME_PATH), '.env') : '',
    path.resolve(__dirname, '../.env'),
  ];

  for (const envPath of envPathCandidates) {
    if (!envPath) continue;
    if (!fs.existsSync(envPath)) continue;
    const result = dotenv.config({ path: envPath });
    if (!result.error) {
      console.log('[ENV CHECK] loaded .env from =', envPath);
      return envPath;
    }
  }

  console.log('[ENV CHECK] .env file not loaded, continuing with existing process.env');
  return null;
}

function applyRuntimeJsonEnv() {
  const runtimePath = process.env.RUNTIME_PATH || '';
  if (!runtimePath || !fs.existsSync(runtimePath)) return;

  try {
    const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
    const map = {
      storeName: 'STORE_NAME',
      reviewRule: 'REVIEW_RULE',
      baeminStoreId: 'BAEMIN_STORE_ID',
      coupangStoreId: 'COUPANG_STORE_ID',
      bizNo: 'COUPANG_BIZ_NO',
      idCardPath: 'ID_CARD_PATH',
      serverBaseUrl: 'SERVER_BASE_URL',
      baeminReplyMode: 'BAEMIN_REPLY_MODE',
      coupangReplyMode: 'COUPANG_REPLY_MODE',
    };

    for (const [key, envKey] of Object.entries(map)) {
      const value = runtime[key];
      if (value != null && String(value).trim()) {
        process.env[envKey] = String(value).trim();
      }
    }

    if (process.env.BAEMIN_STORE_ID && !process.env.STORE_ID) {
      process.env.STORE_ID = process.env.BAEMIN_STORE_ID;
    }
    if (process.env.COUPANG_BIZ_NO && !process.env.BIZ_NO) {
      process.env.BIZ_NO = process.env.COUPANG_BIZ_NO;
    }
    if (process.env.ID_CARD_PATH) {
      process.env.IDCARD_PATH = process.env.ID_CARD_PATH;
      process.env.ID_CARD_FILE = process.env.ID_CARD_PATH;
    }

    console.log('[ENV CHECK] runtime.json env applied from =', runtimePath);
  } catch (error) {
    console.log('[ENV CHECK] runtime.json load failed =', error.message);
  }
}

tryLoadDotenv();
applyRuntimeJsonEnv();

const { applyRuntimeEnv, getFeatureMeta } = require('./actions');
const { runSingleFeature } = require('./index');

let appendUserError = () => {};
try {
  appendUserError = require('../utils/errorCollector').appendUserError;
} catch (e) {
  console.warn('[runner] errorCollector load failed:', e.message);
}

function decodePayload(encoded) {
  if (!encoded) {
    throw new Error('runner payload가 없습니다.');
  }

  const json = Buffer.from(encoded, 'base64').toString('utf-8');
  return JSON.parse(json);
}

async function main() {
  const encoded = process.argv[2];
  const payload = decodePayload(encoded);

  const featureKey = payload?.featureKey;
  const settings = payload?.settings || {};
  const meta = getFeatureMeta(featureKey);

  if (!meta) {
    throw new Error(`알 수 없는 featureKey 입니다: ${featureKey}`);
  }

  applyRuntimeEnv(settings);

  if (!process.env.COUPANG_REVIEW_CARE_URL && settings?.COUPANG_REVIEW_CARE_URL) {
    process.env.COUPANG_REVIEW_CARE_URL = settings.COUPANG_REVIEW_CARE_URL;
  }

  console.log(`[runner] 준비 실행: ${meta.label}`);
  console.log('[runner] 설정 적용 완료');

  const result = await runSingleFeature(featureKey, settings, {
    log: (msg) => console.log(msg),
    error: (msg) => console.error(msg),
  });

  if (!result?.ok) {
    throw new Error(result?.error || `${meta.label} 실행 실패`);
  }
}

main().catch((error) => {
  appendUserError('runner.unhandled', error, {
    argv: process.argv.slice(2),
    runtimePath: process.env.RUNTIME_PATH || '',
  });
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
