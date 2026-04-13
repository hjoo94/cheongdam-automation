; 설치/제거 전 실행 중인 본 앱을 트리 단위로 강제 종료합니다.
; (_CHECK_APP_RUNNING 을 호출하지 않음 — GetProcessInfo 포함 순서 문제로 언인스톨러 빌드가 실패할 수 있음)

!macro customCheckAppRunning
try_kill_again:
  DetailPrint "Cheongdam Bot 실행 종료(강제) 시도..."
  nsExec::Exec `%SYSTEMROOT%\System32\cmd.exe /c taskkill /F /IM "${APP_EXECUTABLE_FILENAME}" /T`
  Pop $R9
  Sleep 2500
  !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
  IntCmp $R0 0 still_open not_running not_running
still_open:
  MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" IDRETRY try_kill_again IDCANCEL 0
  Quit
not_running:
!macroend
