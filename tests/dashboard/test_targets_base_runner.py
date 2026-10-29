"""Offline scoped Base runner telemetry; never health or execution authority."""

import copy
import importlib
import json

import pytest

from conftest import get
from dashboard import ops, target_sources as sources
from dashboard.artifacts import ALLOWLIST
from dashboard.targets import BASE_EXECUTOR, BASE_UNIVERSAL_EXECUTOR, BASE_EULER_EVK_EXECUTOR, BASE_WATCH, MORPHO, build_targets
from test_target_sources import NOW, Reader, address, block, coverage, iso


CASES = (
    ("base-b8-wsteth-weth-0x10c5", "0x10c53e75fe7a7e6bf58a9e68b6a30fcc7d4e6e2c", "0x6aa81f51dfc955df598e18006deae56ce907ac02b0b5358705f1a28fcea23cc0", BASE_EXECUTOR),
    ("base-b10-yousd-usdc-0xd406", "0xd406c93c8227ef08dc8ef0dfa027786bb85b756b", ops.BASE_YOUSD_MARKET, BASE_EXECUTOR),
    ("base-b7-yousd-usdc-0x108b", "0x108b853407284e77656c569677c82e8fed581299", ops.BASE_YOUSD_MARKET, BASE_EXECUTOR),
    ("base-b0-usde-usdc-0x6075", "0x60753e8622a6cfea1df449a9625a9778bb922b72", ops.BASE_USDE_MARKET, BASE_EXECUTOR),
    ("base-b4-usde-usdc-0x7dcd", "0x7dcdb4ad4017f848879d17370aa6f32564e5cd08", ops.BASE_USDE_MARKET, BASE_EXECUTOR),
    ("base-b5-usde-usdc-0x8986", "0x8986f93988d415abfb7b9bb700ccd3580c2f5298", ops.BASE_USDE_MARKET, BASE_EXECUTOR),
    ("base-b6-usde-usdc-0xae0a", "0xae0a739c3724bb5cd2bdcf73764c87a5a6ec21a3", ops.BASE_USDE_MARKET, BASE_EXECUTOR),
    ("base-b1-usde-usdc-0xb4fb", "0xb4fb31e7b1471a8e52dd1e962a281a732ead59c1", ops.BASE_USDE_MARKET, BASE_EXECUTOR),
    ("base-b2-usde-usdc-0x7bee", "0x7bee8d37fba61a6251a08b957d502c56e2a50fab", ops.BASE_USDE_MARKET, BASE_EXECUTOR),
    ("base-b14-usde-usdc-0x6efc", "0x6efc48b8b6222924fa6ea95d174af5518b761177", ops.BASE_USDE_MARKET, BASE_EXECUTOR),
    ("base-b15-yousd-usdc-0x5c2a", "0x5c2a8098c392fde0fa736e598ced595a9d6eb0b8", ops.BASE_YOUSD_MARKET, BASE_EXECUTOR),
    ("base-b9-weeth-weth-0x9558", "0x9558b339bb03246c44c57fcee184645dbfab253f", "0xfd0895ba253889c243bf59bc4b96fd1e06d68631241383947b04d1c293a0cfea", BASE_EXECUTOR),
    ("base-b11-fluid48-susdai-usdc", "0x7e0371ec1177d3cf177a1a9a87dbc1e1864cd828", "0x59fa2f51f5c8fffceb538180ec47a869ec3dbd4a", BASE_UNIVERSAL_EXECUTOR),
    ("base-b12-euler-wtspym-usdc", "0x17914d576bd7d14a14bdf187d1c72b194c61e358", "0x4c1aeda9b43efcf1da1d1755b18802aabe90f61e", BASE_EULER_EVK_EXECUTOR),
    ("base-b13-euler-wtcoin-usdc", "0x17914d576bd7d14a14bdf187d1c72b194c61e35b", "0x4c1aeda9b43efcf1da1d1755b18802aabe90f61e", BASE_EULER_EVK_EXECUTOR),
)
SINGLES = {
    "#B0": "targetB0_Base_USDe_USDC", "#B11": "targetB11_Fluid_sUSDai_USDC_Vault48",
    "#B12": "targetB12_EulerV2_wtSPYM_USDC_0x1791", "#B13": "targetB13_EulerV2_wtCOIN_USDC_0x1791",
    "#B14": "targetB14_Base_USDe_USDC_0x6efc", "#B15": "targetB15_Base_yoUSD_USDC_0x5c2a",
}


def fixtures():
    targets = {"extra_Base_USDe_Whales": [], "base_Morpho_Whales": []}
    watch_rows = []
    for ident, borrower, market, executor in CASES:
        rank = "#" + ident.split("-")[1].upper()
        row = {"rank": rank, "user": borrower, "marketId": market, "chainId": 8453,
               "deployedExecutor": executor, "healthFactor": 1.01, "liquidatableNow": False,
               "debtUsdc": 100, "collateralValueUsdc": 110, "bpsToLiquidation": 99.0099,
               "liveQuote": {"grossSurplusUsdc": 48, "provenance": "HISTORICAL_REFERENCE"}}
        if rank in SINGLES:
            targets[SINGLES[rank]] = row
        else:
            targets["base_Morpho_Whales" if rank in {"#B1", "#B2"} else "extra_Base_USDe_Whales"].append(row)
        # Intentionally different health, position and forecast facts: metadata
        # enrichment must not import any of these runner values into the card.
        watch_rows.append({"id": ident, "rank": rank, "borrower": borrower, "healthFactor": "0.5",
                           "bpsToLiquidation": -5000, "isLiquidatable": True, "debtUsdc": 999,
                           "passiveHoursToCrossing": 0,
                           **({"executor": executor} if executor != BASE_EXECUTOR else {})})
    sentinel = {"schema": "top-whale-triggers-status/v1", "generatedAt": iso(),
                "pin": {**block(), "utc": iso(NOW - 10)}, "targets": targets,
                "baseObservation": {"status": "COMPLETE", "pin": {**block(2000, 8453, 20), "utc": iso(NOW - 20)}}}
    watch = {"ok": True, "armed": True, "chainId": 8453, "mode": "EXECUTE_IF_LIQUIDATABLE", "checkedAt": iso(),
             "deployedExecutor": "0x88bff83b4c987cc90a863cd79baa54dd5cd94f32", "blockNumber": 2001,
             "pin": block(2001, 8453, 15, "b"), "targets": watch_rows}
    return {sources.SENTINEL: sentinel, BASE_WATCH: watch}


@pytest.mark.parametrize("explicit_identity", [False, True])
def test_all_fifteen_base_plans_api_metadata_and_provenance_without_health_quote_or_authority_overlay(root, client, monkeypatch, explicit_identity):
    data = fixtures()
    if explicit_identity:
        data[BASE_WATCH]["pin"]["utc"] = iso(NOW - 15)
        for item, (ident, borrower, market, executor) in zip(data[BASE_WATCH]["targets"], CASES):
            item.update(targetId=ident, marketId=market, user=borrower, chainId=8453,
                        executor=executor, deployedExecutor=executor, pool=MORPHO if executor == BASE_EXECUTOR else market)
    baseline = {r["rank"]: r for r in build_targets(Reader({sources.SENTINEL: data[sources.SENTINEL]}), NOW)["targets"]}
    for key, value in data.items():
        (root / ALLOWLIST[key]).write_text(json.dumps(value), encoding="utf8")
    monkeypatch.setattr(importlib.import_module("dashboard.app").time, "time", lambda: NOW)
    response = get(client, f"/api/v1/targets?source={BASE_WATCH}&page_size=100")
    assert response.status_code == 200
    view = response.get_json()
    assert view["summary"]["total"] == view["pagination"]["filtered_total"] == 15
    assert coverage(view, BASE_WATCH)["accepted_rows"] == 15
    expected = {"#" + ident.split("-")[1].upper(): (user, market, executor) for ident, user, market, executor in CASES}
    assert {r["rank"] for r in view["targets"]} == set(expected)
    for row in view["targets"]:
        user, market, executor = expected[row["rank"]]
        assert row["chain_id"] == 8453 and row["borrower_address"] == user and row["executor_address"] == executor
        assert row["venue_address"] == (MORPHO if executor == BASE_EXECUTOR else market)
        runner = row["runner"]
        assert runner["source"] == BASE_WATCH and runner["mode"] == "EXECUTE_IF_LIQUIDATABLE"
        assert runner["checked_at"] == iso() and runner["freshness"] == "FRESH" and runner["age_text"] == "15s"
        assert runner["reported_armed"] is True and row["armed"] is None and row["executable_now"] is False
        assert row["liveness"]["state"] == "UNKNOWN" and row["liveness"]["observed_at"] is None
        assert row["source_ids"] == [sources.SENTINEL, BASE_WATCH]
        provenance = next(p for p in row["provenance"] if p["source"] == BASE_WATCH)
        assert provenance == {"source": BASE_WATCH, "generated_at": iso(), "freshness": "FRESH", "age_text": "15s",
                              "block": 2001, "hash": block(char="b")["hash"], "utc": iso(NOW - 15)}
        for field in ("health_factor", "liquidatable_now", "observation", "position", "quote", "protocol_status"):
            assert row[field] == baseline[row["rank"]][field]
        assert row["protocol_status"] == "WATCH" and row["health_factor"] == "1.01"
        assert row["quote"]["available"] is False and row["position"]["passive_hours"] is row["position"]["borrow_apr_pct"] is None


ABSENT = object()


def monitor_fixtures():
    data = fixtures()
    pin = data[sources.SENTINEL]["baseObservation"]["pin"]
    for row in data[sources.SENTINEL]["targets"]["base_Morpho_Whales"]:
        row.pop("deployedExecutor")
        row.update(executor=None, observationKind="READ_ONLY_MONITOR", observationOnly=True,
                   observationStatus="COMPLETE", refreshStatus="COMPLETE", armed=False, executableNow=False,
                   observationBlock=pin["number"], observationHash=pin["hash"],
                   timestamp=pin["timestamp"], observationUtc=pin["utc"])
    return data


@pytest.mark.parametrize("configuration", ["executor-null", "both-null", "absent"])
def test_base_b1_b2_monitor_null_config_api_joins_independent_report_without_changing_health_or_authority(root, client, monkeypatch, configuration):
    data = monitor_fixtures()
    for row in data[sources.SENTINEL]["targets"]["base_Morpho_Whales"]:
        if configuration == "both-null":
            row["deployedExecutor"] = None
        elif configuration == "absent":
            row.pop("executor")
    baseline = {r["id"]: r for r in build_targets(Reader({sources.SENTINEL: data[sources.SENTINEL]}), NOW)["targets"]}
    original = copy.deepcopy(data)
    for key, value in data.items():
        (root / ALLOWLIST[key]).write_text(json.dumps(value), encoding="utf8")
    monkeypatch.setattr(importlib.import_module("dashboard.app").time, "time", lambda: NOW)
    response = get(client, f"/api/v1/targets?source={BASE_WATCH}&page_size=100")
    assert response.status_code == 200
    view = response.get_json()
    assert view["pagination"]["filtered_total"] == coverage(view, BASE_WATCH)["accepted_rows"] == 15
    rows = {r["id"]: r for r in view["targets"]}
    for ident, rank, user in (("base-morpho-0", "#B1", CASES[7][1]), ("base-morpho-1", "#B2", CASES[8][1])):
        row = rows[ident]
        assert row["rank"] == rank and row["chain_id"] == 8453 and row["borrower_address"] == user
        assert row["venue_address"] == MORPHO and row["market_id"] == ops.BASE_USDE_MARKET
        assert row["executor_address"] == BASE_EXECUTOR
        assert row["runner"]["source"] == BASE_WATCH and row["runner"]["mode"] == "EXECUTE_IF_LIQUIDATABLE"
        assert row["runner"]["reported_armed"] is True and row["runner"]["checked_at"] == iso()
        assert row["runner"]["freshness"] == "FRESH" and row["runner"]["age_text"] == "15s"
        assert row["source_ids"] == [sources.SENTINEL, BASE_WATCH]
        assert next(p for p in row["provenance"] if p["source"] == BASE_WATCH)["block"] == 2001
        for field in ("observation", "health_factor", "liquidatable_now", "quote", "position", "protocol_status", "armed", "liveness"):
            assert row[field] == baseline[ident][field]
        assert row["armed"] is None and row["liquidatable_now"] is row["executable_now"] is False
        assert row["quote"]["available"] is False and row["liveness"]["state"] == "UNKNOWN"
    # Projection must not rewrite producer values or use supplied internal flags.
    assert data == original


@pytest.mark.parametrize("field,value", [
    ("executor", address(999)), ("executor", "invalid"), ("executor", ""), ("executor", False),
    ("executor", []), ("executor", {}), ("deployedExecutor", address(999)), ("deployedExecutor", "invalid"),
    ("chainId", 1), ("chainId", "8453"), ("marketId", "0x" + "f" * 64), ("marketId", "invalid"),
    ("user", address(999)), ("user", "invalid"), ("rank", "#B8"), ("rank", ABSENT),
    ("observationKind", "OTHER_SOURCE"), ("observationKind", ABSENT),
    ("observationOnly", False), ("observationOnly", "true"), ("observationOnly", ABSENT),
])
def test_base_b1_b2_monitor_null_config_does_not_hide_identity_config_or_provenance_conflicts(root, client, monkeypatch, field, value):
    data = monitor_fixtures()
    for row in data[sources.SENTINEL]["targets"]["base_Morpho_Whales"]:
        row["_base_monitor_config"] = True  # Untrusted markers must not bypass validation.
        if value is ABSENT:
            row.pop(field)
        else:
            row[field] = copy.deepcopy(value)
    for key, value in data.items():
        (root / ALLOWLIST[key]).write_text(json.dumps(value), encoding="utf8")
    monkeypatch.setattr(importlib.import_module("dashboard.app").time, "time", lambda: NOW)
    response = get(client, f"/api/v1/targets?source={BASE_WATCH}&page_size=100")
    assert response.status_code == 200
    view = response.get_json()
    assert view["pagination"]["filtered_total"] == 13
    assert all(r["id"] not in {"base-morpho-0", "base-morpho-1"} for r in view["targets"])


@pytest.mark.parametrize("part,field,value", [
    ("watch", "chainId", 1), ("watch", "chainId", 42161), ("watch", "chainId", "8453"), ("watch", "chainId", 8453.0),
    ("watch", "deployedExecutor", address(999)), ("watch", "deployedExecutor", ABSENT),
    ("watch", "executor", address(999)), ("watch", "liquidatorAddress", address(999)),
    ("watch", "checkedAt", ABSENT), ("watch", "checkedAt", "invalid"), ("watch", "ok", False),
    ("watch", "pin", ABSENT), ("watch", "blockNumber", 999), ("watch", "targets", ABSENT),
    ("watch", "targets", []), ("watch", "targets", {}),
    ("pin", "chainId", 1), ("pin", "chainId", ABSENT), ("pin", "number", 0), ("pin", "number", True),
    ("pin", "hash", ABSENT), ("pin", "hash", "invalid"), ("pin", "timestamp", ABSENT),
    ("pin", "timestamp", str(NOW - 10)), ("pin", "timestamp", True), ("pin", "timestamp", 0),
    ("pin", "timestamp", NOW * 1000), ("pin", "utc", iso(NOW - 100)),
    ("item", "id", "base-unknown"), ("item", "rank", "#B1"), ("item", "borrower", address(999)),
    ("item", "borrower", ABSENT), ("item", "chainId", 1), ("item", "marketId", ops.BASE_USDE_MARKET),
    ("item", "executor", address(999)), ("item", "deployedExecutor", address(999)),
    ("item", "targetId", "base-unknown"), ("item", "user", address(999)), ("item", "pool", address(999)),
])
def test_base_report_missing_or_conflicting_identity_pin_and_executor_fail_closed(part, field, value):
    data = fixtures()
    watch = data[BASE_WATCH]
    target = {"watch": watch, "pin": watch["pin"], "item": watch["targets"][0]}[part]
    if value is ABSENT:
        target.pop(field)
    else:
        target[field] = copy.deepcopy(value)
    view = build_targets(Reader(data), NOW)
    assert view["summary"]["total"] == 15
    assert all(r["runner"].get("source") != BASE_WATCH and r["runner"]["reported_armed"] is None for r in view["targets"])
    assert all(BASE_WATCH not in r["source_ids"] and r["protocol_status"] == "WATCH" for r in view["targets"])


@pytest.mark.parametrize("change", ["oversized", "duplicate_beyond_nine", "duplicate_id", "duplicate_rank", "duplicate_borrower", "malformed"])
def test_base_report_list_is_bounded_without_truncating_ambiguity(change):
    data = fixtures()
    items = data[BASE_WATCH]["targets"]
    if change == "oversized":
        items.append(copy.deepcopy(items[0]))
    elif change == "duplicate_beyond_nine":
        items[-1] = copy.deepcopy(items[0])
    elif change == "malformed":
        items[-1] = None
    else:
        field = change.removeprefix("duplicate_")
        items[-1][field] = items[0][field]
    view = build_targets(Reader(data), NOW, {"source": BASE_WATCH})
    assert view["summary"]["total"] == 15 and view["targets"] == []


@pytest.mark.parametrize("rank", ["#B11", "#B12", "#B13"])
@pytest.mark.parametrize("executor", [ABSENT, BASE_EXECUTOR, address(999)])
def test_base_special_plans_require_their_explicit_per_row_executor(rank, executor):
    data = fixtures()
    item = next(r for r in data[BASE_WATCH]["targets"] if r["rank"] == rank)
    if executor is ABSENT:
        item.pop("executor")
    else:
        item["executor"] = executor
    assert build_targets(Reader(data), NOW, {"source": BASE_WATCH})["targets"] == []


@pytest.mark.parametrize("field,value", [
    ("chainId", 1), ("user", address(999)), ("marketId", "0x" + "f" * 64),
    ("executor", address(999)), ("deployedExecutor", address(999)), ("rank", "#B8"), ("pool", address(999)),
])
def test_base_join_rejects_conflicting_sentinel_identity_without_losing_other_bindings(field, value):
    data = fixtures()
    data[sources.SENTINEL]["targets"][SINGLES["#B0"]][field] = value
    view = build_targets(Reader(data), NOW, {"source": BASE_WATCH})
    assert len(view["targets"]) == 14 and "#B0" not in {r["rank"] for r in view["targets"]}


@pytest.mark.parametrize("field,age,expected", [("checkedAt", 4000, "STALE"), ("pin", 4000, "STALE"),
                                              ("checkedAt", -600, "UNKNOWN"), ("pin", -600, "UNKNOWN")])
def test_base_report_freshness_uses_both_check_and_pin_without_promoting_stale_or_future(field, age, expected):
    data = fixtures()
    if field == "checkedAt":
        data[BASE_WATCH]["checkedAt"] = iso(NOW - age)
    else:
        data[BASE_WATCH]["pin"]["timestamp"] = NOW - age
    rows = build_targets(Reader(data), NOW, {"source": BASE_WATCH})["targets"]
    assert len(rows) == 15
    for row in rows:
        assert row["runner"]["freshness"] == expected and row["runner"]["reported_armed"] is None
        assert row["runner"]["checked_at"] == data[BASE_WATCH]["checkedAt"]
        assert row["armed"] is None and row["liveness"]["state"] == "UNKNOWN"
        assert row["observation"]["freshness"] == "FRESH" and row["protocol_status"] == "WATCH"
        provenance = next(p for p in row["provenance"] if p["source"] == BASE_WATCH)
        assert provenance["freshness"] == expected and provenance["age_text"] == row["runner"]["age_text"]


@pytest.mark.parametrize("failure", ["missing", "invalid_cached", "changed"])
def test_base_missing_failed_or_changing_capture_does_not_reuse_telemetry(failure):
    data = fixtures()
    reader = Reader(data)
    if failure == "missing":
        data.pop(BASE_WATCH)
    elif failure == "invalid_cached":
        reader.failures[BASE_WATCH] = "INVALID"
    else:
        counts = {}
        def fingerprint(key):
            counts[key] = counts.get(key, 0) + 1
            return (9, 9) if key == BASE_WATCH and counts[key] >= 2 else reader.versions.get(key)
        reader.fingerprint_hook = fingerprint
    view = build_targets(reader, NOW)
    assert view["summary"]["total"] == 15
    assert all(r["runner"].get("source") != BASE_WATCH and r["runner"]["reported_armed"] is None for r in view["targets"])


@pytest.mark.parametrize("mode,armed,reported", [("CHECK_ONLY", False, False), ("WATCH", False, False), ("CHECK_ONLY", True, None)])
def test_base_reported_mode_and_armed_remain_typed_telemetry_only(mode, armed, reported):
    data = fixtures()
    data[BASE_WATCH].update(mode=mode, armed=armed)
    rows = build_targets(Reader(data), NOW, {"source": BASE_WATCH})["targets"]
    assert len(rows) == 15
    for row in rows:
        assert row["runner"]["mode"] == mode and row["runner"]["reported_armed"] is reported
        assert row["armed"] is None and row["liveness"]["state"] == "UNKNOWN"


def test_base_report_never_creates_positions_or_replaces_missing_health_and_does_not_shift_old_source_bits():
    data = fixtures()
    assert build_targets(Reader({BASE_WATCH: data[BASE_WATCH]}), NOW)["summary"]["total"] == 0
    assert sources.SOURCES[-1].id == BASE_WATCH
    assert sources.SOURCE_BITS[sources.SENTINEL] == 1 and sources.SOURCE_BITS[sources.V3_WATCH] == 4
    assert sources.SOURCE_BITS[sources.ARB_WATCH] == 8
    data[sources.SENTINEL]["baseObservation"]["status"] = "UNAVAILABLE"
    rows = build_targets(Reader(data), NOW, {"source": BASE_WATCH})["targets"]
    assert len(rows) == 15
    assert all(r["health_factor"] is r["liquidatable_now"] is None and r["protocol_status"] == "UNKNOWN" for r in rows)


def test_base_scope_never_attaches_to_other_chains_unknown_base_targets_or_morpho_markets():
    data = fixtures()
    targets = data[sources.SENTINEL]["targets"]
    b14 = targets[SINGLES["#B14"]]
    targets["targetM47_Morpho_USDe_RLUSD"] = {**b14, "rank": "#M47", "chainId": 1}
    targets["base_Morpho_Whales"].append({**b14, "rank": "#B3", "user": address(999)})
    from dashboard.targets import ARB_UNIVERSAL_EXECUTOR, ARB_USDG_BINDINGS
    user, market, _ = ARB_USDG_BINDINGS["#ARB9"]
    data[sources.ARB_WATCH] = {"chainId": 42161, "ok": True, "armed": True, "mode": "EXECUTE_IF_LIQUIDATABLE",
        "checkedAt": iso(), "pin": block(chain=42161), "targets": [{"rank": "#ARB9", "borrower": user,
        "marketId": market, "executor": ARB_UNIVERSAL_EXECUTOR, "healthFactor": 1.01, "isLiquidatable": False}]}
    view = build_targets(Reader(data), NOW)
    rows = {r["rank"]: r for r in view["targets"]}
    for rank in ("#M47", "#B3", "#ARB9"):
        assert rows[rank]["runner"].get("source") != BASE_WATCH and BASE_WATCH not in rows[rank]["source_ids"]
    assert len(build_targets(Reader(data), NOW, {"source": BASE_WATCH})["targets"]) == 15
