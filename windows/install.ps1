# SURE Walk Texts for Windows: per-user install, update-in-place and uninstall. No admin.
#   install.ps1                      install (or reinstall) from the package this script is in
#   install.ps1 -Quiet -Dest <dir>   used by update.ps1: replace the code in <dir>, keep everything else, no questions
#   install.ps1 -Uninstall           remove the app, its shortcuts and start-at-login (asks before deleting data)
# The app lives in %LOCALAPPDATA%\Programs\SURE Walk Texts; settings and the message log live in
# %LOCALAPPDATA%\surewalk-texts and %LOCALAPPDATA%\surewalk-bridge, which install and update never touch.
param([switch]$Uninstall, [switch]$Quiet, [string]$Dest = '')
$ErrorActionPreference = 'Stop'
$Name = 'SURE Walk Texts'
if (-not $Dest) { $Dest = Join-Path $env:LOCALAPPDATA "Programs\$Name" }
$From = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path.TrimEnd('\')
$Dest = $Dest.TrimEnd('\')
$Menu = Join-Path ([Environment]::GetFolderPath('Programs')) $Name
$StartupFile = Join-Path ([Environment]::GetFolderPath('Startup')) "$Name.cmd"

function Stop-Texting {
  $n = 0
  Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and ($_.CommandLine -like '*texts-panel\server\server.mjs*' -or $_.CommandLine -like '*\windows\bridge.ps1*') -and $_.CommandLine -notlike '*-DialOnce*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $n++ }
  if ($n) { Start-Sleep -Seconds 2 }
  return $n
}
function Ask([string]$q) { if ($Quiet) { return $false }; return ((Read-Host "$q (y/n)") -match '^\s*y') }

if ($Uninstall) {
  if (-not (Ask "Remove $Name from this computer?")) { 'Nothing removed.'; exit 0 }
  $null = Stop-Texting
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $Menu, $StartupFile
  if (Ask 'Also delete the texting data (settings, GroupMe setup, message log)? This cannot be undone.') {
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $env:LOCALAPPDATA 'surewalk-texts'), (Join-Path $env:LOCALAPPDATA 'surewalk-bridge')
    'Texting data deleted.'
  } else { 'Texting data kept (in %LOCALAPPDATA%\surewalk-texts and surewalk-bridge).' }
  # this script runs from the folder being removed: remove it a moment after we exit
  Start-Process cmd.exe -ArgumentList '/c', "timeout /t 2 /nobreak >nul & rmdir /s /q `"$Dest`"" -WindowStyle Hidden
  "$Name removed."
  exit 0
}

$wasRunning = (Stop-Texting) -gt 0
$atLogin = Test-Path $StartupFile
if ($From -ne $Dest) {
  $null = New-Item -ItemType Directory -Force -Path $Dest
  if (Test-Path (Join-Path $Dest 'app')) { Remove-Item -Recurse -Force (Join-Path $Dest 'app') }
  Get-ChildItem -LiteralPath $Dest -Filter 'node-v*-win-x64.zip' | Where-Object { -not (Test-Path (Join-Path $From $_.Name)) } | Remove-Item -Force
  Get-ChildItem -LiteralPath $From -Force | Where-Object { $_.Name -notin @('bridge-test-log.txt', '.git', '.gitattributes', '.gitignore') } |
    ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $Dest -Recurse -Force }
}
Get-ChildItem -LiteralPath $Dest -Recurse -File | Unblock-File

# Start menu (your own; no admin)
if (Test-Path $Menu) { Remove-Item -Recurse -Force $Menu }
$null = New-Item -ItemType Directory -Force -Path $Menu
$sh = New-Object -ComObject WScript.Shell
function Lnk([string]$title, [string]$target, [string]$arguments, [string]$desc, [int]$style = 1) {
  $l = $sh.CreateShortcut((Join-Path $Menu "$title.lnk"))
  $l.TargetPath = $target; $l.Arguments = $arguments; $l.WorkingDirectory = $Dest; $l.Description = $desc; $l.WindowStyle = $style
  $l.Save()
}
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
Lnk $Name (Join-Path $Dest 'START-TEXTING.cmd') '' 'Start texting and open the dashboard' 7
Lnk "Stop $Name" (Join-Path $Dest 'STOP-TEXTING.cmd') '' 'Stop the texting server and phone bridge' 7
Lnk 'Check for updates' (Join-Path $Dest 'UPDATE.cmd') '' 'Install a newer version from GitHub (keeps your settings)'
Lnk 'Test a call' (Join-Path $Dest 'TEST-CALL.cmd') '' 'Have the iPhone dial a number you type'
Lnk 'Test the phone bridge' (Join-Path $Dest 'TEST-BRIDGE.cmd') '' 'Check the bridge with a pretend phone'
Lnk 'Start at login (on or off)' (Join-Path $Dest 'START-AT-LOGIN.cmd') '' 'Turn starting at login on or off'
Lnk "Uninstall $Name" $ps "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $Dest 'app\windows\install.ps1')`" -Uninstall" "Remove $Name"

if (-not $atLogin -and (Ask 'Start SURE Walk Texts automatically when you log in?')) { $atLogin = $true }
if ($atLogin) { [IO.File]::WriteAllText($StartupFile, "@call `"$(Join-Path $Dest 'START-TEXTING.cmd')`" nobrowser`r`n") }

$ver = ''; try { $ver = (Get-Content -Raw (Join-Path $Dest 'VERSION')).Trim() } catch {}
"$Name $ver installed in $Dest"
'Start menu: SURE Walk Texts.'
if ($atLogin) { 'Starts automatically when you log in.' }
if ($wasRunning) { Start-Process (Join-Path $Dest 'START-TEXTING.cmd') -ArgumentList 'nobrowser' -WindowStyle Minimized; 'Texting restarted.' }
elseif (-not $Quiet -and (Ask 'Start texting now?')) { Start-Process (Join-Path $Dest 'START-TEXTING.cmd') -WindowStyle Minimized }
