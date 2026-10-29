[CmdletBinding()]
param([switch]$Apply)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'hidden-launch-action.ps1')
$script:DashboardWorkspace = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$script:DashboardRunner = Join-Path $PSScriptRoot 'run-dashboard-task.py'

function Get-DashboardPythonPath {
    # Resolve the currently selected interpreter, but refuse PATH shims, UNC
    # executables and arbitrary checkout binaries. No interpreter is downloaded.
    $command = @(Get-Command 'python.exe' -CommandType Application -ErrorAction Stop)[0]
    $python = [IO.Path]::GetFullPath([string]$command.Source)
    $roots = @(
        (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Programs\Python'),
        [Environment]::GetFolderPath('ProgramFiles'),
        [Environment]::GetFolderPath('ProgramFilesX86')
    ) | Where-Object { $_ -ne '' }
    $trusted = $false
    foreach ($root in $roots) {
        if ($python -match ('(?i)^' + [regex]::Escape($root.TrimEnd('\')) + '\\Python3[0-9]+(?:-[0-9]+)?\\python\.exe$')) { $trusted = $true }
    }
    if (-not $trusted -or $python -notmatch '^[A-Za-z]:\\' -or -not [IO.File]::Exists($python)) { throw 'TASK_PYTHON_UNVERIFIED' }
    return $python
}

function Get-DashboardAccountSid {
    return [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
}

function Resolve-DashboardAccountSid {
    param([string]$UserId)
    try {
        if ($UserId -match '^S-[0-9]+(?:-[0-9]+)+$') { return ([Security.Principal.SecurityIdentifier]::new($UserId)).Value }
        return ([Security.Principal.NTAccount]::new($UserId).Translate([Security.Principal.SecurityIdentifier])).Value
    } catch { throw 'TASK_PRINCIPAL_MISMATCH' }
}

function Get-DashboardFixedTask {
    try { $tasks = @(Get-ScheduledTask -TaskName 'EVMAuditDashboard' -TaskPath '\' -ErrorAction Stop) }
    catch {
        # An access/inspection error is not evidence that registration is safe.
        if ($_.FullyQualifiedErrorId -like 'CmdletizationQuery_NotFound_TaskName*' -or
            $_.FullyQualifiedErrorId -ceq 'CmdletizationQuery_NotFound,Get-ScheduledTask') { return $null }
        throw 'TASK_INSPECTION_FAILED'
    }
    if ($tasks.Count -eq 0) { return $null }
    if ($tasks.Count -ne 1 -or $tasks[0].TaskName -cne 'EVMAuditDashboard' -or $tasks[0].TaskPath -cne '\') { throw 'TASK_IDENTITY_MISMATCH' }
    return $tasks[0]
}

function Get-DashboardArguments {
    return '-E -B "{0}"' -f $script:DashboardRunner
}

function Test-DashboardZeroDuration {
    param([string]$Value)
    return $Value -ceq '' -or $Value -ceq 'PT0S'
}

function Assert-DashboardTaskIdentity {
    param($Task, [string]$Python, [string]$AccountSid, [string]$CreatedStart = '')
    if ($Task.TaskName -cne 'EVMAuditDashboard' -or $Task.TaskPath -cne '\') { throw 'TASK_IDENTITY_MISMATCH' }
    if (@($Task.Actions).Count -ne 1) { throw 'TASK_ACTION_MISMATCH' }
    Assert-HiddenLaunchAction -Action @($Task.Actions)[0] -Executable $Python -Arguments (Get-DashboardArguments) -WorkingDirectory $script:DashboardWorkspace
    $principal = $Task.Principal
    if ((Resolve-DashboardAccountSid ([string]$principal.UserId)) -cne $AccountSid -or
        [string]$principal.LogonType -cnotin @('Interactive', '3') -or [string]$principal.RunLevel -cnotin @('Limited', '0') -or
        [string]$principal.GroupId -cne '') { throw 'TASK_PRINCIPAL_MISMATCH' }
    if ($principal.PSObject.Properties['RequiredPrivilege'] -and @($principal.RequiredPrivilege | Where-Object { $_ }).Count -gt 0) { throw 'TASK_PRINCIPAL_MISMATCH' }
    if ($principal.PSObject.Properties['ProcessTokenSidType'] -and [string]$principal.ProcessTokenSidType -cnotin @('Default', '0')) { throw 'TASK_PRINCIPAL_MISMATCH' }
    $settings = $Task.Settings
    if (-not [bool]$settings.Enabled -or [string]$Task.State -eq 'Disabled' -or
        [string]$settings.MultipleInstances -cnotin @('IgnoreNew', '2') -or [string]$settings.ExecutionTimeLimit -cne 'PT0S' -or
        -not [bool]$settings.StartWhenAvailable -or [bool]$settings.WakeToRun -or [bool]$settings.RunOnlyIfIdle -or
        [bool]$settings.RunOnlyIfNetworkAvailable -or [int]$settings.RestartCount -ne 0) { throw 'TASK_SETTINGS_MISMATCH' }
    $triggers = @($Task.Triggers)
    if ($triggers.Count -ne 2) { throw 'TASK_TRIGGER_MISMATCH' }
    $logons = @($triggers | Where-Object { $_.CimClass.CimClassName -ceq 'MSFT_TaskLogonTrigger' })
    $periodic = @($triggers | Where-Object { $_.CimClass.CimClassName -ceq 'MSFT_TaskTimeTrigger' })
    if ($logons.Count -ne 1 -or $periodic.Count -ne 1) { throw 'TASK_TRIGGER_MISMATCH' }
    foreach ($trigger in $triggers) {
        if (-not [bool]$trigger.Enabled -or [string]$trigger.EndBoundary -cne '' -or -not (Test-DashboardZeroDuration ([string]$trigger.ExecutionTimeLimit))) { throw 'TASK_TRIGGER_MISMATCH' }
    }
    $logon = $logons[0]; $repeat = $periodic[0]
    if ((Resolve-DashboardAccountSid ([string]$logon.UserId)) -cne $AccountSid -or [string]$logon.StartBoundary -cne '' -or
        -not (Test-DashboardZeroDuration ([string]$logon.Delay))) { throw 'TASK_TRIGGER_MISMATCH' }
    if ($null -ne $logon.Repetition -and ([string]$logon.Repetition.Interval -cne '' -or [string]$logon.Repetition.Duration -cne '' -or [bool]$logon.Repetition.StopAtDurationEnd)) { throw 'TASK_TRIGGER_MISMATCH' }
    if ($null -eq $repeat.Repetition -or [string]$repeat.Repetition.Interval -cne 'PT1M' -or
        [string]$repeat.Repetition.Duration -cne '' -or [bool]$repeat.Repetition.StopAtDurationEnd -or
        -not (Test-DashboardZeroDuration ([string]$repeat.RandomDelay))) { throw 'TASK_TRIGGER_MISMATCH' }
    $start = [DateTimeOffset]::MinValue
    if ([string]$repeat.StartBoundary -notmatch '^\d{4}-\d{2}-\d{2}T' -or -not [DateTimeOffset]::TryParse([string]$repeat.StartBoundary, [ref]$start) -or $start -gt [DateTimeOffset]::Now.AddMinutes(2)) { throw 'TASK_TRIGGER_MISMATCH' }
    if ($CreatedStart -cne '' -and $start -ne [DateTimeOffset]::Parse($CreatedStart)) { throw 'TASK_TRIGGER_MISMATCH' }
}

function Invoke-DashboardTaskInstall {
    param([switch]$Apply)
    $status = 'refused'; $reason = 'TASK_INSPECTION_FAILED'
    try {
        if (-not [IO.File]::Exists($script:DashboardRunner) -or -not [IO.File]::Exists((Join-Path $script:DashboardWorkspace 'dashboard\__main__.py'))) { throw 'TASK_WORKSPACE_UNVERIFIED' }
        $python = Get-DashboardPythonPath
        $sid = Get-DashboardAccountSid
        $existing = Get-DashboardFixedTask
        if ($null -ne $existing) {
            Assert-DashboardTaskIdentity $existing $python $sid
            $status = 'unchanged'; $reason = 'TASK_DASHBOARD_ALREADY_INSTALLED'
        } elseif (-not $Apply) {
            # Even dry-run verifies the shared hidden launcher and fixed paths.
            [void](New-HiddenLaunchSpec -Executable $python -Arguments (Get-DashboardArguments) -WorkingDirectory $script:DashboardWorkspace)
            $status = 'would-register'; $reason = 'TASK_DASHBOARD_INSTALL_VERIFIED'
        } else {
            $action = New-HiddenScheduledTaskAction -Executable $python -Arguments (Get-DashboardArguments) -WorkingDirectory $script:DashboardWorkspace
            $logon = New-ScheduledTaskTrigger -AtLogOn -User $sid
            $repeat = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1)) -RepetitionInterval (New-TimeSpan -Minutes 1)
            $repeat.Repetition.Duration = ''; $repeat.Repetition.StopAtDurationEnd = $false
            $logon.EndBoundary = ''; $repeat.EndBoundary = ''
            $logon.ExecutionTimeLimit = 'PT0S'; $repeat.ExecutionTimeLimit = 'PT0S'
            $principal = New-ScheduledTaskPrincipal -UserId $sid -LogonType Interactive -RunLevel Limited
            # Battery defaults are left intact. No WakeToRun, elevation, password,
            # S4U, service principal, global power change or explicit task start.
            $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
            if ($null -ne (Get-DashboardFixedTask)) { throw 'TASK_CHANGED_DURING_INSPECTION' }
            try {
                # No -Force: a concurrent same-name registration cannot be replaced.
                Register-ScheduledTask -TaskName 'EVMAuditDashboard' -TaskPath '\' -Action $action -Trigger @($logon, $repeat) -Principal $principal -Settings $settings -ErrorAction Stop | Out-Null
            } catch { throw 'TASK_REGISTER_FAILED_ATTENDED_INSPECTION' }
            try {
                $installed = Get-DashboardFixedTask
                if ($null -eq $installed) { throw 'TASK_IDENTITY_MISMATCH' }
                Assert-DashboardTaskIdentity $installed $python $sid ([string]$repeat.StartBoundary)
            } catch {
                # Never delete/replace an uncertain or concurrently changed task.
                # There is no automatic rollback, Start, Stop or process control.
                throw 'TASK_POSTVALIDATION_FAILED_ATTENDED_INSPECTION'
            }
            $status = 'registered'; $reason = 'TASK_DASHBOARD_INSTALL_VERIFIED'
        }
    } catch {
        $reason = [string]$_.Exception.Message
        if ($reason -notmatch '^TASK_[A-Z_]+$') { $reason = 'TASK_INSPECTION_FAILED' }
    }
    # Allowlisted report, never a raw action, encoded payload, path or user SID.
    [pscustomobject]@{
        taskName = 'EVMAuditDashboard'; taskPath = '\'; status = $status; reason = $reason
        configuration = $(if ($status -cin @('registered', 'unchanged')) { 'VERIFIED' } elseif ($status -ceq 'would-register') { 'PROPOSED' } else { 'EXPECTED_UNVERIFIED' })
        purpose = 'LOOPBACK_DASHBOARD_VIEWER_ONLY'; account = 'CURRENT_ACCOUNT'; logonType = 'Interactive'; runLevel = 'Limited'
        hiddenSynchronous = $true; atLogon = $true; repeatInterval = 'PT1M'; repeatDuration = $null; endBoundary = $null
        multipleInstances = 'IgnoreNew'; startWhenAvailable = $true; executionTimeLimit = 'PT0S'; wakeToRun = $false
        portOccupiedPolicy = 'DEFER_WITHOUT_PROCESS_CONTROL'; taskStartRequested = $false
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    $result = Invoke-DashboardTaskInstall -Apply:$Apply
    $result | ConvertTo-Json -Compress
    if ($result.status -ceq 'refused') { exit 1 }
}
