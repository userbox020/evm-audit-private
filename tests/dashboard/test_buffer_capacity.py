"""Display-only holder capacity through the real aggregate/API/HTML projection."""

import copy
import importlib
import re
from html import unescape
from types import SimpleNamespace

import pytest

from conftest import get
from dashboard import ops
from dashboard.artifacts import ArtifactReader
from dashboard.targets import M7_EXECUTOR, _clean, build_targets
from test_target_sources import Reader
from test_targets import EULER_EXECUTOR, NOW, SENTINEL, fixtures, iso, pin, put


TARGETS = (
    ("targetM7_Morpho_ynETHx_msETH_Canary", "#M7", "0x14bcd9da052cdc6fe0b9446d5a616d5b7b4d4550"),
    ("targetM7B_Morpho_ynETHx_msETH_0x9b13", "#M7B", "0x9b1303ebf09bc51b7fac376c9e421e8daae63b82"),
    ("targetE4_EulerV2_WETH_ynETHx_0x8062", "#E4", "0x8062511602a163fe84d1d2300117ea8cc1600cbd"),
)
RANKS = {rank for _, rank, _ in TARGETS}
NOTE = "Shared holder-specific ordinary redemption capacity; not global cash or NAV and not additive across these targets."
KEYS = {"available", "read_status", "amount_raw", "amount", "symbol", "decimals", "scope",
        "legacy_shares", "legacy_shares_unit", "legacy_shares_rounded", "observation", "note"}
MAX_UINT256 = 2**256 - 1
PRIVATE = "BUFFER_DIAGNOSTIC_SECRET"


def capacity_data(raw="100396316", status="OK", shares=12.345678):
    data = fixtures()
    # Include one unrelated identity to establish that this is not a generic field.
    unrelated = data[SENTINEL]["targets"]["targetM1_Morpho_USDe_DAI"]
    data[SENTINEL]["targets"] = {"targetM1_Morpho_USDe_DAI": unrelated}
    for key, rank, user in TARGETS:
        data[SENTINEL]["targets"][key] = {
            "rank": rank, "user": user, "executor": EULER_EXECUTOR if rank == "#E4" else M7_EXECUTOR,
            "marketId": "0x45c3b59d53e2e148aaa6a857521059676d5c0489" if rank == "#E4" else "0xd2630c0ebf33ba83c82e8cd400a8e6345370238ca695ce58773b2d3e43de1b0a",
            "pair": "eynETHx-2 / eWETH-22 (Euler V2)" if rank == "#E4" else "ynETHx / msETH",
            "armed": True, "healthFactor": .999, "hfUnderwaterNow": True,
            "liquidatableNow": False, "executableNow": False, "eligibleForPreflight": False,
            "bpsToLiquidation": -10.01, "collateralUsd": 24000, "debtUsd": 22000,
            "ynEthxBufferWeth": shares, "bufferMaxWithdrawWeth": raw, "bufferReadStatus": status,
            "liveQuote": {"estimatedProfitUsd": 2080.15},
        }
    return data


def source_rows(data):
    return [data[SENTINEL]["targets"][key] for key, _, _ in TARGETS]


def capacity_rows(view):
    rows = {row["rank"]: row for row in view["targets"] if row["rank"] in RANKS}
    assert set(rows) == RANKS
    return rows


@pytest.fixture
def api(client, root, monkeypatch):
    # Only the clock is replaced: Flask invokes the real build_targets aggregate
    # against the isolated ArtifactReader, not a prebuilt presentation dictionary.
    monkeypatch.setattr(importlib.import_module("dashboard.app"), "time", SimpleNamespace(time=lambda: NOW))

    def load(data):
        for key, value in data.items():
            put(root, key, value)
        response = get(client, "/api/v1/targets")
        assert response.status_code == 200
        assert PRIVATE not in response.get_data(as_text=True)
        return response.get_json()

    return load


def assert_contract(capacity):
    assert set(capacity) == KEYS
    assert type(capacity["available"]) is bool
    assert capacity["read_status"] in {"OK", "READ_FAILED", "UNKNOWN"}
    assert capacity["symbol"] == "WETH" and capacity["decimals"] == 18
    assert capacity["scope"] == "SHARED_YNETHX_HOLDER"
    assert capacity["legacy_shares_unit"] == "MCwETH shares"
    assert capacity["legacy_shares_rounded"] is True and capacity["note"] == NOTE
    assert {"source", "block", "hash", "utc", "freshness"} <= capacity["observation"].keys()


@pytest.mark.parametrize("raw,amount", [
    ("100396316", "0.000000000100396316"), ("1", "0.000000000000000001"),
    ("0", "0.000000000000000000"), ("1000000000000000000", "1.000000000000000000"),
    ("1234567890123456789", "1.234567890123456789"),
    (str(MAX_UINT256), f"{MAX_UINT256 // 10**18}.{MAX_UINT256 % 10**18:018d}"),
])
def test_exact_uint256_capacity_survives_final_api_for_all_three_ranks(api, raw, amount):
    view = api(capacity_data(raw))
    for row in capacity_rows(view).values():
        cap = row["buffer_capacity"]
        assert_contract(cap)
        assert cap["available"] is True and cap["read_status"] == "OK"
        assert cap["amount_raw"] == raw and cap["amount"] == amount
        assert re.fullmatch(r"[0-9]+\.[0-9]{18}", cap["amount"])
        assert cap["legacy_shares"] == "12.345678"
        assert cap["observation"] == row["observation"]
        assert cap["observation"]["freshness"] == "FRESH"
    assert all("buffer_capacity" not in row for row in view["targets"] if row["rank"] not in RANKS)


@pytest.mark.parametrize("raw", [
    None, True, False, 0, 1, 1.5, -1, "", "00", "01", "-1", "+1", "1.0", "1e3", " 1", "1 ",
    "1\n", "٠", str(2**256), "9" * 79, "9" * 5000,
    {"value": "1", "error": PRIVATE}, ["1"], PRIVATE,
])
def test_malformed_raw_never_becomes_zero_or_success(api, raw):
    for row in capacity_rows(api(capacity_data(raw))).values():
        cap = row["buffer_capacity"]
        assert_contract(cap)
        assert not cap["available"] and cap["read_status"] == "UNKNOWN"
        assert cap["amount_raw"] is cap["amount"] is None
        assert cap["legacy_shares"] == "12.345678"  # never substituted for assets


@pytest.mark.parametrize("status,expected", [
    ("READ_FAILED", "READ_FAILED"), (None, "UNKNOWN"), (True, "UNKNOWN"),
    ({"error": PRIVATE}, "UNKNOWN"), (PRIVATE, "UNKNOWN"),
])
def test_read_failure_or_unknown_status_discards_even_valid_raw(api, status, expected):
    for row in capacity_rows(api(capacity_data("0", status))).values():
        cap = row["buffer_capacity"]
        assert not cap["available"] and cap["read_status"] == expected
        assert cap["amount"] is cap["amount_raw"] is None


@pytest.mark.parametrize("missing", ["bufferMaxWithdrawWeth", "bufferReadStatus", "both"])
def test_absent_fields_stay_unknown_despite_shares_or_other_balances(api, missing):
    data = capacity_data()
    for source in source_rows(data):
        for field in ("bufferMaxWithdrawWeth", "bufferReadStatus") if missing == "both" else (missing,):
            source.pop(field)
        source.update(idleWeth="999", navWeth="999999", bufferError=PRIVATE)
    for row in capacity_rows(api(data)).values():
        cap = row["buffer_capacity"]
        assert not cap["available"] and cap["read_status"] == "UNKNOWN"
        assert cap["amount"] is cap["amount_raw"] is None


@pytest.mark.parametrize("shares,expected", [
    (0, "0"), (0.000001, "0.000001"), ("12.345678", "12.345678"),
    (None, None), (True, None), (-1, None), ("1e2", None), ({"value": 1}, None), (PRIVATE, None),
])
def test_legacy_shares_are_validated_rounded_source_units_not_assets(api, shares, expected):
    for row in capacity_rows(api(capacity_data(shares=shares))).values():
        cap = row["buffer_capacity"]
        assert cap["legacy_shares"] == expected
        assert cap["amount_raw"] == "100396316"
        assert cap["legacy_shares_unit"] == "MCwETH shares" and cap["legacy_shares_rounded"] is True


@pytest.mark.parametrize("kind", ["document", "pin", "row"])
def test_stale_capacity_keeps_exact_recorded_value_and_original_pin(api, kind):
    data = capacity_data()
    old = pin(block=900, age=4010, digit="c")
    if kind == "document":
        data[SENTINEL]["generatedAt"] = iso(NOW - 4000)
    elif kind == "pin":
        data[SENTINEL]["pin"] = old
    else:
        for source in source_rows(data):
            source.update(observationBlock=old["number"], observationHash=old["hash"], observationUtc=old["utc"])
    for row in capacity_rows(api(data)).values():
        cap = row["buffer_capacity"]
        assert cap["available"] and cap["read_status"] == "OK"
        assert cap["amount"] == "0.000000000100396316"
        assert cap["observation"]["freshness"] == "STALE"
        expected = pin() if kind == "document" else old
        assert cap["observation"]["block"] == expected["number"]
        assert cap["observation"]["hash"] == expected["hash"]
        assert cap["observation"]["utc"] == expected["utc"]
        assert cap["observation"]["source"] == SENTINEL
        assert not row["quote"]["available"] and row["executable_now"] is False


@pytest.mark.parametrize("bad", [
    "missing_pin", "missing_hash", "wrong_chain", "bad_time", "timestamp_mismatch", "partial_row_pin",
    "bad_row_hash", "incomplete", "unavailable_refresh", "document_failed", "missing_publication", "row_chain",
])
def test_incoherent_provenance_does_not_advertise_capacity(api, bad):
    data = capacity_data()
    state = data[SENTINEL]
    if bad == "missing_pin":
        state.pop("pin")
    elif bad == "missing_hash":
        state["pin"].pop("hash")
    elif bad == "wrong_chain":
        state["pin"]["chainId"] = 8453
    elif bad == "bad_time":
        state["pin"]["utc"] = PRIVATE
    elif bad == "timestamp_mismatch":
        state["pin"]["timestamp"] = NOW - 1000
    elif bad == "document_failed":
        state["ok"] = False
    elif bad == "missing_publication":
        state.pop("generatedAt")
    else:
        for source in source_rows(data):
            if bad == "partial_row_pin":
                source["observationBlock"] = 900
            elif bad == "bad_row_hash":
                source.update(observationBlock=900, observationHash=PRIVATE, observationUtc=iso(NOW - 4000))
            elif bad == "incomplete":
                source["observationStatus"] = "INCOMPLETE"
            elif bad == "unavailable_refresh":
                source["refreshStatus"] = "UNAVAILABLE"
            else:
                source["chainId"] = 8453
    view = api(data)
    if bad in {"missing_pin", "missing_publication"}:
        # The existing source validator rejects the whole document in these
        # cases; the additive DTO must not resurrect excluded target rows.
        assert view["available"] is False and view["targets"] == []
        return
    for row in capacity_rows(view).values():
        cap = row["buffer_capacity"]
        assert not cap["available"] and cap["read_status"] == "UNKNOWN"
        assert cap["amount_raw"] is cap["amount"] is None
        assert cap["observation"]["freshness"] == "UNKNOWN"


@pytest.mark.parametrize("raw,status", [("0", "OK"), ("1", "OK"), (str(MAX_UINT256), "OK"), ("1", "READ_FAILED")])
def test_additive_capacity_cannot_change_any_existing_row_or_quote_gate(raw, status):
    before_data = capacity_data(raw, status)
    for source in source_rows(before_data):
        source.pop("bufferMaxWithdrawWeth")
        source.pop("bufferReadStatus")
    after_data = capacity_data(raw, status)
    before = build_targets(Reader(before_data), NOW)
    after = build_targets(Reader(after_data), NOW)
    for row in before["targets"] + after["targets"]:
        row.pop("buffer_capacity", None)
    assert after == before
    for row in capacity_rows(after).values():
        assert row["armed"] is row["runner"]["reported_armed"] is None
        assert row["executable_now"] is False and row["calldata_ready"] is False
        assert row["status"]["code"] == "ELIGIBLE"  # health, not redemption or execution
        assert row["quote"]["available"] is False
        assert row["quote"]["gross_usd"] is row["quote"]["gross_token_amount"] is None
        assert row.get("max_liq_profit_usd") is None


def test_shared_capacity_is_repeated_not_aggregated_and_only_three_identities(api):
    data = capacity_data()
    for source in data[SENTINEL]["targets"].values():
        source.update(bufferMaxWithdrawWeth="100396316", bufferReadStatus="OK")
    view = api(data)
    caps = [row["buffer_capacity"] for row in capacity_rows(view).values()]
    assert all(cap["amount_raw"] == "100396316" and cap["scope"] == "SHARED_YNETHX_HOLDER" for cap in caps)
    assert all(cap["note"] == NOTE for cap in caps)
    assert all("buffer_capacity" not in row for row in view["targets"] if row["rank"] not in RANKS)
    assert not any("buffer" in key or "capacity" in key for key in view["summary"])


def test_legacy_collateral_copy_corrects_only_share_unit(api, root):
    api(capacity_data())
    reader = ArtifactReader(root)
    legacy = ops.build_top_whale_triggers(reader.read_json(SENTINEL),
        reader.read_json("aave_v4_v3_morpho_liquidator_deploy"), NOW, reader,
        SENTINEL, "aave_v4_v3_morpho_liquidator_deploy")
    for row in capacity_rows(legacy).values():
        if row["rank"] in {"#M7", "#M7B"}:
            assert row["heartbeat_hours_left"] == "$24,000 ynETHx coll (buf 12.3457 MCwETH shares (rounded))"


def test_strict_raw_admission_never_unwraps_objects_or_string_subclasses():
    class WrappedString(str):
        pass

    assert _clean({"bufferMaxWithdrawWeth": WrappedString("1")})["bufferMaxWithdrawWeth"] is None
    assert _clean({"bufferMaxWithdrawWeth": {"value": "1"}, "bufferReadStatus": PRIVATE}) == {
        "bufferMaxWithdrawWeth": None, "bufferReadStatus": None,
    }


def capacity_sections(page):
    html = page.get_data(as_text=True)
    assert PRIVATE not in html
    sections = re.findall(r"<section\b[^>]*>.*?</section>", html, re.S)
    selected = [section for section in sections if "MCwETH shares" in section]
    assert len(selected) == 3
    return [" ".join(unescape(re.sub(r"<[^>]*>", " ", section)).split()) for section in selected]


@pytest.mark.parametrize("raw,status,expected", [
    ("100396316", "OK", "0.000000000100396316"), ("1", "OK", "0.000000000000000001"),
    ("0", "OK", "0.000000000000000000"), (None, "OK", None),
    ("100396316", "READ_FAILED", None), (True, "OK", None), (str(2**256), "OK", None),
])
def test_real_api_dto_renders_exact_capacity_or_unknown_without_inference(api, client, raw, status, expected):
    api(capacity_data(raw, status))
    page = get(client, "/targets")
    assert page.status_code == 200
    for text in capacity_sections(page):
        assert "MCwETH shares" in text and "rounded" in text.lower()
        assert "12.345678" in text and NOTE in text
        assert "12.345678 WETH" not in text
        if expected is not None:
            assert f"{expected} WETH" in text
        else:
            assert "unknown" in text.lower() or "unavailable" in text.lower()
            assert "0.000000000000000000 WETH" not in text
            assert "0.000000000100396316 WETH" not in text


def test_html_retains_stale_capacity_provenance_without_current_quote_promotion(api, client):
    data = capacity_data()
    old = pin(block=900, age=4010, digit="c")
    for source in source_rows(data):
        source.update(observationBlock=900, observationHash=old["hash"], observationUtc=old["utc"])
    before = copy.deepcopy(api(data))
    for text in capacity_sections(get(client, "/targets")):
        assert "stale" in text.lower() and "0.000000000100396316 WETH" in text
        assert "900" in text and old["utc"] in text and old["hash"] in text
    after = get(client, "/api/v1/targets").get_json()
    assert after == before
