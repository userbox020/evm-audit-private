[CmdletBinding()]
param([switch]$SourceOnly)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'hidden-launch-action.ps1')
$script:Passed = 0
function Assert-Case { param([bool]$Condition, [string]$Name) if (-not $Condition) { throw "FAILED: $Name" }; $script:Passed++ }
if ($SourceOnly) {
    foreach ($name in @('hidden-console-runner.ps1', 'hidden-launch-action.ps1', 'set-audit-tasks-silent.ps1')) {
        $tokens = $null; $errors = $null
        [void][Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot $name), [ref]$tokens, [ref]$errors)
        Assert-Case ($errors.Count -eq 0) 'source parses without executing any child'
    }
    $spec = New-HiddenLaunchSpec -Executable (Join-Path ([Environment]::SystemDirectory) 'cmd.exe') -Arguments '/d /c echo %V% && exit /b 37' -WorkingDirectory ''
    $decoded = Read-HiddenLaunchAction $spec
    Assert-Case ($decoded.WorkingDirectory -ceq '' -and $decoded.Arguments -ceq '/d /c echo %V% && exit /b 37') 'empty inherited cwd and opaque percent argument transport survive exact round trip'
    $action = ConvertTo-HiddenScheduledTaskAction $spec
    Assert-Case ([string]$action.WorkingDirectory -ceq '' -and (Test-HiddenActionEqual $action $spec)) 'real CIM action construction preserves empty working directory without task edits'
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.WorkingDirectory = $decoded.WorkingDirectory
    Assert-Case ($start.WorkingDirectory -ceq '') 'ProcessStartInfo retains empty inherited cwd without starting a child'
    $source = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'hidden-console-runner.ps1'))
    Assert-Case ($source.Contains('$wire.workingDirectory -cne ''''') -and $source.Contains('$start.WorkingDirectory = $wire.workingDirectory') -and $source.Contains('$start.UseShellExecute = $false') -and $source.Contains('$start.CreateNoWindow = $true')) 'runner passes empty cwd verbatim and retains console-free .NET flags'
    [Console]::Out.WriteLine((@{ ok = $true; passed = $script:Passed; failed = 0; sourceOnly = $true; childStarted = $false; taskChanged = $false } | ConvertTo-Json -Compress))
    return
}
$root = Join-Path (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Temp\opencode') ('hidden fixture ' + [char]0x03bb + ' ' + [guid]::NewGuid().ToString('N'))
$source = @'
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;
public class HiddenFixture {
  [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
  public static void Main(string[] args) {
    Thread.Sleep(1500);
    string[] rows = new string[args.Length + 2];
    rows[0] = Convert.ToBase64String(Encoding.UTF8.GetBytes(Environment.CurrentDirectory));
    rows[1] = GetConsoleWindow() == IntPtr.Zero ? "NO_CONSOLE" : "HAS_CONSOLE";
    for (int i=0;i<args.Length;i++) rows[i+2] = Convert.ToBase64String(Encoding.UTF8.GetBytes(args[i]));
    File.WriteAllLines("result.txt", rows);
    File.WriteAllText("minimal-env.txt", Environment.GetEnvironmentVariable("PSModulePath") == null && Environment.GetEnvironmentVariable("HIDDEN_FIXTURE_REMOVE") == null ? "MINIMAL" : "INHERITED");
    Environment.Exit(37);
  }
}
'@
function Invoke-FixtureSpec {
    param($Spec)
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $Spec.Execute; $start.Arguments = $Spec.Arguments; $start.WorkingDirectory = $Spec.WorkingDirectory
    $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $child = [Diagnostics.Process]::Start($start)
    if (-not $child.WaitForExit(15000)) { throw 'FIXTURE_TIMEOUT' }
    $code = $child.ExitCode; $child.Dispose(); $watch.Stop()
    return [pscustomobject]@{ code = $code; elapsed = $watch.ElapsedMilliseconds }
}
try {
    [void][IO.Directory]::CreateDirectory($root)
    $exe = Join-Path $root 'fixture child.exe'
    Add-Type -TypeDefinition $source -Language CSharp -OutputAssembly $exe -OutputType ConsoleApplication
    $unicode = 'unicode-' + [char]0x03bb + [char]0x4e2d
    $args = '"hello world" "' + $unicode + '" "say \"hi\"" "%HIDDEN_TEST_VALUE%" "%V" ">" "&&"'
    $spec = New-HiddenLaunchSpec -Executable $exe -Arguments $args -WorkingDirectory $root
    Assert-Case ($spec.Arguments -notmatch '%|hello world|&&') 'raw payload never enters WshShell command line'
    $result = Invoke-FixtureSpec $spec
    Assert-Case ($result.code -eq 37 -and $result.elapsed -ge 1500) 'synchronous wrapper waits and preserves distinctive nonzero exit'
    $rows = [IO.File]::ReadAllLines((Join-Path $root 'result.txt'))
    Assert-Case ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($rows[0])) -ceq $root) 'spaces and Unicode working directory preserved'
    Assert-Case ($rows[1] -ceq 'NO_CONSOLE') 'finite console-subsystem child has no console allocated'
    $actual = @($rows | Select-Object -Skip 2 | ForEach-Object { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($_)) })
    $expected = @('hello world', $unicode, 'say "hi"', '%HIDDEN_TEST_VALUE%', '%V', '>', '&&')
    Assert-Case (($actual -join '|') -ceq ($expected -join '|')) 'spaces Unicode quotes percent FOR and shell tokens remain exact child arguments'
    $fakeManager = Join-Path $root 'manager fixture.ps1'
    [IO.File]::WriteAllText($fakeManager, '& (Join-Path $PSScriptRoot ''fixture child.exe'') ''grandchild''; exit $LASTEXITCODE')
    $managerArgs = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $fakeManager + '"'
    $managerSpec = New-HiddenLaunchSpec -Executable (Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe') -Arguments $managerArgs -WorkingDirectory $root
    $result = Invoke-FixtureSpec $managerSpec
    $rows = [IO.File]::ReadAllLines((Join-Path $root 'result.txt'))
    Assert-Case ($result.code -eq 37 -and $rows[1] -ceq 'NO_CONSOLE') 'manager-shaped PowerShell native grandchild also remains console-free and propagates exit'
    Remove-Item -LiteralPath (Join-Path $root 'result.txt')
    $spec = New-HiddenLaunchSpec -Executable $exe -Arguments $args -WorkingDirectory $root -WaitForExit $false
    $result = Invoke-FixtureSpec $spec
    Assert-Case ($result.code -eq 0 -and -not [IO.File]::Exists((Join-Path $root 'result.txt'))) 'async returns launch success before finite child completion'
    $deadline = [datetime]::UtcNow.AddSeconds(10)
    while (-not [IO.File]::Exists((Join-Path $root 'result.txt')) -and [datetime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
    Assert-Case ([IO.File]::Exists((Join-Path $root 'result.txt'))) 'async child completes independently within finite deadline'
    $hadFixtureRemove = Test-Path Env:HIDDEN_FIXTURE_REMOVE; $oldFixtureRemove = $env:HIDDEN_FIXTURE_REMOVE
    $env:HIDDEN_FIXTURE_REMOVE = 'fixture-only'
    try {
        $wire = [ordered]@{ version = 1; executable = $exe; arguments = $args; workingDirectory = $root; wait = $true; environmentNames = @('SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'PATH', 'TEMP', 'TMP') }
        $paths = Get-HiddenLauncherPaths
        $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($wire | ConvertTo-Json -Compress)))
        $spec = [pscustomobject]@{ Execute = $paths.Execute; Arguments = ('//B //Nologo "{0}" {1}' -f $paths.Wrapper, $encoded); WorkingDirectory = $root }
        $result = Invoke-FixtureSpec $spec
        Assert-Case ($result.code -eq 37 -and [IO.File]::ReadAllText((Join-Path $root 'minimal-env.txt')) -ceq 'MINIMAL') 'bridge removes host-added module path and nonallowlisted environment names'
    } finally { if ($hadFixtureRemove) { $env:HIDDEN_FIXTURE_REMOVE = $oldFixtureRemove } else { Remove-Item Env:HIDDEN_FIXTURE_REMOVE -ErrorAction SilentlyContinue } }
    $had = Test-Path Env:HIDDEN_TEST_VALUE; $old = $env:HIDDEN_TEST_VALUE
    try {
        $env:HIDDEN_TEST_VALUE = 'once-only'
        $arg = '/d /s /c "(for %V in (ok) do @echo %V)> for.txt && echo %HIDDEN_TEST_VALUE%> env.txt && exit /b 43"'
        $spec = New-HiddenLaunchSpec -Executable (Join-Path ([Environment]::SystemDirectory) 'cmd.exe') -Arguments $arg -WorkingDirectory $root
        $result = Invoke-FixtureSpec $spec
        Assert-Case ($result.code -eq 43) 'cmd exit propagates through hidden bridge'
        Assert-Case ([IO.File]::ReadAllText((Join-Path $root 'for.txt')).Trim() -ceq 'ok' -and [IO.File]::ReadAllText((Join-Path $root 'env.txt')).Trim() -ceq 'once-only') 'FOR percent environment redirection and && execute exactly once in target cmd'
        # Harmless stand-in for the research-build shell suffix, including quoted
        # executable/script paths and a success-only marker; no producer runs.
        $node = [IO.Path]::GetFullPath((Get-Command node.exe -CommandType Application).Source)
        $fake = Join-Path $root 'research fixture.js'
        [IO.File]::WriteAllText($fake, 'console.log("fixture-output"); console.error("fixture-error"); process.exit(Number(process.argv[2]));')
        foreach ($code in @(0, 7)) {
            $marker = Join-Path $root 'research.done'
            Remove-Item -LiteralPath $marker -ErrorAction SilentlyContinue
            $arg = '/d /s /c ""' + $node + '" "' + $fake + '" "' + $code + '" > research.log 2>&1 && echo completed> research.done"'
            $spec = New-HiddenLaunchSpec -Executable (Join-Path ([Environment]::SystemDirectory) 'cmd.exe') -Arguments $arg -WorkingDirectory $root
            $result = Invoke-FixtureSpec $spec
            Assert-Case (($result.code -eq $code) -and [IO.File]::Exists($marker) -eq ($code -eq 0)) 'research-shaped redirection and success-only marker preserve exit semantics'
            $log = [IO.File]::ReadAllText((Join-Path $root 'research.log'))
            Assert-Case ($log.Contains('fixture-output') -and $log.Contains('fixture-error')) 'research-shaped stdout and stderr retain shared redirected log'
        }
    } finally { if ($had) { $env:HIDDEN_TEST_VALUE = $old } else { Remove-Item Env:HIDDEN_TEST_VALUE -ErrorAction SilentlyContinue } }
} finally {
    # Only this GUID-named finite fixture directory is removed.
    if ([IO.Directory]::Exists($root)) { Remove-Item -LiteralPath $root -Recurse -Force }
}
[Console]::Out.WriteLine((@{ ok = $true; passed = $script:Passed; failed = 0; fixtureOnly = $true } | ConvertTo-Json -Compress))
