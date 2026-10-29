import json
from datetime import datetime, timezone

import pytest

from dashboard.artifacts import ALLOWLIST, ArtifactReader
from dashboard.ops import build_ops

from conftest import get


NOW = 1_792_469_600
M7_EXECUTOR = "0xc06326bc6fbd4305cdab4de8e239b7b80feb2eb4"
M7_KEY = "targetM7_Morpho_ynETHx_msETH_Canary"
M2_EXECUTOR = "0x2d5bca1b846e89965544c7f03d09a25126803627"
M2_KEY = "targetM2_Morpho_reUSD_USDC"


def iso(value):
    return datetime.fromtimestamp(value, timezone.utc).isoformat()


def write_artifact(root, key, value):
    path = root / ALLOWLIST[key]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf8")


def arb_home_watch():
    from dashboard.targets import (ARB_BINDINGS, ARB_EXECUTOR, ARB_FLUID_42_BORROWER, ARB_FLUID_42_ID,
                                   ARB_SINGLES, ARB_UNIVERSAL_EXECUTOR, ARB_USDG_BINDINGS, _ARB_METADATA)
    targets = [{"rank": rank, "borrower": user, "marketId": market, "healthFactor": 1.01,
                "isLiquidatable": False, "bpsToLiquidation": 99.01, "debtStableUsd": 1000, "collateralValueUsd": 1100}
               for rank, (user, market, _) in ARB_BINDINGS.items()]
    targets.extend({"id": ident, "rank": metadata[0], "marketId": metadata[2], "executor": ARB_UNIVERSAL_EXECUTOR,
                    "borrower": ARB_FLUID_42_BORROWER if ident == ARB_FLUID_42_ID else None,
                    "healthFactor": 1.01, "isLiquidatable": False, "debtStableUsd": 1000, "collateralValueUsd": 1100}
                   for ident, metadata in _ARB_METADATA.items())
    targets.extend({"id": ARB_SINGLES[rank], "rank": rank, "borrower": user, "marketId": market,
                    "executor": ARB_UNIVERSAL_EXECUTOR, "healthFactor": 1.0001, "isLiquidatable": False,
                    "bpsToLiquidation": 1, "debtStableUsd": 2000, "collateralValueUsd": 2200}
                   for rank, (user, market, _) in ARB_USDG_BINDINGS.items())
    return {"chainId": 42161, "ok": True, "armed": True, "mode": "EXECUTE_IF_LIQUIDATABLE",
            "checkedAt": iso(NOW - 5), "deployedExecutor": ARB_EXECUTOR,
            "pin": {"number": 400000000, "hash": "0x" + "ab" * 32, "timestamp": NOW - 10}, "targets": targets}


def test_home_has_all_nine_arbitrum_rows_once_with_canonical_usdg_identity_and_unchanged_first_seven(root, m7_artifacts):
    from dashboard.targets import ARB_MORPHO, ARB_SINGLES, ARB_UNIVERSAL_EXECUTOR, ARB_USDG_BINDINGS, ARB_WATCH, build_curated_targets
    watch = arb_home_watch()
    write_artifact(root, ARB_WATCH, {**watch, "targets": watch["targets"][:7]})
    before = build_ops(ArtifactReader(root), NOW)["offensive"]["top_whales"]["targets"]
    write_artifact(root, ARB_WATCH, watch)
    after = build_ops(ArtifactReader(root), NOW)["offensive"]["top_whales"]["targets"]
    arb = [row for row in after if row.get("rank", "").startswith("#ARB")]
    assert [row["rank"] for row in arb] == [f"#ARB{i}" for i in range(1, 10)]
    assert [row for row in after if row["id"] not in ARB_SINGLES.values()] == before
    curated = {row["id"]: row for row in build_curated_targets(ArtifactReader(root), NOW)["targets"]}
    for rank, (borrower, market, pair) in ARB_USDG_BINDINGS.items():
        row = next(row for row in arb if row["rank"] == rank)
        assert row["id"] == ARB_SINGLES[rank] and row["market_id"] == market and row["borrower_address"] == borrower
        assert row["venue_address"] == ARB_MORPHO and row["executor"] == ARB_UNIVERSAL_EXECUTOR
        assert row["pair"] == pair == curated[row["id"]]["pair"]
        assert row["armed"] is None and curated[row["id"]]["status"]["code"] == "WATCH"
        assert row["executable_now"] is row["calldata_ready"] is row["liquidatable_now"] is False
        assert row["surplus_usd"] is row["repay_summary"] is row["seized_summary"] is None
        assert row["chain_id"] == 42161 and row["observation_block"] == watch["pin"]["number"]
        assert row["observation_utc"] == iso(NOW - 10)
        assert row["observation_block"] != m7_artifacts["pin"]["number"]
        assert "USDT" not in row["label"]


@pytest.mark.parametrize("mutation", ["rank", "borrower", "market", "id", "executor", "wrong_chain", "bad_pin", "stale", "unarmed", "check_only", "eligible"])
def test_home_arb8_arb9_fail_closed_on_spoofed_identity_or_readiness(root, m7_artifacts, mutation):
    from dashboard.targets import ARB_SINGLES, ARB_WATCH
    watch = arb_home_watch()
    for item in watch["targets"][7:]:
        # None of these unvalidated execution/quote claims may become readiness.
        item.update(executableNow=True, armed=True, readyExecuteUniversalCalldata="0x12345678",
                    liveQuote={"grossSurplusUsd": 9999, "grossSurplusUsdc": 9999, "repayUsdc": 100, "seizedReusd": 101})
        if mutation == "rank":
            item["rank"] = "#ARB1"
        elif mutation == "borrower":
            item["borrower"] = "0x" + "ff" * 20
        elif mutation == "market":
            item["marketId"] = "0x" + "ff" * 32
        elif mutation == "id":
            item["id"] = "arb-spoof"
        elif mutation == "executor":
            item["executor"] = watch["deployedExecutor"]  # Wrong legacy USDT executor.
        elif mutation == "eligible":
            item.update(healthFactor=0.99, isLiquidatable=True)
    if mutation == "wrong_chain":
        watch["chainId"] = 1
    elif mutation == "bad_pin":
        watch["pin"]["chainId"] = 1
    elif mutation == "stale":
        watch["checkedAt"] = iso(NOW - 4000)
    elif mutation == "unarmed":
        watch["armed"] = False
    elif mutation == "check_only":
        watch["mode"] = "CHECK_ONLY"
    write_artifact(root, ARB_WATCH, watch)
    rows = [row for row in build_ops(ArtifactReader(root), NOW)["offensive"]["top_whales"]["targets"]
            if row["id"] in ARB_SINGLES.values()]
    if mutation in {"rank", "borrower", "market", "id", "wrong_chain"}:
        assert rows == []
    else:
        assert len(rows) == 2
        for row in rows:
            assert row["armed"] is None
            assert row["executable_now"] is row["calldata_ready"] is False
            assert row["surplus_usd"] is row["repay_summary"] is row["seized_summary"] is None
            if mutation == "eligible":
                assert row["liquidatable_now"] is True
            elif mutation == "bad_pin":
                assert row["observation_block"] is row["observation_utc"] is None


def test_home_arb_usdg_duplicates_are_not_rendered_twice(root, m7_artifacts):
    from dashboard.targets import ARB_SINGLES, ARB_WATCH
    watch = arb_home_watch()
    watch["targets"][0] = dict(watch["targets"][7])
    write_artifact(root, ARB_WATCH, watch)
    rows = build_ops(ArtifactReader(root), NOW)["offensive"]["top_whales"]["targets"]
    for ident in ARB_SINGLES.values():
        assert sum(row["id"] == ident for row in rows) == 1


@pytest.mark.parametrize("armed,inactive,status,expected", [
    (False, True, "CLOSED", False), (True, True, "CLOSED", False),
    (True, False, "CLOSED", False), (True, True, "OPEN", False),
    (False, False, "OPEN", False), (True, False, "OPEN", True), (None, False, "UNKNOWN", False),
])
def test_home_unbound_closed_flags_and_raw_armed_do_not_establish_operational_state(root, m7_artifacts, armed, inactive, status, expected):
    keys = {"targetB14_Base_USDe_USDC_0x6efc": "#B14", "targetM34_Morpho_beraSTONE_WETH": "#M34",
            "targetE8_Euler_eUSDC2_eXAUt1": "#E8"}
    m7_artifacts["targets"] = {key: {"armed": armed, "inactive": inactive, "positionStatus": status,
        "healthFactor": None, "liquidatableNow": False, "executableNow": False,
        "readinessNote": "No outstanding debt at observed block"} for key in keys}
    write_artifact(root, "top_whale_triggers_status", m7_artifacts)
    rows = build_ops(ArtifactReader(root), NOW)["offensive"]["top_whales"]["targets"]
    assert {row["rank"] for row in rows} == set(keys.values())
    assert all(row["armed"] is None for row in rows)  # Neither raw flags nor prose are runner evidence.
    assert all(row["health_factor"] is None and row["executable_now"] is False for row in rows)


@pytest.mark.parametrize("mutation", [None, "wrong_user", "wrong_market", "wrong_pin", "missing_raw", "positive_raw",
                                     "failed_read", "malformed_proof", "failed_capture", "future_pin"])
def test_home_closure_precedence_requires_bound_raw_evidence_and_preserves_measured_hf(root, mutation):
    from dashboard.ops import build_top_whale_triggers
    from test_targets import CLOSURE_DEFINITIONS, NOW as observed_now, SENTINEL, closed_position_data

    data = closed_position_data()
    for item in data[SENTINEL]["targets"].values():
        # Deliberately contradictory readiness, including the Base row's own calldata key.
        item.update(liquidatableNow=True, healthFactor=0.9, readinessNote="Existing readiness reference",
                    readyExecuteCurveUnwindCalldata=item["readyExecuteUniversalCalldata"])
        if mutation == "wrong_user":
            item["user"] = "0x" + "ab" * 20
        elif mutation == "wrong_market":
            item["marketId"] = "0x" + "ab" * (20 if item["rank"] == "#E8" else 32)
        elif mutation == "wrong_pin":
            item["debtObservation"]["hash"] = "0x" + "ab" * 32
        elif mutation == "missing_raw":
            item.pop("debtRaw")
        elif mutation == "positive_raw":
            item["debtRaw"] = "1"
        elif mutation == "failed_read":
            item["debtReadStatus"] = "UNAVAILABLE"
        elif mutation == "malformed_proof":
            item["debtObservation"] = "not a pin"
        elif mutation == "future_pin":
            item["debtObservation"]["utc"] = iso(observed_now + 3600)
    if mutation == "future_pin":
        data[SENTINEL]["pin"]["utc"] = data[SENTINEL]["baseObservation"]["pin"]["utc"] = iso(observed_now + 3600)
    if mutation == "failed_capture":
        data[SENTINEL]["ok"] = False
        data[SENTINEL]["baseObservation"]["status"] = "INCOMPLETE"
    for key, value in data.items():
        write_artifact(root, key, value)
    reader = ArtifactReader(root)
    home = build_top_whale_triggers(reader.read_json(SENTINEL), reader.read_json("aave_v4_v3_morpho_liquidator_deploy"),
                                   observed_now, reader, SENTINEL, "aave_v4_v3_morpho_liquidator_deploy")
    rows = {row["id"]: row for row in home["targets"]}
    assert set(rows) == {definition[1] for definition in CLOSURE_DEFINITIONS}
    for row in rows.values():
        assert row["health_factor"] == "0.900000 HF"
        if mutation is None:
            assert row["armed"] is row["executable_now"] is row["liquidatable_now"] is row["calldata_ready"] is False
            assert row["surplus_usd"] is row["repay_summary"] is row["seized_summary"] is None
            assert row["readiness_note"] == "No outstanding debt at observed block"
        else:
            # Unbound inactive/CLOSED flags alone are not proof of debt closure.
            assert row["executable_now"] is False and row["calldata_ready"] is True
            assert row["liquidatable_now"] is (None if mutation in {"failed_capture", "future_pin"} else True)
            assert row["surplus_usd"] is None
            assert row["quote"]["estimate"]["gross_token_amount"] == "5"
            assert "Configured implementation only" in row["readiness_note"]


@pytest.fixture
def m7_artifacts(root, monkeypatch):
    monkeypatch.setattr("dashboard.ops.execution_view", lambda reader, now: {"verification": "UNAVAILABLE"})
    target = {
        "rank": "#M7",
        "user": "0x14bcd9da052cdc6fe0b9446d5a616d5b7b4d4550",
        "observationOnly": False,
        "armed": True,
        "executor": M7_EXECUTOR,
        "executableNow": False,
        "liquidatableNow": False,
        "hfUnderwaterNow": True,
        "healthFactor": 0.999,
        "bpsToLiquidation": -10.01,
        "collateralUsd": 100_000,
        "debtUsd": 95_000,
        "ynEthxBufferWeth": 0,
        "liveQuote": {
            "collateralSeizedFormatted": "11.34 ynETHx (idle refill) / 50.00 ynETHx (full)",
            "debtOutcomeFormatted": "+1.8939 msETH (idle) / +7.5315 msETH (full)",
            "estimatedProfitUsd": 4431.62,
        },
    }
    state = {
        "schema": "top-whale-triggers-status/v1",
        "generatedAt": iso(NOW - 5),
        "pin": {"chainId": 1, "number": 26_231_200, "hash": "0x" + "11" * 32, "utc": iso(NOW - 10)},
        "targets": {M7_KEY: target},
    }
    write_artifact(root, "top_whale_triggers_status", state)
    write_artifact(root, "eth_morpho_ynethx_rehearsal", {
        "schema": "fork-poc/v1", "status": "PASS", "chainId": 1,
        "generatedAt": iso(NOW - 60), "block": "26231180",
        "observations": [
            {"label": "deployGasUsed", "value": 1_234_567},
            {"label": "ethMorphoYnethxMsethResult", "value": {"ownerMsethGainFormatted": "1.8939", "gasUsed": "345678"}},
        ],
    })
    return state


@pytest.mark.parametrize("ready", [False, True])
def test_m7_configured_executor_and_buffer_calldata_do_not_prove_execution(root, m7_artifacts, ready):
    target = m7_artifacts["targets"][M7_KEY]
    target.update(executableNow=ready, liquidatableNow=ready)
    if ready:
        target["readyExecuteVaultRedeemCalldata"] = "0x12345678" + "00" * 384
    write_artifact(root, "top_whale_triggers_status", m7_artifacts)
    row = build_ops(ArtifactReader(root), NOW)["offensive"]["top_whales"]["targets"][0]
    assert row["rank"] == "#M7"
    assert row["armed"] is None
    assert row["observation_only"] is False
    assert row["executor"] == M7_EXECUTOR
    assert row["executable_now"] is False and row["liquidatable_now"] is row["calldata_ready"] is ready
    assert row["max_liq_profit_usd"] is row["surplus_usd"] is None
    assert row["quote"]["estimate"]["gross_usd"] == "4431.62"
    assert row["seized_summary"] == target["liveQuote"]["collateralSeizedFormatted"]
    assert row["repay_summary"] == target["liveQuote"]["debtOutcomeFormatted"]


@pytest.mark.parametrize("profit", [None, True, "4431.62", -1, float("inf")])
def test_m7_invalid_profit_is_not_projected_as_positive(root, m7_artifacts, profit):
    m7_artifacts["targets"][M7_KEY]["liveQuote"]["estimatedProfitUsd"] = profit
    write_artifact(root, "top_whale_triggers_status", m7_artifacts)
    row = build_ops(ArtifactReader(root), NOW)["offensive"]["top_whales"]["targets"][0]
    assert row["max_liq_profit_usd"] is None
    assert row["surplus_usd"] is None


@pytest.mark.parametrize("calldata", [None, 123, "0x", "0x12345678" + "00" * 383])
def test_m7_malformed_calldata_is_not_reported_as_ready(root, m7_artifacts, calldata):
    m7_artifacts["targets"][M7_KEY]["readyExecuteVaultRedeemCalldata"] = calldata
    write_artifact(root, "top_whale_triggers_status", m7_artifacts)
    row = build_ops(ArtifactReader(root), NOW)["offensive"]["top_whales"]["targets"][0]
    assert row["armed"] is None
    assert row["calldata_ready"] is False


def test_m7_rehearsal_records_deployed_executor_and_both_conditional_proofs(root, m7_artifacts):
    whales = build_ops(ArtifactReader(root), NOW)["offensive"]["top_whales"]
    rehearsal = whales["morpho_fork_rehearsals"][0]
    assert rehearsal["rank"] == "#M7"
    assert rehearsal["executor"] == M7_EXECUTOR
    assert rehearsal["deployed_block"] == 26_231_193
    assert rehearsal["deployment_tx"] == "0x8589450c5988e3eb12e735b65d5a5841d7d127d30377f28a28e1641f66178e11"
    assert "11.34 ynETHx -> +1.8939 msETH (12.67 WETH idle refill)." in rehearsal["notes"]
    assert "50.00 ynETHx -> +7.5315 msETH (60 WETH full refill)." in rehearsal["notes"]
    assert whales["morpho_rehearsal"]["m7_gain_mseth"] == "1.8939"


def test_m7_dashboard_shows_deployment_reference_and_unearned_estimate(client, m7_artifacts):
    response = get(client, "/")
    assert response.status_code == 200
    html = response.get_data(as_text=True)
    assert "MorphoVaultRedeemUnwindRoundTrip deployment reference" in html
    assert M7_EXECUTOR in html
    assert "mainnet deployment block 26231193" in html
    assert "11.34 ynETHx" in html and "+1.8939 msETH" in html and "12.67 WETH idle refill" in html
    assert "50.00 ynETHx" in html and "+7.5315 msETH" in html and "60 WETH full refill" in html
    assert "4431.62 USD" in html and "stored estimate, not earned" in html
    assert "#M7 ynETHx / msETH · staged" not in html


@pytest.mark.parametrize("calldata,ready", [(None, False), ("0x", False), (123, False), ("0x12345678" + "00" * 512, True)])
def test_m2_ops_separates_configuration_curve_calldata_and_unproven_estimate(root, m7_artifacts, calldata, ready):
    m7_artifacts["targets"][M2_KEY] = {
        "user": "0xaa34d20be3f9623ccf5bff53ef4dfa765c3f5dd5", "armed": True,
        "liquidatableNow": ready, "executableNow": ready, "readyExecuteCurveUnwindCalldata": calldata,
        "liveQuote": {"repayUsdc": 97450, "seizedReusd": 100000, "grossSurplusUsdc": 2111.52},
    }
    write_artifact(root, "top_whale_triggers_status", m7_artifacts)
    row = next(r for r in build_ops(ArtifactReader(root), NOW)["offensive"]["top_whales"]["targets"] if r["rank"] == "#M2")
    assert row["armed"] is None
    assert row["observation_only"] is False
    assert row["executor"] == M2_EXECUTOR
    assert row["calldata_ready"] is ready and row["executable_now"] is False
    assert row["surplus_usd"] is None and row["quote"]["estimate"]["gross_token_amount"] == "2111.52"


def test_m2_and_m7_rehearsal_cards_keep_separate_deployed_executors(root, client, m7_artifacts):
    write_artifact(root, "eth_morpho_reusd_rehearsal", {
        "schema": "fork-poc/v1", "status": "PASS", "chainId": 1, "generatedAt": iso(NOW - 60), "block": "26230276",
        "observations": [
            {"label": "deployGasUsed", "value": "948557"},
            {"label": "ethMorphoReusdUsdcResult", "value": {"ownerUsdcGainFormatted": "2111.524282", "gasUsed": "365773"}},
        ],
    })
    whales = build_ops(ArtifactReader(root), NOW)["offensive"]["top_whales"]
    cards = {card["rank"]: card for card in whales["morpho_fork_rehearsals"]}
    assert cards["#M2"]["executor"] == M2_EXECUTOR
    assert cards["#M2"]["deployed_block"] == 26231360
    assert cards["#M2"]["deployment_tx"] == "0xe0c22fc05b42a527deae2abef2e4f76000be39211c9051c198ca5a9f4412cb06"
    assert cards["#M7"]["executor"] == M7_EXECUTOR
    response = get(client, "/")
    assert response.status_code == 200
    html = response.get_data(as_text=True)
    assert "#M2 reUSD / USDC · MorphoLiquidateUnwindRoundTrip deployment reference" in html
    assert f"Executor {M2_EXECUTOR} &middot; mainnet deployment block 26231360" in html
    assert f"Executor {M7_EXECUTOR} &middot; mainnet deployment block 26231193" in html
    assert "Deployment and local-fork references are separate from runner liveness" in html
    assert "#M2 reUSD / USDC · staged" not in html


def test_b7_dashboard_removes_static_arming_claims_without_hiding_estimate(root, client, m7_artifacts):
    write_artifact(root, "base_morpho_usde_rehearsal", {
        "schema": "fork-poc/v1", "status": "PASS", "chainId": 8453,
        "generatedAt": iso(NOW - 60), "block": "52800100", "observations": [
            {"label": "baseUsdeRehearsalResults", "value": [
                {"rank": "#B0", "ownerUsdcGainFormatted": "10.00", "gasUsed": "300000"},
            ]},
        ],
    })
    m7_artifacts["targets"]["extra_Base_USDe_Whales"] = [{
        "rank": "#B7", "user": "0x108b853407284e77656c569677c82e8fed581299",
        "marketId": "0x1a3e69d0109bb1be42b80e11034bb6ee98fc466721f26845dc83b2aa8d979137",
        "healthFactor": 1.00004, "bpsToLiquidation": 0.4, "passiveHoursToCrossing": 5.38,
        "armed": True, "liquidatableNow": False, "healthIsEstimate": False,
        "liveQuote": {"repayUsdc": 4599.32, "seizedUsde": 4420, "uniV3OutUsdc": 4719.67, "grossSurplusUsdc": 120.36},
    }]
    write_artifact(root, "top_whale_triggers_status", m7_artifacts)
    row = next(r for r in build_ops(ArtifactReader(root), NOW)["offensive"]["top_whales"]["targets"] if r["rank"] == "#B7")
    assert row["armed"] is None and row["observation_only"] is False
    assert row["executor"] == "0x88bf…4f32"
    assert row["pair"] == "yoUSD / USDC (Base)"
    assert row["seized_summary"] == "4420 yoUSD"
    html = get(client, "/").get_data(as_text=True)
    assert "Historical Base setup and fork gains" in html
    assert "#B7 yoUSD / USDC ARMED via redeem" not in html
    assert "stored estimate, not earned" in html
    assert "Configured implementation" in html
    assert "33 armed plans" not in html
    assert "6 Base USDe / USDC whale plans" not in html


def test_ops_reads_pt_and_yousd_rehearsals_with_separate_blocks_units_and_rank_binding(root, m7_artifacts):
    write_artifact(root, "eth_morpho_pt_usde_rehearsal", {
        "schema": "fork-poc/v1", "status": "PASS", "chainId": 1, "generatedAt": iso(NOW - 60), "block": "26231521",
        "observations": [
            {"label": "deployGasUsed", "value": "1150553"},
            {"label": "ethMorphoPtUsdeDaiResult", "value": {"rank": "#M9", "ownerDaiGainFormatted": "338.436261235571976905", "gasUsed": "513615"}},
            {"label": "ethMorphoPtUsdeDaiResult", "value": {"rank": "#M8", "ownerDaiGainFormatted": "882.709344115850392567", "gasUsed": "513616"}},
            {"label": "ethMorphoPtUsdeDaiResult", "value": {"rank": "#M7", "ownerDaiGainFormatted": "99999", "gasUsed": "1"}},
        ],
    })
    write_artifact(root, "base_morpho_yousd_rehearsal", {
        "schema": "fork-poc/v1", "status": "PASS", "chainId": 8453, "generatedAt": iso(NOW - 50), "block": "52841837",
        "observations": [{"label": "baseYoUsdUsdcResult", "value": {"rank": "#B7", "ownerUsdcGainFormatted": "113.727665", "gasUsed": "296233"}}],
    })
    reader = ArtifactReader(root)
    whales = build_ops(reader, NOW)["offensive"]["top_whales"]
    morpho = whales["morpho_rehearsal"]
    assert {key: value for key, value in morpho.items() if key.startswith(("m8_", "m9_"))} == {
        "m8_pin_block": 26231521, "m8_deploy_gas": "1150553", "m8_gain_dai": "882.709344115850392567", "m8_gas": "513616",
        "m9_gain_dai": "338.436261235571976905", "m9_gas": "513615",
    }
    assert morpho["m7_gain_mseth"] == "1.8939"
    base = whales["base_rehearsal"]
    assert base["available"] is True
    assert {key: value for key, value in base.items() if key.startswith("b7_")} == {
        "b7_pin_block": 52841837, "b7_gain_usdc": "113.727665", "b7_gas": "296233",
    }
    assert base["pin_block"] is None and base["b0_gain_usdc"] is base["b1_gain_usdc"] is base["b2_gain_usdc"] is None
    assert reader.read_status["eth_morpho_pt_usde_rehearsal"]["parser"] is True
    assert reader.read_status["base_morpho_yousd_rehearsal"]["parser"] is True
    assert {card["rank"] for card in whales["morpho_fork_rehearsals"]} == {"#M7"}  # PT deployment was fork-only.
