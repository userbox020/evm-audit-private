"""Normalize allowlisted artifacts into the dashboard's safe snapshot schema."""

from __future__ import annotations

import hashlib
import json
import math
import re
from urllib.parse import urlparse
from collections import Counter
from datetime import datetime, timezone
from typing import Any, Iterable

from .artifacts import ALLOWLIST, JsonRead
from .catalog import BY_ID, CATALOG, EVENT_ALIASES, Monitor
from .normalize import (
    AGING,
    CLOCK_SKEW,
    FRESH,
    NA,
    NOT_CONTINUOUSLY_SOURCED,
    freshness,
    safe_value,
    severity,
    timestamp,
)
from .ops import build_ops, bytecode_verification_valid

CURRENT_FRESHNESS = {FRESH, AGING}
BOUNDED_ARTIFACTS = {
    "live-execution-batch-euler-trigger": "live_execution_batch_euler_trigger",
    "live-execution-batch-euler-trigger-2": "live_execution_batch_euler_trigger_2",
    "live-execution-batch-euler-trigger-3": "live_execution_batch_euler_trigger_3",
    "live-execution-batch-aave-trigger": "live_execution_batch_aave_trigger",
    "live-execution-batch-morpho-trigger": "live_execution_batch_morpho_trigger",
    "deployed-bytecode-verification": "deployed_bytecode_verification",
    "silo-default-step1": "silo_default_step1",
    "fluid-exit-depth": "fluid_exit_depth",
    "fluid-t2t4-rehearsal": "fluid_t2t4_rehearsal",
}
FRAXLEND_MATERIAL_AVAILABLE_USD = 10_000
DECIMAL_INTEGER = re.compile(r"^-?[0-9]+$")
DECIMAL_OR_SCIENTIFIC = re.compile(
    r"^[+-]?(?:(?:[0-9]+\.[0-9]*)|(?:[0-9]*\.[0-9]+)|(?:[0-9]+[eE][+-]?[0-9]+)|(?:[0-9]+\.[0-9]*[eE][+-]?[0-9]+))$"
)
ENTITY_DEDUPE_FIELDS = (
    "chain",
    "chainId",
    "market",
    "pair",
    "symbol",
    "assetSymbol",
    "vaultId",
    "positionId",
    "entity",
    "fingerprint",
)
VENUS_PSR_SCHEMA = "venus-psr-state/v1"
VENUS_PSR_CHAINS = {
    "venus-psr-bnb-drift": ("bnb", 56),
    "venus-psr-ethereum-drift": ("ethereum", 1),
    "venus-psr-arbitrum-drift": ("arbitrum", 42161),
}
VENUS_CHAIN_STATUSES = {"CLEAR", "DRIFT", "ERROR"}
VENUS_TOP_STATUSES = {"CLEAR", "DRIFT", "DEGRADED", "ERROR"}
VENUS_DRIFT_CATEGORIES = {
    "PSR_IDENTITY",
    "PSR_CONFIGURATION",
    "DISTRIBUTION",
    "POSITIVE_DESTINATIONS",
    "DESTINATION_CONTROLS",
    "DESTINATION_POLICY",
    "CONVERTER_NETWORK",
}
VENUS_CHAIN_KEYS = {"bnb", "ethereum", "arbitrum"}
MIN_VENUS_INTERVAL = 300
MAX_VENUS_INTERVAL = 86_400
HEX_32 = re.compile(r"^0x[0-9a-fA-F]{64}$")
SAFE_ERROR_CLASS = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")
AAVE_V4_SCANNER = "tools/watch-aave-v4-liquidation-triggers.js"
AAVE_V4_SCHEMA = "aave-v4-liquidation-watch/v1"
AAVE_SOURCE_COVERAGE_SCHEMA = "aave-source-coverage/v1"
AAVE_SOURCE_COVERAGE_SCHEMA_VERSION = 1
AAVE_V4_COVERAGE_KIND = "monitor"
AAVE_V4_PROTOCOL_VERSION = "V4"
AAVE_V4_EXHAUSTIVE_PROOF = "V4_BOUND_REGISTRY_AND_FULL_BORROW_HISTORY"
AAVE_V4_EXHAUSTIVE_HISTORY_SCOPES = {"GENESIS_TO_TIP", "PROVEN_START_TO_TIP"}
AAVE_V4_COVERAGE_CLASSIFICATIONS = {
    "EXHAUSTIVE_COMPLETE",
    "SOURCE_INCOMPLETE",
    "BOUNDED_WINDOW_INCOMPLETE",
    "BOUNDED_OBSERVATIONAL",
}
RESEARCH_WATCH_SCHEMA = "monitor-research-watch/v1"
CURRENT_AUDIT_STATE_SCHEMA = "current-audit-state/v1"
CURRENT_AUDIT_OVERALL = "NO_CURRENT_NET_POSITIVE_ROUTE"
CURRENT_AUDIT_CANDIDATES = (
    ("STEX", "WATCH_TRIGGER"),
    ("Mellow", "CLOSED_DEPLOYMENT_UNBOUND"),
    ("Aave v3.7", "CLOSED_FIXED"),
    ("Yearn v3.0.4", "CLOSED_PRIVILEGED"),
    ("40 Acres", "CLOSED_REFUTED"),
    ("EtherFi DebtManager", "HISTORICAL_WATCH_CURRENT_NEGATIVE"),
)
STEX_PROFIT_TRIGGER_SCHEMA = "stex-profit-trigger/v1"
STEX_CHAIN_ID = 999
STEX_EVIDENCE_CLASS = "SCREENING_ONLY_OFFICIAL_LATEST_REORGABLE"
STEX_TRIGGER_FIELDS = {
    "status",
    "paused",
    "pendingCount",
    "activeRows",
    "positiveGap",
    "totalGapRaw",
}
STEX_BLOCK_FIELDS = {"number", "hash", "timestamp"}
STEX_REQUEST_FIELDS = {
    "id", "kHYPEAmountRaw", "fixedHypeAmountRaw", "currentHypeValueRaw", "gapRaw",
}
STEX_LIQUIDITY_FIELDS = {
    "status", "whypeBalanceRaw", "whypeReserveRaw", "liabilityHaircutRaw",
    "conservativeAvailableRaw",
}
STEX_ECONOMICS_FIELDS = {
    "status", "capitalRaw", "grossCeilingRaw", "feesRaw", "gasRaw", "carryRaw",
    "exitHaircutRaw", "uncertaintyRaw", "conservativeNetRaw", "netBps", "capacityRaw",
}
STEX_GATE_FIELDS = {
    "triggerObserved", "sourceCurrent", "runtimeReachability", "economicsComplete",
    "liquidityExit", "conservativeNetPositive", "keylessForkJustified",
}
STEX_GATE_VALUES = {"PASS", "FAIL", "UNKNOWN"}
NONNEGATIVE_DECIMAL = re.compile(r"^[0-9]{1,78}$")
STEX_BLOCK_TIMESTAMP = re.compile(r"^[0-9]{1,10}$")
ETHERFI_PROFIT_TRIGGER_SCHEMA = "etherfi-debtmanager-profit-trigger/v1"
ETHERFI_PROFIT_TRIGGER_SCHEMA_V2 = "etherfi-debtmanager-profit-trigger/v2"
ETHERFI_PIN_FIELDS = {"number", "hash", "timestamp", "finalized", "headerFamilies", "stateFamilies"}
ETHERFI_RUNTIME_FIELDS = {"implementation", "proxyRuntimeHash", "implementationRuntimeHash", "changedFromHistorical", "exactCurrentSourceBound"}
ETHERFI_POOL_FIELDS = {"token", "decimals", "assetsRaw", "sharesRaw", "liquidRaw", "minSharesRaw", "zeroShareMaxRaw", "recentSupplyEventCount", "recentNonDustSupply", "recentWindowFrom", "recentWindowTo"}
ETHERFI_ECONOMICS_FIELDS = {"status", "capitalRaw", "grossCeilingRaw", "gasRaw", "l1FeeRaw", "carryRaw", "acquisitionUnwindRaw", "competitionRaw", "uncertaintyRaw", "conservativeNetRaw", "netBps", "capacityRaw"}
ETHERFI_GATE_FIELDS = {"sourceCurrent", "runtimeBound", "nonDustFlow", "feasibleCapital", "liquidExit", "economicsComplete", "conservativeNetPositive", "keylessForkJustified"}
ETHERFI_ADDRESS = re.compile(r"^0x[0-9a-fA-F]{40}$")
ETHERFI_DIAGNOSTIC_FIELDS = {"candidatesConsidered", "qualificationAttempts", "chainMatches", "finalizedQualified", "pinConsensusFamilies", "stateAttempts", "stateSuccesses", "stateConsensusFamilies", "stateDistinctGroups", "flowAttempts", "flowSuccesses", "flowConsensusFamilies", "flowDistinctGroups", "failurePhase", "failureCode"}
ETHERFI_FAILURE_PHASES = {"NONE", "QUALIFICATION", "PIN_CONSENSUS", "STATE", "FLOW"}
ETHERFI_FAILURE_CODES = {"NONE", "TWO_FAMILIES_UNAVAILABLE", "PIN_CONSENSUS_UNAVAILABLE", "STATE_CONSENSUS_UNAVAILABLE", "FLOW_CONSENSUS_UNAVAILABLE", "NETWORK_CALL_CAP", "UNEXPECTED"}
LISTA_PROFIT_TRIGGER_SCHEMA = "lista-auction-incentive-profit-trigger/v1"
LISTA_PIN_FIELDS = {"number", "hash", "stateRoot", "timestamp", "finalized", "headerFamilies", "stateFamilies"}
LISTA_RUNTIME_FIELDS = {"interactionImplementation", "clipImplementation", "interactionImplementationRuntimeHash", "clipImplementationRuntimeHash", "changedFromBaseline", "sourceRuntimeAttested"}
LISTA_CONTROL_FIELDS = {"auctionWhitelistModeRaw", "publicAuctionCaller", "stoppedRaw", "tipRad", "chipWad", "chostRad"}
LISTA_AUCTION_FIELDS = {"activeCount", "scannedCount", "needsRedoCount", "rewardEligibleRedoCount", "scanComplete"}
LISTA_ECONOMICS_FIELDS = {"status", "maximumGrossRewardRad", "maximumGrossRewardLisUSDRaw", "gasRaw", "l1FeeRaw", "competitionRaw", "uncertaintyRaw", "conservativeNetRaw", "netBps"}
LISTA_TRIGGER_VALUES = {"INCOMPLETE", "RUNTIME_DRIFT_REVIEW", "BLOCKED_WHITELIST", "BLOCKED_STOPPED", "BLOCKED_NO_ACTIVE_AUCTION", "BLOCKED_SCAN_CAP", "BLOCKED_NO_ELIGIBLE_REDO", "BLOCKED_NONPOSITIVE_GROSS", "POSITIVE_GROSS_FORK_WARRANTED"}
LISTA_ECONOMICS_VALUES = {"NOT_RUN", "INCOMPLETE", "NONPOSITIVE_GROSS", "POSITIVE_GROSS_ONLY"}
LISTA_GATE_FIELDS = {"sourceCurrent", "runtimeBaseline", "publicCaller", "activeAuction", "eligibleRedo", "grossPositive", "economicsComplete", "conservativeNetPositive", "keylessForkJustified"}
AAVE_V3_ARBITRUM_EVENTS_SCHEMA = "aave-v3-arbitrum-config-oracle-events/v2"
AAVE_V3_ARBITRUM_EVENT_NAMES = (
    "ReserveInitialized", "ReserveBorrowing", "CollateralConfigurationChanged", "ReserveActive", "ReserveFrozen", "ReservePaused",
    "BorrowCapChanged", "SupplyCapChanged", "AssetCollateralInEModeChanged", "AssetBorrowableInEModeChanged", "AssetLtvzeroInEModeChanged",
    "EModeCategoryAdded", "EModeCategoryIsolationChanged", "ReserveInterestRateStrategyChanged", "ReserveInterestRateDataChanged", "ATokenUpgraded",
    "VariableDebtTokenUpgraded", "AssetSourceUpdated", "PriceOracleUpdated", "PoolUpdated", "PoolConfiguratorUpdated",
)
AAVE_V3_ARBITRUM_PHASES = {"NONE", "CURSOR", "AUTHORITY", "ABI", "INVENTORY", "QUALIFICATION", "HEADER", "LOG", "TERMINAL", "CAP", "OUTPUT"}
AAVE_V3_ARBITRUM_CODES = {"NONE", "AUTHORITY_INVALID", "ABI_INVALID", "INVENTORY_INVALID", "INVENTORY_MUTATED", "TWO_FAMILIES_UNAVAILABLE", "COMMON_FINALIZED_UNAVAILABLE", "HEADER_INVALID", "HEADER_DISAGREEMENT", "LOG_INVALID", "LOG_DISAGREEMENT", "WRONG_EMITTER", "EVENT_CAP", "TERMINAL_RECHECK_FAILED", "FINALITY_REGRESSION", "READ_CAP", "OUTPUT_INVALID", "PRIOR_ARTIFACT_INVALID", "PRIOR_ARTIFACT_MUTATED", "UNEXPECTED"}
AAVE_V3_LIQ_WATCH_SCANNER = "tools/aave-v3-liquidation-watch.js"
AAVE_V3_READINESS_SCANNER = "tools/audit-aave-v3-trigger-readiness.js"
AAVE_V3_EXACT_QUOTES_SCHEMA = "aave-v3-liquidation-exact-quotes/v1"
AAVE_V3_TRIGGER_QUOTES_SCHEMA = "aave-v3-liquidation-trigger-quotes/v1"
AAVE_V3_BORROWER_UNIVERSE_SCHEMA = "aave-v3-borrower-universe/v1"
AAVE_V3_SAFE_CLASS = re.compile(r"^[A-Z][A-Z0-9_]{0,79}$")
AAVE_V3_BLOCKER = re.compile(r"^[a-z][a-z0-9-]{0,95}$")
AAVE_V3_SHA256 = re.compile(r"^[a-f0-9]{64}$")
AAVE_V3_ENDPOINT_LEAK = re.compile(
    r"http|://|blockscout|drpc|tenderly|mevblocker|publicnode", re.IGNORECASE
)
AAVE_V3_READINESS_GATE_FIELDS = (
    "triggerReady",
    "exactEconomicsReady",
    "sourceAbiReady",
    "monitorMathReady",
    "deployedSelectorReady",
    "flashLiquidityReady",
    "forkProofReady",
    "liveExecutorReady",
)
MORPHO_BLUE_LIQUIDATABLE_SCHEMA = "morpho-blue-liquidatable-observation/v1"
MORPHO_BLUE_LIQUIDATABLE_SCANNER = "tools/scan-morpho-blue-l.js"
MORPHO_BLUE_CHAIN_IDS = {1, 8453}
MORPHO_EVENT_STATS = ("Borrow", "Liquidate", "Repay", "Supply")
MORPHO_MAX_BUCKETS = 10
MORPHO_ENDPOINT_LEAK = re.compile(
    r"http|://|blockscout|drpc|tenderly|mevblocker|publicnode", re.IGNORECASE
)
EULER_L_WATCH_SCHEMA = "euler-l-watch/v1"
EULER_L_WATCH_SCANNER = "tools/watch-euler-l.js"
EULER_L_SURFACE_SCHEMA = "euler-l-observation/v1"
EULER_L_SURFACE_SCANNER = "tools/scan-euler-l.js"
EULER_L_VALUATION_SCHEMA = "euler-l-valuation/v1"
EULER_L_VALUATION_SCANNER = "tools/calc-euler-l-valuation.js"
EULER_L_CHAIN_ID = 1
EULER_L_MAX_BUCKETS = 10
EULER_L_ENDPOINT_LEAK = re.compile(
    r"http|://|blockscout|drpc|tenderly|mevblocker|publicnode", re.IGNORECASE
)
SCHEDULER_SCHEMA = "trigger-watch-scheduler/v1"
SENTINEL_SCHEMA = "official-deployed-delta-sentinel/v1"
SENTINEL_REPOSITORIES = (
    ("silo-finance/silo-contracts-v3", "implementation"),
    ("VenusProtocol/venus-protocol", "implementation"),
    ("aave-dao/aave-v3-origin", "implementation"),
    ("aave-dao/aave-governance-v3", "governance"),
    ("aave-dao/aave-address-book", "deployment-registry"),
    ("morpho-org/morpho-blue", "implementation"),
    ("yearn/yearn-vaults-v3", "implementation"),
    ("etherfi-protocol/cash-v3", "implementation"),
    ("lista-dao/lista-dao-contracts", "historical"),
    ("AladdinDAO/fx-protocol-contracts", "implementation"),
    ("compound-finance/comet", "implementation"),
    ("Instadapp/fluid-contracts-public", "implementation"),
    ("curvefi/curve-core", "deployment-registry"),
    ("basalt-vault/basalt-vault", "implementation"),
    ("Enhanced-Finance/contracts", "implementation"),
    ("vetro-protocol/vetro-contracts", "implementation"),
    ("basedollar/basedollar", "implementation"),
)
SCHEDULER_PRODUCERS = (
    ("valantis-stex", "reports/monitor/stex-profit-trigger.json"),
    ("etherfi-debtmanager", "reports/monitor/etherfi-debtmanager-profit-trigger.json"),
    ("lista-auction-incentive", "reports/monitor/lista-auction-incentive-profit-trigger.json"),
    ("aave-v3-arbitrum-config-oracle-events", "reports/monitor/aave-v3-arbitrum-config-oracle-events.json"),
)
SENTINEL_REPO_FIELDS = {"id", "officialUrl", "defaultBranch", "sourceClass", "observedHeadSha", "previousHeadSha", "releaseIds", "tags", "configuredManifestPaths", "changedManifestPaths", "changeHints", "chainTextHints", "evidenceUrls", "etagByUrl", "pollStatus", "observedAt"}
RESEARCH_DISPOSITIONS = {
    "ACTIVE_WATCH",
    "CHANGE_TRIGGER",
    "SCHEDULED",
    "HOLD",
    "SUPPRESSED",
}
RESEARCH_ENTRY_STATUSES = {"COMPLETE", "INCOMPLETE"}
RESEARCH_EFFECTIVE_DISPOSITIONS = RESEARCH_DISPOSITIONS | {"INCOMPLETE"}
SOURCE_HEALTH_VALUES = {"OK", "STALE", "INVALID"}
MAX_METRIC_MAGNITUDE = 1_000_000_000_000_000.0
POLYMARKET_R17_SCHEMA = "r17-public-read-only-monitor"
POLYMARKET_R17_DECIMAL = re.compile(r"^-?(?:0|[1-9][0-9]*)\.[0-9]{6}$")
POLYMARKET_R17_REASON = re.compile(r"^r17-[a-z0-9-]{1,75}$")
POLYMARKET_R17_HASH = re.compile(r"^[a-f0-9]{64}$")
POLYMARKET_R17_SIDES = {"BUY YES", "BUY NO"}
POLYMARKET_R17_GATE_VALUES = {"PASS", "FAIL", "UNKNOWN"}
POLYMARKET_R19_SCHEMA = "r19-public-read-only-structural-scan"
POLYMARKET_R19_DECIMAL = re.compile(r"^-?(?:0|[1-9][0-9]*)\.[0-9]{6}$")
POLYMARKET_R19_REASON = re.compile(r"^r19-[a-z0-9-]{1,95}$")
POLYMARKET_R19_HASH = re.compile(r"^[a-f0-9]{64}$")
POLYMARKET_R19_SAFE_ID = re.compile(r"^(?:[0-9]{1,90}|0x[a-f0-9]{64})$")
POLYMARKET_R19_BUNDLES = {"SAME_CONDITION_PARITY", "STRIKE_LADDER_DIAGNOSTIC"}
POLYMARKET_R19_GATES = {"PASS", "FAIL", "UNKNOWN"}
POLYMARKET_R20_SCHEMA = "r20-public-read-only-merge-backed-parity"
POLYMARKET_R20_DECIMAL = re.compile(r"^-?(?:0|[1-9][0-9]*)\.[0-9]{6}$")
POLYMARKET_R20_REASON = re.compile(r"^r20-[a-z0-9-]{1,100}$")
POLYMARKET_R20_HASH = re.compile(r"^[a-f0-9]{64}$")
POLYMARKET_R20_SAFE_ID = re.compile(r"^(?:[0-9]{1,90}|0x[a-f0-9]{64})$")


def _unknown(freshness_value: str = "UNKNOWN", alarm: str = "UNKNOWN") -> dict[str, Any]:
    return {
        "observation": "UNKNOWN",
        "freshness": freshness_value,
        "age": None,
        "alarm": alarm,
        "metrics": [],
        "provenance": [],
        "warnings": [],
        "observation_at": None,
        "source_health": "UNKNOWN",
    }


def _state_for(state: dict[str, Any], ident: str) -> dict[str, Any]:
    conditions = state.get("conditions", {}) if isinstance(state, dict) else {}
    if not isinstance(conditions, dict):
        return {}
    record = conditions.get(ident, {})
    return record if isinstance(record, dict) else {}


def _number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        result = float(value)
        return result if math.isfinite(result) and abs(result) <= MAX_METRIC_MAGNITUDE else None
    except (TypeError, ValueError):
        return None


def _quantity(value: Any) -> float | None:
    if isinstance(value, list):
        return float(len(value))
    return _number(value)


def _positive(value: Any) -> bool:
    quantity = _quantity(value)
    return quantity is not None and quantity > 0


def _metric(label: str, value: Any) -> tuple[str, Any] | None:
    if isinstance(value, str):
        stripped = value.strip()
        if stripped.lower() in {"nan", "+nan", "-nan", "infinity", "+infinity", "-infinity", "inf", "+inf", "-inf"}:
            return None
        if DECIMAL_OR_SCIENTIFIC.fullmatch(stripped):
            value = _number(stripped)
    normalized = safe_value(value)
    return (label, normalized) if normalized is not None else None


def _metrics(values: Iterable[tuple[str, Any]]) -> list[tuple[str, Any]]:
    result = []
    for label, value in values:
        item = _metric(label, value)
        if item is not None:
            result.append(item)
    return result


def _iso_time(value: Any) -> str | None:
    observed = timestamp(value)
    if observed is None:
        return None
    try:
        return datetime.fromtimestamp(observed, timezone.utc).isoformat()
    except (OverflowError, OSError, ValueError):
        return None


def _health_factors(value: Any, depth: int = 0) -> list[float]:
    """Collect only recognized health-factor fields from bounded result data."""

    if depth > 5:
        return []
    if isinstance(value, list):
        factors: list[float] = []
        for row in value:
            factors.extend(_health_factors(row, depth + 1))
        return factors
    if not isinstance(value, dict):
        return []

    factors = []
    for key, nested in value.items():
        if key in {
            "healthFactor",
            "health_factor",
            "hf",
            "topHealthFactor",
            "minHealthFactor",
        }:
            number = _number(nested)
            if number is not None:
                factors.append(number)
        elif isinstance(nested, (dict, list)):
            factors.extend(_health_factors(nested, depth + 1))
    return factors


def _observation_time(item: Monitor, record: dict[str, Any], result: dict[str, Any]) -> Any:
    if item.id == "aave-v3-hf-watch":
        return result.get("checkedAt") or record.get("lastScan")
    if item.id == "aave-v4-liquidation-watch":
        return result.get("sourceGeneratedAt") or result.get("generatedAt")
    if item.id == "hyperlend":
        return record.get("lastCheck")
    if item.id == "kamino-liquidation-window":
        return result.get("generatedAt") or result.get("at")
    if item.id in {"morpho-liq", "fraxlend-pair-watch"}:
        return result.get("checkedAt")
    return None


def _classify_aave_v3(result: dict[str, Any]) -> tuple[str, list[tuple[str, Any]]]:
    rows = result.get("results", result.get("rows"))
    chains = result.get("chains")
    factors = _health_factors(rows)
    minimum = min(factors) if factors else None
    metrics = _metrics((("chains", chains), ("minimum health factor", minimum)))

    if isinstance(rows, list) and not rows:
        return "UNKNOWN", metrics
    if minimum is not None:
        if minimum <= 1:
            return "TRIGGERED", metrics
        if minimum <= 1.05:
            return "WATCH", metrics
        return "CLEAR", metrics
    return "UNKNOWN", metrics


def _healthy_count_triplet(
    value: dict[str, Any], attempted: str, succeeded: str, failed: str, *, nonzero: bool = False
) -> bool:
    attempt = value.get(attempted)
    success = value.get(succeeded)
    failure = value.get(failed)
    return bool(
        all(_bounded_count(count) for count in (attempt, success, failure))
        and (not nonzero or attempt > 0)
        and success == attempt
        and failure == 0
        and success + failure == attempt
    )


def _aave_count(value: Any) -> bool:
    """Match the shared producer's non-negative safe-integer count contract."""

    return (
        not isinstance(value, bool)
        and isinstance(value, int)
        and 0 <= value <= 9_007_199_254_740_991
    )


def _healthy_aave_count_triplet(
    value: dict[str, Any], attempted: str, succeeded: str, failed: str, *, nonzero: bool = False
) -> bool:
    attempt = value.get(attempted)
    success = value.get(succeeded)
    failure = value.get(failed)
    return bool(
        all(_aave_count(count) for count in (attempt, success, failure))
        and (not nonzero or attempt > 0)
        and success + failure == attempt
        and success == attempt
        and failure == 0
    )


def _exact_aave_promotion_closure(value: Any) -> bool:
    return bool(
        isinstance(value, dict)
        and set(value) == {
            "eligible",
            "routePositive",
            "executableNow",
            "signedActionJustified",
        }
        and all(flag is False for flag in value.values())
    )


def _aave_reserve_link_key(value: Any) -> tuple[str, int, str, int] | None:
    if not isinstance(value, dict):
        return None
    hub = value.get("hubAddress")
    spoke = value.get("spoke")
    asset_id = value.get("assetId")
    reserve_id = value.get("reserveId")
    if (
        not isinstance(hub, str)
        or not hub
        or not isinstance(spoke, str)
        or not spoke
        or not _aave_count(asset_id)
        or not _aave_count(reserve_id)
    ):
        return None
    return hub.lower(), asset_id, spoke.lower(), reserve_id


def _aave_v4_reserve_links_complete(source_coverage: dict[str, Any]) -> bool:
    """Validate exact aggregate-to-consumed topology linkage and count relations."""

    aggregates = source_coverage.get("spokeReserveLinks")
    consumed = source_coverage.get("consumedReserveLinks")
    global_count_fields = (
        "reserveLinksExpected",
        "reserveLinksObserved",
        "reserveLinksConsumed",
        "reserveLinksCap",
    )
    if (
        not isinstance(aggregates, list)
        or not isinstance(consumed, list)
        or not all(_aave_count(source_coverage.get(field)) for field in global_count_fields)
        or source_coverage["reserveLinksCap"] == 0
        or source_coverage.get("reserveLinksTruncated") is not False
        or source_coverage["reserveLinksExpected"] > source_coverage["reserveLinksCap"]
    ):
        return False

    consumed_keys = [_aave_reserve_link_key(link) for link in consumed]
    if (
        any(key is None for key in consumed_keys)
        or len(set(consumed_keys)) != len(consumed_keys)
        or len(consumed) != source_coverage["reserveLinksConsumed"]
    ):
        return False

    spokes: set[str] = set()
    aggregate_keys: list[tuple[str, int, str, int]] = []
    expected = observed = aggregate_consumed = 0
    for row in aggregates:
        if not isinstance(row, dict):
            return False
        spoke = row.get("spoke")
        normalized_spoke = spoke.lower() if isinstance(spoke, str) and spoke else None
        counts = (row.get("expected"), row.get("observed"), row.get("consumed"), row.get("cap"))
        links = row.get("links")
        if (
            normalized_spoke is None
            or normalized_spoke in spokes
            or not all(_aave_count(count) for count in counts)
            or row["cap"] == 0
            or row.get("wasTruncated") is not False
            or row["expected"] > row["cap"]
            or row["expected"] != row["observed"]
            or row["observed"] != row["consumed"]
            or not isinstance(links, list)
        ):
            return False
        spokes.add(normalized_spoke)
        keys = [_aave_reserve_link_key(link) for link in links]
        if (
            any(key is None for key in keys)
            or len(set(keys)) != len(keys)
            or any(key[2] != normalized_spoke for key in keys if key is not None)
            or len(links) != row["consumed"]
        ):
            return False
        aggregate_keys.extend(key for key in keys if key is not None)
        expected += row["expected"]
        observed += row["observed"]
        aggregate_consumed += row["consumed"]

    # Spoke cardinality and reserve-link cardinality are separate dimensions.
    if (
        len(spokes) != source_coverage.get("spokesExpected")
        or len(spokes) != source_coverage.get("spokesObserved")
        or expected != source_coverage["reserveLinksExpected"]
        or observed != source_coverage["reserveLinksObserved"]
        or aggregate_consumed != source_coverage["reserveLinksConsumed"]
        or source_coverage["reserveLinksExpected"] != source_coverage["reserveLinksObserved"]
        or source_coverage["reserveLinksObserved"] != source_coverage["reserveLinksConsumed"]
        or len(aggregate_keys) != len(consumed_keys)
        or len(set(aggregate_keys)) != len(aggregate_keys)
        or set(aggregate_keys) != set(consumed_keys)
    ):
        return False
    return True


def _aave_v4_history_exhaustive(source_coverage: dict[str, Any]) -> bool:
    observed = source_coverage.get("observedRange")
    if not isinstance(observed, dict):
        return False
    start = observed.get("fromBlock")
    end = observed.get("toBlock")
    if not _aave_count(start) or not _aave_count(end) or end < start:
        return False
    scope = source_coverage.get("historyScope")
    if scope not in AAVE_V4_EXHAUSTIVE_HISTORY_SCOPES:
        return False
    if scope == "GENESIS_TO_TIP":
        return start == 0 and source_coverage.get("historyStartBound") is None
    bound = source_coverage.get("historyStartBound")
    return bool(
        start > 0
        and isinstance(bound, dict)
        and bound.get("proven") is True
        and bound.get("block") == start
        and isinstance(bound.get("proof"), str)
        and bound["proof"].strip()
    )


def _aave_v4_coverage_exhaustive(
    state: dict[str, Any], latest: dict[str, Any], source_coverage: dict[str, Any]
) -> bool:
    """Accept CLEAR only from the canonical, internally consistent exhaustive contract."""

    proof = source_coverage.get("exhaustiveProof")
    topology = source_coverage.get("topologyUniverse")
    excluded = source_coverage.get("excludedSpokes")
    raw_topology_age = source_coverage.get("topologyAgeMs")
    topology_age = _number(raw_topology_age)
    if (
        state.get("schema") != AAVE_V4_SCHEMA
        or state.get("scanner") != AAVE_V4_SCANNER
        or state.get("classification") != source_coverage.get("classification")
        or state.get("complete") != source_coverage.get("complete")
        or state.get("sourceCoverage") != source_coverage
        or latest.get("classification") != source_coverage.get("classification")
        or latest.get("complete") != source_coverage.get("complete")
        or source_coverage.get("schema") != AAVE_SOURCE_COVERAGE_SCHEMA
        or isinstance(source_coverage.get("schemaVersion"), bool)
        or source_coverage.get("schemaVersion") != AAVE_SOURCE_COVERAGE_SCHEMA_VERSION
        or source_coverage.get("protocolVersion") != AAVE_V4_PROTOCOL_VERSION
        or source_coverage.get("coverageKind") != AAVE_V4_COVERAGE_KIND
        or source_coverage.get("producerKind") != AAVE_V4_COVERAGE_KIND
        or source_coverage.get("classification") != "EXHAUSTIVE_COMPLETE"
        or source_coverage.get("complete") is not True
        or source_coverage.get("sampleComplete") is not True
        or source_coverage.get("promotionEligible") is not False
        or not _exact_aave_promotion_closure(source_coverage.get("promotionClosure"))
        or source_coverage.get("fullHistoryProven") is not True
        or source_coverage.get("errors") != []
        or source_coverage.get("wasTruncated") is not False
        or timestamp(source_coverage.get("topologyGeneratedAt")) is None
        or isinstance(raw_topology_age, bool)
        or not isinstance(raw_topology_age, (int, float))
        or topology_age is None
        or not -60_000 <= topology_age <= 300_000
        or not isinstance(source_coverage.get("topologyRefreshAttempted"), bool)
        or source_coverage.get("topologyRefreshOk") is not True
        or source_coverage.get("topologySourceComplete") is not True
        or source_coverage.get("topologySourceSampleComplete") is not True
        or not isinstance(topology, dict)
        or topology.get("type") != "DECLARED_STATIC_HUB_SET"
        or topology.get("bound") is not True
        or not isinstance(topology.get("registry"), str)
        or not topology["registry"].strip()
        or not isinstance(topology.get("version"), str)
        or not topology["version"].strip()
        or not isinstance(proof, dict)
        or proof.get("type") != AAVE_V4_EXHAUSTIVE_PROOF
        or proof.get("exact") is not True
        or proof.get("evidence") != f'{topology.get("registry")}@{topology.get("version")}'
        or source_coverage.get("proof") != proof
        or not _aave_v4_history_exhaustive(source_coverage)
        or not _aave_count(source_coverage.get("chainsExpected"))
        or source_coverage.get("chainsExpected") != 1
        or not _aave_count(source_coverage.get("chainsObserved"))
        or source_coverage.get("chainsObserved") != 1
        or not _healthy_aave_count_triplet(
            source_coverage, "logChunksAttempted", "logChunksSucceeded", "logChunksFailed", nonzero=True
        )
        or not _healthy_aave_count_triplet(
            source_coverage, "accountReadsAttempted", "accountReadsSucceeded", "accountReadsFailed"
        )
        or not _healthy_aave_count_triplet(
            source_coverage, "reserveReadsAttempted", "reserveReadsSucceeded", "reserveReadsFailed"
        )
        or not _healthy_aave_count_triplet(
            source_coverage, "stateReadsAttempted", "stateReadsSucceeded", "stateReadsFailed"
        )
        or not _aave_count(source_coverage.get("discoveredBorrowers"))
        or source_coverage.get("checkedBorrowers") != source_coverage.get("discoveredBorrowers")
        or source_coverage.get("accountReadsAttempted") != source_coverage.get("checkedBorrowers")
        or not _aave_count(source_coverage.get("spokesExpected"))
        or not _aave_count(source_coverage.get("spokesObserved"))
        or source_coverage.get("spokesObserved") != source_coverage.get("spokesExpected")
        or not _aave_count(source_coverage.get("truncationLimit"))
        or source_coverage.get("truncationLimit") == 0
        or excluded != []
        or source_coverage.get("spokeFilteringApplied") is not False
        or not _aave_v4_reserve_links_complete(source_coverage)
    ):
        return False

    if source_coverage["stateReadsAttempted"] != (
        source_coverage["accountReadsAttempted"] + source_coverage["reserveReadsAttempted"]
    ):
        return False
    if source_coverage["stateReadsSucceeded"] != (
        source_coverage["accountReadsSucceeded"] + source_coverage["reserveReadsSucceeded"]
    ) or source_coverage["stateReadsFailed"] != (
        source_coverage["accountReadsFailed"] + source_coverage["reserveReadsFailed"]
    ):
        return False

    return True


def _classify_aave_v4(
    result: dict[str, Any], source_coverage: dict[str, Any], exhaustive: bool
) -> tuple[str, list[tuple[str, Any]]]:
    metrics = _metrics(
        (
            ("coverage", source_coverage.get("classification")),
            ("coverage complete", source_coverage.get("complete")),
            ("active borrowers", result.get("activeBorrowers")),
            ("near liquidation", result.get("nearLiquidation")),
            ("liquidatable", result.get("liquidatable")),
            ("route positive", result.get("routePositive")),
            ("trigger rows", result.get("triggerRows")),
            ("quote required rows", result.get("quoteRequiredRows")),
            ("top health factor", result.get("topHealthFactor")),
        )
    )
    if _positive(result.get("liquidatable")) or _positive(result.get("routePositive")):
        return "TRIGGERED", metrics
    watch_fields = ("nearLiquidation", "triggerRows", "quoteRequiredRows")
    if any(_positive(result.get(key)) for key in watch_fields):
        return "WATCH", metrics

    evidence = ("liquidatable", "routePositive", *watch_fields)
    if exhaustive and all(
        _quantity(result.get(key)) == 0 for key in evidence
    ):
        return "CLEAR", metrics
    return "UNKNOWN", metrics


def _classify_hyperlend(record: dict[str, Any]) -> tuple[str, list[tuple[str, Any]]]:
    keys = ("routeCandidates", "divergentStaleSources", "staleSourceWatchpoints")
    if not all(isinstance(record.get(key), list) for key in keys):
        return "UNKNOWN", []
    candidates = record["routeCandidates"]
    divergent = record["divergentStaleSources"]
    watchpoints = record["staleSourceWatchpoints"]
    priority = "CRITICAL" if candidates else (
        "HIGH" if divergent else ("WARN" if watchpoints else "NONE")
    )
    metrics = _metrics(
        (
            ("priority", priority),
            ("route candidates", len(candidates)),
            ("divergent sources", len(divergent)),
            ("stale sources", len(watchpoints)),
        )
    )
    if candidates:
        return "TRIGGERED", metrics
    if divergent or watchpoints:
        return "WATCH", metrics
    return "CLEAR", metrics


def _fallback(result: dict[str, Any], primary: str, fallback: str) -> Any:
    return result[primary] if primary in result else result.get(fallback)


def _classify_kamino(result: dict[str, Any]) -> tuple[str, list[tuple[str, Any]]]:
    liquidatable_value = _fallback(
        result, "sameSlotLiquidatableRows", "sameSlotLiquidatable"
    )
    reduced_value = _fallback(result, "sameSlotReducedRows", "sameSlotReduced")
    liquidatable = _quantity(liquidatable_value)
    reduced = _quantity(reduced_value)
    stale_reduced = _quantity(result.get("staleReducedRows"))
    metrics = _metrics(
        (
            ("same-slot liquidatable", liquidatable_value),
            ("same-slot reduced", reduced_value),
            ("stale reduced rows", result.get("staleReducedRows")),
        )
    )
    if liquidatable is not None and liquidatable > 0:
        return "TRIGGERED", metrics
    if reduced is not None and reduced > 0:
        return "WATCH", metrics
    if liquidatable == 0 and reduced == 0:
        return "CLEAR", metrics
    if stale_reduced is not None:
        return "UNKNOWN", metrics
    return "UNKNOWN", metrics


def _classify_morpho(result: dict[str, Any]) -> tuple[str, list[tuple[str, Any]]]:
    liquidatable = _quantity(result.get("liquidatable"))
    borrowers = _quantity(result.get("totalBorrowers"))
    metrics = _metrics(
        (
            ("total borrowers", result.get("totalBorrowers")),
            ("liquidatable", result.get("liquidatable")),
            ("top health factor", result.get("topHF")),
        )
    )
    if liquidatable is not None and liquidatable > 0:
        return "TRIGGERED", metrics
    if liquidatable == 0 and borrowers is not None and borrowers >= 0:
        return "CLEAR", metrics
    return "UNKNOWN", metrics


def _classify_fraxlend(result: dict[str, Any]) -> tuple[str, list[tuple[str, Any]]]:
    bad_data = result.get("isBadData")
    available_usd = _number(result.get("availableUsd"))
    metrics = _metrics(
        (
            ("bad data", bad_data),
            ("low rate", result.get("lowRate")),
            ("high rate", result.get("highRate")),
            ("available assets", result.get("availableAssets")),
            ("available USD", result.get("availableUsd")),
        )
    )
    if bad_data is True:
        if available_usd is not None and available_usd >= FRAXLEND_MATERIAL_AVAILABLE_USD:
            return "TRIGGERED", metrics
        return "WATCH", metrics
    if bad_data is False:
        return "CLEAR", metrics
    return "UNKNOWN", metrics


def _alarm(item: Monitor, observation: str, freshness_value: str) -> str:
    if observation != "TRIGGERED":
        return "NONE"
    if item.mode != "CONTINUOUS":
        return "NONE"
    return "CURRENT" if freshness_value in CURRENT_FRESHNESS else "HISTORICAL"


def _next_expected(value: Any, cadence: int | None) -> str | None:
    observed = timestamp(value)
    if observed is None or cadence is None:
        return None
    return _iso_time(observed + cadence)


def _producer_health(
    item: Monitor,
    record: dict[str, Any],
    *,
    latest: Any = None,
    last_success: Any = None,
    legacy_context: str | None = None,
) -> dict[str, Any]:
    latest_value = latest if latest is not None else record.get("observation_at")
    success_value = last_success if last_success is not None else latest_value
    return {
        "latest_observation": _iso_time(latest_value),
        "last_success": _iso_time(success_value),
        "next_expected_update": _next_expected(latest_value, item.cadence),
        "legacy_context": legacy_context,
    }


def _valid_successful_observation(value: Any, require_drift: bool = False) -> bool:
    if not isinstance(value, dict):
        return False
    status = value.get("status")
    categories = value.get("driftCategories")
    return bool(
        status in {"CLEAR", "DRIFT"}
        and timestamp(value.get("at")) is not None
        and isinstance(value.get("blockNumber"), int)
        and HEX_32.fullmatch(str(value.get("blockHash", "")))
        and HEX_32.fullmatch(str(value.get("digest", "")))
        and isinstance(categories, list)
        and len(categories) == len(set(categories))
        and all(category in VENUS_DRIFT_CATEGORIES for category in categories)
        and (status != "CLEAR" or not categories)
        and (status != "DRIFT" or bool(categories))
        and (not require_drift or status == "DRIFT")
    )


def _valid_venus_chain(row: Any, chain_id: int, attempt_at: Any) -> bool:
    if not isinstance(row, dict):
        return False
    if row.get("chainId") != chain_id or row.get("status") not in VENUS_CHAIN_STATUSES:
        return False
    if row.get("attemptAt") != attempt_at or timestamp(row.get("attemptAt")) is None:
        return False
    successful = row.get("lastSuccessfulObservation")
    if successful is None:
        if row.get("lastSuccessfulAt") is not None:
            return False
    elif not _valid_successful_observation(successful) or row.get("lastSuccessfulAt") != successful.get("at"):
        return False
    unresolved = row.get("unresolvedDrift")
    if unresolved is not None and not _valid_successful_observation(unresolved, require_drift=True):
        return False
    categories = row.get("driftCategories")
    if not isinstance(categories, list) or any(
        category not in VENUS_DRIFT_CATEGORIES for category in categories
    ):
        return False
    baseline = row.get("baseline")
    if (
        not isinstance(baseline, dict)
        or not isinstance(baseline.get("blockNumber"), int)
        or not HEX_32.fullmatch(str(baseline.get("blockHash", "")))
        or not HEX_32.fullmatch(str(baseline.get("digest", "")))
    ):
        return False
    current = row.get("current")
    if row["status"] == "ERROR":
        expected_unresolved = successful if isinstance(successful, dict) and successful.get("status") == "DRIFT" else None
        return (
            current is None
            and isinstance(row.get("errorClass"), str)
            and SAFE_ERROR_CLASS.fullmatch(row["errorClass"]) is not None
            and not categories
            and unresolved == expected_unresolved
        )
    valid = (
        isinstance(current, dict)
        and isinstance(current.get("blockNumber"), int)
        and HEX_32.fullmatch(str(current.get("blockHash", ""))) is not None
        and HEX_32.fullmatch(str(current.get("digest", ""))) is not None
        and row.get("errorClass") is None
        and ((row["status"] == "CLEAR" and not categories) or (row["status"] == "DRIFT" and bool(categories)))
    )
    if not valid or not isinstance(successful, dict) or successful.get("at") != row.get("attemptAt"):
        return False
    if successful.get("status") != row["status"] or successful.get("driftCategories") != categories:
        return False
    if (
        successful.get("blockNumber") != current.get("blockNumber")
        or successful.get("blockHash") != current.get("blockHash")
        or successful.get("digest") != current.get("digest")
    ):
        return False
    if row["status"] == "CLEAR":
        return unresolved is None
    return unresolved == successful


def venus_state_valid(state: Any) -> bool:
    if not isinstance(state, dict):
        return False
    interval = state.get("intervalSeconds")
    if (
        state.get("schema") != VENUS_PSR_SCHEMA
        or state.get("status") not in VENUS_TOP_STATUSES
        or isinstance(interval, bool)
        or not isinstance(interval, int)
        or not MIN_VENUS_INTERVAL <= interval <= MAX_VENUS_INTERVAL
        or state.get("readOnly") is not True
        or state.get("upstreamTransactions") != 0
        or state.get("signedActionJustified") is not False
        or state.get("providerMaterialAbsent") is not True
        or timestamp(state.get("attemptAt")) is None
        or not isinstance(state.get("chains"), dict)
        or set(state["chains"]) != VENUS_CHAIN_KEYS
    ):
        return False
    expected_ids = {"bnb": 56, "ethereum": 1, "arbitrum": 42161}
    if not all(
        _valid_venus_chain(state["chains"][key], expected_ids[key], state["attemptAt"])
        for key in VENUS_CHAIN_KEYS
    ):
        return False
    for row in state["chains"].values():
        for field in ("current", "lastSuccessfulObservation", "unresolvedDrift"):
            observation = row.get(field)
            if isinstance(observation, dict) and "rpcStrength" in observation and observation["rpcStrength"] != "single-provider":
                return False
    statuses = [state["chains"][key]["status"] for key in VENUS_CHAIN_KEYS]
    expected_status = (
        "ERROR" if all(status == "ERROR" for status in statuses)
        else "DEGRADED" if "ERROR" in statuses
        else "DRIFT" if "DRIFT" in statuses
        else "CLEAR"
    )
    return state["status"] == expected_status


def _bounded_count(value: Any) -> bool:
    return (
        not isinstance(value, bool)
        and isinstance(value, int)
        and 0 <= value <= 1_000_000_000
    )


def aave_v4_state_valid(state: Any) -> bool:
    """Validate the dedicated read-only watcher artifact, not legacy STATE."""

    if not isinstance(state, dict):
        return False
    if state.get("schema") != AAVE_V4_SCHEMA:
        return False
    if state.get("scanner") != AAVE_V4_SCANNER:
        return False
    safety = state.get("safety")
    latest = state.get("latest")
    if (
        not isinstance(safety, dict)
        or safety.get("signedActions") is not False
        or safety.get("signedActionJustified") is not False
        or safety.get("routePositive") is not False
        or not isinstance(latest, dict)
        or timestamp(state.get("generatedAt")) is None
        or timestamp(latest.get("generatedAt")) is None
        or timestamp(latest.get("sourceGeneratedAt")) is None
    ):
        return False
    source_health = latest.get("sourceHealth", state.get("sourceHealth", "OK"))
    if source_health not in SOURCE_HEALTH_VALUES:
        return False
    source_coverage = latest.get("sourceCoverage")
    if (
        not isinstance(source_coverage, dict)
        or source_coverage.get("classification") not in AAVE_V4_COVERAGE_CLASSIFICATIONS
        or not isinstance(source_coverage.get("complete"), bool)
    ):
        return False
    coverage_errors = source_coverage.get("errors")
    if coverage_errors is not None and (
        not isinstance(coverage_errors, list)
        or not all(isinstance(error, str) for error in coverage_errors)
    ):
        return False
    wrapper_generated = timestamp(state["generatedAt"])
    generated = timestamp(latest["generatedAt"])
    sourced = timestamp(latest["sourceGeneratedAt"])
    if (
        wrapper_generated is None
        or generated is None
        or sourced is None
        or sourced > generated + 300
        or generated > wrapper_generated + 300
    ):
        return False
    summary = latest.get("summary")
    if not isinstance(summary, dict) or summary.get("signedActionJustified") is not False:
        return False
    required_counts = (
        "activeBorrowers",
        "nearLiquidation",
        "liquidatable",
        "routePositive",
        "triggerRows",
        "quoteRequiredRows",
    )
    if not all(_bounded_count(summary.get(key)) for key in required_counts):
        return False
    if summary["routePositive"] != 0:
        return False
    for key in ("topHealthFactor", "topBpsToLiquidation", "topDebtUsd"):
        value = summary.get(key)
        if value is not None and _number(value) is None:
            return False
    for key in ("topRows", "triggerRows", "quoteRequiredRows"):
        rows = latest.get(key)
        if rows is not None and not isinstance(rows, list):
            return False
    return True


def research_watch_state_valid(state: Any) -> bool:
    """Validate builder output as display-only research metadata."""

    if not isinstance(state, dict) or state.get("schema") != RESEARCH_WATCH_SCHEMA:
        return False
    safety = state.get("safety")
    entries = state.get("entries")
    if (
        timestamp(state.get("generatedAt")) is None
        or not isinstance(safety, dict)
        or safety.get("readOnly") is not True
        or safety.get("networkAccess") is not False
        or safety.get("execution") is not False
        or safety.get("signedActions") is not False
        or not isinstance(entries, list)
        or len(entries) > 200
    ):
        return False
    def fail_closed(value: Any) -> bool:
        return value == "unknown" or value is False

    seen: set[str] = set()
    for entry in entries:
        if not isinstance(entry, dict):
            return False
        ident = entry.get("id")
        sources = entry.get("sources")
        gates = entry.get("gates")
        if (
            not isinstance(ident, str)
            or not re.fullmatch(r"[a-z0-9][a-z0-9-]{2,79}", ident)
            or ident in seen
            or not isinstance(entry.get("protocol"), str)
            or not entry["protocol"].strip()
            or entry.get("disposition") not in RESEARCH_DISPOSITIONS
            or entry.get("status") not in RESEARCH_ENTRY_STATUSES
            or entry.get("effectiveDisposition") not in RESEARCH_EFFECTIVE_DISPOSITIONS
            or not isinstance(entry.get("trigger"), str)
            or not entry["trigger"].strip()
            or not isinstance(entry.get("reason"), str)
            or not entry["reason"].strip()
            or not fail_closed(entry.get("routePositive"))
            or not fail_closed(entry.get("executableNow"))
            or entry.get("signedActionJustified") is not False
            or not isinstance(gates, dict)
            or not gates
            or not all(fail_closed(value) for value in gates.values())
            or not isinstance(sources, list)
            or not sources
        ):
            return False
        seen.add(ident)
        source_complete = True
        for source in sources:
            exists = source.get("exists") if isinstance(source, dict) else None
            mtime = source.get("mtime") if isinstance(source, dict) else None
            if (
                not isinstance(source, dict)
                or not isinstance(source.get("path"), str)
                or not source["path"]
                or source["path"].startswith(("/", "\\"))
                or ".." in source["path"].replace("\\", "/").split("/")
                or not isinstance(exists, bool)
                or (exists and timestamp(mtime) is None)
                or (not exists and mtime is not None)
            ):
                return False
            source_complete = source_complete and exists
        if (entry["status"] == "COMPLETE") != source_complete:
            return False
        if entry["effectiveDisposition"] != (
            entry["disposition"] if source_complete else "INCOMPLETE"
        ):
            return False
        review_at = entry.get("reviewAt")
        if entry["disposition"] == "SCHEDULED":
            if timestamp(review_at) is None:
                return False
        elif review_at is not None:
            return False
    return True


def current_audit_state_valid(state: Any) -> bool:
    """Accept only the fixed, local current-audit summary contract."""

    if not isinstance(state, dict):
        return False
    candidates = state.get("candidates")
    next_move = state.get("nextMove")
    if (
        set(state) != {
            "schema",
            "generatedAt",
            "overall",
            "routePositive",
            "executableNow",
            "signedActionJustified",
            "candidates",
            "nextMove",
        }
        or state.get("schema") != CURRENT_AUDIT_STATE_SCHEMA
        or timestamp(state.get("generatedAt")) is None
        or not isinstance(state.get("generatedAt"), str)
        or not state["generatedAt"].startswith("2026-10-11T")
        or not state["generatedAt"].endswith("Z")
        or state.get("overall") != CURRENT_AUDIT_OVERALL
        or state.get("routePositive") is not False
        or state.get("executableNow") is not False
        or state.get("signedActionJustified") is not False
        or not isinstance(candidates, list)
        or len(candidates) != len(CURRENT_AUDIT_CANDIDATES)
        or not isinstance(next_move, dict)
        or set(next_move) != {"primary", "secondary", "forkCondition"}
        or not all(isinstance(next_move[key], str) and next_move[key].strip() for key in next_move)
    ):
        return False
    for row, (name, status) in zip(candidates, CURRENT_AUDIT_CANDIDATES):
        if (
            not isinstance(row, dict)
            or set(row) != {"name", "status", "detail"}
            or row.get("name") != name
            or row.get("status") != status
            or not isinstance(row.get("detail"), str)
            or not row["detail"].strip()
        ):
            return False
    return True


def _current_audit_state(state: Any, now: float, available: bool) -> dict[str, Any]:
    """Normalize the standalone summary without consulting monitor artifacts."""

    if not available or not current_audit_state_valid(state):
        return {"available": False}
    fresh, age = freshness(state["generatedAt"], now)
    return {
        "available": True,
        "generated_at": _iso_time(state["generatedAt"]),
        "freshness": fresh,
        "age": age,
        "overall": state["overall"],
        "route_positive": False,
        "executable_now": False,
        "signed_action_justified": False,
        "candidates": [
            {"name": row["name"], "status": row["status"], "detail": row["detail"]}
            for row in state["candidates"]
        ],
        "next_move": {
            "primary": state["nextMove"]["primary"],
            "secondary": state["nextMove"]["secondary"],
            "fork_condition": state["nextMove"]["forkCondition"],
        },
    }


def _stex_decimal(value: Any) -> bool:
    """Validate a raw nonnegative decimal without converting its units."""

    return isinstance(value, str) and NONNEGATIVE_DECIMAL.fullmatch(value) is not None


def _stex_raw(value: Any) -> bool:
    return value is None or _stex_decimal(value)


def _stex_block_timestamp(value: Any) -> bool:
    return bool(
        isinstance(value, str)
        and STEX_BLOCK_TIMESTAMP.fullmatch(value)
        and 0 <= int(value) <= 4_102_444_800
    )


def _stex_block(value: Any) -> bool:
    return bool(
        isinstance(value, dict)
        and set(value) == STEX_BLOCK_FIELDS
        and isinstance(value.get("number"), str)
        and NONNEGATIVE_DECIMAL.fullmatch(value["number"]) is not None
        and isinstance(value.get("hash"), str)
        and HEX_32.fullmatch(value["hash"]) is not None
        and _stex_block_timestamp(value.get("timestamp"))
    )


def _stex_null_block(value: Any) -> bool:
    return isinstance(value, dict) and set(value) == STEX_BLOCK_FIELDS and all(
        value[key] is None for key in STEX_BLOCK_FIELDS
    )


def _stex_incomplete_block_window(value: Any) -> bool:
    """Accept only the producer's atomic, one-sided incomplete header shape."""

    if not isinstance(value, dict) or set(value) != {"before", "after", "stable"}:
        return False
    before_null = _stex_null_block(value["before"])
    after_null = _stex_null_block(value["after"])
    if not (before_null or _stex_block(value["before"])):
        return False
    if not (after_null or _stex_block(value["after"])):
        return False
    if before_null:
        return after_null and value["stable"] is None
    if after_null:
        return value["stable"] is None
    return isinstance(value["stable"], bool)


def _stex_incomplete_trigger_observations(value: dict[str, Any]) -> bool:
    """Validate nullable observations retained when the producer fails closed."""

    active_rows = value.get("activeRows")
    positive_gap = value.get("positiveGap")
    total_gap = value.get("totalGapRaw")
    aggregates = (active_rows, positive_gap, total_gap)
    if all(item is None for item in aggregates):
        return bool(
            value.get("paused") is not True
            and (value.get("paused") is False or value.get("pendingCount") is None)
        )
    return bool(
        active_rows == 0
        and positive_gap is False
        and total_gap == "0"
        and (
            value.get("paused") is True and value.get("pendingCount") is None
            or value.get("paused") is False
            and isinstance(value.get("pendingCount"), int)
            and not isinstance(value.get("pendingCount"), bool)
        )
    )


def stex_profit_trigger_valid(state: Any) -> bool:
    """Validate the narrow STEX trigger artifact without deriving a route claim."""

    if not isinstance(state, dict) or set(state) != {
        "schema", "generatedAt", "chainId", "evidenceClass", "blockWindow", "trigger",
        "requests", "liquidity", "economics", "gates", "safety",
    }:
        return False
    block_window = state.get("blockWindow")
    trigger = state.get("trigger")
    liquidity = state.get("liquidity")
    economics = state.get("economics")
    safety = state.get("safety")
    incomplete = isinstance(trigger, dict) and trigger.get("status") == "INCOMPLETE"
    if (
        state.get("schema") != STEX_PROFIT_TRIGGER_SCHEMA
        or timestamp(state.get("generatedAt")) is None
        or not isinstance(state.get("generatedAt"), str)
        or not state["generatedAt"].endswith("Z")
        or state.get("chainId") not in ({None, STEX_CHAIN_ID} if incomplete else {STEX_CHAIN_ID})
        or state.get("evidenceClass") != STEX_EVIDENCE_CLASS
        or not isinstance(block_window, dict)
        or set(block_window) != {"before", "after", "stable"}
        or not (_stex_incomplete_block_window(block_window) if incomplete else (_stex_block(block_window["before"]) and _stex_block(block_window["after"]) and isinstance(block_window["stable"], bool)))
        or not isinstance(trigger, dict)
        or set(trigger) != STEX_TRIGGER_FIELDS
        or not isinstance(trigger.get("status"), str)
        or re.fullmatch(r"[A-Z][A-Z0-9_]{0,63}", trigger["status"]) is None
        or trigger.get("paused") is not None and not isinstance(trigger.get("paused"), bool)
        or trigger.get("pendingCount") is not None and (
            not isinstance(trigger.get("pendingCount"), int)
            or isinstance(trigger.get("pendingCount"), bool)
            or not 0 <= trigger["pendingCount"] <= 1_000_000
        )
        or (not _stex_incomplete_trigger_observations(trigger) if incomplete else (not isinstance(trigger.get("activeRows"), int) or isinstance(trigger.get("activeRows"), bool) or not 0 <= trigger["activeRows"] <= 1_000_000 or not isinstance(trigger.get("positiveGap"), bool) or not _stex_decimal(trigger.get("totalGapRaw"))))
        or not isinstance(state.get("requests"), list)
        or len(state["requests"]) > 16
        or not isinstance(liquidity, dict)
        or set(liquidity) != STEX_LIQUIDITY_FIELDS
        or not isinstance(liquidity.get("status"), str)
        or re.fullmatch(r"[A-Z][A-Z0-9_]{0,63}", liquidity["status"]) is None
        or not isinstance(economics, dict)
        or set(economics) != STEX_ECONOMICS_FIELDS
        or not isinstance(economics.get("status"), str)
        or re.fullmatch(r"[A-Z][A-Z0-9_]{0,63}", economics["status"]) is None
        or not isinstance(state.get("gates"), dict)
        or set(state["gates"]) != STEX_GATE_FIELDS
        or not all(value in STEX_GATE_VALUES for value in state["gates"].values())
        or not isinstance(safety, dict)
        or set(safety) != {"networkCalls", "automaticRetries", "transactions", "signing", "broadcast"}
        or not isinstance(safety.get("networkCalls"), int)
        or isinstance(safety.get("networkCalls"), bool)
        or not 0 <= safety["networkCalls"] <= 1_000_000
        or safety.get("automaticRetries") != 0
        or safety.get("transactions") != 0
        or safety.get("signing") is not False
        or safety.get("broadcast") is not False
    ):
        return False
    if incomplete:
        before = block_window["before"]
        after = block_window["after"]
        if _stex_block(before) and _stex_block(after):
            if int(before["number"]) > int(after["number"]):
                return False
            if int(before["timestamp"]) > int(after["timestamp"]):
                return False
        return bool(
            state["requests"] == []
            and liquidity["status"] == "NOT_RUN"
            and economics["status"] == "NOT_RUN"
            and all(liquidity[key] is None for key in STEX_LIQUIDITY_FIELDS - {"status"})
            and all(economics[key] is None for key in STEX_ECONOMICS_FIELDS - {"status"})
        )
    if int(block_window["before"]["number"]) > int(block_window["after"]["number"]):
        return False
    if int(block_window["before"]["timestamp"]) > int(block_window["after"]["timestamp"]):
        return False
    if not all(
        isinstance(row, dict)
        and set(row) == STEX_REQUEST_FIELDS
        and all(_stex_decimal(row[field]) for field in STEX_REQUEST_FIELDS)
        for row in state["requests"]
    ):
        return False
    if len({row["id"] for row in state["requests"]}) != len(state["requests"]):
        return False
    if not all(_stex_raw(liquidity[field]) for field in STEX_LIQUIDITY_FIELDS - {"status"}):
        return False
    if not all(_stex_raw(economics[field]) for field in STEX_ECONOMICS_FIELDS - {"status"}):
        return False
    return True


def _stex_profit_trigger(state: Any, now: float, available: bool) -> dict[str, Any]:
    """Present only explicit STEX evidence; cached or invalid input is unavailable."""

    if not available or not stex_profit_trigger_valid(state):
        return {"available": False}
    fresh, age = freshness(state["generatedAt"], now)
    trigger = state["trigger"]
    return {
        "available": True,
        "generated_at": _iso_time(state["generatedAt"]),
        "freshness": fresh,
        "age": age,
        "chain_id": state["chainId"],
        "evidence_class": state["evidenceClass"],
        "block_window": state["blockWindow"],
        "status": trigger["status"],
        "paused": trigger["paused"],
        "pending_count": trigger["pendingCount"],
        "active_rows": trigger["activeRows"],
        "positive_gap": trigger["positiveGap"],
        "total_gap_raw": trigger["totalGapRaw"],
        "requests": state["requests"],
        "liquidity": {
            "status": state["liquidity"]["status"],
            "raw": [(key, state["liquidity"][key]) for key in STEX_LIQUIDITY_FIELDS - {"status"}],
        },
        "economics": {
            "status": state["economics"]["status"],
            "raw": [(key, state["economics"][key]) for key in STEX_ECONOMICS_FIELDS - {"status"}],
        },
        "gates": list(state["gates"].items()),
    }


def _etherfi_safety_valid(safety: Any) -> bool:
    legacy = {"inventoryReadInMemoryOnly", "networkCalls", "automaticRetries", "transactions", "signing", "broadcast"}
    if not isinstance(safety, dict) or set(safety) not in (legacy, legacy | {"transportFailures", "retryExhaustions"}):
        return False
    if (safety.get("inventoryReadInMemoryOnly") is not True
        or safety.get("signing") is not False or safety.get("broadcast") is not False
        or type(safety.get("transactions")) is not int or safety["transactions"] != 0
        or not all(type(safety.get(key)) is int and 0 <= safety[key] <= 1_000_000 for key in ("networkCalls", "automaticRetries"))):
        return False
    if set(safety) == legacy:
        return safety["automaticRetries"] == 0
    return (
        all(type(safety[key]) is int and 0 <= safety[key] <= safety["networkCalls"] for key in ("transportFailures", "retryExhaustions"))
        and safety["networkCalls"] <= 80
        and safety["automaticRetries"] <= min(44, safety["transportFailures"])
        and safety["retryExhaustions"] <= safety["transportFailures"]
    )


def etherfi_debtmanager_profit_trigger_valid(state: Any) -> bool:
    """Validate the exact EtherFi read-only trigger contract."""

    base_keys = {
        "schema", "generatedAt", "chainId", "evidenceClass", "pin", "runtime", "paused",
        "pools", "trigger", "economics", "gates", "safety",
    }
    if not isinstance(state, dict) or state.get("schema") not in (ETHERFI_PROFIT_TRIGGER_SCHEMA, ETHERFI_PROFIT_TRIGGER_SCHEMA_V2):
        return False
    if set(state) != (base_keys | ({"diagnostics"} if state["schema"] == ETHERFI_PROFIT_TRIGGER_SCHEMA_V2 else set())):
        return False
    pin = state.get("pin")
    runtime = state.get("runtime")
    trigger = state.get("trigger")
    economics = state.get("economics")
    gates = state.get("gates")
    safety = state.get("safety")
    if (
        not isinstance(state.get("generatedAt"), str)
        or not state["generatedAt"].endswith("Z")
        or timestamp(state["generatedAt"]) is None
        or not isinstance(state.get("chainId"), int)
        or isinstance(state.get("chainId"), bool)
        or not 1 <= state["chainId"] <= 4_294_967_295
        or not isinstance(state.get("evidenceClass"), str)
        or re.fullmatch(r"[A-Z][A-Z0-9_]{0,63}", state["evidenceClass"]) is None
        or not isinstance(pin, dict)
        or set(pin) != ETHERFI_PIN_FIELDS
        or not _stex_decimal(pin.get("number"))
        or not isinstance(pin.get("hash"), str)
        or HEX_32.fullmatch(pin["hash"]) is None
        or not _stex_block_timestamp(pin.get("timestamp"))
        or not isinstance(pin.get("finalized"), bool)
        or not all(isinstance(pin.get(key), int) and not isinstance(pin.get(key), bool) and 0 <= pin[key] <= 1_000_000 for key in ("headerFamilies", "stateFamilies"))
        or not isinstance(runtime, dict)
        or set(runtime) != ETHERFI_RUNTIME_FIELDS
        or not isinstance(runtime.get("implementation"), str)
        or ETHERFI_ADDRESS.fullmatch(runtime["implementation"]) is None
        or any(not isinstance(runtime.get(key), str) or HEX_32.fullmatch(runtime[key]) is None for key in ("proxyRuntimeHash", "implementationRuntimeHash"))
        or not isinstance(runtime.get("changedFromHistorical"), bool)
        or not isinstance(runtime.get("exactCurrentSourceBound"), bool)
        or not isinstance(state.get("paused"), bool)
        or not isinstance(state.get("pools"), list)
        or len(state["pools"]) != 2
        or not isinstance(trigger, dict)
        or set(trigger) != {"status", "positive", "reason"}
        or not isinstance(trigger.get("status"), str)
        or re.fullmatch(r"[A-Z][A-Z0-9_]{0,63}", trigger["status"]) is None
        or not isinstance(trigger.get("positive"), bool)
        or not isinstance(trigger.get("reason"), str)
        or re.fullmatch(r"[A-Z][A-Z0-9_]{0,127}", trigger["reason"]) is None
        or not isinstance(economics, dict)
        or set(economics) != ETHERFI_ECONOMICS_FIELDS
        or not isinstance(economics.get("status"), str)
        or re.fullmatch(r"[A-Z][A-Z0-9_]{0,63}", economics["status"]) is None
        or not isinstance(gates, dict)
        or set(gates) != ETHERFI_GATE_FIELDS
        or not all(value in STEX_GATE_VALUES for value in gates.values())
        or not _etherfi_safety_valid(safety)
    ):
        return False
    if not all(
        isinstance(pool, dict)
        and set(pool) == ETHERFI_POOL_FIELDS
        and isinstance(pool.get("token"), str)
        and ETHERFI_ADDRESS.fullmatch(pool["token"]) is not None
        and isinstance(pool.get("decimals"), int)
        and not isinstance(pool.get("decimals"), bool)
        and 0 <= pool["decimals"] <= 255
        and all(_stex_decimal(pool[key]) for key in ("assetsRaw", "sharesRaw", "liquidRaw", "minSharesRaw", "recentWindowFrom", "recentWindowTo"))
        and _stex_raw(pool.get("zeroShareMaxRaw"))
        and isinstance(pool.get("recentSupplyEventCount"), int)
        and not isinstance(pool.get("recentSupplyEventCount"), bool)
        and 0 <= pool["recentSupplyEventCount"] <= 1_000_000
        and isinstance(pool.get("recentNonDustSupply"), bool)
        and int(pool["recentWindowFrom"]) <= int(pool["recentWindowTo"])
        for pool in state["pools"]
    ) or len({pool["token"].lower() for pool in state["pools"]}) != 2:
        return False
    if state["schema"] == ETHERFI_PROFIT_TRIGGER_SCHEMA_V2:
        diagnostics = state["diagnostics"]
        if not isinstance(diagnostics, dict) or set(diagnostics) != ETHERFI_DIAGNOSTIC_FIELDS:
            return False
        counts = (
            "candidatesConsidered", "qualificationAttempts", "chainMatches", "finalizedQualified",
            "pinConsensusFamilies", "stateAttempts", "stateSuccesses", "stateConsensusFamilies",
            "stateDistinctGroups", "flowAttempts", "flowSuccesses", "flowConsensusFamilies",
            "flowDistinctGroups",
        )
        if not all(isinstance(diagnostics[key], int) and not isinstance(diagnostics[key], bool) and diagnostics[key] >= 0 for key in counts):
            return False
        relationships = (
            ("qualificationAttempts", "candidatesConsidered"), ("chainMatches", "qualificationAttempts"),
            ("finalizedQualified", "chainMatches"), ("pinConsensusFamilies", "finalizedQualified"),
            ("flowAttempts", "finalizedQualified"), ("flowSuccesses", "flowAttempts"),
            ("stateAttempts", "flowSuccesses"), ("stateSuccesses", "stateAttempts"),
            ("stateConsensusFamilies", "stateSuccesses"),
            ("flowConsensusFamilies", "flowSuccesses"),
        )
        if diagnostics["candidatesConsidered"] > 44 or any(diagnostics[child] > diagnostics[parent] for child, parent in relationships) or diagnostics["stateDistinctGroups"] > diagnostics["stateSuccesses"] or diagnostics["flowConsensusFamilies"] > diagnostics["stateConsensusFamilies"] or diagnostics["flowDistinctGroups"] > diagnostics["stateConsensusFamilies"]:
            return False
        if diagnostics["failurePhase"] not in ETHERFI_FAILURE_PHASES or diagnostics["failureCode"] not in ETHERFI_FAILURE_CODES or (diagnostics["failurePhase"] == "NONE") != (diagnostics["failureCode"] == "NONE") or (trigger["status"] == "INCOMPLETE") != (diagnostics["failurePhase"] != "NONE"):
            return False
    return all(_stex_raw(economics[key]) for key in ETHERFI_ECONOMICS_FIELDS - {"status"})


def _etherfi_debtmanager_profit_trigger(state: Any, now: float, available: bool) -> dict[str, Any]:
    """Normalize only explicit EtherFi evidence and hide incomplete placeholders."""

    if not available or not etherfi_debtmanager_profit_trigger_valid(state):
        return {"available": False}
    fresh, age = freshness(state["generatedAt"], now)
    pin = state["pin"]
    incomplete = (
        state["trigger"]["status"] == "INCOMPLETE"
        or pin["headerFamilies"] == 0
        or pin["stateFamilies"] == 0
    )
    return {
        "available": True,
        "generated_at": _iso_time(state["generatedAt"]),
        "freshness": fresh,
        "age": age,
        "evidence_class": state["evidenceClass"],
        "pin": pin,
        "runtime": state["runtime"],
        "paused": state["paused"],
        "status": state["trigger"]["status"],
        "positive": state["trigger"]["positive"],
        "reason": state["trigger"]["reason"],
        "diagnostics": state.get("diagnostics"),
        "pool_evidence_complete": not incomplete,
        "pools": state["pools"] if not incomplete else [],
        "economics": {"status": state["economics"]["status"], "raw": [(key, state["economics"][key]) for key in ETHERFI_ECONOMICS_FIELDS - {"status"}]},
        "gates": list(state["gates"].items()),
    }


def lista_auction_incentive_profit_trigger_valid(state: Any) -> bool:
    """Validate the exact BSC Lista auction-reset trigger contract."""

    if not isinstance(state, dict) or set(state) != {
        "schema", "generatedAt", "chainId", "evidenceClass", "pin", "runtime", "controls",
        "auctions", "economics", "trigger", "gates", "safety",
    }:
        return False
    pin, runtime, controls = state.get("pin"), state.get("runtime"), state.get("controls")
    auctions, economics, trigger = state.get("auctions"), state.get("economics"), state.get("trigger")
    gates, safety = state.get("gates"), state.get("safety")
    if (
        state.get("schema") != LISTA_PROFIT_TRIGGER_SCHEMA
        or not isinstance(state.get("generatedAt"), str) or not state["generatedAt"].endswith("Z") or timestamp(state["generatedAt"]) is None
        or state.get("chainId") != 56
        or not isinstance(state.get("evidenceClass"), str) or re.fullmatch(r"[A-Z][A-Z0-9_]{0,63}", state["evidenceClass"]) is None
        or not isinstance(pin, dict) or set(pin) != LISTA_PIN_FIELDS
        or not _stex_decimal(pin.get("number")) or not _stex_block_timestamp(pin.get("timestamp"))
        or any(not isinstance(pin.get(key), str) or HEX_32.fullmatch(pin[key]) is None for key in ("hash", "stateRoot"))
        or pin.get("finalized") is not True
        or not all(isinstance(pin.get(key), int) and not isinstance(pin.get(key), bool) and 0 <= pin[key] <= 1_000_000 for key in ("headerFamilies", "stateFamilies"))
        or not isinstance(runtime, dict) or set(runtime) != LISTA_RUNTIME_FIELDS
        or any(not isinstance(runtime.get(key), str) or ETHERFI_ADDRESS.fullmatch(runtime[key]) is None for key in ("interactionImplementation", "clipImplementation"))
        or any(not isinstance(runtime.get(key), str) or HEX_32.fullmatch(runtime[key]) is None for key in ("interactionImplementationRuntimeHash", "clipImplementationRuntimeHash"))
        or not isinstance(runtime.get("changedFromBaseline"), bool) or not isinstance(runtime.get("sourceRuntimeAttested"), bool)
        or not isinstance(controls, dict) or set(controls) != LISTA_CONTROL_FIELDS
        or not all(_stex_decimal(controls.get(key)) for key in ("auctionWhitelistModeRaw", "stoppedRaw", "tipRad", "chipWad", "chostRad"))
        or not isinstance(controls.get("publicAuctionCaller"), bool)
        or not isinstance(auctions, dict) or set(auctions) != LISTA_AUCTION_FIELDS
        or not all(isinstance(auctions.get(key), int) and not isinstance(auctions.get(key), bool) and 0 <= auctions[key] <= 1_000_000 for key in ("activeCount", "scannedCount", "needsRedoCount", "rewardEligibleRedoCount"))
        or not isinstance(auctions.get("scanComplete"), bool)
        or not isinstance(economics, dict) or set(economics) != LISTA_ECONOMICS_FIELDS
        or economics.get("status") not in LISTA_ECONOMICS_VALUES
        or not all(_stex_decimal(economics.get(key)) for key in ("maximumGrossRewardRad", "maximumGrossRewardLisUSDRaw"))
        or not all(_stex_raw(economics.get(key)) for key in LISTA_ECONOMICS_FIELDS - {"status", "maximumGrossRewardRad", "maximumGrossRewardLisUSDRaw"})
        or not isinstance(trigger, dict) or set(trigger) != {"status", "positive", "reason"}
        or trigger.get("status") not in LISTA_TRIGGER_VALUES or not isinstance(trigger.get("positive"), bool)
        or not isinstance(trigger.get("reason"), str) or re.fullmatch(r"[A-Z][A-Z0-9_]{0,127}", trigger["reason"]) is None
        or not isinstance(gates, dict) or set(gates) != LISTA_GATE_FIELDS or not all(value in STEX_GATE_VALUES for value in gates.values())
        or not isinstance(safety, dict) or set(safety) != {"inventoryReadInMemoryOnly", "networkCalls", "automaticRetries", "transactions", "signing", "broadcast", "borrowerScanning", "auctionIdsPersisted"}
        or safety.get("inventoryReadInMemoryOnly") is not True or not isinstance(safety.get("networkCalls"), int) or isinstance(safety.get("networkCalls"), bool) or not 0 <= safety["networkCalls"] <= 1_000_000
        or safety.get("automaticRetries") != 0 or safety.get("transactions") != 0 or safety.get("signing") is not False or safety.get("broadcast") is not False or safety.get("borrowerScanning") is not False or safety.get("auctionIdsPersisted") is not False
    ):
        return False
    return True


def _lista_auction_incentive_profit_trigger(state: Any, now: float, available: bool) -> dict[str, Any]:
    """Normalize Lista evidence without promoting gross or placeholder values."""

    if not available or not lista_auction_incentive_profit_trigger_valid(state):
        return {"available": False}
    fresh, age = freshness(state["generatedAt"], now)
    trigger, auctions, economics = state["trigger"], state["auctions"], state["economics"]
    economics_reported = economics["status"] != "NOT_RUN" and auctions["activeCount"] > 0
    return {
        "available": True, "generated_at": _iso_time(state["generatedAt"]), "freshness": fresh,
        "age": age, "evidence_class": state["evidenceClass"], "pin": state["pin"],
        "runtime": state["runtime"], "controls": state["controls"], "auctions": auctions,
        "status": trigger["status"], "positive": trigger["positive"], "reason": trigger["reason"],
        "economics": {"status": economics["status"], "reported": economics_reported, "raw": [(key, economics[key]) for key in LISTA_ECONOMICS_FIELDS - {"status"}]},
        "gates": list(state["gates"].items()),
    }


def _public_github_url(value: Any) -> bool:
    if not isinstance(value, str) or len(value) > 300:
        return False
    parsed = urlparse(value)
    return bool(
        parsed.scheme == "https"
        and parsed.netloc in {"github.com", "api.github.com"}
        and parsed.username is None
        and parsed.password is None
        and parsed.fragment == ""
        and parsed.path.startswith("/")
    )


def _aave_decimal(value: Any) -> bool:
    return isinstance(value, str) and re.fullmatch(r"(?:0|[1-9][0-9]*)", value) is not None


def _aave_range(value: Any) -> bool:
    return isinstance(value, dict) and set(value) == {"fromBlock", "toBlock"} and _aave_decimal(value["fromBlock"]) and _aave_decimal(value["toBlock"]) and int(value["fromBlock"]) <= int(value["toBlock"])


def aave_v3_arbitrum_config_oracle_events_valid(state: Any) -> bool:
    """Validate the bounded event-only scanner artifact without interpreting state."""

    if not isinstance(state, dict):
        return False
    successful = state.get("status") in {"COMPLETE", "EVENT_SURVIVOR"}
    keys = {"schema", "generatedAt", "status", "outcome", "phase", "code", "chainId", "eventOnly", "sourcePinned", "qualification", "blockRange", "reads", "lastCompleteCursor", "continuation", "route", "safety"}
    if successful:
        keys |= {"eventCount", "categoryCounts", "events"}
    if set(state) != keys or state.get("schema") != AAVE_V3_ARBITRUM_EVENTS_SCHEMA or timestamp(state.get("generatedAt")) is None:
        return False
    if state.get("status") not in {"COMPLETE", "EVENT_SURVIVOR", "INCOMPLETE"} or state.get("phase") not in AAVE_V3_ARBITRUM_PHASES or state.get("code") not in AAVE_V3_ARBITRUM_CODES:
        return False
    if state.get("chainId") != 42161 or state.get("eventOnly") is not True or state.get("sourcePinned") is not True or successful != (state["phase"] == "NONE" and state["code"] == "NONE"):
        return False
    expected_outcome = "COMPLETE_ZERO_EVENTS" if state["status"] == "COMPLETE" else "EVENT_SURVIVOR_NO_ROUTE" if state["status"] == "EVENT_SURVIVOR" else "INCOMPLETE"
    if state.get("outcome") != expected_outcome:
        return False
    qualification = state.get("qualification")
    if not isinstance(qualification, dict) or set(qualification) != {"anonymousCandidateCount", "anonymousChainMatchedCount", "anonymousLogQualifiedCount", "selectedFamilyCount"}:
        return False
    counts = list(qualification.values())
    if not all(isinstance(value, int) and not isinstance(value, bool) and value >= 0 for value in counts) or qualification["anonymousCandidateCount"] > 6 or qualification["anonymousChainMatchedCount"] > qualification["anonymousCandidateCount"] or qualification["anonymousLogQualifiedCount"] > qualification["anonymousChainMatchedCount"] or qualification["selectedFamilyCount"] > 2:
        return False
    reads = state.get("reads")
    if not isinstance(reads, dict) or set(reads) != {"count", "maximum", "retries"} or not isinstance(reads.get("count"), int) or isinstance(reads.get("count"), bool) or reads["count"] < 0 or reads["count"] > 40 or reads.get("maximum") != 40 or reads.get("retries") != 0:
        return False
    if state.get("route") != {"routeObserved": False, "routePositive": "n/a", "stateInterpretationPerformed": False} or state.get("safety") != {"readOnlyRpc": True, "transactions": False, "signing": False, "broadcast": False, "walletAccess": False, "productionMutation": False}:
        return False
    cursor, block_range, continuation = state.get("lastCompleteCursor"), state.get("blockRange"), state.get("continuation")
    if (cursor is not None and not _aave_range(cursor)) or not isinstance(block_range, dict) or set(block_range) != {"fromBlock", "toBlock"} or not isinstance(continuation, dict) or set(continuation) != {"mode", "previousToBlock", "nextFromBlock", "cursorAdvanced", "backlogRemaining", "blocksScanned"}:
        return False
    if continuation.get("mode") not in {"FIRST_WINDOW", "CONTINUATION", "NO_NEW_FINALIZED_BLOCK", "INCOMPLETE"} or (continuation.get("previousToBlock") is not None and not _aave_decimal(continuation["previousToBlock"])) or (continuation.get("nextFromBlock") is not None and not _aave_decimal(continuation["nextFromBlock"])):
        return False
    if not isinstance(continuation.get("cursorAdvanced"), bool) or (continuation.get("backlogRemaining") is not None and not isinstance(continuation["backlogRemaining"], bool)) or not isinstance(continuation.get("blocksScanned"), int) or isinstance(continuation.get("blocksScanned"), bool) or not 0 <= continuation["blocksScanned"] <= 8192:
        return False
    if successful:
        event_count, category_counts, events = state.get("eventCount"), state.get("categoryCounts"), state.get("events")
        if not isinstance(event_count, int) or isinstance(event_count, bool) or not 0 <= event_count <= 64 or not isinstance(category_counts, dict) or set(category_counts) != set(AAVE_V3_ARBITRUM_EVENT_NAMES) or not all(isinstance(value, int) and not isinstance(value, bool) and value >= 0 for value in category_counts.values()) or sum(category_counts.values()) != event_count or not isinstance(events, list) or len(events) != event_count or (state["status"] == "COMPLETE") != (event_count == 0):
            return False
        if any(not isinstance(row, dict) or set(row) != {"category", "blockNumber", "transactionIndex", "logIndex", "commitment"} or row.get("category") not in AAVE_V3_ARBITRUM_EVENT_NAMES or not all(_aave_decimal(row.get(key)) for key in ("blockNumber", "transactionIndex", "logIndex")) or not isinstance(row.get("commitment"), str) or re.fullmatch(r"sha256-[A-Za-z0-9_-]{43}", row["commitment"]) is None for row in events):
            return False
        if continuation["mode"] == "NO_NEW_FINALIZED_BLOCK":
            if state["status"] != "COMPLETE" or event_count != 0 or cursor is None or block_range != {"fromBlock": None, "toBlock": None} or continuation["cursorAdvanced"] or continuation["blocksScanned"] != 0 or continuation["backlogRemaining"] is not False or continuation["previousToBlock"] != cursor["toBlock"] or continuation["nextFromBlock"] != str(int(cursor["toBlock"]) + 1):
                return False
        elif continuation["mode"] not in {"FIRST_WINDOW", "CONTINUATION"} or not _aave_range(block_range) or cursor != block_range or continuation["cursorAdvanced"] is not True or continuation["blocksScanned"] != int(block_range["toBlock"]) - int(block_range["fromBlock"]) + 1 or continuation["nextFromBlock"] != str(int(block_range["toBlock"]) + 1) or (continuation["mode"] == "FIRST_WINDOW") != (continuation["previousToBlock"] is None) or (continuation["mode"] == "CONTINUATION" and int(block_range["fromBlock"]) != int(continuation["previousToBlock"]) + 1):
            return False
    elif continuation["mode"] != "INCOMPLETE" or continuation["cursorAdvanced"] or continuation["backlogRemaining"] is not None or continuation["blocksScanned"] != 0 or block_range != {"fromBlock": None, "toBlock": None} or (cursor is None and (continuation["previousToBlock"] is not None or continuation["nextFromBlock"] is not None)) or (cursor is not None and (continuation["previousToBlock"] != cursor["toBlock"] or continuation["nextFromBlock"] != str(int(cursor["toBlock"]) + 1))):
        return False
    return re.search(r"(?:https?|wss?)://|0x[0-9a-f]{8,}|\b(?:credentials?|secrets?|api[- _]?keys?|authorization|bearer|endpoints?|rpc[_-]?endpoints|raw[- _]?logs?)\b", json.dumps(state), re.IGNORECASE) is None


def _aave_v3_arbitrum_config_oracle_events(state: Any, now: float, available: bool) -> dict[str, Any]:
    if not available or not aave_v3_arbitrum_config_oracle_events_valid(state):
        return {"available": False}
    fresh, age = freshness(state["generatedAt"], now, 1800, 5400)
    return {"available": True, "generated_at": _iso_time(state["generatedAt"]), "freshness": fresh, "age": age, "status": state["outcome"], "positive": False, "event_survivor": state["outcome"] == "EVENT_SURVIVOR_NO_ROUTE", "event_count": state.get("eventCount"), "phase": state["phase"], "code": state["code"], "last_complete_cursor": state["lastCompleteCursor"], "continuation": state["continuation"], "route_positive": "n/a"}


def trigger_watch_scheduler_valid(state: Any) -> bool:
    base_keys = {"schema", "generatedAt", "cadenceSeconds", "discoveryCadenceSeconds", "running", "pid", "startedAt", "cycle", "producers", "discovery", "safety"}
    if not isinstance(state, dict) or set(state) - base_keys - {"capabilityRotation", "aaveV4BinderRefresh"}:
        return False
    cycle, discovery, safety, producers = state.get("cycle"), state.get("discovery"), state.get("safety"), state.get("producers")
    if (
        state.get("schema") != SCHEDULER_SCHEMA or not isinstance(state.get("generatedAt"), str) or timestamp(state["generatedAt"]) is None
        or state.get("cadenceSeconds") != 900 or state.get("discoveryCadenceSeconds") != 21600
        or not isinstance(state.get("running"), bool) or not isinstance(state.get("pid"), int) or isinstance(state.get("pid"), bool) or state["pid"] < 0
        or not isinstance(state.get("startedAt"), str) or timestamp(state["startedAt"]) is None
        or not isinstance(cycle, dict) or set(cycle) != {"sequence", "startedAt", "completedAt", "status"}
        or not isinstance(cycle.get("sequence"), int) or isinstance(cycle.get("sequence"), bool) or cycle["sequence"] < 0
        or any(not isinstance(cycle.get(key), str) or timestamp(cycle[key]) is None for key in ("startedAt", "completedAt")) or cycle.get("status") not in {"PASS", "DEGRADED"}
        or timestamp(cycle["startedAt"]) > timestamp(cycle["completedAt"])
        or not isinstance(producers, list) or len(producers) != len(SCHEDULER_PRODUCERS)
        or not isinstance(discovery, dict) or set(discovery) != {"status", "lastAttemptAt", "nextDueAt", "exitCode", "durationMs", "artifactPath"}
        or discovery.get("status") not in {"NOT_INSTALLED", "NOT_DUE", "PASS", "FAILED", "TIMEOUT", "ARTIFACT_INVALID"}
        or any(value is not None and (not isinstance(value, str) or timestamp(value) is None) for value in (discovery.get("lastAttemptAt"), discovery.get("nextDueAt")))
        or discovery.get("exitCode") is not None and (not isinstance(discovery.get("exitCode"), int) or isinstance(discovery.get("exitCode"), bool))
        or not isinstance(discovery.get("durationMs"), int) or isinstance(discovery.get("durationMs"), bool) or discovery["durationMs"] < 0
        or discovery.get("artifactPath") != "reports/monitor/official-deployed-delta-sentinel.json"
        or not isinstance(safety, dict) or safety != {"localOnly": True, "sequential": True, "overlap": False, "automaticRetries": 0, "transactionsInitiatedByScheduler": 0, "signing": False, "broadcast": False}
    ):
        return False
    for row, (ident, path) in zip(producers, SCHEDULER_PRODUCERS):
        if not isinstance(row, dict) or set(row) != {"id", "status", "exitCode", "durationMs", "artifactPath", "triggerStatus", "triggerReason", "generatedAt"}:
            return False
        if row.get("id") != ident or row.get("artifactPath") != path or row.get("status") not in {"PASS", "FAILED", "TIMEOUT", "ARTIFACT_INVALID"} or row.get("exitCode") is not None and (not isinstance(row["exitCode"], int) or isinstance(row["exitCode"], bool)) or not isinstance(row.get("durationMs"), int) or isinstance(row.get("durationMs"), bool) or row["durationMs"] < 0 or row.get("triggerStatus") is not None and (not isinstance(row["triggerStatus"], str) or re.fullmatch(r"[A-Z][A-Z0-9_]{0,63}", row["triggerStatus"]) is None) or row.get("triggerReason") is not None and (not isinstance(row["triggerReason"], str) or re.fullmatch(r"[A-Z][A-Z0-9_]{0,127}", row["triggerReason"]) is None) or row.get("generatedAt") is not None and (not isinstance(row["generatedAt"], str) or timestamp(row["generatedAt"]) is None) or row.get("status") == "PASS" and (row.get("exitCode") != 0 or row.get("triggerStatus") is None or row.get("generatedAt") is None):
            return False
    rotation = state.get("capabilityRotation")
    if rotation is not None:
        if not isinstance(rotation, dict) or set(rotation) != {"artifactPath", "status", "lastAttemptAt", "nextDueAt", "durationMs", "exitCode"} or rotation.get("artifactPath") != "reports/monitor/etherfi-optimism-provider-capability-rotation.json" or rotation.get("status") not in {"NOT_DUE", "READY", "INCOMPLETE", "DEGRADED", "FAILED", "TIMEOUT"} or not isinstance(rotation.get("durationMs"), int) or isinstance(rotation.get("durationMs"), bool) or rotation["durationMs"] < 0 or rotation.get("exitCode") is not None and (not isinstance(rotation["exitCode"], int) or isinstance(rotation["exitCode"], bool)) or any(value is not None and (not isinstance(value, str) or timestamp(value) is None) for value in (rotation.get("lastAttemptAt"), rotation.get("nextDueAt"))):
            return False
        if rotation["status"] in {"READY", "INCOMPLETE"} and rotation["exitCode"] != 0:
            return False
        if rotation["status"] == "NOT_DUE" and rotation["exitCode"] is not None:
            return False
        if rotation["status"] != "NOT_DUE":
            if rotation["lastAttemptAt"] is None or rotation["nextDueAt"] is None or timestamp(rotation["nextDueAt"]) < timestamp(rotation["lastAttemptAt"]):
                return False
    aave_refresh = state.get("aaveV4BinderRefresh")
    if aave_refresh is not None:
        if (
            not isinstance(aave_refresh, dict)
            or set(aave_refresh) != {"status", "lastAttemptAt", "durationMs", "exitCode"}
            or aave_refresh.get("status") not in {"NOT_DUE", "NOT_INSTALLED", "PASS", "FAILED", "TIMEOUT"}
            or not isinstance(aave_refresh.get("durationMs"), int) or isinstance(aave_refresh["durationMs"], bool) or aave_refresh["durationMs"] < 0
            or aave_refresh.get("exitCode") is not None and (not isinstance(aave_refresh["exitCode"], int) or isinstance(aave_refresh["exitCode"], bool))
            or aave_refresh.get("lastAttemptAt") is not None and (not isinstance(aave_refresh["lastAttemptAt"], str) or timestamp(aave_refresh["lastAttemptAt"]) is None)
        ):
            return False
        if aave_refresh["status"] == "PASS" and (aave_refresh.get("exitCode") != 0 or aave_refresh.get("lastAttemptAt") is None):
            return False
        if aave_refresh["status"] == "NOT_DUE" and (aave_refresh.get("exitCode") is not None or aave_refresh.get("lastAttemptAt") is not None):
            return False
        if aave_refresh["status"] in {"FAILED", "TIMEOUT", "NOT_INSTALLED"} and aave_refresh.get("lastAttemptAt") is None:
            return False
        if aave_refresh["status"] == "NOT_INSTALLED" and aave_refresh.get("exitCode") is not None:
            return False
    return True


def official_deployed_delta_sentinel_valid(state: Any) -> bool:
    if not isinstance(state, dict) or set(state) != {"schema", "generatedAt", "runId", "status", "baselineCreated", "repositories"}:
        return False
    rows = state.get("repositories")
    if state.get("schema") != SENTINEL_SCHEMA or not isinstance(state.get("generatedAt"), str) or timestamp(state["generatedAt"]) is None or not isinstance(state.get("runId"), str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,160}", state["runId"]) or state.get("status") not in {"unchanged", "candidate-change", "incomplete", "rate-limited"} or not isinstance(state.get("baselineCreated"), bool) or not isinstance(rows, list) or len(rows) != len(SENTINEL_REPOSITORIES):
        return False
    for row, (repository_id, source_class) in zip(rows, SENTINEL_REPOSITORIES):
        if not isinstance(row, dict) or set(row) != SENTINEL_REPO_FIELDS:
            return False
        if row.get("id") != repository_id or row.get("officialUrl") != f"https://github.com/{repository_id}" or row.get("sourceClass") != source_class or row.get("defaultBranch") is not None and not isinstance(row["defaultBranch"], str) or row.get("observedHeadSha") is not None and (not isinstance(row["observedHeadSha"], str) or re.fullmatch(r"[0-9a-f]{40}", row["observedHeadSha"]) is None) or row.get("previousHeadSha") is not None and (not isinstance(row["previousHeadSha"], str) or re.fullmatch(r"[0-9a-f]{40}", row["previousHeadSha"]) is None) or row.get("pollStatus") not in {"unchanged", "candidate-change", "incomplete", "rate-limited"} or not isinstance(row.get("observedAt"), str) or timestamp(row["observedAt"]) is None:
            return False
        list_fields = ("releaseIds", "tags", "configuredManifestPaths", "changedManifestPaths", "changeHints", "chainTextHints", "evidenceUrls")
        if not all(isinstance(row.get(key), list) and len(row[key]) <= 64 for key in list_fields) or not all(isinstance(value, int) and not isinstance(value, bool) and value >= 0 for value in row["releaseIds"]) or not all(isinstance(value, str) and len(value) <= 200 for key in ("tags", "configuredManifestPaths", "changedManifestPaths", "changeHints", "chainTextHints") for value in row[key]) or not all(_public_github_url(url) for url in row["evidenceUrls"]) or not isinstance(row.get("etagByUrl"), dict) or set(row["etagByUrl"]) != set(row["evidenceUrls"]) or not all(isinstance(tag, str) and len(tag) <= 300 for tag in row["etagByUrl"].values()):
            return False
    return True


def _continuous_watch(scheduler: Any, sentinel: Any, trigger_states: dict[str, Any], now: float, scheduler_current: bool, sentinel_current: bool) -> dict[str, Any]:
    if not scheduler_current or not trigger_watch_scheduler_valid(scheduler):
        return {"available": False}
    fresh, age = freshness(scheduler["generatedAt"], now, 1800, 5400)
    producers = []
    for row, key in zip(scheduler["producers"], ("stex", "etherfi", "lista", "aave")):
        artifact = trigger_states[key]
        aligned = bool(artifact.get("available") and artifact.get("freshness") in CURRENT_FRESHNESS and artifact.get("generated_at") == _iso_time(row["generatedAt"]) and artifact.get("status") == row["triggerStatus"])
        producers.append({"id": row["id"], "status": row["status"], "trigger_status": row["triggerStatus"], "aligned": aligned})
    sentinel_view = {"available": False}
    if sentinel_current and official_deployed_delta_sentinel_valid(sentinel):
        sentinel_view = {"available": True, "status": sentinel["status"], "baseline_created": sentinel["baselineCreated"], "generated_at": _iso_time(sentinel["generatedAt"])}
    rotation = scheduler.get("capabilityRotation")
    rotation_view = None if rotation is None else {"status": rotation["status"], "last_attempt_at": _iso_time(rotation["lastAttemptAt"]), "next_due_at": _iso_time(rotation["nextDueAt"])}
    return {"available": True, "running": scheduler["running"], "cycle": scheduler["cycle"]["status"], "generated_at": _iso_time(scheduler["generatedAt"]), "freshness": fresh, "age": age, "producers": producers, "discovery": scheduler["discovery"], "sentinel": sentinel_view, "capability_rotation": rotation_view, "operational": scheduler["running"] and scheduler["cycle"]["status"] == "PASS" and fresh in CURRENT_FRESHNESS and all(row["aligned"] and row["status"] == "PASS" for row in producers)}


def legacy_state_valid(state: Any) -> bool:
    return isinstance(state, dict) and isinstance(state.get("conditions"), dict)


def _venus_psr(item: Monitor, now: float, state: Any) -> dict[str, Any]:
    provenance = ["venus-psr-state", item.id]
    invalid = _unknown()
    invalid.update(
        provenance=provenance,
        warnings=["Venus PSR producer state is unavailable or invalid"],
        source_health="ERROR",
        producer_health=_producer_health(item, {}),
    )
    if not venus_state_valid(state):
        return invalid

    chain_key, chain_id = VENUS_PSR_CHAINS[item.id]
    chain = state["chains"].get(chain_key)
    interval = state["intervalSeconds"]
    base_aging, base_stale = item.freshness_limits()
    aging_after = max(base_aging, interval * 2)
    stale_after = max(base_stale, interval * 6)
    fresh, age = freshness(chain["attemptAt"], now, aging_after, stale_after)
    chain_status = chain["status"]
    if chain_status == "CLEAR" and fresh in CURRENT_FRESHNESS:
        observation = "CLEAR"
    elif chain_status == "CLEAR":
        observation = "UNKNOWN"
    elif chain_status == "ERROR":
        observation = "ERROR"
    elif fresh in CURRENT_FRESHNESS:
        observation = "TRIGGERED"
    else:
        observation = "WATCH"

    current = chain.get("current") if isinstance(chain.get("current"), dict) else {}
    unresolved = chain.get("unresolvedDrift") if isinstance(chain.get("unresolvedDrift"), dict) else None
    warnings = []
    if chain_status == "ERROR":
        warnings.append("Current chain read failed; no clear status inferred")
    elif chain_status == "CLEAR" and observation == "UNKNOWN":
        warnings.append(
            "Venus PSR clear result is not fresh enough to support a current negative claim"
        )
    elif chain_status == "DRIFT" and observation == "WATCH":
        warnings.append("Recorded drift is not fresh enough for a current alarm")
    if unresolved is not None:
        warnings.append("Prior successful drift remains unresolved")
    if current:
        warnings.append("Single-provider comparison only; independent corroboration is not established")
    metrics = _metrics(
        (
            ("producer status", chain_status),
            ("current block", current.get("blockNumber")),
            ("drift categories", len(chain["driftCategories"])),
            ("unresolved drift categories", len(unresolved["driftCategories"]) if unresolved else 0),
        )
    )
    result = {
        "observation": observation,
        "freshness": fresh,
        "age": age,
        "alarm": _alarm(item, observation, fresh),
        "metrics": metrics,
        "provenance": provenance,
        "warnings": warnings,
        "observation_at": _iso_time(chain["attemptAt"]),
        "source_health": "ERROR" if chain_status == "ERROR" else "OK",
        "baseline_block": chain["baseline"]["blockNumber"],
        "baseline_hash": chain["baseline"]["blockHash"],
        "current_block": current.get("blockNumber"),
        "rpc_strength": "single-provider" if current else "unknown",
        "unresolved_drift": {
            "at": _iso_time(unresolved["at"]),
            "block": unresolved["blockNumber"],
            "categories": list(unresolved["driftCategories"]),
            "status": "UNRESOLVED",
        } if unresolved else None,
    }
    result["producer_health"] = _producer_health(
        item,
        result,
        latest=chain["attemptAt"],
        last_success=chain.get("lastSuccessfulAt"),
    )
    result["producer_health"]["last_success"] = _iso_time(chain.get("lastSuccessfulAt"))
    result["producer_health"]["next_expected_update"] = _next_expected(chain["attemptAt"], interval)
    return result


def _aave_v4(item: Monitor, now: float, state: Any) -> dict[str, Any]:
    provenance = ["aave-v4-authoritative-watch"]
    if not aave_v4_state_valid(state):
        result = _unknown()
        result.update(
            provenance=provenance,
            warnings=["Dedicated Aave V4 watcher state is unavailable or invalid"],
            source_health="INVALID",
        )
        return result

    latest = state["latest"]
    summary = latest["summary"]
    source_coverage = latest["sourceCoverage"]
    observed_at = latest["sourceGeneratedAt"]
    aging_after, stale_after = item.freshness_limits()
    fresh, age = freshness(observed_at, now, aging_after, stale_after)
    source_health = latest.get("sourceHealth", state.get("sourceHealth", "OK"))
    exhaustive = _aave_v4_coverage_exhaustive(state, latest, source_coverage)
    observation, metrics = _classify_aave_v4(summary, source_coverage, exhaustive)
    warnings: list[str] = []
    has_finding = observation in {"WATCH", "TRIGGERED"}
    if source_health in {"STALE", "INVALID"}:
        warnings.append("Watcher source health does not support a current observation")
        fresh = "STALE" if source_health == "STALE" else "UNKNOWN"
        age = age if source_health == "STALE" else None
        observation = "HISTORICAL" if has_finding else "UNKNOWN"
    elif not exhaustive:
        observation = "HISTORICAL" if has_finding else "UNKNOWN"
        source_health = "DEGRADED"
        warnings.append(
            "Source coverage is incomplete; bounded findings are historical context only"
            if has_finding
            else "Source coverage is incomplete; zero samples do not establish a clear result"
        )
    elif fresh not in CURRENT_FRESHNESS:
        observation = "HISTORICAL" if has_finding else "UNKNOWN"
        source_health = "STALE" if fresh == "STALE" else "DEGRADED"
        warnings.append(
            "Watcher evidence is stale and retained as historical context only"
            if has_finding
            else "Exhaustive coverage is not fresh enough to establish a clear result"
        )

    return {
        "observation": observation,
        "freshness": fresh,
        "age": age,
        "alarm": _alarm(item, observation, fresh),
        "metrics": metrics,
        "provenance": provenance,
        "warnings": warnings,
        "observation_at": _iso_time(observed_at),
        "source_health": source_health,
    }


def _research_watch(item: Monitor, state: Any) -> dict[str, Any]:
    provenance = ["research-watch-state"]
    if not research_watch_state_valid(state):
        result = _unknown(NOT_CONTINUOUSLY_SOURCED)
        result.update(
            provenance=provenance,
            warnings=["Research watch registry state is unavailable or invalid"],
            source_health="INVALID",
        )
        return result
    complete = sum(entry["status"] == "COMPLETE" for entry in state["entries"])
    incomplete = len(state["entries"]) - complete
    return {
        "observation": "AVAILABLE",
        "freshness": NOT_CONTINUOUSLY_SOURCED,
        "age": None,
        "alarm": "NONE",
        "metrics": _metrics(
            (("entries", len(state["entries"])), ("complete", complete), ("incomplete", incomplete))
        ),
        "provenance": provenance,
        "warnings": ["Missing source artifacts remain incomplete"] if incomplete else [],
        "observation_at": _iso_time(state["generatedAt"]),
        "source_health": "OK" if incomplete == 0 else "INCOMPLETE",
    }


def _adapter(item: Monitor, state: dict[str, Any], now: float) -> dict[str, Any]:
    if item.source == "NO_SOURCE":
        unavailable = NOT_CONTINUOUSLY_SOURCED if item.mode == "EVENT" else NA
        result = _unknown(unavailable)
        result["source_health"] = unavailable
        return result
    if item.source != "STATE":
        result = _unknown()
        result.update(source_health="UNSUPPORTED", warnings=["No adapter is registered for this source"])
        return result

    record = _state_for(state, item.id)
    if not record:
        result = _unknown()
        result["source_health"] = "OK"
        result["provenance"] = [item.id]
        return result
    result = record.get("lastResult") if isinstance(record.get("lastResult"), dict) else {}
    observed_at = _observation_time(item, record, result)
    aging_after, stale_after = item.freshness_limits()
    fresh, age = freshness(observed_at, now, aging_after, stale_after)

    if item.id == "aave-v3-hf-watch":
        observation, metrics = _classify_aave_v3(result)
    elif item.id == "hyperlend":
        observation, metrics = _classify_hyperlend(record)
    elif item.id == "kamino-liquidation-window":
        observation, metrics = _classify_kamino(result)
    elif item.id == "morpho-liq":
        observation, metrics = _classify_morpho(result)
    elif item.id == "fraxlend-pair-watch":
        observation, metrics = _classify_fraxlend(result)
    else:
        observation, metrics = "UNKNOWN", []

    warnings: list[str] = []
    if observation == "CLEAR" and fresh not in CURRENT_FRESHNESS:
        observation = "UNKNOWN"
        warnings.append(
            "Clear result is not fresh enough to support a current negative claim"
        )

    return {
        "observation": observation,
        "freshness": fresh,
        "age": age,
        "alarm": _alarm(item, observation, fresh),
        "metrics": metrics,
        "provenance": [item.id],
        "warnings": warnings,
        "observation_at": _iso_time(observed_at),
        "source_health": "ERROR" if observation == "ERROR" else "OK",
    }


def _decimal_string(value: Any) -> str | None:
    return value if isinstance(value, str) and DECIMAL_INTEGER.fullmatch(value) else None


def _chain_valid(chain: Any) -> bool:
    if not isinstance(chain, dict):
        return False
    chain_id = chain.get("chainId")
    return chain_id is None or str(chain_id) == "42161"


def _ostium(item: Monitor, now: float, deployment: Any, settlement: Any) -> dict[str, Any]:
    provenance = ["ostium-deployment", "ostium-settlement"]
    if not isinstance(deployment, dict) or not isinstance(settlement, dict):
        result = _unknown()
        result.update(
            provenance=provenance,
            warnings=["required artifact unavailable"],
        )
        return result

    errors: list[str] = []
    cautions: list[str] = []
    if deployment.get("schema") != "ostium.step3.pinned-deployment-evidence":
        errors.append("deployment schema invalid")
    if settlement.get("schema") != "ostium.step3b.authenticated-omitted-mark-evidence":
        errors.append("settlement schema invalid")

    chain_a = deployment.get("chain")
    chain_b = settlement.get("chain")
    if not _chain_valid(chain_a) or not _chain_valid(chain_b):
        errors.append("chain identity invalid")
    pin_a = chain_a.get("pin", {}) if isinstance(chain_a, dict) else {}
    pin_b = chain_b.get("pin", {}) if isinstance(chain_b, dict) else {}
    pin_times = (timestamp(pin_a.get("timestamp")), timestamp(pin_b.get("timestamp")))
    matched_pin = bool(
        isinstance(pin_a, dict)
        and isinstance(pin_b, dict)
        and pin_a.get("blockNumber") is not None
        and pin_a.get("blockHash")
        and pin_a.get("blockNumber") == pin_b.get("blockNumber")
        and pin_a.get("blockHash") == pin_b.get("blockHash")
        and pin_times[0] is not None
        and pin_times[0] == pin_times[1]
    )
    if not matched_pin:
        errors.append("matching chain pin invalid")

    if matched_pin:
        aging_after, stale_after = item.freshness_limits()
        oldest_pin = min(value for value in pin_times if value is not None)
        fresh, age = freshness(oldest_pin, now, aging_after, stale_after)
        observation_at = _iso_time(oldest_pin)
    else:
        fresh, age, observation_at = "UNKNOWN", None, None

    coverage = settlement.get("coverage")
    economics = settlement.get("economics")
    pairs = settlement.get("pairs")
    if not isinstance(coverage, dict) or not isinstance(economics, dict) or not isinstance(pairs, list):
        errors.append("bounded evidence structure invalid")
        coverage, economics, pairs = {}, {}, []
    recent = coverage.get("recentWindow") if isinstance(coverage, dict) else None
    recent = recent if isinstance(recent, dict) else {}
    duration = _number(recent.get("approximateDurationDays"))
    from_block = _number(recent.get("fromBlock"))
    to_block = _number(recent.get("toBlock"))
    from_time = timestamp(recent.get("fromTimestamp"))
    to_time = timestamp(recent.get("toTimestamp"))
    duration_matches_range = bool(
        duration is not None
        and from_time is not None
        and to_time is not None
        and abs(duration - ((to_time - from_time) / 86_400)) <= 0.01
    )
    bounded = bool(
        coverage.get("assessmentScope")
        == "DETERMINISTIC_RECENT_WINDOW_SCREEN_NOT_FULL_30_DAY_ASSESSMENT"
        and coverage.get("noEventCoverage") == "OLDER_HISTORY_OPEN_BEFORE_RECENT_WINDOW"
        and duration is not None
        and 0 < duration <= 1
        and from_block is not None
        and to_block is not None
        and from_block <= to_block
        and from_time is not None
        and to_time is not None
        and from_time <= to_time
        and duration_matches_range
        and (not matched_pin or to_time == pin_times[0])
        and (not matched_pin or to_block == _number(pin_a.get("blockNumber")))
        and economics.get("assessmentScope")
        == "RECENT_WINDOW_ONLY_NOT_FULL_30_DAY_OR_COMPLETE_HISTORICAL_ASSESSMENT"
    )
    if not bounded:
        errors.append("bounded coverage invalid")

    proven = 0
    malformed_pair = False
    for pair in pairs:
        if not isinstance(pair, dict):
            malformed_pair = True
            continue
        candidate = pair.get("candidate")
        if not isinstance(candidate, dict):
            malformed_pair = True
            continue
        if candidate.get("status") == "PROVEN_AUTHENTICATED_OMITTED_MARK_CANDIDATE_IN_RECENT_WINDOW":
            proven += 1
    if malformed_pair:
        errors.append("candidate rows invalid")

    aggregate_delta = _decimal_string(economics.get("provenCandidateAggregateDelta"))
    withdrawal_difference = _decimal_string(economics.get("withdrawalPriceDifference"))
    if economics.get("deployedProfitClaim") != "NONE":
        errors.append("deployed profit claim inconsistent")
    if aggregate_delta is None or withdrawal_difference is None:
        errors.append("candidate aggregates invalid")

    cautions.append("older history remains open")
    vault = deployment.get("vault")
    vault_settlement = vault.get("settlement") if isinstance(vault, dict) else None
    if isinstance(vault_settlement, dict) and vault_settlement.get("eligible") is True:
        cautions.append("settlement eligibility requires separate current review")
    route_gate = deployment.get("routeGate")
    if isinstance(route_gate, dict) and route_gate.get("runtimeCompatible") is True:
        cautions.append("runtime compatibility does not establish executability")

    pending_rows = settlement.get("settlements")
    pending_rows = pending_rows.get("inspected") if isinstance(pending_rows, dict) else []
    pending_count = sum(
        isinstance(row, dict) and row.get("status") == "PENDING_GLOBAL"
        for row in pending_rows
    ) if isinstance(pending_rows, list) else 0

    metrics = _metrics(
        (
            ("matching pin", "yes" if matched_pin else "no"),
            ("bounded coverage days", duration),
            ("proven bounded candidates", proven),
            ("candidate aggregate delta", aggregate_delta),
            ("withdrawal price difference", withdrawal_difference),
            (
                "deployed profit claim",
                "NONE" if economics.get("deployedProfitClaim") == "NONE" else "UNKNOWN",
            ),
            ("pending settlements", pending_count),
            ("older history", "OPEN"),
        )
    )
    return {
        "observation": "UNKNOWN" if errors else "WATCH",
        "freshness": fresh,
        "age": age,
        "alarm": "NONE",
        "metrics": [] if errors else metrics,
        "provenance": provenance,
        "warnings": errors + cautions,
        "observation_at": observation_at,
        "source_health": "ERROR" if errors else "OK",
    }


def _cached_override(record: dict[str, Any], health: JsonRead) -> dict[str, Any]:
    """Prevent cached data from presenting any current observation or alarm."""

    prior = record.get("observation", "UNKNOWN")
    prior_alarm = record.get("alarm")
    record["cached_observation"] = prior
    record["observation"] = "UNKNOWN"
    record["freshness"] = "UNKNOWN"
    record["age"] = None
    record["alarm"] = "HISTORICAL" if prior_alarm in {"CURRENT", "HISTORICAL"} else "NONE"
    record["source_health"] = "ERROR" if health.source else "UNKNOWN"
    record["warnings"] = list(record.get("warnings", [])) + [
        "current source read failed; cached evidence is historical only"
    ]
    return record


def _monitor_alias(row: dict[str, Any]) -> str | None:
    for key in ("monitorId", "monitor", "condition"):
        value = row.get(key)
        if isinstance(value, str):
            alias = EVENT_ALIASES.get(value.strip().lower())
            if alias in BY_ID:
                return alias
    return None


def _dedupe_entities(row: dict[str, Any]) -> tuple[tuple[str, str], ...]:
    values = []
    for key in ENTITY_DEDUPE_FIELDS:
        value = safe_value(row.get(key))
        if value is not None:
            values.append((key, str(value)[:160]))
    return tuple(values)


def _event_alarm(
    item: Monitor | None,
    monitor_record: dict[str, Any] | None,
    level: str,
    event_freshness: str,
) -> str:
    if level == "INFO":
        return "NONE"
    recent = event_freshness in CURRENT_FRESHNESS
    if item is None:
        return "HISTORICAL"
    if item.mode == "CONTINUOUS":
        if recent and monitor_record and monitor_record.get("alarm") == "CURRENT":
            return "CURRENT"
        return "HISTORICAL"
    return "RECENT_EVENT" if recent else "HISTORICAL"


def _research_views(state: Any, now: float) -> tuple[dict[str, list[dict[str, Any]]], list[dict[str, Any]]]:
    groups = {key: [] for key in ("active", "change_triggers", "scheduled", "hold", "suppressed", "incomplete")}
    due: list[dict[str, Any]] = []
    if not research_watch_state_valid(state):
        return groups, due
    group_for = {
        "ACTIVE_WATCH": "active",
        "CHANGE_TRIGGER": "change_triggers",
        "SCHEDULED": "scheduled",
        "HOLD": "hold",
        "SUPPRESSED": "suppressed",
    }
    for entry in state["entries"]:
        group = "incomplete" if entry["effectiveDisposition"] == "INCOMPLETE" else group_for[entry["disposition"]]
        view = {
            "id": entry["id"],
            "protocol": entry["protocol"],
            "disposition": entry["disposition"],
            "status": entry["status"],
            "effective_disposition": entry["effectiveDisposition"],
            "trigger": entry["trigger"],
            "reason": entry["reason"],
            "review_at": _iso_time(entry.get("reviewAt")),
            "route_positive": entry["routePositive"],
            "executable_now": entry["executableNow"],
            "signed_action_justified": False,
            "source_count": len(entry["sources"]),
        }
        groups[group].append(view)
        review_epoch = timestamp(entry.get("reviewAt"))
        if (
            entry["disposition"] == "SCHEDULED"
            and entry["status"] == "COMPLETE"
            and review_epoch is not None
            and now >= review_epoch
        ):
            due.append(
                {
                    "condition": entry["id"],
                    "monitor_id": "research-watch-registry",
                    "severity": "INFO",
                    "message": "Scheduled research watch is due for read-only review",
                    "freshness": NOT_CONTINUOUSLY_SOURCED,
                    "alarm": "NONE",
                    "event_at": _iso_time(review_epoch),
                    "due_for_review": True,
                }
            )
    return groups, due


def _alerts(
    reader: Any,
    now: float,
    records: list[dict[str, Any]],
    due_reviews: list[dict[str, Any]] | None = None,
) -> tuple[list[dict[str, Any]], int]:
    parsed = reader.jsonl()
    by_id = {record["id"]: record for record in records}
    normalized: list[dict[str, Any]] = []
    seen: set[tuple[Any, ...]] = set()

    for row in parsed["events"]:
        if not isinstance(row, dict):
            continue
        level = severity(row.get("severity"))
        if level is None:
            continue
        monitor_id = _monitor_alias(row)
        item = BY_ID.get(monitor_id) if monitor_id else None
        wrapper_value = row.get("timestamp", row.get("at"))
        source_value = row.get("sourceGeneratedAt")
        event_value = source_value if source_value is not None else wrapper_value
        source_health = str(row.get("sourceHealth", "OK")).upper()
        if item is None:
            fresh, _ = freshness(event_value, now)
        else:
            aging_after, stale_after = item.freshness_limits()
            fresh, _ = freshness(event_value, now, aging_after, stale_after)
        health_only = source_health in {"STALE", "INVALID"}
        if source_value is not None and timestamp(source_value) is None:
            source_health = "INVALID"
            health_only = True
        if health_only:
            fresh = "STALE" if source_health == "STALE" else "UNKNOWN"
        event_epoch = timestamp(event_value)
        condition = monitor_id or "monitor-event"
        alarm = "HISTORICAL" if health_only and level != "INFO" else _event_alarm(
            item, by_id.get(monitor_id), level, fresh
        )
        dedupe_key = (
            condition,
            level,
            event_epoch,
            alarm,
            _dedupe_entities(row),
        )
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)
        normalized.append(
            {
                "condition": condition,
                "monitor_id": monitor_id,
                "severity": level,
                "message": "Source health event" if health_only else "Recorded monitor event",
                "freshness": fresh,
                "alarm": alarm,
                "event_at": _iso_time(event_value),
                "health_only": health_only,
                "_event_epoch": event_epoch if event_epoch is not None else float("-inf"),
            }
        )

    for record in records:
        unresolved = record.get("unresolved_drift")
        if isinstance(unresolved, dict) and record.get("observation") in {"ERROR", "UNKNOWN", "WATCH"}:
            event_epoch = timestamp(unresolved.get("at"))
            normalized.append(
                {
                    "condition": record["id"],
                    "monitor_id": record["id"],
                    "severity": "WARN",
                    "message": "Prior configuration drift remains unresolved",
                    "freshness": "HISTORICAL",
                    "alarm": "HISTORICAL",
                    "event_at": unresolved.get("at"),
                    "categories": list(unresolved.get("categories", [])),
                    "_event_epoch": event_epoch if event_epoch is not None else float("-inf"),
                }
            )
        if record["alarm"] not in {"CURRENT", "HISTORICAL"}:
            continue
        if any(
            event["monitor_id"] == record["id"]
            and event["alarm"] == record["alarm"]
            for event in normalized
        ):
            continue
        event_epoch = timestamp(record.get("observation_at"))
        normalized.append(
            {
                "condition": record["id"],
                "monitor_id": record["id"],
                "severity": "CRITICAL" if record["id"] == "hyperlend" else "HIGH",
                "message": "Current source-backed monitor trigger"
                if record["alarm"] == "CURRENT"
                else "Historical monitor trigger evidence",
                "freshness": record["freshness"],
                "alarm": record["alarm"],
                "event_at": record.get("observation_at"),
                "_event_epoch": event_epoch if event_epoch is not None else float("-inf"),
            }
        )

    normalized.extend(due_reviews or [])
    normalized.sort(
        key=lambda event: (
            event["alarm"] != "CURRENT",
            -event.get("_event_epoch", timestamp(event.get("event_at")) or float("-inf")),
        )
    )
    for event in normalized:
        event.pop("_event_epoch", None)
    return normalized[:100], int(parsed["malformed"])


def _r17_fixed_claims(value: Any) -> bool:
    return bool(
        isinstance(value, dict)
        and value.get("status") == "REJECT"
        and value.get("highestStatus") == "REJECT"
        and value.get("profitabilityClaim") is False
        and value.get("routePositive") == "unknown"
        and value.get("signedActionJustified") is False
        and value.get("shadowOnly") is True
    )


def _r17_nullable_decimal(value: Any) -> bool:
    return value is None or (
        isinstance(value, str)
        and len(value) <= 64
        and POLYMARKET_R17_DECIMAL.fullmatch(value) is not None
    )


def _r17_ranking_row_valid(row: Any) -> bool:
    if (
        not isinstance(row, dict)
        or set(row) != {
            "candidateId", "marketId", "source", "analyticalSide", "capitalRequiredUsd",
            "maximumLossUsd", "payoutIfCorrectUsd", "profitIfCorrectUsd", "probability",
            "conservativeExpectedNetUsd", "returnOnCapitalBps", "capacity", "costs",
            "confidence", "settlement", "freshness", "concentration", "killGates",
            "analyticalRankingEligible",
            "positiveNumericalEstimateDoesNotEstablishProfitFillOrAction", "reasonCode",
            "status", "highestStatus", "profitabilityClaim", "routePositive",
            "signedActionJustified", "shadowOnly",
        }
        or not _r17_fixed_claims(row)
    ):
        return False
    probability = row.get("probability")
    capacity = row.get("capacity")
    costs = row.get("costs")
    gates = row.get("killGates")
    economic = (
        "capitalRequiredUsd", "maximumLossUsd", "payoutIfCorrectUsd",
        "profitIfCorrectUsd", "conservativeExpectedNetUsd", "returnOnCapitalBps",
        "confidence", "concentration",
    )
    if (
        not isinstance(row.get("candidateId"), str)
        or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", row["candidateId"])
        or row.get("marketId") is not None and not isinstance(row.get("marketId"), str)
        or row.get("source") not in {None, "R15", "R16"}
        or row.get("analyticalSide") not in {None, *POLYMARKET_R17_SIDES}
        or not all(_r17_nullable_decimal(row.get(field)) for field in economic)
        or not isinstance(probability, dict)
        or set(probability) != {"lower", "central", "upper"}
        or not all(_r17_nullable_decimal(value) for value in probability.values())
        or not isinstance(capacity, dict)
        or set(capacity) != {"shares", "usd"}
        or not all(_r17_nullable_decimal(value) for value in capacity.values())
        or not isinstance(costs, dict)
        or set(costs) != {"feeUsd", "impactUsd", "modelUsd", "basisUsd", "latencyUsd", "carryUsd", "oneLegUsd", "unwindUsd"}
        or not all(_r17_nullable_decimal(value) for value in costs.values())
        or not isinstance(gates, dict)
        or not gates
        or not all(isinstance(name, str) and value in POLYMARKET_R17_GATE_VALUES for name, value in gates.items())
        or not isinstance(row.get("analyticalRankingEligible"), bool)
        or row.get("positiveNumericalEstimateDoesNotEstablishProfitFillOrAction") is not True
        or not isinstance(row.get("reasonCode"), str)
        or POLYMARKET_R17_REASON.fullmatch(row["reasonCode"]) is None
        or row.get("settlement") not in {None, "COMPLETE", "INCOMPLETE"}
        or row.get("freshness") not in {None, "CURRENT", "STALE"}
    ):
        return False
    if row["analyticalRankingEligible"]:
        return bool(
            row.get("conservativeExpectedNetUsd") is not None
            and not row["conservativeExpectedNetUsd"].startswith("-")
            and row["conservativeExpectedNetUsd"] != "0.000000"
            and all(value == "PASS" for value in gates.values())
        )
    return True


def polymarket_r17_valid(state: Any) -> bool:
    """Validate the fixed REJECT-only R17 dashboard artifact."""

    if not isinstance(state, dict) or set(state) != {
        "schemaVersion", "schema", "mode", "generatedAtMs", "invocationKey", "schedule",
        "intervalKeys", "sourceRuns", "scanCounts", "rejectionFunnel", "ranking",
        "killGates", "reasonCode", "journalHeadHash",
        "positiveNumericalEstimateDoesNotEstablishProfitFillOrAction", "actualFills",
        "realizedPnlUsd", "status", "highestStatus", "profitabilityClaim",
        "routePositive", "signedActionJustified", "shadowOnly", "artifactHash",
    }:
        return False
    schedule = state.get("schedule")
    ranking = state.get("ranking")
    source_runs = state.get("sourceRuns")
    scan_counts = state.get("scanCounts")
    funnel = state.get("rejectionFunnel")
    if (
        state.get("schemaVersion") != 1
        or state.get("schema") != POLYMARKET_R17_SCHEMA
        or state.get("mode") != "public"
        or not _r17_fixed_claims(state)
        or not isinstance(state.get("generatedAtMs"), int)
        or isinstance(state.get("generatedAtMs"), bool)
        or state["generatedAtMs"] < 0
        or not isinstance(schedule, dict)
        or set(schedule) != {"scheduleKey", "intervalMs", "intervals"}
        or not isinstance(schedule.get("scheduleKey"), str)
        or re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", schedule["scheduleKey"]) is None
        or not isinstance(schedule.get("intervalMs"), int)
        or isinstance(schedule.get("intervalMs"), bool)
        or not 1_000 <= schedule["intervalMs"] <= 604_800_000
        or not isinstance(schedule.get("intervals"), int)
        or isinstance(schedule.get("intervals"), bool)
        or not 1 <= schedule["intervals"] <= 12
        or not isinstance(state.get("intervalKeys"), list)
        or len(state["intervalKeys"]) != schedule["intervals"]
        or not all(isinstance(value, str) and POLYMARKET_R17_HASH.fullmatch(value) for value in state["intervalKeys"])
        or not isinstance(source_runs, list)
        or len(source_runs) > 24
        or not isinstance(ranking, list)
        or len(ranking) > 4800
        or not all(_r17_ranking_row_valid(row) for row in ranking)
        or not isinstance(state.get("killGates"), list)
        or not all(isinstance(gate, str) and re.fullmatch(r"[A-Z][A-Z0-9_]{0,63}", gate) for gate in state["killGates"])
        or not isinstance(state.get("reasonCode"), str)
        or POLYMARKET_R17_REASON.fullmatch(state["reasonCode"]) is None
        or state.get("positiveNumericalEstimateDoesNotEstablishProfitFillOrAction") is not True
        or state.get("actualFills") is not None
        or state.get("realizedPnlUsd") is not None
        or not isinstance(scan_counts, dict)
        or set(scan_counts) != {"intervals", "sourceScans", "r15", "r16"}
        or not all(_bounded_count(value) for value in scan_counts.values())
        or not isinstance(funnel, dict)
        or set(funnel) != {"sourceScans", "rowsSeen", "exactCandidates", "rankingInputs", "completeEconomics", "positiveConservativeNet", "rankedNumericalRejects", "rejected"}
        or not all(_bounded_count(value) for value in funnel.values())
        or not all(isinstance(state.get(field), str) and POLYMARKET_R17_HASH.fullmatch(state[field]) for field in ("invocationKey", "journalHeadHash", "artifactHash"))
    ):
        return False
    for run in source_runs:
        if (
            not isinstance(run, dict)
            or set(run) != {"intervalKey", "source", "scanStatus", "sourceRunHash", "counts", "reasonCode"}
            or not isinstance(run.get("intervalKey"), str)
            or POLYMARKET_R17_HASH.fullmatch(run["intervalKey"]) is None
            or run.get("source") not in {"R15", "R16"}
            or run.get("scanStatus") not in {"COMPLETE_REJECT", "ERROR_REJECT"}
            or not isinstance(run.get("reasonCode"), str)
            or not re.fullmatch(r"r(?:15|16)-[a-z0-9-]{1,75}", run["reasonCode"])
            or run.get("sourceRunHash") is not None and POLYMARKET_R17_HASH.fullmatch(str(run["sourceRunHash"])) is None
            or not isinstance(run.get("counts"), dict)
            or set(run["counts"]) != {"rowsSeen", "exactCandidates", "selectedCandidates", "sourceCandidates"}
            or not all(_bounded_count(value) for value in run["counts"].values())
        ):
            return False
    core = dict(state)
    artifact_hash = core.pop("artifactHash")
    encoded = json.dumps(core, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest() == artifact_hash


def _polymarket_r17(state: Any, now: float, available: bool) -> dict[str, Any]:
    null_economics = {
        "capital_required_usd": None, "maximum_loss_usd": None,
        "payout_if_correct_usd": None, "profit_if_correct_usd": None,
        "conservative_expected_net_usd": None, "return_on_capital_bps": None,
        "capacity_shares": None, "capacity_usd": None,
    }
    if not available or not polymarket_r17_valid(state):
        return {
            "available": False, "status": "REJECT", "highest_status": "REJECT",
            "reason": "r17-artifact-unavailable", "gates": ["ARTIFACT_AVAILABLE"],
            "economics": null_economics, "ranking": [], "source_runs": [],
            "profitability_claim": False, "route_positive": "unknown",
            "signed_action_justified": False, "shadow_only": True,
            "actual_fills": None, "realized_pnl_usd": None,
        }
    fresh, age = freshness(state["generatedAtMs"] / 1000, now)
    rows = []
    for row in state["ranking"][:200]:
        rows.append({
            "candidate_id": row["candidateId"], "market_id": row["marketId"],
            "source": row["source"], "analytical_side": row["analyticalSide"],
            "status": "REJECT", "reason": row["reasonCode"],
            "gates": sorted(row["killGates"].items()),
            "economics": {
                "capital_required_usd": row["capitalRequiredUsd"],
                "maximum_loss_usd": row["maximumLossUsd"],
                "payout_if_correct_usd": row["payoutIfCorrectUsd"],
                "profit_if_correct_usd": row["profitIfCorrectUsd"],
                "conservative_expected_net_usd": row["conservativeExpectedNetUsd"],
                "return_on_capital_bps": row["returnOnCapitalBps"],
                "capacity_shares": row["capacity"]["shares"],
                "capacity_usd": row["capacity"]["usd"],
            },
            "probability": row["probability"], "costs": row["costs"],
            "confidence": row["confidence"], "settlement": row["settlement"],
            "freshness": row["freshness"], "concentration": row["concentration"],
            "analytical_ranking_eligible": row["analyticalRankingEligible"],
            "positive_estimate_is_not_profit_fill_or_action": True,
        })
    return {
        "available": True, "status": "REJECT", "highest_status": "REJECT",
        "generated_at": _iso_time(state["generatedAtMs"] / 1000), "freshness": fresh,
        "age": age, "reason": state["reasonCode"], "gates": list(state["killGates"]),
        "economics": rows[0]["economics"] if rows else null_economics,
        "ranking": rows, "source_runs": list(state["sourceRuns"]),
        "scan_counts": dict(state["scanCounts"]),
        "rejection_funnel": dict(state["rejectionFunnel"]),
        "profitability_claim": False, "route_positive": "unknown",
        "signed_action_justified": False, "shadow_only": True,
        "actual_fills": None, "realized_pnl_usd": None,
    }


def _polymarket_r17_record(item: Monitor, state: Any, now: float, available: bool) -> dict[str, Any]:
    section = _polymarket_r17(state, now, available)
    generated = state.get("generatedAtMs") / 1000 if available and isinstance(state, dict) else None
    return {
        "observation": "REJECT", "freshness": section.get("freshness", "UNKNOWN"),
        "age": section.get("age"), "alarm": "NONE", "metrics": _metrics((
            ("source scans", section.get("scan_counts", {}).get("sourceScans")),
            ("ranking rows", len(section.get("ranking", []))),
        )), "provenance": [], "warnings": [] if available else ["R17 artifact unavailable"],
        "observation_at": _iso_time(generated), "source_health": "OK" if available else "UNKNOWN",
    }


def _r19_decimal(value: Any) -> bool:
    return value is None or isinstance(value, str) and POLYMARKET_R19_DECIMAL.fullmatch(value) is not None


def _r19_claims(value: Any) -> bool:
    return (
        isinstance(value, dict)
        and value.get("status") == "REJECT"
        and value.get("profitabilityClaim") is False
        and value.get("routePositive") == "unknown"
        and value.get("signedActionJustified") is False
        and value.get("shadowOnly") is True
        and value.get("counterfactual") is True
        and value.get("executionAtomic") is False
        and value.get("fillEvidence") == "none"
    )


def _r19_bundle(value: Any) -> bool:
    if not _r19_claims(value) or value.get("bundleType") not in POLYMARKET_R19_BUNDLES:
        return False
    reason = value.get("reasonCode")
    if not isinstance(reason, str) or POLYMARKET_R19_REASON.fullmatch(reason) is None:
        return False
    for field in ("bundleId", "marketId", "conditionId"):
        item = value.get(field)
        if item is not None and (not isinstance(item, str) or POLYMARKET_R19_SAFE_ID.fullmatch(item) is None and POLYMARKET_R19_HASH.fullmatch(item) is None):
            return False
    for field in ("bundleHash", "diagnosticHash", "familyHash"):
        item = value.get(field)
        if item is not None and (not isinstance(item, str) or POLYMARKET_R19_HASH.fullmatch(item) is None):
            return False
    for field in ("marketIds", "conditionIds"):
        items = value.get(field)
        if items is not None and (not isinstance(items, list) or len(items) > 2 or any(not isinstance(item, str) or POLYMARKET_R19_SAFE_ID.fullmatch(item) is None for item in items)):
            return False
    gates = value.get("gates", {})
    if not isinstance(gates, dict) or not all(isinstance(name, str) and re.fullmatch(r"[A-Z0-9_]{1,80}", name) and result in POLYMARKET_R19_GATES for name, result in gates.items()):
        return False
    economics = value.get("economics")
    if economics is not None:
        if not isinstance(economics, dict) or not all(_r19_decimal(economics.get(field)) for field in ("quantity", "minimumPayoutUsd", "allInCostUsd", "conservativeNetUsd", "returnOnCapitalBps", "worstLossUsd", "capacityUnits")):
            return False
        legs = economics.get("legs")
        reserves = economics.get("reserves")
        if reserves is not None and (not isinstance(reserves, dict) or not all(isinstance(name, str) and _r19_decimal(amount) for name, amount in reserves.items())):
            return False
        if legs is not None:
            if not isinstance(legs, list) or len(legs) > 2:
                return False
            for leg in legs:
                if not isinstance(leg, dict) or leg.get("analyticalLabel") not in {"BUY YES", "BUY NO"} or any(key in leg for key in ("order", "payload", "calldata", "signature", "transaction")):
                    return False
                if not isinstance(leg.get("tokenId"), str) or POLYMARKET_R19_SAFE_ID.fullmatch(leg["tokenId"]) is None:
                    return False
                if not _r19_decimal(leg.get("grossUsd")) or not _r19_decimal(leg.get("feeUsd")):
                    return False
                levels = leg.get("levels")
                if not isinstance(levels, list) or len(levels) > 64 or any(not isinstance(level, dict) or not all(_r19_decimal(level.get(field)) for field in ("price", "size", "feeUsd")) for level in levels):
                    return False
    analytical = value.get("analyticalLegs")
    if analytical is not None and (not isinstance(analytical, list) or len(analytical) > 2 or any(not isinstance(leg, dict) or leg.get("analyticalLabel") not in {"BUY YES", "BUY NO"} or any(key in leg for key in ("order", "payload", "calldata", "signature", "transaction")) for leg in analytical)):
        return False
    if analytical is not None and any(not isinstance(leg.get("marketId"), str) or POLYMARKET_R19_SAFE_ID.fullmatch(leg["marketId"]) is None for leg in analytical):
        return False
    return True


def polymarket_r19_valid(state: Any) -> bool:
    if not _r19_claims(state) or state.get("schema") != POLYMARKET_R19_SCHEMA or state.get("mode") != POLYMARKET_R19_SCHEMA:
        return False
    if state.get("actualFills") is not None or state.get("realizedPnlUsd") is not None:
        return False
    if not isinstance(state.get("asOfMs"), int) or state["asOfMs"] < 0 or not isinstance(state.get("resultHash"), str) or POLYMARKET_R19_HASH.fullmatch(state["resultHash"]) is None:
        return False
    encoded = json.dumps(state, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    if re.search(r"https?://|\b(?:payload|calldata|signature|transaction)\b", encoded, re.IGNORECASE):
        return False
    core = dict(state)
    result_hash = core.pop("resultHash")
    if hashlib.sha256(json.dumps(core, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest() != result_hash:
        return False
    reason = state.get("reasonCode")
    if not isinstance(reason, str) or POLYMARKET_R19_REASON.fullmatch(reason) is None:
        return False
    bundles, rows, ladders = state.get("bundles"), state.get("rows"), state.get("ladders")
    if not isinstance(bundles, list) or not isinstance(rows, list) or not isinstance(ladders, list) or len(bundles) > 20 or len(ladders) > 190 or bundles != rows:
        return False
    if not all(_r19_bundle(item) for item in bundles + ladders):
        return False
    rejections = state.get("rejections")
    if not isinstance(rejections, list) or len(rejections) > 20 or any(not isinstance(item, dict) or not isinstance(item.get("reasonCode"), str) or POLYMARKET_R19_REASON.fullmatch(item["reasonCode"]) is None or item.get("marketId") is not None and (not isinstance(item["marketId"], str) or POLYMARKET_R19_SAFE_ID.fullmatch(item["marketId"]) is None) or item.get("sourceHash") is not None and (not isinstance(item["sourceHash"], str) or POLYMARKET_R19_HASH.fullmatch(item["sourceHash"]) is None) for item in rejections):
        return False
    funnel = state.get("rejectionFunnel")
    return isinstance(funnel, dict) and all(isinstance(key, str) and isinstance(value, int) and value >= 0 for key, value in funnel.items())


def _polymarket_r19(state: Any, available: bool, now: float | None = None) -> dict[str, Any]:
    empty = {"availability": False, "available": False, "status": "REJECT", "reason": "r19-artifact-unavailable", "generated_at": None, "funnel": {}, "ranking": [], "kill_gates": [], "actual_fills": None, "realized_pnl_usd": None, "profitability_claim": False, "route_positive": "unknown", "signed_action_justified": False, "shadow_only": True}
    if not available or not polymarket_r19_valid(state):
        return empty
    fresh, age = freshness(state["asOfMs"] / 1000, now if now is not None else state["asOfMs"] / 1000, 1_800, 5_400)
    ranking, killed = [], set()
    for bundle in [*state["bundles"], *state["ladders"]]:
        economics = bundle.get("economics") or {}
        gates = bundle.get("gates") or {}
        killed.update(name for name, result in gates.items() if result != "PASS")
        source_legs = economics.get("legs") or bundle.get("analyticalLegs") or []
        legs = [{"analytical_label": leg["analyticalLabel"]} for leg in source_legs]
        ranking.append({"bundle_id": bundle.get("bundleId") or bundle.get("diagnosticHash"), "bundle_type": bundle["bundleType"], "status": "REJECT", "disposition": "REJECT", "reason": bundle["reasonCode"], "economics": {"verified_payout_floor": economics.get("minimumPayoutUsd"), "all_in_cost": economics.get("allInCostUsd"), "conservative_net": economics.get("conservativeNetUsd"), "return_on_capital_bps": economics.get("returnOnCapitalBps")}, "legs": legs, "counterfactual": True, "execution_atomic": False, "fill_evidence": "none"})
    generated_at = _iso_time(state["asOfMs"] / 1000)
    return {"availability": True, "available": True, "status": "REJECT", "reason": state["reasonCode"], "generated_at": generated_at, "freshness": fresh, "age": age, "last_scan": {"generated_at": generated_at, "freshness": fresh, "health": "REJECT", "bundle_count": len(ranking)}, "bundle_count": len(ranking), "funnel": dict(state["rejectionFunnel"]), "rejection_funnel": dict(state["rejectionFunnel"]), "ranking": ranking, "kill_gates": sorted(killed), "actual_fills": None, "realized_pnl_usd": None, "profitability_claim": False, "route_positive": "unknown", "signed_action_justified": False, "shadow_only": True}


def _polymarket_r19_record(item: Monitor, state: Any, available: bool, now: float) -> dict[str, Any]:
    section = _polymarket_r19(state, available, now)
    return {"observation": "REJECT" if available else "UNKNOWN", "freshness": section.get("freshness", "UNKNOWN"), "age": section.get("age"), "alarm": "NONE", "metrics": _metrics((("bundles", len(section["ranking"])),)), "provenance": [], "warnings": [] if available else ["R19 artifact unavailable"], "observation_at": section["generated_at"], "source_health": "OK" if available else "UNKNOWN"}


def _r20_claims(value: Any) -> bool:
    return isinstance(value, dict) and value.get("status") == "REJECT" and value.get("profitabilityClaim") is False and value.get("routePositive") == "unknown" and value.get("signedActionJustified") is False and value.get("shadowOnly") is True and value.get("counterfactual") is True and value.get("executionAtomic") is False and value.get("fillEvidence") == "none"


def _r20_decimal(value: Any) -> bool:
    return value is None or isinstance(value, str) and POLYMARKET_R20_DECIMAL.fullmatch(value) is not None


def _r20_economics(value: Any) -> bool:
    if value is None:
        return True
    if not isinstance(value, dict):
        return False
    scalar_fields = ("quantity", "mergeCollateralPusd", "mergeCollateralUsd", "pUsdUsd", "acquisitionGrossPusd", "acquisitionGrossUsd", "feesPusd", "feesUsd", "spreadUsd", "impactUsd", "latencyUsd", "oneLegUsd", "cancellationUsd", "mergeGasNative", "mergeGasUsd", "approvalGasNative", "approvalGasUsd", "capitalLockUsd", "unwindUsd", "allInCostUsd", "conservativeNetUsd", "returnOnCapitalBps", "worstLossUsd")
    if not set(scalar_fields).issubset(value) or not all(_r20_decimal(value.get(field)) for field in scalar_fields):
        return False
    legs = value.get("legs")
    if legs is not None:
        if not isinstance(legs, list) or len(legs) > 2:
            return False
        for leg in legs:
            if not isinstance(leg, dict) or leg.get("analyticalLabel") not in {"BUY YES", "BUY NO"} or not isinstance(leg.get("tokenId"), str) or POLYMARKET_R20_SAFE_ID.fullmatch(leg["tokenId"]) is None:
                return False
            if not _r20_decimal(leg.get("grossPusd")) or not _r20_decimal(leg.get("feePusd")):
                return False
            levels = leg.get("levels")
            if not isinstance(levels, list) or len(levels) > 64 or any(not isinstance(level, dict) or not all(_r20_decimal(level.get(field)) for field in ("price", "quantity", "grossPusd", "feePusd")) for level in levels):
                return False
    return True


def _r20_bundle(value: Any) -> bool:
    if not _r20_claims(value) or value.get("bundleType") != "SAME_CONDITION_MERGE_PARITY" or value.get("mergeabilityVerified") not in {True, False}:
        return False
    if not isinstance(value.get("reasonCode"), str) or POLYMARKET_R20_REASON.fullmatch(value["reasonCode"]) is None:
        return False
    for field in ("bundleId", "marketId", "conditionId"):
        item = value.get(field)
        if item is not None and (not isinstance(item, str) or POLYMARKET_R20_SAFE_ID.fullmatch(item) is None and POLYMARKET_R20_HASH.fullmatch(item) is None):
            return False
    if value.get("bundleHash") is not None and (not isinstance(value["bundleHash"], str) or POLYMARKET_R20_HASH.fullmatch(value["bundleHash"]) is None):
        return False
    for field in ("positionDerived", "authoritativeTokenBinding", "mergeTargetVerified", "callerOwnsPositions", "mergeApprovalRequired"):
        if field in value and value[field] not in {True, False}:
            return False
    if value["mergeabilityVerified"] is False and value.get("economics") is not None:
        return False
    return _r20_economics(value.get("economics"))


def polymarket_r20_valid(state: Any) -> bool:
    if not _r20_claims(state) or state.get("schema") != POLYMARKET_R20_SCHEMA or state.get("mode") != POLYMARKET_R20_SCHEMA or state.get("actualFills") is not None or state.get("realizedPnlUsd") is not None:
        return False
    if not isinstance(state.get("asOfMs"), int) or state["asOfMs"] < 0 or not isinstance(state.get("reasonCode"), str) or POLYMARKET_R20_REASON.fullmatch(state["reasonCode"]) is None or not isinstance(state.get("resultHash"), str) or POLYMARKET_R20_HASH.fullmatch(state["resultHash"]) is None:
        return False
    encoded = json.dumps(state, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    if re.search(r"https?://|\b(?:payload|calldata|order|signature|transaction|private.?key|mnemonic|signer|wallet)\b", encoded, re.IGNORECASE):
        return False
    core = dict(state)
    result_hash = core.pop("resultHash")
    if hashlib.sha256(json.dumps(core, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest() != result_hash:
        return False
    rows, bundles = state.get("rows"), state.get("bundles")
    if not isinstance(rows, list) or not isinstance(bundles, list) or rows != bundles or len(rows) > 100 or not all(_r20_bundle(row) for row in rows):
        return False
    funnel = state.get("rejectionFunnel")
    return isinstance(funnel, dict) and all(isinstance(key, str) and isinstance(value, int) and value >= 0 for key, value in funnel.items())


def _polymarket_r20(state: Any, available: bool, now: float) -> dict[str, Any]:
    empty = {"availability": False, "available": False, "status": "REJECT", "reason": "r20-artifact-unavailable", "generated_at": None, "funnel": {}, "ranking": [], "merge_identity": {"position_derived": None, "authoritative_token_binding": None}, "runtime_gates": {"merge_target_verified": None, "caller_owns_positions": None}, "mergeability_state": "UNKNOWN", "economics": None, "actual_fills": None, "realized_pnl_usd": None, "profitability_claim": False, "route_positive": "unknown", "signed_action_justified": False, "shadow_only": True}
    if not available or not polymarket_r20_valid(state):
        return empty
    fresh, age = freshness(state["asOfMs"] / 1000, now, 1_800, 5_400)
    ranking = []
    for row in state["rows"]:
        economics = row.get("economics")
        ranking.append({"bundle_id": row.get("bundleId"), "market_id": row.get("marketId"), "condition_id": row.get("conditionId"), "bundle_type": row["bundleType"], "status": "REJECT", "reason": row["reasonCode"], "position_derived": row.get("positionDerived"), "authoritative_token_binding": row.get("authoritativeTokenBinding"), "merge_target_verified": row.get("mergeTargetVerified"), "caller_owns_positions": row.get("callerOwnsPositions"), "mergeability_state": "VERIFIED" if row["mergeabilityVerified"] else "UNVERIFIED", "economics": None if economics is None else {"merge_collateral_pusd": economics.get("mergeCollateralPusd"), "merge_collateral_usd": economics.get("mergeCollateralUsd"), "all_in_cost_usd": economics.get("allInCostUsd"), "conservative_net_usd": economics.get("conservativeNetUsd"), "return_on_capital_bps": economics.get("returnOnCapitalBps"), "worst_loss_usd": economics.get("worstLossUsd")}, "counterfactual": True, "execution_atomic": False, "fill_evidence": "none"})
    verified = [row for row in state["rows"] if row["mergeabilityVerified"]]
    generated_at = _iso_time(state["asOfMs"] / 1000)
    return {"availability": True, "available": True, "status": "REJECT", "reason": state["reasonCode"], "generated_at": generated_at, "freshness": fresh, "age": age, "funnel": dict(state["rejectionFunnel"]), "ranking": ranking, "merge_identity": {"position_derived": any(row.get("positionDerived") is True for row in state["rows"]) if state["rows"] else None, "authoritative_token_binding": any(row.get("authoritativeTokenBinding") is True for row in state["rows"]) if state["rows"] else None}, "runtime_gates": {"merge_target_verified": any(row.get("mergeTargetVerified") is True for row in state["rows"]) if state["rows"] else None, "caller_owns_positions": any(row.get("callerOwnsPositions") is True for row in state["rows"]) if state["rows"] else None}, "mergeability_state": "VERIFIED" if verified else "UNVERIFIED" if state["rows"] else "UNKNOWN", "economics": ranking[0]["economics"] if ranking else None, "actual_fills": None, "realized_pnl_usd": None, "profitability_claim": False, "route_positive": "unknown", "signed_action_justified": False, "shadow_only": True}


def _polymarket_r20_record(item: Monitor, state: Any, available: bool, now: float) -> dict[str, Any]:
    section = _polymarket_r20(state, available, now)
    return {"observation": "REJECT" if available else "UNKNOWN", "freshness": section.get("freshness", "UNKNOWN"), "age": section.get("age"), "alarm": "NONE", "metrics": _metrics((("bundles", len(section["ranking"])),)), "provenance": [], "warnings": [] if available else ["R20 artifact unavailable"], "observation_at": section["generated_at"], "source_health": "OK" if available else "UNKNOWN"}


def base_paper_valid(state: Any, study: str) -> bool:
    """Admit only the existing Base quote-only schemas, never execution evidence."""

    try:
        schema = {"R8": "base-paper-cycle/v8", "R9": "base-paper-usds/v9"}[study]
        if not isinstance(state, dict) or state["schema"] != schema or state["chainId"] != 8453 or state["study"] != "ORDINARY_MARKET_QUOTES_ONLY":
            return False
        if state["status"] not in ("OBSERVED_UNPROMOTED", "INCOMPLETE") or not isinstance(state["code"], str) or re.fullmatch(r"[A-Z][A-Z0-9_]{0,95}", state["code"]) is None:
            return False
        generated, completed = timestamp(state["generatedAt"]), timestamp(state["completedAt"])
        if not isinstance(state["generatedAt"], str) or not isinstance(state["completedAt"], str) or generated is None or completed is None or not 0 <= completed - generated <= 360:
            return False
        if re.search(r"(?:https?|wss?)://", json.dumps(state), re.IGNORECASE):
            return False
        gates, economics, safety = state["gates"], state["economics"], state["safety"]
        if gates["profitabilityClaim"] is not False or gates["signedActionJustified"] is not False or gates["executableNow"] != "unknown" or gates["transferSuccess"] != "unknown":
            return False
        if economics["costsComplete"] is not False or economics["allSizesDisproved"] is not False or any(economics[key] is not None for key in ("conservativeNetUsdc", "conservativeNetUsd", "conservativeNetNative", "netBps", "fills", "realizedPnl")):
            return False
        if safety["readOnly" if study == "R8" else "readOnlyRpc"] is not True or any(safety[key] is not False for key in ("endpointMaterialPersisted", "walletAccess", "signing")) or any(type(safety[key]) is not int or safety[key] != 0 for key in ("transactions", "retries")):
            return False
        if state["source"]["sourceRuntimeBound"] != "unknown":
            return False
        expected = {"usdc": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", "psm": "0x1601843c5e9bc251a3272907010afa41fa18347e"}
        expected.update({"pool": "0xaa9780e54843013ff2ee957d103e96f4777a54e7", "susds": "0x5875eee11cf8398102fdad704c9e96607675467a", "weth": "0x4200000000000000000000000000000000000006"} if study == "R8" else {"pool": "0x81057171115672ac7d08bbebb04481e19aa0bfeb", "usds": "0x820c137fa70c8691f0e44dc420a5e53c168921dc"})
        if any(state["addresses"][key] != value for key, value in expected.items()):
            return False
        sizes = [str(n * 1_000_000) for n in (1, 5, 10, 25, 50, 100)]
        if state["inputSizesUsdcRaw"] != sizes:
            return False
        qualification = state["qualification"]
        if any(type(qualification[key]) is not int for key in ("attempted", "qualified", "selectedFamilyCount")) or not 0 <= qualification["selectedFamilyCount"] <= qualification["qualified"] <= qualification["attempted"] <= 8:
            return False
        observation = state["observation"]
        if state["status"] == "INCOMPLETE":
            return observation is None
        if state["phase"] != "TERMINAL" or qualification["selectedFamilyCount"] != 2 or observation["rpcStrength"] != "corroborated-operator-families" or observation["upstreamIndependenceProven"] is not False:
            return False
        pin = observation["pin"]
        if any(not isinstance(pin[key], str) or HEX_32.fullmatch(pin[key]) is None for key in ("hash", "parentHash", "stateRoot")) or any(not isinstance(pin[key], str) or re.fullmatch(r"[1-9][0-9]{0,19}", pin[key]) is None for key in ("number", "timestamp")):
            return False
        if not -60 <= generated - int(pin["timestamp"]) <= 3600:
            return False
        psm = observation["psm"]
        if psm["capacityIsTransferProof"] is not False or not isinstance(psm["balanceAllowanceCapacityRaw"], str) or NONNEGATIVE_DECIMAL.fullmatch(psm["balanceAllowanceCapacityRaw"]) is None:
            return False
        rows = observation["rows"]
        if not isinstance(rows, list) or len(rows) != len(sizes):
            return False
        for row, size in zip(rows, sizes):
            if row["inputUsdcRaw"] != size or not isinstance(row["outputUsdcRaw"], str) or NONNEGATIVE_DECIMAL.fullmatch(row["outputUsdcRaw"]) is None:
                return False
            surplus = int(row["outputUsdcRaw"]) - int(size)
            if row["quotedSurplusUsdcRaw"] != str(surplus) or row["quotedSurplusBps"] != {"numerator": str(surplus * 10000), "denominator": size}:
                return False
            if row["quoteIncludesPoolFeesAndImpact"] is not True or row["conservativeNetUsdc"] is not None or row["executable"] != "unknown":
                return False
            if row["pocketBalanceAllowanceSufficient"] is not (int(row["outputUsdcRaw"]) <= int(psm["balanceAllowanceCapacityRaw"])):
                return False
            if study == "R9" and (row["fullInputExecutionVerified"] is not False or row["quoterGasIsCycleGas"] is not False):
                return False
        positive = any(int(row["quotedSurplusUsdcRaw"]) > 0 and row["pocketBalanceAllowanceSufficient"] for row in rows)
        return state["code"] == ("QUOTED_SURPLUS_REQUIRES_VALIDATION" if positive else "NO_CAPACITY_BACKED_POSITIVE_QUOTE_AT_TESTED_SIZES")
    except (KeyError, TypeError, ValueError, OverflowError):
        return False


def _base_paper(reader: Any, now: float) -> list[dict[str, Any]]:
    """Project fixed artifact fields without making one-shot quotes live signals."""

    def usdc(raw: str) -> str:
        value = int(raw)
        return f"{'-' if value < 0 else ''}{abs(value) // 1_000_000}.{abs(value) % 1_000_000:06d}"

    cards = []
    for study, key, route in (("R8", "base_paper_r8", "USDC -> WETH -> sUSDS -> PSM3 -> USDC"), ("R9", "base_paper_r9", "USDC -> USDS -> PSM3 -> USDC")):
        result = reader.read_json(key, validator=lambda value: base_paper_valid(value, study))
        card = {"study": study, "artifact": ALLOWLIST[key].rsplit("/", 1)[-1], "route": route, "available": result.current, "cached": result.cached,
                "status": "UNAVAILABLE", "freshness": "UNKNOWN", "rows": [], "conservative_net_usdc": None,
                "profitability_claim": False, "executable_now": "unknown", "signed_action_justified": False}
        cards.append(card)
        if not result.current:
            continue
        state = result.value
        fresh, age = freshness(state["generatedAt"], now, 1800, 5400)
        card.update(status=state["status"], freshness=fresh, age=age, generated_at=state["generatedAt"], code=state["code"])
        observation = state["observation"]
        if observation is None:
            continue
        rows = [{"input_usdc": usdc(row["inputUsdcRaw"]), "output_usdc": usdc(row["outputUsdcRaw"]), "quoted_change_usdc": usdc(row["quotedSurplusUsdcRaw"])} for row in observation["rows"]]
        best = max(observation["rows"], key=lambda row: int(row["quotedSurplusUsdcRaw"]))
        positive = any(int(row["quotedSurplusUsdcRaw"]) > 0 for row in observation["rows"])
        pin_fresh, pin_age = freshness(int(observation["pin"]["timestamp"]), now, 1800, 5400)
        card.update(status="WATCH" if positive else "PARK", rows=rows, best_quoted_change_usdc=usdc(best["quotedSurplusUsdcRaw"]),
                    best_input_usdc=usdc(best["inputUsdcRaw"]), block=observation["pin"]["number"], block_hash=observation["pin"]["hash"],
                    pin_freshness=pin_fresh, pin_age=pin_age, source_runtime_bound=state["source"]["sourceRuntimeBound"],
                    provider_families=state["qualification"]["selectedFamilyCount"],
                    preview_balances_sufficient=all(row["pocketBalanceAllowanceSufficient"] for row in observation["rows"]),
                    next_gate="Validate positive quote, source/runtime, transfers and all costs" if positive else "Reopen only on changed economics or a materially better venue")
    return cards


def _aave_v3_endpoint_leak(value: Any, skip: frozenset[str] = frozenset()) -> bool:
    """Return True when any bounded scalar text carries an endpoint or provider hint."""

    stack: list[Any] = [value]
    seen = 0
    while stack:
        node = stack.pop()
        seen += 1
        if seen > 20_000:
            return True
        if isinstance(node, str):
            if AAVE_V3_ENDPOINT_LEAK.search(node):
                return True
        elif isinstance(node, dict):
            for key, item in node.items():
                if isinstance(key, str) and key in skip:
                    continue
                stack.append(item)
        elif isinstance(node, list):
            stack.extend(node)
    return False


def aave_v3_liquidation_watch_valid(state: Any) -> bool:
    """Validate the read-only Aave V3 continuous watch plus coverage-proof artifact."""

    if not isinstance(state, dict):
        return False
    coverage = state.get("sourceCoverage")
    safety = state.get("safety")
    latest = state.get("latest")
    if (
        state.get("scanner") != AAVE_V3_LIQ_WATCH_SCANNER
        or timestamp(state.get("generatedAt")) is None
        or not isinstance(state.get("classification"), str)
        or AAVE_V3_SAFE_CLASS.fullmatch(state["classification"]) is None
        or not isinstance(state.get("complete"), bool)
        or not _aave_count(state.get("cycle"))
        or not isinstance(safety, dict)
        or safety.get("signedActions") is not False
        or safety.get("signedActionJustified") is not False
        or safety.get("routePositive") is not False
        or safety.get("globalRoutePositive") is not False
        or safety.get("executableNow") is not False
        or not isinstance(coverage, dict)
        or coverage.get("schema") != AAVE_SOURCE_COVERAGE_SCHEMA
        or isinstance(coverage.get("schemaVersion"), bool)
        or coverage.get("schemaVersion") != AAVE_SOURCE_COVERAGE_SCHEMA_VERSION
        or coverage.get("protocolVersion") != "V3"
        or coverage.get("coverageKind") != AAVE_V4_COVERAGE_KIND
        or coverage.get("classification") != state["classification"]
        or coverage.get("complete") != state["complete"]
        or not isinstance(coverage.get("coverageProofVerified"), bool)
        or not _exact_aave_promotion_closure(coverage.get("promotionClosure"))
        or not all(
            _aave_count(coverage.get(key))
            for key in (
                "chainsExpected",
                "chainsObserved",
                "logChunksAttempted",
                "logChunksSucceeded",
                "logChunksFailed",
                "discoveredBorrowers",
                "checkedBorrowers",
            )
        )
        or not isinstance(coverage.get("blocker"), str)
        or not isinstance(latest, dict)
        or not all(
            isinstance(latest.get(key), bool)
            for key in (
                "triggerReady",
                "exactReady",
                "sourceAbiReady",
                "deployedSelectorReady",
                "flashLiquidityReady",
                "forkProofReady",
                "liveExecutorReady",
            )
        )
        or latest.get("executableNow") is not False
        or latest.get("signedActionJustified") is not False
        or latest.get("routePositive") != 0
        or latest.get("globalRoutePositive") != 0
    ):
        return False
    if coverage["coverageProofVerified"]:
        proof = coverage.get("coverageProof")
        if (
            not isinstance(proof, dict)
            or proof.get("schema") != AAVE_V3_BORROWER_UNIVERSE_SCHEMA
            or not isinstance(proof.get("universeSha256"), str)
            or AAVE_V3_SHA256.fullmatch(proof["universeSha256"]) is None
            or timestamp(proof.get("verifiedAt")) is None
        ):
            return False
    return not _aave_v3_endpoint_leak(state)


def aave_v3_trigger_readiness_valid(state: Any) -> bool:
    """Validate the read-only Aave V3 trigger/executor readiness artifact."""

    if not isinstance(state, dict):
        return False
    coverage = state.get("sourceCoverage")
    safety = state.get("safety")
    summary = state.get("summary")
    findings = state.get("findings")
    live = state.get("live")
    if (
        state.get("scanner") != AAVE_V3_READINESS_SCANNER
        or timestamp(state.get("generatedAt")) is None
        or not isinstance(state.get("classification"), str)
        or AAVE_V3_SAFE_CLASS.fullmatch(state["classification"]) is None
        or not isinstance(state.get("complete"), bool)
        or not isinstance(coverage, dict)
        or coverage.get("schema") != AAVE_SOURCE_COVERAGE_SCHEMA
        or coverage.get("classification") != state["classification"]
        or not isinstance(safety, dict)
        or safety.get("signedActions") is not False
        or safety.get("signedActionJustified") is not False
        or safety.get("routePositive") is not False
        or safety.get("executableNow") is not False
        or not isinstance(summary, dict)
        or not isinstance(summary.get("status"), str)
        or AAVE_V3_BLOCKER.fullmatch(summary["status"]) is None
        or summary.get("routePositive") != 0
        or summary.get("executableNow") is not False
        or summary.get("signedActionJustified") is not False
        or not _aave_count(summary.get("routeWatchCandidates"))
        or not _aave_count(summary.get("currentLiquidatable"))
        or not _aave_count(summary.get("exactEconomicsRows"))
        or not _aave_count(summary.get("rowsWithAnyQuote"))
        or not _aave_count(summary.get("findingCount"))
        or not all(
            isinstance(summary.get(key), bool) for key in AAVE_V3_READINESS_GATE_FIELDS
        )
        or not isinstance(summary.get("blocker"), str)
        or (
            summary.get("currentHealthFactor") is not None
            and _number(summary["currentHealthFactor"]) is None
        )
        or (
            summary.get("bpsToLiquidation") is not None
            and _number(summary["bpsToLiquidation"]) is None
        )
        or not isinstance(findings, list)
        or len(findings) > 64
        or len(findings) != summary["findingCount"]
        or not isinstance(live, dict)
        or not isinstance(live.get("account"), dict)
        or _number(live["account"].get("healthFactor")) is None
        or _number(live["account"].get("bpsToLiquidation")) is None
    ):
        return False
    for row in findings:
        if (
            not isinstance(row, dict)
            or not isinstance(row.get("severity"), str)
            or row["severity"] not in {"info", "low", "medium", "high", "critical"}
            or not isinstance(row.get("title"), str)
            or not row["title"].strip()
            or not isinstance(row.get("detail"), str)
            or not row["detail"].strip()
        ):
            return False
    return not _aave_v3_endpoint_leak(state)


def aave_v3_liquidation_quotes_valid(state: Any, schema: str) -> bool:
    """Validate an exact- or trigger-fired quote artifact without reading a route claim."""

    if not isinstance(state, dict):
        return False
    flash = state.get("flash")
    if (
        state.get("schema") != schema
        or timestamp(state.get("generatedAt")) is None
        or state.get("readonly") is not True
        or state.get("rpcUrlsStored") is not False
        or state.get("routePositive") != "unknown"
        or state.get("executableNow") is not False
        or state.get("autoExecutable") is not False
        or state.get("signedActionJustified") is not False
        or state.get("forkJustified") is not False
        or not isinstance(state.get("exactQuoteComplete"), bool)
        or not isinstance(state.get("blockers"), list)
        or not all(
            isinstance(blocker, str) and AAVE_V3_BLOCKER.fullmatch(blocker)
            for blocker in state["blockers"]
        )
        or not _aave_count(state.get("requestsUsed"))
        or not isinstance(state.get("scenarios"), list)
        or not isinstance(flash, dict)
        or not isinstance(flash.get("balancerPoolDrainedAtObservation"), bool)
    ):
        return False
    for row in state["scenarios"]:
        if (
            not isinstance(row, dict)
            or row.get("routePositive") != "unknown"
            or row.get("executable") is not False
            or row.get("executableNow") is not False
            or row.get("autoExecutable") is not False
            or row.get("signedActionJustified") is not False
            or row.get("forkJustified") is not False
            or not isinstance(row.get("blockers"), list)
        ):
            return False
    gas_model = state.get("gasModel")
    if gas_model is not None and not isinstance(gas_model, (str, int, float, dict)):
        return False
    return not _aave_v3_endpoint_leak(state)


def aave_v3_borrower_universe_valid(state: Any) -> bool:
    """Validate the full-history borrower-universe coverage proof artifact."""

    if not isinstance(state, dict):
        return False
    floor = state.get("floorBlock")
    head = state.get("headBlock")
    if (
        state.get("schema") != AAVE_V3_BORROWER_UNIVERSE_SCHEMA
        or timestamp(state.get("generatedAt")) is None
        or state.get("readonly") is not True
        or state.get("rpcUrlsStored") is not False
        or state.get("signedActionJustified") is not False
        or not _aave_count(floor)
        or not _aave_count(head)
        or head < floor
        or not isinstance(state.get("coverageClass"), str)
        or AAVE_V3_SAFE_CLASS.fullmatch(state["coverageClass"]) is None
        or not isinstance(state.get("fullHistoryProven"), bool)
        or not _aave_count(state.get("dedupedBorrowersCount"))
        or not isinstance(state.get("universeSha256"), str)
        or AAVE_V3_SHA256.fullmatch(state["universeSha256"]) is None
    ):
        return False
    return not _aave_v3_endpoint_leak(state, frozenset({"borrowerUniverse"}))


def _aave_v3_watch_section(read: JsonRead, now: float) -> dict[str, Any]:
    if not read.current or not aave_v3_liquidation_watch_valid(read.value):
        return {"available": False}
    state = read.value
    coverage = state["sourceCoverage"]
    latest = state["latest"]
    fresh, age = freshness(state["generatedAt"], now, 120, 360)
    proof = None
    if coverage["coverageProofVerified"] and isinstance(coverage.get("coverageProof"), dict):
        raw = coverage["coverageProof"]
        proof = {
            "schema": raw["schema"],
            "universe_sha256": raw["universeSha256"][:12],
            "verified_at": _iso_time(raw["verifiedAt"]),
        }
    return {
        "available": True,
        "generated_at": _iso_time(state["generatedAt"]),
        "freshness": fresh,
        "age": age,
        "classification": state["classification"],
        "complete": state["complete"],
        "coverage_verified": coverage["coverageProofVerified"],
        "coverage_proof": proof,
        "chains_observed": coverage["chainsObserved"],
        "chains_expected": coverage["chainsExpected"],
        "blocker": coverage["blocker"],
        "watch_candidates": (
            latest["watchCandidates"] if _aave_count(latest.get("watchCandidates")) else None
        ),
        "current_liquidatable": (
            latest["currentLiquidatable"]
            if _aave_count(latest.get("currentLiquidatable"))
            else None
        ),
        "trigger_ready": latest["triggerReady"],
        "exact_ready": latest["exactReady"],
    }


def _aave_v3_readiness_section(read: JsonRead, now: float) -> dict[str, Any]:
    if not read.current or not aave_v3_trigger_readiness_valid(read.value):
        return {"available": False}
    state = read.value
    summary = state["summary"]
    fresh, age = freshness(state["generatedAt"], now, 120, 360)
    shadow = None
    top_row = state.get("topRow")
    if isinstance(top_row, dict) and isinstance(top_row.get("economics"), dict):
        economics = top_row["economics"]
        shadow = {
            "shadow_net_usd": economics.get("shadowNetUsd"),
            "exact_quote_missing": economics.get("exactQuoteMissing"),
            "blocker": economics.get("blocker"),
        }
    return {
        "available": True,
        "generated_at": _iso_time(state["generatedAt"]),
        "freshness": fresh,
        "age": age,
        "status": summary["status"],
        "health_factor": summary["currentHealthFactor"],
        "bps_to_liquidation": summary["bpsToLiquidation"],
        "current_liquidatable": summary["currentLiquidatable"],
        "route_watch_candidates": summary["routeWatchCandidates"],
        "gates": [(key, summary[key]) for key in AAVE_V3_READINESS_GATE_FIELDS],
        "findings_count": summary["findingCount"],
        "shadow_economics": shadow,
        "blocker": summary["blocker"],
    }


def _aave_v3_quote_section(read: JsonRead, schema: str, now: float) -> dict[str, Any]:
    if not read.current or not aave_v3_liquidation_quotes_valid(read.value, schema):
        return {"available": False}
    state = read.value
    fresh, age = freshness(state["generatedAt"], now, 1800, 5400)
    gas_model = state.get("gasModel")
    if isinstance(gas_model, dict):
        gas_model = {key: gas_model[key] for key in sorted(gas_model) if isinstance(key, str)}
    return {
        "available": True,
        "generated_at": _iso_time(state["generatedAt"]),
        "freshness": fresh,
        "age": age,
        "exact_quote_complete": state["exactQuoteComplete"],
        "gas_model": gas_model,
        "blockers": list(state["blockers"]),
        "drained_balancer": state["flash"]["balancerPoolDrainedAtObservation"],
        "requests_used": state["requestsUsed"],
        "scenario_count": len(state["scenarios"]),
        "readonly": True,
        "signed_action_justified": False,
    }


def _aave_v3_universe_section(read: JsonRead, now: float) -> dict[str, Any]:
    if not read.current or not aave_v3_borrower_universe_valid(read.value):
        return {"available": False}
    state = read.value
    fresh, age = freshness(state["generatedAt"], now, 86_400, 604_800)
    return {
        "available": True,
        "generated_at": _iso_time(state["generatedAt"]),
        "freshness": fresh,
        "age": age,
        "coverage_class": state["coverageClass"],
        "universe_sha256": state["universeSha256"][:12],
        "floor_block": state["floorBlock"],
        "head_block": state["headBlock"],
        "deduped_borrowers": state["dedupedBorrowersCount"],
        "full_history_proven": state["fullHistoryProven"],
    }


def _aave_v3_liquidation(
    item: Monitor,
    now: float,
    watch_read: JsonRead,
    readiness_read: JsonRead,
    exact_read: JsonRead,
    trigger_read: JsonRead,
    universe_read: JsonRead,
) -> dict[str, Any]:
    """Aggregate the five Aave V3 trigger artifacts into one fail-closed record."""

    watch = _aave_v3_watch_section(watch_read, now)
    readiness = _aave_v3_readiness_section(readiness_read, now)
    exact_quote = _aave_v3_quote_section(exact_read, AAVE_V3_EXACT_QUOTES_SCHEMA, now)
    trigger_quote = _aave_v3_quote_section(trigger_read, AAVE_V3_TRIGGER_QUOTES_SCHEMA, now)
    universe = _aave_v3_universe_section(universe_read, now)

    warnings: list[str] = []
    if not watch["available"]:
        warnings.append("Aave V3 liquidation watch artifact is unavailable or invalid")
    elif not watch["complete"]:
        warnings.append(
            "Live sample is bounded; only the historical borrower universe is coverage-proven"
        )
    if not readiness["available"]:
        warnings.append("Trigger readiness artifact is unavailable or invalid")
    if not exact_quote["available"]:
        warnings.append("Exact-quote artifact is unavailable or invalid")
    if not trigger_quote["available"]:
        warnings.append("No trigger-fired quote artifact is present yet")
    if not universe["available"]:
        warnings.append("Borrower-universe coverage proof is unavailable or invalid")

    if watch["available"]:
        fresh = watch["freshness"]
        age = watch["age"]
        if watch["current_liquidatable"] and watch["current_liquidatable"] > 0:
            observation = "TRIGGERED"
        elif watch["trigger_ready"] or watch["exact_ready"]:
            observation = "WATCH"
        elif watch["complete"] and watch["coverage_verified"]:
            observation = "CLEAR"
        else:
            observation = "UNKNOWN"
        source_health = "OK"
    else:
        fresh, age = "UNKNOWN", None
        observation = "UNKNOWN"
        source_health = "INVALID" if watch_read.source else "UNKNOWN"

    metrics = _metrics(
        (
            ("coverage", watch.get("classification")),
            ("coverage verified", watch.get("coverage_verified")),
            ("watch candidates", watch.get("watch_candidates")),
            ("current liquidatable", watch.get("current_liquidatable")),
            ("readiness health factor", readiness.get("health_factor")),
            ("bps to liquidation", readiness.get("bps_to_liquidation")),
            ("readiness findings", readiness.get("findings_count")),
            ("exact quote complete", exact_quote.get("exact_quote_complete")),
            ("trigger quote", "present" if trigger_quote["available"] else "no trigger yet"),
            ("universe coverage class", universe.get("coverage_class")),
            ("universe floor block", universe.get("floor_block")),
        )
    )

    return {
        "observation": observation,
        "freshness": fresh,
        "age": age,
        "alarm": _alarm(item, observation, fresh),
        "metrics": metrics,
        "provenance": [
            "aave-v3-liquidation-watch",
            "aave-v3-trigger-readiness",
            "aave-v3-liquidation-exact-quotes",
            "aave-v3-liquidation-trigger-quotes",
            "aave-v3-borrower-universe",
        ],
        "warnings": warnings,
        "observation_at": watch.get("generated_at"),
        "source_health": source_health,
        "aave_v3_liquidation": {
            "watch": watch,
            "readiness": readiness,
            "exact_quote": exact_quote,
            "trigger_quote": trigger_quote,
            "universe": universe,
            "fail_closed_notice": "readonly · signedActionJustified:false",
        },
    }


def _morpho_endpoint_leak(value: Any, skip: frozenset[str] = frozenset()) -> bool:
    """Return True when any bounded scalar text carries an endpoint or provider hint."""

    stack: list[Any] = [value]
    seen = 0
    while stack:
        node = stack.pop()
        seen += 1
        if seen > 20_000:
            return True
        if isinstance(node, str):
            if MORPHO_ENDPOINT_LEAK.search(node):
                return True
        elif isinstance(node, dict):
            for key, item in node.items():
                if isinstance(key, str) and key in skip:
                    continue
                stack.append(item)
        elif isinstance(node, list):
            stack.extend(node)
    return False


def morpho_blue_liquidatable_valid(state: Any) -> bool:
    """Validate the read-only Morpho Blue liquidatable-observation artifact."""

    if not isinstance(state, dict):
        return False
    safety = state.get("safety")
    pin = state.get("pin")
    totals = state.get("totals")
    coverage = state.get("coverage")
    rows = state.get("rows")
    if (
        state.get("schema") != MORPHO_BLUE_LIQUIDATABLE_SCHEMA
        or timestamp(state.get("scannedAt")) is None
        or state.get("scanner") != MORPHO_BLUE_LIQUIDATABLE_SCANNER
        or state.get("chainId") not in MORPHO_BLUE_CHAIN_IDS
        or not isinstance(safety, dict)
        or safety.get("readOnly") is not True
        or safety.get("signedActions") is not False
        or safety.get("transactions") is not False
        or safety.get("endpointMaterialPersisted") is not False
        or not isinstance(pin, dict)
        or not _aave_count(pin.get("number"))
        or not isinstance(pin.get("hash"), str)
        or HEX_32.fullmatch(pin["hash"]) is None
        or timestamp(pin.get("timestamp")) is None
        or not isinstance(pin.get("finality"), str)
        or not isinstance(totals, dict)
        or not all(
            _aave_count(totals.get(key))
            for key in (
                "rawDirectionalLiquidatable",
                "exactLiquidatable",
                "activeEvaluated",
                "oracleUnavailable",
            )
        )
        or not isinstance(coverage, dict)
        or not isinstance(coverage.get("complete"), bool)
        or not isinstance(coverage.get("blockers"), list)
        or not all(isinstance(blocker, str) for blocker in coverage["blockers"])
        or not isinstance(rows, list)
        or len(rows) > 200_000
    ):
        return False
    for row in rows:
        if (
            not isinstance(row, dict)
            or not isinstance(row.get("routePositive"), bool)
            or not isinstance(row.get("valuationStatus"), str)
            or not isinstance(row.get("probeStatus"), str)
            or not isinstance(row.get("quoteExecutable"), bool)
            or (row.get("netUsdcRaw") is not None and not isinstance(row.get("netUsdcRaw"), str))
        ):
            return False
    return not _morpho_endpoint_leak(state, frozenset({"rows", "valuation"}))


def morpho_ws_status_valid(state: Any) -> bool:
    """Validate the per-BSD Morpho watcher status artifact."""

    if not isinstance(state, dict):
        return False
    stats = state.get("eventStats")
    chains = state.get("chains")
    if (
        timestamp(state.get("updatedAt")) is None
        or not isinstance(state.get("trigger"), str)
        or AAVE_V3_BLOCKER.fullmatch(state["trigger"]) is None
        or not isinstance(stats, dict)
        or not all(_aave_count(stats.get(key)) for key in MORPHO_EVENT_STATS)
        or not _aave_count(state.get("liquidationsSeen"))
        or not isinstance(chains, list)
        or len(chains) > 64
        or not isinstance(state.get("status"), str)
        or AAVE_V3_SAFE_CLASS.fullmatch(state["status"]) is None
    ):
        return False
    for chain in chains:
        if (
            not isinstance(chain, dict)
            or not isinstance(chain.get("key"), str)
            or not _aave_count(chain.get("id"))
            or not isinstance(chain.get("connected"), bool)
            or not isinstance(chain.get("degraded"), bool)
            or not isinstance(chain.get("subscriptionState"), str)
        ):
            return False
    return not _morpho_endpoint_leak(state)


def _morpho_route_positive(row: dict[str, Any]) -> bool:
    value = row.get("routePositive")
    if value is True:
        return True
    return isinstance(value, str) and value.strip().lower() == "true"


def _morpho_bucket_counts(rows: list[Any], field: str) -> list[tuple[str, int]]:
    """Return at most the ten largest (bucket, count) pairs, deterministically ordered."""

    counts: Counter[str] = Counter()
    for row in rows:
        value = row.get(field)
        if isinstance(value, str) and value:
            counts[value] += 1
    ordered = sorted(counts.items(), key=lambda item: (-item[1], item[0]))
    return ordered[:MORPHO_MAX_BUCKETS]


def _morpho_chain_section(read: JsonRead, now: float) -> dict[str, Any]:
    if not read.current or not morpho_blue_liquidatable_valid(read.value):
        return {"available": False}
    state = read.value
    rows = state["rows"]
    totals = state["totals"]
    fresh, age = freshness(state["scannedAt"], now, 120, 360)
    return {
        "available": True,
        "scanned_at": _iso_time(state["scannedAt"]),
        "freshness": fresh,
        "age": age,
        "chain_id": state["chainId"],
        "pin_block": state["pin"]["number"],
        "pin_finality": state["pin"]["finality"],
        "coverage_complete": state["coverage"]["complete"],
        "coverage_blockers": list(state["coverage"]["blockers"]),
        "totals": {
            "raw_directional_liquidatable": totals["rawDirectionalLiquidatable"],
            "exact_liquidatable": totals["exactLiquidatable"],
            "active_evaluated": totals["activeEvaluated"],
            "oracle_unavailable": totals["oracleUnavailable"],
        },
        "route_positive_count": sum(1 for row in rows if _morpho_route_positive(row)),
        "probe_status_counts": _morpho_bucket_counts(rows, "probeStatus"),
        "valuation_status_counts": _morpho_bucket_counts(rows, "valuationStatus"),
        "row_count": len(rows),
    }


def _morpho_ws_section(read: JsonRead, now: float) -> dict[str, Any]:
    if not read.current or not morpho_ws_status_valid(read.value):
        return {"available": False}
    state = read.value
    fresh, age = freshness(state["updatedAt"], now, 120, 360)
    return {
        "available": True,
        "updated_at": _iso_time(state["updatedAt"]),
        "freshness": fresh,
        "age": age,
        "trigger": state["trigger"],
        "liquidations_seen": state["liquidationsSeen"],
        "event_stats": [(key, state["eventStats"][key]) for key in MORPHO_EVENT_STATS],
        "chains": len(state["chains"]),
        "status": state["status"],
    }


def _morpho_blue_liquidation(
    item: Monitor,
    now: float,
    eth_read: JsonRead,
    base_read: JsonRead,
    ws_read: JsonRead,
) -> dict[str, Any]:
    """Aggregate the Morpho Blue chain observations and watcher status fail-closed."""

    eth = _morpho_chain_section(eth_read, now)
    base = _morpho_chain_section(base_read, now)
    watch = _morpho_ws_section(ws_read, now)

    warnings: list[str] = []
    if not eth["available"]:
        warnings.append("Morpho Blue Ethereum observation is unavailable or invalid")
    if not base["available"]:
        warnings.append("Morpho Blue Base observation is unavailable or invalid")
    if not watch["available"]:
        warnings.append("Morpho watcher status is unavailable or invalid")

    if eth["available"]:
        fresh, age = eth["freshness"], eth["age"]
        if eth["route_positive_count"] > 0:
            observation = "TRIGGERED"
        elif eth["totals"]["exact_liquidatable"] > 0:
            observation = "WATCH"
        elif eth["coverage_complete"]:
            observation = "CLEAR"
        else:
            observation = "UNKNOWN"
        source_health = "OK"
    else:
        fresh, age = "UNKNOWN", None
        observation = "UNKNOWN"
        source_health = "INVALID" if eth_read.source else "UNKNOWN"

    eth_totals = eth.get("totals", {})
    base_totals = base.get("totals", {})
    metrics = _metrics(
        (
            ("ethereum exact liquidatable", eth_totals.get("exact_liquidatable")),
            ("ethereum route positive", eth.get("route_positive_count")),
            ("ethereum coverage complete", eth.get("coverage_complete")),
            ("base exact liquidatable", base_totals.get("exact_liquidatable")),
            ("base route positive", base.get("route_positive_count")),
            ("watcher liquidations seen", watch.get("liquidations_seen")),
            ("watcher chains", watch.get("chains")),
        )
    )

    return {
        "observation": observation,
        "freshness": fresh,
        "age": age,
        "alarm": _alarm(item, observation, fresh),
        "metrics": metrics,
        "provenance": [
            "morpho-blue-liquidatable",
            "morpho-blue-liquidatable-base",
            "morpho-ws-status",
        ],
        "warnings": warnings,
        "observation_at": eth.get("scanned_at"),
        "source_health": source_health,
        "morpho_blue_liquidation": {
            "eth": eth,
            "base": base,
            "watch": watch,
            "fail_closed_notice": "readonly · signedActionJustified:false",
        },
    }


def _euler_endpoint_leak(value: Any, skip: frozenset[str] = frozenset()) -> bool:
    """Return True when any bounded scalar text carries an endpoint or provider hint."""

    stack: list[Any] = [value]
    seen = 0
    while stack:
        node = stack.pop()
        seen += 1
        if seen > 20_000:
            return True
        if isinstance(node, str):
            if EULER_L_ENDPOINT_LEAK.search(node):
                return True
        elif isinstance(node, dict):
            for key, item in node.items():
                if isinstance(key, str) and key in skip:
                    continue
                stack.append(item)
        elif isinstance(node, list):
            stack.extend(node)
    return False


def euler_l_watch_valid(state: Any) -> bool:
    """Validate the read-only Euler EVK continuous liquidation-watch status artifact."""

    if not isinstance(state, dict):
        return False
    surface = state.get("surface")
    rpc = state.get("rpcQualification")
    safety = state.get("safety")
    health = state.get("producer_health")
    config = state.get("config")
    rotation = state.get("rotation")
    totals = state.get("totals")
    vaults = state.get("vaults")
    blockers = state.get("blockers")
    live = state.get("liveBatchStatus")
    if (
        state.get("schema") != EULER_L_WATCH_SCHEMA
        or timestamp(state.get("generatedAt")) is None
        or state.get("scanner") != EULER_L_WATCH_SCANNER
        or not isinstance(state.get("scope"), str)
        or not _aave_count(state.get("cycle"))
        or timestamp(state.get("startedAt")) is None
        or not isinstance(state.get("ok"), bool)
        or "reason" not in state or (state["reason"] is not None and not isinstance(state["reason"], str))
        or (not _aave_count(state.get("blockNumber")) and (state["ok"] or state.get("blockNumber") is not None))
        or not isinstance(surface, dict)
        or not isinstance(surface.get("artifact"), str)
        or not isinstance(surface.get("present"), bool)
        or not isinstance(surface.get("fresh"), bool)
        or (surface.get("scannedAt") is not None and timestamp(surface["scannedAt"]) is None)
        or "reason" not in surface or (surface["reason"] is not None and not isinstance(surface["reason"], str))
        or (surface.get("vaultsWithBorrows") is not None and not _aave_count(surface["vaultsWithBorrows"]))
        or not isinstance(rpc, dict)
        or not isinstance(rpc.get("qualified"), bool)
        or not isinstance(rpc.get("archiveCapable"), bool)
        or (not isinstance(rpc.get("tier"), str) and (rpc["qualified"] or rpc.get("tier") is not None))
        or not _aave_count(rpc.get("candidatesQualified"))
        or not isinstance(safety, dict)
        or safety.get("readOnly") is not True
        or safety.get("rpcUrlsStored") is not False
        or safety.get("envFilesRead") is not False
        or safety.get("privateKeysRead") is not False
        or safety.get("signedActions") is not False
        or safety.get("exploitExecuteCalls") is not False
        or safety.get("forkTransactions") is not False
        or safety.get("routePositive") is not False
        or not isinstance(health, dict)
        or not all(
            isinstance(health.get(key), bool)
            for key in (
                "surfaceArtifactPresent",
                "surfaceArtifactFresh",
                "rpcQualified",
                "rpcArchiveCapable",
                "sweepCompleted",
                "liveStateRead",
                "multicallSucceeded",
                "failClosed",
            )
        )
        or health.get("routePositive") is not False
        or not all(
            _aave_count(health.get(key))
            for key in (
                "rpcCandidatesQualified",
                "multicallFallbacks",
                "vaultsSelected",
                "vaultsSwept",
                "consecutiveQualificationFailures",
                "requests",
            )
        )
        or (health.get("surfaceArtifactAgeMs") is not None and not _aave_count(health["surfaceArtifactAgeMs"]))
        or not isinstance(config, dict)
        or not isinstance(rotation, dict)
        or not _aave_count(rotation.get("cursor"))
        or not _aave_count(rotation.get("nextCursor"))
        or not isinstance(totals, dict)
        or (totals.get("vaultsWithBorrowsInSurface") is not None and not _aave_count(totals["vaultsWithBorrowsInSurface"]))
        or not all(
            _aave_count(totals.get(key))
            for key in (
                "vaultsSelected",
                "vaultsSwept",
                "vaultsWithStateRead",
                "vaultsReadFailed",
                "liquidatableVaults",
                "violatorChecksAttempted",
                "violatorChecksHealthy",
                "violatorChecksLiquidatable",
                "violatorChecksNotProven",
                "stateReadsAttempted",
                "stateReadsSucceeded",
                "requests",
            )
        )
        or not isinstance(vaults, list)
        or len(vaults) > 10_000
        or not isinstance(blockers, list)
        or not all(isinstance(blocker, str) for blocker in blockers)
        or not isinstance(live, dict)
        or not isinstance(live.get("authorizationState"), str)
        or (live.get("reason") is not None and not isinstance(live["reason"], str))
    ):
        return False
    return not _euler_endpoint_leak(state, frozenset({"vaults"}))


def euler_l_surface_valid(state: Any) -> bool:
    """Validate the read-only Euler EVK liquidate/VaultStatus surface observation."""

    if not isinstance(state, dict):
        return False
    safety = state.get("safety")
    pin = state.get("pin")
    totals = state.get("totals")
    coverage = state.get("coverage")
    inventory = state.get("inventory")
    enumeration = state.get("enumeration")
    reads = state.get("reads")
    csv = state.get("csv")
    if (
        state.get("schema") != EULER_L_SURFACE_SCHEMA
        or timestamp(state.get("scannedAt")) is None
        or state.get("scanner") != EULER_L_SURFACE_SCANNER
        or state.get("chainId") != EULER_L_CHAIN_ID
        or not isinstance(safety, dict)
        or safety.get("readOnly") is not True
        or safety.get("signedActions") is not False
        or safety.get("transactions") is not False
        or safety.get("endpointMaterialPersisted") is not False
        or not isinstance(pin, dict)
        or not _aave_count(pin.get("number"))
        or not isinstance(pin.get("hash"), str)
        or HEX_32.fullmatch(pin["hash"]) is None
        or timestamp(pin.get("timestamp")) is None
        or not isinstance(pin.get("finality"), str)
        or not isinstance(totals, dict)
        or not all(
            _aave_count(totals.get(key))
            for key in (
                "evVaultCount",
                "liquidateEventCount",
                "vaultsWithLiquidations",
                "vaultsWithBorrows",
                "vaultsWithCurrentStateRead",
                "currentStateReadFailures",
            )
        )
        or not isinstance(totals.get("truncated"), bool)
        or not isinstance(coverage, dict)
        or not isinstance(coverage.get("complete"), bool)
        or not isinstance(coverage.get("blockers"), list)
        or not all(isinstance(blocker, str) for blocker in coverage["blockers"])
        or not isinstance(inventory, dict)
        or not _aave_count(inventory.get("factoryProxyListLength"))
        or not isinstance(enumeration, dict)
        or not isinstance(reads, dict)
        or not isinstance(csv, dict)
    ):
        return False
    return not _euler_endpoint_leak(state, frozenset({"vaults", "topLiquidateEvents"}))


def euler_l_valuation_valid(state: Any) -> bool:
    """Validate the read-only Euler EVK candidate-valuation observation."""

    if not isinstance(state, dict):
        return False
    safety = state.get("safety")
    source = state.get("source")
    pin = state.get("pin")
    candidates = state.get("candidates")
    summary = state.get("summary")
    routes = state.get("routes")
    if (
        state.get("schema") != EULER_L_VALUATION_SCHEMA
        or timestamp(state.get("generatedAt")) is None
        or state.get("scanner") != EULER_L_VALUATION_SCANNER
        or state.get("chainId") != EULER_L_CHAIN_ID
        or not isinstance(safety, dict)
        or safety.get("readOnly") is not True
        or safety.get("signedActions") is not False
        or safety.get("transactions") is not False
        or safety.get("endpointMaterialPersisted") is not False
        or safety.get("externalPriceApi") is not False
        or safety.get("fetchPriceUsed") is not False
        or not isinstance(source, dict)
        or source.get("schema") != EULER_L_SURFACE_SCHEMA
        or not isinstance(pin, dict)
        or not _aave_count(pin.get("number"))
        or not isinstance(pin.get("hash"), str)
        or HEX_32.fullmatch(pin["hash"]) is None
        or timestamp(pin.get("timestamp")) is None
        or not isinstance(candidates, dict)
        or not all(
            _aave_count(candidates.get(key))
            for key in ("evaluated", "maxCandidates", "quoteReadsUsed", "quoteReadsBudget")
        )
        or not isinstance(summary, dict)
        or not all(
            _aave_count(summary.get(key))
            for key in (
                "candidatesEvaluated",
                "netPositive",
                "netBeforeGasPositive",
                "routePositive",
                "qualifiedView",
                "unqualified",
                "quoteExecutableCount",
            )
        )
        or not isinstance(summary.get("valuationStatusCounts"), dict)
        or not isinstance(summary.get("probeStatusCounts"), dict)
        or not isinstance(routes, list)
        or len(routes) > 200_000
    ):
        return False
    return not _euler_endpoint_leak(state, frozenset({"routes", "rows", "topNetPositive"}))


def _euler_bucket_counts(counts: dict[str, Any]) -> list[tuple[str, int]]:
    """Return at most the ten largest (bucket, count) pairs, deterministically ordered."""

    items = [
        (key, value)
        for key, value in counts.items()
        if isinstance(key, str) and _aave_count(value)
    ]
    ordered = sorted(items, key=lambda item: (-item[1], item[0]))
    return ordered[:EULER_L_MAX_BUCKETS]


def _euler_watch_section(read: JsonRead, now: float) -> dict[str, Any]:
    if not read.current or not euler_l_watch_valid(read.value):
        return {"available": False}
    state = read.value
    totals = state["totals"]
    health = state["producer_health"]
    fresh, age = freshness(state["generatedAt"], now, 600, 1800)
    return {
        "available": True,
        "generated_at": _iso_time(state["generatedAt"]),
        "freshness": fresh,
        "age": age,
        "ok": state["ok"],
        "reason": state["reason"],
        "cycle": state["cycle"],
        "block_number": state["blockNumber"],
        "sweep_completed": health["sweepCompleted"],
        "live_state_read": health["liveStateRead"],
        "fail_closed": health["failClosed"],
        "route_positive": state["safety"]["routePositive"],
        "surface_present": health["surfaceArtifactPresent"],
        "surface_fresh": health["surfaceArtifactFresh"],
        "requests": totals["requests"],
        "sweep": {
            "vaults_selected": totals["vaultsSelected"],
            "vaults_swept": totals["vaultsSwept"],
            "vaults_with_state_read": totals["vaultsWithStateRead"],
            "liquidatable_vaults": totals["liquidatableVaults"],
        },
        "blockers": list(state["blockers"]),
    }


def _euler_surface_section(read: JsonRead, now: float) -> dict[str, Any]:
    if not read.current or not euler_l_surface_valid(read.value):
        return {"available": False}
    state = read.value
    totals = state["totals"]
    coverage = state["coverage"]
    fresh, age = freshness(state["scannedAt"], now, 86_400, 604_800)
    return {
        "available": True,
        "scanned_at": _iso_time(state["scannedAt"]),
        "freshness": fresh,
        "age": age,
        "chain_id": state["chainId"],
        "pin_block": state["pin"]["number"],
        "pin_finality": state["pin"]["finality"],
        "ev_vault_count": totals["evVaultCount"],
        "liquidate_event_count": totals["liquidateEventCount"],
        "vaults_with_liquidations": totals["vaultsWithLiquidations"],
        "vaults_with_borrows": totals["vaultsWithBorrows"],
        "coverage_complete": coverage["complete"],
        "coverage_blockers": list(coverage["blockers"]),
        "truncated": totals["truncated"],
    }


def _euler_valuation_section(read: JsonRead, now: float) -> dict[str, Any]:
    if not read.current or not euler_l_valuation_valid(read.value):
        return {"available": False}
    state = read.value
    summary = state["summary"]
    fresh, age = freshness(state["generatedAt"], now, 86_400, 604_800)
    return {
        "available": True,
        "generated_at": _iso_time(state["generatedAt"]),
        "freshness": fresh,
        "age": age,
        "candidates_evaluated": summary["candidatesEvaluated"],
        "net_positive": summary["netPositive"],
        "net_before_gas_positive": summary["netBeforeGasPositive"],
        "route_positive": summary["routePositive"],
        "qualified_view": summary["qualifiedView"],
        "unqualified": summary["unqualified"],
        "quote_executable_count": summary["quoteExecutableCount"],
        "valuation_status_counts": _euler_bucket_counts(summary["valuationStatusCounts"]),
        "probe_status_counts": _euler_bucket_counts(summary["probeStatusCounts"]),
    }


def _euler_evk_liquidation(
    item: Monitor,
    now: float,
    watch_read: JsonRead,
    surface_read: JsonRead,
    valuation_read: JsonRead,
) -> dict[str, Any]:
    """Aggregate the Euler EVK watch, surface, and valuation observations fail-closed."""

    watch = _euler_watch_section(watch_read, now)
    surface = _euler_surface_section(surface_read, now)
    valuation = _euler_valuation_section(valuation_read, now)

    warnings: list[str] = []
    if not watch["available"]:
        warnings.append("Euler EVK watch status is unavailable or invalid")
    if not surface["available"]:
        warnings.append("Euler EVK surface observation is unavailable or invalid")
    if not valuation["available"]:
        warnings.append("Euler EVK valuation artifact is unavailable or invalid")

    if watch["available"]:
        fresh, age = watch["freshness"], watch["age"]
        liquidatable = watch["sweep"]["liquidatable_vaults"]
        healthy = watch["ok"] and watch["sweep_completed"] and watch["live_state_read"]
        if not healthy:
            observation = "ERROR"
            warnings.append("Euler watch did not complete a successful live observation")
        elif liquidatable > 0:
            observation = "WATCH"
        elif not watch["fail_closed"] and surface["available"] and surface["coverage_complete"]:
            observation = "CLEAR"
        else:
            observation = "UNKNOWN"
        source_health = "OK" if healthy else "ERROR"
    else:
        fresh, age = "UNKNOWN", None
        observation = "UNKNOWN"
        source_health = "INVALID" if watch_read.source else "UNKNOWN"

    sweep = watch.get("sweep", {})
    metrics = _metrics(
        (
            ("sweep vaults swept", sweep.get("vaults_swept")),
            ("sweep liquidatable vaults", sweep.get("liquidatable_vaults")),
            ("sweep completed", watch.get("sweep_completed")),
            ("surface evVaultCount", surface.get("ev_vault_count")),
            ("surface liquidate events", surface.get("liquidate_event_count")),
            ("surface vaults with liquidations", surface.get("vaults_with_liquidations")),
            ("surface coverage complete", surface.get("coverage_complete")),
            ("valuation candidates evaluated", valuation.get("candidates_evaluated")),
            ("valuation net positive", valuation.get("net_positive")),
        )
    )

    return {
        "observation": observation,
        "freshness": fresh,
        "age": age,
        "alarm": _alarm(item, observation, fresh),
        "metrics": metrics,
        "provenance": [
            "euler-l-watch-status",
            "euler-l",
            "euler-l-valuation",
        ],
        "warnings": warnings,
        "observation_at": watch.get("generated_at"),
        "source_health": source_health,
        "euler_evk_liquidation": {
            "watch": watch,
            "surface": surface,
            "valuation": valuation,
            "route_positive": False,
            "fail_closed_notice": "readonly · routePositive:false · signedActionJustified:false",
        },
    }


def _bounded_artifact_time(key: str, state: dict[str, Any]) -> Any:
    if key.startswith("live_execution_batch_"):
        return state.get("approvedAt") or state.get("issuedAt")
    if key == "deployed_bytecode_verification":
        summary = state.get("summary")
        return summary.get("checkedAt") if isinstance(summary, dict) else None
    return state.get("generatedAt") or state.get("scannedAt") or state.get("completedAt")


def _bounded_artifact_valid(key: str, state: Any) -> bool:
    """Validate the fields consumed by the bounded-evidence catalog rows."""

    if not isinstance(state, dict) or timestamp(_bounded_artifact_time(key, state)) is None:
        return False
    if key.startswith("live_execution_batch_"):
        return (
            state.get("schema") in ("live-execution-batch/v1", "live-execution-batch/v2", "live-execution-batch/v3")
            and timestamp(state.get("expiresAt")) is not None
        )
    if key == "deployed_bytecode_verification":
        return bytecode_verification_valid(state) and all(
            _aave_count(state["summary"].get(field)) for field in ("total", "mismatches", "missing")
        )
    if key == "silo_default_step1":
        gaps = state.get("gaps")
        return (
            state.get("scanner") == "tools/fork-poc/silo-default-keeper.js"
            and state.get("mode") == "offline-scenario-plan"
            and isinstance(gaps, list) and len(gaps) <= 1000
            and all(isinstance(gap, dict) and isinstance(gap.get("status"), str) for gap in gaps)
        )
    schemas = {"fluid_exit_depth": "fluid-exit-depth/v1", "fluid_t2t4_rehearsal": "fluid-t2t4-fork-rehearsal/v1"}
    rows = state.get("rows")
    return (
        key in schemas and state.get("schema") == schemas[key]
        and isinstance(rows, list) and len(rows) <= 10_000
        and all(isinstance(row, dict) and isinstance(row.get("state"), str) for row in rows)
    )


def _bounded_artifact_record(item: Monitor, key: str, read: JsonRead, now: float) -> dict[str, Any]:
    result = _unknown()
    result["provenance"] = [key]
    if not read.current:
        result.update(
            source_health="ERROR" if read.source else "UNKNOWN",
            warnings=["Bounded artifact is unavailable or invalid; cached evidence is historical only"],
        )
        return result

    state = read.value
    observed_at = _bounded_artifact_time(key, state)
    fresh, age = freshness(observed_at, now, *item.freshness_limits())
    observation = "AVAILABLE"
    warnings = ["Bounded producer evidence; no live execution or route authorization is established"]
    if key.startswith("live_execution_batch_"):
        observation = "EXPIRED" if timestamp(state["expiresAt"]) <= now else "PRESENT_UNVERIFIED"
        metrics = [("reported expiry", _iso_time(state["expiresAt"])), ("signature verification", "NOT_VERIFIED")]
    elif key == "deployed_bytecode_verification":
        summary = state["summary"]
        metrics = [(field, summary[field]) for field in ("total", "mismatches", "missing")]
        if summary["mismatches"] or summary["missing"]:
            observation = "WATCH"
    elif key == "silo_default_step1":
        observation = "ERROR" if "error" in state else "PLAN"
        metrics = [("gaps", len(state["gaps"])), ("fork executed", state.get("ranFork") is True)]
    elif key == "fluid_exit_depth":
        metrics = [("rows", len(state["rows"])), ("reported executable after sizing", sum(row.get("executableAfterSizing") is True for row in state["rows"]))]
    else:
        passed = sum(row["state"] == "PASS" for row in state["rows"])
        failed = len(state["rows"]) - passed
        observation = "ERROR" if state.get("state") == "FAIL_CLOSED" else "WATCH" if failed else "AVAILABLE"
        metrics = [("rows", len(state["rows"])), ("rehearsal pass", passed), ("fail closed", failed)]
        warnings.append("Rehearsals can be mock-driven; a reported pass is not live execution proof")
    result.update(
        observation=observation, freshness=fresh, age=age, alarm="NONE",
        metrics=_metrics(metrics), warnings=warnings, observation_at=_iso_time(observed_at),
        source_health="ERROR" if observation == "ERROR" else "OK",
    )
    return result


def snapshot(reader: Any, now: float | None = None) -> dict[str, Any]:
    """Build a deterministic, presentation-safe dashboard snapshot."""

    if now is None:
        now = datetime.now(timezone.utc).timestamp()
    state_read = reader.read_json("state")
    safe_state = state_read.value if isinstance(state_read.value, dict) else {}
    venus_read = reader.read_json("venus_psr", validator=venus_state_valid)
    aave_v4_read = reader.read_json("aave_v4", validator=aave_v4_state_valid)
    research_read = reader.read_json("research_watch", validator=research_watch_state_valid)
    current_audit_read = reader.read_json(
        "current_audit_state", validator=current_audit_state_valid
    )
    stex_read = reader.read_json("stex_profit_trigger", validator=stex_profit_trigger_valid)
    etherfi_read = reader.read_json(
        "etherfi_debtmanager_profit_trigger", validator=etherfi_debtmanager_profit_trigger_valid
    )
    lista_read = reader.read_json(
        "lista_auction_incentive_profit_trigger", validator=lista_auction_incentive_profit_trigger_valid
    )
    aave_events_read = reader.read_json(
        "aave_v3_arbitrum_config_oracle_events", validator=aave_v3_arbitrum_config_oracle_events_valid
    )
    aave_v3_watch_read = reader.read_json(
        "aave_v3_liquidation_watch", validator=aave_v3_liquidation_watch_valid
    )
    aave_v3_readiness_read = reader.read_json(
        "aave_v3_trigger_readiness", validator=aave_v3_trigger_readiness_valid
    )
    aave_v3_exact_read = reader.read_json(
        "aave_v3_liquidation_exact_quotes",
        validator=lambda value: aave_v3_liquidation_quotes_valid(value, AAVE_V3_EXACT_QUOTES_SCHEMA),
    )
    aave_v3_trigger_quotes_read = reader.read_json(
        "aave_v3_liquidation_trigger_quotes",
        validator=lambda value: aave_v3_liquidation_quotes_valid(value, AAVE_V3_TRIGGER_QUOTES_SCHEMA),
    )
    aave_v3_universe_read = reader.read_json(
        "aave_v3_borrower_universe", validator=aave_v3_borrower_universe_valid
    )
    morpho_eth_read = reader.read_json(
        "morpho_blue_liquidatable", validator=morpho_blue_liquidatable_valid
    )
    morpho_base_read = reader.read_json(
        "morpho_blue_liquidatable_base", validator=morpho_blue_liquidatable_valid
    )
    morpho_ws_read = reader.read_json("morpho_ws_status", validator=morpho_ws_status_valid)
    euler_watch_read = reader.read_json("euler_l_watch", validator=euler_l_watch_valid)
    euler_surface_read = reader.read_json("euler_l_surface", validator=euler_l_surface_valid)
    euler_valuation_read = reader.read_json("euler_l_valuation", validator=euler_l_valuation_valid)
    scheduler_read = reader.read_json("trigger_watch_scheduler", validator=trigger_watch_scheduler_valid)
    sentinel_read = reader.read_json(
        "official_deployed_delta_sentinel", validator=official_deployed_delta_sentinel_valid
    )
    polymarket_r17_read = reader.read_json("polymarket_r17", validator=polymarket_r17_valid)
    polymarket_r19_read = reader.read_json("polymarket_r19", validator=polymarket_r19_valid)
    polymarket_r20_read = reader.read_json("polymarket_r20", validator=polymarket_r20_valid)
    deployment_read = reader.read_json("ostium_deployment")
    settlement_read = reader.read_json("ostium_settlement")
    bounded_reads = {
        key: reader.read_json(key, validator=lambda state, key=key: _bounded_artifact_valid(key, state))
        for key in BOUNDED_ARTIFACTS.values()
    }

    records = []
    for item in CATALOG:
        if item.id == "ostium-stale-mark":
            value = _ostium(
                item,
                now,
                deployment_read.value,
                settlement_read.value,
            )
            if not deployment_read.current or not settlement_read.current:
                failed = deployment_read if not deployment_read.current else settlement_read
                value = _cached_override(value, failed)
                value["metrics"] = []
        elif item.source == "AAVE_V4":
            value = _aave_v4(item, now, aave_v4_read.value)
            if not aave_v4_read.current:
                value = _cached_override(value, aave_v4_read)
        elif item.source == "VENUS_PSR":
            value = _venus_psr(item, now, venus_read.value)
            if not venus_read.current:
                value = _cached_override(value, venus_read)
                value["producer_health"]["legacy_context"] = (
                    "cached Venus PSR producer state is historical only"
                    if venus_read.cached
                    else "Venus PSR producer state is unavailable"
                )
        elif item.source == "RESEARCH_WATCH":
            value = _research_watch(item, research_read.value)
            if not research_read.current:
                value = _cached_override(value, research_read)
        elif item.source == "POLYMARKET_R17":
            value = _polymarket_r17_record(
                item, polymarket_r17_read.value, now, polymarket_r17_read.current
            )
        elif item.source == "POLYMARKET_R19":
            value = _polymarket_r19_record(item, polymarket_r19_read.value, polymarket_r19_read.current, now)
        elif item.source == "POLYMARKET_R20":
            value = _polymarket_r20_record(item, polymarket_r20_read.value, polymarket_r20_read.current, now)
        elif item.source == "AAVE_V3_LIQ_WATCH":
            value = _aave_v3_liquidation(
                item,
                now,
                aave_v3_watch_read,
                aave_v3_readiness_read,
                aave_v3_exact_read,
                aave_v3_trigger_quotes_read,
                aave_v3_universe_read,
            )
            if not aave_v3_watch_read.current:
                value = _cached_override(value, aave_v3_watch_read)
        elif item.source == "MORPHO_BLUE_LIQ":
            value = _morpho_blue_liquidation(item, now, morpho_eth_read, morpho_base_read, morpho_ws_read)
            if not morpho_eth_read.current:
                value = _cached_override(value, morpho_eth_read)
        elif item.source == "EULER_EVK_LIQ":
            value = _euler_evk_liquidation(
                item, now, euler_watch_read, euler_surface_read, euler_valuation_read
            )
            if not euler_watch_read.current:
                value = _cached_override(value, euler_watch_read)
        elif item.id in BOUNDED_ARTIFACTS:
            key = BOUNDED_ARTIFACTS[item.id]
            value = _bounded_artifact_record(item, key, bounded_reads[key], now)
        else:
            value = _adapter(item, safe_state, now)
            if item.source == "STATE" and not state_read.current:
                value = _cached_override(value, state_read)
        if "producer_health" not in value:
            legacy_context = None
            if item.source == "STATE" and value.get("freshness") == "STALE":
                legacy_context = "legacy STATE producer observation is stale"
            elif item.source == "STATE" and value.get("freshness") == "UNKNOWN":
                legacy_context = "legacy STATE producer has no current observation"
            value["producer_health"] = _producer_health(
                item,
                value,
                legacy_context=legacy_context,
            )
        value.update(
            id=item.id,
            name=item.name,
            disposition=item.disposition,
            note=item.note,
            protocol=item.protocol,
            mode=item.mode,
            cadence=item.cadence,
        )
        if item.id == "lista-auction-incentive":
            value["lista_trigger"] = _lista_auction_incentive_profit_trigger(
                lista_read.value, now, lista_read.current
            )
        current_status = (
            value["observation"]
            if value.get("source_health") == "OK"
            and value.get("freshness") in CURRENT_FRESHNESS
            and value.get("observation") not in {"UNKNOWN", "ERROR"}
            else "UNKNOWN"
        )
        value.update(
            status=current_status,
            status_source=item.source,
            status_at=value.get("observation_at") if current_status != "UNKNOWN" else None,
        )
        records.append(value)

    research_watches, due_reviews = _research_views(
        research_read.value if research_read.current else None,
        now,
    )
    alerts, malformed = _alerts(reader, now, records, due_reviews)
    counts = Counter(record["disposition"] for record in records)
    continuous = [record for record in records if record["mode"] == "CONTINUOUS"]
    no_live = not any(
        record["source_health"] == "OK"
        and record["freshness"] in CURRENT_FRESHNESS
        and record["observation"] not in {"UNKNOWN", "ERROR"}
        for record in continuous
    )
    alarm_counts = {
        "current": sum(alert["alarm"] == "CURRENT" for alert in alerts),
        "historical": sum(alert["alarm"] == "HISTORICAL" for alert in alerts),
    }
    current_alarms = [alert for alert in alerts if alert["alarm"] == "CURRENT"]
    historical_alarms = [alert for alert in alerts if alert["alarm"] != "CURRENT"]
    stex_trigger = _stex_profit_trigger(stex_read.value, now, stex_read.current)
    etherfi_trigger = _etherfi_debtmanager_profit_trigger(etherfi_read.value, now, etherfi_read.current)
    lista_trigger = _lista_auction_incentive_profit_trigger(lista_read.value, now, lista_read.current)
    aave_events = _aave_v3_arbitrum_config_oracle_events(aave_events_read.value, now, aave_events_read.current)
    continuous_watch = _continuous_watch(
        scheduler_read.value,
        sentinel_read.value,
        {"stex": stex_trigger, "etherfi": etherfi_trigger, "lista": lista_trigger, "aave": aave_events},
        now,
        scheduler_read.current,
        sentinel_read.current,
    )
    base_paper = _base_paper(reader, now)
    return {
        "generated_at": datetime.fromtimestamp(now, timezone.utc).isoformat(),
        "monitors": records,
        "alarms": alerts,
        "current_alarms": current_alarms,
        "historical_alarms": historical_alarms,
        "alarm_counts": alarm_counts,
        "counts": dict(counts),
        "parser": {"malformed_alert_records": malformed},
        "producer_health": {
            "legacy_state_current_read": state_read.current,
            "venus_psr_current_read": venus_read.current,
            "aave_v4_current_read": aave_v4_read.current,
            "research_watch_current_read": research_read.current,
            "current_audit_state_current_read": current_audit_read.current,
            "stex_profit_trigger_current_read": stex_read.current,
            "etherfi_debtmanager_profit_trigger_current_read": etherfi_read.current,
            "lista_auction_incentive_profit_trigger_current_read": lista_read.current,
            "aave_v3_arbitrum_config_oracle_events_current_read": aave_events_read.current,
            "aave_v3_liquidation_watch_current_read": aave_v3_watch_read.current,
            "aave_v3_trigger_readiness_current_read": aave_v3_readiness_read.current,
            "aave_v3_liquidation_exact_quotes_current_read": aave_v3_exact_read.current,
            "aave_v3_liquidation_trigger_quotes_current_read": aave_v3_trigger_quotes_read.current,
            "aave_v3_borrower_universe_current_read": aave_v3_universe_read.current,
            "morpho_blue_liquidatable_current_read": morpho_eth_read.current,
            "morpho_blue_liquidatable_base_current_read": morpho_base_read.current,
            "morpho_ws_status_current_read": morpho_ws_read.current,
            "euler_l_watch_current_read": euler_watch_read.current,
            "euler_l_surface_current_read": euler_surface_read.current,
            "euler_l_valuation_current_read": euler_valuation_read.current,
            "trigger_watch_scheduler_current_read": scheduler_read.current,
            "official_deployed_delta_sentinel_current_read": sentinel_read.current,
            "polymarket_r17_current_read": polymarket_r17_read.current,
            "polymarket_r19_current_read": polymarket_r19_read.current,
            "polymarket_r20_current_read": polymarket_r20_read.current,
            "legacy_context": "legacy STATE producer remains viewer-only and may be stale",
        },
        "research_watches": research_watches,
        "current_audit_state": _current_audit_state(
            current_audit_read.value, now, current_audit_read.current
        ),
        "stex_profit_trigger": stex_trigger,
        "etherfi_debtmanager_profit_trigger": etherfi_trigger,
        "lista_auction_incentive_profit_trigger": lista_trigger,
        "aave_v3_arbitrum_config_oracle_events": aave_events,
        "continuous_watch": continuous_watch,
        "base_paper": base_paper,
        "polymarket_r17": _polymarket_r17(
            polymarket_r17_read.value, now, polymarket_r17_read.current
        ),
        "polymarket_r19": _polymarket_r19(
            polymarket_r19_read.value, polymarket_r19_read.current, now
        ),
        "polymarket_r20": _polymarket_r20(
            polymarket_r20_read.value, available=polymarket_r20_read.current, now=now
        ),
        "no_current_live_status": no_live,
        **build_ops(reader, now),
    }
