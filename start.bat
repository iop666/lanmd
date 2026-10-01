@echo off
setlocal
title mdlive
cd /d "%~dp0"

rem ---- 1. Check Node.js ----
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install Node.js 20 or later: https://nodejs.org/
  echo.
  pause
  exit /b 1
)

rem ---- 2. First run: install dependencies ----
if exist "node_modules" goto build_check
echo [SETUP] First run - installing dependencies, takes 1-2 minutes...
call npm install --no-fund --no-audit
if errorlevel 1 goto fail

:build_check
rem ---- 3. Build if dist output is missing ----
if exist "server\dist\index.js" if exist "web\dist\index.html" goto start_server
echo [BUILD] Compiling, about half a minute...
call npm run build
if errorlevel 1 goto fail

:start_server
set PORT=8787
for /f "delims=" %%i in ('node scripts\get-config-port.mjs 2^>nul') do set PORT=%%i

rem ---- 4. Skip if already running ----
curl -s -o nul -m 2 http://localhost:%PORT%/api/health
if not errorlevel 1 (
  echo [INFO] mdlive is already running at http://localhost:%PORT%
  if not defined MDLIVE_NO_BROWSER start "" http://localhost:%PORT%
  exit /b 0
)

rem ---- 5. Start server in a minimized background window, then exit this one ----
echo [START] Starting mdlive on port %PORT% ...
start "mdlive-server" /min cmd /c "node server\dist\index.js"

rem ---- 6. Wait until healthy (max ~20s). ping used as a portable sleep ----
set /a tries=0
:wait_loop
ping -n 2 127.0.0.1 >nul
curl -s -o nul -m 2 http://localhost:%PORT%/api/health
if not errorlevel 1 goto healthy
set /a tries+=1
if %tries% lss 20 goto wait_loop
echo [WARN] Server not responding yet. Check the minimized "mdlive-server" window for errors.
pause
exit /b 1

:healthy
echo [OK] mdlive is running: http://localhost:%PORT%
echo      Phone: open the LAN address shown in the server window.
echo      To stop: close the minimized "mdlive-server" window, or run stop.bat
if not defined MDLIVE_NO_BROWSER start "" http://localhost:%PORT%
ping -n 3 127.0.0.1 >nul
exit /b 0

:fail
echo.
echo [ERROR] Install/build failed. Check the messages above (often a network issue with npm install).
pause
exit /b 1
