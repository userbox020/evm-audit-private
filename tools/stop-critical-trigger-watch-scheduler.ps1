[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$workspace = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$expectedTools = [System.IO.Path]::GetFullPath((Join-Path $workspace "tools"))
$schedulerScript = [System.IO.Path]::GetFullPath((Join-Path $expectedTools "run-critical-trigger-watch-scheduler.js"))
$lockPath = [System.IO.Path]::GetFullPath((Join-Path $workspace "reports\monitor\trigger-watch-scheduler.lock"))

if ($expectedTools -cne [System.IO.Path]::GetFullPath($PSScriptRoot) -or -not (Test-Path -LiteralPath $schedulerScript -PathType Leaf)) { throw "Workspace parent/path verification failed." }
if (-not (Test-Path -LiteralPath $lockPath -PathType Leaf)) { throw "Scheduler lock is absent." }

function Read-StrictLock([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.PSIsContainer -or $item.Length -lt 1 -or $item.Length -gt 512) { throw "Malformed scheduler lock." }
    $value = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
    $names = @($value.PSObject.Properties.Name | Sort-Object)
    if (($names -join ',') -cne 'nonce,pid,startedAt' -or [string]$value.nonce -cnotmatch '^[0-9a-f]{32}$') { throw "Malformed scheduler lock." }
    $parsedPid = [int64]0
    $parsedTime = [DateTimeOffset]::MinValue
    if (-not [int64]::TryParse([string]$value.pid, [ref]$parsedPid) -or $parsedPid -lt 1 `
        -or -not [DateTimeOffset]::TryParseExact([string]$value.startedAt, "yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$parsedTime)) { throw "Malformed scheduler lock." }
    return $value
}

if (-not ("NativeCommandLine" -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NativeCommandLine {
    [DllImport("shell32.dll", SetLastError=true)] static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string commandLine, out int argc);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);
    public static string[] Split(string commandLine) {
        int count;
        IntPtr pointer = CommandLineToArgvW(commandLine, out count);
        if (pointer == IntPtr.Zero || count < 1) throw new InvalidOperationException("Command line parse failed");
        try {
            string[] result = new string[count];
            for (int i = 0; i < count; i++) result[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(pointer, i * IntPtr.Size));
            return result;
        } finally { LocalFree(pointer); }
    }
}
'@
}

$owner = Read-StrictLock $lockPath
$pidToStop = [int64]$owner.pid
$process = Get-Process -Id $pidToStop -ErrorAction Stop
$cim = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $pidToStop) -ErrorAction Stop
if ($null -eq $cim -or [string]::IsNullOrWhiteSpace([string]$cim.CommandLine) -or [string]::IsNullOrWhiteSpace([string]$cim.ExecutablePath)) { throw "Scheduler command line is not safely available." }
$argv = [NativeCommandLine]::Split([string]$cim.CommandLine)
$actualExecutable = [System.IO.Path]::GetFullPath([string]$cim.ExecutablePath)
if ($argv.Count -ne 3 -or [System.IO.Path]::GetFullPath($argv[0]) -cne $actualExecutable `
    -or [System.IO.Path]::GetFullPath($argv[1]) -cne $schedulerScript -or $argv[2] -cne "--daemon") { throw "Scheduler process command line mismatch." }
if ([System.IO.Path]::GetFileName($actualExecutable) -ine "node.exe") { throw "Scheduler executable mismatch." }

Stop-Process -Id $pidToStop -ErrorAction Stop
$deadline = [DateTime]::UtcNow.AddSeconds(15)
while ([DateTime]::UtcNow -lt $deadline -and $null -ne (Get-Process -Id $pidToStop -ErrorAction SilentlyContinue)) { Start-Sleep -Milliseconds 100 }
if ($null -ne (Get-Process -Id $pidToStop -ErrorAction SilentlyContinue)) { throw "Scheduler did not stop within the bounded wait." }

if (Test-Path -LiteralPath $lockPath -PathType Leaf) {
    $remaining = Read-StrictLock $lockPath
    if ([int64]$remaining.pid -ne $pidToStop -or [string]$remaining.nonce -cne [string]$owner.nonce -or [string]$remaining.startedAt -cne [string]$owner.startedAt) { throw "Scheduler lock ownership changed; refusing cleanup." }
    Remove-Item -LiteralPath $lockPath -Force -ErrorAction Stop
}
if (Test-Path -LiteralPath $lockPath) { throw "Scheduler lock remains after stop." }
