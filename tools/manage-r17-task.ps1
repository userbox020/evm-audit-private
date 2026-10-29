[CmdletBinding()]
param(
    [ValidateSet('Install', 'Status', 'Remove', 'RunNow')]
    [string]$Mode = 'Status'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'hidden-launch-action.ps1')

$TaskName = 'EVM-Audit-Polymarket-R17-R18-15m'
$Cadence = New-TimeSpan -Minutes 15
$ExecutionLimit = New-TimeSpan -Minutes 14
$WorkspacePath = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$ManagerPath = [System.IO.Path]::GetFullPath($PSCommandPath)
$CliPath = [System.IO.Path]::GetFullPath((Join-Path $WorkspacePath 'tools\polymarket-research-r18\cli.js'))
$MonitorRoot = [System.IO.Path]::GetFullPath((Join-Path $WorkspacePath 'reports\monitor'))
$ExpectedArguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -Mode RunNow' -f $ManagerPath
$script:VerifiedPowerShellPath = $null
$script:VerifiedNodePath = $null

function Write-SanitizedJson {
    param([hashtable]$Value)
    [Console]::Out.WriteLine(($Value | ConvertTo-Json -Compress -Depth 4))
}

function Get-VerifiedNodePath {
    $applications = @(Get-Command 'node.exe' -CommandType Application -ErrorAction Stop)
    if ($applications.Count -ne 1) { throw 'NODE_PATH_AMBIGUOUS' }
    $resolved = [System.IO.Path]::GetFullPath($applications[0].Source)
    if (-not [System.IO.Path]::IsPathRooted($resolved) -or -not [System.IO.File]::Exists($resolved) -or [System.IO.Path]::GetFileName($resolved) -cne 'node.exe') { throw 'NODE_PATH_INVALID' }
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
    if ($TaskName -ne 'EVM-Audit-Polymarket-R17-R18-15m') { throw 'TASK_IDENTITY_INVALID' }
    if (-not [System.IO.Directory]::Exists($WorkspacePath) -or -not [System.IO.Directory]::Exists($MonitorRoot)) { throw 'WORKSPACE_INVALID' }
    if (-not [System.IO.File]::Exists($ManagerPath) -or -not [System.StringComparer]::OrdinalIgnoreCase.Equals($ManagerPath, [System.IO.Path]::GetFullPath((Join-Path $WorkspacePath 'tools\manage-r17-task.ps1')))) { throw 'MANAGER_PATH_INVALID' }
    if (-not [System.IO.File]::Exists($CliPath) -or -not [System.StringComparer]::OrdinalIgnoreCase.Equals($CliPath, [System.IO.Path]::GetFullPath((Join-Path $WorkspacePath 'tools\polymarket-research-r18\cli.js')))) { throw 'TARGET_PATH_INVALID' }
    $script:VerifiedPowerShellPath = Get-VerifiedPowerShellPath
    $script:VerifiedNodePath = Get-VerifiedNodePath
}

function Get-FixedTask {
    return Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
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
    if ($Task.TaskName -ne $TaskName -or $Task.TaskPath -ne '\') { throw 'TASK_IDENTITY_MISMATCH' }
    if (@($Task.Actions).Count -ne 1) { throw 'TASK_ACTION_MISMATCH' }
    $action = @($Task.Actions)[0]
    if ($null -eq $script:VerifiedPowerShellPath) { throw 'TASK_ACTION_MISMATCH' }
    Assert-HiddenLaunchAction -Action $action -Executable $script:VerifiedPowerShellPath -Arguments $ExpectedArguments -WorkingDirectory $WorkspacePath
    if ((Resolve-PrincipalSid -UserId ([string]$Task.Principal.UserId)) -ne (Get-CurrentUserSid)) { throw 'TASK_PRINCIPAL_USER_MISMATCH' }
    if ([string]$Task.Principal.LogonType -ne 'Interactive' -or [string]$Task.Principal.RunLevel -ne 'Limited') { throw 'TASK_PRINCIPAL_MISMATCH' }
    $triggers = @($Task.Triggers)
    if ($triggers.Count -ne 1 -or [string]$triggers[0].Repetition.Interval -ne 'PT15M') { throw 'TASK_TRIGGER_MISMATCH' }
    if ([string]$Task.Settings.MultipleInstances -ne 'IgnoreNew' -or [string]$Task.Settings.ExecutionTimeLimit -ne 'PT14M' -or [bool]$Task.Settings.StartWhenAvailable) { throw 'TASK_SETTINGS_MISMATCH' }
    return $true
}

function Remove-JustCreatedFixedTask {
    $created = Get-FixedTask
    if ($null -eq $created -or $created.TaskName -ne $TaskName -or $created.TaskPath -ne '\') { throw 'INSTALL_ROLLBACK_IDENTITY_MISMATCH' }
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

function Invoke-Install {
    Assert-LocalPaths
    if ($null -ne (Get-FixedTask)) { throw 'TASK_ALREADY_EXISTS' }
    $action = New-HiddenScheduledTaskAction -Executable $script:VerifiedPowerShellPath -Arguments $ExpectedArguments -WorkingDirectory $WorkspacePath
    $trigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1)) -RepetitionInterval $Cadence
    $principal = New-ScheduledTaskPrincipal -UserId (Get-CurrentUserId) -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit $ExecutionLimit -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    $registered = $false
    try {
        try { $task = Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings }
        catch { throw 'TASK_REGISTER_FAILED' }
        $registered = $true
        try { [void](Assert-TaskIdentity -Task $task) }
        catch { throw ('TASK_POSTVALIDATION_' + [string]$_.Exception.Message) }
    }
    catch {
        $failure = $_
        if ($registered) {
            try { Remove-JustCreatedFixedTask }
            catch { throw 'TASK_ROLLBACK_FAILED' }
        }
        throw $failure
    }
    Write-SanitizedJson @{ ok = $true; mode = 'Install'; taskName = $TaskName; cadenceMinutes = 15; multipleInstances = 'IgnoreNew'; principal = 'CurrentUserInteractiveLimited' }
}

function Invoke-Status {
    Assert-LocalPaths
    $task = Get-FixedTask
    if ($null -eq $task) { Write-SanitizedJson @{ ok = $true; mode = 'Status'; taskName = $TaskName; installed = $false; state = 'Absent'; lastResult = $null }; return }
    [void](Assert-TaskIdentity -Task $task)
    $info = Get-ScheduledTaskInfo -TaskName $TaskName
    Write-SanitizedJson @{ ok = $true; mode = 'Status'; taskName = $TaskName; installed = $true; state = [string]$task.State; enabled = [bool]$task.Settings.Enabled; lastResult = [int64]$info.LastTaskResult }
}

function Invoke-Remove {
    Assert-LocalPaths
    $task = Get-FixedTask
    if ($null -eq $task) { throw 'TASK_NOT_FOUND' }
    [void](Assert-TaskIdentity -Task $task)
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-SanitizedJson @{ ok = $true; mode = 'Remove'; taskName = $TaskName; removed = $true }
}

function Invoke-RunNow {
    Assert-LocalPaths
    $asOfMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    Push-Location -LiteralPath $WorkspacePath
    try { & $script:VerifiedNodePath $CliPath 'run-once' '--as-of-ms' ([string]$asOfMs) '--root' $MonitorRoot; $exitCode = $LASTEXITCODE }
    finally { Pop-Location }
    if ($exitCode -ne 0) { throw 'TARGET_RUN_FAILED' }
    Write-SanitizedJson @{ ok = $true; mode = 'RunNow'; taskName = $TaskName; completed = $true }
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        switch ($Mode) {
            'Install' { Invoke-Install }
            'Status' { Invoke-Status }
            'Remove' { Invoke-Remove }
            'RunNow' { Invoke-RunNow }
        }
    }
    catch {
        $code = [string]$_.Exception.Message
        if ($code -notmatch '^(?:TASK|INSTALL|MANAGER|TARGET|WORKSPACE|NODE|POWERSHELL)_[A-Z0-9_]+$') { $code = 'MANAGER_FAILED_CLOSED' }
        Write-SanitizedJson @{ ok = $false; mode = $Mode; code = $code }
        exit 1
    }
}
