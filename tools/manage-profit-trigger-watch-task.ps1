[CmdletBinding()]
param(
    [ValidateSet('Preflight', 'Install', 'RunScheduled', 'Status', 'Uninstall')]
    [string]$Mode = 'Preflight'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'hidden-launch-action.ps1')

$TaskName = 'EVM-Audit-Profit-Trigger-Watch'
$Cadence = New-TimeSpan -Seconds 240
$ExecutionLimit = New-TimeSpan -Minutes 10
$MutexName = 'Local\EVM-Audit-Profit-Trigger-Watch'
$WorkspacePath = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$ManagerPath = [System.IO.Path]::GetFullPath($PSCommandPath)
$ProducerPath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'run-profit-trigger-watch.js'))
$ForkAutomationEnabled = $false # Safety hold: producers stay scheduled; no automatic fork/alert APPLY.
$AutopilotPath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'trigger-fork-autopilot.js'))
$DispatcherPath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'monitor-alert-dispatcher.js'))
$ExpectedArguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -Mode RunScheduled' -f $ManagerPath
$script:VerifiedPowerShellPath = $null

function Write-SanitizedJson {
    param([hashtable]$Value)
    [Console]::Out.WriteLine(($Value | ConvertTo-Json -Compress -Depth 5))
}

function Get-VerifiedNodePath {
    $command = Get-Command 'node.exe' -CommandType Application -ErrorAction Stop
    $resolved = [System.IO.Path]::GetFullPath($command.Source)
    if (-not [System.IO.File]::Exists($resolved) -or [System.IO.Path]::GetFileName($resolved) -ne 'node.exe') { throw 'NODE_PATH_INVALID' }
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

function Assert-LocalPaths {
    if ($TaskName -ne 'EVM-Audit-Profit-Trigger-Watch') { throw 'TASK_IDENTITY_INVALID' }
    if (-not [System.IO.Directory]::Exists($WorkspacePath)) { throw 'WORKSPACE_INVALID' }
    if (-not [System.IO.File]::Exists($ManagerPath) -or [System.IO.Path]::GetFullPath($ManagerPath) -ne [System.IO.Path]::GetFullPath((Join-Path $WorkspacePath 'tools\manage-profit-trigger-watch-task.ps1'))) { throw 'MANAGER_PATH_INVALID' }
    if (-not [System.IO.File]::Exists($ProducerPath) -or [System.IO.Path]::GetFullPath($ProducerPath) -ne [System.IO.Path]::GetFullPath((Join-Path $WorkspacePath 'tools\run-profit-trigger-watch.js'))) { throw 'PRODUCER_PATH_INVALID' }
    if (-not [System.IO.File]::Exists($AutopilotPath) -or [System.IO.Path]::GetFullPath($AutopilotPath) -ne [System.IO.Path]::GetFullPath((Join-Path $WorkspacePath 'tools\trigger-fork-autopilot.js'))) { throw 'AUTOPILOT_PATH_INVALID' }
    if (-not [System.IO.File]::Exists($DispatcherPath) -or [System.IO.Path]::GetFullPath($DispatcherPath) -ne [System.IO.Path]::GetFullPath((Join-Path $WorkspacePath 'tools\monitor-alert-dispatcher.js'))) { throw 'DISPATCHER_PATH_INVALID' }
    $script:VerifiedPowerShellPath = Get-VerifiedPowerShellPath
    [void](Get-VerifiedNodePath)
}

function ConvertFrom-IsoDuration {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value)
    try { return [System.Xml.XmlConvert]::ToTimeSpan($Value) }
    catch { throw 'TASK_TRIGGER_MISMATCH' }
}

function Invoke-Preflight {
    Assert-LocalPaths
    Write-SanitizedJson @{ ok = $true; mode = 'Preflight'; taskName = $TaskName; workspaceVerified = $true; managerVerified = $true; producerVerified = $true; nodeVerified = $true; taskQueried = $false; taskChanged = $false; childExecuted = $false; inventoryRead = $false; networkRead = $false; outputAccess = $false }
}

function Get-FixedTask {
    return Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}

function Get-CurrentUserId {
    return [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
}

function Get-CurrentUserSid {
    return [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
}

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
    if ($Task.TaskName -ne $TaskName -or $Task.TaskPath -ne '\') { throw 'TASK_IDENTITY_MISMATCH' }
    if (@($Task.Actions).Count -ne 1) { throw 'TASK_ACTION_MISMATCH' }
    $action = @($Task.Actions)[0]
    if ($null -eq $script:VerifiedPowerShellPath) { throw 'TASK_ACTION_MISMATCH' }
    Assert-HiddenLaunchAction -Action $action -Executable $script:VerifiedPowerShellPath -Arguments $ExpectedArguments -WorkingDirectory $WorkspacePath
    if ((Resolve-PrincipalSid -UserId ([string]$Task.Principal.UserId)) -ne (Get-CurrentUserSid)) { throw 'TASK_PRINCIPAL_USER_MISMATCH' }
    if ([string]$Task.Principal.RunLevel -ne 'Limited') { throw 'TASK_PRINCIPAL_RUNLEVEL_MISMATCH' }
    $triggers = @($Task.Triggers)
    if ($triggers.Count -ne 1) { throw 'TASK_TRIGGER_MISMATCH' }
    $repetition = $triggers[0].Repetition
    if ($null -eq $repetition) { throw 'TASK_TRIGGER_MISMATCH' }
    if ((ConvertFrom-IsoDuration -Value ([string]$repetition.Interval)) -ne $Cadence) { throw 'TASK_TRIGGER_MISMATCH' }
    if ([string]$repetition.Duration -ne '' -or [bool]$repetition.StopAtDurationEnd) { throw 'TASK_TRIGGER_MISMATCH' }
    if ([string]$Task.Settings.MultipleInstances -ne 'IgnoreNew') { throw 'TASK_SETTINGS_MISMATCH' }
    if ((ConvertFrom-IsoDuration -Value ([string]$Task.Settings.ExecutionTimeLimit)) -ne $ExecutionLimit) { throw 'TASK_SETTINGS_MISMATCH' }
    return $true
}

function Remove-JustCreatedFixedTask {
    $createdTask = Get-FixedTask
    if ($null -eq $createdTask -or $createdTask.TaskName -ne $TaskName -or $createdTask.TaskPath -ne '\') { throw 'INSTALL_ROLLBACK_IDENTITY_MISMATCH' }
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

function Invoke-Install {
    Assert-LocalPaths
    if ($null -ne (Get-FixedTask)) { throw 'TASK_ALREADY_EXISTS' }
    $action = New-HiddenScheduledTaskAction -Executable $script:VerifiedPowerShellPath -Arguments $ExpectedArguments -WorkingDirectory $WorkspacePath
    $trigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1)) -RepetitionInterval $Cadence
    $trigger.Repetition.StopAtDurationEnd = $false
    $principal = New-ScheduledTaskPrincipal -UserId (Get-CurrentUserId) -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit $ExecutionLimit -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    $created = $false
    try {
        try { $registered = Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings }
        catch { throw 'TASK_REGISTER_FAILED' }
        $created = $true
        try { [void](Assert-TaskIdentity -Task $registered) }
        catch {
            $identityCode = [string]$_.Exception.Message
            if ($identityCode -notmatch '^TASK_(?:IDENTITY|ACTION|TRIGGER|PRINCIPAL_(?:USER|RUNLEVEL))_MISMATCH$') { $identityCode = 'TASK_IDENTITY_MISMATCH' }
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
    Write-SanitizedJson @{ ok = $true; mode = 'Install'; taskName = $TaskName; enabled = $true; cadenceSeconds = 240; indefinite = $true; multipleInstances = 'IgnoreNew'; executionLimitMinutes = 10 }
}

function Test-CurrentAutopilotStatus {
    param(
        [Parameter(Mandatory = $true)][datetimeoffset]$ProducerStart,
        [Parameter(Mandatory = $true)][datetimeoffset]$ProducerEnd,
        [Parameter(Mandatory = $true)][datetimeoffset]$AutopilotStart,
        [Parameter(Mandatory = $true)][datetimeoffset]$AutopilotEnd,
        [Parameter(Mandatory = $true)][string]$StatusPath
    )
    try { $status = Get-Content -LiteralPath $StatusPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop }
    catch { throw 'AUTOPILOT_STATUS_INVALID' }
    if ($null -eq $status -or $status -isnot [pscustomobject] -or $status.schema -cne 'trigger-fork-autopilot-status/v1' -or $status.mode -cne 'APPLY' -or $null -ne $status.blocker -or
        $status.classification -cnotin @('NO_FIRED_EVENT', 'NO_NEW_EVENT', 'EXECUTED') -or $status.source -isnot [pscustomobject] -or
        $status.source.path -cne 'reports/monitor/profit-trigger-watch.json' -or $status.source.fresh -cne $true) { throw 'AUTOPILOT_STATUS_INVALID' }
    $stamp = [datetimeoffset]::MinValue
    $sourceStamp = [datetimeoffset]::MinValue
    $format = 'yyyy-MM-ddTHH:mm:ss.fffZ'
    $culture = [System.Globalization.CultureInfo]::InvariantCulture
    $style = [System.Globalization.DateTimeStyles]::AssumeUniversal
    if ($status.generatedAt -isnot [string] -or -not [datetimeoffset]::TryParseExact($status.generatedAt, $format, $culture, $style, [ref]$stamp) -or
        $stamp -lt $AutopilotStart -or $stamp -gt $AutopilotEnd -or
        $status.source.generatedAt -isnot [string] -or -not [datetimeoffset]::TryParseExact($status.source.generatedAt, $format, $culture, $style, [ref]$sourceStamp) -or
        $sourceStamp -lt $ProducerStart -or $sourceStamp -gt $ProducerEnd) { throw 'AUTOPILOT_STATUS_INVALID' }
    if ($status.classification -ne 'EXECUTED') {
        if ($null -ne $status.execution) { throw 'AUTOPILOT_STATUS_INVALID' }
        return $false
    }
    if ($status.execution -isnot [pscustomobject] -or $status.execution.promoted -isnot [bool] -or $status.execution.success -isnot [bool]) { throw 'AUTOPILOT_STATUS_INVALID' }
    if ($status.execution.promoted -and -not $status.execution.success) { throw 'AUTOPILOT_STATUS_INVALID' }
    return $status.execution.promoted
}

function Invoke-RunScheduled {
    Assert-LocalPaths
    $mutex = [System.Threading.Mutex]::new($false, $MutexName)
    $acquired = $false
    try {
        $acquired = $mutex.WaitOne(0)
        if (-not $acquired) { exit 3 }
        $nodePath = Get-VerifiedNodePath
        $hadNodeOptions = Test-Path Env:NODE_OPTIONS
        $hadNodePath = Test-Path Env:NODE_PATH
        $oldNodeOptions = if ($hadNodeOptions) { $env:NODE_OPTIONS } else { $null }
        $oldNodePath = if ($hadNodePath) { $env:NODE_PATH } else { $null }
        try {
            Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
            Remove-Item Env:NODE_PATH -ErrorAction SilentlyContinue
            Push-Location -LiteralPath $WorkspacePath
            try {
                $producerStart = [datetimeoffset]::UtcNow
                & $nodePath $ProducerPath '--run-once'; $childExit = $LASTEXITCODE
                $producerEnd = [datetimeoffset]::UtcNow
            }
            finally { Pop-Location }
            $autoExit = 0
            $dispExit = 0
            if ($ForkAutomationEnabled -and $childExit -eq 0) {
                Push-Location -LiteralPath $WorkspacePath
                try {
                    $autopilotStart = [datetimeoffset]::UtcNow
                    & $nodePath $AutopilotPath '--apply'; $autoExit = $LASTEXITCODE
                    $autopilotEnd = [datetimeoffset]::UtcNow
                }
                finally { Pop-Location }
                if ($autoExit -ne 0) { exit 1 }
                $statusPath = Join-Path $WorkspacePath 'reports\monitor\trigger-fork-autopilot-status.json'
                $promoted = Test-CurrentAutopilotStatus -ProducerStart $producerStart -ProducerEnd $producerEnd -AutopilotStart $autopilotStart -AutopilotEnd $autopilotEnd -StatusPath $statusPath
                if ($promoted) {
                    Push-Location -LiteralPath $WorkspacePath
                    try { & $nodePath $DispatcherPath '--apply'; $dispExit = $LASTEXITCODE }
                    finally { Pop-Location }
                    if ($dispExit -ne 0) { exit 1 }
                }
            }
        }
        finally {
            if ($hadNodeOptions) { $env:NODE_OPTIONS = $oldNodeOptions } else { Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue }
            if ($hadNodePath) { $env:NODE_PATH = $oldNodePath } else { Remove-Item Env:NODE_PATH -ErrorAction SilentlyContinue }
        }
        if ($childExit -in @(0, 1)) { exit $childExit }
        exit 1
    }
    finally {
        if ($acquired) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}

function Invoke-Status {
    Assert-LocalPaths
    $task = Get-FixedTask
    if ($null -eq $task) { Write-SanitizedJson @{ ok = $true; mode = 'Status'; taskName = $TaskName; installed = $false; enabled = $false; state = 'Absent'; lastResult = $null }; return }
    [void](Assert-TaskIdentity -Task $task)
    $info = Get-ScheduledTaskInfo -TaskName $TaskName
    Write-SanitizedJson @{ ok = $true; mode = 'Status'; taskName = $TaskName; installed = $true; enabled = [bool]$task.Settings.Enabled; state = [string]$task.State; lastResult = [int64]$info.LastTaskResult }
}

function Invoke-Uninstall {
    Assert-LocalPaths
    $task = Get-FixedTask
    if ($null -eq $task) { throw 'TASK_NOT_FOUND' }
    [void](Assert-TaskIdentity -Task $task)
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-SanitizedJson @{ ok = $true; mode = 'Uninstall'; taskName = $TaskName; deleted = $true }
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
        if ($failureCode -notmatch '^(?:TASK|INSTALL|MANAGER|PRODUCER|WORKSPACE|NODE|POWERSHELL)_[A-Z0-9_]+$') { $failureCode = 'MANAGER_FAILED_CLOSED' }
        Write-SanitizedJson @{ ok = $false; mode = $Mode; code = $failureCode }
        exit 1
    }
}
