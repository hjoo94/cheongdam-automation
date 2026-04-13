function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanLines(text) {
  return String(text || '')
    .split('\n')
    .map((v) => v.trim())
    .filter(Boolean);
}

async function waitForEnter() {
  if (typeof global.__uiWaitForEnter === 'function') {
    return await global.__uiWaitForEnter();
  }

  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', () => resolve());
  });
}

module.exports = {
  waitForEnter,
  sleep,
  cleanLines,
};