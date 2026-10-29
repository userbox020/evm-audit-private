import copy
import importlib
import json

import pytest

from conftest import get
from dashboard.artifacts import ALLOWLIST, ArtifactReader
from dashboard.targets import build_curated_targets, build_targets
from test_targets import NOW, SENTINEL, V4_WATCH, fixtures, iso, pin, put, rows


WATCH = "rank1_aave_v4_v2_watch"
TARGET = "target1_AaveV4_USDe_USDC"
DISPLAY = "target-1-aave-v4-usde-usdc"
BORROWER = "0x1cb432f80416f07db4420b8c20447924a0658894"
SPOKE = "0xba1b3d55d249692b669a164024a838309b7508af"
EXECUTOR = "0x3c02c96bbb423d0109b823c23a05fcf0bf91ecb7"
OWNER = "0x24e46e91dfaad1fa3d49c48aa85ca9306885ce0a"


def status(**changes):
    return {
        "targetId": TARGET, "borrower": BORROWER, "spoke": SPOKE,
        "owner": OWNER, "deployedExecutor": EXECUTOR, "collectionScope": "RANK1_ONLY",
        "checkedAt": iso(NOW - 3), "scheduled": True, "terminal": False,
        "executionReady": False, "armed": False, "ok": True, "mode": "STANDBY",
        "pin": pin(block=1002, age=3),
        "targets": [{"id": "spokeA-candidate1-usde-usdc", "borrower": BORROWER, "spoke": SPOKE,
                     "healthFactorRaw": "1000000000000000001", "bpsToLiquidation": "0.000001",
                     "isLiquidatableBothProviders": False, "liquidatable": False, "mode": "CURRENT"}],
        **changes,
    }


def write_inputs(root, data=None, report=None):
    for key, value in (fixtures() if data is None else data).items():
        put(root, key, value)
    if report is not None:
        put(root, WATCH, report)


@pytest.fixture(params=[build_curated_targets, build_targets], ids=["curated", "public"])
def build_view(request):
    return request.param


def test_isolated_allowlist_preserves_legacy_path():
    assert ALLOWLIST[WATCH] == "reports/raw/fast/rank1-aave-v4-v2-watch.json"
    assert ALLOWLIST[V4_WATCH] == "reports/raw/fast/aave-v4-executor-live-watch.json"


@pytest.mark.parametrize("child_mode", ["CURRENT", "NEXT_BLOCK_PASSIVE"])
def test_v2_only_standby_keeps_sentinel_health_forecast_and_quote(root, build_view, child_mode):
    data = fixtures()
    del data[V4_WATCH]
    report = status()
    report["targets"][0]["mode"] = child_mode
    write_inputs(root, data, report)
    row = rows(build_view(ArtifactReader(root), NOW))[DISPLAY]
    runner = row["runner"]
    assert runner["label"] == "Dedicated Aave V4 #1 v2"
    assert runner["mode"] == "STANDBY" and runner["source"] == WATCH
    assert runner["freshness"] == "FRESH" and runner["age_text"] == "3s"
    assert runner["checked_at"] == iso(NOW - 3)
    assert runner["scheduled"] is row["scheduled"] is True
    assert runner["terminal"] is row["terminal"] is False
    assert runner["execution_ready"] is row["execution_ready"] is False
    assert runner["reported_armed"] is row["armed"] is row["executable_now"] is False
    assert row["calldata_ready"] is False
    assert runner["reason_text"] == row["readiness_note"] == "Monitoring; no execution proof yet"
    assert float(row["health_factor"]) == 1.01
    assert row["observation"]["source"] == row["quote"]["source"] == SENTINEL
    assert row["observation"]["block"] == row["quote"]["block"] == 1000
    assert row["position"]["passive_hours"] == "12.3"
    assert row["executor_address"] == EXECUTOR


@pytest.mark.parametrize("legacy_stale", [False, True])
def test_only_rank1_runner_changes_and_v2_wins_over_legacy(root, build_view, legacy_stale):
    data = fixtures()
    if legacy_stale:
        data[V4_WATCH].update(checkedAt=iso(NOW - 5000), pin=pin(block=1001, age=5000))
    write_inputs(root, data)
    before = build_view(ArtifactReader(root), NOW)
    put(root, WATCH, status())
    after = build_view(ArtifactReader(root), NOW)
    old_rows, new_rows = rows(before), rows(after)
    assert old_rows.keys() == new_rows.keys()
    for ident in old_rows.keys() - {DISPLAY}:
        assert new_rows[ident] == old_rows[ident]
    assert after["runners"] == before["runners"]
    assert new_rows[DISPLAY]["runner"]["source"] == WATCH
    assert new_rows[DISPLAY]["runner"]["freshness"] == "FRESH"
    assert new_rows[DISPLAY]["runner"]["reported_armed"] is False
    for field in ("observation", "quote", "position", "health_factor", "bps_to_liq"):
        assert new_rows[DISPLAY][field] == old_rows[DISPLAY][field]


@pytest.mark.parametrize("scheduled,terminal,prefix", [(False, True, "Stopped"), (True, False, "Monitoring")])
def test_prepin_hold_has_status_freshness_not_fabricated_health(root, build_view, scheduled, terminal, prefix):
    report = status(ok=False, mode="HOLD", targets=[], scheduled=scheduled, terminal=terminal)
    del report["pin"]
    write_inputs(root, report=report)
    row = rows(build_view(ArtifactReader(root), NOW))[DISPLAY]
    runner = row["runner"]
    assert runner["mode"] == "HOLD" and runner["source"] == WATCH
    assert runner["freshness"] == "FRESH" and runner["checked_at"] == iso(NOW - 3)
    assert runner["scheduled"] is scheduled and runner["terminal"] is terminal
    assert runner["reason_text"] == f"{prefix}; on hold; no execution proof yet"
    assert runner["execution_ready"] is runner["reported_armed"] is False
    assert runner["reason_text"] in row["blockers"]


def test_check_only_finished_is_stopped_not_armed(root, build_view):
    write_inputs(root, report=status(mode="CHECK_ONLY", scheduled=False, terminal=True))
    runner = rows(build_view(ArtifactReader(root), NOW))[DISPLAY]["runner"]
    assert runner["mode"] == "CHECK_ONLY" and runner["terminal"] is True
    assert runner["scheduled"] is runner["execution_ready"] is runner["reported_armed"] is False
    assert runner["reason_text"] == "Stopped; check only"


@pytest.mark.parametrize("where,field", [
    ("root", "targetId"), ("root", "borrower"), ("root", "spoke"),
    ("root", "deployedExecutor"), ("root", "owner"), ("root", "collectionScope"),
    ("child", "id"), ("child", "borrower"), ("child", "spoke"),
])
def test_full_identity_mismatch_cannot_fall_back_to_old_armed(root, build_view, where, field):
    report = status()
    (report if where == "root" else report["targets"][0])[field] = "0x" + "ef" * 20
    write_inputs(root, report=report)
    runner = rows(build_view(ArtifactReader(root), NOW))[DISPLAY]["runner"]
    assert runner["source"] == WATCH and runner["freshness"] == "UNKNOWN"
    assert runner["mode"] is runner["checked_at"] is runner["reported_armed"] is None
    assert runner["execution_ready"] is False
    assert runner["reason_text"] == "Runner status unavailable"


@pytest.mark.parametrize("field,value", [
    ("checkedAt", True), ("checkedAt", NOW), ("checkedAt", "bad"),
    ("checkedAt", "2026-02-30T00:00:00Z"), ("checkedAt", "2026-10-24"),
    ("checkedAt", "2026-10-24T00:00:00"),
    ("scheduled", 1), ("scheduled", "true"), ("terminal", 0), ("terminal", None),
    ("executionReady", 1), ("executionReady", "false"), ("executionReady", True),
    ("armed", 0), ("armed", True), ("ok", 1), ("mode", "UNKNOWN"), ("mode", {}),
    ("targets", {}), ("pin", None),
])
def test_malformed_fields_are_unavailable_not_ready(root, field, value):
    write_inputs(root, report=status(**{field: value}))
    runner = rows(build_targets(ArtifactReader(root), NOW))[DISPLAY]["runner"]
    assert runner["freshness"] == "UNKNOWN" and runner["reported_armed"] is None
    assert runner["execution_ready"] is False and runner["scheduled"] is runner["terminal"] is None


@pytest.mark.parametrize("mutation", ["duplicate", "bool_health", "bool_bps", "bool_liquidatable", "bool_pin", "bool_chain", "contradictory_lifecycle"])
def test_malformed_nested_status_and_lifecycle_fail_closed(root, mutation):
    report = status()
    if mutation == "duplicate":
        report["targets"].append(copy.deepcopy(report["targets"][0]))
    elif mutation == "contradictory_lifecycle":
        report["terminal"] = True
    elif mutation in {"bool_pin", "bool_chain"}:
        report["pin"]["timestamp" if mutation == "bool_pin" else "chainId"] = True
    else:
        report["targets"][0][{"bool_health": "healthFactorRaw", "bool_bps": "bpsToLiquidation", "bool_liquidatable": "liquidatable"}[mutation]] = True if mutation != "bool_liquidatable" else 1
    write_inputs(root, report=report)
    assert rows(build_targets(ArtifactReader(root), NOW))[DISPLAY]["runner"]["freshness"] == "UNKNOWN"


@pytest.mark.parametrize("age,expected", [(1800, "AGING"), (5000, "STALE"), (-301, "CLOCK_SKEW")])
def test_stale_or_future_status_does_not_inherit_fresh_legacy_arming(root, build_view, age, expected):
    write_inputs(root, report=status(checkedAt=iso(NOW - age)))
    row = rows(build_view(ArtifactReader(root), NOW))[DISPLAY]
    runner = row["runner"]
    assert runner["freshness"] == expected and runner["checked_at"] == iso(NOW - age)
    assert runner["reported_armed"] is runner["scheduled"] is runner["terminal"] is None
    assert runner["execution_ready"] is row["armed"] is False
    assert "unknown" in runner["reason_text"] or "unavailable" in runner["reason_text"]


def test_missing_fixed_executor_status_cannot_reuse_legacy_armed(root, build_view):
    data = fixtures()
    data[V4_WATCH]["deployedExecutor"] = EXECUTOR
    write_inputs(root, data)
    runner = rows(build_view(ArtifactReader(root), NOW))[DISPLAY]["runner"]
    assert runner["source"] == WATCH and runner["freshness"] == "UNKNOWN"
    assert runner["reported_armed"] is None and runner["execution_ready"] is False


def test_cached_status_is_never_reused_after_corruption_or_removal(root, build_view):
    write_inputs(root, report=status())
    reader = ArtifactReader(root)
    assert rows(build_view(reader, NOW))[DISPLAY]["runner"]["freshness"] == "FRESH"
    path = root / ALLOWLIST[WATCH]
    path.write_text("{invalid", encoding="utf8")
    for missing in (False, True):
        if missing:
            path.unlink()
        runner = rows(build_view(reader, NOW))[DISPLAY]["runner"]
        assert reader.read_status[WATCH]["last_good"] is True
        assert runner["freshness"] == "UNKNOWN" and runner["checked_at"] is None
        assert runner["reported_armed"] is None and runner["execution_ready"] is False


def test_opaque_text_and_capability_flags_never_create_labels_or_proof(root, build_view):
    poison = "<script>SECRET https://private.invalid/token .env</script>"
    report = status(label=poison, reason=poison, factoryReady=True, futureCapabilityReady=True, processedCount=99)
    report["targets"][0]["reason"] = poison
    write_inputs(root, report=report)
    view = build_view(ArtifactReader(root), NOW)
    assert "SECRET" not in json.dumps(view)
    runner = rows(view)[DISPLAY]["runner"]
    assert runner["reason_text"] == "Monitoring; no execution proof yet"
    assert runner["execution_ready"] is False


@pytest.mark.parametrize("reported_ready", [False, True])
def test_attempt_mode_does_not_make_healthy_check_execution_ready(root, build_view, reported_ready):
    report = status(mode="ATTEMPTED", executionReady=reported_ready)
    report["targets"][0].update(liquidatable=True, isLiquidatableBothProviders=True)
    write_inputs(root, report=report)
    runner = rows(build_view(ArtifactReader(root), NOW))[DISPLAY]["runner"]
    assert runner["execution_ready"] is False
    assert runner["freshness"] == ("UNKNOWN" if reported_ready else "FRESH")
    if not reported_ready:
        assert runner["reason_text"] == "Monitoring; execution attempt reported; success not established"


def test_existing_route_renders_status_without_artifact_writes(root, client, monkeypatch):
    write_inputs(root, report=status())
    before = {p: p.read_bytes() for p in root.rglob("*.json")}
    monkeypatch.setattr(importlib.import_module("dashboard.app").time, "time", lambda: NOW)
    response = get(client, "/api/v1/targets?page_size=100")
    assert response.status_code == 200
    assert rows(response.json)[DISPLAY]["runner"]["source"] == WATCH
    html = get(client, "/targets?page_size=100").get_data(as_text=True)
    assert "Dedicated Aave V4 #1 v2" in html
    assert "Monitoring; no execution proof yet" in html
    assert {p: p.read_bytes() for p in root.rglob("*.json")} == before
