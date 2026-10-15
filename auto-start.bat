@echo off
cd /d "%~dp0"
title Dose of Destruction dev server

rem The dev server also runs the GPU job queue (tools/gpu/jobs.mjs): keep this
rem window open while jobs run. Close it (or run auto-stop.bat) to stop.

rem Already running? Just open the pages: a second server would run a second
rem job queue over the same .cache\gpu\jobs.json.
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 8089 -State Listen -ErrorAction SilentlyContinue) { exit 1 }"
if errorlevel 1 (
  echo The dev server is already running on http://localhost:8089
  start "" "http://localhost:8089/devtools.html"
  timeout /t 3 >nul
  exit /b 0
)

rem auto-stop.bat leaves this so the restart loop below knows to stop too.
if exist ".cache\stop-dev-server" del ".cache\stop-dev-server"

echo Starting local dev server (npm run dev)...
echo Dose of Destruction site: http://localhost:8089
echo Game page:                http://localhost:8089/Game/
echo Dev tools:                http://localhost:8089/devtools.html
echo.
echo Keep this window open: GPU jobs run inside the dev server.
start "" "http://localhost:8089/devtools.html"

:run
call npm run dev -- --host 0.0.0.0 --port 8089 --strictPort
if exist ".cache\stop-dev-server" (
  del ".cache\stop-dev-server"
  echo Stopped by auto-stop.bat.
  timeout /t 3 >nul
  exit /b 0
)
rem If it stops by itself (a crash, a failed restart), start it again; queued GPU jobs resume.
echo.
echo The dev server stopped (%date% %time%). Restarting in 5 seconds; close this window to stop for good.
timeout /t 5
goto run
