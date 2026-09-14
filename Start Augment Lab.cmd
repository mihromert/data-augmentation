@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required to run Augment Lab.
  echo Install Node.js 22 or newer, then run this file again.
  pause
  exit /b 1
)

if not exist "node_modules\.bin\vinext.cmd" (
  echo Preparing Augment Lab for first use...
  call npm install --ignore-scripts --no-audit --no-fund
  if errorlevel 1 (
    echo Setup did not complete. Check your internet connection and try again.
    pause
    exit /b 1
  )
)

echo Starting Augment Lab...
start "Augment Lab server - close to stop" /min cmd /c "npm run dev"
timeout /t 4 /nobreak >nul
start "" "http://localhost:3000"
exit /b 0
