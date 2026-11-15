@echo off
setlocal
cd /d "%~dp0"
if not exist package.json (
  echo package.json not found.
  pause
  exit /b 1
)
call npm start
pause
