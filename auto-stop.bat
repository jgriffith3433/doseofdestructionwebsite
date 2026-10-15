@echo off
cd /d "%~dp0"

echo ==================================================
echo Stop local development server
echo ==================================================

rem Tells auto-start.bat's window not to start it again.
if not exist ".cache" mkdir ".cache"
echo stop> ".cache\stop-dev-server"

powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = Get-NetTCPConnection -LocalPort 8089 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique; if ($p) { foreach ($id in $p) { Write-Host \"Stopping dev server on port 8089 (PID $id)\"; Stop-Process -Id $id -Force -ErrorAction SilentlyContinue } } else { Write-Host \"No dev server found on port 8089\" }"

echo Done. GPU servers stop themselves once idle; queued jobs wait until the dev server runs again.
pause
