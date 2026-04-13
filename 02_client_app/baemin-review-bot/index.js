require("dotenv").config();

const { openNaverMail } = require("./platforms/naverMail");
const { runBaemin } = require("./platforms/baemin");
const { runCoupangEats } = require("./platforms/coupangEats");
const { runBaeminAnswered } = require("./platforms/baeminAnswered");
const { runCoupangAnswered } = require("./platforms/coupangAnswered");

async function main() {
  const platform = (process.env.PLATFORM || "baemin").toLowerCase();
  const mode = (process.env.MODE || "unanswered").toLowerCase();
  const mailTest = String(process.env.MAIL_TEST || "false").toLowerCase() === "true";

  if (mailTest) {
    console.log("\n==============================");
    console.log("네이버 메일 테스트 모드 시작");
    console.log("==============================\n");

    await testMail();
    return;
  }

  const runList = [];

  const isBaemin = platform === "baemin" || platform === "all";
  const isCoupang =
    platform === "coupang" ||
    platform === "coupangeats" ||
    platform === "coupang_eats" ||
    platform === "all";

  const isUnanswered = mode === "unanswered" || mode === "all";
  const isAnswered = mode === "answered" || mode === "all";

  if (isBaemin && isUnanswered) {
    if (typeof runBaemin !== "function") {
      throw new Error("runBaemin 함수 로드 실패: platforms/baemin.js export 확인 필요");
    }
    runList.push({ name: "배민 미답변 모드", fn: runBaemin });
  }

  if (isBaemin && isAnswered) {
    if (typeof runBaeminAnswered !== "function") {
      throw new Error("runBaeminAnswered 함수 로드 실패: platforms/baeminAnswered.js export 확인 필요");
    }
    runList.push({ name: "배민 답변완료 블라인드 모드", fn: runBaeminAnswered });
  }

  if (isCoupang && isUnanswered) {
    if (typeof runCoupangEats !== "function") {
      throw new Error("runCoupangEats 함수 로드 실패: platforms/coupangEats.js export 확인 필요");
    }
    runList.push({ name: "쿠팡 미답변 모드", fn: runCoupangEats });
  }

  if (isCoupang && isAnswered) {
    if (typeof runCoupangAnswered !== "function") {
      throw new Error("runCoupangAnswered 함수 로드 실패: platforms/coupangAnswered.js export 확인 필요");
    }
    runList.push({ name: "쿠팡 답변완료 블라인드 모드", fn: runCoupangAnswered });
  }

  if (!runList.length) {
    throw new Error(`지원하지 않는 조합입니다. PLATFORM=${platform}, MODE=${mode}`);
  }

  for (const item of runList) {
    console.log("\n==============================");
    console.log(`${item.name} 시작`);
    console.log("==============================\n");
    await item.fn();
  }
}

async function testMail() {
  const result = await openNaverMail();

  if (!result) {
    console.log("openNaverMail 실행 결과가 없습니다.");
    return;
  }

  const { browser, page, matchedLog, apology } = result;

  console.log("\n==============================");
  console.log("메일 테스트 결과");
  console.log("==============================");
  console.log("매칭 로그:", matchedLog || null);
  console.log("생성 사과문:", apology || "");
  console.log("==============================\n");

  await page.waitForTimeout(15000);
  await browser.close();
}

main().catch((err) => {
  console.error("실행 중 에러:", err.message || String(err));
  process.exit(1);
});