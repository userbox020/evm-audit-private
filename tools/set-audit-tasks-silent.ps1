[CmdletBinding()]
param([switch]$Apply, [switch]$RepairCanarySchedule)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'hidden-launch-action.ps1')
$script:SilentWorkspace = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))

function Get-SilentTaskBindings {
    # Fixed root-task allowlist. Never enumerate or mutate unrelated/disabled tasks.
    return [ordered]@{
        EVMAuditMonitorAlerts = @('monitor-alert-dispatcher.js', '--apply')
        EVMAuditTriggerCoverageAudit = @('audit-trigger-coverage-universe.js', '')
        'EVM-Audit-Profit-Trigger-Watch' = @('manage-profit-trigger-watch-task.ps1', 'RunScheduled')
        EVMAuditCanaryFeeds = @('refresh-canary-feeds.js', '--once')
        EVMAuditMonitorSetWatchdog = @('monitor-set-watchdog.js', '--apply')
        EVMAuditWalletBalances = @('watch-wallet-balances.js', '--once')
        'EVM-Audit-Polymarket-R17-R18-15m' = @('manage-r17-task.ps1', 'RunNow')
        EVMAuditWalletTransactions = @('watch-wallet-transactions.js', '--once')
        EVMAuditMonitorSet = @('monitor-set-autostart.cmd', '')
        EVMAuditMonitorKaminoReduced = @('monitor-kamino-reduced-status.js', '--loop --interval-seconds 300')
        EVMAuditMonitorVenus = @('monitor-venus-psr-multichain.js', '--loop --use-authorized-inventory --allow-public-ethereum-fallback --interval-seconds 3600')
    }
}

function Get-SilentTrustedNode {
    # Fixed installation, never accept an arbitrary PATH-selected executable.
    $trusted = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'nodejs\node.exe'
    if (-not [IO.File]::Exists($trusted)) { throw 'TASK_EXECUTABLE_UNVERIFIED' }
    $nodes = @(Get-Command node.exe -CommandType Application -All -ErrorAction Stop)
    if ($nodes.Count -eq 0 -or @($nodes | Where-Object { -not [StringComparer]::OrdinalIgnoreCase.Equals([IO.Path]::GetFullPath($_.Source), $trusted) }).Count -ne 0) { throw 'TASK_EXECUTABLE_UNVERIFIED' }
    return $trusted
}

function Resolve-SilentExecutable {
    param([string]$Executable)
    $system = [Environment]::SystemDirectory
    $cmd = Join-Path $system 'cmd.exe'
    $ps = Join-Path $system 'WindowsPowerShell\v1.0\powershell.exe'
    # Known aliases are intentionally pinned to trusted absolute executables.
    # Arguments and cwd are NEVER normalized. Rooted executable spelling survives.
    if ([StringComparer]::OrdinalIgnoreCase.Equals($Executable, 'cmd.exe')) { $resolved = $cmd }
    elseif ([StringComparer]::OrdinalIgnoreCase.Equals($Executable, 'powershell.exe')) { $resolved = $ps }
    elseif ([StringComparer]::OrdinalIgnoreCase.Equals($Executable, 'node') -or [StringComparer]::OrdinalIgnoreCase.Equals($Executable, 'node.exe')) { $resolved = Get-SilentTrustedNode }
    elseif ([StringComparer]::OrdinalIgnoreCase.Equals($Executable, $cmd) -or [StringComparer]::OrdinalIgnoreCase.Equals($Executable, $ps)) { $resolved = $Executable }
    elseif ([IO.Path]::IsPathRooted($Executable) -and [StringComparer]::OrdinalIgnoreCase.Equals($Executable, (Get-SilentTrustedNode))) { $resolved = $Executable }
    else { throw 'TASK_EXECUTABLE_UNVERIFIED' }
    if (-not [IO.File]::Exists($resolved)) { throw 'TASK_EXECUTABLE_UNVERIFIED' }
    return $resolved
}

function Assert-SilentTaskPayload {
    param([string]$Name, $Action)
    $bindings = Get-SilentTaskBindings
    if (-not $bindings.Contains($Name)) { throw 'TASK_NOT_ALLOWLISTED' }
    $cwd = [string]$Action.WorkingDirectory
    if ($cwd -cne '' -and (-not [IO.Path]::IsPathRooted($cwd) -or -not [StringComparer]::OrdinalIgnoreCase.Equals([IO.Path]::GetFullPath($cwd), $script:SilentWorkspace))) { throw 'TASK_WORKSPACE_UNVERIFIED' }
    $arg = [string]$Action.Arguments
    if ($arg -match '(?i)(?:https?|wss?)://|\b(?:bearer|token|secret|password|credential|endpoint|rpc[_-]?url)\s*[:= ]|[\r\n\x00]') { throw 'TASK_PAYLOAD_REFUSED' }
    $exe = Resolve-SilentExecutable ([string]$Action.Execute)
    $system = [Environment]::SystemDirectory
    $ps = Join-Path $system 'WindowsPowerShell\v1.0\powershell.exe'
    $cmd = Join-Path $system 'cmd.exe'
    $binding = $bindings[$Name]
    $target = Join-Path $PSScriptRoot $binding[0]
    if (-not [IO.File]::Exists($target)) { throw 'TASK_TARGET_UNVERIFIED' }
    if ($binding[0].EndsWith('.ps1')) {
        $expected = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -Mode {1}' -f $target, $binding[1]
        if (-not [StringComparer]::OrdinalIgnoreCase.Equals($exe, $ps) -or $arg -cne $expected) { throw 'TASK_PAYLOAD_UNSUPPORTED' }
        return
    }
    if ($binding[0].EndsWith('.cmd')) {
        $forms = @('/c ""{0}""', '/d /s /c ""{0}""', '/c "{0}"', '/c {0}')
        $accepted = @($forms | ForEach-Object { $_ -f $target })
        if ($cwd -cne '') { $accepted += @('/c tools\monitor-set-autostart.cmd', '/c "tools\monitor-set-autostart.cmd"') }
        if (-not [StringComparer]::OrdinalIgnoreCase.Equals($exe, $cmd) -or $arg -cnotin $accepted) { throw 'TASK_PAYLOAD_UNSUPPORTED' }
        return
    }
    if ($Name -ceq 'EVMAuditWalletBalances' -and [StringComparer]::OrdinalIgnoreCase.Equals($exe, $ps)) {
        # Exact installed, workspace-bound PowerShell grammar. Not a general
        # -Command parser: extra statements, flags or script paths are refused.
        $literalRoot = $script:SilentWorkspace.Replace("'", "''")
        $expected = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Set-Location ''' + $literalRoot + '''; & node ''tools\watch-wallet-balances.js'' --once"'
        if ($arg -cne $expected) { throw 'TASK_PAYLOAD_UNSUPPORTED' }
        [void](Get-SilentTrustedNode)
        return
    }
    $node = Get-SilentTrustedNode
    $scriptForms = @(('"{0}"' -f $target))
    if ($target -notmatch '[\s"&|<>^%]') { $scriptForms += $target }
    # Empty task cwd is inherited. Only absolute targets, or an exact cd preamble
    # below, may bind a relative script to this workspace.
    if ($cwd -cne '') { $scriptForms += @(('tools\' + $binding[0]), ('tools/' + $binding[0])) }
    $flags = @([string]$binding[1])
    if ($Name -in @('EVMAuditWalletBalances', 'EVMAuditWalletTransactions')) { $flags += '' }
    if ($Name -ceq 'EVMAuditTriggerCoverageAudit') { $flags += '--apply' }
    $commands = @()
    foreach ($form in $scriptForms) {
        foreach ($flag in $flags) {
            $tail = ($form + ' ' + $flag).TrimEnd()
            if ([StringComparer]::OrdinalIgnoreCase.Equals($exe, $node) -and $arg -ceq $tail) { return }
            $commands += 'node ' + $tail
            $commands += ('"{0}" ' -f $node) + $tail
        }
    }
    if (-not [StringComparer]::OrdinalIgnoreCase.Equals($exe, $cmd)) { throw 'TASK_EXECUTABLE_UNVERIFIED' }
    # Accept only fully known command grammars. No arbitrary flags, redirection,
    # appended commands, variable expansion or raw-command registry.
    $preambles = @('', '(set NODE_OPTIONS=) & (set NODE_PATH=) & ')
    if ($cwd -cne '') { $preambles += '(set NODE_OPTIONS=) & (set NODE_PATH=) & (for /f "delims=" %V in (''node tools\monitor-minimal-env.js --names-to-clear'') do set "%V=") & (node tools\monitor-minimal-env.js --assert-current >nul 2>&1 || exit /b 1) & ' }
    foreach ($command in $commands) {
        foreach ($prefix in $preambles) {
            foreach ($body in @($command, ('(' + $command + ')'))) {
                foreach ($switches in @('/c', '/d /c', '/d /s /c')) {
                    if ($arg -ceq ($switches + ' "' + $prefix + $body + '"')) { return }
                    if ($prefix -ceq '' -and $body -ceq $command -and $arg -ceq ($switches + ' ' + $command)) { return }
                }
            }
        }
    }
    # A separately enumerated cd grammar supports inherited cwd without guessing
    # it or accepting arbitrary shell statements.
    foreach ($flag in $flags) {
        $relative = ('node tools\' + $binding[0] + ' ' + $flag).TrimEnd()
        $expected = '/d /c cd /d "' + $script:SilentWorkspace + '" && ' + $relative
        if ($arg -ceq $expected) { return }
    }
    throw 'TASK_PAYLOAD_UNSUPPORTED'
}

function Get-SilentNonActionXml {
    param([string]$Name)
    [xml]$xml = Export-ScheduledTask -TaskName $Name -TaskPath '\' -ErrorAction Stop
    $actions = @($xml.DocumentElement.ChildNodes | Where-Object { $_.LocalName -ceq 'Actions' })
    if ($actions.Count -ne 1) { throw 'TASK_XML_UNVERIFIED' }
    [void]$xml.DocumentElement.RemoveChild($actions[0])
    return $xml.OuterXml
}

function Invoke-SilentTaskMigration {
    param([switch]$Apply)
    foreach ($name in (Get-SilentTaskBindings).Keys) {
        $status = 'refused'; $reason = 'TASK_INSPECTION_FAILED'; $executableNormalized = $false
        try {
            $tasks = @(Get-ScheduledTask -TaskName $name -TaskPath '\' -ErrorAction SilentlyContinue)
            if ($tasks.Count -eq 0) { $status = 'absent'; $reason = 'TASK_ABSENT' }
            elseif ($tasks.Count -ne 1) { throw 'TASK_IDENTITY_UNVERIFIED' }
            else {
                $task = $tasks[0]
                if ($task.TaskName -cne $name -or $task.TaskPath -cne '\') { throw 'TASK_IDENTITY_UNVERIFIED' }
                if (-not [bool]$task.Settings.Enabled -or [string]$task.State -eq 'Disabled') {
                    $status = 'skipped'; $reason = 'TASK_DISABLED'
                } else {
                    if (@($task.Actions).Count -ne 1) { throw 'TASK_ACTION_UNSUPPORTED' }
                    $original = @($task.Actions)[0]
                    $inner = $original
                    $wrapped = [IO.Path]::GetFileName([string]$original.Execute) -ieq 'wscript.exe'
                    if ($wrapped) { $inner = Read-HiddenLaunchAction $original }
                    Assert-SilentTaskPayload $name $inner
                    $resolvedExe = Resolve-SilentExecutable ([string]$inner.Execute)
                    $executableNormalized = [string]$inner.Execute -cne $resolvedExe
                    $spec = New-HiddenLaunchSpec -Executable $resolvedExe -Arguments $inner.Arguments -WorkingDirectory $inner.WorkingDirectory
                    if ($wrapped) { $status = 'unchanged'; $reason = 'TASK_CANONICAL' }
                    elseif (-not $Apply) { $status = 'would-change'; $reason = 'TASK_VERIFIED' }
                    else {
                        # Snapshots and rollback action remain in memory only.
                        $before = Get-SilentNonActionXml $name
                        $current = Get-ScheduledTask -TaskName $name -TaskPath '\' -ErrorAction Stop
                        if (-not [bool]$current.Settings.Enabled -or @($current.Actions).Count -ne 1 -or -not (Test-HiddenActionEqual @($current.Actions)[0] $original) -or (Get-SilentNonActionXml $name) -cne $before) { throw 'TASK_CHANGED_DURING_INSPECTION' }
                        $action = ConvertTo-HiddenScheduledTaskAction $spec
                        try {
                            Set-ScheduledTask -TaskName $name -TaskPath '\' -Action $action -ErrorAction Stop | Out-Null
                            $after = Get-ScheduledTask -TaskName $name -TaskPath '\' -ErrorAction Stop
                            if ($after.TaskName -cne $name -or $after.TaskPath -cne '\' -or -not [bool]$after.Settings.Enabled -or @($after.Actions).Count -ne 1 -or -not (Test-HiddenActionEqual @($after.Actions)[0] $spec) -or (Get-SilentNonActionXml $name) -cne $before) { throw 'TASK_POSTVALIDATION_FAILED' }
                        } catch {
                            # A rejected Set (for example ACL denial) may not have
                            # changed anything. Verify that before attempting another
                            # write; failed inspection is uncertainty, never proof.
                            $updateNotApplied = $false
                            try {
                                $observed = Get-ScheduledTask -TaskName $name -TaskPath '\' -ErrorAction Stop
                                $observedXml = Get-SilentNonActionXml $name
                                $updateNotApplied = ($observed.TaskName -ceq $name -and $observed.TaskPath -ceq '\' -and [bool]$observed.Settings.Enabled -and [string]$observed.State -ne 'Disabled' -and @($observed.Actions).Count -eq 1 -and (Test-HiddenActionEqual @($observed.Actions)[0] $original) -and $observedXml -ceq $before)
                            } catch { $updateNotApplied = $false }
                            if ($updateNotApplied) { throw 'TASK_UPDATE_NOT_APPLIED' }
                            try {
                                Set-ScheduledTask -TaskName $name -TaskPath '\' -Action $original -ErrorAction Stop | Out-Null
                                $restored = Get-ScheduledTask -TaskName $name -TaskPath '\' -ErrorAction Stop
                                if (@($restored.Actions).Count -ne 1 -or -not (Test-HiddenActionEqual @($restored.Actions)[0] $original) -or (Get-SilentNonActionXml $name) -cne $before) { throw 'invalid' }
                            } catch { throw 'TASK_ROLLBACK_FAILED' }
                            throw 'TASK_UPDATE_ROLLED_BACK'
                        }
                        $status = 'changed'; $reason = 'TASK_ACTION_ONLY_VERIFIED'
                    }
                }
            }
        } catch {
            $reason = [string]$_.Exception.Message
            if ($reason -notmatch '^TASK_[A-Z_]+$') { $reason = 'TASK_INSPECTION_FAILED' }
        }
        [pscustomobject]@{ taskName = $name; status = $status; reason = $reason; executableNormalized = $executableNormalized }
        # Do not continue a batch after an unverifiable rollback. Restoring
        # non-action fields here would violate this action-only authority.
        if ($reason -ceq 'TASK_ROLLBACK_FAILED') { return }
    }
}

function Get-CanaryXmlChild {
    param($Node, [string]$Name)
    $children = @($Node.ChildNodes | Where-Object { $_.LocalName -ceq $Name })
    if ($children.Count -gt 1) { throw 'TASK_XML_UNVERIFIED' }
    if ($children.Count -eq 1) { return $children[0] }
    return $null
}

function ConvertTo-CanaryBoundary {
    param([string]$Value)
    if ($Value -ceq '') { return $null }
    $parsed = [DateTimeOffset]::MinValue
    if ($Value -notmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$' -or -not [DateTimeOffset]::TryParse($Value, [ref]$parsed)) { throw 'TASK_TRIGGER_DATE_INVALID' }
    return $parsed.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
}

function Get-CanaryScheduleSnapshot {
    # No task enumeration. Raw XML/actions/principal stay in memory only.
    $tasks = @(Get-ScheduledTask -TaskName 'EVMAuditCanaryFeeds' -TaskPath '\' -ErrorAction Stop)
    if ($tasks.Count -ne 1 -or $tasks[0].TaskName -cne 'EVMAuditCanaryFeeds' -or $tasks[0].TaskPath -cne '\') { throw 'TASK_IDENTITY_UNVERIFIED' }
    $task = $tasks[0]
    if (-not [bool]$task.Settings.Enabled -or [string]$task.State -eq 'Disabled') { throw 'TASK_DISABLED' }
    if (@($task.Actions).Count -ne 1) { throw 'TASK_ACTION_UNSUPPORTED' }
    $inner = Read-HiddenLaunchAction @($task.Actions)[0] # enforces canonical synchronous wait=true
    Assert-SilentTaskPayload 'EVMAuditCanaryFeeds' $inner
    if ([string]$task.Settings.MultipleInstances -cnotin @('IgnoreNew', '2')) { throw 'TASK_SETTINGS_UNSUPPORTED' }
    try { $limit = [Xml.XmlConvert]::ToTimeSpan([string]$task.Settings.ExecutionTimeLimit) } catch { throw 'TASK_SETTINGS_UNSUPPORTED' }
    if ($limit.TotalMinutes -lt 16) { throw 'TASK_SETTINGS_UNSUPPORTED' } # 3 x 5-minute children + close/write margin
    if (@($task.Triggers).Count -ne 1) { throw 'TASK_TRIGGER_UNSUPPORTED' }
    [xml]$xml = Export-ScheduledTask -TaskName 'EVMAuditCanaryFeeds' -TaskPath '\' -ErrorAction Stop
    $triggers = Get-CanaryXmlChild $xml.DocumentElement 'Triggers'
    if ($null -eq $triggers -or @($triggers.ChildNodes).Count -ne 1 -or $triggers.FirstChild.LocalName -cne 'TimeTrigger') { throw 'TASK_TRIGGER_UNSUPPORTED' }
    $trigger = $triggers.FirstChild
    $repeat = Get-CanaryXmlChild $trigger 'Repetition'
    if ($null -eq $repeat -or @($repeat.ChildNodes | Where-Object { $_.LocalName -cnotin @('Interval', 'Duration', 'StopAtDurationEnd') }).Count -gt 0) { throw 'TASK_TRIGGER_UNSUPPORTED' }
    $fields = @{}
    foreach ($key in @('StartBoundary', 'EndBoundary', 'Enabled')) {
        $node = Get-CanaryXmlChild $trigger $key
        $fields[$key] = if ($null -eq $node) { '' } else { $node.InnerText }
    }
    foreach ($key in @('Interval', 'Duration', 'StopAtDurationEnd')) {
        $node = Get-CanaryXmlChild $repeat $key
        $fields[$key] = if ($null -eq $node) { '' } else { $node.InnerText }
    }
    try {
        $interval = [Xml.XmlConvert]::ToString([Xml.XmlConvert]::ToTimeSpan($fields.Interval))
        $duration = if ($fields.Duration -ceq '') { $null } else { [Xml.XmlConvert]::ToString([Xml.XmlConvert]::ToTimeSpan($fields.Duration)) }
    } catch { throw 'TASK_TRIGGER_UNSUPPORTED' }
    if ($fields.Enabled -cnotin @('', 'true', 'false') -or $fields.StopAtDurationEnd -cnotin @('', 'true', 'false')) { throw 'TASK_TRIGGER_UNSUPPORTED' }
    $schedule = [pscustomobject][ordered]@{
        startBoundary = ConvertTo-CanaryBoundary $fields.StartBoundary
        endBoundary = ConvertTo-CanaryBoundary $fields.EndBoundary
        interval = $interval; duration = $duration
        enabled = $fields.Enabled -cne 'false'; stopAtDurationEnd = $fields.StopAtDurationEnd -ceq 'true'
    }
    $fullXml = $xml.OuterXml
    $invariant = $trigger.CloneNode($true)
    foreach ($node in @($invariant.ChildNodes)) {
        if ($node.LocalName -cin @('Repetition', 'StartBoundary', 'EndBoundary', 'Enabled')) { [void]$invariant.RemoveChild($node) }
    }
    [void]$xml.DocumentElement.RemoveChild($triggers)
    return [pscustomobject]@{
        Task = $task; FullXml = $fullXml; NonTriggerXml = $xml.OuterXml; TriggerInvariant = $invariant.OuterXml
        Schedule = $schedule
        Settings = [pscustomobject]@{ enabled = $true; multipleInstances = 'IgnoreNew'; executionTimeLimit = [Xml.XmlConvert]::ToString($limit); startWhenAvailable = [bool]$task.Settings.StartWhenAvailable }
    }
}

function Copy-CanaryScheduleTrigger {
    param($Trigger)
    # Explicitly copy the embedded instance as well; never mutate the retained
    # original used for comparison and bounded rollback.
    $copy = [Microsoft.Management.Infrastructure.CimInstance]::new($Trigger)
    $copy.Repetition = [Microsoft.Management.Infrastructure.CimInstance]::new($Trigger.Repetition)
    return $copy
}

function Test-CanaryScheduleOwnedUpdate {
    param($Observed, $Before, $Proposed)
    return ($Observed.NonTriggerXml -ceq $Before.NonTriggerXml -and $Observed.TriggerInvariant -ceq $Before.TriggerInvariant -and
        ($Observed.Schedule | ConvertTo-Json -Compress) -ceq ($Proposed | ConvertTo-Json -Compress))
}

function Invoke-CanaryScheduleRepair {
    param([switch]$Apply)
    $status = 'refused'; $reason = 'TASK_INSPECTION_FAILED'; $currentSummary = $null; $proposed = $null; $settings = $null
    try {
        $before = Get-CanaryScheduleSnapshot
        $currentSummary = $before.Schedule; $settings = $before.Settings
        $now = [DateTimeOffset]::Now
        $healthy = ($null -ne $currentSummary.startBoundary -and [DateTimeOffset]::Parse($currentSummary.startBoundary) -le $now -and
            $null -eq $currentSummary.endBoundary -and $currentSummary.interval -ceq 'PT5M' -and $null -eq $currentSummary.duration -and
            $currentSummary.enabled -and -not $currentSummary.stopAtDurationEnd)
        if ($healthy) { $proposed = $currentSummary; $status = 'unchanged'; $reason = 'TASK_CANARY_SCHEDULE_HEALTHY' }
        else {
            $start = $now.ToString('yyyy-MM-ddTHH:mm:sszzz')
            $proposed = [pscustomobject][ordered]@{ startBoundary = ConvertTo-CanaryBoundary $start; endBoundary = $null; interval = 'PT5M'; duration = $null; enabled = $true; stopAtDurationEnd = $false }
            if (-not $Apply) { $status = 'would-change'; $reason = 'TASK_CANARY_SCHEDULE_VERIFIED' }
            else {
                $original = @($before.Task.Triggers)[0]
                $replacement = Copy-CanaryScheduleTrigger $original
                $replacement.StartBoundary = $start; $replacement.EndBoundary = ''; $replacement.Enabled = $true
                $replacement.Repetition.Interval = 'PT5M'; $replacement.Repetition.Duration = ''; $replacement.Repetition.StopAtDurationEnd = $false
                $current = Get-CanaryScheduleSnapshot
                if ($current.FullXml -cne $before.FullXml) { throw 'TASK_CHANGED_DURING_INSPECTION' }
                try {
                    Set-ScheduledTask -TaskName 'EVMAuditCanaryFeeds' -TaskPath '\' -Trigger $replacement -ErrorAction Stop | Out-Null
                    $after = Get-CanaryScheduleSnapshot
                    if (-not (Test-CanaryScheduleOwnedUpdate $after $before $proposed)) { throw 'TASK_POSTVALIDATION_FAILED' }
                } catch {
                    # A no-op/denied Set needs no rollback. Uncertain or concurrent
                    # drift is NEVER overwritten, even if that prevents recovery.
                    try { $observed = Get-CanaryScheduleSnapshot } catch { throw 'TASK_ROLLBACK_UNSAFE_ATTENDED_RECOVERY' }
                    if ($observed.FullXml -ceq $before.FullXml) { throw 'TASK_UPDATE_NOT_APPLIED' }
                    if (-not (Test-CanaryScheduleOwnedUpdate $observed $before $proposed)) { throw 'TASK_ROLLBACK_UNSAFE_CONCURRENT_DRIFT' }
                    try {
                        $rollbackCheck = Get-CanaryScheduleSnapshot
                        if ($rollbackCheck.FullXml -cne $observed.FullXml) { throw 'TASK_CHANGED_DURING_INSPECTION' }
                    } catch { throw 'TASK_ROLLBACK_UNSAFE_CONCURRENT_DRIFT' }
                    try {
                        Set-ScheduledTask -TaskName 'EVMAuditCanaryFeeds' -TaskPath '\' -Trigger $original -ErrorAction Stop | Out-Null
                        $restored = Get-CanaryScheduleSnapshot
                        if ($restored.FullXml -cne $before.FullXml) { throw 'TASK_POSTVALIDATION_FAILED' }
                    } catch { throw 'TASK_ROLLBACK_FAILED' }
                    throw 'TASK_UPDATE_ROLLED_BACK'
                }
                $status = 'changed'; $reason = 'TASK_CANARY_TRIGGER_ONLY_VERIFIED'
            }
        }
    } catch {
        $reason = [string]$_.Exception.Message
        if ($reason -notmatch '^TASK_[A-Z_]+$') { $reason = 'TASK_INSPECTION_FAILED' }
    }
    # Explicit safe fields only: never emit XML, actions, encoded payloads or users.
    [pscustomobject]@{ taskName = 'EVMAuditCanaryFeeds'; taskPath = '\'; status = $status; reason = $reason; current = $currentSummary; proposed = $proposed; settings = $settings }
}

function Invoke-SilentTaskOperation {
    param([switch]$Apply, [switch]$RepairCanarySchedule)
    if ($RepairCanarySchedule) { Invoke-CanaryScheduleRepair -Apply:$Apply; return }
    Invoke-SilentTaskMigration -Apply:$Apply
}

if ($MyInvocation.InvocationName -ne '.') {
    $results = @(Invoke-SilentTaskOperation -Apply:$Apply -RepairCanarySchedule:$RepairCanarySchedule)
    $results | ConvertTo-Json -Compress
    if (@($results | Where-Object { $_.status -eq 'refused' }).Count -gt 0) { exit 1 }
}
