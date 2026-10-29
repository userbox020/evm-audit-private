[CmdletBinding()]
param(
    [switch]$UseAuthorizedInventory,
    [switch]$AllowPublicEthereumFallback,
    [ValidateRange(300, 86400)]
    [int]$IntervalSeconds = 3600
)

$ErrorActionPreference = "Stop"
$workspace = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$monitorScript = Join-Path $workspace "tools\monitor-venus-psr-multichain.js"
$monitorDirectory = Join-Path $workspace "reports\monitor"
$lockDirectory = Join-Path $monitorDirectory ".venus-psr-monitor.lock"
$lockOwnerPath = Join-Path $lockDirectory "owner.json"
$lockNonce = [Guid]::NewGuid().ToString("D").ToLowerInvariant()

if (-not (Test-Path -LiteralPath $workspace -PathType Container)) {
    throw "Workspace directory is unavailable."
}
if (-not (Test-Path -LiteralPath $monitorScript -PathType Leaf)) {
    throw "Venus monitor script is unavailable."
}
if (-not (Test-Path -LiteralPath $monitorDirectory -PathType Container)) {
    throw "Monitor output directory is unavailable."
}
if (-not $UseAuthorizedInventory) {
    throw "Live monitoring requires explicit -UseAuthorizedInventory authorization. The dashboard alone remains viewer-only."
}
if (Test-Path -LiteralPath $lockDirectory) {
    throw "A Venus PSR monitor loop is already running or requires lock cleanup."
}

$node = Get-Command node -ErrorAction Stop
$python = Get-Command py -ErrorAction Stop
$monitorArguments = @(
    "`"$monitorScript`"",
    "--loop",
    "--interval-seconds",
    [string]$IntervalSeconds,
    "--use-authorized-inventory",
    "--lock-nonce",
    $lockNonce
)
if ($AllowPublicEthereumFallback) {
    $monitorArguments += "--allow-public-ethereum-fallback"
}

$monitor = $null
try {
    $monitor = Start-Process -FilePath $node.Source -ArgumentList $monitorArguments -WorkingDirectory $workspace -NoNewWindow -PassThru
    Start-Sleep -Seconds 1
    if ($monitor.HasExited) {
        throw "Venus PSR monitor failed to start."
    }
    & $python.Source -m dashboard
}
finally {
    if ($null -ne $monitor -and -not $monitor.HasExited) {
        Stop-Process -Id $monitor.Id -ErrorAction SilentlyContinue
        $monitor.WaitForExit(5000) | Out-Null
        if (-not $monitor.HasExited) {
            Stop-Process -Id $monitor.Id -Force -ErrorAction SilentlyContinue
        }
    }
    if ($null -ne $monitor -and $monitor.HasExited -and (Test-Path -LiteralPath $lockOwnerPath -PathType Leaf)) {
        $owned = $false
        try {
            $ownerInfo = Get-Item -LiteralPath $lockOwnerPath -Force
            if (($ownerInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0 -and $ownerInfo.Length -le 1024) {
                $owner = Get-Content -LiteralPath $lockOwnerPath -Raw -Encoding UTF8 | ConvertFrom-Json
                $owned = ([int64]$owner.pid -eq [int64]$monitor.Id) -and ([string]$owner.nonce -ceq $lockNonce)
            }
        }
        catch {
            $owned = $false
        }
        if ($owned) {
            Remove-Item -LiteralPath $lockOwnerPath -Force -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath $lockDirectory -Force -ErrorAction SilentlyContinue
        }
    }
}
