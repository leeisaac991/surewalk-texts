@echo off
rem SURE Walk — Texting Laptop
rem Starts the texting server and iPhone Bluetooth bridge, then opens the dashboard.
rem Installs nothing and needs no admin. Everything it keeps is under %LOCALAPPDATA%.
setlocal EnableExtensions
title SURE Walk — Texting Laptop
set "HERE=%~dp0"
set "APP=%HERE%app"
set "DATA=%LOCALAPPDATA%\surewalk-texts"
set "URL=http://127.0.0.1:8787/"
if not exist "%DATA%" mkdir "%DATA%"

echo.
echo ======================================================================
echo                     SURE WALK - TEXTING LAPTOP
echo ======================================================================
echo   Role: Designated laptop for automated texting and phone bridge.
echo   Keep this laptop plugged in, awake, and near the SURE Walk iPhone.
echo ======================================================================
echo.

rem Files from a downloaded zip are marked "from the internet"; this laptop's PowerShell policy then stops to ask
rem before each script. Clear the mark on this folder's own files.
powershell.exe -NoProfile -NonInteractive -Command "Get-ChildItem -LiteralPath '%HERE%.' -Recurse -File | Unblock-File" >nul 2>&1

rem Portable Node (shipped as the official zip; unpacked once with Windows' built-in tar)
set "NODE="
for %%z in ("%HERE%node-v*-win-x64.zip") do (
  if not exist "%DATA%\%%~nz\node.exe" (echo [1/3] Unpacking Node.js runtime, one time only ... & tar -xf "%%z" -C "%DATA%")
  if exist "%DATA%\%%~nz\node.exe" set "NODE=%DATA%\%%~nz\node.exe"
)
if not defined NODE (echo [ERROR] Could not find or unpack Node.js next to this file. & pause & exit /b 1)
set "SUREWALK_GS=%APP%\apps-script"
set "SERVER=%APP%\texts-panel\server\server.mjs"

echo [1/3] Node.js runtime ready.

curl -s -o nul -m 2 "%URL%"
if errorlevel 1 (
  echo [2/3] Starting texting server on port 8787 ...
  "%NODE%" "%SERVER%" link-bridge >nul
  start "SURE Walk texting server" /min "%NODE%" "%SERVER%"
  echo       Texting server started.
) else (
  echo [2/3] Texting server is already running on http://127.0.0.1:8787.
)

rem The bridge exits by itself if one is already running.
echo [3/3] Starting iPhone Bluetooth bridge (Phone Link) ...
start "SURE Walk phone bridge" /min powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%APP%\windows\bridge.ps1"
echo       Phone bridge started.

rem Newer release on GitHub? Asked in a popup by a separate process, so this file can be replaced safely.
start "" /min powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%APP%\windows\update.ps1" -Check

echo.
echo ======================================================================
echo   Opening dashboard at %URL% ...
echo ======================================================================
echo.

if /i "%~1"=="nobrowser" (
  echo Dashboard launch skipped (nobrowser flag).
  exit /b 0
)

for /l %%i in (1,1,30) do (
  curl -s -o nul -m 1 "%URL%" && goto :open
  timeout /t 1 /nobreak >nul
)
echo [WARNING] The texting server did not answer - see %DATA%\server.log
pause
exit /b 1

:open
start "" "%URL%"
echo Done! Texting server is active.
exit /b 0
