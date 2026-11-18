# SURE Walk Texts for Windows: updates from GitHub Releases (leeisaac991/surewalk-texts-windows).
#   update.ps1          check, and if there's a newer release: download it, check its SHA-256, install it in place
#   update.ps1 -Check   used at start: quietly check; if newer, ask in a popup (no answer in 30 s = not now)
# Only published releases are offered, never work in progress. Settings and the message log are never touched.
param([switch]$Check)
$ErrorActionPreference = 'Stop'
$Repo = 'leeisaac991/surewalk-texts-windows'
$Asset = 'SURE-Walk-Texts-Windows.zip'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path.TrimEnd('\')
$cur = '0'; try { $cur = (Get-Content -Raw (Join-Path $Root 'VERSION')).Trim() } catch {}
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$hdr = @{ 'User-Agent' = 'surewalk-texts-updater'; 'Accept' = 'application/vnd.github+json' }

function Newer([string]$a, [string]$b) {   # is version a newer than b? (2026.11.18 / 2026.11.18.2)
  $x = @($a.Split('.') | ForEach-Object { [int]("0" + ($_ -replace '\D', '')) }); $y = @($b.Split('.') | ForEach-Object { [int]("0" + ($_ -replace '\D', '')) })
  for ($i = 0; $i -lt [Math]::Max($x.Count, $y.Count); $i++) {
    $p = 0; if ($i -lt $x.Count) { $p = $x[$i] }; $q = 0; if ($i -lt $y.Count) { $q = $y[$i] }
    if ($p -ne $q) { return $p -gt $q }
  }
  return $false
}

try { $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers $hdr -TimeoutSec 15 -UseBasicParsing }
catch { if ($Check) { exit 0 }; "Could not reach GitHub to check for updates: $($_.Exception.Message)"; exit 1 }
$new = ([string]$rel.tag_name) -replace '^v', ''
if (-not (Newer $new $cur)) { if (-not $Check) { "You have the latest version ($cur)." }; exit 0 }

if ($Check) {
  $sh = New-Object -ComObject WScript.Shell
  $ans = $sh.Popup("SURE Walk Texts $new is available (you have $cur).`n`nInstall it now? Texting restarts for a few seconds.", 30, 'SURE Walk Texts update', 4 + 32)
  if ($ans -ne 6) { exit 0 }
}
"Updating SURE Walk Texts $cur -> $new ..."
$zip = $rel.assets | Where-Object { $_.name -eq $Asset } | Select-Object -First 1
$sum = $rel.assets | Where-Object { $_.name -eq "$Asset.sha256" } | Select-Object -First 1
if (-not $zip -or -not $sum) { 'That release is missing its files - try again later.'; exit 1 }
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("surewalk-update-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$null = New-Item -ItemType Directory -Path $tmp
try {
  $zf = Join-Path $tmp $Asset
  $sf = Join-Path $tmp "$Asset.sha256"
  Invoke-WebRequest -Uri $zip.browser_download_url -OutFile $zf -Headers @{ 'User-Agent' = 'surewalk-texts-updater' } -UseBasicParsing
  Invoke-WebRequest -Uri $sum.browser_download_url -OutFile $sf -Headers @{ 'User-Agent' = 'surewalk-texts-updater' } -UseBasicParsing
  $want = ((Get-Content -Raw $sf) -split '\s+')[0].Trim().ToLower()
  $got = (Get-FileHash -Algorithm SHA256 $zf).Hash.ToLower()
  if ($want -ne $got) { "The download did not match its checksum (expected $want, got $got) - nothing was changed."; exit 1 }
  tar -xf $zf -C $tmp
  if ($LASTEXITCODE) { 'Could not unpack the update - nothing was changed.'; exit 1 }
  $inst = Join-Path $tmp 'SURE-Walk-Texts-Windows\app\windows\install.ps1'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $inst -Quiet -Dest $Root
  if ($LASTEXITCODE) { 'The update did not finish - see above.'; exit 1 }
  if ($Check) { (New-Object -ComObject WScript.Shell).Popup("SURE Walk Texts $new is installed.", 10, 'SURE Walk Texts update', 64) | Out-Null }
} finally { Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $tmp }
