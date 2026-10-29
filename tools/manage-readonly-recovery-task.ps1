[CmdletBinding()]
param([switch]$Apply)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'hidden-launch-action.ps1')
. (Join-Path $PSScriptRoot 'manage-dashboard-task.ps1') -Apply:$Apply
$script:ReadOnlyRecoveryRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$script:ReadOnlyRecoveryRunner = Join-Path $PSScriptRoot 'run-readonly-recovery.ps1'

function Get-ReadOnlyRecoveryTaskHost {
    $hostPath = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe'
    if (-not [IO.File]::Exists($hostPath)) { throw 'TASK_HOST_UNVERIFIED' }
    return $hostPath
}
function Get-ReadOnlyRecoveryTaskArguments {
    if ($script:ReadOnlyRecoveryRunner -match '["\r\n]') { throw 'TASK_WORKSPACE_UNVERIFIED' }
    return '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -Apply' -f $script:ReadOnlyRecoveryRunner
}
function Get-ReadOnlyRecoveryFixedTask {
    try { $tasks = @(Get-ScheduledTask -TaskName 'EVMAuditReadOnlyRecovery' -TaskPath '\' -ErrorAction Stop) }
    catch {
        if ($_.FullyQualifiedErrorId -like 'CmdletizationQuery_NotFound_TaskName*' -or $_.FullyQualifiedErrorId -ceq 'CmdletizationQuery_NotFound,Get-ScheduledTask') { return $null }
        throw 'TASK_INSPECTION_FAILED'
    }
    if ($tasks.Count -eq 0) { return $null }
    if ($tasks.Count -ne 1 -or $tasks[0].TaskName -cne 'EVMAuditReadOnlyRecovery' -or $tasks[0].TaskPath -cne '\') { throw 'TASK_IDENTITY_MISMATCH' }
    return $tasks[0]
}
function Assert-ReadOnlyRecoveryTaskIdentity {
    param($Task, [string]$HostPath, [string]$Sid)
    if ($Task.TaskName -cne 'EVMAuditReadOnlyRecovery' -or $Task.TaskPath -cne '\') { throw 'TASK_IDENTITY_MISMATCH' }
    if (@($Task.Actions).Count -ne 1) { throw 'TASK_ACTION_MISMATCH' }
    Assert-HiddenLaunchAction -Action @($Task.Actions)[0] -Executable $HostPath -Arguments (Get-ReadOnlyRecoveryTaskArguments) -WorkingDirectory $script:ReadOnlyRecoveryRoot
    $principal = $Task.Principal
    if ((Resolve-DashboardAccountSid ([string]$principal.UserId)) -cne $Sid -or [string]$principal.LogonType -cnotin @('Interactive', '3') -or
        [string]$principal.RunLevel -cnotin @('Limited', '0') -or [string]$principal.GroupId -cne '') { throw 'TASK_PRINCIPAL_MISMATCH' }
    if ($principal.PSObject.Properties['RequiredPrivilege'] -and @($principal.RequiredPrivilege | Where-Object { $_ }).Count -gt 0) { throw 'TASK_PRINCIPAL_MISMATCH' }
    if ($principal.PSObject.Properties['ProcessTokenSidType'] -and [string]$principal.ProcessTokenSidType -cnotin @('Default', '0')) { throw 'TASK_PRINCIPAL_MISMATCH' }
    $settings = $Task.Settings
    if (-not [bool]$settings.Enabled -or [string]$Task.State -ceq 'Disabled') { throw 'TASK_DISABLED_HELD' }
    if ([string]$settings.MultipleInstances -cnotin @('IgnoreNew', '2') -or [string]$settings.ExecutionTimeLimit -cne 'PT5M' -or
        -not [bool]$settings.StartWhenAvailable -or [bool]$settings.WakeToRun -or [bool]$settings.RunOnlyIfIdle -or
        [bool]$settings.RunOnlyIfNetworkAvailable -or [int]$settings.RestartCount -ne 0) { throw 'TASK_SETTINGS_MISMATCH' }
    $triggers = @($Task.Triggers)
    if ($triggers.Count -ne 1) { throw 'TASK_TRIGGER_MISMATCH' }
    $logon = $triggers[0]
    if ($logon.CimClass.CimClassName -cne 'MSFT_TaskLogonTrigger' -or -not [bool]$logon.Enabled -or
        (Resolve-DashboardAccountSid ([string]$logon.UserId)) -cne $Sid -or [string]$logon.StartBoundary -cne '' -or [string]$logon.EndBoundary -cne '' -or
        [string]$logon.Delay -cne 'PT1M' -or -not (Test-DashboardZeroDuration ([string]$logon.ExecutionTimeLimit))) { throw 'TASK_TRIGGER_MISMATCH' }
    if ($null -ne $logon.Repetition -and ([string]$logon.Repetition.Interval -cne '' -or [string]$logon.Repetition.Duration -cne '' -or [bool]$logon.Repetition.StopAtDurationEnd)) { throw 'TASK_TRIGGER_MISMATCH' }
}
function Invoke-ReadOnlyRecoveryTaskInstall {
    param([switch]$Apply)
    $status = 'refused'; $reason = 'TASK_INSPECTION_FAILED'
    try {
        if (-not [IO.File]::Exists($script:ReadOnlyRecoveryRunner) -or -not [IO.File]::Exists((Join-Path $PSScriptRoot 'readonly-recovery.js'))) { throw 'TASK_WORKSPACE_UNVERIFIED' }
        $hostPath = Get-ReadOnlyRecoveryTaskHost
        $sid = Get-DashboardAccountSid
        $existing = Get-ReadOnlyRecoveryFixedTask
        if ($null -ne $existing) {
            Assert-ReadOnlyRecoveryTaskIdentity $existing $hostPath $sid
            $status = 'unchanged'; $reason = 'TASK_RECOVERY_ALREADY_INSTALLED'
        } elseif (-not $Apply) {
            [void](New-HiddenLaunchSpec -Executable $hostPath -Arguments (Get-ReadOnlyRecoveryTaskArguments) -WorkingDirectory $script:ReadOnlyRecoveryRoot)
            $status = 'would-register'; $reason = 'TASK_RECOVERY_INSTALL_VERIFIED'
        } else {
            $action = New-HiddenScheduledTaskAction -Executable $hostPath -Arguments (Get-ReadOnlyRecoveryTaskArguments) -WorkingDirectory $script:ReadOnlyRecoveryRoot
            $logon = New-ScheduledTaskTrigger -AtLogOn -User $sid
            $logon.EndBoundary = ''; $logon.ExecutionTimeLimit = 'PT0S'; $logon.Delay = 'PT1M'
            $principal = New-ScheduledTaskPrincipal -UserId $sid -LogonType Interactive -RunLevel Limited
            $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
            if ($null -ne (Get-ReadOnlyRecoveryFixedTask)) { throw 'TASK_CHANGED_DURING_INSPECTION' }
            try {
                # Deliberately no Force: registration cannot replace a race winner.
                Register-ScheduledTask -TaskName 'EVMAuditReadOnlyRecovery' -TaskPath '\' -Action $action -Trigger @($logon) -Principal $principal -Settings $settings -ErrorAction Stop | Out-Null
            } catch { throw 'TASK_REGISTER_FAILED_ATTENDED_INSPECTION' }
            try {
                $installed = Get-ReadOnlyRecoveryFixedTask
                if ($null -eq $installed) { throw 'TASK_IDENTITY_MISMATCH' }
                Assert-ReadOnlyRecoveryTaskIdentity $installed $hostPath $sid
            } catch { throw 'TASK_POSTVALIDATION_FAILED_ATTENDED_INSPECTION' }
            $status = 'registered'; $reason = 'TASK_RECOVERY_INSTALL_VERIFIED'
        }
    } catch {
        $reason = [string]$_.Exception.Message
        if ($reason -notmatch '^TASK_[A-Z_]+$') { $reason = 'TASK_INSPECTION_FAILED' }
    }
    [pscustomobject]@{
        taskName = 'EVMAuditReadOnlyRecovery'; taskPath = '\'; status = $status; reason = $reason
        account = 'CURRENT_ACCOUNT'; logonType = 'Interactive'; runLevel = 'Limited'; hiddenSynchronous = $true
        atLogon = $true; logonDelay = 'PT1M'; multipleInstances = 'IgnoreNew'; startWhenAvailable = $true; executionTimeLimit = 'PT5M'; wakeToRun = $false
        taskStartRequested = $false; existingTasksChanged = $false; liveExecutions = 'EXCLUDED_HELD'
    }
}
if ($MyInvocation.InvocationName -ne '.') {
    $result = Invoke-ReadOnlyRecoveryTaskInstall -Apply:$Apply
    $result | ConvertTo-Json -Compress
    if ($result.status -ceq 'refused') { exit 1 }
}
