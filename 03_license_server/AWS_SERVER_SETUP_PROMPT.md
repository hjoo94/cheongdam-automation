# AWS Lightsail 서버 구축 요청 프롬프트

아래 내용을 다른 ChatGPT 또는 서버 작업자에게 그대로 전달하면 됩니다.

```text
나는 Windows Electron 기반 고객용 프로그램을 배포하려고 한다. 프로그램은 고객 PC에서 라이센스 인증과 GPT API 호출을 직접 처리하지 않고, AWS Lightsail Ubuntu 서버의 Node.js 라이센스/GPT 중계 서버에 연결한다.

목표:
1. AWS Lightsail Ubuntu 22.04 또는 24.04 인스턴스에 Node.js 20을 설치한다.
2. 서버 코드는 /opt/chungdam-license-server 에 배포한다.
3. 서버는 Node.js server.js 로 실행한다.
4. 포트는 4300, HOST는 0.0.0.0 이다.
5. Lightsail 방화벽에서 TCP 4300을 외부 고객 PC에서 접근 가능하게 연다.
6. OpenAI API Key는 고객 PC가 아니라 서버의 .env 파일에만 저장한다.
7. systemd 서비스로 등록해서 서버 프로세스가 죽으면 자동 재시작되고, 인스턴스가 재부팅되어도 자동 실행되게 한다.
8. /health 엔드포인트가 외부에서 정상 응답하는지 확인한다.
9. 고객 PC 프로그램에는 서버 주소를 http://서버고정IP:4300 형태로 입력한다.

서버 환경 변수:
HOST=0.0.0.0
PORT=4300
ADMIN_SECRET=강한_관리자_비밀번호
OPENAI_API_KEY=실제_OpenAI_API_Key
OPENAI_MODEL_ADVANCED=gpt-4.1
OPENAI_MODEL_BASIC=gpt-4.1-mini

systemd 서비스 조건:
- WorkingDirectory=/opt/chungdam-license-server
- EnvironmentFile=/opt/chungdam-license-server/.env
- ExecStart=/usr/bin/node /opt/chungdam-license-server/server.js
- Restart=always
- RestartSec=5
- User=ubuntu
- WantedBy=multi-user.target

설치 후 반드시 아래를 확인해라:
1. sudo systemctl status chungdam-license-server --no-pager
2. curl http://127.0.0.1:4300/health
3. 외부 PC에서 curl http://서버고정IP:4300/health
4. Lightsail Static IP가 연결되어 있는지
5. Lightsail 방화벽에서 4300/tcp가 열려 있는지

보안 조건:
- .env 권한은 chmod 600으로 제한한다.
- AWS 계정 비밀번호나 OpenAI API Key를 채팅에 노출하지 않는다.
- 고객 PC에는 OpenAI API Key를 저장하지 않는다.
- 고객 PC에는 라이센스 키와 서버 주소만 입력한다.
```
