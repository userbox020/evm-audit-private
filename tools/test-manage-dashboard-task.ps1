[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'manage-dashboard-task.ps1')
$script:Passed = 0
function Assert-Case { param([bool]$Condition, [string]$Name) if (-not $Condition) { throw "FAILED: $Name" }; $script:Passed++ }

# Only local interpreter resolution is real. Every Scheduler/account operation
# is mocked, and the Python subprocess below mocks sockets and module execution.
$pythonResolver = ${function:Get-DashboardPythonPath}
$script:TestPython = Get-DashboardPythonPath
$script:FixtureSid = 'S-1-5-21-111-222-333-1001'
function Get-DashboardPythonPath { return $script:TestPython }
function Get-DashboardAccountSid { return $script:FixtureSid }
function Resolve-DashboardAccountSid { param([string]$UserId) return $UserId }
function Reset-Fixture {
    $script:Task = $null; $script:Gets = 0; $script:Registers = 0; $script:Forbidden = 0
    $script:DriftBefore = $false; $script:DriftDuring = $false; $script:BadAfter = $false
    $script:QueryFailure = $false; $script:MissingError = $false; $script:ThrowAfterRegister = $false
    $script:QueryErrorId = ''
}
function Get-ScheduledTask {
    [CmdletBinding()]param([string]$TaskName, [string]$TaskPath)
    if ($TaskName -cne 'EVMAuditDashboard' -or $TaskPath -cne '\') { throw 'TASK_TEST_FIXED_IDENTITY_REQUIRED' }
    $script:Gets++
    if ($script:QueryFailure) { throw 'fixture-private-query-failure' }
    if ($script:MissingError) { Write-Error -Message 'fixture absent' -ErrorId 'CmdletizationQuery_NotFound_TaskName' -Category ObjectNotFound; return }
    if ($script:QueryErrorId -cne '') {
        $category = if ($script:QueryErrorId -ceq 'AccessDenied') { 'PermissionDenied' } else { 'ObjectNotFound' }
        Write-Error -Message 'fixture-private-query-error' -ErrorId $script:QueryErrorId -Category $category
        return
    }
    if ($script:DriftBefore -and $script:Gets -eq 2) { $script:Task = New-FixtureTask }
    if ($null -ne $script:Task) { return $script:Task }
}
function New-ScheduledTaskAction {
    param($Execute, $Argument, $WorkingDirectory)
    return [pscustomobject]@{ Execute = $Execute; Arguments = $Argument; WorkingDirectory = $WorkingDirectory }
}
function New-ScheduledTaskTrigger {
    param([switch]$AtLogOn, [string]$User, [switch]$Once, [datetime]$At, [TimeSpan]$RepetitionInterval)
    if ($AtLogOn) {
        return [pscustomobject]@{ CimClass = [pscustomobject]@{ CimClassName = 'MSFT_TaskLogonTrigger' }; UserId = $User; StartBoundary = ''; EndBoundary = ''; Enabled = $true; ExecutionTimeLimit = 'PT0S'; Repetition = $null; Delay = '' }
    }
    if (-not $Once -or $RepetitionInterval -ne [TimeSpan]::FromMinutes(1)) { throw 'TASK_TEST_TRIGGER_INVALID' }
    return [pscustomobject]@{ CimClass = [pscustomobject]@{ CimClassName = 'MSFT_TaskTimeTrigger' }; StartBoundary = $At.ToString('yyyy-MM-ddTHH:mm:ss'); EndBoundary = ''; Enabled = $true; ExecutionTimeLimit = 'PT0S'; RandomDelay = ''; Repetition = [pscustomobject]@{ Interval = 'PT1M'; Duration = ''; StopAtDurationEnd = $false } }
}
function New-ScheduledTaskPrincipal {
    param([string]$UserId, [string]$LogonType, [string]$RunLevel)
    return [pscustomobject]@{ UserId = $UserId; GroupId = ''; LogonType = $LogonType; RunLevel = $RunLevel; RequiredPrivilege = @(); ProcessTokenSidType = 'Default' }
}
function New-ScheduledTaskSettingsSet {
    param([string]$MultipleInstances, [switch]$StartWhenAvailable, [TimeSpan]$ExecutionTimeLimit)
    return [pscustomobject]@{ Enabled = $true; MultipleInstances = $MultipleInstances; StartWhenAvailable = [bool]$StartWhenAvailable; ExecutionTimeLimit = [Xml.XmlConvert]::ToString($ExecutionTimeLimit); WakeToRun = $false; RunOnlyIfIdle = $false; RunOnlyIfNetworkAvailable = $false; RestartCount = 0; DisallowStartIfOnBatteries = $true; StopIfGoingOnBatteries = $true }
}
function New-FixtureTask {
    return [pscustomobject]@{
        TaskName = 'EVMAuditDashboard'; TaskPath = '\'; State = 'Ready'
        Actions = @(New-HiddenLaunchSpec -Executable $script:TestPython -Arguments (Get-DashboardArguments) -WorkingDirectory $script:DashboardWorkspace)
        Principal = New-ScheduledTaskPrincipal -UserId $script:FixtureSid -LogonType Interactive -RunLevel Limited
        Settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
        Triggers = @((New-ScheduledTaskTrigger -AtLogOn -User $script:FixtureSid), (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval ([TimeSpan]::FromMinutes(1))))
    }
}
function Register-ScheduledTask {
    [CmdletBinding()]param($TaskName, $TaskPath, $Action, $Trigger, $Principal, $Settings)
    if ($TaskName -cne 'EVMAuditDashboard' -or $TaskPath -cne '\') { throw 'TASK_TEST_FIXED_IDENTITY_REQUIRED' }
    $script:Registers++
    if ($script:DriftDuring) { $script:Task = New-FixtureTask; throw 'TASK_TEST_CONCURRENT_REGISTER' }
    if ($null -ne $script:Task) { throw 'TASK_TEST_NO_OVERWRITE' }
    $script:Task = [pscustomobject]@{ TaskName = $TaskName; TaskPath = $TaskPath; State = 'Ready'; Actions = @($Action); Triggers = @($Trigger); Principal = $Principal; Settings = $Settings }
    if ($script:BadAfter) { $script:Task.Principal.UserId = 'concurrent-account' }
    if ($script:ThrowAfterRegister) { throw 'TASK_TEST_REGISTER_FAILED_AFTER_WRITE' }
    return $script:Task
}
function Start-ScheduledTask { $script:Forbidden++; throw 'TASK_TEST_START_FORBIDDEN' }
function Stop-ScheduledTask { $script:Forbidden++; throw 'TASK_TEST_STOP_FORBIDDEN' }
function Unregister-ScheduledTask { $script:Forbidden++; throw 'TASK_TEST_DELETE_FORBIDDEN' }
function Set-ScheduledTask { $script:Forbidden++; throw 'TASK_TEST_UPDATE_FORBIDDEN' }
function Start-Process { $script:Forbidden++; throw 'TASK_TEST_PROCESS_FORBIDDEN' }
function Stop-Process { $script:Forbidden++; throw 'TASK_TEST_PROCESS_FORBIDDEN' }

Reset-Fixture
$result = Invoke-DashboardTaskInstall
Assert-Case ($result.status -ceq 'would-register' -and $script:Registers -eq 0 -and $script:Forbidden -eq 0) 'default dry run has zero Scheduler mutations or process operations'
Assert-Case ($result.taskName -ceq 'EVMAuditDashboard' -and $result.taskPath -ceq '\' -and -not $result.taskStartRequested) 'only fixed root identity is reported; no Start requested'
$report = $result | ConvertTo-Json -Compress
Assert-Case ($report -notmatch 'S-1-5|Arguments|workingDirectory|wscript|python.exe|executable|fixture-private') 'dry-run output excludes account IDs raw actions paths and opaque payloads'
$result = Invoke-DashboardTaskInstall -Apply
Assert-Case ($result.status -ceq 'registered' -and $script:Registers -eq 1 -and $script:Gets -eq 4 -and $script:Forbidden -eq 0) 'apply registers one fixed task after an absence recheck and fresh postvalidation'
$inner = Read-HiddenLaunchAction $script:Task.Actions[0]
Assert-Case ($inner.Execute -ceq $script:TestPython -and $inner.Arguments -ceq ('-E -B "' + $script:DashboardRunner + '"') -and $inner.WorkingDirectory -ceq $script:DashboardWorkspace) 'canonical synchronous action pins environment-ignoring current Python with existing user-site dependencies and the fixed runner'
$wire = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(([string]$script:Task.Actions[0].Arguments).Split(' ')[-1])) | ConvertFrom-Json
Assert-Case ($wire.wait -ceq $true -and @($wire.PSObject.Properties).Count -eq 5) 'hidden helper waits for server lifetime rather than detaching'
Assert-Case ($script:Task.Principal.UserId -ceq $script:FixtureSid -and $script:Task.Principal.LogonType -ceq 'Interactive' -and $script:Task.Principal.RunLevel -ceq 'Limited' -and $script:Task.Principal.GroupId -ceq '' -and $script:Task.Principal.RequiredPrivilege.Count -eq 0) 'same account interactive limited principal has no elevation service identity or extra privileges'
Assert-Case ($script:Task.Triggers.Count -eq 2 -and $script:Task.Triggers[0].UserId -ceq $script:FixtureSid -and $script:Task.Triggers[1].Repetition.Interval -ceq 'PT1M' -and $script:Task.Triggers[1].Repetition.Duration -ceq '' -and -not $script:Task.Triggers[1].Repetition.StopAtDurationEnd -and @($script:Task.Triggers | Where-Object { $_.EndBoundary -cne '' }).Count -eq 0) 'same-account logon plus one-minute repetition have no end or duration'
Assert-Case ($script:Task.Settings.MultipleInstances -ceq 'IgnoreNew' -and $script:Task.Settings.ExecutionTimeLimit -ceq 'PT0S' -and $script:Task.Settings.StartWhenAvailable -and -not $script:Task.Settings.WakeToRun -and $script:Task.Settings.DisallowStartIfOnBatteries -and $script:Task.Settings.StopIfGoingOnBatteries) 'overlaps ignored lifetime unlimited and default battery/wake policies unmodified'
$result = Invoke-DashboardTaskInstall -Apply
Assert-Case ($result.status -ceq 'unchanged' -and $script:Registers -eq 1 -and $script:Forbidden -eq 0) 'installation is idempotent without rewriting the task'
$result = Invoke-DashboardTaskInstall
Assert-Case ($result.status -ceq 'unchanged' -and $script:Registers -eq 1) 'dry-run recognizes exact existing task'

foreach ($bad in @('name', 'path', 'action', 'async', 'cwd', 'python', 'arguments', 'principal', 'elevation', 'logon', 'group', 'privileges', 'tokenType', 'disabled', 'instances', 'limit', 'startAvailable', 'wake', 'idle', 'network', 'restart', 'triggerCount', 'triggerType', 'triggerEnd', 'triggerLimit', 'logonUser', 'logonStart', 'logonDelay', 'interval', 'duration', 'stopAtEnd', 'randomDelay', 'futureStart', 'invalidStart')) {
    Reset-Fixture; $script:Task = New-FixtureTask
    switch ($bad) {
        'name' { $script:Task.TaskName = 'UnrelatedTask' }
        'path' { $script:Task.TaskPath = '\other\' }
        'action' { $script:Task.Actions[0].Arguments += ' ' }
        'async' { $script:Task.Actions = @(New-HiddenLaunchSpec -Executable $script:TestPython -Arguments (Get-DashboardArguments) -WorkingDirectory $script:DashboardWorkspace -WaitForExit $false) }
        'cwd' { $script:Task.Actions[0].WorkingDirectory = $PSScriptRoot }
        'python' { $script:Task.Actions = @(New-HiddenLaunchSpec -Executable (Join-Path $PSScriptRoot 'python.exe') -Arguments (Get-DashboardArguments) -WorkingDirectory $script:DashboardWorkspace) }
        'arguments' { $script:Task.Actions = @(New-HiddenLaunchSpec -Executable $script:TestPython -Arguments ((Get-DashboardArguments) + ' --arbitrary') -WorkingDirectory $script:DashboardWorkspace) }
        'principal' { $script:Task.Principal.UserId = 'different-account' }
        'elevation' { $script:Task.Principal.RunLevel = 'Highest' }
        'logon' { $script:Task.Principal.LogonType = 'S4U' }
        'group' { $script:Task.Principal.GroupId = 'some-group' }
        'privileges' { $script:Task.Principal.RequiredPrivilege = @('SeDebugPrivilege') }
        'tokenType' { $script:Task.Principal.ProcessTokenSidType = 'Unrestricted' }
        'disabled' { $script:Task.Settings.Enabled = $false }
        'instances' { $script:Task.Settings.MultipleInstances = 'Parallel' }
        'limit' { $script:Task.Settings.ExecutionTimeLimit = 'PT1H' }
        'startAvailable' { $script:Task.Settings.StartWhenAvailable = $false }
        'wake' { $script:Task.Settings.WakeToRun = $true }
        'idle' { $script:Task.Settings.RunOnlyIfIdle = $true }
        'network' { $script:Task.Settings.RunOnlyIfNetworkAvailable = $true }
        'restart' { $script:Task.Settings.RestartCount = 10 }
        'triggerCount' { $script:Task.Triggers = @($script:Task.Triggers[0]) }
        'triggerType' { $script:Task.Triggers[1].CimClass.CimClassName = 'MSFT_TaskBootTrigger' }
        'triggerEnd' { $script:Task.Triggers[1].EndBoundary = '2026-10-29T00:00:00Z' }
        'triggerLimit' { $script:Task.Triggers[1].ExecutionTimeLimit = 'PT1H' }
        'logonUser' { $script:Task.Triggers[0].UserId = 'different-account' }
        'logonStart' { $script:Task.Triggers[0].StartBoundary = '2026-10-29T00:00:00Z' }
        'logonDelay' { $script:Task.Triggers[0].Delay = 'PT1H' }
        'interval' { $script:Task.Triggers[1].Repetition.Interval = 'PT1S' }
        'duration' { $script:Task.Triggers[1].Repetition.Duration = 'PT1H' }
        'stopAtEnd' { $script:Task.Triggers[1].Repetition.StopAtDurationEnd = $true }
        'randomDelay' { $script:Task.Triggers[1].RandomDelay = 'PT1H' }
        'futureStart' { $script:Task.Triggers[1].StartBoundary = [DateTimeOffset]::Now.AddDays(1).ToString('o') }
        'invalidStart' { $script:Task.Triggers[1].StartBoundary = 'fixture-private-date' }
    }
    $result = Invoke-DashboardTaskInstall -Apply
    Assert-Case ($result.status -ceq 'refused' -and $script:Registers -eq 0 -and $script:Forbidden -eq 0) ('incompatible existing task is never adopted or overwritten: ' + $bad)
    Assert-Case (($result | ConvertTo-Json -Compress) -notmatch 'fixture-private|different-account|some-group|SeDebugPrivilege|S-1-5') 'refusal remains sanitized'
}
Reset-Fixture; $script:DriftBefore = $true
$result = Invoke-DashboardTaskInstall -Apply
Assert-Case ($result.reason -ceq 'TASK_CHANGED_DURING_INSPECTION' -and $script:Registers -eq 0 -and $script:Forbidden -eq 0) 'task appearing before registration is preserved'
Reset-Fixture; $script:DriftDuring = $true
$result = Invoke-DashboardTaskInstall -Apply
Assert-Case ($result.reason -ceq 'TASK_REGISTER_FAILED_ATTENDED_INSPECTION' -and $script:Registers -eq 1 -and $null -ne $script:Task -and $script:Forbidden -eq 0) 'no Force registration or cleanup overwrites concurrent same-name task'
Reset-Fixture; $script:BadAfter = $true
$result = Invoke-DashboardTaskInstall -Apply
Assert-Case ($result.reason -ceq 'TASK_POSTVALIDATION_FAILED_ATTENDED_INSPECTION' -and $script:Registers -eq 1 -and $script:Task.Principal.UserId -ceq 'concurrent-account' -and $script:Forbidden -eq 0) 'postvalidation detects drift without deleting or reverting it'
Reset-Fixture; $script:ThrowAfterRegister = $true
$result = Invoke-DashboardTaskInstall -Apply
Assert-Case ($result.reason -ceq 'TASK_REGISTER_FAILED_ATTENDED_INSPECTION' -and $null -ne $script:Task -and $script:Forbidden -eq 0) 'uncertain partial registration requires attended inspection not blind rollback'
Reset-Fixture; $script:QueryFailure = $true
$result = Invoke-DashboardTaskInstall -Apply
Assert-Case ($result.reason -ceq 'TASK_INSPECTION_FAILED' -and $script:Registers -eq 0) 'inspection denial is not treated as absence'
Reset-Fixture; $script:MissingError = $true
$result = Invoke-DashboardTaskInstall
Assert-Case ($result.status -ceq 'would-register' -and $script:Registers -eq 0) 'specific Scheduler not-found error is an absent task'
Reset-Fixture; $script:QueryErrorId = 'CmdletizationQuery_NotFound'
$observedErrorId = ''
try { Get-ScheduledTask -TaskName 'EVMAuditDashboard' -TaskPath '\' -ErrorAction Stop | Out-Null } catch { $observedErrorId = $_.FullyQualifiedErrorId }
Assert-Case ($observedErrorId -ceq 'CmdletizationQuery_NotFound,Get-ScheduledTask') 'mock reproduces exact production absent-task error ID'
$result = Invoke-DashboardTaskInstall
Assert-Case ($result.status -ceq 'would-register' -and $script:Registers -eq 0 -and $script:Forbidden -eq 0) 'exact production not-found ID is accepted without mutation'
foreach ($errorId in @('AccessDenied', 'CmdletizationQuery_QueryFailed', 'CmdletizationQuery_NotFound_Unexpected')) {
    Reset-Fixture; $script:QueryErrorId = $errorId
    $result = Invoke-DashboardTaskInstall -Apply
    Assert-Case ($result.status -ceq 'refused' -and $result.reason -ceq 'TASK_INSPECTION_FAILED' -and $script:Registers -eq 0 -and $script:Forbidden -eq 0) 'access denial generic query failure and near-match not-found IDs still fail closed'
}

# The actual resolver must reject arbitrary PATH binaries and store aliases.
function Get-Command { [CmdletBinding()]param($Name, $CommandType) return [pscustomobject]@{ Source = $script:BadPythonPath } }
foreach ($badPath in @((Join-Path $PSScriptRoot 'python.exe'), (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Microsoft\WindowsApps\python.exe'), '\\fixture.invalid\share\python.exe')) {
    $script:BadPythonPath = $badPath; $rejected = $false
    try { & $pythonResolver | Out-Null } catch { $rejected = $_.Exception.Message -ceq 'TASK_PYTHON_UNVERIFIED' }
    Assert-Case $rejected 'Python resolution refuses checkout binaries store aliases and network paths without executing them'
}
Remove-Item Function:Get-Command

$pythonTests = @'
import ast
import contextlib
import errno
import importlib.util
import io
import json
from pathlib import Path
import sys
import unittest
from unittest import mock

source = Path(sys.argv[1])
spec = importlib.util.spec_from_file_location("dashboard_task_fixture", source)
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)

class RunnerTests(unittest.TestCase):
    def test_fixed_interpreter_flags_ignore_environment_but_allow_user_site(self):
        self.assertEqual(sys.flags.ignore_environment, 1)
        self.assertEqual(sys.flags.isolated, 0)
        self.assertEqual(sys.flags.no_user_site, 0)
        self.assertTrue(sys.dont_write_bytecode)

    def invoke(self, *, bind_error=None, launch_error=None, args=None, socket_error=None):
        output = io.StringIO()
        with mock.patch.object(runner.socket, "socket") as factory, \
             mock.patch.object(runner.os, "chdir") as chdir, \
             mock.patch.object(runner.runpy, "run_module") as launch, \
             mock.patch.object(sys, "path", list(sys.path)), \
             contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            factory.side_effect = socket_error
            probe = factory.return_value.__enter__.return_value
            probe.bind.side_effect = bind_error
            def module(*call_args, **kwargs):
                self.assertTrue(factory.return_value.__exit__.called)
                self.assertEqual(call_args, ("dashboard",))
                self.assertEqual(kwargs, {"run_name": "__main__", "alter_sys": True})
                self.assertEqual(sys.path[0], str(runner.WORKSPACE))
                print("fixture-private-module-output")
                if launch_error is not None:
                    raise launch_error
            launch.side_effect = module
            code = runner.main([] if args is None else args)
        return code, output.getvalue().splitlines(), factory, probe, chdir, launch

    def test_free_port_launches_only_fixed_module_synchronously(self):
        code, output, factory, probe, chdir, launch = self.invoke()
        self.assertEqual(code, 0)
        self.assertEqual(output, ["DASHBOARD_STARTING", "DASHBOARD_STOPPED"])
        factory.assert_called_once_with(runner.socket.AF_INET, runner.socket.SOCK_STREAM)
        probe.bind.assert_called_once_with(("127.0.0.1", 5050))
        probe.connect.assert_not_called()
        if hasattr(runner.socket, "SO_EXCLUSIVEADDRUSE"):
            probe.setsockopt.assert_called_once_with(runner.socket.SOL_SOCKET, runner.socket.SO_EXCLUSIVEADDRUSE, 1)
        chdir.assert_called_once_with(source.resolve().parent.parent)
        launch.assert_called_once_with("dashboard", run_name="__main__", alter_sys=True)

    def test_occupied_port_defers_without_launch_or_adoption(self):
        code, output, _, _, chdir, launch = self.invoke(bind_error=OSError(errno.EADDRINUSE, "fixture-private-listener"))
        self.assertEqual((code, output), (0, ["PORT_OCCUPIED"]))
        chdir.assert_not_called()
        launch.assert_not_called()

    def test_other_port_failure_fails_closed(self):
        code, output, _, _, _, launch = self.invoke(bind_error=OSError(errno.EACCES, "fixture-private-port-error"))
        self.assertEqual((code, output), (1, ["PORT_UNAVAILABLE"]))
        launch.assert_not_called()

    def test_socket_creation_failure_fails_closed(self):
        code, output, _, _, _, launch = self.invoke(socket_error=OSError("fixture-private-socket-error"))
        self.assertEqual((code, output), (1, ["PORT_UNAVAILABLE"]))
        launch.assert_not_called()

    def test_unknown_arguments_refuse_before_socket_or_module(self):
        for args in [["--port", "5051"], ["--execute"], ["other-module"]]:
            code, output, factory, _, chdir, launch = self.invoke(args=args)
            self.assertEqual((code, output), (2, ["DASHBOARD_ARGUMENTS_REFUSED"]))
            factory.assert_not_called()
            chdir.assert_not_called()
            launch.assert_not_called()

    def test_module_failure_never_leaks_exception_or_request_output(self):
        code, output, _, _, _, launch = self.invoke(launch_error=RuntimeError("fixture-private-runtime-error"))
        self.assertEqual((code, output), (1, ["DASHBOARD_STARTING", "DASHBOARD_FAILED"]))
        self.assertEqual(launch.call_count, 1)

    def test_flask_binding_race_failure_is_not_retried_in_process(self):
        code, output, _, _, _, launch = self.invoke(launch_error=SystemExit("fixture-private-bind-race"))
        self.assertEqual((code, output), (1, ["DASHBOARD_STARTING", "DASHBOARD_FAILED"]))
        self.assertEqual(launch.call_count, 1)

    def test_clean_module_exit_is_fixed_status(self):
        code, output, _, _, _, _ = self.invoke(launch_error=SystemExit(0))
        self.assertEqual((code, output), (0, ["DASHBOARD_STARTING", "DASHBOARD_STOPPED"]))

    def test_interrupt_has_no_traceback_or_process_controls(self):
        code, output, _, _, _, launch = self.invoke(launch_error=KeyboardInterrupt())
        self.assertEqual((code, output), (0, ["DASHBOARD_STARTING", "DASHBOARD_STOPPED"]))
        self.assertEqual(launch.call_count, 1)

    def test_no_child_process_collector_or_financial_startup(self):
        tree = ast.parse(source.read_text(encoding="utf-8"))
        imports = {alias.name for node in ast.walk(tree) if isinstance(node, ast.Import) for alias in node.names}
        self.assertEqual(imports, {"contextlib", "errno", "os", "runpy", "socket", "sys"})
        self.assertFalse(any(isinstance(node, (ast.While, ast.AsyncFor)) for node in ast.walk(tree)))
        text = source.read_text(encoding="utf-8")
        for forbidden in ["subprocess", "Popen", "os.system", "os.kill", "node.exe", "watch-wallet", "execute-top-whale"]:
            self.assertNotIn(forbidden, text)

stream = io.StringIO()
result = unittest.TextTestRunner(stream=stream).run(unittest.defaultTestLoader.loadTestsFromTestCase(RunnerTests))
if not result.wasSuccessful():
    print(stream.getvalue())
    raise SystemExit(1)
print(json.dumps({"tests": result.testsRun, "failed": len(result.failures) + len(result.errors)}))
'@
$pythonOutput = $pythonTests | & $script:TestPython -E -B - $script:DashboardRunner
if ($LASTEXITCODE -ne 0) { throw ('FAILED: isolated runner mocks: ' + ($pythonOutput -join [Environment]::NewLine)) }
$pythonResult = $pythonOutput | ConvertFrom-Json
Assert-Case ($pythonResult.tests -eq 11 -and $pythonResult.failed -eq 0) 'fixed-flag Python runner mocks passed without actual sockets or module startup'
[Console]::Out.WriteLine((@{ ok = $true; passed = $script:Passed; failed = 0; pythonTests = $pythonResult.tests; pythonFailures = $pythonResult.failed; fixtureOnly = $true } | ConvertTo-Json -Compress))
