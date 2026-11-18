@echo off
rem Checks GitHub for a newer release of SURE Walk Texts and installs it (your settings and message log are kept).
setlocal
set "HERE=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%HERE%app\windows\update.ps1"
pause
