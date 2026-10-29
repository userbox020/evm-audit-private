"""Offline deployment inventory tests; catalog references are never opened."""

import copy
import importlib
import json
import socket
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode

import pytest
from jinja2 import DictLoader

from dashboard.app import create_app
import dashboard.deployed_contracts as deployed
import dashboard.jobs as jobs

ADDRESS = "0x" + "aB" * 20
HASH = "0x" + "cd" * 32
JOB_ID = "aave-v4-executor-watch"
SCRIPT_PATH = "tools/execute-aave-v4-liquidation.js"


def record(**changes):
    result = {
        "id": "alpha", "name": "Alpha executor", "aliases": ["Straße route", "Target #A1"],
        "kind": "executor", "deployment_scope": "workspace_live", "chain_id": 1,
        "chain_name": "Ethereum", "address": ADDRESS, "purpose": "Liquidation settlement",
        "protocols": ["Protocol Alpha"], "funding": "Atomic flash liquidity",
        "capabilities": ["Repay and unwind"], "source_paths": ["contracts/Alpha.sol"],
        "deployment": {"status": "receipt_backed", "label": "Receipt backed",
                       "tx_hash": HASH, "block_number": 123, "observed_at": "2026-10-20T01:02:03Z",
                       "gas_used": "234567", "note": "Historic receipt, not a new verification."},
        "ownership": {"owner_address": "0x" + "12" * 20, "access": "Owner only",
                      "upgradeability": "No upgrade route in recorded source"},
        "code": {"runtime_hash": HASH, "verification": "Recorded runtime evidence only", "compiler": "0.8.30"},
        "runners": [{"job_id": JOB_ID, "label": "Observed executor",
                     "script_id": SCRIPT_PATH, "note": "Process state is not contract readiness."}],
        "readiness": {"state": "held", "label": "Held", "note": "This route requires a fresh bounded approval."},
        "blockers": ["Fresh route evidence missing"],
        "evidence": [{"path": "reports/receipt.json", "lines": "1-20", "note": "Dated record"}],
    }
    result.update(changes)
    return result


def observation():
    return {"observedAt": datetime.now(timezone.utc).isoformat(),
            "inspection": {"processes": "OK", "scheduler": "OK"},
            "jobs": [{"id": JOB_ID, "process": {
                "state": "RUNNING", "pids": [41, 42], "matchKind": "WORKSPACE_PATH"}}]}


def snapshot():
    return jobs.sanitize(observation(), time.time())


@pytest.fixture(autouse=True)
def no_host_inspection(monkeypatch):
    monkeypatch.setattr(jobs, "collect_windows", observation)

    def forbidden(*args, **kwargs):
        pytest.fail("deployment inventory must not start processes or use the network")

    monkeypatch.setattr(subprocess, "Popen", forbidden)
    monkeypatch.setattr(socket, "create_connection", forbidden)


@pytest.fixture
def catalog(tmp_path, monkeypatch):
    path = tmp_path / "fixture-deployments.json"
    monkeypatch.setattr(deployed, "CATALOG_PATH", path)

    def write(records=None, **changes):
        value = {"catalog_as_of": "2026-10-26", "contracts": [record()] if records is None else records,
                 "coverage": {"summary": "Curated workspace records only", "exclusions": ["Forks excluded"],
                              "gaps": ["No fresh chain check"]},
                 "notices": ["A running process does not make a contract armed."]}
        value.update(changes)
        path.write_text(json.dumps(value), encoding="utf-8")
        return path

    write()
    return write


@pytest.fixture
def client(root, catalog):
    app = create_app(root)
    app.config["TESTING"] = True
    # Keep isolated route checks alongside real-template integration below.
    app.jinja_loader = DictLoader({"jobs.html": """{{ title }} {{ jobs.schema }}
        {% for row in deployed.contracts %}{{ row.name }} {{ row.purpose }}
        {% for path in row.source_paths %}{{ path }}{% endfor %}
        {% for item in row.evidence %}{{ item.path }} {{ item.note }}{% endfor %}
        {% endfor %}{{ deployed.filters.contract_q }}"""})
    return app.test_client(use_cookies=False)


@pytest.fixture
def real_client(root, catalog):
    app = create_app(root)
    app.config["TESTING"] = True
    return app.test_client(use_cookies=False)


def request(client, path, method="GET", remote="127.0.0.1", host="127.0.0.1:5050"):
    return client.open(path, method=method, base_url="http://127.0.0.1:5050",
                       environ_overrides={"REMOTE_ADDR": remote, "HTTP_HOST": host})


def test_payload_shape_fixed_date_unknown_metadata(catalog):
    catalog([record(ownership={}, code={}, deployment={"status": "recorded_only"}, readiness={})])
    data = deployed.build_deployed_contracts(snapshot())
    assert set(data) == {"catalog_as_of", "read_only", "live_chain_checked_at", "summary", "filters",
                         "options", "contracts", "coverage", "notices"}
    assert data["catalog_as_of"] == "2026-10-26"
    assert data["read_only"] is True and data["live_chain_checked_at"] is None
    row = data["contracts"][0]
    assert set(row) == {"id", "name", "aliases", "kind", "kind_label", "chain_id", "chain_name", "address",
                        "explorer_url", "purpose", "protocols", "funding", "capabilities", "source_paths",
                        "deployment", "ownership", "code", "runners", "readiness", "blockers", "evidence"}
    assert row["ownership"] == {"owner_address": None, "access": None, "upgradeability": None}
    assert row["code"] == {"runtime_hash": None, "verification": None, "compiler": None}
    assert all(row["deployment"][key] is None for key in ("tx_hash", "tx_url", "block_number", "observed_at", "gas_used"))
    assert row["readiness"]["state"] == "unknown"
    assert row["runners"][0]["state"] == "RUNNING"
    assert data["summary"] == {"total": 1, "matched": 1, "executors": 1, "other_contracts": 0,
                               "receipt_backed": 0, "recorded_only": 1, "chains": 1}


@pytest.mark.parametrize("date_value", ["2026-10-20", "2026-10-20T12:13:14Z"])
def test_catalog_date_is_not_fetch_time(catalog, date_value):
    catalog(catalog_as_of=date_value)
    first = deployed.build_deployed_contracts({})
    second = deployed.build_deployed_contracts(snapshot())
    assert first["catalog_as_of"] == second["catalog_as_of"] == date_value


@pytest.mark.parametrize("reverse", [False, True])
def test_dedupe_chain_address_merges_aliases_evidence_bindings(catalog, reverse):
    weaker = record(name="Earlier name", address=ADDRESS.lower(), aliases=["Old alias"],
                    deployment={"status": "recorded_only", "tx_hash": "0x" + "ef" * 32, "note": "Older note"},
                    source_paths=["contracts/Old.sol"],
                    evidence=[{"path": "notes/deployment.md", "lines": 4, "note": "Recorded address"}],
                    runners=[{"job_id": JOB_ID, "script_id": SCRIPT_PATH, "note": "Second binding note"},
                             {"job_id": None, "script_id": "unregistered.js", "label": "Manual runner"}])
    records = [weaker, record()]
    catalog((list(reversed(records)) if reverse else records) + [record(id="base", chain_id=8453, chain_name="Base")])
    data = deployed.build_deployed_contracts(snapshot())
    assert data["summary"]["total"] == 2 and data["summary"]["chains"] == 2
    row = next(row for row in data["contracts"] if row["chain_id"] == 1)
    assert row["name"] == "Alpha executor"
    assert {"Earlier name", "Old alias", "Straße route", "Target #A1"} <= set(row["aliases"])
    assert set(row["source_paths"]) == {"contracts/Old.sol", "contracts/Alpha.sol"}
    assert {item["path"] for item in row["evidence"]} == {"notes/deployment.md", "reports/receipt.json"}
    assert row["deployment"]["status"] == "receipt_backed"
    assert row["deployment"]["tx_hash"] == HASH and row["deployment"]["block_number"] == 123
    assert "Older note" in row["deployment"]["note"]
    assert len(row["runners"]) == 2
    known = next(runner for runner in row["runners"] if runner["job_id"])
    assert "Second binding note" in known["note"] and "Process state" in known["note"]
    assert known["state"] == "RUNNING"


def multi_catalog(catalog):
    catalog([record(), record(id="helper", name="Base helper", aliases=[], kind="helper", chain_id=8453,
                             chain_name="Base", address="0x" + "23" * 20,
                             deployment={"status": "recorded_only"}),
             record(id="other", name="Testnet contract", aliases=[], kind="other", chain_id=84532,
                    chain_name="Base Sepolia", address="0x" + "34" * 20, deployment_scope="workspace_testnet",
                    deployment={"status": "recorded_only"})])


@pytest.mark.parametrize("filters,expected", [
    ({"contract_chain": "1"}, ["alpha"]),
    ({"contract_chain": "8453"}, ["helper"]),
    ({"contract_kind": "other"}, ["other"]),
    ({"contract_evidence": "receipt_backed"}, ["alpha"]),
    ({"contract_evidence": "recorded_only"}, ["helper", "other"]),
    ({"contract_chain": "8453", "contract_kind": "helper", "contract_evidence": "recorded_only", "contract_q": "BASE"}, ["helper"]),
    ({"contract_chain": "8453", "contract_kind": "executor"}, []),
    ({"contract_q": " STRASSE "}, ["alpha"]),
    ({"contract_q": "target #a1"}, ["alpha"]),
    ({"contract_q": "contracts/alpha.sol"}, ["alpha", "helper", "other"]),
    ({"contract_q": ADDRESS.lower()}, ["alpha"]),
    ({"contract_q": "repay and unwind"}, ["alpha", "helper", "other"]),
])
def test_exact_combined_search_filters_global_counts(catalog, filters, expected):
    multi_catalog(catalog)
    data = deployed.build_deployed_contracts({}, filters)
    assert [row["id"] for row in data["contracts"]] == expected
    assert data["summary"] == {"total": 3, "matched": len(expected), "executors": 1, "other_contracts": 2,
                               "receipt_backed": 1, "recorded_only": 2, "chains": 3}
    assert {option["value"] for option in data["options"]["chains"]} == {"1", "8453", "84532"}


@pytest.mark.parametrize("key,value", [
    ("contract_chain", "01"), ("contract_chain", " 1"), ("contract_chain", "999"),
    ("contract_chain", "Ethereum"), ("contract_kind", "Executor"), ("contract_kind", "executor "),
    ("contract_kind", "all"), ("contract_evidence", "RECEIPT_BACKED"), ("contract_evidence", "unknown"),
])
def test_invalid_exact_filters_do_not_widen(catalog, key, value):
    data = deployed.build_deployed_contracts({}, {key: value})
    assert data["filters"][key] == value
    assert data["contracts"] == [] and data["summary"]["total"] == 1


def test_search_bound(catalog):
    data = deployed.build_deployed_contracts({}, {"contract_q": "  " + "X" * 250 + "  "})
    assert data["filters"]["contract_q"] == "X" * 200


@pytest.mark.parametrize("changes", [
    {"deployment_scope": scope} for scope in (None, "fork", "staged", "third_party", "workspace_fork", [], "")
] + [{"address": address} for address in (None, "0x" + "0" * 40, "0x1234", "0x" + "gg" * 20,
                                         "https://example.invalid/address", " " + ADDRESS)]
  + [{"chain_id": chain} for chain in (None, True, 0, -1, "1", 1.0, [], 2**53)]
  + [{"kind": kind} for kind in (None, "fork", "Executor", [])]
  + [{"deployment": {"status": status}} for status in (None, "source_only", "staged", [])])
def test_invalid_scope_identity_and_enums_excluded(catalog, changes):
    catalog([record(**changes)])
    data = deployed.build_deployed_contracts({})
    assert data["summary"]["total"] == 0
    assert "1 invalid or out-of-scope" in data["coverage"]["exclusions"][-1]


@pytest.mark.parametrize("chain,base", [(chain, spec[1]) for chain, spec in deployed.EXPLORERS.items()])
def test_only_fixed_explorer_urls(catalog, chain, base):
    raw = record(chain_id=chain, explorer_url="javascript:bad()", tx_url="https://example.invalid")
    raw["deployment"]["tx_url"] = "javascript:bad()"
    catalog([raw])
    row = deployed.build_deployed_contracts({})["contracts"][0]
    assert row["explorer_url"] == base + "/address/" + ADDRESS
    assert row["deployment"]["tx_url"] == base + "/tx/" + HASH
    assert "javascript:" not in json.dumps(row)


def test_unknown_chain_and_invalid_optional_metadata(catalog):
    raw = record(chain_id=999999, chain_name=None,
                 ownership={"owner_address": "javascript:owner"},
                 code={"runtime_hash": "not a hash"},
                 readiness={"state": "armed", "label": "Ready", "note": "Unsafe promotion"})
    raw["deployment"].update(tx_hash="0x123", block_number=True, gas_used=-1, observed_at="not a date")
    catalog([raw], catalog_as_of="not a date")
    data = deployed.build_deployed_contracts({})
    row = data["contracts"][0]
    assert row["explorer_url"] is None and row["chain_name"] is None
    assert row["ownership"]["owner_address"] is None and row["code"]["runtime_hash"] is None
    assert all(row["deployment"][key] is None for key in ("tx_hash", "tx_url", "block_number", "gas_used", "observed_at"))
    assert row["readiness"]["state"] == "unknown" and row["readiness"]["label"] == "Unknown"
    assert data["catalog_as_of"] is None


def test_reads_only_catalog_not_references(catalog, monkeypatch):
    raw = record(source_paths=["../../never-open.sol", "https://example.invalid/source"],
                 evidence=[{"path": "../../never-open.json", "lines": "1-4", "note": "Reference only"}])
    path = catalog([raw])
    original = Path.read_text
    reads = []

    def fixed_read(self, *args, **kwargs):
        assert self == path, "source/evidence reference was followed"
        reads.append(self)
        return original(self, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", fixed_read)
    data = deployed.build_deployed_contracts({})
    assert reads == [path]
    assert data["contracts"][0]["source_paths"] == raw["source_paths"]
    assert data["contracts"][0]["evidence"] == raw["evidence"]


@pytest.mark.parametrize("content", [None, "not-json", "[]", "{}", '{"contracts":{}}'])
def test_unavailable_catalog_is_honest_and_lazy(catalog, content):
    path = catalog()
    if content is None:
        path.unlink()
    else:
        path.write_text(content, encoding="utf-8")
    data = deployed.build_deployed_contracts(snapshot())
    assert data["contracts"] == [] and data["catalog_as_of"] is None
    assert "unavailable" in data["coverage"]["summary"]
    assert data["coverage"]["gaps"]


def test_runner_projection_and_script_match_warning(catalog):
    snap = snapshot()
    process = next(row for row in snap["jobs"] if row["id"] == JOB_ID)["process"]
    process.update(pids=[42, 41, 42], matchKind="SCRIPT_MATCH")
    before = copy.deepcopy(snap)
    row = deployed.build_deployed_contracts(snap)["contracts"][0]
    runner = row["runners"][0]
    assert runner["state"] == "RUNNING" and runner["pids"] == [41, 42]
    assert runner["match_kind"] == "SCRIPT_MATCH" and "workspace identity is not confirmed" in runner["note"]
    assert runner["observed_at"] == snap["observedAt"] and runner["url"] == f"#job-{JOB_ID}"
    assert row["readiness"]["state"] == "held" and snap == before


@pytest.mark.parametrize("changes", [
    {"freshness": "STALE"}, {"freshness": "UNAVAILABLE"}, {"freshness": None},
    {"inspection": {"processes": "ERROR", "scheduler": "OK"}}, {"inspection": []},
    {"observedAt": None}, {"observedAt": "not a date"}, {"observedAt": "2026-10-26"},
    {"observedAt": "2026-10-26T00:00:00"},
])
@pytest.mark.parametrize("state", ["RUNNING", "NOT_RUNNING"])
def test_stale_or_unavailable_runner_state_withheld(catalog, changes, state):
    snap = snapshot()
    job = next(row for row in snap["jobs"] if row["id"] == JOB_ID)
    if state == "NOT_RUNNING":
        job["process"].update(state=state, pids=[], matchKind="NONE")
    snap.update(changes)
    runner = deployed.build_deployed_contracts(snap)["contracts"][0]["runners"][0]
    assert runner["state"] == "UNKNOWN" and runner["pids"] == []
    assert runner["match_kind"] == "NONE"


@pytest.mark.parametrize("process", [None, [], {},
    {"state": "RUNNING", "pids": [True], "matchKind": "WORKSPACE_PATH"},
    {"state": "RUNNING", "pids": [-1], "matchKind": "WORKSPACE_PATH"},
    {"state": "RUNNING", "pids": [1, "2"], "matchKind": "WORKSPACE_PATH"},
    {"state": "RUNNING", "pids": [], "matchKind": "WORKSPACE_PATH"},
    {"state": "RUNNING", "pids": [1], "matchKind": []},
    {"state": "RUNNING", "pids": [1], "matchKind": "NONE"},
    {"state": "NOT_RUNNING", "pids": [1], "matchKind": "NONE"},
    {"state": "DISABLED", "pids": [], "matchKind": "NONE"},
])
def test_malformed_process_never_exposes_pids(catalog, process):
    snap = snapshot()
    next(row for row in snap["jobs"] if row["id"] == JOB_ID)["process"] = process
    runner = deployed.build_deployed_contracts(snap)["contracts"][0]["runners"][0]
    assert runner["state"] == "UNKNOWN" and runner["pids"] == []


def test_confirmed_absence_only_from_fresh_process_inspection(catalog):
    snap = snapshot()
    next(row for row in snap["jobs"] if row["id"] == JOB_ID)["process"].update(
        state="NOT_RUNNING", pids=[], matchKind="NONE")
    runner = deployed.build_deployed_contracts(snap)["contracts"][0]["runners"][0]
    assert runner["state"] == "NOT_RUNNING" and runner["pids"] == []


@pytest.mark.parametrize("binding", [
    {"job_id": None, "script_id": SCRIPT_PATH},
    {"job_id": "unknown-job", "script_id": SCRIPT_PATH},
    {"job_id": JOB_ID, "script_id": "tools/unregistered.js"},
    {"job_id": JOB_ID, "script_id": SCRIPT_PATH + ".backup"},
    {"job_id": JOB_ID, "script_id": None},
    {"job_id": "../" + JOB_ID, "script_id": SCRIPT_PATH},
    {"job_id": JOB_ID, "script_id": JOB_ID},
    {"job_id": JOB_ID, "script_id": "execute-aave-v4-liquidation.js"},
    {"job_id": JOB_ID, "script_id": " " + SCRIPT_PATH},
    {"job_id": JOB_ID, "script_id": SCRIPT_PATH.replace("/", "\\")},
    {"job_id": JOB_ID, "script_id": SCRIPT_PATH.upper()},
])
def test_unmapped_bindings_not_stopped_or_guessed(catalog, binding):
    catalog([record(runners=[dict(binding, state="RUNNING", pids=[9876], url="javascript:bad()")])])
    runner = deployed.build_deployed_contracts(snapshot())["contracts"][0]["runners"][0]
    assert runner["state"] == "UNMAPPED" and runner["pids"] == []
    assert runner["url"] is None and runner["observed_at"] is None


@pytest.mark.parametrize("malformation", ["duplicate", "missing-script", "invalid-script", "wrong-id", "path-instead-of-id", "missing-row"])
def test_malformed_snapshot_rows_unknown(catalog, malformation):
    snap = snapshot()
    job = next(row for row in snap["jobs"] if row["id"] == JOB_ID)
    if malformation == "duplicate":
        snap["jobs"].append(copy.deepcopy(job))
    elif malformation == "missing-row":
        snap["jobs"].remove(job)
    else:
        job["scriptId"] = {"missing-script": None, "invalid-script": [],
                           "wrong-id": "novelty-monitor", "path-instead-of-id": SCRIPT_PATH}[malformation]
    runner = deployed.build_deployed_contracts(snap)["contracts"][0]["runners"][0]
    assert runner["state"] == "UNKNOWN" and runner["pids"] == []


@pytest.mark.parametrize("path", ["/jobs", "/api/v1/jobs/contracts"])
def test_single_snapshot_and_isolated_routes(client, monkeypatch, path):
    app_module = importlib.import_module("dashboard.app")
    calls = []
    snap = snapshot()
    monkeypatch.setattr(client.application.extensions["jobs_inspector"], "snapshot", lambda: calls.append(1) or snap)

    def forbidden(*args, **kwargs):
        pytest.fail("unrelated collector or dashboard snapshot called")

    for name in ("snapshot", "build_canary", "build_ops"):
        monkeypatch.setattr(app_module, name, forbidden)
    response = request(client, path)
    assert response.status_code == 200 and calls == [1]
    if path.startswith("/api/"):
        assert response.get_json() == deployed.build_deployed_contracts(snap)
    else:
        assert "Jobs audit-jobs/v1" in response.get_data(as_text=True)


def test_existing_jobs_api_schema_and_behavior_unchanged(client, monkeypatch):
    app_module = importlib.import_module("dashboard.app")
    snap = snapshot()
    calls = []
    monkeypatch.setattr(client.application.extensions["jobs_inspector"], "snapshot", lambda: calls.append(1) or snap)

    def forbidden(*args, **kwargs):
        pytest.fail("existing Jobs API must not load deployment inventory")

    monkeypatch.setattr(app_module, "build_deployed_contracts", forbidden)
    response = request(client, "/api/v1/jobs?contract_kind=helper&ignored=" + "x" * 4100)
    assert response.status_code == 200 and response.get_json() == snap and calls == [1]


@pytest.mark.parametrize("path", ["/jobs", "/api/v1/jobs/contracts"])
def test_query_size_bound_before_snapshot(client, monkeypatch, path):
    calls = []
    monkeypatch.setattr(client.application.extensions["jobs_inspector"], "snapshot", lambda: calls.append(1) or snapshot())
    assert request(client, path + "?x=" + "a" * 4094).status_code == 200
    assert calls == [1]
    assert request(client, path + "?x=" + "a" * 4095).status_code == 400
    assert calls == [1]


@pytest.mark.parametrize("path", ["/jobs", "/api/v1/jobs/contracts"])
def test_local_method_and_csp_guards(client, path):
    response = request(client, path)
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-store"
    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert response.headers["Referrer-Policy"] == "no-referrer"
    assert "default-src 'self'" in response.headers["Content-Security-Policy"]
    for method in ("POST", "PUT", "PATCH", "DELETE"):
        assert request(client, path, method).status_code == 405
    for host in ("example.com", "127.0.0.1.evil.test:5050", "localhost:0"):
        assert request(client, path, host=host).status_code == 403
    assert request(client, path, remote="192.0.2.4").status_code == 403
    assert request(client, path, method="HEAD").status_code == 200


def test_api_filters_route_name_and_no_executors_route(client, catalog):
    multi_catalog(catalog)
    response = request(client, "/api/v1/jobs/contracts?contract_chain=8453&contract_kind=helper&contract_evidence=recorded_only")
    assert [row["id"] for row in response.get_json()["contracts"]] == ["helper"]
    assert "deployed_contracts_api" in client.application.view_functions
    assert request(client, "/executors").status_code == 404


def test_template_escapes_catalog_and_filters(client, catalog):
    marker = '<img src=x onerror="bad()">'
    catalog([record(name=marker, purpose=marker, source_paths=[marker], evidence=[{"path": marker, "note": marker}])])
    text = request(client, "/jobs").get_data(as_text=True)
    assert "<img" not in text and text.count("&lt;img") == 5
    text = request(client, "/jobs?contract_q=%3Cscript%3Ebad()%3C/script%3E").get_data(as_text=True)
    assert "<script>" not in text and "&lt;script&gt;" in text


def test_actual_v4_path_maps_to_normalized_snapshot_id(catalog):
    spec = next(spec for spec in jobs.CATALOG if spec["id"] == JOB_ID)
    assert spec["script"] == SCRIPT_PATH and not spec.get("aliases")
    snap = snapshot()
    job = next(row for row in snap["jobs"] if row["id"] == JOB_ID)
    assert job["scriptId"] == JOB_ID and snap["freshness"] == "FRESH"
    runner = deployed.build_deployed_contracts(snap)["contracts"][0]["runners"][0]
    assert runner["script_id"] == SCRIPT_PATH
    assert runner["state"] == "RUNNING" and runner["pids"] == [41, 42]
    assert runner["url"] == f"#job-{JOB_ID}"


@pytest.mark.parametrize("script", ["tools/execute-top-whale-trigger.js", "tools/watch-top-whale-triggers.js"])
def test_combined_watcher_executor_never_implies_executor_liveness(catalog, script):
    ident = "top-whale-trigger-executor"
    spec = next(spec for spec in jobs.CATALOG if spec["id"] == ident)
    assert "tools/watch-top-whale-triggers.js" in spec["aliases"]
    raw = observation()
    raw["jobs"][0]["id"] = ident
    snap = jobs.sanitize(raw, time.time())
    assert next(row for row in snap["jobs"] if row["id"] == ident)["process"]["state"] == "RUNNING"
    catalog([record(runners=[{"job_id": ident, "script_id": script}])])
    runner = deployed.build_deployed_contracts(snap)["contracts"][0]["runners"][0]
    assert runner["state"] in {"UNKNOWN", "UNMAPPED"} and runner["pids"] == []
    assert runner["match_kind"] == "NONE"
    if script == spec["script"]:
        assert "combines script aliases" in runner["note"]


def test_unregistered_id_cannot_be_registered_by_snapshot(catalog):
    ident = "unregistered-executor"
    assert ident not in deployed.JOB_SPECS
    catalog([record(runners=[{"job_id": ident, "script_id": SCRIPT_PATH}])])
    snap = snapshot()
    job = copy.deepcopy(next(row for row in snap["jobs"] if row["id"] == JOB_ID))
    snap["jobs"].append(dict(job, id=ident, scriptId=ident))
    runner = deployed.build_deployed_contracts(snap)["contracts"][0]["runners"][0]
    assert runner["state"] == "UNMAPPED" and runner["pids"] == [] and runner["url"] is None


def test_real_template_filters_global_counts_and_original_register(real_client, catalog):
    multi_catalog(catalog)
    response = request(real_client, "/jobs")
    assert response.status_code == 200
    full = response.get_data(as_text=True)
    query = urlencode({"contract_q": "base", "contract_chain": "8453", "contract_kind": "helper",
                       "contract_evidence": "recorded_only"})
    response = request(real_client, "/jobs?" + query)
    assert response.status_code == 200
    filtered = response.get_data(as_text=True)
    for html in (full, filtered):
        assert 'id="jobs-register"' in html and 'id="deployed-contracts"' in html
        assert html.count('<th scope="row" id="job-') == len(jobs.CATALOG)
        assert f'id="job-{JOB_ID}"' in html and '<a href="/api/v1/jobs">View JSON</a>' in html
        assert '<dt>Recorded deployments</dt><dd>3</dd>' in html
        assert '<dt>Receipt recorded</dt><dd>1</dd>' in html
        assert '<dt>Deployment record only</dt><dd>2</dd>' in html
        assert '<dt>Other contracts</dt><dd>2</dd>' in html
    assert '<strong>3</strong> matching / 3 recorded deployments' in full
    assert '<strong>1</strong> matching / 3 recorded deployments' in filtered
    assert 'id="contract-helper"' in filtered
    assert 'id="contract-alpha"' not in filtered and 'id="contract-other"' not in filtered
    assert '<option value="8453" selected>' in filtered and '<option value="helper" selected>' in filtered
    full_register = full.split('<section class="jobs-register"', 1)[1].split('</section>', 1)[0]
    filtered_register = filtered.split('<section class="jobs-register"', 1)[1].split('</section>', 1)[0]
    assert full_register == filtered_register and '41, 42' in full_register


def test_real_template_escapes_catalog_query_and_invalid_filter(real_client, catalog):
    marker = '<img src=x onerror="bad()">'
    catalog([record(name=marker, purpose=marker, source_paths=[marker],
                    evidence=[{"path": marker, "note": marker}])])
    text = request(real_client, "/jobs").get_data(as_text=True)
    assert '<img' not in text and text.count('&lt;img') == 5
    query = urlencode({"contract_q": '<script>bad()</script>', "contract_kind": marker})
    response = request(real_client, "/jobs?" + query)
    assert response.status_code == 200
    text = response.get_data(as_text=True)
    assert '<img' not in text and '<script>bad()' not in text
    assert '&lt;script&gt;bad()&lt;/script&gt;' in text and 'Unrecognized: &lt;img' in text
    assert 'No contracts match these filters' in text
    assert '<strong>0</strong> matching / 1 recorded deployments' in text
    assert 'id="jobs-register"' in text and f'id="job-{JOB_ID}"' in text
