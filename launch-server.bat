@echo off
setlocal
cd /d "%~dp0"
echo Starting local server from:
echo %cd%
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1" -Port 8000
echo.
echo Server stopped or failed to start.
pause
