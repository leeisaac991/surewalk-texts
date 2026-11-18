@echo off
rem Tests the phone bridge on this laptop against a pretend iPhone and a throwaway texting server.
rem Touches nothing real: no phone, no GroupMe, its own temporary files. Safe while texting is running.
setlocal EnableExtensions
set "HERE=%~dp0"
set "DATA=%LOCALAPPDATA%\surewalk-texts"
if not exist "%DATA%" mkdir "%DATA%"
powershell.exe -NoProfile -NonInteractive -Command "Get-ChildItem -LiteralPath '%HERE%.' -Recurse -File | Unblock-File" >nul 2>&1
set "NODE="
for %%z in ("%HERE%node-v*-win-x64.zip") do (
  if not exist "%DATA%\%%~nz\node.exe" (echo Unpacking Node.js ... & tar -xf "%%z" -C "%DATA%")
  if exist "%DATA%\%%~nz\node.exe" set "NODE=%DATA%\%%~nz\node.exe"
)
if not defined NODE (echo Could not find or unpack Node.js. & pause & exit /b 1)
set "SUREWALK_GS=%HERE%app\apps-script"
"%NODE%" "%HERE%app\windows\test\bridge-test.mjs" > "%HERE%bridge-test-log.txt" 2>&1
type "%HERE%bridge-test-log.txt"
echo.
echo Saved to %HERE%bridge-test-log.txt
pause
