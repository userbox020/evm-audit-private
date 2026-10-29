# manage-novelty-refresh-task.ps1
#
# Owns ONE self-contained scheduled task that periodically refreshes the seven novelty-pattern
# scanner artifacts consumed by the `novelty-patterns` condition and the `fresh-noveltyState` gate.
# Deliberately standalone: neither tools/monitor-set-autostart.cmd nor tools/monitor-service-manifest.js
# is touched, so the task does not become part of the 13-line read-only monitor set.
#
# Follows the proven tools/manage-kamino-reduced-status-task.ps1 pattern: a dedicated logon-triggered
# task running a bounded runner from the workspace root, with a 6 h repetition interval so the
# artifacts stay well inside their 24 h freshness window.
#
# Modes: Preflight | Install | Status | RunNow | Uninstall
#
# Read-only. No signing, no transaction, no state change. Endpoint material stays process-only.
#
# NOTE: registering a scheduled task on this host requires elevation. A non-elevated Install fails
# closed with TASK_REGISTER_ACCESS_DENIED_ELEVATION_REQUIRED. The user runs Install from an elevated
# PowerShell. RunNow/Status/Preflight work without elevation.

[CmdletBinding()]
param(
    [ValidateSet('Preflight', 'Install', 'Status', 'RunNow', 'Uninstall')]
    [string]$Mode = 'Preflight'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$TaskName = 'EVMAuditMonitorNoveltyRefresh'
$IntervalHours = 6
$RunnerRel = 'tools\refresh-novelty-patterns.js'
$WorkspacePath = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$RunnerPath = [System.IO.Path]::GetFullPath((Join-Path $WorkspacePath $RunnerRel))

function Write-Json {
    param([hashtable]$Value)
    [Console]::Out.WriteLine(($Value | ConvertTo-Json -Compress -Depth 6))
}

function Get-VerifiedNodePath {
    $cmd = Get-Command 'node.exe' -CommandType Application -ErrorAction Stop
    $resolved = [System.IO.Path]::GetFullPath($cmd.Source)
    if (-not [System.IO.File]::Exists($resolved)) { throw 'NODE_PATH_INVALID' }
    return $resolved
}

function Assert-LocalPaths {
    if (-not [System.IO.Directory]::Exists($WorkspacePath)) { throw 'WORKSPACE_INVALID' }
    if (-not [System.IO.File]::Exists($RunnerPath)) { throw 'RUNNER_PATH_INVALID' }
    [void](Get-VerifiedNodePath)
}

function Get-TaskActionArgument {
    # Mirrors the kamino/venus-team preamble: clear NODE_OPTIONS/NODE_PATH, assert the minimal
    # monitor environment, then run the bounded sequential refresher.
    return ('/c "(set NODE_OPTIONS=) & (set NODE_PATH=) & ' +
        '(for /f "delims=" %V in (''node tools\monitor-minimal-env.js --names-to-clear'') do set "%V=") & ' +
        '(node tools\monitor-minimal-env.js --assert-current >nul 2>&1 || exit /b 1) & ' +
        '(node ' + $RunnerRel + ')"')
}

function New-RefreshTriggers {
    # Logon trigger for a normal session start, plus a repeating 6 h trigger so a long-running
    # session (the exact failure mode that expired the startup artifacts) still refreshes.
    $atLogon = New-ScheduledTaskTrigger -AtLogOn
    $repeating = New-ScheduledTaskTrigger -Once -At (Get-Date) `
        -RepetitionInterval (New-TimeSpan -Hours $IntervalHours) `
        -RepetitionDuration ([TimeSpan]::MaxValue)
    return @($atLogon, $repeating)
}

function Invoke-Preflight {
    Assert-LocalPaths
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Write-Json @{
        ok = $true; mode = 'Preflight'; taskName = $TaskName
        workspaceVerified = $true; runnerVerified = $true; nodeVerified = $true
        intervalHours = $IntervalHours
        taskInstalled = ($null -ne $task)
        elevationRequiredForInstall = $true
        taskChanged = $false; childExecuted = $false; networkRead = $false
    }
}

function Invoke-Install {
    Assert-LocalPaths
    $nodeExe = Get-VerifiedNodePath
    $cmdExe = Join-Path ([System.Environment]::SystemDirectory) 'cmd.exe'
    $argument = Get-TaskActionArgument

    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($null -ne $existing) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }

    $action = New-ScheduledTaskAction -Execute $cmdExe -Argument $argument -WorkingDirectory $WorkspacePath
    $triggers = New-RefreshTriggers
    $principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)

    try {
        $registered = Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Principal $principal -Settings $settings
    } catch {
        $detail = [string]$_.Exception.Message
        if ($detail -match 'Access is denied') { throw 'TASK_REGISTER_ACCESS_DENIED_ELEVATION_REQUIRED' }
        throw 'TASK_REGISTER_FAILED'
    }

    # Post-validation: only our exact action may exist.
    $check = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($null -eq $check) { throw 'TASK_POSTVALIDATION_MISSING' }
    $acts = @($check.Actions)
    if ($acts.Count -ne 1) { throw 'TASK_POSTVALIDATION_ACTION_COUNT' }
    if (-not [string]::Equals([string]$acts[0].Execute, $cmdExe, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'TASK_POSTVALIDATION_EXECUTE' }
    if ([string]$acts[0].Arguments -ne $argument) { throw 'TASK_POSTVALIDATION_ARGUMENT' }

    Write-Json @{
        ok = $true; mode = 'Install'; taskName = $TaskName; enabled = [bool]$check.Settings.Enabled
        state = [string]$check.State; intervalHours = $IntervalHours; trigger = 'AtLogOn+6h'
        registered = ($null -ne $registered)
    }
}

function Invoke-Status {
    Assert-LocalPaths
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($null -eq $task) {
        Write-Json @{ ok = $true; mode = 'Status'; taskName = $TaskName; installed = $false; enabled = $false; state = 'Absent'; lastResult = $null }
        return
    }
    $info = Get-ScheduledTaskInfo -TaskName $TaskName
    $acts = @($task.Actions)
    Write-Json @{
        ok = $true; mode = 'Status'; taskName = $TaskName; installed = $true
        enabled = [bool]$task.Settings.Enabled; state = [string]$task.State
        lastRunTime = if ($info.LastRunTime) { $info.LastRunTime.ToString('o') } else { $null }
        lastResult = [int64]$info.LastTaskResult
        nextRunTime = if ($info.NextRunTime) { $info.NextRunTime.ToString('o') } else { $null }
        actionExecute = if ($acts.Count -ge 1) { [string]$acts[0].Execute } else { $null }
        actionArgument = if ($acts.Count -ge 1) { [string]$acts[0].Arguments } else { $null }
    }
}

function Invoke-RunNow {
    Assert-LocalPaths
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($null -eq $task) { throw 'TASK_NOT_FOUND' }
    Start-ScheduledTask -TaskName $TaskName
    Start-Sleep -Seconds 2
    $after = Get-ScheduledTask -TaskName $TaskName
    Write-Json @{ ok = $true; mode = 'RunNow'; taskName = $TaskName; state = [string]$after.State; started = $true }
}

function Invoke-Uninstall {
    Assert-LocalPaths
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($null -eq $task) { throw 'TASK_NOT_FOUND' }
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Json @{ ok = $true; mode = 'Uninstall'; taskName = $TaskName; deleted = $true }
}

try {
    switch ($Mode) {
        'Preflight' { Invoke-Preflight }
        'Install' { Invoke-Install }
        'Status' { Invoke-Status }
        'RunNow' { Invoke-RunNow }
        'Uninstall' { Invoke-Uninstall }
    }
}
catch {
    $code = [string]$_.Exception.Message
    if ($code -notmatch '^[A-Z][A-Z0-9_]+$') { $code = 'MANAGER_FAILED_CLOSED' }
    Write-Json @{ ok = $false; mode = $Mode; code = $code }
    exit 1
}
