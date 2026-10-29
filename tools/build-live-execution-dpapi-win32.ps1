$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$SourceRoot = Join-Path $PSScriptRoot "native\live-execution-dpapi-win32"
$OutputRoot = Join-Path $Root ".runtime\live-execution-approver-custody-win32"
$OutputAddon = Join-Path $OutputRoot "dpapi-current-user.node"
$OutputManifest = Join-Path $OutputRoot "build-manifest.json"
$TempRoot = "C:\Users\MiPC\AppData\Local\Temp\opencode"
$NodeVersion = "v24.13.0"
$NodeHeaders = "C:\Users\MiPC\AppData\Local\node-gyp\Cache\24.13.0"
$NodeLib = Join-Path $NodeHeaders "x64\node.lib"
$NodeExe = "C:\Program Files\nodejs\node.exe"
$NodeGyp = "C:\Program Files\nodejs\node_modules\npm\node_modules\node-gyp\bin\node-gyp.js"
$VsWhere = "C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe"

function Get-Sha256([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}
function Get-BytesSha256([byte[]]$Bytes) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return -join ($sha.ComputeHash($Bytes) | ForEach-Object { $_.ToString("x2") }) } finally { $sha.Dispose() }
}
function Get-FramedHash($Rows) {
  $text = (($Rows | ForEach-Object { "{0}`0{1}`n" -f $_.name, $_.sha256 }) -join "")
  return Get-BytesSha256 ([Text.Encoding]::UTF8.GetBytes($text))
}
function Test-BytesEqual([byte[]]$Left, [byte[]]$Right) {
  if ($Left.Length -ne $Right.Length) { return $false }
  for ($index = 0; $index -lt $Left.Length; $index++) { if ($Left[$index] -ne $Right[$index]) { return $false } }
  return $true
}
function Write-NewBytes([string]$Path, [byte[]]$Bytes) {
  $stream = [IO.FileStream]::new($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $stream.Write($Bytes, 0, $Bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
}

# Validate every fixed prerequisite before creating build or publication output.
if (-not [String]::Equals([Environment]::OSVersion.Platform.ToString(), "Win32NT", [StringComparison]::Ordinal)) { throw "BUILD_PLATFORM_INVALID" }
foreach ($required in @($TempRoot, $NodeExe, $NodeGyp, $VsWhere, (Join-Path $NodeHeaders "include\node\node_api.h"), (Join-Path $NodeHeaders "x64\node.lib"), (Join-Path $SourceRoot "dpapi_current_user.c"), (Join-Path $SourceRoot "binding.gyp"))) {
  if (-not (Test-Path -LiteralPath $required)) { throw "BUILD_PREREQUISITE_MISSING" }
}
$nodeFacts = & $NodeExe -e 'process.stdout.write(JSON.stringify({version:process.version,arch:process.arch,napi:process.versions.napi}))'
if ($LASTEXITCODE -ne 0) { throw "BUILD_NODE_INVALID" }
$node = $nodeFacts | ConvertFrom-Json
if ($node.version -ne $NodeVersion -or $node.arch -ne "x64" -or $node.napi -ne "10") { throw "BUILD_NODE_INVALID" }
$pythonExe = (& py -3.11 -c "import sys; print(sys.executable)" 2>$null).Trim()
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $pythonExe)) { throw "BUILD_PYTHON_INVALID" }
$pythonVersion = (& $pythonExe -c "import sys; print('.'.join(map(str, sys.version_info[:3])))" 2>$null).Trim()
if ($LASTEXITCODE -ne 0 -or -not $pythonVersion.StartsWith("3.11.")) { throw "BUILD_PYTHON_INVALID" }
$vsInstall = (& $VsWhere -latest -products * -version "[17.0,18.0)" -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null).Trim()
$vsVersion = (& $VsWhere -latest -products * -version "[17.0,18.0)" -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationVersion 2>$null).Trim()
$msbuild = Join-Path $vsInstall "MSBuild\Current\Bin\MSBuild.exe"
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $msbuild) -or -not $vsVersion.StartsWith("17.")) { throw "BUILD_VISUAL_STUDIO_INVALID" }

$sourceRows = @(
  [ordered]@{ name = "tools/native/live-execution-dpapi-win32/binding.gyp"; sha256 = Get-Sha256 (Join-Path $SourceRoot "binding.gyp") },
  [ordered]@{ name = "tools/native/live-execution-dpapi-win32/dpapi_current_user.c"; sha256 = Get-Sha256 (Join-Path $SourceRoot "dpapi_current_user.c") }
)
$sourceSha = Get-FramedHash $sourceRows
$buildRows = @(
  [ordered]@{ name = "node.exe"; sha256 = Get-Sha256 $NodeExe },
  [ordered]@{ name = "node-gyp.js"; sha256 = Get-Sha256 $NodeGyp },
  [ordered]@{ name = "python.exe"; sha256 = Get-Sha256 $pythonExe },
  [ordered]@{ name = "MSBuild.exe"; sha256 = Get-Sha256 $msbuild },
  [ordered]@{ name = "tools/build-live-execution-dpapi-win32.ps1"; sha256 = Get-Sha256 $PSCommandPath }
)
$buildSha = Get-FramedHash $buildRows

$buildRoots = @()
try {
  foreach ($ordinal in 1..2) {
    $buildRoot = Join-Path $TempRoot ("live-execution-dpapi-build-{0}-{1}" -f ([Guid]::NewGuid().ToString("N")), $ordinal)
    [void][IO.Directory]::CreateDirectory($buildRoot)
    $buildRoots += $buildRoot
    [IO.File]::Copy((Join-Path $SourceRoot "binding.gyp"), (Join-Path $buildRoot "binding.gyp"), $false)
    [IO.File]::Copy((Join-Path $SourceRoot "dpapi_current_user.c"), (Join-Path $buildRoot "dpapi_current_user.c"), $false)
    $oldPython = $env:PYTHON; $oldNodedir = $env:npm_config_nodedir; $oldArch = $env:npm_config_arch; $oldVs = $env:GYP_MSVS_VERSION
    try {
      $env:PYTHON = $pythonExe; $env:npm_config_nodedir = $NodeHeaders; $env:npm_config_arch = "x64"; $env:GYP_MSVS_VERSION = "2022"
      & $NodeExe $NodeGyp configure build --release --arch=x64 --nodedir=$NodeHeaders --node_lib_file=$NodeLib --msvs_version=2022 --directory=$buildRoot
      if ($LASTEXITCODE -ne 0) { throw "BUILD_NATIVE_FAILED" }
    } finally {
      $env:PYTHON = $oldPython; $env:npm_config_nodedir = $oldNodedir; $env:npm_config_arch = $oldArch; $env:GYP_MSVS_VERSION = $oldVs
    }
  }
  $built = @($buildRoots | ForEach-Object { Join-Path $_ "build\Release\dpapi_current_user.node" })
  if ($built.Where({ -not (Test-Path -LiteralPath $_) }).Count -ne 0) { throw "BUILD_ARTIFACT_MISSING" }
  $artifactSha = Get-Sha256 $built[0]
  if ((Get-Sha256 $built[1]) -ne $artifactSha) { throw "BUILD_NOT_REPRODUCIBLE" }
  $artifactBytes = [IO.File]::ReadAllBytes($built[0])
  $manifest = [ordered]@{
    schema = "live-execution-dpapi-win32-build/v1"
    node = [ordered]@{ version = $NodeVersion; napi = 10; arch = "x64" }
    sourceSha256 = $sourceSha
    buildSha256 = $buildSha
    sources = $sourceRows
    toolchain = [ordered]@{ nodeGyp = "bundled-npm"; python = $pythonVersion; visualStudio = $vsVersion; configuration = "Release"; reproducibleBuilds = 2 }
    artifact = [ordered]@{ path = ".runtime/live-execution-approver-custody-win32/dpapi-current-user.node"; sha256 = $artifactSha; bytes = $artifactBytes.Length }
  }
  $manifestText = (($manifest | ConvertTo-Json -Depth 8) -replace "`r`n", "`n") + "`n"
  $manifestBytes = [Text.UTF8Encoding]::new($false).GetBytes($manifestText)

  if (Test-Path -LiteralPath $OutputRoot) {
    $item = Get-Item -LiteralPath $OutputRoot -Force
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "BUILD_OUTPUT_CONFLICT" }
    $names = @([IO.Directory]::EnumerateFiles($OutputRoot) | ForEach-Object { [IO.Path]::GetFileName($_) } | Sort-Object)
    if (($names -join "|") -ne "build-manifest.json|dpapi-current-user.node" -or (Get-Sha256 $OutputAddon) -ne $artifactSha -or -not (Test-BytesEqual ([IO.File]::ReadAllBytes($OutputManifest)) $manifestBytes)) { throw "BUILD_OUTPUT_CONFLICT" }
  } else {
    $runtimeParent = Split-Path -Parent $OutputRoot
    if (-not (Test-Path -LiteralPath $runtimeParent)) { throw "BUILD_OUTPUT_PARENT_MISSING" }
    $stage = Join-Path $TempRoot ("live-execution-dpapi-publish-{0}" -f [Guid]::NewGuid().ToString("N"))
    [void][IO.Directory]::CreateDirectory($stage)
    try {
      Write-NewBytes (Join-Path $stage "dpapi-current-user.node") $artifactBytes
      Write-NewBytes (Join-Path $stage "build-manifest.json") $manifestBytes
      [IO.Directory]::Move($stage, $OutputRoot)
    } finally { if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force } }
  }
  [Console]::Out.WriteLine((ConvertTo-Json ([ordered]@{ ok = $true; status = "BUILD_VERIFIED"; artifactSha256 = $artifactSha; sourceSha256 = $sourceSha; buildSha256 = $buildSha }) -Compress))
} finally {
  foreach ($directory in $buildRoots) { if (Test-Path -LiteralPath $directory) { Remove-Item -LiteralPath $directory -Recurse -Force } }
}
