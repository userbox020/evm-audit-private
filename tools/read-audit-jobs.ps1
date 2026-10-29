# Fixed read-only collector. No parameters, task actions, command lines or errors leave this process.
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$Workspace = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$Catalog = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'audit-job-catalog.json') -Raw | ConvertFrom-Json

# Windows argument parsing must honor adjacent quotes/backslashes, not treat a
# script-looking substring inside a larger argument as the script token.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace AuditJobs {
    public static class Arguments {
        [DllImport("shell32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern IntPtr CommandLineToArgvW(string commandLine, out int count);
        [DllImport("kernel32.dll")]
        public static extern IntPtr LocalFree(IntPtr memory);
    }
}
'@

function Get-Field($Object, [string]$Name) {
    if ($null -ne $Object -and $null -ne $Object.PSObject.Properties[$Name]) { return $Object.$Name }
    return $null
}

function Convert-SafeDate($Value) {
    if ($null -eq $Value) { return $null }
    try {
        $date = [datetime]$Value
        if ($date.Year -ge 2000) { return $date.ToUniversalTime().ToString('o') }
    } catch { }
    return $null
}

# Reviewed manager entry modes differ. Never count administrative invocations
# (Install/Status/Preflight) or extend one manager's run mode to another alias.
$ManagerRunModes = @{
    'tools/manage-profit-trigger-watch-task.ps1' = 'RunScheduled'
    'tools/manage-r17-task.ps1' = 'RunNow'
    'tools/manage-protocol-trigger-scout-v3-task.ps1' = 'RunScheduled'
    'tools/manage-lido-delta-v5-task.ps1' = 'RunScheduled'
    'tools/manage-lido-delta-v6-task.ps1' = 'RunScheduled'
}

# Match only the script argument of a reviewed interpreter, never arbitrary substrings
# or arguments containing script-looking text. cmd wrappers are deliberately excluded.
function Get-ScriptToken($Process) {
    $name = [string]$Process.Name
    $count = 0
    $memory = [AuditJobs.Arguments]::CommandLineToArgvW([string]$Process.CommandLine, [ref]$count)
    if ($memory -eq [IntPtr]::Zero) { throw 'ARGUMENT_INSPECTION_UNAVAILABLE' }
    $parts = @()
    try {
        for ($index = 0; $index -lt $count; $index++) {
            $pointer = [Runtime.InteropServices.Marshal]::ReadIntPtr($memory, ($index * [IntPtr]::Size))
            $parts += [Runtime.InteropServices.Marshal]::PtrToStringUni($pointer)
        }
    } finally { [void][AuditJobs.Arguments]::LocalFree($memory) }
    if ($parts.Count -lt 2) { return $null }
    if ($name -ieq 'node.exe') {
        # The reviewed launchers invoke node with the script as its first argument.
        if (-not [regex]::IsMatch($parts[1], '^[-/]')) { return [string]$parts[1] }
    } elseif ($name -ieq 'powershell.exe' -or $name -ieq 'pwsh.exe') {
        $fileIndex = -1
        for ($i = 1; $i -lt $parts.Count - 1; $i++) {
            if ($parts[$i] -ieq '-File') { $fileIndex = $i; break }
            # Do not interpret text inside -Command / -EncodedCommand as a script invocation.
            if ([regex]::IsMatch($parts[$i], '^-(Command|EncodedCommand|c|ec)$', [Text.RegularExpressions.RegexOptions]::IgnoreCase)) { return $null }
        }
        if ($fileIndex -lt 0) { return $null }
        $scriptToken = [string]$parts[$fileIndex + 1]
        $modes = @()
        for ($i = $fileIndex + 2; $i -lt $parts.Count - 1; $i++) {
            if ($parts[$i] -ieq '-Mode') { $modes += $parts[$i + 1] }
        }
        if ($modes.Count -ne 1) { return $null }
        foreach ($alias in $ManagerRunModes.Keys) {
            if ((Get-MatchKind $scriptToken $alias) -and $modes[0] -ieq $ManagerRunModes[$alias]) {
                return $scriptToken
            }
        }
    }
    return $null
}

function Get-MatchKind([string]$Token, [string]$Script) {
    if (-not $Token -or -not $Script) { return $null }
    $relative = $Script.Replace('/', '\')
    $candidate = $Token.Replace('/', '\')
    $absolute = [IO.Path]::GetFullPath((Join-Path $Workspace $relative))
    if ([StringComparer]::OrdinalIgnoreCase.Equals($candidate, $absolute)) { return 'WORKSPACE_PATH' }
    if ([StringComparer]::OrdinalIgnoreCase.Equals($candidate, $relative) -or
        [StringComparer]::OrdinalIgnoreCase.Equals($candidate, ('.\' + $relative))) { return 'SCRIPT_MATCH' }
    return $null
}

function Test-CanonicalHiddenAction($Action) {
    # Recognize the reviewed synchronous scheduler transport, not arbitrary VBS
    # names or Settings.Hidden. Decode only in memory to verify the wire mode;
    # none of the opaque payload/target arguments are included in the result.
    $expectedHost = Join-Path ([Environment]::SystemDirectory) 'wscript.exe'
    if (-not [StringComparer]::OrdinalIgnoreCase.Equals([string](Get-Field $Action 'Execute'), $expectedHost)) { return $false }
    $wrapper = [IO.Path]::GetFullPath((Join-Path $Workspace 'tools\launch-hidden.vbs'))
    $prefix = '//B //Nologo "{0}" ' -f $wrapper
    $arguments = [string](Get-Field $Action 'Arguments')
    if (-not $arguments.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { return $false }
    $encoded = $arguments.Substring($prefix.Length)
    if ($encoded.Length -gt 28000 -or -not [regex]::IsMatch($encoded, '^[A-Za-z0-9+/]+={0,2}$')) { return $false }
    try {
        $wire = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded)) | ConvertFrom-Json
        return ((Get-Field $wire 'version') -ceq 1 -and (Get-Field $wire 'wait') -is [bool] -and
            (Get-Field $wire 'wait') -eq $true -and (Get-Field $wire 'executable') -is [string] -and
            (Get-Field $wire 'arguments') -is [string] -and (Get-Field $wire 'workingDirectory') -is [string])
    } catch { return $false }
}

$processStatus = 'OK'
$schedulerStatus = 'OK'
$processes = @()
$tasks = @()
try {
    $processes = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'node.exe' OR Name = 'powershell.exe' OR Name = 'pwsh.exe'" -ErrorAction Stop)
    if (@($processes | Where-Object { [string]::IsNullOrWhiteSpace([string]$_.CommandLine) }).Count -gt 0) {
        # A short-lived interpreter may exit during enumeration. Refresh the entire
        # filtered snapshot once: never merge stale PIDs or infer identity across
        # PID reuse. A still-unreadable candidate or failed retry stays fail-closed.
        $processes = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'node.exe' OR Name = 'powershell.exe' OR Name = 'pwsh.exe'" -ErrorAction Stop)
        if (@($processes | Where-Object { [string]::IsNullOrWhiteSpace([string]$_.CommandLine) }).Count -gt 0) { $processStatus = 'ERROR' }
    }
} catch { $processStatus = 'ERROR' }
try {
    # Enumerate once to distinguish absence from failed inspection. Only exact root task
    # identities in the fixed catalog are subsequently projected.
    $tasks = @(Get-ScheduledTask -TaskPath '\' -ErrorAction Stop)
} catch { $schedulerStatus = 'ERROR' }

$jobs = @()
foreach ($spec in $Catalog) {
    $script = Get-Field $spec 'script'
    $producerMatches = @()
    if ($processStatus -eq 'OK' -and $script) {
        $scripts = @($script) + @(Get-Field $spec 'aliases')
        foreach ($process in $processes) {
            $token = Get-ScriptToken $process
            foreach ($candidate in $scripts) {
                $kind = Get-MatchKind $token $candidate
                if ($kind) {
                    $producerMatches += [pscustomobject]@{ Process = $process; MatchKind = $kind }
                    break
                }
            }
        }
    }
    # If a reviewed PowerShell manager has a matching producer child, count the
    # leaf producer, not both. Unrelated manual shells and cmd wrappers never match.
    $parentIds = @($producerMatches | ForEach-Object { [long]$_.Process.ParentProcessId })
    $leaves = @($producerMatches | Where-Object { [long]$_.Process.ProcessId -notin $parentIds })
    $processView = [ordered]@{
        state = 'UNKNOWN'; pid = $null; pids = @(); instanceCount = 0
        startedAt = $null; windowVisible = $null; matchKind = 'NONE'
    }
    if ($processStatus -eq 'OK' -and $script) {
        $processView.state = 'NOT_RUNNING'
        if ($leaves.Count -gt 128) {
            $processView.state = 'UNKNOWN'
        } elseif ($leaves.Count -gt 0) {
            $ids = @($leaves | ForEach-Object { [long]$_.Process.ProcessId } | Sort-Object -Unique)
            $processView.state = 'RUNNING'
            $processView.pids = $ids
            $processView.instanceCount = $ids.Count
            $processView.matchKind = 'WORKSPACE_PATH'
            if (@($leaves | Where-Object { $_.MatchKind -eq 'SCRIPT_MATCH' }).Count -gt 0) {
                $processView.matchKind = 'SCRIPT_MATCH'
            }
            if ($ids.Count -eq 1) {
                $processView.pid = $ids[0]
                $processView.startedAt = Convert-SafeDate $leaves[0].Process.CreationDate
                # A console producer can have no MainWindowHandle even in a visible
                # wrapper. Do not claim hidden/visible from missing window information.
            }
        }
    }
    $schedule = $null
    $taskId = Get-Field $spec 'taskId'
    if ($taskId) {
        $schedule = [ordered]@{
            taskId = $taskId; state = 'UNKNOWN'; enabled = $null; cadenceSeconds = $null
            nextRunAt = $null; lastRunAt = $null; lastResultCode = $null; hiddenLaunch = $null
        }
        if ($schedulerStatus -eq 'OK') {
            $found = @($tasks | Where-Object { $_.TaskName -ceq $taskId -and $_.TaskPath -eq '\' })
            if ($found.Count -eq 0) {
                $schedule.state = 'MISSING'
            } elseif ($found.Count -eq 1) {
                try {
                    $task = $found[0]
                    $info = Get-ScheduledTaskInfo -TaskName $taskId -TaskPath '\' -ErrorAction Stop
                    $state = ([string]$task.State).ToUpperInvariant()
                    if ($state -in @('RUNNING', 'READY', 'DISABLED', 'QUEUED')) { $schedule.state = $state }
                    $schedule.enabled = [bool]$task.Settings.Enabled
                    $schedule.nextRunAt = Convert-SafeDate $info.NextRunTime
                    $schedule.lastRunAt = Convert-SafeDate $info.LastRunTime
                    $schedule.lastResultCode = [long]$info.LastTaskResult
                    $intervals = @()
                    foreach ($trigger in @($task.Triggers)) {
                        $repetition = Get-Field $trigger 'Repetition'
                        $interval = Get-Field $repetition 'Interval'
                        if ($interval) {
                            $seconds = [System.Xml.XmlConvert]::ToTimeSpan($interval).TotalSeconds
                            if ($seconds -gt 0 -and $seconds -le 31536000 -and $seconds -eq [math]::Floor($seconds)) {
                                $intervals += [long]$seconds
                            }
                        }
                    }
                    $intervals = @($intervals | Sort-Object -Unique)
                    if ($intervals.Count -eq 1) { $schedule.cadenceSeconds = $intervals[0] }
                    # Settings.Hidden only hides a task in the scheduler UI, NOT its
                    # console. Recognize the pinned synchronous hidden transport or
                    # explicit PS window flags; neither proves producer readiness.
                    foreach ($action in @($task.Actions)) {
                        $execute = [IO.Path]::GetFileName([string](Get-Field $action 'Execute'))
                        $arguments = [string](Get-Field $action 'Arguments')
                        if ($execute -in @('powershell.exe', 'pwsh.exe') -and
                            [regex]::IsMatch($arguments, '(?:^|\s)-WindowStyle\s+Hidden(?:\s|$)', [Text.RegularExpressions.RegexOptions]::IgnoreCase)) {
                            if (@($task.Actions).Count -eq 1) { $schedule.hiddenLaunch = $true }
                        }
                        if (@($task.Actions).Count -eq 1 -and (Test-CanonicalHiddenAction $action)) {
                            $schedule.hiddenLaunch = $true
                        }
                    }
                } catch {
                    # An individual inaccessible task is unknown, never missing.
                    $schedule = [ordered]@{
                        taskId = $taskId; state = 'UNKNOWN'; enabled = $null; cadenceSeconds = $null
                        nextRunAt = $null; lastRunAt = $null; lastResultCode = $null; hiddenLaunch = $null
                    }
                }
            }
        }
    }
    $jobs += [ordered]@{ id = $spec.id; process = $processView; schedule = $schedule }
}
$result = [ordered]@{
    observedAt = [datetime]::UtcNow.ToString('o')
    inspection = [ordered]@{ processes = $processStatus; scheduler = $schedulerStatus }
    jobs = $jobs
}
$json = ConvertTo-Json -InputObject $result -Depth 8 -Compress
if ([Text.Encoding]::UTF8.GetByteCount($json) -gt 131072) { exit 1 }
[Console]::Out.Write($json)
