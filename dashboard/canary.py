"""Fail-closed normalization for the exploit re-arm canary page.

The page reads exactly two allowlisted artifacts written by the first-party
sentinel ``tools/monitor-exploit-rearm-canary.js`` (read-only; no signing, no
broadcast) plus the existing wallet-balances artifact. Nothing here trusts
unbounded content: every field is shape-checked before display.
"""

from __future__ import annotations

import math
import re
from typing import Any

from .artifacts import ArtifactReader
from .execution import (
    EXECUTION_REASON as _EXECUTION_REASON,
    TIME_PATTERN as _EXECUTION_TIME,
    execution_view as _execution_view,
)
from .normalize import freshness, timestamp
from .ops import scrub_text, wallet_balances_valid, wallet_row_total, wallet_totals_view

CANARY_SCHEMA = "exploit-rearm-canary/v1"
CANARY_HISTORY_SCHEMA = "exploit-rearm-canary-history/v1"
CANARY_CHAIN_ID = 1
CANARY_SENTINEL_IDS = ("obol-govlst-rearm", "morpho-paxg-misscale", "ammalgam-f1-window")
CANARY_VERDICTS = {"DORMANT", "FIRED"}
REARM_CANARY_VERDICTS = CANARY_VERDICTS | {"INCOMPLETE"}
CANARY_MAX_RUNS = 50
CANARY_CADENCE_SECONDS = 300
_HEX32 = re.compile(r"^0x[0-9a-fA-F]{64}$")
_DECIMAL = re.compile(r"^-?[0-9]+$")

MULTICHAIN_SCHEMA = "exploit-rearm-canary-multichain/v1"
MULTICHAIN_HISTORY_SCHEMA = "exploit-rearm-canary-multichain-history/v1"
MULTICHAIN_CHAIN_IDS = (1, 8453, 42161, 999, 4663, 56, 31612, 480, 747474, 5042)
MULTICHAIN_CHAIN_ALIASES = {
    1: "ethereum", 8453: "base", 42161: "arbitrum", 999: "hyperevm", 4663: "robinhood",
    56: "bsc", 31612: "mezo", 480: "world", 747474: "katana", 5042: "arc",
}
MULTICHAIN_MAX_SENTINELS = 96
MULTICHAIN_MAX_MARKETS = 32
MULTICHAIN_MAX_CHAINS = 16
MULTICHAIN_CADENCE_SECONDS = 300

DIVERGENCE_SCHEMA = "oracle-divergence-monitor/v1"
DIVERGENCE_HISTORY_SCHEMA = "oracle-divergence-monitor-history/v1"
DIVERGENCE_CHAIN_IDS = MULTICHAIN_CHAIN_IDS
DIVERGENCE_CHAIN_ALIASES = MULTICHAIN_CHAIN_ALIASES
DIVERGENCE_KINDS = ("api-market", "constant-oracle", "custom-oracle")
DIVERGENCE_MAX_SENTINELS = 512
DIVERGENCE_CADENCE_SECONDS = 300
DIVERGENCE_MAX_MEASUREMENTS = 64
DIVERGENCE_VERDICTS = {"DORMANT", "FIRED", "INCOMPLETE"}

WALLET_TX_SCHEMA = "exploit-rearm-canary-wallet-tx/v1"
WALLET_TX_MAX_ROWS = 50
WALLET_TX_MAX_CHAINS = 8
WALLET_TX_MAX_AMOUNTS = 16
WALLET_TX_CHAIN_IDS = MULTICHAIN_CHAIN_IDS
WALLET_TX_CHAIN_ALIASES = MULTICHAIN_CHAIN_ALIASES
WALLET_TX_STATUSES = {"mined", "failed", "pending", "RECEIPT_UNAVAILABLE"}
WALLET_TX_DIRECTIONS = {"in", "out", "unknown"}
WALLET_TX_EXPLORERS = {
    1: "https://etherscan.io/tx/",
    8453: "https://basescan.org/tx/",
    42161: "https://arbiscan.io/tx/",
}
WALLET_TX_CADENCE_SECONDS = 3600
WALLET_CADENCE_SECONDS = 900
_ADDRESS = re.compile(r"^0x[0-9a-fA-F]{40}$")
_HEX_METHOD = re.compile(r"^0x[0-9a-fA-F]{8}$")
_TX_AMOUNT = re.compile(r"^-?[0-9][0-9,._ ]{0,39}$")
_TX_SYMBOL = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$")
_USD_2DP = re.compile(r"^-?(?:0|[1-9][0-9]*)\.[0-9]{2}$")
_FIXED_POINT = re.compile(r"^-?[0-9]+(?:\.[0-9]+)?$")
_CREDENTIAL_TEXT = re.compile(
    r"\b(?:authorization|proxy-authorization|headers|cookie|set-cookie|x-api-key|"
    r"(?:private|api|secret)[_ -]?key|token|password|mnemonic)\b[\"']?\s*[:=]"
    r"|\b(?:bearer|basic)\s+\S+",
    re.IGNORECASE,
)

# Only known scalar measurement fields cross the view boundary. Unknown keys,
# objects and arrays are never copied, even when the enclosing artifact is valid.
_MEASUREMENT_TYPES = {
    **dict.fromkeys((
        "payoutAmountWei", "feeAmountWei", "stakerRewardTokenBalanceWei",
        "sumUnclaimedRewardWei", "netObolWei", "lltv", "oraclePriceWei",
        "oraclePrice", "totalSupplyAssets", "totalBorrowAssets", "availableLiquidityUsdcWei",
        "availableRaw", "getDeviation", "deviationThreshold", "usdeUsdAnswer",
        "usdeUsdAnswerThreshold", "observedDeviation",
    ), "raw"),
    **dict.fromkeys((
        "collateralToken", "loanToken", "oracle", "morpho", "clone", "feed", "roleReceiver",
    ), "address"),
    "marketId": "hash",
    "loanSymbol": "symbol",
    **dict.fromkeys(("loanDecimals", "collateralDecimals"), "decimals"),
    **dict.fromkeys((
        "ownedDeposits", "eip1967Addrs", "probes", "logHits", "logScannedFrom", "logScannedTo",
        "pinBlock", "priorPin", "unreadRequired", "legacySlotMismatch", "configDeltas", "staleSeconds", "pinTimestamp",
        "moveBps", "marketsAtOrAboveThreshold", "feedsRead", "maxFeedAgeSec", "marketsGapFired",
        "priceStreak", "priceFirstSeenMs",
    ), "count"),
    **dict.fromkeys((
        "erc4626", "exitPriced", "routePositive", "liquidityFired", "isRebalanceInitiated",
        "gateOpen", "isChallenged", "isPrimary", "deviationFired", "answerFired", "monitorOnly",
        "marketsRead", "executed", "logTruncated", "headerWitness",
        "marketBound", "marketStateReadable", "stablePair", "scaleSuspect", "feedless",
    ), "bool"),
    **dict.fromkeys(("floorUsd", "thresholdUsd", "collateralUsd", "loanUsd", "divergenceBps"), "number"),
    **dict.fromkeys(("availableLiquidityUsd", "maxBorrowUsd"), "fixed"),
    **dict.fromkeys((
        "type", "label", "pair", "routeStatus", "bulkLogs", "arcBinding", "firedReasons",
        "logError", "marketReadError", "referenceMissing",
    ), "text"),
}
_CAP_TYPES = {
    "capitalEthPerAction": "fixed", "gasCeilingEthPerTx": "fixed",
    "flashLoans": "bool", "slippageCriticalLegs": "bool",
}

# Sequential refresher status (tools/refresh-canary-feeds.js -> canary-feeds-refresh/v1).
RUNNER_SCHEMA = "canary-feeds-refresh/v1"
RUNNER_STATUSES = frozenset({"RUNNING", "BLOCKED", "DEGRADED", "FAILED", "UPDATED"})
RUNNER_REASONS = frozenset({
    "MONITORING_WINDOW_CLOSED",
    "PRODUCER_OWNER_PRESENT",
    "PRODUCER_OWNER_REMAINS_ATTENDED_RECOVERY_REQUIRED",
})
RUNNER_FEED_IDS = ("dedicated", "multichain", "divergence")
RUNNER_FEED_REASONS = frozenset({
    "CHILD_TIMEOUT", "CHILD_START_FAILED", "OBSERVATION_NOT_UPDATED_OR_INVALID",
})
RUNNER_VERDICTS = frozenset({"DORMANT", "INCOMPLETE", "FIRED"})
RUNNER_MAX_FEEDS = 3
RUNNER_MAX_INCOMPLETE = 100_000
RUNNER_CADENCE_SECONDS = 300
OBSERVATION_MODES = frozenset({"READ_ONLY_ONCE"})
HISTORICAL_WINDOW_STATES = frozenset({"NOT_STARTED", "OPEN", "WINDOW_CLOSED", "INVALID"})
RUNNER_KEYS = frozenset({
    "schema", "startedAt", "generatedAt", "status", "reason", "updatedCount",
    "monitoringEndsAt", "noSigning", "noBroadcast", "feeds",
    "observationMode", "historicalMonitoringWindowState",
})
RUNNER_FEED_KEYS = frozenset({
    "id", "exitCode", "updated", "generatedAt", "verdict", "incompleteCount", "reason",
    "observationMode", "historicalMonitoringWindowState",
})


def _observation_metadata_valid(value: dict[str, Any]) -> bool:
    for key, allowed in (("observationMode", OBSERVATION_MODES),
                         ("historicalMonitoringWindowState", HISTORICAL_WINDOW_STATES)):
        field = value.get(key)
        if field is not None and (not isinstance(field, str) or field not in allowed):
            return False
    return True


def _observation_metadata_view(value: dict[str, Any]) -> dict[str, str | None]:
    return {
        "observation_mode": value.get("observationMode"),
        "historical_monitoring_window_state": value.get("historicalMonitoringWindowState"),
    }


def _execution_row() -> dict[str, str]:
    return {
        "execution_readiness": "NOT_READY",
        "execution_reason": _EXECUTION_REASON,
        "batch_scope": "NOT_VERIFIED",
    }


def _diagnostic(value: Any, limit: int = 240) -> str | None:
    """Use the shared scrubber, also covering quoted credentials/header values."""

    if not isinstance(value, str):
        return None
    # A diagnostic containing header/credential material is withheld in full;
    # partial regex substitution can leave nested or comma-separated values.
    return scrub_text("…" if _CREDENTIAL_TEXT.search(value) else value, limit)


def _typed_value(value: Any, kind: str) -> Any:
    if kind == "text":
        return _diagnostic(value, 300)
    if kind == "bool":
        return value if isinstance(value, bool) else None
    if kind == "number":
        return value if _finite_number(value) else None
    if kind in {"count", "decimals"}:
        return value if _bounded_uint(value, 255 if kind == "decimals" else 9_007_199_254_740_991) else None
    if not isinstance(value, str) or len(value) > 80:
        return None
    pattern = {"raw": _DECIMAL, "fixed": _FIXED_POINT, "address": _ADDRESS,
               "hash": _HEX32, "symbol": _TX_SYMBOL}[kind]
    return value if pattern.fullmatch(value) else None


def _project_known(value: dict[str, Any], fields: dict[str, str]) -> dict[str, Any]:
    projected = {}
    for key, kind in fields.items():
        if key not in value:
            continue
        clean = _typed_value(value[key], kind)
        if clean is not None or value[key] is None:
            projected[key] = clean
    return projected


def _chain_view(chain_id: int, entry: dict[str, Any]) -> dict[str, Any]:
    return {
        "chain_id": chain_id,
        "alias": MULTICHAIN_CHAIN_ALIASES.get(chain_id, f"chain-{chain_id}"),
        "qualified": entry["qualified"],
        "block": entry.get("block") if _bounded_uint(entry.get("block"), 4_294_967_295) else None,
        "hash": _typed_value(entry.get("hash"), "hash"),
        "reason": _diagnostic(entry.get("reason"), 64),
    }


def _sentinel_valid(row: Any) -> bool:
    if not isinstance(row, dict) or row.get("sentinel") not in CANARY_SENTINEL_IDS:
        return False
    if not isinstance(row.get("fired"), bool) or not isinstance(row.get("ok"), bool):
        return False
    error = row.get("error")
    if error is not None and (not isinstance(error, str) or len(error) > 300):
        return False
    # These two producers omit reason on an unsuccessful read. This is not a
    # success shortcut and cannot admit a reason-less fired observation.
    failure_without_reason = (
        "reason" not in row and row["sentinel"] in CANARY_SENTINEL_IDS[:2]
        and row["ok"] is False and row["fired"] is False
        and isinstance(error, str) and bool(error.strip())
    )
    if not failure_without_reason and (
        not isinstance(row.get("reason"), str) or len(row["reason"]) > 500
    ):
        return False
    measurements = row.get("measurements")
    if measurements is not None:
        if not isinstance(measurements, dict) or len(measurements) > 64:
            return False
        for key, value in measurements.items():
            if not isinstance(key, str) or len(key) > 80:
                return False
            if value is not None and not isinstance(value, (str, bool, int)):
                return False
    pairs = row.get("pairs")
    if pairs is not None:
        if not isinstance(pairs, list) or len(pairs) > 8:
            return False
        for pair in pairs:
            if not isinstance(pair, dict):
                return False
            if not isinstance(pair.get("pair"), str) or len(pair["pair"]) > 64:
                return False
            candidates = pair.get("candidates")
            if candidates is not None and (isinstance(candidates, bool) or not isinstance(candidates, int)):
                return False
            borrowers = pair.get("borrowers")
            if borrowers is not None and (isinstance(borrowers, bool) or not isinstance(borrowers, int)):
                return False
            in_window = pair.get("inWindow")
            if in_window is not None and not isinstance(in_window, dict):
                return False
            if not isinstance(pair.get("fired"), bool):
                return False
            if pair.get("error") is not None and not isinstance(pair.get("error"), str):
                return False
    return True


def _batch_valid(batch: Any) -> bool:
    if not isinstance(batch, dict):
        return False
    if not isinstance(batch.get("name"), str) or len(batch["name"]) > 120:
        return False
    if batch.get("chainId") != CANARY_CHAIN_ID:
        return False
    if timestamp(batch.get("startedAt")) is None or "expiresAt" not in batch:
        return False
    expires_at = batch.get("expiresAt")
    monitor_ends_at = batch.get("monitorEndsAt")
    if expires_at is not None and monitor_ends_at is not None:
        return False
    if any(
        not isinstance(value, str) or not _EXECUTION_TIME.fullmatch(value) or timestamp(value) is None
        for value in (expires_at, monitor_ends_at) if value is not None
    ):
        return False
    if not isinstance(batch.get("profitDestination"), str) or len(batch["profitDestination"]) > 64:
        return False
    caps = batch.get("caps")
    if not isinstance(caps, dict):
        return False
    return (
        caps.get("flashLoans") is False
        and caps.get("slippageCriticalLegs") is False
        and isinstance(caps.get("capitalEthPerAction"), str)
        and isinstance(caps.get("gasCeilingEthPerTx"), str)
    )


def exploit_rearm_canary_valid(state: Any) -> bool:
    """Validate the sentinel's status artifact shape without trusting its verdict."""

    if not isinstance(state, dict) or state.get("schema") != CANARY_SCHEMA:
        return False
    if state.get("chainId") != CANARY_CHAIN_ID:
        return False
    if timestamp(state.get("generatedAt")) is None:
        return False
    if not isinstance(state.get("runId"), str) or len(state["runId"]) > 64:
        return False
    if not _batch_valid(state.get("batch")):
        return False
    if state.get("noSigning") is not True or state.get("noBroadcast") is not True:
        return False
    pin = state.get("pin")
    if not isinstance(pin, dict):
        return False
    block = pin.get("block")
    if isinstance(block, bool) or not isinstance(block, int) or not 0 <= block <= 4_294_967_295:
        return False
    if pin.get("hash") is not None and (_not_str_or_hex(pin["hash"])):
        return False
    if state.get("verdict") not in REARM_CANARY_VERDICTS:
        return False
    fired_count = state.get("firedCount")
    if isinstance(fired_count, bool) or not isinstance(fired_count, int) or not 0 <= fired_count <= 3:
        return False
    fired_sentinels = state.get("firedSentinels")
    if not isinstance(fired_sentinels, list) or any(x not in CANARY_SENTINEL_IDS for x in fired_sentinels):
        return False
    if fired_count != len(fired_sentinels):
        return False
    sentinels = state.get("sentinels")
    if not isinstance(sentinels, list) or len(sentinels) != len(CANARY_SENTINEL_IDS):
        return False
    ids = [
        str(row["sentinel"])
        for row in sentinels
        if isinstance(row, dict) and isinstance(row.get("sentinel"), str)
    ]
    if sorted(ids) != sorted(CANARY_SENTINEL_IDS):
        return False
    if not all(_sentinel_valid(row) for row in sentinels):
        return False
    fired_ids = {row["sentinel"] for row in sentinels if row["fired"]}
    if len(fired_ids) != fired_count or fired_ids != set(fired_sentinels):
        return False
    expected = "FIRED" if fired_count else (
        "INCOMPLETE" if any(not row["ok"] for row in sentinels) else "DORMANT"
    )
    return state["verdict"] == expected


def _not_str_or_hex(value: Any) -> bool:
    return not (isinstance(value, str) and _HEX32.fullmatch(value) is not None)


def exploit_rearm_canary_history_valid(state: Any) -> bool:
    """Validate the bounded history artifact (newest last, capped)."""

    if not isinstance(state, dict) or state.get("schema") != CANARY_HISTORY_SCHEMA:
        return False
    if timestamp(state.get("batchStartedAt")) is None:
        return False
    if timestamp(state.get("generatedAt")) is None:
        return False
    runs = state.get("runs")
    if not isinstance(runs, list) or len(runs) > CANARY_MAX_RUNS:
        return False
    for run in runs:
        if not isinstance(run, dict):
            return False
        if not isinstance(run.get("runId"), str) or len(run["runId"]) > 64:
            return False
        if timestamp(run.get("at")) is None:
            return False
        block = run.get("block")
        if isinstance(block, bool) or not isinstance(block, int) or not 0 <= block <= 4_294_967_295:
            return False
        if run.get("verdict") not in REARM_CANARY_VERDICTS:
            return False
        fired = run.get("fired")
        if not isinstance(fired, list) or any(x not in CANARY_SENTINEL_IDS for x in fired):
            return False
        if not isinstance(run.get("measurements"), dict):
            return False
    return True


def _multichain_measurements_valid(measurements: Any) -> bool:
    if measurements is None:
        return True
    if not isinstance(measurements, dict) or len(measurements) > 64:
        return False
    for key, value in measurements.items():
        if not isinstance(key, str) or len(key) > 80:
            return False
        if value is None or isinstance(value, (str, bool, int)):
            continue
        if not isinstance(value, float) or not math.isfinite(value):
            return False
    return True


def _multichain_markets_valid(markets: Any) -> bool:
    if markets is None:
        return True
    if not isinstance(markets, list) or len(markets) > MULTICHAIN_MAX_MARKETS:
        return False
    for market in markets:
        if not isinstance(market, dict):
            return False
        if not isinstance(market.get("pair"), str) or len(market["pair"]) > 64:
            return False
        if not isinstance(market.get("marketId"), str) or _HEX32.fullmatch(market["marketId"]) is None:
            return False
        if not isinstance(market.get("ok"), bool):
            return False
        for field in ("borrowRaw", "borrowUsd"):
            value = market.get(field)
            if value is not None and (not isinstance(value, str) or len(value) > 80):
                return False
        if market.get("error") is not None and (
            not isinstance(market["error"], str) or len(market["error"]) > 300
        ):
            return False
    return True


def _multichain_sentinel_valid(row: Any) -> bool:
    if not isinstance(row, dict):
        return False
    sentinel = row.get("sentinel")
    if not isinstance(sentinel, str) or not 0 < len(sentinel) <= 120:
        return False
    if row.get("chainId") not in MULTICHAIN_CHAIN_IDS:
        return False
    if not isinstance(row.get("fired"), bool) or not isinstance(row.get("ok"), bool):
        return False
    if not isinstance(row.get("reason"), str) or len(row["reason"]) > 500:
        return False
    error = row.get("error")
    if error is not None and (not isinstance(error, str) or len(error) > 300):
        return False
    row_type = row.get("type")
    if row_type is not None and (not isinstance(row_type, str) or len(row_type) > 40):
        return False
    return _multichain_measurements_valid(row.get("measurements")) and _multichain_markets_valid(
        row.get("markets")
    )


def _multichain_batch_valid(batch: Any) -> bool:
    if not isinstance(batch, dict):
        return False
    if not isinstance(batch.get("name"), str) or len(batch["name"]) > 120:
        return False
    chain_ids = batch.get("chainIds")
    if not isinstance(chain_ids, list) or not chain_ids or len(chain_ids) > MULTICHAIN_MAX_CHAINS:
        return False
    if any(isinstance(cid, bool) or cid not in MULTICHAIN_CHAIN_IDS for cid in chain_ids):
        return False
    if timestamp(batch.get("startedAt")) is None or timestamp(batch.get("expiresAt")) is None:
        return False
    if not isinstance(batch.get("profitDestination"), str) or len(batch["profitDestination"]) > 64:
        return False
    caps = batch.get("caps")
    if not isinstance(caps, dict):
        return False
    return (
        isinstance(caps.get("capitalEthPerAction"), str)
        and isinstance(caps.get("gasCeilingEthPerTx"), str)
        and isinstance(caps.get("flashLoans"), bool)
        and isinstance(caps.get("slippageCriticalLegs"), bool)
    )


def _multichain_chains_valid(chains: Any) -> bool:
    if not isinstance(chains, dict) or not chains or len(chains) > MULTICHAIN_MAX_CHAINS:
        return False
    for key, value in chains.items():
        if not isinstance(key, str) or not key.isdigit() or int(key) not in MULTICHAIN_CHAIN_IDS:
            return False
        if not isinstance(value, dict) or not isinstance(value.get("qualified"), bool):
            return False
        if value["qualified"]:
            block = value.get("block")
            if isinstance(block, bool) or not isinstance(block, int) or not 0 <= block <= 4_294_967_295:
                return False
            if value.get("hash") is not None and _not_str_or_hex(value["hash"]):
                return False
        elif value.get("reason") is not None and (
            not isinstance(value["reason"], str) or len(value["reason"]) > 64
        ):
            return False
    return True


def exploit_rearm_canary_multichain_valid(state: Any) -> bool:
    """Validate the multichain sentinel status artifact shape without trusting its verdict."""

    if not isinstance(state, dict) or state.get("schema") != MULTICHAIN_SCHEMA:
        return False
    if not _observation_metadata_valid(state):
        return False
    if timestamp(state.get("generatedAt")) is None:
        return False
    if not isinstance(state.get("runId"), str) or len(state["runId"]) > 64:
        return False
    if not _multichain_batch_valid(state.get("batch")):
        return False
    if state.get("noSigning") is not True or state.get("noBroadcast") is not True:
        return False
    if not _multichain_chains_valid(state.get("chains")):
        return False
    if state.get("verdict") not in REARM_CANARY_VERDICTS:
        return False
    sentinels = state.get("sentinels")
    if not isinstance(sentinels, list) or not 0 < len(sentinels) <= MULTICHAIN_MAX_SENTINELS:
        return False
    if not all(_multichain_sentinel_valid(row) for row in sentinels):
        return False
    ids = [row["sentinel"] for row in sentinels]
    if len(set(ids)) != len(ids):
        return False
    fired_ids = [row["sentinel"] for row in sentinels if row["fired"]]
    fired_count = state.get("firedCount")
    if isinstance(fired_count, bool) or not isinstance(fired_count, int) or not 0 <= fired_count <= MULTICHAIN_MAX_SENTINELS:
        return False
    fired_sentinels = state.get("firedSentinels")
    if not isinstance(fired_sentinels, list) or any(not isinstance(x, str) or x not in ids for x in fired_sentinels):
        return False
    if fired_count != len(fired_sentinels) or fired_count != len(fired_ids):
        return False
    if set(fired_sentinels) != set(fired_ids):
        return False
    expected = "FIRED" if fired_count else (
        "INCOMPLETE" if any(not row["ok"] for row in sentinels) else "DORMANT"
    )
    return state["verdict"] == expected


def exploit_rearm_canary_multichain_history_valid(state: Any) -> bool:
    """Validate the bounded multichain history artifact (newest last, capped)."""

    if not isinstance(state, dict) or state.get("schema") != MULTICHAIN_HISTORY_SCHEMA:
        return False
    if timestamp(state.get("batchStartedAt")) is None or timestamp(state.get("generatedAt")) is None:
        return False
    runs = state.get("runs")
    if not isinstance(runs, list) or len(runs) > CANARY_MAX_RUNS:
        return False
    for run in runs:
        if not isinstance(run, dict):
            return False
        if not isinstance(run.get("runId"), str) or len(run["runId"]) > 64:
            return False
        if timestamp(run.get("at")) is None:
            return False
        if run.get("verdict") not in REARM_CANARY_VERDICTS:
            return False
        fired = run.get("fired")
        if not isinstance(fired, list) or any(not isinstance(x, str) for x in fired):
            return False
        count = run.get("firedCount")
        if isinstance(count, bool) or not isinstance(count, int) or not 0 <= count <= MULTICHAIN_MAX_SENTINELS:
            return False
        if count != len(fired):
            return False
        chains = run.get("chains")
        if not isinstance(chains, dict):
            return False
        for key, block in chains.items():
            if not isinstance(key, str) or not key.isdigit() or int(key) not in MULTICHAIN_CHAIN_IDS:
                return False
            if block is not None and (
                isinstance(block, bool) or not isinstance(block, int) or not 0 <= block <= 4_294_967_295
            ):
                return False
    return True


def _finite_number(value: Any) -> bool:
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return True
    return isinstance(value, float) and math.isfinite(value)


def _divergence_measurements_valid(measurements: Any) -> bool:
    if measurements is None:
        return True
    if not isinstance(measurements, dict) or len(measurements) > DIVERGENCE_MAX_MEASUREMENTS:
        return False
    for key, value in measurements.items():
        if not isinstance(key, str) or not 0 < len(key) <= 80:
            return False
        if value is None or isinstance(value, (str, bool, int)):
            continue
        if not isinstance(value, float) or not math.isfinite(value):
            return False
    return True


def _divergence_sentinel_valid(row: Any) -> bool:
    if not isinstance(row, dict):
        return False
    sentinel = row.get("sentinel")
    if not isinstance(sentinel, str) or not 0 < len(sentinel) <= 120:
        return False
    if row.get("chainId") not in DIVERGENCE_CHAIN_IDS:
        return False
    if not isinstance(row.get("oracle"), str) or _ADDRESS.fullmatch(row["oracle"]) is None:
        return False
    market_id = row.get("marketId")
    if market_id is not None and (not isinstance(market_id, str) or _HEX32.fullmatch(market_id) is None):
        return False
    pair = row.get("pair")
    if pair is not None and (not isinstance(pair, str) or len(pair) > 64):
        return False
    if row.get("kind") not in DIVERGENCE_KINDS:
        return False
    for field in (
        "fired",
        "ok",
        "referenceOk",
        "sustained",
        "feedless",
        "constantAcrossRuns",
        "borrowsPositive",
        "actionable",
        "scaleSuspect",
    ):
        if not isinstance(row.get(field), bool):
            return False
    if not isinstance(row.get("reason"), str) or len(row["reason"]) > 600:
        return False
    error = row.get("error")
    if error is not None and (not isinstance(error, str) or len(error) > 300):
        return False
    reference_source = row.get("referenceSource")
    if reference_source is not None and (
        not isinstance(reference_source, str) or len(reference_source) > 120
    ):
        return False
    for ratio_field in ("oracleRatio", "referenceRatio", "divergenceBps"):
        value = row.get(ratio_field)
        if value is not None and not _finite_number(value):
            return False
    threshold = row.get("thresholdBps")
    if isinstance(threshold, bool) or not isinstance(threshold, int) or not 0 <= threshold <= 100_000:
        return False
    consecutive = row.get("consecutiveOver")
    if isinstance(consecutive, bool) or not isinstance(consecutive, int) or not 0 <= consecutive <= 10_000:
        return False
    for raw_field in ("borrowRaw", "availableRaw"):
        value = row.get(raw_field)
        if value is not None and (not isinstance(value, str) or _DECIMAL.fullmatch(value) is None):
            return False
    return _divergence_measurements_valid(row.get("measurements"))


def _divergence_thresholds_valid(thresholds: Any) -> bool:
    if not isinstance(thresholds, dict):
        return False
    for key in ("stableBps", "nonStableBps", "sustainRuns"):
        value = thresholds.get(key)
        if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 1_000_000:
            return False
    return True


def _divergence_coverage_valid(coverage: Any) -> bool:
    if not isinstance(coverage, dict) or not coverage or len(coverage) > 16:
        return False
    for key, value in coverage.items():
        if not isinstance(key, str) or not 0 < len(key) <= 40:
            return False
        if not _finite_number(value):
            return False
    return True


def oracle_divergence_monitor_valid(state: Any) -> bool:
    """Validate the dynamic oracle-divergence status artifact without trusting its verdict."""

    if not isinstance(state, dict) or state.get("schema") != DIVERGENCE_SCHEMA:
        return False
    if timestamp(state.get("generatedAt")) is None:
        return False
    if not isinstance(state.get("runId"), str) or len(state["runId"]) > 64:
        return False
    if (
        state.get("noSigning") is not True
        or state.get("noBroadcast") is not True
        or state.get("noManipulation") is not True
    ):
        return False
    if not _divergence_thresholds_valid(state.get("thresholds")):
        return False
    if not _multichain_chains_valid(state.get("chains")):
        return False
    if not _divergence_coverage_valid(state.get("coverage")):
        return False
    sentinels = state.get("sentinels")
    if not isinstance(sentinels, list) or not 0 < len(sentinels) <= DIVERGENCE_MAX_SENTINELS:
        return False
    if not all(_divergence_sentinel_valid(row) for row in sentinels):
        return False
    ids = [row["sentinel"] for row in sentinels]
    if len(set(ids)) != len(ids):
        return False
    if state.get("verdict") not in DIVERGENCE_VERDICTS:
        return False
    fired_count = state.get("firedCount")
    if (
        isinstance(fired_count, bool)
        or not isinstance(fired_count, int)
        or not 0 <= fired_count <= DIVERGENCE_MAX_SENTINELS
    ):
        return False
    fired_sentinels = state.get("firedSentinels")
    if not isinstance(fired_sentinels, list) or any(
        not isinstance(x, str) or x not in ids for x in fired_sentinels
    ):
        return False
    fired_ids = [row["sentinel"] for row in sentinels if row["fired"]]
    if fired_count != len(fired_sentinels) or fired_count != len(fired_ids):
        return False
    if set(fired_sentinels) != set(fired_ids):
        return False
    sustained = state.get("sustainedCount")
    if (
        isinstance(sustained, bool)
        or not isinstance(sustained, int)
        or not 0 <= sustained <= DIVERGENCE_MAX_SENTINELS
    ):
        return False
    if sustained != len([row for row in sentinels if row["sustained"]]):
        return False
    expected = (
        "FIRED" if fired_count > 0
        else "INCOMPLETE" if any(not row["ok"] for row in sentinels) or any(
            not chain["qualified"] for chain in state["chains"].values()
        ) else "DORMANT"
    )
    return state["verdict"] == expected


def _divergence_ratio_map_valid(value: Any) -> bool:
    if value is None:
        return True
    if not isinstance(value, dict) or len(value) > DIVERGENCE_MAX_SENTINELS:
        return False
    for key, entry in value.items():
        if not isinstance(key, str) or not 0 < len(key) <= 80:
            return False
        if not (isinstance(entry, str) or _finite_number(entry)):
            return False
    return True


def oracle_divergence_monitor_history_valid(state: Any) -> bool:
    """Validate the bounded divergence history (newest last, capped)."""

    if not isinstance(state, dict) or state.get("schema") != DIVERGENCE_HISTORY_SCHEMA:
        return False
    if timestamp(state.get("generatedAt")) is None:
        return False
    runs = state.get("runs")
    if not isinstance(runs, list) or len(runs) > CANARY_MAX_RUNS:
        return False
    for run in runs:
        if not isinstance(run, dict):
            return False
        if not isinstance(run.get("runId"), str) or len(run["runId"]) > 64:
            return False
        if timestamp(run.get("at")) is None:
            return False
        if run.get("verdict") not in DIVERGENCE_VERDICTS:
            return False
        fired = run.get("fired")
        if not isinstance(fired, list) or any(not isinstance(x, str) for x in fired):
            return False
        count = run.get("firedCount")
        if (
            isinstance(count, bool)
            or not isinstance(count, int)
            or not 0 <= count <= DIVERGENCE_MAX_SENTINELS
        ):
            return False
        if count != len(fired):
            return False
        if (run["verdict"] == "FIRED") != (count > 0):
            return False
        chains = run.get("chains")
        if not isinstance(chains, dict):
            return False
        for key, block in chains.items():
            if not isinstance(key, str) or not key.isdigit() or int(key) not in DIVERGENCE_CHAIN_IDS:
                return False
            if block is not None and (
                isinstance(block, bool) or not isinstance(block, int) or not 0 <= block <= 4_294_967_295
            ):
                return False
        for map_field in ("prices", "priceStreak", "consecutiveOver", "priceFirstSeen"):
            if not _divergence_ratio_map_valid(run.get(map_field)):
                return False
    return True


def _bounded_uint(value: Any, maximum: int) -> bool:
    return not isinstance(value, bool) and isinstance(value, int) and 0 <= value <= maximum


def _wallet_tx_amount_valid(amount: Any) -> bool:
    if not isinstance(amount, dict):
        return False
    token = amount.get("token")
    if token is not None and (not isinstance(token, str) or _ADDRESS.fullmatch(token) is None):
        return False
    symbol = amount.get("symbol")
    if symbol is not None and (not isinstance(symbol, str) or _TX_SYMBOL.fullmatch(symbol) is None):
        return False
    decimals = amount.get("decimals")
    if decimals is not None and (isinstance(decimals, bool) or not isinstance(decimals, int) or not 0 <= decimals <= 255):
        return False
    raw = amount.get("raw")
    if not isinstance(raw, str) or _DECIMAL.fullmatch(raw) is None:
        return False
    formatted = amount.get("formatted")
    if formatted is not None and (not isinstance(formatted, str) or _TX_AMOUNT.fullmatch(formatted) is None):
        return False
    return amount.get("direction") in ("in", "out")


def _wallet_tx_row_valid(row: Any) -> bool:
    if not isinstance(row, dict):
        return False
    if not isinstance(row.get("hash"), str) or _HEX32.fullmatch(row["hash"]) is None:
        return False
    if type(row.get("chainId")) is not int or row["chainId"] not in WALLET_TX_CHAIN_IDS:
        return False
    block = row.get("blockNumber")
    if block is not None and not _bounded_uint(block, 4_294_967_295):
        return False
    if row.get("blockTimestamp") is not None and timestamp(row["blockTimestamp"]) is None:
        return False
    if row.get("status") not in WALLET_TX_STATUSES:
        return False
    if row["status"] == "RECEIPT_UNAVAILABLE" and block is None:
        return False
    if row["status"] == "pending" and block is not None:
        return False
    if row.get("direction") not in WALLET_TX_DIRECTIONS:
        return False
    for field in ("from", "to"):
        value = row.get(field)
        if value is not None and (not isinstance(value, str) or _ADDRESS.fullmatch(value) is None):
            return False
    method = row.get("method")
    if method is not None and (not isinstance(method, str) or _HEX_METHOD.fullmatch(method) is None):
        return False
    method_name = row.get("methodName")
    if method_name is not None and (not isinstance(method_name, str) or len(method_name) > 64):
        return False
    description = row.get("description")
    if not isinstance(description, str) or not 0 < len(description) <= 300:
        return False
    for field in ("gasUsed", "gasPriceWei"):
        value = row.get(field)
        if value is not None and (not isinstance(value, str) or _DECIMAL.fullmatch(value) is None):
            return False
    amounts = row.get("amounts")
    if not isinstance(amounts, list) or len(amounts) > WALLET_TX_MAX_AMOUNTS:
        return False
    if not all(_wallet_tx_amount_valid(amount) for amount in amounts):
        return False
    error = row.get("error")
    if error is not None and (not isinstance(error, str) or len(error) > 300):
        return False
    return True


def exploit_rearm_canary_wallet_transactions_valid(state: Any) -> bool:
    """Validate the bounded wallet transaction-history artifact, fail-closed."""

    if not isinstance(state, dict) or state.get("schema") != WALLET_TX_SCHEMA:
        return False
    if not isinstance(state.get("wallet"), str) or _ADDRESS.fullmatch(state["wallet"]) is None:
        return False
    if timestamp(state.get("generatedAt")) is None:
        return False
    if not _bounded_uint(state.get("durationMs"), 86_400_000):
        return False
    max_rows = state.get("maxRows")
    if isinstance(max_rows, bool) or not isinstance(max_rows, int) or not 1 <= max_rows <= WALLET_TX_MAX_ROWS:
        return False
    chains = state.get("chains")
    if not isinstance(chains, list) or not chains or len(chains) > WALLET_TX_MAX_CHAINS:
        return False
    total = 0
    seen_chains: set[int] = set()
    for chain in chains:
        if not isinstance(chain, dict):
            return False
        chain_id = chain.get("chainId")
        if type(chain_id) is not int or chain_id not in WALLET_TX_CHAIN_IDS or chain_id in seen_chains:
            return False
        seen_chains.add(chain_id)
        if not isinstance(chain.get("name"), str) or len(chain["name"]) > 40:
            return False
        for field in ("headBlock", "nonce"):
            value = chain.get(field)
            if value is not None and not _bounded_uint(value, 4_294_967_295):
                return False
        rows = chain.get("rows")
        if not isinstance(rows, list) or len(rows) > WALLET_TX_MAX_ROWS:
            return False
        if not all(_wallet_tx_row_valid(row) and row["chainId"] == chain_id for row in rows):
            return False
        total += len(rows)
        error = chain.get("error")
        if error is not None and (not isinstance(error, str) or len(error) > 300):
            return False
    if total > WALLET_TX_MAX_ROWS:
        return False
    if state.get("rowCount") != total:
        return False
    if state.get("noSigning") is not True or state.get("noBroadcast") is not True:
        return False
    errors = state.get("errors")
    if not isinstance(errors, list) or len(errors) > 100:
        return False
    for error in errors:
        if not isinstance(error, dict) or not isinstance(error.get("scope"), str) or not isinstance(error.get("message"), str):
            return False
        if len(error["scope"]) > 64 or len(error["message"]) > 200:
            return False
    return True


def _multichain_sentinel_view(row: dict[str, Any]) -> dict[str, Any]:
    measurements = _project_known(row.get("measurements") or {}, _MEASUREMENT_TYPES)
    view = {
        "id": _diagnostic(row["sentinel"], 120),
        "chain_id": row["chainId"],
        "type": _diagnostic(row.get("type"), 40),
        "label": measurements.get("label"),
        "fired": row["fired"],
        "ok": row["ok"],
        "reason": _diagnostic(row["reason"], 500),
        "error": _diagnostic(row.get("error"), 300),
        "executed": row.get("executed") is True,
        "executed_at": row.get("executedAt") if timestamp(row.get("executedAt")) is not None else None,
        "route_status": _diagnostic(row.get("routeStatus"), 120),
        "route_positive": _typed_value(row.get("routePositive"), "bool"),
        **_execution_row(),
        "measurements": measurements,
        "markets": [],
    }
    for market in row.get("markets") or []:
        view["markets"].append(
            {
                "pair": _diagnostic(market.get("pair"), 64),
                "market_id": market.get("marketId"),
                "borrow_raw": _typed_value(market.get("borrowRaw"), "raw"),
                "borrow_usd": _typed_value(market.get("borrowUsd"), "fixed"),
                "ok": market.get("ok"),
                "error": _diagnostic(market.get("error"), 300),
                "feed": _typed_value(market.get("feed"), "address"),
                "feed_age_sec": _typed_value(market.get("feedAgeSec"), "number"),
                "round_moved_pct": _typed_value(market.get("roundMovedPct"), "number"),
                "gap_fired": _typed_value(market.get("gapFired"), "bool"),
                "debt_at_or_above_threshold": _typed_value(market.get("debtAtOrAboveThreshold"), "bool"),
            }
        )
    return view


def _multichain_view(reader: ArtifactReader, now: float) -> dict[str, Any]:
    status = reader.read_json(
        "exploit_rearm_canary_multichain", validator=exploit_rearm_canary_multichain_valid
    )
    value = status.value if isinstance(status.value, dict) else None
    if value is None or not status.current:
        return {
            "available": False,
            **_observation_metadata_view({}),
            "freshness": "STALE",
            "age": None,
            "verdict": None,
            "fired_count": 0,
            "fired_sentinels": [],
            "batch": None,
            "chains": [],
            "groups": [],
            "runs": [],
            "history_available": False,
        }

    fresh, age = freshness(
        value["generatedAt"], now, MULTICHAIN_CADENCE_SECONDS * 2, MULTICHAIN_CADENCE_SECONDS * 6
    )
    batch = value["batch"]
    expires = timestamp(batch["expiresAt"])
    chains = []
    for key, entry in value["chains"].items():
        chain_id = int(key)
        chains.append(_chain_view(chain_id, entry))
    chains.sort(key=lambda item: MULTICHAIN_CHAIN_IDS.index(item["chain_id"]))
    groups = []
    for chain in chains:
        rows = [row for row in value["sentinels"] if row["chainId"] == chain["chain_id"]]
        if rows:
            groups.append({**chain, "sentinels": [_multichain_sentinel_view(row) for row in rows]})

    runs = []
    history = reader.read_json(
        "exploit_rearm_canary_multichain_history",
        validator=exploit_rearm_canary_multichain_history_valid,
    )
    history_value = history.value if isinstance(history.value, dict) else None
    history_available = history.current and history_value is not None
    if history_available and history_value is not None:
        for run in reversed(history_value["runs"][-12:]):
            runs.append(
                {
                    "at": run.get("at"),
                    "verdict": run.get("verdict"),
                    "fired": [_diagnostic(item, 120) for item in run.get("fired", [])],
                    "fired_count": run.get("firedCount"),
                }
            )
    return {
        "available": True,
        **_observation_metadata_view(value),
        "freshness": fresh,
        "age": age,
        "generated_at": value["generatedAt"],
        "verdict": value["verdict"],
        "fired_count": value["firedCount"],
        "fired_sentinels": [_diagnostic(item, 120) for item in value["firedSentinels"]],
        "batch": {
            "name": _diagnostic(batch["name"], 120),
            "chain_ids": batch["chainIds"],
            "started_at": batch["startedAt"],
            "expires_at": batch["expiresAt"],
            "expired": bool(expires is not None and now >= expires),
            "expires_in": max(0, int(expires - now)) if expires is not None else None,
            "profit_destination": _typed_value(batch["profitDestination"], "address"),
            "caps": _project_known(batch["caps"], _CAP_TYPES),
        },
        "chains": chains,
        "groups": groups,
        "runs": runs,
        "history_available": history_available,
    }


def _divergence_sentinel_view(row: dict[str, Any]) -> dict[str, Any]:
    measurements = _project_known(row.get("measurements") or {}, _MEASUREMENT_TYPES)
    return {
        "id": _diagnostic(row["sentinel"], 120),
        "chain_id": row["chainId"],
        "oracle": row["oracle"],
        "market_id": row.get("marketId"),
        "pair": _diagnostic(row.get("pair"), 64),
        "kind": row["kind"],
        "fired": row["fired"],
        "ok": row["ok"],
        "reason": _diagnostic(row["reason"], 600),
        "error": _diagnostic(row.get("error"), 300),
        "reference_ok": row["referenceOk"],
        "reference_source": _diagnostic(row.get("referenceSource"), 120),
        "oracle_ratio": row.get("oracleRatio"),
        "reference_ratio": row.get("referenceRatio"),
        "divergence_bps": row.get("divergenceBps"),
        "threshold_bps": row["thresholdBps"],
        "scale_suspect": row["scaleSuspect"],
        "sustained": row["sustained"],
        "feedless": row["feedless"],
        "constant_across_runs": row["constantAcrossRuns"],
        "borrows_positive": row["borrowsPositive"],
        "actionable": row["actionable"],
        "consecutive_over": row["consecutiveOver"],
        "borrow_raw": row.get("borrowRaw"),
        "available_raw": row.get("availableRaw"),
        **_execution_row(),
        "measurements": measurements,
    }


def _divergence_view(reader: ArtifactReader, now: float) -> dict[str, Any]:
    """Normalize the dynamic oracle-divergence artifact for the canary page."""

    empty = {
        "available": False,
        "freshness": "STALE",
        "age": None,
        "generated_at": None,
        "verdict": None,
        "fired_count": 0,
        "fired_sentinels": [],
        "sustained_count": 0,
        "thresholds": None,
        "coverage": None,
        "chains": [],
        "groups": [],
        "runs": [],
        "history_available": False,
    }
    read = reader.read_json("oracle_divergence_monitor", validator=oracle_divergence_monitor_valid)
    value = read.value if isinstance(read.value, dict) else None
    if value is None or not read.current:
        return empty

    fresh, age = freshness(
        value["generatedAt"], now, DIVERGENCE_CADENCE_SECONDS * 2, DIVERGENCE_CADENCE_SECONDS * 6
    )
    chains = []
    for key, entry in value["chains"].items():
        chain_id = int(key)
        chains.append(_chain_view(chain_id, entry))
    chains.sort(key=lambda item: DIVERGENCE_CHAIN_IDS.index(item["chain_id"]))
    groups = []
    for chain in chains:
        rows = [row for row in value["sentinels"] if row["chainId"] == chain["chain_id"]]
        if rows:
            groups.append({**chain, "sentinels": [_divergence_sentinel_view(row) for row in rows]})
    runs = []
    history = reader.read_json(
        "oracle_divergence_monitor_history", validator=oracle_divergence_monitor_history_valid
    )
    history_value = history.value if isinstance(history.value, dict) else None
    history_available = history.current and history_value is not None
    if history_available and history_value is not None:
        for run in reversed(history_value["runs"][-12:]):
            runs.append(
                {
                    "at": run.get("at"),
                    "verdict": run.get("verdict"),
                    "fired": [_diagnostic(item, 120) for item in run.get("fired", [])],
                    "fired_count": run.get("firedCount"),
                }
            )
    return {
        "available": True,
        "freshness": fresh,
        "age": age,
        "generated_at": value["generatedAt"],
        "verdict": value["verdict"],
        "fired_count": value["firedCount"],
        "fired_sentinels": [_diagnostic(item, 120) for item in value["firedSentinels"]],
        "sustained_count": value["sustainedCount"],
        "thresholds": _project_known(value["thresholds"], dict.fromkeys(
            ("stableBps", "nonStableBps", "sustainRuns", "minDexDepthUsd"), "number")),
        "coverage": _project_known(value["coverage"], dict.fromkeys(
            ("universe", "apiMarkets", "constantOracles", "referenceResolved", "referenceResolvedPct"), "number")),
        "chains": chains,
        "groups": groups,
        "runs": runs,
        "history_available": history_available,
    }


def _format_wei(value: Any, decimals: int) -> str | None:
    """Render an integer wei string into a fixed-point display string."""

    if _typed_value(value, "raw") is None:
        return None
    negative = value.startswith("-")
    digits = value[1:] if negative else value
    if len(digits) <= decimals:
        fraction = digits.zfill(decimals)
        whole = "0"
    else:
        fraction = digits[-decimals:]
        whole = digits[:-decimals]
    result = f"{whole}.{fraction}".rstrip("0").rstrip(".") or "0"
    return ("-" if negative else "") + result


def _obol_view(measurements: dict[str, Any]) -> dict[str, Any]:
    measurements = _project_known(measurements, _MEASUREMENT_TYPES)
    return {
        "payout_obol": _format_wei(measurements.get("payoutAmountWei"), 18),
        "fee_obol": _format_wei(measurements.get("feeAmountWei"), 18),
        "staker_balance_obol": _format_wei(measurements.get("stakerRewardTokenBalanceWei"), 18),
        "unclaimed_obol": _format_wei(measurements.get("sumUnclaimedRewardWei"), 18),
        "net_obol": _format_wei(measurements.get("netObolWei"), 18),
        "owned_deposits": measurements.get("ownedDeposits"),
    }


def _morpho_view(measurements: dict[str, Any]) -> dict[str, Any]:
    measurements = _project_known(measurements, _MEASUREMENT_TYPES)
    lltv = measurements.get("lltv")
    # WAD -> percent as exact decimal text, never via binary float. Oracle price
    # remains raw protocol units, not USD; OBOL net remains pre-gas surplus.
    lltv_pct = _format_wei(lltv, 16) if (
        lltv is not None and re.fullmatch(r"[0-9]{1,19}", lltv) and int(lltv) <= 10**18
    ) else None
    return {
        "available_usdc": _format_wei(measurements.get("availableLiquidityUsdcWei"), 6),
        "total_supply_usdc": _format_wei(measurements.get("totalSupplyAssets"), 6),
        "total_borrow_usdc": _format_wei(measurements.get("totalBorrowAssets"), 6),
        "oracle_price_wei": measurements.get("oraclePriceWei"),
        "lltv": measurements.get("lltv"),
        "lltv_pct": lltv_pct,
        "oracle": measurements.get("oracle"),
    }


def _ammalgam_view(row: dict[str, Any]) -> dict[str, Any]:
    pairs = []
    for pair in row.get("pairs") or []:
        window = pair.get("inWindow")
        pairs.append(
            {
                "pair": _typed_value(pair.get("pair"), "address"),
                "candidates": pair.get("candidates"),
                "borrowers": pair.get("borrowers"),
                "fired": pair.get("fired"),
                "error": _diagnostic(pair.get("error"), 300),
                "window": None
                if not isinstance(window, dict)
                else {
                    "borrower": _typed_value(window.get("borrower"), "address"),
                    "ratio_bips": _typed_value(window.get("ratioBips"), "raw"),
                    "liquidate_eth_call": _diagnostic(window.get("liquidateEthCall"), 120),
                },
            }
        )
    return {"pairs": pairs}


def _transactions_view(reader: ArtifactReader, now: float) -> dict[str, Any]:
    """Normalize the bounded wallet transaction-history artifact for display."""

    empty = {
        "available": False,
        "as_of": None,
        "freshness": "UNKNOWN",
        "age": None,
        "stale": False,
        "wallet": None,
        "wallet_short": None,
        "rows": [],
        "chains": [],
        "row_count": 0,
        "errors": [],
        "no_signing": None,
        "no_broadcast": None,
    }
    read = reader.read_json(
        "exploit_rearm_canary_wallet_transactions",
        validator=exploit_rearm_canary_wallet_transactions_valid,
    )
    value = read.value if isinstance(read.value, dict) else None
    if value is None or not read.current:
        return empty

    fresh, age = freshness(
        value["generatedAt"], now, WALLET_TX_CADENCE_SECONDS * 2, WALLET_TX_CADENCE_SECONDS * 6
    )
    rows: list[dict[str, Any]] = []
    chains = []
    for chain in value["chains"]:
        chain_id = chain["chainId"]
        alias = WALLET_TX_CHAIN_ALIASES.get(chain_id, f"chain-{chain_id}")
        explorer = WALLET_TX_EXPLORERS.get(chain_id)
        chain_rows = []
        for row in chain["rows"]:
            amounts = [
                {
                    "token": amount.get("token"),
                    "symbol": amount.get("symbol"),
                    "decimals": amount.get("decimals"),
                    "raw": amount["raw"],
                    "formatted": amount.get("formatted"),
                    "direction": amount["direction"],
                }
                for amount in row["amounts"]
            ]
            view = {
                "hash": row["hash"],
                "short_hash": f"{row['hash'][:10]}\u2026{row['hash'][-4:]}",
                "explorer_url": f"{explorer}{row['hash']}" if explorer else None,
                "chain_id": chain_id,
                "chain": alias,
                "block": row.get("blockNumber"),
                "time": row.get("blockTimestamp"),
                "status": row["status"],
                "direction": row["direction"],
                "description": _diagnostic(row["description"], 300),
                "method_name": _diagnostic(row.get("methodName"), 64),
                "error": _diagnostic(row.get("error"), 300),
                "gas_used": row.get("gasUsed"),
                "gas_price_wei": row.get("gasPriceWei"),
                "amounts": amounts,
            }
            chain_rows.append(view)
            rows.append(view)
        chains.append(
            {
                "chain_id": chain_id,
                "chain": alias,
                "head_block": chain.get("headBlock"),
                "nonce": chain.get("nonce"),
                "rows": chain_rows,
                "error": _diagnostic(chain.get("error"), 300),
            }
        )
    rows.sort(key=lambda item: timestamp(item.get("time")) or 0.0, reverse=True)
    wallet = value["wallet"]
    return {
        "available": True,
        "as_of": value["generatedAt"],
        "freshness": fresh,
        "age": age,
        "stale": fresh in {"STALE", "CLOCK_SKEW"},
        "wallet": wallet,
        "wallet_short": f"{wallet[:6]}\u2026{wallet[-4:]}",
        "rows": rows,
        "chains": chains,
        "row_count": value["rowCount"],
        "errors": [
            {"scope": _diagnostic(error["scope"], 64), "message": _diagnostic(error["message"], 200)}
            for error in value["errors"]
        ],
        "no_signing": value.get("noSigning"),
        "no_broadcast": value.get("noBroadcast"),
    }


def _age_text(age: Any) -> str | None:
    if not isinstance(age, (int, float)) or isinstance(age, bool) or age != age or age < 0:
        return None
    seconds = int(age)
    if seconds < 90:
        return f"{seconds}s"
    if seconds < 5_400:
        return f"{seconds // 60}m"
    if seconds < 172_800:
        return f"{seconds // 3_600}h"
    return f"{seconds // 86_400}d"


def _usd_text(value: Any) -> str | None:
    """Accept only an explicit 2-decimal USD string; anything else is unknown."""

    if not isinstance(value, str) or _USD_2DP.fullmatch(value.strip()) is None:
        return None
    return value.strip()


def _sum_usd(values: list[Any]) -> str | None:
    """Sum explicit 2dp USD strings; unknown when empty or any value is unpriced."""

    if not values:
        return None
    cents = 0
    for value in values:
        text = _usd_text(value)
        if text is None:
            return None
        negative = text.startswith("-")
        whole, _, fraction = (text[1:] if negative else text).partition(".")
        amount = int(whole) * 100 + int(fraction)
        cents += -amount if negative else amount
    return f"{'-' if cents < 0 else ''}{abs(cents) // 100}.{abs(cents) % 100:02d}"


def _amount_view(value: Any) -> dict[str, Any] | None:
    """Project one native/token amount with explicit zero vs no-data markers."""

    if not isinstance(value, dict):
        return None
    symbol = value.get("symbol")
    if not isinstance(symbol, str) or not symbol:
        return None
    formatted = value.get("formatted")
    if not isinstance(formatted, str):
        formatted = None
    return {
        "symbol": symbol,
        "formatted": formatted,
        "usd": _usd_text(value.get("usd")),
        "is_zero": formatted == "0",
        "is_no_data": formatted is None,
    }


def _balance_rows(
    wallet_state: Any, wallet_fresh: bool, destination: Any, now: float
) -> dict[str, Any]:
    """Normalize the wallet-balance snapshot into a per-chain display view.

    Missing reads stay visible as "no data" and a single unresolved token no
    longer invalidates the snapshot; per-chain subtotals fail closed (``None``)
    whenever any contributing row is incomplete.
    """

    empty = {
        "available": False,
        "as_of": None,
        "freshness": "STALE",
        "age": None,
        "age_text": None,
        "stale": False,
        "rows": [],
        "chains": [],
        "solana": [],
        "totals": None,
        "errors": [],
        "unpriced_chains": [],
    }
    if not isinstance(wallet_state, dict) or not wallet_fresh:
        return empty
    fresh, age = freshness(
        wallet_state.get("asOf"), now, WALLET_CADENCE_SECONDS * 2, WALLET_CADENCE_SECONDS * 6
    )
    labels: dict[str, str] = {}
    for entry in wallet_state.get("addresses", []):
        if isinstance(entry, dict) and isinstance(entry.get("address"), str):
            label = entry.get("label")
            labels[entry["address"].lower()] = _diagnostic(label, 80) or ""
    rows: list[dict[str, Any]] = []
    chains = []
    for chain in wallet_state.get("chains", []):
        chain_rows = []
        for row in chain.get("addressRows", []):
            address = str(row.get("address", ""))
            native = _amount_view(row.get("native"))
            tokens = [
                view
                for view in (_amount_view(token) for token in (row.get("tokens") or []))
                if view is not None
            ]
            view = {
                "address": address,
                "short": f"{address[:6]}\u2026{address[-4:]}" if len(address) >= 10 else address,
                "label": labels.get(address.lower()),
                "is_profit_destination": (
                    isinstance(destination, str) and address.lower() == destination.lower()
                ),
                "block": row.get("blockNumber"),
                "native": native,
                "tokens": tokens,
                "total_usd": wallet_row_total(row),
                "stable_usd_total": _usd_text(row.get("stableUsdTotal")),
                "error": _diagnostic(row.get("error"), 200),
            }
            chain_rows.append(view)
            rows.append({**view, "chain": _diagnostic(chain.get("name"), 40), "chain_id": chain.get("chainId")})
        if not chain_rows:
            continue
        chains.append(
            {
                "chain": _diagnostic(chain.get("name"), 40),
                "chain_id": chain.get("chainId"),
                "rows": chain_rows,
                "native_symbol": next(
                    (row["native"]["symbol"] for row in chain_rows if row["native"]), None
                ),
            }
        )
    solana_rows = []
    for row in wallet_state.get("solana") or []:
        if not isinstance(row, dict) or not isinstance(row.get("address"), str):
            continue
        solana_rows.append(
            {
                "address": row["address"],
                "short": f"{row['address'][:4]}\u2026{row['address'][-4:]}",
                "label": _diagnostic(row.get("label"), 80),
                "slot": row.get("slot"),
                "native": _amount_view(row.get("native")),
                "tokens": [
                    view
                    for view in (_amount_view(token) for token in (row.get("tokens") or []))
                    if view is not None
                ],
                "total_usd": wallet_row_total(row),
                "stable_usd_total": _usd_text(row.get("stableUsdTotal")),
                "error": _diagnostic(row.get("error"), 200),
            }
        )
    rows.sort(key=lambda item: not item["is_profit_destination"])
    # wallet_balances_valid already bounds chains, addresses and tokens. Do not
    # truncate the displayed holdings while retaining totals over hidden rows.
    for chain in chains:
        complete = all(
            row["total_usd"] is not None
            and not any(token["is_no_data"] for token in row["tokens"])
            for row in chain["rows"]
        )
        chain["complete"] = complete
        chain["subtotal_usd"] = _sum_usd([row["total_usd"] for row in chain["rows"]]) if complete else None
    totals = wallet_totals_view(wallet_state)
    if totals is not None:
        raw_totals = wallet_state["totals"]
        totals["note"] = _diagnostic(raw_totals.get("note"), 120)
        raw_unpriced = raw_totals.get("unpricedChains")
        totals["unpricedChains"] = [
            _diagnostic(item, 40) or "unknown" for item in raw_unpriced if isinstance(item, str)
        ][:64] if isinstance(raw_unpriced, list) else []
    unpriced = totals.get("unpricedChains") if totals else None
    unpriced_chains = (
        [item[:40] for item in unpriced if isinstance(item, str)][:64]
        if isinstance(unpriced, list)
        else []
    )
    errors = [
        {"scope": _diagnostic(error.get("scope"), 64) or "unknown", "message": _diagnostic(error.get("message"), 200) or "error"}
        for error in (wallet_state.get("errors") or [])
        if isinstance(error, dict) and isinstance(error.get("message"), str)
    ]
    return {
        "available": True,
        "as_of": wallet_state.get("asOf"),
        "freshness": fresh,
        "age": age,
        "age_text": _age_text(age),
        "stale": fresh in {"STALE", "CLOCK_SKEW"},
        "rows": rows,
        "chains": chains,
        "solana": solana_rows,
        "totals": totals,
        "errors": errors,
        "unpriced_chains": unpriced_chains,
    }


def _runner_feed_valid(row: Any) -> bool:
    if not isinstance(row, dict) or set(row) - RUNNER_FEED_KEYS:
        return False
    if not _observation_metadata_valid(row):
        return False
    if row.get("id") not in RUNNER_FEED_IDS:
        return False
    exit_code = row.get("exitCode")
    if exit_code is not None and (
        isinstance(exit_code, bool) or not isinstance(exit_code, int) or not 0 <= exit_code <= 255
    ):
        return False
    if not isinstance(row.get("updated"), bool):
        return False
    generated = row.get("generatedAt")
    if generated is not None and (
        not isinstance(generated, str) or not _EXECUTION_TIME.fullmatch(generated) or timestamp(generated) is None
    ):
        return False
    if row["updated"] and generated is None:
        return False
    verdict = row.get("verdict")
    if verdict is not None and verdict not in RUNNER_VERDICTS:
        return False
    incomplete = row.get("incompleteCount")
    if incomplete is not None and (
        isinstance(incomplete, bool) or not isinstance(incomplete, int) or not 0 <= incomplete <= RUNNER_MAX_INCOMPLETE
    ):
        return False
    reason = row.get("reason")
    if reason is not None and reason not in RUNNER_FEED_REASONS:
        return False
    return True


def canary_feeds_runner_valid(value: Any) -> bool:
    """Validate the bounded refresher-status contract; every field is an allowlisted shape."""

    if not isinstance(value, dict) or set(value) - RUNNER_KEYS:
        return False
    if not _observation_metadata_valid(value):
        return False
    if value.get("schema") != RUNNER_SCHEMA:
        return False
    if value.get("noSigning") is not True or value.get("noBroadcast") is not True:
        return False
    if value.get("status") not in RUNNER_STATUSES:
        return False
    reason = value.get("reason")
    if reason is not None and reason not in RUNNER_REASONS:
        return False
    started = value.get("startedAt")
    if not isinstance(started, str) or not _EXECUTION_TIME.fullmatch(started) or timestamp(started) is None:
        return False
    generated = value.get("generatedAt")
    if generated is not None and (
        not isinstance(generated, str) or not _EXECUTION_TIME.fullmatch(generated) or timestamp(generated) is None
    ):
        return False
    if generated is not None and timestamp(generated) < timestamp(started):
        return False
    count = value.get("updatedCount")
    if isinstance(count, bool) or not isinstance(count, int) or not 0 <= count <= RUNNER_MAX_FEEDS:
        return False
    window = value.get("monitoringEndsAt")
    if window is not None and (
        not isinstance(window, str) or not _EXECUTION_TIME.fullmatch(window) or timestamp(window) is None
    ):
        return False
    feeds = value.get("feeds")
    if not isinstance(feeds, list) or len(feeds) > RUNNER_MAX_FEEDS:
        return False
    if not all(_runner_feed_valid(row) for row in feeds):
        return False
    if len({row["id"] for row in feeds}) != len(feeds):
        return False
    if value["status"] == "UPDATED" and count == 0:
        return False
    for row in feeds:
        observed = timestamp(row.get("generatedAt"))
        if observed is not None and (
            (row["updated"] and observed < timestamp(started))
            or (generated is not None and observed > timestamp(generated))
        ):
            return False
    return count == sum(row["updated"] for row in feeds)


def _runner_view(reader: ArtifactReader, now: float) -> dict[str, Any]:
    """Return the always-present, sanitized canary-feeds runner health view.

    Age (``freshness``/``age``) and recorded ``status`` stay separate so a stale
    previous success is never presented as current health. Raw payload fields are
    never exposed: only allowlisted statuses/reasons/ids/counts are projected.
    """

    base: dict[str, Any] = {
        "available": False,
        **_observation_metadata_view({}),
        "status": "UNAVAILABLE",
        "reason": None,
        "started_at": None,
        "generated_at": None,
        "freshness": "UNKNOWN",
        "age": None,
        "updated_count": None,
        "monitoring_ends_at": None,
        "window_state": "UNKNOWN",
        "window_scope": "HISTORICAL_MULTICHAIN",
        "feeds": [],
    }
    read = reader.read_json("canary_feeds_runner", validator=canary_feeds_runner_valid)
    value = read.value if read.current and isinstance(read.value, dict) else None
    if value is None:
        return base
    # A RUNNING refresh has no generatedAt yet; its start time drives age.
    observed = value.get("generatedAt") or value.get("startedAt")
    fresh, age = freshness(observed, now, RUNNER_CADENCE_SECONDS * 2, RUNNER_CADENCE_SECONDS * 6)
    feeds = []
    for row in value["feeds"]:
        feed = {
            "id": row["id"],
            **_observation_metadata_view(row),
            "updated": row["updated"],
            "verdict": row.get("verdict"),
            "reason": row.get("reason"),
        }
        if row.get("generatedAt") is not None:
            # Producer generatedAt is its scan-start observation, not completion
            # time. Never substitute the fresher wrapper timestamp for it.
            feed_fresh, feed_age = freshness(
                row["generatedAt"], now, RUNNER_CADENCE_SECONDS * 2, RUNNER_CADENCE_SECONDS * 6
            )
            feed.update(generated_at=row["generatedAt"], age=feed_age,
                        age_text=_age_text(feed_age), freshness=feed_fresh)
        for source, target in (("exitCode", "exit_code"), ("incompleteCount", "incomplete_count")):
            if row.get(source) is not None:
                feed[target] = row[source]
        feeds.append(feed)
    end = timestamp(value.get("monitoringEndsAt"))
    # monitoringEndsAt belongs to the historical multichain batch. startedAt is
    # this refresh's start, NOT the historical window start or an authority grant.
    # Keep the recorded state separate; only the known end can advance to expired.
    historical_state = value.get("historicalMonitoringWindowState")
    window_state = (
        "UNKNOWN" if historical_state == "INVALID" else
        "EXPIRED" if end is not None and now >= end else
        {"NOT_STARTED": "NOT_STARTED", "OPEN": "ACTIVE", "WINDOW_CLOSED": "EXPIRED"}
        .get(historical_state, "UNKNOWN")
    )
    return {
        "available": True,
        **_observation_metadata_view(value),
        "status": value["status"],
        "reason": value.get("reason"),
        "started_at": value["startedAt"],
        "generated_at": value.get("generatedAt"),
        "freshness": fresh,
        "age": age,
        "updated_count": value["updatedCount"],
        "monitoring_ends_at": value.get("monitoringEndsAt"),
        "window_state": window_state,
        "window_scope": "HISTORICAL_MULTICHAIN",
        "feeds": feeds,
    }


def build_canary(reader: ArtifactReader, now: float) -> dict[str, Any]:
    """Return the safe, normalized canary-page snapshot."""

    execution = _execution_view(reader, now)
    runner = _runner_view(reader, now)
    status = reader.read_json("exploit_rearm_canary", validator=exploit_rearm_canary_valid)
    history = reader.read_json("exploit_rearm_canary_history", validator=exploit_rearm_canary_history_valid)
    history_value = history.value if history.current and isinstance(history.value, dict) else None
    history_available = history_value is not None
    # History is independently available evidence, never a substitute for the
    # current sentinel snapshot. Both status branches share this same projection.
    runs = [
        {
            "at": run.get("at"),
            "block": run.get("block"),
            "verdict": run.get("verdict"),
            "fired": [_diagnostic(item, 120) for item in run.get("fired", [])],
        }
        for run in reversed(history_value["runs"][-12:])
    ] if history_available else []
    multichain = _multichain_view(reader, now)
    divergence = _divergence_view(reader, now)
    transactions = _transactions_view(reader, now)
    wallet = reader.read_json("wallet_balances", validator=wallet_balances_valid)
    wallet_ok = wallet.current and isinstance(wallet.value, dict)
    value = status.value if isinstance(status.value, dict) else None
    if value is None or not status.current:
        return {
            "available": False,
            "freshness": "STALE",
            "age": None,
            "verdict": None,
            "sentinels": [],
            "runs": runs,
            "batch": None,
            "execution": execution,
            "balances": _balance_rows(wallet.value, wallet_ok, None, now),
            "transactions": transactions,
            "history_available": history_available,
            "multichain": multichain,
            "divergence": divergence,
            "runner": runner,
        }

    fresh, age = freshness(value["generatedAt"], now, CANARY_CADENCE_SECONDS * 2, CANARY_CADENCE_SECONDS * 6)
    batch = value["batch"]
    started = timestamp(batch["startedAt"])
    monitor_ends_at = batch.get("monitorEndsAt")
    expires = timestamp(batch.get("expiresAt") or monitor_ends_at)
    measurements_by_id = {
        row["sentinel"]: (row.get("measurements") or {}) for row in value["sentinels"]
    }
    sentinels = []
    for row in value["sentinels"]:
        view: dict[str, Any] = {
            "id": row["sentinel"],
            "fired": row["fired"],
            "ok": row["ok"],
            "reason": _diagnostic(row.get("reason"), 500),
            "error": _diagnostic(row.get("error"), 300),
            **_execution_row(),
        }
        if row["sentinel"] == "obol-govlst-rearm":
            view["view"] = _obol_view(measurements_by_id[row["sentinel"]])
        elif row["sentinel"] == "morpho-paxg-misscale":
            view["view"] = _morpho_view(measurements_by_id[row["sentinel"]])
        else:
            view["view"] = _ammalgam_view(row)
        sentinels.append(view)

    destination = _typed_value(batch.get("profitDestination"), "address")
    return {
        "available": True,
        "freshness": fresh,
        "age": age,
        "generated_at": value["generatedAt"],
        "verdict": value["verdict"],
        "fired_sentinels": value["firedSentinels"],
        "pin_block": value["pin"]["block"],
        "pin_hash": value["pin"].get("hash"),
        "batch": {
            "name": _diagnostic(batch["name"], 120),
            "chain_id": batch["chainId"],
            "started_at": batch["startedAt"],
            "expires_at": batch.get("expiresAt"),
            "monitor_ends_at": monitor_ends_at,
            "expired": bool(expires is not None and now >= expires),
            "expires_in": max(0, int(expires - now)) if expires is not None else None,
            "profit_destination": destination,
            "caps": _project_known(batch["caps"], _CAP_TYPES),
            "start_valid": started is not None,
        },
        "execution": execution,
        "sentinels": sentinels,
        "runs": runs,
        "balances": _balance_rows(wallet.value, wallet_ok, destination, now),
        "transactions": transactions,
        "history_available": history_available,
        "multichain": multichain,
        "divergence": divergence,
        "runner": runner,
    }
