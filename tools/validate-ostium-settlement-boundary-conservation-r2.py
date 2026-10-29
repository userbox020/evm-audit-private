#!/usr/bin/env python3
"""Strict, check-only, independent validator for Ostium settlement R2."""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path


class ValidationError(RuntimeError):
    pass


if sys.flags.optimize != 0:
    raise ValidationError("optimized Python is forbidden")
if os.environ.get("PYTHONOPTIMIZE", "") != "":
    raise ValidationError("nonempty PYTHONOPTIMIZE is forbidden")

ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / "targets" / "ostium"
FILES = {"model.json", "observations.json", "test-result.json", "manifest.json"}
IDS = [
    "A_DEADLINE_MINUS_1", "A_DEADLINE_EXACT", "A_DEADLINE_PLUS_1",
    "B_OPEN_PNL_ZERO_DELTA", "B_OPEN_PNL_POSITIVE_BELOW_CAP", "B_OPEN_PNL_EXACT_CONFIGURED_CAP",
    "B_OPEN_PNL_ONE_ABOVE_CONFIGURED_CAP", "B_OPEN_PNL_VAULT_VALUE_CAP", "B_OPEN_PNL_EQUAL_CAPS",
    "B_OPEN_PNL_LARGE_NEGATIVE_NONDIVISIBLE", "B_OPEN_PNL_ZERO_SUPPLY_POSITIVE", "B_OPEN_PNL_ZERO_SUPPLY_NEGATIVE",
    "C_MIXED_WITHDRAWAL_FIRST_PINNED_PRICE", "C_FULL_WITHDRAWAL_REJECT_RECLAIM", "C_DEPOSIT_BLOCKED_RECLAIM", "C_CAPPED_MULTI_USER_PRORATA_DUST",
    "D_MM_POSITIVE_BEFORE_REFRESH", "D_MM_NEGATIVE_AFTER_REFRESH_FLOOR", "D_MM_NON_MM_REJECTION", "D_MM_OVER_BUFFER_ROLLBACK",
    "D_MM_INSUFFICIENT_BALANCE_ROLLBACK", "E_NONZERO_THRESHOLD_DERIVATIONS",
]
UNITS = {"count", "seconds", "unix-seconds", "asset-6", "share-6", "pnl-18", "per-share-18", "asset-per-share-18", "ratio-18", "bytes4-decimal", "panic-code"}
ACTORS = {"OWNER", "GOV", "REFERENCE_SETUP", "SETTLER", "ALICE", "BOB", "CAROL", "MM", "RECEIVER", "OUTSIDER", "VAULT", "ZERO"}
DECIMAL = re.compile(r"^(?:0|-?[1-9][0-9]*)$")
ADDRESS = re.compile(r"0x[0-9a-fA-F]{40}(?![0-9a-fA-F])")
HEX32 = re.compile(r"^[0-9a-f]{64}$")
SELECTOR = re.compile(r"^0x[0-9a-f]{8}$")
WAD, ASSET = 10**18, 10**6
CHECKS = 0


def check(condition: bool, message: str) -> None:
    global CHECKS
    CHECKS += 1
    if not condition:
        raise ValidationError(message)


def keys(obj: dict, expected: set[str], where: str) -> None:
    check(isinstance(obj, dict), f"{where}: object required")
    check(set(obj) == expected, f"{where}: exact keys mismatch: {set(obj) ^ expected}")


def load(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise ValidationError(f"invalid JSON {path}: {exc}") from exc
    check(isinstance(value, dict), f"{path.name}: root object required")
    return value


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def q(value: int, unit: str) -> dict:
    return {"value": str(value), "unit": unit}


def qv(value, unit: str | None = None, where: str = "quantity") -> int:
    keys(value, {"value", "unit"}, where)
    check(isinstance(value["value"], str) and DECIMAL.fullmatch(value["value"]) is not None, f"{where}: canonical decimal required")
    check(value["unit"] in UNITS, f"{where}: unknown unit")
    if unit is not None:
        check(value["unit"] == unit, f"{where}: expected unit {unit}")
    return int(value["value"])


def no_json_numbers(node, where: str = "root") -> None:
    if isinstance(node, bool) or node is None or isinstance(node, str):
        return
    if isinstance(node, (int, float)):
        check(False, f"{where}: JSON numbers forbidden; use canonical strings")
    if isinstance(node, list):
        for i, item in enumerate(node):
            no_json_numbers(item, f"{where}[{i}]")
        return
    if isinstance(node, dict):
        for name, item in node.items():
            no_json_numbers(item, f"{where}.{name}")
        return
    check(False, f"{where}: unsupported JSON type")


def trunc(a: int, b: int) -> int:
    check(b > 0, "division denominator")
    return (abs(a) // b) * (-1 if a < 0 else 1)


def floor_signed(a: int, b: int) -> int:
    quotient = trunc(a, b)
    return quotient - 1 if a < 0 and a % b != 0 else quotient


def open_step(previous: int, proposed: int, supply: int, acc: int, rewards: int, maximum_per_token: int) -> dict:
    vault_cap = (WAD + rewards - acc) * supply // ASSET
    configured_cap = maximum_per_token * supply // ASSET
    cap = min(vault_cap, configured_cap)
    raw = proposed - previous
    delta = min(raw, cap) if raw > cap else raw
    cap_ids: list[int] = []
    if raw > cap:
        if cap == vault_cap:
            cap_ids.append(0)
        if cap == configured_cap:
            cap_ids.append(1)
    next_acc = acc
    if supply > 0:
        next_acc += trunc(delta * ASSET, supply)
        if next_acc >= WAD + rewards:
            next_acc = WAD + rewards - 1
    return {"raw": raw, "delta": delta, "capIds": cap_ids, "nextAcc": next_acc, "settled": previous + delta,
            "vaultCap": vault_cap, "configuredCap": configured_cap}


def price(acc_used: int, threshold: int, rewards: int) -> int:
    effective = acc_used - threshold
    return WAD + rewards - threshold - (effective if effective > 0 else 0)


def buffer(acc: int, threshold: int, supply: int) -> int:
    return trunc(-(acc - threshold) * supply, WAD)


STATE_KEYS = {"settlementId", "settlementTimestamp", "settlementOpenPnl", "accPnl", "accPnlUsed", "rewards", "threshold", "effectiveAccUsed", "price", "buffer", "supply", "custody", "supplyCap", "maxOpenPnlPerToken", "maxSettlementInterval", "withdrawDelay"}
STATE_UNITS = {"settlementId": "count", "settlementTimestamp": "unix-seconds", "settlementOpenPnl": "pnl-18", "accPnl": "per-share-18", "accPnlUsed": "per-share-18", "rewards": "per-share-18", "threshold": "per-share-18", "effectiveAccUsed": "per-share-18", "price": "asset-per-share-18", "buffer": "asset-6", "supply": "share-6", "custody": "asset-6", "supplyCap": "share-6", "maxOpenPnlPerToken": "per-share-18", "maxSettlementInterval": "seconds", "withdrawDelay": "count"}
QUEUE_KEYS = {"actor", "kind", "settlementId", "pending", "total", "status", "settlementPrice", "allocationScale"}
GHOST_KEYS = {"pendingDepositEscrow", "pendingWithdrawEscrow", "claimableAssets", "claimableShares", "refundableAssets", "reclaimableAssets", "reclaimableShares"}
GHOST_UNITS = {"pendingDepositEscrow": "asset-6", "pendingWithdrawEscrow": "share-6", "claimableAssets": "asset-6", "claimableShares": "share-6", "refundableAssets": "asset-6", "reclaimableAssets": "asset-6", "reclaimableShares": "share-6"}
EVENT_PAYLOADS = {
    "ShareToAssetsPriceUpdated": {"value"},
    "AccPnlPerTokenUsedUpdatedV2": {"settlementId", "prevOpenPnl", "newOpenPnl", "settlementOpenPnl", "accPnlPerTokenUsed"},
    "MaxOpenPnlDeltaUsed": {"maxDeltaId", "delta", "maxDelta"},
    "AsyncDepositWithdrawExecuted": {"settlementId", "deltaShares", "totalAssetsToDeposit", "totalSharesToWithdraw", "shareToAssetsPrice"},
    "SettlementExecuted": {"settlementId", "settlementTs", "settlementOpenPnl", "settlementType", "accPnlPerTokenUsed", "accRewardsPerToken", "shareToAssetsPrice", "totalClosedPnl", "totalSupply", "totalAssets", "bufferSize"},
    "DepositRequestedV2": {"owner", "settlementId", "assets"}, "WithdrawRequestedV2": {"owner", "settlementId", "shares"},
    "DepositClaimedV2": {"owner", "settlementId", "shares"}, "WithdrawClaimedV2": {"owner", "settlementId", "assets"},
    "DepositReclaimedV2": {"owner", "settlementId", "assets"}, "WithdrawReclaimedV2": {"owner", "settlementId", "shares"},
    "TotalAssetsToDepositAboveMax": {"settlementId", "totalAssetsToDeposit", "maxAssets"},
    "TotalSharesToWithdrawAboveMax": {"settlementId", "totalSharesToWithdraw", "maxShares"},
    "TotalAssetsToDepositCapped": {"settlementId", "requestedAmount", "allocatedAmount"},
    "DepositPartiallyRefunded": {"owner", "settlementId", "refundedAssets"},
    "MMDeposit": {"mm", "settlementId", "assets"}, "MMWithdraw": {"mm", "settlementId", "receiver", "assets"},
    "MarketMakerUpdated": {"oldMM", "newMM"},
    "Transfer": {"from", "to", "value"},
    "Initialized": {"version"},
}


def validate_event(event: dict, where: str) -> None:
    keys(event, {"name", "payload"}, where)
    name = event["name"]
    check(name in EVENT_PAYLOADS, f"{where}: unknown event {name}")
    keys(event["payload"], EVENT_PAYLOADS[name], f"{where}.payload")
    for field, value in event["payload"].items():
        if isinstance(value, str):
            check(value in ACTORS, f"{where}.{field}: symbolic actor required")
        else:
            lower = field.lower()
            if name == "Transfer" and field == "value": unit = "share-6"
            elif name == "ShareToAssetsPriceUpdated": unit = "asset-per-share-18"
            elif name == "TotalAssetsToDepositCapped" and field in {"requestedAmount", "allocatedAmount"}: unit = "asset-6"
            elif field == "totalClosedPnl": unit = "asset-6"
            elif "timestamp" in lower or field == "settlementTs": unit = "unix-seconds"
            elif "settlementid" in lower or "maxdeltaid" in lower or field == "settlementType": unit = "count"
            elif "sharetoassetsprice" in lower: unit = "asset-per-share-18"
            elif "accpnl" in lower or "accrewards" in lower or "scale" in lower: unit = "per-share-18"
            elif "openpnl" in lower or field in {"delta", "maxDelta"}: unit = "pnl-18"
            elif "shares" in lower or "supply" in lower or field == "deltaShares": unit = "share-6"
            elif "assets" in lower or "cashflow" in lower or "buffer" in lower: unit = "asset-6"
            else: unit = "count"
            qv(value, unit, f"{where}.{field}")


def validate_snapshot(snapshot: dict, where: str) -> None:
    keys(snapshot, {"vault", "queues", "balances", "ghost", "conservation"}, where)
    keys(snapshot["vault"], STATE_KEYS, f"{where}.vault")
    state = {name: qv(value, STATE_UNITS[name], f"{where}.vault.{name}") for name, value in snapshot["vault"].items()}
    check(state["effectiveAccUsed"] == state["accPnlUsed"] - state["threshold"], f"{where}: effective acc")
    check(state["price"] == price(state["accPnlUsed"], state["threshold"], state["rewards"]), f"{where}: price")
    check(state["buffer"] == buffer(state["accPnl"], state["threshold"], state["supply"]), f"{where}: buffer")
    keys(snapshot["balances"], {"assets", "shares"}, f"{where}.balances")
    for kind, unit in (("assets", "asset-6"), ("shares", "share-6")):
        check(set(snapshot["balances"][kind]) == ACTORS - {"ZERO"}, f"{where}: balance actor set")
        for label, quantity in snapshot["balances"][kind].items():
            check(label in ACTORS, f"{where}: actor")
            qv(quantity, unit, f"{where}.balances.{kind}.{label}")
    check(qv(snapshot["balances"]["assets"]["VAULT"], "asset-6") == state["custody"], f"{where}: custody balance")
    for index, queue in enumerate(snapshot["queues"]):
        keys(queue, QUEUE_KEYS, f"{where}.queues[{index}]")
        check(queue["actor"] in ACTORS - {"VAULT", "ZERO"}, f"{where}: queue actor")
        check(queue["kind"] in {"DEPOSIT", "WITHDRAW"}, f"{where}: queue kind")
        unit = "asset-6" if queue["kind"] == "DEPOSIT" else "share-6"
        qv(queue["settlementId"], "count"); qv(queue["pending"], unit); qv(queue["total"], unit); qv(queue["status"], "count")
        qv(queue["settlementPrice"], "asset-per-share-18"); qv(queue["allocationScale"], "ratio-18")
    keys(snapshot["ghost"], GHOST_KEYS, f"{where}.ghost")
    computed = {name: 0 for name in GHOST_KEYS}
    for queue in snapshot["queues"]:
        pending, status = qv(queue["pending"]), qv(queue["status"]); deposit = queue["kind"] == "DEPOSIT"
        p = qv(queue["settlementPrice"]); scale = qv(queue["allocationScale"])
        if status == 1:
            computed["pendingDepositEscrow" if deposit else "pendingWithdrawEscrow"] += pending
        elif status == 2 and deposit:
            allocated = pending * scale // WAD
            computed["claimableShares"] += 0 if p == 0 else allocated * WAD // p
            computed["refundableAssets"] += pending - allocated
        elif status == 2:
            computed["claimableAssets"] += 0 if p == 0 else pending * p // WAD
        elif status == 3:
            computed["reclaimableAssets" if deposit else "reclaimableShares"] += pending
        check(status in {0, 1, 2, 3}, f"{where}: status enum")
    for name in GHOST_KEYS:
        check(qv(snapshot["ghost"][name], GHOST_UNITS[name]) == computed[name], f"{where}: ghost {name}")
    keys(snapshot["conservation"], {"tokenBalanceSum", "tokenTotalSupply", "tokenEqual", "shareBalanceSum", "vaultTotalSupply", "shareEqual"}, f"{where}.conservation")
    token_sum = sum(qv(x, "asset-6") for x in snapshot["balances"]["assets"].values())
    share_sum = sum(qv(x, "share-6") for x in snapshot["balances"]["shares"].values())
    check(qv(snapshot["conservation"]["tokenBalanceSum"], "asset-6") == token_sum, f"{where}: token sum")
    check(qv(snapshot["conservation"]["shareBalanceSum"], "share-6") == share_sum, f"{where}: share sum")
    check(qv(snapshot["conservation"]["tokenTotalSupply"], "asset-6") == token_sum, f"{where}: token supply")
    check(qv(snapshot["conservation"]["vaultTotalSupply"], "share-6") == state["supply"] == share_sum, f"{where}: share supply")
    check(snapshot["conservation"]["tokenEqual"] is True and snapshot["conservation"]["shareEqual"] is True, f"{where}: conservation booleans")


def inputs(case: dict) -> dict[str, dict]:
    result = {}
    for index, row in enumerate(case["inputs"]):
        keys(row, {"name", "value"}, f"input[{index}]")
        check(isinstance(row["name"], str) and row["name"] not in result, "input unique name")
        qv(row["value"], where=f"input.{row['name']}")
        result[row["name"]] = row["value"]
    return result


def iv(values: dict, name: str) -> int:
    check(name in values, f"missing input {name}")
    return qv(values[name])


def event_names(case: dict) -> list[str]:
    return [event["name"] for phase in case["timeline"] for event in phase["events"]]


def event(case: dict, name: str) -> dict:
    rows = [event for phase in case["timeline"] for event in phase["events"] if event["name"] == name]
    check(len(rows) == 1, f"{case['caseId']}: one {name} required")
    return rows[0]


def values_map(rows: dict[str, tuple[int, str]]) -> dict:
    return {name: q(value, unit) for name, (value, unit) in rows.items()}


def recompute(case: dict) -> dict:
    case_id = case["caseId"]
    data = inputs(case)
    pre = {name: qv(value) for name, value in case["pre"]["vault"].items()}
    post = {name: qv(value) for name, value in case["post"]["vault"].items()}
    if case_id.startswith("A_"):
        offset = iv(data, "offset"); delta = 0 if offset < 0 else 1
        check(iv(data, "deadline") == pre["settlementTimestamp"] + pre["maxSettlementInterval"], f"{case_id}: deadline")
        expected_names = [] if delta == 0 else ["ShareToAssetsPriceUpdated", "AccPnlPerTokenUsedUpdatedV2", "AsyncDepositWithdrawExecuted", "SettlementExecuted"]
        check(post["settlementId"] == pre["settlementId"] + delta, f"{case_id}: settlement id")
        if delta == 0:
            check(case["pre"] == case["post"], f"{case_id}: no-op state")
        return {"deadlineOffset": q(offset, "seconds"), "settlementDelta": q(delta, "count"), "eventNames": expected_names}
    if case_id.startswith("B_"):
        proposed, maximum = iv(data, "proposedOpenPnl"), iv(data, "configuredMaxPerToken")
        calc = open_step(pre["settlementOpenPnl"], proposed, pre["supply"], pre["accPnl"], pre["rewards"], maximum)
        expected_names = ["MaxOpenPnlDeltaUsed"] * len(calc["capIds"]) + ["ShareToAssetsPriceUpdated", "AccPnlPerTokenUsedUpdatedV2", "AsyncDepositWithdrawExecuted", "SettlementExecuted"]
        check(post["settlementOpenPnl"] == calc["settled"] and post["accPnl"] == calc["nextAcc"], f"{case_id}: open step state")
        caps = [int(e["payload"]["maxDeltaId"]["value"]) for p in case["timeline"] for e in p["events"] if e["name"] == "MaxOpenPnlDeltaUsed"]
        check(caps == calc["capIds"], f"{case_id}: cap IDs")
        return {"rawDelta": q(calc["raw"], "pnl-18"), "acceptedDelta": q(calc["delta"], "pnl-18"), "settledOpenPnl": q(calc["settled"], "pnl-18"), "accPnl": q(calc["nextAcc"], "per-share-18"), "price": q(price(calc["nextAcc"], 0, 0), "asset-per-share-18"), "capIds": [str(x) for x in calc["capIds"]], "eventNames": expected_names}
    if case_id == IDS[12]:
        pinned = pre["price"]; withdraw, deposit = iv(data, "withdrawShares"), iv(data, "depositAssets")
        check(case["post"]["queues"][0]["pending"] == q(0, "share-6") and case["post"]["queues"][1]["pending"] == q(0, "asset-6"), f"{case_id}: queues cleared")
        return values_map({"pinnedPrice": (pinned, "asset-per-share-18"), "withdrawnAssets": (withdraw * pinned // WAD, "asset-6"), "depositedShares": (deposit * WAD // pinned, "share-6"), "finalPending": (0, "count")})
    if case_id == IDS[13]:
        supply = iv(data, "supply"); open_pnl = pre["settlementOpenPnl"]; market = supply * pre["price"] // WAD
        open_assets = (-open_pnl) * ASSET // WAD if open_pnl < 0 else 0; max_assets = max(0, market - open_assets)
        balance_limit = max_assets * WAD // pre["price"]; limit = min(supply - 1, balance_limit)
        return values_map({"requested": (supply, "share-6"), "maxShares": (limit, "share-6"), "burned": (0, "share-6"), "reclaimed": (supply, "share-6"), "finalPending": (0, "share-6")})
    if case_id == IDS[14]:
        requested = iv(data, "requestedAssets")
        check(pre["effectiveAccUsed"] > 0, f"{case_id}: effective used positive")
        return values_map({"effectiveUsed": (pre["effectiveAccUsed"], "per-share-18"), "maxAssets": (0, "asset-6"), "reclaimed": (requested, "asset-6"), "finalPending": (0, "asset-6")})
    if case_id == IDS[15]:
        capacity, first, second = iv(data, "capacity"), iv(data, "bobRequest"), iv(data, "carolRequest")
        scale = capacity * WAD // (first + second); a, b = first * scale // WAD, second * scale // WAD
        return values_map({"scale": (scale, "ratio-18"), "bobShares": (a, "share-6"), "carolShares": (b, "share-6"), "bobRefund": (first - a, "asset-6"), "carolRefund": (second - b, "asset-6"), "residualVaultShares": (capacity - a - b, "share-6")})
    if case_id == IDS[16]:
        supply, proposed, cashflow, maximum = iv(data, "supply"), iv(data, "proposedOpenPnl"), iv(data, "cashflow"), iv(data, "maxPerToken")
        cash_delta = trunc(cashflow * WAD, supply)
        actual = open_step(pre["settlementOpenPnl"], proposed, supply, pre["accPnl"] - cash_delta, pre["rewards"], maximum)
        reversed_step = open_step(pre["settlementOpenPnl"], proposed, supply, pre["accPnl"], pre["rewards"], maximum)
        check(actual["settled"] != reversed_step["settled"], f"{case_id}: ordering must change settlement")
        acc_event = event(case, "AccPnlPerTokenUsedUpdatedV2"); settlement = event(case, "SettlementExecuted")
        check(qv(acc_event["payload"]["accPnlPerTokenUsed"]) == actual["nextAcc"], f"{case_id}: cashflow precedes refresh")
        check(qv(settlement["payload"]["accPnlPerTokenUsed"]) == actual["nextAcc"], f"{case_id}: settlement payload")
        return {"cashflowDelta": q(cash_delta, "per-share-18"), "accEventUsed": q(actual["nextAcc"], "per-share-18"), "settlementAccUsed": q(actual["nextAcc"], "per-share-18"), "settledOpenPnl": q(actual["settled"], "pnl-18"), "reversedSettledOpenPnl": q(reversed_step["settled"], "pnl-18"), "orderDiscriminating": True, "eventNames": ["ShareToAssetsPriceUpdated", "AccPnlPerTokenUsedUpdatedV2", "AsyncDepositWithdrawExecuted", "SettlementExecuted", "MMDeposit"]}
    if case_id == IDS[17]:
        supply, proposed, cashflow = iv(data, "supply"), iv(data, "proposedOpenPnl"), iv(data, "cashflow")
        refresh = open_step(pre["settlementOpenPnl"], proposed, supply, pre["accPnl"], pre["rewards"], pre["maxOpenPnlPerToken"])
        mm_floor = floor_signed(cashflow * WAD, supply); final_acc = refresh["nextAcc"] - mm_floor
        reversed_acc = open_step(pre["settlementOpenPnl"], proposed, supply, pre["accPnl"] - mm_floor, pre["rewards"], pre["maxOpenPnlPerToken"])["nextAcc"]
        check(refresh["nextAcc"] != reversed_acc, f"{case_id}: event ordering discrimination")
        check(qv(event(case, "AccPnlPerTokenUsedUpdatedV2")["payload"]["accPnlPerTokenUsed"]) == refresh["nextAcc"], f"{case_id}: refresh excludes withdrawal")
        check(qv(event(case, "SettlementExecuted")["payload"]["accPnlPerTokenUsed"]) == final_acc, f"{case_id}: settlement includes withdrawal")
        return {"refreshEventAcc": q(refresh["nextAcc"], "per-share-18"), "settlementAcc": q(final_acc, "per-share-18"), "reversedRefreshEventAcc": q(reversed_acc, "per-share-18"), "negativeFloorDelta": q(mm_floor, "per-share-18"), "receiverGain": q(-cashflow, "asset-6"), "orderDiscriminating": True, "eventNames": ["ShareToAssetsPriceUpdated", "AccPnlPerTokenUsedUpdatedV2", "AsyncDepositWithdrawExecuted", "SettlementExecuted", "MMWithdraw"]}
    if case_id in IDS[18:21]:
        selector, panic = {IDS[18]: ("0x85100bab", None), IDS[19]: ("0x2a8f1d36", None), IDS[20]: ("0x4e487b71", 17)}[case_id]
        check(case["pre"] == case["post"], f"{case_id}: exact rollback")
        check(case["timeline"] == [], f"{case_id}: rolled-back events absent")
        return {"selector": selector, "panicCode": None if panic is None else q(panic, "panic-code"), "rollback": True, "eventNames": []}
    if case_id == IDS[21]:
        threshold = iv(data, "preInitializeAccUsed"); supply = iv(data, "supply")
        check(threshold > 0, f"{case_id}: nonzero threshold")
        return values_map({"threshold": (threshold, "per-share-18"), "effective": (0, "per-share-18"), "price": (price(post["accPnl"], threshold, post["rewards"]), "asset-per-share-18"), "buffer": (buffer(post["accPnl"], threshold, supply), "asset-6")})
    check(False, f"unhandled case {case_id}")
    return {}


def validate_case(case: dict, index: int) -> None:
    keys(case, {"caseId", "status", "inputs", "pre", "post", "timeline", "expected", "observed", "revert", "comparison"}, f"case[{index}]")
    check(case["caseId"] == IDS[index], f"case[{index}]: exact ID/order")
    validate_snapshot(case["pre"], f"{case['caseId']}.pre"); validate_snapshot(case["post"], f"{case['caseId']}.post")
    check(isinstance(case["timeline"], list), f"{case['caseId']}: timeline list")
    for pi, phase in enumerate(case["timeline"]):
        keys(phase, {"phase", "transactionTimestamp", "events"}, f"{case['caseId']}.timeline[{pi}]")
        check(isinstance(phase["phase"], str) and phase["phase"], "phase label")
        qv(phase["transactionTimestamp"], "unix-seconds")
        for ei, ev in enumerate(phase["events"]):
            validate_event(ev, f"{case['caseId']}.timeline[{pi}].events[{ei}]")
    independently_expected = recompute(case)
    check(case["expected"] == independently_expected, f"{case['caseId']}: independently recomputed expected mismatch")
    check(case["observed"] == independently_expected, f"{case['caseId']}: observed mismatch")
    keys(case["comparison"], {"expectedObservedEqual", "prePostRollbackEqual"}, f"{case['caseId']}.comparison")
    check(case["comparison"]["expectedObservedEqual"] is (case["expected"] == case["observed"]), f"{case['caseId']}: comparison derivation")
    failed = case["revert"] is not None
    check(case["comparison"]["prePostRollbackEqual"] is ((case["pre"] == case["post"]) if failed else False), f"{case['caseId']}: rollback derivation")
    check(case["status"] == ("PASS" if case["comparison"]["expectedObservedEqual"] and (not failed or case["comparison"]["prePostRollbackEqual"]) else "FAIL"), f"{case['caseId']}: status derivation")
    check(case["status"] == "PASS", f"{case['caseId']}: case did not pass")
    if failed:
        keys(case["revert"], {"transactionPath", "gasLimit", "receiptAvailable", "selector", "exactData", "decodedActor", "panicCode"}, f"{case['caseId']}.revert")
        check(case["revert"]["transactionPath"] == "SIGNER_SEND_TRANSACTION_EXPLICIT_GAS_LIMIT", "transaction path required")
        check(qv(case["revert"]["gasLimit"], "count") == 8_000_000, "explicit gas")
        check(isinstance(case["revert"]["receiptAvailable"], bool), "receipt label")
        check(SELECTOR.fullmatch(case["revert"]["selector"]) is not None, "selector")
        check(case["revert"]["selector"] == independently_expected["selector"], "revert selector expected")
        if case["caseId"] == IDS[18]:
            check(case["revert"]["exactData"] is None and case["revert"]["decodedActor"] == "OUTSIDER", "address-bearing revert normalized")
        elif case["caseId"] == IDS[19]:
            check(case["revert"]["exactData"] == "0x2a8f1d36" and case["revert"]["panicCode"] is None, "buffer exact data")
        else:
            expected_data = "0x4e487b71" + "0" * 62 + "11"
            check(case["revert"]["exactData"] == expected_data, "panic 0x11 exact bytes")
            check(qv(case["revert"]["panicCode"], "panic-code") == 17, "panic code 0x11")


def flags(document: dict, where: str) -> None:
    for name in ("runtimeAssertion", "deploymentAssertion", "currentStateAssertion", "economicsAssertion"):
        check(document[name] is False, f"{where}: {name}")
    check(document["routePositive"] is None and document["fork"] is False, f"{where}: route/fork")
    check(document["classification"] == "LOCAL_SOURCE_BEHAVIOR_CONFIRMED", f"{where}: classification")


def walk(node):
    if isinstance(node, dict):
        yield node
        for child in node.values():
            yield from walk(child)
    elif isinstance(node, list):
        for child in node:
            yield from walk(child)


def main() -> None:
    check(len(sys.argv) == 2, "usage: validator DIRECTORY")
    directory = Path(sys.argv[1]).resolve()
    check(directory.is_dir(), "package directory missing")
    check({x.name for x in directory.iterdir()} == FILES, "exact four final files")
    for file in directory.iterdir():
        text = file.read_text(encoding="utf-8")
        check(ADDRESS.search(text) is None, f"address forbidden in {file.name}")
    model, obs, result, manifest = (load(directory / name) for name in ("model.json", "observations.json", "test-result.json", "manifest.json"))
    for name, doc in (("model", model), ("observations", obs), ("test-result", result), ("manifest", manifest)):
        no_json_numbers(doc, name); flags(doc, name)
    keys(obs, {"schema", "classification", "runtimeAssertion", "deploymentAssertion", "currentStateAssertion", "economicsAssertion", "routePositive", "fork", "caseCount", "actorLabels", "unitAllowlist", "deployment", "cases"}, "observations")
    check(obs["schema"] == "ostium-settlement-boundary-conservation-r2-observations/v2", "observation schema")
    check(qv(obs["caseCount"], "count") == 22, "case count")
    check(set(obs["actorLabels"]) == ACTORS and len(obs["actorLabels"]) == len(ACTORS), "actor labels")
    check(set(obs["unitAllowlist"]) == UNITS and len(obs["unitAllowlist"]) == len(UNITS), "unit allowlist")
    keys(obs["deployment"], {"vault", "registry", "asset", "openPnl", "runtimeKeccak256", "artifactRuntimeKeccak256"}, "deployment")
    check(HEX32.fullmatch(obs["deployment"]["runtimeKeccak256"]) is not None, "runtime hash")
    check(obs["deployment"]["runtimeKeccak256"] == obs["deployment"]["artifactRuntimeKeccak256"], "local runtime bytecode equality")
    check(isinstance(obs["cases"], list) and len(obs["cases"]) == 22, "22 cases")
    check(len({x["caseId"] for x in obs["cases"]}) == 22, "no duplicate cases")
    for index, case in enumerate(obs["cases"]):
        validate_case(case, index)

    common = {"schema", "classification", "runtimeAssertion", "deploymentAssertion", "currentStateAssertion", "economicsAssertion", "routePositive", "fork"}
    keys(model, common | {"scope", "caseCount", "caseIds", "repository", "compiler", "build", "systemUnderTest", "inputBindings", "overlays", "r1Authority", "historicalContext", "insufficientCustodyClassification"}, "model")
    check(model["schema"] == "ostium-settlement-boundary-conservation-r2-model/v2", "model schema")
    check(qv(model["caseCount"], "count") == 22 and model["caseIds"] == IDS, "model case matrix")
    check(model["historicalContext"] == [], "historical context unused")
    keys(model["compiler"], {"module", "version", "longVersion", "platform", "executable", "executableSha256", "downloadAllowed", "networkDenialGuard"}, "compiler")
    check(model["compiler"]["version"] == "0.8.24" and model["compiler"]["longVersion"] == "0.8.24+commit.e11b9ed9", "exact compiler")
    check(model["compiler"]["module"] == "hardhat/native-solc" and model["compiler"]["downloadAllowed"] is False, "native offline compiler")
    check(HEX32.fullmatch(model["compiler"]["executableSha256"]) is not None, "compiler hash")
    keys(model["build"], {"fqn", "buildInfoPath", "buildInfoSha256", "artifactPath", "artifactSha256", "artifactRuntimeBytecodeSha256", "compilerSettings", "sourceClosure", "astTripwires"}, "build")
    build_path, artifact_path = ROOT / model["build"]["buildInfoPath"], ROOT / model["build"]["artifactPath"]
    check(sha(build_path) == model["build"]["buildInfoSha256"] and sha(artifact_path) == model["build"]["artifactSha256"], "build/artifact hashes")
    build, artifact = load(build_path), load(artifact_path)
    check(build["solcVersion"] == "0.8.24" and build["solcLongVersion"] == "0.8.24+commit.e11b9ed9", "build compiler")
    settings = build["input"]["settings"]
    check(settings["optimizer"] == {"enabled": True, "runs": 200}, "optimizer exact")
    check(settings["viaIR"] is True and settings["evmVersion"] == "paris", "viaIR/evm")
    expected_output = {"*": {"*": ["abi", "evm.bytecode", "evm.deployedBytecode", "evm.methodIdentifiers", "metadata"], "": ["ast"]}}
    check(settings["outputSelection"] == expected_output, "output selection exact")
    normalized_settings = {"optimizerEnabled": True, "optimizerRuns": "200", "viaIR": True, "evmVersion": "paris", "outputSelection": expected_output}
    check(model["build"]["compilerSettings"] == normalized_settings, "normalized settings binding")
    check(artifact["sourceName"] == "src/OstiumVault.sol" and artifact["contractName"] == "OstiumVault" and model["build"]["fqn"] == "src/OstiumVault.sol:OstiumVault", "FQN")
    check(hashlib.sha256(artifact["deployedBytecode"].encode()).hexdigest() == model["build"]["artifactRuntimeBytecodeSha256"], "artifact runtime hash")
    closure = model["build"]["sourceClosure"]
    check(set(closure) == set(build["input"]["sources"]), "source closure exact")
    for source_name, source in build["input"]["sources"].items():
        content = source["content"].encode(); check(hashlib.sha256(content).hexdigest() == closure[source_name], f"closure hash {source_name}")
        disk = TARGET / ("node_modules" if source_name.startswith("@") else "") / source_name
        check(disk.read_bytes() == content, f"on-disk build equality {source_name}")
    ast = build["output"]["sources"]["src/OstiumVault.sol"]["ast"]
    definitions = {(node.get("nodeType"), node.get("name")) for node in walk(ast)}
    for tripwire in model["build"]["astTripwires"]:
        keys(tripwire, {"nodeType", "name"}, "AST tripwire")
        check((tripwire["nodeType"], tripwire["name"]) in definitions, f"AST tripwire {tripwire}")
    for binding in model["inputBindings"] + model["overlays"]:
        keys(binding, {"path", "sha256"}, "binding"); check(sha(ROOT / binding["path"]) == binding["sha256"], f"binding {binding['path']}")
    keys(model["repository"], {"path", "commit", "tree", "trackedProductionDiff", "trackedProductionDiffSha256"}, "repository")
    def git(*args: str) -> str:
        run = subprocess.run(["git", *args], cwd=TARGET, text=True, capture_output=True)
        check(run.returncode == 0, f"git {' '.join(args)}")
        return run.stdout.strip()
    check(git("rev-parse", "HEAD") == model["repository"]["commit"] and git("rev-parse", "HEAD^{tree}") == model["repository"]["tree"], "commit/tree")
    production_diff = git("diff", "--", "src/OstiumVault.sol", "src/OstiumRegistry.sol", "src/interfaces/IOstiumVault.sol", "src/interfaces/IOstiumRegistry.sol")
    check(production_diff == "" and hashlib.sha256(production_diff.encode()).hexdigest() == model["repository"]["trackedProductionDiffSha256"], "production diff empty")
    cache = Path(os.environ["LOCALAPPDATA"]) / "hardhat-nodejs" / "Cache" / "compilers-v2" / "windows-amd64" / model["compiler"]["executable"]
    check(cache.is_file() and sha(cache) == model["compiler"]["executableSha256"], "compiler cache executable")
    version = subprocess.run([str(cache), "--version"], text=True, capture_output=True)
    check(version.returncode == 0 and "0.8.24+commit.e11b9ed9" in version.stdout, "compiler executable identity")
    check(len(model["r1Authority"]) == 4, "four R1 authority bindings")
    for binding in model["r1Authority"]:
        keys(binding, {"path", "sha256", "preserved", "authority"}, "R1 binding")
        check(binding["preserved"] is True and binding["authority"] == "SUPERSEDED_BY_R2_FOR_CURRENT_PACKAGE_AUTHORITY", "R1 authority status")
        check(sha(ROOT / binding["path"]) == binding["sha256"], "R1 preserved hash")
    check(model["insufficientCustodyClassification"] == {"kind": "DIAGNOSTIC_LIVENESS", "panicCode": "0x11", "conservationLoss": False, "route": False}, "panic classification")

    keys(result, common | {"compile", "test", "caseCount", "observationsSha256"}, "test-result")
    check(result["schema"] == "ostium-settlement-boundary-conservation-r2-test-result/v2", "result schema")
    for command_name in ("compile", "test"):
        row = result[command_name]; keys(row, {"command", "exitCode", "signal", "stdoutBytes", "stdoutSha256", "stderrBytes", "stderrSha256"} | ({"passing", "failing"} if command_name == "test" else set()), command_name)
        check(qv(row["exitCode"], "count") == 0 and row["signal"] is None, f"{command_name} exit")
        qv(row["stdoutBytes"], "count"); qv(row["stderrBytes"], "count")
        check(HEX32.fullmatch(row["stdoutSha256"]) is not None and HEX32.fullmatch(row["stderrSha256"]) is not None, "output hashes")
    check(qv(result["test"]["passing"], "count") == 4 and qv(result["test"]["failing"], "count") == 0, "test counts")
    check(qv(result["caseCount"], "count") == 22, "result cases")
    observations_hash = sha(directory / "observations.json")
    check(result["observationsSha256"] == observations_hash, "actual observations hash in test result")

    keys(manifest, common | {"packageDirectory", "authoritativeFileSha256", "r1Authority"}, "manifest")
    check(manifest["schema"] == "ostium-settlement-boundary-conservation-r2-manifest/v2", "manifest schema")
    check(manifest["packageDirectory"] == "ostium-settlement-boundary-conservation-r2", "package name")
    hashes = manifest["authoritativeFileSha256"]
    check(set(hashes) == {"model.json", "observations.json", "test-result.json"}, "manifest hash keys")
    for name, expected in hashes.items():
        check(sha(directory / name) == expected, f"manifest hash {name}")
    check(hashes["observations.json"] == observations_hash == result["observationsSha256"], "observation hash cross-link")
    check(manifest["r1Authority"] == model["r1Authority"], "R1 authority cross-link")
    print(f"PASS check-only strict R2: cases=22 checks={CHECKS} sources={len(closure)} bindings={len(model['inputBindings'])} overlays={len(model['overlays'])}")


if __name__ == "__main__":
    try:
        main()
    except ValidationError as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        raise SystemExit(1)
