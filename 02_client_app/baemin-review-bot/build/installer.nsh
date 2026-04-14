; 설치/제거 전 실행 중인 본 앱을 트리 단위로 강제 종료합니다.
; (_CHECK_APP_RUNNING 을 호출하지 않음 — GetProcessInfo 포함 순서 문제로 언인스톨러 빌드가 실패할 수 있음)
; 자동 업데이트 시 메인 프로세스가 아직 내려가는 중이면 FIND_PROCESS 가 살아 있다고 판단하므로,
; taskkill + 대기 루프를 여러 번 돌린 뒤에만 사용자에게 Retry 를 냅니다.

!macro customCheckAppRunning
try_kill_again:
  StrCpy $R8 0
inner_kill:
  IntOp $R8 $R8 + 1
  DetailPrint "Cheongdam Bot 실행 종료(강제) 시도 ($R8/6)..."
  nsExec::Exec `%SYSTEMROOT%\System32\cmd.exe /c taskkill /F /IM "${APP_EXECUTABLE_FILENAME}" /T`
  Pop $R9
  Sleep 4000
  !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
  IntCmp $R0 0 proc_still_alive exit_kill_macro exit_kill_macro
proc_still_alive:
  IntCmp $R8 6 ask_user inner_kill inner_kill
ask_user:
  MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" IDRETRY try_kill_again IDCANCEL 0
  Quit
exit_kill_macro:
!macroend
