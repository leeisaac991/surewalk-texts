@echo off
rem Turns "start SURE Walk Texts when I log in" on or off (a small file in your own Startup folder; no admin).
setlocal
set "LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\SURE Walk Texts.cmd"
if exist "%LNK%" (
  del "%LNK%"
  echo Start at login is now OFF.
) else (
  (echo @call "%~dp0START-TEXTING.cmd")>"%LNK%"
  echo Start at login is now ON. Opens the texting dashboard on startup.
)
pause
