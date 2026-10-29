[CmdletBinding()]
param([switch]$Apply, [switch]$Check)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:RecoveryRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))

function Get-RecoveryScriptToken {
    param([string]$CommandLine)
    $count = 0
    $memory = [ReadOnlyRecovery.Arguments]::CommandLineToArgvW($CommandLine, [ref]$count)
    if ($memory -eq [IntPtr]::Zero) { throw 'INSPECTION_FAILED' }
    $parts = @()
    try {
        for ($i = 0; $i -lt $count; $i++) {
            $parts += [Runtime.InteropServices.Marshal]::PtrToStringUni([Runtime.InteropServices.Marshal]::ReadIntPtr($memory, ($i * [IntPtr]::Size)))
        }
    } finally { [void][ReadOnlyRecovery.Arguments]::LocalFree($memory) }
    for ($i = 1; $i -lt $parts.Count; $i++) {
        if ($parts[$i] -cin @('-E', '-B', '-u', '-s', '-S', '-I')) { continue }
        if ($parts[$i].StartsWith('-')) { return $null }
        return $parts[$i]
    }
    return $null
}

function Get-ReadOnlyRecoveryAuxiliary {
    # Dot-sourcing the reviewed manager is inert; reuse its interpreter and task lookup.
    . (Join-Path $PSScriptRoot 'manage-dashboard-task.ps1')
    try {
        if (-not ('ReadOnlyRecovery.Arguments' -as [type])) {
            Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace ReadOnlyRecovery {
    public static class Arguments {
        [DllImport("shell32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern IntPtr CommandLineToArgvW(string commandLine, out int count);
        [DllImport("kernel32.dll")]
        public static extern IntPtr LocalFree(IntPtr memory);
    }
}
'@
        }
        $task = Get-DashboardFixedTask
        $schedule = @{ taskId = 'EVMAuditDashboard'; state = 'MISSING'; enabled = $null }
        if ($null -ne $task) {
            $state = ([string]$task.State).ToUpperInvariant()
            if ($state -notin @('READY', 'RUNNING', 'QUEUED', 'DISABLED')) { throw 'INSPECTION_FAILED' }
            $schedule = @{ taskId = 'EVMAuditDashboard'; state = $state; enabled = [bool]$task.Settings.Enabled }
        }
        $count = 0; $legacyStartup = $false
        $processes = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'python.exe' OR Name = 'pythonw.exe' OR Name = 'cmd.exe'" -ErrorAction Stop)
        foreach ($process in $processes) {
            if ([string]::IsNullOrWhiteSpace([string]$process.CommandLine)) { throw 'INSPECTION_FAILED' }
            if ($process.Name -ieq 'cmd.exe') {
                # Conservative defer only. Never expose, execute or persist command lines.
                if ([string]$process.CommandLine -match '(?i)(?:^|[\\/\s"])(?:monitor-set-autostart\.cmd)(?:$|[\s"])') { $legacyStartup = $true }
                continue
            }
            $token = Get-RecoveryScriptToken ([string]$process.CommandLine)
            if ($token) {
                $candidate = $token.Replace('/', '\')
                if ([StringComparer]::OrdinalIgnoreCase.Equals($candidate, (Join-Path $PSScriptRoot 'run-dashboard-task.py')) -or $candidate -iin @('tools\run-dashboard-task.py', '.\tools\run-dashboard-task.py')) { $count += 1 }
            }
        }
        $occupied = $false
        $probe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 5050)
        try { $probe.Server.ExclusiveAddressUse = $true; $probe.Start() }
        catch {
            $cause = $_.Exception
            while ($null -ne $cause.InnerException) { $cause = $cause.InnerException }
            if ($cause -is [Net.Sockets.SocketException] -and $cause.SocketErrorCode -eq [Net.Sockets.SocketError]::AddressAlreadyInUse) { $occupied = $true }
            else { throw 'INSPECTION_FAILED' }
        } finally { $probe.Stop() }
        $python = $null
        if ($count -eq 0 -and -not $occupied -and $schedule.state -notin @('DISABLED', 'RUNNING', 'QUEUED') -and $schedule.enabled -ne $false) {
            try { $python = Get-DashboardPythonPath } catch { $python = $null }
        }
        return [pscustomobject]@{ ok = $true; dashboard = @{ count = $count; occupied = $occupied; python = $python }; schedule = $schedule; legacyStartup = $legacyStartup }
    } catch { return [pscustomobject]@{ ok = $false } }
}

function New-ReadOnlyRecoveryStartInfo {
    param([string]$Node, [switch]$Apply)
    if (-not [IO.Path]::IsPathRooted($Node) -or $Node -notmatch '^[A-Za-z]:\\' -or $script:RecoveryRoot -match '["\r\n]') { throw 'RECOVERY_PATH_REFUSED' }
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $Node
    $mode = if ($Apply) { '--apply' } else { '--check' }
    $start.Arguments = '"{0}" {1}' -f (Join-Path $PSScriptRoot 'readonly-recovery.js'), $mode
    $start.WorkingDirectory = $script:RecoveryRoot
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($name in @($start.EnvironmentVariables.Keys)) {
        if ($name -notin @('SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'PATH', 'TEMP', 'TMP')) { $start.EnvironmentVariables.Remove($name) }
    }
    # Explicit as well as allowlist removal: Node must never see startup injection.
    $start.EnvironmentVariables.Remove('NODE_OPTIONS')
    $start.EnvironmentVariables.Remove('NODE_PATH')
    return $start
}

function Invoke-ReadOnlyRecovery {
    param([switch]$Apply, [switch]$Check)
    $mutex = $null; $owned = $false; $child = $null
    try {
        if ($Apply -and $Check) { throw 'RECOVERY_ARGUMENTS_REFUSED' }
        $node = [IO.Path]::GetFullPath([string](@(Get-Command 'node.exe' -CommandType Application -ErrorAction Stop)[0].Source))
        if (-not [IO.File]::Exists($node) -or -not [IO.File]::Exists((Join-Path $PSScriptRoot 'readonly-recovery.js'))) { throw 'RECOVERY_PATH_REFUSED' }
        $hash = [Security.Cryptography.SHA256]::Create()
        try { $suffix = [BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($script:RecoveryRoot.ToLowerInvariant()))).Replace('-', '').Substring(0, 16) }
        finally { $hash.Dispose() }
        $mutex = [Threading.Mutex]::new($false, ('Local\EVMAuditReadOnlyRecovery-' + $suffix))
        try { $owned = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $owned = $true }
        if (-not $owned) { [Console]::Out.WriteLine('readonly-recovery: RECOVERY_ALREADY_RUNNING'); return 1 }
        $child = [Diagnostics.Process]::Start((New-ReadOnlyRecoveryStartInfo -Node $node -Apply:$Apply))
        # Only the fixed JS summary can be displayed. Native diagnostics stay private.
        $stdout = $child.StandardOutput.ReadToEnd()
        [void]$child.StandardError.ReadToEnd()
        $child.WaitForExit()
        $code = $child.ExitCode
        $line = $stdout.Trim()
        if ($line -cmatch '^readonly-recovery (?:apply|check): [A-Z_]+; present=\d{1,2}/12; launched=\d{1,2}; dashboard=[A-Z_]+; monitor-readiness=(?:[A-Z_]+|healthy|observational|fail-closed); live=EXCLUDED_HELD$') { [Console]::Out.WriteLine($line) }
        else { [Console]::Out.WriteLine('readonly-recovery: RECOVERY_FAILED'); $code = 1 }
        return $code
    } catch { [Console]::Out.WriteLine('readonly-recovery: RECOVERY_REFUSED'); return 1 }
    finally {
        if ($null -ne $child) { $child.Dispose() }
        if ($owned) { $mutex.ReleaseMutex() }
        if ($null -ne $mutex) { $mutex.Dispose() }
    }
}

if ($MyInvocation.InvocationName -ne '.') { exit (Invoke-ReadOnlyRecovery -Apply:$Apply -Check:$Check) }
