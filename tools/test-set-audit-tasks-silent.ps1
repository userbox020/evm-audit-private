[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'set-audit-tasks-silent.ps1')
$script:Passed = 0
function Assert-Case { param([bool]$Condition, [string]$Name) if (-not $Condition) { throw "FAILED: $Name" }; $script:Passed++ }
$script:Name = 'EVM-Audit-Profit-Trigger-Watch'
$script:Inner = [pscustomobject]@{
    Execute = (Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe')
    Arguments = ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -Mode RunScheduled' -f (Join-Path $PSScriptRoot 'manage-profit-trigger-watch-task.ps1'))
    WorkingDirectory = $script:SilentWorkspace
}
function Reset-Fixture {
    $script:Task = [pscustomobject]@{ TaskName = $script:Name; TaskPath = '\'; Actions = @($script:Inner); State = 'Ready'; Settings = [pscustomobject]@{ Enabled = $true } }
    $script:Sets = 0; $script:Exports = 0; $script:Drift = $false; $script:BadAfterAction = $false; $script:AfterDrift = $false; $script:StickyDrift = $false
    $script:ThrowBefore = $false; $script:ThrowAfter = $false; $script:InspectTaskFailure = $false; $script:InspectXmlFailure = $false
    $script:FollowingTask = $null; $script:FollowingSets = 0
}
function Get-ScheduledTask {
    [CmdletBinding()]param([string]$TaskName, [string]$TaskPath)
    if ($TaskPath -cne '\') { throw 'TASK_TEST_ROOT_REQUIRED' }
    if ($TaskName -ceq $script:Name) {
        if ($script:Sets -gt 0 -and $script:InspectTaskFailure) { throw 'TASK_FIXTURE_INSPECTION_FAILED' }
        return $script:Task
    }
    if ($null -ne $script:FollowingTask -and $TaskName -ceq $script:FollowingTask.TaskName) { return $script:FollowingTask }
    return $null
}
function Export-ScheduledTask {
    [CmdletBinding()]param([string]$TaskName, [string]$TaskPath)
    $script:Exports++
    if ($TaskName -ceq $script:Name -and $script:Sets -gt 0 -and $script:InspectXmlFailure) { throw 'TASK_FIXTURE_INSPECTION_FAILED' }
    $value = if ($script:AfterDrift) { 'drift' } else { 'same' }
    return ('<Task><Principal>{0}</Principal><Triggers><Interval>PT4M</Interval></Triggers><Settings><Enabled>true</Enabled></Settings><Actions><Exec /></Actions></Task>' -f $value)
}
function New-ScheduledTaskAction { param($Execute, $Argument, $WorkingDirectory) return [pscustomobject]@{ Execute = $Execute; Arguments = $Argument; WorkingDirectory = $WorkingDirectory } }
function Set-ScheduledTask {
    [CmdletBinding()]param($TaskName, $TaskPath, $Action)
    if ($null -ne $script:FollowingTask -and $TaskName -ceq $script:FollowingTask.TaskName) {
        Assert-Case ($TaskPath -ceq '\') 'following action-only mock update stays root-bound'
        $script:FollowingSets++
        $script:FollowingTask.Actions = @($Action)
        return
    }
    $script:Sets++
    Assert-Case ($TaskName -ceq $script:Name -and $TaskPath -ceq '\') 'action-only update is fixed-root and allowlisted'
    if ($script:Sets -eq 1 -and $script:ThrowBefore) { throw 'TASK_FIXTURE_SET_DENIED' }
    $script:Task.Actions = @($Action)
    if ($script:Sets -eq 1 -and $script:BadAfterAction) { $script:Task.Actions = @($script:Inner) }
    $script:AfterDrift = $script:StickyDrift -or ($script:Sets -eq 1 -and $script:Drift)
    if ($script:Sets -eq 1 -and $script:ThrowAfter) { throw 'TASK_FIXTURE_SET_FAILED_AFTER_MUTATION' }
}
function Result { param([switch]$Apply) return @(Invoke-SilentTaskMigration -Apply:$Apply | Where-Object { $_.taskName -ceq $script:Name })[0] }

Reset-Fixture
$result = Result
Assert-Case ($result.status -ceq 'would-change' -and $script:Sets -eq 0) 'default dry run has no scheduler mutation'
$expectedNames = @('EVMAuditMonitorAlerts', 'EVMAuditTriggerCoverageAudit', 'EVM-Audit-Profit-Trigger-Watch', 'EVMAuditCanaryFeeds', 'EVMAuditMonitorSetWatchdog', 'EVMAuditWalletBalances', 'EVM-Audit-Polymarket-R17-R18-15m', 'EVMAuditWalletTransactions', 'EVMAuditMonitorSet', 'EVMAuditMonitorKaminoReduced', 'EVMAuditMonitorVenus')
Assert-Case (((Get-SilentTaskBindings).Keys -join '|') -ceq ($expectedNames -join '|')) 'exact fixed task allowlist excludes external disabled and autopilot tasks'
$result = Result -Apply
Assert-Case ($result.status -ceq 'changed' -and $script:Sets -eq 1) 'apply updates one action'
Assert-Case ($script:Exports -eq 3) 'non-action XML checked before, immediately before and after'
$inner = Read-HiddenLaunchAction $script:Task.Actions[0]
Assert-Case (Test-HiddenActionEqual $inner $script:Inner) 'exact original exe opaque args and cwd retained'
$encodedWire = ([string]$script:Task.Actions[0].Arguments).Substring(([string]$script:Task.Actions[0].Arguments).LastIndexOf(' ') + 1)
$canonicalWire = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encodedWire)) | ConvertFrom-Json
Assert-Case ((@($canonicalWire.PSObject.Properties.Name) -join '|') -ceq 'version|executable|arguments|workingDirectory|wait' -and $canonicalWire.version -ceq 1 -and $canonicalWire.wait -ceq $true) 'scheduled action wire matches backend five-field canonical schema exactly'
$result = Result -Apply
Assert-Case ($result.status -ceq 'unchanged' -and $script:Sets -eq 1) 'canonical wrapped action is idempotent'
$script:Task.Actions[0].Arguments += ' '
$result = Result -Apply
Assert-Case ($result.status -ceq 'refused' -and $script:Sets -eq 1) 'noncanonical wrapper tampering refused'
Reset-Fixture
$script:Task.Settings.Enabled = $false
$script:Task.Actions = @([pscustomobject]@{ Execute = 'unverified.exe' })
$result = Result -Apply
Assert-Case ($result.status -ceq 'skipped' -and $script:Sets -eq 0 -and $script:Exports -eq 0) 'disabled task untouched even when action unsupported'
Reset-Fixture
$script:Task.Actions = @($script:Inner, $script:Inner)
Assert-Case ((Result -Apply).reason -ceq 'TASK_ACTION_UNSUPPORTED' -and $script:Sets -eq 0) 'ambiguous multi-action task refused'
Reset-Fixture; $script:Task.TaskPath = '\foreign\'
Assert-Case ((Result -Apply).reason -ceq 'TASK_IDENTITY_UNVERIFIED' -and $script:Sets -eq 0) 'non-root task identity refused'
Reset-Fixture; $script:Task.State = 'Disabled'
Assert-Case ((Result -Apply).reason -ceq 'TASK_DISABLED' -and $script:Sets -eq 0) 'disabled state skipped without rewriting'
foreach ($bad in @(
    [pscustomobject]@{ Execute = '.\powershell.exe'; Arguments = $script:Inner.Arguments; WorkingDirectory = $script:SilentWorkspace },
    [pscustomobject]@{ Execute = $script:Inner.Execute; Arguments = ($script:Inner.Arguments + ' --unexpected'); WorkingDirectory = $script:SilentWorkspace },
    [pscustomobject]@{ Execute = $script:Inner.Execute; Arguments = ($script:Inner.Arguments + ' https://fixture.invalid'); WorkingDirectory = $script:SilentWorkspace },
    [pscustomobject]@{ Execute = $script:Inner.Execute; Arguments = $script:Inner.Arguments; WorkingDirectory = $PSScriptRoot }
)) {
    Reset-Fixture; $script:Task.Actions = @($bad); $result = Result -Apply
    Assert-Case ($result.status -ceq 'refused' -and $script:Sets -eq 0) 'unverified payload refused without mutation'
    Assert-Case (($result | ConvertTo-Json -Compress) -notmatch 'fixture.invalid|unexpected|Arguments|Execute') 'report contains no raw argument diagnostics'
}
Reset-Fixture; $script:BadAfterAction = $true
$result = Result -Apply
Assert-Case ($result.reason -ceq 'TASK_UPDATE_NOT_APPLIED' -and $script:Sets -eq 1 -and (Test-HiddenActionEqual $script:Task.Actions[0] $script:Inner)) 'postvalidation observes exact original state and avoids an unnecessary rollback write'
Reset-Fixture; $script:Drift = $true
$result = Result -Apply
Assert-Case ($result.reason -ceq 'TASK_UPDATE_ROLLED_BACK' -and $script:Sets -eq 2) 'non-action XML mismatch triggers action rollback'
Reset-Fixture; $script:StickyDrift = $true
$batch = @(Invoke-SilentTaskMigration -Apply)
Assert-Case ($batch[-1].reason -ceq 'TASK_ROLLBACK_FAILED' -and $batch.Count -eq 3 -and $script:Sets -eq 2) 'unrestorable non-action drift halts batch without exceeding action-only authority'

Reset-Fixture; $script:ThrowBefore = $true
$script:FollowingTask = [pscustomobject]@{
    TaskName = 'EVMAuditCanaryFeeds'; TaskPath = '\'; State = 'Ready'; Settings = [pscustomobject]@{ Enabled = $true }
    Actions = @([pscustomobject]@{ Execute = (Get-SilentTrustedNode); Arguments = ('"' + (Join-Path $PSScriptRoot 'refresh-canary-feeds.js') + '" --once'); WorkingDirectory = $script:SilentWorkspace })
}
$batch = @(Invoke-SilentTaskMigration -Apply)
$denied = @($batch | Where-Object { $_.taskName -ceq $script:Name })[0]
$following = @($batch | Where-Object { $_.taskName -ceq 'EVMAuditCanaryFeeds' })[0]
Assert-Case ($denied.reason -ceq 'TASK_UPDATE_NOT_APPLIED' -and $denied.status -ceq 'refused' -and $script:Sets -eq 1 -and (Test-HiddenActionEqual $script:Task.Actions[0] $script:Inner)) 'Set throw before mutation produces safe not-applied reason and zero rollback writes'
Assert-Case ($batch.Count -eq 11 -and $following.status -ceq 'changed' -and $script:FollowingSets -eq 1) 'verified unchanged rejection continues to migrate the next allowlisted task'

Reset-Fixture; $script:ThrowAfter = $true
$batch = @(Invoke-SilentTaskMigration -Apply)
$failedAfterMutation = @($batch | Where-Object { $_.taskName -ceq $script:Name })[0]
Assert-Case ($failedAfterMutation.reason -ceq 'TASK_UPDATE_ROLLED_BACK' -and $script:Sets -eq 2 -and (Test-HiddenActionEqual $script:Task.Actions[0] $script:Inner) -and $batch.Count -eq 11) 'Set throw after mutation still performs and verifies the original action rollback'

foreach ($inspection in @('task', 'xml')) {
    Reset-Fixture; $script:ThrowBefore = $true
    if ($inspection -ceq 'task') { $script:InspectTaskFailure = $true } else { $script:InspectXmlFailure = $true }
    $batch = @(Invoke-SilentTaskMigration -Apply)
    Assert-Case ($batch[-1].reason -ceq 'TASK_ROLLBACK_FAILED' -and $batch.Count -eq 3 -and $script:Sets -eq 2) 'failed state inspection cannot pretend unchanged and unverified rollback hard-stops the batch'
}
Reset-Fixture

# The tricky cmd payload is accepted only as a fully known grammar, then retained verbatim.
$kamino = [pscustomobject]@{ Execute = (Join-Path ([Environment]::SystemDirectory) 'cmd.exe'); WorkingDirectory = $script:SilentWorkspace; Arguments = '/c "(set NODE_OPTIONS=) & (set NODE_PATH=) & (for /f "delims=" %V in (''node tools\monitor-minimal-env.js --names-to-clear'') do set "%V=") & (node tools\monitor-minimal-env.js --assert-current >nul 2>&1 || exit /b 1) & (node tools\monitor-kamino-reduced-status.js --loop --interval-seconds 300)"' }
Assert-SilentTaskPayload 'EVMAuditMonitorKaminoReduced' $kamino
$spec = New-HiddenLaunchSpec -Executable $kamino.Execute -Arguments $kamino.Arguments -WorkingDirectory $kamino.WorkingDirectory
Assert-Case (Test-HiddenActionEqual (Read-HiddenLaunchAction $spec) $kamino) 'FOR percent syntax survives canonical transport exactly'
$kamino.Arguments += ' & echo tampered'
$rejected = $false; try { Assert-SilentTaskPayload 'EVMAuditMonitorKaminoReduced' $kamino } catch { $rejected = $true }
Assert-Case $rejected 'appended command tampering refused'

# Source-built fixtures for every newly recognized installed grammar. No live
# task/action is read here, and all scheduler mutation functions remain mocks.
$savedName = $script:Name; $savedInner = $script:Inner
$system = [Environment]::SystemDirectory
$node = Get-SilentTrustedNode
$toolsRoot = Join-Path $script:SilentWorkspace 'tools'
$balanceArgs = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Set-Location ''' + $script:SilentWorkspace.Replace("'", "''") + '''; & node ''tools\watch-wallet-balances.js'' --once"'
$minimal = '(set NODE_OPTIONS=) & (set NODE_PATH=) & (for /f "delims=" %V in (''node tools\monitor-minimal-env.js --names-to-clear'') do set "%V=") & (node tools\monitor-minimal-env.js --assert-current >nul 2>&1 || exit /b 1) & '
$fixtures = @(
    @{ name = 'EVMAuditMonitorAlerts'; exe = 'cmd.exe'; cwd = ''; arg = ('/d /c node ' + (Join-Path $toolsRoot 'monitor-alert-dispatcher.js') + ' --apply'); target = (Join-Path $system 'cmd.exe'); normalized = $true },
    @{ name = 'EVMAuditTriggerCoverageAudit'; exe = 'node'; cwd = ''; arg = ((Join-Path $toolsRoot 'audit-trigger-coverage-universe.js') + ' --apply'); target = $node; normalized = $true },
    @{ name = 'EVMAuditMonitorSetWatchdog'; exe = 'CMD.EXE'; cwd = ''; arg = ('/d /c node ' + (Join-Path $toolsRoot 'monitor-set-watchdog.js') + ' --apply'); target = (Join-Path $system 'cmd.exe'); normalized = $true },
    @{ name = 'EVMAuditWalletBalances'; exe = 'powershell.exe'; cwd = $script:SilentWorkspace; arg = $balanceArgs; target = (Join-Path $system 'WindowsPowerShell\v1.0\powershell.exe'); normalized = $true },
    @{ name = 'EVMAuditMonitorSet'; exe = 'cmd.exe'; cwd = $script:SilentWorkspace; arg = ('/c "' + (Join-Path $toolsRoot 'monitor-set-autostart.cmd') + '"'); target = (Join-Path $system 'cmd.exe'); normalized = $true },
    @{ name = 'EVMAuditMonitorVenus'; exe = (Join-Path $system 'CMD.EXE').ToUpperInvariant(); cwd = $script:SilentWorkspace; arg = ('/c "' + $minimal + '(node tools\monitor-venus-psr-multichain.js --loop --use-authorized-inventory --allow-public-ethereum-fallback --interval-seconds 3600)"'); target = (Join-Path $system 'CMD.EXE').ToUpperInvariant(); normalized = $false },
    @{ name = 'EVMAuditTriggerCoverageAudit'; exe = 'NODE.EXE'; cwd = ''; arg = ('"' + (Join-Path $toolsRoot 'audit-trigger-coverage-universe.js') + '" --apply'); target = $node; normalized = $true },
    @{ name = 'EVMAuditTriggerCoverageAudit'; exe = $node.ToUpperInvariant(); cwd = ''; arg = ((Join-Path $toolsRoot 'audit-trigger-coverage-universe.js') + ' --apply'); target = $node.ToUpperInvariant(); normalized = $false },
    @{ name = 'EVMAuditMonitorAlerts'; exe = 'cmd.exe'; cwd = ''; arg = ('/d /c cd /d "' + $script:SilentWorkspace + '" && node tools\monitor-alert-dispatcher.js --apply'); target = (Join-Path $system 'cmd.exe'); normalized = $true }
)
foreach ($fixture in $fixtures) {
    $script:Name = $fixture.name
    $script:Inner = [pscustomobject]@{ Execute = $fixture.exe; Arguments = $fixture.arg; WorkingDirectory = $fixture.cwd }
    Reset-Fixture
    $result = Result
    Assert-Case ($result.status -ceq 'would-change' -and $result.executableNormalized -ceq $fixture.normalized -and $script:Sets -eq 0) 'exact installed grammar verifies with explicit alias normalization reporting'
    $result = Result -Apply
    Assert-Case ($result.status -ceq 'changed' -and $script:Sets -eq 1) 'installed-form mock migration remains action-only'
    $decoded = Read-HiddenLaunchAction $script:Task.Actions[0]
    Assert-Case ($decoded.Execute -ceq $fixture.target -and $decoded.Arguments -ceq $fixture.arg -and $decoded.WorkingDirectory -ceq $fixture.cwd -and [string]$script:Task.Actions[0].WorkingDirectory -ceq $fixture.cwd) 'alias pins trusted exe while raw arguments and cwd including empty survive exactly'
    $script:Task.Actions[0].Execute = ([string]$script:Task.Actions[0].Execute).ToUpperInvariant()
    $result = Result -Apply
    Assert-Case ($result.status -ceq 'unchanged' -and $script:Sets -eq 1) 'installed form stays idempotent with Windows executable casing'
    $script:BadAfterAction = $true; Reset-Fixture; $script:BadAfterAction = $true
    $result = Result -Apply
    Assert-Case ($result.reason -ceq 'TASK_UPDATE_NOT_APPLIED' -and $script:Sets -eq 1 -and (Test-HiddenActionEqual $script:Task.Actions[0] $script:Inner)) 'installed-form no-op failure retains original alias and exact empty cwd without a rollback write'
    foreach ($suffix in @(' & echo fixture-tamper', '; Write-Output fixture-tamper', ' --token fixture-secret', ' https://fixture.invalid')) {
        Reset-Fixture
        $script:Task.Actions = @([pscustomobject]@{ Execute = $fixture.exe; Arguments = ($fixture.arg + $suffix); WorkingDirectory = $fixture.cwd })
        $result = Result -Apply
        Assert-Case ($result.status -ceq 'refused' -and $script:Sets -eq 0 -and ($result | ConvertTo-Json -Compress) -notmatch 'fixture-secret|fixture.invalid|fixture-tamper') 'appended commands and endpoint/secret-shaped additions are refused without disclosure'
    }
    Reset-Fixture
    $script:Task.Actions = @([pscustomobject]@{ Execute = $fixture.exe; Arguments = $fixture.arg; WorkingDirectory = $toolsRoot })
    Assert-Case ((Result -Apply).reason -ceq 'TASK_WORKSPACE_UNVERIFIED' -and $script:Sets -eq 0) 'nonempty foreign cwd is never replaced or accepted'
    if ($fixture.arg.Contains($script:SilentWorkspace)) {
        Reset-Fixture
        $script:Task.Actions = @([pscustomobject]@{ Execute = $fixture.exe; Arguments = $fixture.arg.Replace($script:SilentWorkspace, ($script:SilentWorkspace + '\foreign')); WorkingDirectory = $fixture.cwd })
        Assert-Case ((Result -Apply).status -ceq 'refused' -and $script:Sets -eq 0) 'absolute script or cd marker must bind the exact workspace'
    }
}
$script:Name = 'EVMAuditTriggerCoverageAudit'
$script:Inner = [pscustomobject]@{ Execute = 'node'; Arguments = 'tools\audit-trigger-coverage-universe.js --apply'; WorkingDirectory = '' }
Reset-Fixture
Assert-Case ((Result -Apply).status -ceq 'refused' -and $script:Sets -eq 0) 'inherited cwd cannot bind a relative producer without exact cd grammar'
$script:Name = 'EVMAuditMonitorVenus'
$script:Inner = [pscustomobject]@{ Execute = (Join-Path $system 'cmd.exe'); Arguments = $fixtures[5].arg; WorkingDirectory = '' }
Reset-Fixture
Assert-Case ((Result -Apply).status -ceq 'refused' -and $script:Sets -eq 0) 'relative minimal-environment helper and producer require workspace cwd'
function Get-Command { [CmdletBinding()]param($Name, $CommandType, [switch]$All) return [pscustomobject]@{ Source = (Join-Path $toolsRoot 'node.exe') } }
$rejected = $false; try { Resolve-SilentExecutable 'node' | Out-Null } catch { $rejected = $_.Exception.Message -ceq 'TASK_EXECUTABLE_UNVERIFIED' }
Assert-Case $rejected 'arbitrary PATH-selected node cannot satisfy a trusted alias'
Remove-Item Function:Get-Command
$script:Name = $savedName; $script:Inner = $savedInner; Reset-Fixture

# Manager identities must reject a plausible but altered canonical wrapper too.
foreach ($manager in @('manage-profit-trigger-watch-task.ps1', 'manage-r17-task.ps1')) {
    . (Join-Path $PSScriptRoot $manager)
    $script:VerifiedPowerShellPath = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe'
    $spec = New-HiddenLaunchSpec -Executable $script:VerifiedPowerShellPath -Arguments ($ExpectedArguments + ' -Unexpected') -WorkingDirectory $WorkspacePath
    $fake = [pscustomobject]@{ TaskName = $TaskName; TaskPath = '\'; Actions = @($spec) }
    $rejected = $false; try { Assert-TaskIdentity $fake | Out-Null } catch { $rejected = $_.Exception.Message -ceq 'TASK_ACTION_MISMATCH' }
    Assert-Case $rejected 'manager rejects wrapped but non-exact inner payload'
    $spec = New-HiddenLaunchSpec -Executable $script:VerifiedPowerShellPath -Arguments $ExpectedArguments -WorkingDirectory $WorkspacePath
    $spec.Execute = ([string]$spec.Execute).ToUpperInvariant()
    $interval = if ($manager -ceq 'manage-r17-task.ps1') { 'PT15M' } else { 'PT4M' }
    $limit = if ($manager -ceq 'manage-r17-task.ps1') { 'PT14M' } else { 'PT10M' }
    $fake = [pscustomobject]@{
        TaskName = $TaskName; TaskPath = '\'; Actions = @($spec)
        Principal = [pscustomobject]@{ UserId = (Get-CurrentUserSid); RunLevel = 'Limited'; LogonType = 'Interactive' }
        Triggers = @([pscustomobject]@{ Repetition = [pscustomobject]@{ Interval = $interval; Duration = ''; StopAtDurationEnd = $false } })
        Settings = [pscustomobject]@{ MultipleInstances = 'IgnoreNew'; ExecutionTimeLimit = $limit; StartWhenAvailable = $false }
    }
    Assert-Case (Assert-TaskIdentity $fake) 'manager exact original payload and security settings remain compatible with Windows executable case identity'
    $fake.Actions = @(New-HiddenLaunchSpec -Executable $script:VerifiedPowerShellPath -Arguments $ExpectedArguments -WorkingDirectory '')
    $rejected = $false; try { Assert-TaskIdentity $fake | Out-Null } catch { $rejected = $_.Exception.Message -ceq 'TASK_ACTION_MISMATCH' }
    Assert-Case $rejected 'empty cwd support does not weaken a manager guard requiring exact workspace cwd'
}

# Kamino's existing operational entrypoint is sourced only with scheduler mocks;
# preflight output is discarded and no producer is ever executed.
function Get-ScheduledTask { [CmdletBinding()]param([string]$TaskName) return $null }
$savedConsole = [Console]::Out; $fixtureConsole = New-Object IO.StringWriter
try {
    [Console]::SetOut($fixtureConsole)
    . (Join-Path $PSScriptRoot 'manage-kamino-reduced-status-task.ps1') -Mode Preflight
} finally { [Console]::SetOut($savedConsole); $fixtureConsole.Dispose() }
function Write-Json { param([hashtable]$Value) }
$script:KaminoChecks = 0; $script:KaminoBadCwd = $false
function Get-ScheduledTask {
    [CmdletBinding()]param([string]$TaskName)
    $script:KaminoChecks++
    if ($script:KaminoChecks -eq 1) { return $null }
    $spec = New-HiddenLaunchSpec -Executable (Join-Path ([Environment]::SystemDirectory) 'cmd.exe') -Arguments (Get-TaskActionArgument) -WorkingDirectory $WorkspacePath
    if ($script:KaminoBadCwd) { $spec.WorkingDirectory = $PSScriptRoot }
    return [pscustomobject]@{ TaskName = 'EVMAuditMonitorKaminoReduced'; TaskPath = '\'; Actions = @($spec); State = 'Ready'; Settings = [pscustomobject]@{ Enabled = $true } }
}
function New-ScheduledTaskTrigger { param([switch]$AtLogOn) return [pscustomobject]@{} }
function New-ScheduledTaskPrincipal { param($UserId, $LogonType, $RunLevel) return [pscustomobject]@{} }
function New-ScheduledTaskSettingsSet { param($MultipleInstances, [switch]$AllowStartIfOnBatteries, [switch]$DontStopIfGoingOnBatteries, $ExecutionTimeLimit) return [pscustomobject]@{} }
function Register-ScheduledTask {
    param($TaskName, $Action, $Trigger, $Principal, $Settings)
    Assert-HiddenLaunchAction -Action $Action -Executable (Join-Path ([Environment]::SystemDirectory) 'cmd.exe') -Arguments (Get-TaskActionArgument) -WorkingDirectory $WorkspacePath
    return [pscustomobject]@{ TaskName = $TaskName }
}
Invoke-Install | Out-Null
Assert-Case ($script:KaminoChecks -eq 2) 'Kamino mock install uses exact canonical cmd payload and postvalidates'
$script:KaminoChecks = 0; $script:KaminoBadCwd = $true
$rejected = $false; try { Invoke-Install | Out-Null } catch { $rejected = $_.Exception.Message -ceq 'TASK_ACTION_MISMATCH' }
Assert-Case $rejected 'Kamino postvalidation rejects canonical wrapper with wrong cwd'

# Isolated Canary trigger repair. All Scheduler reads and writes below are mocks;
# only fixture XML is exported, never actual task actions or user identities.
function Reset-CanaryFixture {
    $action = New-HiddenLaunchSpec -Executable (Get-SilentTrustedNode) -Arguments ('"' + (Join-Path $PSScriptRoot 'refresh-canary-feeds.js') + '" --once') -WorkingDirectory $script:SilentWorkspace
    $script:CanaryTask = [pscustomobject]@{
        TaskName = 'EVMAuditCanaryFeeds'; TaskPath = '\'; State = 'Ready'; Actions = @($action)
        Principal = [pscustomobject]@{ UserId = 'fixture-private-user'; LogonType = 'InteractiveToken'; RunLevel = 'LeastPrivilege' }
        Settings = [pscustomobject]@{ Enabled = $true; MultipleInstances = 'IgnoreNew'; ExecutionTimeLimit = 'PT16M'; StartWhenAvailable = $true; WakeToRun = $false; DisallowStartIfOnBatteries = $true; StopIfGoingOnBatteries = $true }
        Triggers = @([pscustomobject]@{ Id = 'preserved-trigger-id'; StartBoundary = '2026-10-11T22:10:00Z'; EndBoundary = '2026-10-25T22:10:00Z'; Enabled = $true; RandomDelay = 'PT0S'; ExecutionTimeLimit = 'PT0S'; Repetition = [pscustomobject]@{ Interval = 'PT5M'; Duration = ''; StopAtDurationEnd = $false } })
    }
    $script:CanarySets = 0; $script:CanaryGets = 0; $script:CanaryNames = @()
    $script:CanaryDriftBefore = $false; $script:CanaryDriftAfter = ''; $script:CanaryDriftRollback = $false
    $script:CanaryThrowBefore = $false; $script:CanaryThrowAfter = $false; $script:CanaryNoop = $false; $script:CanaryInspectFailure = $false
}
function Get-ScheduledTask {
    [CmdletBinding()]param([string]$TaskName, [string]$TaskPath)
    if ($TaskName -cne 'EVMAuditCanaryFeeds' -or $TaskPath -cne '\') { throw 'TASK_TEST_CANARY_ONLY' }
    $script:CanaryNames += $TaskName; $script:CanaryGets++
    if (($script:CanaryDriftBefore -and $script:CanaryGets -eq 2) -or ($script:CanaryDriftRollback -and $script:CanaryGets -eq 4)) { $script:CanaryTask.Principal.UserId = 'concurrent-user' }
    if ($script:CanaryInspectFailure -and $script:CanarySets -gt 0) { throw 'TASK_TEST_INSPECTION_FAILED' }
    return $script:CanaryTask
}
function Export-ScheduledTask {
    [CmdletBinding()]param([string]$TaskName, [string]$TaskPath)
    if ($TaskName -cne 'EVMAuditCanaryFeeds' -or $TaskPath -cne '\') { throw 'TASK_TEST_CANARY_ONLY' }
    $t = $script:CanaryTask; $s = $t.Settings; $p = $t.Principal; $tr = $t.Triggers[0]; $r = $tr.Repetition; $a = $t.Actions[0]
    $end = if ($tr.EndBoundary -ceq '') { '' } else { '<EndBoundary>' + $tr.EndBoundary + '</EndBoundary>' }
    $duration = if ($r.Duration -ceq '') { '' } else { '<Duration>' + $r.Duration + '</Duration>' }
    return ('<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><RegistrationInfo><Description>unchanged-private-description</Description></RegistrationInfo>' +
        '<Triggers><TimeTrigger id="' + $tr.Id + '"><Repetition><Interval>' + $r.Interval + '</Interval>' + $duration + '<StopAtDurationEnd>' + ([string][bool]$r.StopAtDurationEnd).ToLowerInvariant() + '</StopAtDurationEnd></Repetition><StartBoundary>' + $tr.StartBoundary + '</StartBoundary>' + $end + '<Enabled>' + ([string][bool]$tr.Enabled).ToLowerInvariant() + '</Enabled><ExecutionTimeLimit>' + $tr.ExecutionTimeLimit + '</ExecutionTimeLimit><RandomDelay>' + $tr.RandomDelay + '</RandomDelay></TimeTrigger></Triggers>' +
        '<Principals><Principal><UserId>' + $p.UserId + '</UserId><LogonType>' + $p.LogonType + '</LogonType><RunLevel>' + $p.RunLevel + '</RunLevel></Principal></Principals>' +
        '<Settings><Enabled>' + ([string][bool]$s.Enabled).ToLowerInvariant() + '</Enabled><MultipleInstancesPolicy>' + $s.MultipleInstances + '</MultipleInstancesPolicy><ExecutionTimeLimit>' + $s.ExecutionTimeLimit + '</ExecutionTimeLimit><StartWhenAvailable>' + ([string][bool]$s.StartWhenAvailable).ToLowerInvariant() + '</StartWhenAvailable><WakeToRun>' + ([string][bool]$s.WakeToRun).ToLowerInvariant() + '</WakeToRun><DisallowStartIfOnBatteries>' + ([string][bool]$s.DisallowStartIfOnBatteries).ToLowerInvariant() + '</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>' + ([string][bool]$s.StopIfGoingOnBatteries).ToLowerInvariant() + '</StopIfGoingOnBatteries></Settings>' +
        '<Actions Context="preserved"><Exec><Command>' + [Security.SecurityElement]::Escape($a.Execute) + '</Command><Arguments>' + [Security.SecurityElement]::Escape($a.Arguments) + '</Arguments><WorkingDirectory>' + [Security.SecurityElement]::Escape($a.WorkingDirectory) + '</WorkingDirectory></Exec></Actions></Task>')
}
function Copy-CanaryScheduleTrigger {
    param($Trigger)
    return ($Trigger | ConvertTo-Json -Depth 4 | ConvertFrom-Json)
}
function Set-ScheduledTask {
    [CmdletBinding()]param($TaskName, $TaskPath, $Trigger)
    if ($TaskName -cne 'EVMAuditCanaryFeeds' -or $TaskPath -cne '\' -or @($Trigger).Count -ne 1) { throw 'TASK_TEST_CANARY_TRIGGER_ONLY' }
    $script:CanarySets++
    if ($script:CanarySets -eq 1 -and $script:CanaryThrowBefore) { throw 'TASK_TEST_SET_DENIED' }
    if ($script:CanarySets -eq 1 -and $script:CanaryNoop) { return }
    $script:CanaryTask.Triggers = @($Trigger)
    if ($script:CanarySets -eq 1) {
        switch ($script:CanaryDriftAfter) {
            'principal' { $script:CanaryTask.Principal.UserId = 'concurrent-user' }
            'settings' { $script:CanaryTask.Settings.WakeToRun = $true }
            'action' { $script:CanaryTask.Actions[0].Arguments += ' ' }
            'trigger' { $script:CanaryTask.Triggers[0].RandomDelay = 'PT1M' }
            'schedule' { $script:CanaryTask.Triggers[0].Repetition.Interval = 'PT7M' }
        }
        if ($script:CanaryThrowAfter) { throw 'TASK_TEST_SET_FAILED_AFTER_MUTATION' }
    }
}

Reset-CanaryFixture
$before = Get-CanaryScheduleSnapshot
$script:CanaryGets = 0
$results = @(Invoke-SilentTaskOperation -RepairCanarySchedule)
$result = $results[0]
Assert-Case ($results.Count -eq 1 -and $result.status -ceq 'would-change' -and $script:CanarySets -eq 0) 'schedule mode dry-run makes zero writes and does not invoke eleven-task migration'
Assert-Case ($result.current.endBoundary -ceq '2026-10-25T22:10:00.000Z' -and $null -eq $result.proposed.endBoundary -and $result.proposed.interval -ceq 'PT5M' -and $null -eq $result.proposed.duration) 'sanitized proposal removes only historical trigger expiry and keeps five-minute cadence'
Assert-Case ($result.settings.executionTimeLimit -ceq 'PT16M' -and $result.settings.startWhenAvailable -and $result.settings.multipleInstances -ceq 'IgnoreNew') 'dry-run exposes only safe relevant settings'
$report = $result | ConvertTo-Json -Depth 5 -Compress
Assert-Case ($report -notmatch 'fixture-private-user|unchanged-private-description|Arguments|wscript|node.exe|version|Principal|workingDirectory') 'dry-run never emits users actions XML or encoded payloads'
$result = Invoke-SilentTaskOperation -RepairCanarySchedule -Apply
Assert-Case ($result.status -ceq 'changed' -and $script:CanarySets -eq 1 -and @($script:CanaryNames | Where-Object { $_ -cne 'EVMAuditCanaryFeeds' }).Count -eq 0) 'repair changes only the exact root Canary task once'
$after = Get-CanaryScheduleSnapshot
Assert-Case ($after.NonTriggerXml -ceq $before.NonTriggerXml -and $after.TriggerInvariant -ceq $before.TriggerInvariant) 'actions principal logon privileges battery wake settings and unrelated trigger fields survive exactly'
Assert-Case ($after.Schedule.startBoundary -ceq $result.proposed.startBoundary -and $null -eq $after.Schedule.endBoundary -and $null -eq $after.Schedule.duration -and -not $after.Schedule.stopAtDurationEnd) 'postvalidation confirms current start and nonexpiring repetition'
$result = Invoke-SilentTaskOperation -RepairCanarySchedule -Apply
Assert-Case ($result.status -ceq 'unchanged' -and $script:CanarySets -eq 1) 'healthy schedule repair is idempotent'

foreach ($startWhenAvailable in @($true, $false)) {
    Reset-CanaryFixture; $script:CanaryTask.Settings.StartWhenAvailable = $startWhenAvailable
    $script:CanaryTask.Triggers[0].Repetition.Duration = 'PT24H'; $script:CanaryTask.Triggers[0].Repetition.StopAtDurationEnd = $true
    $result = Invoke-CanaryScheduleRepair -Apply
    Assert-Case ($result.status -ceq 'changed' -and $script:CanaryTask.Settings.StartWhenAvailable -ceq $startWhenAvailable -and $script:CanaryTask.Triggers[0].Repetition.Duration -ceq '') 'duration repair preserves StartWhenAvailable rather than changing operational policy'
}
Reset-CanaryFixture; $script:CanaryDriftBefore = $true
$result = Invoke-CanaryScheduleRepair -Apply
Assert-Case ($result.reason -ceq 'TASK_CHANGED_DURING_INSPECTION' -and $script:CanarySets -eq 0) 'concurrent drift before mutation is refused without writes'
Reset-CanaryFixture; $script:CanaryThrowBefore = $true
$result = Invoke-CanaryScheduleRepair -Apply
Assert-Case ($result.reason -ceq 'TASK_UPDATE_NOT_APPLIED' -and $script:CanarySets -eq 1) 'denied Set never causes an unnecessary rollback'
Reset-CanaryFixture; $script:CanaryNoop = $true
$result = Invoke-CanaryScheduleRepair -Apply
Assert-Case ($result.reason -ceq 'TASK_UPDATE_NOT_APPLIED' -and $script:CanarySets -eq 1) 'postvalidation rejects a successful but ineffective Set'
Reset-CanaryFixture; $script:CanaryThrowAfter = $true
$before = Export-ScheduledTask -TaskName 'EVMAuditCanaryFeeds' -TaskPath '\'
$result = Invoke-CanaryScheduleRepair -Apply
Assert-Case ($result.reason -ceq 'TASK_UPDATE_ROLLED_BACK' -and $script:CanarySets -eq 2 -and (Export-ScheduledTask -TaskName 'EVMAuditCanaryFeeds' -TaskPath '\') -ceq $before) 'failed owned update rolls back only its trigger and strictly verifies original XML'
foreach ($drift in @('principal', 'settings', 'action', 'trigger', 'schedule')) {
    Reset-CanaryFixture; $script:CanaryDriftAfter = $drift
    $result = Invoke-CanaryScheduleRepair -Apply
    Assert-Case ($result.reason -clike 'TASK_ROLLBACK_UNSAFE_*' -and $script:CanarySets -eq 1 -and $result.status -ceq 'refused') 'postvalidation drift is never overwritten by rollback'
}
Reset-CanaryFixture; $script:CanaryThrowAfter = $true; $script:CanaryDriftRollback = $true
$result = Invoke-CanaryScheduleRepair -Apply
Assert-Case ($result.reason -ceq 'TASK_ROLLBACK_UNSAFE_CONCURRENT_DRIFT' -and $script:CanarySets -eq 1) 'rollback rechecks ownership immediately before mutation'
Reset-CanaryFixture; $script:CanaryInspectFailure = $true
$result = Invoke-CanaryScheduleRepair -Apply
Assert-Case ($result.reason -ceq 'TASK_ROLLBACK_UNSAFE_ATTENDED_RECOVERY' -and $script:CanarySets -eq 1) 'unavailable post-state never justifies a blind rollback'

foreach ($invalid in @('name', 'path', 'disabled', 'unwrapped', 'async', 'payload', 'cwd', 'overlap', 'limit', 'triggers', 'date')) {
    Reset-CanaryFixture
    switch ($invalid) {
        'name' { $script:CanaryTask.TaskName = 'EVMAuditWalletBalances' }
        'path' { $script:CanaryTask.TaskPath = '\other\' }
        'disabled' { $script:CanaryTask.Settings.Enabled = $false }
        'unwrapped' { $script:CanaryTask.Actions = @(Read-HiddenLaunchAction $script:CanaryTask.Actions[0]) }
        'async' { $inner = Read-HiddenLaunchAction $script:CanaryTask.Actions[0]; $script:CanaryTask.Actions = @(New-HiddenLaunchSpec -Executable $inner.Execute -Arguments $inner.Arguments -WorkingDirectory $inner.WorkingDirectory -WaitForExit $false) }
        'payload' { $inner = Read-HiddenLaunchAction $script:CanaryTask.Actions[0]; $script:CanaryTask.Actions = @(New-HiddenLaunchSpec -Executable $inner.Execute -Arguments ($inner.Arguments + ' --loop') -WorkingDirectory $inner.WorkingDirectory) }
        'cwd' { $script:CanaryTask.Actions[0].WorkingDirectory = $PSScriptRoot }
        'overlap' { $script:CanaryTask.Settings.MultipleInstances = 'Parallel' }
        'limit' { $script:CanaryTask.Settings.ExecutionTimeLimit = 'PT15M' }
        'triggers' { $script:CanaryTask.Triggers = @($script:CanaryTask.Triggers[0], $script:CanaryTask.Triggers[0]) }
        'date' { $script:CanaryTask.Triggers[0].EndBoundary = 'fixture-secret-invalid-date' }
    }
    $result = Invoke-CanaryScheduleRepair -Apply
    Assert-Case ($result.status -ceq 'refused' -and $script:CanarySets -eq 0 -and ($result | ConvertTo-Json -Depth 5 -Compress) -notmatch 'fixture-secret') 'invalid identity canonical action settings or trigger metadata fail closed before mutation'
}
[Console]::Out.WriteLine((@{ ok = $true; passed = $script:Passed; failed = 0; fixtureOnly = $true } | ConvertTo-Json -Compress))
