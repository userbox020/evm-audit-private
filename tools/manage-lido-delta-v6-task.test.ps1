[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Manager = Join-Path $PSScriptRoot 'manage-lido-delta-v6-task.ps1'
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
Assert-Case (@($preflightCommands | Where-Object { $_ -in $forbiddenPreflight }).Count -eq 0) 'preflight has no task query change or child execution'

Assert-Case ($Source.Contains("`$TaskName = 'EVM-Audit-Lido-Delta-V6'")) 'fixed task identity'
Assert-Case ($Source.Contains('oracle-feed-module-delta-v6.js') -and $Source.Contains('$TargetPath ''--capture-if-ready''')) 'fixed target and exact child argument'
Assert-Case ($Source.Contains("ValidateSet('Preflight', 'Install', 'RunScheduled', 'Status', 'Uninstall')")) 'exact mode set'
Assert-Case ($Source.Contains('New-TimeSpan -Minutes 5') -and $Source.Contains('New-TimeSpan -Hours 8') -and $Source.Contains('New-TimeSpan -Minutes 10')) 'fixed bounded cadence duration and execution limit'
Assert-Case ($Source.Contains('-Execute $script:VerifiedPowerShellPath -Argument $ExpectedArguments') -and $Source.Contains('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File')) 'absolute trusted PowerShell action'
Assert-Case ($Source.Contains('[System.Environment]::SystemDirectory') -and $Source.Contains("`$applications.Count -ne 1") -and $Source.Contains("`$PSVersionTable.PSVersion.Major -ne 5") -and $Source.Contains("`$PSVersionTable.PSVersion.Minor -ne 1")) 'one trusted Windows PowerShell 5.1 application'
Assert-Case ($Source.Contains('[System.IO.Path]::IsPathRooted($resolved)') -and $Source.Contains("`$script:VerifiedNodePath = Get-VerifiedNodePath")) 'node executable is resolved absolutely'
Assert-Case ($Source.Contains("Resolve-PrincipalSid -UserId ([string]`$Task.Principal.UserId)") -and $Source.Contains('Get-CurrentUserSid')) 'principal comparison uses canonical SID'
Assert-Case ($Source.Contains('-LogonType Interactive -RunLevel Limited') -and $Source.Contains("`$Task.Principal.LogonType -ne 'Interactive'") -and $Source.Contains("`$Task.Principal.RunLevel -ne 'Limited'")) 'Interactive limited principal is created and validated'
Assert-Case ($Source.Contains("Repetition.Interval -ne 'PT5M'") -and $Source.Contains("Repetition.Duration -ne 'PT8H'") -and $Source.Contains("ExecutionTimeLimit -ne 'PT10M'")) 'trigger and execution settings are exactly validated'
Assert-Case ($Source.Contains('WaitOne(0)') -and $Source.Contains('Local\EVM-Audit-Lido-Delta-V6')) 'deterministic nonblocking mutex'
Assert-Case ($Source.Contains("if (`$childExit -eq 3) { exit 3 }") -and $Source.IndexOf("if (`$childExit -eq 3) { exit 3 }") -lt $Source.LastIndexOf('Disable-TerminalTask')) 'not-ready exits before disable'
Assert-Case ($Source.Contains("if (`$childExit -in @(0, 1, 4)) { exit `$childExit }") -and $Source.Contains('Disable-TerminalTask') -and $Source.Contains('exit 1')) 'terminal and unexpected exit-disable matrix'
Assert-Case (([regex]::Matches($Source, 'Disable-ScheduledTask')).Count -eq 1) 'terminal disable operation occurs once in source'
Assert-Case ($Source.Contains('Remove-Item Env:NODE_OPTIONS') -and $Source.Contains('Remove-Item Env:NODE_PATH')) 'NODE_OPTIONS and NODE_PATH are cleared and restored'
Assert-Case ($Source.Contains('try { Remove-JustCreatedFixedTask }') -and $Source.Contains("`$createdTask.TaskName -ne `$TaskName -or `$createdTask.TaskPath -ne '\'")) 'guarded exact post-registration rollback'
Assert-Case (-not $Source.Contains('cmd /c') -and -not $Source.Contains('cmd.exe')) 'no cmd wrapper'
Assert-Case (-not $Source.Contains('Start-Job') -and -not $Source.Contains('Register-ObjectEvent')) 'no daemon or background job'
Assert-Case (-not $Source.Contains('Out-File') -and -not $Source.Contains('Tee-Object') -and -not $Source.Contains('.log') -and -not [regex]::IsMatch($Source, '(?m)^\s*>')) 'no redirection or log files'
Assert-Case (-not $Source.Contains('-TaskName *') -and -not $Source.Contains('Unregister-ScheduledTask *')) 'no wildcard task operation'
Assert-Case ($Source.Contains("TASK_POSTVALIDATION_") -and $Source.Contains("TASK_REGISTER_FAILED") -and $Source.Contains("TASK_ROLLBACK_FAILED") -and $Source.Contains("MANAGER_FAILED_CLOSED")) 'sanitized stage-specific failures'

. $Manager
$script:MockGetCount = 0
$script:MockRegisterCount = 0
$script:MockUnregisterCount = 0
$script:MockDisableCount = 0
$script:MockExistingTask = $null
$script:MockRollbackTask = [pscustomobject]@{ TaskName = 'EVM-Audit-Lido-Delta-V6'; TaskPath = '\' }
$script:CapturedExecute = $null
$script:CapturedLogonType = $null
$script:CapturedRunLevel = $null
$script:CapturedExecutionLimit = $null

function Get-ScheduledTask {
    [CmdletBinding()]
    param([string]$TaskName)
    $script:MockGetCount += 1
    if ($script:MockGetCount -eq 1) { return $script:MockExistingTask }
    return $script:MockRollbackTask
}
function New-ScheduledTaskAction { param($Execute, $Argument, $WorkingDirectory) $script:CapturedExecute = [string]$Execute; return [pscustomobject]@{ Execute = [string]$Execute; Arguments = [string]$Argument; WorkingDirectory = [string]$WorkingDirectory } }
function New-ScheduledTaskTrigger { param([switch]$Once, $At, $RepetitionInterval, $RepetitionDuration) return [pscustomobject]@{ Repetition = [pscustomobject]@{ Interval = 'PT5M'; Duration = 'PT8H' } } }
function New-ScheduledTaskPrincipal { param($UserId, $LogonType, $RunLevel) $script:CapturedLogonType = [string]$LogonType; $script:CapturedRunLevel = [string]$RunLevel; return [pscustomobject]@{ UserId = [string]$UserId; LogonType = [string]$LogonType; RunLevel = [string]$RunLevel } }
function New-ScheduledTaskSettingsSet { param($MultipleInstances, $ExecutionTimeLimit, [switch]$AllowStartIfOnBatteries, [switch]$DontStopIfGoingOnBatteries) $script:CapturedExecutionLimit = $ExecutionTimeLimit; return [pscustomobject]@{ Enabled = $true; ExecutionTimeLimit = 'PT10M' } }
function Register-ScheduledTask { param($TaskName, $Action, $Trigger, $Principal, $Settings) $script:MockRegisterCount += 1; $badAction = [pscustomobject]@{ Execute = 'powershell.exe'; Arguments = $Action.Arguments; WorkingDirectory = $Action.WorkingDirectory }; return [pscustomobject]@{ TaskName = $TaskName; TaskPath = '\'; Actions = @($badAction); Principal = $Principal; Triggers = @($Trigger); Settings = $Settings } }
function Unregister-ScheduledTask { param($TaskName, [switch]$Confirm) $script:MockUnregisterCount += 1; $script:MockUnregisterName = [string]$TaskName; $script:MockUnregisterConfirm = [bool]$Confirm }
function Disable-ScheduledTask { param($TaskName) $script:MockDisableCount += 1; $script:MockDisableName = [string]$TaskName }

$installFailed = $false
try { Invoke-Install | Out-Null } catch { $installFailed = $true; $script:InstallFailureCode = [string]$_.Exception.Message }
Assert-Case $installFailed 'mocked postvalidation mismatch fails closed'
Assert-Case ($script:InstallFailureCode -eq 'TASK_POSTVALIDATION_TASK_ACTION_MISMATCH') 'postvalidation emits sanitized stage code'
Assert-Case ($script:MockRegisterCount -eq 1 -and $script:MockUnregisterCount -eq 1) 'failed validation rolls back exactly once'
Assert-Case ($script:MockUnregisterName -eq 'EVM-Audit-Lido-Delta-V6' -and $script:MockUnregisterConfirm -eq $false) 'rollback targets only exact fixed task'
Assert-Case ([System.IO.Path]::IsPathRooted($script:CapturedExecute) -and [System.StringComparer]::OrdinalIgnoreCase.Equals($script:CapturedExecute, $script:VerifiedPowerShellPath)) 'install uses exact absolute PowerShell executable'
Assert-Case ($script:CapturedLogonType -eq 'Interactive' -and $script:CapturedRunLevel -eq 'Limited') 'install uses Interactive limited principal'
Assert-Case ($script:CapturedExecutionLimit.TotalMinutes -eq 10) 'install uses ten-minute execution limit'

$currentSid = Get-CurrentUserSid
Assert-Case ((Resolve-PrincipalSid -UserId (Get-CurrentUserId)) -eq $currentSid) 'account name canonicalizes to current SID'
Assert-Case ((Resolve-PrincipalSid -UserId $currentSid) -eq $currentSid) 'SID canonicalization is stable'

$script:MockGetCount = 0
$script:MockRegisterCount = 0
$script:MockUnregisterCount = 0
$script:MockExistingTask = [pscustomobject]@{ TaskName = 'EVM-Audit-Lido-Delta-V6'; TaskPath = '\' }
$existingFailed = $false
try { Invoke-Install | Out-Null } catch { $existingFailed = $true }
Assert-Case ($existingFailed -and $script:MockRegisterCount -eq 0 -and $script:MockUnregisterCount -eq 0) 'existing task is never overwritten or removed'

$script:MockGetCount = 1
$script:MockRollbackTask = [pscustomobject]@{ TaskName = 'EVM-Audit-Lido-Delta-V6'; TaskPath = '\'; Actions = @([pscustomobject]@{ Execute = $script:VerifiedPowerShellPath; Arguments = $ExpectedArguments; WorkingDirectory = $WorkspacePath }); Principal = [pscustomobject]@{ UserId = $currentSid; LogonType = 'Interactive'; RunLevel = 'Limited' }; Triggers = @([pscustomobject]@{ Repetition = [pscustomobject]@{ Interval = 'PT5M'; Duration = 'PT8H' } }); Settings = [pscustomobject]@{ Enabled = $true; ExecutionTimeLimit = 'PT10M' } }
$script:MockDisableCount = 0
Disable-TerminalTask
Assert-Case ($script:MockDisableCount -eq 1 -and $script:MockDisableName -eq 'EVM-Audit-Lido-Delta-V6') 'terminal disable validates and disables exact task once'

Remove-Item Function:Get-ScheduledTask, Function:New-ScheduledTaskAction, Function:New-ScheduledTaskTrigger, Function:New-ScheduledTaskPrincipal, Function:New-ScheduledTaskSettingsSet, Function:Register-ScheduledTask, Function:Unregister-ScheduledTask, Function:Disable-ScheduledTask

$preflightOutput = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $Manager -Mode Preflight
Assert-Case ($LASTEXITCODE -eq 0) 'safe preflight exits zero'
$parsed = $preflightOutput | ConvertFrom-Json
Assert-Case ($parsed.ok -eq $true -and $parsed.taskQueried -eq $false -and $parsed.taskChanged -eq $false -and $parsed.childExecuted -eq $false) 'preflight reports zero task and child action'
Assert-Case ($parsed.inventoryRead -eq $false -and $parsed.networkRead -eq $false -and $parsed.outputAccess -eq $false) 'preflight reports zero inventory network and output access'

[Console]::Out.WriteLine((@{ ok = $true; passed = $script:Passed; failed = 0 } | ConvertTo-Json -Compress))
