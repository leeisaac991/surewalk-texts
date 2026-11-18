# SURE Walk phone bridge for Windows: UT iPhone <-> texting server (http://127.0.0.1:8787/bridge).
#
# Replaces BlueFerry + surewalk_bridge (Linux) with one script that needs no install and no admin:
#   - talks to the paired iPhone directly over Bluetooth with the Message Access Profile (MAP), using
#     Windows' own Bluetooth APIs from Windows PowerShell 5.1
#   - every few seconds: reads the iPhone inbox listing, forwards new texts to the server, sends what
#     the server queued (one at a time), reports how each send went. Same JSON as the Linux bridge.
#
# Run by START-TEXTING.cmd. By hand:
#   powershell -NoProfile -ExecutionPolicy Bypass -File bridge.ps1
#   ... -Device "PARK"              pick the phone by (part of) its Bluetooth name
#   ... -TestTcp 127.0.0.1:9400     talk to a pretend phone over TCP instead of Bluetooth (tests)
#   ... -StateDir <folder>          where config.json / state.json live (default %LOCALAPPDATA%\surewalk-bridge)
#
# Keeps (in the state folder): texts already forwarded (as hashes), anything not yet delivered.
# Its log (bridge.log) never contains message text or phone numbers.
param(
  [string]$Device = '',
  [string]$TestTcp = '',
  [string]$StateDir = ''
)
$ErrorActionPreference = 'Stop'
$Version = 'win-2026.11.17'
$SendGapMs = 3000                       # between texts in one batch (the server paces too)
$ForwardWindowMs = 2 * 3600 * 1000      # after a restart, unseen texts up to 2 h old are still forwarded
$ListCount = 40                         # newest inbox entries looked at each poll

if (-not $StateDir) { $base = $env:LOCALAPPDATA; if (-not $base) { $base = [IO.Path]::GetTempPath() }; $StateDir = Join-Path $base 'surewalk-bridge' }
$null = New-Item -ItemType Directory -Force -Path $StateDir
$CfgFile = Join-Path $StateDir 'config.json'
$StateFile = Join-Path $StateDir 'state.json'
$LogFile = Join-Path $StateDir 'bridge.log'

function Log([string]$text) {
  $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $text
  Write-Host $line
  try {
    if ((Test-Path $LogFile) -and (Get-Item $LogFile).Length -gt 1MB) { Move-Item -Force $LogFile ($LogFile + '.old') }
    [IO.File]::AppendAllText($LogFile, $line + "`r`n")
  } catch {}
}
function Msg($err) {
  $x = $err
  if ($x -is [System.Management.Automation.ErrorRecord]) { $x = $x.Exception }
  while ($x.InnerException) { $x = $x.InnerException }
  return [string]$x.Message
}
function NowMs { return [long]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) }

# ------------------------------------------------------------ one bridge at a time
$mutexName = 'Local\SureWalkPhoneBridge'; if ($TestTcp) { $mutexName += 'Test' }   # tests can run next to the real bridge
$mutex = New-Object System.Threading.Mutex($false, $mutexName)
if (-not $mutex.WaitOne(0)) { Log 'Another phone bridge is already running - this one exits.'; exit 0 }

# ------------------------------------------------------------ config + state
if (-not (Test-Path $CfgFile)) { Log "No config at $CfgFile - run START-TEXTING.cmd (it links the bridge to the server)."; exit 1 }
$Cfg = Get-Content -Raw -Encoding UTF8 $CfgFile | ConvertFrom-Json
if (-not ($Cfg.url -match '^http://(127\.0\.0\.1|localhost):\d+/') -or ([string]$Cfg.key).Length -lt 32) { Log "$CfgFile needs the local server URL and its key."; exit 1 }

$State = @{ seen = (New-Object System.Collections.Generic.List[string]); inbound = (New-Object System.Collections.ArrayList); results = (New-Object System.Collections.ArrayList); seeded = $false }
if (Test-Path $StateFile) {
  try {
    $d = Get-Content -Raw -Encoding UTF8 $StateFile | ConvertFrom-Json
    foreach ($s in @($d.seen)) { if ($s) { $State.seen.Add([string]$s) } }
    foreach ($m in @($d.inbound)) { if ($m) { $null = $State.inbound.Add(@{ id = [string]$m.id; from = [string]$m.from; text = [string]$m.text; ts = [long]$m.ts }) } }
    foreach ($r in @($d.results)) { if ($r) { $null = $State.results.Add(@{ outId = $r.outId; status = [string]$r.status; error = [string]$r.error }) } }
    $State.seeded = [bool]$d.seeded
  } catch { Log ("state.json unreadable, starting fresh: " + (Msg $_)) }
}
$Seen = New-Object 'System.Collections.Generic.HashSet[string]'
foreach ($s in $State.seen) { $null = $Seen.Add($s) }
function Save-State {
  while ($State.seen.Count -gt 5000) { $State.seen.RemoveAt(0) }
  $obj = @{ seen = @($State.seen); inbound = @($State.inbound); results = @($State.results); seeded = $State.seeded }
  $json = ConvertTo-Json -InputObject $obj -Depth 6 -Compress
  $tmp = $StateFile + '.tmp'
  [IO.File]::WriteAllText($tmp, $json, (New-Object System.Text.UTF8Encoding($false)))
  if (Test-Path $StateFile) { [IO.File]::Replace($tmp, $StateFile, [NullString]::Value) } else { [IO.File]::Move($tmp, $StateFile) }
}
function Mark-Seen([string]$id) { if ($Seen.Add($id)) { $State.seen.Add($id) } }

# ------------------------------------------------------------ Windows Bluetooth (WinRT) helpers
if (-not $TestTcp) {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $ext = [System.WindowsRuntimeSystemExtensions].GetMethods()
  $script:AsTaskOp = $ext | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
  $script:AsTaskAct = $ext | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' } | Select-Object -First 1
}
function T([string]$name) {
  foreach ($a in 'Windows.Foundation', 'Windows.Devices', 'Windows.System.Devices', 'Windows.Networking', 'Windows.Storage') {
    $t = [Type]::GetType("$name, $a, ContentType=WindowsRuntime")
    if ($t) { return $t }
  }
  throw "cannot load Windows type $name"
}
function Await($op, [Type]$type, [int]$ms = 15000) {
  $task = $script:AsTaskOp.MakeGenericMethod($type).Invoke($null, @($op))
  if (-not $task.Wait($ms)) { throw ("timed out after " + ($ms / 1000) + " s") }
  return $task.Result
}
function AwaitAction($op, [int]$ms = 15000) {
  $task = $script:AsTaskAct.Invoke($null, @($op))
  if (-not $task.Wait($ms)) { throw ("timed out after " + ($ms / 1000) + " s") }
}

# ------------------------------------------------------------ transport: Bluetooth RFCOMM, or TCP for tests
$script:Link = $null   # @{ kind; sock; w; r; tcp; ns; cid; max; name }
function Link-Write([byte[]]$bytes) {
  $L = $script:Link
  if ($L.kind -eq 'tcp') { $L.ns.Write($bytes, 0, $bytes.Length); $L.ns.Flush(); return }
  $L.w.WriteBytes($bytes)
  $null = Await ($L.w.StoreAsync()) ([uint32]) 15000
}
function Link-Read([int]$n, [int]$ms) {
  $L = $script:Link
  $buf = New-Object byte[] $n
  if ($L.kind -eq 'tcp') {
    $L.ns.ReadTimeout = $ms; $got = 0
    while ($got -lt $n) { $k = $L.ns.Read($buf, $got, $n - $got); if ($k -le 0) { throw 'the phone closed the connection' }; $got += $k }
    return , $buf
  }
  $got = Await ($L.r.LoadAsync([uint32]$n)) ([uint32]) $ms
  if ($got -lt $n) { throw 'the phone closed the connection' }
  for ($i = 0; $i -lt $n; $i++) { $buf[$i] = $L.r.ReadByte() }
  return , $buf
}
function Link-Close {
  $L = $script:Link; $script:Link = $null
  if (-not $L) { return }
  try { if ($L.kind -eq 'tcp') { $L.tcp.Close() } else { $L.sock.Dispose() } } catch {}
}

# ------------------------------------------------------------ OBEX
$MAS_UUID = [byte[]](0xbb, 0x58, 0x2b, 0x40, 0x42, 0x0c, 0x11, 0xdb, 0xb0, 0xde, 0x08, 0x00, 0x20, 0x0c, 0x9a, 0x66)
$Codes = @{ 0xA0 = 'OK'; 0x90 = 'Continue'; 0xC0 = 'Bad Request'; 0xC1 = 'Unauthorized'; 0xC3 = 'Forbidden'; 0xC4 = 'Not Found'; 0xC6 = 'Not Acceptable'; 0xCB = 'Length Required'; 0xD0 = 'Internal Error'; 0xD1 = 'Not Implemented'; 0xD3 = 'Service Unavailable' }
function CodeName([int]$c) { $n = $Codes[$c]; if (-not $n) { $n = 'unknown' }; return ('0x{0:X2} {1}' -f $c, $n) }
function NewBuf { return , (New-Object System.Collections.Generic.List[byte]) }
function Add16([System.Collections.Generic.List[byte]]$b, [int]$n) { $b.Add([byte](($n -shr 8) -band 0xFF)); $b.Add([byte]($n -band 0xFF)) }
function AddHdr([System.Collections.Generic.List[byte]]$b, [int]$id, [byte[]]$v) { $b.Add([byte]$id); Add16 $b ($v.Length + 3); $b.AddRange($v) }
function AddName([System.Collections.Generic.List[byte]]$b, [string]$name) {
  $u = NewBuf
  if ($name.Length) { $u.AddRange([System.Text.Encoding]::BigEndianUnicode.GetBytes($name)); $u.Add(0); $u.Add(0) }
  AddHdr $b 0x01 $u.ToArray()
}
function AddType([System.Collections.Generic.List[byte]]$b, [string]$type) { AddHdr $b 0x42 ([System.Text.Encoding]::ASCII.GetBytes($type + [char]0)) }
function AddConn([System.Collections.Generic.List[byte]]$b) { $c = $script:Link.cid; if ($c) { $b.Add(0xCB); $b.AddRange([byte[]]$c) } }

function Xfer([int]$op, [System.Collections.Generic.List[byte]]$body, [int]$ms = 20000) {
  $p = NewBuf
  $p.Add([byte]$op); Add16 $p ($body.Count + 3); $p.AddRange($body)
  Link-Write $p.ToArray()
  $head = Link-Read 3 $ms
  $len = ([int]$head[1] -shl 8) -bor $head[2]
  $all = New-Object byte[] ([Math]::Max($len, 3))
  [Array]::Copy($head, $all, 3)
  if ($len -gt 3) { $rest = Link-Read ($len - 3) $ms; [Array]::Copy($rest, 0, $all, 3, $len - 3) }
  return , $all
}
# Headers of a response packet -> @{ id = [byte[]] }; Body (0x48) and End-of-Body (0x49) both land in 'body'.
function Headers([byte[]]$p, [int]$off) {
  $h = @{}; $i = $off
  while ($i -lt $p.Length) {
    $id = [int]$p[$i]; $kind = $id -band 0xC0
    if ($kind -eq 0x00 -or $kind -eq 0x40) {
      if ($i + 2 -ge $p.Length) { break }
      $n = ([int]$p[$i + 1] -shl 8) -bor $p[$i + 2]
      if ($n -lt 3 -or $i + $n -gt $p.Length) { break }
      $v = New-Object byte[] ($n - 3); [Array]::Copy($p, $i + 3, $v, 0, $n - 3)
      if ($id -eq 0x48 -or $id -eq 0x49) { $h['body'] = $v } else { $h[$id] = $v }
      $i += $n
    } elseif ($kind -eq 0x80) { if ($i + 1 -ge $p.Length) { break }; $h[$id] = [byte[]]@($p[$i + 1]); $i += 2 }
    else { if ($i + 4 -ge $p.Length) { break }; $v = New-Object byte[] 4; [Array]::Copy($p, $i + 1, $v, 0, 4); $h[$id] = $v; $i += 5 }
  }
  return $h
}
# GET with continuation; returns @{ code; body = [byte[]] }
function Obex-Get([System.Collections.Generic.List[byte]]$first) {
  $resp = Xfer 0x83 $first
  $body = NewBuf; $guard = 0
  while ($true) {
    $h = Headers $resp 3
    if ($h.ContainsKey('body')) { $body.AddRange([byte[]]$h['body']) }
    if ($resp[0] -ne 0x90) { break }
    if ($guard++ -gt 2000) { throw 'the phone kept sending (over 2000 packets)' }
    $b = NewBuf; AddConn $b
    $resp = Xfer 0x83 $b
  }
  return @{ code = [int]$resp[0]; body = $body.ToArray() }
}

# ------------------------------------------------------------ MAP session
function Phone-Open {
  Link-Close
  if ($TestTcp) {
    $hp = $TestTcp.Split(':')
    $tcp = New-Object System.Net.Sockets.TcpClient
    $tcp.Connect($hp[0], [int]$hp[1])
    $script:Link = @{ kind = 'tcp'; tcp = $tcp; ns = $tcp.GetStream(); name = 'test phone'; cid = $null; max = 0x2000 }
  } else {
    $BtDev = T 'Windows.Devices.Bluetooth.BluetoothDevice'
    $DevInfo = T 'Windows.Devices.Enumeration.DeviceInformation'
    $Cache = T 'Windows.Devices.Bluetooth.BluetoothCacheMode'
    $SvcId = T 'Windows.Devices.Bluetooth.Rfcomm.RfcommServiceId'
    $Res = T 'Windows.Devices.Bluetooth.Rfcomm.RfcommDeviceServicesResult'
    $coll = Await ($DevInfo::FindAllAsync($BtDev::GetDeviceSelectorFromPairingState($true))) (T 'Windows.Devices.Enumeration.DeviceInformationCollection')
    $phones = @()
    foreach ($di in $coll) {
      $d = Await ($BtDev::FromIdAsync($di.Id)) $BtDev
      if (-not $d) { continue }
      $ok = ("$($d.ClassOfDevice.MajorClass)" -eq 'Phone') -or ($d.Name -match 'iPhone')
      if ($Device) { $ok = $d.Name -like "*$Device*" }
      if ($ok) { $phones += $d }
    }
    if (-not $phones.Count) { throw 'no paired phone (pair the iPhone in Settings > Bluetooth & devices)' }
    $svc = $null; $name = ''
    foreach ($ph in $phones) {
      $r = Await ($ph.GetRfcommServicesForIdAsync($SvcId::FromShortId(0x1132), $Cache::Uncached)) $Res 20000
      if ($r.Services -and $r.Services.Count -gt 0) { $svc = $r.Services[0]; $name = $ph.Name; break }
    }
    if (-not $svc) { throw 'the iPhone is not reachable (Bluetooth on, nearby, unlocked once?)' }
    $sock = [Activator]::CreateInstance((T 'Windows.Networking.Sockets.StreamSocket'))
    AwaitAction ($sock.ConnectAsync($svc.ConnectionHostName, $svc.ConnectionServiceName, (T 'Windows.Networking.Sockets.SocketProtectionLevel')::BluetoothEncryptionAllowNullAuthentication)) 30000
    # PowerShell can't match these constructors itself; reflection can.
    $w = (T 'Windows.Storage.Streams.DataWriter').GetConstructor([Type[]]@((T 'Windows.Storage.Streams.IOutputStream'))).Invoke(@($sock.OutputStream))
    $r = (T 'Windows.Storage.Streams.DataReader').GetConstructor([Type[]]@((T 'Windows.Storage.Streams.IInputStream'))).Invoke(@($sock.InputStream))
    $script:Link = @{ kind = 'bt'; sock = $sock; w = $w; r = $r; name = $name; cid = $null; max = 0x2000 }
  }
  $b = NewBuf
  $b.AddRange([byte[]](0x10, 0x00, 0x20, 0x00)); AddHdr $b 0x46 $MAS_UUID
  $resp = Xfer 0x80 $b
  if ($resp[0] -ne 0xA0) {
    $why = CodeName $resp[0]
    Link-Close
    if ($why -like '*Forbidden*') { throw "the iPhone refused message access ($why): on the iPhone, Settings > Bluetooth > (i) next to this laptop > Show Notifications ON" }
    throw "the iPhone refused the message session ($why)"
  }
  $script:Link.max = [Math]::Max(255, [Math]::Min(0x2000, (([int]$resp[5] -shl 8) -bor $resp[6])))
  $h = Headers $resp 7
  if ($h.ContainsKey(0xCB)) { $script:Link.cid = $h[0xCB] }
  foreach ($dir in '', 'telecom', 'msg') {
    $b = NewBuf; $b.AddRange([byte[]](0x02, 0x00)); AddConn $b; AddName $b $dir
    $resp = Xfer 0x85 $b
    if ($resp[0] -ne 0xA0) { $why = CodeName $resp[0]; Link-Close; throw "could not open the message folders ($why)" }
  }
  Log ("connected to " + $script:Link.name)
}
function Phone-Close {
  if (-not $script:Link) { return }
  try { $b = NewBuf; AddConn $b; $null = Xfer 0x81 $b 3000 } catch {}
  Link-Close
}

function Html([string]$s) { return [System.Net.WebUtility]::HtmlDecode($s) }
# MAP datetime "YYYYMMDDTHHMMSS[+hhmm|Z]" -> epoch ms (no offset = this laptop's local time, as the phone sends it)
function MapMs([string]$s) {
  if (-not $s -or $s.Length -lt 15) { return [long]0 }
  try {
    $dt = [datetime]::ParseExact($s.Substring(0, 15), 'yyyyMMddTHHmmss', [Globalization.CultureInfo]::InvariantCulture)
    $rest = $s.Substring(15)
    if ($rest -match '^Z') { return [long]([DateTimeOffset]::new($dt, [TimeSpan]::Zero).ToUnixTimeMilliseconds()) }
    if ($rest -match '^([+-])(\d\d):?(\d\d)') {
      $off = New-Object TimeSpan ([int]$Matches[2]), ([int]$Matches[3]), 0
      if ($Matches[1] -eq '-') { $off = $off.Negate() }
      return [long]([DateTimeOffset]::new($dt, $off).ToUnixTimeMilliseconds())
    }
    return [long]([DateTimeOffset]::new($dt.ToUniversalTime()).ToUnixTimeMilliseconds())
  } catch { return [long]0 }
}
# Parse a listing without an XML parser: phones sometimes send unescaped characters that break strict XML.
function Parse-Listing([string]$xml) {
  $out = @()
  foreach ($m in [regex]::Matches($xml, '<msg\b((?:\s+[\w:-]+\s*=\s*"[^"]*")*)\s*/?>')) {
    $a = @{}
    foreach ($kv in [regex]::Matches($m.Groups[1].Value, '([\w:-]+)\s*=\s*"([^"]*)"')) { $a[$kv.Groups[1].Value.ToLower()] = Html $kv.Groups[2].Value }
    if ($a['handle']) { $out += , $a }
  }
  return , $out
}
# bMessage -> @{ from; text } (sender = TEL/EMAIL of the first vCard before the envelope; body between BEGIN:MSG and END:MSG)
function Parse-BMessage([string]$s) {
  $from = $null
  $head = $s; $k = $s.IndexOf('BEGIN:BENV', [StringComparison]::OrdinalIgnoreCase); if ($k -ge 0) { $head = $s.Substring(0, $k) }
  foreach ($line in ($head -split "\r?\n")) {
    $t = $line.Trim()
    if (-not $from -and $t -match '^(TEL|EMAIL)[^:]*:(.+)$') { $v = $Matches[2].Trim(); if ($v) { $from = $v } }
  }
  $text = $null
  $mm = [regex]::Match($s, '(?is)(?:^|\n)[ \t]*BEGIN:MSG[ \t]*\r?\n(.*?)\r?\n[ \t]*END:MSG[ \t]*(?:\r?\n|$)')
  if ($mm.Success) {
    $lines = $mm.Groups[1].Value -split "\r?\n" | ForEach-Object { if ($_ -match '^ (BEGIN:|END:)') { $_.Substring(1) } else { $_ } }
    $text = ($lines -join "`n").Trim("`r", "`n", ' ')
  }
  return @{ from = $from; text = $text }
}
function Phone-GetMessage([string]$handle) {
  $b = NewBuf; AddConn $b; AddType $b 'x-bt/message'; AddName $b $handle
  AddHdr $b 0x4C ([byte[]](0x0A, 0x01, 0x00, 0x14, 0x01, 0x01))   # Attachment off, Charset UTF-8
  $g = Obex-Get $b
  if ($g.code -ne 0xA0) { throw ("could not read a message (" + (CodeName $g.code) + ")") }
  return Parse-BMessage ([System.Text.Encoding]::UTF8.GetString($g.body))
}
function Hash20([string]$s) {
  $sha = [System.Security.Cryptography.SHA1]::Create()
  $hex = -join ($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($s)) | ForEach-Object { $_.ToString('x2') })
  return $hex.Substring(0, 20)
}
# Newest incoming texts -> @( @{ id; from; text; ts } ), oldest first. Reads full text only when the listing's subject may be cut short.
function Phone-Incoming {
  $b = NewBuf; AddConn $b; AddType $b 'x-bt/MAP-msg-listing'; AddName $b 'inbox'
  AddHdr $b 0x4C ([byte[]](0x01, 0x02, 0x00, [byte]$ListCount, 0x13, 0x01, 0xFF))   # MaxListCount, SubjectLength 255
  $g = Obex-Get $b
  if ($g.code -ne 0xA0) { throw ("the iPhone refused the inbox listing (" + (CodeName $g.code) + ")") }
  $items = Parse-Listing ([System.Text.Encoding]::UTF8.GetString($g.body))
  $out = @()
  foreach ($a in $items) {
    $type = [string]$a['type']
    if ($type -and $type -notmatch '^(SMS|MMS|IM)') { continue }   # skip e-mail
    $ts = MapMs $a['datetime']
    $from = [string]$a['sender_addressing']; $text = [string]$a['subject']
    $pre = Hash20 ("pre|" + $a['handle'] + "|" + $a['datetime'] + "|" + $from + "|" + $text)
    if ($Seen.Contains($pre)) { continue }                        # already handled this exact listing entry
    if (-not $from -or -not $text -or $text.Length -ge 250) {
      try { $full = Phone-GetMessage $a['handle']; if ($full.from) { $from = $full.from }; if ($full.text) { $text = $full.text } }
      catch { Log ("message read failed: " + (Msg $_)) }
    }
    if (-not $from -or -not $text) { Mark-Seen $pre; continue }
    $key = Hash20 ("$from|$ts|$text")
    $out += , @{ id = $key; from = $from; text = $text; ts = $ts; pre = $pre }
  }
  return , @($out | Sort-Object { $_.ts })
}
function Bmsg([string]$to, [string]$body) {
  $stuffed = (($body -split "\r?\n") | ForEach-Object { if ($_ -match '^(?i)(BEGIN:|END:)') { ' ' + $_ } else { $_ } }) -join "`n"
  $prop = 'TEL'; if ($to.Contains('@')) { $prop = 'EMAIL' }
  $len = [System.Text.Encoding]::UTF8.GetByteCount($stuffed)
  $lines = @('BEGIN:BMSG', 'VERSION:1.0', 'STATUS:UNREAD', 'TYPE:SMS_GSM', 'FOLDER:telecom/msg/outbox',
    'BEGIN:VCARD', 'VERSION:2.1', 'N:;;;;', 'TEL:', 'END:VCARD',
    'BEGIN:BENV', 'BEGIN:VCARD', 'VERSION:2.1', 'N:;;;;', "${prop}:$to", 'END:VCARD',
    'BEGIN:BBODY', 'CHARSET:UTF-8', "LENGTH:$len", 'BEGIN:MSG', $stuffed, 'END:MSG', 'END:BBODY', 'END:BENV', 'END:BMSG')
  return ($lines -join "`r`n") + "`r`n"
}
# PushMessage -> @{ status = sent|failed|unknown; error }
function Phone-Send([string]$to, [string]$body) {
  $to = ($to -replace '[\s().-]', '')
  if (-not ($to -match '^\+?\d{3,15}$' -or $to -match '^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$')) { return @{ status = 'failed'; error = 'not a phone number' } }
  if (-not $script:Link) { return @{ status = 'failed'; error = 'phone not connected to the laptop' } }
  $data = [System.Text.Encoding]::UTF8.GetBytes((Bmsg $to $body))
  $hdr = NewBuf; AddConn $hdr; AddType $hdr 'x-bt/message'; AddName $hdr 'outbox'
  AddHdr $hdr 0x4C ([byte[]](0x14, 0x01, 0x01))                     # Charset UTF-8
  $room = $script:Link.max - 3 - $hdr.Count - 3
  $written = $false
  try {
    $off = 0; $first = $true
    while ($true) {
      $b = NewBuf; if ($first) { $b.AddRange($hdr) } else { AddConn $b }
      $cap = $room; if (-not $first) { $cap = $script:Link.max - 3 - $b.Count - 3 }
      $n = [Math]::Min($cap, $data.Length - $off)
      $chunk = New-Object byte[] $n; [Array]::Copy($data, $off, $chunk, 0, $n)
      $last = ($off + $n) -ge $data.Length
      if ($last) { AddHdr $b 0x49 $chunk; $op = 0x82 } else { AddHdr $b 0x48 $chunk; $op = 0x02 }
      $written = $true
      $resp = Xfer $op $b 30000
      $off += $n; $first = $false
      if ($last) { break }
      if ($resp[0] -ne 0x90) { return @{ status = 'failed'; error = ("the iPhone refused the text (" + (CodeName $resp[0]) + ")") } }
    }
    if ($resp[0] -eq 0xA0) { return @{ status = 'sent'; error = '' } }
    return @{ status = 'failed'; error = ("the iPhone refused the text (" + (CodeName $resp[0]) + ")") }
  } catch {
    $e = Msg $_
    Link-Close
    if ($written) { return @{ status = 'unknown'; error = "The phone didn't confirm it - check the iPhone before resending ($e)" } }
    return @{ status = 'failed'; error = $e }
  }
}

# ------------------------------------------------------------ the texting server
function Server-Sync($payload) {
  $wc = New-Object System.Net.WebClient
  $wc.Proxy = $null                                   # 127.0.0.1 only: never through a proxy
  $wc.Encoding = [System.Text.Encoding]::UTF8
  $wc.Headers['Content-Type'] = 'application/json'
  $wc.Headers['User-Agent'] = "surewalk-bridge/$Version"
  $body = ConvertTo-Json -InputObject (@{ key = $Cfg.key; op = 'sync' } + $payload) -Depth 6 -Compress
  try { $text = $wc.UploadString([string]$Cfg.url, 'POST', $body) }
  catch { throw ("can't reach the texting server: " + (Msg $_)) }
  try { $data = $text | ConvertFrom-Json } catch { throw "the texting server didn't answer with JSON" }
  if (-not $data) { throw 'the texting server refused the key (run STOP-TEXTING.cmd then START-TEXTING.cmd to relink)' }
  return $data
}

# ------------------------------------------------------------ main loop
Log "SURE Walk phone bridge $Version starting (state: $StateDir)"
$lastErr = ''; $nextConnect = [datetime]::MinValue; $connectDelay = 5; $poll = 3.0; $backoff = 0
try {
  while ($true) {
    # 1. phone link (retry with back-off while it's away)
    if (-not $script:Link -and (Get-Date) -ge $nextConnect) {
      try { Phone-Open; $lastErr = ''; $connectDelay = 5 }
      catch {
        $e = Msg $_
        if ($e -ne $lastErr) { Log ("phone: " + $e) }
        $lastErr = $e; Link-Close
        $nextConnect = (Get-Date).AddSeconds($connectDelay); $connectDelay = [Math]::Min(60, $connectDelay * 2)
      }
    }
    # 2. new incoming texts
    if ($script:Link) {
      try {
        $now = NowMs
        $msgs = Phone-Incoming
        if (-not $State.seeded) {
          foreach ($m in $msgs) { Mark-Seen $m.id; Mark-Seen $m.pre }
          $State.seeded = $true
          Log ("first run: " + $msgs.Count + " texts already on the phone are treated as history")
        } else {
          foreach ($m in $msgs) {
            Mark-Seen $m.pre
            if ($Seen.Contains($m.id)) { continue }
            Mark-Seen $m.id
            if ($m.ts -and ($now - $m.ts) -gt $ForwardWindowMs) { continue }
            $null = $State.inbound.Add(@{ id = $m.id; from = $m.from; text = $m.text; ts = $m.ts })
            Log 'new text from a rider'
          }
        }
        Save-State
      } catch {
        $e = Msg $_
        Log ("reading texts failed: " + $e); $lastErr = $e
        Link-Close; $nextConnect = (Get-Date).AddSeconds(2)
      }
    }
    # 3. sync with the server
    $nIn = [Math]::Min(50, $State.inbound.Count); $nRes = [Math]::Min(100, $State.results.Count)
    $connected = [bool]$script:Link
    $errText = ''; if (-not $connected) { $errText = $lastErr; if ($errText.Length -gt 200) { $errText = $errText.Substring(0, 200) } }
    $payload = @{
      bridge = @{ connected = $connected; healthy = $true; error = $errText; version = $Version }
      inbound = @($State.inbound | Select-Object -First $nIn)
      results = @($State.results | Select-Object -First $nRes)
    }
    try { $resp = Server-Sync $payload; $backoff = 0 }
    catch {
      $backoff = [Math]::Min(60, [Math]::Max(2, $backoff * 2))
      Log ((Msg $_) + " - retrying in $backoff s")
      Start-Sleep -Seconds $backoff
      continue
    }
    if ($nIn) { $State.inbound.RemoveRange(0, $nIn) }
    if ($nRes) { $State.results.RemoveRange(0, $nRes) }
    Save-State
    $pm = 3000; if ($resp.pollMs) { $pm = [double]$resp.pollMs }
    $poll = [Math]::Max(1.0, [Math]::Min(30.0, $pm / 1000))

    # 4. send what the server queued, one at a time
    $outbox = @(); if ($resp.outbox) { $outbox = @($resp.outbox) }
    for ($i = 0; $i -lt $outbox.Count; $i++) {
      $o = $outbox[$i]
      $r = Phone-Send ([string]$o.to) ([string]$o.body)
      $null = $State.results.Add(@{ outId = $o.outId; status = $r.status; error = [string]$r.error })
      Log ("text " + ($i + 1) + "/" + $outbox.Count + ": " + $r.status)
      Save-State
      if ($i -lt $outbox.Count - 1) { Start-Sleep -Milliseconds $SendGapMs }
    }
    if ($resp.dial) { foreach ($d in @($resp.dial)) { if ($d) { Log 'a call was requested - calling from the laptop is not supported; call from the iPhone' } } }
    if ($outbox.Count) { continue }   # report the outcomes right away
    Start-Sleep -Milliseconds ([int]($poll * 1000))
  }
} finally {
  Phone-Close
  try { Save-State } catch {}
  Log 'stopped'
  $mutex.ReleaseMutex()
}
