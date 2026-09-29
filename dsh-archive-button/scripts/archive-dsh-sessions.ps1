<#
    DSH session archive tool.
    Moves stale DSH session folders (not touched for N days) into zip archives.

    Source : %USERPROFILE%\.dsh\sessions\<workspace>\<session-id>\session.jsonl.zstd
    Target : <DSH_ROOT>\archive\dsh-sessions\<workspace>\<yyyy-MM>\<session-id>.zip

    A session folder is deleted ONLY after the zip is reopened and byte-verified.
    Restore with restore-dsh-session.ps1.

    Writes a machine-readable result JSON (-ResultFile) for the sidebar button plugin.

    Usage:
      powershell -NoProfile -ExecutionPolicy Bypass -File archive-dsh-sessions.ps1 -DryRun
      powershell -NoProfile -ExecutionPolicy Bypass -File archive-dsh-sessions.ps1 -Force
      powershell -NoProfile -ExecutionPolicy Bypass -File archive-dsh-sessions.ps1 -DaysOld 14 -Force
#>
[CmdletBinding()]
param(
    [int]$DaysOld = 3,
    [string]$SessionsRoot = (Join-Path $env:USERPROFILE '.dsh\sessions'),
    [string]$ArchiveRoot = $(if ($env:DSH_ROOT) { Join-Path $env:DSH_ROOT 'archive\dsh-sessions' } else { Join-Path $env:USERPROFILE 'DeepSeek_harness\archive\dsh-sessions' }),
    [string]$LogFile = $(if ($env:DSH_ROOT) { Join-Path $env:DSH_ROOT 'logs\dsh-session-archive.log' } else { Join-Path $env:USERPROFILE 'DeepSeek_harness\logs\dsh-session-archive.log' }),
    [string]$ResultFile = (Join-Path $ArchiveRoot '.last-result.json'),
    [int]$MinIntervalDays = 1,
    [switch]$Force,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 needs BOTH assemblies: FileSystem alone leaves
# [System.IO.Compression.ZipArchiveMode] unresolvable ("cannot find type").
Add-Type -AssemblyName System.IO.Compression | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null

$logDir = Split-Path -Parent $LogFile
if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
if (-not (Test-Path -LiteralPath $ArchiveRoot)) { New-Item -ItemType Directory -Path $ArchiveRoot -Force | Out-Null }
$stateFile = Join-Path $ArchiveRoot '.last-run.txt'
$pendingCsv = Join-Path (Split-Path -Parent $LogFile) 'dsh-session-archive-pending.csv'

function Write-Log {
    param([string]$Message)
    # Cap the log at 1 MB (2026-09-11): rotate to <log>.1 once it grows past that,
    # so an append-only log can never grow without bound.
    if (Test-Path -LiteralPath $LogFile) {
        if ((Get-Item -LiteralPath $LogFile).Length -gt 1MB) {
            Move-Item -LiteralPath $LogFile -Destination ($LogFile + '.1') -Force
        }
    }
    $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8
    Write-Host $line
}

function Write-Result {
    param([hashtable]$Data)
    try {
        $json = $Data | ConvertTo-Json -Depth 6 -Compress
        [System.IO.File]::WriteAllText($ResultFile, $json, (New-Object System.Text.UTF8Encoding($false)))
    }
    catch { Write-Log ('WARN result file not written: ' + $_.Exception.Message) }
}

function New-SessionZip {
    param([string]$SessionDir, [string]$ZipPath)
    $tmp = $ZipPath + '.tmp'
    if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force }
    $parent = Split-Path -Parent $ZipPath
    if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }

    $base = Split-Path -Leaf $SessionDir
    $files = Get-ChildItem -LiteralPath $SessionDir -Recurse -File -Force
    # source is already zstd-compressed: store without re-compression (fast, lossless container)
    $zip = [System.IO.Compression.ZipFile]::Open($tmp, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($f in $files) {
            $rel = $f.FullName.Substring($SessionDir.Length).TrimStart('\') -replace '\\', '/'
            $entryName = $base + '/' + $rel
            [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                $zip, $f.FullName, $entryName, [System.IO.Compression.CompressionLevel]::NoCompression)
        }
    }
    finally { $zip.Dispose() }
    Move-Item -LiteralPath $tmp -Destination $ZipPath -Force
}

function Test-SessionZip {
    param([string]$SessionDir, [string]$ZipPath)
    if (-not (Test-Path -LiteralPath $ZipPath)) { return $false }
    $src = Get-ChildItem -LiteralPath $SessionDir -Recurse -File -Force
    $srcCount = @($src).Count
    $srcBytes = ($src | Measure-Object Length -Sum).Sum
    if ($null -eq $srcBytes) { $srcBytes = 0 }

    $zip = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
    try {
        $entryCount = @($zip.Entries).Count
        $entryBytes = ($zip.Entries | Measure-Object Length -Sum).Sum
        if ($null -eq $entryBytes) { $entryBytes = 0 }
    }
    finally { $zip.Dispose() }

    return (($entryCount -eq $srcCount) -and ($entryBytes -eq $srcBytes))
}

$startedAt = Get-Date

if (-not (Test-Path -LiteralPath $SessionsRoot)) {
    Write-Log ('ERROR sessions root not found: ' + $SessionsRoot)
    Write-Result @{ mode = 'error'; error = 'sessions-root-missing'; root = $SessionsRoot; finishedAt = (Get-Date).ToString('o') }
    exit 1
}

if (-not $DryRun -and -not $Force -and (Test-Path -LiteralPath $stateFile)) {
    $raw = [System.IO.File]::ReadAllText($stateFile).Trim()
    $last = [datetime]::MinValue
    if ([datetime]::TryParse($raw, [ref]$last)) {
        $age = ((Get-Date) - $last).TotalDays
        if ($age -lt $MinIntervalDays) {
            Write-Log ('SKIP last archive run was {0:N2} days ago (min interval {1} days)' -f $age, $MinIntervalDays)
            Write-Result @{ mode = 'skipped'; reason = 'min-interval'; lastRun = $raw; daysSince = [math]::Round($age, 2); finishedAt = (Get-Date).ToString('o') }
            exit 0
        }
    }
}

$cutoff = (Get-Date).AddDays(-$DaysOld)
$mode = if ($DryRun) { 'DRYRUN' } else { 'ARCHIVE' }
Write-Log ('START mode={0} daysOld={1} cutoff={2}' -f $mode, $DaysOld, $cutoff.ToString('yyyy-MM-dd HH:mm:ss'))

$pending = New-Object System.Collections.Generic.List[object]
$skipped = 0
$empty = 0

foreach ($ws in (Get-ChildItem -LiteralPath $SessionsRoot -Directory -Force)) {
    foreach ($sd in (Get-ChildItem -LiteralPath $ws.FullName -Directory -Force)) {
        $files = Get-ChildItem -LiteralPath $sd.FullName -Recurse -File -Force
        if (@($files).Count -eq 0) { $empty++; continue }
        $newest = ($files | Sort-Object LastWriteTime -Descending | Select-Object -First 1).LastWriteTime
        if ($newest -gt $cutoff) { $skipped++; continue }
        $bytes = ($files | Measure-Object Length -Sum).Sum
        if ($null -eq $bytes) { $bytes = 0 }
        $pending.Add([pscustomobject]@{
            Workspace = $ws.Name
            Session   = $sd.Name
            SourceDir = $sd.FullName
            LastWrite = $newest
            Bytes     = [int64]$bytes
        })
    }
}

$totalBytes = ($pending | Measure-Object Bytes -Sum).Sum
if ($null -eq $totalBytes) { $totalBytes = 0 }
Write-Log ('SCAN candidates={0} skippedActive={1} emptyDirs={2} totalMB={3}' -f $pending.Count, $skipped, $empty, [math]::Round($totalBytes / 1MB, 1))

$pending | Sort-Object LastWrite | Select-Object Workspace, Session, LastWrite, @{n = 'MB'; e = { [math]::Round($_.Bytes / 1MB, 2) } } |
    Export-Csv -LiteralPath $pendingCsv -NoTypeInformation -Encoding UTF8
Write-Log ('LIST written: ' + $pendingCsv)

$byWs = @()
foreach ($g in ($pending | Group-Object Workspace)) {
    $gb = ($g.Group | Measure-Object Bytes -Sum).Sum
    if ($null -eq $gb) { $gb = 0 }
    $byWs += @{ name = $g.Name; count = $g.Count; mb = [math]::Round($gb / 1MB, 1) }
}

if ($DryRun) {
    $byMonth = $pending | Group-Object { '{0} | {1}' -f $_.Workspace, $_.LastWrite.ToString('yyyy-MM') } |
        Sort-Object Name | ForEach-Object {
            '{0}  count={1}  MB={2}' -f $_.Name, $_.Count, [math]::Round((($_.Group | Measure-Object Bytes -Sum).Sum) / 1MB, 1)
        }
    foreach ($l in $byMonth) { Write-Log ('PENDING ' + $l) }
    Write-Result @{
        mode = 'scan'; candidates = $pending.Count; skippedActive = $skipped; emptyDirs = $empty
        totalMB = [math]::Round($totalBytes / 1MB, 1); byWorkspace = $byWs; daysOld = $DaysOld
        finishedAt = (Get-Date).ToString('o')
    }
    Write-Log 'DRYRUN finished, nothing moved'
    exit 0
}

$archived = 0
$failed = 0
$movedBytes = 0

foreach ($item in $pending) {
    $stamp = $item.LastWrite.ToString('yyyy-MM')
    $zipPath = Join-Path (Join-Path (Join-Path $ArchiveRoot $item.Workspace) $stamp) ($item.Session + '.zip')
    try {
        New-SessionZip -SessionDir $item.SourceDir -ZipPath $zipPath
        if (Test-SessionZip -SessionDir $item.SourceDir -ZipPath $zipPath) {
            Remove-Item -LiteralPath $item.SourceDir -Recurse -Force
            $archived++
            $movedBytes += $item.Bytes
            Write-Log ('OK archived {0}/{1} ({2} MB) -> {3}' -f $item.Workspace, $item.Session, [math]::Round($item.Bytes / 1MB, 2), $zipPath)
        }
        else {
            $failed++
            if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
            Write-Log ('ERROR verify failed, source kept: {0}/{1}' -f $item.Workspace, $item.Session)
        }
    }
    catch {
        $failed++
        Write-Log ('ERROR {0}/{1}: {2}' -f $item.Workspace, $item.Session, $_.Exception.Message)
    }
}

Write-Log ('DONE archived={0} failed={1} freedMB={2}' -f $archived, $failed, [math]::Round($movedBytes / 1MB, 1))
Write-Result @{
    mode = 'archive'; candidates = $pending.Count; archived = $archived; failed = $failed
    freedMB = [math]::Round($movedBytes / 1MB, 1); skippedActive = $skipped; byWorkspace = $byWs
    daysOld = $DaysOld; startedAt = $startedAt.ToString('o'); finishedAt = (Get-Date).ToString('o')
}
[System.IO.File]::WriteAllText($stateFile, (Get-Date).ToString('o'), (New-Object System.Text.UTF8Encoding($false)))

if ($failed -gt 0) { exit 1 }
exit 0
