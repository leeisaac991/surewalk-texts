@echo off
rem Stops the SURE Walk texting server and phone bridge started by START-TEXTING.cmd (your own programs only).
powershell.exe -NoProfile -NonInteractive -Command "$n = 0; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and ($_.CommandLine -like '*texts-panel\server\server.mjs*' -or $_.CommandLine -like '*\windows\bridge.ps1*') -and $_.CommandLine -notlike '*Get-CimInstance*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $n++ }; if ($n) { 'Stopped the texting server and phone bridge.' } else { 'Nothing was running.' }"
timeout /t 3 >nul
