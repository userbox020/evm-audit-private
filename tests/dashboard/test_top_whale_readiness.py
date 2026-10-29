import json
from datetime import datetime, timezone

import pytest

from dashboard.artifacts import ALLOWLIST, ArtifactReader
from dashboard.ops import (
    base_morpho_deploy_valid,
    base_morpho_live_watch_valid,
    base_morpho_rehearsal_valid,
    build_ops,
    build_top_whale_triggers,
    top_whale_executor_watch_valid,
)
from dashboard.targets import build_curated_targets


NOW = 1_792_400_000
BORROWER = "0x1a557354c5b8d7df38ea914209e416dc7065b158"
SPOKE_C = "0xbf10bdfe177de0336afd7fccf80a904e15386219"
SPOKE_A = "0xba1b3d55d249692b669a164024a838309b7508af"
CALLDATA = "0x834cbf54" + "00" * (17 * 32)


def iso(value):
    return datetime.fromtimestamp(value, timezone.utc).isoformat()


def sentinel(targets, **extra):
    return {
        "schema": "top-whale-triggers-status/v1",
        "generatedAt": iso(NOW - 10),
        "pin": {"chainId": 1, "number": 26_225_000, "utc": iso(NOW - 20)},
        "targets": targets,
        **extra,
    }


def watch(*targets, age=5, block=26_225_001):
    return {
        "ok": True,
        "deployedExecutor": "0x" + "33" * 20,
        "checkedAt": iso(NOW - age),
        "blockNumber": block,
        "pin": {"chainId": 1, "number": block, "utc": iso(NOW - age)},
        "targets": list(targets),
    }


def v3_watch(**extra):
    return {
        "ok": True,
        "checkedAt": iso(NOW - 5),
        "mode": "WATCH",
        "partition": "AAVE_V3_ONLY",
        "blockNumber": 26_225_001,
        "candidateCount": 2,
        **extra,
    }


def base_rehearsal_payload(**extra):
    return {
        "schema": "fork-poc/v1",
        "status": "PASS",
        "chainId": 8453,
        "generatedAt": iso(NOW - 60),
        "block": "52800100",
        "observations": [
            {"label": "deployGasUsed", "value": 1_234_567},
            {"label": "baseUsdeRehearsalResults", "value": [
                {"rank": "#B2", "ownerUsdcGainFormatted": "20.234567", "gasUsed": 234_567},
                {"rank": "#B1", "ownerUsdcGainFormatted": "10.123456", "gasUsed": "123456"},
            ]},
        ],
        **extra,
    }


def base_deploy_payload(**extra):
    return {
        "ok": True,
        "status": "DEPLOYED_ON_BASE_MAINNET",
        "chainId": 8453,
        "contractAddress": "0x" + "44" * 20,
        "txHash": "0x" + "ab" * 32,
        "blockNumber": 52_800_123,
        "gasUsed": 1_234_567,
        "actualFeeEth": "0.000001234567",
        "deployedBytecodeBytes": 5432,
        "actor": "0x" + "55" * 20,
        "ownerBaseEthAfter": "0.001234567890",
        "recordedAt": iso(NOW - 60),
        **extra,
    }


def base_watch_payload(**extra):
    return {
        "ok": True,
        "chainId": 8453,
        "checkedAt": iso(NOW - 5),
        "mode": "WATCH",
        "blockNumber": 52_800_125,
        "firedCount": 2,
        **extra,
    }


def build(root, state, live_watch=None, v3_live_watch=None, base_rehearsal=None, base_deploy=None, base_live_watch=None, m7_rehearsal=None, pt_rehearsal=None, yousd_rehearsal=None):
    # Reuse the isolated artifact tree and collector guard in conftest.py.
    for key, value in (
        ("top_whale_triggers_status", state),
        ("aave_v4_executor_live_watch", live_watch),
        ("top_whale_executor_live_watch", v3_live_watch),
        ("base_morpho_usde_rehearsal", base_rehearsal),
        ("base_morpho_liquidator_deploy", base_deploy),
        ("base_morpho_executor_live_watch", base_live_watch),
        ("eth_morpho_ynethx_rehearsal", m7_rehearsal),
        ("eth_morpho_pt_usde_rehearsal", pt_rehearsal),
        ("base_morpho_yousd_rehearsal", yousd_rehearsal),
    ):
        file = root / ALLOWLIST[key]
        if value is not None:
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text(json.dumps(value), encoding="utf8")
        elif file.exists():
            file.unlink()
    reader = ArtifactReader(root)
    return build_top_whale_triggers(
        reader.read_json("top_whale_triggers_status"), None, NOW, reader,
        "top_whale_triggers_status", "aave_v4_v3_morpho_liquidator_deploy",
        v4_watch_read=reader.read_json("aave_v4_executor_live_watch"),
        v3_watch_read=reader.read_json("top_whale_executor_live_watch"),
        base_rehearsal_read=reader.read_json("base_morpho_usde_rehearsal"),
        base_deploy_read=reader.read_json("base_morpho_liquidator_deploy"),
        base_watch_read=reader.read_json("base_morpho_executor_live_watch"),
        m7_rehearsal_read=reader.read_json("eth_morpho_ynethx_rehearsal"),
        pt_rehearsal_read=reader.read_json("eth_morpho_pt_usde_rehearsal"),
        yousd_rehearsal_read=reader.read_json("base_morpho_yousd_rehearsal"),
    )


@pytest.mark.parametrize("kind,chain,section,prefix", [
    ("pt_rehearsal", 1, "morpho_rehearsal", "m8_"),
    ("yousd_rehearsal", 8453, "base_rehearsal", "b7_"),
])
@pytest.mark.parametrize("change", [None, {"status": "FAIL"}, {"chainId": 10}, {"chainId": True}, {"chainId": "1"}, {"schema": "wrong"}, {"generatedAt": None}, {"observations": {}}])
def test_new_rehearsals_reject_missing_invalid_and_wrong_chain_payloads(root, kind, chain, section, prefix, change):
    payload = None if change is None else {**base_rehearsal_payload(chainId=chain), **change}
    view = build(root, sentinel({}), **{kind: payload})
    assert not any(key.startswith(prefix) for key in view[section])
    assert view[section]["available"] is False


@pytest.mark.parametrize("block", [None, True, -1, 10**12 + 1, "²", "9" * 5000])
def test_new_rehearsals_bound_blocks_and_ignore_unknown_observations(root, block):
    pt = base_rehearsal_payload(chainId=1, block=block, observations=[None, {},
        {"label": "ethMorphoPtUsdeDaiResult", "value": {"rank": "#M8"}},
        {"label": "ethMorphoPtUsdeDaiResult", "value": {"rank": "#M9"}},
        {"label": "wrong", "value": {"rank": "#M8", "ownerDaiGainFormatted": "999"}},
    ])
    yo = base_rehearsal_payload(block=block, observations=[None, {},
        {"label": "baseYoUsdUsdcResult", "value": {"rank": "#B0", "ownerUsdcGainFormatted": "999"}},
    ])
    view = build(root, sentinel({}), pt_rehearsal=pt, yousd_rehearsal=yo)
    assert view["morpho_rehearsal"]["available"] is True and view["base_rehearsal"]["available"] is True
    assert all(view["morpho_rehearsal"][key] is None for key in ("m8_pin_block", "m8_deploy_gas", "m8_gain_dai", "m8_gas", "m9_gain_dai", "m9_gas"))
    assert all(view["base_rehearsal"][key] is None for key in ("b7_pin_block", "b7_gain_usdc", "b7_gas"))


@pytest.mark.parametrize("key,chain,argument,section,prefix", [
    ("eth_morpho_pt_usde_rehearsal", 1, "pt_rehearsal_read", "morpho_rehearsal", "m8_"),
    ("base_morpho_yousd_rehearsal", 8453, "yousd_rehearsal_read", "base_rehearsal", "b7_"),
])
def test_new_rehearsals_cached_last_good_is_not_current_proof(root, key, chain, argument, section, prefix):
    from dashboard.ops import _fork_poc_rehearsal_valid

    path = root / ALLOWLIST[key]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(base_rehearsal_payload(chainId=chain)), encoding="utf8")
    reader = ArtifactReader(root)
    assert reader.read_json(key, validator=lambda value: _fork_poc_rehearsal_valid(value, chain)).current
    path.write_text("{", encoding="utf8")
    invalid = reader.read_json(key, validator=lambda value: _fork_poc_rehearsal_valid(value, chain))
    assert invalid.cached is True and invalid.current is False
    view = build_top_whale_triggers(None, None, NOW, reader, "top_whale_triggers_status", "aave_v4_v3_morpho_liquidator_deploy", **{argument: invalid})
    assert view[section]["available"] is False and not any(field.startswith(prefix) for field in view[section])


@pytest.mark.parametrize("legacy", [False, True])
@pytest.mark.parametrize("rehearsed", [False, True])
def test_base_is_estimated_observation_never_e10_execution(root, legacy, rehearsed):
    base_pin = {"chainId": 8453, "number": 52_800_123, "hash": "0x" + "22" * 32, "utc": iso(NOW - 12)}
    rows = [{
        "user": "0x" + f"{index + 1:02x}" * 20,
        "pair": "USDe / USDC (Base)",
        "healthFactor": 0.999998,
        "bpsToLiquidation": -0.02,
        "debtUsd" if legacy else "debtUsdc": 12_345.67,
        "collateralUsd" if legacy else "collateralValueUsdc": 13_456.78,
        "grossBonusUsd": 999,
        "liquidatableNow": True,
        "executableNow": True,
        "observationOnly": False,
        "executor": "0x4C8b…C31F (Base)",  # Unsupported E10 must not survive.
        "readyExecuteMorphoCalldata": "0x834cbf54" if legacy else CALLDATA,
    } for index in range(3)]
    view = build(
        root, sentinel({"base_Morpho_Whales": rows}, baseObservation={"status": "COMPLETE", "pin": base_pin}),
        base_rehearsal=base_rehearsal_payload() if rehearsed else None,
    )
    assert view["base_rehearsal"]["available"] is rehearsed
    assert len(view["targets"]) == 3
    for row in view["targets"]:
        assert row["observation_only"] is True
        assert row["executable_now"] is False
        assert row["liquidatable_now"] is True  # Reported eligibility is separate from execution readiness.
        assert row["executor"] is None
        assert row["calldata_ready"] is False
        assert row["surplus_usd"] is None
        assert row["health_is_estimate"] is True
        assert row["health_factor"] == "0.999998"
        assert row["bps_to_liq"] == "-0.0200"
        assert row["repay_summary"] == "12,345.67 USDC debt (est.)"
        assert row["seized_summary"] == "13,456.78 USDC collateral value"
        assert row["chain_id"] == 8453
        assert row["observation_block"] == base_pin["number"] != view["pin_block"]
        assert row["observation_utc"] == base_pin["utc"]
        assert "unaccrued interest" in row["readiness_note"]
        assert "$" not in json.dumps(row)
        assert "E10" not in json.dumps(row)
        assert "4C8b" not in json.dumps(row)


def test_base_missing_pin_never_inherits_ethereum_pin(root):
    view = build(root, sentinel({"base_Morpho_Whales": [{"healthFactor": None, "debtUsdc": 0, "collateralValueUsdc": None}]}))
    row = view["targets"][0]
    assert row["observation_block"] is None
    assert row["observation_utc"] is None
    assert row["health_factor"] is None
    assert row["seized_summary"] is None
    assert row["repay_summary"] == "0.00 USDC debt (est.)"


@pytest.mark.parametrize("status", ["UNAVAILABLE", "INCOMPLETE"])
def test_base_capture_failure_has_fixed_warning_not_healthy(root, status):
    view = build(root, sentinel({"base_Morpho_Whales": []}, baseObservation={"status": status, "reason": "RAW_PRIVATE_TRANSPORT_ERROR"}))
    assert view["available"] is True  # Optional Base failure does not discard Ethereum.
    assert any("Base whale" in warning and "unavailable" in warning for warning in view["warnings"])
    assert "RAW_PRIVATE" not in json.dumps(view)
    assert view["targets"] == []


def test_base_zero_price_partial_capture_warns(root):
    view = build(root, sentinel({"base_Morpho_Whales": [{"healthFactor": None, "collateralValueUsdc": None}]}, baseObservation={"status": "INCOMPLETE"}))
    assert any("incomplete" in warning for warning in view["warnings"])
    assert view["targets"][0]["health_factor"] is None


def test_paxg_ignores_legacy_execution_profit_and_fired_claims(root):
    view = build(root, sentinel({"target3_Morpho_PAXG_USDC": {
        "availableUsdc": 12_345.123456, "executableNow": True, "liquidatableNow": True,
        "readyExecuteMorphoCalldata": CALLDATA, "readyBorrowCalldata": CALLDATA,
        "readySupplyCollateralCalldata": CALLDATA, "grossBonusUsd": 999,
    }}, anyTriggerFired=True, firedTriggers=["TARGET_3_MORPHO_PAXG_USDC_LIQUIDITY_AVAILABLE"]))
    row = view["targets"][0]
    assert row["observation_only"] is True
    assert row["liquidatable_now"] is False
    assert row["executable_now"] is False
    assert row["calldata_ready"] is False
    assert row["executor"] is None
    assert row["user_short"] is None
    assert row["surplus_usd"] is None
    assert row["repay_summary"] is None
    assert row["seized_summary"] is None
    assert row["heartbeat_hours_left"] == "12,345.123456 USDC available"
    assert row["chain_id"] == 1
    assert row["health_is_estimate"] is False
    assert view["any_fired"] is False
    assert view["fired_triggers"] == []
    text = json.dumps(row)
    for unsupported in ("pre-funded", "armed", "1e12", "24,994", "24e4", "af5b"):
        assert unsupported not in text


@pytest.mark.parametrize("calldata", [None, "", "0x", "0x834cbf54", "0x834cbf54" + "00" * 32, CALLDATA[:-2], CALLDATA[:-1] + "z", CALLDATA])
def test_aave_calldata_requires_full_parameterized_abi_shape(root, calldata):
    item = {"user": BORROWER, "spoke": SPOKE_C, "readyExecuteMorphoCalldata": calldata}
    view = build(root, sentinel({
        "target1_AaveV4_USDe_USDC": item,
        "target2A_AaveV3_weETH_WETH_0x7231": item,
        "target2B_AaveV3_weETH_WETH_0x1A55": item,
        "spokeC_AaveV4_weETH_WETH": [item],
    }))
    assert len(view["targets"]) == 4
    for row in view["targets"]:
        assert row["calldata_ready"] is (calldata == CALLDATA)
        assert row["observation_only"] is False
        assert row["health_is_estimate"] is False
        if calldata == CALLDATA:
            assert "execution is not proven" in row["readiness_note"]


@pytest.mark.parametrize("calldata", [CALLDATA, "0x834cbf54"])
def test_additional_v3_rows_keep_calldata_checks_and_do_not_collide_with_spoke_c(root, calldata):
    borrower = "0xafbf278e06d2269aba2a4898afbab2ecb2584924"
    item = {
        "user": borrower, "pool": "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2",
        "healthFactor": 1.000986, "bpsToLiquidation": 9.86,
        "collateralUsd": 600_000, "debtUsd": 550_000, "liquidatableNow": False,
        "liveQuote": {"repayWeth": 100, "seizedWeEth": 91, "grossSurplusUsd": 5268, "grossSurplusWeth": 2.1},
        "readyExecuteMorphoCalldata": calldata,
    }
    view = build(root, sentinel({
        "target2A_AaveV3_weETH_WETH_0x7231": item,
        "additional_AaveV3_weETH_WETH": [
            {**item, "rank": "#2C", "user": "0x4998ff53c34e25495c21652be7ce63b0e40b0995"},
            item,
        ],
        "spokeC_AaveV4_weETH_WETH": [{**item, "spoke": SPOKE_C, "rank": "#C2"}],
    }))
    primary = next(row for row in view["targets"] if row["rank"] == "#2A")
    extras = [row for row in view["targets"] if row["id"].startswith("aave-v3-extra-")]
    assert [row["rank"] for row in extras] == ["#2C", "#2D"]
    assert [row["id"] for row in extras] == ["aave-v3-extra-0", "aave-v3-extra-1"]
    for row in extras:
        assert row["protocol"] == "Aave V3"
        assert row["pair"] == "weETH / WETH"
        assert row["calldata_ready"] is (calldata == CALLDATA)
        for field in (
            "health_factor", "bps_to_liq", "heartbeat_hours_left", "passive_hours_left",
            "repay_summary", "seized_summary", "surplus_usd", "executor", "venue_short",
        ):
            assert row[field] == primary[field]
    assert extras[1]["label"] == "Aave V3 weETH / WETH (0xafbf…4924)"
    v4 = next(row for row in view["targets"] if row["id"] == "spoke-c-0")
    assert v4["protocol"] == "Aave V4"
    assert v4["user_short"] == extras[1]["user_short"] == "0xafbf…4924"
    assert v4["venue_short"] != extras[1]["venue_short"]
    assert len(view["targets"]) == 4


@pytest.mark.parametrize("calldata,ready", [
    (None, False), (123, False), ("0x834cbf54", False),
    ("0x834cbf54" + "00" * 319, False),
    ("0x834cbf54" + "00" * 320, True),
    ("0x12345678" + "00" * 320, False),
])
def test_m1_morpho_row_uses_dedicated_executor_quote_and_calldata_check(root, calldata, ready):
    view = build(root, sentinel({
        "spokeC_AaveV4_weETH_WETH": [{"user": BORROWER, "spoke": SPOKE_C}],
        "targetM1_Morpho_USDe_DAI": {
            "user": "0xa3609cf7872faa7804281c7c5edb8b2d33001089",
            "healthFactor": 1.001051, "bpsToLiquidation": 10.5,
            "collateralUsd": 240_000, "debtUsd": 200_000, "liquidatableNow": False,
            "liveQuote": {"repayDai": 103_943, "seizedUsde": 108_500, "grossSurplusDai": 4057},
            "readyExecuteMorphoBlueCalldata": calldata,
        },
        "base_Morpho_Whales": [{}],
    }))
    assert [row["id"] for row in view["targets"]] == ["spoke-c-0", "target-m1-morpho-usde-dai", "base-morpho-0"]
    row = view["targets"][1]
    assert row["rank"] == "#M1"
    assert row["label"] == "Morpho Eth USDe / DAI Whale (0xa360…1089)"
    assert row["protocol"] == "Morpho Blue"
    assert row["pair"] == "USDe / DAI"
    assert row["user_short"] == "0xa360…1089"
    assert row["venue_short"] == "0xBBBB…FFCb"
    assert row["health_factor"] == "1.001051 HF"
    assert row["bps_to_liq"] == "10.50 bps to liq"
    assert row["heartbeat_hours_left"] == "$240,000 USDe coll"
    assert row["passive_hours_left"] == "$200,000 DAI debt"
    assert row["repay_summary"] == "103943 DAI"
    assert row["seized_summary"] == "108500 USDe"
    assert row["surplus_usd"] == "+$4,057.00 DAI"
    assert row["executor"] == "0xaf5b…07ba"
    assert row["calldata_ready"] is ready
    assert row["liquidatable_now"] is False
    assert row["chain_id"] == 1
    assert row["observation_block"] == view["pin_block"]


@pytest.mark.parametrize("fields,expected", [
    ({"debtUsd": 200_000, "passiveHoursToCrossing": 12.34}, "$200,000 DAI debt (12.3h passive)"),
    ({"debtUsd": 200_000, "passiveHoursToCrossing": 0}, "$200,000 DAI debt (0.0h passive)"),
    ({"debtUsd": 200_000}, "$200,000 DAI debt"),
    ({"debtUsd": 200_000, "passiveHoursToCrossing": None}, "$200,000 DAI debt"),
    ({"debtUsd": 200_000, "passiveHoursToCrossing": -1}, "$200,000 DAI debt"),
    ({"debtUsd": 200_000, "passiveHoursToCrossing": "12.3"}, "$200,000 DAI debt"),
    ({"debtUsd": 200_000, "passiveHoursToCrossing": True}, "$200,000 DAI debt"),
    ({"passiveHoursToCrossing": 12.34}, None),
    ({"debtUsd": "200000", "passiveHoursToCrossing": 12.34}, None),
])
def test_m1_passive_countdown_requires_numeric_debt_and_nonnegative_hours(root, fields, expected):
    row = build(root, sentinel({"targetM1_Morpho_USDe_DAI": fields}))["targets"][0]
    assert row["passive_hours_left"] == expected


@pytest.mark.parametrize("gross", [2050, -12.5])
@pytest.mark.parametrize("hours", [None, 0, 12.34])
def test_m2_is_ordered_after_m1_with_curve_quote_and_deployed_executor(root, gross, hours):
    view = build(root, sentinel({
        "targetM1_Morpho_USDe_DAI": {},
        "targetM2_Morpho_reUSD_USDC": {
            "user": "0xaa34d20be3f9623ccf5bff53ef4dfa765c3f5dd5", "healthFactor": .999, "bpsToLiquidation": -10.01,
            "debtUsd": 200000, "collateralUsd": 240000, "passiveHoursToCrossing": hours, "liquidatableNow": True,
            "observationOnly": False, "executableNow": True, "executor": "0x" + "55" * 20,
            "readyExecuteCurveUnwindCalldata": "0x12345678" + "00" * 512,
            "liveQuote": {"repayUsdc": 97450, "seizedReusd": 100000, "grossSurplusUsdc": gross},
        },
        "base_Morpho_Whales": [{}],
    }))
    assert [r["id"] for r in view["targets"]] == ["target-m1-morpho-usde-dai", "target-m2-morpho-reusd-usdc", "base-morpho-0"]
    row = view["targets"][1]
    assert row["rank"] == "#M2"
    assert row["label"] == "Morpho Eth reUSD / USDC Whale (0xaa34…5dd5)"
    assert row["protocol"] == "Morpho Blue"
    assert row["pair"] == "reUSD / USDC"
    assert row["user_short"] == "0xaa34…5dd5"
    assert row["health_factor"] == "0.999000 HF"
    assert row["bps_to_liq"] == "-10.01 bps to liq"
    assert row["liquidatable_now"] is True
    assert row["observation_only"] is False
    assert row["armed"] is row["executable_now"] is row["calldata_ready"] is True
    assert row["executor"] == "0x2d5bca1b846e89965544c7f03d09a25126803627"
    assert "Armed on Curve-unwind executor" in row["readiness_note"]
    assert row["repay_summary"] == "97450 USDC"
    assert row["seized_summary"] == "100000 reUSD"
    assert row["surplus_usd"] == f"{gross:+,.2f} USDC (gross, pre-gas)"
    assert row["heartbeat_hours_left"] == "240,000.00 USDC collateral value"
    assert row["passive_hours_left"] == "200,000.00 USDC debt" + (f" ({hours:.1f}h passive estimate)" if hours is not None else "")
    assert row["chain_id"] == 1
    assert row["observation_block"] == view["pin_block"]


def test_m2_malformed_quote_and_optional_fields_do_not_leak_or_imply_readiness(root):
    for invalid in (None, [], "invalid"):
        assert build(root, sentinel({"targetM2_Morpho_reUSD_USDC": invalid}))["targets"] == []
    row = build(root, sentinel({"targetM2_Morpho_reUSD_USDC": {
        "user": "invalid", "healthFactor": None, "bpsToLiquidation": True, "collateralUsd": True, "debtUsd": "200000",
        "liquidatableNow": "true", "liveQuote": {"grossSurplusUsdc": float("inf"), "repayUsdc": "PRIVATE_ERROR", "seizedReusd": True},
    }}))["targets"][0]
    for key in ("user_short", "health_factor", "bps_to_liq", "heartbeat_hours_left", "passive_hours_left", "repay_summary", "seized_summary", "surplus_usd", "liquidatable_now"):
        assert row[key] is None
    assert row["calldata_ready"] is False
    assert "PRIVATE_ERROR" not in json.dumps(row)


@pytest.mark.parametrize("eligible", [True, False])
def test_base_usde_b1_b2_are_armed_but_mglo_b3_remains_observation_only(root, eligible):
    market = "0x54cf9be57fdfa6457a660991907434ff9d295c465a603a50126ff647d50b7354"
    items = [{"rank": f"#B{i}", "marketId": market if i < 3 else "0x" + "cc" * 32,
              "pair": "USDe / USDC (Base)" if i < 3 else "mGLO / USDC (Base)", "liquidatableNow": eligible} for i in (1, 2, 3)]
    rows = build(root, sentinel({"base_Morpho_Whales": items}))["targets"]
    for i, row in enumerate(rows):
        armed = i < 2
        assert row["armed"] is armed
        assert row["observation_only"] is not armed
        assert row["executor"] == ("0x88bf…4f32" if armed else None)
        assert row["executable_now"] is (armed and eligible)
        assert row["calldata_ready"] is armed
    # Labels, pair text and even the deployed executor alone do not arm an unknown market.
    items[0]["marketId"] = "0x" + "cc" * 32
    items[0]["executor"] = "0x88bff83b4c987cc90a863cd79baa54dd5cd94f32"
    assert build(root, sentinel({"base_Morpho_Whales": items}))["targets"][0]["observation_only"] is True


@pytest.mark.parametrize("estimate,expected_estimate", [(False, False), (True, True), (None, True), (0, True), ("false", True)])
@pytest.mark.parametrize("eligible", [True, False, None, "true"])
def test_base_preserves_valid_accrued_estimate_flag_boolean_eligibility_and_passive_hours(root, estimate, expected_estimate, eligible):
    item = {"healthIsEstimate": estimate, "liquidatableNow": eligible, "healthFactor": .999, "bpsToLiquidation": -10.01,
            "debtUsdc": 12000, "collateralValueUsdc": 14000, "passiveHoursToCrossing": 0}
    row = build(root, sentinel({"base_Morpho_Whales": [item]}))["targets"][0]
    assert row["health_is_estimate"] is expected_estimate
    assert row["liquidatable_now"] is (eligible if isinstance(eligible, bool) else None)
    assert row["executable_now"] is row["calldata_ready"] is False
    assert row["executor"] is None
    debt = "12,000.00 USDC debt" + (" (est.)" if expected_estimate else "")
    assert row["repay_summary"] == debt
    assert row["passive_hours_left"] == debt + " (0.0h passive estimate)"
    assert ("unaccrued interest" in row["readiness_note"]) is expected_estimate
    if not expected_estimate:
        assert row["readiness_note"] == "Observation only; no Base liquidator deployed or live batch approved."


def test_m1_missing_or_malformed_optional_data_is_not_rendered_as_positive(root):
    for invalid in (None, [], "invalid"):
        assert build(root, sentinel({"targetM1_Morpho_USDe_DAI": invalid}))["targets"] == []
    row = build(root, sentinel({"targetM1_Morpho_USDe_DAI": {
        "user": "invalid", "healthFactor": None, "bpsToLiquidation": -1,
        "collateralUsd": True, "debtUsd": "200000", "liveQuote": [], "liquidatableNow": True,
    }}))["targets"][0]
    assert row["liquidatable_now"] is True
    assert row["calldata_ready"] is False
    for field in ("user_short", "health_factor", "bps_to_liq", "heartbeat_hours_left", "passive_hours_left", "repay_summary", "seized_summary", "surplus_usd"):
        assert row[field] is None


@pytest.mark.parametrize("same_spoke", [True, False])
def test_spoke_c_duplicate_uses_full_borrower_and_venue_not_cross_protocol(root, same_spoke):
    view = build(root, sentinel({
        "target2B_AaveV3_weETH_WETH_0x1A55": {"user": BORROWER},
        "spokeC_AaveV4_weETH_WETH": [{"user": BORROWER.upper().replace("0X", "0x"), "spoke": SPOKE_C if same_spoke else SPOKE_A}],
    }), watch({"id": "spokeC-candidate3-weeth-weth", "borrower": BORROWER, "spoke": SPOKE_C, "healthFactorFormatted": "1.000001"}))
    assert sum(row["rank"] == "#1B" for row in view["targets"]) == (0 if same_spoke else 1)
    assert sum(row["protocol"] == "Aave V3" for row in view["targets"]) == 1
    assert sum(row["id"] == "spoke-c-0" for row in view["targets"]) == 1
    if not same_spoke:
        legacy_row = next(row for row in view["targets"] if row["rank"] == "#1B")
        assert legacy_row["calldata_ready"] is False
        assert legacy_row["surplus_usd"] is None


@pytest.mark.parametrize("age,block,use_dedicated", [(20, 26_225_001, False), (4000, 26_225_001, False), (5, 26_224_999, False), (5, 26_225_001, True), (10, 26_225_000, True)])
def test_dedicated_watch_must_be_fresh_and_at_least_as_new(root, age, block, use_dedicated):
    unified = {"healthFactor": 1.01, "bpsToLiquidation": 99.0099, "liquidatableNow": True}
    dedicated = {"id": "spokeA-candidate1-usde-usdc", "healthFactorFormatted": "1.020000000", "bpsToLiquidation": "200.000", "isLiquidatableBothProviders": False}
    view = build(root, sentinel({"target1_AaveV4_USDe_USDC": unified}), watch(dedicated, age=age, block=block))
    row = view["targets"][0]
    assert row["health_factor"] == ("1.020000000" if use_dedicated else "1.010000")
    assert row["bps_to_liq"] == ("200.000" if use_dedicated else "99.0099")
    assert row["liquidatable_now"] is (not use_dedicated)
    assert row["observation_block"] == (block if use_dedicated else view["pin_block"])


def test_aave_fired_signal_is_not_removed_with_legacy_paxg(root):
    trigger = "TARGET_1_AAVE_V4_USDE_USDC_LIQUIDATABLE"
    view = build(root, sentinel({}, firedTriggers=["TARGET_3_MORPHO_PAXG_USDC_LIQUIDITY_AVAILABLE", trigger], anyTriggerFired=True))
    assert view["any_fired"] is True
    assert view["fired_triggers"] == [trigger]


@pytest.mark.parametrize("snapshot", [[], "malformed whale snapshot", None])
def test_non_object_whale_snapshot_with_valid_dedicated_watch_is_unavailable(root, snapshot):
    for key, value in (("top_whale_triggers_status", snapshot), ("aave_v4_executor_live_watch", watch())):
        (root / ALLOWLIST[key]).write_text(json.dumps(value), encoding="utf8")
    reader = ArtifactReader(root)
    view = build_top_whale_triggers(
        reader.read_json("top_whale_triggers_status"), None, NOW, reader,
        "top_whale_triggers_status", "aave_v4_v3_morpho_liquidator_deploy",
        v4_watch_read=reader.read_json("aave_v4_executor_live_watch"),
    )
    assert view["available"] is False
    assert view["v4_live_watch"]["available"] is True
    assert view["targets"] == []
    assert view["warnings"] == ["Top whale trigger sentinel status is unavailable or invalid"]


@pytest.mark.parametrize("ok", [True, False])
def test_v3_executor_watch_valid_status_is_projected(root, ok):
    payload = v3_watch(ok=ok)
    assert top_whale_executor_watch_valid(payload) is True
    view = build(root, sentinel({}), v3_live_watch=payload)
    assert view["v3_live_watch"] == {
        "available": True,
        "freshness": "FRESH",
        "age_text": "5s",
        "checked_at": payload["checkedAt"],
        "mode": "WATCH",
        "partition": "AAVE_V3_ONLY",
        "block_number": 26_225_001,
        "candidate_count": 2,
    }
    assert view["targets"] == []
    assert view["any_fired"] is False


def test_v3_executor_watch_stale_timestamp_is_not_fresh_file_mtime(root):
    payload = v3_watch(checkedAt=iso(NOW - 4000))
    view = build(root, sentinel({}), v3_live_watch=payload)
    assert view["freshness"] == "FRESH"
    assert view["v3_live_watch"]["available"] is True
    assert view["v3_live_watch"]["freshness"] == "STALE"
    assert view["v3_live_watch"]["age_text"] == "66m"
    assert view["v3_live_watch"]["checked_at"] == payload["checkedAt"]


@pytest.mark.parametrize("payload", [
    None, [], "invalid", {},
    {key: value for key, value in v3_watch().items() if key != "ok"},
    {key: value for key, value in v3_watch().items() if key != "checkedAt"},
    {key: value for key, value in v3_watch().items() if key != "mode"},
    v3_watch(ok=1), v3_watch(ok="true"),
    v3_watch(checkedAt="not-a-timestamp"), v3_watch(mode=None),
])
def test_v3_executor_watch_missing_or_malformed_is_unavailable(root, payload):
    assert top_whale_executor_watch_valid(payload) is False
    view = build(root, sentinel({}), v3_live_watch=payload)
    assert view["available"] is True
    assert view["v3_live_watch"] == {
        "available": False,
        "freshness": "UNKNOWN",
        "age_text": None,
        "checked_at": None,
        "mode": None,
        "partition": None,
        "block_number": None,
        "candidate_count": 0,
    }


@pytest.mark.parametrize("fields,block,count", [
    ({"pin": {"number": 26_225_000}}, 26_225_001, 2),
    ({"blockNumber": None, "pin": {"number": 26_225_000}}, 26_225_000, 2),
    ({"blockNumber": True, "pin": {"number": 26_225_000}, "candidateCount": True}, 26_225_000, 0),
    ({"blockNumber": 10**12 + 1, "pin": [], "candidateCount": 101}, None, 0),
    ({"blockNumber": -1, "pin": {"number": "26225000"}, "candidateCount": -1}, None, 0),
    ({"blockNumber": "26225001", "pin": {"number": True}, "candidateCount": "2"}, None, 0),
    ({"blockNumber": 10**12, "candidateCount": 100}, 10**12, 100),
])
def test_v3_executor_watch_bounds_and_pin_fallback(root, fields, block, count):
    view = build(root, sentinel({}), v3_live_watch=v3_watch(**fields))["v3_live_watch"]
    assert view["available"] is True
    assert view["block_number"] == block
    assert view["candidate_count"] == count


def test_v3_executor_watch_scrubs_and_bounds_text(root):
    payload = v3_watch(mode="WATCH https://example.invalid/status " + "x" * 50, partition="V3\n" + "y" * 50)
    view = build(root, sentinel({}), v3_live_watch=payload)["v3_live_watch"]
    assert view["mode"] == ("WATCH … " + "x" * 50)[:40]
    assert view["partition"] == ("V3 " + "y" * 50)[:40]
    assert build(root, sentinel({}), v3_live_watch=v3_watch(partition=None))["v3_live_watch"]["partition"] is None


@pytest.mark.parametrize("payload,available,freshness", [
    (v3_watch(), True, "FRESH"),
    (v3_watch(checkedAt=iso(NOW - 4000)), True, "STALE"),
    (v3_watch(ok="true"), False, "UNKNOWN"),
    (None, False, "UNKNOWN"),
])
def test_ops_wires_v3_executor_watch_offline(root, monkeypatch, payload, available, freshness):
    monkeypatch.setattr("dashboard.ops.execution_view", lambda reader, now: {"verification": "UNAVAILABLE"})
    if payload is not None:
        (root / ALLOWLIST["top_whale_executor_live_watch"]).write_text(json.dumps(payload), encoding="utf8")
    reader = ArtifactReader(root)
    whales = build_ops(reader, NOW)["offensive"]["top_whales"]
    assert whales["available"] is False  # Watch status does not require a sentinel snapshot.
    assert whales["v3_live_watch"]["available"] is available
    assert whales["v3_live_watch"]["freshness"] == freshness
    assert reader.read_status["top_whale_executor_live_watch"]["parser"] is available


def test_v3_executor_watch_cached_valid_payload_is_not_current(root):
    path = root / ALLOWLIST["top_whale_executor_live_watch"]
    path.write_text(json.dumps(v3_watch()), encoding="utf8")
    reader = ArtifactReader(root)
    assert reader.read_json("top_whale_executor_live_watch", validator=top_whale_executor_watch_valid).current
    path.write_text("{", encoding="utf8")
    invalid_read = reader.read_json("top_whale_executor_live_watch", validator=top_whale_executor_watch_valid)
    assert invalid_read.cached is True
    view = build_top_whale_triggers(
        None, None, NOW, reader,
        "top_whale_triggers_status", "aave_v4_v3_morpho_liquidator_deploy",
        v3_watch_read=invalid_read,
    )
    assert view["v3_live_watch"]["available"] is False
    assert view["v3_live_watch"]["freshness"] == "UNKNOWN"


@pytest.mark.parametrize("block", [52_800_100, "52800100"])
def test_base_rehearsal_projects_local_fork_evidence(root, block):
    payload = base_rehearsal_payload(block=block)
    assert base_morpho_rehearsal_valid(payload) is True
    view = build(root, sentinel({}), base_rehearsal=payload)
    assert view["base_rehearsal"] == {
        "available": True,
        "pin_block": 52_800_100,
        "deploy_gas": "1234567",
        "b1_gain_usdc": "10.123456",
        "b1_gas": "123456",
        "b2_gain_usdc": "20.234567",
        "b2_gas": "234567",
    }
    assert view["any_fired"] is False


@pytest.mark.parametrize("payload", [
    None, [], "invalid", {},
    base_rehearsal_payload(schema="other/v1"),
    base_rehearsal_payload(status="FAIL"),
    base_rehearsal_payload(chainId=1),
    base_rehearsal_payload(chainId="8453"),
    base_rehearsal_payload(generatedAt=None),
    base_rehearsal_payload(generatedAt="invalid"),
    base_rehearsal_payload(observations={}),
])
def test_base_rehearsal_missing_or_invalid_is_unavailable(root, payload):
    assert base_morpho_rehearsal_valid(payload) is False
    view = build(root, sentinel({}), base_rehearsal=payload)
    assert view["available"] is True
    assert view["base_rehearsal"] == {
        "available": False,
        "pin_block": None,
        "deploy_gas": None,
        "b1_gain_usdc": None,
        "b1_gas": None,
        "b2_gain_usdc": None,
        "b2_gas": None,
    }


@pytest.mark.parametrize("block", [None, True, -1, 10**12 + 1, 1.5, "0x123", "²", "9" * 5000])
def test_base_rehearsal_invalid_block_is_unknown(root, block):
    view = build(root, sentinel({}), base_rehearsal=base_rehearsal_payload(block=block))
    assert view["base_rehearsal"]["available"] is True
    assert view["base_rehearsal"]["pin_block"] is None


def test_base_rehearsal_skips_malformed_observations_and_scrubs_text(root):
    payload = base_rehearsal_payload(observations=[
        None, "invalid", {},
        {"label": "deployGasUsed", "value": "https://example.invalid/gas " + "1" * 30},
        {"label": "baseUsdeRehearsalResults", "value": {}},
        {"label": "baseUsdeRehearsalResults", "value": [
            None, "invalid", {},
            {"rank": "#B3", "ownerUsdcGainFormatted": "999", "gasUsed": "999"},
            {"rank": "#B1", "ownerUsdcGainFormatted": "https://example.invalid/gain " + "2" * 40, "gasUsed": "3" * 30},
        ]},
    ])
    view = build(root, sentinel({}), base_rehearsal=payload)["base_rehearsal"]
    assert view["deploy_gas"] == ("… " + "1" * 30)[:24]
    assert view["b1_gain_usdc"] == ("… " + "2" * 40)[:32]
    assert view["b1_gas"] == "3" * 24
    assert view["b2_gain_usdc"] is None
    assert view["b2_gas"] is None


@pytest.mark.parametrize("payload,available", [
    (base_rehearsal_payload(), True),
    (base_rehearsal_payload(status="FAIL"), False),
    (None, False),
])
def test_ops_wires_base_rehearsal_offline_without_execution_readiness(root, monkeypatch, payload, available):
    monkeypatch.setattr("dashboard.ops.execution_view", lambda reader, now: {"verification": "UNAVAILABLE"})
    build(root, sentinel({"base_Morpho_Whales": [{
        "executableNow": True, "observationOnly": False,
        "readyExecuteMorphoCalldata": CALLDATA, "executor": "0x" + "44" * 20,
    }]}), base_rehearsal=payload)
    reader = ArtifactReader(root)
    whales = build_ops(reader, NOW)["offensive"]["top_whales"]
    assert whales["base_rehearsal"]["available"] is available
    assert reader.read_status["base_morpho_usde_rehearsal"]["parser"] is available
    row = whales["targets"][0]
    assert row["observation_only"] is True
    assert row["executable_now"] is False
    assert row["calldata_ready"] is False
    assert row["executor"] is None


def test_ops_projects_eth_morpho_m1_and_m2_fork_rehearsals_offline(root, monkeypatch):
    monkeypatch.setattr("dashboard.ops.execution_view", lambda reader, now: {"verification": "UNAVAILABLE"})
    build(root, sentinel({}))
    for key, payload in (
        ("eth_morpho_usde_dai_rehearsal", {
            "schema": "fork-poc/v1", "status": "PASS", "chainId": 1,
            "generatedAt": "2026-10-19T22:15:00Z", "block": "26229381",
            "observations": [{"label": "ethMorphoUsdeDaiResult", "value": {"ownerDaiGainFormatted": "4631.690342", "gasUsed": "407860"}}],
        }),
        ("eth_morpho_reusd_rehearsal", {
            "schema": "fork-poc/v1", "status": "PASS", "chainId": 1,
            "generatedAt": "2026-10-20T00:55:22Z", "block": "26230276",
            "observations": [
                {"label": "deployGasUsed", "value": "948557"},
                {"label": "ethMorphoReusdUsdcResult", "value": {"ownerUsdcGainFormatted": "2111.524282", "gasUsed": "365773"}},
            ],
        }),
    ):
        file = root / ALLOWLIST[key]
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(json.dumps(payload), encoding="utf-8")
    whales = build_ops(ArtifactReader(root), NOW)["offensive"]["top_whales"]
    assert whales["morpho_rehearsal"] == {
        "available": True,
        "m1_pin_block": 26229381,
        "m1_gain_dai": "4631.690342",
        "m1_gas": "407860",
        "m2_pin_block": 26230276,
        "m2_deploy_gas": "948557",
        "m2_gain_usdc": "2111.524282",
        "m2_gas": "365773",
    }


def test_base_executor_and_live_watch_projection_does_not_imply_target_readiness(root):
    deploy = base_deploy_payload()
    live_watch = base_watch_payload()
    assert base_morpho_deploy_valid(deploy) is True
    assert base_morpho_live_watch_valid(live_watch) is True
    view = build(root, sentinel({"base_Morpho_Whales": [{
        "executableNow": True, "observationOnly": False,
        "readyExecuteMorphoCalldata": CALLDATA, "executor": deploy["contractAddress"],
    }]}), base_deploy=deploy, base_live_watch=live_watch)
    assert view["base_executor"] == {
        "available": True,
        "contract_address": deploy["contractAddress"],
        "short_address": "0x4444…4444",
        "tx_hash": deploy["txHash"],
        "short_tx": "0xabababab…ababab",
        "block_number": 52_800_123,
        "gas_used": "1234567",
        "actual_fee_eth": "0.000001234567",
        "code_bytes": 5432,
        "owner": "0x5555…5555",
        "owner_eth_after": "0.001234567890",
        "deployed_at": deploy["recordedAt"],
    }
    assert view["base_live_watch"] == {
        "available": True,
        "freshness": "FRESH",
        "age_text": "5s",
        "checked_at": live_watch["checkedAt"],
        "mode": "WATCH",
        "block_number": 52_800_125,
        "fired_count": 2,
    }
    assert view["any_fired"] is False
    row = view["targets"][0]
    assert row["observation_only"] is True
    assert row["executable_now"] is row["calldata_ready"] is False
    assert row["executor"] is None


@pytest.mark.parametrize("payload", [
    None, [], "invalid", {},
    base_deploy_payload(ok=False), base_deploy_payload(ok=1),
    base_deploy_payload(status="DEPLOYED_AND_TWO_PROVIDER_VERIFIED"),
    base_deploy_payload(chainId=1), base_deploy_payload(chainId="8453"),
    base_deploy_payload(contractAddress=None), base_deploy_payload(contractAddress="invalid"),
    base_deploy_payload(recordedAt=None), base_deploy_payload(recordedAt="invalid"),
])
def test_base_executor_missing_or_invalid_is_unavailable(root, payload):
    assert base_morpho_deploy_valid(payload) is False
    view = build(root, sentinel({}), base_deploy=payload)
    assert view["available"] is True
    assert view["base_executor"] == {
        "available": False,
        "contract_address": None,
        "short_address": None,
        "tx_hash": None,
        "short_tx": None,
        "block_number": None,
        "gas_used": None,
        "actual_fee_eth": None,
        "code_bytes": None,
        "owner": None,
        "owner_eth_after": None,
        "deployed_at": None,
    }


@pytest.mark.parametrize("payload", [
    None, [], "invalid", {},
    base_watch_payload(ok=False), base_watch_payload(ok=1),
    base_watch_payload(chainId=1), base_watch_payload(chainId="8453"),
    base_watch_payload(checkedAt=None), base_watch_payload(checkedAt="invalid"),
    base_watch_payload(mode=None),
])
def test_base_live_watch_missing_or_invalid_is_unavailable(root, payload):
    assert base_morpho_live_watch_valid(payload) is False
    view = build(root, sentinel({}), base_live_watch=payload)
    assert view["available"] is True
    assert view["base_live_watch"] == {
        "available": False,
        "freshness": "UNKNOWN",
        "age_text": None,
        "checked_at": None,
        "mode": None,
        "block_number": None,
        "fired_count": 0,
    }


def test_base_live_watch_uses_own_timestamp_and_scrubs_mode(root):
    payload = base_watch_payload(checkedAt=iso(NOW - 4000), mode="WATCH https://example.invalid/status " + "x" * 50)
    view = build(root, sentinel({}), base_live_watch=payload)
    assert view["freshness"] == "FRESH"
    assert view["base_live_watch"]["available"] is True
    assert view["base_live_watch"]["freshness"] == "STALE"
    assert view["base_live_watch"]["age_text"] == "66m"
    assert view["base_live_watch"]["checked_at"] == payload["checkedAt"]
    assert view["base_live_watch"]["mode"] == ("WATCH … " + "x" * 50)[:40]


@pytest.mark.parametrize("block,count", [(None, None), (True, True), (-1, -1), (10**12 + 1, 101), ("52800125", "2"), (10**12, 100)])
def test_base_live_watch_bounds_optional_numbers(root, block, count):
    view = build(root, sentinel({}), base_live_watch=base_watch_payload(blockNumber=block, firedCount=count))["base_live_watch"]
    assert view["available"] is True
    assert view["block_number"] == (10**12 if block == 10**12 else None)
    assert view["fired_count"] == (100 if count == 100 else 0)


def test_base_executor_bounds_and_scrubs_optional_fields(root):
    payload = base_deploy_payload(
        txHash="zz" + "ab" * 32, actor="invalid", blockNumber=True, deployedBytecodeBytes=100_001,
        gasUsed="https://example.invalid/gas " + "1" * 30, actualFeeEth=None, ownerBaseEthAfter=None,
    )
    view = build(root, sentinel({}), base_deploy=payload)["base_executor"]
    assert view["available"] is True
    for key in ("tx_hash", "short_tx", "owner", "block_number", "code_bytes", "actual_fee_eth", "owner_eth_after"):
        assert view[key] is None
    assert view["gas_used"] == ("… " + "1" * 30)[:24]


@pytest.mark.parametrize("deploy,live_watch,available,freshness", [
    (base_deploy_payload(), base_watch_payload(), True, "FRESH"),
    (base_deploy_payload(), base_watch_payload(checkedAt=iso(NOW - 4000)), True, "STALE"),
    (base_deploy_payload(chainId=1), base_watch_payload(chainId=1), False, "UNKNOWN"),
    (None, None, False, "UNKNOWN"),
])
def test_ops_wires_base_executor_and_live_watch_offline(root, monkeypatch, deploy, live_watch, available, freshness):
    monkeypatch.setattr("dashboard.ops.execution_view", lambda reader, now: {"verification": "UNAVAILABLE"})
    build(root, None, base_deploy=deploy, base_live_watch=live_watch)
    reader = ArtifactReader(root)
    whales = build_ops(reader, NOW)["offensive"]["top_whales"]
    assert whales["available"] is False  # Both optional sections work without a sentinel snapshot.
    assert whales["base_executor"]["available"] is available
    assert whales["base_live_watch"]["available"] is available
    assert whales["base_live_watch"]["freshness"] == freshness
    assert reader.read_status["base_morpho_liquidator_deploy"]["parser"] is available
    assert reader.read_status["base_morpho_executor_live_watch"]["parser"] is available


@pytest.mark.parametrize("key,payload,validator,read_arg,section", [
    ("base_morpho_liquidator_deploy", base_deploy_payload(), base_morpho_deploy_valid, "base_deploy_read", "base_executor"),
    ("base_morpho_executor_live_watch", base_watch_payload(), base_morpho_live_watch_valid, "base_watch_read", "base_live_watch"),
])
def test_base_cached_valid_payload_is_not_current(root, key, payload, validator, read_arg, section):
    path = root / ALLOWLIST[key]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf8")
    reader = ArtifactReader(root)
    assert reader.read_json(key, validator=validator).current
    path.write_text("{", encoding="utf8")
    invalid_read = reader.read_json(key, validator=validator)
    assert invalid_read.cached is True
    view = build_top_whale_triggers(
        None, None, NOW, reader,
        "top_whale_triggers_status", "aave_v4_v3_morpho_liquidator_deploy",
        **{read_arg: invalid_read},
    )
    assert view[section]["available"] is False


def extra_base_usde_payloads(liquidatable=False):
    return [{
        "rank": rank,
        "user": user,
        "marketId": "0x54cf9be57fdfa6457a660991907434ff9d295c465a603a50126ff647d50b7354",
        "pair": "USDe / USDC (Base)",
        "chainId": 8453,
        "observationBlock": 52_800_123,
        "observationHash": "0x" + "22" * 32,
        "observationUtc": iso(NOW - 12),
        "observationStatus": "COMPLETE",
        "deployedExecutor": "0x88bff83b4c987cc90a863cd79baa54dd5cd94f32",
        "healthFactor": 0.9999 if liquidatable else 1.0001,
        "healthIsEstimate": False,
        "liquidatableNow": liquidatable,
        "bpsToLiquidation": -1 if liquidatable else 1,
        "debtUsdc": 700_000,
        "collateralValueUsdc": 800_000,
        "passiveHoursToCrossing": 0 if liquidatable else 2.5,
        "liveQuote": {"repayUsdc": 662660.18, "seizedUsde": 680000, "uniV3OutUsdc": 685802.73, "grossSurplusUsdc": 23142.55},
    } for rank, user in (
        ("#B4", "0x7dcdb4ad4017f848879d17370aa6f32564e5cd08"),
        ("#B5", "0x8986f93988d415abfb7b9bb700ccd3580c2f5298"),
        ("#B6", "0xae0a739c3724bb5cd2bdcf73764c87a5a6ec21a3"),
    )]


def base_b7_payload(liquidatable=False):
    return {**extra_base_usde_payloads(liquidatable)[0],
        "rank": "#B7", "user": "0x108b853407284e77656c569677c82e8fed581299",
        "marketId": "0x1a3e69d0109bb1be42b80e11034bb6ee98fc466721f26845dc83b2aa8d979137",
        "pair": "yoUSD / USDC (Base)", "armed": True, "observationOnly": False,
        "bpsToLiquidation": -1 if liquidatable else 0.4, "passiveHoursToCrossing": 0 if liquidatable else 5.38,
        "liveQuote": {"repayUsdc": 4599.32, "seizedUsde": 4420.0, "uniV3OutUsdc": 4719.67,
                      "grossSurplusUsdc": 120.36, "grossSurplusUsd": 120.36},
    }


@pytest.mark.parametrize("liquidatable", [False, True])
def test_b7_projects_as_fourth_extra_base_whale_with_redeem_units(root, liquidatable):
    item = base_b7_payload(liquidatable)
    view = build(root, sentinel({"extra_Base_USDe_Whales": extra_base_usde_payloads() + [item]}))
    assert len(view["targets"]) == 4
    row = view["targets"][3]
    assert row["id"] == "base-usde-extra-3" and row["rank"] == "#B7"
    assert row["pair"] == "yoUSD / USDC (Base)"
    assert row["armed"] is True and row["observation_only"] is False
    assert row["liquidatable_now"] is row["executable_now"] is liquidatable
    assert row["executor"] == "0x88bf…4f32"
    assert row["repay_summary"] == "4599.32 USDC"
    assert row["seized_summary"] == "4420.0 yoUSD"
    assert row["surplus_usd"] == "+$120.36 USDC"
    assert row["bps_to_liq"] == ("-1.0000" if liquidatable else "0.4000")
    assert "yoUSD.redeem" in row["readiness_note"]


@pytest.mark.parametrize("field,value", [("marketId", "0x" + "99" * 32), ("user", "0x" + "11" * 20), ("user", None)])
def test_b7_wrong_market_or_borrower_cannot_be_promoted_by_rank(root, field, value):
    item = base_b7_payload()
    item[field] = value
    assert build(root, sentinel({"extra_Base_USDe_Whales": [item]}))["targets"] == []


@pytest.mark.parametrize("liquidatable", [False, True])
def test_extra_base_usde_whales_project_after_b0_with_base_quote_and_pin(root, liquidatable):
    items = extra_base_usde_payloads(liquidatable)
    view = build(root, sentinel({
        "targetB0_Base_USDe_USDC": {},
        "extra_Base_USDe_Whales": items + [{"rank": "#B7"}],
        "base_Morpho_Whales": [{}],
    }))
    assert [row["id"] for row in view["targets"]] == [
        "target-b0-base-usde-usdc", "base-usde-extra-0", "base-usde-extra-1", "base-usde-extra-2", "base-morpho-0",
    ]
    for row, item in zip(view["targets"][1:4], items):
        assert row["rank"] == item["rank"]
        assert row["observation_only"] is False
        assert row["executable_now"] is row["liquidatable_now"] is liquidatable
        assert row["health_is_estimate"] is False
        assert row["executor"] == "0x88bf…4f32"
        assert row["calldata_ready"] is True
        assert row["chain_id"] == 8453
        assert row["observation_block"] == item["observationBlock"] != view["pin_block"]
        assert row["observation_utc"] == item["observationUtc"]
        assert row["repay_summary"] == "662660.18 USDC"
        assert row["seized_summary"] == "680000 USDe"
        assert row["surplus_usd"] == "+$23,142.55 USDC"
        assert row["passive_hours_left"] == f"700,000.00 USDC debt ({item['passiveHoursToCrossing']:.1f}h passive estimate)"


@pytest.mark.parametrize("payload", [None, {}, "invalid", [None, "invalid"]])
def test_extra_base_usde_invalid_array_or_entries_are_skipped(root, payload):
    assert build(root, sentinel({"extra_Base_USDe_Whales": payload}))["targets"] == []


@pytest.mark.parametrize("liquidatable", [False, True])
def test_curated_extra_base_usde_whales_use_base_runner_and_usdc_quote(root, liquidatable):
    items = extra_base_usde_payloads(liquidatable)
    base_pin = {"chainId": 8453, "number": 52_800_123, "hash": "0x" + "22" * 32, "utc": iso(NOW - 12)}
    state = sentinel({
        "targetB0_Base_USDe_USDC": {**items[0], "rank": "#B0", "user": "0x60753e8622a6cfea1df449a9625a9778bb922b72"},
        "extra_Base_USDe_Whales": items,
    }, baseObservation={"status": "COMPLETE", "pin": base_pin})
    state["pin"]["hash"] = "0x" + "11" * 32
    build(root, state)
    view = build_curated_targets(ArtifactReader(root), NOW)
    assert view["summary"]["total"] == 4
    b0 = view["targets"][0]
    for idx, row in enumerate(view["targets"][1:]):
        assert row["id"] == f"base-usde-extra-{idx}"
        assert row["rank"] == items[idx]["rank"]
        assert row["borrower_address"] == items[idx]["user"]
        assert row["chain_name"] == "Base"
        assert row["observation_only"] is False
        assert row["status"]["code"] == ("ELIGIBLE" if liquidatable else "WATCH")
        assert row["observation"]["block"] == base_pin["number"]
        assert row["observation"]["hash"] == base_pin["hash"]
        assert row["executor_address"] == items[idx]["deployedExecutor"]
        assert row["runner"] == b0["runner"]
        assert row["runner"]["label"] == "Base Morpho Runner"
        assert row["runner"]["reported_armed"] is True
        assert row["quote"]["available"] is True
        assert row["quote"]["gross_token_symbol"] == "USDC"
        assert row["quote"]["gross_token_amount"] == "23142.55"
        assert row["position"]["debt_symbol"] == "USDC"


@pytest.mark.parametrize("block", [26_230_500, "26230500"])
def test_ops_projects_m7_fork_rehearsal_offline(root, monkeypatch, block):
    monkeypatch.setattr("dashboard.ops.execution_view", lambda reader, now: {"verification": "UNAVAILABLE"})
    payload = base_rehearsal_payload(chainId=1, block=block, observations=[
        {"label": "deployGasUsed", "value": 987654},
        {"label": "ethMorphoYnethxMsethResult", "value": {"ownerMsethGainFormatted": "1.23456789", "gasUsed": "345678"}},
    ])
    build(root, sentinel({"targetM7_Morpho_ynETHx_msETH_Canary": {}}), m7_rehearsal=payload)
    reader = ArtifactReader(root)
    whales = build_ops(reader, NOW)["offensive"]["top_whales"]
    rehearsal = whales["morpho_rehearsal"]
    assert rehearsal["available"] is True
    assert {key: value for key, value in rehearsal.items() if key.startswith("m7_")} == {
        "m7_pin_block": 26_230_500, "m7_deploy_gas": "987654", "m7_gain_mseth": "1.23456789", "m7_gas": "345678",
    }
    assert reader.read_status["eth_morpho_ynethx_rehearsal"]["parser"] is True
    assert whales["targets"][0]["observation_only"] is False
    assert whales["targets"][0]["armed"] is True
    assert whales["targets"][0]["executable_now"] is False


@pytest.mark.parametrize("payload", [None, {}, base_rehearsal_payload(), base_rehearsal_payload(chainId=1, status="FAIL")])
def test_invalid_or_missing_m7_rehearsal_does_not_add_optional_keys(root, monkeypatch, payload):
    monkeypatch.setattr("dashboard.ops.execution_view", lambda reader, now: {"verification": "UNAVAILABLE"})
    expected = build(root, sentinel({}))["morpho_rehearsal"]
    build(root, sentinel({}), m7_rehearsal=payload)
    assert build_ops(ArtifactReader(root), NOW)["offensive"]["top_whales"]["morpho_rehearsal"] == expected


@pytest.mark.parametrize("block", [None, True, -1, 10**12 + 1, "²", "9" * 5000])
def test_m7_rehearsal_invalid_block_and_missing_observations_remain_unknown(root, block):
    payload = base_rehearsal_payload(chainId=1, block=block, observations=[None, {}, {"label": "ethMorphoYnethxMsethResult", "value": {}}])
    view = build(root, sentinel({}), m7_rehearsal=payload)["morpho_rehearsal"]
    assert view["available"] is True
    assert all(view[key] is None for key in ("m7_pin_block", "m7_deploy_gas", "m7_gain_mseth", "m7_gas"))
