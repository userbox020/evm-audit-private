# run-all-scanners.ps1 — Bootstrap all inventories, then start continuous monitoring
param([switch]$Quick, [switch]$NoWatch, [int]$Interval = 300)

$ErrorActionPreference = "Continue"
Push-Location $PSScriptRoot\..

Write-Host "=== STEP 1/3: Oracle staleness inventory ==="
node tools/scan-staleness-gaps.js
if ($LASTEXITCODE -ne 0) { Write-Host "  Warning: staleness scanner failed, using cached data" }

Write-Host "=== STEP 2/3: Vault donation inventory ==="
if ($Quick) {
    node tools/scan-vault-donation.js --quick
} else {
    node tools/scan-vault-donation.js
}
if ($LASTEXITCODE -ne 0) { Write-Host "  Warning: vault scanner failed, using cached data" }

Write-Host "=== STEP 3/3: Continuous monitor ==="
if (-not $NoWatch) {
    Write-Host "Starting watch mode (Ctrl+C to stop)..."
    node tools/monitor-novelty-conditions.js --watch --interval=$Interval
} else {
    node tools/monitor-novelty-conditions.js --once
}

Pop-Location
