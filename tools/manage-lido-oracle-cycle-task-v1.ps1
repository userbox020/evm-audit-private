[CmdletBinding()]
param(
    [ValidateSet('Preflight', 'Install', 'RunScheduled', 'Status', 'Uninstall')]
    [string]$Mode = 'Preflight',
    [Parameter(Mandatory = $true)]
    [string]$ManifestPath,
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9a-f]{64}$')]
    [string]$ManifestSha256
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ManagerVersion = 'lido-oracle-cycle-task-manager/v1'
$ManifestSchema = 'ETHEREUM_LIDO_ORACLE_CYCLE_MANIFEST_V1'
$ManifestProfile = 'ETHEREUM_LIDO_NEST_FOUR_TARGET_V1'
$WorkspacePath = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$ManagerPath = [System.IO.Path]::GetFullPath($PSCommandPath)
$ManifestRootPath = [System.IO.Path]::GetFullPath((Join-Path $WorkspacePath 'tools\atomic\ethereum-top-trades-7d-reconstruction\lido-oracle-cycle-manifests'))
$ExpectedEngineRelativePath = 'tools/atomic/ethereum-top-trades-7d-reconstruction/lido-oracle-cycle-engine-v1.js'
$AllowedEngineRootRelativePath = 'tools/atomic/ethereum-top-trades-7d-reconstruction/'
$GenericOutputArtifactPattern = '^ethereum-lido-nest-oracle-cycle-[a-z0-9][a-z0-9-]{7,119}$'
$LegacyReferenceArtifactPattern = '^ethereum-lido-nest-oracle-feed-(?:baseline|delta)-v[4-6]-[0-9]{8}-[0-9]{2}$'
$ExpectedToolRelativePaths = @(
    'tools/atomic/ethereum-top-trades-7d-reconstruction/collector.js',
    'tools/atomic/ethereum-top-trades-7d-reconstruction/lido-oracle-cycle-engine-v1.js',
    'tools/atomic/ethereum-top-trades-7d-reconstruction/oracle-feed-module-baseline-v4.js',
    'tools/atomic/ethereum-top-trades-7d-reconstruction/oracle-feed-module-baseline-v5.js',
    'tools/atomic/ethereum-top-trades-7d-reconstruction/oracle-feed-module-delta-phase3.js',
    'tools/atomic/ethereum-top-trades-7d-reconstruction/oracle-feed-module-delta-v2.js',
    'tools/atomic/ethereum-top-trades-7d-reconstruction/oracle-feed-module-delta-v6.js'
)
$Cadence = New-TimeSpan -Minutes 5
$Duration = New-TimeSpan -Hours 8
$ExecutionLimit = New-TimeSpan -Minutes 10
$script:Configuration = $null
$script:VerifiedPowerShellPath = $null
$script:VerifiedNodePath = $null
$script:ExpectedArguments = $null

function Write-SanitizedJson {
    param([hashtable]$Value)
    [Console]::Out.WriteLine(($Value | ConvertTo-Json -Compress -Depth 6))
}

function Get-Sha256Hex {
    param([Parameter(Mandatory = $true)][byte[]]$Bytes)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return (($sha.ComputeHash($Bytes) | ForEach-Object { $_.ToString('x2') }) -join '') }
    finally { $sha.Dispose() }
}

function ConvertTo-CanonicalJson {
    param($Value)
    if ($null -eq $Value) { return 'null' }
    if ($Value -is [string]) { return ($Value | ConvertTo-Json -Compress) }
    if ($Value -is [bool]) { if ($Value) { return 'true' } else { return 'false' } }
    if ($Value -is [sbyte] -or $Value -is [byte] -or $Value -is [int16] -or $Value -is [uint16] -or $Value -is [int32] -or $Value -is [uint32] -or $Value -is [int64] -or $Value -is [uint64]) {
        return ([System.Convert]::ToString($Value, [System.Globalization.CultureInfo]::InvariantCulture))
    }
    if ($Value -is [System.Collections.IDictionary]) {
        $names = @($Value.Keys | ForEach-Object { [string]$_ } | Sort-Object -CaseSensitive)
        $parts = foreach ($name in $names) { (ConvertTo-CanonicalJson $name) + ':' + (ConvertTo-CanonicalJson $Value[$name]) }
        return '{' + ($parts -join ',') + '}'
    }
    if ($Value -is [System.Array] -or ($Value -is [System.Collections.IEnumerable] -and -not ($Value -is [string]))) {
        $parts = foreach ($entry in $Value) { ConvertTo-CanonicalJson $entry }
        return '[' + ($parts -join ',') + ']'
    }
    $properties = @($Value.PSObject.Properties)
    if ($properties.Count -gt 0) {
        $parts = foreach ($property in @($properties | Sort-Object Name -CaseSensitive)) {
            (ConvertTo-CanonicalJson ([string]$property.Name)) + ':' + (ConvertTo-CanonicalJson $property.Value)
        }
        return '{' + ($parts -join ',') + '}'
    }
    if ($Value -is [System.Management.Automation.PSCustomObject]) { return '{}' }
    throw 'MANIFEST_CANONICAL_VALUE_INVALID'
}

function Assert-ExactProperties {
    param($Value, [string[]]$Expected, [string]$Code)
    if ($null -eq $Value -or $Value -is [System.Array]) { throw $Code }
    $actual = @($Value.PSObject.Properties.Name | Sort-Object -CaseSensitive)
    $wanted = @($Expected | Sort-Object -CaseSensitive)
    if (($actual -join "`n") -cne ($wanted -join "`n")) { throw $Code }
}

function Assert-DirectoryChainNoReparse {
    param([Parameter(Mandatory = $true)][string]$Root, [Parameter(Mandatory = $true)][string]$TargetDirectory, [string]$Code)
    $rootFull = [System.IO.Path]::GetFullPath($Root)
    $targetFull = [System.IO.Path]::GetFullPath($TargetDirectory)
    $boundary = $rootFull.TrimEnd('\') + '\'
    if (-not [System.StringComparer]::OrdinalIgnoreCase.Equals($targetFull, $rootFull) -and -not $targetFull.StartsWith($boundary, [System.StringComparison]::OrdinalIgnoreCase)) { throw $Code }
    $current = $targetFull
    while ($true) {
        $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
        if (-not $item.PSIsContainer -or (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) { throw $Code }
        if ([System.StringComparer]::OrdinalIgnoreCase.Equals($current, $rootFull)) { break }
        $current = [System.IO.Path]::GetDirectoryName($current)
    }
}

function Read-StableRegularFile {
    param([Parameter(Mandatory = $true)][string]$Path, [int64]$MaximumBytes, [string]$Code)
    $full = [System.IO.Path]::GetFullPath($Path)
    $before = Get-Item -LiteralPath $full -Force -ErrorAction Stop
    if ($before.PSIsContainer -or (($before.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) -or $before.Length -lt 1 -or $before.Length -gt $MaximumBytes -or $before.FullName -cne $full) { throw $Code }
    $bytes = [System.IO.File]::ReadAllBytes($full)
    $after = Get-Item -LiteralPath $full -Force -ErrorAction Stop
    if ($after.PSIsContainer -or (($after.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) -or $after.FullName -cne $full -or $after.Length -ne $before.Length -or $after.Length -ne $bytes.LongLength -or $after.LastWriteTimeUtc.Ticks -ne $before.LastWriteTimeUtc.Ticks) { throw $Code }
    return ,$bytes
}

function Resolve-BoundWorkspaceFile {
    param([string]$RelativePath, [string]$RequiredPrefix, [int64]$ExpectedBytes, [string]$ExpectedSha256, [string]$Code)
    if ([string]::IsNullOrEmpty($RelativePath) -or $RelativePath.Length -gt 240 -or $RelativePath -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._/-]*$' -or $RelativePath.Contains('\') -or $RelativePath.Contains('//') -or [System.IO.Path]::IsPathRooted($RelativePath)) { throw $Code }
    $segments = @($RelativePath.Split('/'))
    if (@($segments | Where-Object { $_ -eq '.' -or $_ -eq '..' -or $_.Length -eq 0 }).Count -ne 0 -or -not $RelativePath.StartsWith($RequiredPrefix, [System.StringComparison]::Ordinal)) { throw $Code }
    $nativeRelative = $RelativePath.Replace('/', '\')
    $resolved = [System.IO.Path]::GetFullPath((Join-Path $WorkspacePath $nativeRelative))
    $workspaceBoundary = $WorkspacePath.TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($workspaceBoundary, [System.StringComparison]::OrdinalIgnoreCase)) { throw $Code }
    Assert-DirectoryChainNoReparse -Root $WorkspacePath -TargetDirectory ([System.IO.Path]::GetDirectoryName($resolved)) -Code $Code
    $bytes = Read-StableRegularFile -Path $resolved -MaximumBytes 16777216 -Code $Code
    if ($ExpectedBytes -lt 1 -or $bytes.LongLength -ne $ExpectedBytes -or $ExpectedSha256 -cnotmatch '^[0-9a-f]{64}$' -or (Get-Sha256Hex $bytes) -cne $ExpectedSha256) { throw $Code }
    return $resolved
}

function Get-VerifiedPowerShellPath {
    if ($PSVersionTable.PSEdition -ne 'Desktop' -or $PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) { throw 'POWERSHELL_VERSION_INVALID' }
    $trustedHome = [System.IO.Path]::GetFullPath((Join-Path ([System.Environment]::SystemDirectory) 'WindowsPowerShell\v1.0'))
    if (-not [System.StringComparer]::OrdinalIgnoreCase.Equals([System.IO.Path]::GetFullPath($PSHOME), $trustedHome)) { throw 'POWERSHELL_HOME_INVALID' }
    $expected = [System.IO.Path]::GetFullPath((Join-Path $trustedHome 'powershell.exe'))
    $applications = @(Get-Command -Name $expected -CommandType Application -ErrorAction Stop)
    if ($applications.Count -ne 1) { throw 'POWERSHELL_PATH_AMBIGUOUS' }
    $resolved = [System.IO.Path]::GetFullPath($applications[0].Source)
    if (-not [System.IO.Path]::IsPathRooted($resolved) -or -not [System.IO.File]::Exists($resolved) -or -not [System.StringComparer]::OrdinalIgnoreCase.Equals($resolved, $expected)) { throw 'POWERSHELL_PATH_INVALID' }
    return $resolved
}

function Get-VerifiedNodePath {
    $applications = @(Get-Command -Name 'node.exe' -CommandType Application -ErrorAction Stop)
    if ($applications.Count -ne 1) { throw 'NODE_PATH_AMBIGUOUS' }
    $resolved = [System.IO.Path]::GetFullPath($applications[0].Source)
    if (-not [System.IO.Path]::IsPathRooted($resolved) -or -not [System.IO.File]::Exists($resolved) -or [System.IO.Path]::GetFileName($resolved) -cne 'node.exe') { throw 'NODE_PATH_INVALID' }
    return $resolved
}

function Test-ManifestInteger {
    param($Value)
    return (($Value -is [int32] -or $Value -is [int64]) -and [int64]$Value -ge 0)
}

function Assert-SafeRelativeManifestPath {
    param([string]$RelativePath, [string]$Code)
    if ([string]::IsNullOrEmpty($RelativePath) -or $RelativePath.Length -gt 512 -or $RelativePath.Contains('\') -or [System.IO.Path]::IsPathRooted($RelativePath)) { throw $Code }
    $segments = @($RelativePath.Split('/'))
    if (@($segments | Where-Object { $_.Length -eq 0 -or $_ -eq '.' -or $_ -eq '..' }).Count -ne 0) { throw $Code }
    $resolved = [System.IO.Path]::GetFullPath((Join-Path $WorkspacePath $RelativePath.Replace('/', '\')))
    if (-not $resolved.StartsWith(($WorkspacePath.TrimEnd('\') + '\'), [System.StringComparison]::OrdinalIgnoreCase)) { throw $Code }
}

function Assert-ManifestBindingShape {
    param($Binding, [string]$Code)
    Assert-ExactProperties $Binding @('bytes', 'path', 'sha256') $Code
    if (-not (Test-ManifestInteger $Binding.bytes) -or [int64]$Binding.bytes -lt 1 -or [int64]$Binding.bytes -gt 2097152 -or [string]$Binding.sha256 -cnotmatch '^[0-9a-f]{64}$') { throw $Code }
    Assert-SafeRelativeManifestPath -RelativePath ([string]$Binding.path) -Code $Code
}

function Assert-NoForbiddenManifestContent {
    param($Value)
    if ($Value -is [string]) {
        if ($Value -match '(?:https?|wss?)://' -or $Value -match '^0x[0-9a-fA-F]{40}$' -or $Value -match '^0x[0-9a-fA-F]{8}$') { throw 'MANIFEST_FORBIDDEN' }
        return
    }
    if ($null -eq $Value -or $Value -isnot [System.Management.Automation.PSCustomObject] -and $Value -isnot [System.Array]) { return }
    if ($Value -is [System.Array]) { foreach ($entry in $Value) { Assert-NoForbiddenManifestContent $entry }; return }
    foreach ($property in $Value.PSObject.Properties) {
        if ([string]$property.Name -match '^(?:abi|abis|address|addresses|calldata|code|endpoint|endpoints|expression|expressions|family|families|method|methods|module|modules|rpc|selector|selectors|sourceUrl|sourceUrls|url|urls)$') { throw 'MANIFEST_FORBIDDEN' }
        Assert-NoForbiddenManifestContent $property.Value
    }
}

function Assert-CaptureShape {
    param($Capture, [string]$CycleMode)
    $keys = @('candidateCap', 'concurrencyCap', 'eventRangeBlockCap', 'eventsPerTargetCap', 'inventoryBytes', 'inventoryEntries', 'latestFallback', 'logRequestCap', 'observerCount', 'outputBytes', 'requestCap', 'requestTimeoutMs', 'responseBytes', 'retries', 'sourceRequests', 'targetCount', 'totalResponseBytes', 'totalTimeoutMs', 'traces')
    Assert-ExactProperties $Capture $keys 'MANIFEST_CAPTURE_INVALID'
    foreach ($key in @($keys | Where-Object { $_ -ne 'latestFallback' })) { if (-not (Test-ManifestInteger $Capture.$key)) { throw 'MANIFEST_CAPTURE_INVALID' } }
    if ($Capture.latestFallback -isnot [bool] -or $Capture.latestFallback -ne $false -or [int64]$Capture.candidateCap -lt 2 -or [int64]$Capture.candidateCap -gt 8 -or [int64]$Capture.concurrencyCap -lt 1 -or [int64]$Capture.concurrencyCap -gt 4 -or [int64]$Capture.observerCount -ne 2 -or [int64]$Capture.targetCount -ne 4 -or [int64]$Capture.inventoryBytes -gt 2097152 -or [int64]$Capture.inventoryEntries -gt 64 -or [int64]$Capture.requestTimeoutMs -lt 1 -or [int64]$Capture.requestTimeoutMs -gt 12000 -or [int64]$Capture.responseBytes -lt 1 -or [int64]$Capture.responseBytes -gt 2097152 -or [int64]$Capture.outputBytes -lt 1 -or [int64]$Capture.outputBytes -gt 196608 -or [int64]$Capture.retries -ne 0 -or [int64]$Capture.traces -ne 0 -or [int64]$Capture.sourceRequests -ne 0) { throw 'MANIFEST_CAPTURE_INVALID' }
    if ($CycleMode -ceq 'BASELINE') {
        if ([int64]$Capture.requestCap -lt 1 -or [int64]$Capture.requestCap -gt 96 -or [int64]$Capture.totalTimeoutMs -lt 1 -or [int64]$Capture.totalTimeoutMs -gt 360000 -or [int64]$Capture.totalResponseBytes -lt 1 -or [int64]$Capture.totalResponseBytes -gt 33554432 -or [int64]$Capture.logRequestCap -ne 0 -or [int64]$Capture.eventsPerTargetCap -ne 0 -or [int64]$Capture.eventRangeBlockCap -ne 0) { throw 'MANIFEST_CAPTURE_INVALID' }
    }
    elseif ([int64]$Capture.requestCap -lt 1 -or [int64]$Capture.requestCap -gt 128 -or [int64]$Capture.totalTimeoutMs -lt 1 -or [int64]$Capture.totalTimeoutMs -gt 480000 -or [int64]$Capture.totalResponseBytes -lt 1 -or [int64]$Capture.totalResponseBytes -gt 41943040 -or [int64]$Capture.logRequestCap -gt 16 -or [int64]$Capture.eventsPerTargetCap -gt 8 -or [int64]$Capture.eventRangeBlockCap -gt 2048) { throw 'MANIFEST_CAPTURE_INVALID' }
}

function Assert-EngineManifestShape {
    param($Manifest)
    Assert-ExactProperties $Manifest @('authority', 'capture', 'cycleId', 'immutable', 'mode', 'output', 'profile', 'reference', 'scheduler', 'schema', 'tools', 'window') 'MANIFEST_SCHEMA_INVALID'
    Assert-NoForbiddenManifestContent $Manifest
    $cycleId = [string]$Manifest.cycleId
    $cycleMode = [string]$Manifest.mode
    if ([string]$Manifest.schema -cne $ManifestSchema -or $Manifest.immutable -isnot [bool] -or $Manifest.immutable -ne $true -or $cycleId -cnotmatch '^[A-Z0-9][A-Z0-9_-]{7,95}$' -or [string]$Manifest.profile -cne $ManifestProfile -or $cycleMode -notin @('BASELINE', 'DELTA')) { throw 'MANIFEST_SCHEMA_INVALID' }
    Assert-ExactProperties $Manifest.output @('artifact') 'MANIFEST_OUTPUT_INVALID'
    $artifact = [string]$Manifest.output.artifact
    if ($artifact -cnotmatch $GenericOutputArtifactPattern) { throw 'MANIFEST_OUTPUT_INVALID' }

    Assert-ExactProperties $Manifest.tools @('files') 'MANIFEST_TOOLS_INVALID'
    $toolRows = @($Manifest.tools.files)
    if ($toolRows.Count -ne $ExpectedToolRelativePaths.Count) { throw 'MANIFEST_TOOLS_INVALID' }
    foreach ($row in $toolRows) { Assert-ManifestBindingShape $row 'MANIFEST_TOOLS_INVALID' }
    $actualToolPaths = @($toolRows | ForEach-Object { [string]$_.path } | Sort-Object -CaseSensitive)
    if (($actualToolPaths -join "`n") -cne ($ExpectedToolRelativePaths -join "`n")) { throw 'MANIFEST_TOOLS_INVALID' }

    Assert-ExactProperties $Manifest.authority @('commitment', 'files', 'targets') 'MANIFEST_AUTHORITY_INVALID'
    if ([string]$Manifest.authority.commitment -cnotmatch '^[0-9a-f]{64}$') { throw 'MANIFEST_AUTHORITY_INVALID' }
    $authorityFiles = @($Manifest.authority.files)
    if ($authorityFiles.Count -lt 1 -or @($authorityFiles | ForEach-Object { [string]$_.path } | Select-Object -Unique).Count -ne $authorityFiles.Count) { throw 'MANIFEST_AUTHORITY_INVALID' }
    foreach ($row in $authorityFiles) { Assert-ManifestBindingShape $row 'MANIFEST_AUTHORITY_INVALID' }
    $targetRows = @($Manifest.authority.targets)
    $categories = @('ADAPTER_MODULE_POINTER', 'FEED_HEALTH', 'FEED_POINTER', 'ORACLE_POINTER')
    if ($targetRows.Count -ne 4) { throw 'MANIFEST_AUTHORITY_INVALID' }
    foreach ($target in $targetRows) {
        Assert-ExactProperties $target @('authorityCommitment', 'category', 'runtimeIdentityCommitment', 'targetCommitment') 'MANIFEST_AUTHORITY_INVALID'
        if ([string]$target.category -notin $categories) { throw 'MANIFEST_AUTHORITY_INVALID' }
        foreach ($commitment in @($target.authorityCommitment, $target.runtimeIdentityCommitment, $target.targetCommitment)) { if ([string]$commitment -cnotmatch '^[0-9a-f]{64}$') { throw 'MANIFEST_AUTHORITY_INVALID' } }
    }
    $actualCategories = @($targetRows | ForEach-Object { [string]$_.category } | Sort-Object -CaseSensitive)
    if (($actualCategories -join "`n") -cne ($categories -join "`n")) { throw 'MANIFEST_AUTHORITY_INVALID' }

    Assert-ExactProperties $Manifest.reference @('artifact', 'authorityCommitment', 'blockNumber', 'classification', 'manifest', 'outputCommitment', 'projectionCommitment', 'state', 'tool') 'MANIFEST_REFERENCE_INVALID'
    foreach ($name in @('manifest', 'state', 'tool')) { Assert-ManifestBindingShape $Manifest.reference.$name 'MANIFEST_REFERENCE_INVALID' }
    $referenceArtifact = [string]$Manifest.reference.artifact
    if (($referenceArtifact -cnotmatch $GenericOutputArtifactPattern -and $referenceArtifact -cnotmatch $LegacyReferenceArtifactPattern) -or [string]$Manifest.reference.blockNumber -cnotmatch '^(?:0|[1-9][0-9]*)$') { throw 'MANIFEST_REFERENCE_INVALID' }
    foreach ($commitment in @($Manifest.reference.authorityCommitment, $Manifest.reference.outputCommitment, $Manifest.reference.projectionCommitment)) { if ([string]$commitment -cnotmatch '^[0-9a-f]{64}$') { throw 'MANIFEST_REFERENCE_INVALID' } }
    $referenceRoot = 'reports/raw/fast/{0}/' -f [string]$Manifest.reference.artifact
    if ($artifact -ceq [string]$Manifest.reference.artifact -or [string]$Manifest.reference.state.path -cne ($referenceRoot + 'state.json') -or [string]$Manifest.reference.manifest.path -cne ($referenceRoot + 'manifest.json') -or -not ([string]$Manifest.reference.tool.path).EndsWith('.js', [System.StringComparison]::Ordinal)) { throw 'MANIFEST_REFERENCE_INVALID' }
    if (($cycleMode -ceq 'BASELINE' -and [string]$Manifest.reference.classification -cne 'EXPECTED_ROUND_ADVANCEMENT') -or ($cycleMode -ceq 'DELTA' -and [string]$Manifest.reference.classification -cne 'LIDO_BASELINE_ESTABLISHED')) { throw 'MANIFEST_REFERENCE_INVALID' }

    $referenceBlock = [System.Numerics.BigInteger]::Parse([string]$Manifest.reference.blockNumber, [System.Globalization.CultureInfo]::InvariantCulture)
    if ($cycleMode -ceq 'BASELINE') {
        Assert-ExactProperties $Manifest.window @('minimumExclusive') 'MANIFEST_WINDOW_INVALID'
        if ([string]$Manifest.window.minimumExclusive -cnotmatch '^(?:0|[1-9][0-9]*)$' -or [System.Numerics.BigInteger]::Parse([string]$Manifest.window.minimumExclusive, [System.Globalization.CultureInfo]::InvariantCulture) -ne ($referenceBlock + 2048)) { throw 'MANIFEST_WINDOW_INVALID' }
    }
    else {
        Assert-ExactProperties $Manifest.window @('maximumInclusive', 'minimumInclusive') 'MANIFEST_WINDOW_INVALID'
        if ([string]$Manifest.window.minimumInclusive -cnotmatch '^(?:0|[1-9][0-9]*)$' -or [string]$Manifest.window.maximumInclusive -cnotmatch '^(?:0|[1-9][0-9]*)$' -or [System.Numerics.BigInteger]::Parse([string]$Manifest.window.minimumInclusive, [System.Globalization.CultureInfo]::InvariantCulture) -ne ($referenceBlock + 256) -or [System.Numerics.BigInteger]::Parse([string]$Manifest.window.maximumInclusive, [System.Globalization.CultureInfo]::InvariantCulture) -ne ($referenceBlock + 2048)) { throw 'MANIFEST_WINDOW_INVALID' }
    }
    Assert-CaptureShape $Manifest.capture $cycleMode
    Assert-ExactProperties $Manifest.scheduler @('automatic', 'retries', 'runOnce') 'MANIFEST_SCHEDULER_INVALID'
    if ($Manifest.scheduler.automatic -isnot [bool] -or $Manifest.scheduler.automatic -ne $false -or -not (Test-ManifestInteger $Manifest.scheduler.retries) -or [int64]$Manifest.scheduler.retries -ne 0 -or $Manifest.scheduler.runOnce -isnot [bool] -or $Manifest.scheduler.runOnce -ne $true) { throw 'MANIFEST_SCHEDULER_INVALID' }
}

function Assert-ManifestAndTools {
    if (-not [System.IO.Path]::IsPathRooted($ManifestPath)) { throw 'MANIFEST_PATH_INVALID' }
    $canonicalManifestPath = [System.IO.Path]::GetFullPath($ManifestPath)
    if ($canonicalManifestPath -cne $ManifestPath) { throw 'MANIFEST_PATH_INVALID' }
    if ($ManifestSha256 -cnotmatch '^[0-9a-f]{64}$') { throw 'MANIFEST_DIGEST_INVALID' }
    if (-not [System.IO.Directory]::Exists($WorkspacePath) -or -not [System.IO.Directory]::Exists($ManifestRootPath)) { throw 'WORKSPACE_INVALID' }
    Assert-DirectoryChainNoReparse -Root $WorkspacePath -TargetDirectory $ManifestRootPath -Code 'MANIFEST_PATH_INVALID'
    if (-not [System.StringComparer]::OrdinalIgnoreCase.Equals([System.IO.Path]::GetDirectoryName($canonicalManifestPath), $ManifestRootPath) -or [System.IO.Path]::GetExtension($canonicalManifestPath) -cne '.json') { throw 'MANIFEST_PATH_INVALID' }
    $manifestBytes = Read-StableRegularFile -Path $canonicalManifestPath -MaximumBytes 196608 -Code 'MANIFEST_FILE_INVALID'
    if ((Get-Sha256Hex $manifestBytes) -cne $ManifestSha256) { throw 'MANIFEST_DIGEST_MISMATCH' }
    $utf8 = [System.Text.UTF8Encoding]::new($false, $true)
    try { $manifestText = $utf8.GetString($manifestBytes) } catch { throw 'MANIFEST_ENCODING_INVALID' }
    try { $manifest = $manifestText | ConvertFrom-Json -ErrorAction Stop } catch { throw 'MANIFEST_JSON_INVALID' }
    $canonicalBytes = $utf8.GetBytes((ConvertTo-CanonicalJson $manifest) + "`n")
    if ($canonicalBytes.LongLength -ne $manifestBytes.LongLength -or (Get-Sha256Hex $canonicalBytes) -cne $ManifestSha256) { throw 'MANIFEST_CANONICAL_BYTES_INVALID' }

    Assert-EngineManifestShape $manifest
    $expectedManagerPath = [System.IO.Path]::GetFullPath((Join-Path $WorkspacePath 'tools\manage-lido-oracle-cycle-task-v1.ps1'))
    if ($ManagerPath -cne $expectedManagerPath) { throw 'MANAGER_PATH_INVALID' }
    Assert-DirectoryChainNoReparse -Root $WorkspacePath -TargetDirectory ([System.IO.Path]::GetDirectoryName($ManagerPath)) -Code 'MANAGER_PATH_INVALID'
    $managerBytes = Read-StableRegularFile -Path $ManagerPath -MaximumBytes 1048576 -Code 'MANAGER_PATH_INVALID'
    $managerHash = Get-Sha256Hex $managerBytes
    $toolRows = @($manifest.tools.files)
    foreach ($row in $toolRows) {
        [void](Resolve-BoundWorkspaceFile -RelativePath ([string]$row.path) -RequiredPrefix $AllowedEngineRootRelativePath -ExpectedBytes ([int64]$row.bytes) -ExpectedSha256 ([string]$row.sha256) -Code 'MANIFEST_TOOL_TAMPER')
    }
    $engineRows = @($toolRows | Where-Object { [string]$_.path -ceq $ExpectedEngineRelativePath })
    if ($engineRows.Count -ne 1) { throw 'MANIFEST_ENGINE_TOOL_INVALID' }
    $enginePath = [System.IO.Path]::GetFullPath((Join-Path $WorkspacePath $ExpectedEngineRelativePath.Replace('/', '\')))
    $cycleToken = ([string]$manifest.cycleId).Substring(0, [System.Math]::Min(24, ([string]$manifest.cycleId).Length))
    $taskName = 'EVM-Audit-Lido-Cycle-{0}-{1}' -f $cycleToken, $ManifestSha256.Substring(0, 12)
    $mutexName = 'Local\' + $taskName
    if ($taskName.Length -gt 58 -or $taskName -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$' -or $mutexName.Length -gt 64) { throw 'MANIFEST_TASK_NAME_INVALID' }
    $bundlePath = [System.IO.Path]::GetFullPath((Join-Path $WorkspacePath ('reports\raw\fast\' + [string]$manifest.output.artifact)))

    $script:VerifiedPowerShellPath = Get-VerifiedPowerShellPath
    $script:VerifiedNodePath = Get-VerifiedNodePath
    $script:ExpectedArguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -Mode RunScheduled -ManifestPath "{1}" -ManifestSha256 {2}' -f $ManagerPath, $canonicalManifestPath, $ManifestSha256
    $script:Configuration = [pscustomobject]@{
        TaskName = $taskName; MutexName = $mutexName; CadenceMinutes = 5; DurationHours = 8; ExecutionLimitMinutes = 10
        EnginePath = $enginePath; BundlePath = $bundlePath; CycleId = [string]$manifest.cycleId; CycleMode = [string]$manifest.mode
        ManagerSha256 = $managerHash; OutputBytes = [int64]$manifest.capture.outputBytes
    }
}

function Invoke-Preflight {
    Assert-ManifestAndTools
    Write-SanitizedJson @{ ok = $true; mode = 'Preflight'; managerVersion = $ManagerVersion; taskName = $script:Configuration.TaskName; manifestVerified = $true; managerVerified = $true; engineVerified = $true; nodeVerified = $true; powershellVerified = $true; taskQueried = $false; taskChanged = $false; childExecuted = $false; inventoryRead = $false; networkRead = $false; outputAccess = $false }
}

function Get-FixedTask {
    $tasks = @(Get-ScheduledTask -TaskName $script:Configuration.TaskName -ErrorAction SilentlyContinue)
    if ($tasks.Count -gt 1) { throw 'TASK_IDENTITY_MISMATCH' }
    if ($tasks.Count -eq 0) { return $null }
    return $tasks[0]
}

function Get-CurrentUserId { return [System.Security.Principal.WindowsIdentity]::GetCurrent().Name }
function Get-CurrentUserSid { return [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value }

function Resolve-PrincipalSid {
    param([Parameter(Mandatory = $true)][string]$UserId)
    try {
        if ($UserId -match '^S-[0-9]+(?:-[0-9]+)+$') { return ([System.Security.Principal.SecurityIdentifier]::new($UserId)).Value }
        return ([System.Security.Principal.NTAccount]::new($UserId).Translate([System.Security.Principal.SecurityIdentifier])).Value
    }
    catch { throw 'TASK_PRINCIPAL_USER_MISMATCH' }
}

function Assert-TaskIdentity {
    param([Parameter(Mandatory = $true)]$Task)
    if ([string]$Task.TaskName -cne $script:Configuration.TaskName -or [string]$Task.TaskPath -cne '\') { throw 'TASK_IDENTITY_MISMATCH' }
    if (@($Task.Actions).Count -ne 1) { throw 'TASK_ACTION_MISMATCH' }
    $action = @($Task.Actions)[0]
    if ($null -eq $script:VerifiedPowerShellPath -or -not [System.IO.Path]::IsPathRooted([string]$action.Execute) -or -not [System.StringComparer]::OrdinalIgnoreCase.Equals([string]$action.Execute, $script:VerifiedPowerShellPath) -or [string]$action.Arguments -cne $script:ExpectedArguments -or -not [System.StringComparer]::OrdinalIgnoreCase.Equals([System.IO.Path]::GetFullPath([string]$action.WorkingDirectory), $WorkspacePath)) { throw 'TASK_ACTION_MISMATCH' }
    if ((Resolve-PrincipalSid -UserId ([string]$Task.Principal.UserId)) -ne (Get-CurrentUserSid)) { throw 'TASK_PRINCIPAL_USER_MISMATCH' }
    if ([string]$Task.Principal.LogonType -ne 'Interactive') { throw 'TASK_PRINCIPAL_LOGON_MISMATCH' }
    if ([string]$Task.Principal.RunLevel -ne 'Limited') { throw 'TASK_PRINCIPAL_RUNLEVEL_MISMATCH' }
    $triggers = @($Task.Triggers)
    $expectedDuration = 'PT{0}H' -f $script:Configuration.DurationHours
    if ($triggers.Count -ne 1 -or [string]$triggers[0].Repetition.Interval -cne 'PT5M' -or [string]$triggers[0].Repetition.Duration -cne $expectedDuration) { throw 'TASK_TRIGGER_MISMATCH' }
    $expectedLimit = 'PT{0}M' -f $script:Configuration.ExecutionLimitMinutes
    if ([string]$Task.Settings.ExecutionTimeLimit -cne $expectedLimit -or [string]$Task.Settings.MultipleInstances -cne 'IgnoreNew') { throw 'TASK_SETTINGS_MISMATCH' }
    return $true
}

function Remove-JustCreatedFixedTask {
    $createdTask = Get-FixedTask
    if ($null -eq $createdTask -or [string]$createdTask.TaskName -cne $script:Configuration.TaskName -or [string]$createdTask.TaskPath -cne '\') { throw 'INSTALL_ROLLBACK_IDENTITY_MISMATCH' }
    Unregister-ScheduledTask -TaskName $script:Configuration.TaskName -Confirm:$false
}

function Invoke-Install {
    Assert-ManifestAndTools
    if ($null -ne (Get-FixedTask)) { throw 'TASK_ALREADY_EXISTS' }
    $cadence = New-TimeSpan -Minutes 5
    $duration = New-TimeSpan -Hours $script:Configuration.DurationHours
    $executionLimit = New-TimeSpan -Minutes $script:Configuration.ExecutionLimitMinutes
    $action = New-ScheduledTaskAction -Execute $script:VerifiedPowerShellPath -Argument $script:ExpectedArguments -WorkingDirectory $WorkspacePath
    $trigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1)) -RepetitionInterval $cadence -RepetitionDuration $duration
    $principal = New-ScheduledTaskPrincipal -UserId (Get-CurrentUserId) -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit $executionLimit -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    $created = $false
    try {
        try { $registered = Register-ScheduledTask -TaskName $script:Configuration.TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings }
        catch { throw 'TASK_REGISTER_FAILED' }
        $created = $true
        try { [void](Assert-TaskIdentity -Task $registered) }
        catch {
            $identityCode = [string]$_.Exception.Message
            if ($identityCode -notmatch '^TASK_(?:IDENTITY|ACTION|TRIGGER|SETTINGS|PRINCIPAL_(?:USER|LOGON|RUNLEVEL))_MISMATCH$') { $identityCode = 'TASK_IDENTITY_MISMATCH' }
            throw ('TASK_POSTVALIDATION_' + $identityCode)
        }
    }
    catch {
        $installFailure = $_
        if ($created) {
            try { Remove-JustCreatedFixedTask }
            catch { throw 'TASK_ROLLBACK_FAILED' }
        }
        throw $installFailure
    }
    Write-SanitizedJson @{ ok = $true; mode = 'Install'; managerVersion = $ManagerVersion; taskName = $script:Configuration.TaskName; enabled = $true; cadenceMinutes = 5; durationHours = $script:Configuration.DurationHours; executionLimitMinutes = $script:Configuration.ExecutionLimitMinutes }
}

function Disable-TerminalTask {
    $task = Get-FixedTask
    if ($null -eq $task) { throw 'TASK_NOT_FOUND' }
    [void](Assert-TaskIdentity -Task $task)
    Disable-ScheduledTask -TaskName $script:Configuration.TaskName | Out-Null
}

function Complete-ScheduledRun {
    param([int]$ChildExit)
    if ($ChildExit -eq 3) { return 3 }
    Disable-TerminalTask
    if ($ChildExit -in @(0, 1, 4)) { return $ChildExit }
    return 1
}

function Invoke-RunScheduled {
    Assert-ManifestAndTools
    $mutex = [System.Threading.Mutex]::new($false, $script:Configuration.MutexName)
    $acquired = $false
    try {
        $acquired = $mutex.WaitOne(0)
        if (-not $acquired) { exit 3 }
        $hadNodeOptions = Test-Path Env:NODE_OPTIONS
        $hadNodePath = Test-Path Env:NODE_PATH
        $oldNodeOptions = if ($hadNodeOptions) { $env:NODE_OPTIONS } else { $null }
        $oldNodePath = if ($hadNodePath) { $env:NODE_PATH } else { $null }
        try {
            Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
            Remove-Item Env:NODE_PATH -ErrorAction SilentlyContinue
            Push-Location -LiteralPath $WorkspacePath
            try { & $script:VerifiedNodePath $script:Configuration.EnginePath '--run-if-ready' '--manifest-path' $ManifestPath '--manifest-sha256' $ManifestSha256; $childExit = $LASTEXITCODE }
            catch { $childExit = 1 }
            finally { Pop-Location }
        }
        finally {
            if ($hadNodeOptions) { $env:NODE_OPTIONS = $oldNodeOptions } else { Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue }
            if ($hadNodePath) { $env:NODE_PATH = $oldNodePath } else { Remove-Item Env:NODE_PATH -ErrorAction SilentlyContinue }
        }
        exit (Complete-ScheduledRun -ChildExit $childExit)
    }
    finally {
        if ($acquired) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}

function Read-TerminalArtifact {
    $terminalPath = [System.IO.Path]::GetFullPath((Join-Path $script:Configuration.BundlePath 'terminal.json'))
    if (-not [System.IO.File]::Exists($terminalPath)) { return $null }
    Assert-DirectoryChainNoReparse -Root $WorkspacePath -TargetDirectory ([System.IO.Path]::GetDirectoryName($terminalPath)) -Code 'ENGINE_TERMINAL_ARTIFACT_INVALID'
    $bytes = Read-StableRegularFile -Path $terminalPath -MaximumBytes $script:Configuration.OutputBytes -Code 'ENGINE_TERMINAL_ARTIFACT_INVALID'
    $utf8 = [System.Text.UTF8Encoding]::new($false, $true)
    try { $text = $utf8.GetString($bytes); $terminal = $text | ConvertFrom-Json -ErrorAction Stop } catch { throw 'ENGINE_TERMINAL_ARTIFACT_INVALID' }
    if ((Get-Sha256Hex ($utf8.GetBytes((ConvertTo-CanonicalJson $terminal) + "`n"))) -cne (Get-Sha256Hex $bytes)) { throw 'ENGINE_TERMINAL_ARTIFACT_INVALID' }
    Assert-ExactProperties $terminal @('classification', 'counts', 'currentBlock', 'cycleId', 'manifestSha256', 'mode', 'reasonCode', 'status') 'ENGINE_TERMINAL_ARTIFACT_INVALID'
    if ([string]$terminal.cycleId -cne $script:Configuration.CycleId -or [string]$terminal.mode -cne $script:Configuration.CycleMode -or [string]$terminal.manifestSha256 -cne $ManifestSha256) { throw 'ENGINE_TERMINAL_ARTIFACT_INVALID' }
    $reasonMap = @{ PREFLIGHT_OK = 'MANIFEST_AND_LOCAL_BINDINGS_VALID'; UNPUBLISHED = 'OUTPUT_ABSENT'; NOT_READY = 'MINIMUM_NOT_REACHED'; WINDOW_EXPIRED = 'MAXIMUM_EXCEEDED'; PUBLISHED = 'CAPTURE_COMPLETE'; ALREADY_PUBLISHED = 'EXISTING_VALID_BUNDLE' }
    $status = [string]$terminal.status
    if (-not $reasonMap.ContainsKey($status) -or [string]$terminal.reasonCode -cne [string]$reasonMap[$status]) { throw 'ENGINE_TERMINAL_ARTIFACT_INVALID' }
    Assert-ExactProperties $terminal.counts @('candidates', 'events', 'logReads', 'qualified', 'reads', 'selected', 'targets', 'validPairs') 'ENGINE_TERMINAL_ARTIFACT_INVALID'
    foreach ($property in $terminal.counts.PSObject.Properties) { if (-not (Test-ManifestInteger $property.Value)) { throw 'ENGINE_TERMINAL_ARTIFACT_INVALID' } }
    $currentBlock = $terminal.currentBlock
    $classification = $terminal.classification
    if ($status -in @('PREFLIGHT_OK', 'UNPUBLISHED')) {
        if ($null -ne $currentBlock -or $null -ne $classification) { throw 'ENGINE_TERMINAL_ARTIFACT_INVALID' }
    }
    elseif ([string]$currentBlock -cnotmatch '^(?:0|[1-9][0-9]*)$') { throw 'ENGINE_TERMINAL_ARTIFACT_INVALID' }
    if ($status -in @('NOT_READY', 'WINDOW_EXPIRED') -and $null -ne $classification) { throw 'ENGINE_TERMINAL_ARTIFACT_INVALID' }
    if ($status -in @('PUBLISHED', 'ALREADY_PUBLISHED')) {
        $allowedClassifications = if ($script:Configuration.CycleMode -ceq 'BASELINE') { @('LIDO_BASELINE_ESTABLISHED', 'UNKNOWN') } else { @('UNCHANGED', 'EXPECTED_ROUND_ADVANCEMENT', 'REVIEW_REQUIRED', 'UNKNOWN') }
        if ([string]$classification -notin $allowedClassifications) { throw 'ENGINE_TERMINAL_ARTIFACT_INVALID' }
    }
    return [pscustomobject]@{ Terminal = $true; Reason = [string]$terminal.reasonCode }
}

function Invoke-Status {
    Assert-ManifestAndTools
    $task = Get-FixedTask
    $terminal = Read-TerminalArtifact
    if ($null -eq $task) {
        Write-SanitizedJson @{ ok = $true; mode = 'Status'; managerVersion = $ManagerVersion; taskName = $script:Configuration.TaskName; installed = $false; enabled = $false; state = 'Absent'; lastResult = $null; terminal = [bool]($null -ne $terminal); reason = if ($null -ne $terminal) { $terminal.Reason } else { $null } }
        return
    }
    [void](Assert-TaskIdentity -Task $task)
    $info = Get-ScheduledTaskInfo -TaskName $script:Configuration.TaskName
    if ($task.Settings.Enabled -isnot [bool]) { throw 'TASK_SETTINGS_MISMATCH' }
    $enabled = [bool]$task.Settings.Enabled
    $state = [string]$task.State
    if ($state -notin @('Unknown', 'Disabled', 'Queued', 'Ready', 'Running')) { throw 'TASK_STATE_INVALID' }
    $isTerminal = $null -ne $terminal
    $reason = if ($isTerminal) { $terminal.Reason } elseif (-not $enabled) { 'ENGINE_TERMINAL_ARTIFACT_MISSING' } else { $null }
    if (-not $enabled -and $null -eq $terminal) { $isTerminal = $true }
    Write-SanitizedJson @{ ok = $true; mode = 'Status'; managerVersion = $ManagerVersion; taskName = $script:Configuration.TaskName; installed = $true; enabled = $enabled; state = $state; lastResult = [int64]$info.LastTaskResult; terminal = $isTerminal; reason = $reason }
}

function Invoke-Uninstall {
    Assert-ManifestAndTools
    $task = Get-FixedTask
    if ($null -eq $task) { throw 'TASK_NOT_FOUND' }
    [void](Assert-TaskIdentity -Task $task)
    Unregister-ScheduledTask -TaskName $script:Configuration.TaskName -Confirm:$false
    Write-SanitizedJson @{ ok = $true; mode = 'Uninstall'; managerVersion = $ManagerVersion; taskName = $script:Configuration.TaskName; deleted = $true }
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        switch ($Mode) {
            'Preflight' { Invoke-Preflight }
            'Install' { Invoke-Install }
            'RunScheduled' { Invoke-RunScheduled }
            'Status' { Invoke-Status }
            'Uninstall' { Invoke-Uninstall }
        }
    }
    catch {
        $failureCode = [string]$_.Exception.Message
        if ($failureCode -notmatch '^(?:TASK|INSTALL|MANAGER|MANIFEST|ENGINE|WORKSPACE|NODE|POWERSHELL)_[A-Z0-9_]+$') { $failureCode = 'MANAGER_FAILED_CLOSED' }
        Write-SanitizedJson @{ ok = $false; mode = $Mode; managerVersion = $ManagerVersion; code = $failureCode }
        exit 1
    }
}
