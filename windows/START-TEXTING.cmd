@echo off
rem SURE Walk Texts on Windows: starts the texting server and the iPhone bridge, then opens the dashboard.
rem Installs nothing and needs no admin. Everything it keeps is under %LOCALAPPDATA%.
rem   START-TEXTING.cmd nobrowser     start without opening the dashboard (used at login)
setlocal EnableExtensions
title SURE Walk Texts
set "HERE=%~dp0"
set "APP=%HERE%app"
set "DATA=%LOCALAPPDATA%\surewalk-texts"
set "URL=http://127.0.0.1:8787/"
if not exist "%DATA%" mkdir "%DATA%"

rem Files from a downloaded zip are marked "from the internet"; this laptop's PowerShell policy then stops to ask
rem before each script. Clear the mark on this folder's own files.
powershell.exe -NoProfile -NonInteractive -Command "Get-ChildItem -LiteralPath '%HERE%.' -Recurse -File | Unblock-File" >nul 2>&1

rem Portable Node (shipped as the official zip; unpacked once with Windows' built-in tar)
set "NODE="
for %%z in ("%HERE%node-v*-win-x64.zip") do (
  if not exist "%DATA%\%%~nz\node.exe" (echo Unpacking Node.js, one time only ... & tar -xf "%%z" -C "%DATA%")
  if exist "%DATA%\%%~nz\node.exe" set "NODE=%DATA%\%%~nz\node.exe"
)
if not defined NODE (echo Could not find or unpack Node.js next to this file. & pause & exit /b 1)
set "SUREWALK_GS=%APP%\apps-script"
set "SERVER=%APP%\texts-panel\server\server.mjs"

curl -s -o nul -m 2 "%URL%"
if errorlevel 1 (
  "%NODE%" "%SERVER%" link-bridge >nul
  start "SURE Walk texting server" /min "%NODE%" "%SERVER%"
  echo Texting server started.
) else (
  echo The texting server is already running.
)
rem The bridge exits by itself if one is already running.
start "SURE Walk phone bridge" /min powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%APP%\windows\bridge.ps1"
echo Phone bridge started.

if /i "%~1"=="nobrowser" exit /b 0
for /l %%i in (1,1,30) do (
  curl -s -o nul -m 1 "%URL%" && goto :open
  timeout /t 1 /nobreak >nul
)
echo The texting server did not answer - see %DATA%\server.log
pause
exit /b 1
:open
start "" "%URL%"
exit /b 0
