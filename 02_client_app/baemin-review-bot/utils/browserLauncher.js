const { chromium } = require('playwright');

function isMissingBrowserError(error) {
  const message = String(error && error.message ? error.message : error || '');
  return (
    message.includes("Executable doesn't exist") ||
    message.includes('Please run the following command to download new browsers') ||
    message.includes('browserType.launch:') ||
    message.includes('browserType.launchPersistentContext:')
  );
}

async function launchChromiumWithFallback(options = {}) {
  const attempts = [
    { label: 'playwright chromium', opts: { ...options } },
    { label: 'chrome channel', opts: { ...options, channel: 'chrome' } },
    { label: 'msedge channel', opts: { ...options, channel: 'msedge' } },
  ];

  let lastError;

  for (const attempt of attempts) {
    try {
      return await chromium.launch(attempt.opts);
    } catch (error) {
      lastError = error;
      if (!isMissingBrowserError(error)) {
        throw error;
      }
    }
  }

  throw lastError;
}

async function launchPersistentChromiumWithFallback(userDataDir, options = {}) {
  const attempts = [
    { label: 'playwright chromium', opts: { ...options } },
    { label: 'chrome channel', opts: { ...options, channel: 'chrome' } },
    { label: 'msedge channel', opts: { ...options, channel: 'msedge' } },
  ];

  let lastError;

  for (const attempt of attempts) {
    try {
      return await chromium.launchPersistentContext(userDataDir, attempt.opts);
    } catch (error) {
      lastError = error;
      if (!isMissingBrowserError(error)) {
        throw error;
      }
    }
  }

  throw lastError;
}

module.exports = {
  launchChromiumWithFallback,
  launchPersistentChromiumWithFallback,
};
