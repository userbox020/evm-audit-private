# Offline only: no scheduler, process launch, network, producer or status writes.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'manage-readonly-recovery-task.ps1')
. (Join-Path $PSScriptRoot 'run-readonly-recovery.ps1')
$script:TestSid = 'S-1-5-21-111-222-333-1001'
$script:Checks = 0
function Assert-RecoveryTest {
    param([bool]$Condition, [string]$Name)
    if (-not $Condition) { throw ('TEST_FAILED_' + $Name) }
    $script:Checks++
}
function Reset-RecoveryMock {
    $script:MockTask = $null; $script:MockCalls = @(); $script:MockGets = 0
    $script:MockRace = $false; $script:MockInspectionFailure = $false; $script:MockRegisterRace = $false; $script:MockPostMismatch = $false
}
function Get-DashboardAccountSid { return $script:TestSid }
function Get-ReadOnlyRecoveryTaskHost { return 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' }
function Get-ScheduledTask {
    [CmdletBinding()]param([string]$TaskName, [string]$TaskPath)
    if ($TaskName -cne 'EVMAuditReadOnlyRecovery' -or $TaskPath -cne '\') { throw 'UNEXPECTED_TASK' }
    $script:MockGets++
    $script:MockCalls += 'get'
    if ($script:MockInspectionFailure) { throw 'PRIVATE_INSPECTION_DETAIL' }
    if ($script:MockRace -and $script:MockGets -eq 2) { return New-RecoveryMockTask }
    if ($null -ne $script:MockTask) { return $script:MockTask }
    return @()
}
function New-ScheduledTaskAction {
    param([string]$Execute, [string]$Argument, [string]$WorkingDirectory)
    return [pscustomobject]@{ Execute = $Execute; Arguments = $Argument; WorkingDirectory = $WorkingDirectory }
}
function New-ScheduledTaskTrigger {
    param([switch]$AtLogOn, [string]$User)
    if (-not $AtLogOn -or $User -cne $script:TestSid) { throw 'UNEXPECTED_TRIGGER' }
    return [pscustomobject]@{
        CimClass = @{ CimClassName = 'MSFT_TaskLogonTrigger' }; Enabled = $true; UserId = $User
        StartBoundary = ''; EndBoundary = ''; Delay = ''; ExecutionTimeLimit = 'PT0S'; Repetition = $null
    }
}
function New-ScheduledTaskPrincipal {
    param([string]$UserId, [string]$LogonType, [string]$RunLevel)
    return [pscustomobject]@{ UserId = $UserId; LogonType = $LogonType; RunLevel = $RunLevel; GroupId = ''; RequiredPrivilege = @(); ProcessTokenSidType = 'Default' }
}
function New-ScheduledTaskSettingsSet {
    param([string]$MultipleInstances, [switch]$StartWhenAvailable, [TimeSpan]$ExecutionTimeLimit)
    if ($ExecutionTimeLimit -ne [TimeSpan]::FromMinutes(5)) { throw 'UNEXPECTED_TIME_LIMIT' }
    return [pscustomobject]@{
        Enabled = $true; MultipleInstances = $MultipleInstances; StartWhenAvailable = [bool]$StartWhenAvailable; ExecutionTimeLimit = 'PT5M'
        WakeToRun = $false; RunOnlyIfIdle = $false; RunOnlyIfNetworkAvailable = $false; RestartCount = 0
    }
}
function Register-ScheduledTask {
    [CmdletBinding()]param([string]$TaskName, [string]$TaskPath, $Action, $Trigger, $Principal, $Settings)
    # No Force/Password/User parameters: an unsafe call fails this mock's binding.
    if ($TaskName -cne 'EVMAuditReadOnlyRecovery' -or $TaskPath -cne '\') { throw 'UNEXPECTED_TASK' }
    $script:MockCalls += 'register'
    if ($script:MockRegisterRace) { throw 'PRIVATE_RACE_DETAIL' }
    $script:MockTask = [pscustomobject]@{ TaskName = $TaskName; TaskPath = $TaskPath; Actions = @($Action); Triggers = @($Trigger); Principal = $Principal; Settings = $Settings; State = 'Ready' }
    if ($script:MockPostMismatch) { $script:MockTask.Settings.WakeToRun = $true }
}
function Start-ScheduledTask { throw 'FORBIDDEN_START' }
function Stop-ScheduledTask { throw 'FORBIDDEN_STOP' }
function Unregister-ScheduledTask { throw 'FORBIDDEN_DELETE' }
function Enable-ScheduledTask { throw 'FORBIDDEN_ENABLE' }
function Set-ScheduledTask { throw 'FORBIDDEN_SET' }
function Start-Process { throw 'FORBIDDEN_PROCESS' }
function Stop-Process { throw 'FORBIDDEN_PROCESS' }
function New-RecoveryMockTask {
    $action = New-HiddenScheduledTaskAction -Executable (Get-ReadOnlyRecoveryTaskHost) -Arguments (Get-ReadOnlyRecoveryTaskArguments) -WorkingDirectory $script:ReadOnlyRecoveryRoot
    $logon = New-ScheduledTaskTrigger -AtLogOn -User $script:TestSid
    $logon.Delay = 'PT1M'
    return [pscustomobject]@{
        TaskName = 'EVMAuditReadOnlyRecovery'; TaskPath = '\'; Actions = @($action)
        Triggers = @($logon)
        Principal = New-ScheduledTaskPrincipal -UserId $script:TestSid -LogonType Interactive -RunLevel Limited
        Settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
        State = 'Ready'
    }
}

Reset-RecoveryMock
$result = Invoke-ReadOnlyRecoveryTaskInstall
Assert-RecoveryTest ($result.status -ceq 'would-register') 'ABSENT_DRYRUN'
Assert-RecoveryTest ($script:MockCalls -notcontains 'register') 'DRYRUN_NO_REGISTER'
Assert-RecoveryTest ($null -eq $script:MockTask) 'DRYRUN_NO_TASK_CHANGE'

Reset-RecoveryMock
$result = Invoke-ReadOnlyRecoveryTaskInstall -Apply
Assert-RecoveryTest ($result.status -ceq 'registered') 'REGISTER'
Assert-RecoveryTest ($script:MockGets -eq 3) 'PRE_POST_RACE_CHECKS'
Assert-RecoveryTest (@($script:MockCalls | Where-Object { $_ -ceq 'register' }).Count -eq 1) 'REGISTER_ONCE'
$action = $script:MockTask.Actions[0]
$decoded = Read-HiddenLaunchAction $action
Assert-RecoveryTest ($decoded.Arguments -ceq (Get-ReadOnlyRecoveryTaskArguments)) 'FIXED_RUNNER_ARGUMENTS'
Assert-RecoveryTest ($decoded.WorkingDirectory -ceq $script:ReadOnlyRecoveryRoot) 'FIXED_WORKSPACE'
$wire = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(($action.Arguments.Split(' ')[-1]))) | ConvertFrom-Json
Assert-RecoveryTest ($wire.wait -ceq $true) 'SYNCHRONOUS_HIDDEN_ACTION'
Assert-RecoveryTest ($script:MockTask.Principal.LogonType -ceq 'Interactive' -and $script:MockTask.Principal.RunLevel -ceq 'Limited') 'LIMITED_INTERACTIVE'
Assert-RecoveryTest ($script:MockTask.Triggers.Count -eq 1 -and $script:MockTask.Settings.ExecutionTimeLimit -ceq 'PT5M') 'LOGIN_BOUNDED'
Assert-RecoveryTest ($script:MockTask.Triggers[0].Delay -ceq 'PT1M' -and $result.logonDelay -ceq 'PT1M') 'LOGIN_DELAY_EXACT'
$before = $script:MockTask | ConvertTo-Json -Depth 8 -Compress
$script:MockCalls = @()
$result = Invoke-ReadOnlyRecoveryTaskInstall -Apply
Assert-RecoveryTest ($result.status -ceq 'unchanged') 'IDEMPOTENT'
Assert-RecoveryTest ($script:MockCalls -notcontains 'register') 'UNCHANGED_NO_REGISTER'
Assert-RecoveryTest (($script:MockTask | ConvertTo-Json -Depth 8 -Compress) -ceq $before) 'UNCHANGED_IDENTITY'

foreach ($delay in @('', 'PT0S', 'PT2M', 'PT60S')) {
    Reset-RecoveryMock
    $script:MockTask = New-RecoveryMockTask
    $script:MockTask.Triggers[0].Delay = $delay
    $before = $script:MockTask | ConvertTo-Json -Depth 8 -Compress
    $result = Invoke-ReadOnlyRecoveryTaskInstall -Apply
    Assert-RecoveryTest ($result.status -ceq 'refused' -and $result.reason -ceq 'TASK_TRIGGER_MISMATCH') 'LOGIN_DELAY_MISMATCH'
    Assert-RecoveryTest ($script:MockCalls -notcontains 'register') 'LOGIN_DELAY_NO_REGISTER'
    Assert-RecoveryTest (($script:MockTask | ConvertTo-Json -Depth 8 -Compress) -ceq $before) 'LOGIN_DELAY_UNCHANGED'
}

foreach ($mutation in @('action', 'disabled', 'principal', 'trigger', 'settings')) {
    Reset-RecoveryMock
    $script:MockTask = New-RecoveryMockTask
    switch ($mutation) {
        'action' { $script:MockTask.Actions[0].Arguments = 'PRIVATE_ACTION' }
        'disabled' { $script:MockTask.State = 'Disabled'; $script:MockTask.Settings.Enabled = $false }
        'principal' { $script:MockTask.Principal.RunLevel = 'Highest' }
        'trigger' { $script:MockTask.Triggers[0].EndBoundary = '2026-11-01T12:00:00' }
        'settings' { $script:MockTask.Settings.WakeToRun = $true }
    }
    $before = $script:MockTask | ConvertTo-Json -Depth 8 -Compress
    $result = Invoke-ReadOnlyRecoveryTaskInstall -Apply
    Assert-RecoveryTest ($result.status -ceq 'refused') ('REFUSE_' + $mutation)
    Assert-RecoveryTest (($script:MockTask | ConvertTo-Json -Depth 8 -Compress) -ceq $before) ('PRESERVE_' + $mutation)
    Assert-RecoveryTest ($script:MockCalls -notcontains 'register') ('NO_REGISTER_' + $mutation)
    Assert-RecoveryTest (($result | ConvertTo-Json -Compress) -notmatch 'PRIVATE') ('SANITIZED_' + $mutation)
}

Reset-RecoveryMock
$script:MockRace = $true
$result = Invoke-ReadOnlyRecoveryTaskInstall -Apply
Assert-RecoveryTest ($result.reason -ceq 'TASK_CHANGED_DURING_INSPECTION') 'RACE_REFUSED'
Assert-RecoveryTest ($script:MockCalls -notcontains 'register') 'RACE_NO_REGISTER'
Reset-RecoveryMock
$script:MockRegisterRace = $true
$result = Invoke-ReadOnlyRecoveryTaskInstall -Apply
Assert-RecoveryTest ($result.reason -ceq 'TASK_REGISTER_FAILED_ATTENDED_INSPECTION') 'REGISTER_RACE_REFUSED'
Reset-RecoveryMock
$script:MockPostMismatch = $true
$result = Invoke-ReadOnlyRecoveryTaskInstall -Apply
Assert-RecoveryTest ($result.reason -ceq 'TASK_POSTVALIDATION_FAILED_ATTENDED_INSPECTION') 'POST_RACE_REFUSED'
Assert-RecoveryTest ($null -ne $script:MockTask) 'NO_POST_RACE_DELETE'
Reset-RecoveryMock
$script:MockInspectionFailure = $true
$result = Invoke-ReadOnlyRecoveryTaskInstall -Apply
Assert-RecoveryTest ($result.reason -ceq 'TASK_INSPECTION_FAILED') 'INSPECTION_FAILURE'
Assert-RecoveryTest ($script:MockCalls -notcontains 'register') 'INSPECTION_NO_REGISTER'

# Construct only: no process is started and environment changes are restored.
$savedOptions = $env:NODE_OPTIONS; $savedPath = $env:NODE_PATH; $savedPrivate = $env:RECOVERY_TEST_PRIVATE
try {
    $env:NODE_OPTIONS = '--require DO_NOT_RUN'; $env:NODE_PATH = 'DO_NOT_LOAD'; $env:RECOVERY_TEST_PRIVATE = 'DO_NOT_INHERIT'
    $start = New-ReadOnlyRecoveryStartInfo -Node 'C:\Program Files\nodejs\node.exe' -Apply
    Assert-RecoveryTest (-not $start.EnvironmentVariables.ContainsKey('NODE_OPTIONS') -and -not $start.EnvironmentVariables.ContainsKey('NODE_PATH')) 'NO_NODE_INJECTION'
    Assert-RecoveryTest (-not $start.EnvironmentVariables.ContainsKey('RECOVERY_TEST_PRIVATE')) 'MINIMAL_ENV'
    Assert-RecoveryTest ($start.WorkingDirectory -ceq $script:RecoveryRoot -and $start.CreateNoWindow -and -not $start.UseShellExecute) 'FIXED_HIDDEN_RUNNER'
    Assert-RecoveryTest ($start.Arguments.EndsWith(' --apply')) 'APPLY_ARG'
    $checkStart = New-ReadOnlyRecoveryStartInfo -Node 'C:\Program Files\nodejs\node.exe'
    Assert-RecoveryTest ($checkStart.Arguments.EndsWith(' --check')) 'CHECK_DEFAULT'
} finally { $env:NODE_OPTIONS = $savedOptions; $env:NODE_PATH = $savedPath; $env:RECOVERY_TEST_PRIVATE = $savedPrivate }
[Console]::Out.WriteLine(('readonly-recovery mocked PowerShell tests: PASS ({0} checks)' -f $script:Checks))
