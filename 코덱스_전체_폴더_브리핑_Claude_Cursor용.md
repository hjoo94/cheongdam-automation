# 코덱스 전체 폴더 브리핑 (Claude / Cursor 전달용)

작성 기준: 2026-04-14, 로컬 경로 `C:\Users\DESKTOP\Desktop\코덱스`

민감 파일(`.env`, `*.pem`, `ssh.txt`, `licenses.json`)은 내용 확인 없이 존재와 역할만 반영했다. 패치 작업자는 이 파일들을 커밋하거나 채팅에 노출하지 말 것.

## 1. 전체 구조 요약

이 폴더는 `Cheongdam Bot` 고객용 Electron 앱, Node.js 라이선스/GPT 중계 서버, Electron 라이선스 관리자 앱, 모바일 제어 페이지/목업, 배포 산출물 보관 폴더로 구성되어 있다.

핵심 연결 흐름:

1. 고객 PC에서 `02_client_app/baemin-review-bot` Electron 앱 실행
2. 앱이 라이선스 키와 기기 지문을 `03_license_server/server.js`의 `/api/license/verify`로 전송
3. 서버가 `03_license_server/data/licenses.json`에서 라이선스 상태, 만료일, 기능 권한, 기기 바인딩을 검증
4. 고객 앱의 GPT 답글/재무/스레드 기능은 고객 PC에 OpenAI 키를 두지 않고 서버의 `/api/gpt/*` 엔드포인트를 통해 호출
5. `04_license_admin` 관리자 앱은 서버의 `/api/admin/licenses*` API로 라이선스를 발급/조회/연장/삭제/활성화
6. 모바일 웹은 서버의 `/mobile` 및 `/api/mobile/*` API로 고객 앱 상태를 보고, 스레드 긴급중지/기능 토글 같은 명령을 서버에 큐잉
7. 고객 앱은 주기적으로 모바일 명령을 pull 해서 로컬 설정에 반영
8. 자동 업데이트는 서버의 `/api/updates/client/latest`, `/api/updates/admin/latest`, `/downloads/<exe>`를 통해 동작

현재 코드 기준 기본 서버 주소는 주로 `http://43.202.181.184:4300`이다. 다만 `.cursor/rules`, `클로드_컨텍스트_복원_메모.md`, 일부 테스트에는 과거 IP `43.201.84.136`, `43.203.124.132` 흔적이 남아 있다. 패치 시 서버 주소, `PUBLIC_BASE_URL`, 고객 앱 기본 URL, 관리자 앱 기본 URL, 업데이트 매니페스트 URL을 반드시 같이 확인해야 한다.

## 2. 최상위 폴더와 역할

### `.cursor/`

Cursor 규칙 폴더다. `.cursor/rules/chungdam-delivery.mdc`가 있으며, 라이선스 서버/자동 업데이트/NSIS 설치/URL 정합성을 항상 고려하라는 운영 규칙이 들어 있다. 내용에 과거 서버 IP가 남아 있어 현재 코드와 비교 필요.

### `.deploy-update/`

과거 배포 패키지 보관 폴더다. `Cheongdam Bot Setup 1.0.8.exe`부터 `1.0.15.exe` 등 고객 앱 설치 파일과 `chungdam-license-server-update-1.0.8.tar.gz`부터 `1.0.15.tar.gz` 등 서버 업데이트 tar.gz가 있다. 현재 소스가 아니라 배포 산출물이다.

### `.git/`

Git 저장소 메타데이터다. 직접 수정 대상 아님.

### `02_client_app/`

고객용 앱 프로젝트가 들어 있다. 실제 앱은 `02_client_app/baemin-review-bot`이다. Electron 기반 Windows 앱이고 제품명은 `Cheongdam Bot`, 현재 `package.json` 버전은 `1.0.34`.

### `03_license_server/`

Node.js 라이선스/GPT 중계 서버다. `server.js`가 핵심이며, 고객 앱/관리자 앱/모바일 웹/업데이트 다운로드를 모두 담당한다. OpenAI API 키와 관리자 시크릿, JWT 시크릿은 `.env`에서 읽는다.

### `04_license_admin/`

Electron 관리자 앱이다. 제품명은 `Cheongdam License Admin`, 현재 `package.json` 버전은 `1.0.9`. 라이선스 발급/조회/연장/삭제/활성화와 관리자 앱 자동 업데이트를 담당한다.

### `05_mobile_mockup/`

모바일 제어 UI 및 테스트 페이지다. 서버가 `GET /mobile` 요청 시 `05_mobile_mockup/mobile-dashboard-mockup.html`을 읽어 제공한다. `preview-mobile.html`과 `test-offline-playground/index.html`은 서버 없이 화면/응답 흐름을 확인하는 목업이다.

### `downloads/`

최상위 다운로드 산출물 폴더다. `Cheongdam Bot Setup 1.0.32.exe`, `Cheongdam Bot Setup 1.0.33.exe` 등이 있다. 서버 프로젝트 내부의 `03_license_server/downloads`와 구분 필요.

### `new/`

테스트/참고 자료 폴더다. 은행 거래내역 xlsx/csv, 네이버 신분증 업로드 화면, 블라인드 다음페이지, 욕설감지 이미지 등이 있다. 재무 분석/네이버 메일/쿠팡 블라인드 문제 재현용 자료로 보인다.

### `문제사진_여기에넣기/`

사용자가 자동화 오류 화면 캡처를 넣는 폴더다. README에는 어떤 기능에서 문제가 났는지, 마지막 로그, 실제 동작을 같이 알려달라고 되어 있다. 현재 쿠팡 블라인드 과정 이미지들이 들어 있다.

### `패치파일_EXE_여기/`

고객에게 전달할 설치 exe/zip 보관 폴더다. `Cheongdam Bot Setup 1.0.6.exe`부터 `1.0.25.exe/Zip`, 관리자 앱 `1.0.7.exe` 등이 있다. README의 최신 파일명은 오래된 값이라 실제 파일 목록과 다르다.

### 루트 파일

`.gitignore`는 민감 파일, 빌드 결과, 로그, exe, tar.gz 등을 제외한다. `LightsailDefaultKey-ap-northeast-2.pem`은 SSH 키라 열거나 공유하지 말 것. `클로드_컨텍스트_복원_메모.md`는 과거 Claude 전달용 메모인데 콘솔에서 일부 인코딩이 깨져 보이며, 내용상 과거 버전/IP 정보가 섞여 있다.

## 3. 고객 앱 `02_client_app/baemin-review-bot`

### 목적

배민/쿠팡이츠 리뷰 답글 자동화, 배민/쿠팡 블라인드/리뷰케어 신청, 네이버 메일 기반 신고/신분증 업로드 자동화, 재무 분석, 가게클릭 분석, 스레드 마케팅 초안 생성, 모바일 원격 토글, 자동 업데이트를 묶은 Electron 고객 앱이다.

### 주요 의존성

- 런타임: `dotenv`, `playwright`
- 개발/빌드: `electron`, `electron-builder`
- 빌드 스크립트: `npm run build` 또는 `npm run build:win`
- 테스트: `npm test` -> `scripts/smoke-tests.js`

### 주요 폴더

- `app/`: Electron 메인/프리로드/HTML UI/보안 설정
- `bot/`: UI에서 선택한 기능을 개별 자동화 모듈로 연결하고 서브프로세스 실행
- `platforms/`: 실제 배민/쿠팡/네이버 자동화 로직
- `utils/`: 브라우저 실행, 로그, 재무 분석, 리뷰 분석, 보안 감사, 스레드 수집/안전 필터, 쿠팡 페이지네이션 등 공통 유틸
- `scripts/`: smoke test
- `assets/`: 현재 파일 없음
- `.deploy`, `.deploy-update`, `dist*`, `build`, `logs`, `tmp`, `node_modules`: 배포/빌드/로그/임시/의존성 산출물

### `app/main.js`

고객 앱의 중심 파일이다. 담당 기능:

- Electron 창 생성 및 IPC 핸들러 등록
- 사용자 설정 저장/불러오기 (`settings.json`)
- 라이선스 저장/검증 (`license.json`)
- 런타임 설정 파일 생성 (`runtime.json`)
- 기기 지문 생성: Windows MachineGuid, hostname, MAC, platform/arch 등을 sha256으로 해시
- 서버 URL 마이그레이션 및 HTTPS/신뢰 HTTP 검증
- 자동 업데이트: `/api/updates/client/latest` 확인, sha256 검증, 설치 파일 다운로드, NSIS silent 설치 실행
- 라이선스 재검증 주기: 6시간
- 기능 권한 적용: `baeminReplyBasic/Premium`, `coupangReplyBasic/Premium`, `baeminBlind`, `coupangBlind`, `naverMail`, `financeAnalysis`, `threadsMarketing`
- 선택 기능별 서브프로세스 준비/시작/중지
- 모바일 상태 push 및 명령 pull: `/api/mobile/state/update`, `/api/mobile/commands/pull`
- 재무 파일 선택/분석, 가게클릭 분석, 스레드 초안 생성, 오류 로그 요약

중요 IPC:

- `save-settings`, `load-settings`
- `check-server-connection`
- `check-app-update`
- `save-license`, `load-license`, `verify-license`
- `prepare-bot`, `start-bot`, `stop-bot`
- `reset-coupang`
- `get-review-analysis`
- `pick-idcard`, `pick-finance-file`, `pick-finance-deposit-files`, `pick-finance-withdrawal-files`
- `analyze-finance-file`
- `analyze-store-click`
- `analyze-threads-marketing`
- `open-threads-mosaic-folder`, `open-log-folder`, `summarize-error-logs`

### `app/config.js`

서버 기본 주소와 구 서버 주소 마이그레이션을 담당한다.

- 현재 기본값: `http://43.202.181.184:4300`
- 레거시 목록: `43.203.124.132`, `43.201.84.136`의 http/https
- `migrateServerBaseUrl()`은 레거시 주소를 현재 기본 주소로 바꾼다.

### `app/security.js`

보안 유틸이다. 주요 역할:

- 민감 설정 키(`threadsAccessToken` 등) 저장 시 Electron `safeStorage`로 암호화
- 로그 마스킹
- 신뢰 가능한 HTTP 라이선스 서버 판정
- sha256 파일 해시 및 constant-time hex 비교
- 패키지 앱에서 불안전한 서버 URL 차단

### `app/preload.js`

Renderer에 `window.chungdamApi` 형태로 안전한 IPC API만 노출한다. UI에서 직접 Node 접근하지 않도록 `contextIsolation` 구조를 쓴다.

### `app/index.html`

고객 앱 UI다. 라이선스 섹션, 자동화 기능 선택, 매장/GPT 답글 규칙, 재무 분석, 스레드 초안, 로그 등 다수 UI와 프론트 스크립트가 한 파일에 들어 있다.

### `bot/actions.js`

UI 선택값을 실제 플랫폼 모듈로 매핑한다.

- `baeminReply` -> `platforms/baemin.js`
- `baeminBlind` -> `platforms/baeminAnswered.js`
- `coupangReply` -> `platforms/coupangEats.js`
- `coupangBlind` -> `platforms/coupangAnswered.js`
- `naverMail` -> `platforms/naverMail.js`

또한 매장명, 답글 규칙, 배민/쿠팡 스토어 ID, 사업자번호, 신분증 파일 경로, 답글 모드 등을 환경변수로 주입한다.

### `bot/runner.js`

각 자동화 기능을 별도 Node 프로세스로 실행하는 진입점이다. `runtime.json`과 `.env`를 읽어 환경변수를 복원하고, featureKey에 맞는 모듈을 실행한다. UI 메인 프로세스와 자동화 프로세스를 분리해 충돌을 줄이는 구조다.

### `bot/index.js`, `bot/actions.js`

`runSingleFeature` 계열을 통해 featureKey별 자동화 함수를 호출한다. 패치 시 `bot/actions.js`의 feature map과 `platforms/*.js`의 export 이름이 맞는지 확인해야 한다.

### `platforms/`

실제 Playwright 자동화 코드다.

- `baemin.js`: 배민 미답변 리뷰 수집, GPT 답글 생성, 답글 입력/제출, 리뷰 로그 저장
- `baeminAnswered.js`: 배민 답변 완료 리뷰/블라인드 또는 리뷰케어 신청 흐름, HappyTalk 페이지 연동
- `coupangEats.js`: 쿠팡이츠 미답변 리뷰 답글 자동화, 쿠팡 로그인/리뷰 페이지 복구/세션 정리
- `coupangAnswered.js`: 쿠팡이츠 답변 완료/블라인드 신청 흐름, HappyTalk 단계 클릭, 다음 페이지 처리, 디버그 아티팩트 저장
- `naverMail.js`: 네이버 메일에서 리뷰케어/신고 관련 메일을 열고 신청 폼 이동, 닉네임/사유 입력, 신분증 업로드, 제출 및 메일 삭제 처리

문제 화면이 들어오면 우선 매칭:

- 쿠팡 답글 문제: `platforms/coupangEats.js`
- 쿠팡 블라인드 문제: `platforms/coupangAnswered.js`
- 배민 답글 문제: `platforms/baemin.js`
- 배민 블라인드/리뷰케어 문제: `platforms/baeminAnswered.js`
- 네이버 메일/신분증 업로드 문제: `platforms/naverMail.js`

### `gptClient.js`

고객 앱에서 GPT 관련 서버 API를 호출하는 클라이언트다.

- 런타임 설정에서 `serverBaseUrl`, `licenseKey`, `deviceFingerprint`, 기능 권한을 읽는다.
- 기본 답글 모드는 `basic`이면 로컬 템플릿 답글, `advanced`이면 서버 GPT 호출.
- `/api/gpt/reply`: 리뷰 답글 생성
- `/api/gpt/review-care-apology`: 리뷰케어 사과문 생성
- `/api/gpt/finance-classify`: 재무 거래 분류
- `/api/gpt/store-click-analysis`: 가게클릭 성과 분석
- `/api/gpt/threads-drafts`: 스레드 초안 생성
- 서버 실패 시 일부 기능은 로컬 fallback을 사용하지만, 라이선스 오류는 중단 오류로 올린다.

### `utils/`

주요 유틸 역할:

- `browserLauncher.js`: Playwright Chromium 실행 fallback
- `common.js`: sleep, line cleanup, enter 대기
- `coupangPagination.js`: 쿠팡 리뷰 다음 페이지 탐색/클릭/디버그
- `errorCollector.js`: 사용자 오류 로그 기록
- `financeAnalyzer.js`: xlsx/xls/csv/txt 거래내역 파싱, 엑셀/PowerShell fallback, 입금/출금 분리, 카테고리 분류, VAT/세금/마진 계산, 메모리 저장
- `logger.js`: 로그 파일 기록
- `reviewAnalysis.js`: 리뷰 로그를 월별/플랫폼별로 분석
- `reviewClassifier.js`: 리뷰 성격 분류
- `reviewLogFormatter.js`, `reviewLogManager.js`: 리뷰 로그 포맷/중복 방지/월별 파일 관리
- `reviewCaptureMosaic.js`: 스레드 초안용 리뷰 이미지 모자이크 처리
- `runtimePaths.js`: 런타임 루트, 로그, 브라우저 프로필, auth 경로 계산
- `securityAudit.js`: 보안 이벤트/민감값 해시 감사 로그
- `storeClickAnalyzer.js`: 가게클릭 표 텍스트 파싱/성과 계산
- `threadsMarketing.js`: Threads API/수동 게시글 수집, 키워드 정규화, 게시글 랭킹
- `threadsSafety.js`: 스레드 초안 금칙/위험 문구 필터
- `versionCompare.js`: 업데이트 버전 비교

### 빌드 관련 주의점

`package.json`의 `build.asarUnpack`에 `app/security.js`, `app/config.js`, `bot/**/*`, `platforms/**/*`, `utils/**/*`, `gptClient.js`, `index.js`, `dotenv`, `playwright` 관련 패키지가 포함된다. 자동화 모듈은 패키징 후에도 `app.asar.unpacked`에서 require 가능해야 한다.

`dist`, `dist1032`, `dist1033`, `dist1034`, `dist-secure-test`는 빌드 산출물이다. 보통 소스 패치는 `app/`, `bot/`, `platforms/`, `utils/`, `gptClient.js`, `package.json` 쪽에 하고, 빌드 산출물은 재빌드 결과로만 갱신한다.

## 4. 라이선스/GPT 서버 `03_license_server`

### 목적

고객 PC에 OpenAI API 키를 두지 않고 서버에서만 GPT를 호출하며, 라이선스 발급/검증/기능 권한/기기 바인딩/모바일 명령/업데이트 매니페스트/다운로드를 처리한다.

### 주요 의존성

- `jsonwebtoken`만 런타임 의존성
- `npm start` -> `node server.js`
- `sync:client-installer` -> `node scripts/sync-client-installer.js`

### 주요 파일/폴더

- `server.js`: 전체 HTTP API 서버
- `.env`: `HOST`, `PORT`, `PUBLIC_BASE_URL`, `ADMIN_SECRET`, `OPENAI_API_KEY`, `OPENAI_MODEL_ADVANCED`, `OPENAI_MODEL_BASIC`, `JWT_SECRET`, `CLIENT_APP_VERSION`, `CLIENT_APP_FILE`, `ADMIN_APP_VERSION`, `ADMIN_APP_FILE` 등. 내용 노출 금지
- `.env.example`: 예시 환경변수
- `data/licenses.json`: 라이선스 DB. 커밋/공유 금지
- `data/mobile-state.json`: 고객 앱이 push한 모바일 표시 상태
- `data/mobile-commands.json`: 모바일/서버에서 생성한 명령 큐
- `downloads/`: 업데이트 exe 배포 위치. `/downloads/<file>`로 제공
- `deploy/chungdam-license-server.service`: systemd 서비스 파일
- `deploy/healthcheck.sh`: 헬스체크 스크립트
- `scripts/`: 운영 보조 스크립트
- `DEPLOY.md`, `AWS_SERVER_SETUP_PROMPT.md`: Lightsail 배포 문서

### `server.js` 핵심 상수

- `PORT`: 기본 `4300`
- `HOST`: 기본 `0.0.0.0`
- `PUBLIC_BASE_URL`: 기본 `http://43.202.181.184:4300`
- `UPDATE_MANIFEST.client.version`: 기본 `1.0.34`
- `UPDATE_MANIFEST.client.fileName`: 기본 `Cheongdam Bot Setup 1.0.34.exe`
- `UPDATE_MANIFEST.admin.version`: 기본 `1.0.9`
- `UPDATE_MANIFEST.admin.fileName`: 기본 `Cheongdam License Admin Setup 1.0.9.exe`
- `JWT_SECRET`: 필수. 없으면 서버가 `process.exit(1)`로 시작 실패
- `ADMIN_SECRET`: 관리자 API 인증 헤더 `x-admin-secret` 값
- `OPENAI_MODEL_ADVANCED`: 기본 `gpt-4.1`
- `OPENAI_MODEL_BASIC`: 기본 `gpt-4.1-mini`

### 서버 API 목록

일반/다운로드:

- `GET /health`: `{ ok: true, status: "healthy" }`
- `GET /downloads/<file>` 또는 `HEAD /downloads/<file>`: 설치 파일 다운로드
- `GET /api/updates/client/latest`: 고객 앱 업데이트 매니페스트
- `GET /api/updates/admin/latest`: 관리자 앱 업데이트 매니페스트
- `GET /mobile` 또는 `/mobile/`: `05_mobile_mockup/mobile-dashboard-mockup.html` 제공

관리자 API (`x-admin-secret` 필요):

- `GET /api/admin/licenses`: 라이선스 목록
- `POST /api/admin/licenses`: 라이선스 발급
- `POST /api/admin/licenses/toggle`: 활성/비활성 전환
- `POST /api/admin/licenses/extend`: 만료일 연장
- `POST /api/admin/licenses/delete`: 라이선스 삭제

고객 라이선스/GPT API:

- `POST /api/license/verify`: 라이선스 키, deviceFingerprint 검증 및 최초 기기 바인딩
- `POST /api/gpt/reply`: 리뷰 답글 생성
- `POST /api/gpt/review-care-apology`: 리뷰케어 사과문 생성
- `POST /api/gpt/finance-classify`: 거래 카테고리 분류
- `POST /api/gpt/store-click-analysis`: 가게클릭 분석
- `POST /api/gpt/threads-drafts`: 스레드 초안 생성

모바일 API:

- `POST /api/mobile/auth/login`: 라이선스 키 + deviceFingerprint로 JWT 발급, 3600초 만료, IP당 분당 10회 제한
- `POST /api/mobile/state/update`: 고객 앱이 현재 상태를 서버에 저장
- `GET/POST /api/mobile/state/get`: Bearer JWT로 상태 조회
- `POST /api/mobile/commands/create`: Bearer JWT로 명령 생성
- `POST /api/mobile/commands/push`: 기존 body 인증 방식으로 스레드 긴급중지 toggle push
- `POST /api/mobile/commands/pull`: 고객 앱이 pending 명령을 가져가고 consumed 처리

### 라이선스 데이터 구조

서버가 만드는 라이선스 주요 필드:

- `licenseKey`
- `customerName`
- `issuedAt`
- `expiresAt`
- `isEnabled`
- `deviceFingerprint`
- `features`
- `licenseHash`
- `lastVerifiedAt`
- `lastAppVersion`
- `lastPlatform`
- `lastIntegrity`

`licenseHash`는 라이선스 핵심 필드와 기능 권한, deviceFingerprint를 sha256으로 해시해 위변조를 감지한다. 과거 해시 방식도 일부 허용한다.

기능 권한 예:

- `baeminReply`, `baeminReplyBasic`, `baeminReplyPremium`
- `baeminBlind`
- `coupangReply`, `coupangReplyBasic`, `coupangReplyPremium`
- `coupangBlind`
- `naverMail`
- `financeAnalysis`
- `threadsMarketing`

### 운영 스크립트

- `repair-license-hashes.js`: `licenses.json`의 누락/불일치 `licenseHash` 재계산
- `clear-license-device-fp.js`: 특정 라이선스의 기기 바인딩 초기화
- `sync-client-installer.js`: 고객 앱 NSIS exe를 서버 `downloads`로 복사하고 `.env`의 `CLIENT_APP_VERSION`, `CLIENT_APP_FILE` 갱신
- `vps-set-client-app-version.sh`: VPS에서 고객 앱 버전 환경변수 변경
- `verify-admin-api-on-vps.sh`: VPS 관리자 API 확인
- `curl-verify-one-license.sh`: 로컬 라이선스 검증 curl
- `inspect-license-on-vps.py`: VPS 라이선스 확인 보조
- `sync-admin-secret-from-legacy.sh`: 과거 경로에서 관리자 시크릿 동기화

### 배포 주의

`DEPLOY.md` 기준으로 AWS Lightsail Ubuntu, Node.js 20, systemd 서비스 `/opt/chungdam-license-server`, 포트 `4300/tcp` 오픈이 전제다. `.env` 권한은 `chmod 600` 권장. OpenAI API 키는 고객 PC가 아니라 서버 `.env`에만 있어야 한다.

## 5. 관리자 앱 `04_license_admin`

### 목적

관리자가 라이선스 서버에 접속해 고객별 라이선스를 발급/관리하는 Electron 앱이다. 제품명 `Cheongdam License Admin`, 현재 버전 `1.0.9`.

### 주요 파일

- `app/main.js`: 관리자 앱 메인 프로세스, 서버 설정 저장, 관리자 API 호출, 자동 업데이트
- `app/preload.js`: `window.adminApi` IPC API 노출
- `app/index.html`: 관리자 UI, 라이선스 발급/목록/검색/토글/연장/삭제
- `issue-license.js`: 서버 API가 아니라 로컬 `03_license_server/data/licenses.json`에 직접 라이선스를 추가하는 구형 CLI 도구. 현재 서버의 `licenseHash` 방식과 완전히 맞는지 확인 필요
- `.env`: 관리자 앱 기본 서버/관리자 시크릿 로딩용. 내용 노출 금지
- `dist`, `dist109`: 빌드 산출물

### `app/main.js` 기능

- `03_license_server/.env` 또는 `04_license_admin/.env`에서 환경변수 로딩
- 기본 서버 주소: `http://43.202.181.184:4300`
- 과거 IP `43.201.84.136`, `43.203.124.132`를 현재 IP로 마이그레이션
- 관리자 설정 저장 위치: Electron userData의 `admin-config.json`
- `x-admin-secret` 헤더로 서버 관리자 API 호출
- `/api/updates/admin/latest` 자동 업데이트 확인
- sha256 검증 후 관리자 앱 설치 파일 실행

### `app/preload.js`

Renderer에 `window.adminApi`를 노출한다.

노출 API:

- `loadAdminConfig`
- `saveAdminConfig`
- `checkAdminServer`
- `createLicense`
- `getLicenses`
- `toggleLicenseEnabled`
- `extendLicenseDays`
- `deleteLicense`
- `checkUpdate`
- `onUpdateStatus`
- `copyText`

## 6. 모바일 UI `05_mobile_mockup`

### 목적

모바일에서 고객 앱 상태 확인 및 스레드 긴급중지/기능 토글 같은 원격 제어를 테스트/제공하는 화면이다.

### 파일

- `mobile-dashboard-mockup.html`: 서버가 `/mobile`로 제공하는 실제 연동 페이지
- `preview-mobile.html`: 로컬 미리보기
- `run.cmd`: 실행 보조
- `test-offline-playground/index.html`: 서버 없이 mock 응답으로 모바일 흐름 테스트
- `test-offline-playground/README.txt`: mock 응답 형태 설명

서버 연동 응답 형태:

- 로그인: `{ ok, token, expiresIn }`
- 상태: `{ ok, state }`
- 명령: `{ ok, id, threadsEmergencyStop }`
- 오류: `{ ok: false, error }`

## 7. 데이터/배포/문제 재현 폴더

### `downloads/`

루트 `downloads`에는 `Cheongdam Bot Setup 1.0.32.exe`, `Cheongdam Bot Setup 1.0.33.exe`가 있다. 서버가 실제로 배포하는 다운로드 위치는 `03_license_server/downloads`이므로 혼동 주의.

### `패치파일_EXE_여기/`

고객 전달용 exe/zip 모음이다. `1.0.25`까지 큰 zip/exe가 있으며 GitHub 커밋 대상이 아니다. README는 최신 상태와 맞지 않을 수 있다.

### `.deploy-update/`

과거 배포 묶음이다. `1.0.8`~`1.0.15` 고객 앱 exe와 서버 tar.gz가 있다. 소스 패치 대상이 아니라 참고/백업 성격이다.

### `문제사진_여기에넣기/`

쿠팡 블라인드 과정 이미지가 다수 있다. 문제 분석 시 이미지의 화면 문구/버튼명과 다음 파일을 매칭해서 본다.

- 쿠팡 블라인드: `02_client_app/baemin-review-bot/platforms/coupangAnswered.js`
- 쿠팡 답글: `02_client_app/baemin-review-bot/platforms/coupangEats.js`
- 네이버 신분증 업로드: `02_client_app/baemin-review-bot/platforms/naverMail.js`
- 배민 블라인드: `02_client_app/baemin-review-bot/platforms/baeminAnswered.js`
- GPT/라이선스: `02_client_app/baemin-review-bot/gptClient.js`, `03_license_server/server.js`

### `new/`

거래내역 샘플과 문제 화면 자료가 있다. 재무 분석(`utils/financeAnalyzer.js`)과 네이버/쿠팡 문제 분석에 참고 가능하다.

## 8. 패치 시 가장 중요한 체크리스트

1. 서버 주소 정합성
   - 고객 앱: `02_client_app/baemin-review-bot/app/config.js`
   - 고객 앱 보안: `02_client_app/baemin-review-bot/app/security.js`
   - GPT 클라이언트: `02_client_app/baemin-review-bot/gptClient.js`
   - 관리자 앱: `04_license_admin/app/main.js`
   - 서버 매니페스트: `03_license_server/server.js`의 `PUBLIC_BASE_URL`
   - 서버 `.env`: `PUBLIC_BASE_URL`, `CLIENT_APP_VERSION`, `CLIENT_APP_FILE`, `ADMIN_APP_VERSION`, `ADMIN_APP_FILE`

2. 버전/업데이트 정합성
   - 고객 앱 `package.json` 버전과 서버 `CLIENT_APP_VERSION`, `CLIENT_APP_FILE`, `03_license_server/downloads` 파일명, `/api/updates/client/latest` 응답이 같은 릴리스를 가리켜야 한다.
   - 관리자 앱도 `package.json` 버전, `ADMIN_APP_VERSION`, `ADMIN_APP_FILE`, 다운로드 파일이 맞아야 한다.
   - sha256은 서버가 `downloads` 파일에서 계산하므로 파일이 없으면 `installerReady: false`가 된다.

3. 라이선스 기능 권한
   - UI에서 기능을 켜도 서버 라이선스 `features`에 해당 권한이 없으면 실행/GPT 호출이 막힌다.
   - 답글은 기본/프리미엄 권한이 분리되어 있다: `baeminReplyBasic/Premium`, `coupangReplyBasic/Premium`.
   - `financeAnalysis`, `threadsMarketing`도 별도 권한이다.

4. 기기 바인딩
   - 최초 검증 시 `deviceFingerprint`가 비어 있으면 서버가 해당 기기로 바인딩한다.
   - 다른 PC에서 쓰려면 `clear-license-device-fp.js` 또는 관리자 기능으로 바인딩 초기화가 필요하다.
   - 바인딩 후 `licenseHash` 재계산이 필요하다.

5. 모바일 원격 제어
   - 서버 시작에는 `JWT_SECRET`이 필수다.
   - 모바일 웹은 Bearer JWT 기반 API와 기존 body 인증 기반 API가 혼재되어 있다.
   - 고객 앱은 `state/update`와 `commands/pull`을 통해 서버와 동기화한다.

6. 빌드 산출물
   - `dist*`, `node_modules`, exe, blockmap, tar.gz는 일반 소스 패치 대상이 아니다.
   - 배포가 목표일 때만 빌드 후 `03_license_server/downloads`와 배포 폴더에 산출물을 반영한다.

7. 인코딩
   - 일부 파일이 콘솔에서 깨져 보인다. 실제 소스는 한국어 문자열이 들어 있고, PowerShell 출력 인코딩 문제일 가능성이 있다. 대량 문자열 수정 시 인코딩을 깨지 않도록 주의.

## 9. Claude/Cursor에게 바로 전달할 작업 지시 예시

이 저장소는 고객용 Electron 앱(`02_client_app/baemin-review-bot`), Node 라이선스/GPT 서버(`03_license_server`), 관리자 Electron 앱(`04_license_admin`), 모바일 제어 UI(`05_mobile_mockup`)가 연결된 구조다. 패치할 때는 고객 앱 UI/자동화 코드만 보지 말고 서버 API, 라이선스 feature 권한, 업데이트 매니페스트, 관리자 앱 호출 흐름을 같이 확인해야 한다.

기능 오류가 배민/쿠팡/네이버 자동화라면 `platforms/*.js`를 먼저 본다. GPT 답글/재무/스레드 문제라면 고객 앱 `gptClient.js`, `utils/*`, 서버 `server.js`의 `/api/gpt/*`를 같이 본다. 라이선스 문제라면 고객 앱 `app/main.js`의 `verifyLicenseWithServer`, 서버 `handleLicenseVerify`, `validateLicenseForUse`, `validateLicenseFeature`, `data/licenses.json` 구조를 본다. 업데이트 문제라면 고객 앱/관리자 앱의 update 로직, 서버 `UPDATE_MANIFEST`, `downloads` 파일 존재와 sha256, `.env`의 version/file 변수를 같이 본다.

민감 파일은 열람/출력/커밋 금지: `.env`, `*.pem`, `ssh.txt`, `licenses.json`.
