[CmdletBinding()]
param(
    [ValidateSet('Preflight', 'Install', 'RunScheduled', 'Status', 'Uninstall')]
    [string]$Mode = 'Preflight'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$TaskName = 'EVM-Audit-Protocol-Trigger-Scout-V3'
$Cadence = New-TimeSpan -Minutes 5
$Duration = New-TimeSpan -Hours 8
$MutexName = 'Local\EVM-Audit-Protocol-Trigger-Scout-V3'
$WorkspacePath = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$ManagerPath = [System.IO.Path]::GetFullPath($PSCommandPath)
$ScoutPath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'atomic\ethereum-top-trades-7d-reconstruction\protocol-delta-trigger-scout-v3.js'))
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
    if ($TaskName -ne 'EVM-Audit-Protocol-Trigger-Scout-V3') { throw 'TASK_IDENTITY_INVALID' }
    if (-not [System.IO.Directory]::Exists($WorkspacePath)) { throw 'WORKSPACE_INVALID' }
    if (-not [System.IO.File]::Exists($ManagerPath) -or [System.IO.Path]::GetFullPath($ManagerPath) -ne [System.IO.Path]::GetFullPath((Join-Path $WorkspacePath 'tools\manage-protocol-trigger-scout-v3-task.ps1'))) { throw 'MANAGER_PATH_INVALID' }
    if (-not [System.IO.File]::Exists($ScoutPath) -or [System.IO.Path]::GetFullPath($ScoutPath) -ne [System.IO.Path]::GetFullPath((Join-Path $WorkspacePath 'tools\atomic\ethereum-top-trades-7d-reconstruction\protocol-delta-trigger-scout-v3.js'))) { throw 'SCOUT_PATH_INVALID' }
    $script:VerifiedPowerShellPath = Get-VerifiedPowerShellPath
    [void](Get-VerifiedNodePath)
}

function Invoke-Preflight {
    Assert-LocalPaths
    Write-SanitizedJson @{ ok = $true; mode = 'Preflight'; taskName = $TaskName; workspaceVerified = $true; managerVerified = $true; scoutVerified = $true; nodeVerified = $true; taskQueried = $false; taskChanged = $false; childExecuted = $false; inventoryRead = $false; networkRead = $false; outputAccess = $false }
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
    if ($null -eq $script:VerifiedPowerShellPath -or -not [System.IO.Path]::IsPathRooted([string]$action.Execute) -or -not [System.StringComparer]::OrdinalIgnoreCase.Equals([string]$action.Execute, $script:VerifiedPowerShellPath) -or [string]$action.Arguments -cne $ExpectedArguments -or [System.IO.Path]::GetFullPath([string]$action.WorkingDirectory) -ne $WorkspacePath) { throw 'TASK_ACTION_MISMATCH' }
    if ((Resolve-PrincipalSid -UserId ([string]$Task.Principal.UserId)) -ne (Get-CurrentUserSid)) { throw 'TASK_PRINCIPAL_USER_MISMATCH' }
    if ([string]$Task.Principal.RunLevel -ne 'Limited') { throw 'TASK_PRINCIPAL_RUNLEVEL_MISMATCH' }
    $triggers = @($Task.Triggers)
    if ($triggers.Count -ne 1 -or [string]$triggers[0].Repetition.Interval -ne 'PT5M' -or [string]$triggers[0].Repetition.Duration -ne 'PT8H') { throw 'TASK_TRIGGER_MISMATCH' }
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
    $action = New-ScheduledTaskAction -Execute $script:VerifiedPowerShellPath -Argument $ExpectedArguments -WorkingDirectory $WorkspacePath
    $trigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1)) -RepetitionInterval $Cadence -RepetitionDuration $Duration
    $principal = New-ScheduledTaskPrincipal -UserId (Get-CurrentUserId) -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
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
    Write-SanitizedJson @{ ok = $true; mode = 'Install'; taskName = $TaskName; enabled = $true; cadenceMinutes = 5; durationHours = 8 }
}

function Disable-TerminalTask {
    $task = Get-FixedTask
    if ($null -eq $task) { throw 'TASK_NOT_FOUND' }
    [void](Assert-TaskIdentity -Task $task)
    Disable-ScheduledTask -TaskName $TaskName | Out-Null
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
            try { & $nodePath $ScoutPath '--capture-if-ready'; $childExit = $LASTEXITCODE }
            finally { Pop-Location }
        }
        finally {
            if ($hadNodeOptions) { $env:NODE_OPTIONS = $oldNodeOptions } else { Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue }
            if ($hadNodePath) { $env:NODE_PATH = $oldNodePath } else { Remove-Item Env:NODE_PATH -ErrorAction SilentlyContinue }
        }
        if ($childExit -eq 3) { exit 3 }
        Disable-TerminalTask
        if ($childExit -in @(0, 1, 4)) { exit $childExit }
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
        if ($failureCode -notmatch '^(?:TASK|INSTALL|MANAGER|SCOUT|WORKSPACE|NODE|POWERSHELL)_[A-Z0-9_]+$') { $failureCode = 'MANAGER_FAILED_CLOSED' }
        Write-SanitizedJson @{ ok = $false; mode = $Mode; code = $failureCode }
        exit 1
    }
}
