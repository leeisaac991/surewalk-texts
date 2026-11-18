@echo off
rem Has the iPhone dial a number you type - a real call, e.g. to your own phone - to check calling from this laptop.
rem The call happens on the iPhone: answer or hang up there.
setlocal
set "HERE=%~dp0"
powershell.exe -NoProfile -NonInteractive -Command "Get-ChildItem -LiteralPath '%HERE%.' -Recurse -File | Unblock-File" >nul 2>&1
echo This makes the iPhone dial the number you type. The call stays on the iPhone.
set "NUM="
set /p "NUM=Number to call (e.g. your own phone): "
if not defined NUM exit /b 0
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%HERE%app\windows\bridge.ps1" -DialOnce "%NUM%"
pause
