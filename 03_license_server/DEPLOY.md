# Chungdam License Server AWS Lightsail Deployment

이 문서는 고객 PC 배포 전에 AWS Lightsail Ubuntu 서버에 라이센스/GPT 중계 서버를 설치하는 최종 절차입니다.

## 1. Lightsail 인스턴스 준비

- OS: Ubuntu 22.04 LTS 또는 24.04 LTS
- 권장 사양: 최소 1GB RAM, 운영 고객이 늘어나면 2GB 이상
- 네트워킹 방화벽: `TCP 22`, `TCP 4300` 허용
- 고정 IP: Lightsail Static IP를 생성해서 인스턴스에 연결

고객 PC 프로그램의 서버 주소는 아래 형식입니다.

```text
http://서버고정IP:4300
```

## 2. 서버 접속

로컬 PC에서 SSH 키가 있을 때:

```bash
ssh ubuntu@서버고정IP
```

Lightsail 브라우저 SSH를 사용할 때는 AWS 콘솔에서 인스턴스의 `Connect using SSH`를 누른 뒤 아래 명령부터 실행합니다.

## 3. Node.js 설치

```bash
sudo apt update
sudo apt install -y curl ca-certificates gnupg
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

## 4. 서버 코드 업로드

로컬의 `03_license_server` 폴더 전체를 서버의 `/opt/chungdam-license-server`로 업로드합니다.

SSH 키가 있는 로컬 PC에서 예시:

```bash
scp -r 03_license_server ubuntu@서버고정IP:/tmp/chungdam-license-server
ssh ubuntu@서버고정IP
sudo rm -rf /opt/chungdam-license-server
sudo mv /tmp/chungdam-license-server /opt/chungdam-license-server
sudo chown -R ubuntu:ubuntu /opt/chungdam-license-server
```

Lightsail 브라우저 SSH만 사용할 때는 파일 업로드 기능으로 압축 파일을 올린 뒤 `/opt/chungdam-license-server`에 압축 해제합니다.

## 5. 환경 변수 설정

```bash
cd /opt/chungdam-license-server
cp .env.example .env
nano .env
```

`.env` 권장값:

```env
HOST=0.0.0.0
PORT=4300
ADMIN_SECRET=강한_관리자_비밀번호_문자열
OPENAI_API_KEY=실제_OpenAI_API_Key
OPENAI_MODEL_ADVANCED=gpt-4.1
OPENAI_MODEL_BASIC=gpt-4.1-mini
```

권한 보호:

```bash
chmod 600 /opt/chungdam-license-server/.env
```

## 6. 라이센스 데이터 초기화

```bash
mkdir -p /opt/chungdam-license-server/data
test -f /opt/chungdam-license-server/data/licenses.json || printf '[]' > /opt/chungdam-license-server/data/licenses.json
```

## 7. 의존성 설치

```bash
cd /opt/chungdam-license-server
npm install --omit=dev
```

## 8. systemd 자동 실행 등록

```bash
sudo cp /opt/chungdam-license-server/deploy/chungdam-license-server.service /etc/systemd/system/chungdam-license-server.service
sudo systemctl daemon-reload
sudo systemctl enable chungdam-license-server
sudo systemctl restart chungdam-license-server
```

`Restart=always`가 적용되어 서버 프로세스가 죽으면 자동 재시작되고, Lightsail 인스턴스가 재부팅되어도 자동 실행됩니다.

## 9. 상태 확인

서버 내부:

```bash
curl http://127.0.0.1:4300/health
sudo systemctl status chungdam-license-server --no-pager
```

외부 PC:

```bash
curl http://서버고정IP:4300/health
```

정상 응답 예:

```json
{"ok":true}
```

## 10. 운영 명령어

```bash
sudo systemctl restart chungdam-license-server
sudo systemctl stop chungdam-license-server
sudo systemctl start chungdam-license-server
sudo journalctl -u chungdam-license-server -n 200 --no-pager
```

## 11. 고객 PC 프로그램 설정

프로그램 설정의 서버 주소에 아래 값을 입력합니다.

```text
http://서버고정IP:4300
```

라이센스 키는 관리자 앱 또는 서버 API로 발급한 키를 고객별로 입력합니다. GPT API 키는 고객 PC에 넣지 않습니다. OpenAI API 키는 서버의 `.env`에만 보관합니다.

## 12. 배포 전 체크리스트

- Lightsail Static IP가 연결되어 있다.
- Lightsail 방화벽에서 `4300/tcp`가 열려 있다.
- `/health`가 외부 PC에서 열린다.
- `.env`에 실제 `OPENAI_API_KEY`가 들어 있다.
- `systemctl status`가 `active (running)`이다.
- 고객 PC 프로그램의 서버 주소가 `http://서버고정IP:4300`이다.
- 라이센스 기능 권한에 `baeminReply`, `baeminBlind`, `coupangReply`, `coupangBlind`, `naverMail` 중 고객에게 판매한 기능만 켜져 있다.
