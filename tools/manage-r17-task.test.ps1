[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Manager = Join-Path $PSScriptRoot 'manage-r17-task.ps1'
$Source = [System.IO.File]::ReadAllText($Manager)
$script:Passed = 0
function Assert-Case { param([bool]$Condition, [string]$Name) if (-not $Condition) { throw "FAILED: $Name" }; $script:Passed += 1 }

$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Manager, [ref]$tokens, [ref]$errors)
Assert-Case ($errors.Count -eq 0) 'manager parses'
Assert-Case ($Source.Contains("ValidateSet('Install', 'Status', 'Remove', 'RunNow')")) 'exact modes'
Assert-Case ($Source.Contains("`$TaskName = 'EVM-Audit-Polymarket-R17-R18-15m'")) 'fixed task identity'
Assert-Case ($Source.Contains('New-TimeSpan -Minutes 15') -and $Source.Contains('-MultipleInstances IgnoreNew') -and $Source.Contains("Repetition.Interval -ne 'PT15M'")) 'exact cadence and overlap setting'
Assert-Case ($Source.Contains('-LogonType Interactive -RunLevel Limited') -and $Source.Contains("LogonType -ne 'Interactive'") -and $Source.Contains("RunLevel -ne 'Limited'")) 'current-user interactive limited principal'
Assert-Case ($Source.Contains("polymarket-research-r18\cli.js") -and $Source.Contains("'run-once' '--as-of-ms'") -and $Source.Contains("'--root' `$MonitorRoot")) 'fixed local R18 command'
Assert-Case (-not $Source.Contains('-TaskName *') -and -not $Source.Contains('Unregister-ScheduledTask *')) 'no wildcard task management'
Assert-Case ($Source.Contains('try { Remove-JustCreatedFixedTask }') -and $Source.Contains("`$created.TaskName -ne `$TaskName -or `$created.TaskPath -ne '\'")) 'failed install has exact rollback'
Assert-Case (-not $Source.Contains('Start-Process') -and -not $Source.Contains('cmd.exe') -and -not $Source.Contains('cmd /c')) 'no shell wrapper'
Assert-Case ($Source.Contains('New-HiddenScheduledTaskAction -Executable $script:VerifiedPowerShellPath -Arguments $ExpectedArguments -WorkingDirectory $WorkspacePath') -and $Source.Contains('Assert-HiddenLaunchAction -Action $action -Executable $script:VerifiedPowerShellPath -Arguments $ExpectedArguments -WorkingDirectory $WorkspacePath')) 'canonical hidden wrapper installs and verifies exact inner payload'

$runNow = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-RunNow' }, $true)
$runCommands = @($runNow.Body.FindAll({ param($node) $node -is [System.Management.Automation.Language.CommandAst] }, $true) | ForEach-Object { $_.GetCommandName() })
Assert-Case (@($runCommands | Where-Object { $_ -in @('Register-ScheduledTask', 'Unregister-ScheduledTask', 'Get-ScheduledTask') }).Count -eq 0) 'RunNow never registers or manages a task'

. $Manager
function Assert-LocalPaths { $script:VerifiedPowerShellPath = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'; $script:VerifiedNodePath = 'C:\Program Files\nodejs\node.exe' }
$script:MockGet = 0; $script:Registered = 0; $script:Unregistered = 0; $script:Existing = $null
function Get-ScheduledTask { param([string]$TaskName) $script:MockGet += 1; if ($script:MockGet -eq 1) { return $script:Existing }; return [pscustomobject]@{ TaskName = 'EVM-Audit-Polymarket-R17-R18-15m'; TaskPath = '\' } }
function New-ScheduledTaskAction { param($Execute, $Argument, $WorkingDirectory) return [pscustomobject]@{ Execute = $Execute; Arguments = $Argument; WorkingDirectory = $WorkingDirectory } }
function New-ScheduledTaskTrigger { param([switch]$Once, $At, $RepetitionInterval) return [pscustomobject]@{ Repetition = [pscustomobject]@{ Interval = 'PT15M' } } }
function New-ScheduledTaskPrincipal { param($UserId, $LogonType, $RunLevel) return [pscustomobject]@{ UserId = (Get-CurrentUserSid); LogonType = 'Interactive'; RunLevel = 'Limited' } }
function New-ScheduledTaskSettingsSet { param($MultipleInstances, $ExecutionTimeLimit, [switch]$AllowStartIfOnBatteries, [switch]$DontStopIfGoingOnBatteries) return [pscustomobject]@{ Enabled = $true; MultipleInstances = 'IgnoreNew'; ExecutionTimeLimit = 'PT14M'; StartWhenAvailable = $false } }
function Register-ScheduledTask { param($TaskName, $Action, $Trigger, $Principal, $Settings) $script:Registered += 1; $bad = [pscustomobject]@{ Execute = 'powershell.exe'; Arguments = $Action.Arguments; WorkingDirectory = $Action.WorkingDirectory }; return [pscustomobject]@{ TaskName = $TaskName; TaskPath = '\'; Actions = @($bad); Principal = $Principal; Triggers = @($Trigger); Settings = $Settings } }
function Unregister-ScheduledTask { param($TaskName, [switch]$Confirm) $script:Unregistered += 1; $script:UnregisteredName = $TaskName }

$failed = $false
try { Invoke-Install | Out-Null } catch { $failed = $true; $script:InstallCode = [string]$_.Exception.Message }
Assert-Case ($failed -and $script:Registered -eq 1 -and $script:Unregistered -eq 1) 'mocked postvalidation failure rolls back'
Assert-Case ($script:UnregisteredName -eq 'EVM-Audit-Polymarket-R17-R18-15m') 'rollback uses fixed task name'

$script:MockGet = 0; $script:Registered = 0; $script:Unregistered = 0; $script:Existing = [pscustomobject]@{ TaskName = 'Foreign'; TaskPath = '\' }
$existingFailed = $false
try { Invoke-Install | Out-Null } catch { $existingFailed = $true }
Assert-Case ($existingFailed -and $script:Registered -eq 0 -and $script:Unregistered -eq 0) 'existing task preflight rejects without replacement'

$script:MockGet = 0; $script:Unregistered = 0; $script:Existing = [pscustomobject]@{ TaskName = 'EVM-Audit-Polymarket-R17-R18-15m'; TaskPath = '\'; Actions = @([pscustomobject]@{ Execute = 'wrong.exe'; Arguments = $ExpectedArguments; WorkingDirectory = $WorkspacePath }); Principal = [pscustomobject]@{ UserId = (Get-CurrentUserSid); LogonType = 'Interactive'; RunLevel = 'Limited' }; Triggers = @([pscustomobject]@{ Repetition = [pscustomobject]@{ Interval = 'PT15M' } }); Settings = [pscustomobject]@{ MultipleInstances = 'IgnoreNew'; ExecutionTimeLimit = 'PT14M'; StartWhenAvailable = $false } }
$removeFailed = $false
try { Invoke-Remove | Out-Null } catch { $removeFailed = $true }
Assert-Case ($removeFailed -and $script:Unregistered -eq 0) 'remove rejects non-owned action before unregister'

[Console]::Out.WriteLine((@{ ok = $true; passed = $script:Passed; failed = 0 } | ConvertTo-Json -Compress))
