@echo off
setlocal

set "BASE=%~dp0"
set "HTML=%BASE%mobile-dashboard-mockup.html"

if not exist "%HTML%" (
  echo [ERROR] mobile-dashboard-mockup.html not found.
  pause
  exit /b 1
)

start "" "%HTML%"
echo Opened: %HTML%
exit /b 0
