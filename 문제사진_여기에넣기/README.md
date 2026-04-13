# 문제 사진 넣는 곳

앞으로 자동화 중 문제가 생기면 이 폴더에 사진을 넣어주세요.

폴더 경로:

```text
C:\Users\DESKTOP\Desktop\코덱스\문제사진_여기에넣기
```

사진을 넣은 뒤 채팅에 이렇게만 말해주면 됩니다.

```text
문제사진_여기에넣기 폴더 확인해서 패치해줘
```

## 권장 파일명

가능하면 아래처럼 저장해주세요. 꼭 지키지 않아도 됩니다.

```text
쿠팡답글_문제내용.jpg
쿠팡블라인드_다음페이지안됨.jpg
쿠팡블라인드_해피톡멈춤.jpg
네이버메일_신분증업로드안됨.jpg
네이버메일_닉네임매칭안됨.jpg
배민블라인드_접수안됨.jpg
```

## 같이 알려주면 좋은 내용

사진만 있어도 확인하지만, 아래 중 하나라도 같이 알려주면 더 빨리 찾을 수 있습니다.

- 어떤 기능인지: 쿠팡 답글, 쿠팡 블라인드, 네이버 메일, 배민 블라인드
- 화면에서 멈춘 버튼 이름
- 로그 마지막 3~5줄
- 기대한 동작
- 실제 동작

## 내가 확인할 기준

사진을 받으면 다음 순서로 확인합니다.

1. 사진 속 화면 문구와 버튼명을 확인합니다.
2. 관련 자동화 파일을 검색합니다.
   - 쿠팡 답글: `02_client_app\baemin-review-bot\platforms\coupangEats.js`
   - 쿠팡 블라인드: `02_client_app\baemin-review-bot\platforms\coupangAnswered.js`
   - 네이버 메일: `02_client_app\baemin-review-bot\platforms\naverMail.js`
   - GPT 답글/라이센스: `02_client_app\baemin-review-bot\gptClient.js`, `03_license_server\server.js`
3. 해당 화면 단계의 selector, 버튼 클릭, 입력, 대기시간, 페이지 이동 로직을 패치합니다.
4. 문법 검사와 빌드까지 확인합니다.

