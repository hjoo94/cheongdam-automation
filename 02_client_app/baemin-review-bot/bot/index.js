const { resolveFeatureRunner } = require('./actions');

async function runSingleFeature(featureKey, settings = {}, options = {}) {
  const log = typeof options.log === 'function' ? options.log : console.log;
  const errorLog = typeof options.error === 'function' ? options.error : console.error;

  try {
    const runner = resolveFeatureRunner(featureKey);

    if (!runner) {
      throw new Error(`실행할 수 없는 기능입니다: ${featureKey}`);
    }

    log(`[봇] 단일 기능 실행 시작: ${featureKey}`);
    await runner(settings);
    log(`[봇] 단일 기능 실행 완료: ${featureKey}`);

    return { ok: true };
  } catch (e) {
    errorLog(`[봇] 에러: ${e?.stack || e?.message || String(e)}`);
    return { ok: false, error: e?.message || String(e) };
  }
}

module.exports = { runSingleFeature };