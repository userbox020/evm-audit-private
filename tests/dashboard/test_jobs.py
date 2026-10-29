"""Offline jobs contract tests: every inspection is stubbed, never the host."""

import io
import json
import os
import re
import subprocess
import threading
import time
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from jinja2 import DictLoader

from dashboard.app import create_app
import dashboard.jobs as jobs


def observation(rows=None, age=0, processes="OK", scheduler="OK"):
    return {"observedAt": datetime.fromtimestamp(time.time() - age, timezone.utc).isoformat(),
            "inspection": {"processes": processes, "scheduler": scheduler}, "jobs": rows or []}


def row(ident="novelty-monitor", pids=None, state="RUNNING", match="WORKSPACE_PATH", schedule=None):
    return {"id": ident, "process": {"state": state, "pids": [123] if pids is None else pids,
                                    "pid": 999, "instanceCount": 999, "matchKind": match,
                                    "startedAt": "2026-10-17T07:00:00Z", "windowVisible": False},
            "schedule": schedule}


def find(data, ident="novelty-monitor"):
    return next(item for item in data["jobs"] if item["id"] == ident)


@pytest.fixture(autouse=True)
def no_host_inspection(monkeypatch):
    monkeypatch.setattr(jobs, "collect_windows", lambda: observation())


@pytest.fixture
def real_jobs_client(root, monkeypatch):
    app = create_app(root)
    app.config["TESTING"] = True
    import importlib
    app_module = importlib.import_module("dashboard.app")
    def forbidden(*args, **kwargs):
        pytest.fail("jobs route called an unrelated expensive snapshot")
    for name in ("snapshot", "build_canary", "build_ops"):
        monkeypatch.setattr(app_module, name, forbidden)
    return app.test_client(use_cookies=False)


@pytest.fixture
def jobs_client(real_jobs_client):
    # Keep the isolated route contract checks as well as real-template coverage.
    real_jobs_client.application.jinja_loader = DictLoader({"jobs.html": "{{ jobs.schema }} {{ jobs.jobs[0].label }}"})
    return real_jobs_client


def request(client, path, method="GET", remote="127.0.0.1", host="127.0.0.1:5050"):
    return client.open(path, method=method, base_url="http://127.0.0.1:5050",
                       environ_overrides={"REMOTE_ADDR": remote, "HTTP_HOST": host})


@pytest.mark.parametrize("path", ["/jobs", "/api/v1/jobs"])
def test_routes_read_only_local_isolated(jobs_client, path):
    response = request(jobs_client, path)
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-store"
    for method in ("POST", "PUT", "PATCH", "DELETE"):
        assert request(jobs_client, path, method).status_code == 405
    assert request(jobs_client, path, remote="192.0.2.4").status_code == 403
    assert request(jobs_client, path, host="example.com").status_code == 403
    assert request(jobs_client, path, host="127.0.0.1.evil.test:5050").status_code == 403


def test_render_autoescapes_catalog_labels(real_jobs_client, monkeypatch):
    spec = dict(jobs.CATALOG[0], label='<img src=x onerror="bad()">')
    monkeypatch.setattr(jobs, "CATALOG", (spec,))
    text = request(real_jobs_client, "/jobs").get_data(as_text=True)
    assert "<img" not in text and "&lt;img" in text


def render_real_job(client, raw, ident):
    client.application.extensions["jobs_inspector"].collector = lambda: raw
    response = request(client, "/jobs")
    assert response.status_code == 200
    html = response.get_data(as_text=True)
    record = next(record for record in re.findall(r"<tr>.*?</tr>", html, re.DOTALL)
                  if f"<code>{ident}</code>" in record)
    return html, record


def test_real_template_running_pids_and_jobs_navigation(real_jobs_client):
    html, record = render_real_job(real_jobs_client, observation([row(pids=[913771, 913772])]), "novelty-monitor")
    assert "Running" in record and "2 instances" in record
    assert "913771, 913772" in record
    assert '<a href="/jobs" aria-current="page">Jobs</a>' in html
    assert '<a href="/api/v1/jobs">View JSON</a>' in html


def test_real_template_disabled_schedule_can_have_running_pid(real_jobs_client):
    ident = "trigger-fork-autopilot"
    schedule = {"taskId": "EVMAuditTriggerForkAutopilot", "state": "DISABLED", "enabled": False}
    _, record = render_real_job(real_jobs_client, observation([row(ident, pids=[918271], schedule=schedule)]), ident)
    assert "Running" in record and "918271" in record
    assert "Disabled" in record and "Automatic launch disabled" in record
    assert "No confirmed live PID" not in record


def test_real_template_stale_observation_withholds_pid(real_jobs_client):
    html, record = render_real_job(real_jobs_client, observation([row(pids=[917271])], age=60), "novelty-monitor")
    assert "STALE" in html and "PIDs are withheld" in html
    assert "Unknown" in record and "Not verified" in record
    assert "917271" not in html and "Running</span>" not in record
    api = request(real_jobs_client, "/api/v1/jobs").get_json()
    assert find(api)["process"]["pid"] is None and find(api)["process"]["pids"] == []


@pytest.mark.parametrize("pids,expected_pid,count", [([123], 123, 1), ([7, 3, 7], None, 2)])
def test_running_pid_invariants(pids, expected_pid, count):
    proc = find(jobs.sanitize(observation([row(pids=pids)]), time.time()))["process"]
    assert proc["state"] == "RUNNING"
    assert proc["pid"] == expected_pid
    assert proc["pids"] == sorted(set(pids)) and proc["instanceCount"] == count
    if count > 1:
        assert proc["startedAt"] is None


@pytest.mark.parametrize("pids,match", [([], "WORKSPACE_PATH"), ([True], "WORKSPACE_PATH"),
                                       ([-1], "SCRIPT_MATCH"), ([1], "NONE"), ([1], [])])
def test_unproven_running_is_unknown(pids, match):
    proc = find(jobs.sanitize(observation([row(pids=pids, match=match)]), time.time()))["process"]
    assert proc["state"] == "UNKNOWN" and proc["pid"] is None and proc["pids"] == []


@pytest.mark.parametrize("state", ["READY", "DISABLED", "RUNNING", "QUEUED", "MISSING"])
def test_scheduler_state_does_not_imply_liveness(state):
    spec = next(spec for spec in jobs.CATALOG if spec["id"] == "wallet-balances")
    schedule = dict(taskId=spec["taskId"], state=state, enabled=state != "DISABLED",
                    cadenceSeconds=300, hiddenLaunch=True, lastResultCode=0)
    raw = observation([{"id": spec["id"], "schedule": schedule}])
    item = find(jobs.sanitize(raw, time.time()), spec["id"])
    assert item["schedule"]["state"] == state
    assert item["process"]["state"] == "UNKNOWN"
    raw["jobs"][0]["process"] = row(state="NOT_RUNNING", pids=[])["process"]
    item = find(jobs.sanitize(raw, time.time()), spec["id"])
    assert item["process"]["state"] == "NOT_RUNNING" and item["process"]["pid"] is None


@pytest.mark.parametrize("status,age", [("UNSUPPORTED", 0), ("UNAVAILABLE", 0), ("ERROR", 0), ("OK", 60), ("OK", -60)])
def test_failed_or_stale_is_unknown(status, age):
    data = jobs.sanitize(observation([row()], age=age, processes=status, scheduler=status), time.time())
    proc = find(data)["process"]
    assert proc["state"] == "UNKNOWN" and proc["pid"] is None and proc["pids"] == []
    assert data["freshness"] != "FRESH"
    assert data["observedAt"] is not None


def test_cache_and_failure_demote_keep_observed_at(monkeypatch):
    calls = []
    tick = [10.0]
    monkeypatch.setattr(jobs.time, "monotonic", lambda: tick[0])
    def collect():
        calls.append(1)
        if len(calls) > 1:
            raise OSError("private command line / endpoint / path")
        return observation([row()])
    inspector = jobs.JobsInspector(collect)
    first = inspector.snapshot()
    assert find(first)["process"]["state"] == "RUNNING"
    inspector.snapshot()
    assert len(calls) == 1
    tick[0] += 16
    failed = inspector.snapshot()
    assert len(calls) == 2 and failed["observedAt"] == first["observedAt"]
    assert find(failed)["process"]["state"] == "UNKNOWN"
    assert failed["inspection"] == {"processes": "ERROR", "scheduler": "ERROR"}
    assert "private" not in json.dumps(failed)


def test_cache_rechecks_freshness(monkeypatch):
    now = time.time()
    raw = observation([row()])
    inspector = jobs.JobsInspector(lambda: raw)
    monkeypatch.setattr(jobs.time, "time", lambda: now)
    assert inspector.snapshot()["freshness"] == "FRESH"
    monkeypatch.setattr(jobs.time, "time", lambda: now + 100)
    assert inspector.snapshot()["freshness"] == "STALE"
    assert find(inspector.snapshot())["process"]["state"] == "UNKNOWN"


def test_projection_rejects_unsafe_ids_and_ignores_extra_fields():
    raw = observation([dict(row(), commandLine="secret", label="<script>", actions="secret"),
                       dict(row(), id="../../secret"), dict(row(), id="<script>")])
    raw.update(error="secret", endpoint="secret", path="secret")
    data = jobs.sanitize(raw, time.time())
    encoded = json.dumps(data)
    assert all(token not in encoded for token in ("secret", "<script>", '"commandLine"', '"endpoint"', '"actions"'))
    assert len(data["jobs"]) == len(jobs.CATALOG)
    assert all("/" not in item["scriptId"] for item in data["jobs"])


@pytest.mark.parametrize("raw", [{}, {"inspection": {"processes": []}}, {"jobs": [None, {}]},
                                 {"observedAt": "not a date"}, {"observedAt": "2026-10-17"}])
def test_malformed_observations_fail_closed(raw):
    data = jobs.sanitize(raw, time.time())
    assert find(data)["process"]["state"] == "UNKNOWN"
    assert data["freshness"] == "UNAVAILABLE"


def test_duplicate_rows_fail_closed():
    data = jobs.sanitize(observation([row(), row(pids=[9])]), time.time())
    assert find(data)["process"]["state"] == "UNKNOWN"


def test_external_and_startup_rows_are_not_false_absence():
    data = jobs.sanitize(observation([row("base-arb-bot-guardian"), row("monitor-set")]), time.time())
    for ident in ("base-arb-bot-guardian", "monitor-set"):
        assert find(data, ident)["process"]["state"] == "UNKNOWN"
    assert not {"morpho-startup-scan", "disabled-routes-report", "research-watch-build"} & {item["id"] for item in data["jobs"]}


class FakeCollector:
    def __init__(self, content=b"{}", returncode=0):
        self.stdout = io.BytesIO(content)
        self.returncode = returncode
        self.killed = False

    def wait(self, timeout):
        return self.returncode

    def poll(self):
        return self.returncode

    def kill(self):
        self.killed = True
        self.returncode = -1


def invoke_fixed_collector(monkeypatch, collector):
    # no_host_inspection replaces the function, so call the saved implementation below.
    calls = []
    monkeypatch.setattr(jobs, "os", SimpleNamespace(name="nt", environ={"SystemRoot": r"C:\Windows"}))
    monkeypatch.setattr(jobs.subprocess, "CREATE_NO_WINDOW", 0x08000000, raising=False)
    monkeypatch.setattr(jobs.subprocess, "Popen", lambda argv, **kwargs: calls.append((argv, kwargs)) or collector)
    return calls


REAL_COLLECT_WINDOWS = jobs.collect_windows


def test_collector_does_not_use_automatic_matches_collection():
    source = (jobs.WORKSPACE / "tools/read-audit-jobs.ps1").read_text(encoding="utf-8")
    assert re.search(r"\$matches\b", source, re.IGNORECASE) is None


def test_fixed_collector_arguments_and_output_bound(monkeypatch):
    calls = invoke_fixed_collector(monkeypatch, FakeCollector(b'{"jobs":[]}'))
    assert REAL_COLLECT_WINDOWS() == {"jobs": []}
    argv, options = calls[0]
    assert argv[-2:] == ["-File", str(jobs.WORKSPACE / "tools/read-audit-jobs.ps1")]
    assert options["creationflags"] == 0x08000000 and options["stderr"] == subprocess.DEVNULL
    assert options["stdin"] == subprocess.DEVNULL and "shell" not in options
    invoke_fixed_collector(monkeypatch, FakeCollector(b" " * (jobs.MAX_OUTPUT_BYTES + 1)))
    with pytest.raises(ValueError):
        REAL_COLLECT_WINDOWS()


@pytest.mark.parametrize("content,code", [(b"not json", 0), (b"[]", 0), (b"{}", 1)])
def test_collector_rejects_invalid_output(monkeypatch, content, code):
    invoke_fixed_collector(monkeypatch, FakeCollector(content, code))
    with pytest.raises(ValueError):
        REAL_COLLECT_WINDOWS()


def test_nonwindows_explicitly_unsupported(monkeypatch):
    monkeypatch.setattr(jobs, "os", SimpleNamespace(name="posix"))
    raw = REAL_COLLECT_WINDOWS()
    assert raw["inspection"] == {"processes": "UNSUPPORTED", "scheduler": "UNSUPPORTED"}
    data = jobs.sanitize(raw, time.time())
    assert data["freshness"] == "UNAVAILABLE" and data["observedAt"] is None
    assert all(item["process"]["state"] == "UNKNOWN" for item in data["jobs"])


def test_collector_timeout_kills_only_its_own_child(monkeypatch):
    release = threading.Event()
    class HungCollector(FakeCollector):
        def __init__(self):
            super().__init__()
            self.returncode = None
            self.stdout = SimpleNamespace(read=lambda size: release.wait(1) and b"", close=lambda: None)

        def kill(self):
            super().kill()
            release.set()
    child = HungCollector()
    invoke_fixed_collector(monkeypatch, child)
    monkeypatch.setattr(jobs, "COLLECTOR_TIMEOUT", 0.01)
    with pytest.raises(ValueError):
        REAL_COLLECT_WINDOWS()
    assert child.killed


@pytest.mark.skipif(os.name != "nt", reason="Windows PowerShell offline mock harness")
@pytest.mark.parametrize("process_scenario", ["readable", "transient-readable", "transient-exited",
                                             "persistent-null", "persistent-whitespace", "exception", "retry-exception"])
def test_powershell_collector_with_only_mocked_inspection(process_scenario):
    """Run the real projection/token code, with every system query replaced in scope."""
    workspace = str(jobs.WORKSPACE).replace("'", "''")
    script = str(jobs.WORKSPACE / "tools/read-audit-jobs.ps1").replace("'", "''")
    harness = r'''
$ErrorActionPreference = 'Stop'
$fixtureWorkspace = '__WORKSPACE__'
$fixtureScenario = '__SCENARIO__'
$script:fixtureQueryCount = 0
function New-FixtureProcess($Id, $Parent, $Name, $Line) {
    return [pscustomobject]@{ProcessId=$Id; ParentProcessId=$Parent; Name=$Name; CommandLine=$Line; CreationDate=[datetime]'2026-10-17T07:00:00Z'; MainWindowHandle=0}
}
function New-FixtureHiddenTask($TaskName, $Variant) {
    $wire = [ordered]@{version=1; executable='C:\private-target.exe'; arguments='private-endpoint-sentinel'; workingDirectory='C:\private-workspace'; wait=$true}
    if ($Variant -eq 'async') { $wire.wait = $false }
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($wire | ConvertTo-Json -Compress)))
    $wrapper = Join-Path $fixtureWorkspace 'tools\launch-hidden.vbs'
    $hostPath = Join-Path ([Environment]::SystemDirectory) 'wscript.exe'
    if ($Variant -eq 'wrong-wrapper') { $wrapper = 'C:\other-workspace\tools\launch-hidden.vbs' }
    if ($Variant -eq 'wrong-host') { $hostPath = 'C:\other-host\wscript.exe' }
    if ($Variant -eq 'wrapper-suffix') { $wrapper += '.backup' }
    if ($Variant -eq 'invalid-payload') { $encoded = '!!!' }
    $action = [pscustomobject]@{Execute=$hostPath; Arguments=('//B //Nologo "{0}" {1}' -f $wrapper, $encoded)}
    return [pscustomobject]@{TaskName=$TaskName;TaskPath='\';State='Ready';Settings=[pscustomobject]@{Enabled=$true;Hidden=$false};Triggers=@();Actions=@($action)}
}
function Get-CimInstance {
    param($ClassName, $Filter, $ErrorAction)
    $script:fixtureQueryCount += 1
    if ($ClassName -cne 'Win32_Process' -or $Filter -cne "Name = 'node.exe' OR Name = 'powershell.exe' OR Name = 'pwsh.exe'" -or $ErrorAction -cne 'Stop') { throw 'UNEXPECTED_QUERY' }
    if ($fixtureScenario -eq 'exception' -or ($fixtureScenario -eq 'retry-exception' -and $script:fixtureQueryCount -eq 2)) { throw 'private-error-sentinel' }
    $snapshot = @(
        (New-FixtureProcess 101 1 'node.exe' ('node "' + $fixtureWorkspace + '\tools\monitor-novelty-conditions.js" --watch')),
        (New-FixtureProcess 102 1 'node.exe' 'node tools/monitor-novelty-conditions.js.backup'),
        (New-FixtureProcess 103 1 'node.exe' 'node --eval "tools/monitor-novelty-conditions.js"'),
        (New-FixtureProcess 104 1 'node.exe' 'node other.js tools/monitor-novelty-conditions.js'),
        (New-FixtureProcess 105 1 'cmd.exe' 'cmd /c node tools/monitor-novelty-conditions.js'),
        (New-FixtureProcess 106 1 'node.exe' 'node "tools/monitor-novelty-conditions.js"suffix'),
        (New-FixtureProcess 201 1 'node.exe' 'node tools/monitor-morpho-ws.js'),
        (New-FixtureProcess 202 1 'node.exe' 'node .\tools\monitor-morpho-ws.js'),
        (New-FixtureProcess 301 1 'powershell.exe' 'powershell -NoProfile -File tools/manage-profit-trigger-watch-task.ps1 -Mode RunScheduled'),
        (New-FixtureProcess 302 301 'node.exe' 'node tools/run-profit-trigger-watch.js'),
        (New-FixtureProcess 303 1 'powershell.exe' 'powershell -NoProfile -File tools/manage-profit-trigger-watch-task.ps1 -Mode RunScheduled'),
        (New-FixtureProcess 401 1 'powershell.exe' 'powershell -Command echo tools/manage-lido-delta-v5-task.ps1'),
        (New-FixtureProcess 501 1 'powershell.exe' 'powershell -NoProfile -File tools/manage-r17-task.ps1 -Mode RunNow'),
        (New-FixtureProcess 502 1 'powershell.exe' 'powershell -NoProfile -File tools/manage-r17-task.ps1 -Mode RunNow'),
        (New-FixtureProcess 503 502 'node.exe' 'node tools/polymarket-research-r18/cli.js'),
        (New-FixtureProcess 511 1 'powershell.exe' 'powershell -NoProfile -File tools/manage-protocol-trigger-scout-v3-task.ps1 -Mode RunScheduled'),
        (New-FixtureProcess 512 1 'powershell.exe' 'powershell -NoProfile -File tools/manage-lido-delta-v6-task.ps1 -Mode RunScheduled'),
        (New-FixtureProcess 601 1 'powershell.exe' 'powershell -NoProfile -File tools/manage-profit-trigger-watch-task.ps1 -Mode Install'),
        (New-FixtureProcess 602 1 'powershell.exe' 'powershell -NoProfile -File tools/manage-profit-trigger-watch-task.ps1 -Mode Status'),
        (New-FixtureProcess 603 1 'powershell.exe' 'powershell -NoProfile -File tools/manage-profit-trigger-watch-task.ps1 -Mode Preflight'),
        (New-FixtureProcess 604 1 'powershell.exe' 'powershell -NoProfile -File tools/manage-profit-trigger-watch-task.ps1 -Mode RunNow'),
        (New-FixtureProcess 605 1 'powershell.exe' 'powershell -Command "echo -File tools/manage-profit-trigger-watch-task.ps1 -Mode RunScheduled"'),
        (New-FixtureProcess 606 1 'powershell.exe' 'powershell -NoProfile -File tools/manage-profit-trigger-watch-task.ps1.backup -Mode RunScheduled'),
        (New-FixtureProcess 607 1 'powershell.exe' 'powershell -NoProfile -File other.ps1 -Argument "tools/manage-profit-trigger-watch-task.ps1" -Mode RunScheduled'),
        (New-FixtureProcess 608 1 'powershell.exe' 'powershell -NoProfile -File tools/manage-r17-task.ps1 -Mode RunScheduled')
    )
    if ($fixtureScenario -in @('persistent-null', 'persistent-whitespace')) {
        $snapshot[0].CommandLine = $null
        if ($fixtureScenario -eq 'persistent-whitespace') { $snapshot[0].CommandLine = '   ' }
    } elseif ($fixtureScenario -in @('transient-readable', 'transient-exited', 'retry-exception')) {
        if ($script:fixtureQueryCount -eq 1) {
            $snapshot += New-FixtureProcess 999 1 'node.exe' $null
            # This readable first-snapshot PID must not survive the full refresh.
            $snapshot += New-FixtureProcess 881 1 'node.exe' 'node tools/watch-wallet-balances.js'
        } elseif ($fixtureScenario -eq 'transient-readable') {
            $snapshot += New-FixtureProcess 999 1 'node.exe' 'node tools/watch-wallet-transactions.js'
        }
    }
    return $snapshot
}
function Get-ScheduledTask {
    param($TaskPath, $ErrorAction)
    @(
        [pscustomobject]@{TaskName='EVMAuditWalletBalances';TaskPath='\';State='Ready';Settings=[pscustomobject]@{Enabled=$true;Hidden=$true};Triggers=@([pscustomobject]@{Repetition=[pscustomobject]@{Interval='PT5M'}});Actions=@([pscustomobject]@{Execute='node.exe';Arguments='private-endpoint-sentinel'})},
        [pscustomobject]@{TaskName='EVMAuditTriggerForkAutopilot';TaskPath='\';State='Disabled';Settings=[pscustomobject]@{Enabled=$false;Hidden=$true};Triggers=@();Actions=@([pscustomobject]@{Execute='powershell.exe';Arguments='-NoProfile -WindowStyle Hidden -File private-path-sentinel'})},
        (New-FixtureHiddenTask 'EVMAuditCanaryFeeds' 'canonical'),
        (New-FixtureHiddenTask 'EVMAuditTriggerCoverageAudit' 'wrong-wrapper'),
        (New-FixtureHiddenTask 'EVMAuditMonitorSetWatchdog' 'wrong-host'),
        (New-FixtureHiddenTask 'EVMAuditWalletTransactions' 'wrapper-suffix'),
        (New-FixtureHiddenTask 'EVM-Audit-Polymarket-R17-R18-15m' 'invalid-payload'),
        (New-FixtureHiddenTask 'EVMAuditMonitorKaminoReduced' 'async'),
        [pscustomobject]@{TaskName='Unmanaged-private-task';TaskPath='\';State='Running'}
    )
}
function Get-ScheduledTaskInfo {
    param($TaskName, $TaskPath, $ErrorAction)
    [pscustomobject]@{NextRunTime=[datetime]'2026-10-18T07:00:00Z';LastRunTime=[datetime]'2026-10-17T07:00:00Z';LastTaskResult=0}
}
. '__SCRIPT__'
$expectedQueries = 2
if ($fixtureScenario -in @('readable', 'exception')) { $expectedQueries = 1 }
if ($script:fixtureQueryCount -ne $expectedQueries) { throw 'UNEXPECTED_QUERY_COUNT' }
'''.replace("__WORKSPACE__", workspace).replace("__SCRIPT__", script).replace(
        "__SCENARIO__", process_scenario)
    executable = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"),
                              "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    child = subprocess.Popen([executable, "-NoProfile", "-NonInteractive", "-Command", harness],
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             creationflags=subprocess.CREATE_NO_WINDOW)
    try:
        stdout, stderr = child.communicate(timeout=15)
    except subprocess.TimeoutExpired:
        child.kill()
        child.communicate()
        pytest.fail("offline PowerShell mock harness timed out")
    assert child.returncode == 0, stderr.decode("utf-8", errors="replace")
    assert len(stdout) <= jobs.MAX_OUTPUT_BYTES and b"private-" not in stdout
    raw = json.loads(stdout.decode("utf-8-sig"))
    assert raw["inspection"]["scheduler"] == "OK"
    if process_scenario in {"persistent-null", "persistent-whitespace", "exception", "retry-exception"}:
        assert raw["inspection"]["processes"] == "ERROR"
        assert all(item["process"]["state"] == "UNKNOWN" for item in raw["jobs"])
        assert all(item["process"]["pid"] is None and item["process"]["pids"] == [] for item in raw["jobs"])
    else:
        assert raw["inspection"]["processes"] == "OK"
        assert find(raw)["process"]["pids"] == [101]
        assert find(raw)["process"]["matchKind"] == "WORKSPACE_PATH"
        assert find(raw)["process"]["state"] == "RUNNING" and find(raw)["process"]["windowVisible"] is None
        morpho = find(raw, "morpho-ws")["process"]
        assert morpho["pids"] == [201, 202] and morpho["pid"] is None and morpho["instanceCount"] == 2
        assert morpho["matchKind"] == "SCRIPT_MATCH"
        profit = find(raw, "profit-trigger-watch")["process"]
        assert profit["pids"] == [302, 303] and profit["pid"] is None and profit["instanceCount"] == 2
        assert find(raw, "polymarket-r17-r18")["process"]["pids"] == [501, 503]
        assert find(raw, "protocol-trigger-scout-v3")["process"]["pids"] == [511]
        assert find(raw, "lido-delta-v6")["process"]["pids"] == [512]
        assert find(raw, "lido-delta-v5")["process"]["state"] == "NOT_RUNNING"
        if process_scenario in {"transient-readable", "transient-exited"}:
            assert find(raw, "wallet-balances")["process"]["state"] == "NOT_RUNNING"
            assert all(881 not in item["process"]["pids"] for item in raw["jobs"])
        transactions = find(raw, "wallet-transactions")["process"]
        if process_scenario == "transient-readable":
            assert transactions["state"] == "RUNNING" and transactions["pids"] == [999]
        else:
            assert transactions["state"] == "NOT_RUNNING" and transactions["pids"] == []
    balance = find(raw, "wallet-balances")
    assert balance["schedule"]["state"] == "READY" and balance["schedule"]["cadenceSeconds"] == 300
    assert balance["schedule"]["hiddenLaunch"] is None
    disabled = find(raw, "trigger-fork-autopilot")
    assert disabled["schedule"]["state"] == "DISABLED" and disabled["schedule"]["enabled"] is False
    assert disabled["schedule"]["hiddenLaunch"] is True
    assert find(raw, "canary-feeds")["schedule"]["hiddenLaunch"] is True
    for ident in ("trigger-coverage-audit", "monitor-set-watchdog", "wallet-transactions", "polymarket-r17-r18", "kamino-reduced"):
        assert find(raw, ident)["schedule"]["hiddenLaunch"] is None
    assert find(raw, "monitor-alerts")["schedule"]["state"] == "MISSING"
