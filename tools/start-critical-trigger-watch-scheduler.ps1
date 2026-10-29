[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$workspace = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$expectedTools = [System.IO.Path]::GetFullPath((Join-Path $workspace "tools"))
$schedulerScript = [System.IO.Path]::GetFullPath((Join-Path $expectedTools "run-critical-trigger-watch-scheduler.js"))
$monitorDirectory = [System.IO.Path]::GetFullPath((Join-Path $workspace "reports\monitor"))
$lockPath = Join-Path $monitorDirectory "trigger-watch-scheduler.lock"
$healthPath = Join-Path $monitorDirectory "trigger-watch-scheduler.json"

function Read-StrictLock([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.PSIsContainer -or $item.Length -lt 1 -or $item.Length -gt 512) { throw "Malformed scheduler lock." }
    $value = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
    $names = @($value.PSObject.Properties.Name | Sort-Object)
    if (($names -join ',') -cne 'nonce,pid,startedAt' -or [string]$value.nonce -cnotmatch '^[0-9a-f]{32}$') { throw "Malformed scheduler lock." }
    $parsedPid = [int64]0
    if (-not [int64]::TryParse([string]$value.pid, [ref]$parsedPid) -or $parsedPid -lt 1) { throw "Malformed scheduler lock." }
    $parsedTime = [DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParseExact([string]$value.startedAt, "yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$parsedTime)) { throw "Malformed scheduler lock." }
    return $value
}

function Test-LivePid([int64]$Id) {
    return $null -ne (Get-Process -Id $Id -ErrorAction SilentlyContinue)
}

function Test-JsonInteger($Value) {
    return $Value -is [int32] -or $Value -is [int64]
}

function Test-NullableIsoTimestamp($Value) {
    if ($null -eq $Value) { return $true }
    if ($Value -isnot [string]) { return $false }
    $parsed = [DateTimeOffset]::MinValue
    return [DateTimeOffset]::TryParseExact($Value, "yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$parsed) `
        -and $parsed.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [Globalization.CultureInfo]::InvariantCulture) -ceq $Value
}

function Test-ExactJsonKeys($Value, [string]$Names) {
    return $Value -is [System.Management.Automation.PSCustomObject] -and (@($Value.PSObject.Properties.Name | Sort-Object) -join ',') -ceq $Names
}

function Test-NonnegativeSafeInteger($Value) {
    return (Test-JsonInteger $Value) -and $Value -ge 0 -and $Value -le 9007199254740991
}

function Test-StrictDaily($Value, [string]$ExpectedId, [bool]$HasReadOnly) {
    $names = 'annotations,durationMs,exitCode,freshness,generatedAt,id,lastAttemptAt,lastDueAt,nextDueAt,status'
    if ($HasReadOnly) { $names = 'annotations,durationMs,exitCode,freshness,generatedAt,id,lastAttemptAt,lastDueAt,nextDueAt,readOnly,status' }
    $statuses = @('NOT_DUE', 'INFLIGHT', 'INTERRUPTED', 'PASS', 'INCOMPLETE', 'FAILED', 'TIMEOUT', 'ARTIFACT_INVALID', 'NOT_INSTALLED')
    if (-not (Test-ExactJsonKeys $Value $names) -or $Value.id -isnot [string] -or $Value.id -cne $ExpectedId `
        -or $Value.status -isnot [string] -or $statuses -cnotcontains $Value.status `
        -or ($HasReadOnly -and ($Value.readOnly -isnot [bool] -or $Value.readOnly -ne $true)) `
        -or -not (Test-NullableIsoTimestamp $Value.lastDueAt) -or -not (Test-NullableIsoTimestamp $Value.lastAttemptAt) `
        -or $null -eq $Value.nextDueAt -or -not (Test-NullableIsoTimestamp $Value.nextDueAt) `
        -or -not (Test-NullableIsoTimestamp $Value.generatedAt) -or -not (Test-NonnegativeSafeInteger $Value.durationMs) `
        -or ($null -ne $Value.exitCode -and -not (Test-JsonInteger $Value.exitCode)) `
        -or $Value.freshness -isnot [string] -or $Value.annotations -isnot [array]) { return $false }
    foreach ($annotation in $Value.annotations) { if ($annotation -isnot [string]) { return $false } }
    # Match the scheduler's initial unclaimed state and durable UTC-midnight claim schemas.
    if ($null -eq $Value.lastDueAt -and $null -eq $Value.lastAttemptAt -and $Value.status -ceq 'NOT_DUE') { return $true }
    if ($null -eq $Value.lastDueAt -or $null -eq $Value.lastAttemptAt) { return $false }
    $due = [DateTimeOffset]::Parse($Value.lastDueAt)
    return $due.TimeOfDay -eq [TimeSpan]::Zero `
        -and [DateTimeOffset]::Parse($Value.lastAttemptAt) -ge $due `
        -and [DateTimeOffset]::Parse($Value.nextDueAt) -eq $due.AddDays(1)
}

function Test-StrictHealth([string]$Path, [int64]$ExpectedPid, [string]$ExpectedStartedAt) {
    try {
        $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.PSIsContainer -or $item.Length -lt 1 -or $item.Length -gt 1048576) { return $false }
        $rawHealth = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
        # Windows PowerShell unwraps a single-element JSON array; require an object root.
        if ($rawHealth -cnotmatch '^\s*\{') { return $false }
        $health = $rawHealth | ConvertFrom-Json -ErrorAction Stop
        $names = @($health.PSObject.Properties.Name | Sort-Object)
        if (($names -join ',') -cne 'a12Daily,aaveV3Daily,aaveV4BinderRefresh,cadenceSeconds,capabilityRotation,compoundV3Daily,cycle,discovery,discoveryCadenceSeconds,generatedAt,gmxDaily,morphoDaily,pid,producers,running,safety,schema,startedAt') { return $false }
        if (-not (Test-StrictDaily $health.a12Daily 'a12-h1-watch' $false) `
            -or -not (Test-StrictDaily $health.morphoDaily 'morpho-multi-pair-watch' $true) `
            -or -not (Test-StrictDaily $health.gmxDaily 'gmx-position-watch' $true) `
            -or -not (Test-StrictDaily $health.aaveV3Daily 'aave-v3-borrower-watch' $true) `
            -or -not (Test-StrictDaily $health.compoundV3Daily 'compound-v3-base-watch' $true)) { return $false }
        if ($health.schema -isnot [string] -or $health.running -isnot [bool] `
            -or -not (Test-NonnegativeSafeInteger $health.pid) -or $health.pid -lt 1 `
            -or -not (Test-JsonInteger $health.cadenceSeconds) -or -not (Test-JsonInteger $health.discoveryCadenceSeconds) `
            -or $null -eq $health.generatedAt -or -not (Test-NullableIsoTimestamp $health.generatedAt) `
            -or $null -eq $health.startedAt -or -not (Test-NullableIsoTimestamp $health.startedAt)) { return $false }
        if (-not (Test-ExactJsonKeys $health.safety 'automaticRetries,broadcast,localOnly,overlap,sequential,signing,transactionsInitiatedByScheduler')) { return $false }
        foreach ($flag in @('localOnly', 'sequential', 'overlap', 'signing', 'broadcast')) {
            if ($health.safety.$flag -isnot [bool]) { return $false }
        }
        if (-not (Test-JsonInteger $health.safety.automaticRetries) -or -not (Test-JsonInteger $health.safety.transactionsInitiatedByScheduler)) { return $false }
        if (-not (Test-ExactJsonKeys $health.cycle 'completedAt,sequence,startedAt,status') `
            -or -not (Test-NonnegativeSafeInteger $health.cycle.sequence) `
            -or $null -eq $health.cycle.startedAt -or -not (Test-NullableIsoTimestamp $health.cycle.startedAt) `
            -or $null -eq $health.cycle.completedAt -or -not (Test-NullableIsoTimestamp $health.cycle.completedAt) `
            -or $health.cycle.status -isnot [string] -or @('PASS', 'DEGRADED') -cnotcontains $health.cycle.status) { return $false }
        $discovery = $health.discovery
        if (-not (Test-ExactJsonKeys $discovery 'artifactPath,durationMs,exitCode,lastAttemptAt,nextDueAt,status') `
            -or $discovery.status -isnot [string] -or @('NOT_INSTALLED', 'NOT_DUE', 'PASS', 'FAILED', 'TIMEOUT', 'ARTIFACT_INVALID') -cnotcontains $discovery.status `
            -or -not (Test-NullableIsoTimestamp $discovery.lastAttemptAt) -or -not (Test-NullableIsoTimestamp $discovery.nextDueAt) `
            -or ($null -ne $discovery.exitCode -and -not (Test-JsonInteger $discovery.exitCode)) `
            -or -not (Test-NonnegativeSafeInteger $discovery.durationMs) `
            -or $discovery.artifactPath -isnot [string] -or $discovery.artifactPath.Length -lt 1 -or $discovery.artifactPath.Length -gt 256 `
            -or [IO.Path]::IsPathRooted($discovery.artifactPath) -or @($discovery.artifactPath -split '[\\/]') -contains '..') { return $false }
        $aaveRefreshNames = @($health.aaveV4BinderRefresh.PSObject.Properties.Name | Sort-Object)
        $aaveRefreshStatuses = @('NOT_DUE', 'NOT_INSTALLED', 'PASS', 'FAILED', 'TIMEOUT')
        if (($aaveRefreshNames -join ',') -cne 'durationMs,exitCode,lastAttemptAt,status' `
            -or $health.aaveV4BinderRefresh -isnot [System.Management.Automation.PSCustomObject] `
            -or $health.aaveV4BinderRefresh.status -isnot [string] `
            -or $aaveRefreshStatuses -cnotcontains [string]$health.aaveV4BinderRefresh.status `
            -or -not (Test-NullableIsoTimestamp $health.aaveV4BinderRefresh.lastAttemptAt) `
            -or -not (Test-NonnegativeSafeInteger $health.aaveV4BinderRefresh.durationMs) `
            -or [int64]$health.aaveV4BinderRefresh.durationMs -lt 0 `
            -or ($null -ne $health.aaveV4BinderRefresh.exitCode -and -not (Test-JsonInteger $health.aaveV4BinderRefresh.exitCode))) { return $false }
        if (([string]$health.aaveV4BinderRefresh.status -ceq 'PASS' `
                -and ($null -eq $health.aaveV4BinderRefresh.exitCode -or [int64]$health.aaveV4BinderRefresh.exitCode -ne 0 -or $null -eq $health.aaveV4BinderRefresh.lastAttemptAt)) `
            -or ([string]$health.aaveV4BinderRefresh.status -ceq 'NOT_DUE' `
                -and ($null -ne $health.aaveV4BinderRefresh.exitCode -or $null -ne $health.aaveV4BinderRefresh.lastAttemptAt)) `
            -or ([string]$health.aaveV4BinderRefresh.status -in @('FAILED', 'TIMEOUT', 'NOT_INSTALLED') `
                -and $null -eq $health.aaveV4BinderRefresh.lastAttemptAt) `
            -or ([string]$health.aaveV4BinderRefresh.status -ceq 'NOT_INSTALLED' -and $null -ne $health.aaveV4BinderRefresh.exitCode)) { return $false }
        $rotationNames = @($health.capabilityRotation.PSObject.Properties.Name | Sort-Object)
        $rotationStatuses = @('NOT_DUE', 'READY', 'INCOMPLETE', 'DEGRADED', 'FAILED', 'TIMEOUT')
        if (($rotationNames -join ',') -cne 'artifactPath,durationMs,exitCode,lastAttemptAt,nextDueAt,status' `
            -or $health.capabilityRotation -isnot [System.Management.Automation.PSCustomObject] `
            -or $health.capabilityRotation.artifactPath -isnot [string] -or $health.capabilityRotation.status -isnot [string] `
            -or [string]$health.capabilityRotation.artifactPath -cne 'reports/monitor/etherfi-optimism-provider-capability-rotation.json' `
            -or $rotationStatuses -cnotcontains [string]$health.capabilityRotation.status `
            -or -not (Test-NullableIsoTimestamp $health.capabilityRotation.lastAttemptAt) `
            -or -not (Test-NullableIsoTimestamp $health.capabilityRotation.nextDueAt) `
            -or -not (Test-NonnegativeSafeInteger $health.capabilityRotation.durationMs) `
            -or [int64]$health.capabilityRotation.durationMs -lt 0 `
            -or ($null -ne $health.capabilityRotation.exitCode -and -not (Test-JsonInteger $health.capabilityRotation.exitCode))) { return $false }
        if (($health.capabilityRotation.status -in @('READY', 'INCOMPLETE') -and ($null -eq $health.capabilityRotation.exitCode -or $health.capabilityRotation.exitCode -ne 0)) `
            -or ($health.capabilityRotation.status -ceq 'NOT_DUE' -and $null -ne $health.capabilityRotation.exitCode) `
            -or ($health.capabilityRotation.status -cne 'NOT_DUE' -and ($null -eq $health.capabilityRotation.lastAttemptAt -or $null -eq $health.capabilityRotation.nextDueAt)) `
            -or ($null -ne $health.capabilityRotation.lastAttemptAt -and $null -ne $health.capabilityRotation.nextDueAt `
                -and [DateTimeOffset]::Parse($health.capabilityRotation.nextDueAt) -lt [DateTimeOffset]::Parse($health.capabilityRotation.lastAttemptAt))) { return $false }
        $expectedProducerIds = @('valantis-stex', 'etherfi-debtmanager', 'lista-auction-incentive', 'aave-v3-arbitrum-config-oracle-events')
        $expectedArtifactPaths = @('reports/monitor/stex-profit-trigger.json', 'reports/monitor/etherfi-debtmanager-profit-trigger.json', 'reports/monitor/lista-auction-incentive-profit-trigger.json', 'reports/monitor/aave-v3-arbitrum-config-oracle-events.json')
        if ($health.producers -isnot [array]) { return $false }
        $producers = @($health.producers)
        if ($producers.Count -ne $expectedProducerIds.Count) { return $false }
        for ($index = 0; $index -lt $expectedProducerIds.Count; $index++) {
            if ($null -eq $producers[$index] -or [string]$producers[$index].id -cne $expectedProducerIds[$index]) { return $false }
            $row = $producers[$index]
            if (-not (Test-ExactJsonKeys $row 'artifactPath,durationMs,exitCode,generatedAt,id,status,triggerReason,triggerStatus') `
                -or $row.id -isnot [string] -or $row.artifactPath -isnot [string] -or $row.status -isnot [string] `
                -or $row.artifactPath -cne $expectedArtifactPaths[$index] `
                -or @('PASS', 'FAILED', 'TIMEOUT', 'ARTIFACT_INVALID') -cnotcontains $row.status `
                -or ($null -ne $row.exitCode -and -not (Test-JsonInteger $row.exitCode)) `
                -or -not (Test-NonnegativeSafeInteger $row.durationMs) -or -not (Test-NullableIsoTimestamp $row.generatedAt) `
                -or ($null -ne $row.triggerStatus -and $row.triggerStatus -isnot [string]) `
                -or ($null -ne $row.triggerReason -and $row.triggerReason -isnot [string]) `
                -or ($row.status -ceq 'PASS' -and ($null -eq $row.exitCode -or $row.exitCode -ne 0 -or $null -eq $row.triggerStatus -or $null -eq $row.generatedAt))) { return $false }
        }
        return ([string]$health.schema -ceq 'trigger-watch-scheduler/v1' -and [int]$health.cadenceSeconds -eq 900 `
            -and [int]$health.discoveryCadenceSeconds -eq 21600 -and [bool]$health.running `
            -and [int64]$health.pid -eq $ExpectedPid -and [string]$health.startedAt -ceq $ExpectedStartedAt `
            -and [bool]$health.safety.localOnly -and [bool]$health.safety.sequential `
            -and -not [bool]$health.safety.overlap -and [int]$health.safety.automaticRetries -eq 0 `
            -and [int]$health.safety.transactionsInitiatedByScheduler -eq 0 -and -not [bool]$health.safety.signing -and -not [bool]$health.safety.broadcast)
    }
    catch { return $false }
}

if (-not (Test-Path -LiteralPath $workspace -PathType Container) -or $expectedTools -cne [System.IO.Path]::GetFullPath($PSScriptRoot)) { throw "Workspace parent/path verification failed." }
if (-not (Test-Path -LiteralPath $schedulerScript -PathType Leaf) -or -not (Test-Path -LiteralPath $monitorDirectory -PathType Container)) { throw "Scheduler workspace files are unavailable." }
if ((Get-Item -LiteralPath $schedulerScript -Force).Directory.FullName -cne $expectedTools) { throw "Scheduler path verification failed." }

if (Test-Path -LiteralPath $lockPath) {
    $existing = Read-StrictLock $lockPath
    if (Test-LivePid ([int64]$existing.pid)) { throw "ALREADY_RUNNING" }
}

$nodeCommands = @(Get-Command node.exe -CommandType Application -ErrorAction Stop)
if ($nodeCommands.Count -ne 1) { throw "Ambiguous Node command." }
$nodePath = [System.IO.Path]::GetFullPath($nodeCommands[0].Source)
if ([System.IO.Path]::GetFileName($nodePath) -ine "node.exe") { throw "Unsafe Node command." }
$arguments = @($schedulerScript, "--daemon")
$savedNodeOptions = [Environment]::GetEnvironmentVariable("NODE_OPTIONS", "Process")
$savedNodePath = [Environment]::GetEnvironmentVariable("NODE_PATH", "Process")
$started = $null
try {
    [Environment]::SetEnvironmentVariable("NODE_OPTIONS", $null, "Process")
    [Environment]::SetEnvironmentVariable("NODE_PATH", $null, "Process")
    $started = Start-Process -FilePath $nodePath -ArgumentList $arguments -WorkingDirectory $workspace -WindowStyle Hidden -PassThru
}
finally {
    [Environment]::SetEnvironmentVariable("NODE_OPTIONS", $savedNodeOptions, "Process")
    [Environment]::SetEnvironmentVariable("NODE_PATH", $savedNodePath, "Process")
}

$verified = $false
try {
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    while ([DateTime]::UtcNow -lt $deadline) {
        $started.Refresh()
        if ($started.HasExited) { throw "Scheduler exited during startup." }
        if (Test-Path -LiteralPath $lockPath -PathType Leaf) {
            $owner = Read-StrictLock $lockPath
            if ([int64]$owner.pid -eq [int64]$started.Id -and (Test-LivePid ([int64]$owner.pid)) `
                -and (Test-Path -LiteralPath $healthPath -PathType Leaf) `
                -and (Test-StrictHealth $healthPath ([int64]$owner.pid) ([string]$owner.startedAt))) {
                $verified = $true
                break
            }
        }
        Start-Sleep -Milliseconds 100
    }
    if (-not $verified) { throw "Scheduler health/lock startup verification timed out." }
    [Console]::Out.WriteLine([string]$started.Id)
}
catch {
    if ($null -ne $started) {
        $started.Refresh()
        if (-not $started.HasExited) { Stop-Process -Id $started.Id -ErrorAction SilentlyContinue }
    }
    throw
}
