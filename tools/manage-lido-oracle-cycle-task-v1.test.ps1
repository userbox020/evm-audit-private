[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Manager = Join-Path $PSScriptRoot 'manage-lido-oracle-cycle-task-v1.ps1'
$Engine = Join-Path $PSScriptRoot 'atomic\ethereum-top-trades-7d-reconstruction\lido-oracle-cycle-engine-v1.js'
$Source = [System.IO.File]::ReadAllText($Manager)
$EngineSource = [System.IO.File]::ReadAllText($Engine)
$script:Passed = 0

function Assert-Case {
    param([bool]$Condition, [string]$Name)
    if (-not $Condition) { throw "FAILED: $Name" }
    $script:Passed += 1
}

function Assert-ThrowsCode {
    param([scriptblock]$Action, [string]$Code, [string]$Name)
    $actual = $null
    try { & $Action } catch { $actual = [string]$_.Exception.Message }
    Assert-Case ($actual -ceq $Code) $Name
}

$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Manager, [ref]$tokens, [ref]$errors)
Assert-Case ($errors.Count -eq 0) 'parser accepts manager'
Assert-Case ($Source.Contains("ValidateSet('Preflight', 'Install', 'RunScheduled', 'Status', 'Uninstall')")) 'exact manager modes'
Assert-Case ([regex]::IsMatch($Source, '\[Parameter\(Mandatory = \$true\)\]\r?\n\s*\[string\]\$ManifestPath') -and $Source.Contains("ValidatePattern('^[0-9a-f]{64}$')")) 'manifest path and digest are mandatory'
Assert-Case ($Source.Contains("`$ManifestSchema = 'ETHEREUM_LIDO_ORACLE_CYCLE_MANIFEST_V1'") -and $Source.Contains("`$ManifestProfile = 'ETHEREUM_LIDO_NEST_FOUR_TARGET_V1'")) 'manager uses engine schema and profile'
Assert-Case ($Source.Contains("@('authority', 'capture', 'cycleId', 'immutable', 'mode', 'output', 'profile', 'reference', 'scheduler', 'schema', 'tools', 'window')")) 'manager uses exact engine top-level keys'
Assert-Case ($Source.Contains("@('automatic', 'retries', 'runOnce')") -and $Source.Contains("`$Manifest.scheduler.automatic -ne `$false") -and $Source.Contains("`$Manifest.scheduler.runOnce -ne `$true")) 'manager uses exact engine scheduler contract'
Assert-Case (-not $Source.Contains('$manifest.tools.manager') -and -not $Source.Contains('engineBundle')) 'manager invents no manager binding or bundle field'
Assert-Case ($Source.Contains("`$ExpectedEngineRelativePath = 'tools/atomic/ethereum-top-trades-7d-reconstruction/lido-oracle-cycle-engine-v1.js'") -and $Source.Contains('$manifest.tools.files')) 'engine binding comes from exact tools files row'
Assert-Case ($Source.Contains("`$LegacyReferenceArtifactPattern = '^ethereum-lido-nest-oracle-feed-(?:baseline|delta)-v[4-6]-[0-9]{8}-[0-9]{2}`$'")) 'manager uses exact engine legacy reference grammar'
Assert-Case ($Source.Contains("'reports\raw\fast\' + [string]`$manifest.output.artifact")) 'bundle path derives from engine output artifact'
Assert-Case ($Source.Contains("'EVM-Audit-Lido-Cycle-{0}-{1}'") -and $Source.Contains('$ManifestSha256.Substring(0, 12)') -and $Source.Contains("'Local\' + `$taskName")) 'task and mutex identities derive deterministically'
Assert-Case ($Source.Contains('New-TimeSpan -Minutes 5') -and $Source.Contains('New-TimeSpan -Hours 8') -and $Source.Contains('New-TimeSpan -Minutes 10')) 'manager fixes cadence duration and execution limit'
Assert-Case ($Source.Contains('[System.Environment]::SystemDirectory') -and $Source.Contains("`$PSVersionTable.PSVersion.Major -ne 5") -and $Source.Contains("`$PSVersionTable.PSVersion.Minor -ne 1")) 'trusted Windows PowerShell 5.1 is exact'
Assert-Case ($Source.Contains("Get-Command -Name 'node.exe' -CommandType Application") -and $Source.Contains('[System.IO.Path]::IsPathRooted($resolved)')) 'Node executable resolves absolutely'
Assert-Case ($Source.Contains('-LogonType Interactive -RunLevel Limited') -and $Source.Contains('Resolve-PrincipalSid') -and $Source.Contains('Get-CurrentUserSid')) 'principal uses current canonical SID and Interactive limited logon'
Assert-Case ($Source.Contains('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File') -and $Source.Contains('-Mode RunScheduled -ManifestPath') -and $Source.Contains('-ManifestSha256')) 'registered action has exact manager manifest arguments'
Assert-Case ($Source.Contains("'--run-if-ready' '--manifest-path' `$ManifestPath '--manifest-sha256' `$ManifestSha256")) 'child arguments exactly match engine CLI'
Assert-Case ($Source.Contains('WaitOne(0)') -and $Source.Contains('$script:Configuration.MutexName')) 'mutex is deterministic and nonblocking'
Assert-Case ($Source.Contains('if ($ChildExit -eq 3) { return 3 }') -and $Source.IndexOf('if ($ChildExit -eq 3) { return 3 }') -lt $Source.IndexOf('Disable-TerminalTask', $Source.IndexOf('function Complete-ScheduledRun'))) 'not-ready returns before disable'
Assert-Case ($Source.Contains('if ($ChildExit -in @(0, 1, 4)) { return $ChildExit }')) 'terminal and unexpected exit matrix is fixed'
Assert-Case ($Source.Contains('Remove-Item Env:NODE_OPTIONS') -and $Source.Contains('Remove-Item Env:NODE_PATH') -and $Source.Contains('$env:NODE_OPTIONS = $oldNodeOptions') -and $Source.Contains('$env:NODE_PATH = $oldNodePath')) 'Node environment is cleared and restored'
Assert-Case ($Source.Contains('try { Remove-JustCreatedFixedTask }') -and $Source.Contains('TASK_ALREADY_EXISTS') -and $Source.Contains('INSTALL_ROLLBACK_IDENTITY_MISMATCH')) 'install has no overwrite and guarded rollback'
Assert-Case (-not $Source.Contains('-TaskName *') -and -not $Source.Contains('Unregister-ScheduledTask *') -and -not $Source.Contains('Get-ScheduledTask |')) 'no wildcard or listing task operation'
Assert-Case (-not $Source.Contains('cmd.exe') -and -not $Source.Contains('cmd /c') -and -not $Source.Contains('Start-Process') -and -not $Source.Contains('Out-File') -and -not $Source.Contains('Tee-Object')) 'no cmd detached child redirection or logs'
Assert-Case ($Source.Contains("@('classification', 'counts', 'currentBlock', 'cycleId', 'manifestSha256', 'mode', 'reasonCode', 'status')")) 'status validates exact engine terminal keys'
Assert-Case ($Source.Contains('ENGINE_TERMINAL_ARTIFACT_MISSING') -and $Source.Contains("Join-Path `$script:Configuration.BundlePath 'terminal.json'")) 'status maps missing disabled terminal safely'
Assert-Case ($EngineSource.Contains('const MANIFEST_SCHEMA = "ETHEREUM_LIDO_ORACLE_CYCLE_MANIFEST_V1"') -and $EngineSource.Contains('const PROFILE = "ETHEREUM_LIDO_NEST_FOUR_TARGET_V1"')) 'fixture contract is anchored to engine constants'
Assert-Case ($EngineSource.Contains('exact(manifest, ["authority", "capture", "cycleId", "immutable", "mode", "output", "profile", "reference", "scheduler", "schema", "tools", "window"]')) 'fixture top-level shape is anchored to engine validator'

$preflightAst = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-Preflight' }, $true)
Assert-Case ($null -ne $preflightAst) 'preflight function exists'
$preflightCommands = @($preflightAst.Body.FindAll({ param($node) $node -is [System.Management.Automation.Language.CommandAst] }, $true) | ForEach-Object { $_.GetCommandName() })
$forbidden = @('Get-ScheduledTask', 'Get-ScheduledTaskInfo', 'Register-ScheduledTask', 'Disable-ScheduledTask', 'Unregister-ScheduledTask', 'Start-Process', 'node.exe')
Assert-Case (@($preflightCommands | Where-Object { $_ -in $forbidden }).Count -eq 0) 'preflight directly performs no task operation or child execution'

$fixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('lido-cycle-manager-v1-' + [Guid]::NewGuid().ToString('N'))
$workspace = Join-Path $fixtureRoot 'workspace'
$atomic = Join-Path $workspace 'tools\atomic\ethereum-top-trades-7d-reconstruction'
$manifestRoot = Join-Path $atomic 'lido-oracle-cycle-manifests'
$reports = Join-Path $workspace 'reports\raw\fast'
[void][System.IO.Directory]::CreateDirectory($manifestRoot)
[void][System.IO.Directory]::CreateDirectory($reports)
$fixtureManager = Join-Path $workspace 'tools\manage-lido-oracle-cycle-task-v1.ps1'
[System.IO.File]::WriteAllBytes($fixtureManager, [System.IO.File]::ReadAllBytes($Manager))
$manifestFile = Join-Path $manifestRoot 'cycle.json'
$placeholderDigest = '0' * 64

. $Manager -Mode Preflight -ManifestPath ([System.IO.Path]::GetFullPath($manifestFile)) -ManifestSha256 $placeholderDigest
$WorkspacePath = [System.IO.Path]::GetFullPath($workspace)
$ManagerPath = [System.IO.Path]::GetFullPath($fixtureManager)
$ManifestRootPath = [System.IO.Path]::GetFullPath($manifestRoot)
$ManifestPath = [System.IO.Path]::GetFullPath($manifestFile)
$trustedPowerShell = [System.IO.Path]::GetFullPath((Join-Path ([System.Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe'))
function Get-VerifiedPowerShellPath { return $trustedPowerShell }
function Get-VerifiedNodePath { return $trustedPowerShell }

function New-FileFact {
    param([string]$RelativePath, [string]$Text)
    $absolute = [System.IO.Path]::GetFullPath((Join-Path $WorkspacePath $RelativePath.Replace('/', '\')))
    [void][System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($absolute))
    $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($Text)
    [System.IO.File]::WriteAllBytes($absolute, $bytes)
    return [pscustomobject]@{ path = $RelativePath; bytes = [int64]$bytes.LongLength; sha256 = Get-Sha256Hex $bytes }
}

function Get-Hex64 {
    param([int]$Value)
    return $Value.ToString('x').PadLeft(64, '0')
}

function New-EngineCompatibleManifest {
    $toolRows = @()
    $index = 0
    foreach ($relative in $ExpectedToolRelativePaths) { $toolRows += New-FileFact $relative ("tool-{0}`n" -f $index); $index += 1 }
    $authorityFile = New-FileFact 'authority/pin.json' "{}`n"
    $referenceArtifact = 'ethereum-lido-nest-oracle-cycle-reference-0001'
    $referenceState = New-FileFact ("reports/raw/fast/{0}/state.json" -f $referenceArtifact) "{}`n"
    $referenceManifest = New-FileFact ("reports/raw/fast/{0}/manifest.json" -f $referenceArtifact) "{}`n"
    $referenceTool = New-FileFact 'tools/reference.js' "module.exports = {};`n"
    $categories = @('ADAPTER_MODULE_POINTER', 'FEED_HEALTH', 'FEED_POINTER', 'ORACLE_POINTER')
    $targets = @()
    for ($i = 0; $i -lt $categories.Count; $i += 1) { $targets += [pscustomobject]@{ category = $categories[$i]; targetCommitment = Get-Hex64 ($i + 1); authorityCommitment = Get-Hex64 ($i + 11); runtimeIdentityCommitment = Get-Hex64 ($i + 21) } }
    $capture = [pscustomobject]@{ candidateCap = 8; concurrencyCap = 4; eventRangeBlockCap = 2048; eventsPerTargetCap = 8; inventoryBytes = 2097152; inventoryEntries = 64; latestFallback = $false; logRequestCap = 16; observerCount = 2; outputBytes = 196608; requestCap = 128; requestTimeoutMs = 12000; responseBytes = 2097152; retries = 0; sourceRequests = 0; targetCount = 4; totalResponseBytes = 41943040; totalTimeoutMs = 480000; traces = 0 }
    return [pscustomobject]@{
        schema = 'ETHEREUM_LIDO_ORACLE_CYCLE_MANIFEST_V1'; immutable = $true; cycleId = 'LIDO_DELTA_CYCLE_0001'; profile = 'ETHEREUM_LIDO_NEST_FOUR_TARGET_V1'; mode = 'DELTA'
        output = [pscustomobject]@{ artifact = 'ethereum-lido-nest-oracle-cycle-delta-0001' }
        tools = [pscustomobject]@{ files = $toolRows }
        authority = [pscustomobject]@{ commitment = Get-Hex64 90; files = @($authorityFile); targets = $targets }
        reference = [pscustomobject]@{ artifact = $referenceArtifact; tool = $referenceTool; state = $referenceState; manifest = $referenceManifest; outputCommitment = Get-Hex64 70; classification = 'LIDO_BASELINE_ESTABLISHED'; blockNumber = '1000'; projectionCommitment = Get-Hex64 71; authorityCommitment = Get-Hex64 90 }
        window = [pscustomobject]@{ minimumInclusive = '1256'; maximumInclusive = '3048' }
        capture = $capture
        scheduler = [pscustomobject]@{ automatic = $false; retries = 0; runOnce = $true }
    }
}

function Write-Manifest {
    param($Value, [switch]$Pretty)
    $text = if ($Pretty) { ($Value | ConvertTo-Json -Depth 12) + "`n" } else { (ConvertTo-CanonicalJson $Value) + "`n" }
    $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($text)
    [System.IO.File]::WriteAllBytes($ManifestPath, $bytes)
    $script:ManifestSha256 = Get-Sha256Hex $bytes
}

try {
    $manifest = New-EngineCompatibleManifest
    Write-Manifest $manifest
    Assert-ManifestAndTools
    Assert-Case ($script:Configuration.CycleId -ceq 'LIDO_DELTA_CYCLE_0001' -and $script:Configuration.CycleMode -ceq 'DELTA') 'engine-compatible canonical fixture validates'
    Assert-Case ($script:Configuration.BundlePath.EndsWith('\reports\raw\fast\ethereum-lido-nest-oracle-cycle-delta-0001', [System.StringComparison]::OrdinalIgnoreCase)) 'fixture bundle resolves under reports raw fast'
    Assert-Case ($script:Configuration.TaskName -match '^EVM-Audit-Lido-Cycle-LIDO_DELTA_CYCLE_0001-[0-9a-f]{12}$' -and $script:Configuration.MutexName -ceq ('Local\' + $script:Configuration.TaskName)) 'safe task identities derive from cycle and digest'
    Assert-Case ($script:Configuration.ManagerSha256 -ceq (Get-Sha256Hex ([System.IO.File]::ReadAllBytes($fixtureManager)))) 'manager self-validates without manifest binding'

    $savedPath = $ManifestPath
    $ManifestPath = [System.IO.Path]::GetFullPath((Join-Path $fixtureRoot 'outside.json'))
    Assert-ThrowsCode { Assert-ManifestAndTools } 'MANIFEST_PATH_INVALID' 'manifest outside engine manifest directory is rejected'
    $ManifestPath = $savedPath
    $savedDigest = $ManifestSha256
    $ManifestSha256 = 'f' * 64
    Assert-ThrowsCode { Assert-ManifestAndTools } 'MANIFEST_DIGEST_MISMATCH' 'manifest digest mismatch is rejected'
    $ManifestSha256 = $savedDigest

    Write-Manifest $manifest -Pretty
    Assert-ThrowsCode { Assert-ManifestAndTools } 'MANIFEST_CANONICAL_BYTES_INVALID' 'noncanonical engine manifest is rejected'
    Write-Manifest $manifest

    $legacy = 'ethereum-lido-nest-oracle-feed-delta-v6-20260829-01'
    $manifest = New-EngineCompatibleManifest
    $manifest.reference.artifact = $legacy
    $manifest.reference.state = New-FileFact ("reports/raw/fast/{0}/state.json" -f $legacy) "{}`n"
    $manifest.reference.manifest = New-FileFact ("reports/raw/fast/{0}/manifest.json" -f $legacy) "{}`n"
    Write-Manifest $manifest
    Assert-ManifestAndTools
    Assert-Case ([string]$manifest.reference.artifact -ceq $legacy) 'legacy delta V6 reference artifact is accepted'

    $manifest = New-EngineCompatibleManifest
    $manifest.reference.artifact = 'ethereum-lido-nest-oracle-feed-delta-v7-20260829-01'
    $manifest.reference.state.path = 'reports/raw/fast/ethereum-lido-nest-oracle-feed-delta-v7-20260829-01/state.json'
    $manifest.reference.manifest.path = 'reports/raw/fast/ethereum-lido-nest-oracle-feed-delta-v7-20260829-01/manifest.json'
    Write-Manifest $manifest
    Assert-ThrowsCode { Assert-ManifestAndTools } 'MANIFEST_REFERENCE_INVALID' 'arbitrary legacy-like reference artifact is rejected'

    $manifest = New-EngineCompatibleManifest
    $manifest.output.artifact = $legacy
    Write-Manifest $manifest
    Assert-ThrowsCode { Assert-ManifestAndTools } 'MANIFEST_OUTPUT_INVALID' 'legacy artifact grammar is rejected for output'

    $old = [pscustomobject]@{ schemaVersion = 'lido-oracle-cycle-manifest/v1'; profile = 'lido-oracle-cycle-v1'; mode = 'scheduled'; scheduler = [pscustomobject]@{}; tools = [pscustomobject]@{}; engineBundle = [pscustomobject]@{} }
    Write-Manifest $old
    Assert-ThrowsCode { Assert-ManifestAndTools } 'MANIFEST_SCHEMA_INVALID' 'old incompatible manager-only schema is rejected'

    $manifest = New-EngineCompatibleManifest
    $manifest.scheduler.automatic = $true
    Write-Manifest $manifest
    Assert-ThrowsCode { Assert-ManifestAndTools } 'MANIFEST_SCHEDULER_INVALID' 'engine scheduler mismatch is rejected'
    $manifest = New-EngineCompatibleManifest
    Write-Manifest $manifest
    $engineRow = @($manifest.tools.files | Where-Object { $_.path -ceq $ExpectedEngineRelativePath })[0]
    [System.IO.File]::AppendAllText((Join-Path $WorkspacePath $ExpectedEngineRelativePath.Replace('/', '\')), 'tamper')
    Assert-ThrowsCode { Assert-ManifestAndTools } 'MANIFEST_TOOL_TAMPER' 'engine tool tamper is rejected'
    [System.IO.File]::WriteAllText((Join-Path $WorkspacePath $ExpectedEngineRelativePath.Replace('/', '\')), "tool-1`n", [System.Text.UTF8Encoding]::new($false))
    $manifest = New-EngineCompatibleManifest
    Write-Manifest $manifest
    Assert-ManifestAndTools

    $script:MockGetCount = 0
    $script:MockRegisterCount = 0
    $script:MockUnregisterCount = 0
    $script:MockDisableCount = 0
    $script:MockExistingTask = $null
    $script:MockRollbackTask = [pscustomobject]@{ TaskName = $script:Configuration.TaskName; TaskPath = '\' }
    function Get-ScheduledTask { [CmdletBinding()] param([string]$TaskName) $script:MockGetCount += 1; if ($script:MockGetCount -eq 1) { return $script:MockExistingTask }; return $script:MockRollbackTask }
    function New-ScheduledTaskAction { param($Execute, $Argument, $WorkingDirectory) $script:Action = [pscustomobject]@{ Execute = [string]$Execute; Arguments = [string]$Argument; WorkingDirectory = [string]$WorkingDirectory }; return $script:Action }
    function New-ScheduledTaskTrigger { param([switch]$Once, $At, $RepetitionInterval, $RepetitionDuration) return [pscustomobject]@{ Repetition = [pscustomobject]@{ Interval = 'PT5M'; Duration = 'PT8H' } } }
    function New-ScheduledTaskPrincipal { param($UserId, $LogonType, $RunLevel) return [pscustomobject]@{ UserId = [string]$UserId; LogonType = [string]$LogonType; RunLevel = [string]$RunLevel } }
    function New-ScheduledTaskSettingsSet { param($MultipleInstances, $ExecutionTimeLimit, [switch]$AllowStartIfOnBatteries, [switch]$DontStopIfGoingOnBatteries) return [pscustomobject]@{ Enabled = $true; ExecutionTimeLimit = 'PT10M'; MultipleInstances = 'IgnoreNew' } }
    function Register-ScheduledTask { param($TaskName, $Action, $Trigger, $Principal, $Settings) $script:MockRegisterCount += 1; $bad = [pscustomobject]@{ Execute = 'powershell.exe'; Arguments = $Action.Arguments; WorkingDirectory = $Action.WorkingDirectory }; return [pscustomobject]@{ TaskName = $TaskName; TaskPath = '\'; Actions = @($bad); Principal = $Principal; Triggers = @($Trigger); Settings = $Settings } }
    function Unregister-ScheduledTask { param($TaskName, [switch]$Confirm) $script:MockUnregisterCount += 1; $script:UnregisteredName = [string]$TaskName }
    function Disable-ScheduledTask { param($TaskName) $script:MockDisableCount += 1; $script:DisabledName = [string]$TaskName }
    function Write-SanitizedJson { param([hashtable]$Value) $script:CapturedJson = $Value }

    Assert-ThrowsCode { Invoke-Install } 'TASK_POSTVALIDATION_TASK_ACTION_MISMATCH' 'postvalidation action mismatch fails closed'
    Assert-Case ($script:MockRegisterCount -eq 1 -and $script:MockUnregisterCount -eq 1 -and $script:UnregisteredName -ceq $script:Configuration.TaskName) 'failed install rolls back exact derived task once'
    Assert-Case ([System.IO.Path]::IsPathRooted($script:Action.Execute) -and $script:Action.Arguments -ceq $script:ExpectedArguments) 'install uses exact absolute action'
    $script:MockGetCount = 0; $script:MockRegisterCount = 0; $script:MockUnregisterCount = 0; $script:MockExistingTask = [pscustomobject]@{ TaskName = $script:Configuration.TaskName; TaskPath = '\' }
    Assert-ThrowsCode { Invoke-Install } 'TASK_ALREADY_EXISTS' 'existing derived task is never overwritten'
    Assert-Case ($script:MockRegisterCount -eq 0 -and $script:MockUnregisterCount -eq 0) 'existing task remains untouched'

    $currentSid = Get-CurrentUserSid
    $exactTask = [pscustomobject]@{ TaskName = $script:Configuration.TaskName; TaskPath = '\'; State = 'Ready'; Actions = @([pscustomobject]@{ Execute = $script:VerifiedPowerShellPath; Arguments = $script:ExpectedArguments; WorkingDirectory = $WorkspacePath }); Principal = [pscustomobject]@{ UserId = $currentSid; LogonType = 'Interactive'; RunLevel = 'Limited' }; Triggers = @([pscustomobject]@{ Repetition = [pscustomobject]@{ Interval = 'PT5M'; Duration = 'PT8H' } }); Settings = [pscustomobject]@{ Enabled = $true; ExecutionTimeLimit = 'PT10M'; MultipleInstances = 'IgnoreNew' } }
    $script:MockRollbackTask = $exactTask; $script:MockGetCount = 1; $script:MockDisableCount = 0
    Assert-Case ((Complete-ScheduledRun 3) -eq 3 -and $script:MockDisableCount -eq 0) 'not-ready keeps task enabled'
    foreach ($code in @(0, 1, 4, 9)) { $before = $script:MockDisableCount; $actual = Complete-ScheduledRun $code; $expected = if ($code -in @(0, 1, 4)) { $code } else { 1 }; Assert-Case ($actual -eq $expected -and $script:MockDisableCount -eq $before + 1) ("exit {0} disables exact task once" -f $code) }

    function Get-ScheduledTaskInfo { param($TaskName) return [pscustomobject]@{ LastTaskResult = 0 } }
    $counts = [pscustomobject]@{ candidates = 2; events = 0; logReads = 1; qualified = 2; reads = 8; selected = 2; targets = 4; validPairs = 1 }
    $terminal = [pscustomobject]@{ cycleId = $script:Configuration.CycleId; mode = 'DELTA'; status = 'PUBLISHED'; reasonCode = 'CAPTURE_COMPLETE'; manifestSha256 = $ManifestSha256; currentBlock = '1300'; classification = 'UNCHANGED'; counts = $counts }
    $terminalPath = Join-Path $script:Configuration.BundlePath 'terminal.json'
    [void][System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($terminalPath))
    [System.IO.File]::WriteAllBytes($terminalPath, [System.Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-CanonicalJson $terminal) + "`n"))
    $exactTask.Settings.Enabled = $false; $script:MockGetCount = 1; $script:CapturedJson = $null; Invoke-Status; $status = $script:CapturedJson
    Assert-Case ($status.terminal -eq $true -and $status.reason -ceq 'CAPTURE_COMPLETE' -and $status.enabled -eq $false) 'status validates engine terminal schema'
    [System.IO.File]::Delete($terminalPath); $script:MockGetCount = 1; $script:CapturedJson = $null; Invoke-Status; $missing = $script:CapturedJson
    Assert-Case ($missing.terminal -eq $true -and $missing.reason -ceq 'ENGINE_TERMINAL_ARTIFACT_MISSING') 'disabled task maps missing terminal safely'

    $script:MockGetCount = 0; $script:CapturedJson = $null; Invoke-Preflight; $preflight = $script:CapturedJson
    Assert-Case ($preflight.ok -eq $true -and $preflight.taskQueried -eq $false -and $preflight.taskChanged -eq $false -and $preflight.childExecuted -eq $false) 'safe injected preflight succeeds without task or child operations'
    Assert-Case ($preflight.inventoryRead -eq $false -and $preflight.networkRead -eq $false -and $preflight.outputAccess -eq $false) 'safe injected preflight avoids inventory network and output'
}
finally {
    if ([System.IO.Directory]::Exists($fixtureRoot)) { [System.IO.Directory]::Delete($fixtureRoot, $true) }
}

[Console]::Out.WriteLine((@{ ok = $true; passed = $script:Passed; failed = 0 } | ConvertTo-Json -Compress))
