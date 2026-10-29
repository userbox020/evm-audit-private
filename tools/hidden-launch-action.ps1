# Shared canonical wire format. Encoding is transport, not secret protection.
function Get-HiddenLauncherPaths {
    $system = [System.Environment]::SystemDirectory
    $wrapper = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'launch-hidden.vbs'))
    $bridge = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'hidden-console-runner.ps1'))
    if ($wrapper -match '[%"\r\n]' -or -not [System.IO.File]::Exists($wrapper) -or -not [System.IO.File]::Exists($bridge)) { throw 'TASK_HIDDEN_PATH_INVALID' }
    return [pscustomobject]@{ Execute = (Join-Path $system 'wscript.exe'); Wrapper = $wrapper }
}

function New-HiddenLaunchSpec {
    param([Parameter(Mandatory=$true)][string]$Executable,
        [Parameter(Mandatory=$true)][AllowEmptyString()][string]$Arguments,
        [Parameter(Mandatory=$true)][AllowEmptyString()][string]$WorkingDirectory,
        [bool]$WaitForExit = $true)
    if (-not [System.IO.Path]::IsPathRooted($Executable) -or ($WorkingDirectory -cne '' -and -not [System.IO.Path]::IsPathRooted($WorkingDirectory)) -or $Executable.Contains([char]0) -or $Arguments.Contains([char]0) -or $WorkingDirectory.Contains([char]0)) { throw 'TASK_HIDDEN_PAYLOAD_INVALID' }
    $paths = Get-HiddenLauncherPaths
    $wire = [ordered]@{ version = 1; executable = $Executable; arguments = $Arguments; workingDirectory = $WorkingDirectory; wait = $WaitForExit }
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($wire | ConvertTo-Json -Compress)))
    if ($encoded.Length -gt 28000) { throw 'TASK_HIDDEN_PAYLOAD_TOO_LONG' }
    return [pscustomobject]@{ Execute = $paths.Execute; Arguments = ('//B //Nologo "{0}" {1}' -f $paths.Wrapper, $encoded); WorkingDirectory = $WorkingDirectory }
}

function Test-HiddenActionEqual {
    param($Action, $Expected)
    return ([StringComparer]::OrdinalIgnoreCase.Equals([string]$Action.Execute, [string]$Expected.Execute) -and [string]$Action.Arguments -ceq [string]$Expected.Arguments -and [string]$Action.WorkingDirectory -ceq [string]$Expected.WorkingDirectory)
}

function Assert-HiddenLaunchAction {
    param($Action, [string]$Executable, [string]$Arguments, [string]$WorkingDirectory)
    $expected = New-HiddenLaunchSpec -Executable $Executable -Arguments $Arguments -WorkingDirectory $WorkingDirectory
    if (-not (Test-HiddenActionEqual $Action $expected)) { throw 'TASK_ACTION_MISMATCH' }
}

function New-HiddenScheduledTaskAction {
    param([string]$Executable, [string]$Arguments, [string]$WorkingDirectory)
    $spec = New-HiddenLaunchSpec -Executable $Executable -Arguments $Arguments -WorkingDirectory $WorkingDirectory
    return ConvertTo-HiddenScheduledTaskAction $spec
}

function ConvertTo-HiddenScheduledTaskAction {
    param($Spec)
    # Omit the optional CIM parameter when empty: do not substitute the workspace.
    if ([string]$Spec.WorkingDirectory -ceq '') { return New-ScheduledTaskAction -Execute $Spec.Execute -Argument $Spec.Arguments }
    return New-ScheduledTaskAction -Execute $Spec.Execute -Argument $Spec.Arguments -WorkingDirectory $Spec.WorkingDirectory
}

function Read-HiddenLaunchAction {
    param($Action)
    $paths = Get-HiddenLauncherPaths
    if (-not [StringComparer]::OrdinalIgnoreCase.Equals([string]$Action.Execute, $paths.Execute)) { throw 'TASK_HIDDEN_ACTION_INVALID' }
    $prefix = '//B //Nologo "{0}" ' -f $paths.Wrapper
    if (-not ([string]$Action.Arguments).StartsWith($prefix, [StringComparison]::Ordinal)) { throw 'TASK_HIDDEN_ACTION_INVALID' }
    try {
        $encoded = ([string]$Action.Arguments).Substring($prefix.Length)
        if ($encoded -notmatch '^[A-Za-z0-9+/]+={0,2}$' -or $encoded.Length -gt 28000) { throw 'invalid' }
        $wire = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded)) | ConvertFrom-Json
        if (@($wire.PSObject.Properties).Count -ne 5 -or $wire.version -cne 1 -or $wire.wait -cne $true -or $wire.executable -isnot [string] -or $wire.arguments -isnot [string] -or $wire.workingDirectory -isnot [string]) { throw 'invalid' }
        $spec = New-HiddenLaunchSpec -Executable $wire.executable -Arguments $wire.arguments -WorkingDirectory $wire.workingDirectory
        if (-not (Test-HiddenActionEqual $Action $spec)) { throw 'invalid' }
        return [pscustomobject]@{ Execute = $wire.executable; Arguments = $wire.arguments; WorkingDirectory = $wire.workingDirectory }
    } catch { throw 'TASK_HIDDEN_ACTION_INVALID' }
}
