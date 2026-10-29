$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$ProductionBase = "C:\Users\MiPC\AppData\Local"
$ProductionDirectory = "C:\Users\MiPC\AppData\Local\EVM_AUDIT\approvers"
$ProductionFile = "C:\Users\MiPC\AppData\Local\EVM_AUDIT\approvers\windows-local-approver-20260912-01.pk8.dpapi"
$TestBase = "C:\Users\MiPC\AppData\Local\Temp\opencode"

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class ApproverAclNative {
  [StructLayout(LayoutKind.Sequential)] public struct FILETIME { public uint Low; public uint High; }
  [StructLayout(LayoutKind.Sequential)] public struct FILE_INFO {
    public uint Attributes; public FILETIME CreationTime; public FILETIME LastAccessTime; public FILETIME LastWriteTime;
    public uint VolumeSerialNumber; public uint FileSizeHigh; public uint FileSizeLow; public uint NumberOfLinks;
    public uint FileIndexHigh; public uint FileIndexLow;
  }
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FILE_INFO info);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, System.Text.StringBuilder path, int size, uint flags);
}
"@

function Fail([string]$Code) { throw $Code }
function Same-Path([string]$A, [string]$B) { return [String]::Equals([IO.Path]::GetFullPath($A).TrimEnd('\'), [IO.Path]::GetFullPath($B).TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase) }
function Is-Descendant([string]$Path, [string]$Base) {
  $full = [IO.Path]::GetFullPath($Path); $root = [IO.Path]::GetFullPath($Base).TrimEnd('\') + '\'
  return $full.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -and -not (Same-Path $full $Base)
}
function New-ExactAcl([bool]$Directory) {
  $user = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $system = [Security.Principal.SecurityIdentifier]::new("S-1-5-18")
  $full = [Security.AccessControl.FileSystemRights]::FullControl
  $allow = [Security.AccessControl.AccessControlType]::Allow
  if ($Directory) {
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $inherit = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
    foreach ($sid in @($user, $system)) { [void]$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, $full, $inherit, [Security.AccessControl.PropagationFlags]::None, $allow)) }
  } else {
    $acl = [Security.AccessControl.FileSecurity]::new()
    foreach ($sid in @($user, $system)) { [void]$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, $full, $allow)) }
  }
  $acl.SetOwner($user); $acl.SetAccessRuleProtection($true, $false)
  return $acl
}
function Test-ExactAcl([string]$Path, [bool]$Directory) {
  $user = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $acl = Get-Acl -LiteralPath $Path
  try { $owner = ([Security.Principal.NTAccount]::new($acl.Owner)).Translate([Security.Principal.SecurityIdentifier]).Value } catch { return $false }
  $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  if ($owner -ne $user -or -not $acl.AreAccessRulesProtected -or $rules.Count -ne 2) { return $false }
  $wanted = if ($Directory) { [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit } else { [Security.AccessControl.InheritanceFlags]::None }
  foreach ($sid in @($user, "S-1-5-18")) {
    $match = @($rules | Where-Object { $_.IdentityReference.Value -eq $sid })
    if ($match.Count -ne 1 -or $match[0].IsInherited -or $match[0].AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $match[0].FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or $match[0].InheritanceFlags -ne $wanted -or $match[0].PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) { return $false }
  }
  return $true
}
function Assert-FixedLocalPath([string]$Path) {
  $full = [IO.Path]::GetFullPath($Path)
  if (-not [IO.Path]::IsPathRooted($full) -or [IO.Path]::GetPathRoot($full) -ne "C:\") { Fail "PATH_INVALID" }
  $drive = [IO.DriveInfo]::new("C")
  if (-not $drive.IsReady -or $drive.DriveType -ne [IO.DriveType]::Fixed) { Fail "DRIVE_INVALID" }
}
function Assert-NoReparseExisting([string]$Base, [string]$Path) {
  Assert-FixedLocalPath $Path
  if (-not (Test-Path -LiteralPath $Base -PathType Container)) { Fail "BASE_INVALID" }
  $cursor = [IO.Path]::GetFullPath($Base)
  if (((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Fail "REPARSE_POINT" }
  $relative = [IO.Path]::GetFullPath($Path).Substring($cursor.TrimEnd('\').Length).TrimStart('\')
  foreach ($part in $relative.Split(@('\'), [StringSplitOptions]::RemoveEmptyEntries)) {
    $cursor = Join-Path $cursor $part
    if (Test-Path -LiteralPath $cursor) {
      if (((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Fail "REPARSE_POINT" }
    } else { break }
  }
}
function Ensure-ExactDirectories([string]$Base, [string]$Directory) {
  $cursor = [IO.Path]::GetFullPath($Base)
  $relative = [IO.Path]::GetFullPath($Directory).Substring($cursor.TrimEnd('\').Length).TrimStart('\')
  foreach ($part in $relative.Split(@('\'), [StringSplitOptions]::RemoveEmptyEntries)) {
    $cursor = Join-Path $cursor $part
    if (Test-Path -LiteralPath $cursor) {
      $item = Get-Item -LiteralPath $cursor -Force
      if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or -not (Test-ExactAcl $cursor $true)) { Fail "DIRECTORY_ACL_INVALID" }
    } else {
      [void][IO.Directory]::CreateDirectory($cursor, (New-ExactAcl $true))
      if (-not (Test-ExactAcl $cursor $true)) { Fail "DIRECTORY_ACL_INVALID" }
    }
  }
}
function Get-HandleFacts([IO.FileStream]$Stream) {
  $info = New-Object ApproverAclNative+FILE_INFO
  if (-not [ApproverAclNative]::GetFileInformationByHandle($Stream.SafeFileHandle, [ref]$info)) { Fail "FILE_IDENTITY_INVALID" }
  $builder = [Text.StringBuilder]::new(32768)
  $count = [ApproverAclNative]::GetFinalPathNameByHandle($Stream.SafeFileHandle, $builder, $builder.Capacity, 0)
  if ($count -eq 0 -or $count -ge $builder.Capacity) { Fail "FILE_IDENTITY_INVALID" }
  $final = $builder.ToString(); if ($final.StartsWith("\\?\")) { $final = $final.Substring(4) }
  return [pscustomobject]@{ Path = $final; Links = [uint32]$info.NumberOfLinks; Length = $Stream.Length }
}
function Assert-ExactFile([string]$Path, [long]$ExpectedLength) {
  if ($ExpectedLength -lt 0 -or $ExpectedLength -gt 17825792) { Fail "LENGTH_INVALID" }
  $item = Get-Item -LiteralPath $Path -Force
  if ($item.PSIsContainer -or ($item.Attributes -band ([IO.FileAttributes]::Device -bor [IO.FileAttributes]::ReparsePoint)) -ne 0 -or -not (Test-ExactAcl $Path $false)) { Fail "FILE_ACL_INVALID" }
  $stream = [IO.FileStream]::new($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try {
    $facts = Get-HandleFacts $stream
    if (-not (Same-Path $facts.Path $Path) -or $facts.Links -ne 1 -or $facts.Length -ne $ExpectedLength) { Fail "FILE_IDENTITY_INVALID" }
  } finally { $stream.Dispose() }
}
function Create-Empty([string]$Base, [string]$Path) {
  if (Test-Path -LiteralPath $Path) { Fail "DESTINATION_EXISTS" }
  Ensure-ExactDirectories $Base ([IO.Path]::GetDirectoryName($Path))
  $stream = [IO.FileStream]::new($Path, [IO.FileMode]::CreateNew, [Security.AccessControl.FileSystemRights]::FullControl, [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough, (New-ExactAcl $false))
  try { $stream.Flush($true) } finally { $stream.Dispose() }
  Assert-ExactFile $Path 0
}
function Commit-Ciphertext([string]$Path, [byte[]]$Ciphertext, [long]$ExpectedLength) {
  if ($null -eq $Ciphertext -or $Ciphertext.Length -eq 0 -or $Ciphertext.Length -ne $ExpectedLength) { Fail "CIPHERTEXT_INVALID" }
  Assert-ExactFile $Path 0
  $stream = [IO.FileStream]::new($Path, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough)
  try {
    $facts = Get-HandleFacts $stream
    if (-not (Same-Path $facts.Path $Path) -or $facts.Links -ne 1 -or $facts.Length -ne 0 -or -not (Test-ExactAcl $Path $false)) { Fail "FILE_IDENTITY_INVALID" }
    $stream.Write($Ciphertext, 0, $Ciphertext.Length); $stream.Flush($true)
  } finally { $stream.Dispose(); if ($null -ne $Ciphertext) { [Array]::Clear($Ciphertext, 0, $Ciphertext.Length) } }
  Assert-ExactFile $Path $ExpectedLength
}
function Assert-Keys($Object, [string[]]$Expected) {
  $actual = @($Object.PSObject.Properties.Name | Sort-Object); $wanted = @($Expected | Sort-Object)
  if (($actual -join '|') -ne ($wanted -join '|')) { Fail "REQUEST_INVALID" }
}

$response = $null
try {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { Fail "PLATFORM_INVALID" }
  if ($args.Count -ne 0) { Fail "REQUEST_INVALID" }
  $raw = [Console]::In.ReadToEnd()
  if ([Text.Encoding]::UTF8.GetByteCount($raw) -gt 25165824) { Fail "REQUEST_INVALID" }
  try { $request = $raw | ConvertFrom-Json } catch { Fail "REQUEST_INVALID" }
  if ($null -eq $request -or $request -is [Array]) { Fail "REQUEST_INVALID" }
  $operation = [string]$request.operation
  $isTest = $operation.StartsWith("TEST_", [StringComparison]::Ordinal)
  if ($isTest) {
    if ($operation -eq "TEST_PREFLIGHT") { Assert-Keys $request @("operation", "path"); $path = [IO.Path]::GetFullPath([string]$request.path) }
    else {
      $expectedKeys = @("operation", "path", "expectedLength")
      if ($operation -eq "TEST_COMMIT_CIPHERTEXT") { $expectedKeys += "ciphertextBase64" }
      Assert-Keys $request $expectedKeys
      $path = [IO.Path]::GetFullPath([string]$request.path)
    }
    if (-not (Is-Descendant $path $TestBase)) { Fail "TEST_PATH_FORBIDDEN" }
    Assert-NoReparseExisting $TestBase $path
    $base = Split-Path -Parent (Split-Path -Parent $path)
    if (-not (Is-Descendant $base $TestBase)) { Fail "TEST_PATH_FORBIDDEN" }
  } else {
    if (-not [String]::Equals($env:LOCALAPPDATA, $ProductionBase, [StringComparison]::OrdinalIgnoreCase)) { Fail "LOCAL_APP_DATA_INVALID" }
    $path = $ProductionFile; $base = $ProductionBase
    if (-not (Same-Path ([IO.Path]::GetDirectoryName($path)) $ProductionDirectory)) { Fail "PATH_INVALID" }
  }
  Assert-NoReparseExisting $base $path
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  if ($sid -notmatch '^S-1-5-21-(?:[0-9]+-){3}[0-9]+$') { Fail "SID_INVALID" }
  switch ($operation) {
    "PREFLIGHT" { Assert-Keys $request @("operation"); if (-not (Same-Path $path $ProductionFile)) { Fail "PATH_INVALID" }; $response = [ordered]@{ ok = $true; status = "PREFLIGHT_OK"; sid = $sid } }
    "CREATE_EMPTY" { Assert-Keys $request @("operation", "expectedLength"); if ([long]$request.expectedLength -ne 0) { Fail "LENGTH_INVALID" }; Create-Empty $base $path; $response = [ordered]@{ ok = $true; status = "EMPTY_FILE_READY"; sid = $sid; length = 0 } }
    "VERIFY" { Assert-Keys $request @("operation", "expectedLength"); Assert-ExactFile $path ([long]$request.expectedLength); $response = [ordered]@{ ok = $true; status = "FILE_VERIFIED"; sid = $sid; length = [long]$request.expectedLength } }
    "COMMIT_CIPHERTEXT" { Assert-Keys $request @("operation", "expectedLength", "ciphertextBase64"); $cipher = [Convert]::FromBase64String([string]$request.ciphertextBase64); Commit-Ciphertext $path $cipher ([long]$request.expectedLength); $response = [ordered]@{ ok = $true; status = "CUSTODY_COMMITTED"; sid = $sid; length = [long]$request.expectedLength } }
    "TEST_PREFLIGHT" { $response = [ordered]@{ ok = $true; status = "PREFLIGHT_OK"; sid = $sid } }
    "TEST_CREATE_EMPTY" { if ([long]$request.expectedLength -ne 0) { Fail "LENGTH_INVALID" }; Create-Empty $base $path; $response = [ordered]@{ ok = $true; status = "EMPTY_FILE_READY"; sid = $sid; length = 0 } }
    "TEST_VERIFY" { Assert-ExactFile $path ([long]$request.expectedLength); $response = [ordered]@{ ok = $true; status = "FILE_VERIFIED"; sid = $sid; length = [long]$request.expectedLength } }
    "TEST_COMMIT_CIPHERTEXT" { $cipher = [Convert]::FromBase64String([string]$request.ciphertextBase64); Commit-Ciphertext $path $cipher ([long]$request.expectedLength); $response = [ordered]@{ ok = $true; status = "CUSTODY_COMMITTED"; sid = $sid; length = [long]$request.expectedLength } }
    default { Fail "OPERATION_INVALID" }
  }
  [Console]::Out.WriteLine(($response | ConvertTo-Json -Compress)); exit 0
} catch {
  $allowed = @("PLATFORM_INVALID", "REQUEST_INVALID", "OPERATION_INVALID", "LOCAL_APP_DATA_INVALID", "PATH_INVALID", "TEST_PATH_FORBIDDEN", "DRIVE_INVALID", "BASE_INVALID", "REPARSE_POINT", "SID_INVALID", "DIRECTORY_ACL_INVALID", "DESTINATION_EXISTS", "LENGTH_INVALID", "CIPHERTEXT_INVALID", "FILE_ACL_INVALID", "FILE_IDENTITY_INVALID")
  $code = if ($allowed -contains $_.Exception.Message) { $_.Exception.Message } else { "ACL_HELPER_FAILED" }
  [Console]::Out.WriteLine((([ordered]@{ ok = $false; status = "DENIED"; code = $code }) | ConvertTo-Json -Compress)); exit 1
}
