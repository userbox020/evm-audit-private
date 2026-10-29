[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Manager = Join-Path $PSScriptRoot 'manage-profit-trigger-watch-task.ps1'
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

Assert-Case ($Source.Contains("`$TaskName = 'EVM-Audit-Profit-Trigger-Watch'")) 'fixed task identity'
Assert-Case ($Source.Contains('New-TimeSpan -Seconds 240') -and -not $Source.Contains('New-TimeSpan -Hours 24')) 'fixed 240-second indefinite cadence'
Assert-Case ($Source.Contains("ValidateSet('Preflight', 'Install', 'RunScheduled', 'Status', 'Uninstall')")) 'exact mode set'
Assert-Case ($Source.Contains('New-HiddenScheduledTaskAction -Executable $script:VerifiedPowerShellPath -Arguments $ExpectedArguments') -and $Source.Contains("-NoProfile -NonInteractive -ExecutionPolicy Bypass -File")) 'safe canonical hidden self action'
Assert-Case ($Source.Contains('Assert-HiddenLaunchAction -Action $action -Executable $script:VerifiedPowerShellPath -Arguments $ExpectedArguments -WorkingDirectory $WorkspacePath')) 'exact canonical wrapper and original payload verification'
Assert-Case ($Source.Contains('[System.Environment]::SystemDirectory') -and $Source.Contains("`$applications.Count -ne 1") -and $Source.Contains("`$PSVersionTable.PSVersion.Major -ne 5") -and $Source.Contains("`$PSVersionTable.PSVersion.Minor -ne 1")) 'one trusted Windows PowerShell 5.1 application is resolved'
Assert-Case ($Source.Contains("`$Task.TaskName -ne `$TaskName -or `$Task.TaskPath -ne '\'")) 'exact uninstall identity verification'
Assert-Case (([regex]::Matches($Source, 'Disable-ScheduledTask')).Count -eq 0) 'monitor never disables its own re-arming task'
Assert-Case ($Source.Contains("if (`$childExit -in @(0, 1)) { exit `$childExit }") -and $Source.Contains('if (-not $acquired) { exit 3 }')) 'bounded terminal exit matrix'
Assert-Case ($Source.Contains('WaitOne(0)') -and $Source.Contains("Local\EVM-Audit-Profit-Trigger-Watch")) 'nonblocking deterministic mutex'
Assert-Case ($Source.Contains('-MultipleInstances IgnoreNew') -and $Source.Contains("MultipleInstances -ne 'IgnoreNew'") -and $Source.Contains('StopAtDurationEnd = $false')) 'task enforces indefinite no-overlap scheduling'
Assert-Case (-not $Source.Contains('cmd /c') -and -not $Source.Contains('cmd.exe')) 'no cmd wrapper'
Assert-Case (-not $Source.Contains('Start-Job') -and -not $Source.Contains('Register-ObjectEvent')) 'no background daemon'
Assert-Case (-not $Source.Contains('Out-File') -and -not $Source.Contains('Tee-Object') -and -not $Source.Contains('.log')) 'no output log'
Assert-Case (-not $Source.Contains('-TaskName *') -and -not $Source.Contains('Unregister-ScheduledTask *')) 'no wildcard task operation'
Assert-Case ($Source.Contains("Remove-Item Env:NODE_OPTIONS") -and $Source.Contains("Remove-Item Env:NODE_PATH")) 'child environment is narrowly cleared and restored'
Assert-Case ($Source.Contains('try { Remove-JustCreatedFixedTask }') -and $Source.Contains("`$createdTask.TaskName -ne `$TaskName -or `$createdTask.TaskPath -ne '\'")) 'post-registration validation failure has exact fixed-identity rollback'
Assert-Case ($Source.Contains('run-profit-trigger-watch.js') -and $Source.Contains("'--run-once'")) 'scheduled run targets the fixed producer and run-once mode'
Assert-Case ($Source.Contains("Join-Path `$PSScriptRoot 'trigger-fork-autopilot.js'") -and $Source.Contains("Join-Path `$PSScriptRoot 'monitor-alert-dispatcher.js'")) 'downstream fork automation paths are workspace-pinned'
Assert-Case ($Source.Contains("& `$nodePath `$AutopilotPath '--apply'") -and $Source.Contains("& `$nodePath `$DispatcherPath '--apply'")) 'clean producer pass applies fork autopilot then dispatcher'
Assert-Case ($Source.Contains('$ForkAutomationEnabled = $false') -and $Source.Contains('if ($ForkAutomationEnabled -and $childExit -eq 0)')) 'scheduled fork and alert apply are paused while producers remain active'
Assert-Case ($Source.Contains('if ($autoExit -ne 0) { exit 1 }') -and $Source.Contains('if ($dispExit -ne 0) { exit 1 }')) 'nonzero autopilot or dispatcher fails the pass closed'
Assert-Case ($Source.Contains('if ($promoted) {') -and $Source.Contains('Test-CurrentAutopilotStatus -ProducerStart $producerStart -ProducerEnd $producerEnd -AutopilotStart $autopilotStart -AutopilotEnd $autopilotEnd')) 'dispatcher is gated by current-pass status promotion'
Assert-Case ($Source.Contains('AUTOPILOT_PATH_INVALID') -and $Source.Contains('DISPATCHER_PATH_INVALID')) 'downstream paths fail closed on identity mismatch'
Assert-Case (-not $Source.Contains('rpc_endpoints') -and -not $Source.Contains('Invoke-WebRequest') -and -not $Source.Contains('Invoke-RestMethod')) 'manager never reads the endpoint inventory or the network'
Assert-Case ($Source.Contains('taskChanged = $false') -and $Source.Contains('childExecuted = $false') -and $Source.Contains('inventoryRead = $false') -and $Source.Contains('networkRead = $false')) 'sanitized preflight flags are fixed false'

. $Manager
$fixturePath = Join-Path ([System.IO.Path]::GetTempPath()) ('manager-autopilot-status-fixture-' + [guid]::NewGuid().ToString('N') + '.json')
$producerStart = [datetimeoffset]::Parse('2026-09-28T18:00:00.000Z')
$producerEnd = [datetimeoffset]::Parse('2026-09-28T18:00:02.000Z')
$autopilotStart = [datetimeoffset]::Parse('2026-09-28T18:00:03.000Z')
$autopilotEnd = [datetimeoffset]::Parse('2026-09-28T18:00:05.000Z')
$fixture = @{
    schema = 'trigger-fork-autopilot-status/v1'; mode = 'APPLY'; classification = 'EXECUTED'; blocker = $null
    generatedAt = '2026-09-28T18:00:04.000Z'
    source = @{ path = 'reports/monitor/profit-trigger-watch.json'; generatedAt = '2026-09-28T18:00:01.000Z'; fresh = $true }
    execution = @{ promoted = $true; success = $true }
}
function Test-Fixture {
    param($Value)
    [System.IO.File]::WriteAllText($fixturePath, ($Value | ConvertTo-Json -Depth 6))
    return Test-CurrentAutopilotStatus -ProducerStart $producerStart -ProducerEnd $producerEnd -AutopilotStart $autopilotStart -AutopilotEnd $autopilotEnd -StatusPath $fixturePath
}
function Assert-FixtureRejected {
    param([string]$Name)
    $rejected = $false
    try { Test-Fixture $fixture | Out-Null } catch { $rejected = $true }
    Assert-Case $rejected $Name
}
try {
    Assert-Case (Test-Fixture $fixture) 'current promoted execution permits dispatch'
    $fixture.generatedAt = '2026-09-28T17:59:59.000Z'
    Assert-FixtureRejected 'prior promoted status cannot dispatch'
    $fixture.generatedAt = '2026-09-28T18:00:04.000Z'
    $fixture.source.generatedAt = '2026-09-28T17:59:59.000Z'
    Assert-FixtureRejected 'prior producer status cannot dispatch'
    $fixture.source.generatedAt = '2026-09-28T18:00:01.000Z'
    $fixture.mode = 'CHECK'
    Assert-FixtureRejected 'check mode cannot dispatch'
    $fixture.mode = 'APPLY'
    $fixture.blocker = 'OVERLAP_LOCKED'
    Assert-FixtureRejected 'lock denial cannot dispatch'
    $fixture.blocker = $null
    $fixture.classification = 'NO_FIRED_EVENT'
    $fixture.execution = $null
    Assert-Case (-not (Test-Fixture $fixture)) 'current no-fire status does not dispatch'
    $fixture.classification = 'EXECUTED'
    $fixture.execution = @{ promoted = $false; success = $false }
    Assert-Case (-not (Test-Fixture $fixture)) 'unpromoted execution does not dispatch'
    $fixture.classification = 'EXECUTED_FAILED'
    Assert-FixtureRejected 'failed execution cannot dispatch'
    $fixture.classification = 'EXECUTED'
    $fixture.execution = @{ promoted = 'true'; success = $true }
    Assert-FixtureRejected 'nonboolean promotion is malformed'
    [System.IO.File]::WriteAllText($fixturePath, '{broken json')
    $parseRejected = $false
    try { Test-CurrentAutopilotStatus -ProducerStart $producerStart -ProducerEnd $producerEnd -AutopilotStart $autopilotStart -AutopilotEnd $autopilotEnd -StatusPath $fixturePath | Out-Null } catch { $parseRejected = $true }
    Assert-Case $parseRejected 'parse failure cannot dispatch'
}
finally { Remove-Item -LiteralPath $fixturePath -ErrorAction SilentlyContinue }

# Isolated child processes exercise the real RunScheduled control flow (including exit),
# but resolve every child path to an inert fixture in a private temporary workspace.
$runFixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('manager-run-fixture-' + [guid]::NewGuid().ToString('N'))
$fixtureNode = [System.IO.Path]::GetFullPath((Get-Command node.exe -CommandType Application -ErrorAction Stop).Source)
$fixturePowerShell = [System.IO.Path]::GetFullPath((Get-Command powershell.exe -CommandType Application -ErrorAction Stop).Source)
$fakeChild = @'
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.MANAGER_TEST_DIR;
const scenario = process.env.MANAGER_TEST_SCENARIO;
const name = path.basename(process.argv[1]);
const action = name === 'run-profit-trigger-watch.js' ? 'producer' : name === 'trigger-fork-autopilot.js' ? 'autopilot' : 'dispatcher';
fs.appendFileSync(path.join(dir, 'calls.txt'), action + '\n');
if (action === 'producer') {
  fs.writeFileSync(path.join(dir, 'producer-time.txt'), new Date().toISOString());
  process.exit(scenario === 'producer-fail' ? 1 : 0);
}
if (action === 'dispatcher') process.exit(scenario === 'dispatcher-fail' ? 2 : 0);
if (scenario === 'autopilot-fail') process.exit(2);
if (scenario === 'overlap' || scenario === 'missing') process.exit(0);
const now = new Date();
const stamp = scenario === 'stale' ? new Date(now.getTime() - 60000).toISOString() : now.toISOString();
const sourceStamp = scenario === 'stale-source' ? new Date(now.getTime() - 60000).toISOString() : fs.readFileSync(path.join(dir, 'producer-time.txt'), 'utf8');
const status = {
  schema: 'trigger-fork-autopilot-status/v1', generatedAt: stamp, mode: 'APPLY',
  classification: scenario === 'no-fire' ? 'NO_FIRED_EVENT' : 'EXECUTED', blocker: null,
  source: { path: 'reports/monitor/profit-trigger-watch.json', generatedAt: sourceStamp, fresh: true },
  execution: scenario === 'no-fire' ? null : { promoted: true, success: true }
};
fs.writeFileSync(path.join(dir, 'reports', 'monitor', 'trigger-fork-autopilot-status.json'), scenario === 'malformed' ? '{broken json' : JSON.stringify(status));
'@
$fakeRunner = @'
param([string]$Manager, [string]$FixtureNode, [string]$FixtureDir, [string]$Scenario)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. $Manager
# These overrides exist only in this one fixture process. The manager file is untouched.
$WorkspacePath = $FixtureDir
$ProducerPath = Join-Path $FixtureDir 'tools\run-profit-trigger-watch.js'
$AutopilotPath = Join-Path $FixtureDir 'tools\trigger-fork-autopilot.js'
$DispatcherPath = Join-Path $FixtureDir 'tools\monitor-alert-dispatcher.js'
$MutexName = 'Local\EVM-Audit-Profit-Trigger-Watch-Fixture-' + [guid]::NewGuid().ToString('N')
if ($Scenario -ne 'held') { $ForkAutomationEnabled = $true }
$env:MANAGER_TEST_DIR = $FixtureDir
$env:MANAGER_TEST_SCENARIO = $Scenario
function Assert-LocalPaths { }
function Get-VerifiedNodePath { return $FixtureNode }
try { Invoke-RunScheduled } catch { exit 1 }
'@
try {
    [void](New-Item -ItemType Directory -Path $runFixtureRoot -Force)
    $runnerPath = Join-Path $runFixtureRoot 'fixture-run.ps1'
    [System.IO.File]::WriteAllText($runnerPath, $fakeRunner)
    $scenarios = @(
        @{ name = 'held'; exit = 0; calls = 'producer' },
        @{ name = 'producer-fail'; exit = 1; calls = 'producer' },
        @{ name = 'autopilot-fail'; exit = 1; calls = 'producer,autopilot' },
        @{ name = 'overlap'; exit = 1; calls = 'producer,autopilot' },
        @{ name = 'missing'; exit = 1; calls = 'producer,autopilot' },
        @{ name = 'malformed'; exit = 1; calls = 'producer,autopilot' },
        @{ name = 'stale'; exit = 1; calls = 'producer,autopilot' },
        @{ name = 'stale-source'; exit = 1; calls = 'producer,autopilot' },
        @{ name = 'no-fire'; exit = 0; calls = 'producer,autopilot' },
        @{ name = 'promote'; exit = 0; calls = 'producer,autopilot,dispatcher' },
        @{ name = 'dispatcher-fail'; exit = 1; calls = 'producer,autopilot,dispatcher' }
    )
    foreach ($scenario in $scenarios) {
        $dir = Join-Path $runFixtureRoot $scenario.name
        $toolsDir = Join-Path $dir 'tools'
        [void](New-Item -ItemType Directory -Path $toolsDir -Force)
        [void](New-Item -ItemType Directory -Path (Join-Path $dir 'reports\monitor') -Force)
        foreach ($file in @('run-profit-trigger-watch.js', 'trigger-fork-autopilot.js', 'monitor-alert-dispatcher.js')) {
            [System.IO.File]::WriteAllText((Join-Path $toolsDir $file), $fakeChild)
        }
        if ($scenario.name -eq 'overlap') {
            $prior = @{ schema = 'trigger-fork-autopilot-status/v1'; generatedAt = '2020-01-01T00:00:00.000Z'; mode = 'APPLY'; blocker = $null; classification = 'EXECUTED'; source = @{ path = 'reports/monitor/profit-trigger-watch.json'; generatedAt = '2020-01-01T00:00:00.000Z'; fresh = $true }; execution = @{ promoted = $true; success = $true } }
            [System.IO.File]::WriteAllText((Join-Path $dir 'reports\monitor\trigger-fork-autopilot-status.json'), ($prior | ConvertTo-Json -Depth 5))
        }
        & $fixturePowerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $runnerPath -Manager $Manager -FixtureNode $fixtureNode -FixtureDir $dir -Scenario $scenario.name 2>$null | Out-Null
        $fixtureExit = $LASTEXITCODE
        $callsPath = Join-Path $dir 'calls.txt'
        $calls = if (Test-Path -LiteralPath $callsPath) { @(Get-Content -LiteralPath $callsPath) -join ',' } else { '' }
        Assert-Case ($fixtureExit -eq $scenario.exit -and $calls -ceq $scenario.calls) ('isolated RunScheduled ' + $scenario.name + ' exit and child sequence')
    }
    Assert-Case ($Source.Contains('$ForkAutomationEnabled = $false') -and $fakeRunner.Contains('$ForkAutomationEnabled = $true')) 'fixture-only override leaves production safety pause intact'
}
finally { Remove-Item -LiteralPath $runFixtureRoot -Recurse -Force -ErrorAction SilentlyContinue }

$script:MockGetCount = 0
$script:MockRegisterCount = 0
$script:MockUnregisterCount = 0
$script:MockUnregisterTaskName = $null
$script:MockUnregisterConfirm = $null
$script:MockExistingTask = $null
$script:MockRollbackTask = [pscustomobject]@{ TaskName = 'EVM-Audit-Profit-Trigger-Watch'; TaskPath = '\' }
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
    return [pscustomobject]@{ Repetition = [pscustomobject]@{ Interval = 'PT4M'; Duration = ''; StopAtDurationEnd = $false } }
}
function New-ScheduledTaskPrincipal {
    param($UserId, $LogonType, $RunLevel)
    $script:CapturedLogonType = [string]$LogonType
    return [pscustomobject]@{ UserId = [string]$UserId; RunLevel = [string]$RunLevel }
}
function New-ScheduledTaskSettingsSet {
    param($MultipleInstances, $ExecutionTimeLimit, [switch]$AllowStartIfOnBatteries, [switch]$DontStopIfGoingOnBatteries)
    return [pscustomobject]@{ Enabled = $true; MultipleInstances = 'IgnoreNew'; ExecutionTimeLimit = 'PT10M' }
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
Assert-Case ($script:MockUnregisterTaskName -eq 'EVM-Audit-Profit-Trigger-Watch' -and $script:MockUnregisterConfirm -eq $false) 'mocked rollback targets only fixed task without wildcard'
Assert-Case ([System.IO.Path]::IsPathRooted($script:CapturedExecute) -and $script:CapturedExecute -ceq (Get-HiddenLauncherPaths).Execute) 'mocked install registers exact absolute trusted wrapper executable'
Assert-Case ($script:CapturedLogonType -eq 'Interactive') 'mocked install uses the Windows PowerShell 5.1 Interactive logon type'

$currentSid = Get-CurrentUserSid
Assert-Case ((Resolve-PrincipalSid -UserId (Get-CurrentUserId)) -eq $currentSid) 'account-name principal canonicalizes to the current SID'
Assert-Case ((Resolve-PrincipalSid -UserId $currentSid) -eq $currentSid) 'SID principal remains canonically stable'

$script:MockGetCount = 0
$script:MockRegisterCount = 0
$script:MockUnregisterCount = 0
$script:MockExistingTask = [pscustomobject]@{ TaskName = 'EVM-Audit-Profit-Trigger-Watch'; TaskPath = '\' }
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
