#!/usr/bin/env python3
"""Offline, fail-closed coverage of top-level canary rows. Never infer execution profit."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import stat
import sys

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from dashboard import canary  # noqa: E402

OUTPUT_DIR = ROOT / "reports" / "raw" / "fast" / "all-sentinels-coverage-20260926"
MAX_BYTES = 4 * 1024 * 1024
SAFE_ID = re.compile(r"[A-Za-z0-9:._-]{1,120}\Z")
MARKET_ID = re.compile(r"0x[0-9a-fA-F]{64}\Z")
ADDRESS = re.compile(r"0x[0-9a-fA-F]{40}\Z")
POSITIVE_RAW = re.compile(r"[1-9][0-9]*\Z")
GATES = ("publicFunding", "borrowExecutable", "exitExecutable", "gasSlippageBound",
         "conservativeNetPositive", "signedBatchValid")
UPGRADES = {
    "upgrade:480:world-openxaut": "world",
    "upgrade:4663:modt-usde-usdg": "rh",
    "upgrade:4663:spine": "rh",
    "upgrade:5042:arc-cirbtc": "arc",
}
EQUITY_ID = "rh:rh-equity-gap-threshold"


def require(condition: bool, category: str) -> None:
    if not condition:
        raise ValueError(category)


def no_symlink_components(path: Path) -> None:
    path = path.absolute()
    for component in (path, *path.parents):
        if component.exists() or component.is_symlink():
            require(not component.is_symlink(), "symlink-refused")
            require(not getattr(component, "is_junction", lambda: False)(), "junction-refused")


def read_bounded(path: str) -> dict:
    source = Path(path).absolute()
    no_symlink_components(source)
    info = source.lstat()
    require(stat.S_ISREG(info.st_mode) and 0 < info.st_size <= MAX_BYTES, "unbounded-or-nonregular-input")
    data = source.read_bytes()
    require(0 < len(data) <= MAX_BYTES, "unbounded-input")
    parsed = json.loads(data)
    require(isinstance(parsed, dict), "invalid-json-object")
    return parsed


def source_reported_market_binding(row: dict) -> bool:
    measurements = row.get("measurements") or {}
    market_id = row.get("marketId")
    collateral = measurements.get("collateralToken")
    loan = measurements.get("loanToken")
    oracle_price = measurements.get("oraclePrice")
    return bool(row["ok"] and isinstance(market_id, str) and MARKET_ID.fullmatch(market_id) and
                isinstance(collateral, str) and ADDRESS.fullmatch(collateral) and
                isinstance(loan, str) and ADDRESS.fullmatch(loan) and
                isinstance(oracle_price, str) and len(oracle_price) <= 78 and
                POSITIVE_RAW.fullmatch(oracle_price))


def validate(inputs: dict) -> None:
    checks = (
        ("divergence", canary.oracle_divergence_monitor_valid),
        ("multichain", canary.exploit_rearm_canary_multichain_valid),
        ("multichainHistory", canary.exploit_rearm_canary_multichain_history_valid),
        ("dedicated", canary.exploit_rearm_canary_valid),
        ("dedicatedHistory", canary.exploit_rearm_canary_history_valid),
    )
    for name, validator in checks:
        require(validator(inputs[name]), "invalid-" + name)
    for surface in ("multichain", "dedicated"):
        status, history = inputs[surface], inputs[surface + "History"]
        require(bool(history["runs"]) and history["runs"][-1]["runId"] == status["runId"],
                "history-run-mismatch")
    div, ledger = inputs["divergence"], inputs["ledger"]
    require(ledger.get("schema") == "oracle-divergence-readiness-step1/v1" and
            ledger.get("sourceRunId") == div["runId"] and ledger.get("sourceAt") == div["generatedAt"],
            "ledger-run-mismatch")
    records = ledger.get("records")
    require(isinstance(records, list) and len(records) == len(div["sentinels"]), "ledger-row-count-mismatch")
    source_keys = {}
    for row in div["sentinels"]:
        key = (row["chainId"], row["sentinel"])
        require(key not in source_keys, "duplicate-divergence-identity")
        source_keys[key] = row
    seen = set()
    for row in records:
        require(isinstance(row, dict), "invalid-ledger-row")
        key = (row.get("chainId"), row.get("sentinel"))
        require(key in source_keys and key not in seen, "ledger-identity-mismatch")
        seen.add(key)
        src = source_keys[key]
        require(row.get("sourceRunId") == div["runId"] and row.get("sourceAt") == div["generatedAt"] and
                row.get("oracle") == src["oracle"] and row.get("marketId") == src["marketId"] and
                row.get("monitorOk") is src["ok"] and row.get("referenceOk") is src["referenceOk"] and
                row.get("signalFired") is src["fired"] and
                row.get("monitorActionableAsObserved") is src["actionable"], "ledger-source-mismatch")
        require(row.get("sourceReportedMarketBinding") is source_reported_market_binding(src),
                "ledger-source-market-binding-mismatch")
        require(row.get("routeReady") is False and row.get("liveReady") is False and
                row.get("profitRank") is None and isinstance(row.get("gates"), dict) and
                set(row["gates"]) == set(GATES) and all(row["gates"][gate] == "unknown" for gate in GATES),
                "forged-profit-gate")
    require(len(seen) == len(source_keys), "missing-ledger-identity")


def nested_markets(row: dict, chain: dict | None) -> dict:
    markets = row.get("markets")
    if row["ok"] is False and isinstance(chain, dict) and chain.get("qualified") is False and markets is None:
        return {"observed": False, "count": None, "ok": None, "notOk": None,
                "marketIds": [], "note": "unobserved-endpoint-unavailable"}
    require(isinstance(markets, list) and 0 < len(markets) <= canary.MULTICHAIN_MAX_MARKETS,
            "equity-market-count-invalid")
    require(all(isinstance(market, dict) and type(market.get("ok")) is bool for market in markets),
            "equity-market-state-invalid")
    ids = [market.get("marketId") for market in markets]
    require(all(isinstance(mid, str) and MARKET_ID.fullmatch(mid) for mid in ids) and
            len({mid.lower() for mid in ids}) == len(markets), "equity-market-identity-invalid")
    ok = sum(market.get("ok") is True for market in markets)
    return {"observed": True, "count": len(markets), "ok": ok, "notOk": len(markets) - ok, "marketIds": ids,
            "note": "nested-evidence-only-not-top-level-sentinels"}


def upgrade_coverage(row: dict, status: dict, history: dict) -> dict:
    identity, cid = row["sentinel"], str(row["chainId"])
    state = status.get("upgradeState", {}).get("sentinels", {}).get(identity)
    require(isinstance(state, dict), "upgrade-state-missing")
    cursor_state = state.get(UPGRADES[identity])
    cursor, stored = cursor_state.get("cursor") if isinstance(cursor_state, dict) else None, state.get("pin")
    require(type(cursor) is int and 0 <= cursor <= 4_294_967_295 and
            type(stored) is int and 0 <= stored <= 4_294_967_295, "upgrade-cursor-or-pin-invalid")
    result = {"upgradeStoredPin": stored, "verifiedCursor": cursor,
              "chainObservedPin": None, "historicalObservedPin": None,
              "uncoveredFrom": None, "uncoveredTo": None, "uncoveredReason": None}
    chain = status["chains"].get(cid)
    require(isinstance(chain, dict), "upgrade-chain-missing")
    if not chain["qualified"]:
        historical = history["runs"][-1].get("upgradePins", {}).get(identity)
        if historical == stored:
            result["historicalObservedPin"] = stored
        result["uncoveredReason"] = "unknown-current-head"
        return result
    pin = chain["block"]
    result["chainObservedPin"] = pin
    if cursor < pin:
        result["uncoveredFrom"], result["uncoveredTo"] = cursor + 1, pin
        result["uncoveredReason"] = "unscanned-after-verified-cursor"
    else:
        result["uncoveredReason"] = "cursor-at-or-beyond-observed-pin"
    return result


def build(inputs: dict) -> dict:
    validate(inputs)
    records, unique = [], set()
    for surface in ("divergence", "multichain", "dedicated"):
        status = inputs[surface]
        for row in status["sentinels"]:
            identity = row["sentinel"]
            require(isinstance(identity, str) and SAFE_ID.fullmatch(identity), "unsafe-sentinel-id")
            key = (surface, row["chainId"], identity)
            require(key not in unique, "duplicate-top-level-identity")
            unique.add(key)
            reasons = ["observation-not-revalidated", "execution-proof-unknown", "profit-unverified"]
            if not row["ok"]:
                reasons.append("monitor-incomplete")
            if row["fired"]:
                reasons.append("signal-needs-independent-route-proof")
            item = {
                "source": surface, "schema": status["schema"], "runId": status["runId"],
                "at": status["generatedAt"], "chainId": row["chainId"], "id": identity,
                "monitorOk": row["ok"], "fired": row["fired"], "blockingReasons": reasons,
                "profitRank": None, "routeReady": False, "liveReady": False,
                "executionGates": {gate: "unknown" for gate in GATES},
                "executionEconomics": {name: "unknown" for name in ("netProfit", "gas", "slippage", "authorization")},
                "observationFreshness": "not-revalidated",
            }
            if surface == "divergence":
                ledger = inputs["ledger"]
                ledger_row = next(x for x in ledger["records"] if x["chainId"] == row["chainId"] and x["sentinel"] == identity)
                item.update(sourceMarketBound=row.get("measurements", {}).get("marketBound") is True,
                            sourceMarketStateReadable=row.get("measurements", {}).get("marketStateReadable") is True,
                            referenceOk=row["referenceOk"], signalFired=row["fired"],
                            monitorActionableAsObserved=row["actionable"],
                            sourceReportedMarketBinding=ledger_row["sourceReportedMarketBinding"])
                if not row["referenceOk"]:
                    reasons.append("reference-unresolved")
                if not item["sourceMarketBound"]:
                    reasons.append("market-binding-unverified")
            else:
                item["batchMetadataExpiryAt"] = status["batch"]["expiresAt"]
                item["batchMetadataNote"] = "metadata-only-not-signed-approval"
                reasons.append("batch-metadata-not-signed-approval")
                if surface == "multichain":
                    chain = status["chains"].get(str(row["chainId"]))
                    if not chain or not chain["qualified"]:
                        reasons.append("chain-unqualified")
                    if identity in UPGRADES:
                        item.update(upgrade_coverage(row, status, inputs["multichainHistory"]))
                        if item["uncoveredReason"] in ("unknown-current-head", "unscanned-after-verified-cursor"):
                            reasons.append(item["uncoveredReason"])
                    if identity == EQUITY_ID:
                        item["nestedMarketChecks"] = nested_markets(row, chain)
                        if not item["nestedMarketChecks"]["observed"]:
                            reasons.append("nested-market-evidence-unavailable")
            records.append(item)
    records.sort(key=lambda row: (row["source"], row["chainId"], row["id"]))
    by_surface, by_chain, blocked = {}, {}, {}
    for row in records:
        by_surface[row["source"]] = by_surface.get(row["source"], 0) + 1
        cid = str(row["chainId"])
        by_chain[cid] = by_chain.get(cid, 0) + 1
        for reason in row["blockingReasons"]:
            blocked[reason] = blocked.get(reason, 0) + 1
    return {"schema": "all-sentinels-coverage/v1", "sources": {
        surface: {"schema": inputs[surface]["schema"], "runId": inputs[surface]["runId"],
                  "at": inputs[surface]["generatedAt"]} for surface in ("divergence", "multichain", "dedicated")},
        "summary": {"universe": len(records), "bySurface": by_surface, "byChain": by_chain,
                    "rowCompleteness": {"sourceRows": sum(len(inputs[s]["sentinels"]) for s in ("divergence", "multichain", "dedicated")),
                                        "outputRows": len(records), "uniqueTopLevelRows": len(unique)},
                    "blockingCategories": blocked, "verifiedProfitable": 0,
                    "unknownProfitability": len(records), "profitabilityOrderPossible": False,
                    "evidencePriorityIsNotProfitOrder": True}, "records": records}


def output_path(raw: str) -> Path:
    target = Path(raw).absolute()
    require(target.parent == OUTPUT_DIR and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*\.json", target.name),
            "output-outside-allowlist")
    no_symlink_components(target)
    require(not target.exists(), "output-exists")
    return target


def write_new(raw: str, output: dict) -> None:
    target = output_path(raw)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    no_symlink_components(target)
    temporary = target.with_name(target.name + f".{os.getpid()}.tmp")
    try:
        with temporary.open("x", encoding="utf-8") as handle:
            json.dump(output, handle, indent=2, ensure_ascii=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.link(temporary, target)  # exclusive, atomic visibility; never replace a historical report
    finally:
        temporary.unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    for name in ("divergence-status", "divergence-ledger", "multichain-status", "multichain-history",
                 "dedicated-status", "dedicated-history", "out"):
        parser.add_argument("--" + name, required=True)
    args = parser.parse_args(argv)
    try:
        sources = {"divergence": args.divergence_status, "ledger": args.divergence_ledger,
                   "multichain": args.multichain_status, "multichainHistory": args.multichain_history,
                   "dedicated": args.dedicated_status, "dedicatedHistory": args.dedicated_history}
        target = output_path(args.out)
        output = build({name: read_bounded(source) for name, source in sources.items()})
        write_new(str(target), output)
        print(json.dumps({"universe": output["summary"]["universe"], "liveReady": 0, "profitRanked": 0}))
        return 0
    except (ValueError, OSError, KeyError, TypeError, json.JSONDecodeError):
        print("coverage input/output rejected; no profitability inferred", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
