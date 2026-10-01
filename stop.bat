@echo off
setlocal
cd /d "%~dp0"
set PORT=8787
for /f "delims=" %%i in ('node scripts\get-config-port.mjs 2^>nul') do set PORT=%%i

set FOUND=
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%PORT% " ^| findstr "LISTENING"') do (
  set FOUND=%%p
  taskkill /f /pid %%p >nul 2>nul && echo [OK] mdlive pid %%p stopped.
)
if not defined FOUND (
  echo [INFO] mdlive is not running on port %PORT%.
)
ping -n 3 127.0.0.1 >nul
exit /b 0
