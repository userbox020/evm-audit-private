# install-scheduled-task.ps1 — Runs monitor every 5 minutes via Windows Task Scheduler
# Run once as Administrator. Survives terminal close and reboot.
param([int]$IntervalMinutes = 5)

$taskName = "EVM-Audit-Novelty-Monitor"
$scriptPath = Join-Path $PSScriptRoot "monitor-novelty-conditions.js"
$nodeExe = (Get-Command node).Source
$logDir = Join-Path $PSScriptRoot "..\reports\monitor"
$logFile = Join-Path $logDir "task-scheduler.log"

# Remove existing task if present
schtasks /DELETE /TN $taskName /F 2>$null

# Create new task: runs every N minutes, highest available privileges not needed
schtasks /CREATE `
    /TN $taskName `
    /TR "cmd /c `"$nodeExe`" `"$scriptPath`" --once >> `"$logFile`" 2>&1" `
    /SC MINUTE `
    /MO $IntervalMinutes `
    /F `
    /RL LIMITED

Write-Host "Task '$taskName' installed — runs every $IntervalMinutes min."
Write-Host "Logs: $logFile"
Write-Host ""
Write-Host "Manage:"
Write-Host "  schtasks /QUERY /TN $taskName          — check status"
Write-Host "  schtasks /DELETE /TN $taskName /F       — stop and remove"
Write-Host "  Get-Content `"$logFile`" -Tail 20        — see recent output"
