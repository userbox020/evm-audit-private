[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Manager = Join-Path $PSScriptRoot 'manage-protocol-trigger-scout-v3-task.ps1'
$Source = [System.IO.File]::ReadAllText($Manager)
$script:Passed = 0

function Assert-Case {
    param([bool]$Condition, [string]$Name)
    if (-not $Condition) { throw "FAILED: $Name" }
    $script:Passed += 1
}

$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Manager, [ref]$tokens, [ref]$errors)
Assert-Case ($errors.Count -eq 0) 'parser accepts manager'

$preflight = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-Preflight' }, $true)
Assert-Case ($null -ne $preflight) 'preflight function exists'
$preflightCommands = @($preflight.Body.FindAll({ param($node) $node -is [System.Management.Automation.Language.CommandAst] }, $true) | ForEach-Object { $_.GetCommandName() })
$forbiddenPreflight = @('Get-ScheduledTask', 'Get-ScheduledTaskInfo', 'Register-ScheduledTask', 'Disable-ScheduledTask', 'Unregister-ScheduledTask', 'Start-Process', 'node.exe')
Assert-Case (@($preflightCommands | Where-Object { $_ -in $forbiddenPreflight }).Count -eq 0) 'preflight has no task query/change or child execution'

Assert-Case ($Source.Contains("`$TaskName = 'EVM-Audit-Protocol-Trigger-Scout-V3'")) 'fixed task identity'
Assert-Case ($Source.Contains('New-TimeSpan -Minutes 5') -and $Source.Contains('New-TimeSpan -Hours 8')) 'fixed bounded cadence and duration'
Assert-Case ($Source.Contains("ValidateSet('Preflight', 'Install', 'RunScheduled', 'Status', 'Uninstall')")) 'exact mode set'
Assert-Case ($Source.Contains('-Execute $script:VerifiedPowerShellPath -Argument $ExpectedArguments') -and $Source.Contains("-NoProfile -NonInteractive -ExecutionPolicy Bypass -File")) 'safe absolute self action'
Assert-Case ($Source.Contains("[System.StringComparer]::OrdinalIgnoreCase.Equals([string]`$action.Execute, `$script:VerifiedPowerShellPath)") -and $Source.Contains("[System.IO.Path]::IsPathRooted([string]`$action.Execute") -and $Source.Contains("[string]`$action.Arguments -cne `$ExpectedArguments")) 'exact absolute executable action verification'
Assert-Case ($Source.Contains('[System.Environment]::SystemDirectory') -and $Source.Contains("`$applications.Count -ne 1") -and $Source.Contains("`$PSVersionTable.PSVersion.Major -ne 5") -and $Source.Contains("`$PSVersionTable.PSVersion.Minor -ne 1")) 'one trusted Windows PowerShell 5.1 application is resolved'
Assert-Case ($Source.Contains("`$Task.TaskName -ne `$TaskName -or `$Task.TaskPath -ne '\'")) 'exact uninstall identity verification'
Assert-Case (([regex]::Matches($Source, 'Disable-ScheduledTask')).Count -eq 1) 'single terminal disable operation'
Assert-Case ($Source.Contains("if (`$childExit -eq 3) { exit 3 }") -and $Source.Contains("if (`$childExit -in @(0, 1, 4)) { exit `$childExit }") -and $Source.Contains('Disable-TerminalTask')) 'terminal disable matrix'
Assert-Case ($Source.Contains('WaitOne(0)') -and $Source.Contains("Local\EVM-Audit-Protocol-Trigger-Scout-V3")) 'nonblocking deterministic mutex'
Assert-Case (-not $Source.Contains('cmd /c') -and -not $Source.Contains('cmd.exe')) 'no cmd wrapper'
Assert-Case (-not $Source.Contains('Start-Job') -and -not $Source.Contains('Register-ObjectEvent')) 'no background daemon'
Assert-Case (-not $Source.Contains('Out-File') -and -not $Source.Contains('Tee-Object') -and -not $Source.Contains('.log')) 'no output log'
Assert-Case (-not $Source.Contains('-TaskName *') -and -not $Source.Contains('Unregister-ScheduledTask *')) 'no wildcard task operation'
Assert-Case ($Source.Contains("Remove-Item Env:NODE_OPTIONS") -and $Source.Contains("Remove-Item Env:NODE_PATH")) 'child environment is narrowly cleared and restored'
Assert-Case ($Source.Contains('try { Remove-JustCreatedFixedTask }') -and $Source.Contains("`$createdTask.TaskName -ne `$TaskName -or `$createdTask.TaskPath -ne '\'")) 'post-registration validation failure has exact fixed-identity rollback'

. $Manager
$script:MockGetCount = 0
$script:MockRegisterCount = 0
$script:MockUnregisterCount = 0
$script:MockUnregisterTaskName = $null
$script:MockUnregisterConfirm = $null
$script:MockExistingTask = $null
$script:MockRollbackTask = [pscustomobject]@{ TaskName = 'EVM-Audit-Protocol-Trigger-Scout-V3'; TaskPath = '\' }
$script:CapturedExecute = $null

function Get-ScheduledTask {
    [CmdletBinding()]
    param([string]$TaskName)
    $script:MockGetCount += 1
    if ($script:MockGetCount -eq 1) { return $script:MockExistingTask }
    return $script:MockRollbackTask
}
function New-ScheduledTaskAction {
    param($Execute, $Argument, $WorkingDirectory)
    $script:CapturedExecute = [string]$Execute
    return [pscustomobject]@{ Execute = [string]$Execute; Arguments = [string]$Argument; WorkingDirectory = [string]$WorkingDirectory }
}
function New-ScheduledTaskTrigger {
    param([switch]$Once, $At, $RepetitionInterval, $RepetitionDuration)
    return [pscustomobject]@{ Repetition = [pscustomobject]@{ Interval = 'PT5M'; Duration = 'PT8H' } }
}
function New-ScheduledTaskPrincipal {
    param($UserId, $LogonType, $RunLevel)
    $script:CapturedLogonType = [string]$LogonType
    return [pscustomobject]@{ UserId = [string]$UserId; RunLevel = [string]$RunLevel }
}
function New-ScheduledTaskSettingsSet {
    param($MultipleInstances, $ExecutionTimeLimit, [switch]$AllowStartIfOnBatteries, [switch]$DontStopIfGoingOnBatteries)
    return [pscustomobject]@{ Enabled = $true }
}
function Register-ScheduledTask {
    param($TaskName, $Action, $Trigger, $Principal, $Settings)
    $script:MockRegisterCount += 1
    $badAction = [pscustomobject]@{ Execute = 'powershell.exe'; Arguments = $Action.Arguments; WorkingDirectory = $Action.WorkingDirectory }
    return [pscustomobject]@{ TaskName = $TaskName; TaskPath = '\'; Actions = @($badAction); Principal = $Principal; Triggers = @($Trigger); Settings = $Settings }
}
function Unregister-ScheduledTask {
    param($TaskName, [switch]$Confirm)
    $script:MockUnregisterCount += 1
    $script:MockUnregisterTaskName = [string]$TaskName
    $script:MockUnregisterConfirm = [bool]$Confirm
}

$installFailed = $false
try { Invoke-Install | Out-Null } catch { $installFailed = $true; $script:InstallFailureCode = [string]$_.Exception.Message }
Assert-Case $installFailed 'mocked post-registration identity mismatch fails closed'
Assert-Case ($script:InstallFailureCode -eq 'TASK_POSTVALIDATION_TASK_ACTION_MISMATCH') 'mocked post-validation failure emits only its sanitized stage code'
Assert-Case ($script:MockRegisterCount -eq 1 -and $script:MockUnregisterCount -eq 1) 'mocked failed validation rolls back exactly once'
Assert-Case ($script:MockUnregisterTaskName -eq 'EVM-Audit-Protocol-Trigger-Scout-V3' -and $script:MockUnregisterConfirm -eq $false) 'mocked rollback targets only fixed task without wildcard'
Assert-Case ([System.IO.Path]::IsPathRooted($script:CapturedExecute) -and [System.StringComparer]::OrdinalIgnoreCase.Equals($script:CapturedExecute, $script:VerifiedPowerShellPath)) 'mocked install registers exact absolute trusted executable'
Assert-Case ($script:CapturedLogonType -eq 'Interactive') 'mocked install uses the Windows PowerShell 5.1 Interactive logon type'

$currentSid = Get-CurrentUserSid
Assert-Case ((Resolve-PrincipalSid -UserId (Get-CurrentUserId)) -eq $currentSid) 'account-name principal canonicalizes to the current SID'
Assert-Case ((Resolve-PrincipalSid -UserId $currentSid) -eq $currentSid) 'SID principal remains canonically stable'

$script:MockGetCount = 0
$script:MockRegisterCount = 0
$script:MockUnregisterCount = 0
$script:MockExistingTask = [pscustomobject]@{ TaskName = 'EVM-Audit-Protocol-Trigger-Scout-V3'; TaskPath = '\' }
$existingFailed = $false
try { Invoke-Install | Out-Null } catch { $existingFailed = $true }
Assert-Case ($existingFailed -and $script:MockRegisterCount -eq 0 -and $script:MockUnregisterCount -eq 0) 'mocked existing task is never overwritten or removed'

Remove-Item Function:Get-ScheduledTask, Function:New-ScheduledTaskAction, Function:New-ScheduledTaskTrigger, Function:New-ScheduledTaskPrincipal, Function:New-ScheduledTaskSettingsSet, Function:Register-ScheduledTask, Function:Unregister-ScheduledTask

$preflightOutput = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $Manager -Mode Preflight
Assert-Case ($LASTEXITCODE -eq 0) 'safe preflight exits zero'
$parsed = $preflightOutput | ConvertFrom-Json
Assert-Case ($parsed.ok -eq $true -and $parsed.taskQueried -eq $false -and $parsed.taskChanged -eq $false -and $parsed.childExecuted -eq $false) 'safe preflight reports no task or child action'
Assert-Case ($parsed.inventoryRead -eq $false -and $parsed.networkRead -eq $false -and $parsed.outputAccess -eq $false) 'safe preflight reports no inventory network or output access'

[Console]::Out.WriteLine((@{ ok = $true; passed = $script:Passed; failed = 0 } | ConvertTo-Json -Compress))
