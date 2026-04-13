const fs = require('fs');
const path = require('path');
const readline = require('readline');

const LICENSES_PATH = path.join(__dirname, '..', '03_license_server', 'data', 'licenses.json');

function ensureFile() {
  const dir = path.dirname(LICENSES_PATH);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (!fs.existsSync(LICENSES_PATH)) {
    fs.writeFileSync(LICENSES_PATH, '[]', 'utf-8');
  }
}

function readLicenses() {
  ensureFile();
  try {
    return JSON.parse(fs.readFileSync(LICENSES_PATH, 'utf-8'));
  } catch (error) {
    return [];
  }
}

function writeLicenses(data) {
  ensureFile();
  fs.writeFileSync(LICENSES_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

function randomPart(length = 4) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < length; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

function generateLicenseKey() {
  return `CDM-${randomPart(4)}-${randomPart(4)}-${randomPart(4)}`;
}

function ask(rl, question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

function parseBool(input) {
  return ['y', 'yes', '1', 'true', 'on'].includes(String(input).toLowerCase());
}

async function main() {
  ensureFile();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const customerName = await ask(rl, '고객명 입력: ');
    const daysText = await ask(rl, '사용일수 입력(예: 30): ');
    const baeminReplyBasic = await ask(rl, '배민 기본 답글 허용? (y/n): ');
    const baeminReplyPremium = await ask(rl, '배민 프리미엄 답글 허용? (y/n): ');
    const baeminBlind = await ask(rl, '배민 블라인드 허용? (y/n): ');
    const coupangReplyBasic = await ask(rl, '쿠팡 기본 답글 허용? (y/n): ');
    const coupangReplyPremium = await ask(rl, '쿠팡 프리미엄 답글 허용? (y/n): ');
    const coupangBlind = await ask(rl, '쿠팡 블라인드 허용? (y/n): ');
    const naverMail = await ask(rl, '네이버 메일 허용? (y/n): ');
    const financeAnalysis = await ask(rl, '재무 분석 허용? (y/n): ');

    const days = Number(daysText);

    if (!customerName) {
      throw new Error('고객명은 필수입니다.');
    }

    if (!Number.isFinite(days) || days <= 0) {
      throw new Error('사용일수는 1 이상의 숫자여야 합니다.');
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

    const newLicense = {
      licenseKey: generateLicenseKey(),
      customerName,
      issuedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      isEnabled: true,
      features: {
        baeminReply: parseBool(baeminReplyBasic) || parseBool(baeminReplyPremium),
        baeminReplyBasic: parseBool(baeminReplyBasic),
        baeminReplyPremium: parseBool(baeminReplyPremium),
        baeminBlind: parseBool(baeminBlind),
        coupangReply: parseBool(coupangReplyBasic) || parseBool(coupangReplyPremium),
        coupangReplyBasic: parseBool(coupangReplyBasic),
        coupangReplyPremium: parseBool(coupangReplyPremium),
        coupangBlind: parseBool(coupangBlind),
        naverMail: parseBool(naverMail),
        financeAnalysis: parseBool(financeAnalysis),
      },
    };

    const list = readLicenses();
    list.push(newLicense);
    writeLicenses(list);

    console.log('\n라이센스 발급 완료');
    console.log('고객명:', newLicense.customerName);
    console.log('라이센스 키:', newLicense.licenseKey);
    console.log('만료일:', newLicense.expiresAt);
    console.log('기능:', newLicense.features);
  } catch (error) {
    console.error('오류:', error.message);
  } finally {
    rl.close();
  }
}

main();
