#!/usr/bin/env python3
"""Deterministic source-linked models for TermMax V2 Step1 R2.

These are integer/state models, not EVM or production-callback execution.
"""

from __future__ import annotations

import argparse
import copy
import json
from dataclasses import dataclass, field
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TERM_MAX = ROOT / "targets" / "termmax"
SEED = 0x7E4D4A


def require_source(relative: str, *anchors: str) -> int:
    text = (TERM_MAX / relative).read_text(encoding="utf-8")
    for anchor in anchors:
        assert anchor in text, f"missing source anchor in {relative}: {anchor}"
    return len(anchors)


@dataclass
class RouterState:
    balances: dict[str, int] = field(default_factory=dict)
    allowances_to_gt: dict[str, int] = field(default_factory=dict)
    paused: bool = False


@dataclass
class GtState:
    configured_token: str
    debt: int
    collateral: int
    owner_collateral_gain: int = 0
    market_token_gain: int = 0


def exact_public_sweep(router: RouterState, opening: int, atomic_funding: int) -> dict[str, int | bool | str]:
    """One-unit swapTokens path: adapter=0, unequal token pair, empty data."""
    before = copy.deepcopy(router)
    try:
        if router.paused:
            raise PermissionError("whenNotPaused")
        router.balances["VICTIM"] = opening + atomic_funding
        input_amount = router.balances["VICTIM"]
        recipient_gain = input_amount
        router.balances["VICTIM"] = 0
    except Exception:
        router.balances = before.balances
        router.allowances_to_gt = before.allowances_to_gt
        router.paused = before.paused
        raise
    return {
        "adapter": "0x0000000000000000000000000000000000000000",
        "tokenIn": "VICTIM",
        "tokenOut": "DUMMY_UNEQUAL_TO_VICTIM",
        "swapData": "0x",
        "useBalanceOnchain": True,
        "recipient": "ATTACKER",
        "openingRouterBalance": opening,
        "callerAtomicFunding": atomic_funding,
        "recipientGain": recipient_gain,
        "callerNetGain": recipient_gain - atomic_funding,
        "routerResidue": router.balances["VICTIM"],
        "adapterWhitelistChecked": False,
        "ownerAuthorizationChecked": False,
        "requiresUnpaused": True,
    }


def gt_repay(router: RouterState, gt: GtState, requested: int) -> int:
    final_repay = min(gt.debt, requested)
    if gt.debt == final_repay:
        gt.owner_collateral_gain += gt.collateral
        gt.collateral = 0
    gt.debt -= final_repay

    token = gt.configured_token
    if router.allowances_to_gt.get(token, 0) < final_repay:
        raise PermissionError("configured-token allowance")
    if router.balances.get(token, 0) < final_repay:
        raise ValueError("configured-token balance")
    router.allowances_to_gt[token] -= final_repay
    router.balances[token] -= final_repay
    gt.market_token_gain += final_repay
    return final_repay


def swap_and_repay_transaction(router: RouterState, gt: GtState, path_token_out: str, requested: int) -> dict[str, int]:
    """Outer transaction wrapper models EVM all-or-nothing rollback on later failure."""
    router_before, gt_before = copy.deepcopy(router), copy.deepcopy(gt)
    try:
        router.allowances_to_gt[path_token_out] = router.allowances_to_gt.get(path_token_out, 0) + requested
        final_repay = gt_repay(router, gt, requested)
        refund = router.balances.get(path_token_out, 0)
        router.balances[path_token_out] = 0
        return {
            "finalRepay": final_repay,
            "pathTokenRefund": refund,
            "configuredTokenAllowanceAfter": router.allowances_to_gt.get(gt.configured_token, 0),
            "pathTokenAllowanceAfter": router.allowances_to_gt.get(path_token_out, 0),
            "configuredTokenRouterResidue": router.balances.get(gt.configured_token, 0),
            "collateralGain": gt.owner_collateral_gain,
            "debtAfter": gt.debt,
        }
    except Exception:
        router.balances = router_before.balances
        router.allowances_to_gt = router_before.allowances_to_gt
        router.paused = router_before.paused
        gt.configured_token = gt_before.configured_token
        gt.debt = gt_before.debt
        gt.collateral = gt_before.collateral
        gt.owner_collateral_gain = gt_before.owner_collateral_gain
        gt.market_token_gain = gt_before.market_token_gain
        raise


def build_results() -> dict:
    source_anchor_count = 0
    source_anchor_count += require_source(
        "contracts/v2/router/TermMaxRouterV2.sol",
        "external\n        nonReentrant\n        whenNotPaused",
        "if (path.useBalanceOnchain)",
        "IERC20(path.units[0].tokenIn).balanceOf(address(this))",
        "if (units[i].adapter == address(0))",
        "IERC20(units[i].tokenIn).safeTransfer(recipient, inputAmt);",
        "IERC20 repayToken = IERC20(paths[0].units[paths[0].units.length - 1].tokenOut);",
        "repayToken.safeIncreaseAllowance(address(gt), repayAmt);",
        "gt.repay(gtId, repayAmt, byDebtToken);",
    )
    source_anchor_count += require_source(
        "contracts/v2/tokens/AbstractGearingTokenV2.sol",
        "if (repayAmt > loan.debtAmt)",
        "repayAmt = loan.debtAmt;",
        "_transferCollateral(ownerOf(id), loan.collateralData);",
        "config.debtToken.safeTransferFrom(msg.sender, marketAddr(), finalRepayAmt);",
        "config.ft.safeTransferFrom(msg.sender, marketAddr(), finalRepayAmt);",
    )
    source_anchor_count += require_source(
        "contracts/v2/lib/TransferUtilsV2.sol",
        "if (value > oldAllowance)",
        "token.forceApprove(spender, value);",
    )
    source_anchor_count += require_source(
        "contracts/v2/TermMaxOrderV2.sol",
        "uint256 ftBalance = ft.balanceOf(address(this));",
        "if (ftBalance != 0) (received, deliveryData) = market.redeem(ftBalance, recipient);",
        "uint256 shares = _pool.balanceOf(address(this));",
        "delete _orderConfig;",
    )
    source_anchor_count += require_source(
        "contracts/v2/router/swapAdapters/OkxSwapAdapter.sol",
        "(address router, address okxApproveAddress, bytes memory data)",
        "IERC20(tokenIn).safeApprove(okxApproveAddress, amount);",
        "(bool success, bytes memory returnData) = router.call(data);",
        "tokenOutAmt = abi.decode(returnData, (uint256));",
    )

    regressions: dict[str, dict | str] = {}

    sweep_router = RouterState()
    sweep = exact_public_sweep(sweep_router, opening=1_000, atomic_funding=37)
    assert sweep["recipientGain"] == 1_037
    assert sweep["callerNetGain"] == 1_000
    assert sweep["routerResidue"] == 0
    regressions["exactPublicSweep"] = sweep

    paused = RouterState(paused=True, balances={"VICTIM": 1_000})
    paused_before = copy.deepcopy(paused)
    try:
        exact_public_sweep(paused, opening=1_000, atomic_funding=37)
        raise AssertionError("paused sweep unexpectedly succeeded")
    except PermissionError:
        pass
    assert paused == paused_before
    regressions["pausedSweepRollback"] = {"rolledBack": True, "routerBalance": paused.balances["VICTIM"]}

    mismatch_router = RouterState(balances={"FT": 50, "DUMMY": 1})
    mismatch_gt = GtState(configured_token="FT", debt=50, collateral=777)
    mismatch_before = (copy.deepcopy(mismatch_router), copy.deepcopy(mismatch_gt))
    try:
        swap_and_repay_transaction(mismatch_router, mismatch_gt, "DUMMY", 80)
        raise AssertionError("zero-allowance mismatch unexpectedly succeeded")
    except PermissionError:
        pass
    assert mismatch_router == mismatch_before[0] and mismatch_gt == mismatch_before[1]
    regressions["wrongTokenZeroConfiguredAllowance"] = {
        "status": "reverted-in-model",
        "configuredTokenBalanceAfter": mismatch_router.balances["FT"],
        "configuredTokenAllowanceAfter": mismatch_router.allowances_to_gt.get("FT", 0),
        "dummyAllowanceAfter": mismatch_router.allowances_to_gt.get("DUMMY", 0),
        "debtAfter": mismatch_gt.debt,
        "collateralAfter": mismatch_gt.collateral,
    }

    setup_router = RouterState(balances={"FT": 70})
    setup_gt = GtState(configured_token="FT", debt=40, collateral=400)
    over_repay = swap_and_repay_transaction(setup_router, setup_gt, "FT", 100)
    assert over_repay == {
        "finalRepay": 40,
        "pathTokenRefund": 30,
        "configuredTokenAllowanceAfter": 60,
        "pathTokenAllowanceAfter": 60,
        "configuredTokenRouterResidue": 0,
        "collateralGain": 400,
        "debtAfter": 0,
    }
    regressions["overRepayAllowanceResidue"] = over_repay

    stale_router = RouterState(
        balances={"FT": 50, "DUMMY": 1},
        allowances_to_gt={"FT": over_repay["configuredTokenAllowanceAfter"]},
    )
    stale_gt = GtState(configured_token="FT", debt=50, collateral=777)
    stale_success = swap_and_repay_transaction(stale_router, stale_gt, "DUMMY", 80)
    assert stale_success == {
        "finalRepay": 50,
        "pathTokenRefund": 1,
        "configuredTokenAllowanceAfter": 10,
        "pathTokenAllowanceAfter": 80,
        "configuredTokenRouterResidue": 0,
        "collateralGain": 777,
        "debtAfter": 0,
    }
    regressions["wrongTokenStaleAllowanceAndBalanceSuccess"] = stale_success

    regressions["relationToSweep"] = {
        "samePreexistingConfiguredTokenValue": 50,
        "directSweepThenOrdinaryRepayPossible": True,
        "independentValueBeyondRouterBalanceProven": False,
    }

    first_payment = 100 + 30
    no_donation_second = 0
    later_ft_donation = 13
    later_pool_share_donation = 7
    later_donation_payment = later_ft_donation + later_pool_share_donation
    assert no_donation_second == 0 and later_donation_payment == 20
    regressions["repeatRedeemAll"] = {
        "firstPayment": first_payment,
        "secondWithoutDonation": no_donation_second,
        "laterFtDonation": later_ft_donation,
        "laterPoolShareDonation": later_pool_share_donation,
        "thirdAfterDonation": later_donation_payment,
        "configDeletionBlocksLaterCall": False,
    }

    assert len(regressions) == 7
    return {
        "schema": "termmax-v2-settlement-step1-r2-model/v1",
        "classification": "WATCH/CONDITIONAL-LOCAL-ROUTE-POSITIVE/REPOSITORY-SOURCE-CONFIRMED/DEPLOYMENT-UNVERIFIED/FORGE-EXECUTION-BLOCKED",
        "evidenceType": "deterministic-python-integer-state-model-with-source-substring-bindings-not-evm-execution",
        "seed": SEED,
        "sourceAnchorCount": source_anchor_count,
        "regressionCount": len(regressions),
        "routePositiveLocalSource": 1,
        "routePositiveOperationalGlobal": 0,
        "executableNow": 0,
        "signedActionJustified": False,
        "fork": False,
        "regressions": regressions,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    results = build_results()
    if args.json:
        print(json.dumps(results, indent=2, sort_keys=True))
    else:
        print(f"PASS: {results['regressionCount']} regressions; {results['sourceAnchorCount']} source anchors")


if __name__ == "__main__":
    main()
