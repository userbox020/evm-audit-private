[CmdletBinding()]
param(
    [switch]$Once,
    [switch]$CheckOnly,
    [object]$IntervalSeconds = "300",
    [string]$RenzoLineageManifest,
    [string]$RenzoQualificationEvidence,
    [string]$FraxlendManifest,
    [string]$UniswapXLineageManifest,
    [string]$UniswapXDurabilityEvidence,
    [string]$LocalStorageAttestation,
    [string]$ValantisSuccessorLineage,
    [string]$ValantisFinalityCapability
)

# Node launch is this wrapper's sole process boundary. The monitor itself never
# starts a process. NODE_OPTIONS and NODE_PATH are removed from that child only.
# Unknown named parameters are rejected by PowerShell before script execution;
# that host-level parameter-binding boundary cannot be converted to monitor JSON.
$ErrorActionPreference = "Stop"
$schema = "blocked-branch-reopen-state/v1"
$savedNodeOptions = [Environment]::GetEnvironmentVariable("NODE_OPTIONS", "Process")
$savedNodePath = [Environment]::GetEnvironmentVariable("NODE_PATH", "Process")

try {
    $workspace = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
    $monitorScript = Join-Path $PSScriptRoot "monitor-blocked-branch-reopen.js"
    if (-not (Test-Path -LiteralPath $workspace -PathType Container)) { throw "Workspace unavailable" }
    if (-not (Test-Path -LiteralPath $monitorScript -PathType Leaf)) { throw "Monitor unavailable" }
    $intervalText = [string]$IntervalSeconds
    $parsedInterval = [long]0
    if ($intervalText -notmatch '^[0-9]+$' -or -not [long]::TryParse($intervalText, [ref]$parsedInterval) -or $parsedInterval -lt 30 -or $parsedInterval -gt 86400) {
        throw "Invalid interval"
    }

    $nodeCommands = @(Get-Command node.exe -CommandType Application -ErrorAction Stop)
    if ($nodeCommands.Count -ne 1) { throw "Ambiguous Node command" }
    $nodePath = [System.IO.Path]::GetFullPath($nodeCommands[0].Source)
    if ([System.IO.Path]::GetFileName($nodePath) -ine "node.exe") { throw "Unsafe Node command" }
    $nodeItem = Get-Item -LiteralPath $nodePath -Force -ErrorAction Stop
    if (($nodeItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Reparse Node command rejected" }
    $nodeParent = $nodeItem.Directory
    while ($null -ne $nodeParent) {
        if (($nodeParent.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Reparse Node path rejected" }
        $nodeParent = $nodeParent.Parent
    }

    $arguments = @($monitorScript, $(if ($Once) { "--once" } else { "--watch" }), "--interval-seconds", [string]$parsedInterval)
    if ($CheckOnly) { $arguments += "--check-only" }
    $optionalPaths = @(
        @("--renzo-lineage-manifest", $RenzoLineageManifest),
        @("--renzo-qualification-evidence", $RenzoQualificationEvidence),
        @("--fraxlend-manifest", $FraxlendManifest),
        @("--uniswapx-lineage-manifest", $UniswapXLineageManifest),
        @("--uniswapx-durability-evidence", $UniswapXDurabilityEvidence),
        @("--local-storage-attestation", $LocalStorageAttestation),
        @("--valantis-successor-lineage", $ValantisSuccessorLineage),
        @("--valantis-finality-capability", $ValantisFinalityCapability)
    )
    foreach ($entry in $optionalPaths) {
        if (-not [string]::IsNullOrWhiteSpace($entry[1])) { $arguments += $entry[0]; $arguments += $entry[1] }
    }

    [Environment]::SetEnvironmentVariable("NODE_OPTIONS", $null, "Process")
    [Environment]::SetEnvironmentVariable("NODE_PATH", $null, "Process")
    & $nodePath @arguments
    $code = $LASTEXITCODE
    if ($null -eq $code) { $code = 1 }
    exit $code
}
catch {
    [Console]::Out.WriteLine('{"errorClass":"LAUNCH_FAILED","schema":"' + $schema + '","status":"HOLD"}')
    exit 1
}
finally {
    [Environment]::SetEnvironmentVariable("NODE_OPTIONS", $savedNodeOptions, "Process")
    [Environment]::SetEnvironmentVariable("NODE_PATH", $savedNodePath, "Process")
}
