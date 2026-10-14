@echo off
cd /d "%~dp0"
echo Starting local dev server (npm run dev)...
echo Dose of Destruction site: http://localhost:8089
echo Game page:                http://localhost:8089/Game/
start "" "http://localhost:8089/"
call npm run dev -- --host 0.0.0.0 --port 8089
