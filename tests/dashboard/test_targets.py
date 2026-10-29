import copy
import importlib
import json
import socket
import subprocess
from datetime import datetime, timezone

import pytest

from dashboard import ops
from dashboard.artifacts import ALLOWLIST, ArtifactReader
from dashboard.targets import BASE_EXECUTOR, M1_EXECUTOR, M2_EXECUTOR, M32_EXECUTOR, M32_CONTRACT_NAME, M32_RUNTIME_KECCAK256, M32_READINESS_NOTE, M7_EXECUTOR, M1_MARKET, M1_USER, MORPHO, POOL, READS, SENTINEL, V3_USERS, V3_WATCH, V4_WATCH, build_curated_targets, build_targets
from dashboard.targets import M32_REFERENCE, M32_VALUATION, build_inventory


NOW = 1_792_400_000
UNIFIED = "0x" + "11" * 20
DEDICATED = "0x" + "22" * 20
M2_USER = "0xaa34d20be3f9623ccf5bff53ef4dfa765c3f5dd5"
M2_MARKET = "0x4565ac05d38b19374ccbb04c17cca60ca9353cd41824f0803d0fc7704f60eaed"
SPOKE_A = "0xba1b3d55d249692b669a164024a838309b7508af"
SPOKE_C = "0xbf10bdfe177de0336afd7fccf80a904e15386219"
V3_A = "0x7231eaeea108e3ea05c993cbee21f23ddd7a44bf"
V3_B = "0x1a557354c5b8d7df38ea914209e416dc7065b158"
C_USERS = ["0x40534e513df8277870b81e97b5107b3f39de4f15", "0xafbf278e06d2269aba2a4898afbab2ecb2584924", V3_B,
           "0xfcc83b338ba980f501e51110c7f51791a21d4a28", V3_A, "0xba482cae263659b3226c919b9229a27c76217d7d",
           "0xc99f25ac2404f6cf35bd6fe5ccb7f88f0625a8be", "0x4b9859df9ba9b428328c05eea63b51c3b36fd2bb"]
V4_IDS = ["spokeA-candidate1-usde-usdc", "spokeC-c1-weeth-weth-0x4053", "spokeC-c2-weeth-weth-0xafbf",
          "spokeC-candidate3-weeth-weth", "spokeC-c4-weeth-weth-0xfcc8", "spokeC-candidate4-weeth-weth",
          "spokeC-c6-weeth-weth-0xba48", "spokeC-c7-weeth-weth-0xc99f", "spokeC-c8-weeth-weth-0x4b98"]
CALLDATA = "0x834cbf54" + "00" * (17 * 32)
M2_CALLDATA = "0x12345678" + "00" * 512
LIVE_RUNNER_LABELS = {"Dedicated Aave V4", "Unified Aave V3", "Unified Morpho M1"}


def iso(seconds):
    return datetime.fromtimestamp(seconds, timezone.utc).isoformat()


def pin(chain=1, block=1000, age=20, digit="a"):
    return {"chainId": chain, "number": block, "hash": "0x" + digit * 64, "timestamp": NOW - age, "utc": iso(NOW - age)}


def fixtures():
    def weth(user, venue="pool"):
        return {"user": user, venue: POOL if venue == "pool" else SPOKE_C, "healthFactor": 1.01, "liquidatableNow": False,
                "bpsToLiquidation": 99.0099, "collateralUsd": 250000, "debtUsd": 200000,
                "liveQuote": {"repayWeth": 100, "seizedWeEth": 101, "curveOutWeth": 102, "grossSurplusWeth": 2, "grossSurplusUsd": 4800},
                "readyExecuteMorphoCalldata": CALLDATA}
    targets = {
        "target1_AaveV4_USDe_USDC": {"user": "0x1cb432f80416f07db4420b8c20447924a0658894", "spoke": SPOKE_A,
            "healthFactor": 1.01, "liquidatableNow": False, "bpsToLiquidation": 99.0099, "passiveHoursToCrossing": 12.3, "hoursUntil24hHeartbeat": 2,
            "liveQuote": {"repayUsdc": 1000, "seizedUsde": 1010, "uniV3OutUsdc": 1005, "grossSurplusUsdc": 5}, "readyExecuteMorphoCalldata": CALLDATA},
        "target2A_AaveV3_weETH_WETH_0x7231": weth(V3_A), "target2B_AaveV3_weETH_WETH_0x1A55": weth(V3_B),
        "additional_AaveV3_weETH_WETH": [weth(user) for user in sorted(V3_USERS - {V3_A, V3_B})],
        "spokeC_AaveV4_weETH_WETH": [weth(user, "spoke") for user in C_USERS],
        "targetM1_Morpho_USDe_DAI": {"user": M1_USER, "marketId": M1_MARKET, "deployedExecutor": M1_EXECUTOR,
            "healthFactor": .999, "liquidatableNow": True, "bpsToLiquidation": -10.01, "debtUsd": 200000, "collateralUsd": 240000,
            "borrowAprPct": 8.5, "passiveHoursToCrossing": 0, "readyExecuteMorphoBlueCalldata": CALLDATA,
            "liveQuote": {"repayDai": 103943, "seizedUsde": 108500, "uniV3OutDai": 108000, "grossSurplusDai": 4057, "grossSurplusUsd": 4057}},
        "targetM2_Morpho_reUSD_USDC": {"user": M2_USER, "marketId": M2_MARKET, "rank": "#M2", "pair": "reUSD / USDC",
            "healthFactor": .999, "storedHealthFactor": 1.01, "liquidatableNow": True, "bpsToLiquidation": -10.01,
            "debtUsd": 200000, "collateralUsd": 240000, "borrowAprPct": 8.5, "passiveHoursToCrossing": 0,
            "observationOnly": False, "armed": True, "executableNow": True, "executor": M2_EXECUTOR,
            "deployedExecutor": M2_EXECUTOR, "readyExecuteCurveUnwindCalldata": M2_CALLDATA,
            "liveQuote": {"repayUsdc": 97450, "seizedReusd": 100000, "curveOutUsdc": 99500, "grossSurplusUsdc": 2050, "grossSurplusUsd": 2050}},
        "base_Morpho_Whales": [{"user": user, "marketId": ops.BASE_USDE_MARKET if i < 2 else "0x" + "b" * 64, "pair": "USDe / USDC (Base)" if i < 2 else "mGLO / USDC (Base)",
            "chainId": 8453, "observationStatus": "COMPLETE", "healthFactor": .999, "bpsToLiquidation": -10.01,
            "debtUsdc": 12000, "collateralValueUsdc": 14000, "liquidatableNow": True,
            "readyExecuteMorphoCalldata": CALLDATA, "grossBonusUsd": 99999} for i, user in enumerate([
                "0xb4fb31e7b1471a8e52dd1e962a281a732ead59c1", "0x7bee8d37fba61a6251a08b957d502c56e2a50fab", "0x2e3dc205e5687e02eb4bea4f657c9572a83490e5"])],
        "target3_Morpho_PAXG_USDC": {"marketId": "0x" + "c" * 64, "availableUsdc": 12345, "liquidatableNow": True, "grossBonusUsd": 1000000},
    }
    for value in targets.values():
        for item in value if isinstance(value, list) else [value]:
            if item.get("liveQuote"):
                item["liveQuote"].update(provenance="ONCHAIN_MEASURED", observationBlock=1000,
                                         observationHash=pin()["hash"], observationUtc=pin()["utc"])
    watch_targets = [{"id": "spokeA-candidate1-usde-usdc", "borrower": targets["target1_AaveV4_USDe_USDC"]["user"], "spoke": SPOKE_A}]
    watch_targets += [{"id": V4_IDS[i + 1], "borrower": u, "spoke": SPOKE_C} for i, u in enumerate(C_USERS)]
    for i, target in enumerate(watch_targets):
        target.update(healthFactorRaw="990000000000000000" if i < 2 else "1010000000000000000",
                      healthFactorFormatted="0.990000000" if i < 2 else "1.010000000", bpsToLiquidation="-100.000" if i < 2 else "100.000",
                      isLiquidatableBothProviders=i < 2)
    return {
        SENTINEL: {"schema": "top-whale-triggers-status/v1", "generatedAt": iso(NOW - 10), "pin": pin(), "targets": targets,
                   "baseObservation": {"status": "COMPLETE", "pin": pin(8453, 2000, 15, "b")}},
        "aave_v4_v3_morpho_liquidator_deploy": {"ok": True, "contractAddress": UNIFIED, "deployedAt": iso(NOW - 100), "txHash": "0x" + "1" * 64},
        "aave_v4_flash_liquidator_deploy": {"status": "DEPLOYED_AND_TWO_PROVIDER_VERIFIED", "contractAddress": DEDICATED,
            "recordedAt": iso(NOW - 100), "bytecodeVerification": {"twoProvidersAgreed": True}},
        V4_WATCH: {"ok": True, "armed": True, "mode": "EXECUTE_IF_LIQUIDATABLE", "checkedAt": iso(NOW - 5), "blockNumber": 1001,
                   "pin": pin(block=1001, age=5, digit="d"), "deployedExecutor": DEDICATED, "targets": watch_targets},
        V3_WATCH: {"ok": True, "armed": True, "mode": "EXECUTE_IF_LIQUIDATABLE", "checkedAt": iso(NOW - 5), "partition": "V3_ONLY",
                   "pin": pin(block=1001, age=5, digit="d"), "liquidatorAddress": UNIFIED, "morphoExecution": "M1_USDE_DAI_ARMED; PAXG_DISABLED"},
    }


def producer_fixtures():
    data = fixtures()
    for key in (V3_WATCH, V4_WATCH):
        # Exact executor-pinned-rpc producer shape: no chainId or utc.
        data[key]["pin"] = {"number": 1001, "hash": "0x" + "d" * 64, "parentHash": "0x" + "a" * 64,
                            "stateRoot": "0x" + "e" * 64, "timestamp": NOW - 15, "baseFeePerGas": "100000000"}
    return data


def put(root, key, data):
    path = root / ALLOWLIST[key]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data), encoding="utf8")


def build(root, data=None, reader=None):
    for key, value in (fixtures() if data is None else data).items():
        put(root, key, value)
    return build_curated_targets(reader or ArtifactReader(root), NOW)


def rows(view):
    return {row["id"]: row for row in view["targets"]}


CLOSURE_DEFINITIONS = (
    ("targetB14_Base_USDe_USDC_0x6efc", "base-usde-usdc-b14", "#B14", 8453,
     "0x6efc48b8b6222924fa6ea95d174af5518b761177", ops.BASE_USDE_MARKET, "MORPHO_BORROW_SHARES", "USDe / USDC (Base)"),
    ("targetM34_Morpho_beraSTONE_WETH", "morpho-berastone-weth-m34", "#M34", 1,
     "0x52426c8065974821e99fa3c9aad73e47b9f1d6fc", "0xf78b7d3a62437f78097745a5e3117a50c56a02ec5f072cba8d988a129c6d4fb6", "MORPHO_BORROW_SHARES", "beraSTONE / WETH"),
    ("targetE8_Euler_eUSDC2_eXAUt1", "euler-eusdc2-exaut1-e8", "#E8", 1,
     "0x3a8306fb4fa0811a86955f4421600e3b500a9e44", "0x797dd80692c3b2dadabce8e30c07fde5307d48a9", "EULER_DEBT_ASSETS", "eUSDC-2 / eXAUt-1"),
)


def closed_position_data():
    data = fixtures()
    data[SENTINEL]["targets"] = {}
    for key, _, rank, chain, user, market, kind, pair in CLOSURE_DEFINITIONS:
        observed = data[SENTINEL]["baseObservation"]["pin"] if chain == 8453 else data[SENTINEL]["pin"]
        data[SENTINEL]["targets"][key] = {
            "rank": rank, "user": user, "marketId": market, "chainId": chain, "pair": pair,
            "healthFactor": None, "bpsToLiquidation": None, "debtUsd": 0, "collateralUsd": 10,
            "positionStatus": "CLOSED", "inactive": True, "debtRaw": "0", "debtReadStatus": "COMPLETE",
            "debtReadKind": kind, "debtObservation": copy.deepcopy(observed), "observationStatus": "COMPLETE",
            # Deliberately retained old readiness must lose to validated raw-zero evidence.
            "armed": True, "executableNow": True, "liquidatableNow": False,
            "readyExecuteUniversalCalldata": M2_CALLDATA,
            "liveQuote": {"repayUsdc": 100, "seizedReusd": 101, "curveOutUsdc": 105, "grossSurplusUsdc": 5, "grossSurplusUsd": 5},
        }
    return data


def test_closed_positions_preserve_identity_hf_and_suppress_stale_readiness(root):
    data = closed_position_data()
    for view in (build(root, data), build_targets(ArtifactReader(root), NOW)):
        assert view["summary"]["total"] == 3
        for _, ident, rank, _, user, _, _, _ in CLOSURE_DEFINITIONS:
            row = rows(view)[ident]
            assert row["rank"] == rank and row["borrower_address"] == user
            assert row["status"]["code"] == "INACTIVE"
            assert row["inactive"] is True and row["position_status"] == "CLOSED"
            assert row["health_factor"] is None and row["bps_to_liq"] is None
            assert row["armed"] is row["executable_now"] is row["liquidatable_now"] is row["calldata_ready"] is False
            assert row["runner"]["reported_armed"] is False
            assert row["quote"]["available"] is False and row["quote"]["gross_token_amount"] is None
            assert row["surplus_usd"] is None
            assert row["readiness_note"] == "No outstanding debt at observed block"
            assert row["readiness_note"] in row["blockers"]


@pytest.mark.parametrize("mutation", ["missing_raw", "positive_dust", "failed_read", "missing_pin", "wrong_pin", "wrong_chain", "wrong_user", "wrong_market", "wrong_kind", "incomplete", "decimal_zero", "bool_zero", "stale"])
def test_closed_positions_require_raw_zero_identity_and_current_matching_pin(root, mutation):
    data = closed_position_data()
    for row in data[SENTINEL]["targets"].values():
        if mutation == "missing_raw":
            row.pop("debtRaw")
        elif mutation == "positive_dust":
            row.update(debtRaw="1", positionStatus="OPEN", inactive=False)
        elif mutation == "failed_read":
            row["debtReadStatus"] = "UNAVAILABLE"
        elif mutation == "missing_pin":
            row.pop("debtObservation")
        elif mutation == "wrong_pin":
            row["debtObservation"]["hash"] = "0x" + "f" * 64
        elif mutation == "wrong_chain":
            row["debtObservation"]["chainId"] = 42161
        elif mutation == "wrong_user":
            row["user"] = V3_A
        elif mutation == "wrong_market":
            row["marketId"] = "0x" + "f" * (40 if row["rank"] == "#E8" else 64)
        elif mutation == "wrong_kind":
            row["debtReadKind"] = "MAX_REPAY"
        elif mutation == "incomplete":
            row["observationStatus"] = "INCOMPLETE"
        elif mutation == "decimal_zero":
            row["debtRaw"] = "0.0"
        elif mutation == "bool_zero":
            row["debtRaw"] = False
    for view in (build(root, data), build_targets(ArtifactReader(root), NOW + (4000 if mutation == "stale" else 0))):
        # Curated view above uses NOW; evaluate stale explicitly as well.
        if mutation == "stale":
            view = build_curated_targets(ArtifactReader(root), NOW + 4000) if view["schema"] == "dashboard-targets/v1" else view
        assert len(view["targets"]) == 3
        assert all(row["status"]["code"] == ("STALE" if mutation == "stale" else "UNKNOWN") for row in view["targets"])


def test_closed_positions_reopen_on_positive_raw_debt_without_losing_ids(root):
    data = closed_position_data()
    before = rows(build(root, data))
    for row in data[SENTINEL]["targets"].values():
        row.update(positionStatus="OPEN", inactive=False, debtRaw="1", debtUsd=0, healthFactor=1.01,
                   bpsToLiquidation=99.0099, armed=True, executableNow=False, liquidatableNow=False)
    for view in (build(root, data), build_targets(ArtifactReader(root), NOW)):
        assert set(rows(view)) == set(before)
        for row in view["targets"]:
            assert row["status"]["code"] == "WATCH"
            assert not row.get("inactive")
            assert row["health_factor"] is not None and row["position"]["debt_amount"] == "0"
            assert "No outstanding debt" not in row["readiness_note"]


def test_home_adapter_keeps_closed_identities_without_profit_or_fabricated_health(root):
    data = closed_position_data()
    build(root, data)
    reader = ArtifactReader(root)
    home = ops.build_top_whale_triggers(reader.read_json(SENTINEL), reader.read_json("aave_v4_v3_morpho_liquidator_deploy"), NOW,
                                      reader, SENTINEL, "aave_v4_v3_morpho_liquidator_deploy")
    for _, ident, *_ in CLOSURE_DEFINITIONS:
        row = rows(home)[ident]
        assert row["health_factor"] is None and row["surplus_usd"] is None
        assert row["armed"] is False and row["repay_summary"] is row["seized_summary"] is None
        assert row["executable_now"] is row["liquidatable_now"] is row["calldata_ready"] is False
        assert row["readiness_note"] == "No outstanding debt at observed block"


@pytest.mark.parametrize("stage", ["watch", "underwater", "stale", "invalid_calldata"])
def test_a4_curated_and_shortlist_preserve_identity_and_reported_unified_runner(root, stage):
    data = fixtures()
    underwater = stage in {"underwater", "invalid_calldata"}
    executor = "0xf09a01a6c23b936d5a51abce87a6ec8442a44262"
    data["aave_v4_v3_morpho_liquidator_deploy"]["contractAddress"] = executor
    data[V3_WATCH]["liquidatorAddress"] = executor
    item = {
        "rank": "#A4", "user": "0xa4298746f662119a4df27fa57f20e18e44ccb767",
        "spoke": "0x94e7a5dcbe816e498b89ab752661904e2f56c485", "pair": "WETH / USDC (Same-Asset)",
        "observationOnly": False, "armed": True, "executableNow": underwater, "executor": executor, "deployedExecutor": executor,
        "readinessNote": "ARMED on Unified 0xf09a...4262 (same-asset WETH/WETH Reserve 0, ~0.0337 WETH / ~$82.64 bonus, 0.01 WETH min profit).",
        "healthFactor": .999 if underwater else 1.00436, "liquidatableNow": underwater,
        "bpsToLiquidation": -10.01 if underwater else 43.4107, "collateralUsd": 12345.67, "debtUsd": 9876.54,
        "liveQuote": {"repayUsdc": 1741.77, "seizedUsde": 1812.31, "uniV3OutUsdc": 1812.31, "grossSurplusUsdc": 70.54},
        "readyExecuteMorphoCalldata": CALLDATA,
    }
    if stage == "invalid_calldata":
        item["readyExecuteMorphoCalldata"] = "0x1234"
    item["liveQuote"].update(provenance="ONCHAIN_MEASURED", observationBlock=1000,
                             observationHash=pin()["hash"], observationUtc=pin()["utc"])
    data[SENTINEL]["targets"]["targetA4_AaveV4_SameAsset_0xa429"] = item
    if stage == "stale":
        data[SENTINEL]["generatedAt"] = iso(NOW - 4000)
        data[SENTINEL]["pin"] = pin(age=4010)
        item["liveQuote"]["observationUtc"] = iso(NOW - 4010)
    curated = build(root, data)
    assert curated["summary"]["total"] == 25
    assert curated["summary"]["observation_only"] == 2
    shortlist = build_targets(ArtifactReader(root), NOW)
    for view in (curated, shortlist):
        row = rows(view)["target-a4-aave-v4-same-asset-0xa429"]
        assert row["rank"] == "#A4" and row["pair"] == "WETH / USDC (Same-Asset)"
        assert row["protocol"] == "Aave V4" and row["chain_name"] == "Ethereum" and row["chain_id"] == 1
        assert row["borrower_address"] == item["user"] and row["venue_address"] == item["spoke"]
        assert row["status"]["code"] == ("STALE" if stage == "stale" else "ELIGIBLE" if underwater else "WATCH")
        assert row["observation_only"] is False and row["armed"] is None
        assert row["executable_now"] is False
        assert row["calldata_ready"] is (stage != "invalid_calldata")
        assert row["executor_address"] == executor and row["executor"] == "0xf09a…4262"
        assert row["runner"]["label"] == "Unified Aave V4 A4" and row["runner"]["reported_armed"] is True
        assert row["runner"]["source"] == V3_WATCH  # Never assigned to the nine-plan dedicated V4 runner.
        assert row["liquidatable_now"] is (None if stage == "stale" else underwater)
        assert row["observation"]["block"] == 1000 and row["observation"]["source"] == SENTINEL
        assert row["observation"]["hash"] == data[SENTINEL]["pin"]["hash"]
        assert row["quote"]["source"] == SENTINEL and row["quote"]["block"] == 1000
        assert row["quote"]["freshness"] == ("STALE" if stage == "stale" else "FRESH")
        assert row["quote"]["available"] is (stage != "stale")
        assert (row["quote"].get("estimate") or row["quote"])["gross_token_amount"] == "70.54"
        assert row["quote"]["gross_token_symbol"] == row["quote"]["repay_symbol"] == row["quote"]["seize_symbol"] == "USDC"
        assert row["quote"]["repay_amount"] == "1741.77" and row["quote"]["seize_amount"] == "1812.31"
        assert row["quote"]["gross_usd"] is None and row["gross_usd_numeric"] is None
        assert row["surplus_usd"] == (None if stage == "stale" else "70.54 USDC (gross, pre-gas)")
        assert row["seized_summary"] == "1812.31 USDC"
        assert "Configured implementation only" in row["readiness_note"]
    reader = ArtifactReader(root)
    legacy = ops.build_top_whale_triggers(reader.read_json(SENTINEL),
        reader.read_json("aave_v4_v3_morpho_liquidator_deploy"), NOW, reader,
        SENTINEL, "aave_v4_v3_morpho_liquidator_deploy")
    a4 = rows(legacy)["target-a4-aave-v4-same-asset-0xa429"]
    assert a4["executor"] == "0xf09a…4262"
    assert a4["observation_only"] is False and a4["armed"] is None
    assert a4["calldata_ready"] is (stage != "invalid_calldata") and a4["executable_now"] is False


@pytest.mark.parametrize("change", ["borrower", "spoke", "executor", "partition", "stale_runner"])
def test_a4_runner_requires_exact_identity_matching_executor_partition_and_fresh_watch(root, change):
    data = fixtures()
    item = {"rank": "#A4", "user": "0xa4298746f662119a4df27fa57f20e18e44ccb767",
            "spoke": "0x94e7a5dcbe816e498b89ab752661904e2f56c485", "pair": "WETH / USDC (Same-Asset)",
            "healthFactor": .999, "liquidatableNow": True, "armed": True, "readyExecuteMorphoCalldata": CALLDATA}
    if change == "borrower":
        item["user"] = V3_A
    elif change == "spoke":
        item["spoke"] = SPOKE_A
    elif change == "executor":
        data[V3_WATCH]["liquidatorAddress"] = DEDICATED
    elif change == "partition":
        data[V3_WATCH]["partition"] = "invalid"
    else:
        data[V3_WATCH]["checkedAt"] = iso(NOW - 4000)
        data[V3_WATCH]["pin"] = pin(age=4010)
    data[SENTINEL]["targets"]["targetA4_AaveV4_SameAsset_0xa429"] = item
    curated = build(root, data)
    shortlist = build_targets(ArtifactReader(root), NOW)
    for view in (curated, shortlist):
        row = rows(view)["target-a4-aave-v4-same-asset-0xa429"]
        assert row["runner"]["label"] == "Unified Aave V4 A4"
        assert row["runner"]["reported_armed"] is None
        assert row["executor_address"] == UNIFIED


@pytest.mark.parametrize("stage", ["watch", "underwater", "stale", "no_debt"])
def test_yn_euler_candidates_are_observation_only_across_ops_curated_and_shortlist(root, stage):
    data = fixtures()
    definitions = [
        ("targetYnEthx_Curve_NavArb", "#YN", "0xd65ed4bce447195187f37ce7d82f56adf1826f8f",
         "0xd65ed4bce447195187f37ce7d82f56adf1826f8f", "WETH -> ynETHx -> Redeem (Curve/NAV)", "Curve/NAV"),
        ("targetE1_EulerV2_RLUSD_USDC_0xbf21", "#E1", "0xbf21702d7213bc7a95fc0ecb1e4a4e43c2380772",
         "0xe1ce9af672f8854845e5474400b6ddc7ae458a10", "eUSDC-22 / eRLUSD-1 (Euler V2)", "Euler V2"),
        ("targetE2_EulerV2_USDC_syrupUSDC_0x9f09", "#E2", "0x9f09502a0b68edbccdff5e6c59270ad150def361",
         "0x9bd52f2805c6af014132874124686e7b248c2cbb", "esyrupUSDC-4 / eUSDC-70 (Euler V2)", "Euler V2"),
    ]
    for key, rank, user, venue, pair, _ in definitions:
        data[SENTINEL]["targets"][key] = {
            "rank": rank, "user": user, "marketId": venue, "pair": pair,
            "healthFactor": None if stage == "no_debt" else .999 if stage == "underwater" else 1.01,
            "bpsToLiquidation": None if stage == "no_debt" else -10.01 if stage == "underwater" else 99.0099,
            "liquidatableNow": stage == "underwater", "debtUsd": 0 if stage == "no_debt" else 113499,
            "collateralUsd": 114500, "ynEthxBufferWeth": 2,
            # Even contradictory raw execution flags/calldata cannot arm these fixed candidates.
            "observationOnly": False, "armed": True, "executableNow": True,
            "deployedExecutor": M1_EXECUTOR, "readyExecuteMorphoCalldata": CALLDATA,
            "liveQuote": {"estimatedProfitUsd": 1135, "collateralSeizedFormatted": "109,505 eUSDC-22",
                          "debtOutcomeFormatted": "113,499 RLUSD"},
        }
    if stage == "stale":
        data[SENTINEL]["generatedAt"] = iso(NOW - 4000)
        data[SENTINEL]["pin"] = pin(age=4010)
        curated = build(root, data)
        reader = ArtifactReader(root)
        shortlist = build_targets(reader, NOW)
        legacy = ops.build_top_whale_triggers(reader.read_json(SENTINEL),
            reader.read_json("aave_v4_v3_morpho_liquidator_deploy"), NOW, reader,
            SENTINEL, "aave_v4_v3_morpho_liquidator_deploy")
        assert curated["summary"]["total"] == 27 and curated["summary"]["observation_only"] == 3
        assert shortlist["summary"]["total"] == 26 and shortlist["summary"]["observation_only"] == 2
        for view in (legacy, curated, shortlist):
            for _, rank, user, venue, pair, protocol in definitions:
                row = next(r for r in view["targets"] if r["rank"] == rank)
                assert row["pair"] == pair
                if rank in {"#YN", "#E1"}:
                    assert row["observation_only"] is False and row["armed"] is None
                    continue
                assert row["observation_only"] is True
                assert row["armed"] is row["executable_now"] is row["calldata_ready"] is False
                assert row["executor"] is None and row["surplus_usd"] is None
                if view is legacy:
                    continue
                assert row["protocol_label"] == protocol
                assert row["group_key"] == "euler-v2"
                assert row["protocol"] == ("Euler" if view is shortlist and protocol == "Euler V2" else protocol)
                assert row["borrower_address"] == user and row["venue_address"] == venue
                assert row["chain_id"] == 1 and row["chain_name"] == "Ethereum"
                assert row["status"]["code"] == "OBSERVATION_ONLY"
                assert row["runner"]["label"] is row["runner"]["reported_armed"] is row["executor_address"] is None
                assert row["quote"]["available"] is False and row["quote"]["gross_usd"] is None
                assert row["observation"]["block"] == 1000 and row["observation"]["source"] == SENTINEL
                assert row["observation"]["freshness"] == ("STALE" if stage == "stale" else "FRESH")
                assert row["liquidatable_now"] is (None if stage in {"stale", "no_debt"} else stage == "underwater")


EULER_EXTENDED = [
    ("targetE3_EulerV2_WETH_ynETHx_0x831e", "target-e3-euler-v2-weth-ynethx-0x831e", "#E3", "0x831ec4f2aba6deab29fb1aefdf9b049721d3c366",
     "0x45c3b59d53e2e148aaa6a857521059676d5c0489", "eynETHx-2 / eWETH-22 (Euler V2)"),
    ("targetE4_EulerV2_WETH_ynETHx_0x8062", "target-e4-euler-v2-weth-ynethx-0x8062", "#E4", "0x8062511602a163fe84d1d2300117ea8cc1600cbd",
     "0x45c3b59d53e2e148aaa6a857521059676d5c0489", "eynETHx-2 / eWETH-22 (Euler V2)"),
    ("targetE5_EulerV2_USDC_USDT_0xd1ed", "target-e5-euler-v2-usdc-usdt-0xd1ed", "#E5", "0xd1edf7fc3d913c94e6c649985ce36bbc2e871d0f",
     "0xe0a80d35bb6618cba260120b279d357978c42bce", "eUSDT-9 / eUSDC-22 (Euler V2)"),
    ("targetE6_EulerV2_USDT_USDC_0x079d", "target-e6-euler-v2-usdt-usdc-0x079d", "#E6", "0x079dfb0a62b4723b45166abb7892fe362543ad8d",
     "0x7c280dbdef569e96c7919251bd2b0edf0734c5a8", "eUSDC-22 / eUSDT-9 (Euler V2)"),
]
EULER_EXECUTOR = "0xac262ce4319b887aeac069730c7978c98a8c5fe6"


@pytest.mark.parametrize("stage", ["healthy", "buffer_blocked", "ready", "stale", "no_debt"])
def test_extended_euler_targets_are_configured_and_keep_buffer_eligibility_separate(root, stage):
    data = fixtures()
    underwater = stage in {"buffer_blocked", "ready", "stale"}
    for key, ident, rank, user, venue, pair in EULER_EXTENDED:
        ready = underwater and not (stage == "buffer_blocked" and rank in {"#E3", "#E4"})
        data[SENTINEL]["targets"][key] = {
            "rank": rank, "user": user, "marketId": venue, "pair": pair,
            "executor": EULER_EXECUTOR, "armed": True, "observationOnly": False,
            "healthFactor": None if stage == "no_debt" else .999 if underwater else 1.01,
            "hfUnderwaterNow": underwater, "liquidatableNow": ready, "executableNow": ready,
            "bpsToLiquidation": -10.01 if underwater else 99.0099,
            "debtUsd": 0 if stage == "no_debt" else 1368.25, "collateralUsd": 1350,
            "liveQuote": {"estimatedProfitUsd": 13.68},
            **({"readyExecuteEulerEvkCalldata": "0x12345678" + "00" * 384} if ready else {}),
        }
    if stage == "stale":
        data[SENTINEL]["generatedAt"] = iso(NOW - 4000)
        data[SENTINEL]["pin"] = pin(age=4010)
    curated = build(root, data)
    reader = ArtifactReader(root)
    shortlist = build_targets(reader, NOW)
    legacy = ops.build_top_whale_triggers(reader.read_json(SENTINEL),
        reader.read_json("aave_v4_v3_morpho_liquidator_deploy"), NOW, reader,
        SENTINEL, "aave_v4_v3_morpho_liquidator_deploy")
    for view in (legacy, curated, shortlist):
        for key, ident, rank, user, venue, pair in EULER_EXTENDED:
            row = rows(view)[ident]
            ready = data[SENTINEL]["targets"][key]["executableNow"]
            assert row["rank"] == rank and row["pair"] == pair
            assert row["observation_only"] is False and row["armed"] is None
            assert row["calldata_ready"] is ready
            if view is legacy:
                assert row["executor"] == EULER_EXECUTOR and row["executable_now"] is False
                continue
            assert row["protocol_label"] == "Euler V2" and row["group_key"] == "euler-v2"
            assert row["borrower_address"] == user and row["venue_address"] == venue
            assert row["market_id"] == (venue if view is curated else None)
            assert row["executor_address"] == EULER_EXECUTOR and row["runner"]["label"] == "Unified Euler V2"
            assert row["runner"]["reported_armed"] is None
            assert row["status"]["code"] == ("STALE" if stage == "stale" else "UNKNOWN" if stage == "no_debt" else "ELIGIBLE" if underwater else "WATCH")
            assert row["liquidatable_now"] is (None if stage in {"stale", "no_debt"} else underwater)
            assert any("MCwETH withdrawal buffer" in note for note in row["blockers"]) is (stage == "buffer_blocked" and rank in {"#E3", "#E4"})
            assert row["quote"]["available"] is False and row["quote"]["gross_usd"] is None
            if view is curated:
                assert row["executable_now"] is False


@pytest.mark.parametrize("key,ident,rank,user,venue,pair", EULER_EXTENDED)
@pytest.mark.parametrize("change", [{"user": M1_USER}, {"marketId": M1_MARKET}, {"executor": M1_EXECUTOR}, {"armed": "true"}])
def test_extended_euler_runner_scope_is_exact(root, key, ident, rank, user, venue, pair, change):
    data = fixtures()
    data[SENTINEL]["targets"][key] = {"rank": rank, "user": user, "marketId": venue, "pair": pair,
        "executor": EULER_EXECUTOR, "armed": True, "healthFactor": 1.01, "liquidatableNow": False, **change}
    row = rows(build(root, data))[ident]
    assert row["runner"]["reported_armed"] is None
    assert row["executor_address"] == EULER_EXECUTOR


@pytest.mark.parametrize("state", ["watch", "underwater", "stale", "estimated"])
def test_pt_m8_m9_are_observation_only_in_curated_and_shortlist_views(root, state):
    data = fixtures()
    for i, (rank, user) in enumerate(ops.PT_USDE_DAI_USERS.items()):
        data[SENTINEL]["targets"][f"target{rank[1:]}_Morpho_PT_USDe_DAI"] = {
            "rank": rank, "user": user, "marketId": ops.PT_USDE_DAI_MARKET, "pair": "PT-USDe-31JUL2025 / DAI",
            "healthFactor": .999 if state == "underwater" else 1.004,
            "liquidatableNow": None if state == "estimated" else state == "underwater",
            "bpsToLiquidation": -10 if state == "underwater" else [38.67, 41.0][i],
            "debtUsd": 30000, "collateralUsd": 33000, "collateralPt": 33000,
            "borrowAprPct": None if state == "estimated" else 8.5, "passiveHoursToCrossing": None if state == "estimated" else 4.2,
            "healthIsEstimate": state == "estimated", "observationStatus": "COMPLETE",
            # Staged borrowers cannot become armed via unsupported raw flags or fork addresses.
            "observationOnly": False, "armed": True, "executableNow": True, "deployedExecutor": M1_EXECUTOR,
            "readyExecuteMorphoBlueCalldata": CALLDATA,
            "liveQuote": {"repayDai": 100, "seizedUsde": 110, "uniV3OutDai": 111, "grossSurplusDai": 11},
        }
    if state == "stale":
        data[SENTINEL]["generatedAt"] = iso(NOW - 4000)
        data[SENTINEL]["pin"] = pin(age=4010)
    curated = build(root, data)
    shortlist = build_targets(ArtifactReader(root), NOW)
    for view in (curated, shortlist):
        for rank, user in ops.PT_USDE_DAI_USERS.items():
            row = next(r for r in view["targets"] if r["rank"] == rank)
            assert row["borrower_address"] == user and row["market_id"] == ops.PT_USDE_DAI_MARKET
            assert row["chain_name"] == "Ethereum" and row["chain_id"] == 1
            assert row["venue_address"] == MORPHO and row["pair"] == "PT-USDe-31JUL2025 / DAI"
            assert row["status"]["code"] == "OBSERVATION_ONLY"
            assert row["observation_only"] is True
            assert row["armed"] is row["executable_now"] is row["calldata_ready"] is False
            assert row["executor_address"] is row["executor"] is row["runner"]["label"] is row["runner"]["reported_armed"] is None
            assert row["quote"]["available"] is False and row["quote"]["gross_token_amount"] is None
            assert row["surplus_usd"] is None
            assert row["readiness_note"] == ops.PT_USDE_DAI_NOTE
            assert row["position"]["debt_symbol"] == "DAI"
    for row in curated["targets"]:
        if row["rank"] in ops.PT_USDE_DAI_USERS:
            assert row["position"]["collateral_symbol"] == "PT-USDe-31JUL2025"
            assert row["health_is_estimate"] is (state == "estimated")


@pytest.mark.parametrize("field,value", [("user", V3_A), ("marketId", M1_MARKET)])
def test_pt_rank_cannot_replace_the_curated_borrower_or_market_binding(root, field, value):
    data = fixtures()
    data[SENTINEL]["targets"]["targetM8_Morpho_PT_USDe_DAI"] = {
        "rank": "#M8", "user": ops.PT_USDE_DAI_USERS["#M8"], "marketId": ops.PT_USDE_DAI_MARKET, field: value,
    }
    assert all(row["rank"] != "#M8" for row in build(root, data)["targets"])


@pytest.mark.parametrize("stage", ["watch", "eligible", "stale", "incomplete"])
def test_b7_curated_and_shortlist_keep_base_identity_and_unproven_redeem_estimate(root, stage):
    data = fixtures()
    item = {
        "rank": "#B7", "user": ops.BASE_YOUSD_BORROWER, "marketId": ops.BASE_YOUSD_MARKET,
        "pair": "yoUSD / USDC (Base)", "chainId": 8453, "deployedExecutor": BASE_EXECUTOR,
        "healthFactor": .9999 if stage == "eligible" else 1.00004, "healthIsEstimate": False,
        "liquidatableNow": stage == "eligible", "bpsToLiquidation": -1 if stage == "eligible" else .4,
        "passiveHoursToCrossing": 0 if stage == "eligible" else 5.38, "observationStatus": "COMPLETE",
        "armed": True, "observationOnly": False,
        "liveQuote": {"repayUsdc": 4599.32, "seizedUsde": 4420, "uniV3OutUsdc": 4719.67,
                      "grossSurplusUsdc": 120.36, "grossSurplusUsd": 120.36},
    }
    data[SENTINEL]["targets"]["extra_Base_USDe_Whales"] = [item]
    if stage == "stale":
        data[SENTINEL]["baseObservation"]["pin"] = pin(8453, 2000, 4000, "b")
    elif stage == "incomplete":
        data[SENTINEL]["baseObservation"]["status"] = "INCOMPLETE"
    view = build(root, data)
    row = rows(view)["base-usde-extra-0"]
    assert row["rank"] == "#B7" and row["pair"] == "yoUSD / USDC (Base)"
    assert (row["borrower_address"], row["market_id"], row["chain_id"]) == (ops.BASE_YOUSD_BORROWER, ops.BASE_YOUSD_MARKET, 8453)
    assert row["executor_address"] == BASE_EXECUTOR and row["executor"] == "0x88bf…4f32"
    assert row["runner"]["label"] == "Base Morpho Runner"
    assert row["runner"]["reported_armed"] is None
    assert row["status"]["code"] == {"watch": "WATCH", "eligible": "ELIGIBLE", "stale": "STALE", "incomplete": "UNKNOWN"}[stage]
    assert row["quote"]["seize_symbol"] == "yoUSD"
    assert row["quote"]["seize_amount"] == "4420"
    assert row["quote"]["gross_token_symbol"] == "USDC"
    assert row["quote"]["gross_token_amount"] is None
    assert row["quote"]["estimate"]["gross_token_amount"] == "120.36"
    shortlist = build_targets(ArtifactReader(root), NOW)
    b7 = next(r for r in shortlist["targets"] if r["rank"] == "#B7")
    assert b7["borrower_address"] == ops.BASE_YOUSD_BORROWER
    assert b7["runner"]["reported_armed"] is None
    assert b7["executable_now"] is False  # The dashboard never authorizes execution.


def test_new_morpho_and_extended_base_targets_are_configured_and_prioritized(root, client, monkeypatch):
    data = fixtures()
    tmap = data[SENTINEL]["targets"]
    for key, rank, pair, user, market in (
        ("targetM17_Morpho_eUSDe_USDe", "#M17", "eUSDe / USDe",
         "0x6adac55e197c09001a605e54042670f5adced052", "0x140fe48783fe88d2a52b31705577d917628caaf74ff79865b39d4c2aa6c2fd3c"),
        ("targetM18_Morpho_USD3_USDC", "#M18", "USD3 / USDC",
         "0x599275be9753ecd8e6c380a7ef78e38711b8f212", "0xe3df58f9d3011b7481ff36b939fa5f8da642f34ea5792d25d3958dbf1efa26d7"),
    ):
        tmap[key] = {"rank": rank, "pair": pair, "user": user, "marketId": market,
                     "healthFactor": 1.01, "liquidatableNow": False, "armed": True, "executor": M2_EXECUTOR,
                     "readyExecuteReusdCalldata": M2_CALLDATA,
                     "liveQuote": {"repayUsdc": 1000, "seizedReusd": 1010, "grossSurplusUsd": 10}}
    pt_executor = "0xd53ee7b5806c4d7f36422eab99dc46563d18b84d"
    for rank, user in ops.PT_USDE_DAI_USERS.items():
        tmap[f"target{rank[1:]}_Morpho_PT_USDe_DAI"] = {
            "rank": rank, "user": user, "marketId": ops.PT_USDE_DAI_MARKET,
            "armed": True, "executor": pt_executor,
        }
    tmap["targetM14_Morpho_PT_USDat_USDC"] = {
        "rank": "#M14", "user": "0x09c67aa4ee667872a9e8e2c0310b4a7fe8d3fc44",
        "marketId": "0x69ef7fd17b42cd7df6d885aee1b11380837afbc1664b25587041cf193b31617b",
        "armed": True, "executor": pt_executor,
    }
    tmap["targetE1_EulerV2_RLUSD_USDC_0xbf21"] = {
        "rank": "#E1", "user": "0xbf21702d7213bc7a95fc0ecb1e4a4e43c2380772",
        "marketId": "0xe1ce9af672f8854845e5474400b6ddc7ae458a10",
        "armed": True, "executor": EULER_EXECUTOR,
    }
    tmap["extra_Base_USDe_Whales"] = [
        {"rank": f"#B{i}", "user": f"0x{i:040x}", "marketId": ops.BASE_USDE_MARKET,
         "pair": "wstETH / WETH (Base)" if i == 8 else "weETH / WETH (Base)" if i == 9 else "USDe / USDC (Base)",
         "chainId": 8453, "healthFactor": 1.01, "liquidatableNow": False, "armed": True,
         "deployedExecutor": BASE_EXECUTOR} for i in range(4, 10)
    ]
    tmap["extra_Base_USDe_Whales"][3].update(
        user=ops.BASE_YOUSD_BORROWER, marketId=ops.BASE_YOUSD_MARKET, pair="yoUSD / USDC (Base)")
    base_weth = {
        "#B8": ("0x10c53e75fe7a7e6bf58a9e68b6a30fcc7d4e6e2c", "0x6aa81f51dfc955df598e18006deae56ce907ac02b0b5358705f1a28fcea23cc0"),
        "#B9": ("0x9558b339bb03246c44c57fcee184645dbfab253f", "0xfd0895ba253889c243bf59bc4b96fd1e06d68631241383947b04d1c293a0cfea"),
    }
    for i, (user, market) in enumerate(base_weth.values(), start=4):
        tmap["extra_Base_USDe_Whales"][i].update(
            user=user, marketId=market, observationStatus="COMPLETE",
            observationBlock=2000, observationHash=data[SENTINEL]["baseObservation"]["pin"]["hash"],
            observationUtc=iso(NOW - 15))
    for key, value in data.items():
        put(root, key, value)
    app_module = importlib.import_module("dashboard.app")
    monkeypatch.setattr(app_module.time, "time", lambda: NOW)
    response = client.get("/api/v1/targets?page_size=100&sort=curated", base_url="http://127.0.0.1:5050",
                          environ_base={"REMOTE_ADDR": "127.0.0.1"})
    assert response.status_code == 200
    assert response.json["summary"]["stale"] == 0
    indexed = {row["rank"]: row for row in response.json["targets"]}
    for rank, pair in (("#M17", "eUSDe / USDe"), ("#M18", "USD3 / USDC"),
                       ("#B8", "wstETH / WETH (Base)"), ("#B9", "weETH / WETH (Base)")):
        assert indexed[rank]["pair"] == pair
        assert indexed[rank]["armed"] is None
    assert [row["rank"] for row in response.json["targets"] if row["id"].startswith("base-usde-extra-")] == [f"#B{i}" for i in range(4, 10)]
    assert indexed["#B7"]["id"] == "base-usde-extra-3"
    for rank, (user, market) in base_weth.items():
        row = indexed[rank]
        assert (row["borrower_address"], row["market_id"], row["venue_address"], row["chain_id"]) == (user, market, MORPHO, 8453)
        assert row["observation"]["freshness"] == "FRESH"
        assert row["observation"]["source"] == SENTINEL
        assert row["observation"]["block"] == 2000
        assert row["observation"]["hash"] == data[SENTINEL]["baseObservation"]["pin"]["hash"]

    reader = ArtifactReader(root)
    legacy = ops.build_top_whale_triggers(reader.read_json(SENTINEL),
        reader.read_json("aave_v4_v3_morpho_liquidator_deploy"), NOW, reader,
        SENTINEL, "aave_v4_v3_morpho_liquidator_deploy")
    order = [row["rank"] for row in legacy["targets"]]
    for rank in ("#M8", "#M9", "#M14", "#M17", "#M18"):
        assert order.index(rank) < order.index("#E1")


def test_curated_24_rows_keep_keys_and_strict_full_identifiers_chain_and_pins(root):
    data = fixtures()
    view = build(root, data)
    assert set(view) == {"schema", "generated_at", "available", "freshness", "age_text", "pin_block", "pin_utc", "warnings", "summary", "targets", "runners", "deployments", "evidence"}
    assert view["schema"] == "dashboard-targets/v1"
    assert view["summary"] == {"total": 24, "eligible": 6, "observation_only": 2, "stale": 0}
    assert view["generated_at"] == iso(NOW)
    assert view["freshness"] == "FRESH"
    indexed = rows(view)
    assert len(indexed) == 24
    assert set(indexed) == {"target-1-aave-v4-usde-usdc", "target2a-aavev3-weeth-weth-0x7231", "target2b-aavev3-weeth-weth-0x1a55",
        "target-m1-morpho-usde-dai", "target-m2-morpho-reusd-usdc", "target-3-morpho-paxg-usdc", *(f"aave-v3-extra-{i}" for i in range(7)), *(f"spoke-c-{i}" for i in range(8)), *(f"base-morpho-{i}" for i in range(3))}
    reader = ArtifactReader(root)
    old = ops.build_top_whale_triggers(reader.read_json(SENTINEL), reader.read_json("aave_v4_v3_morpho_liquidator_deploy"), NOW, reader,
                                      SENTINEL, "aave_v4_v3_morpho_liquidator_deploy")
    for original in old["targets"]:
        assert set(original) <= set(indexed[original["id"]])
    for ident, row in indexed.items():
        base = ident.startswith("base-")
        assert row["chain_id"] == (8453 if base else 1)
        assert row["chain_name"] == ("Base" if base else "Ethereum")
        assert row["status"]["code"] in {"ELIGIBLE", "WATCH", "OBSERVATION_ONLY"}
        assert row["observation"]["block"] == (2000 if base else 1001 if row["protocol"] == "Aave V4" else 1000)
        assert row["observation"]["hash"] == "0x" + ("b" if base else "d" if row["protocol"] == "Aave V4" else "a") * 64
    assert indexed["target2b-aavev3-weeth-weth-0x1a55"]["borrower_address"] == indexed["spoke-c-2"]["borrower_address"] == V3_B
    assert indexed["spoke-c-2"]["venue_address"] == SPOKE_C
    assert indexed["spoke-c-2"]["executor_address"] == DEDICATED != UNIFIED
    assert indexed["target-m1-morpho-usde-dai"]["market_id"] == M1_MARKET


def test_health_overlay_does_not_retimestamp_stale_quotes_and_preserves_negative_gross(root):
    data = fixtures()
    data[SENTINEL]["generatedAt"] = iso(NOW - 4000)
    data[SENTINEL]["pin"] = pin(age=4010)
    quote = data[SENTINEL]["targets"]["spokeC_AaveV4_weETH_WETH"][0]["liveQuote"]
    quote.update(curveOutWeth=99, grossSurplusWeth=-1, grossSurplusUsd=-2400, observationUtc=iso(NOW - 4010))
    view = build(root, data)
    c1 = rows(view)["spoke-c-0"]
    assert c1["status"]["code"] == "ELIGIBLE"
    assert c1["bps_numeric"] == -100
    assert c1["observation"]["source"] == V4_WATCH
    assert c1["quote"]["source"] == SENTINEL
    assert c1["quote"]["block"] == 1000 != c1["observation"]["block"]
    assert c1["quote"]["utc"] == iso(NOW - 4010)
    assert c1["quote"]["freshness"] == "STALE"
    assert c1["quote"]["age_text"] == "66m" != c1["observation"]["age_text"]
    assert c1["quote"]["hash"] == "0x" + "a" * 64 != c1["observation"]["hash"]
    assert c1["quote"]["estimate"]["gross_token_amount"] == "-1"
    assert c1["quote"]["estimate"]["gross_usd"] == "-2400"
    assert c1["gross_usd_numeric"] is c1["surplus_usd"] is None
    assert rows(view)["target2a-aavev3-weeth-weth-0x7231"]["status"]["code"] == "STALE"
    assert rows(view)["target-m1-morpho-usde-dai"]["liquidatable_now"] is None


def test_units_estimates_and_observations_never_become_quoted_profit_or_readiness(root):
    view = build(root)
    indexed = rows(view)
    m1 = indexed["target-m1-morpho-usde-dai"]
    assert m1["quote"]["gross_token_amount"] == "4057"
    assert m1["quote"]["gross_token_symbol"] == "DAI"
    assert m1["quote"]["gross_usd"] is m1["gross_usd_numeric"] is None
    assert m1["position"]["debt_symbol"] == "DAI"
    assert m1["position"]["collateral_symbol"] == "USDe"
    assert m1["position"]["borrow_apr_pct"] == "8.5"
    assert m1["position"]["passive_hours"] == "0"
    assert "$" not in m1["passive_hours_left"] + m1["heartbeat_hours_left"] + m1["surplus_usd"]
    assert "executable profitability" in " ".join(m1["blockers"])
    assert indexed["target-1-aave-v4-usde-usdc"]["quote"]["gross_usd"] is None
    for ident in ["base-morpho-2", "target-3-morpho-paxg-usdc"]:
        row = indexed[ident]
        assert row["status"]["code"] == "OBSERVATION_ONLY"
        assert row["quote"]["available"] is False
        assert row["quote"]["gross_token_amount"] is row["quote"]["gross_usd"] is None
        assert row["executor_address"] is row["runner"]["reported_armed"] is row["runner"]["label"] is None
        assert row["executable_now"] is row["calldata_ready"] is False
    base = indexed["base-morpho-0"]
    assert base["position"]["is_estimate"] is True
    assert base["position"]["collateral_symbol"] == base["position"]["debt_symbol"] == "USDC"
    assert base["venue_address"] == MORPHO
    assert base["runner"]["reported_armed"] is None
    assert base["quote"]["available"] is False
    assert "execution readiness remain unproven" in " ".join(base["blockers"])
    paxg = indexed["target-3-morpho-paxg-usdc"]
    assert paxg["borrower_address"] is paxg["position"]["debt_amount"] is None
    assert "market liquidity" in paxg["label"]
    assert not any("profit" in key for key in view["summary"])


@pytest.mark.parametrize("change", [
    lambda d: d[V4_WATCH]["targets"][0].update(borrower=V3_A),
    lambda d: d[V4_WATCH]["targets"][0].update(spoke=SPOKE_C),
    lambda d: d[V4_WATCH].update(checkedAt=iso(NOW - 4000)),
    lambda d: d[V4_WATCH].update(blockNumber=999, pin=pin(block=999)),
    lambda d: d[V4_WATCH].update(pin=pin(chain=8453, block=1001)),
    lambda d: d[V4_WATCH].update(blockNumber=999),
])
def test_bad_or_older_dedicated_health_does_not_replace_sentinel(root, change):
    data = fixtures(); change(data)
    row = rows(build(root, data))["target-1-aave-v4-usde-usdc"]
    assert row["observation"]["source"] == SENTINEL
    assert row["status"]["code"] == "WATCH"
    assert row["quote"]["block"] == 1000


@pytest.mark.parametrize("change", [
    lambda d: d[V3_WATCH].pop("morphoExecution"),
    lambda d: d[V3_WATCH].update(morphoExecution="DISABLED_OBSERVATION_ONLY"),
    lambda d: d[V3_WATCH].update(checkedAt=iso(NOW - 4000)),
    lambda d: d[V3_WATCH].update(armed="true"),
    lambda d: d[V3_WATCH].update(mode="CHECK_ONLY"),
    lambda d: d[V3_WATCH].update(ok=False),
    lambda d: d[V3_WATCH]["pin"].update(hash="bad"),
])
def test_m1_reported_armed_requires_actual_fresh_scoped_telemetry(root, change):
    data = fixtures(); change(data)
    assert rows(build(root, data))["target-m1-morpho-usde-dai"]["runner"]["reported_armed"] is None


def test_runner_tri_state_partition_and_failed_target_health(root):
    data = fixtures()
    initial = rows(build(root, data))
    for ident in ("target-m1-morpho-usde-dai", "target2a-aavev3-weeth-weth-0x7231", "spoke-c-0"):
        assert initial[ident]["runner"]["reported_armed"] is True
    data[V3_WATCH].update(armed=False, mode="CHECK_ONLY")
    data[V4_WATCH]["targets"][1].update(healthFactorRaw=None, healthFactorFormatted=None, isLiquidatableBothProviders=False)
    result = rows(build(root, data))
    assert result["target-m1-morpho-usde-dai"]["runner"]["reported_armed"] is False
    assert result["spoke-c-0"]["status"]["code"] == "UNKNOWN"
    assert result["spoke-c-0"]["liquidatable_now"] is None
    data[V3_WATCH].update(partition="UNRELATED", armed=True, mode="EXECUTE_IF_LIQUIDATABLE")
    assert rows(build(root, data))["target2a-aavev3-weeth-weth-0x7231"]["runner"]["reported_armed"] is None


def test_missing_invalid_and_cached_sources_never_become_healthy(root):
    reader = ArtifactReader(root)
    assert build_curated_targets(reader, NOW)["available"] is False
    assert build(root, reader=reader)["summary"]["total"] == 24
    path = root / ALLOWLIST[SENTINEL]
    path.write_text("{bad-json", encoding="utf8")
    failed = build_curated_targets(reader, NOW)
    assert reader.read_status[SENTINEL]["last_good"] is True
    assert failed["available"] is False
    assert failed["targets"] == []
    assert failed["freshness"] == "UNKNOWN"
    path.unlink()
    assert build_curated_targets(reader, NOW)["targets"] == []


@pytest.mark.parametrize("change", [
    lambda d: d[SENTINEL]["pin"].update(hash="bad"),
    lambda d: d[SENTINEL]["pin"].update(chainId=8453),
    lambda d: d[SENTINEL]["targets"]["targetM1_Morpho_USDe_DAI"].update(healthFactor=None),
    lambda d: d[SENTINEL]["targets"]["targetM1_Morpho_USDe_DAI"].update(liquidatableNow="true"),
    lambda d: d[SENTINEL]["targets"]["targetM1_Morpho_USDe_DAI"].update(user="bad"),
    lambda d: d[SENTINEL]["targets"]["targetM1_Morpho_USDe_DAI"].update(observationStatus="INCOMPLETE"),
])
def test_incomplete_health_is_unknown_not_false_or_eligible(root, change):
    data = fixtures(); change(data)
    row = rows(build(root, data))["target-m1-morpho-usde-dai"]
    assert row["status"]["code"] == "UNKNOWN"
    assert row["liquidatable_now"] is None


def test_base_missing_or_incomplete_pin_never_inherits_ethereum(root):
    data = fixtures()
    data[SENTINEL]["baseObservation"] = {"status": "INCOMPLETE", "reason": "RAW_ERROR"}
    result = rows(build(root, data))["base-morpho-0"]
    assert result["observation"]["block"] is result["observation"]["hash"] is result["observation"]["utc"] is None
    assert result["observation"]["freshness"] == "UNKNOWN"
    assert result["status"]["code"] == "UNKNOWN"
    data[SENTINEL]["baseObservation"] = {"status": "COMPLETE", "pin": pin()}
    result = rows(build(root, data))["base-morpho-0"]
    assert result["observation"]["block"] is result["observation"]["hash"] is result["observation"]["utc"] is None


def test_injection_nonfinite_values_and_extra_targets_are_not_exported(root):
    data = fixtures()
    poison = '<script>alert(1)</script> https://private.invalid/token token=SECRET reports/private .env.exploit'
    tmap = data[SENTINEL]["targets"]
    tmap["additional_AaveV3_weETH_WETH"].append(copy.deepcopy(tmap["additional_AaveV3_weETH_WETH"][0]))
    tmap["unrelated_scanner"] = {"user": poison}
    target = tmap["additional_AaveV3_weETH_WETH"][0]
    target.update(rank=poison, user=poison, pool=poison, healthFactor=float("inf"), bpsToLiquidation=float("nan"), rawError=poison)
    target["liveQuote"].update(grossSurplusUsd=poison, grossSurplusWeth=float("-inf"), seizedWeEth=True)
    tmap["base_Morpho_Whales"][0].update(pair=poison, marketId="zz" + "a" * 64)
    data[V4_WATCH]["targets"][0].update(healthFactorFormatted=poison)
    data["aave_v4_flash_liquidator_deploy"].update(gasUsed=poison, actualDeployFeeEth=poison, txHash="zz" + "a" * 64)
    data[V3_WATCH].update(mode=poison, reason=poison)
    view = build(root, data)
    text = json.dumps(view, allow_nan=False)
    for forbidden in ("<script", "SECRET", "private.invalid", ".env", "rawError", "unrelated_scanner", "NaN", "Infinity"):
        assert forbidden not in text
    assert view["summary"]["total"] == 24
    row = rows(view)["aave-v3-extra-0"]
    assert row["borrower_address"] is row["venue_address"] is row["bps_numeric"] is row["gross_usd_numeric"] is None
    assert view["deployments"]["v4"]["gas_used"] is view["deployments"]["v4"]["tx_hash"] is None


def test_decimal_strings_and_zero_output_failure_are_not_formatted_string_parsing(root):
    data = fixtures()
    quote = data[SENTINEL]["targets"]["targetM1_Morpho_USDe_DAI"]["liveQuote"]
    quote["grossSurplusDai"] = "-0.000000000000000001"
    row = rows(build(root, data))["target-m1-morpho-usde-dai"]
    assert row["quote"]["available"] is True
    assert row["quote"]["gross_token_amount"] == "-0.000000000000000001"
    quote["uniV3OutDai"] = 0
    row = rows(build(root, data))["target-m1-morpho-usde-dai"]
    assert row["quote"]["available"] is False
    assert row["quote"]["gross_token_amount"] is None


@pytest.mark.parametrize("gross", [2050, -12.5])
def test_m2_keeps_measured_curve_quote_and_usdc_units_without_runner_inference(root, gross):
    data = fixtures()
    m2 = data[SENTINEL]["targets"]["targetM2_Morpho_reUSD_USDC"]
    m2.update(executableNow=True, deployedExecutor=M2_EXECUTOR, readyExecuteCurveUnwindCalldata=M2_CALLDATA)
    m2["liveQuote"].update(grossSurplusUsdc=gross, grossSurplusUsd=gross)
    view = build(root, data)
    indexed = rows(view)
    row = indexed["target-m2-morpho-reusd-usdc"]
    order = [r["id"] for r in view["targets"]]
    assert order.index(row["id"]) == order.index("target-m1-morpho-usde-dai") + 1
    assert row["rank"] == "#M2"
    assert row["pair"] == "reUSD / USDC"
    assert row["borrower_address"] == M2_USER
    assert row["market_id"] == M2_MARKET
    assert row["venue_address"] == MORPHO
    assert row["chain_name"] == "Ethereum"
    assert row["status"]["code"] == "ELIGIBLE"
    assert row["liquidatable_now"] is True
    assert row["observation_only"] is False
    assert row["armed"] is None and row["executable_now"] is False and row["calldata_ready"] is True
    assert row["executor_address"] == M2_EXECUTOR
    assert row["runner"]["label"] == "Unified Morpho M2"
    assert row["runner"]["reported_armed"] is None
    assert "executable profitability" in " ".join(row["blockers"])
    quote = row["quote"]
    assert quote["available"] is True
    assert quote["gross_token_amount"] == str(gross)
    assert quote["gross_token_symbol"] == quote["repay_symbol"] == "USDC"
    assert quote["repay_amount"] == "97450"
    assert quote["seize_amount"] == "100000"
    assert quote["seize_symbol"] == "reUSD"
    assert quote["gross_usd"] is row["gross_usd_numeric"] is None
    assert quote["block"] == row["observation"]["block"] == 1000
    assert quote["utc"] == row["observation"]["utc"] == iso(NOW - 20)
    assert quote["hash"] == "0x" + "a" * 64
    assert quote["source"] == SENTINEL
    assert "before gas" in " ".join(quote["notes"])
    assert row["position"]["debt_amount"] == "200000"
    assert row["position"]["collateral_amount"] == "240000"
    assert row["position"]["debt_symbol"] == row["position"]["collateral_symbol"] == "USDC"
    assert row["position"]["borrow_apr_pct"] == "8.5"
    assert row["position"]["passive_hours"] == "0"


@pytest.mark.parametrize("payload_bytes,ready", [(24580, True), (32769, False)])
def test_m31_multihop_calldata_is_preserved_within_bounded_size(root, payload_bytes, ready):
    data = fixtures()
    data[SENTINEL]["targets"]["targetM31_Morpho_syrupUSDC_USDC"] = {
        "rank": "#M31", "pair": "syrupUSDC / USDC",
        "user": "0x950fd558f47e234a2fde23b7d61f7ccdbcb4a86f",
        "marketId": "0x729badf297ee9f2f6b3f717b96fd355fc6ec00422284ce1968e76647b258cf44",
        "healthFactor": .999, "liquidatableNow": True, "armed": True,
        "executor": M2_EXECUTOR, "readyExecuteCurveUnwindCalldata": "0x" + "ab" * payload_bytes,
    }
    for view in (build(root, data), build_targets(ArtifactReader(root), NOW)):
        row = rows(view)["morpho-syrupusdc-usdc-m31"]
        assert row["rank"] == "#M31"
        assert row["calldata_ready"] is ready


@pytest.mark.parametrize("legacy, binding", [(True, "m2"), (True, "curve"), (True, "reusd"), (False, "dedicated")])
@pytest.mark.parametrize("stage", ["healthy", "underwater", "stale"])
def test_m32_preserves_dedicated_reference_gain_but_rejects_legacy_m2_quotes(root, legacy, binding, stage):
    data = fixtures()
    baseline = rows(build(root, data))
    item = copy.deepcopy(data[SENTINEL]["targets"]["targetM2_Morpho_reUSD_USDC"])
    item.update(rank="#M32", pair="sUSDe / USDtb",
                user="0xc17a3f83798c8dfe5b6bc4f05825fccf08889c65",
                marketId="0x88a18b2f4d94e7ad27a381b15531c06abf05a7c99dd5d3c3679875fed6f7e742",
                healthFactor=.999 if stage == "underwater" else 1.00014, liquidatableNow=stage == "underwater",
                executableNow=True, bpsToLiquidation=-10.01 if stage == "underwater" else 1.4,
                readinessNote="ARMED on shared M2; +$276.80 simulated.")
    item["liveQuote"] = {"repayUsdc": 9000, "seizedReusd": 8000, "curveOutUsdc": 9276.80,
                         "grossSurplusUsdc": 276.80, "grossSurplusUsd": 276.80}
    item.pop("readyExecuteCurveUnwindCalldata")
    if binding != "m2":
        item.update(executor=M32_EXECUTOR, deployedExecutor=M32_EXECUTOR)
    if binding in {"curve", "reusd"}:
        item["readyExecuteCurveUnwindCalldata" if binding == "curve" else "readyExecuteReusdCalldata"] = M2_CALLDATA
    if not legacy:
        item.update(observationOnly=False, armed=True, executableNow=False,
                    liveQuote={"repayUsdc": 11039.80, "seizedReusd": 9025.94, "curveOutUsdc": 11319.14,
                               "grossSurplusUsdc": 279.34, "grossSurplusUsd": 213.50})
        item.pop("readinessNote")  # The ops projection must also default to dedicated M32 readiness.
    if stage == "stale":
        data[SENTINEL]["generatedAt"] = iso(NOW - 4000)
        data[SENTINEL]["pin"] = pin(age=4010)
    data[SENTINEL]["targets"]["targetM32_Morpho_sUSDe_USDtb"] = item
    curated = build(root, data)
    for view in (curated, build_targets(ArtifactReader(root), NOW)):
        row = rows(view)["morpho-susde-usdtb-m32"]
        assert row["rank"] == "#M32" and row["pair"] == "sUSDe / USDtb"
        assert row["executor_address"] == M32_EXECUTOR == "0x2c94b422884c0495cae3cef9ce7ab337fac247c4"
        assert row["executor"] == "0x2c94…47c4"
        assert row["executor_family"] == "m32"
        assert row["executor_name"] == M32_CONTRACT_NAME == "MorphoM32CurveUnwindLiquidator"
        assert row["expected_runtime_keccak256"] == M32_RUNTIME_KECCAK256 == "0x2b3e40560e4e0ce96999b35d6f0141def9d7cba00baf7aa3caa7f22cd3f4a191"
        assert row["borrower_address"] == item["user"] and row["market_id"] == item["marketId"]
        assert row["venue_address"] == MORPHO and row["chain_id"] == 1
        assert row["observation_only"] is False
        assert row["armed"] is None
        assert row["executable_now"] is row["calldata_ready"] is False
        assert row["status"]["code"] == {"healthy": "WATCH", "underwater": "ELIGIBLE", "stale": "STALE"}[stage]
        assert row["liquidatable_now"] is (None if stage == "stale" else stage == "underwater")
        assert float(row["health_factor"]) == item["healthFactor"]
        assert row["runner"]["label"] == "Dedicated Morpho M32"
        assert row["runner"]["reported_armed"] is None
        assert row["runner"]["source"] is row["runner"]["checked_at"] is row["runner"]["mode"] is None
        assert row["runner"]["freshness"] == "UNKNOWN"
        assert "not authorization" in " ".join(row["runner"]["notes"])
        assert row["readiness_note"] == M32_READINESS_NOTE
        quote = row["quote"]
        assert quote["available"] is False
        if legacy:
            assert quote["freshness"] == "UNKNOWN"
            assert quote["utc"] is quote["block"] is quote["hash"] is quote["source"] is quote["age_text"] is None
            assert quote["repay_amount"] is quote["seize_amount"] is quote["gross_token_amount"] is None
            assert row["repay_summary"] is row["seized_summary"] is row["surplus_usd"] is None
        else:
            assert quote["freshness"] == "UNKNOWN"
            assert quote["block"] is quote["hash"] is quote["utc"] is None
            assert quote["source"] == SENTINEL
            assert quote["repay_amount"] == "11039.8" and quote["seize_amount"] == "9025.94"
            assert quote["gross_token_amount"] is None and quote["estimate"]["gross_token_amount"] == "279.34"
            assert row["repay_summary"] == "11039.8 USDtb" and row["seized_summary"] == "9025.94 sUSDe"
            assert row["surplus_usd"] is None
            assert "rehearsal reference" in " ".join(quote["notes"])
        assert quote["repay_symbol"] == quote["gross_token_symbol"] == "USDtb"
        assert quote["seize_symbol"] == "sUSDe"
        assert quote["gross_usd"] is row["gross_usd_numeric"] is None
        assert row["observation"]["block"] == 1000
        assert row["observation"]["utc"] == iso(NOW - (4010 if stage == "stale" else 20))
        assert row["observation"]["freshness"] == ("STALE" if stage == "stale" else "FRESH")
        assert row["historical_reference"]["available"] is False
        assert "221.63" not in json.dumps(row) and "Configured dedicated" in row["readiness_note"]
        assert "276.8" not in json.dumps(row)
        other = rows(view)["target-m2-morpho-reusd-usdc"]
        assert other["executor_address"] == M2_EXECUTOR == "0x2d5bca1b846e89965544c7f03d09a25126803627"
        assert other["armed"] is None and other["calldata_ready"] is True
        assert other["observation_only"] is False
        assert other["runner"]["label"] == "Unified Morpho M2"
    if stage != "stale":
        assert {key: row for key, row in rows(curated).items() if key != "morpho-susde-usdtb-m32"} == baseline
    position = rows(curated)["morpho-susde-usdtb-m32"]["position"]
    assert position["debt_symbol"] == "USDtb"
    assert position["collateral_symbol"] == "USDtb"  # collateralUsd is valued in loan-token units, not USD or sUSDe.
    reader = ArtifactReader(root)
    home = ops.build_top_whale_triggers(reader.read_json(SENTINEL),
        reader.read_json("aave_v4_v3_morpho_liquidator_deploy"), NOW, reader,
        SENTINEL, "aave_v4_v3_morpho_liquidator_deploy")
    row = rows(home)["morpho-susde-usdtb-m32"]
    assert row["executor"] == M32_EXECUTOR
    assert row["readiness_note"] == M32_READINESS_NOTE
    assert row["armed"] is None and row["observation_only"] is False
    assert row["executable_now"] is row["calldata_ready"] is False
    if legacy:
        assert row["repay_summary"] is row["seized_summary"] is row["surplus_usd"] is None
    else:
        assert row["repay_summary"] == "11039.8 USDtb" and row["seized_summary"] == "9025.94 sUSDe"
        assert row["surplus_usd"] is None


def m32_reference_fixture():
    # Minimal public shape from the fixed sanitized report, not live-quote data.
    original = {"number": "26281701", "timestamp": "1793075915",
                "hash": "0x4a333f22a3d4bd55f36378c6337987c79090395599c5a3a0fdbb1f61d71a86ab"}
    net = {"nativeWei": "92491044130095672", "usd8DecFloor": "21349892698"}
    return {"schema": "m32-deployed-local-host/v1", "status": "LOCAL_REHEARSAL_PASS",
            "startedAt": "2026-10-27T04:56:27.455Z", "completedAt": "2026-10-27T04:57:10.076Z",
            "liveActions": False, "signing": False, "authorityConsumed": False, "productionTimingProven": False,
            "pin": {"chainId": 1, **original},
            "rehearsal": {"schema": "m32-deployed-local-rehearsal/v1", "status": "LOCAL_REHEARSAL_PASS",
                          "liveActions": False, "signing": False, "authorityConsumed": False, "productionTimingProven": False,
                          "localFixture": True, "fullyArmed": False, "productionFullRunnerProven": False,
                          "freshProductionQualificationProven": False, "executor": M32_EXECUTOR,
                          "runtimeKeccak256": M32_RUNTIME_KECCAK256, "valuationBasis": M32_VALUATION,
                          "valuationPin": original, "syntheticAdvancementSeconds": "43200",
                          "selected": {"net": net, "replay": {"status": "LOCAL_SETTLED", "net": copy.deepcopy(net),
                                       "ownerUsdTbGainRaw": "279339667356750828660",
                                       "exactExit": {"inputUsdTbRaw": "221630231995370853342"}}}}}


def m32_reference_data():
    data = fixtures()
    data[SENTINEL]["targets"]["targetM32_Morpho_sUSDe_USDtb"] = {
        "rank": "#M32", "pair": "sUSDe / USDtb", "user": "0xc17a3f83798c8dfe5b6bc4f05825fccf08889c65",
        "marketId": "0x88a18b2f4d94e7ad27a381b15531c06abf05a7c99dd5d3c3679875fed6f7e742",
        "executor": M32_EXECUTOR, "deployedExecutor": M32_EXECUTOR,
        "observationOnly": False, "armed": True, "executableNow": False,
        "healthFactor": 1.00014, "liquidatableNow": False, "bpsToLiquidation": 1.4,
        "debtUsd": 11038.47, "collateralUsd": 12064.69,
        "liveQuote": {"repayUsdc": 11039.80, "seizedReusd": 9025.94, "curveOutUsdc": 11319.14,
                      "grossSurplusUsdc": 279.34, "grossSurplusUsd": 213.50}}
    data[M32_REFERENCE] = m32_reference_fixture()
    return data


@pytest.mark.parametrize("quote_state", ["dedicated", "missing", "legacy"])
def test_m32_estimate_is_visible_in_summary_details_and_apis_with_historical_provenance(root, client, monkeypatch, quote_state):
    data = m32_reference_data()
    item = data[SENTINEL]["targets"]["targetM32_Morpho_sUSDe_USDtb"]
    quoted = quote_state == "dedicated"
    if quote_state == "missing":
        item.pop("liveQuote")
    elif quote_state == "legacy":
        item.update(executor=M2_EXECUTOR, deployedExecutor=M2_EXECUTOR, readyExecuteCurveUnwindCalldata=M2_CALLDATA,
                    liveQuote={"repayUsdc": 9000, "seizedReusd": 8000, "curveOutUsdc": 9276.80,
                               "grossSurplusUsdc": 276.80, "grossSurplusUsd": 276.80})
    build(root, data)
    reader = ArtifactReader(root)
    for view in (build_curated_targets(reader, NOW), build_targets(reader, NOW), build_inventory(reader, NOW)):
        row = rows(view)["morpho-susde-usdtb-m32"]
        ref = row["historical_reference"]
        assert ref["available"] is True
        assert ref["label"] == "Modeled net · historical local fork"
        assert ref["modeled_net_usd"] == "213.49892698" and ref["modeled_net_usd_display"] == "213.50"
        assert ref["modeled_net_native_wei"] == "92491044130095672"
        assert ref["source_artifact"] == "reports/raw/fast/executor-readiness-m32-20261026/m32-deployed-local-20261027T045710076Z.json"
        assert ref["started_at"] == "2026-10-27T04:56:27.455000+00:00"
        assert ref["completed_at"] == "2026-10-27T04:57:10.076000+00:00"
        assert ref["original_block"] == 26281701
        assert ref["original_hash"] == data[M32_REFERENCE]["pin"]["hash"]
        assert ref["original_utc"] == iso(1793075915)
        assert ref["fixture_advance_seconds"] == 43200 and ref["valuation_basis"] == M32_VALUATION
        assert row["observation"]["block"] == 1000 and row["observation"]["utc"] == iso(NOW - 20)
        assert row["observation"]["freshness"] == "FRESH"
        assert row["quote"]["available"] is False
        assert row["quote"]["gross_token_amount"] is row["surplus_usd"] is None
        assert (row["quote"].get("estimate") or {}).get("gross_token_amount") == ("279.34" if quoted else None)
        assert row["gross_usd_numeric"] is None
        assert row["repay_summary"] == ("11039.8 USDtb" if quoted else None)
        assert row["seized_summary"] == ("9025.94 sUSDe" if quoted else None)
        assert row["position"]["debt_amount"] == "11038.47"
        assert row["armed"] is None and row["observation_only"] is False
        assert row["runner"]["reported_armed"] is None
        assert "221.63" not in json.dumps(row) and "276.8" not in json.dumps(row)
    # Adding/removing a historical net must not move the candidate in gain sorts.
    for order in ("gross-asc", "gross-desc"):
        before = build_targets(reader, NOW, {"sort": order})
        put(root, M32_REFERENCE, {})
        without = build_targets(reader, NOW, {"sort": order})
        assert [r["id"] for r in before["targets"]] == [r["id"] for r in without["targets"]]
        put(root, M32_REFERENCE, data[M32_REFERENCE])
    app_module = importlib.import_module("dashboard.app")
    monkeypatch.setattr(app_module.time, "time", lambda: NOW)
    response = client.get("/targets?q=morpho-susde-usdtb-m32", base_url="http://127.0.0.1:5050",
                          environ_base={"REMOTE_ADDR": "127.0.0.1"})
    assert response.status_code == 200
    html = response.get_data(as_text=True)
    summary = html.split('<li data-target-row', 1)[1].split("</summary>", 1)[0]
    details = html.split('<div class="t-target-body">', 1)[1].split("</details>", 1)[0]
    assert "Not established" not in summary and "No valid quote" not in summary
    assert "Current quote unavailable" in summary
    assert "<strong>$213.50 modeled net</strong>" in summary
    assert "Historical local fork · block 26281701" in summary
    assert "not earned" in summary
    reference = html.split('aria-label="Historical local-fork reference"', 1)[1].split("</section>", 1)[0]
    assert "$213.50 modeled net · historical local fork" in reference
    assert "2026-10-27T04:57:10.076000+00:00" in reference and "+12 hours (43200 seconds)" in reference
    assert "Original Ethereum block" in reference and "26281701" in reference
    assert "original historical" in reference.lower() and "Not current profit" in reference
    assert ALLOWLIST[M32_REFERENCE] in reference and "221.63" not in html
    assert "$213.50 modeled net · historical local fork" in details
    assert "276.8" not in html
    request = {"base_url": "http://127.0.0.1:5050", "environ_base": {"REMOTE_ADDR": "127.0.0.1"}}
    response = client.get("/api/v1/targets?q=morpho-susde-usdtb-m32", **request)
    assert response.status_code == 200
    row = rows(response.json)["morpho-susde-usdtb-m32"]
    assert row["surplus_usd"] is None
    assert row["historical_reference"]["modeled_net_usd_display"] == "213.50"
    assert row["armed"] is None and row["observation_only"] is False
    response = client.get("/api/v1/ops", **request)
    assert response.status_code == 200
    row = rows(response.json["offensive"]["top_whales"])["morpho-susde-usdtb-m32"]
    assert row["surplus_usd"] is None
    assert row["repay_summary"] == ("11039.8 USDtb" if quoted else None)
    assert row["seized_summary"] == ("9025.94 sUSDe" if quoted else None)
    assert row["armed"] is None and row["observation_only"] is False
    assert row["executor"] == M32_EXECUTOR and row["calldata_ready"] is row["executable_now"] is False


@pytest.mark.parametrize("change", [
    lambda d: d.clear(),
    lambda d: d.update(rehearsal=[]),
    lambda d: d.update(completedAt="not-a-date"),
    lambda d: d.update(completedAt="2026-10-26T00:00:00Z"),
    lambda d: d["pin"].update(hash="bad"),
    lambda d: d["pin"].update(number="26281702"),
    lambda d: d["pin"].update(chainId=True),
    lambda d: d["rehearsal"].update(executor=M2_EXECUTOR),
    lambda d: d["rehearsal"].update(valuationBasis="CURRENT"),
    lambda d: d["rehearsal"].update(localFixture=False),
    lambda d: d["rehearsal"].update(syntheticAdvancementSeconds=None),
    lambda d: d["rehearsal"].update(fullyArmed=True),
    lambda d: d["rehearsal"].update(selected=[]),
    lambda d: d["rehearsal"]["selected"]["net"].update(usd8DecFloor="213.50"),
    lambda d: d["rehearsal"]["selected"]["net"].update(usd8DecFloor=True),
    lambda d: d["rehearsal"]["selected"]["net"].update(nativeWei="1" * 79),
    lambda d: d["rehearsal"]["selected"]["replay"].update(status="FAILED"),
])
def test_m32_invalid_reference_does_not_reuse_last_good_or_affect_current_health(root, change):
    data = m32_reference_data()
    reader = ArtifactReader(root)
    prior = rows(build(root, data, reader))["morpho-susde-usdtb-m32"]
    change(data[M32_REFERENCE])
    for view in (build(root, data, reader), build_targets(reader, NOW)):
        row = rows(view)["morpho-susde-usdtb-m32"]
        assert row["historical_reference"]["available"] is False
        assert "modeled_net_usd" not in row["historical_reference"]
        assert "missing or invalid" in row["historical_reference"]["note"]
        assert row["observation"] == prior["observation"]
    assert row["quote"] == prior["quote"] and row["quote"]["available"] is False


@pytest.mark.parametrize("missing", [False, True])
def test_m32_unreadable_or_missing_reference_is_unavailable_even_after_good_read(root, missing):
    data = m32_reference_data()
    reader = ArtifactReader(root)
    assert rows(build(root, data, reader))["morpho-susde-usdtb-m32"]["historical_reference"]["available"] is True
    path = root / ALLOWLIST[M32_REFERENCE]
    if missing:
        path.unlink()
    else:
        path.write_text("{broken-json", encoding="utf8")
    for view in (build_curated_targets(reader, NOW), build_targets(reader, NOW)):
        row = rows(view)["morpho-susde-usdtb-m32"]
        assert row["historical_reference"]["available"] is False
        assert row["quote"]["available"] is False and row["quote"]["estimate"]["gross_token_amount"] == "279.34"


@pytest.mark.parametrize("estimate", [False, True, None, "false", 0])
def test_base_accrued_flag_and_passive_countdown_survive_armed_usde_projection(root, estimate):
    data = fixtures()
    for raw in data[SENTINEL]["targets"]["base_Morpho_Whales"]:
        raw.update(healthIsEstimate=estimate, storedHealthFactor=1.01, borrowAprPct=8.5,
                   passiveHoursToCrossing=0, liquidatableNow=True)
    view = build(root, data)
    for row in view["targets"]:
        if not row["id"].startswith("base-morpho-"):
            continue
        assert row["position"]["is_estimate"] is row["health_is_estimate"] is (estimate is not False)
        assert row["position"]["borrow_apr_pct"] == "8.5"
        assert row["position"]["passive_hours"] == "0"
        assert "0.0h passive estimate" in row["passive_hours_left"]
        assert row["liquidatable_now"] is True
        armed = row["rank"] in {"#B1", "#B2"}
        assert row["status"]["code"] == ("ELIGIBLE" if armed else "OBSERVATION_ONLY")
        assert row["observation_only"] is not armed
        assert row["quote"]["available"] is False
        assert row["quote"]["gross_token_amount"] is None
        assert row["executor_address"] == (BASE_EXECUTOR if armed else None)
        assert row["runner"]["reported_armed"] is None
        assert row["executable_now"] is False and row["calldata_ready"] is armed
        assert row["observation"]["block"] == 2000
        assert row["observation"]["hash"] == "0x" + "b" * 64
        if armed:
            assert "Configured implementation only" in row["readiness_note"]
        elif estimate is False:
            assert row["readiness_note"] == "Observation only; no Base liquidator deployed or live batch approved."
        else:
            assert "unaccrued interest" in row["readiness_note"]


def test_m2_and_base_missing_rate_or_quote_facts_remain_unknown_despite_armed_setup(root):
    data = fixtures()
    m2 = data[SENTINEL]["targets"]["targetM2_Morpho_reUSD_USDC"]
    m2["liveQuote"].update(curveOutUsdc=0, seizedReusd="RAW_PRIVATE_ERROR")
    for raw in data[SENTINEL]["targets"]["base_Morpho_Whales"]:
        raw.update(healthIsEstimate=True, liquidatableNow=None, borrowAprPct=None, passiveHoursToCrossing=None)
    view = build(root, data)
    assert "RAW_PRIVATE_ERROR" not in json.dumps(view)
    m2_row = rows(view)["target-m2-morpho-reusd-usdc"]
    assert m2_row["quote"]["available"] is False
    assert m2_row["quote"]["gross_token_amount"] is None
    for row in view["targets"]:
        if row["id"].startswith("base-morpho-"):
            assert row["liquidatable_now"] is None
            assert row["health_is_estimate"] is True
            assert row["position"]["borrow_apr_pct"] is row["position"]["passive_hours"] is None
    data[SENTINEL]["generatedAt"] = iso(NOW - 4000)
    stale = rows(build(root, data))["target-m2-morpho-reusd-usdc"]
    assert stale["liquidatable_now"] is None
    assert stale["status"]["code"] == "STALE"
    assert stale["runner"]["reported_armed"] is None


@pytest.mark.parametrize("stage", ["watch", "underwater", "refill", "stale", "invalid_calldata", "invalid_market"])
def test_m7b_companion_keeps_configuration_and_buffer_evidence_without_runner_inference(root, stage):
    data = fixtures()
    underwater = stage != "watch"
    market = "0xd2630c0ebf33ba83c82e8cd400a8e6345370238ca695ce58773b2d3e43de1b0a"
    item = {
        "rank": "#M7B", "user": "0x9b1303ebf09bc51b7fac376c9e421e8daae63b82", "marketId": market,
        "pair": "ynETHx / msETH", "executor": M7_EXECUTOR,
        "observationOnly": False, "armed": True, "executableNow": stage in {"refill", "invalid_calldata"},
        "healthFactor": .999 if underwater else 1.01, "storedHealthFactor": 1.02,
        "liquidatableNow": stage == "refill", "hfUnderwaterNow": underwater,
        "bpsToLiquidation": -10.01 if underwater else 99.0099,
        "borrowAprPct": 8.5, "passiveHoursToCrossing": 0 if underwater else None,
        "collateralUsd": 24000, "debtUsd": 22000, "ynEthxBufferWeth": 60 if stage == "refill" else 0,
        "liveQuote": {"collateralSeizedFormatted": "5.69 ynETHx (buffer refill)",
                      "debtOutcomeFormatted": "+0.8612 msETH (pre-gas)", "estimatedProfitUsd": 2080.15},
    }
    parent = {**item, "rank": "#M7", "user": "0x14bcd9da052cdc6fe0b9446d5a616d5b7b4d4550",
              "healthFactor": .999, "hfUnderwaterNow": True, "observationOnly": False, "armed": True,
              "liquidatableNow": stage == "refill", "executableNow": stage == "refill",
              "liveQuote": {"estimatedProfitUsd": 4431.62}}
    if stage == "refill":
        parent["readyExecuteVaultRedeemCalldata"] = "0x12345678" + "00" * 384
        item["readyExecuteVaultRedeemCalldata"] = parent["readyExecuteVaultRedeemCalldata"]
    if stage == "invalid_calldata":
        item["readyExecuteVaultRedeemCalldata"] = "0x1234"
    if stage == "invalid_market":
        item["marketId"] = "invalid"
    data[SENTINEL]["targets"].update(targetM7_Morpho_ynETHx_msETH_Canary=parent,
                                   targetM7B_Morpho_ynETHx_msETH_0x9b13=item)
    if stage == "stale":
        data[SENTINEL]["generatedAt"] = iso(NOW - 4000)
        data[SENTINEL]["pin"] = pin(age=4010)
    curated = build(root, data)
    shortlist = build_targets(ArtifactReader(root), NOW)
    assert curated["summary"]["total"] == 26 and curated["summary"]["observation_only"] == 2
    m7 = rows(curated)["target-m7-morpho-ynethx-mseth-canary"]
    assert m7["observation_only"] is False and m7["armed"] is None
    assert m7["runner"]["label"] == "Unified Morpho M7" and m7["executor_address"] == M7_EXECUTOR
    assert m7["executable_now"] is False and m7["calldata_ready"] is (stage == "refill")
    for view in (curated, shortlist):
        ident = "target-m7b-morpho-ynethx-mseth-0x9b13"
        if view is shortlist and stage == "invalid_market":
            assert ident not in rows(view)
            continue
        row = rows(view)[ident]
        assert row["rank"] == "#M7B" and row["pair"] == "ynETHx / msETH"
        assert row["borrower_address"] == item["user"] and row["venue_address"] == MORPHO
        assert row["market_id"] == (None if stage == "invalid_market" else market)
        assert row["protocol"] == "Morpho Blue" and row["chain_id"] == 1 and row["chain_name"] == "Ethereum"
        assert row["status"]["code"] == ("STALE" if stage == "stale" else "UNKNOWN" if stage == "invalid_market" else "ELIGIBLE" if underwater else "WATCH")
        assert row["observation_only"] is False and row["armed"] is None
        assert row["calldata_ready"] is (stage == "refill")
        assert row["executable_now"] is False
        assert row["executor_address"] == M7_EXECUTOR and row["runner"]["label"] == "Unified Morpho M7"
        assert row["runner"]["reported_armed"] is None
        assert row["liquidatable_now"] is (None if stage in {"stale", "invalid_market"} else underwater)
        assert row["observation"]["source"] == SENTINEL and row["observation"]["block"] == 1000
        assert row["quote"]["available"] is False and row["quote"]["gross_token_amount"] is None
        assert row["quote"]["gross_usd"] is row["surplus_usd"] is row["gross_usd_numeric"] is None
        assert row["max_liq_profit_usd"] is None
        assert row["quote"]["estimate"]["gross_usd"] == "2080.15"
        assert "rehearsal estimates" in " ".join(row["quote"]["notes"])
        assert "Configured implementation only" in row["readiness_note"]
    reader = ArtifactReader(root)
    legacy = ops.build_top_whale_triggers(reader.read_json(SENTINEL),
        reader.read_json("aave_v4_v3_morpho_liquidator_deploy"), NOW, reader,
        SENTINEL, "aave_v4_v3_morpho_liquidator_deploy")
    row = rows(legacy)["target-m7b-morpho-ynethx-mseth-0x9b13"]
    assert row["observation_only"] is False and row["armed"] is None
    assert row["executable_now"] is False
    assert row["calldata_ready"] is (stage == "refill")


@pytest.mark.parametrize("change", [
    {"user": "0x14bcd9da052cdc6fe0b9446d5a616d5b7b4d4550"},
    {"marketId": M1_MARKET}, {"executor": M1_EXECUTOR}, {"armed": "true"},
])
def test_m7b_runner_report_requires_exact_companion_borrower_market_executor_and_boolean(root, change):
    data = fixtures()
    item = {"rank": "#M7B", "user": "0x9b1303ebf09bc51b7fac376c9e421e8daae63b82",
            "marketId": "0xd2630c0ebf33ba83c82e8cd400a8e6345370238ca695ce58773b2d3e43de1b0a",
            "pair": "ynETHx / msETH", "executor": M7_EXECUTOR, "armed": True,
            "healthFactor": .999, "hfUnderwaterNow": True, "liquidatableNow": False, "executableNow": False}
    item.update(change)
    data[SENTINEL]["targets"]["targetM7B_Morpho_ynETHx_msETH_0x9b13"] = item
    curated = build(root, data)
    shortlist = build_targets(ArtifactReader(root), NOW)
    for view in (curated, shortlist):
        row = rows(view)["target-m7b-morpho-ynethx-mseth-0x9b13"]
        assert row["runner"]["reported_armed"] is None
        assert row["runner"]["source"] is None
        assert row["executor_address"] == M7_EXECUTOR
        assert row["executable_now"] is False


@pytest.mark.parametrize("ready", [False, True])
def test_m7_curated_projection_separates_configuration_estimate_and_buffer_evidence(root, ready):
    data = fixtures()
    data[SENTINEL]["targets"]["targetM7_Morpho_ynETHx_msETH_Canary"] = {
        "rank": "#M7", "user": "0x14bcd9da052cdc6fe0b9446d5a616d5b7b4d4550",
        "marketId": "0xd2630c0ebf33ba83c82e8cd400a8e6345370238ca695ce58773b2d3e43de1b0a",
        "executor": M7_EXECUTOR, "armed": True, "healthFactor": .999, "hfUnderwaterNow": True,
        "liquidatableNow": ready, "executableNow": ready,
        "liveQuote": {"estimatedProfitUsd": 4431.62},
        **({"readyExecuteVaultRedeemCalldata": "0x12345678" + "00" * 384} if ready else {}),
    }
    row = rows(build(root, data))["target-m7-morpho-ynethx-mseth-canary"]
    assert row["observation_only"] is False
    assert row["armed"] is row["runner"]["reported_armed"] is None
    assert row["executor_address"] == M7_EXECUTOR
    assert row["runner"]["label"] == "Unified Morpho M7"
    assert row["runner"]["source"] is None
    assert row["status"]["code"] == "ELIGIBLE"  # Underwater even while the buffer is empty.
    assert row["executable_now"] is False and row["calldata_ready"] is ready
    assert row["max_liq_profit_usd"] is None
    assert row["quote"]["estimate"]["gross_usd"] == "4431.62"
    assert row["quote"]["available"] is False  # Rehearsal estimate is not a current exit quote.


@pytest.mark.parametrize("change", [
    lambda d, r: r.update(user=UNIFIED),
    lambda d, r: r.update(marketId=M1_MARKET),
    lambda d, r: r.update(deployedExecutor=M1_EXECUTOR),
    lambda d, r: r.update(armed="true"),
    lambda d, r: r.pop("armed"),
    lambda d, r: d[SENTINEL].update(generatedAt=iso(NOW - 4000)),
    lambda d, r: d[SENTINEL].update(ok=False),
])
def test_m2_curated_armed_telemetry_requires_fresh_exact_identity_and_boolean(root, change):
    data = fixtures()
    change(data, data[SENTINEL]["targets"]["targetM2_Morpho_reUSD_USDC"])
    row = rows(build(root, data))["target-m2-morpho-reusd-usdc"]
    assert row["runner"]["reported_armed"] is None
    assert row["executor_address"] == M2_EXECUTOR


def test_actual_producer_pins_and_nine_ids_report_all_19_scoped_runners(root):
    data = producer_fixtures()
    assert [target["id"] for target in data[V4_WATCH]["targets"]] == V4_IDS
    assert all("chainId" not in data[key]["pin"] and "utc" not in data[key]["pin"] for key in (V3_WATCH, V4_WATCH))
    view = build(root, data)
    v4 = [r for r in view["targets"] if r["protocol"] == "Aave V4"]
    v3 = [r for r in view["targets"] if r["protocol"] == "Aave V3"]
    m1 = rows(view)["target-m1-morpho-usde-dai"]
    assert len(v4) == len(v3) == 9
    for row in v4 + v3 + [m1]:
        assert row["runner"]["freshness"] == "FRESH"
        assert row["runner"]["reported_armed"] is True
        summary = view["runners"]["v4" if row in v4 else "v3"]
        assert summary["freshness"] == row["runner"]["freshness"]
        assert summary["age_text"] == row["runner"]["age_text"] == "15s"
        assert summary["block_number"] == 1001
        assert row["quote"]["block"] == 1000
        assert row["quote"]["utc"] == iso(NOW - 20)
    for row in v4:
        assert row["executor_address"] == DEDICATED
        assert row["observation"]["block"] == 1001
        assert row["observation"]["hash"] == "0x" + "d" * 64
        assert row["observation"]["utc"] == iso(NOW - 15)
        assert row["observation"]["source"] == V4_WATCH
    assert rows(view)["spoke-c-4"]["borrower_address"] == V3_A  # Actual candidate4 ID belongs to #C5.


def test_actual_v4_matching_is_independent_of_ids_and_array_order(root):
    data = producer_fixtures()
    data[V4_WATCH]["targets"].reverse()
    data[SENTINEL]["targets"]["spokeC_AaveV4_weETH_WETH"].reverse()
    # Swapping two recognized IDs must not swap the full-identity health bindings.
    first, last = data[V4_WATCH]["targets"][0], data[V4_WATCH]["targets"][-1]
    first["id"], last["id"] = last["id"], first["id"]
    expected = {(t["borrower"], t["spoke"]): t for t in data[V4_WATCH]["targets"]}
    view = build(root, data)
    for row in view["targets"]:
        if row["protocol"] != "Aave V4":
            continue
        target = expected[(row["borrower_address"], row["venue_address"])]
        assert row["liquidatable_now"] is target["isLiquidatableBothProviders"]
        assert row["bps_numeric"] == float(target["bpsToLiquidation"])
        assert row["runner"]["reported_armed"] is True
        assert row["executor_address"] == DEDICATED


@pytest.mark.parametrize("watch", [V3_WATCH, V4_WATCH])
@pytest.mark.parametrize("field,value", [
    ("chainId", 8453), ("chainId", True), ("chainId", None), ("chainId", "1"),
    ("timestamp", None), ("timestamp", True), ("timestamp", "1792451975"), ("timestamp", -1), ("timestamp", 0),
    ("timestamp", NOW - 5.5), ("timestamp", float("inf")), ("timestamp", 1792451975000), ("timestamp", NOW + 301),
    ("hash", None), ("hash", "0x" + "g" * 64), ("hash", "0x" + "a" * 63),
    ("utc", None), ("utc", iso(NOW - 100)),
])
def test_actual_runner_invalid_pin_never_reports_fresh_or_armed(root, watch, field, value):
    data = producer_fixtures()
    data[watch]["pin"][field] = value
    view = build(root, data)
    summary = view["runners"]["v4" if watch == V4_WATCH else "v3"]
    assert summary["freshness"] == "UNKNOWN"
    for row in view["targets"]:
        if row["runner"]["label"] not in LIVE_RUNNER_LABELS or (row["protocol"] == "Aave V4") != (watch == V4_WATCH):
            continue
        assert row["runner"]["reported_armed"] is None
        assert row["runner"]["freshness"] == summary["freshness"]
        assert row["runner"]["age_text"] == summary["age_text"]
        if watch == V4_WATCH:
            assert row["observation"]["source"] == SENTINEL


@pytest.mark.parametrize("watch", [V3_WATCH, V4_WATCH])
@pytest.mark.parametrize("field", ["timestamp", "hash"])
def test_actual_runner_missing_required_pin_field_is_unknown(root, watch, field):
    data = producer_fixtures(); del data[watch]["pin"][field]
    view = build(root, data)
    assert view["runners"]["v4" if watch == V4_WATCH else "v3"]["freshness"] == "UNKNOWN"
    assert view["runners"]["v4" if watch == V4_WATCH else "v3"]["age_text"] is None
    for row in view["targets"]:
        if row["runner"]["label"] in LIVE_RUNNER_LABELS and (row["protocol"] == "Aave V4") == (watch == V4_WATCH):
            assert row["runner"]["reported_armed"] is None
            assert row["runner"]["age_text"] is None
            assert row["runner"]["checked_at"] == iso(NOW - 5)


@pytest.mark.parametrize("reason", ["NEXT_BLOCK_PROVIDER_DISAGREEMENT", "UNSUPPORTED_REASON", "https://private.invalid/SECRET", {"error": "SECRET"}])
def test_blocked_shared_runner_exposes_only_scoped_allowlisted_reason_and_attempt_time(root, reason):
    data = producer_fixtures()
    watch = data[V3_WATCH]
    watch.update(ok=False, armed=False, mode="BLOCKED", reason=reason, checkedAt=iso(NOW))
    watch.pop("pin")
    curated = build(root, data)
    for view in (curated, build_targets(ArtifactReader(root), NOW)):
        row = rows(view)["target2a-aavev3-weeth-weth-0x7231"]
        runner = row["runner"]
        recognized = reason == "NEXT_BLOCK_PROVIDER_DISAGREEMENT"
        expected = "Shared runner blocked: provider disagreement." if recognized else "Shared runner blocked; no supported reason is available."
        assert runner["mode"] == "BLOCKED" and runner["reported_armed"] is None
        assert runner["freshness"] == "UNKNOWN" and runner["age_text"] is None
        assert runner["checked_at"] == iso(NOW)
        assert runner["reason_code"] == (reason if recognized else None)
        assert runner["reason_text"] == expected
        assert expected in runner["notes"] and expected in row["blockers"]
        assert row["observation"]["freshness"] == "FRESH"  # Independent health stays usable.
        assert rows(view)["target-1-aave-v4-usde-usdc"]["runner"]["reason_text"] is None
        assert not any(token in json.dumps(view) for token in ("SECRET", "private.invalid", "UNSUPPORTED_REASON"))


def test_blocked_reason_does_not_follow_unscoped_or_recovered_runner(root):
    data = producer_fixtures()
    watch = data[V3_WATCH]
    watch.update(ok=False, armed=False, mode="BLOCKED", reason="NEXT_BLOCK_PROVIDER_DISAGREEMENT", partition="UNRELATED")
    for recovered in (False, True):
        if recovered:
            watch.update(ok=True, armed=True, mode="EXECUTE_IF_LIQUIDATABLE", partition="V3_ONLY")
        build(root, data)
        row = rows(build_targets(ArtifactReader(root), NOW))["target2a-aavev3-weeth-weth-0x7231"]
        assert row["runner"]["reason_code"] is row["runner"]["reason_text"] is None
        assert row["runner"]["reported_armed"] is (True if recovered else None)
        assert "provider disagreement" not in " ".join(row["blockers"] + row["runner"]["notes"])


@pytest.mark.parametrize("reason", ["NEXT_BLOCK_PROVIDER_DISAGREEMENT", "https://private.invalid/SECRET"])
def test_minimal_shared_runner_failure_is_source_level_only(root, client, monkeypatch, reason):
    data = producer_fixtures()
    data[V3_WATCH] = {"ok": False, "armed": False, "mode": "BLOCKED", "checkedAt": iso(NOW), "reason": reason}
    expected = ("Shared runner blocked: provider disagreement." if reason == "NEXT_BLOCK_PROVIDER_DISAGREEMENT"
                else "Shared runner blocked; no supported reason is available.")
    curated = build(root, data)
    for view in (curated, build_targets(ArtifactReader(root), NOW)):
        affected = [row for row in view["targets"] if row["runner"]["mode"] == "BLOCKED"]
        assert len(affected) == 10
        for row in affected:
            runner = row["runner"]
            assert runner["reason_text"] == expected
            assert runner["reason_code"] == (reason if reason == "NEXT_BLOCK_PROVIDER_DISAGREEMENT" else None)
            assert runner["reported_armed"] is runner["source"] is runner["age_text"] is None
            assert runner["freshness"] == "UNKNOWN" and runner["checked_at"] == iso(NOW)
            assert runner.get("held") is not True
            assert row["observation"]["freshness"] == "FRESH"
            assert expected in runner["notes"] and expected in row["blockers"]
            assert any("before runner scope and pin were established" in note for note in runner["notes"])
        assert "SECRET" not in json.dumps(view) and "private.invalid" not in json.dumps(view)
    monkeypatch.setattr(importlib.import_module("dashboard.app").time, "time", lambda: NOW)
    html = client.get("/targets", base_url="http://127.0.0.1:5050", environ_base={"REMOTE_ADDR": "127.0.0.1"}).get_data(as_text=True)
    assert expected in html and "SECRET" not in html and "private.invalid" not in html


@pytest.mark.parametrize("field,value", [("partition", "UNRELATED"), ("liquidatorAddress", DEDICATED),
                                         ("morphoExecution", "DISABLED_OBSERVATION_ONLY"), ("pin", None)])
def test_minimal_shared_failure_fallback_does_not_repair_present_scope_fields(root, field, value):
    data = producer_fixtures()
    data[V3_WATCH] = {"ok": False, "armed": False, "mode": "BLOCKED", "checkedAt": iso(NOW),
                      "reason": "NEXT_BLOCK_PROVIDER_DISAGREEMENT", field: value}
    curated = build(root, data)
    for view in (curated, build_targets(ArtifactReader(root), NOW)):
        runner = rows(view)["target2a-aavev3-weeth-weth-0x7231"]["runner"]
        assert runner["reason_code"] is runner["reason_text"] is runner["reported_armed"] is runner["source"] is None


def test_successful_zero_age_pin_is_not_hidden(root):
    data = producer_fixtures()
    for key in (V3_WATCH, V4_WATCH):
        data[key]["checkedAt"] = iso(NOW)
        data[key]["pin"]["timestamp"] = NOW
    view = build(root, data)
    for row in view["targets"]:
        if row["runner"]["label"] in LIVE_RUNNER_LABELS:
            assert row["runner"]["freshness"] == "FRESH"
            assert row["runner"]["age_text"] == "0s"


def test_unified_aave_and_spark_labels_preserve_actual_morpho_label(root):
    from dashboard.targets import SINGLES, SPARK_POOL, SPARK_WHALE_BINDINGS, UNIFIED_EXECUTOR, V3_WHALE_BINDINGS
    data = producer_fixtures()
    data[V3_WATCH]["liquidatorAddress"] = UNIFIED_EXECUTOR
    for bindings, pool, pair in ((V3_WHALE_BINDINGS, POOL, "weETH / WETH"),
                                 (SPARK_WHALE_BINDINGS, SPARK_POOL, "wstETH / WETH (SparkLend)")):
        for ident, (rank, user) in bindings.items():
            name = next(name for name, value in SINGLES.items() if value == ident)
            data[SENTINEL]["targets"][name] = {"rank": rank, "user": user, "pool": pool, "pair": pair,
                "healthFactor": 1.01, "liquidatableNow": False}
    curated = build(root, data)
    for view in (curated, build_targets(ArtifactReader(root), NOW)):
        indexed = rows(view)
        for bindings, label in ((V3_WHALE_BINDINGS, "Aave V3"), (SPARK_WHALE_BINDINGS, "SparkLend")):
            for ident, (rank, _) in bindings.items():
                assert indexed[ident]["runner"]["label"] == f"Unified {label} {rank[1:]}"
        assert indexed["target-m1-morpho-usde-dai"]["runner"]["label"] == "Unified Morpho M1"


def test_actual_runner_stale_pin_controls_row_and_summary_age_even_with_fresh_check(root):
    data = producer_fixtures()
    for key in (V3_WATCH, V4_WATCH):
        data[key]["pin"]["timestamp"] = NOW - 4000
    view = build(root, data)
    for row in view["targets"]:
        if row["runner"]["label"] in LIVE_RUNNER_LABELS:
            summary = view["runners"]["v4" if row["protocol"] == "Aave V4" else "v3"]
            assert row["runner"]["freshness"] == summary["freshness"] == "STALE"
            assert row["runner"]["age_text"] == summary["age_text"] == "66m"
            assert row["runner"]["reported_armed"] is None


@pytest.mark.parametrize("index", range(9))
@pytest.mark.parametrize("field", ["borrower", "spoke"])
def test_actual_v4_wrong_full_identity_never_claims_target_scope(root, index, field):
    data = producer_fixtures()
    data[V4_WATCH]["targets"][index][field] = UNIFIED
    row = rows(build(root, data))["target-1-aave-v4-usde-usdc" if index == 0 else f"spoke-c-{index - 1}"]
    assert row["runner"]["reported_armed"] is None
    assert row["executor_address"] != DEDICATED
    assert row["observation"]["source"] == SENTINEL


@pytest.mark.parametrize("duplicate", ["within_watch", "beyond_nine", "sentinel"])
def test_ambiguous_full_identity_matches_fail_closed(root, duplicate):
    data = producer_fixtures()
    if duplicate == "within_watch":
        data[V4_WATCH]["targets"][2] = copy.deepcopy(data[V4_WATCH]["targets"][1])
        data[V4_WATCH]["targets"][2]["id"] = V4_IDS[2]
    elif duplicate == "beyond_nine":
        data[V4_WATCH]["targets"].append(copy.deepcopy(data[V4_WATCH]["targets"][1]))
    else:
        data[SENTINEL]["targets"]["spokeC_AaveV4_weETH_WETH"][1] = copy.deepcopy(data[SENTINEL]["targets"]["spokeC_AaveV4_weETH_WETH"][0])
    view = build(root, data)
    for ident in ("spoke-c-0", "spoke-c-1"):
        row = rows(view)[ident]
        assert row["runner"]["reported_armed"] is None
        assert row["executor_address"] != DEDICATED
        assert row["observation"]["source"] == SENTINEL
    if duplicate == "beyond_nine":
        assert all(row["runner"]["reported_armed"] is None for row in view["targets"] if row["protocol"] == "Aave V4")


@pytest.mark.parametrize("armed", [None, False, "true"])
def test_actual_19_runners_require_explicit_boolean_armed(root, armed):
    data = producer_fixtures()
    for key in (V3_WATCH, V4_WATCH):
        if armed is None:
            del data[key]["armed"]
        else:
            data[key]["armed"] = armed
    relevant = [row for row in build(root, data)["targets"] if row["runner"]["label"] in LIVE_RUNNER_LABELS]
    assert len(relevant) == 19
    for row in relevant:
        assert row["runner"]["reported_armed"] is (False if armed is False else None)


def test_runner_pin_normalization_is_not_applied_to_sentinel_or_base(root):
    data = producer_fixtures()
    data[SENTINEL]["pin"] = copy.deepcopy(data[V3_WATCH]["pin"])
    data[SENTINEL]["baseObservation"]["pin"] = copy.deepcopy(data[V3_WATCH]["pin"])
    view = build(root, data)
    assert view["freshness"] == "UNKNOWN"
    assert view["pin_block"] is view["pin_utc"] is None
    for ident in ("target-m1-morpho-usde-dai", "base-morpho-0"):
        observation = rows(view)[ident]["observation"]
        assert observation["freshness"] == "UNKNOWN"
        assert observation["block"] is observation["utc"] is observation["hash"] is None


def test_routes_are_get_only_loopback_no_side_effects_or_dynamic_reads(root, monkeypatch):
    from dashboard.target_sources import TRADE_SOURCES, NEAR_BINDINGS, NEAR_IDENTITIES, NEAR_WATCH
    app_module = importlib.import_module("dashboard.app")
    for key, value in fixtures().items():
        put(root, key, value)
    put(root, NEAR_IDENTITIES, {"chainId": 1, "actions": [
        {"targetId": ident, "spoke": spoke, "borrower": borrower, "executor": executor}
        for ident, (spoke, borrower, executor) in NEAR_BINDINGS.items()]})
    put(root, NEAR_WATCH, {"checkedAt": iso(NOW - 5), "ok": False, "armed": False, "mode": "BLOCKED",
                          "enabledTargetIds": [], "armedTargetIds": [],
                          "heldTargets": [{"targetId": "rank2_wsteth_weth_0x4cd7"}]})
    before = {p: p.read_bytes() for p in root.rglob("*.json")}
    calls, rendered = [], []
    original = ArtifactReader.read_target_json

    def fixed_read(self, key, **kwargs):
        assert key in {s.id for s in TRADE_SOURCES}
        calls.append(key)
        return original(self, key, **kwargs)

    def forbidden(*args, **kwargs):
        pytest.fail("Targets route attempted a side effect or aggregate builder")

    monkeypatch.setattr(ArtifactReader, "read_target_json", fixed_read)
    monkeypatch.setattr(ArtifactReader, "read_target_index", forbidden)
    monkeypatch.setattr(ops, "build_ops", forbidden)
    monkeypatch.setattr(app_module, "build_ops", forbidden)
    monkeypatch.setattr(app_module, "snapshot", forbidden)
    monkeypatch.setattr(subprocess, "run", forbidden)
    monkeypatch.setattr(subprocess, "Popen", forbidden)
    monkeypatch.setattr(socket, "create_connection", forbidden)
    monkeypatch.setattr(app_module.time, "time", lambda: NOW)
    monkeypatch.setattr(app_module, "render_template", lambda name, **kw: rendered.append((name, kw)) or "targets template stub")
    client = app_module.create_app(root).test_client(use_cookies=False)
    request = {"base_url": "http://127.0.0.1:5050", "environ_base": {"REMOTE_ADDR": "127.0.0.1"}}
    query = "?source=../../.env&protocol=none&view_mode=inventory&trade_candidates=false"
    response = client.get("/api/v1/targets" + query, **request)
    assert response.status_code == 200
    assert response.json["summary"]["total"] == 26
    assert response.json["view_mode"] == "trade_candidates"
    assert calls == [s.id for s in TRADE_SOURCES]
    assert {s["id"] for s in response.json["coverage"]["sources"]} == set(calls)
    assert {s["value"] for s in response.json["options"]["sources"]} == set(calls)
    assert all(r["record_type"] == "position" and r["borrower_address"] for r in response.json["targets"])
    assert "target-3-morpho-paxg-usdc" not in rows(response.json)
    assert response.headers["Cache-Control"] == "no-store"
    assert "default-src 'self'" in response.headers["Content-Security-Policy"]
    assert client.get("/targets" + query, **request).status_code == 200
    assert rendered[0][0] == "targets.html"
    assert rendered[0][1]["data"] == response.json
    filtered = client.get("/api/v1/targets?chain=Base&page_size=1", **request)
    assert filtered.json["summary"]["total"] == 26
    assert filtered.json["pagination"]["filtered_total"] == 3
    assert len(filtered.json["targets"]) == 1
    assert client.get("/api/v1/targets?q=" + "x" * 4097, **request).json == {"ok": False, "reason": "BAD_REQUEST", "status": 400}
    assert client.get("/targets?q=" + "x" * 4097, **request).status_code == 400
    for path in ("/targets", "/api/v1/targets"):
        assert client.post(path, **request).status_code == 405
        assert client.get(path, base_url="http://evil.example", environ_base={"REMOTE_ADDR": "127.0.0.1"}).status_code == 403
        assert client.get(path, base_url="http://127.0.0.1:5050", environ_base={"REMOTE_ADDR": "10.0.0.1"}).status_code == 403
    assert {p: p.read_bytes() for p in root.rglob("*.json")} == before


@pytest.mark.parametrize("hold_age", [20, 1800])
def test_aggregate_fresh_near_hold_overrides_newer_dedicated_armed_not_protocol_health(root, hold_age):
    from dashboard.target_sources import NEAR_BINDINGS, NEAR_WATCH
    ident = "rank2_wsteth_weth_0x4cd7"
    spoke, borrower, executor = NEAR_BINDINGS[ident]
    data = fixtures()
    data[SENTINEL]["targets"]["target1_AaveV4_USDe_USDC"].update(user=borrower, spoke=spoke)
    data[V4_WATCH]["targets"][0].update(borrower=borrower, spoke=spoke)
    data[V4_WATCH].update(checkedAt=iso(NOW - 2), blockNumber=1002, pin=pin(block=1002, age=2, digit="d"))
    data[NEAR_WATCH] = {"ok": True, "armed": True, "mode": "EXECUTE_IF_LIQUIDATABLE", "checkedAt": iso(NOW - hold_age),
                        "pin": pin(age=hold_age), "enabledTargetIds": [], "armedTargetIds": [], "heldTargets": [{"targetId": ident}],
                        "targets": [{"id": ident, "borrower": borrower, "spoke": spoke, "executor": executor,
                                     "healthFactorRaw": "1010000000000000000", "isLiquidatableBothProviders": False}]}
    for key, value in data.items():
        put(root, key, value)
    row = rows(build_targets(ArtifactReader(root), NOW))["target-1-aave-v4-usde-usdc"]
    assert row["protocol_status"] == "ELIGIBLE" and row["observation"]["source"] == V4_WATCH
    if hold_age == 20:
        assert row["status"]["code"] == "HELD"
        assert row["runner"]["held"] is True and row["runner"]["reported_armed"] is False
        assert row["runner"]["checked_at"] == iso(NOW - hold_age)
    else:
        assert row["status"]["code"] == "ELIGIBLE"
        assert row["runner"]["held"] is not True and row["runner"]["reported_armed"] is True


@pytest.mark.parametrize("invalid", ["root-failed", "eth-chain-absent", "base-eth-pin-without-chain", "base-incomplete"])
def test_aggregate_sentinel_requires_explicit_chain_and_complete_success(root, invalid):
    state = fixtures()[SENTINEL]
    if invalid == "root-failed":
        state["ok"] = False
    elif invalid == "eth-chain-absent":
        del state["pin"]["chainId"]
    elif invalid == "base-eth-pin-without-chain":
        state["baseObservation"]["pin"] = dict(state["pin"])
        del state["baseObservation"]["pin"]["chainId"]
    else:
        state["baseObservation"]["status"] = "INCOMPLETE"
    put(root, SENTINEL, state)
    view = build_targets(ArtifactReader(root), NOW)
    assert view["summary"]["total"] == 23
    for row in view["targets"]:
        affected = invalid == "root-failed" or (row["chain_id"] == 8453 if invalid.startswith("base-") else row["chain_id"] == 1)
        if affected:
            assert row["protocol_status"] == "UNKNOWN"
            assert row["health_factor"] is row["liquidatable_now"] is None
            assert row["observation"]["block"] is row["observation"]["hash"] is None


@pytest.mark.parametrize("pin_age", [15, 4000])
def test_aggregate_unified_source_filter_attributes_only_ten_scoped_rows_and_runner_age(root, pin_age):
    data = fixtures()
    data[V3_WATCH]["pin"] = pin(block=1001, age=pin_age, digit="d")
    for key, value in data.items():
        put(root, key, value)
    view = build_targets(ArtifactReader(root), NOW, {"source": V3_WATCH})
    assert view["summary"]["total"] == 23 and view["pagination"]["filtered_total"] == 10
    assert sum(r["protocol"] == "Aave V3" for r in view["targets"]) == 9
    assert sum(r["protocol"] == "Morpho Blue" for r in view["targets"]) == 1
    for row in view["targets"]:
        assert row["observation"]["source"] == SENTINEL and row["observation"]["block"] == 1000
        provenance = next(p for p in row["provenance"] if p["source"] == V3_WATCH)
        assert provenance["generated_at"] == data[V3_WATCH]["checkedAt"]
        assert provenance["block"] == 1001
        assert provenance["freshness"] == row["runner"]["freshness"] == ("FRESH" if pin_age == 15 else "STALE")
        assert provenance["age_text"] == row["runner"]["age_text"] == ("15s" if pin_age == 15 else "66m")


@pytest.mark.parametrize("failure", ["scope", "noncurrent"])
def test_aggregate_unified_attribution_cannot_follow_label_candidate_count_or_cached_value(root, failure):
    data = fixtures()
    for key, value in data.items():
        put(root, key, value)
    reader = ArtifactReader(root)
    assert build_targets(reader, NOW, {"source": V3_WATCH})["pagination"]["filtered_total"] == 10
    if failure == "scope":
        data[V3_WATCH].update(partition="UNRELATED", morphoExecution="DISABLED_OBSERVATION_ONLY", candidateCount=999999)
        put(root, V3_WATCH, data[V3_WATCH])
    else:
        (root / ALLOWLIST[V3_WATCH]).write_text("{invalid", encoding="utf8")
    view = build_targets(reader, NOW, {"source": V3_WATCH})
    assert view["summary"]["total"] == 23 and view["pagination"]["filtered_total"] == 0


@pytest.mark.parametrize("stage", ["observation", "stale", "incomplete"])
def test_shortlist_keeps_m2_and_base_borrowers_in_actual_observation_stages(root, stage):
    data = fixtures()
    if stage == "stale":
        data[SENTINEL]["generatedAt"] = iso(NOW - 4000)
        data[SENTINEL]["pin"] = pin(age=4010)
        data[SENTINEL]["baseObservation"]["pin"] = pin(8453, 2000, 4010, "b")
    elif stage == "incomplete":
        data[SENTINEL]["ok"] = False
        data[SENTINEL]["baseObservation"]["status"] = "INCOMPLETE"
    for key, value in data.items():
        put(root, key, value)
    view = build_targets(ArtifactReader(root), NOW)
    assert view["summary"]["total"] == 23
    indexed = rows(view)
    assert "target-3-morpho-paxg-usdc" not in indexed
    m2 = indexed["target-m2-morpho-reusd-usdc"]
    assert (m2["borrower_address"], m2["market_id"], m2["chain_id"]) == (M2_USER, M2_MARKET, 1)
    for ident in ("target-m2-morpho-reusd-usdc", "base-morpho-0", "base-morpho-1", "base-morpho-2"):
        row = indexed[ident]
        observation_only = ident == "base-morpho-2"
        assert row["status"]["code"] == ("OBSERVATION_ONLY" if observation_only else "ELIGIBLE" if stage == "observation" else "STALE" if stage == "stale" else "UNKNOWN")
        assert row["executable_now"] is False  # Aggregated shortlist never asserts execution readiness.
        assert row["executor_address"] == (None if observation_only else M2_EXECUTOR if ident.startswith("target-m2") else BASE_EXECUTOR)
        expected_armed = None if observation_only else (True if stage == "observation" else None if ident.startswith("target-m2") else False)
        assert row["runner"]["reported_armed"] is None
        if observation_only:
            assert row["readiness_note"] in row["blockers"]
        if stage == "stale":
            assert row["protocol_status"] == "STALE"
            assert any("aged" in b for b in row["blockers"])
        elif stage == "incomplete":
            assert row["protocol_status"] == "UNKNOWN" and row["health_factor"] is None
    assert not any("profit" in key for key in view["summary"])


def test_shortlist_canonical_dedup_retains_chain_market_protocol_and_near_scopes(root):
    from dashboard.target_sources import NEAR_BINDINGS, NEAR_IDENTITIES
    data = fixtures()
    target = data[SENTINEL]["targets"]
    spoke, borrower, _ = next(iter(NEAR_BINDINGS.values()))
    target["target1_AaveV4_USDe_USDC"].update(user=borrower, spoke=spoke)
    target["spokeC_AaveV4_weETH_WETH"][0].update(user=borrower.upper().replace("0X", "0x"), spoke=spoke)
    target["targetM2_Morpho_reUSD_USDC"]["user"] = M1_USER
    target["base_Morpho_Whales"][0].update(user=M1_USER, marketId=M1_MARKET)
    data[NEAR_IDENTITIES] = {"chainId": 1, "actions": [
        {"targetId": ident, "spoke": s, "borrower": b, "executor": e} for ident, (s, b, e) in NEAR_BINDINGS.items()]}
    for key, value in data.items():
        put(root, key, value)
    view = build_targets(ArtifactReader(root), NOW)
    assert view["summary"]["total"] == len({row["position_key"] for row in view["targets"]}) == 24
    merged = next(row for row in view["targets"] if row["borrower_address"] == borrower)
    assert set(merged["source_ids"]) == {SENTINEL, NEAR_IDENTITIES}
    assert merged["id"] == "target-1-aave-v4-usde-usdc"
    same_borrower = [row for row in view["targets"] if row["borrower_address"] == M1_USER]
    assert {(row["chain_id"], row["market_id"]) for row in same_borrower} == {(1, M1_MARKET), (1, M2_MARKET), (8453, M1_MARKET)}
    assert {row["protocol"] for row in view["targets"] if row["borrower_address"] == V3_B} == {"Aave V3", "Aave V4"}
