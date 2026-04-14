청담봇 모바일 UI — 오프라인 체험 폴더 (v1.0.32)
===============================================

이 폴더는 라이선스 서버·실제 API 없이 브라우저만으로
모바일 대시보드 흐름(로그인 → 상태 → 토글)을 연습할 수 있습니다.

열기
----
1. test-offline-playground\index.html 을 Chrome 또는 Edge에서 더블클릭하여 엽니다.
2. 화면 안내에 따라 버튼을 눌러 보세요.

동작
----
• 서버로 fetch 하지 않습니다. (전부 브라우저 안 Mock)
• 응답 JSON 형태는 실제 서버와 동일하게 맞춤:
    { ok, token, expiresIn }
    { ok, state }   — state.status.threadsPolicy.threadsEmergencyStop
    { ok, id, threadsEmergencyStop }

실서버 연동 테스트
------------------
• 03_license_server 실행 후 브라우저에서:
    http://127.0.0.1:4300/mobile/?local=1
  (또는 배포 주소 /mobile/)
