# dsh-restart-instance.ps1 - restart exactly ONE dsh web instance.
#
# Two ways to name the target:
#   -Port <n>   the port the instance listens on (what the fixed host plugin passes)
#   -Auto       infer the target from the process that asked: walk up the parent
#               chain to the node.exe that spawned wscript, read the port it
#               listens on and rebuild its command line. This is the safety net
#               for hosts still running the OLD plugin, which hardcoded 3080:
#               without it, pressing restart inside the 3098 instance kills 3080.
#   -DryRun     print what would happen and exit without killing anything.
#
# Everything else comes from the request file the host plugin wrote just before
# triggering this script:
#   <DSH_ROOT>\logs\dsh-restart\request-<port>.json
# (node executable, entry script, working directory, argv). The environment is
# inherited through the wscript -> powershell chain, so DSH_HOME of the original
# process survives. When -Auto has to rebuild the launch line itself it uses the
# caller's CommandLine and resolves a relative entry against the known install
# roots; if nothing resolves it refuses to touch the machine and says so.
#
# Keep this file pure ASCII: Windows PowerShell 5.1 reads BOM-less files as ANSI
# and non-ASCII bytes can decode into stray braces.
#
# NOTE 1: new dsh web refuses a 0.0.0.0 bind; callers pass 127.0.0.1.
# NOTE 2: never launch through `cmd /c` with a shell redirect from Start-Process:
#         the redirect makes the spawn fail silently. Use -RedirectStandardOutput.
# NOTE 3: keep the stdout log path of port 3080 at logs\dsh-web.log - the desktop
#         shell resolves the process token from that file.

param(
    [int]$Port = 0,
    [switch]$Auto,
    [switch]$DryRun
)

$ErrorActionPreference = 'SilentlyContinue'

$root = if ($env:DSH_ROOT) { $env:DSH_ROOT } else { Join-Path $env:USERPROFILE 'DeepSeek_harness' }
$logDir = Join-Path $root 'logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $logDir 'dsh-restart') -Force | Out-Null

$log = Join-Path $logDir ("dsh-restart-instance-{0}.log" -f $(if ($Port -gt 0) { $Port } else { 'auto' }))
function L($m) {
    try { Add-Content -Path $log -Value ((Get-Date).ToString('HH:mm:ss.fff') + ' ' + $m) -Encoding UTF8 } catch { }
}

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
function Get-ListenerPid([int]$p) {
    $pattern = ':' + [string]$p + ' '
    foreach ($nl in (netstat -ano 2>$null | Select-String -SimpleMatch $pattern | Select-String 'LISTENING')) {
        $parts = ($nl.ToString().Trim() -split '\s+')
        if ($parts.Count -ge 5) { return [int]$parts[-1] }
    }
    return $null
}

function Get-ListeningPorts([int]$processId) {
    $ports = @()
    foreach ($nl in (netstat -ano 2>$null | Select-String 'LISTENING')) {
        $parts = ($nl.ToString().Trim() -split '\s+')
        if ($parts.Count -lt 5) { continue }
        if ([int]$parts[-1] -ne $processId) { continue }
        $local = $parts[1]
        $idx = $local.LastIndexOf(':')
        if ($idx -lt 0) { continue }
        $p = 0
        if ([int]::TryParse($local.Substring($idx + 1), [ref]$p)) { $ports += $p }
    }
    return ($ports | Sort-Object -Unique)
}

# Split a Windows command line into argv (quote-aware; our paths are either
# quoted or space-free, which is all this needs to be correct for).
function Split-CommandLine([string]$cl) {
    $out = @()
    $cur = ''
    $inQuote = $false
    foreach ($ch in $cl.ToCharArray()) {
        if ($ch -eq '"') { $inQuote = -not $inQuote; continue }
        if (-not $inQuote -and ($ch -eq ' ' -or $ch -eq "`t")) {
            if ($cur -ne '') { $out += $cur; $cur = '' }
            continue
        }
        $cur += $ch
    }
    if ($cur -ne '') { $out += $cur }
    return $out
}

# The node.exe that ultimately asked for this restart (wscript's parent, or
# higher up when a launcher sits in between).
function Get-CallerNodeProcess {
    $self = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $PID) -ErrorAction SilentlyContinue
    if (-not $self) { return $null }
    $parentId = $self.ParentProcessId
    for ($hop = 0; $hop -lt 5 -and $parentId; $hop++) {
        $proc = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $parentId) -ErrorAction SilentlyContinue
        if (-not $proc) { return $null }
        if ($proc.Name -eq 'node.exe') { return $proc }
        $parentId = $proc.ParentProcessId
    }
    return $null
}

$installRoots = @()
if ($env:DSH_INSTALL_ROOT) { $installRoots += $env:DSH_INSTALL_ROOT }
$installRoots += @(
    (Join-Path $env:USERPROFILE '.dsh\profiles')
)

# ---------------------------------------------------------------------------
# 1. resolve the target instance
# ---------------------------------------------------------------------------
L ("script start port=" + $Port + " auto=" + [bool]$Auto + " dryRun=" + [bool]$DryRun)
if (-not $DryRun) { Start-Sleep -Seconds 1 }

$nodeExe = $null
$entry = $null
$workDir = $null
$argList = @()
$fromRequest = $false

if ($Auto -and $Port -le 0) {
    $caller = Get-CallerNodeProcess
    if (-not $caller) {
        L 'ABORT: -Auto found no caller node process (refusing to guess a target)'
        exit 1
    }
    L ("auto caller pid=" + $caller.ProcessId + " name=" + $caller.Name)
    $ports = Get-ListeningPorts $caller.ProcessId
    if (-not $ports -or $ports.Count -eq 0) {
        L 'ABORT: -Auto could not find a port the caller listens on'
        exit 1
    }
    $Port = [int]$ports[0]
    L ("auto resolved port=" + $Port + " (caller ports: " + ($ports -join ',') + ")")

    $tokens = Split-CommandLine ([string]$caller.CommandLine)
    if ($tokens.Count -lt 2) {
        L 'ABORT: -Auto could not parse the caller command line'
        exit 1
    }
    $nodeExe = $tokens[0]
    $entry = $tokens[1]
    $argList = @()
    if ($tokens.Count -gt 2) { $argList = @($tokens[2..($tokens.Count - 1)]) }
    if (-not [System.IO.Path]::IsPathRooted($entry)) {
        $resolved = $null
        foreach ($cand in $installRoots) {
            $try = Join-Path $cand $entry
            if (Test-Path $try) { $resolved = $try; $workDir = $cand; break }
        }
        if (-not $resolved) {
            L ("ABORT: relative entry '" + $entry + "' not found under: " + ($installRoots -join '; '))
            exit 1
        }
        $entry = $resolved
        L ("auto resolved entry=" + $entry + " workDir=" + $workDir)
    } else {
        $workDir = [System.IO.Path]::GetDirectoryName($entry)
    }
}

# The request file (written by the fixed host plugin) wins when it exists.
if ($Port -gt 0) {
    $reqFile = Join-Path $logDir ("dsh-restart\request-{0}.json" -f $Port)
    if (Test-Path $reqFile) {
        try {
            $req = Get-Content -Path $reqFile -Raw -Encoding UTF8 | ConvertFrom-Json
            $nodeExe = [string]$req.nodeExe
            $entry = [string]$req.entry
            $workDir = [string]$req.workDir
            $argList = @()
            if ($req.args) { $argList = @($req.args) }
            $fromRequest = $true
        } catch {
            L ("request file unreadable, falling back to inferred launch: " + $_.Exception.Message)
        }
    }
}

if ([string]::IsNullOrWhiteSpace($nodeExe)) { $nodeExe = 'node' }
if ([string]::IsNullOrWhiteSpace($workDir)) { $workDir = $root }
if ([string]::IsNullOrWhiteSpace($entry) -or -not (Test-Path $entry)) {
    L ("ABORT: entry script not found: " + $entry)
    exit 1
}
if (-not (Test-Path $workDir)) {
    L ("ABORT: working directory not found: " + $workDir)
    exit 1
}
# 2026-09-14: a restart must never pop the desktop browser.
# `dsh web` opens the default browser unless --no-open is on its command line, and
# the captured argv of the instance being restarted often carries no --no-open
# (tray auto-start / bare `dsh web`), so a phone-triggered restart opened a fresh
# 3080 tab on the desktop. Re-add it for web instances only; every other argv is
# relaunched verbatim.
if (($argList -contains 'web') -and ($argList -notcontains '--no-open')) {
    $argList = @($argList) + '--no-open'
    L 'appended --no-open to the relaunch line (restart never opens the desktop browser)'
}

L ("target port=" + $Port + " entry=" + $entry + " workDir=" + $workDir + " args=[" + ($argList -join ' ') + "] fromRequest=" + $fromRequest)

if ($DryRun) {
    L ("DRYRUN: would kill pid " + (Get-ListenerPid $Port) + " and spawn: " + $nodeExe + " " + $entry + " " + ($argList -join ' '))
    Write-Output ("DRYRUN port=" + $Port + " entry=" + $entry + " workDir=" + $workDir + " args=" + ($argList -join ' '))
    exit 0
}

# ---------------------------------------------------------------------------
# 2. stop the current listener on this port
# ---------------------------------------------------------------------------
$ownerPid = Get-ListenerPid $Port
if ($ownerPid) {
    L ("killing pid " + $ownerPid + " listening on " + $Port)
    Stop-Process -Id $ownerPid -Force
} else {
    L "no listener found; starting a fresh instance"
}

for ($i = 0; $i -lt 60; $i++) {
    if (-not (Get-ListenerPid $Port)) { break }
    Start-Sleep -Milliseconds 250
}
if (Get-ListenerPid $Port) { L "WARN: port still busy after kill; launching anyway" }

# ---------------------------------------------------------------------------
# 3. relaunch with the captured argv
# ---------------------------------------------------------------------------
$outLog = Join-Path $logDir 'dsh-web.log'
$errLog = Join-Path $logDir 'dsh-web.err.log'
if ($Port -ne 3080) {
    $outLog = Join-Path $logDir ("dsh-web-{0}.log" -f $Port)
    $errLog = Join-Path $logDir ("dsh-web-{0}.err.log" -f $Port)
}
if ((Test-Path $outLog) -and (Get-Item $outLog).Length -gt 10MB) {
    Move-Item $outLog ($outLog + '.1') -Force
}

$allArgs = @($entry) + $argList
$quoted = @()
foreach ($a in $allArgs) { $quoted += ('"' + [string]$a + '"') }
$argumentString = ($quoted -join ' ')
L ("spawning: " + $nodeExe + " " + $argumentString)
try {
    Start-Process -FilePath $nodeExe -ArgumentList $argumentString -WorkingDirectory $workDir -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog -ErrorAction Stop
} catch {
    L ("spawn failed: " + $_.Exception.Message)
}

# ---------------------------------------------------------------------------
# 4. verify the listener came back
# ---------------------------------------------------------------------------
$newPid = $null
for ($i = 0; $i -lt 80; $i++) {
    Start-Sleep -Milliseconds 500
    $newPid = Get-ListenerPid $Port
    if ($newPid) { break }
}
if ($newPid) {
    L ("listening pid=" + $newPid)
} else {
    L ("WARN: nothing listening on " + $Port + " after restart; see " + $errLog)
}
# ---------------------------------------------------------------------------
L "done"
