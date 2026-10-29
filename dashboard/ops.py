"""Read-only operational panels: campaign coverage, pipeline, mode, and wallets.

Every value here is a normalized, presentation-safe projection of an exact
allowlisted artifact. Free text is scrubbed of paths, URLs, and credential
tokens; unknown or absent evidence is never rendered as a positive state and no
panel ever executes, signs, broadcasts, or mutates anything.
"""

from __future__ import annotations

import os
import re
from datetime import datetime, timezone
from typing import Any

from .normalize import AGING, FRESH, STALE, UNKNOWN, freshness, timestamp
from .execution import EXECUTION_REASON, execution_view
from .wallets import SOLANA_PATTERN, collector_status, valid_solana_address, watch_address_entries

COVERAGE_SCHEMA = "trigger-coverage-audit/v1"
PROFIT_TRIGGER_WATCH_SCHEMA = "profit-trigger-watch/v1"
AUTOPILOT_STATUS_SCHEMA = "trigger-fork-autopilot-status/v1"
AUTOPILOT_STATE_SCHEMA = "trigger-fork-autopilot-state/v1"
ALERT_DISPATCHER_SCHEMA = "monitor-alert-dispatcher-status/v1"
WATCHDOG_SCHEMA = "monitor-set-watchdog-status/v1"
APPROVER_REGISTRY_SCHEMA = "live-execution-approver-registry/v1"
WALLET_BALANCES_SCHEMA = "wallet-balances/v1"

COVERAGE_STATUSES = ("COVERED", "BLOCKED", "MISSING", "STALE", "OTHER")
FORBIDDEN_TEXT = re.compile(
    r"(?:\bauthorization\s*[:=]\s*(?:bearer|basic)\s+[^\s,;\"']*"
    r"|\b(?:(?:private|api|secret)[_-]?key|token|password|mnemonic)\s*[:=]\s*(?:\"[^\"]*\"|'[^']*'|[^\s,;]+)"
    r"|reports[\\/][^\s,;\"']*"
    r"|[A-Za-z]:[\\/][^\s,;\"']*"
    r"|/(?:home|Users|var|tmp|etc)/[^\s,;\"']*"
    r"|(?:https?|wss?)://[^\s,;\"']*"
    r"|\.env(?:\.[A-Za-z0-9_.-]+)?"
    r"|\b(?:rpc_endpoints|graphql_endpoints)\b"
    r"|\b(?:private|api|secret)[_-]?key\b"
    r"|\bmnemonic\b)",
    re.IGNORECASE,
)
STATUS_PATTERN = re.compile(r"[A-Z][A-Z0-9_]{0,47}")
ID_PATTERN = re.compile(r"[a-z0-9][a-z0-9-]{1,79}")
HEX64 = re.compile(r"[0-9a-f]{64}")
ADDRESS = re.compile(r"0x[0-9a-fA-F]{40}")
SYMBOL = re.compile(r"[A-Za-z0-9][A-Za-z0-9._+-]{0,31}")
RAW = re.compile(r"[0-9]{1,78}")
AMOUNT = re.compile(r"-?[0-9][0-9,._ ]{0,39}")
USD_2DP = re.compile(r"-?(?:0|[1-9][0-9]*)\.[0-9]{2}")
DECIMAL = re.compile(r"[0-9]{1,20}")
SCOPE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
ALGORITHM = re.compile(r"[A-Za-z0-9][A-Za-z0-9._+-]{0,31}")
CHAIN_NAMES = {
    1: "Ethereum",
    10: "Optimism",
    56: "BNB Chain",
    137: "Polygon",
    8453: "Base",
    42161: "Arbitrum",
    999: "HyperEVM",
}
CHAIN_SLUGS = {
    "ethereum": 1,
    "eth": 1,
    "base": 8453,
    "arbitrum": 42161,
    "optimism": 10,
    "bnb": 56,
    "bsc": 56,
    "polygon": 137,
    "hyperevm": 999,
    "hyper": 999,
}
BATCH_APPROVED_STATES = {"APPROVED", "ACTIVE", "VALID", "AUTHORIZED", "SIGNED"}
BATCH_EXPIRY_KEYS = ("expiresAt", "expires_at", "expiry", "expiryAt", "validUntil", "notAfter")
BATCH_STATUS_KEYS = ("status", "state", "batchStatus")
BATCH_ACTION_KEYS = ("actions", "operations", "calls", "steps", "transactions")
BATCH_APPROVER_KEYS = ("approvers", "approvals", "signers", "authorizations")
WATCH_ADDRESS_KEYS = ("addresses", "watchlist", "watchAddresses", "entries", "wallets")
DISPATCH_DISABLED = ("dispatch is disabled", "dispatch disabled", "dispatch: disabled", "on-fire dispatch disabled")
DISPATCH_ENABLED = ("dispatch is enabled", "dispatch enabled", "dispatch: enabled", "on-fire dispatch enabled")

# Offensive-program artifacts (fix-30 panel). Each read is strict and fail-closed.
FLEET_DEPLOY_SCHEMA = "euler-fleet-deploy-status/v1"
AUTOFIRE_LOOP_SCHEMA = "autofire-loop/v1"
FASTLANE_SCHEMA = "euler-fastlane-watch/v1"
SILO_WATCH_SCHEMA = "silo-default-watch/v1"
ENVELOPE_SCHEMA = "live-execution-batch/v1"
FILE_FRESH_SECONDS = 300.0
BATCH_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")
CAPS_TOTAL_KEYS = ("signedExecutionsTotal", "signedExecutions", "maxSignedExecutionsPerDay", "signedDeploymentsTotal")
# Fixed enumeration: the allowlisted envelope keys plus the three previously
# unwired envelopes (fleet-2, scroll-retry, euler-autofire) and the unified V4/V3 Morpho batch.
BATCH_ENVELOPE_SOURCES = (
    ("live_execution_batch", "root / liquity"),
    ("live_execution_batch_euler_trigger", "euler trigger"),
    ("live_execution_batch_euler_trigger_2", "euler trigger 2"),
    ("live_execution_batch_euler_trigger_3", "euler trigger 3"),
    ("live_execution_batch_euler_fleet_2", "euler fleet 2"),
    ("live_execution_batch_aave_trigger", "aave trigger"),
    ("live_execution_batch_morpho_trigger", "morpho trigger"),
    ("live_execution_batch_eth_bridge_scroll_retry", "eth-bridge scroll retry"),
    ("live_execution_batch_euler_autofire", "euler autofire"),
    ("live_execution_batch_aave_v4_v3_morpho", "aave v4/v3 morpho"),
    ("live_execution_batch_aave_v4_executor", "aave v4 executor"),
)
TOP_WHALE_TRIGGERS_SCHEMA = "top-whale-triggers-status/v1"
BASE_USDE_MARKET = "0x54cf9be57fdfa6457a660991907434ff9d295c465a603a50126ff647d50b7354"
BASE_YOUSD_MARKET = "0x1a3e69d0109bb1be42b80e11034bb6ee98fc466721f26845dc83b2aa8d979137"
BASE_YOUSD_BORROWER = "0x108b853407284e77656c569677c82e8fed581299"
MASK_LABEL_PREFIXES = ("EULER-LIQ-V3-F", "FLUID")


def _bounded_int(value: Any, maximum: int = 1_000_000_000) -> bool:
    return not isinstance(value, bool) and isinstance(value, int) and 0 <= value <= maximum


def _nonneg_number(value: Any) -> bool:
    return not isinstance(value, bool) and isinstance(value, (int, float)) and value >= 0


def _iso(value: Any) -> str | None:
    observed = timestamp(value)
    if observed is None:
        return None
    try:
        return datetime.fromtimestamp(observed, timezone.utc).isoformat()
    except (OverflowError, OSError, ValueError):
        return None


def scrub_text(value: Any, limit: int = 240) -> str | None:
    """Return bounded, single-line text with paths, URLs, and key tokens removed."""

    if not isinstance(value, str):
        return None
    text = "".join(" " if ord(ch) < 32 and ch != "\t" else ch for ch in value)
    text = FORBIDDEN_TEXT.sub("…", text)
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return None
    return text[:limit]


def _short_address(value: Any) -> str | None:
    if not isinstance(value, str) or ADDRESS.fullmatch(value) is None:
        return None
    return f"{value[:6]}…{value[-4:]}"


def _short_base58(value: Any) -> str | None:
    if not isinstance(value, str) or SOLANA_PATTERN.fullmatch(value) is None:
        return None
    return f"{value[:4]}…{value[-4:]}"


def _short_for(address: Any, family: Any) -> str | None:
    return _short_base58(address) if family == "solana" else _short_address(address)


def _usd_text(value: Any) -> str | None:
    """Accept only an explicit 2-decimal USD string; anything else is unpriced."""

    if not isinstance(value, str):
        return None
    text = value.strip()
    if len(text) > 40 or USD_2DP.fullmatch(text) is None:
        return None
    return text


def _price_source(value: Any) -> str | None:
    """Accept only the two declared price-source states; anything else is unknown."""

    return value if value in ("defillama", "unavailable") else None


def _sum_usd(values: Any) -> str | None:
    """Sum explicit 2dp USD strings; unknown when empty or any value is unpriced.

    Uses integer cents so the total is never distorted by floating point.
    """

    if not isinstance(values, list) or not values:
        return None
    cents = 0
    for value in values:
        if not isinstance(value, str) or USD_2DP.fullmatch(value) is None:
            return None
        negative = value.startswith("-")
        whole, _, fraction = (value[1:] if negative else value).partition(".")
        amount = int(whole) * 100 + int(fraction)
        cents += -amount if negative else amount
    sign = "-" if cents < 0 else ""
    magnitude = abs(cents)
    return f"{sign}{magnitude // 100}.{magnitude % 100:02d}"


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


def _freshness_view(value: Any, now: float, aging: float = 900, stale: float = 3_600) -> tuple[str, float | None]:
    return freshness(value, now, aging, stale)


def f(value: Any, default: str = "—") -> str:
    """Guarded scalar formatter for the offensive panel; never raises."""

    if value is None:
        return default
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    text = scrub_text(value, 96)
    return text if text else default


def humanCountdown(expires_at: Any, now: float) -> str | None:
    """Human countdown to an expiry; None when the timestamp is unparseable.

    Only a parseable expiry yields text, so a template can never invent a
    countdown from a missing or malformed value.
    """

    target = timestamp(expires_at)
    if target is None:
        return None
    remaining = target - now
    if remaining <= 0:
        return "expired"
    seconds = int(remaining)
    days, seconds = divmod(seconds, 86_400)
    hours, seconds = divmod(seconds, 3_600)
    minutes = seconds // 60
    if days:
        return f"{days}d {hours}h"
    if hours:
        return f"{hours}h {minutes}m"
    return f"{minutes}m"


def _file_age(reader: Any, key: str, now: float) -> float | None:
    """File mtime age in seconds, or None when it cannot be established."""

    try:
        info = os.stat(reader.path(key))
    except (OSError, AttributeError, KeyError):
        return None
    return max(0.0, now - info.st_mtime)


def _mtime_freshness(age: float | None) -> str:
    if age is None:
        return UNKNOWN
    return FRESH if age <= FILE_FRESH_SECONDS else STALE


# --------------------------------------------------------------------------- #
# Campaign coverage
# --------------------------------------------------------------------------- #


def trigger_coverage_valid(state: Any) -> bool:
    if not isinstance(state, dict) or state.get("schema") != COVERAGE_SCHEMA:
        return False
    if timestamp(state.get("auditedAt")) is None:
        return False
    digest = state.get("universeSha256")
    if not (isinstance(digest, str) and HEX64.fullmatch(digest)):
        return False
    if not isinstance(state.get("done"), bool):
        return False
    rows = state.get("rows")
    if not isinstance(rows, list) or len(rows) > 256:
        return False
    for row in rows:
        if not isinstance(row, dict):
            return False
        row_id = row.get("id")
        status = row.get("status")
        if not (isinstance(row_id, str) and ID_PATTERN.fullmatch(row_id)):
            return False
        if not (isinstance(status, str) and STATUS_PATTERN.fullmatch(status)):
            return False
        if timestamp(row.get("observedAt")) is None:
            return False
        if row.get("expiresAt") is not None and timestamp(row["expiresAt"]) is None:
            return False
        sha = row.get("artifactSha256")
        if sha is not None and not (isinstance(sha, str) and HEX64.fullmatch(sha)):
            return False
        for field in ("evidence", "blockers"):
            items = row.get(field)
            if not isinstance(items, list) or len(items) > 64:
                return False
            if any(not isinstance(item, str) or len(item) > 400 for item in items):
                return False
    return True


def _row_chain_family(row: dict[str, Any]) -> tuple[str, str]:
    slug = row["id"].split("-", 1)[0]
    chain_id = row.get("chainId")
    if isinstance(chain_id, int) and not isinstance(chain_id, bool) and chain_id in CHAIN_NAMES:
        chain = CHAIN_NAMES[chain_id]
    elif slug in CHAIN_SLUGS:
        chain = CHAIN_NAMES[CHAIN_SLUGS[slug]]
    else:
        chain = "Unknown chain"
    family_value = row.get("family")
    family: str = family_value if isinstance(family_value, str) else row["id"].split("-", 1)[-1]
    return chain, family


def build_trigger_coverage(state: Any, now: float, available: bool) -> dict[str, Any]:
    empty = {
        "available": False,
        "freshness": UNKNOWN,
        "age": None,
        "age_text": None,
        "audited_at": None,
        "done": None,
        "total": 0,
        "counts": {key: 0 for key in COVERAGE_STATUSES},
        "rows": [],
        "blocked_count": 0,
        "stale_count": 0,
        "warnings": ["Trigger coverage audit is unavailable or invalid"],
    }
    if not available or not trigger_coverage_valid(state):
        return empty

    fresh, age = _freshness_view(state["auditedAt"], now)
    counts = {key: 0 for key in COVERAGE_STATUSES}
    rows: list[dict[str, Any]] = []
    for raw in state["rows"]:
        status = raw["status"]
        expires = timestamp(raw.get("expiresAt"))
        is_stale = status == "COVERED" and expires is not None and expires < now
        effective = "STALE" if is_stale else (status if status in counts else "OTHER")
        counts[effective] += 1
        chain, family = _row_chain_family(raw)
        blockers = [text for text in (scrub_text(item, 200) for item in raw["blockers"]) if text]
        observed_at = timestamp(raw["observedAt"])
        row_age = max(0.0, now - observed_at) if observed_at is not None else None
        rows.append(
            {
                "id": raw["id"],
                "chain": chain,
                "family": family,
                "status": effective,
                "raw_status": status,
                "observed_at": _iso(raw["observedAt"]),
                "age": row_age,
                "age_text": _age_text(row_age),
                "expiry_at": _iso(raw.get("expiresAt")),
                "stale": is_stale,
                "blockers": blockers,
                "blocker_count": len(blockers),
                "evidence_count": len(raw["evidence"]),
            }
        )
    status_rank = {"BLOCKED": 0, "MISSING": 1, "STALE": 2, "COVERED": 3, "OTHER": 4}
    rows.sort(key=lambda row: (status_rank.get(row["status"], 5), row["id"]))
    warnings = []
    if fresh == STALE:
        warnings.append("Coverage audit timestamp is stale; statuses are historical context only")
    elif fresh == "CLOCK_SKEW":
        warnings.append("Coverage audit timestamp is ahead of the local clock")
    if counts["BLOCKED"]:
        warnings.append(f"{counts['BLOCKED']} campaign row(s) are blocked")
    if counts["STALE"]:
        warnings.append(f"{counts['STALE']} covered row(s) have expired their freshness window")
    return {
        "available": True,
        "freshness": fresh,
        "age": age,
        "age_text": _age_text(age),
        "audited_at": _iso(state["auditedAt"]),
        "done": state["done"],
        "total": len(rows),
        "counts": counts,
        "rows": rows,
        "blocked_count": counts["BLOCKED"],
        "stale_count": counts["STALE"],
        "warnings": warnings,
    }


# --------------------------------------------------------------------------- #
# Profit trigger watch + autopilot
# --------------------------------------------------------------------------- #


def profit_trigger_watch_valid(state: Any) -> bool:
    if not isinstance(state, dict) or state.get("schema") != PROFIT_TRIGGER_WATCH_SCHEMA:
        return False
    if timestamp(state.get("generatedAt")) is None or not isinstance(state.get("running"), bool):
        return False
    producers = state.get("producers")
    if not isinstance(producers, list) or len(producers) > 64:
        return False
    for producer in producers:
        if not isinstance(producer, dict):
            return False
        if not isinstance(producer.get("id"), str) or ID_PATTERN.fullmatch(producer["id"]) is None:
            return False
        if not isinstance(producer.get("status"), str) or STATUS_PATTERN.fullmatch(producer["status"]) is None:
            return False
        if not isinstance(producer.get("reason"), str) or STATUS_PATTERN.fullmatch(producer["reason"]) is None:
            return False
        if not isinstance(producer.get("evidence"), dict):
            return False
        if timestamp(producer.get("generatedAt")) is None:
            return False
    safety = state.get("safety")
    if not isinstance(safety, dict):
        return False
    return bool(
        safety.get("localOnly") is True
        and safety.get("readOnly") is True
        and safety.get("transactionsInitiated") == 0
        and safety.get("signing") is False
        and safety.get("broadcast") is False
        and _bounded_int(safety.get("automaticRetries"))
    )


def build_profit_watch(state: Any, now: float, available: bool) -> dict[str, Any]:
    empty = {
        "available": False,
        "freshness": UNKNOWN,
        "age": None,
        "age_text": None,
        "generated_at": None,
        "running": None,
        "producers": [],
        "attention_count": 0,
        "safety": None,
        "warnings": ["Profit trigger watch is unavailable or invalid"],
    }
    if not available or not profit_trigger_watch_valid(state):
        return empty
    fresh, age = _freshness_view(state["generatedAt"], now)
    producers = []
    for producer in state["producers"]:
        p_fresh, p_age = _freshness_view(producer["generatedAt"], now)
        text = f"{producer['status']} {producer['reason']}".upper()
        attention = (
            "FAILED" in text
            or "TIMEOUT" in text
            or "ERROR" in text
            or p_fresh in {STALE, "CLOCK_SKEW"}
        )
        producers.append(
            {
                "id": producer["id"],
                "status": producer["status"],
                "reason": producer["reason"],
                "generated_at": _iso(producer["generatedAt"]),
                "age": p_age,
                "age_text": _age_text(p_age),
                "freshness": p_fresh,
                "attention": attention,
                "evidence_fields": len(producer["evidence"]),
            }
        )
    producers.sort(key=lambda row: (not row["attention"], row["id"]))
    return {
        "available": True,
        "freshness": fresh,
        "age": age,
        "age_text": _age_text(age),
        "generated_at": _iso(state["generatedAt"]),
        "running": state["running"],
        "producers": producers,
        "attention_count": sum(row["attention"] for row in producers),
        "safety": {
            "local_only": state["safety"].get("localOnly"),
            "read_only": state["safety"].get("readOnly"),
            "transactions_initiated": state["safety"].get("transactionsInitiated"),
            "signing": state["safety"].get("signing"),
            "broadcast": state["safety"].get("broadcast"),
        },
        "warnings": [] if fresh not in {STALE, "CLOCK_SKEW"} else ["Producer cycle timestamp is not current"],
    }


def autopilot_status_valid(state: Any) -> bool:
    if not isinstance(state, dict) or state.get("schema") != AUTOPILOT_STATUS_SCHEMA:
        return False
    if timestamp(state.get("generatedAt")) is None:
        return False
    if not isinstance(state.get("mode"), str) or not state["mode"]:
        return False
    if not isinstance(state.get("classification"), str) or STATUS_PATTERN.fullmatch(state["classification"]) is None:
        return False
    if state.get("blocker") is not None and not isinstance(state.get("blocker"), str):
        return False
    summary = state.get("summary")
    if not isinstance(summary, dict):
        return False
    for key in ("producers", "fired", "eligible", "planned", "executed", "succeeded", "failed", "deduped", "history"):
        if not _bounded_int(summary.get(key)):
            return False
    safety = state.get("safety")
    if not isinstance(safety, dict):
        return False
    if (
        safety.get("localOnly") is not True
        or safety.get("keyless") is not True
        or safety.get("noSigning") is not True
        or safety.get("noBroadcast") is not True
    ):
        return False
    plan = state.get("plan")
    if plan is not None and (not isinstance(plan, list) or len(plan) > 64):
        return False
    return True


def autopilot_state_valid(state: Any) -> bool:
    if not isinstance(state, dict) or state.get("schema") != AUTOPILOT_STATE_SCHEMA:
        return False
    if timestamp(state.get("updatedAt")) is None:
        return False
    events = state.get("events")
    if not isinstance(events, dict) or len(events) > 500:
        return False
    for value in events.values():
        if not isinstance(value, dict):
            return False
        if not isinstance(value.get("producerId"), str):
            return False
        if not isinstance(value.get("terminal"), bool) or not isinstance(value.get("promoted"), bool):
            return False
        if value.get("net") is not None and not isinstance(value.get("net"), str):
            return False
    history = state.get("history")
    if not isinstance(history, list) or len(history) > 500:
        return False
    return True


def build_autopilot(
    status_state: Any,
    state_state: Any,
    now: float,
    status_available: bool,
    state_available: bool,
) -> dict[str, Any]:
    status_ok = status_available and autopilot_status_valid(status_state)
    state_ok = state_available and autopilot_state_valid(state_state)
    result: dict[str, Any] = {
        "available": status_ok,
        "status_available": status_ok,
        "state_available": state_ok,
        "classification": None,
        "blocker": None,
        "generated_at": None,
        "freshness": UNKNOWN,
        "age": None,
        "age_text": None,
        "summary": None,
        "events": [],
        "promoted_count": 0,
        "history_count": 0,
        "safety": None,
        "warnings": [],
    }
    if status_ok:
        fresh, age = _freshness_view(status_state["generatedAt"], now)
        summary = status_state["summary"]
        result.update(
            classification=status_state["classification"],
            blocker=scrub_text(status_state.get("blocker"), 160),
            generated_at=_iso(status_state["generatedAt"]),
            freshness=fresh,
            age=age,
            age_text=_age_text(age),
            summary={
                "producers": summary["producers"],
                "fired": summary["fired"],
                "eligible": summary["eligible"],
                "planned": summary["planned"],
                "executed": summary["executed"],
                "succeeded": summary["succeeded"],
                "failed": summary["failed"],
                "deduped": summary["deduped"],
                "history": summary["history"],
            },
            safety={
                "local_only": status_state["safety"].get("localOnly"),
                "keyless": status_state["safety"].get("keyless"),
                "no_signing": status_state["safety"].get("noSigning"),
                "no_broadcast": status_state["safety"].get("noBroadcast"),
                "endpoint_material_persisted": status_state["safety"].get("endpointMaterialPersisted"),
            },
        )
        if fresh in {STALE, "CLOCK_SKEW"}:
            result["warnings"].append("Autopilot status timestamp is not current")
    else:
        result["warnings"].append("Autopilot status is unavailable or invalid")

    if state_ok:
        events = []
        for key, value in state_state["events"].items():
            at = value.get("lastAttemptAt") or value.get("firstSeenAt") or value.get("attemptedAt")
            events.append(
                {
                    "key": scrub_text(key, 120),
                    "producer_id": value["producerId"],
                    "terminal": value["terminal"],
                    "promoted": value["promoted"],
                    "net": scrub_text(value.get("net"), 80),
                    "phase": scrub_text(value.get("phase"), 40),
                    "result": scrub_text(value.get("result"), 40),
                    "blocker": scrub_text(value.get("blocker"), 80),
                    "at": _iso(at),
                    "epoch": timestamp(at) or float("-inf"),
                }
            )
        events.sort(key=lambda row: row["epoch"], reverse=True)
        for row in events:
            row.pop("epoch", None)
        result["events"] = events[:12]
        result["promoted_count"] = sum(1 for row in events if row["promoted"])
        result["history_count"] = len(state_state["history"])
        # Promoted evidence may sit in history without a current events entry.
        history_promoted = sum(
            1 for row in state_state["history"] if isinstance(row, dict) and row.get("promoted") is True
        )
        result["promoted_count"] = max(result["promoted_count"], history_promoted)
    else:
        result["warnings"].append("Autopilot state is unavailable or invalid")
    return result


# --------------------------------------------------------------------------- #
# Dispatcher + watchdog strips
# --------------------------------------------------------------------------- #


def dispatcher_status_valid(state: Any) -> bool:
    if not isinstance(state, dict) or state.get("schema") != ALERT_DISPATCHER_SCHEMA:
        return False
    if timestamp(state.get("generatedAt")) is None:
        return False
    if not isinstance(state.get("mode"), str) or not state["mode"]:
        return False
    if not isinstance(state.get("baselineEstablished"), bool):
        return False
    summary = state.get("summary")
    if not isinstance(summary, dict) or not summary:
        return False
    if any(not _bounded_int(value) for key, value in summary.items() if key != "retention"):
        return False
    if "retention" in summary:
        retention = summary["retention"]
        if (not isinstance(retention, dict)
            or set(retention) != {"deliveredAcknowledged", "pendingUnacknowledged", "legacyUnclassified"}
            or not all(_bounded_int(value) for value in retention.values())):
            return False
    last_run = state.get("lastRun")
    if last_run is not None and (
        not isinstance(last_run, dict)
        or not isinstance(last_run.get("result"), str)
        or STATUS_PATTERN.fullmatch(last_run["result"]) is None
    ):
        return False
    return True


def build_dispatcher(state: Any, now: float, available: bool) -> dict[str, Any]:
    empty = {
        "available": False,
        "generated_at": None,
        "freshness": UNKNOWN,
        "age": None,
        "age_text": None,
        "mode": None,
        "baseline_established": None,
        "summary": None,
        "last_run_result": None,
        "attention": False,
        "warnings": ["Alert dispatcher status is unavailable or invalid"],
    }
    if not available or not dispatcher_status_valid(state):
        return empty
    fresh, age = _freshness_view(state["generatedAt"], now)
    summary = state["summary"]
    last_run = state.get("lastRun") or {}
    attention = bool(
        summary.get("deliveryUnavailable", 0)
        or summary.get("dropped", 0)
        or (last_run.get("result") not in (None, "PASS"))
        or fresh in {STALE, "CLOCK_SKEW"}
    )
    return {
        "available": True,
        "generated_at": _iso(state["generatedAt"]),
        "freshness": fresh,
        "age": age,
        "age_text": _age_text(age),
        "mode": scrub_text(state["mode"], 16),
        "baseline_established": state["baselineEstablished"],
        "summary": {
            "observations": summary.get("observations"),
            "would_alert": summary.get("wouldAlert"),
            "enqueued": summary.get("enqueued"),
            "dispatched": summary.get("dispatched"),
            "delivered": summary.get("delivered"),
            "delivery_unavailable": summary.get("deliveryUnavailable"),
            "pending": summary.get("pending"),
            "queue_size": summary.get("queueSize"),
            "dropped": summary.get("dropped"),
        },
        "last_run_result": scrub_text(last_run.get("result"), 24),
        "attention": attention,
        "warnings": [],
    }


def watchdog_status_valid(state: Any) -> bool:
    if not isinstance(state, dict) or state.get("schema") != WATCHDOG_SCHEMA:
        return False
    if timestamp(state.get("generatedAt")) is None:
        return False
    if not isinstance(state.get("mode"), str) or not state["mode"]:
        return False
    if not isinstance(state.get("inspection"), str) or not state["inspection"]:
        return False
    if not isinstance(state.get("wallClockCapped"), bool):
        return False
    summary = state.get("summary")
    if not isinstance(summary, dict) or not summary:
        return False
    if any(not _bounded_int(value) for value in summary.values()):
        return False
    services = state.get("services")
    if not isinstance(services, list) or len(services) > 128:
        return False
    for service in services:
        if not isinstance(service, dict) or not isinstance(service.get("id"), str):
            return False
    return True


def build_watchdog(state: Any, now: float, available: bool) -> dict[str, Any]:
    empty = {
        "available": False,
        "generated_at": None,
        "freshness": UNKNOWN,
        "age": None,
        "age_text": None,
        "inspection": None,
        "wall_clock_capped": None,
        "summary": None,
        "attention": False,
        "warnings": ["Monitor-set watchdog status is unavailable or invalid"],
    }
    if not available or not watchdog_status_valid(state):
        return empty
    fresh, age = _freshness_view(state["generatedAt"], now)
    summary = state["summary"]
    attention = bool(
        summary.get("missing", 0)
        or summary.get("failed", 0)
        or summary.get("relaunched", 0)
        or state.get("inspection") != "ok"
        or state.get("wallClockCapped") is True
        or fresh in {STALE, "CLOCK_SKEW"}
    )
    return {
        "available": True,
        "generated_at": _iso(state["generatedAt"]),
        "freshness": fresh,
        "age": age,
        "age_text": _age_text(age),
        "inspection": scrub_text(state["inspection"], 24),
        "wall_clock_capped": state["wallClockCapped"],
        "summary": {
            "total": summary.get("total"),
            "running": summary.get("running"),
            "missing": summary.get("missing"),
            "relaunched": summary.get("relaunched"),
            "failed": summary.get("failed"),
            "cooldown": summary.get("cooldown"),
            "would_relaunch": summary.get("wouldRelaunch"),
        },
        "attention": attention,
        "warnings": [],
    }


def build_pipeline(
    profit_watch: dict[str, Any],
    autopilot: dict[str, Any],
    dispatcher: dict[str, Any],
    watchdog: dict[str, Any],
) -> dict[str, Any]:
    warnings: list[str] = []
    if not profit_watch["available"]:
        warnings.append("Profit trigger watch is unavailable; producer ages are unknown")
    if not autopilot["status_available"]:
        warnings.append("Autopilot status is unavailable; fork classification is unknown")
    if not autopilot["state_available"]:
        warnings.append("Autopilot state is unavailable; promoted-candidate evidence is unknown")
    if not dispatcher["available"]:
        warnings.append("Alert dispatcher summary is unavailable")
    if not watchdog["available"]:
        warnings.append("Watchdog summary is unavailable")
    return {
        "available": any(
            section["available"]
            for section in (profit_watch, autopilot, dispatcher, watchdog)
        ),
        "profit_watch": profit_watch,
        "autopilot": autopilot,
        "dispatcher": dispatcher,
        "watchdog": watchdog,
        "warnings": warnings,
    }


# --------------------------------------------------------------------------- #
# Mode (testing/emulation -> live)
# --------------------------------------------------------------------------- #


def watch_addresses_state(value: Any, available: bool) -> tuple[str, int, str]:
    """Return (state, count, detail) for the coordination watchlist."""

    if not available or not isinstance(value, dict):
        return "UNKNOWN", 0, "watch-address list is unavailable; configured state is unknown"
    for key in WATCH_ADDRESS_KEYS:
        entries = value.get(key)
        if isinstance(entries, list):
            count = len(entries)
            if count == 0:
                return "FAIL", 0, "watch-address list is present but empty"
            return "PASS", count, f"{count} watch address(es) configured"
    return "UNKNOWN", 0, "watch-address file shape is not recognized"


def approver_registry_valid(state: Any) -> bool:
    if not isinstance(state, dict) or state.get("schema") != APPROVER_REGISTRY_SCHEMA:
        return False
    approvers = state.get("approvers")
    if not isinstance(approvers, list) or len(approvers) > 64:
        return False
    seen: set[str] = set()
    for approver in approvers:
        if not isinstance(approver, dict):
            return False
        approver_id = approver.get("approverId")
        algorithm = approver.get("algorithm")
        key = approver.get("publicKeySpkiDerBase64")
        if not isinstance(approver_id, str) or not approver_id.strip() or approver_id in seen:
            return False
        if not isinstance(algorithm, str) or ALGORITHM.fullmatch(algorithm) is None:
            return False
        if not isinstance(key, str) or not key.strip() or len(key) > 4096:
            return False
        seen.add(approver_id)
    return True


def batch_state(value: Any, available: bool, source: bool, now: float, *, execution: dict[str, Any]) -> dict[str, Any]:
    """Classify the live-execution batch without ever executing it."""

    view = {
        "state": "MISSING",
        "detail": "no live-execution batch file is present",
        "expires_at": None,
        "expired": False,
        "action_count": None,
        "approver_evidence": None,
        "approved": None,
        "status": None,
        "verification": execution["verification"],
    }
    if execution["verification"] == "VERIFIED":
        state = execution["authorization_state"]
        view.update(
            state="MISSING" if state == "ABSENT" else state,
            status=state,
            detail=f"signed-batch verifier reports {state.lower().replace('_', ' ')}",
            expires_at=execution["expires_at"],
            expired=state == "EXPIRED",
            approved=state == "VALID",
        )
        return view
    if not available:
        view["state"] = "INVALID" if source else "MISSING"
        view["detail"] = (
            "live-execution batch is present but unreadable or malformed"
            if source
            else "no live-execution batch file is present"
        )
        return view
    if not isinstance(value, dict):
        view.update(state="INVALID", detail="live-execution batch is not an object")
        return view

    status = None
    for key in BATCH_STATUS_KEYS:
        candidate = value.get(key)
        if isinstance(candidate, str) and candidate.strip():
            status = candidate.strip()
            break
    view["status"] = scrub_text(status, 32)
    expiry = None
    for key in BATCH_EXPIRY_KEYS:
        expiry = timestamp(value.get(key))
        if expiry is not None:
            break
    view["expires_at"] = _iso(expiry) if expiry is not None else None
    if expiry is not None and expiry < now:
        view["state"] = "EXPIRED"
        view["expired"] = True
        view["detail"] = "live-execution batch is expired"
        return view

    actions = None
    for key in BATCH_ACTION_KEYS:
        candidate = value.get(key)
        if isinstance(candidate, list):
            actions = candidate
            break
    approver_evidence = None
    for key in BATCH_APPROVER_KEYS:
        candidate = value.get(key)
        if isinstance(candidate, list):
            approver_evidence = len(candidate)
            break
        if isinstance(candidate, dict):
            approver_evidence = len(candidate)
            break
    view["action_count"] = len(actions) if actions is not None else None
    view["approver_evidence"] = approver_evidence

    view["state"] = "PRESENT_UNVERIFIED"
    view["detail"] = "batch metadata is present; signed-batch verification is unavailable"
    return view


def _dispatch_gate(coverage_state: Any, coverage_available: bool) -> tuple[str, str]:
    if not coverage_available or not trigger_coverage_valid(coverage_state):
        return "UNKNOWN", "trigger coverage audit is unavailable; dispatch state is unknown"
    disabled = enabled = False
    for row in coverage_state["rows"]:
        text = " ".join(row["blockers"] + row["evidence"]).lower()
        if any(phrase in text for phrase in DISPATCH_DISABLED):
            disabled = True
        if any(phrase in text for phrase in DISPATCH_ENABLED):
            enabled = True
    if disabled and not enabled:
        return "FAIL", "campaign evidence reports on-fire dispatch is disabled"
    if enabled and not disabled:
        return "PASS", "campaign evidence reports on-fire dispatch is enabled"
    return "UNKNOWN", "campaign rows contain no explicit dispatch-enabled evidence"


def build_mode(
    *,
    now: float,
    watch_state: str,
    watch_count: int,
    watch_detail: str,
    autopilot: dict[str, Any],
    batch: dict[str, Any],
    approvers_available: bool,
    approvers_state: Any,
    coverage_state: Any,
    coverage_available: bool,
) -> dict[str, Any]:
    gates: list[dict[str, Any]] = []

    gates.append(
        {
            "key": "watchlist",
            "label": "Watch addresses configured",
            "source": "coordination/watch-addresses.json",
            "state": watch_state,
            "reason": watch_detail,
            "ok": watch_state == "PASS",
        }
    )

    if autopilot["state_available"]:
        if autopilot["promoted_count"] > 0:
            state, reason = "PASS", f"{autopilot['promoted_count']} fork-promoted candidate event(s) recorded"
        else:
            state, reason = "FAIL", "no fork-promoted candidate event is recorded"
    else:
        state, reason = "UNKNOWN", "autopilot state is unavailable; promoted candidate is unknown"
    gates.append(
        {
            "key": "fork_candidate",
            "label": "Fork-promoted candidate exists",
            "source": "trigger-fork-autopilot-state.json",
            "state": state,
            "reason": reason,
            "ok": state == "PASS",
        }
    )

    batch_pass = batch["state"] == "VALID"
    if batch["state"] in {"MISSING", "PRESENT_UNVERIFIED"}:
        batch_gate_state = "UNKNOWN"
    elif batch_pass:
        batch_gate_state = "PASS"
    else:
        batch_gate_state = "FAIL"
    gates.append(
        {
            "key": "batch",
            "label": "Live-execution batch present, valid, unexpired",
            "source": "coordination/live-execution-batch.json",
            "state": batch_gate_state,
            "reason": batch["detail"],
            "ok": batch_pass,
        }
    )

    registry_valid = approvers_available and approver_registry_valid(approvers_state)
    approver_count = len(approvers_state["approvers"]) if registry_valid else 0
    if registry_valid and approver_count > 0:
        approver_state, approver_reason = "PASS", f"{approver_count} approver(s) provisioned"
    elif registry_valid:
        approver_state, approver_reason = "FAIL", "approver registry is provisioned but empty"
    else:
        approver_state, approver_reason = "UNKNOWN", "approver registry is unavailable or invalid"
    gates.append(
        {
            "key": "approvers",
            "label": "Approver registry provisioned",
            "source": "coordination/live-execution-approvers.json",
            "state": approver_state,
            "reason": approver_reason,
            "ok": approver_state == "PASS",
        }
    )

    dispatch_state, dispatch_reason = _dispatch_gate(coverage_state, coverage_available)
    gates.append(
        {
            "key": "dispatch",
            "label": "Dispatch-enabled evidence in campaign rows",
            "source": "trigger-coverage-audit.json",
            "state": dispatch_state,
            "reason": dispatch_reason,
            "ok": dispatch_state == "PASS",
        }
    )

    # Batch authorization is separate from actually running a verified arming
    # controller. No controller/route qualification is connected here, so the
    # runtime gate is always UNKNOWN and can never satisfy go-live readiness.
    gates.append(
        {
            "key": "runtime",
            "label": "Verified arming controller connected",
            "source": "tools/live-execution-batch.js",
            "state": "UNKNOWN",
            "reason": EXECUTION_REASON,
            "ok": False,
        }
    )

    go_live_ready = all(gate["ok"] for gate in gates)
    current = "READ_ONLY"
    warnings: list[str] = []
    if batch_pass:
        warnings.append(
            "A valid live-execution batch is present, but no verified arming controller is connected; "
            "readiness and route scope remain unverified"
        )
    algorithms: list[str] = []
    if registry_valid:
        algorithms = sorted({approver["algorithm"] for approver in approvers_state["approvers"]})
    return {
        "current": current,
        "go_live_ready": go_live_ready,
        "readiness": "NOT_READY",
        "readiness_reason": EXECUTION_REASON,
        "scope": "NOT_VERIFIED",
        "gates": gates,
        "pass_count": sum(gate["ok"] for gate in gates),
        "gate_count": len(gates),
        "batch": {
            "state": batch["state"],
            "detail": batch["detail"],
            "expires_at": batch["expires_at"],
            "action_count": batch["action_count"],
            "approver_evidence": batch["approver_evidence"],
            "status": batch["status"],
            "verification": batch["verification"],
        },
        "approvers": {
            "available": registry_valid,
            "count": approver_count,
            "algorithms": algorithms,
        },
        "workflow": {
            "command": "node tools/live-execution-batch.js",
            "note": (
                "Text reference only. Prepare and approve a batch with the CLI, then review it here. "
                "The dashboard runs only the fixed status verifier; it never signs, broadcasts, or moves funds."
            ),
        },
        "warnings": warnings,
    }


# --------------------------------------------------------------------------- #
# Wallets
# --------------------------------------------------------------------------- #


def _balance_ok(value: Any) -> bool:
    return bool(
        isinstance(value, dict)
        and isinstance(value.get("symbol"), str)
        and SYMBOL.fullmatch(value["symbol"]) is not None
        and isinstance(value.get("raw"), str)
        and RAW.fullmatch(value["raw"]) is not None
        and isinstance(value.get("formatted"), str)
        and AMOUNT.fullmatch(value["formatted"]) is not None
    )


def _token_ok(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    decimals = value.get("decimals")
    if not (
        isinstance(value.get("symbol"), str)
        and SYMBOL.fullmatch(value["symbol"]) is not None
        and not isinstance(decimals, bool)
        and isinstance(decimals, int)
        and 0 <= decimals <= 255
    ):
        return False
    raw = value.get("raw")
    formatted = value.get("formatted")
    if "raw" not in value or "formatted" not in value:
        return False
    # A failed per-token read is recorded as null/null by the collector. It is a
    # display gap ("no data"), never a fabricated zero, and must not invalidate
    # the rest of the snapshot.
    if raw is None and formatted is None:
        return True
    return bool(
        isinstance(raw, str)
        and RAW.fullmatch(raw) is not None
        and isinstance(formatted, str)
        and AMOUNT.fullmatch(formatted) is not None
    )


def wallet_balances_valid(state: Any) -> bool:
    if not isinstance(state, dict) or state.get("schema") != WALLET_BALANCES_SCHEMA:
        return False
    if timestamp(state.get("asOf")) is None:
        return False
    if not _bounded_int(state.get("durationMs")):
        return False
    watchlist_path = state.get("watchlistPath")
    if watchlist_path is not None and not isinstance(watchlist_path, str):
        return False
    addresses = state.get("addresses")
    if not isinstance(addresses, list) or len(addresses) > 128:
        return False
    for address in addresses:
        if not isinstance(address, dict):
            return False
        if address.get("label") is not None and not isinstance(address["label"], str):
            return False
        if ADDRESS.fullmatch(str(address.get("address", ""))) is None:
            return False
    chains = state.get("chains")
    if not isinstance(chains, list) or len(chains) > 64:
        return False
    for chain in chains:
        if not isinstance(chain, dict):
            return False
        chain_id = chain.get("chainId")
        if isinstance(chain_id, bool) or not isinstance(chain_id, int) or not 0 < chain_id <= 4_294_967_295:
            return False
        if not isinstance(chain.get("name"), str):
            return False
        rows = chain.get("addressRows")
        if not isinstance(rows, list) or len(rows) > 128:
            return False
        for row in rows:
            if not isinstance(row, dict) or ADDRESS.fullmatch(str(row.get("address", ""))) is None:
                return False
            block = row.get("blockNumber")
            if not (
                block is None
                or (not isinstance(block, bool) and isinstance(block, int) and block >= 0)
                or (isinstance(block, str) and DECIMAL.fullmatch(block) is not None)
            ):
                return False
            native = row.get("native")
            if native is not None and not _balance_ok(native):
                return False
            tokens = row.get("tokens")
            if not isinstance(tokens, list) or len(tokens) > 64 or not all(_token_ok(token) for token in tokens):
                return False
            if row.get("error") is not None and not isinstance(row.get("error"), str):
                return False
    solana = state.get("solana")
    if solana is not None and (not isinstance(solana, list) or len(solana) > 64):
        return False
    for row in solana or []:
        if not isinstance(row, dict) or not valid_solana_address(row.get("address")):
            return False
        if row.get("label") is not None and not isinstance(row["label"], str):
            return False
        if row.get("native") is not None and not _balance_ok(row["native"]):
            return False
        tokens = row.get("tokens")
        if not isinstance(tokens, list) or len(tokens) > 64 or not all(_token_ok(token) for token in tokens):
            return False
        slot = row.get("slot")
        if slot is not None and not (_bounded_int(slot, 10**20) or isinstance(slot, str) and DECIMAL.fullmatch(slot)):
            return False
        if row.get("error") is not None and not isinstance(row["error"], str):
            return False
    errors = state.get("errors")
    if not isinstance(errors, list) or len(errors) > 100:
        return False
    for error in errors:
        if (
            not isinstance(error, dict)
            or not isinstance(error.get("scope"), str)
            or not isinstance(error.get("message"), str)
        ):
            return False
    return True


def wallet_row_total(row: dict[str, Any]) -> str | None:
    """A total is usable only when every reported holding is priced/readable."""

    native = row.get("native")
    if (row.get("error") or not isinstance(native, dict)
        or any(token.get("raw") is None for token in row["tokens"])
        or _usd_text(row.get("totalUsd")) is None):
        return None
    return _sum_usd([native.get("usd"), *(token.get("usd") for token in row["tokens"])])


def wallet_totals_view(state: dict[str, Any]) -> dict[str, Any] | None:
    """Project only known fields and withhold totals over incomplete rows."""

    raw = state.get("totals")
    if not isinstance(raw, dict):
        return None
    unpriced = raw.get("unpricedChains")
    rows = [row for chain in state["chains"] for row in chain["addressRows"]] + (state.get("solana") or [])
    total = _sum_usd([wallet_row_total(row) for row in rows]) if _usd_text(raw.get("totalUsd")) is not None else None
    addresses_covered = not state["addresses"] or bool(state["chains"]) and all(
        any(row["address"].lower() == entry["address"].lower() for row in chain["addressRows"])
        for chain in state["chains"] for entry in state["addresses"]
    )
    if raw.get("complete") is False or state.get("errors") or not addresses_covered:
        total = None
    stable = []
    for row in rows:
        readable = all(token.get("raw") is not None and _usd_text(token.get("usd")) is not None for token in row["tokens"])
        stable.append(row.get("stableUsdTotal") if readable else None)
    return {
        "stableUsd": _sum_usd(stable) if rows and _usd_text(raw.get("stableUsd")) is not None else _usd_text(raw.get("stableUsd")),
        "nativeUsd": _sum_usd([(row.get("native") or {}).get("usd") for row in rows]) if _usd_text(raw.get("nativeUsd")) is not None else None,
        "totalUsd": total,
        "note": scrub_text(raw.get("note"), 120),
        "unpricedChains": [scrub_text(item, 40) or "unknown" for item in unpriced if isinstance(item, str)][:64] if isinstance(unpriced, list) else [],
        "priceSource": _price_source(raw.get("priceSource")),
    }


def build_wallets(
    state: Any,
    now: float,
    available: bool,
    *,
    watch_configured: bool,
    watch_count: int,
    watch_detail: str,
    watch_list: Any = (),
    cached: bool = False,
) -> dict[str, Any]:
    watchlist = [
        {
            "label": scrub_text(item.get("label"), 80),
            "address": item["address"],
            "family": item.get("family", "evm"),
            "short": _short_for(item["address"], item.get("family", "evm")),
            "total_usd": None,
        }
        for item in watch_list
    ]
    view: dict[str, Any] = {
        "available": False,
        "as_of": None,
        "freshness": UNKNOWN,
        "age": None,
        "age_text": None,
        "duration_ms": None,
        "addresses": [],
        "watchlist": watchlist,
        "chains": [],
        "solana": [],
        "errors": [],
        "empty_reason": None,
        "watch_addresses_configured": watch_configured,
        "watch_address_count": watch_count,
        "total_rows": 0,
        "ok_rows": 0,
        "error_rows": 0,
        "totals": {
            "stable_usd": None,
            "note": None,
            "unpriced_chains": [],
            "native_usd": None,
            "total_usd": None,
            "price_source": None,
        },
        "cached": cached,
        "warnings": [],
    }
    if not watch_configured:
        view["empty_reason"] = "NO_WATCHLIST"
        view["warnings"].append(watch_detail)
        return view
    if not available or not wallet_balances_valid(state):
        view["empty_reason"] = "NO_ARTIFACT"
        view["warnings"].append(
            "wallet balance snapshot is cached but not current"
            if cached
            else "wallet balance snapshot is unavailable or invalid"
        )
        return view

    fresh, age = _freshness_view(state["asOf"], now)
    addresses = []
    labels: dict[str, str] = {}
    for address in state["addresses"]:
        label = scrub_text(address.get("label"), 80) or "unlabeled"
        labels[address["address"].lower()] = label
        addresses.append(
            {
                "label": label,
                "short": _short_address(address["address"]),
            }
        )
    chains = []
    per_address: dict[str, list[str | None]] = {}
    total = ok = errored = 0
    for chain in state["chains"]:
        rows = []
        for row in chain["addressRows"]:
            total += 1
            error = scrub_text(row.get("error"), 200)
            if error:
                errored += 1
            else:
                ok += 1
            native = row.get("native")
            row_total = wallet_row_total(row)
            per_address.setdefault(f"evm:{row['address'].lower()}", []).append(row_total)
            tokens = [
                {
                    "symbol": token["symbol"],
                    "raw": token["raw"],
                    "formatted": token["formatted"],
                    "decimals": token["decimals"],
                    "usd": _usd_text(token.get("usd")),
                }
                for token in row["tokens"]
            ]
            rows.append(
                {
                    "short": _short_address(row["address"]),
                    "label": labels.get(row["address"].lower()),
                    "block_number": row.get("blockNumber"),
                    "native": None
                    if native is None
                    else {
                        "symbol": native["symbol"],
                        "raw": native["raw"],
                        "formatted": native["formatted"],
                        "usd": _usd_text(native.get("usd")),
                    },
                    "tokens": tokens,
                    "stable_usd_total": _usd_text(row.get("stableUsdTotal")),
                    "total_usd": row_total,
                    "error": error,
                }
            )
        cid = chain["chainId"]
        chains.append(
            {
                "chain_id": cid,
                "name": scrub_text(chain["name"], 40) or CHAIN_NAMES.get(cid, "Unknown chain"),
                "rows": rows,
            }
        )
    solana_rows: list[dict[str, Any]] = []
    for row in state.get("solana") or []:
        if not isinstance(row, dict):
            continue
        address = row.get("address")
        if not isinstance(address, str) or SOLANA_PATTERN.fullmatch(address) is None:
            continue
        solana_total = wallet_row_total(row)
        per_address.setdefault(f"solana:{address}", []).append(solana_total)
        native = row.get("native")
        native_view = None
        if isinstance(native, dict) and _balance_ok(native):
            native_view = {
                "symbol": native["symbol"],
                "raw": native["raw"],
                "formatted": native["formatted"],
                "usd": _usd_text(native.get("usd")),
            }
        token_source = row.get("tokens")
        tokens = [
            {
                "symbol": token["symbol"],
                "raw": token["raw"],
                "formatted": token["formatted"],
                "decimals": token["decimals"],
                "usd": _usd_text(token.get("usd")),
            }
            for token in (token_source if isinstance(token_source, list) else [])
            if isinstance(token, dict) and _token_ok(token)
        ]
        slot = row.get("slot")
        if not (
            slot is None
            or (not isinstance(slot, bool) and isinstance(slot, int) and slot >= 0)
            or (isinstance(slot, str) and DECIMAL.fullmatch(slot) is not None)
        ):
            slot = None
        solana_rows.append(
            {
                "address": address,
                "label": scrub_text(row.get("label"), 80),
                "short": _short_base58(address),
                "slot": slot,
                "native": native_view,
                "tokens": tokens,
                "stable_usd_total": _usd_text(row.get("stableUsdTotal")),
                "total_usd": solana_total,
                "error": scrub_text(row.get("error"), 200),
            }
        )
    for item in watchlist:
        item["total_usd"] = _sum_usd(per_address.get(f"{item['family']}:{item['address']}", []))
    if not addresses and not solana_rows:
        view["empty_reason"] = "NO_WATCHLIST"
    elif total == 0 and not solana_rows:
        view["empty_reason"] = "NO_ROWS"
    totals_raw = wallet_totals_view(state) or {}
    unpriced_raw = totals_raw.get("unpricedChains")
    unpriced_chains = (
        [scrub_text(item, 40) or "unknown" for item in unpriced_raw if isinstance(item, str)][:64]
        if isinstance(unpriced_raw, list)
        else []
    )
    view.update(
        available=True,
        as_of=_iso(state["asOf"]),
        freshness=fresh,
        age=age,
        age_text=_age_text(age),
        duration_ms=state["durationMs"],
        addresses=addresses,
        chains=chains,
        solana=solana_rows,
        errors=[
            {"scope": scrub_text(error["scope"], 40) or "unknown", "message": scrub_text(error["message"], 200) or "error"}
            for error in state["errors"]
        ],
        totals={
            "stable_usd": _usd_text(totals_raw.get("stableUsd")),
            "note": scrub_text(totals_raw.get("note"), 120),
            "unpriced_chains": unpriced_chains,
            "native_usd": _usd_text(totals_raw.get("nativeUsd")),
            "total_usd": _usd_text(totals_raw.get("totalUsd")),
            "price_source": _price_source(totals_raw.get("priceSource")),
        },
        total_rows=total,
        ok_rows=ok,
        error_rows=errored,
    )
    if fresh in {STALE, "CLOCK_SKEW"}:
        view["warnings"].append("wallet balance snapshot is not current")
    if errored:
        view["warnings"].append(f"{errored} address row(s) reported an error")
    return view


# --------------------------------------------------------------------------- #
# Offensive program (live-execution envelopes + watch lane)
# --------------------------------------------------------------------------- #


def euler_fleet_deploy_valid(state: Any) -> bool:
    return bool(
        isinstance(state, dict)
        and state.get("schema") == FLEET_DEPLOY_SCHEMA
        and timestamp(state.get("generatedAt")) is not None
        and isinstance(state.get("deploys"), list)
    )


def euler_fastlane_valid(state: Any) -> bool:
    return bool(
        isinstance(state, dict)
        and state.get("schema") == FASTLANE_SCHEMA
        and timestamp(state.get("scannedAt")) is not None
    )


def autofire_loop_valid(state: Any) -> bool:
    return bool(
        isinstance(state, dict)
        and state.get("schema") == AUTOFIRE_LOOP_SCHEMA
        and timestamp(state.get("scannedAt")) is not None
    )


def silo_watch_valid(state: Any) -> bool:
    return bool(
        isinstance(state, dict)
        and state.get("schema") == SILO_WATCH_SCHEMA
        and (timestamp(state.get("scannedAt")) is not None or timestamp(state.get("generatedAt")) is not None)
    )


def bytecode_verification_valid(state: Any) -> bool:
    if not isinstance(state, dict):
        return False
    summary = state.get("summary")
    return bool(
        isinstance(summary, dict)
        and timestamp(summary.get("checkedAt")) is not None
        and isinstance(state.get("results"), list)
    )


def _read_ok(read: Any) -> bool:
    return bool(getattr(read, "current", False) and isinstance(getattr(read, "value", None), dict))


def _consumed_by_batch(fleet_read: Any, loop_read: Any) -> dict[str, int]:
    """Exact per-envelope consumption when a sibling artifact declares it."""

    consumed: dict[str, int] = {}
    if _read_ok(fleet_read):
        batch_id = fleet_read.value.get("batchId")
        totals = fleet_read.value.get("totals")
        used = totals.get("signedExecutionsUsed") if isinstance(totals, dict) else None
        if isinstance(batch_id, str) and _bounded_int(used):
            consumed[batch_id] = used
    if _read_ok(loop_read):
        budget = loop_read.value.get("budget")
        if isinstance(budget, dict):
            batch_id = budget.get("batchId")
            fired = budget.get("fired")
            if isinstance(batch_id, str) and _bounded_int(fired):
                consumed[batch_id] = fired
    return consumed


def _envelope_row(
    key: str,
    label: str,
    read: Any,
    *,
    now: float,
    file_age: float | None,
    consumed: dict[str, int],
) -> dict[str, Any]:
    row: dict[str, Any] = {
        "key": key,
        "label": label,
        "batch_id": None,
        "chain": None,
        "chain_id": None,
        "approved": None,
        "reported_approved": None,
        "verification": "NOT_VERIFIED",
        "approved_at": None,
        "expires_at": None,
        "expires_in": None,
        "expired": None,
        "status": "MISSING",
        "fresh_reported_status": "MISSING",
        "freshness": _mtime_freshness(file_age),
        "fresh": None if file_age is None else file_age <= FILE_FRESH_SECONDS,
        "age": file_age,
        "age_text": _age_text(file_age),
        "caps": {"max_gas": None, "max_native_wei": None, "per_day": None, "total": None},
        "signed_executions": {"total": None, "consumed": None, "remaining": None},
        "warnings": [],
    }
    source = bool(getattr(read, "source", False))
    value = getattr(read, "value", None)
    if not (getattr(read, "current", False) and isinstance(value, dict)):
        row["status"] = "UNREADABLE" if source else "MISSING"
        row["fresh_reported_status"] = row["status"]
        row["warnings"].append(
            "envelope is present but unreadable or malformed" if source else "no envelope file is present"
        )
        return row

    batch_id = value.get("batchId")
    row["batch_id"] = batch_id if isinstance(batch_id, str) and BATCH_ID.fullmatch(batch_id) else None
    chain_id = value.get("chainId")
    if _bounded_int(chain_id, 4_294_967_295):
        row["chain_id"] = chain_id
    row["chain"] = scrub_text(value.get("chain"), 40)

    reported = None
    for candidate_key in BATCH_STATUS_KEYS:
        candidate = value.get(candidate_key)
        if isinstance(candidate, str) and candidate.strip():
            reported = candidate.strip()
            break
    approved = value.get("approved") is True or (reported or "").upper() in BATCH_APPROVED_STATES
    row["reported_approved"] = approved
    row["approved_at"] = _iso(value.get("approvedAt"))
    expiry = None
    for candidate_key in BATCH_EXPIRY_KEYS:
        expiry = timestamp(value.get(candidate_key))
        if expiry is not None:
            break
    row["expires_at"] = _iso(expiry) if expiry is not None else None
    row["expired"] = bool(expiry is not None and expiry < now)
    row["expires_in"] = humanCountdown(expiry, now) if expiry is not None else None
    status = "EXPIRED" if row["expired"] else "PRESENT_UNVERIFIED"
    row["status"] = status
    row["fresh_reported_status"] = status

    caps_src = value.get("caps") if isinstance(value.get("caps"), dict) else {}
    max_gas = caps_src.get("maxGasLimitPerTransaction") or caps_src.get("maxExecutionGasLimit") or caps_src.get("maxDeployGasLimit")
    max_native = caps_src.get("maxNativeSpendPerTransactionWei") or caps_src.get("maxExecutionSpendWei") or caps_src.get("maxDeploySpendWei")
    per_day = caps_src.get("signedExecutionsPerDay")
    total = None
    for candidate_key in CAPS_TOTAL_KEYS:
        candidate = caps_src.get(candidate_key)
        if _bounded_int(candidate):
            total = candidate
            break
    row["caps"] = {
        "max_gas": max_gas if _bounded_int(max_gas) else None,
        "max_native_wei": max_native if isinstance(max_native, str) and RAW.fullmatch(max_native) else None,
        "per_day": per_day if _bounded_int(per_day) else None,
        "total": total,
    }
    used = consumed.get(row["batch_id"]) if row["batch_id"] is not None else None
    if not _bounded_int(used):
        used = None
    remaining = total - used if (total is not None and used is not None) else None
    row["signed_executions"] = {"total": total, "consumed": used, "remaining": remaining}
    return row


def build_envelopes(reader: Any, now: float, fleet_read: Any, loop_read: Any, execution: dict[str, Any]) -> dict[str, Any]:
    consumed = _consumed_by_batch(fleet_read, loop_read)
    rows = [
        _envelope_row(
            key,
            label,
            reader.read_json(key),
            now=now,
            file_age=_file_age(reader, key, now),
            consumed=consumed,
        )
        for key, label in BATCH_ENVELOPE_SOURCES
    ]
    for row in rows:
        if row["key"] == "live_execution_batch" and execution["verification"] == "VERIFIED":
            state = execution["authorization_state"]
            row.update(status=state, fresh_reported_status=state, verification="VERIFIED", approved=state == "VALID")
            row["expires_at"] = execution["expires_at"]
            row["expired"] = state == "EXPIRED"
            row["expires_in"] = humanCountdown(timestamp(execution["expires_at"]), now) if execution["expires_at"] else None
    rank = {"VALID": 0, "PRESENT_UNVERIFIED": 1, "EXPIRED": 2, "UNREADABLE": 3, "MISSING": 4}
    rows.sort(key=lambda row: (rank.get(row["status"], 5), row["label"]))
    return {
        "available": any(row["status"] not in {"MISSING", "ABSENT", "UNREADABLE"} for row in rows),
        "count": len(rows),
        "approved_count": sum(1 for row in rows if row["status"] == "VALID" and row["verification"] == "VERIFIED"),
        "rows": rows,
    }


def build_fleet_deploy(read: Any, now: float, reader: Any, key: str) -> dict[str, Any]:
    view: dict[str, Any] = {
        "available": False,
        "freshness": UNKNOWN,
        "age": None,
        "age_text": None,
        "generated_at": None,
        "batch_id": None,
        "decision": None,
        "deploys": [],
        "verification": [],
        "totals": None,
        "warnings": [],
    }
    age = _file_age(reader, key, now)
    view["age"] = age
    view["age_text"] = _age_text(age)
    view["freshness"] = _mtime_freshness(age)
    if not (_read_ok(read) and euler_fleet_deploy_valid(read.value)):
        view["warnings"].append("Euler fleet deploy status is unavailable or invalid")
        return view
    state = read.value
    batch_id = state.get("batchId")
    view["batch_id"] = batch_id if isinstance(batch_id, str) and BATCH_ID.fullmatch(batch_id) else None
    view["generated_at"] = _iso(state.get("generatedAt"))
    view["decision"] = scrub_text(state.get("decision"), 24)
    for item in state["deploys"][:8]:
        if not isinstance(item, dict):
            continue
        address = item.get("contractAddress") or item.get("address")
        index = item.get("index")
        block = item.get("blockNumber")
        view["deploys"].append(
            {
                "index": index if _bounded_int(index, 1_000) else None,
                "label": scrub_text(item.get("label"), 40) or "unlabeled",
                "address": _short_address(address) if isinstance(address, str) and ADDRESS.fullmatch(address) else None,
                "status": scrub_text(item.get("status"), 24),
                "block_number": block if _bounded_int(block, 10**12) else None,
            }
        )
    verification = state.get("verification")
    for item in (verification if isinstance(verification, list) else [])[:8]:
        if not isinstance(item, dict):
            continue
        address = item.get("address")
        view["verification"].append(
            {
                "label": scrub_text(item.get("label"), 40) or "unlabeled",
                "address": _short_address(address) if isinstance(address, str) and ADDRESS.fullmatch(address) else None,
                "status": scrub_text(item.get("status"), 32),
            }
        )
    totals = state.get("totals")
    if isinstance(totals, dict):
        view["totals"] = {
            "requested": totals.get("requested") if _bounded_int(totals.get("requested")) else None,
            "deployed": totals.get("deployed") if _bounded_int(totals.get("deployed")) else None,
            "signed_used": totals.get("signedExecutionsUsed") if _bounded_int(totals.get("signedExecutionsUsed")) else None,
        }
    view["available"] = True
    return view


def build_fastlane(read: Any, now: float, reader: Any, key: str) -> dict[str, Any]:
    view: dict[str, Any] = {
        "available": False,
        "freshness": UNKNOWN,
        "age": None,
        "age_text": None,
        "scanned_at": None,
        "head_block": None,
        "fired_decision": None,
        "win_probable": None,
        "candidate_count": None,
        "warnings": [],
    }
    age = _file_age(reader, key, now)
    view["age"] = age
    view["age_text"] = _age_text(age)
    view["freshness"] = _mtime_freshness(age)
    if not (_read_ok(read) and euler_fastlane_valid(read.value)):
        view["warnings"].append("Euler fastlane status is unavailable or invalid")
        return view
    state = read.value
    view["scanned_at"] = _iso(state.get("scannedAt"))
    head = state.get("headBlock")
    view["head_block"] = head if _bounded_int(head, 10**12) else None
    view["fired_decision"] = scrub_text(state.get("firedDecision"), 32)
    summary = state.get("decisionSummary") if isinstance(state.get("decisionSummary"), dict) else {}
    win_probable = summary.get("winProbable")
    view["win_probable"] = win_probable if _bounded_int(win_probable, 100_000) else None
    totals = state.get("totals") if isinstance(state.get("totals"), dict) else {}
    route_rows = totals.get("routeRows")
    view["candidate_count"] = route_rows if _bounded_int(route_rows, 100_000) else None
    view["available"] = True
    return view


def build_autofire_loop(read: Any, now: float, reader: Any, key: str) -> dict[str, Any]:
    view: dict[str, Any] = {
        "available": False,
        "freshness": UNKNOWN,
        "age": None,
        "age_text": None,
        "scanned_at": None,
        "verdict": None,
        "decision": None,
        "budget_used": None,
        "fired": None,
        "total": None,
        "batch_id": None,
        "fastlane": None,
        "warnings": [],
    }
    age = _file_age(reader, key, now)
    view["age"] = age
    view["age_text"] = _age_text(age)
    view["freshness"] = _mtime_freshness(age)
    if not (_read_ok(read) and autofire_loop_valid(read.value)):
        view["warnings"].append("Auto-fire loop status is unavailable or invalid")
        return view
    state = read.value
    view["scanned_at"] = _iso(state.get("scannedAt"))
    view["verdict"] = scrub_text(state.get("verdict"), 24)
    attempt = state.get("attemptResult") if isinstance(state.get("attemptResult"), dict) else {}
    view["decision"] = scrub_text(attempt.get("decision"), 24)
    budget_used = attempt.get("budgetUsed") if isinstance(attempt.get("budgetUsed"), dict) else {}
    view["budget_used"] = {
        "observed_total": budget_used.get("observedTotal") if _bounded_int(budget_used.get("observedTotal"), 100_000) else None,
        "observed_fired": budget_used.get("observedFired") if _bounded_int(budget_used.get("observedFired"), 100_000) else None,
        "lock_consumed": budget_used.get("lockConsumed") if isinstance(budget_used.get("lockConsumed"), bool) else None,
    }
    budget = state.get("budget") if isinstance(state.get("budget"), dict) else {}
    view["fired"] = budget.get("fired") if _bounded_int(budget.get("fired"), 100_000) else None
    view["total"] = budget.get("total") if _bounded_int(budget.get("total"), 100_000) else None
    batch_id = budget.get("batchId")
    view["batch_id"] = batch_id if isinstance(batch_id, str) and BATCH_ID.fullmatch(batch_id) else None
    fastlane = state.get("fastlane") if isinstance(state.get("fastlane"), dict) else {}
    view["fastlane"] = {
        "fired_decision": scrub_text(fastlane.get("firedDecision"), 32),
        "win_probable": fastlane.get("winProbable") if _bounded_int(fastlane.get("winProbable"), 100_000) else None,
        "fresh": fastlane.get("fresh") if isinstance(fastlane.get("fresh"), bool) else None,
        "age_ms": fastlane.get("ageMs") if _bounded_int(fastlane.get("ageMs"), 10**12) else None,
    }
    view["available"] = True
    return view


def build_silo_watch(read: Any, now: float, reader: Any, key: str) -> dict[str, Any]:
    view: dict[str, Any] = {
        "available": False,
        "freshness": UNKNOWN,
        "age": None,
        "age_text": None,
        "scanned_at": None,
        "status": None,
        "event_flag": None,
        "counts": None,
        "warnings": [],
    }
    age = _file_age(reader, key, now)
    view["age"] = age
    view["age_text"] = _age_text(age)
    view["freshness"] = _mtime_freshness(age)
    if not (_read_ok(read) and silo_watch_valid(read.value)):
        view["warnings"].append("Silo default watch status is unavailable or invalid")
        return view
    state = read.value
    view["scanned_at"] = _iso(state.get("scannedAt"))
    view["status"] = scrub_text(state.get("status"), 24)
    view["event_flag"] = scrub_text(state.get("eventFlag"), 40)
    counts = state.get("counts") if isinstance(state.get("counts"), dict) else {}
    view["counts"] = {
        "tracked": counts.get("tracked") if _bounded_int(counts.get("tracked"), 100_000) else None,
        "in_band": counts.get("inBand") if _bounded_int(counts.get("inBand"), 100_000) else None,
        "newly_in_band": counts.get("newlyInBand") if _bounded_int(counts.get("newlyInBand"), 100_000) else None,
    }
    view["available"] = True
    return view


def build_bytecode(read: Any, now: float, reader: Any, key: str) -> dict[str, Any]:
    view: dict[str, Any] = {
        "available": False,
        "freshness": UNKNOWN,
        "age": None,
        "age_text": None,
        "checked_at": None,
        "summary": None,
        "labels": [],
        "warnings": [],
    }
    age = _file_age(reader, key, now)
    view["age"] = age
    view["age_text"] = _age_text(age)
    view["freshness"] = _mtime_freshness(age)
    if not (_read_ok(read) and bytecode_verification_valid(read.value)):
        view["warnings"].append("Deployed bytecode verification is unavailable or invalid")
        return view
    state = read.value
    summary = state["summary"]

    def _summary_int(name: str) -> int | None:
        value = summary.get(name)
        return value if _bounded_int(value, 10**9) else None

    view["checked_at"] = _iso(summary.get("checkedAt"))
    view["summary"] = {
        "total": _summary_int("total"),
        "immutable_masked_matches": _summary_int("immutableMaskedMatches"),
        "raw_matches": _summary_int("rawMatches"),
        "logic_metadata_matches": _summary_int("logicMetadataMatches"),
        "mismatches": _summary_int("mismatches"),
        "missing": _summary_int("missing"),
    }
    for item in state["results"]:
        if not isinstance(item, dict):
            continue
        label = item.get("label")
        if not isinstance(label, str) or not label.startswith(MASK_LABEL_PREFIXES):
            continue
        address = item.get("address")
        view["labels"].append(
            {
                "label": scrub_text(label, 40),
                "address": _short_address(address) if isinstance(address, str) and ADDRESS.fullmatch(address) else None,
                "status": scrub_text(item.get("status"), 32),
            }
        )
    view["labels"].sort(key=lambda row: row["label"] or "")
    view["available"] = True
    return view


def top_whale_triggers_valid(state: Any) -> bool:
    return bool(
        isinstance(state, dict)
        and state.get("schema") == TOP_WHALE_TRIGGERS_SCHEMA
        and timestamp(state.get("generatedAt")) is not None
        and isinstance(state.get("pin"), dict)
        and isinstance(state.get("targets"), dict)
    )


def v4_v3_morpho_deploy_valid(state: Any) -> bool:
    return bool(
        isinstance(state, dict)
        and state.get("ok") is True
        and isinstance(state.get("contractAddress"), str)
        and ADDRESS.fullmatch(state["contractAddress"]) is not None
        and timestamp(state.get("deployedAt")) is not None
    )


def aave_v4_flash_deploy_valid(state: Any) -> bool:
    return bool(
        isinstance(state, dict)
        and state.get("status") == "DEPLOYED_AND_TWO_PROVIDER_VERIFIED"
        and isinstance(state.get("contractAddress"), str)
        and ADDRESS.fullmatch(state["contractAddress"]) is not None
        and timestamp(state.get("recordedAt")) is not None
    )


def aave_v4_live_watch_valid(state: Any) -> bool:
    return bool(
        isinstance(state, dict)
        and state.get("ok") is True
        and isinstance(state.get("deployedExecutor"), str)
        and ADDRESS.fullmatch(state["deployedExecutor"]) is not None
        and timestamp(state.get("checkedAt")) is not None
        and isinstance(state.get("targets"), list)
    )


def top_whale_executor_watch_valid(state: Any) -> bool:
    return bool(
        isinstance(state, dict)
        and isinstance(state.get("ok"), bool)
        and timestamp(state.get("checkedAt")) is not None
        and isinstance(state.get("mode"), str)
    )


def aave_v4_rehearsal_valid(state: Any) -> bool:
    return bool(
        isinstance(state, dict)
        and state.get("status") == "MULTI_SPOKE_LOCAL_FORK_REHEARSAL_PASS"
        and timestamp(state.get("recordedAt")) is not None
    )


def _fork_poc_rehearsal_valid(state: Any, chain_id: int) -> bool:
    return bool(
        isinstance(state, dict)
        and state.get("schema") == "fork-poc/v1"
        and state.get("status") == "PASS"
        and type(state.get("chainId")) is int
        and state.get("chainId") == chain_id
        and timestamp(state.get("generatedAt")) is not None
        and isinstance(state.get("observations"), list)
    )


def base_morpho_rehearsal_valid(state: Any) -> bool:
    return _fork_poc_rehearsal_valid(state, 8453)


def base_morpho_deploy_valid(state: Any) -> bool:
    return bool(
        isinstance(state, dict)
        and state.get("ok") is True
        and state.get("status") == "DEPLOYED_ON_BASE_MAINNET"
        and state.get("chainId") == 8453
        and isinstance(state.get("contractAddress"), str)
        and ADDRESS.fullmatch(state["contractAddress"]) is not None
        and timestamp(state.get("recordedAt")) is not None
    )


def base_morpho_live_watch_valid(state: Any) -> bool:
    return bool(
        isinstance(state, dict)
        and state.get("ok") is True
        and state.get("chainId") == 8453
        and timestamp(state.get("checkedAt")) is not None
        and isinstance(state.get("mode"), str)
    )


def eth_morpho_rehearsal_valid(state: Any) -> bool:
    return _fork_poc_rehearsal_valid(state, 1)


PT_USDE_DAI_MARKET = "0x760b14c9003f08ac4bf0cfb02596ee4d6f0548a4fde5826bfd56befb9ed62ae9"
PT_USDE_DAI_USERS = {"#M8": "0x9b75df7f7cd5b74b8f0f0de8f4751c3f8e9695bb", "#M9": "0x64d85278a093ee5c57739c6c0de6c4eef53a1e02"}
PT_USDE_DAI_NOTE = "Staged & fork-proven via MorphoPendlePtRedeemUnwindRoundTrip (+882.71 / +338.44 DAI at block 26231521); frozen 1.00 oracle, passive accrual watch."


def _whale_calldata_ready(value: Any) -> bool:
    # executeMorpho has a flash amount plus a 16-word static tuple. This only
    # checks ABI shape, not deployment compatibility or execution eligibility.
    return isinstance(value, str) and re.fullmatch(r"0x[0-9a-fA-F]{1096}", value) is not None


def build_top_whale_triggers(
    triggers_read: Any,
    deploy_read: Any,
    now: float,
    reader: Any,
    triggers_key: str,
    deploy_key: str,
    v4_deploy_read: Any = None,
    v4_watch_read: Any = None,
    v4_rehearsal_read: Any = None,
    v3_watch_read: Any = None,
    base_rehearsal_read: Any = None,
    m1_rehearsal_read: Any = None,
    m2_rehearsal_read: Any = None,
    base_deploy_read: Any = None,
    base_watch_read: Any = None,
    m7_rehearsal_read: Any = None,
    pt_rehearsal_read: Any = None,
    yousd_rehearsal_read: Any = None,
    arb_morpho_watch: dict[str, Any] | None = None,
) -> dict[str, Any]:
    view: dict[str, Any] = {
        "available": False,
        "freshness": UNKNOWN,
        "age": None,
        "age_text": None,
        "generated_at": None,
        "pin_block": None,
        "pin_utc": None,
        "any_fired": False,
        "fired_triggers": [],
        "morpho_flash": {"usdc": None, "weth": None},
        "deploy": {
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
            "deployed_at": None,
        },
        "v4_executor": {
            "available": False,
            "contract_address": None,
            "short_address": None,
            "tx_hash": None,
            "short_tx": None,
            "block_number": None,
            "gas_used": None,
            "actual_fee_eth": None,
            "actual_fee_usd": None,
            "code_bytes": None,
            "owner": None,
            "owner_eth_after": None,
            "deployed_at": None,
            "two_provider_verified": False,
        },
        "v4_live_watch": {
            "available": False,
            "freshness": UNKNOWN,
            "age_text": None,
            "checked_at": None,
            "mode": None,
            "block_number": None,
            "fired_count": None,
        },
        "v3_live_watch": {
            "available": False,
            "freshness": UNKNOWN,
            "age_text": None,
            "checked_at": None,
            "mode": None,
            "partition": None,
            "block_number": None,
            "candidate_count": None,
        },
        "v4_rehearsal": {
            "available": False,
            "pin_block": None,
            "spoke_a_gain_usdc": None,
            "spoke_a_gas": None,
            "spoke_c_gain_weth": None,
            "spoke_c_gain_usd": None,
            "spoke_c_gas": None,
        },
        "base_rehearsal": {
            "available": False,
            "pin_block": None,
            "deploy_gas": None,
            "b1_gain_usdc": None,
            "b1_gas": None,
            "b2_gain_usdc": None,
            "b2_gas": None,
        },
        "base_executor": {
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
        },
        "base_live_watch": {
            "available": False,
            "freshness": UNKNOWN,
            "age_text": None,
            "checked_at": None,
            "mode": None,
            "block_number": None,
            "fired_count": None,
        },
        "morpho_rehearsal": {
            "available": False,
            "m1_pin_block": None,
            "m1_gain_dai": None,
            "m1_gas": None,
            "m2_pin_block": None,
            "m2_deploy_gas": None,
            "m2_gain_usdc": None,
            "m2_gas": None,
        },
        "morpho_fork_rehearsals": [],
        "targets": [],
        "warnings": [],
    }
    if _read_ok(deploy_read) and v4_v3_morpho_deploy_valid(deploy_read.value):
        d = deploy_read.value
        addr = d["contractAddress"]
        tx = d.get("txHash") if isinstance(d.get("txHash"), str) and HEX64.fullmatch(d["txHash"][2:]) else None
        owner = d.get("onchainOwner") if isinstance(d.get("onchainOwner"), str) and ADDRESS.fullmatch(d["onchainOwner"]) else None
        view["deploy"] = {
            "available": True,
            "contract_address": addr,
            "short_address": _short_address(addr),
            "tx_hash": tx,
            "short_tx": f"{tx[:10]}…{tx[-6:]}" if tx else None,
            "block_number": d.get("blockNumber") if _bounded_int(d.get("blockNumber"), 10**12) else None,
            "gas_used": scrub_text(str(d.get("gasUsed")), 24) if d.get("gasUsed") is not None else None,
            "actual_fee_eth": round(float(d["actualFeeEth"]), 6) if _nonneg_number(d.get("actualFeeEth")) else None,
            "code_bytes": d.get("deployedCodeBytes") if _bounded_int(d.get("deployedCodeBytes"), 100_000) else None,
            "owner": _short_address(owner) if owner else None,
            "deployed_at": _iso(d.get("deployedAt")),
        }

    if _read_ok(v4_deploy_read) and aave_v4_flash_deploy_valid(v4_deploy_read.value):
        vd = v4_deploy_read.value
        vaddr = vd["contractAddress"]
        vtx = vd.get("txHash") if isinstance(vd.get("txHash"), str) and HEX64.fullmatch(vd["txHash"][2:]) else None
        vowner = vd.get("owner") if isinstance(vd.get("owner"), str) and ADDRESS.fullmatch(vd["owner"]) else None
        bv = vd.get("bytecodeVerification") if isinstance(vd.get("bytecodeVerification"), dict) else {}
        view["v4_executor"] = {
            "available": True,
            "contract_address": vaddr,
            "short_address": _short_address(vaddr),
            "tx_hash": vtx,
            "short_tx": f"{vtx[:10]}…{vtx[-6:]}" if vtx else None,
            "block_number": vd.get("blockNumber") if _bounded_int(vd.get("blockNumber"), 10**12) else None,
            "gas_used": scrub_text(str(vd.get("gasUsed")), 24) if vd.get("gasUsed") is not None else None,
            "actual_fee_eth": scrub_text(str(vd.get("actualDeployFeeEth")), 24),
            "actual_fee_usd": scrub_text(str(vd.get("actualDeployFeeUsdApprox")), 24),
            "code_bytes": bv.get("deployedBytecodeBytes") if _bounded_int(bv.get("deployedBytecodeBytes"), 100_000) else None,
            "owner": _short_address(vowner) if vowner else None,
            "owner_eth_after": scrub_text(str(vd.get("ownerEthBalanceAfterFormatted")), 24),
            "deployed_at": _iso(vd.get("recordedAt")),
            "two_provider_verified": bv.get("twoProvidersAgreed") is True,
        }

    v4_watch_by_id: dict[str, dict[str, Any]] = {}
    v4_watch_pin: dict[str, Any] = {}
    if _read_ok(v4_watch_read) and aave_v4_live_watch_valid(v4_watch_read.value):
        vw = v4_watch_read.value
        w_fresh, w_age = _freshness_view(vw["checkedAt"], now)
        view["v4_live_watch"] = {
            "available": True,
            "freshness": w_fresh,
            "age_text": _age_text(w_age),
            "checked_at": _iso(vw.get("checkedAt")),
            "mode": scrub_text(str(vw.get("mode")), 40),
            "block_number": vw.get("blockNumber") if _bounded_int(vw.get("blockNumber"), 10**12) else None,
            "fired_count": vw.get("firedCount") if _bounded_int(vw.get("firedCount"), 100) else None,
        }
        unified = triggers_read.value if _read_ok(triggers_read) and isinstance(triggers_read.value, dict) else {}
        unified_time = timestamp(unified.get("generatedAt"))
        unified_pin = unified.get("pin") if isinstance(unified.get("pin"), dict) else {}
        watch_block = vw.get("blockNumber")
        unified_block = unified_pin.get("number")
        block_not_older = not (_bounded_int(watch_block, 10**12) and _bounded_int(unified_block, 10**12)) or watch_block >= unified_block
        if w_fresh == FRESH and block_not_older and (unified_time is None or timestamp(vw["checkedAt"]) >= unified_time):
            v4_watch_pin = vw.get("pin") if isinstance(vw.get("pin"), dict) else {}
            for item in vw.get("targets") or []:
                if isinstance(item, dict) and isinstance(item.get("id"), str):
                    v4_watch_by_id[item["id"]] = item

    if _read_ok(v3_watch_read) and top_whale_executor_watch_valid(v3_watch_read.value):
        vw3 = v3_watch_read.value
        w3_fresh, w3_age = _freshness_view(vw3["checkedAt"], now)
        pin3 = vw3.get("pin") if isinstance(vw3.get("pin"), dict) else {}
        block_num = vw3.get("blockNumber") if _bounded_int(vw3.get("blockNumber"), 10**12) else (pin3.get("number") if _bounded_int(pin3.get("number"), 10**12) else None)
        cand_count = vw3.get("candidateCount") if _bounded_int(vw3.get("candidateCount"), 100) else None
        view["v3_live_watch"] = {
            "available": True,
            "freshness": w3_fresh,
            "age_text": _age_text(w3_age),
            "checked_at": _iso(vw3.get("checkedAt")),
            "mode": scrub_text(str(vw3.get("mode")), 40),
            "partition": scrub_text(str(vw3.get("partition") or ""), 40) or None,
            "block_number": block_num,
            "candidate_count": cand_count,
        }

    if _read_ok(v4_rehearsal_read) and aave_v4_rehearsal_valid(v4_rehearsal_read.value):
        vr = v4_rehearsal_read.value
        rpin = vr.get("pin") if isinstance(vr.get("pin"), dict) else {}
        ra = vr.get("rehearsalSpokeA_UsdeUsdc_UniV3") if isinstance(vr.get("rehearsalSpokeA_UsdeUsdc_UniV3"), dict) else {}
        rc = vr.get("rehearsalSpokeC_WeethWeth_CurveNG") if isinstance(vr.get("rehearsalSpokeC_WeethWeth_CurveNG"), dict) else {}
        view["v4_rehearsal"] = {
            "available": True,
            "pin_block": rpin.get("number") if _bounded_int(rpin.get("number"), 10**12) else None,
            "spoke_a_gain_usdc": scrub_text(str(ra.get("ownerUsdcGainFormatted")), 32),
            "spoke_a_gas": scrub_text(str(ra.get("gasUsed")), 24),
            "spoke_c_gain_weth": scrub_text(str(rc.get("ownerWethGainFormatted")), 32),
            "spoke_c_gain_usd": scrub_text(str(rc.get("ownerWethGainUsdApprox")), 32),
            "spoke_c_gas": scrub_text(str(rc.get("gasUsed")), 24),
        }

    if _read_ok(base_rehearsal_read) and base_morpho_rehearsal_valid(base_rehearsal_read.value):
        br = base_rehearsal_read.value
        try:
            pin_block = int(br["block"]) if isinstance(br.get("block"), (int, str)) and str(br["block"]).isdigit() and _bounded_int(int(br["block"]), 10**12) else None
        except ValueError:
            # Some digit strings are not convertible or exceed Python's bound.
            pin_block = None
        base_view = {**view["base_rehearsal"], "available": True, "pin_block": pin_block}
        for observation in br.get("observations") or []:
            if not isinstance(observation, dict):
                continue
            label, value = observation.get("label"), observation.get("value")
            if label == "deployGasUsed":
                base_view["deploy_gas"] = scrub_text(str(value), 24)
            elif label == "baseUsdeRehearsalResults" and isinstance(value, list):
                for item in value:
                    if not isinstance(item, dict):
                        continue
                    if item.get("rank") == "#B0":
                        base_view["b0_gain_usdc"] = scrub_text(str(item.get("ownerUsdcGainFormatted")), 32)
                        base_view["b0_gas"] = scrub_text(str(item.get("gasUsed")), 24)
                    elif item.get("rank") == "#B1":
                        base_view["b1_gain_usdc"] = scrub_text(str(item.get("ownerUsdcGainFormatted")), 32)
                        base_view["b1_gas"] = scrub_text(str(item.get("gasUsed")), 24)
                    elif item.get("rank") == "#B2":
                        base_view["b2_gain_usdc"] = scrub_text(str(item.get("ownerUsdcGainFormatted")), 32)
                        base_view["b2_gas"] = scrub_text(str(item.get("gasUsed")), 24)
        view["base_rehearsal"] = base_view

    if _read_ok(yousd_rehearsal_read) and _fork_poc_rehearsal_valid(yousd_rehearsal_read.value, 8453):
        yr = yousd_rehearsal_read.value
        try:
            b7_block = int(yr["block"]) if isinstance(yr.get("block"), (int, str)) and str(yr["block"]).isdigit() and _bounded_int(int(yr["block"]), 10**12) else None
        except ValueError:
            b7_block = None
        base_view = view["base_rehearsal"]
        base_view.update(available=True, b7_pin_block=b7_block, b7_gain_usdc=None, b7_gas=None)
        # A standalone B7 artifact does not invent legacy B0 rehearsal results.
        base_view.setdefault("b0_gain_usdc", None)
        base_view.setdefault("b0_gas", None)
        for observation in yr["observations"]:
            if not isinstance(observation, dict) or observation.get("label") != "baseYoUsdUsdcResult":
                continue
            val = observation.get("value")
            if isinstance(val, dict) and val.get("rank") == "#B7":
                base_view["b7_gain_usdc"] = scrub_text(str(val["ownerUsdcGainFormatted"]), 32) if val.get("ownerUsdcGainFormatted") is not None else None
                base_view["b7_gas"] = scrub_text(str(val["gasUsed"]), 24) if val.get("gasUsed") is not None else None

    if _read_ok(base_deploy_read) and base_morpho_deploy_valid(base_deploy_read.value):
        bd = base_deploy_read.value
        addr = bd["contractAddress"]
        tx = bd.get("txHash") if isinstance(bd.get("txHash"), str) and re.fullmatch(r"0x[0-9a-fA-F]{64}", bd["txHash"]) else None
        view["base_executor"] = {
            "available": True,
            "contract_address": addr,
            "short_address": _short_address(addr),
            "tx_hash": tx,
            "short_tx": f"{tx[:10]}…{tx[-6:]}" if tx else None,
            "block_number": bd.get("blockNumber") if _bounded_int(bd.get("blockNumber"), 10**12) else None,
            "gas_used": scrub_text(str(bd["gasUsed"]), 24) if bd.get("gasUsed") is not None else None,
            "actual_fee_eth": scrub_text(str(bd["actualFeeEth"]), 24) if bd.get("actualFeeEth") is not None else None,
            "code_bytes": bd.get("deployedBytecodeBytes") if _bounded_int(bd.get("deployedBytecodeBytes"), 100_000) else None,
            "owner": _short_address(bd.get("actor")),
            "owner_eth_after": scrub_text(str(bd["ownerBaseEthAfter"]), 24) if bd.get("ownerBaseEthAfter") is not None else None,
            "deployed_at": _iso(bd["recordedAt"]),
        }

    if _read_ok(base_watch_read) and base_morpho_live_watch_valid(base_watch_read.value):
        bw = base_watch_read.value
        bw_fresh, bw_age = _freshness_view(bw["checkedAt"], now)
        view["base_live_watch"] = {
            "available": True,
            "freshness": bw_fresh,
            "age_text": _age_text(bw_age),
            "checked_at": _iso(bw["checkedAt"]),
            "mode": scrub_text(bw["mode"], 40),
            "block_number": bw.get("blockNumber") if _bounded_int(bw.get("blockNumber"), 10**12) else None,
            "fired_count": bw.get("firedCount") if _bounded_int(bw.get("firedCount"), 100) else None,
        }

    m_rehearsal = dict(view["morpho_rehearsal"])
    if _read_ok(m1_rehearsal_read) and eth_morpho_rehearsal_valid(m1_rehearsal_read.value):
        mr1 = m1_rehearsal_read.value
        try:
            m1_block = int(mr1["block"]) if isinstance(mr1.get("block"), (int, str)) and str(mr1["block"]).isdigit() and _bounded_int(int(mr1["block"]), 10**12) else None
        except ValueError:
            m1_block = None
        m_rehearsal["available"] = True
        m_rehearsal["m1_pin_block"] = m1_block
        for observation in mr1.get("observations") or []:
            if isinstance(observation, dict) and observation.get("label") == "ethMorphoUsdeDaiResult" and isinstance(observation.get("value"), dict):
                val = observation["value"]
                m_rehearsal["m1_gain_dai"] = scrub_text(str(val.get("ownerDaiGainFormatted")), 32)
                m_rehearsal["m1_gas"] = scrub_text(str(val.get("gasUsed")), 24)
    if _read_ok(m2_rehearsal_read) and eth_morpho_rehearsal_valid(m2_rehearsal_read.value):
        mr2 = m2_rehearsal_read.value
        try:
            m2_block = int(mr2["block"]) if isinstance(mr2.get("block"), (int, str)) and str(mr2["block"]).isdigit() and _bounded_int(int(mr2["block"]), 10**12) else None
        except ValueError:
            m2_block = None
        m_rehearsal["available"] = True
        m_rehearsal["m2_pin_block"] = m2_block
        view["morpho_fork_rehearsals"].append({
            "rank": "#M2",
            "executor": "0x2d5bca1b846e89965544c7f03d09a25126803627",
            "deployed_block": 26231360,
            "deployment_tx": "0xe0c22fc05b42a527deae2abef2e4f76000be39211c9051c198ca5a9f4412cb06",
            "notes": ["+2,111.52 USDC fork-proven in 365,773 gas; conditional before gas, not realized mainnet profit."],
        })
        for observation in mr2.get("observations") or []:
            if not isinstance(observation, dict):
                continue
            label, val = observation.get("label"), observation.get("value")
            if label == "deployGasUsed" and val is not None:
                m_rehearsal["m2_deploy_gas"] = scrub_text(str(val), 24)
            elif label == "ethMorphoReusdUsdcResult" and isinstance(val, dict):
                m_rehearsal["m2_gain_usdc"] = scrub_text(str(val.get("ownerUsdcGainFormatted")), 32)
                m_rehearsal["m2_gas"] = scrub_text(str(val.get("gasUsed")), 24)
    if _read_ok(m7_rehearsal_read) and eth_morpho_rehearsal_valid(m7_rehearsal_read.value):
        mr7 = m7_rehearsal_read.value
        try:
            m7_block = int(mr7["block"]) if isinstance(mr7.get("block"), (int, str)) and str(mr7["block"]).isdigit() and _bounded_int(int(mr7["block"]), 10**12) else None
        except ValueError:
            m7_block = None
        m_rehearsal.update(available=True, m7_pin_block=m7_block, m7_deploy_gas=None, m7_gain_mseth=None, m7_gas=None)
        view["morpho_fork_rehearsals"].append({
            "rank": "#M7",
            "executor": "0xc06326bc6fbd4305cdab4de8e239b7b80feb2eb4",
            "deployed_block": 26231193,
            "deployment_tx": "0x8589450c5988e3eb12e735b65d5a5841d7d127d30377f28a28e1641f66178e11",
            "notes": [
                "11.34 ynETHx -> +1.8939 msETH (12.67 WETH idle refill).",
                "50.00 ynETHx -> +7.5315 msETH (60 WETH full refill).",
                "Conditional local-fork gains before gas; not realized mainnet profit.",
            ],
        })
        for observation in mr7.get("observations") or []:
            if not isinstance(observation, dict):
                continue
            label, val = observation.get("label"), observation.get("value")
            if label == "deployGasUsed" and val is not None:
                m_rehearsal["m7_deploy_gas"] = scrub_text(str(val), 24)
            elif label == "ethMorphoYnethxMsethResult" and isinstance(val, dict):
                m_rehearsal["m7_gain_mseth"] = scrub_text(str(val["ownerMsethGainFormatted"]), 32) if val.get("ownerMsethGainFormatted") is not None else None
                m_rehearsal["m7_gas"] = scrub_text(str(val["gasUsed"]), 24) if val.get("gasUsed") is not None else None
    if _read_ok(pt_rehearsal_read) and _fork_poc_rehearsal_valid(pt_rehearsal_read.value, 1):
        pr = pt_rehearsal_read.value
        try:
            m8_block = int(pr["block"]) if isinstance(pr.get("block"), (int, str)) and str(pr["block"]).isdigit() and _bounded_int(int(pr["block"]), 10**12) else None
        except ValueError:
            m8_block = None
        m_rehearsal.update(available=True, m8_pin_block=m8_block, m8_deploy_gas=None,
                           m8_gain_dai=None, m8_gas=None, m9_gain_dai=None, m9_gas=None)
        for observation in pr["observations"]:
            if not isinstance(observation, dict):
                continue
            label, val = observation.get("label"), observation.get("value")
            if label == "deployGasUsed" and val is not None:
                m_rehearsal["m8_deploy_gas"] = scrub_text(str(val), 24)
            elif label == "ethMorphoPtUsdeDaiResult" and isinstance(val, dict) and val.get("rank") in ("#M8", "#M9"):
                prefix = val["rank"][1:].lower()
                m_rehearsal[f"{prefix}_gain_dai"] = scrub_text(str(val["ownerDaiGainFormatted"]), 32) if val.get("ownerDaiGainFormatted") is not None else None
                m_rehearsal[f"{prefix}_gas"] = scrub_text(str(val["gasUsed"]), 24) if val.get("gasUsed") is not None else None
    view["morpho_rehearsal"] = m_rehearsal

    age = _file_age(reader, triggers_key, now)
    view["age"] = age
    view["age_text"] = _age_text(age)
    view["freshness"] = _mtime_freshness(age)
    if not (_read_ok(triggers_read) and top_whale_triggers_valid(triggers_read.value)):
        view["warnings"].append("Top whale trigger sentinel status is unavailable or invalid")
        return view

    state = triggers_read.value
    fresh, calc_age = _freshness_view(state["generatedAt"], now)
    view["freshness"] = fresh
    view["age"] = calc_age
    view["age_text"] = _age_text(calc_age)
    view["generated_at"] = _iso(state.get("generatedAt"))
    pin = state.get("pin") or {}
    view["pin_block"] = pin.get("number") if _bounded_int(pin.get("number"), 10**12) else None
    view["pin_utc"] = _iso(pin.get("utc"))
    fired = state.get("firedTriggers")
    if isinstance(fired, list):
        # Legacy PAXG liquidity alerts are observations, never execution triggers.
        view["fired_triggers"] = [scrub_text(str(item), 64) for item in fired if item and not str(item).startswith("TARGET_3_MORPHO_PAXG_")][:8]
    view["any_fired"] = bool(view["fired_triggers"])

    mf = state.get("morphoZeroFeeFlashLiquidity") or {}
    view["morpho_flash"] = {
        "usdc": round(float(mf["usdc"]), 2) if _nonneg_number(mf.get("usdc")) else None,
        "weth": round(float(mf["weth"]), 2) if _nonneg_number(mf.get("weth")) else None,
    }

    t_map = state.get("targets") or {}
    t1 = t_map.get("target1_AaveV4_USDe_USDC")
    if isinstance(t1, dict):
        q1 = t1.get("liveQuote") if isinstance(t1.get("liveQuote"), dict) else {}
        u1 = t1.get("user") if isinstance(t1.get("user"), str) and ADDRESS.fullmatch(t1["user"]) else None
        sp1 = t1.get("spoke") if isinstance(t1.get("spoke"), str) and ADDRESS.fullmatch(t1["spoke"]) else None
        live_t1 = v4_watch_by_id.get("spokeA-candidate1-usde-usdc", {})
        hf_str = scrub_text(live_t1.get("healthFactorFormatted"), 24) or (f"{float(t1['healthFactor']):.6f}" if _nonneg_number(t1.get("healthFactor")) else None)
        bps_str = scrub_text(str(live_t1["bpsToLiquidation"]), 24) if live_t1.get("bpsToLiquidation") is not None else (f"{float(t1['bpsToLiquidation']):.4f}" if isinstance(t1.get("bpsToLiquidation"), (int, float)) else None)
        view["targets"].append({
            "id": "target-1-aave-v4-usde-usdc",
            "rank": "#1",
            "label": "Aave V4 USDe / USDC Whale",
            "protocol": "Aave V4",
            "pair": "USDe / USDC",
            "user_short": _short_address(u1) if u1 else "0x1cb4…8894",
            "venue_short": _short_address(sp1) if sp1 else "0xba1B…08AF",
            "liquidatable_now": live_t1.get("isLiquidatableBothProviders") is True if live_t1 else t1.get("liquidatableNow") is True,
            "health_factor": hf_str,
            "bps_to_liq": bps_str,
            "heartbeat_hours_left": f"{float(t1['hoursUntil24hHeartbeat']):.2f}h" if _nonneg_number(t1.get("hoursUntil24hHeartbeat")) else None,
            "passive_hours_left": f"{float(t1['passiveHoursToCrossing']):.2f}h" if _nonneg_number(t1.get("passiveHoursToCrossing")) else None,
            "repay_summary": f"{q1.get('repayUsdc')} USDC" if _nonneg_number(q1.get("repayUsdc")) else None,
            "seized_summary": f"{q1.get('seizedUsde')} USDe" if _nonneg_number(q1.get("seizedUsde")) else None,
            "surplus_usd": f"+${float(q1['grossSurplusUsdc']):,.2f}" if _nonneg_number(q1.get("grossSurplusUsdc")) else None,
            "executor": view["deploy"]["short_address"],
            "calldata_ready": _whale_calldata_ready(t1.get("readyExecuteMorphoCalldata")),
            "observation_block": view["v4_live_watch"]["block_number"] if live_t1 else view["pin_block"],
            "observation_utc": _iso(v4_watch_pin.get("utc")) if live_t1 else view["pin_utc"],
        })

    spoke_c = t_map.get("spokeC_AaveV4_weETH_WETH")
    live_c3 = v4_watch_by_id.get("spokeC-candidate3-weeth-weth")
    c3_user = live_c3.get("borrower", "0x1a557354c5b8d7df38ea914209e416dc7065b158") if isinstance(live_c3, dict) else None
    c3_spoke = live_c3.get("spoke", "0xbf10bdfe177de0336afd7fccf80a904e15386219") if isinstance(live_c3, dict) else None
    c3_in_array = isinstance(spoke_c, list) and any(
        isinstance(item, dict) and isinstance(item.get("user"), str) and isinstance(item.get("spoke"), str)
        and item["user"].lower() == str(c3_user).lower() and item["spoke"].lower() == str(c3_spoke).lower()
        for item in spoke_c[:8]
    )
    if isinstance(live_c3, dict) and not c3_in_array:
        view["targets"].append({
            "id": "target-1b-aave-v4-weeth-weth-0x1a55",
            "rank": "#1B",
            "label": "Aave V4 weETH / WETH Whale (Spoke C)",
            "protocol": "Aave V4",
            "pair": "weETH / WETH",
            "user_short": _short_address(c3_user),
            "venue_short": _short_address(c3_spoke),
            "liquidatable_now": live_c3.get("isLiquidatableBothProviders") is True,
            "health_factor": scrub_text(str(live_c3.get("healthFactorFormatted")), 24),
            "bps_to_liq": scrub_text(str(live_c3.get("bpsToLiquidation")), 24),
            "heartbeat_hours_left": None,
            "passive_hours_left": None,
            "repay_summary": None,
            "seized_summary": None,
            "surplus_usd": None,
            "executor": view["v4_executor"]["short_address"],
            "calldata_ready": False,
            "observation_block": view["v4_live_watch"]["block_number"],
            "observation_utc": _iso(v4_watch_pin.get("utc")),
        })

    for key, rank, title in (
        ("target2A_AaveV3_weETH_WETH_0x7231", "#2A", "Aave V3 weETH / WETH Whale #1"),
        ("target2B_AaveV3_weETH_WETH_0x1A55", "#2B", "Aave V3 weETH / WETH Whale #2"),
    ):
        t2 = t_map.get(key)
        if isinstance(t2, dict):
            q2 = t2.get("liveQuote") if isinstance(t2.get("liveQuote"), dict) else {}
            u2 = t2.get("user") if isinstance(t2.get("user"), str) and ADDRESS.fullmatch(t2["user"]) else None
            p2 = t2.get("pool") if isinstance(t2.get("pool"), str) and ADDRESS.fullmatch(t2["pool"]) else None
            view["targets"].append({
                "id": key.lower().replace("_", "-"),
                "rank": rank,
                "label": title,
                "protocol": "Aave V3",
                "pair": "weETH / WETH",
                "user_short": _short_address(u2) if u2 else None,
                "venue_short": _short_address(p2) if p2 else "0x8787…fA4E2",
                "liquidatable_now": t2.get("liquidatableNow") is True,
                "health_factor": f"{float(t2['healthFactor']):.6f}" if _nonneg_number(t2.get("healthFactor")) else None,
                "bps_to_liq": f"{float(t2['bpsToLiquidation']):.4f}" if _nonneg_number(t2.get("bpsToLiquidation")) else None,
                "heartbeat_hours_left": f"${float(t2['collateralUsd']):,.0f} coll" if _nonneg_number(t2.get("collateralUsd")) else None,
                "passive_hours_left": f"${float(t2['debtUsd']):,.0f} debt" if _nonneg_number(t2.get("debtUsd")) else None,
                "repay_summary": f"{q2.get('repayWeth')} WETH" if _nonneg_number(q2.get("repayWeth")) else None,
                "seized_summary": f"{q2.get('seizedWeEth')} weETH" if _nonneg_number(q2.get("seizedWeEth")) else None,
                "surplus_usd": f"+${float(q2['grossSurplusUsd']):,.2f} (+{q2.get('grossSurplusWeth')} WETH)" if _nonneg_number(q2.get("grossSurplusUsd")) else None,
                "executor": view["deploy"]["short_address"],
                "calldata_ready": _whale_calldata_ready(t2.get("readyExecuteMorphoCalldata")),
            })

    for key, ident, rank in (
        ("target2K_AaveV3_WETH_WETH_0x7a05", "aave-v3-weth-weth-0x7a05", "#2K"),
        ("target2L_AaveV3_WETH_WETH_0xd185", "aave-v3-weth-weth-0xd185", "#2L"),
        ("target2M_AaveV3_WETH_WETH_0xf316", "aave-v3-weth-weth-0xf316", "#2M"),
        ("target2N_AaveV3_weETH_WETH_0xee28", "aave-v3-weeth-weth-0xee28", "#2N"),
        ("target2O_AaveV3_weETH_WETH_0x5047", "aave-v3-weeth-weth-0x5047", "#2O"),
        ("target2P_AaveV3_weETH_WETH_0x1d46", "aave-v3-weeth-weth-0x1d46", "#2P"),
        ("target2Q_AaveV3_weETH_WETH_0x5410", "aave-v3-weeth-weth-0x5410", "#2Q"),
    ):
        item = t_map.get(key)
        if not isinstance(item, dict):
            continue
        q = item.get("liveQuote") if isinstance(item.get("liveQuote"), dict) else {}
        u = item.get("user") if isinstance(item.get("user"), str) and ADDRESS.fullmatch(item["user"]) else None
        pool = item.get("pool") or item.get("marketId")
        pool = pool if isinstance(pool, str) and ADDRESS.fullmatch(pool) else "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2"
        same_asset = rank in {"#2K", "#2L", "#2M"}
        pair = "WETH / WETH (Same-Asset)" if same_asset else "weETH / WETH"
        collateral_symbol = "WETH" if same_asset else "weETH"
        view["targets"].append({
            "id": ident, "rank": rank,
            "label": f"Aave V3 {pair} ({_short_address(u) if u else 'whale'})",
            "protocol": "Aave V3", "pair": pair,
            "user_short": _short_address(u), "venue_short": _short_address(pool),
            "liquidatable_now": item.get("liquidatableNow") is True,
            "health_factor": f"{float(item['healthFactor']):.6f}" if _nonneg_number(item.get("healthFactor")) else None,
            "bps_to_liq": f"{float(item['bpsToLiquidation']):.4f}" if _nonneg_number(item.get("bpsToLiquidation")) else None,
            "heartbeat_hours_left": f"${float(item['collateralUsd']):,.0f} coll" if _nonneg_number(item.get("collateralUsd")) else None,
            "passive_hours_left": f"${float(item['debtUsd']):,.0f} debt" if _nonneg_number(item.get("debtUsd")) else None,
            "repay_summary": f"{q.get('repayWeth')} WETH" if _nonneg_number(q.get("repayWeth")) else None,
            "seized_summary": f"{q.get('seizedWeEth')} {collateral_symbol}" if _nonneg_number(q.get("seizedWeEth")) else None,
            "surplus_usd": f"+${float(q['grossSurplusUsd']):,.2f} (+{q.get('grossSurplusWeth')} WETH)" if _nonneg_number(q.get("grossSurplusUsd")) else None,
            "executor": "0xf09a01a6c23b936d5a51abce87a6ec8442a44262",
            "readiness_note": f"Unified Morpho {rank[1:]} on 0xf09a...4262; subject to live preflight.",
            "calldata_ready": _whale_calldata_ready(item.get("readyExecuteMorphoCalldata")),
        })

    extra_v3 = t_map.get("additional_AaveV3_weETH_WETH")
    if isinstance(extra_v3, list):
        for idx, item in enumerate(extra_v3[:8]):
            if not isinstance(item, dict):
                continue
            q = item.get("liveQuote") if isinstance(item.get("liveQuote"), dict) else {}
            u = item.get("user") if isinstance(item.get("user"), str) and ADDRESS.fullmatch(item["user"]) else None
            p = item.get("pool") if isinstance(item.get("pool"), str) and ADDRESS.fullmatch(item["pool"]) else None
            view["targets"].append({
                "id": f"aave-v3-extra-{idx}",
                "rank": scrub_text(str(item.get("rank") or f"#2{chr(67 + idx)}"), 8),
                "label": f"Aave V3 weETH / WETH ({_short_address(u) if u else 'whale'})",
                "protocol": "Aave V3",
                "pair": "weETH / WETH",
                "user_short": _short_address(u) if u else None,
                "venue_short": _short_address(p) if p else "0x8787…fA4E2",
                "liquidatable_now": item.get("liquidatableNow") is True,
                "health_factor": f"{float(item['healthFactor']):.6f}" if _nonneg_number(item.get("healthFactor")) else None,
                "bps_to_liq": f"{float(item['bpsToLiquidation']):.4f}" if _nonneg_number(item.get("bpsToLiquidation")) else None,
                "heartbeat_hours_left": f"${float(item['collateralUsd']):,.0f} coll" if _nonneg_number(item.get("collateralUsd")) else None,
                "passive_hours_left": f"${float(item['debtUsd']):,.0f} debt" if _nonneg_number(item.get("debtUsd")) else None,
                "repay_summary": f"{q.get('repayWeth')} WETH" if _nonneg_number(q.get("repayWeth")) else None,
                "seized_summary": f"{q.get('seizedWeEth')} weETH" if _nonneg_number(q.get("seizedWeEth")) else None,
                "surplus_usd": f"+${float(q['grossSurplusUsd']):,.2f} (+{q.get('grossSurplusWeth')} WETH)" if _nonneg_number(q.get("grossSurplusUsd")) else None,
                "executor": view["deploy"]["short_address"],
                "calldata_ready": _whale_calldata_ready(item.get("readyExecuteMorphoCalldata")),
            })

    if isinstance(spoke_c, list):
        for idx, item in enumerate(spoke_c[:8]):
            if not isinstance(item, dict):
                continue
            q = item.get("liveQuote") if isinstance(item.get("liveQuote"), dict) else {}
            u = item.get("user") if isinstance(item.get("user"), str) and ADDRESS.fullmatch(item["user"]) else None
            sp = item.get("spoke") if isinstance(item.get("spoke"), str) and ADDRESS.fullmatch(item["spoke"]) else None
            view["targets"].append({
                "id": f"spoke-c-{idx}",
                "rank": scrub_text(str(item.get("rank") or f"#C{idx+1}"), 8),
                "label": f"Aave V4 Spoke C weETH / WETH ({_short_address(u) if u else 'whale'})",
                "protocol": "Aave V4",
                "pair": "weETH / WETH",
                "user_short": _short_address(u),
                "venue_short": _short_address(sp) if sp else "0xbF10…6219",
                "liquidatable_now": item.get("liquidatableNow") is True,
                "health_factor": f"{float(item['healthFactor']):.6f}" if _nonneg_number(item.get("healthFactor")) else None,
                "bps_to_liq": f"{float(item['bpsToLiquidation']):.4f}" if _nonneg_number(item.get("bpsToLiquidation")) else None,
                "heartbeat_hours_left": f"${float(item['collateralUsd']):,.0f} coll" if _nonneg_number(item.get("collateralUsd")) else None,
                "passive_hours_left": f"${float(item['debtUsd']):,.0f} debt" if _nonneg_number(item.get("debtUsd")) else None,
                "repay_summary": f"{q.get('repayWeth')} WETH" if _nonneg_number(q.get("repayWeth")) else None,
                "seized_summary": f"{q.get('seizedWeEth')} weETH" if _nonneg_number(q.get("seizedWeEth")) else None,
                "surplus_usd": f"+${float(q['grossSurplusUsd']):,.2f} (+{q.get('grossSurplusWeth')} WETH)" if _nonneg_number(q.get("grossSurplusUsd")) else None,
                "executor": view["deploy"]["short_address"],
                "calldata_ready": _whale_calldata_ready(item.get("readyExecuteMorphoCalldata")),
            })

    m1 = t_map.get("targetM1_Morpho_USDe_DAI")
    if isinstance(m1, dict):
        qm = m1.get("liveQuote") if isinstance(m1.get("liveQuote"), dict) else {}
        u = m1.get("user") if isinstance(m1.get("user"), str) and ADDRESS.fullmatch(m1["user"]) else None
        view["targets"].append({
            "id": "target-m1-morpho-usde-dai",
            "rank": "#M1",
            "label": "Morpho Eth USDe / DAI Whale (0xa360…1089)",
            "protocol": "Morpho Blue",
            "pair": "USDe / DAI",
            "user_short": _short_address(u),
            "venue_short": "0xBBBB…FFCb",
            "liquidatable_now": m1.get("liquidatableNow") is True,
            "health_factor": f"{float(m1['healthFactor']):.6f} HF" if _nonneg_number(m1.get("healthFactor")) else None,
            "bps_to_liq": f"{float(m1['bpsToLiquidation']):.2f} bps to liq" if _nonneg_number(m1.get("bpsToLiquidation")) else None,
            "heartbeat_hours_left": f"${float(m1['collateralUsd']):,.0f} USDe coll" if _nonneg_number(m1.get("collateralUsd")) else None,
            "passive_hours_left": f"${float(m1['debtUsd']):,.0f} DAI debt ({float(m1['passiveHoursToCrossing']):.1f}h passive)" if _nonneg_number(m1.get("passiveHoursToCrossing")) and _nonneg_number(m1.get("debtUsd")) else (f"${float(m1['debtUsd']):,.0f} DAI debt" if _nonneg_number(m1.get("debtUsd")) else None),
            "repay_summary": f"{qm.get('repayDai')} DAI" if _nonneg_number(qm.get("repayDai")) else None,
            "seized_summary": f"{qm.get('seizedUsde')} USDe" if _nonneg_number(qm.get("seizedUsde")) else None,
            "surplus_usd": f"+${float(qm['grossSurplusDai']):,.2f} DAI" if _nonneg_number(qm.get("grossSurplusDai")) else None,
            "executor": "0xaf5b…07ba",
            "calldata_ready": isinstance(m1.get("readyExecuteMorphoBlueCalldata"), str) and len(m1["readyExecuteMorphoBlueCalldata"]) >= 650 and m1["readyExecuteMorphoBlueCalldata"].startswith("0x834cbf54"),
        })

    m2 = t_map.get("targetM2_Morpho_reUSD_USDC")
    if isinstance(m2, dict):
        qm = m2.get("liveQuote") if isinstance(m2.get("liveQuote"), dict) else {}
        u = m2.get("user") if isinstance(m2.get("user"), str) and ADDRESS.fullmatch(m2["user"]) else None
        gross = qm.get("grossSurplusUsdc")
        gross_valid = isinstance(gross, (int, float)) and not isinstance(gross, bool) and -1e60 <= gross <= 1e60
        bps = m2.get("bpsToLiquidation")
        bps_valid = isinstance(bps, (int, float)) and not isinstance(bps, bool) and -1e60 <= bps <= 1e60
        debt_text = f"{float(m2['debtUsd']):,.2f} USDC debt" if _nonneg_number(m2.get("debtUsd")) else None
        if debt_text is not None and _nonneg_number(m2.get("passiveHoursToCrossing")):
            debt_text += f" ({float(m2['passiveHoursToCrossing']):.1f}h passive estimate)"
        view["targets"].append({
            "id": "target-m2-morpho-reusd-usdc",
            "rank": "#M2",
            "label": "Morpho Eth reUSD / USDC Whale (0xaa34…5dd5)",
            "protocol": "Morpho Blue",
            "pair": "reUSD / USDC",
            "user_short": _short_address(u),
            "venue_short": "0xBBBB…FFCb",
            "observation_only": False,
            "armed": True,
            "executable_now": m2.get("executableNow") is True,
            "readiness_note": "Armed on Curve-unwind executor 0x2d5b…3627 (+2,111.52 USDC fork-proven in 365,773 gas).",
            "liquidatable_now": m2.get("liquidatableNow") if isinstance(m2.get("liquidatableNow"), bool) else None,
            "health_factor": f"{float(m2['healthFactor']):.6f} HF" if _nonneg_number(m2.get("healthFactor")) else None,
            "bps_to_liq": f"{float(bps):.2f} bps to liq" if bps_valid else None,
            "heartbeat_hours_left": f"{float(m2['collateralUsd']):,.2f} USDC collateral value" if _nonneg_number(m2.get("collateralUsd")) else None,
            "passive_hours_left": debt_text,
            "repay_summary": f"{qm.get('repayUsdc')} USDC" if _nonneg_number(qm.get("repayUsdc")) else None,
            "seized_summary": f"{qm.get('seizedReusd')} reUSD" if _nonneg_number(qm.get("seizedReusd")) else None,
            "surplus_usd": f"{float(gross):+,.2f} USDC (gross, pre-gas)" if gross_valid else None,
            "executor": "0x2d5bca1b846e89965544c7f03d09a25126803627",
            "calldata_ready": isinstance(m2.get("readyExecuteCurveUnwindCalldata"), str) and re.fullmatch(r"0x[0-9a-fA-F]{1032}", m2["readyExecuteCurveUnwindCalldata"]) is not None,
        })

    t2j = t_map.get("target2J_AaveV3_wstETH_WETH_0x037a")
    if isinstance(t2j, dict):
        q2j = t2j.get("liveQuote") if isinstance(t2j.get("liveQuote"), dict) else {}
        u2j = t2j.get("user") if isinstance(t2j.get("user"), str) and ADDRESS.fullmatch(t2j["user"]) else None
        p2j = t2j.get("pool") if isinstance(t2j.get("pool"), str) and ADDRESS.fullmatch(t2j["pool"]) else None
        view["targets"].append({
            "id": "target2j-aavev3-wsteth-weth-0x037a",
            "rank": "#2J",
            "label": f"Aave V3 wstETH / WETH ({_short_address(u2j) if u2j else 'whale'})",
            "protocol": "Aave V3",
            "pair": "wstETH / WETH",
            "user_short": _short_address(u2j) if u2j else None,
            "venue_short": _short_address(p2j) if p2j else "0x8787…fA4E2",
            "liquidatable_now": t2j.get("liquidatableNow") is True,
            "health_factor": f"{float(t2j['healthFactor']):.6f}" if _nonneg_number(t2j.get("healthFactor")) else None,
            "bps_to_liq": f"{float(t2j['bpsToLiquidation']):.4f}" if _nonneg_number(t2j.get("bpsToLiquidation")) else None,
            "heartbeat_hours_left": f"${float(t2j['collateralUsd']):,.0f} coll" if _nonneg_number(t2j.get("collateralUsd")) else None,
            "passive_hours_left": f"${float(t2j['debtUsd']):,.0f} debt" if _nonneg_number(t2j.get("debtUsd")) else None,
            "repay_summary": f"{q2j.get('repayWeth')} WETH" if _nonneg_number(q2j.get("repayWeth")) else None,
            "seized_summary": f"{q2j.get('seizedWstEth')} wstETH" if _nonneg_number(q2j.get("seizedWstEth")) else None,
            "surplus_usd": f"+${float(q2j['grossSurplusUsd']):,.2f} (+{q2j.get('grossSurplusWeth')} WETH)" if _nonneg_number(q2j.get("grossSurplusUsd")) else None,
            "executor": view["deploy"]["short_address"],
            "calldata_ready": _whale_calldata_ready(t2j.get("readyExecuteMorphoCalldata")),
        })

    for key, ident, rank, debt_snapshot, bps_snapshot in (
        ("targetS1_Spark_wstETH_WETH_0x4b28", "spark-wsteth-weth-0x4b28", "#S1", "$2.07M", "21.88"),
        ("targetS2_Spark_wstETH_WETH_0xf8f5", "spark-wsteth-weth-0xf8f5", "#S2", "$6.11M", "22.09"),
        ("targetS3_Spark_wstETH_WETH_0x0f8f", "spark-wsteth-weth-0x0f8f", "#S3", "$3.53M", "23.06"),
        ("targetS4_Spark_wstETH_WETH_0x1964", "spark-wsteth-weth-0x1964", "#S4", "$2.41M", "23.09"),
    ):
        item = t_map.get(key)
        if not isinstance(item, dict):
            continue
        q = item.get("liveQuote") if isinstance(item.get("liveQuote"), dict) else {}
        u = item.get("user") if isinstance(item.get("user"), str) and ADDRESS.fullmatch(item["user"]) else None
        pool = item.get("pool") or item.get("marketId")
        pool = pool if isinstance(pool, str) and ADDRESS.fullmatch(pool) else "0xc13e21b648a5ee794902342038ff3adab66be987"
        view["targets"].append({
            "id": ident, "rank": rank,
            "label": f"SparkLend wstETH / WETH ({_short_address(u) if u else 'whale'})",
            "protocol": "SparkLend", "pair": "wstETH / WETH (SparkLend)",
            "user_short": _short_address(u), "venue_short": _short_address(pool),
            "liquidatable_now": item.get("liquidatableNow") is True,
            "health_factor": f"{float(item['healthFactor']):.6f}" if _nonneg_number(item.get("healthFactor")) else None,
            "bps_to_liq": f"{float(item['bpsToLiquidation']):.4f}" if _nonneg_number(item.get("bpsToLiquidation")) else None,
            "heartbeat_hours_left": f"${float(item['collateralUsd']):,.0f} coll" if _nonneg_number(item.get("collateralUsd")) else None,
            "passive_hours_left": f"${float(item['debtUsd']):,.0f} WETH debt" if _nonneg_number(item.get("debtUsd")) else None,
            "repay_summary": f"{q.get('repayWeth')} WETH" if _nonneg_number(q.get("repayWeth")) else None,
            "seized_summary": f"{q.get('seizedWstEth')} wstETH" if _nonneg_number(q.get("seizedWstEth")) else None,
            "surplus_usd": f"+${float(q['grossSurplusUsd']):,.2f} (+{q.get('grossSurplusWeth')} WETH)" if _nonneg_number(q.get("grossSurplusUsd")) else None,
            "executor": "0xf09a01a6c23b936d5a51abce87a6ec8442a44262",
            "readiness_note": f"Unified Morpho {rank[1:]} on 0xf09a...4262; snapshot {debt_snapshot} WETH debt at {bps_snapshot} bps. eth_call-proven +0.44 WETH / +$1,060 per 50 WETH tranche (gross, pre-gas); subject to live preflight.",
            "calldata_ready": _whale_calldata_ready(item.get("readyExecuteMorphoCalldata")),
        })

    for source_key, ident, rank, pair, readiness in (
        ("targetA3_AaveV4_USDe_USDC_0x1d9c", "target-a3-aave-v4-usde-usdc-0x1d9c", "#A3", "USDe / USDC",
         "Fork-proven on 0x3c02…ecb7 (+6,242.30 USDC); observation-only to preserve 9-plan V4 watch cap."),
        ("targetA4_AaveV4_SameAsset_0xa429", "target-a4-aave-v4-same-asset-0xa429", "#A4", "WETH / USDC (Same-Asset)",
         "ARMED on Unified 0xf09a...4262 (same-asset WETH/WETH Reserve 0, ~0.0337 WETH / ~$82.64 bonus, 0.01 WETH min profit)."),
        ("targetA5_AaveV4_syrupUSDG_USDG_0x080c", "target-a5-aave-v4-syrupusdg-usdg-0x080c", "#A5", "syrupUSDG / USDG (UniV4)",
         "ARMED on UniV4 0x6125...5e1f ($3.79M USDG debt / $4.13M syrupUSDG collateral -> UniV4 PoolManager, +$31,533.20 USDG fork-proven)."),
        ("targetA6_AaveV4_syrupUSDG_USDG_0xbd81", "target-a6-aave-v4-syrupusdg-usdg-0xbd81", "#A6", "syrupUSDG / USDG (UniV4)",
         "ARMED on UniV4 0x6125...5e1f ($170.16k USDG r0 debt / $185.63k syrupUSDG collateral -> 65k small-crossing tranche, +$2,434.50 USDG)."),
        ("targetA7_AaveV4_syrupUSDG_USDG_0x28e8", "target-a7-aave-v4-syrupusdg-usdg-0x28e8", "#A7", "syrupUSDG / USDG (UniV4)",
         "ARMED on UniV4 0x6125...5e1f ($3.02M USDG r0 debt / $3.31M syrupUSDG collateral -> UniV4 PoolManager, +$31,533.20 USDG)."),
        ("targetA8_AaveV4_syrupUSDG_USDG_0x707e", "target-a8-aave-v4-syrupusdg-usdg-0x707e", "#A8", "syrupUSDG / USDG (UniV4)",
         "ARMED on UniV4 0x6125...5e1f ($3.71M USDG r0 debt / $4.07M syrupUSDG collateral -> 850k tranche, +$31,533.20 USDG)."),
        ("targetA9_AaveV4_syrupUSDG_USDG_0x90ff", "target-a9-aave-v4-syrupusdg-usdg-0x90ff", "#A9", "syrupUSDG / USDG (UniV4)",
         "ARMED on UniV4 0x6125...5e1f ($7.70M USDG r0 debt / $8.45M syrupUSDG collateral -> 850k tranche, +$31,533.20 USDG)."),
        ("targetA10_AaveV4_syrupUSDG_USDG_0x6efc", "target-a10-aave-v4-syrupusdg-usdg-0x6efc", "#A10", "syrupUSDG / USDG (UniV4)",
         "ARMED on UniV4 0x6125...5e1f ($1.75M USDG r0 debt / $1.92M syrupUSDG collateral -> 650k small-crossing tranche, +$24,113.60 USDG)."),
        ("targetA12_AaveV4_WBTC_USDT_0xac90", "target-a12-aave-v4-wbtc-usdt-0xac90", "#A12", "WBTC / USDT (UniV4)",
         "ARMED on UniV4 0x6125...5e1f (+846.58 USDT proven); subject to live preflight."),
        ("targetA14_AaveV4_syrupUSDG_USDG_0xabcc", "aave-v4-syrupusdg-usdg-0xabcc", "#A14", "syrupUSDG / USDG (UniV4)",
         "Unified Morpho A14 on UniV4 0x6125...5e1f; subject to live preflight."),
        ("targetA16_AaveV4_syrupUSDG_USDG_0x9cd7", "aave-v4-syrupusdg-usdg-0x9cd7", "#A16", "syrupUSDG / USDG (UniV4)",
         "Unified Morpho A16 on UniV4 0x6125...5e1f; subject to live preflight."),
        ("targetA18_AaveV4_syrupUSDG_USDG_0xdd64", "aave-v4-syrupusdg-usdg-0xdd64", "#A18", "syrupUSDG / USDG (UniV4)",
         "Unified Morpho A18 on UniV4 0x6125...5e1f; subject to live preflight."),
    ):
        ta3 = t_map.get(source_key)
        if not isinstance(ta3, dict):
            continue
        qa3 = ta3.get("liveQuote") if isinstance(ta3.get("liveQuote"), dict) else {}
        ua3 = ta3.get("user") if isinstance(ta3.get("user"), str) and ADDRESS.fullmatch(ta3["user"]) else None
        spa3 = ta3.get("spoke") if isinstance(ta3.get("spoke"), str) and ADDRESS.fullmatch(ta3["spoke"]) else None
        a12 = rank == "#A12"
        syrup_usdg = rank in {"#A5", "#A6", "#A7", "#A8", "#A9", "#A10", "#A12", "#A14", "#A16", "#A18"}
        is_armed_a = rank == "#A4" or syrup_usdg
        view["targets"].append({
            "id": ident,
            "rank": rank,
            "label": f"Aave V4 {'Spoke A ' if rank == '#A3' else ''}{'WBTC / USDT' if a12 else pair} ({_short_address(ua3) if ua3 else 'whale'})",
            "protocol": "Aave V4",
            "pair": pair,
            "user_short": _short_address(ua3) if ua3 else None,
            "venue_short": _short_address(spa3) if spa3 else "0x973a…5a08" if a12 else "0xba1B…08AF" if rank == "#A3" else "0x774b…e989" if syrup_usdg else "0x94e7…c485",
            "observation_only": not is_armed_a,
            "armed": is_armed_a,
            "executable_now": is_armed_a and ta3.get("liquidatableNow") is True,
            "readiness_note": readiness,
            "liquidatable_now": ta3.get("liquidatableNow") is True,
            "health_factor": f"{float(ta3['healthFactor']):.6f}" if _nonneg_number(ta3.get("healthFactor")) else None,
            "bps_to_liq": f"{float(ta3['bpsToLiquidation']):.4f}" if _nonneg_number(ta3.get("bpsToLiquidation")) else None,
            "heartbeat_hours_left": f"${float(ta3['collateralUsd']):,.0f} coll" if _nonneg_number(ta3.get("collateralUsd")) else None,
            "passive_hours_left": f"${float(ta3['debtUsd']):,.0f} debt" if _nonneg_number(ta3.get("debtUsd")) else None,
            "repay_summary": f"{qa3.get('repayUsdc')} {'USDT' if a12 else 'USDG' if syrup_usdg else 'USDC'}" if _nonneg_number(qa3.get("repayUsdc")) else None,
            "seized_summary": f"{qa3.get('seizedUsde')} {'WBTC' if a12 else 'syrupUSDG' if syrup_usdg else 'USDC' if rank == '#A4' else 'USDe'}" if _nonneg_number(qa3.get("seizedUsde")) else None,
            "surplus_usd": f"+${float(qa3['grossSurplusUsdc']):,.2f}" if _nonneg_number(qa3.get("grossSurplusUsdc")) else None,
            "executor": "0x6125ba227a66a1efbb780d445ea6b79f8b285e1f" if rank in {"#A14", "#A16", "#A18"} else "0x61251a22540e7148cc8ba58cfb0916a898865e1f" if syrup_usdg else "0xf09a…4262" if rank == "#A4" else view["v4_executor"]["short_address"],
            "calldata_ready": (isinstance(ta3.get("readyExecuteUniV4FlashCalldata"), str) and ta3["readyExecuteUniV4FlashCalldata"].startswith("0x")) if a12 else (isinstance(ta3.get("readyExecuteUniV4FlashCalldata"), str) and re.fullmatch(r"0x[0-9a-fA-F]{1288}", ta3["readyExecuteUniV4FlashCalldata"]) is not None) if syrup_usdg else (rank == "#A4" and _whale_calldata_ready(ta3.get("readyExecuteMorphoCalldata"))),
        })

    a13 = t_map.get("targetA13_AaveV4_wstETH_WETH_0x4cd7")
    if isinstance(a13, dict):
        q13 = a13.get("liveQuote") if isinstance(a13.get("liveQuote"), dict) else {}
        u13 = a13.get("user") if isinstance(a13.get("user"), str) and ADDRESS.fullmatch(a13["user"]) else None
        sp13 = a13.get("spoke") if isinstance(a13.get("spoke"), str) and ADDRESS.fullmatch(a13["spoke"]) else "0xe1900480ac69f0b296841cd01cc37546d92f35cd"
        view["targets"].append({
            "id": "target-a13-aave-v4-wsteth-weth-0x4cd7",
            "rank": "#A13",
            "label": f"Aave V4 wstETH / WETH ({_short_address(u13) if u13 else 'whale'})",
            "protocol": "Aave V4",
            "pair": "wstETH / WETH",
            "user_short": _short_address(u13),
            "venue_short": _short_address(sp13),
            "observation_only": False,
            "armed": True,
            "executable_now": a13.get("executableNow") is True,
            "readiness_note": scrub_text(str(a13.get("readinessNote") or "ARMED on Unified 0xf09a...4262; subject to live preflight."), 240),
            "liquidatable_now": a13.get("liquidatableNow") is True,
            "health_factor": f"{float(a13['healthFactor']):.6f}" if _nonneg_number(a13.get("healthFactor")) else None,
            "bps_to_liq": f"{float(a13['bpsToLiquidation']):.4f}" if _nonneg_number(a13.get("bpsToLiquidation")) else None,
            "heartbeat_hours_left": f"${float(a13['collateralUsd']):,.0f} coll" if _nonneg_number(a13.get("collateralUsd")) else None,
            "passive_hours_left": f"${float(a13['debtUsd']):,.0f} debt" if _nonneg_number(a13.get("debtUsd")) else None,
            "repay_summary": f"{q13.get('repayWeth')} WETH" if _nonneg_number(q13.get("repayWeth")) else None,
            "seized_summary": f"{q13.get('seizedWstEth')} wstETH" if _nonneg_number(q13.get("seizedWstEth")) else None,
            "surplus_usd": f"+${float(q13['grossSurplusUsd']):,.2f} (+{q13.get('grossSurplusWeth')} WETH)" if _nonneg_number(q13.get("grossSurplusUsd")) else None,
            "executor": "0xf09a01a6c23b936d5a51abce87a6ec8442a44262",
            "calldata_ready": _whale_calldata_ready(a13.get("readyExecuteMorphoCalldata")),
        })

    m10 = t_map.get("targetM10_Morpho_USDe_RLUSD")
    if isinstance(m10, dict):
        q10 = m10.get("liveQuote") if isinstance(m10.get("liveQuote"), dict) else {}
        u10 = m10.get("user") if isinstance(m10.get("user"), str) and ADDRESS.fullmatch(m10["user"]) else None
        view["targets"].append({
            "id": "target-m10-morpho-usde-rlusd",
            "rank": "#M10",
            "label": f"Morpho Eth USDe / RLUSD ({_short_address(u10) if u10 else 'whale'})",
            "protocol": "Morpho Blue",
            "pair": "USDe / RLUSD",
            "user_short": _short_address(u10),
            "venue_short": "0xBBBB…FFCb",
            "observation_only": False,
            "armed": True,
            "executable_now": m10.get("executableNow") is True,
            "readiness_note": scrub_text(str(m10.get("readinessNote") or "ARMED on 0x2d5b...3627 ($35.2k RLUSD debt / 38.5k USDe collateral -> UniV3 USDe->USDC->RLUSD)."), 240),
            "liquidatable_now": m10.get("liquidatableNow") is True,
            "health_factor": f"{float(m10['healthFactor']):.6f} HF" if _nonneg_number(m10.get("healthFactor")) else None,
            "bps_to_liq": f"{float(m10['bpsToLiquidation']):.2f} bps to liq" if _nonneg_number(m10.get("bpsToLiquidation")) else None,
            "heartbeat_hours_left": f"${float(m10['collateralUsd']):,.0f} coll" if _nonneg_number(m10.get("collateralUsd")) else None,
            "passive_hours_left": f"${float(m10['debtUsd']):,.0f} debt ({float(m10['passiveHoursToCrossing']):.1f}h passive)" if _nonneg_number(m10.get("passiveHoursToCrossing")) and _nonneg_number(m10.get("debtUsd")) else (f"${float(m10['debtUsd']):,.0f} debt" if _nonneg_number(m10.get("debtUsd")) else None),
            "repay_summary": f"{q10.get('repayUsdc')} RLUSD" if _nonneg_number(q10.get("repayUsdc")) else None,
            "seized_summary": f"{q10.get('seizedReusd')} USDe" if _nonneg_number(q10.get("seizedReusd")) else None,
            "surplus_usd": f"+${float(q10['grossSurplusUsd']):,.2f}" if _nonneg_number(q10.get("grossSurplusUsd")) else None,
            "executor": "0x2d5bca1b846e89965544c7f03d09a25126803627",
            "calldata_ready": isinstance(m10.get("readyExecuteCurveUnwindCalldata"), str) and m10["readyExecuteCurveUnwindCalldata"].startswith("0x"),
        })

    m11 = t_map.get("targetM11_Morpho_weETH_WETH")
    if isinstance(m11, dict):
        q11 = m11.get("liveQuote") if isinstance(m11.get("liveQuote"), dict) else {}
        u11 = m11.get("user") if isinstance(m11.get("user"), str) and ADDRESS.fullmatch(m11["user"]) else None
        view["targets"].append({
            "id": "target-m11-morpho-weeth-weth",
            "rank": "#M11",
            "label": f"Morpho Eth weETH / WETH ({_short_address(u11) if u11 else 'whale'})",
            "protocol": "Morpho Blue",
            "pair": "weETH / WETH",
            "user_short": _short_address(u11),
            "venue_short": "0xBBBB…FFCb",
            "observation_only": False,
            "armed": True,
            "executable_now": m11.get("executableNow") is True,
            "readiness_note": scrub_text(str(m11.get("readinessNote") or "ARMED on 0xaf5b...07ba (493.22 WETH / $1.20M debt / 474.29 weETH collateral -> UniV3 weETH->WETH)."), 240),
            "liquidatable_now": m11.get("liquidatableNow") is True,
            "health_factor": f"{float(m11['healthFactor']):.6f} HF" if _nonneg_number(m11.get("healthFactor")) else None,
            "bps_to_liq": f"{float(m11['bpsToLiquidation']):.2f} bps to liq" if _nonneg_number(m11.get("bpsToLiquidation")) else None,
            "heartbeat_hours_left": f"${float(m11['collateralUsd']):,.0f} coll" if _nonneg_number(m11.get("collateralUsd")) else None,
            "passive_hours_left": f"${float(m11['debtUsd']):,.0f} debt ({float(m11['passiveHoursToCrossing']):.1f}h passive)" if _nonneg_number(m11.get("passiveHoursToCrossing")) and _nonneg_number(m11.get("debtUsd")) else (f"${float(m11['debtUsd']):,.0f} debt" if _nonneg_number(m11.get("debtUsd")) else None),
            "repay_summary": f"{q11.get('repayWeth')} WETH" if _nonneg_number(q11.get("repayWeth")) else None,
            "seized_summary": f"{q11.get('seizedWstEth')} weETH" if _nonneg_number(q11.get("seizedWstEth")) else None,
            "surplus_usd": f"+${float(q11['grossSurplusUsd']):,.2f} (+{q11.get('grossSurplusWeth')} WETH)" if _nonneg_number(q11.get("grossSurplusUsd")) else None,
            "executor": "0xaf5b…07ba",
            "calldata_ready": isinstance(m11.get("readyExecuteMorphoBlueCalldata"), str) and len(m11["readyExecuteMorphoBlueCalldata"]) >= 580 and m11["readyExecuteMorphoBlueCalldata"].startswith("0x834cbf54"),
        })

    m30 = t_map.get("targetM30_Morpho_wstETH_WETH")
    if isinstance(m30, dict):
        q30 = m30.get("liveQuote") if isinstance(m30.get("liveQuote"), dict) else {}
        u30 = m30.get("user") if isinstance(m30.get("user"), str) and ADDRESS.fullmatch(m30["user"]) else None
        view["targets"].append({
            "id": "morpho-wsteth-weth-m30",
            "rank": "#M30",
            "label": f"Morpho Eth wstETH / WETH ({_short_address(u30) if u30 else 'whale'})",
            "protocol": "Morpho Blue",
            "pair": "wstETH / WETH",
            "user_short": _short_address(u30),
            "venue_short": "0xBBBB…FFCb",
            "observation_only": False,
            "armed": True,
            "executable_now": m30.get("executableNow") is True,
            "readiness_note": scrub_text(str(m30.get("readinessNote") or "ARMED on 0xaf5b...07ba via UniV3 wstETH->WETH; subject to live preflight."), 240),
            "liquidatable_now": m30.get("liquidatableNow") is True,
            "health_factor": f"{float(m30['healthFactor']):.6f} HF" if _nonneg_number(m30.get("healthFactor")) else None,
            "bps_to_liq": f"{float(m30['bpsToLiquidation']):.2f} bps to liq" if _nonneg_number(m30.get("bpsToLiquidation")) else None,
            "heartbeat_hours_left": f"${float(m30['collateralUsd']):,.0f} coll" if _nonneg_number(m30.get("collateralUsd")) else None,
            "passive_hours_left": f"${float(m30['debtUsd']):,.0f} debt ({float(m30['passiveHoursToCrossing']):.1f}h passive)" if _nonneg_number(m30.get("passiveHoursToCrossing")) and _nonneg_number(m30.get("debtUsd")) else (f"${float(m30['debtUsd']):,.0f} debt" if _nonneg_number(m30.get("debtUsd")) else None),
            "repay_summary": f"{q30.get('repayWeth')} WETH" if _nonneg_number(q30.get("repayWeth")) else None,
            "seized_summary": f"{q30.get('seizedWstEth')} wstETH" if _nonneg_number(q30.get("seizedWstEth")) else None,
            "surplus_usd": f"+${float(q30['grossSurplusUsd']):,.2f} (+{q30.get('grossSurplusWeth')} WETH)" if _nonneg_number(q30.get("grossSurplusUsd")) else None,
            "executor": "0xaf5b…07ba",
            "calldata_ready": isinstance(m30.get("readyExecuteMorphoBlueCalldata"), str) and len(m30["readyExecuteMorphoBlueCalldata"]) >= 580 and m30["readyExecuteMorphoBlueCalldata"].startswith("0x834cbf54"),
        })

    deferred_morpho_targets = []
    for source_key, ident, rk, label_prefix, pair_label, seize_symbol in (
        ("targetM31_Morpho_syrupUSDC_USDC", "morpho-syrupusdc-usdc-m31", "#M31", "Morpho Blue syrupUSDC / USDC", "syrupUSDC / USDC", "syrupUSDC"),
        ("targetM32_Morpho_sUSDe_USDtb", "morpho-susde-usdtb-m32", "#M32", "Morpho Blue sUSDe / USDtb", "sUSDe / USDtb", "sUSDe"),
        ("targetF1_Fluid_USDe_USDT_Vault93", "fluid-usde-usdt-f1", "#F1", "Fluid T2 USDe-USDT / USDT", "USDe-USDT / USDT (Fluid T2)", "USDe-USDT LP"),
        ("targetF2_Fluid_eBTC_cbBTC_Vault96", "fluid-ebtc-cbbtc-f2", "#F2", "Fluid T2 eBTC-cbBTC / WBTC", "eBTC-cbBTC / WBTC (Fluid T2)", "eBTC-cbBTC LP"),
        ("targetF3_Fluid_ETH_osETH_Vault159", "fluid-eth-oseth-f3", "#F3", "Fluid T2 ETH-osETH / wstETH", "ETH-osETH / wstETH (Fluid T2)", "ETH-osETH LP"),
        ("targetF4_Fluid_PAXG_XAUt_Vault123", "fluid-paxg-xaut-f4", "#F4", "Fluid T2 PAXG-XAUt / USDT", "PAXG-XAUt / USDT (Fluid T2)", "PAXG-XAUt LP"),
        ("targetF5_Fluid_WBTC_LBTC_Vault115", "fluid-wbtc-lbtc-f5", "#F5", "Fluid T2 WBTC-LBTC / WBTC", "WBTC-LBTC / WBTC (Fluid T2)", "WBTC-LBTC LP"),
        ("targetF6_Fluid_syrupUSDC_USDC_Vault145", "fluid-syrupusdc-usdc-f6", "#F6", "Fluid T2 syrupUSDC-USDC / USDC", "syrupUSDC-USDC / USDC (Fluid T2)", "syrupUSDC-USDC LP"),
        ("targetM33_Morpho_PT_reUSD_USDT", "morpho-pt-reusd-usdt-m33", "#M33", "Morpho Blue PT-reUSD-10DEC2026 / USDT", "PT-reUSD-10DEC2026 / USDT", "PT-reUSD"),
        ("targetM34_Morpho_beraSTONE_WETH", "morpho-berastone-weth-m34", "#M34", "Morpho Blue beraSTONE / WETH", "beraSTONE / WETH", "beraSTONE"),
        ("targetM35_Morpho_PT_USD3_USDC", "morpho-pt-usd3-usdc-m35", "#M35", "Morpho Blue PT-USD3-17DEC2026 / USDC", "PT-USD3-17DEC2026 / USDC", "PT-USD3"),
        ("targetM36_Morpho_sUSDS_USDT", "morpho-susds-usdt-m36", "#M36", "Morpho Blue sUSDS / USDT", "sUSDS / USDT", "sUSDS"),
        ("targetM37_Morpho_PST_USDT", "morpho-pst-usdt-m37", "#M37", "Morpho Blue PST / USDT", "PST / USDT", "PST"),
        ("targetM38_Morpho_sUSDS_USDT", "morpho-susds-usdt-m38", "#M38", "Morpho Blue sUSDS / USDT", "sUSDS / USDT", "sUSDS"),
        ("targetM39_Morpho_reUSD_USDC", "morpho-reusd-usdc-m39", "#M39", "Morpho Blue reUSD / USDC", "reUSD / USDC", "reUSD"),
        ("targetM40_Morpho_weETH_WETH", "morpho-weeth-weth-m40", "#M40", "Morpho Blue weETH / WETH", "weETH / WETH", "weETH"),
        ("targetM41_Morpho_wstETH_WETH", "morpho-wsteth-weth-m41", "#M41", "Morpho Blue wstETH / WETH", "wstETH / WETH", "wstETH"),
        ("targetM42_Morpho_strUSD_USDC", "morpho-strusd-usdc-m42", "#M42", "Morpho Blue strUSD / USDC", "strUSD / USDC", "strUSD"),
        ("targetM43_Morpho_PRIME_PYUSD", "morpho-prime-pyusd-m43", "#M43", "Morpho Blue PRIME / PYUSD", "PRIME / PYUSD", "PRIME"),
        ("targetM44_Morpho_srUSD_USDC", "morpho-srusd-usdc-m44", "#M44", "Morpho Blue srUSD / USDC", "srUSD / USDC", "srUSD"),
        ("targetM45_Morpho_reUSDe_USDC", "morpho-reusde-usdc-m45", "#M45", "Morpho Blue reUSDe / USDC", "reUSDe / USDC", "reUSDe"),
        ("targetM46_Morpho_apyUSD_apxUSD", "morpho-apyusd-apxusd-m46", "#M46", "Morpho Blue apyUSD / apxUSD", "apyUSD / apxUSD", "apyUSD"),
        ("targetM47_Morpho_USDe_RLUSD", "morpho-usde-rlusd-m47", "#M47", "Morpho Blue USDe / RLUSD", "USDe / RLUSD", "USDe"),
        ("targetM48_Morpho_reUSD_USDT", "morpho-reusd-usdt-m48", "#M48", "Morpho Blue reUSD / USDT", "reUSD / USDT", "reUSD"),
        ("targetM49_Morpho_sUSDe_USDT", "morpho-susde-usdt-m49", "#M49", "Morpho Blue sUSDe / USDT", "sUSDe / USDT", "sUSDe"),
        ("targetB11_Fluid_sUSDai_USDC_Vault48", "fluid-susdai-usdc-b11", "#B11", "Base Fluid T2 sUSDai-USDC / USDC", "sUSDai-USDC / USDC (Base Fluid T2)", "sUSDai-USDC LP"),
        ("targetB12_EulerV2_wtSPYM_USDC_0x1791", "euler-wtspym-usdc-b12", "#B12", "Base Euler V2 ewtSPYM-2 / eUSDC-49", "ewtSPYM-2 / eUSDC-49 (Base Euler V2)", "wtSPYM"),
        ("targetB13_EulerV2_wtCOIN_USDC_0x1791", "euler-wtcoin-usdc-b13", "#B13", "Base Euler V2 ewtCOIN-2 / eUSDC-49", "ewtCOIN-2 / eUSDC-49 (Base Euler V2)", "wtCOIN"),
        ("targetB14_Base_USDe_USDC_0x6efc", "base-usde-usdc-b14", "#B14", "Morpho Base USDe / USDC", "USDe / USDC (Base)", "USDe"),
        ("targetB15_Base_yoUSD_USDC_0x5c2a", "base-yousd-usdc-b15", "#B15", "Morpho Base yoUSD / USDC", "yoUSD / USDC (Base)", "yoUSD"),
        ("targetE7_EulerV2_RLUSD_USDe_0x1066", "euler-rlusd-usde-e7", "#E7", "Euler V2 eUSDe-6 / eRLUSD-1", "eUSDe-6 / eRLUSD-1 (Euler V2)", "eUSDe-6"),
        ("targetE8_Euler_eUSDC2_eXAUt1", "euler-eusdc2-exaut1-e8", "#E8", "Euler V2 eUSDC-2 / eXAUt-1", "eUSDC-2 / eXAUt-1", "eXAUt-1"),
        ("targetE9_Euler_eUSDT9_eUSDC22", "euler-eusdt9-eusdc22-e9", "#E9", "Euler V2 eUSDT-9 / eUSDC-22", "eUSDT-9 / eUSDC-22", "eUSDC-22"),
        ("targetE10_Euler_eRLUSD7_eUSDC70", "euler-erlusd7-eusdc70-e10", "#E10", "Euler V2 eRLUSD-7 / eUSDC-70", "eRLUSD-7 / eUSDC-70", "eUSDC-70"),
        ("targetM12_Morpho_PT_USD3_USDC", "target-m12-morpho-pt-usd3-usdc", "#M12", "Morpho Eth PT-USD3-17DEC2026 / USDC", "PT-USD3-17DEC2026 / USDC", "PT-USD3"),
        ("targetM13_Morpho_PT_USD3_USDC", "target-m13-morpho-pt-usd3-usdc", "#M13", "Morpho Eth PT-USD3-17DEC2026 / USDC", "PT-USD3-17DEC2026 / USDC", "PT-USD3"),
        ("targetM15_Morpho_yoUSD_Edge_USDC", "target-m15-morpho-yousd-edge-usdc", "#M15", "Morpho Eth yoUSD Edge / USDC", "yoUSD Edge / USDC", "yoUSD Edge"),
        ("targetM16_Morpho_apyUSD_apxUSD", "target-m16-morpho-apyusd-apxusd", "#M16", "Morpho Eth apyUSD / apxUSD", "apyUSD / apxUSD", "apyUSD"),
        ("targetM17_Morpho_eUSDe_USDe", "morpho-eusde-usde-m17", "#M17", "Morpho Blue eUSDe / USDe", "eUSDe / USDe", "eUSDe"),
        ("targetM18_Morpho_USD3_USDC", "morpho-usd3-usdc-m18", "#M18", "Morpho Blue USD3 / USDC", "USD3 / USDC", "USD3"),
        ("targetM19_Morpho_USD3_USDC", "morpho-usd3-usdc-m19", "#M19", "Morpho Blue USD3 / USDC", "USD3 / USDC", "USD3"),
        ("targetM20_Morpho_USD3_USDC", "morpho-usd3-usdc-m20", "#M20", "Morpho Blue USD3 / USDC", "USD3 / USDC", "USD3"),
        ("targetM21_Morpho_PT_apyUSD_apxUSD", "morpho-pt-apyusd-apxusd-m21", "#M21", "Morpho Blue PT-apyUSD-5NOV2026 / apxUSD", "PT-apyUSD-5NOV2026 / apxUSD", "PT-apyUSD"),
        ("targetM22_Morpho_PT_apyUSD_apxUSD", "morpho-pt-apyusd-apxusd-m22", "#M22", "Morpho Blue PT-apyUSD-5NOV2026 / apxUSD", "PT-apyUSD-5NOV2026 / apxUSD", "PT-apyUSD"),
        ("targetM23_Morpho_PT_reUSD_USDC", "morpho-pt-reusd-usdc-m23", "#M23", "Morpho Blue PT-reUSD-10DEC2026 / USDC", "PT-reUSD-10DEC2026 / USDC", "PT-reUSD"),
        ("targetM24_Morpho_PT_reUSD_USDC", "morpho-pt-reusd-usdc-m24", "#M24", "Morpho Blue PT-reUSD-10DEC2026 / USDC", "PT-reUSD-10DEC2026 / USDC", "PT-reUSD"),
        ("targetM25_Morpho_USD3_USDC", "morpho-usd3-usdc-m25", "#M25", "Morpho Blue USD3 / USDC", "USD3 / USDC", "USD3"),
        ("targetM26_Morpho_USD3_USDC", "morpho-usd3-usdc-m26", "#M26", "Morpho Blue USD3 / USDC", "USD3 / USDC", "USD3"),
        ("targetM27_Morpho_PT_reUSD_USDC", "morpho-pt-reusd-usdc-m27", "#M27", "Morpho Blue PT-reUSD-10DEC2026 / USDC", "PT-reUSD-10DEC2026 / USDC", "PT-reUSD"),
        ("targetM28_Morpho_PT_reUSD_USDC", "morpho-pt-reusd-usdc-m28", "#M28", "Morpho Blue PT-reUSD-10DEC2026 / USDC", "PT-reUSD-10DEC2026 / USDC", "PT-reUSD"),
        ("targetM2B_Morpho_reUSD_USDC", "target-m2b-morpho-reusd-usdc", "#M2B", "Morpho Eth reUSD / USDC", "reUSD / USDC", "reUSD"),
        ("targetM2C_Morpho_reUSD_USDC", "target-m2c-morpho-reusd-usdc", "#M2C", "Morpho Eth reUSD / USDC", "reUSD / USDC", "reUSD"),
        ("targetM2D_Morpho_reUSD_USDC", "target-m2d-morpho-reusd-usdc", "#M2D", "Morpho Eth reUSD / USDC", "reUSD / USDC", "reUSD"),
    ):
        item = t_map.get(source_key)
        if not isinstance(item, dict):
            continue
        closed = False
        if rk in {"#B14", "#M34", "#E8"}:
            # Local import avoids the targets -> ops presentation dependency at
            # module load. Reuse its exact identity/raw-debt/pin validation.
            from .targets import CLOSED_POSITION_NOTE, _clean, _observation, _position_debt_status
            capture = state.get("baseObservation") if isinstance(state.get("baseObservation"), dict) else {}
            debt_pin = _clean(capture.get("pin") if rk == "#B14" else state.get("pin"))
            complete = state.get("ok") is not False and (rk != "#B14" or capture.get("status") == "COMPLETE")
            closed = (_position_debt_status(ident, _clean(item), debt_pin) == "CLOSED"
                      and _observation(debt_pin, state.get("generatedAt"), now, 8453 if rk == "#B14" else 1,
                                       triggers_key, complete)["freshness"] != UNKNOWN)
            if closed:
                item = {**item, "armed": False, "executableNow": False, "liquidatableNow": False,
                        "liveQuote": None, "readinessNote": CLOSED_POSITION_NOTE}
        if rk == "#M32":
            from .targets import M32_EXECUTOR, M32_READINESS_NOTE, _address
            is_m32_bound = (_address(item.get("deployedExecutor") or item.get("executor")) == M32_EXECUTOR
                            and not any(isinstance(item.get(k), str) and item[k].startswith("0x")
                                        for k in ("readyExecuteCurveUnwindCalldata", "readyExecuteReusdCalldata")))
            item = {**item, "readinessNote": M32_READINESS_NOTE, "executableNow": False}
            if not is_m32_bound:
                item["liveQuote"] = None
        q = item.get("liveQuote") if isinstance(item.get("liveQuote"), dict) else {}
        u = item.get("user") if isinstance(item.get("user"), str) and ADDRESS.fullmatch(item["user"]) else None
        universal = rk in {"#F1", "#F2", "#F3", "#F4", "#F5", "#F6", "#M33", "#M34", "#M36", "#M37", "#M38", "#M42", "#M43", "#M44", "#M45", "#M48", "#M49", "#B11", "#B12", "#B13", "#E7", "#E8", "#E9", "#E10"}
        weth_morpho = rk in {"#M40", "#M41"}
        base_single = rk in {"#B14", "#B15"}
        debt = item.get("debtUsdc", item.get("debtUsd")) if base_single else item.get("debtUsd")
        collateral = item.get("collateralValueUsdc", item.get("collateralUsd")) if base_single else item.get("collateralUsd")
        calldata_key = "readyExecuteReusdCalldata" if rk in {"#M17", "#M18", "#M19", "#M20", "#M25", "#M26"} else "readyExecuteCurveUnwindCalldata"
        if universal:
            calldata_key = next((key for key in ("readyExecuteUniversalCalldata", "readyExecuteCurveUnwindCalldata", "readyExecuteReusdCalldata")
                                 if isinstance(item.get(key), str) and item[key].startswith("0x")), "readyExecuteUniversalCalldata")
        if rk in {"#B12", "#B13", "#E7", "#E8", "#E9", "#E10"} and isinstance(item.get("readyExecuteEulerEvkCalldata"), str) and item["readyExecuteEulerEvkCalldata"].startswith("0x"):
            calldata_key = "readyExecuteEulerEvkCalldata"
        if rk in {"#M31", "#M32"} and not (isinstance(item.get(calldata_key), str) and item[calldata_key].startswith("0x")):
            calldata_key = "readyExecuteReusdCalldata"
        if weth_morpho:
            calldata_key = "readyExecuteMorphoBlueCalldata"
        repay_key = "repayWeth" if weth_morpho else "repayUsdc"
        seize_key = "seizedWstEth" if weth_morpho else "seizedReusd"
        repay_symbol = "WETH" if weth_morpho or rk == "#M34" else "wstETH" if rk == "#F3" else "WBTC" if rk in {"#F2", "#F5"} else "USDC" if rk in {"#F6", "#M42", "#M44", "#M45", "#B11", "#B12", "#B13", "#E8"} else "PYUSD" if rk == "#M43" else "RLUSD" if rk in {"#E7", "#E10", "#M47"} else "USDT" if universal else "apxUSD" if rk in {"#M21", "#M22", "#M46"} else "USDe" if rk == "#M17" else "USDtb" if rk == "#M32" else "USDC"
        target_rows = deferred_morpho_targets if rk in {"#M25", "#M26", "#M27", "#M28"} else view["targets"]
        target_rows.append({
            "id": ident,
            "rank": rk,
            "label": "Base Fluid T2 sUSDai-USDC / USDC (0x59fa…bd4a)" if rk == "#B11" else "Fluid T2 USDe-USDT / USDT (0x989a…9881)" if rk == "#F1" else "Fluid T2 eBTC-cbBTC / WBTC (0x43d1…428d)" if rk == "#F2" else "Fluid T2 ETH-osETH / wstETH (0x40d0…3b8d)" if rk == "#F3" else f"{label_prefix} ({_short_address(u) if u else 'whale'})",
            "position_status": "CLOSED" if closed else None,
            "protocol": "Euler V2" if rk in {"#B12", "#B13", "#E7", "#E8", "#E9", "#E10"} else "Fluid" if rk in {"#F1", "#F2", "#F3", "#F4", "#F5", "#F6", "#B11"} else "Morpho Blue",
            "pair": pair_label,
            "user_short": _short_address(u),
            "venue_short": _short_address(item.get("marketId")) if rk in {"#F4", "#F5", "#F6"} else "0x4c1a…f61e" if rk in {"#B12", "#B13"} else "0xe1ce…8a10" if rk == "#E7" else "0x797d…48a9" if rk == "#E8" else "0x7c28…c5a8" if rk == "#E9" else "0xaf53…9bb2" if rk == "#E10" else "0x59fa…bd4a" if rk == "#B11" else "0xBBBB…FFCb",
            "observation_only": False,
            "armed": (not closed and item.get("inactive") is not True and item.get("positionStatus") != "CLOSED") if rk == "#M32" else ((item.get("armed") is True and item.get("inactive") is not True and item.get("positionStatus") != "CLOSED")
                if source_key in {"targetB14_Base_USDe_USDC_0x6efc", "targetM34_Morpho_beraSTONE_WETH", "targetE8_Euler_eUSDC2_eXAUt1"} else True),
            "executable_now": item.get("executableNow") is True,
            "readiness_note": scrub_text(str(item.get("readinessNote") or ("Base Morpho runner on 0x88bf...4f32; subject to live preflight." if base_single else "Unified Morpho runner on 0xaf5b...07ba; subject to live preflight." if weth_morpho else "Base Euler V2 runner on 0x0aaa...b9b9; subject to live preflight." if rk in {"#B12", "#B13"} else f"Unified Morpho {rk[1:]} on 0xa896...7a6a; subject to live preflight." if rk in {"#E8", "#E9", "#E10"} else "Unified Euler V2 E7 on 0xa896...7a6a; subject to live preflight." if rk == "#E7" else "ARMED on Base Universal 0x86d4...ba53 ($655.2k USDC debt in Fluid T2 Vault 48)." if rk == "#B11" else "ARMED on 0xc503...3089." if universal else "ARMED on 0x2d5b...3627.")), 240),
            "liquidatable_now": item.get("liquidatableNow") is True,
            "health_factor": f"{float(item['healthFactor']):.6f} HF" if _nonneg_number(item.get("healthFactor")) else None,
            "bps_to_liq": f"{float(item['bpsToLiquidation']):.2f} bps to liq" if _nonneg_number(item.get("bpsToLiquidation")) else None,
            "heartbeat_hours_left": f"${float(collateral):,.0f} coll" if _nonneg_number(collateral) else None,
            "passive_hours_left": f"${float(debt):,.0f} debt ({float(item['passiveHoursToCrossing']):.1f}h passive)" if _nonneg_number(item.get("passiveHoursToCrossing")) and _nonneg_number(debt) else (f"${float(debt):,.0f} debt" if _nonneg_number(debt) else None),
            "repay_summary": f"{q.get(repay_key)} {repay_symbol}" if _nonneg_number(q.get(repay_key)) else None,
            "seized_summary": f"{q.get(seize_key)} {seize_symbol}" if _nonneg_number(q.get(seize_key)) else None,
            "surplus_usd": f"+${float(q['grossSurplusUsd']):,.2f}" if _nonneg_number(q.get("grossSurplusUsd")) else None,
            "executor": "0x2c94b422884c0495cae3cef9ce7ab337fac247c4" if rk == "#M32" else "0x88bff83b4c987cc90a863cd79baa54dd5cd94f32" if base_single else "0xaf5b033e23ac555c09096bf39979a855e09907ba" if weth_morpho else "0x0aaa75499fbcb7db821c3aefc84433a53cdeb9b9" if rk in {"#B12", "#B13"} else "0xa8964ab01c35f8e7de8457223861624b66007a6a" if rk in {"#E7", "#E8", "#E9", "#E10"} else "0x86d446bafcd87737d0b763f1e8af65e5c424ba53" if rk == "#B11" else "0xc50321a07dab061d59b992e57a2ef4dca0d33089" if universal else "0x2d5bca1b846e89965544c7f03d09a25126803627",
            "calldata_ready": rk != "#M32" and not closed and isinstance(item.get(calldata_key), str) and item[calldata_key].startswith("0x") and (not weth_morpho or (len(item[calldata_key]) >= 580 and item[calldata_key].startswith("0x834cbf54"))),
        })
        if rk == "#M12":
            target_rows[-1]["market_id"] = "0xecabc12c73a97c766d0c6aeb4c15c635630d78158b2ac8370455a09efcc50837"
        if rk in {"#B11", "#B12", "#B13", "#B14", "#B15"}:
            base_capture = state.get("baseObservation") if isinstance(state.get("baseObservation"), dict) else {}
            base_pin = base_capture.get("pin") if isinstance(base_capture.get("pin"), dict) else {}
            target_rows[-1].update(chain_id=8453, health_is_estimate=item.get("healthIsEstimate") is not False,
                                   observation_block=item.get("observationBlock", base_pin.get("number")),
                                   observation_utc=_iso(item.get("observationUtc", base_pin.get("utc"))))

    m14 = t_map.get("targetM14_Morpho_PT_USDat_USDC")
    if isinstance(m14, dict):
        q14 = m14.get("liveQuote") if isinstance(m14.get("liveQuote"), dict) else {}
        u14 = m14.get("user") if isinstance(m14.get("user"), str) and ADDRESS.fullmatch(m14["user"]) else None
        view["targets"].append({
            "id": "target-m14-morpho-pt-usdat-usdc",
            "rank": "#M14",
            "label": f"Morpho Eth PT-USDat-27AUG2026 / USDC ({_short_address(u14) if u14 else 'whale'})",
            "protocol": "Morpho Blue",
            "pair": "PT-USDat-27AUG2026 / USDC",
            "user_short": _short_address(u14),
            "venue_short": "0xBBBB…FFCb",
            "observation_only": False,
            "armed": True,
            "executable_now": m14.get("executableNow") is True,
            "readiness_note": scrub_text(str(m14.get("readinessNote") or "ARMED on 0xd53e...b84d."), 240),
            "liquidatable_now": m14.get("liquidatableNow") is True,
            "health_factor": f"{float(m14['healthFactor']):.6f} HF" if _nonneg_number(m14.get("healthFactor")) else None,
            "bps_to_liq": f"{float(m14['bpsToLiquidation']):.2f} bps to liq" if _nonneg_number(m14.get("bpsToLiquidation")) else None,
            "heartbeat_hours_left": f"${float(m14['collateralUsd']):,.0f} coll" if _nonneg_number(m14.get("collateralUsd")) else None,
            "passive_hours_left": f"${float(m14['debtUsd']):,.0f} debt ({float(m14['passiveHoursToCrossing']):.1f}h passive)" if _nonneg_number(m14.get("passiveHoursToCrossing")) and _nonneg_number(m14.get("debtUsd")) else (f"${float(m14['debtUsd']):,.0f} debt" if _nonneg_number(m14.get("debtUsd")) else None),
            "repay_summary": f"{q14.get('repayUsdc')} USDC" if _nonneg_number(q14.get("repayUsdc")) else None,
            "seized_summary": f"{q14.get('seizedReusd')} PT-USDat" if _nonneg_number(q14.get("seizedReusd")) else None,
            "surplus_usd": f"+${float(q14['grossSurplusUsd']):,.2f}" if _nonneg_number(q14.get("grossSurplusUsd")) else None,
            "executor": "0xd53ee7b5806c4d7f36422eab99dc46563d18b84d",
            "calldata_ready": isinstance(m14.get("readyExecutePendlePtCalldata"), str) and m14["readyExecutePendlePtCalldata"].startswith("0x"),
        })

    m29 = t_map.get("targetM29_Morpho_PT_srUSDe_USDC")
    if isinstance(m29, dict):
        q29 = m29.get("liveQuote") if isinstance(m29.get("liveQuote"), dict) else {}
        u29 = m29.get("user") if isinstance(m29.get("user"), str) and ADDRESS.fullmatch(m29["user"]) else None
        view["targets"].append({
            "id": "morpho-pt-srusde-usdc-m29",
            "rank": "#M29",
            "label": f"Morpho Blue PT-srUSDe-15JAN2026 / USDC ({_short_address(u29) if u29 else 'whale'})",
            "protocol": "Morpho Blue",
            "pair": "PT-srUSDe-15JAN2026 / USDC",
            "user_short": _short_address(u29),
            "venue_short": "0xBBBB…FFCb",
            "observation_only": False,
            "armed": True,
            "executable_now": m29.get("executableNow") is True,
            "readiness_note": scrub_text(str(m29.get("readinessNote") or "ARMED on 0xd53e...b84d."), 240),
            "liquidatable_now": m29.get("liquidatableNow") is True,
            "health_factor": f"{float(m29['healthFactor']):.6f} HF" if _nonneg_number(m29.get("healthFactor")) else None,
            "bps_to_liq": f"{float(m29['bpsToLiquidation']):.2f} bps to liq" if _nonneg_number(m29.get("bpsToLiquidation")) else None,
            "heartbeat_hours_left": f"${float(m29['collateralUsd']):,.0f} coll" if _nonneg_number(m29.get("collateralUsd")) else None,
            "passive_hours_left": f"${float(m29['debtUsd']):,.0f} debt ({float(m29['passiveHoursToCrossing']):.1f}h passive)" if _nonneg_number(m29.get("passiveHoursToCrossing")) and _nonneg_number(m29.get("debtUsd")) else (f"${float(m29['debtUsd']):,.0f} debt" if _nonneg_number(m29.get("debtUsd")) else None),
            "repay_summary": f"{q29.get('repayUsdc')} USDC" if _nonneg_number(q29.get("repayUsdc")) else None,
            "seized_summary": f"{q29.get('seizedReusd')} PT-srUSDe" if _nonneg_number(q29.get("seizedReusd")) else None,
            "surplus_usd": f"+${float(q29['grossSurplusUsd']):,.2f}" if _nonneg_number(q29.get("grossSurplusUsd")) else None,
            "executor": "0xd53ee7b5806c4d7f36422eab99dc46563d18b84d",
            "calldata_ready": isinstance(m29.get("readyExecutePendlePtCalldata"), str) and m29["readyExecutePendlePtCalldata"].startswith("0x"),
        })

    for rank, borrower in PT_USDE_DAI_USERS.items():
        item = t_map.get(f"target{rank[1:]}_Morpho_PT_USDe_DAI")
        if not isinstance(item, dict) or item.get("marketId") != PT_USDE_DAI_MARKET or str(item.get("user")).lower() != borrower:
            continue
        debt, collateral, bps = item.get("debtUsd"), item.get("collateralPt"), item.get("bpsToLiquidation")
        passive = f"{float(debt):,.2f} DAI debt" if _nonneg_number(debt) else None
        if passive is not None and _nonneg_number(item.get("passiveHoursToCrossing")):
            passive += f" ({float(item['passiveHoursToCrossing']):.2f}h passive estimate)"
        pt_armed = (str(item.get("executor") or item.get("deployedExecutor") or "").lower() == "0xd53ee7b5806c4d7f36422eab99dc46563d18b84d")
        calldata_pt = item.get("readyExecutePendlePtCalldata")
        view["targets"].append({
            "id": f"target-{rank[1:].lower()}-morpho-pt-usde-dai", "rank": rank,
            "label": f"Morpho Eth PT-USDe-31JUL2025 / DAI ({_short_address(borrower)})",
            "protocol": "Morpho Blue", "pair": "PT-USDe-31JUL2025 / DAI",
            "user_short": _short_address(borrower), "venue_short": "0xBBBB…FFCb",
            "observation_only": not pt_armed, "armed": pt_armed,
            "executable_now": pt_armed and item.get("executableNow") is True and item.get("liquidatableNow") is True,
            "readiness_note": scrub_text(str(item.get("readinessNote") or PT_USDE_DAI_NOTE), 240) if pt_armed else PT_USDE_DAI_NOTE,
            "health_is_estimate": item.get("healthIsEstimate") is not False,
            "liquidatable_now": item.get("liquidatableNow") if isinstance(item.get("liquidatableNow"), bool) else None,
            "health_factor": f"{float(item['healthFactor']):.6f}" if _nonneg_number(item.get("healthFactor")) else None,
            "bps_to_liq": f"{float(bps):.4f}" if isinstance(bps, (int, float)) and not isinstance(bps, bool) and -1e60 <= bps <= 1e60 else None,
            "heartbeat_hours_left": f"{float(collateral):,.2f} PT-USDe coll" if _nonneg_number(collateral) else None,
            "passive_hours_left": passive, "repay_summary": None, "seized_summary": None, "surplus_usd": None,
            "executor": "0xd53ee7b5806c4d7f36422eab99dc46563d18b84d" if pt_armed else None,
            "calldata_ready": pt_armed and isinstance(calldata_pt, str) and calldata_pt.startswith("0x"),
        })

    for source_key, ident, rank, pair, protocol, spoke, executor in (
        ("targetA11_AaveV4_USDe_USDC_0x5c43", "target-a11-aave-v4-usde-usdc-0x5c43", "#A11", "USDe / USDC", "Aave V4",
         "0xba1b3d55d249692b669a164024a838309b7508af", "0x3c02c96bbb423d0109b823c23a05fcf0bf91ecb7"),
        ("targetC9_AaveV4_weETH_WETH_0x9f46", "target-c9-aave-v4-weeth-weth-0x9f46", "#C9", "weETH / WETH", "Aave V4 (Spoke C)",
         "0xbf10bdfe177de0336afd7fccf80a904e15386219", "0xf09a01a6c23b936d5a51abce87a6ec8442a44262"),
        ("targetA15_AaveV4_weETH_WETH_0x3519", "aave-v4-weeth-weth-0x3519", "#A15", "weETH / WETH", "Aave V4 (Spoke C)",
         "0xbf10bdfe177de0336afd7fccf80a904e15386219", "0xf09a01a6c23b936d5a51abce87a6ec8442a44262"),
        ("targetA17_AaveV4_weETH_WETH_0xa751", "aave-v4-weeth-weth-0xa751", "#A17", "weETH / WETH", "Aave V4 (Spoke C)",
         "0xbf10bdfe177de0336afd7fccf80a904e15386219", "0xf09a01a6c23b936d5a51abce87a6ec8442a44262"),
    ):
        item = t_map.get(source_key)
        if not isinstance(item, dict):
            continue
        q = item.get("liveQuote") if isinstance(item.get("liveQuote"), dict) else {}
        u = item.get("user") if isinstance(item.get("user"), str) and ADDRESS.fullmatch(item["user"]) else None
        sp = item.get("spoke") if isinstance(item.get("spoke"), str) and ADDRESS.fullmatch(item["spoke"]) else spoke
        a11 = rank == "#A11"
        repay_key, seize_key = ("repayUsdc", "seizedUsde") if a11 else ("repayWeth", "seizedWeEth")
        gross_key = "grossSurplusUsdc" if a11 else "grossSurplusUsd"
        view["targets"].append({
            "id": ident,
            "rank": rank,
            "label": f"Aave V4 Spoke {'A' if a11 else 'C'} {pair} ({_short_address(u) if u else 'whale'})",
            "protocol": protocol,
            "pair": pair,
            "user_short": _short_address(u),
            "venue_short": _short_address(sp),
            "observation_only": False,
            "armed": True,
            "executable_now": item.get("executableNow") is True,
            "readiness_note": scrub_text(str(item.get("readinessNote") or (f"Unified Morpho {rank[1:]} on {_short_address(executor)}; subject to live preflight." if rank in {"#A15", "#A17"} else f"ARMED on {_short_address(executor)}; subject to live preflight.")), 240),
            "liquidatable_now": item.get("liquidatableNow") is True,
            "health_factor": f"{float(item['healthFactor']):.6f}" if _nonneg_number(item.get("healthFactor")) else None,
            "bps_to_liq": f"{float(item['bpsToLiquidation']):.4f}" if _nonneg_number(item.get("bpsToLiquidation")) else None,
            "heartbeat_hours_left": f"${float(item['collateralUsd']):,.0f} coll" if _nonneg_number(item.get("collateralUsd")) else None,
            "passive_hours_left": f"${float(item['debtUsd']):,.0f} debt" if _nonneg_number(item.get("debtUsd")) else None,
            "repay_summary": f"{q.get(repay_key)} {'USDC' if a11 else 'WETH'}" if _nonneg_number(q.get(repay_key)) else None,
            "seized_summary": f"{q.get(seize_key)} {'USDe' if a11 else 'weETH'}" if _nonneg_number(q.get(seize_key)) else None,
            "surplus_usd": (f"+${float(q[gross_key]):,.2f}" + ("" if a11 else f" (+{q.get('grossSurplusWeth')} WETH)")) if _nonneg_number(q.get(gross_key)) else None,
            "executor": executor,
            "calldata_ready": _whale_calldata_ready(item.get("readyExecuteMorphoCalldata")),
        })

    view["targets"].extend(deferred_morpho_targets)

    morpho_wst = t_map.get("morpho_wstETH_WETH_Whales")
    if isinstance(morpho_wst, list):
        for idx, item in enumerate(morpho_wst[:4]):
            if not isinstance(item, dict):
                continue
            q = item.get("liveQuote") if isinstance(item.get("liveQuote"), dict) else {}
            u = item.get("user") if isinstance(item.get("user"), str) and ADDRESS.fullmatch(item["user"]) else None
            rk = scrub_text(str(item.get("rank") or f"#M{idx+3}"), 8)
            view["targets"].append({
                "id": f"morpho-wsteth-{idx}",
                "rank": rk,
                "label": f"Morpho Eth wstETH / WETH ({_short_address(u) if u else 'whale'})",
                "protocol": "Morpho Blue",
                "pair": "wstETH / WETH",
                "user_short": _short_address(u),
                "venue_short": "0xBBBB…FFCb",
                "liquidatable_now": item.get("liquidatableNow") is True,
                "health_factor": f"{float(item['healthFactor']):.6f} HF" if _nonneg_number(item.get("healthFactor")) else None,
                "bps_to_liq": f"{float(item['bpsToLiquidation']):.2f} bps to liq" if _nonneg_number(item.get("bpsToLiquidation")) else None,
                "heartbeat_hours_left": f"${float(item['collateralUsd']):,.0f} coll" if _nonneg_number(item.get("collateralUsd")) else None,
                "passive_hours_left": f"${float(item['debtUsd']):,.0f} debt ({float(item['passiveHoursToCrossing']):.1f}h passive)" if _nonneg_number(item.get("passiveHoursToCrossing")) and _nonneg_number(item.get("debtUsd")) else (f"${float(item['debtUsd']):,.0f} debt" if _nonneg_number(item.get("debtUsd")) else None),
                "repay_summary": f"{q.get('repayWeth')} WETH" if _nonneg_number(q.get("repayWeth")) else None,
                "seized_summary": f"{q.get('seizedWstEth')} wstETH" if _nonneg_number(q.get("seizedWstEth")) else None,
                "surplus_usd": f"+${float(q['grossSurplusUsd']):,.2f} (+{q.get('grossSurplusWeth')} WETH)" if _nonneg_number(q.get("grossSurplusUsd")) else None,
                "executor": "0xaf5b…07ba",
                "calldata_ready": isinstance(item.get("readyExecuteMorphoBlueCalldata"), str) and len(item["readyExecuteMorphoBlueCalldata"]) >= 580 and item["readyExecuteMorphoBlueCalldata"].startswith("0x834cbf54"),
            })

    base_morpho = t_map.get("base_Morpho_Whales")
    base_capture = state.get("baseObservation") if isinstance(state.get("baseObservation"), dict) else {}
    base_pin = base_capture.get("pin") if isinstance(base_capture.get("pin"), dict) else {}
    if base_capture.get("status") == "UNAVAILABLE" or not base_morpho:
        view["warnings"].append("Base whale observations are unavailable; health is unknown.")
    elif base_capture.get("status") == "INCOMPLETE":
        view["warnings"].append("Base whale capture is incomplete; some observations are unavailable.")
    b0 = t_map.get("targetB0_Base_USDe_USDC")
    if isinstance(b0, dict):
        u0 = b0.get("user") if isinstance(b0.get("user"), str) and ADDRESS.fullmatch(b0["user"]) else None
        debt0 = b0.get("debtUsdc", b0.get("debtUsd"))
        coll0 = b0.get("collateralValueUsdc", b0.get("collateralUsd"))
        blk0 = b0.get("observationBlock", base_pin.get("number"))
        est0 = b0.get("healthIsEstimate") is not False
        est_suf0 = " (est.)" if est0 else ""
        debt_text0 = f"{float(debt0):,.2f} USDC debt{est_suf0}" if _nonneg_number(debt0) else None
        passive_text0 = debt_text0
        if passive_text0 is not None and _nonneg_number(b0.get("passiveHoursToCrossing")):
            passive_text0 += f" ({float(b0['passiveHoursToCrossing']):.1f}h passive estimate)"
        q0 = b0.get("liveQuote") if isinstance(b0.get("liveQuote"), dict) else {}
        view["targets"].append({
            "id": "target-b0-base-usde-usdc",
            "rank": "#B0",
            "label": f"Morpho Base USDe / USDC (Base) ({_short_address(u0) if u0 else 'whale'})",
            "protocol": "Morpho Blue (Base)",
            "pair": "USDe / USDC (Base)",
            "user_short": _short_address(u0),
            "venue_short": "0xBBBB…FFCb (Base)",
            "observation_only": False,
            "executable_now": b0.get("liquidatableNow") is True,
            "readiness_note": scrub_text(str(b0.get("readinessNote") or "Armed on Base executor 0x88bf…4f32 (+8,415.20 USDC fork-proven)."), 120),
            "health_is_estimate": est0,
            "chain_id": 8453,
            "observation_block": blk0 if _bounded_int(blk0, 10**12) else None,
            "observation_utc": _iso(b0.get("observationUtc", base_pin.get("utc"))),
            "liquidatable_now": b0.get("liquidatableNow") if isinstance(b0.get("liquidatableNow"), bool) else False,
            "health_factor": f"{float(b0['healthFactor']):.6f}" if _nonneg_number(b0.get("healthFactor")) else None,
            "bps_to_liq": f"{float(b0['bpsToLiquidation']):.4f}" if isinstance(b0.get("bpsToLiquidation"), (int, float)) and not isinstance(b0.get("bpsToLiquidation"), bool) else None,
            "heartbeat_hours_left": f"{float(coll0):,.2f} USDC coll{est_suf0}" if _nonneg_number(coll0) else None,
            "passive_hours_left": passive_text0,
            "repay_summary": f"{q0.get('repayUsdc')} USDC" if _nonneg_number(q0.get("repayUsdc")) else debt_text0,
            "seized_summary": f"{q0.get('seizedUsde')} USDe" if _nonneg_number(q0.get("seizedUsde")) else (f"{float(coll0):,.2f} USDC collateral value" if _nonneg_number(coll0) else None),
            "surplus_usd": f"+${float(q0['grossSurplusUsdc']):,.2f} USDC" if _nonneg_number(q0.get("grossSurplusUsdc")) else "+$8,415.20 USDC (fork-proven)",
            "executor": "0x88bf…4f32",
            "calldata_ready": True,
        })

    extra_base_usde = t_map.get("extra_Base_USDe_Whales")
    if isinstance(extra_base_usde, list):
        for idx, item in enumerate(extra_base_usde[:7]):
            if not isinstance(item, dict):
                continue
            u = item.get("user") if isinstance(item.get("user"), str) and ADDRESS.fullmatch(item["user"]) else None
            rk_b = item.get("rank")
            is_yousd = rk_b == "#B7"
            if is_yousd and (item.get("marketId") != BASE_YOUSD_MARKET or not u or u.lower() != BASE_YOUSD_BORROWER):
                continue
            if rk_b == "#B10" and (item.get("marketId") != BASE_YOUSD_MARKET or not u or u.lower() != "0xd406c93c8227ef08dc8ef0dfa027786bb85b756b"):
                continue
            is_yousd = is_yousd or rk_b == "#B10"
            symbol = "yoUSD" if is_yousd else "wstETH" if rk_b == "#B8" else "weETH" if rk_b == "#B9" else "USDe"
            pair_b = "wstETH / WETH (Base)" if rk_b == "#B8" else "weETH / WETH (Base)" if rk_b == "#B9" else f"{symbol} / USDC (Base)"
            debt = item.get("debtUsdc", item.get("debtUsd"))
            collateral = item.get("collateralValueUsdc", item.get("collateralUsd"))
            block_number = item.get("observationBlock", base_pin.get("number"))
            estimated = item.get("healthIsEstimate") is not False
            estimate_suffix = " (est.)" if estimated else ""
            debt_text = f"{float(debt):,.2f} USDC debt{estimate_suffix}" if _nonneg_number(debt) else None
            passive_text = debt_text
            if passive_text is not None and _nonneg_number(item.get("passiveHoursToCrossing")):
                passive_text += f" ({float(item['passiveHoursToCrossing']):.1f}h passive estimate)"
            q = item.get("liveQuote") if isinstance(item.get("liveQuote"), dict) else {}
            view["targets"].append({
                "id": f"base-usde-extra-{idx}",
                "rank": scrub_text(str(item.get("rank") or f"#B{idx+4}"), 8),
                "label": f"Morpho Base {pair_b} ({_short_address(u) if u else 'whale'})",
                "protocol": "Morpho Blue (Base)",
                "pair": pair_b,
                "user_short": _short_address(u),
                "venue_short": "0xBBBB…FFCb (Base)",
                "observation_only": False,
                "armed": True,
                "executable_now": item.get("liquidatableNow") is True,
                "readiness_note": scrub_text(str(item.get("readinessNote") or ("ARMED on Base executor 0x88bf…4f32 via yoUSD.redeem; subject to live preflight." if is_yousd else "Armed on Base executor 0x88bf…4f32 (+23,142.55 USDC fork-proven).")), 160),
                "health_is_estimate": estimated,
                "chain_id": 8453,
                "observation_block": block_number if _bounded_int(block_number, 10**12) else None,
                "observation_utc": _iso(item.get("observationUtc", base_pin.get("utc"))),
                "liquidatable_now": item.get("liquidatableNow") if isinstance(item.get("liquidatableNow"), bool) else False,
                "health_factor": f"{float(item['healthFactor']):.6f}" if _nonneg_number(item.get("healthFactor")) else None,
                "bps_to_liq": f"{float(item['bpsToLiquidation']):.4f}" if isinstance(item.get("bpsToLiquidation"), (int, float)) and not isinstance(item.get("bpsToLiquidation"), bool) else None,
                "heartbeat_hours_left": f"{float(collateral):,.2f} USDC coll{estimate_suffix}" if _nonneg_number(collateral) else None,
                "passive_hours_left": passive_text,
                "repay_summary": f"{q.get('repayUsdc')} USDC" if _nonneg_number(q.get("repayUsdc")) else debt_text,
                "seized_summary": f"{q.get('seizedUsde')} {symbol}" if _nonneg_number(q.get("seizedUsde")) else (f"{float(collateral):,.2f} USDC collateral value" if _nonneg_number(collateral) else None),
                "surplus_usd": f"+${float(q['grossSurplusUsdc']):,.2f} USDC" if _nonneg_number(q.get("grossSurplusUsdc")) else (None if is_yousd else "+$23,142.55 USDC (fork-proven)"),
                "executor": "0x88bf…4f32",
                "calldata_ready": True,
            })

    if isinstance(base_morpho, list):
        for idx, item in enumerate(base_morpho[:3]):
            if not isinstance(item, dict):
                continue
            u = item.get("user") if isinstance(item.get("user"), str) and ADDRESS.fullmatch(item["user"]) else None
            rank = scrub_text(str(item.get("rank") or f"#B{idx+1}"), 8)
            base_armed = item.get("marketId") == BASE_USDE_MARKET and rank in {"#B1", "#B2"}
            # Legacy USD-named fields were actually USDC-denominated estimates.
            debt = item.get("debtUsdc", item.get("debtUsd"))
            collateral = item.get("collateralValueUsdc", item.get("collateralUsd"))
            block_number = item.get("observationBlock", base_pin.get("number"))
            estimated = item.get("healthIsEstimate") is not False
            estimate_suffix = " (est.)" if estimated else ""
            debt_text = f"{float(debt):,.2f} USDC debt{estimate_suffix}" if _nonneg_number(debt) else None
            passive_text = debt_text
            if passive_text is not None and _nonneg_number(item.get("passiveHoursToCrossing")):
                passive_text += f" ({float(item['passiveHoursToCrossing']):.1f}h passive estimate)"
            view["targets"].append({
                "id": f"base-morpho-{idx}",
                "rank": rank,
                "label": f"Morpho Base {scrub_text(str(item.get('pair') or 'USDe / USDC'), 24)} ({_short_address(u) if u else 'whale'})",
                "protocol": "Morpho Blue (Base)",
                "pair": scrub_text(str(item.get("pair") or "USDe / USDC"), 24),
                "user_short": _short_address(u),
                "venue_short": "0xBBBB…FFCb (Base)",
                "observation_only": not base_armed,
                "armed": base_armed,
                "executable_now": base_armed and item.get("liquidatableNow") is True,
                "readiness_note": "Armed on Base executor 0x88bf…4f32; execution remains subject to live preflight." if base_armed else ("Observation only; health and distance exclude unaccrued interest." if estimated else "Observation only; no Base liquidator deployed or live batch approved."),
                "health_is_estimate": estimated,
                "chain_id": 8453,
                "observation_block": block_number if _bounded_int(block_number, 10**12) else None,
                "observation_utc": _iso(item.get("observationUtc", base_pin.get("utc"))),
                "liquidatable_now": item.get("liquidatableNow") if isinstance(item.get("liquidatableNow"), bool) else None,
                "health_factor": f"{float(item['healthFactor']):.6f}" if _nonneg_number(item.get("healthFactor")) else None,
                "bps_to_liq": f"{float(item['bpsToLiquidation']):.4f}" if isinstance(item.get("bpsToLiquidation"), (int, float)) and not isinstance(item.get("bpsToLiquidation"), bool) else None,
                "heartbeat_hours_left": f"{float(collateral):,.2f} USDC coll{estimate_suffix}" if _nonneg_number(collateral) else None,
                "passive_hours_left": passive_text,
                "repay_summary": debt_text,
                "seized_summary": f"{float(collateral):,.2f} USDC collateral value" if _nonneg_number(collateral) else None,
                "surplus_usd": None,
                "executor": "0x88bf…4f32" if base_armed else None,
                "calldata_ready": base_armed,
            })

    m7 = t_map.get("targetM7_Morpho_ynETHx_msETH_Canary")
    if isinstance(m7, dict):
        u7 = m7.get("user") if isinstance(m7.get("user"), str) and ADDRESS.fullmatch(m7["user"]) else None
        bps7 = m7.get("bpsToLiquidation")
        bps7_valid = isinstance(bps7, (int, float)) and not isinstance(bps7, bool) and -1e60 <= bps7 <= 1e60
        buf7 = m7.get("ynEthxBufferWeth")
        q7 = m7.get("liveQuote") if isinstance(m7.get("liveQuote"), dict) else {}
        profit7 = q7.get("estimatedProfitUsd")
        profit7_valid = _nonneg_number(profit7) and profit7 <= 1e60
        calldata7 = m7.get("readyExecuteVaultRedeemCalldata")
        view["targets"].append({
            "id": "target-m7-morpho-ynethx-mseth-canary",
            "rank": "#M7",
            "label": "Morpho Eth ynETHx / msETH Buffer Canary (0x14bc…4550)",
            "protocol": "Morpho Blue",
            "pair": "ynETHx / msETH",
            "user_short": _short_address(u7),
            "venue_short": "0xBBBB…FFCb",
            "observation_only": False,
            "armed": True,
            "executable_now": m7.get("executableNow") is True,
            "readiness_note": scrub_text(str(m7.get("readinessNote") or "ARMED on 0xc063...2eb4 (dynamic 1-50 ynETHx); awaiting MCwETH buffer refill."), 240),
            "liquidatable_now": m7.get("liquidatableNow") if isinstance(m7.get("liquidatableNow"), bool) else None,
            "health_factor": f"{float(m7['healthFactor']):.6f} HF" if _nonneg_number(m7.get("healthFactor")) else None,
            "bps_to_liq": f"{float(bps7):.2f} bps to liq" if bps7_valid else None,
            "heartbeat_hours_left": f"${float(m7['collateralUsd']):,.0f} ynETHx coll (buf {float(buf7):.4f} MCwETH shares (rounded))" if _nonneg_number(m7.get("collateralUsd")) and _nonneg_number(buf7) else None,
            "passive_hours_left": f"${float(m7['debtUsd']):,.0f} msETH debt (accrued < 1.0)" if _nonneg_number(m7.get("debtUsd")) else None,
            "repay_summary": scrub_text(q7.get("debtOutcomeFormatted"), 96),
            "seized_summary": scrub_text(q7.get("collateralSeizedFormatted"), 96),
            "max_liq_profit_usd": float(profit7) if profit7_valid else None,
            "surplus_usd": f"+${float(profit7):,.2f}" if profit7_valid else None,
            "executor": "0xc06326bc6fbd4305cdab4de8e239b7b80feb2eb4",
            "calldata_ready": isinstance(calldata7, str) and re.fullmatch(r"0x[0-9a-fA-F]{776}", calldata7) is not None,
        })

    m7b = t_map.get("targetM7B_Morpho_ynETHx_msETH_0x9b13")
    if isinstance(m7b, dict):
        u7b = m7b.get("user") if isinstance(m7b.get("user"), str) and ADDRESS.fullmatch(m7b["user"]) else None
        hf7b = f"{float(m7b['healthFactor']):.6f}" if _nonneg_number(m7b.get("healthFactor")) else None
        bps7b, buf7b = m7b.get("bpsToLiquidation"), m7b.get("ynEthxBufferWeth")
        q7b = m7b.get("liveQuote") if isinstance(m7b.get("liveQuote"), dict) else {}
        profit7b, calldata7b = q7b.get("estimatedProfitUsd"), m7b.get("readyExecuteVaultRedeemCalldata")
        profit7b_valid = _nonneg_number(profit7b) and profit7b <= 1e60
        view["targets"].append({
            "id": "target-m7b-morpho-ynethx-mseth-0x9b13", "rank": "#M7B",
            "label": "Morpho Eth ynETHx / msETH Buffer Companion (0x9b13…3b82)",
            "protocol": "Morpho Blue", "pair": "ynETHx / msETH",
            "user_short": _short_address(u7b), "venue_short": "0xBBBB…FFCb",
            "observation_only": False, "armed": True, "executable_now": m7b.get("executableNow") is True,
            "readiness_note": scrub_text(str(m7b.get("readinessNote") or "ARMED on 0xc063...2eb4 (dynamic 1-5.69 ynETHx); awaiting MCwETH buffer refill."), 240),
            "liquidatable_now": m7b.get("liquidatableNow") if isinstance(m7b.get("liquidatableNow"), bool) else None,
            "health_factor": hf7b,
            "bps_to_liq": f"{float(bps7b):.4f}" if isinstance(bps7b, (int, float)) and not isinstance(bps7b, bool) and -1e60 <= bps7b <= 1e60 else None,
            "heartbeat_hours_left": f"${float(m7b['collateralUsd']):,.0f} ynETHx coll (buf {float(buf7b):.4f} MCwETH shares (rounded))" if _nonneg_number(m7b.get("collateralUsd")) and _nonneg_number(buf7b) else None,
            "passive_hours_left": f"${float(m7b['debtUsd']):,.0f} msETH debt" if _nonneg_number(m7b.get("debtUsd")) else None,
            "repay_summary": scrub_text(q7b.get("debtOutcomeFormatted"), 96),
            "seized_summary": scrub_text(q7b.get("collateralSeizedFormatted"), 96),
            "max_liq_profit_usd": float(profit7b) if profit7b_valid else None,
            "surplus_usd": f"+${float(profit7b):,.2f}" if profit7b_valid else None,
            "executor": "0xc06326bc6fbd4305cdab4de8e239b7b80feb2eb4",
            "calldata_ready": isinstance(calldata7b, str) and re.fullmatch(r"0x[0-9a-fA-F]{776}", calldata7b) is not None,
        })

    yn_item = t_map.get("targetYnEthx_Curve_NavArb")
    if isinstance(yn_item, dict):
        user_yn = yn_item.get("user") if isinstance(yn_item.get("user"), str) and ADDRESS.fullmatch(yn_item["user"]) else None
        venue_yn = yn_item.get("marketId") if isinstance(yn_item.get("marketId"), str) and ADDRESS.fullmatch(yn_item["marketId"]) else None
        bps_yn = yn_item.get("bpsToLiquidation")
        quote_yn = yn_item.get("liveQuote") if isinstance(yn_item.get("liveQuote"), dict) else {}
        profit_yn = quote_yn.get("estimatedProfitUsd")
        profit_yn_valid = isinstance(profit_yn, (int, float)) and not isinstance(profit_yn, bool) and -1e12 <= profit_yn <= 1e12
        calldata_yn = yn_item.get("readyExecuteCurveRedeemCalldata")
        view["targets"].append({
            "id": "target-ynethx-curve-navarb", "rank": "#YN", "label": "Curve/NAV WETH -> ynETHx -> Redeem (Curve/NAV)",
            "protocol": "Curve/NAV", "pair": "WETH -> ynETHx -> Redeem (Curve/NAV)",
            "user_short": _short_address(user_yn), "venue_short": _short_address(venue_yn),
            "observation_only": False, "armed": True, "executable_now": yn_item.get("executableNow") is True,
            "readiness_note": scrub_text(str(yn_item.get("readinessNote") or "ARMED on 0x91a0...cd35; fires on MCwETH buffer refill."), 240),
            "liquidatable_now": yn_item.get("liquidatableNow") if isinstance(yn_item.get("liquidatableNow"), bool) else None,
            "health_factor": f"{float(yn_item['healthFactor']):.6f}" if _nonneg_number(yn_item.get("healthFactor")) else None,
            "bps_to_liq": f"{float(bps_yn):.4f}" if isinstance(bps_yn, (int, float)) and not isinstance(bps_yn, bool) and -1e60 <= bps_yn <= 1e60 else None,
            "heartbeat_hours_left": f"${float(yn_item['collateralUsd']):,.0f} coll" if _nonneg_number(yn_item.get("collateralUsd")) else None,
            "passive_hours_left": f"${float(yn_item['debtUsd']):,.0f} debt" if _nonneg_number(yn_item.get("debtUsd")) else None,
            "repay_summary": scrub_text(quote_yn.get("debtOutcomeFormatted"), 96),
            "seized_summary": scrub_text(quote_yn.get("collateralSeizedFormatted"), 96),
            "surplus_usd": f"+${float(profit_yn):,.2f}" if profit_yn_valid else None,
            "executor": "0x91a07a51ca9c2abd333d80ca876f0dfde4d8cd35",
            "calldata_ready": isinstance(calldata_yn, str) and re.fullmatch(r"0x[0-9a-fA-F]{520}", calldata_yn) is not None,
        })

    for source_key, ident, rank, pair in (
        ("targetE1_EulerV2_RLUSD_USDC_0xbf21", "target-e1-euler-v2-rlusd-usdc-0xbf21", "#E1", "eUSDC-22 / eRLUSD-1 (Euler V2)"),
        ("targetE3_EulerV2_WETH_ynETHx_0x831e", "target-e3-euler-v2-weth-ynethx-0x831e", "#E3", "eynETHx-2 / eWETH-22 (Euler V2)"),
        ("targetE4_EulerV2_WETH_ynETHx_0x8062", "target-e4-euler-v2-weth-ynethx-0x8062", "#E4", "eynETHx-2 / eWETH-22 (Euler V2)"),
        ("targetE5_EulerV2_USDC_USDT_0xd1ed", "target-e5-euler-v2-usdc-usdt-0xd1ed", "#E5", "eUSDT-9 / eUSDC-22 (Euler V2)"),
        ("targetE6_EulerV2_USDT_USDC_0x079d", "target-e6-euler-v2-usdt-usdc-0x079d", "#E6", "eUSDC-22 / eUSDT-9 (Euler V2)"),
    ):
        e1_item = t_map.get(source_key)
        if not isinstance(e1_item, dict):
            continue
        user_e1 = e1_item.get("user") if isinstance(e1_item.get("user"), str) and ADDRESS.fullmatch(e1_item["user"]) else None
        venue_e1 = e1_item.get("marketId") if isinstance(e1_item.get("marketId"), str) and ADDRESS.fullmatch(e1_item["marketId"]) else None
        bps_e1 = e1_item.get("bpsToLiquidation")
        quote_e1 = e1_item.get("liveQuote") if isinstance(e1_item.get("liveQuote"), dict) else {}
        profit_e1 = quote_e1.get("estimatedProfitUsd")
        profit_e1_valid = isinstance(profit_e1, (int, float)) and not isinstance(profit_e1, bool) and -1e12 <= profit_e1 <= 1e12
        calldata_e1 = e1_item.get("readyExecuteEulerEvkCalldata")
        view["targets"].append({
            "id": ident, "rank": rank, "label": f"Euler V2 {pair}",
            "protocol": "Euler V2", "pair": pair,
            "user_short": _short_address(user_e1), "venue_short": _short_address(venue_e1),
            "observation_only": False, "armed": True, "executable_now": e1_item.get("executableNow") is True,
            "readiness_note": scrub_text(str(e1_item.get("readinessNote") or ("ARMED on 0xac26...5fe6 ($113.5k eRLUSD-1 / $114.5k eUSDC-22)." if rank == "#E1" else f"ARMED on 0xac26...5fe6 ({pair}).")), 240),
            "liquidatable_now": e1_item.get("liquidatableNow") if isinstance(e1_item.get("liquidatableNow"), bool) else None,
            "health_factor": f"{float(e1_item['healthFactor']):.6f}" if _nonneg_number(e1_item.get("healthFactor")) else None,
            "bps_to_liq": f"{float(bps_e1):.4f}" if isinstance(bps_e1, (int, float)) and not isinstance(bps_e1, bool) and -1e60 <= bps_e1 <= 1e60 else None,
            "heartbeat_hours_left": f"${float(e1_item['collateralUsd']):,.0f} coll" if _nonneg_number(e1_item.get("collateralUsd")) else None,
            "passive_hours_left": f"${float(e1_item['debtUsd']):,.0f} debt" if _nonneg_number(e1_item.get("debtUsd")) else None,
            "repay_summary": scrub_text(quote_e1.get("debtOutcomeFormatted"), 96),
            "seized_summary": scrub_text(quote_e1.get("collateralSeizedFormatted"), 96),
            "surplus_usd": f"+${float(profit_e1):,.2f}" if profit_e1_valid else None,
            "executor": "0xac262ce4319b887aeac069730c7978c98a8c5fe6",
            "calldata_ready": isinstance(calldata_e1, str) and re.fullmatch(r"0x[0-9a-fA-F]{776}", calldata_e1) is not None,
        })

    for source_key, ident, rank, protocol, pair, readiness in (
        ("targetE2_EulerV2_USDC_syrupUSDC_0x9f09", "target-e2-euler-v2-usdc-syrupusdc-0x9f09", "#E2", "Euler V2", "esyrupUSDC-4 / eUSDC-70 (Euler V2)",
         "Euler V2 near-liquidation whale ($398.1k eUSDC-70 debt / $402.7k esyrupUSDC-4 collateral); observation-only."),
    ):
        item = t_map.get(source_key)
        if not isinstance(item, dict):
            continue
        user = item.get("user") if isinstance(item.get("user"), str) and ADDRESS.fullmatch(item["user"]) else None
        venue = item.get("marketId") if isinstance(item.get("marketId"), str) and ADDRESS.fullmatch(item["marketId"]) else None
        bps = item.get("bpsToLiquidation")
        quote = item.get("liveQuote") if isinstance(item.get("liveQuote"), dict) else {}
        e2_armed = (str(item.get("executor") or item.get("deployedExecutor") or "").lower() == "0x61251a22540e7148cc8ba58cfb0916a898865e1f")
        profit_e2 = quote.get("estimatedProfitUsd")
        profit_e2_valid = e2_armed and _nonneg_number(profit_e2) and float(profit_e2) > 0
        calldata_e2 = item.get("readyExecuteUniV4FlashCalldata")
        view["targets"].append({
            "id": ident, "rank": rank, "label": f"{protocol} {pair}", "protocol": protocol, "pair": pair,
            "user_short": _short_address(user), "venue_short": _short_address(venue),
            "observation_only": not e2_armed, "armed": e2_armed,
            "executable_now": e2_armed and item.get("executableNow") is True and item.get("liquidatableNow") is True,
            "readiness_note": scrub_text(str(item.get("readinessNote") or readiness), 240),
            "liquidatable_now": item.get("liquidatableNow") if isinstance(item.get("liquidatableNow"), bool) else None,
            "health_factor": f"{float(item['healthFactor']):.6f}" if _nonneg_number(item.get("healthFactor")) else None,
            "bps_to_liq": f"{float(bps):.4f}" if isinstance(bps, (int, float)) and not isinstance(bps, bool) and -1e60 <= bps <= 1e60 else None,
            "heartbeat_hours_left": f"${float(item['collateralUsd']):,.0f} coll" if _nonneg_number(item.get("collateralUsd")) else None,
            "passive_hours_left": f"${float(item['debtUsd']):,.0f} debt" if _nonneg_number(item.get("debtUsd")) else None,
            "repay_summary": scrub_text(quote.get("debtOutcomeFormatted"), 96),
            "seized_summary": scrub_text(quote.get("collateralSeizedFormatted"), 96),
            "surplus_usd": f"+${float(profit_e2):,.2f}" if profit_e2_valid else None,
            "executor": "0x61251a22540e7148cc8ba58cfb0916a898865e1f" if e2_armed else None,
            "calldata_ready": e2_armed and isinstance(calldata_e2, str) and calldata_e2.startswith("0x"),
        })

    t3 = t_map.get("target3_Morpho_PAXG_USDC")
    if isinstance(t3, dict):
        view["targets"].append({
            "id": "target-3-morpho-paxg-usdc",
            "rank": "#3",
            "label": "Morpho PAXG / USDC market liquidity",
            "protocol": "Morpho Blue",
            "pair": "PAXG / USDC",
            "user_short": None,
            "venue_short": "0x8eaf…06c9",
            "observation_only": True,
            "executable_now": False,
            "readiness_note": "Observation only; available market liquidity is not profit.",
            "liquidatable_now": False,
            "health_factor": None,
            "bps_to_liq": None,
            "heartbeat_hours_left": f"{float(t3['availableUsdc']):,.6f} USDC available" if _nonneg_number(t3.get("availableUsdc")) else None,
            "passive_hours_left": None,
            "repay_summary": None,
            "seized_summary": None,
            "surplus_usd": None,
            "executor": None,
            "calldata_ready": False,
        })

    if isinstance(arb_morpho_watch, dict) and isinstance(arb_morpho_watch.get("targets"), list):
        from .targets import ARB_FLUID_EXECUTOR, ARB_FLUID_ID, ARB_FLUID_54_ID, ARB_FLUID_42_ID, _ARB_METADATA, _arb_morpho_row

        arb_pairs = {
            "#ARB1": "sUSDS / USDT0 (Arb)",
            "#ARB2": "sUSDS / USDT0 (Arb)",
            "#ARB3": "sUSDai / USDC (Arb)",
            "#ARB4": "sUSDS / USDC (Arb)",
            "#ARB5": "sUSDe-USDT / USDT0 (Arbitrum)",
            "#ARB6": "USDai-USDT0 / USDT0 (Arbitrum)",
            "#ARB7": "USDai-USDC / USDT0 (Arbitrum)",
        }
        for item in arb_morpho_watch["targets"][:7]:
            if not isinstance(item, dict):
                continue
            rk = "#ARB5" if item.get("id") == ARB_FLUID_ID else "#ARB6" if item.get("id") == ARB_FLUID_54_ID else "#ARB7" if item.get("id") == ARB_FLUID_42_ID else item.get("rank")
            if not isinstance(rk, str) or rk not in arb_pairs:
                continue
            pair = arb_pairs[rk]
            fluid = rk in {"#ARB5", "#ARB6", "#ARB7"}
            fluid_row = _arb_morpho_row(item) if fluid else None
            if fluid and fluid_row is None:
                continue
            metadata = _ARB_METADATA[fluid_row["id"]] if fluid else None
            u = item.get("borrower") if isinstance(item.get("borrower"), str) and ADDRESS.fullmatch(item["borrower"]) else None
            hf = item.get("healthFactor")
            bps = item.get("bpsToLiquidation")
            liq = bool(item.get("isLiquidatable"))
            debt = item.get("debtStableUsd")
            coll = item.get("collateralValueUsd")
            passive = item.get("passiveHoursToLiquidation")
            view["targets"].append({
                "id": fluid_row["id"] if fluid else f"arb-morpho-{rk.lower().lstrip('#')}",
                "rank": rk,
                "label": "Arbitrum Fluid T2 USDai-USDC / USDT0 (0x5eb4…d06f)" if rk == "#ARB7" else "Arbitrum Fluid T2 USDai-USDT0 / USDT0 (0xd9a7…3669)" if rk == "#ARB6" else "Arbitrum Fluid T2 sUSDe-USDT / USDT0 (0x81a0…3cbb)" if fluid else f"Morpho Arbitrum {pair} ({_short_address(u) if u else 'whale'})",
                "protocol": "Fluid" if fluid else "Morpho Blue (Arbitrum)",
                "pair": pair,
                "chain_id": 42161,
                "user_short": _short_address(u) if u else None,
                "venue_short": _short_address(metadata[2]) if fluid else "0x6c24…8f5e",
                "observation_only": False,
                "executable_now": False if rk == "#ARB7" else liq,
                "readiness_note": metadata[9] if fluid else "ARMED on Arbitrum executor 0x08be…e675 (live poll every 10s).",
                "liquidatable_now": liq,
                "health_factor": f"{float(hf):.6f}" if _nonneg_number(hf) else None,
                "bps_to_liq": f"{float(bps):.2f} bps to liq" if _nonneg_number(bps) else None,
                "heartbeat_hours_left": f"${float(coll):,.0f} coll" if _nonneg_number(coll) else None,
                "passive_hours_left": f"${float(debt):,.0f} debt ({float(passive):.1f}h passive)" if _nonneg_number(passive) and _nonneg_number(debt) else (f"${float(debt):,.0f} debt" if _nonneg_number(debt) else None),
                "repay_summary": (f"{metadata[7]:,.2f} {metadata[4]}" if metadata[7] is not None else None) if fluid else f"{float(debt):,.2f} {'USDC' if rk in {'#ARB3', '#ARB4'} else 'USDT0'}" if _nonneg_number(debt) else None,
                "seized_summary": metadata[6] if fluid else f"{float(coll):,.2f} {'sUSDai' if rk == '#ARB3' else 'sUSDS'}" if _nonneg_number(coll) else None,
                "surplus_usd": f"+{metadata[8]:,.2f} {metadata[4]} (simulated)" if fluid and metadata[8] is not None else None,
                "executor": (fluid_row.get("executor") or ARB_FLUID_EXECUTOR) if fluid else "0x08be4f3e07ef8a2c2f13cefdafcf9a82b5efe675",
                "calldata_ready": rk != "#ARB7",
            })

        # These two Morpho identities use the Universal executor and USDG, not
        # the legacy USDT0 route above. Reuse the canonical bounded adapter.
        from .targets import (ARB_MORPHO, ARB_SINGLES, ARB_UNIVERSAL_EXECUTOR, ARB_WATCH,
                              _arb_morpho_pin, _number, _observation, _runner, arb_morpho_watch_valid)
        if arb_morpho_watch_valid(arb_morpho_watch):
            arb_pin = _arb_morpho_pin(arb_morpho_watch.get("pin"))
            arb_obs = _observation(arb_pin, arb_morpho_watch.get("checkedAt"), now, 42161, ARB_WATCH,
                                   arb_morpho_watch.get("ok") is True and ("blockNumber" not in arb_morpho_watch
                                   or arb_morpho_watch["blockNumber"] == arb_pin.get("number")))
            seen = set()
            for item in arb_morpho_watch["targets"][:9]:
                normalized = _arb_morpho_row(item)
                if normalized is None or normalized.get("rank") not in ARB_SINGLES or normalized["id"] in seen:
                    continue
                seen.add(normalized["id"])
                runner = _runner(arb_morpho_watch, {"mode": arb_morpho_watch.get("mode"), "checked_at": arb_morpho_watch.get("checkedAt")},
                                 "Arbitrum Morpho Runner", normalized.get("executor") == ARB_UNIVERSAL_EXECUTOR, arb_obs)
                hf, bps = _number(normalized.get("healthFactor")), _number(normalized.get("bpsToLiquidation"), signed=True)
                eligible = normalized.get("liquidatableNow")
                known = hf is not None and isinstance(eligible, bool) and eligible == (hf < 1) and arb_obs["freshness"] == FRESH
                coll, debt = _number(normalized.get("collateralUsd")), _number(normalized.get("debtUsd"))
                view["targets"].append({
                    "id": normalized["id"], "rank": normalized["rank"], "pair": normalized["pair"],
                    "label": f"Morpho Arbitrum {normalized['pair']} ({_short_address(normalized['user'])})",
                    "protocol": "Morpho Blue (Arbitrum)", "chain_id": 42161,
                    "market_id": normalized["marketId"], "borrower_address": normalized["user"], "venue_address": ARB_MORPHO,
                    "user_short": _short_address(normalized["user"]), "venue_short": _short_address(ARB_MORPHO),
                    "observation_only": False, "health_is_estimate": False, "armed": runner["reported_armed"] is True,
                    "executable_now": False, "calldata_ready": False, "liquidatable_now": eligible if known else None,
                    "readiness_note": "Reported Arbitrum runner telemetry; current profitability and execution readiness are not established.",
                    "health_factor": f"{hf:.6f}" if hf is not None else None,
                    "bps_to_liq": f"{bps:.2f} bps to liq" if bps is not None else None,
                    "heartbeat_hours_left": f"${coll:,.0f} coll" if coll is not None else None,
                    "passive_hours_left": f"${debt:,.0f} debt" if debt is not None else None,
                    "repay_summary": None, "seized_summary": None, "surplus_usd": None,
                    "executor": ARB_UNIVERSAL_EXECUTOR,
                    "observation_block": arb_obs["block"] if arb_obs["freshness"] != UNKNOWN else None,
                    "observation_utc": arb_obs["utc"] if arb_obs["freshness"] != UNKNOWN else None,
                })

    for row in view["targets"]:
        row.setdefault("observation_only", False)
        row.setdefault("health_is_estimate", False)
        row.setdefault("chain_id", 1)
        row.setdefault("observation_block", view["pin_block"])
        row.setdefault("observation_utc", view["pin_utc"])
        row.setdefault("readiness_note", "Calldata shape checked; execution is not proven." if row["calldata_ready"] else "No parameterized execution calldata available.")

    view["available"] = True
    from .targets import _home_evidence
    return _home_evidence(view, state, reader, now)


def build_offensive(
    reader: Any,
    now: float,
    *,
    fleet_read: Any,
    fastlane_read: Any,
    loop_read: Any,
    silo_read: Any,
    bytecode_read: Any,
    whale_triggers_read: Any = None,
    v4_v3_deploy_read: Any = None,
    v4_flash_deploy_read: Any = None,
    v4_live_watch_read: Any = None,
    v4_rehearsal_read: Any = None,
    v3_watch_read: Any = None,
    base_rehearsal_read: Any = None,
    m1_rehearsal_read: Any = None,
    m2_rehearsal_read: Any = None,
    base_deploy_read: Any = None,
    base_watch_read: Any = None,
    m7_rehearsal_read: Any = None,
    pt_rehearsal_read: Any = None,
    yousd_rehearsal_read: Any = None,
    arb_morpho_watch: dict[str, Any] | None = None,
) -> dict[str, Any]:
    fleet = build_fleet_deploy(fleet_read, now, reader, "euler_fleet_deploy_status")
    fastlane = build_fastlane(fastlane_read, now, reader, "euler_fastlane_status")
    loop = build_autofire_loop(loop_read, now, reader, "autofire_loop_status")
    silo = build_silo_watch(silo_read, now, reader, "silo_default_watch_status")
    bytecode = build_bytecode(bytecode_read, now, reader, "deployed_bytecode_verification")
    top_whales = build_top_whale_triggers(
        whale_triggers_read,
        v4_v3_deploy_read,
        now,
        reader,
        "top_whale_triggers_status",
        "aave_v4_v3_morpho_liquidator_deploy",
        v4_deploy_read=v4_flash_deploy_read,
        v4_watch_read=v4_live_watch_read,
        v4_rehearsal_read=v4_rehearsal_read,
        v3_watch_read=v3_watch_read,
        base_rehearsal_read=base_rehearsal_read,
        m1_rehearsal_read=m1_rehearsal_read,
        m2_rehearsal_read=m2_rehearsal_read,
        base_deploy_read=base_deploy_read,
        base_watch_read=base_watch_read,
        m7_rehearsal_read=m7_rehearsal_read,
        pt_rehearsal_read=pt_rehearsal_read,
        yousd_rehearsal_read=yousd_rehearsal_read,
        arb_morpho_watch=arb_morpho_watch,
    )
    warnings: list[str] = []
    for section in (fleet, fastlane, loop, silo, bytecode):
        warnings.extend(section["warnings"])
    return {
        "available": any(
            section["available"] for section in (fleet, fastlane, loop, silo, bytecode, top_whales)
        ),
        "freshness": UNKNOWN,
        "fleet_deploy": fleet,
        "fastlane": fastlane,
        "autofire_loop": loop,
        "silo_watch": silo,
        "bytecode": bytecode,
        "top_whales": top_whales,
        "warnings": warnings,
    }


# --------------------------------------------------------------------------- #
# Aggregate
# --------------------------------------------------------------------------- #


def build_ops(reader: Any, now: float) -> dict[str, Any]:
    """Read the operational allowlist and return the four normalized panels."""

    execution = execution_view(reader, now)
    coverage_read = reader.read_json("trigger_coverage_audit", validator=trigger_coverage_valid)
    watch_read = reader.read_json("watch_addresses")
    batch_read = reader.read_json("live_execution_batch")
    approvers_read = reader.read_json("live_execution_approvers", validator=approver_registry_valid)
    autopilot_status_read = reader.read_json("trigger_fork_autopilot_status", validator=autopilot_status_valid)
    autopilot_state_read = reader.read_json("trigger_fork_autopilot_state", validator=autopilot_state_valid)
    profit_read = reader.read_json("profit_trigger_watch", validator=profit_trigger_watch_valid)
    dispatcher_read = reader.read_json("monitor_alert_dispatcher_status", validator=dispatcher_status_valid)
    watchdog_read = reader.read_json("monitor_set_watchdog_status", validator=watchdog_status_valid)
    wallet_read = reader.read_json("wallet_balances", validator=wallet_balances_valid)
    fleet_read = reader.read_json("euler_fleet_deploy_status", validator=euler_fleet_deploy_valid)
    fastlane_read = reader.read_json("euler_fastlane_status", validator=euler_fastlane_valid)
    loop_read = reader.read_json("autofire_loop_status", validator=autofire_loop_valid)
    silo_read = reader.read_json("silo_default_watch_status", validator=silo_watch_valid)
    bytecode_read = reader.read_json("deployed_bytecode_verification", validator=bytecode_verification_valid)
    whale_triggers_read = reader.read_json("top_whale_triggers_status", validator=top_whale_triggers_valid)
    v4_v3_deploy_read = reader.read_json("aave_v4_v3_morpho_liquidator_deploy", validator=v4_v3_morpho_deploy_valid)
    v4_flash_deploy_read = reader.read_json("aave_v4_flash_liquidator_deploy", validator=aave_v4_flash_deploy_valid)
    v4_live_watch_read = reader.read_json("aave_v4_executor_live_watch", validator=aave_v4_live_watch_valid)
    v4_rehearsal_read = reader.read_json("aave_v4_multi_spoke_rehearsal", validator=aave_v4_rehearsal_valid)
    v3_live_watch_read = reader.read_json("top_whale_executor_live_watch", validator=top_whale_executor_watch_valid)
    base_rehearsal_read = reader.read_json("base_morpho_usde_rehearsal", validator=base_morpho_rehearsal_valid)
    m1_rehearsal_read = reader.read_json("eth_morpho_usde_dai_rehearsal", validator=eth_morpho_rehearsal_valid)
    m2_rehearsal_read = reader.read_json("eth_morpho_reusd_rehearsal", validator=eth_morpho_rehearsal_valid)
    m7_rehearsal_read = reader.read_json("eth_morpho_ynethx_rehearsal", validator=eth_morpho_rehearsal_valid)
    pt_rehearsal_read = reader.read_json("eth_morpho_pt_usde_rehearsal", validator=lambda value: _fork_poc_rehearsal_valid(value, 1))
    yousd_rehearsal_read = reader.read_json("base_morpho_yousd_rehearsal", validator=lambda value: _fork_poc_rehearsal_valid(value, 8453))
    base_deploy_read = reader.read_json("base_morpho_liquidator_deploy", validator=base_morpho_deploy_valid)
    base_watch_read = reader.read_json("base_morpho_executor_live_watch", validator=base_morpho_live_watch_valid)
    arb_watch_read = reader.read_json("arb_morpho_executor_live_watch")
    arb_watch = arb_watch_read.value if arb_watch_read.current else None

    coverage = build_trigger_coverage(coverage_read.value, now, coverage_read.current)
    watch_state, watch_count, watch_detail = watch_addresses_state(watch_read.value, watch_read.current)
    watch_list = watch_address_entries(watch_read.value, watch_read.current)
    autopilot = build_autopilot(
        autopilot_status_read.value,
        autopilot_state_read.value,
        now,
        autopilot_status_read.current,
        autopilot_state_read.current,
    )
    profit_watch = build_profit_watch(profit_read.value, now, profit_read.current)
    dispatcher = build_dispatcher(dispatcher_read.value, now, dispatcher_read.current)
    watchdog = build_watchdog(watchdog_read.value, now, watchdog_read.current)
    pipeline = build_pipeline(profit_watch, autopilot, dispatcher, watchdog)
    batch = batch_state(
        batch_read.value,
        batch_read.current,
        batch_read.source,
        now,
        execution=execution,
    )
    mode = build_mode(
        now=now,
        watch_state=watch_state,
        watch_count=watch_count,
        watch_detail=watch_detail,
        autopilot=autopilot,
        batch=batch,
        approvers_available=approvers_read.current,
        approvers_state=approvers_read.value,
        coverage_state=coverage_read.value,
        coverage_available=coverage_read.current,
    )
    wallets = build_wallets(
        wallet_read.value,
        now,
        wallet_read.current,
        watch_configured=watch_state == "PASS",
        watch_count=watch_count,
        watch_detail=watch_detail,
        watch_list=watch_list,
        cached=wallet_read.cached,
    )
    wallets["collector"] = collector_status()
    envelopes = build_envelopes(reader, now, fleet_read, loop_read, execution)
    offensive = build_offensive(
        reader,
        now,
        fleet_read=fleet_read,
        fastlane_read=fastlane_read,
        loop_read=loop_read,
        silo_read=silo_read,
        bytecode_read=bytecode_read,
        whale_triggers_read=whale_triggers_read,
        v4_v3_deploy_read=v4_v3_deploy_read,
        v4_flash_deploy_read=v4_flash_deploy_read,
        v4_live_watch_read=v4_live_watch_read,
        v4_rehearsal_read=v4_rehearsal_read,
        v3_watch_read=v3_live_watch_read,
        base_rehearsal_read=base_rehearsal_read,
        m1_rehearsal_read=m1_rehearsal_read,
        m2_rehearsal_read=m2_rehearsal_read,
        base_deploy_read=base_deploy_read,
        base_watch_read=base_watch_read,
        m7_rehearsal_read=m7_rehearsal_read,
        pt_rehearsal_read=pt_rehearsal_read,
        yousd_rehearsal_read=yousd_rehearsal_read,
        arb_morpho_watch=arb_watch,
    )
    return {
        "trigger_coverage": coverage,
        "pipeline": pipeline,
        "mode": mode,
        "wallets": wallets,
        "envelopes": envelopes,
        "offensive": offensive,
    }
