[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Payload)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
try {
    if ($Payload.Length -gt 28000 -or $Payload -notmatch '^[A-Za-z0-9+/]+={0,2}$') { throw 'invalid' }
    $wire = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload)) | ConvertFrom-Json
    $environmentProperty = $wire.PSObject.Properties['environmentNames']
    $expectedPropertyCount = if ($null -eq $environmentProperty) { 5 } else { 6 }
    if (@($wire.PSObject.Properties).Count -ne $expectedPropertyCount -or $wire.version -cne 1 -or $wire.wait -isnot [bool] -or $wire.executable -isnot [string] -or $wire.arguments -isnot [string] -or $wire.workingDirectory -isnot [string]) { throw 'invalid' }
    if (-not [IO.Path]::IsPathRooted($wire.executable) -or -not [IO.File]::Exists($wire.executable) -or ($wire.workingDirectory -cne '' -and (-not [IO.Path]::IsPathRooted($wire.workingDirectory) -or -not [IO.Directory]::Exists($wire.workingDirectory)))) { throw 'invalid' }
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = $wire.executable
    # Opaque original argument string: do not tokenize, expand, log or invoke a shell here.
    $start.Arguments = $wire.arguments
    $start.WorkingDirectory = $wire.workingDirectory
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    if ($null -ne $environmentProperty -and $null -ne $environmentProperty.Value) {
        # PowerShell itself adds PSModulePath. Preserve the dispatcher's minimal
        # name set, not those bridge-host additions; no environment values travel.
        if ($wire.environmentNames -isnot [array] -or @($wire.environmentNames | Where-Object { $_ -isnot [string] -or $_ -notmatch '^[A-Za-z_][A-Za-z0-9_]*$' }).Count -gt 0) { throw 'invalid' }
        foreach ($name in @($start.EnvironmentVariables.Keys)) {
            if ($name -notin $wire.environmentNames) { $start.EnvironmentVariables.Remove($name) }
        }
    }
    $child = [Diagnostics.Process]::Start($start)
    if ($wire.wait) { $child.WaitForExit(); $code = $child.ExitCode; $child.Dispose(); exit $code }
    $child.Dispose()
    # Async means process creation success, NOT producer readiness.
    exit 0
} catch { exit 1 }
