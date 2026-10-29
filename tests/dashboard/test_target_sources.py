"""Aggregation fixtures implement precisely the reader amendment's immutable API."""

import copy
import importlib
import json
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from decimal import Decimal
from types import MappingProxyType

import pytest
from werkzeug.datastructures import MultiDict

from conftest import get
from dashboard import target_sources as sources
from dashboard.target_sources import aggregate_targets as build_inventory
from dashboard.artifacts import ALLOWLIST, ArtifactReader, JsonRead
from dashboard.targets import ARB_BINDINGS, ARB_EXECUTOR, M1_EXECUTOR, MORPHO, POOL, SPARK_POOL, UNIFIED_EXECUTOR, V3_2K_2L_WATCH, build_targets

NOW = 1792453000
NEAR_IDS = tuple(sources.NEAR_BINDINGS)


def iso(value=NOW - 5):
    return datetime.fromtimestamp(value, timezone.utc).isoformat()


def address(value):
    return f"0x{value:040x}"


def block(number=1000, chain=1, age=10, char="a"):
    return {"chainId": chain, "number": number, "hash": "0x" + char * 64, "timestamp": NOW - age}


@dataclass(frozen=True)
class JSONRead:
    value: dict | None
    current: bool
    read_state: str
    fingerprint: tuple | None
    max_bytes: int = 5242880


@dataclass(frozen=True)
class IndexRead:
    entries: tuple
    current: bool = True
    read_state: str = "OK"
    input_rows: int | None = None
    accepted_rows: int = 0
    rejected_rows: int = 0
    omitted_rows: int | None = 0
    truncated: bool = False
    generated_at: str | None = None
    fingerprint: tuple | None = (1, 1)
    max_bytes: int = 67108864
    max_rows: int = 250000


class Reader:
    def __init__(self, values=None, indexes=None):
        self.values = values or {}
        self.indexes = indexes or {}
        self.failures = {}
        self.versions = {key: (1, 1) for key in self.values | self.indexes}
        self.calls = []
        self.fingerprint_hook = None

    def read_json(self, key, validator=None):
        # Fixed optional overlays use the ordinary reader API, not source discovery.
        assert key in {"rank1_aave_v4_v2_watch", "m32_historical_local_rehearsal", V3_2K_2L_WATCH}
        value = self.values.get(key)
        valid = value is not None and (validator is None or validator(value))
        return JsonRead(value if valid else None, valid, key in self.values, valid, False)

    def read_target_json(self, key, validator=None):
        assert key in sources.BY_SOURCE and sources.BY_SOURCE[key].kind == "json"
        self.calls.append(("json", key))
        state = self.failures.get(key, "OK" if key in self.values else "MISSING")
        return JSONRead(self.values.get(key), state in {"OK", "PARTIAL"}, state, self.versions.get(key))

    def read_target_index(self, key):
        assert key in sources.BY_SOURCE and sources.BY_SOURCE[key].kind == "index"
        self.calls.append(("index", key))
        state = self.failures.get(key, "OK" if key in self.indexes else "MISSING")
        entries = self.indexes.get(key, ())
        return IndexRead(entries, state in {"OK", "PARTIAL"}, state, len(entries) if key in self.indexes else None,
                         len(entries), generated_at=iso(NOW - 86400), fingerprint=self.versions.get(key))

    def target_fingerprint(self, key):
        self.calls.append(("fingerprint", key))
        if self.fingerprint_hook:
            return self.fingerprint_hook(key)
        return self.versions.get(key)


def coverage(view, source):
    return next(c for c in view["coverage"]["sources"] if c["id"] == source)


def test_inactive_filter_includes_closed_borrowers_and_excludes_unknown_and_rounded_dust():
    from test_targets import CLOSURE_DEFINITIONS, NOW as observed_now, closed_position_data
    data = closed_position_data()
    reader = Reader(data)
    view = build_targets(reader, observed_now, {"status": "INACTIVE"})
    assert view["query"]["status"] == "INACTIVE" and view["pagination"]["filtered_total"] == 3
    assert {r["rank"] for r in view["targets"]} == {"#B14", "#M34", "#E8"}
    assert all(r["protocol_status"] == "INACTIVE" for r in view["targets"])
    for key, *_ in CLOSURE_DEFINITIONS[:2]:
        data[sources.SENTINEL]["targets"][key].update(debtRaw="1", positionStatus="OPEN", inactive=False, healthFactor=1.01)
    data[sources.SENTINEL]["targets"][CLOSURE_DEFINITIONS[2][0]]["debtReadStatus"] = "UNAVAILABLE"
    view = build_targets(reader, observed_now, {"status": "INACTIVE"})
    assert view["summary"]["total"] == 3 and view["pagination"]["filtered_total"] == 0
    assert build_targets(reader, observed_now, {"status": "UNKNOWN"})["pagination"]["filtered_total"] == 1


def test_raw_closed_evidence_precedence_over_older_health_and_fresh_runner_hold():
    from test_targets import NOW as observed_now, closed_position_data
    reader = Reader(closed_position_data())
    batch = sources.adapt(sources.BY_SOURCE[sources.SENTINEL], reader.read_target_json(sources.SENTINEL), observed_now)
    for key, bundles in batch.evidence.items():
        closed = bundles[0]
        older = replace(closed, source="euler_silo_current_screen", pin={**closed.pin, "block": closed.pin["block"] - 1},
                        hf=Decimal("0.9"), eligible=True, health_known=True, position_status=None, notes=())
        held = sources.Evidence(sources.NEAR_WATCH, closed.at, closed.pin,
                                runner={"held": True, "reported_armed": True, "label": "Scoped test runner"})
        resolved = sources._resolve(key, [older, closed, held], None, observed_now)
        assert resolved.status == resolved.protocol_status == "INACTIVE"
        assert resolved.evidence is closed and resolved.evidence.hf is None
        assert resolved.runner["reported_armed"] is False and resolved.quote["available"] is False
        # A newer successful raw-positive read supersedes closure even without HF.
        reopened = replace(closed, pin={**closed.pin, "block": closed.pin["block"] + 1}, position_status="OPEN", notes=())
        resolved = sources._resolve(key, [closed, reopened], None, observed_now)
        assert resolved.status == "UNKNOWN" and resolved.evidence is reopened
        assert "No outstanding debt at observed block" not in resolved.blockers


def test_same_pin_contradictory_raw_debt_is_unknown_not_inactive():
    from test_targets import NOW as observed_now, closed_position_data
    reader = Reader(closed_position_data())
    batch = sources.adapt(sources.BY_SOURCE[sources.SENTINEL], reader.read_target_json(sources.SENTINEL), observed_now)
    for key, bundles in batch.evidence.items():
        closed = bundles[0]
        positive = replace(closed, position_status="OPEN", notes=())
        resolved = sources._resolve(key, [closed, positive], None, observed_now)
        assert resolved.protocol_status == "UNKNOWN"
        assert any("Conflicting" in note for note in resolved.blockers)


def near_user(alias):
    return sources.NEAR_BINDINGS[NEAR_IDS[alias - 11]][1]


def near_spoke(alias):
    return sources.NEAR_BINDINGS[NEAR_IDS[alias - 11]][0]


def near(users=(11, 12, 13), at=None, pinned=None, factor="1010000000000000000"):
    rows = [{"id": NEAR_IDS[user - 11], "borrower": near_user(user), "spoke": near_spoke(user),
             "executor": sources.NEAR_BINDINGS[NEAR_IDS[user - 11]][2], "healthFactorRaw": factor,
             "isLiquidatableBothProviders": int(factor) < 10**18, "bpsToLiquidation": "100"} for user in users]
    return {"ok": True, "armed": True, "mode": "EXECUTE_IF_LIQUIDATABLE", "checkedAt": at or iso(),
            "pin": pinned or block(), "targets": rows, "enabledTargetIds": [r["id"] for r in rows],
            "armedTargetIds": [r["id"] for r in rows if r["id"] != NEAR_IDS[1]], "heldTargets": [{"targetId": NEAR_IDS[1], "reason": "UNTRUSTED_REASON"}]}


def current_screen(accounts=3):
    vault = address(300)
    positions = [{"vault": vault, "account": address(i + 10), "complete": True,
                  "debt": {"status": "ok", "values": [str(2**200)]},
                  "liquidity": {"status": "ok", "values": [[address(301)], ["200"], "100"]},
                  "liquidations": [{"positiveCapacity": False, "read": {"status": "ok", "values": ["0", "0"]}}]} for i in range(accounts)]
    return {"chainId": 1, "checkedAt": iso(), "pin": block(), "protocols": {
        "euler": {"vaults": [{"vault": vault, "totalBorrows": {"status": "ok", "values": ["999"]}}], "accounts": positions},
        "silo": {"accounts": [{"config": address(400), "debtSilo": address(401), "resolvedDebtSilo": address(401),
                                "account": address(10), "complete": True, "debtSiloMapping": "VERIFIED", "protocolSolvent": True,
                                "maxRepayRaw": "120", "currentLtvRaw": "900000000000000000", "currentLtRaw": "920000000000000000"}]}}}


def test_near_three_without_sentinel_and_scoped_fresh_hold_independent_from_protocol():
    reader = Reader({"aave_v4_near_watch": near()})
    view = build_targets(reader, NOW)
    assert view["schema"] == "dashboard-targets/v2"
    assert view["summary"]["total"] == 3
    assert view["pin_block"] is None  # never synthesize a curated/multichain reference
    by_account = {r["borrower_address"]: r for r in view["targets"]}
    held = by_account[near_user(12)]
    assert held["status"]["code"] == "HELD"
    assert held["protocol_status"] == "WATCH"
    assert held["runner"]["held"] is True
    assert held["runner"]["reported_armed"] is False
    assert held["runner"]["freshness"] == "FRESH"
    assert by_account[near_user(11)]["runner"]["reported_armed"] is True
    assert "UNTRUSTED_REASON" not in json.dumps(view)
    assert all(r["quote"]["available"] is False for r in view["targets"])


def test_held_scope_uses_full_identity_and_unique_target_ids_and_stale_hold_age():
    data = near()
    data["targets"][2]["id"] = NEAR_IDS[1]
    view = build_targets(Reader({"aave_v4_near_watch": data}), NOW)
    assert not any(r["status"]["code"] == "HELD" for r in view["targets"])
    data = near(at=iso(NOW - 4000), pinned=block(age=4010))
    view = build_targets(Reader({"aave_v4_near_watch": data}), NOW)
    held = next(r for r in view["targets"] if r["borrower_address"] == near_user(12))
    assert held["runner"]["held"] is True
    assert held["status"]["code"] == "STALE"
    assert held["runner"]["reported_armed"] is None


def test_full_2533_plus_page_traversal_dedup_and_global_counts():
    entries = tuple((1, "Aave V3", POOL, address(i + 1), None) for i in range(2603))
    reader = Reader(indexes={"aave_v3_borrower_csv": entries})
    seen = []
    for page in range(1, 15):
        view = build_inventory(reader, NOW, {"page": str(page), "page_size": "200"})
        assert view["summary"]["total"] == view["pagination"]["filtered_total"] == 2603
        assert view["pagination"]["pages"] == 14
        assert len(view["targets"]) <= 200
        seen += [r["position_key"] for r in view["targets"]]
    assert len(seen) == len(set(seen)) == 2603
    assert view["pagination"]["start"] == 2601 and view["pagination"]["end"] == 2603
    assert all(r["status"]["code"] == "UNKNOWN" and r["observation"]["block"] is None for r in view["targets"])


def test_large_compact_generation_reuses_digests_projects_only_page_and_rejects_failed_cache(monkeypatch):
    entries = tuple((8453, "Morpho Blue", MORPHO, address(i + 1), "0x" + "a" * 64) for i in range(20001))
    reader = Reader(indexes={"morpho_blue_base_index": entries})
    projected = []
    original = sources._project
    monkeypatch.setattr(sources, "_project", lambda *args: projected.append(args[0]) or original(*args))
    view = build_inventory(reader, NOW, {"page_size": "3"})
    generation = sources._GENERATIONS[reader]
    assert len(projected) == 3 and view["summary"]["total"] == 20001
    assert isinstance(generation.ordered, tuple) and isinstance(generation.by_identity, MappingProxyType)
    assert all(isinstance(d, sources.Descriptor) and isinstance(d.digest, bytes) for d in generation.ordered)
    build_inventory(reader, NOW + 4000, {"page_size": "3"})
    assert sources._GENERATIONS[reader] is generation
    assert len(projected) == 6
    reader.failures["morpho_blue_base_index"] = "INVALID"  # stale entries still present in mock result
    failed = build_inventory(reader, NOW)
    assert failed["summary"]["total"] == 0
    assert sources._GENERATIONS[reader] is not generation
    assert coverage(failed, "morpho_blue_base_index")["read_state"] == "INVALID"


def test_canonical_identity_keeps_chains_protocols_venues_and_markets_distinct():
    user = address(1); market = "0x" + "a" * 64
    first = (1, "Morpho Blue", MORPHO, user, market)
    reader = Reader({"aave_v3_borrower_universe": {"chainId": 1, "pool": POOL, "borrowerUniverse": [{"user": user}]}},
                    {"morpho_blue_index": (first, first, (1, "Morpho Blue", MORPHO, user, "0x" + "b" * 64)),
                     "morpho_blue_base_index": ((8453, "Morpho Blue", MORPHO, user, market),),
                     "aave_v3_borrower_csv": ((1, "Aave V3", POOL, user, None), (1, "Aave V3", address(8), user, None))})
    view = build_inventory(reader, NOW)
    assert view["summary"]["total"] == 5
    assert len({r["position_key"] for r in view["targets"]}) == 5
    merged = next(r for r in view["targets"] if r["venue_address"] == POOL)
    assert set(merged["source_ids"]) == {"aave_v3_borrower_universe", "aave_v3_borrower_csv"}


def test_compound_all_discovery_candidates_join_full_screen_not_top20():
    raw = {"generatedAt": iso(), "identity": {"chainId": 8453, "market": address(500)}, "pin": block(chain=8453),
           "marketState": {"baseScaleRaw": "1000000"},
           "discovery": {"candidates": [{"user": address(i + 1), "status": "COMPLETE", "debtRaw": "1000000" if i < 21 else "0"} for i in range(62)]},
           "screenedBorrowers": [{"user": address(i + 1), "status": "COMPLETE", "debtRaw": "1000000", "hfWad": "1100000000000000000",
                                  "protocolLiquidatableAtPin": False, "protocolFlagMatchesHf": True} for i in range(21)],
           "borrowers": []}
    view = build_inventory(Reader({"compound_v3_base_watch": raw}), NOW, {"page_size": "100"})
    assert view["summary"]["total"] == 62
    assert all(r["protocol_status"] == "WATCH" for r in view["targets"])
    assert sum(r["health_factor"] is not None for r in view["targets"]) == 21
    assert sum(r["position"]["debt_amount"] == "0" for r in view["targets"]) == 41
    assert coverage(view, "compound_v3_base_watch")["accepted_rows"] == 62


def test_euler_current_accounts_markets_history_and_silo_empty_watch_do_not_erase():
    current = current_screen()
    values = {"euler_silo_current_screen": current,
              "euler_l_valuation": {"chainId": 1, "generatedAt": iso(NOW - 40000), "rows": [{"vault": address(300), "violator": address(10), "netUsdcRaw": "999999999"}]},
              "silo_default_watch_status": {"generatedAt": iso(), "trackedAccounts": []},
              "silo_l_surface": {"scannedAt": iso(NOW - 40000), "chains": [{"chainId": 1, "markets": [{"config": address(400), "nearLt": {"accounts": [{"silo": address(401), "account": address(10), "band": "LIQUIDATABLE"}]}}]}]}}
    reader = Reader(values, {"euler_liquidation_history": ((1, "Euler", address(300), address(10), None), (1, "Euler", address(300), address(99), None))})
    view = build_inventory(reader, NOW)
    assert view["summary"]["total"] == 7
    accounts = [r for r in view["targets"] if r["record_type"] == "position"]
    markets = [r for r in view["targets"] if r["record_type"] == "market"]
    assert len(markets) == 2 and all(r["borrower_address"] is None for r in markets)
    measured = next(r for r in accounts if r["protocol"] == "Euler" and r["borrower_address"] == address(10))
    assert measured["observation"]["source"] == "euler_silo_current_screen"
    assert measured["position"]["debt_amount"] == str(2**200)
    assert measured["position"]["debt_symbol"] == "raw token units"
    assert measured["quote"]["available"] is False
    assert next(r for r in accounts if r["protocol"] == "Silo")["protocol_status"] == "WATCH"
    assert next(r for r in accounts if r["borrower_address"] == address(99))["protocol_status"] == "UNKNOWN"


@pytest.mark.parametrize("different_hash", [False, True])
def test_same_pin_health_conflicts_and_same_height_forks_are_unknown(different_hash):
    runner = near(users=(11,), factor="1010000000000000000")
    watch = {"generatedAt": iso(), "latest": {"generatedAt": iso(), "chain": {"id": 1, "blockNumber": 1000,
              "blockHash": "0x" + ("b" if different_hash else "a") * 64, "timestamp": NOW - 10},
              "topRows": [{"spoke": near_spoke(11), "user": near_user(11), "healthFactor": 0.99, "liquidatable": True}]}}
    view = build_targets(Reader({"aave_v4_near_watch": runner, "aave_v4": watch}), NOW)
    row = view["targets"][0]
    assert row["protocol_status"] == "UNKNOWN"
    assert row["liquidatable_now"] is None
    assert "Conflicting health" in " ".join(row["blockers"])


def test_a13_same_pin_precision_difference_keeps_sentinel_health_position_and_quote():
    pinned = block(26250950)
    sentinel = {
        "schema": "top-whale-triggers-status/v1", "generatedAt": iso(),
        "pin": {**pinned, "utc": iso(NOW - 10)},
        "targets": {"targetA13_AaveV4_wstETH_WETH_0x4cd7": {
            "rank": "#A13", "user": near_user(12), "spoke": near_spoke(12), "pair": "wstETH / WETH",
            "armed": True, "executor": "0xf09a01a6c23b936d5a51abce87a6ec8442a44262",
            "healthFactor": 1.0002586963221923, "liquidatableNow": False, "bpsToLiquidation": 2.5863,
            "debtUsd": 3230, "collateralUsd": 3390,
            "liveQuote": {"repayWeth": 1, "seizedWstEth": 1, "uniV3OutWeth": 1.1,
                          "grossSurplusWeth": 0.1, "grossSurplusUsd": 240},
        }},
    }
    runner = near(users=(12,), pinned=pinned, factor="1000258696322192379")
    runner["targets"][0]["bpsToLiquidation"] = "2.5863"
    view = build_targets(Reader({sources.SENTINEL: sentinel, sources.NEAR_WATCH: runner}), NOW)
    assert view["summary"]["total"] == 1
    row, = view["targets"]
    assert row["rank"] == "#A13" and row["protocol_status"] == "WATCH"
    assert "Conflicting health" not in " ".join(row["blockers"])
    assert row["health_factor"] == "1.0002586963221922"
    assert row["position"]["debt_amount"] == "3230" and row["position"]["collateral_amount"] == "3390"
    assert row["quote"]["available"] is False and row["quote"]["seize_symbol"] == "wstETH"
    assert row["quote"]["estimate"]["gross_token_amount"] == "0.1"
    evidence = row["observation"]
    assert (evidence["source"], evidence["block"], evidence["hash"]) == (sources.SENTINEL, 26250950, pinned["hash"])
    assert row["quote"]["block"] is row["quote"]["hash"] is None  # Legacy quote has no independent pin.
    assert row["runner"]["held"] is True  # Duplicate health must not suppress the near runner's hold.


def test_targets_api_arbitrum_watch_returns_four_targets_without_sentinel(root, client, monkeypatch):
    monkeypatch.setattr(importlib.import_module("dashboard.app").time, "time", lambda: NOW)
    watch = {
        "ok": True, "armed": True, "mode": "EXECUTE_IF_LIQUIDATABLE", "chainId": 42161,
        "checkedAt": iso(), "deployedExecutor": ARB_EXECUTOR, "pin": block(chain=42161),
        "targets": [{"rank": rank, "borrower": borrower, "marketId": market,
                     "healthFactor": "1.001092", "bpsToLiquidation": "10.91", "isLiquidatable": False,
                     "debtStableUsd": 1000, "collateralValueUsd": 1100, "passiveHoursToCrossing": 1}
                    for rank, (borrower, market, _) in ARB_BINDINGS.items()],
    }
    (root / ALLOWLIST[sources.ARB_WATCH]).write_text(json.dumps(watch), encoding="utf8")
    response = get(client, "/api/v1/targets?chain=Arbitrum")
    assert response.status_code == 200
    rows = response.get_json()["targets"]
    assert len(rows) == 4 and {row["rank"] for row in rows} == {"#ARB1", "#ARB2", "#ARB3", "#ARB4"}
    assert all(row["chain_id"] == 42161 and row["protocol"] == "Morpho Blue" for row in rows)
    assert all(row["observation"]["freshness"] == "FRESH" for row in rows)  # Pin has timestamp, not utc.


@pytest.mark.parametrize("executor,reported", [
    ("0x2175290a1132fb5e49f6e96cb1610e2cdd7b81c4", True),
    ("0x08be4f3e07ef8a2c2f13cefdafcf9a82b5efe675", None), (address(999), None),
])
def test_arbitrum_fixed_current_executor_binds_only_first_four_and_preserves_other_five(executor, reported):
    from dashboard.targets import ARB_FLUID_42_BORROWER, ARB_UNIVERSAL_EXECUTOR, ARB_USDG_BINDINGS, _ARB_METADATA
    assert ARB_EXECUTOR == "0x2175290a1132fb5e49f6e96cb1610e2cdd7b81c4"
    items = [{"rank": rank, "borrower": user, "marketId": market} for rank, (user, market, _) in ARB_BINDINGS.items()]
    items += [{"id": ident, "rank": meta[0], "borrower": ARB_FLUID_42_BORROWER, "marketId": meta[2],
               "executor": ARB_UNIVERSAL_EXECUTOR} for ident, meta in _ARB_METADATA.items()]
    items += [{"rank": rank, "borrower": user, "marketId": market, "executor": ARB_UNIVERSAL_EXECUTOR}
              for rank, (user, market, _) in ARB_USDG_BINDINGS.items()]
    for item in items:
        item.update(healthFactor=1.01, bpsToLiquidation=99.0099, isLiquidatable=False)
    watch = {"ok": True, "armed": True, "mode": "EXECUTE_IF_LIQUIDATABLE", "chainId": 42161,
             "checkedAt": iso(), "deployedExecutor": executor, "pin": block(chain=42161), "targets": items}
    rows = build_targets(Reader({sources.ARB_WATCH: watch}), NOW)["targets"]
    assert len(rows) == 9
    for row in rows:
        first_four = row["rank"] in ARB_BINDINGS
        assert row["executor_address"] == (ARB_EXECUTOR if first_four else ARB_UNIVERSAL_EXECUTOR)
        assert row["runner"]["reported_armed"] is (reported if first_four else True)
        assert row["runner"]["source"] == (None if first_four and reported is None else sources.ARB_WATCH)
        assert row["armed"] is None and row["liveness"]["state"] == "UNKNOWN"
        assert row["quote"]["available"] is False and row["protocol_status"] == "WATCH"


def test_old_broad_health_and_new_index_date_cannot_replace_fresh_measured_bundle():
    raw = {"generatedAt": iso(NOW - 4000), "latest": {"generatedAt": iso(NOW - 4000), "chain": {"id": 1, "blockNumber": 999,
           "blockHash": "0x" + "b" * 64, "timestamp": NOW - 4000},
           "topRows": [{"spoke": near_spoke(11), "user": near_user(11), "healthFactor": 0.5, "liquidatable": True}]}}
    reader = Reader({"aave_v4_near_watch": near(users=(11,)), "aave_v4": raw},
                    {"aave_v4_borrower_index": ((1, "Aave V4", near_spoke(11), near_user(11), None),)})
    row = build_inventory(reader, NOW)["targets"][0]
    assert row["protocol_status"] == "WATCH"
    assert row["health_factor"] == "1.01"
    assert row["observation"]["source"] == "aave_v4_near_watch"
    index_provenance = next(p for p in row["provenance"] if p["source"] == "aave_v4_borrower_index")
    assert index_provenance["generated_at"] and index_provenance["block"] is index_provenance["hash"] is None


def test_independent_failures_source_limits_and_research_counts_not_fake_positions():
    reader = Reader({"aave_v4_near_watch": near(), "research_watch": {"generatedAt": iso(), "entries": [{}] * 45}})
    for key, state in [("silo_l_surface", "INVALID"), ("euler_l_surface", "OVERSIZED"), ("compound_v3_base_watch", "UNAVAILABLE")]:
        reader.failures[key] = state
    view = build_inventory(reader, NOW)
    assert view["summary"]["total"] == 3
    assert coverage(view, "research_watch")["reported_total"] == 45
    assert coverage(view, "research_watch")["accepted_rows"] == 0
    assert coverage(view, "euler_l_surface")["read_state"] == "OVERSIZED"
    assert coverage(view, "silo_l_surface")["input_rows"] is None
    assert coverage(view, "aave_v3_liquidation_trigger_quotes")["read_state"] == "MISSING"
    assert view["coverage"]["complete"] is False
    assert view["coverage"]["limits"] == {"max_bytes_per_source": 67108864, "max_rows_per_source": 250000}
    assert "16777216" in " ".join(coverage(view, "morpho_blue_liquidatable")["limitations"])


def test_structured_source_cap_and_bad_identities_are_explicit_not_a_healthy_empty_source():
    rows = [{"marketId": "0x" + "a" * 64, "borrower": address(i + 1)} for i in range(10003)]
    rows[0]["borrower"] = "not an address"
    reader = Reader({"morpho_blue_liquidatable": {"chainId": 1, "rows": rows, "scannedAt": iso()}})
    view = build_inventory(reader, NOW)
    c = coverage(view, "morpho_blue_liquidatable")
    assert c["input_rows"] == 10003 and c["accepted_rows"] == 9999
    assert c["rejected_rows"] == 1 and c["omitted_rows"] == 3
    assert c["truncated"] is True and c["read_state"] == "PARTIAL"
    assert len(view["targets"]) == 50 and view["summary"]["total"] == 9999


def test_full_sentinel_arrays_not_old_presentation_caps_and_curated_ids_preserved():
    rows = [{"user": address(i + 1), "pool": POOL, "healthFactor": 1.1, "liquidatableNow": False, "bpsToLiquidation": 1000} for i in range(30)]
    sentinel = {"schema": "top-whale-triggers-status/v1", "generatedAt": iso(), "pin": {**block(), "utc": iso(NOW - 10)},
                "targets": {"additional_AaveV3_weETH_WETH": rows}}
    view = build_inventory(Reader({sources.SENTINEL: sentinel}), NOW)
    assert view["summary"]["total"] == 30
    assert [r["id"] for r in view["targets"][:7]] == [f"aave-v3-extra-{i}" for i in range(7)]
    assert coverage(view, sources.SENTINEL)["accepted_rows"] == 30


@pytest.mark.parametrize("key,rank,user,spoke,pair,seize_symbol", [
    ("targetA3_AaveV4_USDe_USDC_0x1d9c", "#A3", "0x1d9c4116e5784036dbd15bced8aff88970b4a598",
     "0xba1b3d55d249692b669a164024a838309b7508af", "USDe / USDC", "USDe"),
    ("targetA4_AaveV4_SameAsset_0xa429", "#A4", "0xa4298746f662119a4df27fa57f20e18e44ccb767",
     "0x94e7a5dcbe816e498b89ab752661904e2f56c485", "WETH / USDC (Same-Asset)", "USDC"),
])
def test_sentinel_a3_observation_and_a4_armed_projection_preserve_quote_units(key, rank, user, spoke, pair, seize_symbol):
    sentinel = {"schema": "top-whale-triggers-status/v1", "generatedAt": iso(), "pin": {**block(), "utc": iso(NOW - 10)},
                "targets": {key: {"rank": rank, "user": user, "spoke": spoke, "pair": pair,
                    "healthFactor": .999, "liquidatableNow": True, "bpsToLiquidation": -10.01,
                    "observationOnly": True, "executableNow": False,
                    "liveQuote": {"repayUsdc": 1741.77, "seizedUsde": 1812.31, "uniV3OutUsdc": 1812.31, "grossSurplusUsdc": 70.54}}}}
    batch = sources.Batch(sources.BY_SOURCE[sources.SENTINEL],
        {"input_rows": 0, "rejected_rows": 0, "omitted_rows": 0, "truncated": False, "read_state": "OK", "limitations": []},
        at=iso(), now=NOW)
    sources.sentinel(batch, sentinel)
    evidence = next(iter(batch.evidence.values()))[0]
    assert evidence.health_known is True and evidence.eligible is True and evidence.runner is None
    assert evidence.quote["gross_token_symbol"] == "USDC" and evidence.quote["gross_token_amount"] is None
    assert evidence.quote["estimate"]["gross_token_amount"] == "70.54"
    assert evidence.quote["seize_symbol"] == seize_symbol
    view = build_targets(Reader({sources.SENTINEL: sentinel}), NOW)
    assert coverage(view, sources.SENTINEL)["rejected_rows"] == 0
    assert len(view["targets"]) == 1
    row = view["targets"][0]
    assert row["id"] == sources.SINGLES[key] and row["rank"] == rank and row["pair"] == pair
    assert row["protocol_status"] == "ELIGIBLE"
    assert row["status"]["code"] == ("ELIGIBLE" if rank == "#A4" else "OBSERVATION_ONLY")
    assert row["armed"] is (None if rank == "#A4" else False) and row["executable_now"] is row["calldata_ready"] is False
    assert row["runner"]["label"] == ("Unified Aave V4 A4" if rank == "#A4" else None)
    assert row["runner"]["reported_armed"] is row["executor_address"] is None
    assert row["quote"]["seize_symbol"] == seize_symbol and row["quote"]["gross_token_symbol"] == "USDC"


@pytest.mark.parametrize("key,rank,user,venue,pair,protocol", [
    ("targetYnEthx_Curve_NavArb", "#YN", "0xd65ed4bce447195187f37ce7d82f56adf1826f8f",
     "0xd65ed4bce447195187f37ce7d82f56adf1826f8f", "WETH -> ynETHx -> Redeem (Curve/NAV)", "Curve/NAV"),
    ("targetE1_EulerV2_RLUSD_USDC_0xbf21", "#E1", "0xbf21702d7213bc7a95fc0ecb1e4a4e43c2380772",
     "0xe1ce9af672f8854845e5474400b6ddc7ae458a10", "eUSDC-22 / eRLUSD-1 (Euler V2)", "Euler"),
    ("targetE2_EulerV2_USDC_syrupUSDC_0x9f09", "#E2", "0x9f09502a0b68edbccdff5e6c59270ad150def361",
     "0x9bd52f2805c6af014132874124686e7b248c2cbb", "esyrupUSDC-4 / eUSDC-70 (Euler V2)", "Euler"),
])
@pytest.mark.parametrize("stage", ["healthy", "underwater", "stale"])
def test_sentinel_yn_euler_identity_health_and_observation_only_projection(key, rank, user, venue, pair, protocol, stage):
    underwater = stage == "underwater"
    raw = {"schema": "top-whale-triggers-status/v1", "generatedAt": iso(), "pin": {**block(), "utc": iso(NOW - 10)},
           "targets": {key: {"rank": rank, "pair": pair, "user": user, "marketId": venue,
               "healthFactor": .999 if underwater else 1.01, "liquidatableNow": underwater,
               "bpsToLiquidation": -10.01 if underwater else 99.0099, "collateralUsd": 114500, "debtUsd": 113499,
               "observationOnly": False, "armed": True, "executableNow": True,
               "liveQuote": {"estimatedProfitUsd": 1135}}}}
    if stage == "stale":
        raw["generatedAt"] = iso(NOW - 4000)
        raw["pin"] = {**block(age=4010), "utc": iso(NOW - 4010)}
    batch = sources.Batch(sources.BY_SOURCE[sources.SENTINEL],
        {"input_rows": 0, "rejected_rows": 0, "omitted_rows": 0, "truncated": False, "read_state": "OK", "limitations": []},
        at=raw["generatedAt"], now=NOW)
    sources.sentinel(batch, raw)
    identity = sources.identity(1, protocol, venue, user)
    assert list(batch.identities) == [identity]
    evidence = batch.evidence[identity][0]
    assert evidence.runner is None and evidence.quote["available"] is False
    assert evidence.health_known is (rank != "#YN")
    if rank != "#YN":
        assert evidence.eligible is underwater
    for builder in (build_targets, build_inventory):
        view = builder(Reader({sources.SENTINEL: raw}), NOW)
        assert len(view["targets"]) == 1 and coverage(view, sources.SENTINEL)["rejected_rows"] == 0
        row = view["targets"][0]
        assert row["id"] == sources.SINGLES[key] and row["rank"] == rank and row["pair"] == pair
        assert row["protocol"] == protocol
        assert row["protocol_label"] == ("Euler V2" if protocol == "Euler" else "Curve/NAV")
        assert row["venue_address"] == venue and row["borrower_address"] == user
        if rank in {"#YN", "#E1"}:
            assert row["observation_only"] is False and row["armed"] is None
            assert row["executor_address"] == ("0x91a07a51ca9c2abd333d80ca876f0dfde4d8cd35" if rank == "#YN" else "0xac262ce4319b887aeac069730c7978c98a8c5fe6")
            continue
        assert row["status"]["code"] == "OBSERVATION_ONLY" and row["observation_only"] is True
        assert row["protocol_status"] == ("STALE" if stage == "stale" else "ELIGIBLE" if underwater else "WATCH")
        assert row["armed"] is row["executable_now"] is row["calldata_ready"] is False
        assert row["runner"]["label"] is row["runner"]["reported_armed"] is row["executor_address"] is None
        assert row["position"]["debt_amount"] == "113499" and row["position"]["collateral_amount"] == "114500"
        assert row["source_ids"] == [sources.SENTINEL]
        assert row["observation"]["hash"] == raw["pin"]["hash"] and row["observation"]["block"] == 1000
        assert row["quote"]["gross_usd"] is None and row["surplus_usd"] is None


@pytest.mark.parametrize("key,rank,user,venue,pair", [
    ("targetE3_EulerV2_WETH_ynETHx_0x831e", "#E3", "0x831ec4f2aba6deab29fb1aefdf9b049721d3c366",
     "0x45c3b59d53e2e148aaa6a857521059676d5c0489", "eynETHx-2 / eWETH-22 (Euler V2)"),
    ("targetE4_EulerV2_WETH_ynETHx_0x8062", "#E4", "0x8062511602a163fe84d1d2300117ea8cc1600cbd",
     "0x45c3b59d53e2e148aaa6a857521059676d5c0489", "eynETHx-2 / eWETH-22 (Euler V2)"),
    ("targetE5_EulerV2_USDC_USDT_0xd1ed", "#E5", "0xd1edf7fc3d913c94e6c649985ce36bbc2e871d0f",
     "0xe0a80d35bb6618cba260120b279d357978c42bce", "eUSDT-9 / eUSDC-22 (Euler V2)"),
    ("targetE6_EulerV2_USDT_USDC_0x079d", "#E6", "0x079dfb0a62b4723b45166abb7892fe362543ad8d",
     "0x7c280dbdef569e96c7919251bd2b0edf0734c5a8", "eUSDC-22 / eUSDT-9 (Euler V2)"),
])
@pytest.mark.parametrize("stage", ["healthy", "blocked", "ready", "stale", "no_debt"])
def test_extended_euler_sentinel_health_identity_and_buffer_blockers(key, rank, user, venue, pair, stage):
    underwater = stage in {"blocked", "ready", "stale"}
    blocked = stage == "blocked" and rank in {"#E3", "#E4"}
    ready = underwater and not blocked
    executor = "0xac262ce4319b887aeac069730c7978c98a8c5fe6"
    raw = {"schema": "top-whale-triggers-status/v1", "generatedAt": iso(), "pin": {**block(), "utc": iso(NOW - 10)},
           "targets": {key: {"rank": rank, "user": user, "marketId": venue, "pair": pair, "executor": executor,
               "healthFactor": None if stage == "no_debt" else .999 if underwater else 1.01,
               "hfUnderwaterNow": underwater, "liquidatableNow": ready, "executableNow": ready,
               "armed": True, "observationOnly": False, "collateralUsd": 1350, "debtUsd": 0 if stage == "no_debt" else 1368.25,
               "liveQuote": {"estimatedProfitUsd": 13.68},
               **({"readyExecuteEulerEvkCalldata": "0x12345678" + "00" * 384} if ready else {})}}}
    if stage == "stale":
        raw["generatedAt"] = iso(NOW - 4000)
        raw["pin"] = {**block(age=4010), "utc": iso(NOW - 4010)}
    batch = sources.Batch(sources.BY_SOURCE[sources.SENTINEL],
        {"input_rows": 0, "rejected_rows": 0, "omitted_rows": 0, "truncated": False, "read_state": "OK", "limitations": []},
        at=raw["generatedAt"], now=NOW)
    sources.sentinel(batch, raw)
    identity = sources.identity(1, "Euler", venue, user)
    assert list(batch.identities) == [identity]
    evidence = batch.evidence[identity][0]
    assert evidence.health_known is (stage != "no_debt")
    if stage != "no_debt":
        assert evidence.eligible is underwater
    assert any("MCwETH withdrawal buffer" in note for note in evidence.notes) is blocked
    for builder in (build_targets, build_inventory):
        view = builder(Reader({sources.SENTINEL: raw}), NOW)
        assert len(view["targets"]) == 1 and coverage(view, sources.SENTINEL)["rejected_rows"] == 0
        row = view["targets"][0]
        assert row["id"] == sources.SINGLES[key] and row["rank"] == rank and row["pair"] == pair
        assert row["protocol"] == "Euler" and row["protocol_label"] == "Euler V2" and row["group_key"] == "euler-v2"
        assert row["venue_address"] == venue and row["borrower_address"] == user
        assert row["market_id"] is None  # Euler vault identity uses venue, not a Morpho bytes32 market.
        assert row["protocol_status"] == ("STALE" if stage == "stale" else "UNKNOWN" if stage == "no_debt" else "ELIGIBLE" if underwater else "WATCH")
        assert row["observation_only"] is False and row["armed"] is None
        assert row["executor_address"] == executor and row["runner"]["label"] == "Unified Euler V2"
        assert row["runner"]["reported_armed"] is None
        assert row["position"]["debt_amount"] == ("0" if stage == "no_debt" else "1368.25")
        assert row["calldata_ready"] is ready
        assert any("MCwETH withdrawal buffer" in note for note in row["blockers"]) is blocked
        assert row["quote"]["available"] is False and row["quote"]["gross_usd"] is None


def test_a4_joins_unified_runner_provenance_without_replacing_sentinel_health():
    user, spoke = "0xa4298746f662119a4df27fa57f20e18e44ccb767", "0x94e7a5dcbe816e498b89ab752661904e2f56c485"
    executor = "0xf09a01a6c23b936d5a51abce87a6ec8442a44262"
    sentinel = {"schema": "top-whale-triggers-status/v1", "generatedAt": iso(), "pin": {**block(), "utc": iso(NOW - 10)},
                "targets": {"targetA4_AaveV4_SameAsset_0xa429": {"rank": "#A4", "user": user, "spoke": spoke,
                    "pair": "WETH / USDC (Same-Asset)", "healthFactor": .999, "liquidatableNow": True}}}
    watch = {"ok": True, "armed": True, "mode": "EXECUTE_IF_LIQUIDATABLE", "checkedAt": iso(NOW - 1),
             "pin": block(1001, age=1), "liquidatorAddress": executor, "partition": "V3_ONLY"}
    deploy = {"ok": True, "contractAddress": executor, "deployedAt": iso(NOW - 100), "txHash": "0x" + "1" * 64}
    view = build_targets(Reader({sources.SENTINEL: sentinel, sources.V3_WATCH: watch,
                                 "aave_v4_v3_morpho_liquidator_deploy": deploy}), NOW)
    row = view["targets"][0]
    assert row["status"]["code"] == "ELIGIBLE" and row["observation_only"] is False
    assert row["runner"]["label"] == "Unified Aave V4 A4" and row["runner"]["reported_armed"] is True
    assert row["runner"]["source"] == sources.V3_WATCH and row["executor_address"] == executor
    assert row["observation"]["source"] == sources.SENTINEL and row["observation"]["block"] == 1000
    assert row["source_ids"] == [sources.SENTINEL, sources.V3_WATCH]
    assert row["executable_now"] is False


TWO_K_TARGET = "target2K_AaveV3_WETH_WETH_0x7a05"
TWO_K_ID = "aave-v3-weth-weth-0x7a05"
TWO_K_USER = "0x7a0575018b57cb64434fcd794f4f0c624fd0fbd3"


def current_2k_data():
    from test_targets import producer_fixtures
    data = producer_fixtures()
    data["aave_v4_v3_morpho_liquidator_deploy"]["contractAddress"] = UNIFIED_EXECUTOR
    targets = data[sources.SENTINEL]["targets"]
    targets[TWO_K_TARGET] = {
        "rank": "#2K", "user": TWO_K_USER, "pool": POOL, "pair": "WETH / WETH (Same-Asset)",
        "healthFactor": 1.00001, "liquidatableNow": False, "bpsToLiquidation": 0.1,
        "executor": UNIFIED_EXECUTOR, "armed": True,
        "liveQuote": {"provenance": "HISTORICAL_REFERENCE", "grossSurplusWeth": "0.048"},
    }
    targets["target2L_AaveV3_WETH_WETH_0xd185"] = {
        **targets[TWO_K_TARGET], "rank": "#2L", "user": "0xd185e7fafa5d75c7fcb3ff0844fe4c307d8fd57a"}
    targets["targetS1_Spark_wstETH_WETH_0x4b28"] = {
        "rank": "#S1", "user": "0x4b2877a94ead57e8a5e07b7b044eaeb59f605886", "pool": SPARK_POOL,
        "pair": "wstETH / WETH (SparkLend)", "healthFactor": 1.01, "liquidatableNow": False}
    targets["targetA4_AaveV4_SameAsset_0xa429"] = {
        "rank": "#A4", "user": "0xa4298746f662119a4df27fa57f20e18e44ccb767",
        "spoke": "0x94e7a5dcbe816e498b89ab752661904e2f56c485", "pair": "WETH / USDC (Same-Asset)",
        "healthFactor": 1.01, "liquidatableNow": False}
    targets["morpho_wstETH_WETH_Whales"] = [{
        "rank": "#M3", "user": "0xb224f589297a5a207e6069de5dafd4b120129817",
        "marketId": "0xb8fc70e82bc5bb53e773626fcc6a23f7eefa036918d7ef216ecfb1950a94a85e",
        "pair": "wstETH / WETH", "healthFactor": 1.01, "liquidatableNow": False,
        "deployedExecutor": M1_EXECUTOR}]
    targets["targetM40_Morpho_weETH_WETH"] = {
        "rank": "#M40", "user": "0xd7583e3cf08bbcab66f1242195227bbf9f865fda",
        "marketId": "0x37e7484d642d90f14451f1910ba4b7b8e4c3ccdd0ec28f8b2bdb35479e472ba7",
        "pair": "weETH / WETH", "healthFactor": 1.01, "liquidatableNow": False,
        "deployedExecutor": M1_EXECUTOR}
    # Retain the fixture's legacy Morpho flag to exercise every shared-runner
    # attribution branch; the exclusive scope must still win over that flag.
    data[sources.V3_WATCH].update(
        partition="CURRENT_2K_ONLY", collectionScope="CURRENT_2K_ONLY", liquidatorAddress=UNIFIED_EXECUTOR,
        candidateCount=0, targets=[{"rank": "#2K", "user": TWO_K_USER, "bpsToLiquidation": 0.1}])
    return data


@pytest.mark.parametrize("explicit_identity", [False, True])
def test_current_2k_api_report_binding_preserves_provenance_and_truthful_unknowns(root, client, monkeypatch, explicit_identity):
    from test_targets import NOW as observed_now, put
    data = current_2k_data()
    watch = data[sources.V3_WATCH]
    if explicit_identity:
        identity = {"id": TWO_K_ID, "targetId": TWO_K_TARGET, "pool": POOL, "chainId": 1,
                    "borrower": TWO_K_USER, "executor": UNIFIED_EXECUTOR}
        watch.update(identity)
        watch["targets"][0].update(identity)
        data[sources.SENTINEL]["targets"][TWO_K_TARGET].update(identity)
    for key, value in data.items():
        put(root, key, value)
    monkeypatch.setattr(importlib.import_module("dashboard.app").time, "time", lambda: observed_now)
    response = get(client, "/api/v1/targets?q=2K")
    assert response.status_code == 200
    row, = response.get_json()["targets"]
    runner = row["runner"]
    assert row["id"] == TWO_K_ID and row["rank"] == "#2K"
    assert row["borrower_address"] == TWO_K_USER and row["venue_address"] == POOL and row["chain_id"] == 1
    assert row["executor_address"] == UNIFIED_EXECUTOR
    assert runner["label"] == "Unified Aave V3 2K" and runner["source"] == sources.V3_WATCH
    assert runner["mode"] == "EXECUTE_IF_LIQUIDATABLE" and runner["checked_at"] == watch["checkedAt"]
    assert runner["freshness"] == "FRESH" and runner["age_text"] == "15s" and runner["reported_armed"] is True
    provenance = next(p for p in row["provenance"] if p["source"] == sources.V3_WATCH)
    assert provenance["generated_at"] == watch["checkedAt"] and provenance["block"] == 1001
    assert provenance["hash"] == watch["pin"]["hash"] and provenance["age_text"] == "15s"
    assert row["source_ids"] == [sources.SENTINEL, sources.V3_WATCH]
    assert row["observation"]["source"] == sources.SENTINEL and row["observation"]["block"] == 1000
    assert row["observation"]["freshness"] == "FRESH" and row["health_factor"] == "1.00001"
    assert row["liquidatable_now"] is False and row["protocol_status"] == row["status"]["code"] == "WATCH"
    assert row["armed"] is None and row["executable_now"] is False
    assert row["liveness"]["state"] == "UNKNOWN"
    assert row["liveness"]["observed_at"] is row["liveness"]["source"] is None
    assert row["position"]["passive_hours"] is row["position"]["borrow_apr_pct"] is None
    quote = row["quote"]
    assert quote["available"] is False and quote["gross_token_amount"] is row["surplus_usd"] is None
    assert quote["estimate"]["gross_token_amount"] == "0.048" and quote["estimate"]["gross_token_symbol"] == "WETH"
    assert quote["estimate"]["provenance"] == "HISTORICAL_REFERENCE"
    assert quote["freshness"] == "UNKNOWN" and quote["block"] is quote["utc"] is None


@pytest.mark.parametrize("partition", ["CURRENT_2K_ONLY", "V3_ONLY", None])
def test_current_2k_exclusive_scope_never_attaches_to_unrelated_unified_branches(partition):
    from test_targets import NOW as observed_now
    data = current_2k_data()
    data[sources.V3_WATCH]["partition"] = partition
    reader = Reader(data)
    view = build_targets(reader, observed_now)
    rows = {r["rank"]: r for r in view["targets"]}
    # Generic V3, whale V3, Spark, A4, dedicated Morpho and shared Morpho branches.
    for rank in ("#2A", "#2L", "#S1", "#A4", "#M1", "#M2", "#M3", "#M40"):
        runner = rows[rank]["runner"]
        assert runner["source"] is runner["mode"] is runner["checked_at"] is runner["reported_armed"] is None
        assert runner["freshness"] == "UNKNOWN" and runner["age_text"] is None
        assert sources.V3_WATCH not in rows[rank]["source_ids"]
    filtered = build_targets(reader, observed_now, {"source": sources.V3_WATCH})
    assert [r["id"] for r in filtered["targets"]] == ([TWO_K_ID] if partition == "CURRENT_2K_ONLY" else [])


_ABSENT = object()


@pytest.mark.parametrize("part,field,value", [
    ("watch", "partition", _ABSENT), ("watch", "partition", "V3_ONLY"),
    ("watch", "collectionScope", _ABSENT), ("watch", "collectionScope", "DEFAULT"),
    ("watch", "collectionScope", ["CURRENT_2K_ONLY"]),
    ("watch", "liquidatorAddress", _ABSENT), ("watch", "liquidatorAddress", address(999)),
    ("watch", "targetId", "target2L_AaveV3_WETH_WETH_0xd185"), ("watch", "chainId", 8453),
    ("watch", "targets", _ABSENT), ("watch", "targets", []), ("watch", "targets", {}),
    ("watch", "targets", [{"rank": "#2K", "user": TWO_K_USER}] * 2),
    ("item", "rank", _ABSENT), ("item", "rank", "#2L"),
    ("item", "user", _ABSENT), ("item", "user", address(999)),
    ("item", "id", "aave-v3-weth-weth-0xd185"), ("item", "targetId", "unrecognized-target"),
    ("item", "pool", SPARK_POOL), ("item", "pool", "invalid"),
    ("item", "executor", address(999)), ("item", "chainId", 8453),
    ("sentinel", "rank", "#2L"), ("sentinel", "user", address(999)),
    ("sentinel", "pool", SPARK_POOL), ("sentinel", "pool", "invalid"),
    ("sentinel", "executor", address(999)), ("sentinel", "chainId", 8453),
    ("sentinel", "id", "aave-v3-weth-weth-0xd185"),
])
def test_current_2k_missing_or_conflicting_scope_identity_and_executor_fail_closed(part, field, value):
    from test_targets import NOW as observed_now
    data = current_2k_data()
    watch = data[sources.V3_WATCH]
    target = {"watch": watch, "item": watch["targets"][0],
              "sentinel": data[sources.SENTINEL]["targets"][TWO_K_TARGET]}[part]
    if value is _ABSENT:
        target.pop(field)
    else:
        target[field] = copy.deepcopy(value)
    view = build_targets(Reader(data), observed_now)
    assert all(row["runner"].get("source") != sources.V3_WATCH for row in view["targets"])
    row = next((r for r in view["targets"] if r["id"] == TWO_K_ID), None)
    if row is not None:
        assert row["runner"]["reported_armed"] is None
        assert row["runner"]["freshness"] == "UNKNOWN"


@pytest.mark.parametrize("stale_field", ["checkedAt", "pin"])
def test_current_2k_stale_report_or_pin_remains_stale_not_armed(stale_field):
    from test_targets import NOW as observed_now, iso as observed_iso
    data = current_2k_data()
    watch = data[sources.V3_WATCH]
    if stale_field == "checkedAt":
        watch["checkedAt"] = observed_iso(observed_now - 4000)
    else:
        watch["pin"]["timestamp"] = observed_now - 4000
    row, = build_targets(Reader(data), observed_now, {"source": sources.V3_WATCH})["targets"]
    assert row["id"] == TWO_K_ID and row["runner"]["source"] == sources.V3_WATCH
    assert row["runner"]["mode"] == "EXECUTE_IF_LIQUIDATABLE" and row["runner"]["checked_at"] == watch["checkedAt"]
    assert row["runner"]["freshness"] == "STALE" and row["runner"]["age_text"] == "66m"
    assert row["runner"]["reported_armed"] is row["armed"] is None
    assert row["liveness"]["state"] == "UNKNOWN"
    assert row["protocol_status"] == "WATCH" and row["observation"]["freshness"] == "FRESH"
    provenance = next(p for p in row["provenance"] if p["source"] == sources.V3_WATCH)
    assert provenance["freshness"] == "STALE" and provenance["age_text"] == "66m"


@pytest.mark.parametrize("partition", ["V3_ONLY", "V3_AND_EXPLICIT_V4_WETH", "AAVE_V3_ONLY"])
@pytest.mark.parametrize("collection_scope", [None, "DEFAULT"])
def test_current_2k_support_preserves_legacy_broad_partition_membership(partition, collection_scope):
    from test_targets import NOW as observed_now
    data = current_2k_data()
    watch = data[sources.V3_WATCH]
    watch.update(partition=partition)
    watch.pop("collectionScope")
    if collection_scope is not None:
        watch["collectionScope"] = collection_scope
    rows = {r["rank"]: r for r in build_targets(Reader(data), observed_now)["targets"]}
    for rank in ("#2A", "#2K", "#2L", "#S1", "#A4", "#M1", "#M3", "#M40"):
        assert rows[rank]["runner"]["source"] == sources.V3_WATCH
        assert rows[rank]["runner"]["reported_armed"] is True


TWO_L_TARGET = "target2L_AaveV3_WETH_WETH_0xd185"
TWO_L_ID = "aave-v3-weth-weth-0xd185"
TWO_L_USER = "0xd185e7fafa5d75c7fcb3ff0844fe4c307d8fd57a"


def current_2k_2l_data(legacy="stale"):
    from test_targets import NOW as observed_now, iso as observed_iso
    data = current_2k_data()
    watch = copy.deepcopy(data[sources.V3_WATCH])
    watch.update(partition="CURRENT_2K_2L_ONLY", collectionScope="CURRENT_2K_2L_ONLY",
                 checkedAt=observed_iso(observed_now - 2), localMaxSpendWei="750000000000000",
                 targets=[{"rank": "#2K", "user": TWO_K_USER, "bpsToLiquidation": 0.1},
                          {"rank": "#2L", "user": TWO_L_USER, "bpsToLiquidation": 125}])
    data[V3_2K_2L_WATCH] = watch
    if legacy is None:
        del data[sources.V3_WATCH]
    elif legacy == "stale":
        data[sources.V3_WATCH]["checkedAt"] = observed_iso(observed_now - 4000)
    else:
        # A fresh broad legacy frame must not be merged with the selected narrow frame.
        data[sources.V3_WATCH].update(partition="V3_ONLY", collectionScope=None, armed=False)
    data[sources.ARB_WATCH] = {
        "ok": True, "armed": False, "mode": "CHECK_ONLY", "chainId": 42161,
        "checkedAt": observed_iso(observed_now - 5), "deployedExecutor": ARB_EXECUTOR,
        "pin": {"number": 2000, "hash": "0x" + "b" * 64, "timestamp": observed_now - 10},
        "targets": [{"rank": rank, "borrower": borrower, "marketId": market,
                     "healthFactor": "1.01", "isLiquidatable": False}
                    for rank, (borrower, market, _) in ARB_BINDINGS.items()]}
    return data


@pytest.mark.parametrize("legacy", [None, "stale", "fresh"])
def test_current_2k_2l_fresh_optional_api_report_wins_only_for_fixed_targets(root, client, monkeypatch, legacy):
    from test_targets import NOW as observed_now, put
    assert ALLOWLIST[V3_2K_2L_WATCH] == "reports/raw/fast/top-whale-executor-live-watch-2k-2l.json"
    data = current_2k_2l_data(legacy)
    for key, value in data.items():
        if key != V3_2K_2L_WATCH:
            put(root, key, value)
    baseline = {row["id"]: row for row in build_targets(ArtifactReader(root), observed_now)["targets"]}
    put(root, V3_2K_2L_WATCH, data[V3_2K_2L_WATCH])
    monkeypatch.setattr(importlib.import_module("dashboard.app").time, "time", lambda: observed_now)
    response = get(client, "/api/v1/targets")
    assert response.status_code == 200
    view = response.get_json()
    assert view["runners"]["v3"]["source"] == V3_2K_2L_WATCH
    assert view["runners"]["v3"]["partition"] == "CURRENT_2K_2L_ONLY"
    assert view["runners"]["v3"]["candidate_count"] == 0
    rows = {row["id"]: row for row in view["targets"]}
    assert rows.keys() == baseline.keys()
    assert {row["rank"] for row in rows.values()} >= {"#2A", "#2K", "#2L", "#S1", "#A4", "#M1", "#M2", "#M3", "#M40", "#B1", "#ARB1"}
    for ident, row in rows.items():
        for field in ("observation", "protocol_status", "health_factor", "liquidatable_now", "quote", "position", "liveness"):
            assert row[field] == baseline[ident][field]
        assert row["executable_now"] is False
        if ident not in {TWO_K_ID, TWO_L_ID}:
            assert row["runner"].get("source") != V3_2K_2L_WATCH
            assert V3_2K_2L_WATCH not in row["source_ids"]
            assert not any(item["source"] == V3_2K_2L_WATCH for item in row["provenance"])
            if baseline[ident]["runner"].get("source") != sources.V3_WATCH:
                assert row["runner"] == baseline[ident]["runner"]
            else:
                assert row["runner"]["freshness"] == "UNKNOWN" and row["runner"]["reported_armed"] is None
            continue
        runner = row["runner"]
        assert runner["source"] == V3_2K_2L_WATCH and runner["reported_armed"] is True
        assert runner["checked_at"] == data[V3_2K_2L_WATCH]["checkedAt"]
        assert runner["mode"] == "EXECUTE_IF_LIQUIDATABLE" and runner["freshness"] == "FRESH" and runner["age_text"] == "15s"
        assert row["source_ids"] == [sources.SENTINEL, V3_2K_2L_WATCH]
        provenance = next(item for item in row["provenance"] if item["source"] == V3_2K_2L_WATCH)
        assert provenance["block"] == 1001 and provenance["hash"] == data[V3_2K_2L_WATCH]["pin"]["hash"]
        assert provenance["generated_at"] == runner["checked_at"] and provenance["freshness"] == "FRESH"
        assert row["armed"] is None and row["liveness"]["state"] == "UNKNOWN"
        assert row["quote"]["available"] is False and row["quote"]["gross_token_amount"] is row["surplus_usd"] is None


def invalidate_2k_2l_report(root, data, mutation):
    from test_targets import NOW as observed_now, iso as observed_iso, put
    watch = copy.deepcopy(data[V3_2K_2L_WATCH])
    if mutation == "stale_report":
        watch["checkedAt"] = observed_iso(observed_now - 4000)
    elif mutation == "stale_pin":
        watch["pin"]["timestamp"] = observed_now - 4000
    elif mutation == "foreign_scope":
        watch["collectionScope"] = "CURRENT_2K_ONLY"
    elif mutation == "foreign_row":
        watch["targets"][1].update(rank="#2M", user=address(999))
    elif mutation == "invalid":
        (root / ALLOWLIST[V3_2K_2L_WATCH]).write_text("{", encoding="utf8")
        return
    put(root, V3_2K_2L_WATCH, watch)


@pytest.mark.parametrize("mutation", ["stale_report", "stale_pin", "invalid", "foreign_scope", "foreign_row"])
def test_current_2k_2l_unusable_new_report_never_reuses_cached_armed_telemetry(root, mutation):
    from test_targets import NOW as observed_now, put
    data = current_2k_2l_data()
    for key, value in data.items():
        put(root, key, value)
    reader = ArtifactReader(root)
    assert next(row for row in build_targets(reader, observed_now)["targets"] if row["id"] == TWO_L_ID)["runner"]["reported_armed"] is True
    invalidate_2k_2l_report(root, data, mutation)
    view = build_targets(reader, observed_now)
    assert all(row["runner"].get("source") != V3_2K_2L_WATCH and V3_2K_2L_WATCH not in row["source_ids"] for row in view["targets"])
    rows = {row["id"]: row for row in view["targets"]}
    for ident, freshness in ((TWO_K_ID, "STALE"), (TWO_L_ID, "UNKNOWN")):
        row = rows[ident]
        assert row["runner"]["freshness"] == freshness and row["runner"]["reported_armed"] is None
        assert row["armed"] is None and row["executable_now"] is False and row["liveness"]["state"] == "UNKNOWN"
        assert row["quote"]["gross_token_amount"] is None


def test_current_2k_2l_unusable_or_missing_optional_report_preserves_fresh_legacy_exactly(root):
    from test_targets import NOW as observed_now, put
    data = current_2k_2l_data()
    data[sources.V3_WATCH] = current_2k_data()[sources.V3_WATCH]
    for key, value in data.items():
        if key != V3_2K_2L_WATCH:
            put(root, key, value)
    reader = ArtifactReader(root)
    baseline = build_targets(reader, observed_now)
    for mutation in ("stale_report", "stale_pin", "invalid", "foreign_scope", "foreign_row"):
        invalidate_2k_2l_report(root, data, mutation)
        assert build_targets(reader, observed_now) == baseline


def test_current_2k_2l_report_cannot_bind_a_foreign_sentinel_identity(root):
    from test_targets import NOW as observed_now, put
    data = current_2k_2l_data(None)
    data[sources.SENTINEL]["targets"][TWO_L_TARGET]["user"] = address(999)
    for key, value in data.items():
        put(root, key, value)
    rows = {row["id"]: row for row in build_targets(ArtifactReader(root), observed_now)["targets"]}
    assert rows[TWO_K_ID]["runner"]["source"] == V3_2K_2L_WATCH
    assert rows[TWO_L_ID]["runner"]["reported_armed"] is None
    assert rows[TWO_L_ID]["runner"]["freshness"] == "UNKNOWN"
    assert V3_2K_2L_WATCH not in rows[TWO_L_ID]["source_ids"]


def test_literal_and_query_normalization_filters_and_unknown_last_numeric_sort():
    data = near(users=(11, 12, 13))
    for row, bps in zip(data["targets"], ["0", "-2", "12"]):
        row["bpsToLiquidation"] = bps
    entries = ((1, "Aave V4", address(100), address(99), None),)
    reader = Reader({"aave_v4_near_watch": data}, {"aave_v4_borrower_index": entries})
    q = MultiDict([("q", "  Aave   Ethereum  "), ("source", "bad/private"), ("source", "aave_v4_near_watch"),
                   ("protocol", "Aave V4"), ("page", "999999999"), ("page_size", "999"), ("sort", "distance-desc")])
    view = build_inventory(reader, NOW, q)
    assert view["query"]["q"] == "Aave Ethereum" and view["query"]["source"] == ""
    assert view["query"]["page_size"] == 200 and view["query"]["page"] == 1
    assert "bad/private" not in json.dumps(view)
    assert [r["bps_numeric"] for r in view["targets"]] == ["12", "0", "-2", None]
    ascending = build_inventory(reader, NOW, {"sort": "distance-asc"})
    assert [r["bps_numeric"] for r in ascending["targets"]] == ["-2", "0", "12", None]
    empty = build_inventory(reader, NOW, {"q": "Aave .*"})
    assert empty["summary"]["total"] == 4 and empty["pagination"]["filtered_total"] == 0
    assert empty["pagination"]["start"] == empty["pagination"]["end"] == 0
    assert empty["options"] == view["options"]
    for value in ["0", "-1", "+2", "2.0", "１２", "1000000000"]:
        normalized, warnings = sources.normalize_query({"page": value})
        assert normalized["page"] == 1 and warnings == [{"parameter": "page", "code": "DEFAULTED"}]
    normalized, warnings = sources.normalize_query({"q": "x" * 129})
    assert len(normalized["q"]) == 128 and warnings == [{"parameter": "q", "code": "TRUNCATED"}]


def passive_candidates(values):
    return {"schema": "top-whale-triggers-status/v1", "generatedAt": iso(),
            "pin": {**block(), "utc": iso(NOW - 10)}, "targets": {
                "additional_AaveV3_weETH_WETH": [
                    {"user": address(i + 1), "pool": POOL, "healthFactor": "1.01", "liquidatableNow": False,
                     "passiveHoursToCrossing": value} for i, value in enumerate(values)]}}


def test_passive_sort_numeric_zero_precision_ties_and_full_filtered_set_before_pagination():
    values = ["10", "2", "0", "123456789012345678901234567890.000000000000000002",
              "123456789012345678901234567890.000000000000000001", None, "2"]
    reader = Reader({sources.SENTINEL: passive_candidates(values), sources.NEAR_WATCH: near()})
    whole = build_targets(reader, NOW, {"sort": "curated", "protocol": "Aave V3"})
    indexed = {r["id"]: r for r in whole["targets"]}
    ties = sorted(("aave-v3-extra-1", "aave-v3-extra-6"), key=lambda ident: indexed[ident]["position_key"])
    expected = ["aave-v3-extra-2", *ties, "aave-v3-extra-0", "aave-v3-extra-4", "aave-v3-extra-3", "aave-v3-extra-5"]
    seen = []
    for page in range(1, 5):
        view = build_targets(reader, NOW, {"sort": "passive_time", "protocol": "Aave V3", "page_size": "2", "page": str(page)})
        assert view["summary"]["total"] == 10 and view["pagination"]["filtered_total"] == 7
        seen += [r["id"] for r in view["targets"]]
        for row in view["targets"]:
            assert row["position"]["passive_hours"] == values[int(row["id"].rsplit("-", 1)[1])]
    assert seen == expected
    assert [r["id"] for r in build_targets(reader, NOW, {"protocol": "Aave V3"})["targets"]] == expected
    # Missing estimates tie by stable identity digest, never by input/curated order.
    unknown = build_targets(Reader({sources.SENTINEL: passive_candidates([None] * 7)}), NOW)["targets"]
    assert [r["position_key"] for r in unknown] == sorted(r["position_key"] for r in unknown)


@pytest.mark.parametrize("value", [None, "", "invalid", "NaN", "Infinity", float("inf"), float("nan"), "-0.1", True])
def test_passive_sort_missing_invalid_nonfinite_and_negative_last(value):
    view = build_targets(Reader({sources.SENTINEL: passive_candidates([value, "10"])}), NOW)
    assert [r["id"] for r in view["targets"]] == ["aave-v3-extra-1", "aave-v3-extra-0"]
    assert view["targets"][1]["position"]["passive_hours"] is None


@pytest.mark.parametrize("state", ["aging", "stale", "unpinned", "unknown_health", "conflict", "closed", "closed_stale", "selected_missing"])
def test_passive_sort_uses_selected_fresh_known_open_evidence_only(monkeypatch, state):
    original = sources.adapt
    def adapt(*args):
        batch = original(*args)
        if batch.source.id != sources.SENTINEL:
            return batch
        key = next(key for key in batch.evidence if key[4] == address(1))
        evidence = batch.evidence[key][0]
        if state in {"aging", "stale", "closed_stale"}:
            evidence.pin["utc"] = iso(NOW - (1800 if state == "aging" else 4000))
        if state == "unpinned":
            evidence.pin = {}
        elif state == "unknown_health":
            evidence.health_known = False
        elif state == "conflict":
            batch.evidence[key].append(replace(evidence, hf=Decimal("0.9"), eligible=True))
        elif state.startswith("closed"):
            evidence.position_status = "CLOSED"
        elif state == "selected_missing":
            # The newer selected bundle lacks a time; the older curated 0 is not a fallback.
            batch.evidence[key].append(replace(evidence, pin={**evidence.pin, "block": 1001}, position={}))
        return batch
    monkeypatch.setattr(sources, "adapt", adapt)
    view = build_targets(Reader({sources.SENTINEL: passive_candidates(["0", "10"])}), NOW)
    assert [r["id"] for r in view["targets"]] == ["aave-v3-extra-1", "aave-v3-extra-0"]
    if state == "selected_missing":
        assert view["targets"][1]["position"]["passive_hours"] is None
    if state == "unpinned":
        assert view["targets"][1]["observation"]["age_text"] is None


@pytest.mark.parametrize("runner_state", ["blocked", "held"])
def test_passive_sort_retains_fresh_estimates_despite_runner_gate(runner_state):
    from test_targets import fixtures, NOW as observed_now
    data = fixtures()
    first, second = "target2A_AaveV3_weETH_WETH_0x7231", "target2B_AaveV3_weETH_WETH_0x1A55"
    data[sources.SENTINEL]["targets"] = {key: data[sources.SENTINEL]["targets"][key] for key in (first, second)}
    data[sources.SENTINEL]["targets"][first]["passiveHoursToCrossing"] = "0"
    data[sources.SENTINEL]["targets"][second]["passiveHoursToCrossing"] = "10"
    data[sources.V3_WATCH].update(ok=False, armed=False, mode="BLOCKED")
    if runner_state == "held":
        raw = passive_candidates(["10"])
        raw["targets"]["targetA13_AaveV4_wstETH_WETH_0x4cd7"] = {
            "rank": "#A13", "user": near_user(12), "spoke": near_spoke(12),
            "healthFactor": "1.01", "liquidatableNow": False, "passiveHoursToCrossing": "0"}
        data, observed_now = {sources.SENTINEL: raw, sources.NEAR_WATCH: near(users=(12,))}, NOW
    row = build_targets(Reader(data), observed_now)["targets"][0]
    assert row["position"]["passive_hours"] == "0"
    assert row["protocol_status"] == "WATCH" and row["runner"]["reported_armed"] is not True
    assert row["status"]["code"] == ("HELD" if runner_state == "held" else "WATCH")


@pytest.mark.parametrize("query", [{}, {"sort": "invalid"}, {"sort": ""}, {"sort": None}])
def test_sort_defaults_follow_candidate_or_inventory_view(query):
    reader = Reader({sources.SENTINEL: passive_candidates(["10", "2"])})
    candidates, inventory = build_targets(reader, NOW, query), build_inventory(reader, NOW, query)
    assert candidates["query"]["sort"] == "passive_time"
    assert inventory["query"]["sort"] == "curated"
    assert [r["id"] for r in candidates["targets"]] == ["aave-v3-extra-1", "aave-v3-extra-0"]
    assert [r["id"] for r in inventory["targets"]] == ["aave-v3-extra-0", "aave-v3-extra-1"]
    for builder in (build_targets, build_inventory):
        for sort in sources.SORTS:
            view = builder(reader, NOW, {"sort": sort})
            assert view["query"]["sort"] == sort
            assert not view["query_warnings"]


def test_passive_sort_html_json_selected_option_and_links_agree(root, client, monkeypatch):
    monkeypatch.setattr(importlib.import_module("dashboard.app").time, "time", lambda: NOW)
    (root / ALLOWLIST[sources.SENTINEL]).write_text(json.dumps(passive_candidates(["10", "2", "0"])), encoding="utf8")
    query = "?protocol=Aave+V3&page_size=1&page=2&sort=invalid"
    view = get(client, "/api/v1/targets" + query).get_json()
    html = get(client, "/targets" + query).get_data(as_text=True)
    assert view["query"]["sort"] == "passive_time" and view["targets"][0]["position"]["passive_hours"] == "2"
    assert '<option value="passive_time" selected>Passive time: soonest</option>' in html
    assert f'id="target-{view["targets"][0]["position_key"]}"' in html
    assert "sort=passive_time" in html and "sort=invalid" not in html
    assert "/api/v1/targets?" in html and "page=3" in html


def test_source_and_status_filters_use_global_provenance_not_the_page():
    reader = Reader({"aave_v4_near_watch": near()}, {"aave_v4_borrower_index": ((1, "Aave V4", near_spoke(12), near_user(12), None),)})
    view = build_inventory(reader, NOW, {"source": "aave_v4_borrower_index", "status": "HELD", "page_size": "1"})
    assert view["summary"]["total"] == 3 and view["pagination"]["filtered_total"] == 1
    assert view["targets"][0]["borrower_address"] == near_user(12)


def test_recheck_excludes_input_that_changes_after_adapter_before_final_vector():
    reader = Reader({"aave_v4_near_watch": near()})
    counts = {}
    def fingerprint(key):
        counts[key] = counts.get(key, 0) + 1
        if key == "aave_v4_near_watch" and counts[key] >= 2:
            return (9, 9)
        return reader.versions.get(key)
    reader.fingerprint_hook = fingerprint
    view = build_targets(reader, NOW)
    assert view["summary"]["total"] == 0
    assert coverage(view, "aave_v4_near_watch")["read_state"] == "UNAVAILABLE"
    assert "changed" in " ".join(coverage(view, "aave_v4_near_watch")["limitations"])


def test_untrusted_text_and_nonfinite_fields_do_not_escape_source_whitelists():
    raw = near()
    poison = "<script>private https://bad.invalid .env KEY=SECRET</script>"
    raw["targets"][0].update(label=poison, pair=poison, readinessStatus=poison, rawError=poison, healthFactorRaw=poison)
    raw["targets"][2]["bpsToLiquidation"] = float("inf")
    raw["heldTargets"][0]["reason"] = poison
    view = build_targets(Reader({"aave_v4_near_watch": raw}), NOW)
    encoded = json.dumps(view, allow_nan=False)
    assert not any(token in encoded for token in ["<script", "SECRET", "bad.invalid", ".env", "rawError", "Infinity"])


def test_real_artifact_reader_json_fixtures_current_false_rejected(root):
    path = root / ALLOWLIST["aave_v4_near_watch"]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(near()), encoding="utf8")
    reader = ArtifactReader(root)
    assert build_targets(reader, NOW)["summary"]["total"] == 3
    path.write_text("{invalid", encoding="utf8")
    view = build_targets(reader, NOW)
    assert view["summary"]["total"] == 0
    assert coverage(view, "aave_v4_near_watch")["read_state"] == "INVALID"


def test_partial_runner_heartbeat_without_identities_reports_unknown_input_count():
    value = {"ok": False, "armed": False, "mode": "BLOCKED", "checkedAt": iso(),
             "enabledTargetIds": ["rank1"], "armedTargetIds": [], "heldTargets": [{"targetId": "rank2"}]}
    view = build_targets(Reader({"aave_v4_near_watch": value}), NOW)
    assert view["summary"]["total"] == 0
    c = coverage(view, "aave_v4_near_watch")
    assert c["read_state"] == "PARTIAL" and c["input_rows"] is None
    assert view["coverage"]["complete"] is False


def test_broad_healthy_bundle_does_not_freshen_stale_sentinel_quote():
    raw = {"schema": "top-whale-triggers-status/v1", "generatedAt": iso(NOW - 4000),
           "pin": {**block(999, age=4010), "utc": iso(NOW - 4010)},
           "targets": {"spokeC_AaveV4_weETH_WETH": [{"user": near_user(11), "spoke": near_spoke(11),
             "healthFactor": 1.1, "liquidatableNow": False, "bpsToLiquidation": 1000,
             "liveQuote": {"repayWeth": 100, "seizedWeEth": 101, "curveOutWeth": 99,
                           "grossSurplusWeth": -1, "grossSurplusUsd": -2400,
                           "provenance": "ONCHAIN_MEASURED", "observationBlock": 999,
                           "observationHash": block()["hash"], "observationUtc": iso(NOW - 4010)}}]}}
    reader = Reader({sources.SENTINEL: raw, "aave_v4_near_watch": near(users=(11,), factor="990000000000000000")})
    row = build_targets(reader, NOW)["targets"][0]
    assert row["id"] == "spoke-c-0"
    assert row["observation"]["freshness"] == "FRESH" and row["status"]["code"] == "ELIGIBLE"
    assert row["quote"]["freshness"] == "STALE"
    assert row["quote"]["block"] == 999 and row["observation"]["block"] == 1000
    assert row["quote"]["gross_usd"] is row["gross_usd_numeric"] is None
    assert row["quote"]["estimate"]["gross_usd"] == "-2400"
    assert row["quote"]["gross_token_amount"] is None and row["quote"]["estimate"]["gross_token_amount"] == "-1"


def test_unpinned_v3_observations_are_retained_but_not_eligible_and_duplicates_union():
    row = {"chainId": 1, "pool": POOL, "user": address(55), "healthFactor": 0.95, "liquidatable": True,
           "bpsToLiquidation": -500, "totalDebtUsd": 10000, "totalCollateralUsd": 11000}
    raw = {"generatedAt": iso(), "chains": [{"chainId": 1, "pool": POOL, "latestBlock": 500, "topRows": [row]}],
           "globalTopRows": [row], "globalShadowRows": [row]}
    reader = Reader({"aave_v3_route_distance": raw})
    view = build_inventory(reader, NOW)
    assert view["summary"]["total"] == 1
    assert coverage(view, "aave_v3_route_distance")["input_rows"] == 3
    assert coverage(view, "aave_v3_route_distance")["accepted_rows"] == 1
    row = view["targets"][0]
    assert row["protocol_status"] == "UNKNOWN" and row["liquidatable_now"] is None
    assert row["observation"]["block"] is row["observation"]["hash"] is None


def test_all_fixed_json_adapter_paths_and_distinct_market_records():
    user, venue, market = address(55), address(88), "0x" + "a" * 64
    v4row = {"user": user, "spoke": venue, "account": {"healthFactorRaw": "1100000000000000000"}, "liquidatable": False}
    values = {
        "aave_v4_spoke_borrowers": {"generatedAt": iso(), "chain": {"id": 1, "blockNumber": 1000, "blockHash": "0x" + "a" * 64, "timestamp": NOW - 10},
                                    "spokes": [{"spoke": venue, "topUsers": [v4row]}], "topUsers": [v4row], "watchCandidates": [v4row]},
        "aave_v3_trigger_readiness": {"generatedAt": iso(), "topRow": {"chain": "Ethereum", "pool": POOL, "borrower": user}, "live": {"account": {"healthFactor": 1.1}}},
        "aave_v3_liquidation_exact_quotes": {"generatedAt": iso(), "chainId": 1, "pool": POOL, "borrower": user, "liveAccountData": {"healthFactor": "1100000000000000000"}},
        "aave_v3_liquidation_trigger_quotes": {"generatedAt": iso(), "chainId": 1, "pool": POOL, "borrower": user},
        "euler_l_watch": {"generatedAt": iso(), "vaults": [{"vault": venue, "violatorChecks": [{"violator": user}, {"violator": user}]}]},
        "euler_l_surface": {"chainId": 1, "scannedAt": iso(), "vaults": [{"vault": venue, "topLiquidateEvents": [{"violator": user}]}]},
        "morpho_blue_liquidatable_base": {"chainId": 8453, "scannedAt": iso(), "rows": [{"marketId": market, "borrower": user, "fullDebtRaw": "123"}]},
        "morpho_ws_status": {"updatedAt": iso(), "recent": [{"chainId": 8453, "marketId": market, "borrower": user}]},
        "silo_l_economics": {"generatedAt": iso(), "rows": [{"chainId": 1, "debtSilo": venue, "borrower": user}]},
        "silo_default_watch_status": {"generatedAt": iso(), "trackedAccounts": [{"chainId": 1, "silo": venue, "account": user}]},
        "silo_default_step1": {"borrower": user, "silo": venue},  # deliberately offline, not a position
        "state": {"conditions": {"aave-v3-hf-watch": {"lastResult": {"results": [{"chainId": 1, "pool": POOL, "user": user}]}},
                                  "euler-vault-donation-watch": {"lastResult": {"newVaults": [{"chainId": 1, "vault": venue}]}},
                                  "silo-oracle-watch": {"lastResult": {"results": [{"chainId": 1, "siloCount": 9}]}}}},
        "venus_psr": {"chains": {"ethereum": {"chainId": 1, "current": {"markets": [{"vToken": venue}]}}}},
    }
    view = build_inventory(Reader(values), NOW)
    assert view["summary"]["total"] == 7
    assert sum(r["record_type"] == "market" for r in view["targets"]) == 2
    assert all(coverage(view, source)["read_state"] == "OK" for source in values)
    assert coverage(view, "silo_default_step1")["accepted_rows"] == 0
    assert {r["protocol"] for r in view["targets"]} == {"Aave V3", "Aave V4", "Morpho Blue", "Euler", "Silo", "Venus"}


def test_exact_uint256_and_high_precision_negative_sort_are_not_float_or_decimal_rounded():
    maximum = str(2**256 - 1)
    assert sources.raw_position(maximum)["debt_amount"] == maximum
    assert sources.raw_position(1e30)["debt_amount"] is None  # raw float units are not exact
    data = near(users=(11, 12))
    data["targets"][0]["bpsToLiquidation"] = "123456789012345678901234567890.000000000000000001"
    data["targets"][1]["bpsToLiquidation"] = "123456789012345678901234567890.000000000000000002"
    view = build_targets(Reader({"aave_v4_near_watch": data}), NOW, {"sort": "distance-desc"})
    assert [r["borrower_address"] for r in view["targets"]] == [near_user(12), near_user(11)]


def test_malformed_source_isolated_and_missing_armed_scope_is_not_false_arming():
    raw = near()
    del raw["armedTargetIds"]
    view = build_targets(Reader({"aave_v4_near_watch": raw, "aave_v3_route_distance": {"chains": "bad"}}), NOW)
    assert view["summary"]["total"] == 3
    assert all(r["runner"]["reported_armed"] is None for r in view["targets"])
    assert coverage(view, "aave_v4_near_watch")["read_state"] == "PARTIAL"
    assert coverage(view, "aave_v3_route_distance")["read_state"] == "INVALID"
    assert coverage(view, "aave_v3_route_distance")["input_rows"] is None


@pytest.mark.parametrize("value", [True, None, -1, 0, NOW - 5.5, (NOW - 5) * 1000])
def test_invalid_runner_pin_timestamp_never_creates_measured_health_or_arming(value):
    raw = near()
    raw["pin"]["timestamp"] = value
    view = build_targets(Reader({"aave_v4_near_watch": raw}), NOW)
    assert all(row["protocol_status"] == "UNKNOWN" for row in view["targets"])
    assert all(row["runner"]["reported_armed"] is not True for row in view["targets"])
    held = next(row for row in view["targets"] if row["borrower_address"] == near_user(12))
    assert held["status"]["code"] == "HELD" and held["runner"]["reported_armed"] is False


def near_public_identities():
    return {"chainId": 1, "actions": [
        {"targetId": ident, "spoke": binding[0], "borrower": binding[1], "executor": binding[2]}
        for ident, binding in sources.NEAR_BINDINGS.items()]}


def blocked_heartbeat(age=5):
    return {"ok": False, "armed": False, "mode": "BLOCKED", "checkedAt": iso(NOW - age),
            "enabledTargetIds": [NEAR_IDS[0], NEAR_IDS[2]], "armedTargetIds": [],
            "heldTargets": [{"targetId": NEAR_IDS[1], "reason": "UNTRUSTED_BLOCK_REASON"}]}


@pytest.mark.parametrize("age,freshness,status", [(5, "FRESH", "HELD"), (1800, "AGING", "UNKNOWN"), (4000, "STALE", "UNKNOWN")])
def test_blocked_heartbeat_joins_only_current_public_identities_with_independent_age(age, freshness, status):
    raw = near_public_identities()
    raw.update(generatedAt=iso(), approvedAt=iso(), expiresAt=iso(NOW + 99999), approved=True,
               pin=block(), healthFactor="0.5", armed=True)
    reader = Reader({sources.NEAR_IDENTITIES: raw, sources.NEAR_WATCH: blocked_heartbeat(age)},
                    {"aave_v4_borrower_index": tuple((1, "Aave V4", b[0], b[1], None) for b in sources.NEAR_BINDINGS.values())})
    view = build_targets(reader, NOW, {"source": sources.NEAR_WATCH})
    assert view["summary"]["total"] == view["pagination"]["filtered_total"] == 3
    assert {r["borrower_address"] for r in view["targets"]} == {b[1] for b in sources.NEAR_BINDINGS.values()}
    held = next(r for r in view["targets"] if r["borrower_address"] == near_user(12))
    assert held["status"]["code"] == status and held["protocol_status"] == "UNKNOWN"
    assert held["runner"]["held"] is True and held["runner"]["freshness"] == freshness
    assert held["runner"]["checked_at"] == iso(NOW - age)
    assert held["runner"]["reported_armed"] is (False if age == 5 else None)
    for row in view["targets"]:
        assert row["runner"]["reported_armed"] is not True
        assert row["health_factor"] is None and row["liquidatable_now"] is None
        assert row["observation"]["block"] is row["observation"]["hash"] is None
        assert row["quote"]["available"] is False
        provenance = next(p for p in row["provenance"] if p["source"] == sources.NEAR_IDENTITIES)
        assert provenance["generated_at"] is provenance["block"] is provenance["hash"] is provenance["utc"] is None
        assert provenance["freshness"] == "UNKNOWN"
    assert coverage(view, sources.NEAR_WATCH)["read_state"] == "PARTIAL"
    assert coverage(view, sources.NEAR_WATCH)["input_rows"] is None
    assert coverage(view, sources.NEAR_WATCH)["accepted_rows"] == 3
    assert coverage(view, sources.NEAR_IDENTITIES)["accepted_rows"] == 3
    assert "UNTRUSTED_BLOCK_REASON" not in json.dumps(view)


def test_public_approval_metadata_changes_have_no_effect_on_health_arming_or_freshness():
    raw = near_public_identities()
    reader = Reader({sources.NEAR_IDENTITIES: raw, sources.NEAR_WATCH: blocked_heartbeat()})
    before = build_targets(reader, NOW)
    raw.update(approved=True, approvalId="DO_NOT_EXPORT", expiresAt=iso(NOW + 999999), approvedAt=iso(),
               generatedAt=iso(), checkedAt=iso(), armed=True, permissions={"anything": True}, caps={"gas": 9999999})
    raw["actions"][1].update(approved=True, expiresAt=iso(NOW + 999999))
    reader.versions[sources.NEAR_IDENTITIES] = (2, 2)
    assert build_targets(reader, NOW) == before
    raw.update(approved=False, expiresAt=iso(NOW - 999999), generatedAt=iso(NOW - 999999))
    reader.versions[sources.NEAR_IDENTITIES] = (3, 3)
    assert build_targets(reader, NOW) == before


@pytest.mark.parametrize("field", ["borrower", "spoke", "executor", "targetId", "duplicate", "chainId"])
def test_conflicting_or_duplicate_public_bindings_never_receive_heartbeat_telemetry(field):
    raw = near_public_identities()
    if field == "duplicate":
        raw["actions"].append(copy.deepcopy(raw["actions"][1]))
    else:
        raw["actions"][1][field] = "unknown_target" if field == "targetId" else 8453 if field == "chainId" else address(999)
    view = build_targets(Reader({sources.NEAR_IDENTITIES: raw, sources.NEAR_WATCH: blocked_heartbeat()}), NOW)
    assert view["summary"]["total"] == 2
    assert all(r["borrower_address"] != near_user(12) and r["status"]["code"] != "HELD" for r in view["targets"])
    assert coverage(view, sources.NEAR_IDENTITIES)["read_state"] == "PARTIAL"
    assert coverage(view, sources.NEAR_IDENTITIES)["rejected_rows"] == (2 if field == "duplicate" else 1)


@pytest.mark.parametrize("field", ["borrower", "spoke", "executor", "id", "duplicate", "chainId"])
def test_conflicting_full_near_telemetry_cannot_be_repaired_by_fallback_target_id(field):
    raw = near()
    if field == "duplicate":
        raw["targets"].append(copy.deepcopy(raw["targets"][1]))
    else:
        raw["targets"][1][field] = "unknown_target" if field == "id" else 8453 if field == "chainId" else address(999)
    view = build_targets(Reader({sources.NEAR_IDENTITIES: near_public_identities(), sources.NEAR_WATCH: raw}), NOW)
    assert view["summary"]["total"] == 3
    held_identity = next(r for r in view["targets"] if r["borrower_address"] == near_user(12))
    assert held_identity["protocol_status"] == "UNKNOWN"
    assert held_identity["status"]["code"] != "HELD" and held_identity["runner"]["reported_armed"] is None
    assert sources.NEAR_WATCH not in held_identity["source_ids"]
    assert coverage(view, sources.NEAR_WATCH)["read_state"] == "PARTIAL"


@pytest.mark.parametrize("state", ["MISSING", "INVALID", "OVERSIZED", "UNAVAILABLE"])
def test_noncurrent_public_identity_fallback_never_promotes_cached_bindings(state):
    reader = Reader({sources.NEAR_IDENTITIES: near_public_identities(), sources.NEAR_WATCH: blocked_heartbeat()})
    assert build_targets(reader, NOW)["summary"]["total"] == 3
    reader.failures[sources.NEAR_IDENTITIES] = state  # cached value deliberately remains present
    view = build_targets(reader, NOW)
    assert view["summary"]["total"] == 0
    assert coverage(view, sources.NEAR_IDENTITIES)["read_state"] == state


@pytest.mark.parametrize("changed", [sources.NEAR_IDENTITIES, sources.NEAR_WATCH])
def test_final_fingerprint_change_drops_dependent_heartbeat_attribution(changed):
    reader = Reader({sources.NEAR_IDENTITIES: near_public_identities(), sources.NEAR_WATCH: blocked_heartbeat()})
    counts = {}
    def fingerprint(key):
        counts[key] = counts.get(key, 0) + 1
        return (9, 9) if key == changed and counts[key] >= 2 else reader.versions.get(key)
    reader.fingerprint_hook = fingerprint
    view = build_targets(reader, NOW, {"source": sources.NEAR_WATCH})
    assert view["pagination"]["filtered_total"] == 0
    assert view["summary"]["total"] == (0 if changed == sources.NEAR_IDENTITIES else 3)
    assert coverage(view, changed)["read_state"] == "UNAVAILABLE"


def test_fallback_hold_uses_only_checked_at_and_does_not_erase_independent_health():
    heartbeat = blocked_heartbeat()
    watch = {"generatedAt": iso(), "latest": {"generatedAt": iso(), "chain": {"id": 1, "blockNumber": 1000,
             "blockHash": "0x" + "a" * 64, "timestamp": NOW - 10},
             "topRows": [{"spoke": near_spoke(12), "user": near_user(12), "healthFactor": 1.1, "liquidatable": False}]}}
    reader = Reader({sources.NEAR_IDENTITIES: near_public_identities(), sources.NEAR_WATCH: heartbeat, "aave_v4": watch})
    held = next(r for r in build_targets(reader, NOW)["targets"] if r["borrower_address"] == near_user(12))
    assert held["status"]["code"] == "HELD" and held["protocol_status"] == "WATCH"
    assert held["observation"]["source"] == "aave_v4"
    del heartbeat["checkedAt"]
    heartbeat["generatedAt"] = iso()
    row = next(r for r in build_targets(reader, NOW)["targets"] if r["borrower_address"] == near_user(12))
    assert row["status"]["code"] == "WATCH" and row["runner"]["freshness"] == "UNKNOWN"
    assert row["runner"]["checked_at"] is None and row["runner"]["reported_armed"] is None


def test_fixed_public_identity_registration_uses_current_only_artifact_reader(root):
    for key, data in ((sources.NEAR_IDENTITIES, near_public_identities()), (sources.NEAR_WATCH, blocked_heartbeat())):
        path = root / ALLOWLIST[key]
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data), encoding="utf8")
    assert ALLOWLIST[sources.NEAR_IDENTITIES] == "coordination/live-execution-batch-aave-v4-near-liquidation-20261019.json"
    reader = ArtifactReader(root)
    assert build_targets(reader, NOW)["summary"]["total"] == 3
    (root / ALLOWLIST[sources.NEAR_IDENTITIES]).unlink()
    assert build_targets(reader, NOW)["summary"]["total"] == 0


def test_public_shortlist_ignores_warm_inventory_generation_and_never_reads_indexes(monkeypatch):
    values = {sources.NEAR_IDENTITIES: near_public_identities(), sources.NEAR_WATCH: blocked_heartbeat(),
              "aave_v4": {"generatedAt": iso(), "latest": {"chain": {"id": 1},
                          "topRows": [{"spoke": address(900), "user": address(901), "healthFactor": 0.5, "liquidatable": True}]}},
              "euler_silo_current_screen": current_screen(), "research_watch": {"entries": [{}] * 45}}
    indexes = {s.id: ((1, "Aave V3", POOL, address(999), None),) for s in sources.SOURCES if s.kind == "index"}
    reader = Reader(values, indexes)
    assert build_inventory(reader, NOW)["summary"]["total"] > 3
    generation = sources._GENERATIONS[reader]
    reader.calls.clear()
    monkeypatch.setattr(reader, "read_target_index", lambda key: pytest.fail("Public shortlist read an identity index"))
    for query in ({}, {"view_mode": "inventory", "trade_candidates": "false", "all": "true"},
                  {"source": "morpho_blue_base_index", "page_size": "200"}):
        view = build_targets(reader, NOW, query)
        assert view["summary"]["total"] == view["pagination"]["filtered_total"] == 3
        assert view["view_mode"] == "trade_candidates"
        assert {r["borrower_address"] for r in view["targets"]} == {b[1] for b in sources.NEAR_BINDINGS.values()}
        assert {c["id"] for c in view["coverage"]["sources"]} == {s.id for s in sources.TRADE_SOURCES}
        assert {s["value"] for s in view["options"]["sources"]} == {s.id for s in sources.TRADE_SOURCES}
        assert view["options"]["protocols"] == [{"value": "Aave V4", "label": "Aave V4"}]
        assert view["options"]["chains"] == [{"value": "Ethereum", "label": "Ethereum"}]
        assert coverage(view, "aave_v4")["accepted_rows"] == 0
        assert all(c["reported_total"] is None for c in view["coverage"]["sources"])
    assert sources._GENERATIONS[reader] is generation
    assert all(key in {s.id for s in sources.TRADE_SOURCES} for _, key in reader.calls)
    assert not any(kind == "index" for kind, _ in reader.calls)
    assert {key for kind, key in reader.calls if kind == "json"} == {s.id for s in sources.TRADE_SOURCES}


def test_public_shortlist_excludes_broad_only_and_outside_curated_array_members_before_pagination():
    candidates = [{"user": address(i + 1), "pool": POOL, "healthFactor": 1.1, "liquidatableNow": False,
                   "bpsToLiquidation": 1000, "label": "candidate"} for i in range(30)]
    sentinel = {"schema": "top-whale-triggers-status/v1", "generatedAt": iso(), "pin": {**block(), "utc": iso(NOW - 10)},
                "targets": {"additional_AaveV3_weETH_WETH": candidates}}
    reader = Reader({sources.SENTINEL: sentinel, sources.V4_WATCH: {"checkedAt": iso(), "pin": block(),
                    "candidateCount": 999999, "targets": [{"id": "spokeA-candidate1-usde-usdc", "spoke": address(200),
                    "borrower": address(1), "healthFactorRaw": "900000000000000000", "isLiquidatableBothProviders": True}]}})
    seen = []
    for page in range(1, 5):
        view = build_targets(reader, NOW, {"page": str(page), "page_size": "2", "sort": "protocol"})
        assert view["summary"]["total"] == view["pagination"]["filtered_total"] == 7
        assert view["pagination"]["pages"] == 4
        assert view["options"]["protocols"] == [{"value": "Aave V3", "label": "Aave V3"}]
        seen.extend(r["position_key"] for r in view["targets"])
        assert coverage(view, sources.SENTINEL)["input_rows"] == 30
        assert coverage(view, sources.SENTINEL)["accepted_rows"] == 7
    assert len(seen) == len(set(seen)) == 7
    for query in ({"q": address(30)}, {"protocol": "Aave V4"}, {"source": sources.V4_WATCH}):
        view = build_targets(reader, NOW, query)
        assert view["summary"]["total"] == 7 and view["pagination"]["filtered_total"] == 0
    del reader.values[sources.SENTINEL]
    assert build_targets(reader, NOW)["summary"]["total"] == 0  # runner rows/counts alone do not curate a position


@pytest.mark.parametrize("state", ["MISSING", "INVALID", "UNAVAILABLE"])
def test_public_shortlist_retains_three_current_identities_when_near_health_is_unavailable(state):
    reader = Reader({sources.NEAR_IDENTITIES: near_public_identities(), sources.NEAR_WATCH: near()})
    assert build_targets(reader, NOW)["summary"]["total"] == 3
    reader.failures[sources.NEAR_WATCH] = state
    view = build_targets(reader, NOW)
    assert view["summary"]["total"] == 3
    for row in view["targets"]:
        assert row["protocol_status"] == "UNKNOWN" and row["runner"]["reported_armed"] is None
        assert row["source_ids"] == [sources.NEAR_IDENTITIES]
        assert row["health_factor"] is None and row["quote"]["available"] is False


@pytest.mark.parametrize("eligible,executable", [(False, False), (True, False), (True, True)])
def test_sentinel_m7b_protocol_health_keeps_buffer_note_separate_from_armed_runner(eligible, executable):
    key = "targetM7B_Morpho_ynETHx_msETH_0x9b13"
    market = "0xd2630c0ebf33ba83c82e8cd400a8e6345370238ca695ce58773b2d3e43de1b0a"
    user = "0x9b1303ebf09bc51b7fac376c9e421e8daae63b82"
    raw = {"schema": "top-whale-triggers-status/v1", "generatedAt": iso(), "pin": {**block(), "utc": iso(NOW - 10)},
           "targets": {key: {"rank": "#M7B", "pair": "ynETHx / msETH", "user": user, "marketId": market,
               "healthFactor": .999 if eligible else 1.01, "liquidatableNow": executable,
               "hfUnderwaterNow": eligible,  # Protocol health remains independent of the buffer-gated execution flag.
               "bpsToLiquidation": -10.01 if eligible else 99.0099, "observationOnly": False,
               "armed": True, "executableNow": executable,
               "executor": "0xc06326bc6fbd4305cdab4de8e239b7b80feb2eb4",
               "liveQuote": {"estimatedProfitUsd": 2080.15}}}}
    batch = sources.Batch(sources.BY_SOURCE[sources.SENTINEL],
        {"input_rows": 0, "rejected_rows": 0, "omitted_rows": 0, "truncated": False, "read_state": "OK", "limitations": []},
        at=iso(), now=NOW)
    sources.sentinel(batch, raw)
    evidence = next(iter(batch.evidence.values()))[0]
    note = "Protocol health is underwater, but execution remains blocked by ynETHx/MCwETH withdrawal buffer capacity."
    assert evidence.eligible is eligible and evidence.health_known is True
    assert evidence.notes == ((note,) if eligible and not executable else ())
    assert evidence.runner is None and evidence.quote["available"] is False
    assert "rehearsal estimates" in " ".join(evidence.quote["notes"])
    view = build_targets(Reader({sources.SENTINEL: raw}), NOW)
    assert len(view["targets"]) == 1 and coverage(view, sources.SENTINEL)["rejected_rows"] == 0
    row = view["targets"][0]
    assert row["id"] == sources.SINGLES[key] and row["rank"] == "#M7B"
    assert row["borrower_address"] == user and row["venue_address"] == MORPHO and row["market_id"] == market
    assert row["protocol"] == "Morpho Blue" and row["chain_id"] == 1
    assert row["protocol_status"] == ("ELIGIBLE" if eligible else "WATCH")
    assert row["status"]["code"] == row["protocol_status"] and row["observation_only"] is False
    assert row["armed"] is None and row["executable_now"] is row["calldata_ready"] is False
    assert row["runner"]["label"] == "Unified Morpho M7" and row["runner"]["reported_armed"] is None
    assert row["executor_address"] == "0xc06326bc6fbd4305cdab4de8e239b7b80feb2eb4"
    assert (note in row["blockers"]) is (eligible and not executable)
    assert row["quote"]["available"] is False and row["surplus_usd"] is None


def test_sentinel_m7_underwater_base_z_utc_and_morpho_wsteth_resolve_in_shortlist():
    eth_utc = iso(NOW - 10).replace("+00:00", ".000Z")
    base_utc = iso(NOW - 5).replace("+00:00", ".000Z")
    eth_pin = {**block(26237509, 1, 10, "a"), "utc": eth_utc}
    base_pin = {**block(52877345, 8453, 5, "B"), "utc": base_utc}
    sentinel = {
        "schema": "top-whale-triggers-status/v1", "generatedAt": iso(), "pin": eth_pin,
        "baseObservation": {"status": "COMPLETE", "pin": base_pin},
        "targets": {
            "targetM7_Morpho_ynETHx_msETH_Canary": {
                "rank": "#M7", "user": "0x14bcd9da052cdc6fe0b9446d5a616d5b7b4d4550",
                "marketId": "0xd2630c0ebf33ba83c82e8cd400a8e6345370238ca695ce58773b2d3e43de1b0a",
                "executor": "0xc06326bc6fbd4305cdab4de8e239b7b80feb2eb4", "armed": True,
                "healthFactor": 0.992375, "hfUnderwaterNow": True, "liquidatableNow": False,
                "executableNow": False, "bpsToLiquidation": -76.8359,
            },
            "morpho_wstETH_WETH_Whales": [{
                "rank": "#M3", "user": "0xb224f589297a5a207e6069de5dafd4b120129817",
                "marketId": "0xb8fc70e82bc5bb53e773626fcc6a23f7eefa036918d7ef216ecfb1950a94a85e",
                "pair": "wstETH / WETH", "healthFactor": 1.005211, "liquidatableNow": False,
                "bpsToLiquidation": 51.8399, "deployedExecutor": "0xaf5b033e23ac555c09096bf39979a855e09907ba",
            }],
            "extra_Base_USDe_Whales": [{
                "rank": "#B7", "user": sources.ops.BASE_YOUSD_BORROWER, "marketId": sources.ops.BASE_YOUSD_MARKET,
                "pair": "yoUSD / USDC (Base)", "chainId": 8453, "observationBlock": 52877345,
                "observationHash": "0x" + "B" * 64, "observationUtc": base_utc,
                "observationStatus": "COMPLETE", "armed": True, "observationOnly": False,
                "deployedExecutor": "0x88bff83b4c987cc90a863cd79baa54dd5cd94f32",
                "healthFactor": 1.004036, "healthIsEstimate": False, "liquidatableNow": False,
                "bpsToLiquidation": 40.1983, "debtUsdc": 4051.09,
                "liveQuote": {"repayUsdc": 4266.33, "seizedUsde": 4100, "uniV3OutUsdc": 4377.97, "grossSurplusUsdc": 111.64},
            }],
        },
    }
    view = build_targets(Reader({sources.SENTINEL: sentinel}), NOW)
    assert coverage(view, sources.SENTINEL)["rejected_rows"] == 0
    by_rank = {r["rank"]: r for r in view["targets"]}
    assert by_rank["#M7"]["status"]["code"] == "ELIGIBLE"
    assert by_rank["#M7"]["health_factor"] == "0.992375"
    assert by_rank["#M7"]["executable_now"] is False
    assert any("withdrawal buffer capacity" in b for b in by_rank["#M7"]["blockers"])
    assert by_rank["#M3"]["status"]["code"] == "WATCH" and by_rank["#M3"]["health_factor"] == "1.005211"
    assert by_rank["#B7"]["status"]["code"] == "WATCH" and by_rank["#B7"]["health_factor"] == "1.004036"
    assert by_rank["#B7"]["observation_block"] == 52877345
    assert any("share-bounded cap is required" in b for b in by_rank["#B7"]["blockers"])
