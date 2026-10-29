$ErrorActionPreference = "Stop"
Set-StrictMode -Version 3.0

$script:Production = [ordered]@{
  SelfPath = "C:\_Work\__EVM_AUDIT\.runtime\morpho-pt-post-expiry-r2-production\issue-morpho-pt-27aug2026-post-expiry-r2-production-permit-once.ps1"
  NoncePath = "C:\_Work\__EVM_AUDIT\.runtime\morpho-pt-post-expiry-r2-production\morpho-pt-27aug2026-post-expiry-r2-production-nonce.txt"
  PermitPath = "/home/mruserbox/.local/share/evm-audit/morpho-pt-post-expiry-r2/permits/morpho-pt-27aug2026-post-expiry-r2-production.json"
  WslPath = "C:\Windows\System32\wsl.exe"
  LinuxEnvPath = "/usr/bin/env"
  LinuxTestPath = "/usr/bin/test"
  LinuxTimeoutPath = "/usr/bin/timeout"
  LinuxNodePath = "/home/mruserbox/.local/share/evm-audit/morpho-pt-post-expiry-r2/runtime/bin/node"
  LinuxIssuerPath = "/home/mruserbox/.local/share/evm-audit/morpho-pt-post-expiry-r2/tools/issue-morpho-pt-27aug2026-post-expiry-r2-production-permit.js"
  PrecheckArguments = "--distribution Ubuntu-22.04 --user mruserbox --exec /usr/bin/test ! -e /home/mruserbox/.local/share/evm-audit/morpho-pt-post-expiry-r2/permits/morpho-pt-27aug2026-post-expiry-r2-production.json"
  PostcheckArguments = "--distribution Ubuntu-22.04 --user mruserbox --exec /usr/bin/test -e /home/mruserbox/.local/share/evm-audit/morpho-pt-post-expiry-r2/permits/morpho-pt-27aug2026-post-expiry-r2-production.json"
  IssuerArguments = "--distribution Ubuntu-22.04 --user mruserbox --exec /usr/bin/timeout --signal=TERM --kill-after=5s 25s /usr/bin/env -i LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC /home/mruserbox/.local/share/evm-audit/morpho-pt-post-expiry-r2/runtime/bin/node /home/mruserbox/.local/share/evm-audit/morpho-pt-post-expiry-r2/tools/issue-morpho-pt-27aug2026-post-expiry-r2-production-permit.js"
  PrecheckPresentExit = 1
  PostcheckPresentExit = 0
  PostcheckAbsentExit = 1
  PrecheckTimeoutMs = 15000
  PostcheckTimeoutMs = 15000
  IssuerTimeoutMs = 40000
  TerminationWaitMs = 10000
  MaxOutputBytes = 4096
}

if (-not ("R2PermitNative" -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class R2PermitNative {
  public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
  [StructLayout(LayoutKind.Sequential)] public struct FILETIME { public uint Low; public uint High; }
  [StructLayout(LayoutKind.Sequential)] public struct BY_HANDLE_FILE_INFORMATION {
    public uint Attributes; public FILETIME CreationTime; public FILETIME LastAccessTime; public FILETIME LastWriteTime;
    public uint VolumeSerialNumber; public uint FileSizeHigh; public uint FileSizeLow; public uint NumberOfLinks;
    public uint FileIndexHigh; public uint FileIndexLow;
  }
  [StructLayout(LayoutKind.Sequential)] public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;
    public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] public struct IO_COUNTERS {
    public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount;
    public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)] public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;
  }
  [StructLayout(LayoutKind.Sequential)] public struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION {
    public long TotalUserTime; public long TotalKernelTime; public long ThisPeriodTotalUserTime; public long ThisPeriodTotalKernelTime;
    public uint TotalPageFaultCount; public uint TotalProcesses; public uint ActiveProcesses; public uint TotalTerminatedProcesses;
  }
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetFileInformationByHandle(SafeFileHandle h, out BY_HANDLE_FILE_INFORMATION info);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern uint GetFinalPathNameByHandle(SafeFileHandle h, System.Text.StringBuilder p, uint n, uint flags);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint length);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool TerminateJobObject(IntPtr job, uint exitCode);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool QueryInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info, uint length, IntPtr returnedLength);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr handle);
}
"@
}

function New-ExactAcl([bool]$Directory) {
  $user = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $ids = @($user, [Security.Principal.SecurityIdentifier]::new("S-1-5-18"), [Security.Principal.SecurityIdentifier]::new("S-1-5-32-544"))
  $full = [Security.AccessControl.FileSystemRights]::FullControl
  $allow = [Security.AccessControl.AccessControlType]::Allow
  if ($Directory) {
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $inherit = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
    foreach ($sid in $ids) { [void]$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, $full, $inherit, [Security.AccessControl.PropagationFlags]::None, $allow)) }
  } else {
    $acl = [Security.AccessControl.FileSecurity]::new()
    foreach ($sid in $ids) { [void]$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, $full, $allow)) }
  }
  $acl.SetOwner($user)
  $acl.SetAccessRuleProtection($true, $false)
  return $acl
}

function Test-ExactAcl([string]$Path, [bool]$Directory) {
  $user = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $expected = @($user, "S-1-5-18", "S-1-5-32-544")
  $acl = Get-Acl -LiteralPath $Path
  $owner = ([Security.Principal.NTAccount]::new($acl.Owner)).Translate([Security.Principal.SecurityIdentifier]).Value
  $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  if ($owner -ne $user -or -not $acl.AreAccessRulesProtected -or $rules.Count -ne 3) { return $false }
  foreach ($sid in $expected) {
    $match = @($rules | Where-Object { $_.IdentityReference.Value -eq $sid })
    if ($match.Count -ne 1 -or $match[0].IsInherited -or $match[0].AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $match[0].FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl) { return $false }
    $wanted = if ($Directory) { [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit } else { [Security.AccessControl.InheritanceFlags]::None }
    if ($match[0].InheritanceFlags -ne $wanted) { return $false }
  }
  return $true
}

function Get-HandleMetadata([IO.FileStream]$Stream) {
  $info = New-Object R2PermitNative+BY_HANDLE_FILE_INFORMATION
  if (-not [R2PermitNative]::GetFileInformationByHandle($Stream.SafeFileHandle, [ref]$info)) { throw "HANDLE_METADATA" }
  $builder = [Text.StringBuilder]::new(32768)
  $count = [R2PermitNative]::GetFinalPathNameByHandle($Stream.SafeFileHandle, $builder, $builder.Capacity, 0)
  if ($count -eq 0 -or $count -ge $builder.Capacity) { throw "HANDLE_PATH" }
  $final = $builder.ToString()
  if ($final.StartsWith("\\?\")) { $final = $final.Substring(4) }
  return [pscustomobject]@{ Path = $final; Links = [uint32]$info.NumberOfLinks; Attributes = [uint32]$info.Attributes }
}

function Invoke-BoundedChild([string]$FileName, [string]$Arguments, [byte[]]$InputBytes, [int]$TimeoutMs, [int]$MaxOutputBytes, [int]$TerminationWaitMs, [string]$Fault = "") {
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $FileName
  $start.Arguments = $Arguments
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardInput = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.EnvironmentVariables.Clear()
  $start.EnvironmentVariables["SystemRoot"] = "C:\Windows"
  $start.EnvironmentVariables["WINDIR"] = "C:\Windows"
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $start
  $job = [IntPtr]::Zero
  $started = $false
  $assigned = $false
  $failureKind = "ERROR"
  try {
    $job = [R2PermitNative]::CreateJobObject([IntPtr]::Zero, $null)
    if ($job -eq [IntPtr]::Zero) { return [pscustomobject]@{ Kind = "START_ERROR"; ExitCode = $null; Started = $false; TerminationConfirmed = $true; NaturalExit = $false } }
    $limits = New-Object R2PermitNative+JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    $limits.BasicLimitInformation.LimitFlags = [R2PermitNative]::JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    $length = [Runtime.InteropServices.Marshal]::SizeOf([type][R2PermitNative+JOBOBJECT_EXTENDED_LIMIT_INFORMATION])
    if (-not [R2PermitNative]::SetInformationJobObject($job, 9, [ref]$limits, $length)) { return [pscustomobject]@{ Kind = "START_ERROR"; ExitCode = $null; Started = $false; TerminationConfirmed = $true; NaturalExit = $false } }
    if (-not $process.Start()) { return [pscustomobject]@{ Kind = "START_ERROR"; ExitCode = $null; Started = $false; TerminationConfirmed = $true; NaturalExit = $false } }
    $started = $true
    if (-not [R2PermitNative]::AssignProcessToJobObject($job, $process.Handle)) { $failureKind = "JOB_ASSIGN_ERROR"; throw "JOB_ASSIGN" }
    $assigned = $true
    if ($Fault -eq "POST_START") { $failureKind = "POST_START_ERROR"; throw "POST_START" }
    if ($Fault -eq "STDIN_WRITE") { $failureKind = "STDIN_WRITE_ERROR"; throw "STDIN_WRITE" }
    if ($null -ne $InputBytes -and $InputBytes.Length -gt 0) { $process.StandardInput.BaseStream.Write($InputBytes, 0, $InputBytes.Length); $process.StandardInput.BaseStream.Flush() }
    $process.StandardInput.Close()
    $outBuffer = New-Object byte[] 1024; $errBuffer = New-Object byte[] 1024
    $outTask = $process.StandardOutput.BaseStream.ReadAsync($outBuffer, 0, $outBuffer.Length)
    $errTask = $process.StandardError.BaseStream.ReadAsync($errBuffer, 0, $errBuffer.Length)
    if ($Fault -eq "READ") { $failureKind = "READ_ERROR"; throw "READ" }
    $outDone = $false; $errDone = $false; $seen = 0
    $watch = [Diagnostics.Stopwatch]::StartNew()
    while (-not ($process.HasExited -and $outDone -and $errDone)) {
      if ($watch.ElapsedMilliseconds -ge $TimeoutMs) { $failureKind = "TIMEOUT"; throw "TIMEOUT" }
      if (-not $outDone -and $outTask.IsCompleted) { $n = $outTask.GetAwaiter().GetResult(); if ($n -eq 0) { $outDone = $true } else { $seen += $n; $outTask = $process.StandardOutput.BaseStream.ReadAsync($outBuffer, 0, $outBuffer.Length) } }
      if (-not $errDone -and $errTask.IsCompleted) { $n = $errTask.GetAwaiter().GetResult(); if ($n -eq 0) { $errDone = $true } else { $seen += $n; $errTask = $process.StandardError.BaseStream.ReadAsync($errBuffer, 0, $errBuffer.Length) } }
      if ($seen -gt $MaxOutputBytes) { $failureKind = "OUTPUT_LIMIT"; throw "OUTPUT_LIMIT" }
      Start-Sleep -Milliseconds 2
    }
    $process.WaitForExit()
    return [pscustomobject]@{ Kind = "EXIT"; ExitCode = $process.ExitCode; Started = $true; TerminationConfirmed = $true; NaturalExit = $true }
  } catch {
    if (-not $started) { return [pscustomobject]@{ Kind = "START_ERROR"; ExitCode = $null; Started = $false; TerminationConfirmed = $true; NaturalExit = $false } }
    $confirmed = $false
    try {
      $terminated = $job -ne [IntPtr]::Zero -and [R2PermitNative]::TerminateJobObject($job, 125)
      $wait = [Diagnostics.Stopwatch]::StartNew()
      while ($terminated -and $wait.ElapsedMilliseconds -lt $TerminationWaitMs) {
        $accounting = New-Object R2PermitNative+JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
        $accountingLength = [Runtime.InteropServices.Marshal]::SizeOf([type][R2PermitNative+JOBOBJECT_BASIC_ACCOUNTING_INFORMATION])
        $queried = [R2PermitNative]::QueryInformationJobObject($job, 1, [ref]$accounting, $accountingLength, [IntPtr]::Zero)
        if ($queried -and $accounting.ActiveProcesses -eq 0 -and $process.HasExited) { $confirmed = $true; break }
        Start-Sleep -Milliseconds 5
      }
    } catch {}
    if ($job -ne [IntPtr]::Zero) { try { [void][R2PermitNative]::CloseHandle($job) } catch {}; $job = [IntPtr]::Zero }
    return [pscustomobject]@{ Kind = $failureKind; ExitCode = $null; Started = $true; TerminationConfirmed = [bool]$confirmed; NaturalExit = $false; JobAssigned = $assigned }
  } finally {
    if ($job -ne [IntPtr]::Zero) { try { [void][R2PermitNative]::CloseHandle($job) } catch {} }
    $process.Dispose()
  }
}

function Get-ReconciledPermitState([hashtable]$Config) {
  $post = Invoke-BoundedChild $Config.PostcheckExe $Config.PostcheckArguments ([byte[]]@()) $Config.PostcheckTimeoutMs $Config.MaxOutputBytes $Config.TerminationWaitMs
  if ($post.Kind -ne "EXIT" -or -not $post.TerminationConfirmed) { return "UNKNOWN" }
  if ($post.ExitCode -eq $Config.PostcheckPresentExit) { return "PRESENT" }
  if ($post.ExitCode -eq $Config.PostcheckAbsentExit) { return "ABSENT" }
  return "UNKNOWN"
}

function New-Result([int]$ExitCode, [string]$Code, [string]$State) {
  return [pscustomobject]@{ ExitCode = $ExitCode; Code = $Code; PermitState = $State }
}

function Invoke-R2PermitConductor([hashtable]$Config) {
  if ($Config.SelfCheck) {
    if ($args.Count -ne 0 -or -not [String]::Equals([IO.Path]::GetFullPath($PSCommandPath), $Config.SelfPath, [StringComparison]::OrdinalIgnoreCase)) { return New-Result 10 "R2_CONDUCTOR_AUTHORITY" "UNKNOWN" }
    $self = Get-Item -LiteralPath $Config.SelfPath -Force
    if (($self.Attributes -band [IO.FileAttributes]::Directory) -ne 0 -or ($self.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or -not (Test-ExactAcl $Config.SelfPath $false)) { return New-Result 10 "R2_CONDUCTOR_AUTHORITY" "UNKNOWN" }
    $selfStream = [IO.FileStream]::new($Config.SelfPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
      $selfMeta = Get-HandleMetadata $selfStream
      if ($selfMeta.Links -ne 1 -or -not [String]::Equals([IO.Path]::GetFullPath($selfMeta.Path), [IO.Path]::GetFullPath($Config.SelfPath), [StringComparison]::OrdinalIgnoreCase)) { return New-Result 10 "R2_CONDUCTOR_AUTHORITY" "UNKNOWN" }
    } finally { $selfStream.Dispose() }
  }
  $parent = [IO.Path]::GetDirectoryName($Config.NoncePath)
  if (-not (Test-Path -LiteralPath $parent -PathType Container) -or -not (Test-ExactAcl $parent $true)) { return New-Result 11 "R2_NONCE_PARENT_AUTHORITY" "UNKNOWN" }
  $pre = Invoke-BoundedChild $Config.PrecheckExe $Config.PrecheckArguments ([byte[]]@()) $Config.PrecheckTimeoutMs $Config.MaxOutputBytes $Config.TerminationWaitMs
  if ($pre.Kind -ne "EXIT") { return New-Result 21 "R2_PERMIT_PRECHECK_INDETERMINATE" "UNKNOWN" }
  if ($pre.ExitCode -eq $Config.PrecheckPresentExit) { return New-Result 20 "R2_PERMIT_PREEXISTING" "PRESENT" }
  if ($pre.ExitCode -ne 0) { return New-Result 21 "R2_PERMIT_PRECHECK_INDETERMINATE" "UNKNOWN" }
  $stream = $null; $created = $false; $nonceBytes = $null; $random = $null; $issuerState = "NOT_STARTED"; $child = $null
  try {
    $stream = [IO.FileStream]::new($Config.NoncePath, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Read, 4096, [IO.FileOptions]::WriteThrough)
    $created = $true
    $random = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($random) } finally { $rng.Dispose() }
    $hex = -join ($random | ForEach-Object { $_.ToString("x2") })
    $nonceBytes = [Text.Encoding]::ASCII.GetBytes($hex + "`n")
    if ($nonceBytes.Length -ne 65) { throw "NONCE_FRAMING" }
    $stream.Write($nonceBytes, 0, $nonceBytes.Length); $stream.Flush($true)
    Set-Acl -LiteralPath $Config.NoncePath -AclObject (New-ExactAcl $false)
    $meta = Get-HandleMetadata $stream
    $attrs = [IO.File]::GetAttributes($Config.NoncePath)
    if (-not [String]::Equals([IO.Path]::GetFullPath($meta.Path), [IO.Path]::GetFullPath($Config.NoncePath), [StringComparison]::OrdinalIgnoreCase) -or $meta.Links -ne 1 -or ($attrs -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or -not (Test-ExactAcl $Config.NoncePath $false) -or $stream.Length -ne 65) { throw "NONCE_AUTHORITY" }
    $stream.Position = 0
    $fault = if ($Config.ContainsKey("IssuerFault")) { [string]$Config.IssuerFault } else { "" }
    $child = Invoke-BoundedChild $Config.IssuerExe $Config.IssuerArguments $nonceBytes $Config.IssuerTimeoutMs $Config.MaxOutputBytes $Config.TerminationWaitMs $fault
    if ($child.Started) { $issuerState = "STARTED" }
    $stream.Dispose(); $stream = $null
    if (-not $child.Started) {
      Remove-Item -LiteralPath $Config.NoncePath -Force -ErrorAction SilentlyContinue
      return New-Result 22 "R2_ISSUER_NOT_STARTED" "ABSENT"
    }
    if (-not $child.TerminationConfirmed) { return New-Result 27 "R2_TERMINATION_UNCONFIRMED" "UNKNOWN" }
    $reconciled = Get-ReconciledPermitState $Config
    if (-not $child.NaturalExit) {
      if ($child.Kind -eq "TIMEOUT") { return New-Result 124 "R2_ISSUER_TIMEOUT_UNPROVEN" "UNKNOWN" }
      if ($child.Kind -eq "OUTPUT_LIMIT") { return New-Result 125 "R2_ISSUER_OUTPUT_LIMIT_UNPROVEN" "UNKNOWN" }
      return New-Result 27 "R2_POST_START_FAILURE_UNPROVEN" "UNKNOWN"
    }
    if ($reconciled -eq "UNKNOWN") { return New-Result 26 "R2_POSTCHECK_UNKNOWN" "UNKNOWN" }
    if ($reconciled -eq "PRESENT") {
      if ($child.ExitCode -eq 0) { return New-Result 0 "R2_PERMIT_ISSUED" "PRESENT" }
      if ($child.ExitCode -eq 124) { return New-Result 124 "R2_INNER_TIMEOUT_PERMIT_PRESENT" "PRESENT" }
      return New-Result 23 "R2_ISSUER_FAILED_PERMIT_PRESENT" "PRESENT"
    }
    Remove-Item -LiteralPath $Config.NoncePath -Force -ErrorAction SilentlyContinue
    if ($child.ExitCode -eq 0) { return New-Result 24 "R2_ISSUER_SUCCESS_PERMIT_ABSENT" "ABSENT" }
    if ($child.ExitCode -eq 124) { return New-Result 124 "R2_INNER_TIMEOUT_PERMIT_ABSENT" "ABSENT" }
    return New-Result 23 "R2_ISSUER_FAILED_PERMIT_ABSENT" "ABSENT"
  } catch {
    if ($null -ne $stream) { $stream.Dispose(); $stream = $null }
    if ($issuerState -eq "STARTED") {
      $state = "UNKNOWN"
      if ($null -ne $child -and $child.TerminationConfirmed) { try { $state = Get-ReconciledPermitState $Config } catch { $state = "UNKNOWN" } }
      if ($null -ne $child -and $child.NaturalExit -and $state -eq "ABSENT") { Remove-Item -LiteralPath $Config.NoncePath -Force -ErrorAction SilentlyContinue }
      if ($null -eq $child -or -not $child.NaturalExit) { $state = "UNKNOWN" }
      return New-Result 27 "R2_POST_START_EXCEPTION" $state
    }
    if ($created) { Remove-Item -LiteralPath $Config.NoncePath -Force -ErrorAction SilentlyContinue }
    return New-Result 22 "R2_NONCE_OR_AUTHORITY_FAILED" "ABSENT"
  } finally {
    if ($null -ne $random) { [Array]::Clear($random, 0, $random.Length) }
    if ($null -ne $nonceBytes) { [Array]::Clear($nonceBytes, 0, $nonceBytes.Length) }
  }
}

function Get-ProductionConfig {
  return @{
    SelfCheck = $true; SelfPath = $script:Production.SelfPath; NoncePath = $script:Production.NoncePath
    PrecheckExe = $script:Production.WslPath; PrecheckArguments = $script:Production.PrecheckArguments
    PostcheckExe = $script:Production.WslPath; PostcheckArguments = $script:Production.PostcheckArguments
    IssuerExe = $script:Production.WslPath; IssuerArguments = $script:Production.IssuerArguments
    PrecheckPresentExit = $script:Production.PrecheckPresentExit; PrecheckTimeoutMs = $script:Production.PrecheckTimeoutMs
    PostcheckPresentExit = $script:Production.PostcheckPresentExit; PostcheckAbsentExit = $script:Production.PostcheckAbsentExit; PostcheckTimeoutMs = $script:Production.PostcheckTimeoutMs
    IssuerTimeoutMs = $script:Production.IssuerTimeoutMs; TerminationWaitMs = $script:Production.TerminationWaitMs; MaxOutputBytes = $script:Production.MaxOutputBytes
  }
}

if ($MyInvocation.InvocationName -ne ".") {
  if ($args.Count -ne 0) { Write-Output "R2_CONDUCTOR_AUTHORITY PERMIT_STATE_UNKNOWN"; exit 10 }
  $result = Invoke-R2PermitConductor (Get-ProductionConfig)
  Write-Output "$($result.Code) PERMIT_STATE_$($result.PermitState)"
  exit $result.ExitCode
}
