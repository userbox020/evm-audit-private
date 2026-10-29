#!/usr/bin/env python3
"""Offline, production-source-linked TermMax V2 settlement model checks."""

from __future__ import annotations

import random
import unittest
from dataclasses import dataclass, field
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TERM_MAX = ROOT / "targets" / "termmax"
SCALE = 10**36


@dataclass
class MarketModel:
    supply: int
    reserve_ft: int
    debt: int
    collateral: int
    balances: dict[str, int]
    allowances: dict[tuple[str, str], int] = field(default_factory=dict)

    def redeem(self, owner: str, caller: str, recipient: str, amount: int) -> tuple[int, int]:
        if caller != owner:
            key = (owner, caller)
            if self.allowances.get(key, 0) < amount:
                raise PermissionError("insufficient FT allowance")
            self.allowances[key] -= amount

        if self.reserve_ft:
            self.supply -= self.reserve_ft
            self.reserve_ft = 0

        if amount > self.balances.get(owner, 0):
            raise ValueError("insufficient FT balance")

        proportion = amount * SCALE // self.supply
        debt_out = self.debt * proportion // SCALE
        collateral_out = self.collateral * proportion // SCALE

        self.balances[owner] -= amount
        self.supply -= amount
        self.debt -= debt_out
        self.collateral -= collateral_out
        return debt_out, collateral_out


@dataclass
class OrderModel:
    ft: int
    pool_assets: int
    closed: bool = False

    def redeem_all(self, market: MarketModel, recipient: str) -> tuple[int, int, int]:
        ft_balance = self.ft
        received = 0
        collateral = 0
        if ft_balance:
            received, collateral = market.redeem("order", "order", recipient, ft_balance)
            self.ft = 0
        received_from_pool = self.pool_assets
        self.pool_assets = 0
        bad_debt = max(0, ft_balance - received)
        self.closed = True
        return received + received_from_pool, collateral, bad_debt


def swap_and_repay_model(
    configured_repay_token: str,
    first_path_token_out: str,
    router_balances: dict[str, int],
    debt: int,
    repay_amount: int,
) -> tuple[int, int]:
    """Model TermMaxRouterV2:385-390 plus GT token selection at :293-298."""
    if first_path_token_out != configured_repay_token:
        raise PermissionError("GT cannot pull its configured repayment token")
    final_repay = min(debt, repay_amount)
    if router_balances.get(configured_repay_token, 0) < final_repay:
        raise ValueError("insufficient repayment balance")
    router_balances[configured_repay_token] -= final_repay
    refund = router_balances[configured_repay_token]
    router_balances[configured_repay_token] = 0
    return debt - final_repay, refund


class ProductionSourceBindings(unittest.TestCase):
    def assert_source_contains(self, relative: str, *anchors: str) -> None:
        text = (TERM_MAX / relative).read_text(encoding="utf-8")
        for anchor in anchors:
            self.assertIn(anchor, text)

    def test_market_redeem_binding(self) -> None:
        self.assert_source_contains(
            "contracts/v2/TermMaxMarketV2.sol",
            "IMintableERC20V2(address(ft)).burn(address(this), address(this), ftReserve);",
            "uint256 proportion = ftAmount.mulDiv(Constants.DECIMAL_BASE_SQ, ft.totalSupply());",
            "IMintableERC20V2(address(ft)).burn(ftOwner, caller, ftAmount);",
            "deliveryData = gt.delivery(proportion, recipient);",
            "debtToken.safeTransfer(recipient, debtTokenAmt);",
        )

    def test_ft_allowance_binding(self) -> None:
        self.assert_source_contains(
            "contracts/v2/tokens/MintableERC20V2.sol",
            "if (owner != spender)",
            "_spendAllowance(owner, spender, amount);",
            "_burn(owner, amount);",
        )

    def test_delivery_balance_binding(self) -> None:
        self.assert_source_contains(
            "contracts/v2/tokens/GearingTokenWithERC20V2.sol",
            "uint256 collateralReserve = IERC20(_config.collateral).balanceOf(address(this));",
            "uint256 amount = collateralReserve.mulDiv(proportion, Constants.DECIMAL_BASE_SQ);",
        )

    def test_order_redeem_all_binding(self) -> None:
        self.assert_source_contains(
            "contracts/v2/TermMaxOrderV2.sol",
            "if (ftBalance != 0) (received, deliveryData) = market.redeem(ftBalance, recipient);",
            "if (shares != 0) receivedFromPool = _pool.redeem(shares, recipient, address(this));",
            "delete _orderConfig;",
        )

    def test_router_repayment_binding(self) -> None:
        self.assert_source_contains(
            "contracts/v2/router/TermMaxRouterV2.sol",
            "IERC20 repayToken = IERC20(paths[0].units[paths[0].units.length - 1].tokenOut);",
            "gt.repay(gtId, repayAmt, byDebtToken);",
            "uint256 remainingRepayToken = repayToken.balanceOf(address(this));",
            "repayToken.safeTransfer(_msgSender(), remainingRepayToken);",
        )
        self.assert_source_contains(
            "contracts/v2/tokens/AbstractGearingTokenV2.sol",
            "config.debtToken.safeTransferFrom(msg.sender, marketAddr(), finalRepayAmt);",
            "config.ft.safeTransferFrom(msg.sender, marketAddr(), finalRepayAmt);",
        )

    def test_router_onchain_balance_binding(self) -> None:
        self.assert_source_contains(
            "contracts/v2/router/TermMaxRouterV2.sol",
            "if (path.useBalanceOnchain)",
            "IERC20(path.units[0].tokenIn).balanceOf(address(this))",
            "IERC20(units[i].tokenIn).safeTransfer(recipient, inputAmt);",
        )


class SettlementConservation(unittest.TestCase):
    def make_market(self, a: int, b: int, reserve_ft: int, debt: int, collateral: int) -> MarketModel:
        return MarketModel(
            supply=a + b + reserve_ft,
            reserve_ft=reserve_ft,
            debt=debt,
            collateral=collateral,
            balances={"alice": a, "bob": b},
        )

    def test_two_user_sequential_redemption_exhausts_reserves(self) -> None:
        market = self.make_market(3, 7, 2, 101, 211)
        a_debt, a_coll = market.redeem("alice", "alice", "alice", 3)
        b_debt, b_coll = market.redeem("bob", "bob", "bob", 7)
        self.assertEqual(a_debt + b_debt, 101)
        self.assertEqual(a_coll + b_coll, 211)
        self.assertEqual((market.supply, market.debt, market.collateral), (0, 0, 0))

    def test_redemption_order_never_overpays(self) -> None:
        rng = random.Random(0x7E4D4A)
        for _ in range(10_000):
            a, b = rng.randint(1, 10**18), rng.randint(1, 10**18)
            reserve_ft = rng.randint(0, 10**18)
            debt, collateral = rng.randint(0, 10**24), rng.randint(0, 10**24)
            for order in (("alice", a, "bob", b), ("bob", b, "alice", a)):
                market = self.make_market(a, b, reserve_ft, debt, collateral)
                first = market.redeem(order[0], order[0], order[0], order[1])
                second = market.redeem(order[2], order[2], order[2], order[3])
                self.assertLessEqual(first[0] + second[0], debt)
                self.assertLessEqual(first[1] + second[1], collateral)
                self.assertEqual(first[0] + second[0], debt)
                self.assertEqual(first[1] + second[1], collateral)

    def test_partial_claims_cannot_create_reserves(self) -> None:
        market = self.make_market(100, 300, 17, 991, 499)
        initial_debt, initial_collateral = market.debt, market.collateral
        paid_debt = paid_collateral = 0
        for amount in (1, 2, 3, 5, 8, 13):
            out = market.redeem("alice", "alice", "alice", amount)
            paid_debt += out[0]
            paid_collateral += out[1]
            self.assertEqual(paid_debt + market.debt, initial_debt)
            self.assertEqual(paid_collateral + market.collateral, initial_collateral)
        self.assertEqual(market.balances["alice"], 68)

    def test_third_party_redemption_requires_allowance(self) -> None:
        market = self.make_market(50, 50, 0, 100, 100)
        with self.assertRaises(PermissionError):
            market.redeem("alice", "mallory", "mallory", 10)
        self.assertEqual((market.supply, market.debt, market.collateral), (100, 100, 100))

        market.allowances[("alice", "router")] = 10
        out = market.redeem("alice", "router", "alice", 10)
        self.assertEqual(out, (10, 10))
        self.assertEqual(market.allowances[("alice", "router")], 0)

    def test_recipient_does_not_change_burn_authorization(self) -> None:
        market = self.make_market(50, 50, 0, 100, 100)
        market.allowances[("alice", "router")] = 5
        out = market.redeem("alice", "router", "bob", 5)
        self.assertEqual(out, (5, 5))
        self.assertEqual(market.balances["alice"], 45)
        self.assertEqual(market.balances["bob"], 50)

    def test_repeated_redeem_all_has_no_second_payment(self) -> None:
        market = MarketModel(100, 0, 100, 200, {"order": 100})
        order = OrderModel(100, 30)
        first = order.redeem_all(market, "vault")
        second = order.redeem_all(market, "vault")
        self.assertEqual(first, (130, 200, 0))
        self.assertEqual(second, (0, 0, 0))

    def test_mismatched_swap_repay_token_rolls_back(self) -> None:
        balances = {"FT": 100, "FAKE": 100}
        before = balances.copy()
        with self.assertRaises(PermissionError):
            swap_and_repay_model("FT", "FAKE", balances, 80, 80)
        self.assertEqual(balances, before)

    def test_repay_caps_pull_and_refunds_remaining_balance(self) -> None:
        balances = {"FT": 125}
        debt_after, refund = swap_and_repay_model("FT", "FT", balances, 80, 100)
        self.assertEqual(debt_after, 0)
        self.assertEqual(refund, 45)
        self.assertEqual(balances["FT"], 0)

    def test_router_full_balance_refund_is_not_delta_scoped(self) -> None:
        balances = {"DEBT": 17 + 100}
        debt_after, refund = swap_and_repay_model("DEBT", "DEBT", balances, 100, 100)
        self.assertEqual(debt_after, 0)
        self.assertEqual(refund, 17)


if __name__ == "__main__":
    unittest.main(verbosity=2)
