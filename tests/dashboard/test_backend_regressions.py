"""End-to-end regressions for the dashboard/backend review (F1-F11)."""

import json
import subprocess
import threading
import time
import io
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace

import pytest

import dashboard.app as app_module
import dashboard.execution as execution_module
import dashboard.service as service
import dashboard.wallets as wallets
from dashboard.artifacts import ALLOWLIST, ArtifactReader
from dashboard.catalog import CATALOG, Monitor
from dashboard.normalize import timestamp
from dashboard.ops import dispatcher_status_valid, wallet_balances_valid
from conftest import get, post_json
from test_canary import balances_gaps_fixture
from test_dashboard import watch_addresses, write
from test_polymarket_r20 import artifact as r20_artifact


RUN_NODE = subprocess.run  # captured before the autouse collector guard
FIXTURES = Path(__file__).with_name("producer-fixtures.cjs")
EVM = "0x" + "11" * 20
SOLANA = "ChCU36kRCYqZ14SDMiHHYrvFLQWVyR2zUBx6FiRqvBZ2"


def node_fixture(kind, root, value=None):
    result = RUN_NODE(
        ["node", str(FIXTURES), kind, str(root), json.dumps(value or {})],
        capture_output=True, timeout=30, check=True,
    )
    return json.loads(result.stdout)


@pytest.fixture(scope="module")
def producer_outputs(tmp_path_factory):
    return node_fixture("producers", tmp_path_factory.mktemp("dashboard-producers"))


@pytest.fixture(scope="module")
def verifier_reports(tmp_path_factory):
    return node_fixture("batches", tmp_path_factory.mktemp("dashboard-batches"))


@pytest.mark.parametrize("state", ["ABSENT", "UNSIGNED", "BAD_SIGNATURE", "VALID", "NOT_YET_VALID", "EXPIRED", "CONSUMED", "REVOKED"])
def test_all_authority_views_use_actual_verifier_reports(state, verifier_reports, root, client, monkeypatch):
    report = verifier_reports[state]
    expected = report["authorizationState"]
    calls = []

    def verifier(argv, **kwargs):
        assert argv == ["node", str(root / "tools/live-execution-batch.js"), "status"]
        assert kwargs["cwd"] == root and kwargs["timeout"] == 2
        calls.append(argv)
        return SimpleNamespace(returncode=0, stdout=json.dumps(report).encode())

    monkeypatch.setattr(execution_module.subprocess, "run", verifier)
    # Conflicting metadata must lose to the signed, time/terminal-aware verifier.
    forged = {"approved": True, "expiresAt": "2099-01-01T00:00:00Z", "actions": [{}]}
    write(root, ALLOWLIST["live_execution_batch"], forged)
    write(root, ALLOWLIST["live_execution_batch_euler_trigger"], forged)
    for endpoint in ("/api/v1/ops", "/api/v1/snapshot"):
        response = get(client, endpoint)
        assert response.status_code == 200
        data = response.get_json()
        assert data["mode"]["batch"]["state"] == ("MISSING" if expected == "ABSENT" else expected)
        assert data["mode"]["batch"]["verification"] == "VERIFIED"
        # Batch authorization never implies runtime/route readiness.
        assert data["mode"]["current"] == "READ_ONLY"
        assert data["mode"]["go_live_ready"] is False
        assert data["mode"]["readiness"] == "NOT_READY"
        assert data["mode"]["scope"] == "NOT_VERIFIED"
        assert next(g for g in data["mode"]["gates"] if g["key"] == "runtime")["state"] == "UNKNOWN"
        rows = {row["key"]: row for row in data["envelopes"]["rows"]}
        assert rows["live_execution_batch"]["status"] == expected
        assert rows["live_execution_batch_euler_trigger"]["status"] == "PRESENT_UNVERIFIED"
        assert rows["live_execution_batch_euler_trigger"]["approved"] is None
        assert data["envelopes"]["approved_count"] == int(expected == "VALID")
    canary = get(client, "/api/v1/canary").get_json()["execution"]
    assert canary["authorization_state"] == expected and canary["verification"] == "VERIFIED"
    assert canary["readiness"] == "NOT_READY"
    # Ops mode and canary execution report the same readiness contract.
    assert canary["readiness"] == data["mode"]["readiness"]
    assert canary["scope"] == data["mode"]["scope"]
    assert canary["readiness_reason"] == data["mode"]["readiness_reason"]
    assert len(calls) == 3


def test_unsigned_metadata_never_grants_live_mode_when_verifier_unavailable(root, client):
    write(root, ALLOWLIST["live_execution_batch"], {"approved": True, "expiresAt": "2099-01-01T00:00:00Z", "actions": [{}]})
    mode = get(client, "/api/v1/ops").get_json()["mode"]
    assert mode["current"] == "READ_ONLY"
    assert mode["batch"]["state"] == "PRESENT_UNVERIFIED"
    assert mode["go_live_ready"] is False


def test_current_node_producer_contracts_round_trip(producer_outputs, root, client):
    contracts = (
        ("etherfi", "etherfi_debtmanager_profit_trigger", service.etherfi_debtmanager_profit_trigger_valid),
        ("sentinel", "official_deployed_delta_sentinel", service.official_deployed_delta_sentinel_valid),
        ("dispatcher", "monitor_alert_dispatcher_status", dispatcher_status_valid),
        ("eulerFailed", "euler_l_watch", service.euler_l_watch_valid),
        ("eulerHealthy", "euler_l_watch", service.euler_l_watch_valid),
    )
    for name, key, validator in contracts:
        value = producer_outputs[name]
        assert validator(value) is True, name
        write(root, ALLOWLIST[key], value)
        assert ArtifactReader(root).read_json(key, validator=validator).current, name
    data = get(client, "/api/v1/snapshot").get_json()
    for key in ("etherfi_debtmanager_profit_trigger", "official_deployed_delta_sentinel", "euler_l_watch"):
        assert data["producer_health"][key + "_current_read"] is True
    assert data["pipeline"]["dispatcher"]["available"] is True
    euler = next(row for row in data["monitors"] if row["id"] == "euler-liquidation-watch")
    assert euler["source_health"] == "OK"  # failClosed is not a failed observation
    assert euler["euler_evk_liquidation"]["watch"]["reason"] is None
    write(root, ALLOWLIST["euler_l_watch"], producer_outputs["eulerFailed"])
    data = get(client, "/api/v1/snapshot").get_json()
    euler = next(row for row in data["monitors"] if row["id"] == "euler-liquidation-watch")
    assert euler["euler_evk_liquidation"]["watch"]["available"] is True
    assert euler["source_health"] == "ERROR" and euler["observation"] == "ERROR"


def test_new_safety_and_retention_fields_remain_bounded(producer_outputs):
    etherfi = deepcopy(producer_outputs["etherfi"])
    etherfi["safety"].update(networkCalls=3, transportFailures=2, automaticRetries=1, retryExhaustions=1)
    assert service.etherfi_debtmanager_profit_trigger_valid(etherfi)
    for key, value in (("transportFailures", []), ("automaticRetries", 3), ("retryExhaustions", -1), ("networkCalls", 81)):
        invalid = deepcopy(etherfi)
        invalid["safety"][key] = value
        assert service.etherfi_debtmanager_profit_trigger_valid(invalid) is False
    dispatcher = deepcopy(producer_outputs["dispatcher"])
    dispatcher["summary"]["retention"]["pendingUnacknowledged"] = []
    assert dispatcher_status_valid(dispatcher) is False


def test_unlabeled_api_add_through_actual_collector_and_both_views(root, client):
    response = post_json(client, "/api/v1/wallets/addresses", {"address": EVM})
    assert response.status_code == 201
    watchlist = json.loads((root / ALLOWLIST["watch_addresses"]).read_text())
    artifact = node_fixture("wallet", root, {"watchlist": watchlist})
    assert artifact["addresses"][0]["label"] is None
    assert wallet_balances_valid(artifact)
    write(root, ALLOWLIST["wallet_balances"], artifact)
    wallet = get(client, "/api/v1/ops").get_json()["wallets"]
    assert wallet["available"] and wallet["addresses"][0]["label"] == "unlabeled"
    assert wallet["totals"]["total_usd"] == "5.00"
    assert get(client, "/api/v1/canary").get_json()["balances"]["available"]


@pytest.mark.parametrize("failure", [None, "failEvm", "noEvm"])
def test_mixed_family_totals_include_solana_and_propagate_gaps(failure, root, client):
    addresses = [{"address": EVM}, {"address": SOLANA, "family": "solana"}]
    watch_addresses(root, addresses)
    artifact = node_fixture("wallet", root, {"watchlist": {"schema": "watch-addresses/v1", "addresses": addresses}, **({failure: True} if failure else {})})
    expected = "12.00" if failure is None else None
    assert artifact["totals"]["totalUsd"] == expected
    assert artifact["totals"]["complete"] == (failure is None)
    write(root, ALLOWLIST["wallet_balances"], artifact)
    assert get(client, "/api/v1/ops").get_json()["wallets"]["totals"]["total_usd"] == expected
    assert get(client, "/api/v1/canary").get_json()["balances"]["totals"]["totalUsd"] == expected


@pytest.mark.parametrize("bad", ["missing-token-fields", "solana-tokens-scalar", "solana-missing-token-fields", "schema-list", "price-source-list"])
def test_malformed_nested_artifacts_never_crash_routes(bad, root, client):
    value = balances_gaps_fixture()
    watch_addresses(root, value["addresses"])
    write(root, ALLOWLIST["wallet_balances"], value)
    assert get(client, "/api/v1/snapshot").status_code == 200
    assert get(client, "/api/v1/canary").status_code == 200
    if bad == "missing-token-fields":
        value["chains"][0]["addressRows"][0]["tokens"] = [{"symbol": "USDC", "decimals": 6}]
    elif bad.startswith("solana"):
        value["solana"] = [{"address": SOLANA, "native": None, "tokens": 7 if bad == "solana-tokens-scalar" else [{"symbol": "USDC", "decimals": 6}]}]
    elif bad == "schema-list":
        write(root, ALLOWLIST["etherfi_debtmanager_profit_trigger"], {"schema": []})
    else:
        value["totals"]["priceSource"] = []
    write(root, ALLOWLIST["wallet_balances"], value)
    for endpoint in ("/", "/canary", "/api/v1/snapshot", "/api/v1/ops", "/api/v1/canary"):
        assert get(client, endpoint).status_code == 200, endpoint
    if bad in ("missing-token-fields", "solana-tokens-scalar", "solana-missing-token-fields"):
        assert get(client, "/api/v1/ops").get_json()["wallets"]["available"] is False
        assert get(client, "/api/v1/canary").get_json()["balances"]["available"] is False


def test_validator_type_errors_are_source_local_and_cached_values_stay_historical(root, producer_outputs):
    key = "etherfi_debtmanager_profit_trigger"
    value = deepcopy(producer_outputs["etherfi"])
    write(root, ALLOWLIST[key], value)
    reader = ArtifactReader(root)
    assert service.snapshot(reader)[key]["available"] is True
    # A nested unhashable enum used to escape the reader's validation boundary.
    value["gates"]["sourceCurrent"] = []
    write(root, ALLOWLIST[key], value)
    failed = reader.read_json(key, validator=service.etherfi_debtmanager_profit_trigger_valid)
    assert failed.source and failed.cached and not failed.current and not failed.parser
    data = service.snapshot(reader)
    assert data[key]["available"] is False
    assert data["producer_health"][key + "_current_read"] is False


@pytest.mark.parametrize("remove", [False, True])
def test_interleaved_watchlist_mutations_across_app_instances_are_serialized(root, monkeypatch, remove):
    existing, added = "0x" + "22" * 20, "0x" + "33" * 20
    watch_addresses(root, [{"address": existing}] if remove else [])
    loaded, release, second_started, second_finished = (threading.Event() for _ in range(4))
    original_load = wallets.WalletStore.load
    first = True
    guard = threading.Lock()

    def held_load(store):
        nonlocal first
        value = original_load(store)
        with guard:
            hold, first = first, False
        if hold:
            loaded.set()
            assert release.wait(5)
        return value

    monkeypatch.setattr(wallets.WalletStore, "load", held_load)
    monkeypatch.setattr(app_module, "start_refresh", lambda *args, **kwargs: False)

    def request(address, remove=False):
        client = app_module.create_app(root).test_client()
        return post_json(client, "/api/v1/wallets/addresses" + ("/remove" if remove else ""), {"address": address}).status_code

    def second_request():
        second_started.set()
        try:
            return request(existing, remove=remove)
        finally:
            second_finished.set()

    with ThreadPoolExecutor(max_workers=2) as pool:
        first_result = pool.submit(request, added)
        try:
            assert loaded.wait(5)
            second_result = pool.submit(second_request)
            assert second_started.wait(5)
            assert not second_finished.wait(0.15)
        finally:
            release.set()
        assert first_result.result(timeout=5) == 201
        assert second_result.result(timeout=5) == (200 if remove else 201)
    saved = json.loads((root / ALLOWLIST["watch_addresses"]).read_text())
    assert {row["address"] for row in saved["addresses"]} == ({added} if remove else {existing, added})


def test_changes_during_collection_queue_one_followup_covering_final_watchlist(root, client, monkeypatch):
    entered = [threading.Event(), threading.Event()]
    release = [threading.Event(), threading.Event()]
    seen = []

    def collect(argv, **kwargs):
        assert argv == wallets.COLLECTOR_ARGV
        addresses = json.loads((root / ALLOWLIST["watch_addresses"]).read_text())["addresses"]
        index = len(seen)
        seen.append([row["address"] for row in addresses])
        entered[index].set()
        assert release[index].wait(5)
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr(wallets.subprocess, "run", collect)
    first, second, third = ("0x" + value * 40 for value in ("1", "2", "3"))
    try:
        assert post_json(client, "/api/v1/wallets/addresses", {"address": first}).status_code == 201
        assert entered[0].wait(5)
        for address in (second, third):
            assert post_json(client, "/api/v1/wallets/addresses", {"address": address}).status_code == 201
        assert post_json(client, "/api/v1/wallets/addresses/remove", {"address": first}).status_code == 200
        release[0].set()
        assert entered[1].wait(5)
        assert wallets.collector_status()["running"] is True
    finally:
        for event in release:
            event.set()
    deadline = time.monotonic() + 5
    while wallets.collector_status()["running"] and time.monotonic() < deadline:
        time.sleep(0.01)
    assert wallets.collector_status()["running"] is False
    assert seen == [[first], [second, third]]


def test_r20_card_and_monitor_share_clock_and_current_read(root):
    value = r20_artifact()
    write(root, ALLOWLIST["polymarket_r20"], value)
    reader = ArtifactReader(root)
    now = value["asOfMs"] / 1000 + 10
    data = service.snapshot(reader, now=now)
    monitor = next(row for row in data["monitors"] if row["id"] == "polymarket-r20-merge-backed-parity")
    assert data["polymarket_r20"]["freshness"] == monitor["freshness"] == "FRESH"
    assert data["polymarket_r20"]["age"] == monitor["age"] == 10
    write(root, ALLOWLIST["polymarket_r20"], {})
    data = service.snapshot(reader, now=now)
    assert data["producer_health"]["polymarket_r20_current_read"] is False
    assert data["polymarket_r20"]["available"] is False


def bounded_fixture(key):
    when = "2030-01-01T00:00:00Z"
    if key.startswith("live_execution_batch_"):
        return {"schema": "live-execution-batch/v1", "approved": True, "approvedAt": when, "expiresAt": "2030-01-02T00:00:00Z"}
    if key == "deployed_bytecode_verification":
        return {"summary": {"checkedAt": when, "total": 1, "mismatches": 1, "missing": 0}, "results": [{}]}
    if key == "silo_default_step1":
        return {"scanner": "tools/fork-poc/silo-default-keeper.js", "mode": "offline-scenario-plan", "scannedAt": when, "gaps": [{"status": "MISS"}], "ranFork": False}
    return {"schema": "fluid-exit-depth/v1" if key == "fluid_exit_depth" else "fluid-t2t4-fork-rehearsal/v1", "generatedAt": when, "rows": [{"state": "PASS"}]}


def test_catalog_has_explicit_adapter_coverage_and_bounded_sources_drive_rows(root):
    dedicated_sources = {"STATE", "NO_SOURCE", "OSTIUM", "VENUS_PSR", "AAVE_V4", "AAVE_V3_LIQ_WATCH", "MORPHO_BLUE_LIQ", "EULER_EVK_LIQ", "RESEARCH_WATCH", "POLYMARKET_R17", "POLYMARKET_R19", "POLYMARKET_R20"}
    assert all(item.source in dedicated_sources or item.id in service.BOUNDED_ARTIFACTS for item in CATALOG)
    reader = ArtifactReader(root)
    now = timestamp("2030-01-01T00:00:10Z")
    missing = {row["id"]: row for row in service.snapshot(reader, now=now)["monitors"]}
    for ident, key in service.BOUNDED_ARTIFACTS.items():
        assert missing[ident]["source_health"] != "OK"
        (root / ALLOWLIST[key]).parent.mkdir(parents=True, exist_ok=True)
        write(root, ALLOWLIST[key], bounded_fixture(key))
    records = {row["id"]: row for row in service.snapshot(reader, now=now)["monitors"]}
    for ident, key in service.BOUNDED_ARTIFACTS.items():
        assert records[ident]["provenance"] == [key]
        assert records[ident]["freshness"] == "FRESH"
        assert records[ident]["source_health"] == "OK"
        if key.startswith("live_execution_batch_"):
            assert records[ident]["observation"] == "PRESENT_UNVERIFIED"
        write(root, ALLOWLIST[key], {"schema": []})
    failed = {row["id"]: row for row in service.snapshot(reader, now=now)["monitors"]}
    assert all(failed[ident]["source_health"] != "OK" and failed[ident]["freshness"] == "UNKNOWN" for ident in service.BOUNDED_ARTIFACTS)
    unsupported = Monitor("unknown", "unknown", "KEEP_COLD", "", "", "BOUNDED", "UNSUPPORTED")
    assert service._adapter(unsupported, {}, now)["source_health"] == "UNSUPPORTED"


def test_both_wallet_views_project_fixed_totals_and_redact_diagnostics(root, client):
    value = balances_gaps_fixture()
    value["totals"].update(extra={"nested": "EXTRA_MARKER"}, note="api_key=NOTE_MARKER", unpricedChains=["https://fixture.invalid/CHAIN_MARKER"])
    value["addresses"][0]["label"] = "api_key=LABEL_MARKER"
    value["errors"] = [{"scope": "https://fixture.invalid/SCOPE_MARKER", "message": "Authorization: Bearer ERROR_MARKER"}]
    value["chains"][0]["addressRows"][0]["error"] = "api_key=ROW_MARKER"
    watch_addresses(root, [{"address": value["addresses"][0]["address"]}])
    write(root, ALLOWLIST["wallet_balances"], value)
    for endpoint in ("/api/v1/ops", "/api/v1/canary", "/", "/canary"):
        response = get(client, endpoint)
        assert response.status_code == 200
        assert "_MARKER" not in response.get_data(as_text=True)
    totals = get(client, "/api/v1/canary").get_json()["balances"]["totals"]
    assert set(totals) == {"stableUsd", "nativeUsd", "totalUsd", "note", "unpricedChains", "priceSource"}
    assert totals["totalUsd"] is None  # persisted partial totals are not trusted


def test_solana_api_and_collector_agree_on_decoded_key_length(root, client):
    corpus = [SOLANA, "1" * 32, "1" * 31, "1" * 44, "z" * 44, "z" * 43, "0" * 32, "not-a-key"]
    expected = node_fixture("addresses", root, corpus)
    assert [wallets.valid_solana_address(value) for value in corpus] == expected
    for address, valid in zip(corpus, expected):
        response = post_json(client, "/api/v1/wallets/addresses", {"family": "solana", "address": address})
        assert response.status_code == (201 if valid else 400)


# --------------------------------------------------------------------------- #
# Mutation-time watchlist validation (B2)
# --------------------------------------------------------------------------- #

ADDED = "0x" + "cc" * 20


@pytest.mark.parametrize(
    "stored",
    [
        [],  # container is not an object
        {"addresses": {}},  # addresses is not a list
        {"schema": "watch-addresses/v2", "addresses": []},  # unsupported schema
        {"schema": "watch-addresses/v1", "addresses": [], "note": "x"},  # unknown container key
        {"addresses": [{"address": EVM, "family": "cosmos"}]},  # unsupported family
        {"addresses": [{"address": "0x123"}]},  # invalid address
        {"addresses": [{"address": EVM, "label": "x" * 200}]},  # oversized label
        {"addresses": [{"address": EVM, "note": "unsupported"}]},  # unknown entry key
        {"addresses": [7]},  # entry is neither string nor object
        {"addresses": [{"address": EVM}] * 513},  # excessive entry count
    ],
)
def test_watchlist_mutation_rejects_unsupported_or_oversized_state(stored, root, client, collector_guard):
    path = root / ALLOWLIST["watch_addresses"]
    original = json.dumps(stored)
    path.write_text(original, encoding="utf8")
    for endpoint, body in (
        ("/api/v1/wallets/addresses", {"address": ADDED}),
        ("/api/v1/wallets/addresses/remove", {"address": EVM}),
    ):
        response = post_json(client, endpoint, body)
        assert response.status_code == 409, endpoint
        assert response.get_json()["reason"] == "WATCHLIST_UNREADABLE", endpoint
        # The original bytes are never rewritten or silently truncated.
        assert path.read_text(encoding="utf8") == original, endpoint
    assert collector_guard == []


def test_watchlist_mutation_preserves_supported_legacy_entries(root, client):
    path = root / ALLOWLIST["watch_addresses"]
    legacy = {
        "schema": "watch-addresses/v1",
        "addresses": [
            "0x" + "aa" * 20,
            {"address": "0x" + "bb" * 20, "label": "Treasury"},
            {"address": SOLANA, "family": "solana"},
        ],
    }
    path.write_text(json.dumps(legacy), encoding="utf8")
    response = post_json(client, "/api/v1/wallets/addresses", {"address": ADDED})
    assert response.status_code == 201
    saved = json.loads(path.read_text(encoding="utf8"))
    assert saved["schema"] == "watch-addresses/v1"
    assert {row["address"] for row in saved["addresses"]} == {
        "0x" + "aa" * 20, "0x" + "bb" * 20, SOLANA, ADDED,
    }


def test_watchlist_over_limit_is_never_erased_on_add(root, client, collector_guard):
    path = root / ALLOWLIST["watch_addresses"]
    seeded = {"schema": "watch-addresses/v1", "addresses": [{"address": "0x" + f"{i:040x}"} for i in range(513)]}
    original = json.dumps(seeded)
    path.write_text(original, encoding="utf8")
    response = post_json(client, "/api/v1/wallets/addresses", {"address": ADDED})
    assert response.status_code == 409 and response.get_json()["reason"] == "WATCHLIST_UNREADABLE"
    assert path.read_text(encoding="utf8") == original
    assert collector_guard == []


# --------------------------------------------------------------------------- #
# Bounded request stream and JSON body validation (B3/B4)
# --------------------------------------------------------------------------- #

OVERSIZED = b"{" + b" " * 5000


def test_wallet_request_limit_is_enforced_before_buffering(root, client, collector_guard):
    declared = client.post(
        "/api/v1/wallets/addresses", base_url="http://127.0.0.1:5050",
        environ_base={"REMOTE_ADDR": "127.0.0.1"}, data=OVERSIZED, content_type="application/json",
    )
    assert declared.status_code == 413 and declared.get_json()["reason"] == "BODY_TOO_LARGE"

    terminated = client.post(
        "/api/v1/wallets/addresses", base_url="http://127.0.0.1:5050",
        environ_base={"REMOTE_ADDR": "127.0.0.1"}, input_stream=io.BytesIO(OVERSIZED),
        content_type="application/json",
        environ_overrides={"wsgi.input_terminated": True, "CONTENT_LENGTH": None},
    )
    assert terminated.status_code == 413 and terminated.get_json()["reason"] == "BODY_TOO_LARGE"
    assert collector_guard == []
    assert not (root / ALLOWLIST["watch_addresses"]).exists()


def test_wallet_unknown_length_stream_within_limit_is_accepted(root, client):
    body = json.dumps({"address": ADDED}).encode()
    accepted = client.post(
        "/api/v1/wallets/addresses", base_url="http://127.0.0.1:5050",
        environ_base={"REMOTE_ADDR": "127.0.0.1"}, input_stream=io.BytesIO(body),
        content_type="application/json",
        environ_overrides={"wsgi.input_terminated": True, "CONTENT_LENGTH": None},
    )
    assert accepted.status_code == 201
    assert json.loads((root / ALLOWLIST["watch_addresses"]).read_text(encoding="utf8"))["addresses"] == [
        {"address": ADDED}
    ]


@pytest.mark.parametrize("raw", [b"{invalid", b"null", b"123", b"true", b'"scalar"', b'["list"]'])
def test_wallet_mutations_reject_non_object_json_before_side_effects(raw, root, client, collector_guard):
    for endpoint in ("/api/v1/wallets/addresses", "/api/v1/wallets/addresses/remove", "/api/v1/wallets/refresh"):
        response = client.post(
            endpoint, base_url="http://127.0.0.1:5050",
            environ_base={"REMOTE_ADDR": "127.0.0.1"}, data=raw, content_type="application/json",
        )
        assert response.status_code == 400, endpoint
        assert response.get_json()["reason"] == "INVALID_JSON", endpoint
    assert not (root / ALLOWLIST["watch_addresses"]).exists()
    assert collector_guard == []


@pytest.mark.parametrize("endpoint", [
    "/api/v1/wallets/addresses",
    "/api/v1/wallets/addresses/remove",
    "/api/v1/wallets/refresh",
])
@pytest.mark.parametrize("raw", [
    pytest.param(b"[" * 2100, id="unterminated-deep-array"),
    pytest.param(b'{"x":' + b"[" * 1800 + b"0" + b"]" * 1800 + b"}", id="deep-object"),
])
def test_wallet_deep_json_is_rejected_before_side_effects(endpoint, raw, root, client, collector_guard, monkeypatch):
    path = root / ALLOWLIST["watch_addresses"]
    original = json.dumps({"schema": "watch-addresses/v1", "addresses": [{"address": EVM}]}).encode()
    path.write_bytes(original)
    assert len(raw) <= app_module.MAX_BODY_BYTES

    def unexpected_side_effect(*args, **kwargs):
        pytest.fail("invalid JSON must not reach the wallet store or collector")

    monkeypatch.setattr(wallets.WalletStore, "add", unexpected_side_effect)
    monkeypatch.setattr(wallets.WalletStore, "remove", unexpected_side_effect)
    monkeypatch.setattr(app_module, "start_refresh", unexpected_side_effect)
    response = client.post(
        endpoint, base_url="http://127.0.0.1:5050",
        environ_base={"REMOTE_ADDR": "127.0.0.1"}, data=raw, content_type="application/json",
    )
    assert response.status_code == 400
    assert response.get_json()["reason"] == "INVALID_JSON"
    assert path.read_bytes() == original
    assert collector_guard == []


def test_wallet_refresh_accepts_empty_object(root, client, collector_guard):
    response = post_json(client, "/api/v1/wallets/refresh", {})
    assert response.status_code in {202, 409}
    if response.status_code == 202:
        deadline = time.time() + 5
        while not collector_guard and time.time() < deadline:
            time.sleep(0.02)
        assert collector_guard, "valid {} must still reach the collector path"
