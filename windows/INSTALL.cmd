@echo off
rem Installs SURE Walk Texts for you only (no admin): %LOCALAPPDATA%\Programs\SURE Walk Texts + Start menu shortcuts.
setlocal
set "HERE=%~dp0"
powershell.exe -NoProfile -NonInteractive -Command "Get-ChildItem -LiteralPath '%HERE%.' -Recurse -File | Unblock-File" >nul 2>&1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%HERE%app\windows\install.ps1"
pause
