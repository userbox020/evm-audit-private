"""Offline curated inventory contract; no live artifacts, collectors or RPC."""

import importlib
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from flask import url_for
from jinja2 import DictLoader

from conftest import get
from dashboard.app import create_app
from dashboard import liquidity


AS_OF = "2026-10-27"
SCAN_AS_OF = "2026-10-25"
ENDPOINTS = ("/liquidity", "/api/v1/liquidity")
ROUTE_FIELDS = {
    "id", "name", "category", "category_label", "chains", "status", "status_label",
    "atomicity", "paths", "funding", "fees", "repayment", "evidence", "blockers",
    "next_check", "source_refs", "reviewed_at", "capacity", "execution",
}
EXPECTED_IDS = {
    "funding-morpho-blue", "funding-balancer-v2", "funding-aave-v3-pool",
    "funding-uniswap-v4-unlock", "funding-morpho-collateral-first",
    "funding-silo-default-keeper", "funding-prefunded-fixtures",
    "credit-morpho-collateral-borrow", "credit-aave-base", "credit-comet",
    "credit-fluid", "credit-liquity-bold", "swap-same-asset", "swap-uniswap-v3", "quote-polygon-uniswap-v3",
    "swap-uniswap-v4", "swap-curve-direct-ng", "swap-curve-uniswap-composite",
    "swap-balancer-v2-crossvenue", "swap-base-slipstream", "swap-base-hydrex-algebra",
    "swap-fluid-dex-smartcollateral", "swap-kyber", "redemption-erc4626-evk",
    "redemption-nested-ynethx", "redemption-pendle-pt-sale", "redemption-pendle-expired-pt",
    "redemption-spark-psm3", "redemption-reservoir", "lp-curve-ethereum", "lp-curve-base",
    "lp-balancer-ethereum", "delayed-snusd", "delayed-apyusd-receipt",
    "redemption-base-usdplus", "redemption-beefy-yieldbasis", "quote-uniswap-v2-sushi",
    "quote-socket-bungee", "quote-base-aerodrome-v1", "quote-base-eulerswap",
    "quote-hyperevm-lst-lrt", "discovery-v2-factories", "discovery-balancer-v3",
    "quote-generic-erc4626", "blocked-aave-balancer-repayment",
    "blocked-base-aave-v4-dispatch", "blocked-competitive-rehearsal",
    "unsupported-native-flash-lenders", "unsupported-1inch-odos",
    "unsupported-wsteth-unwrap", "unsupported-bold-redemption",
}


def by_id(view):
    return {row["id"]: row for row in view["routes"]}


def test_complete_catalog_schema_options_and_global_counts():
    view = liquidity.build_liquidity()
    assert set(view) == {
        "catalog_as_of", "read_only", "source_mode", "live_checked_at", "summary",
        "filters", "options", "routes", "notices", "scan",
    }
    assert view["catalog_as_of"] == AS_OF
    assert view["read_only"] is True
    assert view["source_mode"] == "curated_snapshot"
    assert view["live_checked_at"] is None
    assert view["filters"] == {"q": "", "chain": "", "category": "", "status": ""}
    assert set(by_id(view)) == EXPECTED_IDS
    assert len(view["routes"]) == len(EXPECTED_IDS) == 51
    assert view["summary"]["total"] == view["summary"]["matched"] == 51
    assert view["summary"]["atomic_funding"] == 4
    assert set(view["summary"]) == {"total", "matched", "atomic_funding", *liquidity.STATUSES}
    for status in liquidity.STATUSES:
        assert view["summary"][status] == sum(row["status"] == status for row in view["routes"])
        assert view["summary"][status] > 0
    assert sum(view["summary"][status] for status in liquidity.STATUSES) == 51
    for row in view["routes"]:
        assert set(row) == ROUTE_FIELDS
        assert row["reviewed_at"] == AS_OF
        assert row["category_label"] == liquidity.CATEGORIES[row["category"]]
        assert row["status_label"] == liquidity.STATUSES[row["status"]]
        for key in ROUTE_FIELDS - {"chains", "paths", "blockers", "source_refs"}:
            assert isinstance(row[key], str) and row[key]
        assert row["capacity"] != "0" and row["execution"] != "0"
        for key in ("paths", "blockers"):
            assert row[key] and all(isinstance(text, str) and text for text in row[key])
        for chain in row["chains"]:
            assert set(chain) == {"id", "name"}
            assert isinstance(chain["id"], int) and isinstance(chain["name"], str)
        for ref in row["source_refs"]:
            assert set(ref) == {"path", "lines", "note"}
            assert all(isinstance(value, str) for value in ref.values())
            assert ref["path"] and ref["note"]
    assert {option["value"] for option in view["options"]["categories"]} == set(liquidity.CATEGORIES)
    assert {option["value"] for option in view["options"]["statuses"]} == set(liquidity.STATUSES)
    assert {option["value"] for option in view["options"]["chains"]} == {
        str(chain["id"]) for row in view["routes"] for chain in row["chains"]
    }
    assert all(set(option) == {"value", "label"} for options in view["options"].values() for option in options)


def test_atomic_funding_count_comes_only_from_explicit_catalog_marker(monkeypatch):
    catalog = json.loads(liquidity.CATALOG_PATH.read_text(encoding="utf-8"))
    assert {row["id"] for row in catalog["routes"] if row.get("atomic_funding") is True} == {
        "funding-morpho-blue", "funding-balancer-v2", "funding-aave-v3-pool", "funding-uniswap-v4-unlock",
    }
    catalog["routes"][0]["atomic_funding"] = False
    monkeypatch.setattr(liquidity, "CATALOG_PATH", SimpleNamespace(read_text=lambda **kwargs: json.dumps(catalog)))
    view = liquidity.build_liquidity({"category": "credit"})
    assert view["summary"]["atomic_funding"] == 3
    assert view["summary"]["total"] == 51


@pytest.mark.parametrize("key", ["chain", "category", "status"])
def test_each_filter_is_exact_and_global_summary_options_do_not_shrink(key):
    all_rows = liquidity.build_liquidity()
    options_key = {"chain": "chains", "category": "categories", "status": "statuses"}[key]
    for option in all_rows["options"][options_key]:
        value = option["value"]
        view = liquidity.build_liquidity({key: value})
        expected = [row for row in all_rows["routes"] if (
            any(str(chain["id"]) == value for chain in row["chains"])
            if key == "chain" else row[key] == value
        )]
        assert view["routes"] == expected
        assert view["summary"] == {**all_rows["summary"], "matched": len(expected)}
        assert view["options"] == all_rows["options"]
        assert view["filters"][key] == value


@pytest.mark.parametrize("args", [
    {"chain": "ethereum"}, {"chain": "01"}, {"chain": "999999"}, {"chain": " 1 "},
    {"category": "Funding"}, {"category": "all"}, {"category": "funding,swap"},
    {"status": "IMPLEMENTED"}, {"status": "ready"}, {"status": " implemented "},
    {"chain": "1", "category": "funding", "status": "invalid"},
])
def test_invalid_filters_are_retained_and_never_silently_widened(args):
    view = liquidity.build_liquidity(args)
    assert view["routes"] == [] and view["summary"]["matched"] == 0
    assert view["summary"]["total"] == 51 and view["summary"]["atomic_funding"] == 4
    assert all(view["filters"][key] == value for key, value in args.items())


def test_combined_filters_and_case_insensitive_search():
    args = {"chain": "8453", "category": "swap", "status": "implemented", "q": "tIcKsPaCiNg 1"}
    view = liquidity.build_liquidity(args)
    assert list(by_id(view)) == ["swap-base-slipstream"]
    assert view["filters"] == args
    assert view["summary"]["matched"] == 1 and view["summary"]["total"] == 51
    assert liquidity.build_liquidity({**args, "chain": "1"})["routes"] == []


@pytest.mark.parametrize(("query", "ident"), [
    ("mCwEtH", "redemption-nested-ynethx"),
    ("PAXG", "credit-morpho-collateral-borrow"),
    ("80094", "funding-prefunded-fixtures"),
    ("HyperEVM", "quote-hyperevm-lst-lrt"),
    ("CollATERALIZED CREDIT", "credit-aave-base"),
    ("Quote only", "quote-base-eulerswap"),
    ("exact principal", "funding-morpho-blue"),
    ("FAILL_CLOSED_DOES_NOT_EXIST", None),
    ("3.4%", "delayed-apyusd-receipt"),
    ("46-84", "funding-balancer-v2"),
    ("FlashLiquidateAaveV3.sol", "funding-aave-v3-pool"),
    ("not a validated executable variant", "credit-morpho-collateral-borrow"),
    ("Quote/cash-check", "quote-base-eulerswap"),
])
def test_search_covers_useful_fields_and_zero_results(query, ident):
    result = by_id(liquidity.build_liquidity({"q": query}))
    if ident is None:
        assert not result
    else:
        assert ident in result


def test_query_is_bounded_and_whitespace_normalized():
    assert liquidity.build_liquidity({"q": "  Morpho  "})["filters"]["q"] == "Morpho"
    long_query = "x" * 201
    view = liquidity.build_liquidity({"q": long_query})
    assert view["filters"]["q"] == "x" * 200
    assert view["routes"] == []


def test_only_fixed_bundled_catalog_is_read_and_source_refs_are_never_followed(monkeypatch):
    original = Path.read_text
    reads = []

    def fixed_only(path, *args, **kwargs):
        reads.append(path)
        assert path == liquidity.CATALOG_PATH
        return original(path, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", fixed_only)
    view = liquidity.build_liquidity({"path": "../../unrelated.json", "source_ref": "unrelated.json"})
    assert reads == [liquidity.CATALOG_PATH]
    assert view["summary"]["total"] == 51
    assert any(ref["path"].startswith("reports/") for row in view["routes"] for ref in row["source_refs"])


def test_empty_workspace_does_not_need_unrelated_reports(tmp_path, collector_guard, monkeypatch):
    app = create_app(tmp_path)
    module = importlib.import_module("dashboard.app")

    def forbidden(*args, **kwargs):
        pytest.fail("liquidity must not read artifacts or invoke collectors")

    for name in ("snapshot", "build_canary", "build_ops", "build_targets", "auto_refresh", "start_refresh", "collector_status"):
        monkeypatch.setattr(module, name, forbidden)
    monkeypatch.setattr(module.ArtifactReader, "read_json", forbidden)
    monkeypatch.setattr(app.extensions["jobs_inspector"], "snapshot", forbidden)
    app.jinja_loader = DictLoader({"liquidity.html": "{{ data.source_mode }} {{ data.catalog_as_of }} {{ data.summary.total }}"})
    client = app.test_client(use_cookies=False)
    assert get(client, "/api/v1/liquidity").get_json() == liquidity.build_liquidity()
    page = get(client, "/liquidity")
    assert page.status_code == 200 and page.get_data(as_text=True) == f"curated_snapshot {AS_OF} 51"
    assert collector_guard == []
    assert list(tmp_path.iterdir()) == []


def test_timestamp_is_fixed_across_refresh_and_results_are_independent(client, monkeypatch):
    module = importlib.import_module("dashboard.app")
    first = get(client, "/api/v1/liquidity").get_json()
    monkeypatch.setattr(module.time, "time", lambda: 2524608000)
    second = get(client, "/api/v1/liquidity").get_json()
    assert first == second
    assert second["catalog_as_of"] == AS_OF
    assert second["scan"]["as_of"] == SCAN_AS_OF
    assert second["live_checked_at"] is None
    first["routes"][0]["name"] = "mutated response"
    assert liquidity.build_liquidity()["routes"][0]["name"] != "mutated response"


@pytest.mark.parametrize(("ident", "fragments"), [
    ("funding-morpho-blue", ["zero", "exact principal", "pull", "not Aave"]),
    ("funding-balancer-v2", ["0 bps", "MODEL", "actual", "transfer", "wstETH + WETH", "skeleton"]),
    ("funding-aave-v3-pool", ["5 bps", "MODEL", "actual premium", "oracle-shocked", "not natural-state"]),
    ("funding-uniswap-v4-unlock", ["unlock", "take", "settle", "synthetic", "swap fees"]),
    ("funding-morpho-collateral-first", ["NOT a separate flash loan", "before debt repayment"]),
    ("funding-silo-default-keeper", ["zero-principal", "gas", "collateral shares"]),
    ("funding-prefunded-fixtures", ["NOT evidence of available user capital", "WBERA -> iBERA"]),
    ("credit-morpho-collateral-borrow", ["locked collateral", "legacy ABI", "unqualified", "not free profit"]),
    ("swap-uniswap-v3", ["100 / 500 / 3000 / 10000", "NOT execution proof"]),
    ("swap-curve-uniswap-composite", ["sUSDe -> crvUSD -> USDC -> USDtb (#M32)", "dedicated deployed and verified executor 0x2c94b422884c0495cae3cef9ce7ab337fac247c4", "MorphoM32CurveUnwindLiquidator", "8-size local rehearsal pass at block 26281701", "0.59s 8-size provider simulation benchmark at block 26282456", "not current profit", "FRAX source/tests and retained probes are not interchangeable", "fail-closed/no-gross-edge", "FRAX probe PASS must not be promoted"]),
    ("swap-balancer-v2-crossvenue", ["MORPHO funding", "reverted gross", "not establish completed repayment"]),
    ("swap-kyber", ["100 bps modeled tolerance", "deadline", "V4 restriction"]),
    ("redemption-erc4626-evk", ["maxLoss 0", "not redeemable cash"]),
    ("redemption-nested-ynethx", ["locally refilled MCwETH", "NOT proven", "conditional"]),
    ("redemption-pendle-expired-pt", ["-45 bps oracle shock", "No standalone YT trading", "YT.redeemPY", "SY.redeem"]),
    ("delayed-snusd", ["NON-ATOMIC", "FAIL_CLOSED", "cooldown"]),
    ("delayed-apyusd-receipt", ["NON-ATOMIC", "3.4% at 3 days", "0% at 20 days"]),
    ("redemption-base-usdplus", ["synthetic issuance", "Aave withdrawal"]),
    ("redemption-beefy-yieldbasis", ["historical full exit", "ROUTE-NEGATIVE"]),
    ("quote-uniswap-v2-sushi", ["fixed-decimals", "not Uniswap V2 flash-borrow"]),
    ("quote-socket-bungee", ["same-chain", "NOT bridge execution"]),
    ("quote-base-eulerswap", ["economics are UNEVALUATED", "not assumed positive or zero"]),
    ("discovery-balancer-v3", ["No Balancer V3 lender consumer", "V2 support"]),
    ("blocked-aave-balancer-repayment", ["approve-only", "remediated in source", "transfer amounts[0] + feeAmounts[0] back to BALANCER_VAULT", "AaveV3LiquidationUnwindRoundTrip.sol", "AaveV3LiquidationUnwindBaseRoundTrip.sol", "fresh natural-state fork rehearsal and Vault capacity checks", "before promotion out of blocked", "does not taint"]),
    ("blocked-base-aave-v4-dispatch", ["dispatch-disabled", "does not enable"]),
    ("blocked-competitive-rehearsal", ["100 USDC", "not the general", "no retry", "bypass", "consumed"]),
    ("unsupported-native-flash-lenders", ["Euler-native", "Fluid-native", "ERC3156", "DODO", "Uniswap V2 / V3 flashborrow", "no invented source line"]),
    ("unsupported-1inch-odos", ["1inch", "Odos", "no integrated"]),
    ("unsupported-wsteth-unwrap", ["stub", "not a complete"]),
    ("unsupported-bold-redemption", ["local tests", "not integrated"]),
])
def test_critical_evidence_caveats_are_not_lost(ident, fragments):
    row = by_id(liquidity.build_liquidity())[ident]
    text = json.dumps(row).casefold()
    for fragment in fragments:
        assert fragment.casefold() in text


def test_deterministic_curve_unwinds_are_cataloged_with_kyber_compatibility():
    rows = by_id(liquidity.build_liquidity())
    paths = rows["swap-curve-uniswap-composite"]["paths"]
    evidence = rows["swap-kyber"]["evidence"]
    for path in ("reUSDe -> sUSDe -> crvUSD -> USDC", "sUSDS -> sUSDe -> crvUSD -> USDT"):
        assert path in paths
        assert path in evidence
    for fragment in ("Ethereum sUSDS -> USDT (#M36/#M38)", "Ethereum reUSDe -> USDC (#M45)",
                     "default to deterministic 3-hop CurveRouterNG unwinds", "UniversalFluidMorphoLiquidator",
                     "runner validation retains Kyber compatibility"):
        assert fragment in evidence


def test_credit_lp_and_blocked_statuses_keep_their_distinct_limits():
    rows = by_id(liquidity.build_liquidity())
    for row in rows.values():
        if row["category"] == "credit":
            assert row["status"] == "study_only"
            assert "debt" in row["repayment"].casefold()
        if row["category"] == "lp":
            assert row["status"] == "study_only"
            assert "unproven" in row["execution"]
    assert rows["blocked-aave-balancer-repayment"]["status"] == "blocked"
    assert rows["funding-balancer-v2"]["status"] == rows["funding-aave-v3-pool"]["status"] == "implemented"
    assert rows["unsupported-native-flash-lenders"]["source_refs"] == []
    assert "Unknown" in rows["blocked-competitive-rehearsal"]["capacity"]
    assert rows["blocked-competitive-rehearsal"]["execution"].startswith("Blocked")


def test_polygon_quote_sizing_is_separate_from_implemented_uniswap_v3(client):
    rows = by_id(liquidity.build_liquidity())
    implemented = rows["swap-uniswap-v3"]
    assert implemented["status"] == "implemented"
    assert {chain["id"] for chain in implemented["chains"]} == {1, 8453, 42161}
    assert "polygon" not in json.dumps(implemented).casefold()
    polygon = rows["quote-polygon-uniswap-v3"]
    assert polygon["chains"] == [{"id": 137, "name": "Polygon"}]
    assert polygon["status"] == "quote_only"
    assert any(ref["path"] == "tools/monitor-novelty-conditions.js" and ref["lines"] == "137, 2044-2052" for ref in polygon["source_refs"])
    assert "not validated Polygon executor support" in polygon["evidence"]
    response = get(client, "/api/v1/liquidity?chain=137&status=implemented")
    assert response.status_code == 200
    assert response.get_json()["routes"] == []
    assert response.get_json()["summary"]["matched"] == 0
    quoted = get(client, "/api/v1/liquidity?chain=137&status=quote_only").get_json()
    assert set(by_id(quoted)) == {"quote-polygon-uniswap-v3"}


def test_uniswap_v4_swap_paths_are_syrup_exits_not_cross_currency_funding():
    view = liquidity.build_liquidity()
    row = by_id(view)["swap-uniswap-v4"]
    assert row["paths"] == [
        "syrupUSDG -> USDG via PoolManager.swap",
        "esyrupUSDC-4 -> syrupUSDC -> USDC via EVK redemption then PoolManager.swap",
        "syrupUSDC -> USDC Kyber route subject to the V4 restriction",
    ]
    assert "USDG <-> USDC" not in json.dumps(row)
    assert any(ref["path"] == "tools/fork-poc/verify-eth-univ4-syrup-liquidations.js" and ref["lines"] == "3-11" for ref in row["source_refs"])
    assert "oracle-shocked/synthetic" in row["evidence"]
    assert "not natural-state profitability proof" in row["evidence"]
    assert "V4 restriction" in row["evidence"]
    assert "current execution unknown" in row["execution"]
    assert view["summary"]["atomic_funding"] == 4


def test_reservoir_is_source_implemented_but_current_rates_and_settlement_unknown():
    implemented = by_id(liquidity.build_liquidity({"status": "implemented", "category": "redemption"}))
    row = implemented["redemption-reservoir"]
    assert row["paths"] == ["srUSD -> SavingModule rUSD -> PSM USDC"]
    assert {(ref["path"], ref["lines"]) for ref in row["source_refs"]} == {
        ("tools/watch-top-whale-triggers.js", "3771-3799"),
        ("tools/execute-top-whale-trigger.js", "1069-1093"),
    }
    assert "two-call" in row["atomicity"]
    assert "targetM44" in row["evidence"] and "loan token" in row["evidence"]
    assert "actual rates, exact-size liquidity or full-repayment proof" in row["evidence"]
    assert "CURRENT UNKNOWN" in row["evidence"]
    assert "Watcher hardcoded simulated profit/readiness is not evidence" in row["evidence"]
    assert row["capacity"].startswith("Unknown currently")
    assert "full-repayment proof" in row["execution"] and "unknown" in row["execution"]
    assert "redemption-reservoir" not in by_id(liquidity.build_liquidity({"status": "quote_only"}))


def test_dated_scan_counts_and_general_economics_are_bounded():
    view = liquidity.build_liquidity()
    assert view["scan"]["chains"] == [
        {"name": "Ethereum", "token_pair_entries": 196, "qualified_route_families": 33, "selected_pools": 38},
        {"name": "Base", "token_pair_entries": 44, "qualified_route_families": 17, "selected_pools": 15},
    ]
    assert view["scan"]["as_of"] == SCAN_AS_OF
    assert "UniV3" in view["scan"]["scope"] and "via USDC" in view["scan"]["scope"]
    assert "not a universal negative" in view["scan"]["conclusion"]
    assert "No all-cost-positive executable liquidation" in view["scan"]["conclusion"]
    notices = " ".join(view["notices"])
    assert "net > 0" in notices and "100 USDC" in notices and "only" in notices
    assert "Unknown is not zero" in notices and "No current capacity refresh" in notices
    assert "Source review, tests, quote probes, mined legs" in notices


def test_api_filters_read_only_headers_and_endpoint_names(client, collector_guard):
    response = get(client, "/api/v1/liquidity?chain=8453&category=swap&status=implemented&q=Slipstream")
    assert response.status_code == 200 and response.is_json
    view = response.get_json()
    assert list(by_id(view)) == ["swap-base-slipstream"]
    assert view["read_only"] is True and view["live_checked_at"] is None
    assert response.headers["Cache-Control"] == "no-store"
    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert response.headers["Referrer-Policy"] == "no-referrer"
    assert "default-src 'self'" in response.headers["Content-Security-Policy"]
    assert "frame-ancestors 'none'" in response.headers["Content-Security-Policy"]
    with client.application.test_request_context():
        assert url_for("liquidity_page") == "/liquidity"
        assert url_for("liquidity_api") == "/api/v1/liquidity"
    assert collector_guard == []


@pytest.mark.parametrize("endpoint", ENDPOINTS)
@pytest.mark.parametrize("method", ["POST", "PUT", "PATCH", "DELETE"])
def test_liquidity_rejects_writes(client, collector_guard, endpoint, method):
    response = client.open(endpoint, method=method, base_url="http://127.0.0.1:5050", environ_base={"REMOTE_ADDR": "127.0.0.1"})
    assert response.status_code == 405
    assert "Content-Security-Policy" in response.headers
    assert collector_guard == []


@pytest.mark.parametrize("endpoint", ENDPOINTS)
@pytest.mark.parametrize(("host", "remote"), [
    ("attacker.example", "127.0.0.1"), ("127.0.0.1.evil", "127.0.0.1"),
    ("127.0.0.1:5050", "192.0.2.9"), ("localhost:0", "127.0.0.1"),
])
def test_liquidity_keeps_loopback_host_guards(client, endpoint, host, remote):
    response = client.get(endpoint, environ_overrides={"HTTP_HOST": host, "REMOTE_ADDR": remote})
    assert response.status_code == 403
    assert "Content-Security-Policy" in response.headers


@pytest.mark.parametrize("endpoint", ENDPOINTS)
def test_query_string_limit_and_200_character_search_bound(client, endpoint):
    # Use a local stub so this backend guard does not depend on template delivery.
    client.application.jinja_loader = DictLoader({"liquidity.html": "{{ data.filters.q }}"})
    assert get(client, endpoint + "?q=" + "x" * 4094).status_code == 200
    oversized = get(client, endpoint + "?q=" + "x" * 4095)
    assert oversized.status_code == 400
    if endpoint.startswith("/api/"):
        assert oversized.get_json()["reason"] == "BAD_REQUEST"
    bounded = get(client, endpoint + "?q=" + "x" * 201)
    if bounded.is_json:
        assert bounded.get_json()["filters"]["q"] == "x" * 200
    else:
        assert bounded.get_data(as_text=True) == "x" * 200


@pytest.mark.parametrize("endpoint", ENDPOINTS)
@pytest.mark.parametrize("method", ["HEAD", "OPTIONS"])
def test_safe_framework_methods_have_no_side_effects(client, collector_guard, endpoint, method):
    client.application.jinja_loader = DictLoader({"liquidity.html": "snapshot"})
    response = client.open(endpoint, method=method, base_url="http://127.0.0.1:5050", environ_base={"REMOTE_ADDR": "127.0.0.1"})
    assert response.status_code == 200
    assert collector_guard == []


def test_liquidity_has_no_raw_evidence_route(client):
    for url in ("/api/v1/liquidity/evidence", "/liquidity/evidence"):
        assert get(client, url).status_code == 404
    ordinary = get(client, "/api/v1/liquidity").get_json()
    assert get(client, "/api/v1/liquidity?path=../../unrelated.json").get_json() == ordinary


def test_delivered_template_renders_snapshot_and_escapes_search(client, collector_guard):
    if not (Path(client.application.root_path) / "templates/liquidity.html").is_file():
        pytest.skip("Designer template not delivered; parent owns final integrated validation")
    response = get(client, "/liquidity")
    assert response.status_code == 200
    html = response.get_data(as_text=True)
    assert "Morpho Blue flash funding" in html
    assert AS_OF in html and "curated" in html.casefold()
    assert "Content-Security-Policy" in response.headers
    malicious = get(client, "/liquidity", query_string={"q": '<script>alert("x")</script>'})
    assert malicious.status_code == 200
    assert '<script>alert("x")</script>' not in malicious.get_data(as_text=True)
    assert "&lt;script&gt;" in malicious.get_data(as_text=True)
    assert collector_guard == []
