"""Fixed stored-target adapters; compact index generations and page-only projection.

No discovery, network, disk cache, runner actions or dynamic filesystem paths.
The reader owns all I/O admission. Enumeration dates never become health pins.
"""

from __future__ import annotations

import hashlib
import heapq
import math
import re
import threading
import weakref
from dataclasses import dataclass, field, replace
from decimal import Decimal, InvalidOperation, localcontext
from types import MappingProxyType
from typing import Any, NamedTuple

from . import ops
from .artifacts import JsonRead
from .normalize import AGING, FRESH, STALE, UNKNOWN, timestamp
from .targets import (ARB_FLUID_ID, ARB_FLUID_54_ID, ARB_FLUID_42_ID, ARB_MORPHO, ARB_SINGLES, ARB_WATCH, ARRAYS, BASE_WATCH, BASE_RUNNER_BINDINGS, MORPHO, POOL, READS, SENTINEL, SINGLES, SPARK_POOL, SPARK_WHALE_BINDINGS, V3_WATCH, V3_WHALE_BINDINGS,
                       V4_WATCH, _arb_morpho_pin, _arb_morpho_row, _arb_usdg_quote, _clean, _quote, _runner_pin,
                       CLOSED_POSITION_NOTE, _base_watch, _position_debt_status, arb_morpho_watch_valid, build_curated_targets)

MAX_ROWS = 10000
CHAINS = {1: "Ethereum", 10: "Optimism", 56: "BNB Chain", 100: "Gnosis", 137: "Polygon",
          8453: "Base", 42161: "Arbitrum", 43114: "Avalanche", 534352: "Scroll", 42220: "Celo"}
PROTOCOLS = ("Aave V3", "Aave V4", "Morpho Blue", "Compound V3", "Euler", "Silo", "Venus", "Curve/NAV", "Fluid", "SparkLend")
STATUSES = ("HELD", "ELIGIBLE", "WATCH", "INACTIVE", "OBSERVATION_ONLY", "STALE", "UNKNOWN")
SORTS = ("passive_time", "curated", "distance-asc", "distance-desc", "gross-asc", "gross-desc", "chain", "protocol", "status")
STATES = {"OK", "PARTIAL", "MISSING", "INVALID", "OVERSIZED", "UNAVAILABLE"}
ADDRESS = re.compile(r"0x[0-9a-fA-F]{40}\Z")
HASH = re.compile(r"0x[0-9a-fA-F]{64}\Z")
NUMBER = re.compile(r"-?(?:0|[1-9][0-9]{0,77})(?:\.[0-9]{1,78})?\Z")
IDENTIFIER = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,95}\Z")
ZERO = "0x" + "0" * 40
NEAR_WATCH = "aave_v4_near_watch"
NEAR_IDENTITIES = "aave_v4_near_identities"
# Public producer bindings only: spoke, borrower, executor. No approval semantics.
NEAR_BINDINGS = MappingProxyType({
    "rank1_usdc_usdc_0x014e": ("0x94e7a5dcbe816e498b89ab752661904e2f56c485", "0x014e4921ec5aeeead25192a48028b776601d2c8e", "0xf09a01a6c23b936d5a51abce87a6ec8442a44262"),
    "rank2_wsteth_weth_0x4cd7": ("0xe1900480ac69f0b296841cd01cc37546d92f35cd", "0x4cd76521f616db4d6978a4a80aeb77ccc9e890ec", "0x3c02c96bbb423d0109b823c23a05fcf0bf91ecb7"),
    "rank5_usdc_usdc_0x0d3f": ("0xd8b93635b8c6d0ff98cbe90b5988e3f2d1cd9da1", "0x0d3ff01d9a6b4ce46e048e495b9c109b6b5d0933", "0xf09a01a6c23b936d5a51abce87a6ec8442a44262"),
})


@dataclass(frozen=True)
class Source:
    id: str
    label: str
    kind: str = "json"
    max_bytes: int = 5242880
    max_rows: int = MAX_ROWS
    note: str = "Stored observations only; not complete on-chain discovery or execution readiness."


SOURCES = (
    Source(SENTINEL, "Curated whale observations"),
    Source(V4_WATCH, "Dedicated Aave V4 runner"),
    Source(V3_WATCH, "Scoped unified runner", note="Runner enrichment only; candidate counts do not create positions."),
    Source(ARB_WATCH, "Arbitrum Morpho runner", max_rows=9,
           note="Six fixed borrower/market bindings and three Fluid vaults; runner health and position telemetry are not executable profit."),
    Source("aave_v4_near_watch", "Near-liquidation Aave V4 runner"),
    Source(NEAR_IDENTITIES, "Near-liquidation public identities", note="Validated public target bindings only; approval metadata supplies no health, freshness or runner authority."),
    Source("aave_v3_borrower_universe", "Aave V3 identity preview", note="Bounded identity preview; enumeration blocks are not health evidence."),
    Source("aave_v3_borrower_csv", "Aave V3 full stored identities", "index", 8388608, 125000,
           "Historical identities, not current debt or health; enumeration dates are not health pins."),
    Source("aave_v3_route_distance", "Aave V3 retained distance observations", note="Debt-gated retained samples; discovery blocks are not hash-pinned health observations."),
    Source("aave_v3_trigger_readiness", "Aave V3 readiness observation"),
    Source("aave_v3_liquidation_exact_quotes", "Aave V3 exact-quote observation", note="Stored quote context; no inferred USD conversion or execution authorization."),
    Source("aave_v3_liquidation_trigger_quotes", "Aave V3 trigger-quote observation"),
    Source("aave_v3_liquidation_watch", "Aave V3 watch coverage", note="Summary telemetry without complete venue identities is coverage only."),
    Source("aave_v4_spoke_borrowers", "Aave V4 detailed spoke observations", note="Retained per-spoke detail is smaller than the reported scored population."),
    Source("aave_v4", "Aave V4 retained watch observations"),
    Source("aave_v4_borrower_index", "Aave V4 full stored identities", "index", 8388608, 100000,
           "Validated fixed history checkpoint; enumeration pins are not health pins."),
    Source("morpho_blue_liquidatable", "Ethereum Morpho detailed observations", max_bytes=16777216,
           note="Fixed 16 MiB JSON exception; retained candidates are not all active positions. Raw oracle values are not USD."),
    Source("morpho_blue_liquidatable_base", "Base Morpho detailed observations"),
    Source("morpho_blue_index", "Ethereum Morpho full stored identities", "index", 16777216, 100000,
           "Event-count identities; active, unresolved and assumed-zero index sets are not current health proofs."),
    Source("morpho_blue_base_index", "Base Morpho full stored identities", "index", 67108864, 250000,
           "Event-count identities; active, unresolved and assumed-zero index sets are not current health proofs."),
    Source("compound_v3_base_watch", "Compound V3 Base known accounts", note="All published discovery candidates, joined to screened accounts; reported debt coverage is not full-market coverage."),
    Source("euler_silo_current_screen", "Pinned Euler and Silo known-account screen", note="Bounded historical samples and known accounts only; liquidation capacity is not executable profit."),
    Source("euler_l_watch", "Euler historical-sample watch", note="Leg observations deduplicate by vault/account; no hash pin means health remains unconfirmed."),
    Source("euler_l_surface", "Euler vault inventory and historical seeds", note="Vault records are markets; liquidation events supply identities, not current health or profit."),
    Source("euler_l_valuation", "Euler historical modeled events", note="Historical modeled event values are not current positions or profit quotes."),
    Source("euler_liquidation_history", "Euler full stored liquidation identities", "index", 5242880, 10000,
           "Historical vault/violator identities only; repay and yield events are not current debt or quotes."),
    Source("silo_l_surface", "Silo markets and known accounts", note="Market sides are not borrowers; saved band labels do not establish current solvency."),
    Source("silo_l_economics", "Silo retained economics accounts", note="Empty candidate output does not erase other known accounts; no liquid-exit qualification."),
    Source("silo_default_watch_status", "Silo default-watch known accounts"),
    Source("silo_default_step1", "Silo offline example coverage", note="Offline example only; never admitted as a live position."),
    Source("research_watch", "Research watch coverage", note="Research counts and prose are coverage only; no inferred borrower identities."),
    Source("state", "Monitor structured-identity coverage", note="Only explicitly identified EVM rows are admitted; summary counts and prose are not positions."),
    Source("morpho_ws_status", "Morpho websocket identity coverage", note="Stored recent identities only; cached-borrower counts and event totals are not positions."),
    Source("venus_psr", "Venus stored market coverage", note="Explicit market addresses only; drift summaries and liquidity are not borrower records or profit."),
    *(Source(key, label, note="Curated operational panel evidence only; no additional live positions.") for key, label in (
        ("aave_v4_v3_morpho_liquidator_deploy", "Unified deployment evidence"),
        ("aave_v4_flash_liquidator_deploy", "Aave V4 deployment evidence"),
        ("aave_v4_multi_spoke_rehearsal", "Aave V4 rehearsal evidence"),
        ("base_morpho_usde_rehearsal", "Base Morpho rehearsal evidence"))),
    # Append so existing source bit positions remain stable.
    Source(BASE_WATCH, "Scoped Base runner", max_rows=len(BASE_RUNNER_BINDINGS),
           note="Runner enrichment only for fixed Base plans; report rows do not create positions or health evidence."),
)
BY_SOURCE = {s.id: s for s in SOURCES}
SOURCE_BITS = {s.id: 1 << i for i, s in enumerate(SOURCES)}
# Only shortlist identity inputs, compatible health evidence and existing panels.
# Historical indexes and unrelated protocol inventories are never read publicly.
TRADE_SOURCES = tuple(s for s in SOURCES if s.id in {
    *READS, ARB_WATCH, NEAR_WATCH, NEAR_IDENTITIES, "aave_v3_route_distance", "aave_v3_trigger_readiness",
    "aave_v3_liquidation_exact_quotes", "aave_v3_liquidation_trigger_quotes",
    "aave_v4_spoke_borrowers", "aave_v4", "morpho_blue_liquidatable", "morpho_blue_liquidatable_base",
})

# Canonical identity: type, chain, protocol, venue, borrower, Morpho market.
Identity = tuple[str, int, str, str, str | None, str | None]


class Descriptor(NamedTuple):
    identity: Identity
    digest: bytes
    mask: int


@dataclass(frozen=True)
class Generation:
    version: tuple
    ordered: tuple[Descriptor, ...]
    by_identity: Any


_GENERATIONS: weakref.WeakKeyDictionary = weakref.WeakKeyDictionary()
_GENERATION_LOCK = threading.RLock()


def address(value: Any) -> str | None:
    return value.lower() if isinstance(value, str) and ADDRESS.fullmatch(value) and value.lower() != ZERO else None


def digest(value: Any) -> str | None:
    return value.lower() if isinstance(value, str) and HASH.fullmatch(value) else None


def integer(value: Any, ceiling: int = 10**12) -> int | None:
    return value if type(value) is int and 0 <= value <= ceiling else None


def decimal(value: Any, signed: bool = False) -> Decimal | None:
    if isinstance(value, bool) or not isinstance(value, (int, float, str, Decimal)):
        return None
    if isinstance(value, int) and value.bit_length() > 256:
        return None
    if isinstance(value, float) and not math.isfinite(value):
        return None
    text = str(value)
    if len(text) > 160:
        return None
    if isinstance(value, str) and not NUMBER.fullmatch(text):
        return None
    try:
        number = Decimal(text)
    except InvalidOperation:
        return None
    return number if number.is_finite() and number.copy_abs() <= Decimal(2**256 - 1) and (signed or number >= 0) else None


def amount(value: Any, signed: bool = False) -> str | None:
    value = decimal(value, signed)
    if value is None:
        return None
    text = format(value, "f")
    return (text.rstrip("0").rstrip(".") if "." in text else text) if value else "0"


def scaled(value: Any, scale: int) -> Decimal | None:
    if not isinstance(value, (int, str)) or isinstance(value, bool):
        return None
    number = decimal(value)
    if number is None or number != number.to_integral_value():
        return None
    with localcontext() as ctx:
        ctx.prec = 160
        return number / scale


def identity(chain: Any, protocol: str, venue: Any, borrower: Any = None, market: Any = None, kind: str = "position") -> Identity | None:
    venue, borrower, market = address(venue), address(borrower), address(market) if protocol == "Fluid" else digest(market)
    if type(chain) is not int or chain not in CHAINS or protocol not in PROTOCOLS or venue is None:
        return None
    if kind not in {"position", "market"} or (kind == "position" and borrower is None):
        return None
    if protocol in {"Morpho Blue", "Fluid"} and market is None:
        return None
    return (kind, chain, protocol, venue, borrower if kind == "position" else None, market if protocol in {"Morpho Blue", "Fluid"} else None)


def descriptor(key: Identity, mask: int) -> Descriptor:
    # Digest once per immutable index generation; hex is formatted on-page only.
    raw = "\x1f".join("" if part is None else str(part) for part in key).encode("ascii")
    return Descriptor(key, hashlib.sha256(raw).digest(), mask)


def obj(value: Any) -> dict:
    return value if isinstance(value, dict) else {}


def source_date(raw: dict) -> str | None:
    for key in ("checkedAt", "generatedAt", "scannedAt", "updatedAt", "attemptAt", "lastRun"):
        at = ops._iso(raw.get(key))
        if at is not None:
            return at
    return None


def pin(value: Any, chain: int) -> dict:
    raw = obj(value)
    explicit_chain = raw.get("chainId", raw.get("id", chain))
    if type(explicit_chain) is not int or explicit_chain != chain:
        return {}
    block = integer(raw.get("number", raw.get("blockNumber")))
    hash_ = digest(raw.get("hash", raw.get("blockHash")))
    seconds = raw.get("timestamp")
    if "timestamp" in raw and not (isinstance(seconds, str) or (type(seconds) is int and 0 < seconds <= 9_999_999_999)):
        return {}
    utc = ops._iso(raw.get("utc", raw.get("timestamp")))
    if "utc" in raw and "timestamp" in raw and timestamp(raw["utc"]) != timestamp(raw["timestamp"]):
        return {}
    return {"block": block, "hash": hash_, "utc": utc} if block and hash_ and utc else {}


def observation(source: str, at: Any, pinned: dict, now: float) -> dict:
    fresh, age = ops._freshness_view(at, now)
    pin_fresh, pin_age = ops._freshness_view(pinned.get("utc"), now)
    if not pinned:
        fresh, age = UNKNOWN, None
    elif fresh not in {FRESH, AGING, STALE} or pin_fresh not in {FRESH, AGING, STALE}:
        fresh, age = UNKNOWN, pin_age
    else:
        age = max(age, pin_age)
        fresh = ops._freshness_view(now - age, now)[0]
    return {"source": source, "freshness": fresh, "age_text": ops._age_text(age),
            "block": pinned.get("block"), "hash": pinned.get("hash"), "utc": pinned.get("utc")}


@dataclass
class Evidence:
    source: str
    at: str | None
    pin: dict
    hf: Decimal | None = None
    eligible: bool | None = None
    bps: Decimal | None = None
    position: dict = field(default_factory=dict)
    runner: dict | None = None
    quote: dict | None = None
    notes: tuple[str, ...] = ()
    health_known: bool = False
    tolerance: Decimal = Decimal(0)
    position_status: str | None = None


@dataclass
class Batch:
    source: Source
    coverage: dict
    at: str | None = None
    now: float = 0
    identities: dict = field(default_factory=dict)
    evidence: dict = field(default_factory=dict)
    scanned: int = 0
    unknown_rows: bool = False
    unknown_omissions: bool = False
    near_bindings: dict = field(default_factory=dict)

    def take(self, values: Any):
        if not isinstance(values, list):
            self.unknown_rows = True
            self.coverage["read_state"] = "PARTIAL"
            self.coverage["limitations"].append("A required structured record list is invalid or absent.")
            return
        self.coverage["input_rows"] += len(values)
        remaining = max(0, self.source.max_rows - self.scanned)
        admitted = min(len(values), remaining)
        self.scanned += admitted
        if admitted < len(values):
            self.coverage["omitted_rows"] += len(values) - admitted
            self.coverage["truncated"] = True
            self.coverage["read_state"] = "PARTIAL"
        yield from values[:admitted]

    def add(self, key: Identity | None, evidence: Evidence | None = None):
        if key is None:
            self.coverage["rejected_rows"] += 1
            self.coverage["read_state"] = "PARTIAL"
            return
        self.identities[key] = SOURCE_BITS[self.source.id]
        if evidence is not None:
            self.evidence.setdefault(key, []).append(evidence)

    def one(self, key: Identity | None, evidence: Evidence | None = None):
        for _ in self.take([None]):
            self.add(key, evidence)


def health(batch: Batch, raw: dict, chain: int, pinned: Any, *, at: Any = None,
           hf: Any = None, hf_raw: Any = None, eligible: Any = None,
           bps: Any = None, position: dict | None = None, known: bool | None = None,
           notes: tuple[str, ...] = ()) -> Evidence:
    factor = scaled(hf_raw, 10**18) if hf_raw is not None else decimal(hf)
    valid_flag = eligible if isinstance(eligible, bool) else None
    if factor is not None and valid_flag is not None and valid_flag != (factor < 1):
        valid_flag = None
    known = (factor is not None and valid_flag is not None) if known is None else bool(known and valid_flag is not None)
    tolerance = Decimal("0.000000000000000001") if hf_raw is not None else (
        Decimal(1).scaleb(factor.as_tuple().exponent) / 2 if factor is not None else Decimal(0))
    return Evidence(batch.source.id, ops._iso(at) if at is not None else batch.at, pin(pinned, chain),
                    factor, valid_flag, decimal(bps, True), position or {}, notes=notes,
                    health_known=known, tolerance=tolerance)


def usd_position(debt: Any, collateral: Any) -> dict:
    return {"debt_amount": amount(debt), "debt_symbol": "USD", "collateral_amount": amount(collateral), "collateral_symbol": "USD"}


def raw_position(debt: Any, collateral: Any = None) -> dict:
    return {"debt_amount": amount(scaled(debt, 1)), "debt_symbol": "raw token units", "collateral_amount": amount(scaled(collateral, 1)),
            "collateral_symbol": "raw token units", "is_estimate": False}


def call_value(row: dict, key: str, index: int = 0) -> Any:
    read = obj(row.get(key))
    values = read.get("values")
    return values[index] if read.get("status") == "ok" and isinstance(values, list) and len(values) > index else None


def lists(batch: Batch, root: dict, names: tuple[str, ...]):
    found = False
    for name in names:
        if name in root:
            found = True
            yield from batch.take(root[name])
    if not found:
        yield from batch.take(None)


def containers(batch: Batch, values: Any):
    if not isinstance(values, list):
        batch.coverage["read_state"] = "INVALID"
        batch.unknown_rows = True
        return
    if len(values) > MAX_ROWS:
        batch.coverage.update(read_state="PARTIAL", truncated=True)
        batch.unknown_rows = batch.unknown_omissions = True
        batch.coverage["limitations"].append("Nested source containers exceeded the traversal cap; omitted population is unknown.")
    yield from values[:MAX_ROWS]


def _near_binding(ident: Any, row: dict, chain: Any = 1):
    if not isinstance(ident, str) or ident not in NEAR_BINDINGS or type(chain) is not int or chain != 1:
        return None
    if "chainId" in row and (type(row["chainId"]) is not int or row["chainId"] != 1):
        return None
    fields = tuple(address(row.get(field)) for field in ("spoke", "borrower", "executor"))
    if fields != NEAR_BINDINGS[ident]:
        return None
    return identity(1, "Aave V4", fields[0], fields[1]), fields[2]


def near_identities(batch: Batch, raw: dict):
    rows = list(batch.take(raw.get("actions")))
    counts = {}
    for value in rows:
        ident = obj(value).get("targetId")
        if isinstance(ident, str):
            counts[ident] = counts.get(ident, 0) + 1
    for value in rows:
        row = obj(value); ident = row.get("targetId")
        binding = _near_binding(ident, row, raw.get("chainId"))
        if binding is None or counts.get(ident) != 1 or batch.coverage["truncated"]:
            batch.add(None)
            continue
        batch.near_bindings[ident] = binding
        batch.add(binding[0])


def _near_scope(raw: dict):
    scope = {}
    for name in ("heldTargets", "armedTargetIds", "enabledTargetIds"):
        values = raw.get(name)
        if not isinstance(values, list) or len(values) > len(NEAR_BINDINGS):
            return None
        ids = [obj(value).get("targetId") if name == "heldTargets" else value for value in values]
        if any(not isinstance(ident, str) or ident not in NEAR_BINDINGS for ident in ids) or len(set(ids)) != len(ids):
            return None
        scope[name] = set(ids)
    return scope


def _near_runner(raw: dict, ident: str, executor: str, scope: dict) -> dict:
    hold = ident in scope["heldTargets"]
    mode = raw.get("mode") if raw.get("mode") in ("WATCH", "CHECK_ONLY", "BLOCKED", "EXECUTE_IF_LIQUIDATABLE") else None
    armed = False if mode == "BLOCKED" else None
    if mode != "BLOCKED" and mode is not None and isinstance(raw.get("armed"), bool) and raw.get("ok") is True:
        armed = raw["armed"] and ident in scope["armedTargetIds"] and ident in scope["enabledTargetIds"] and mode == "EXECUTE_IF_LIQUIDATABLE"
    return {"label": "Near-liquidation Aave V4", "source": NEAR_WATCH, "mode": mode, "held": hold,
            "reported_armed": False if hold else armed, "executor_address": executor}


def runner_targets(batch: Batch, raw: dict):
    source = batch.source.id
    candidates = list(batch.take(raw.get("targets")))
    id_counts, identity_counts = {}, {}
    for row in candidates:
        row = obj(row)
        ident = row.get("id")
        if isinstance(ident, str) and IDENTIFIER.fullmatch(ident):
            id_counts[ident] = id_counts.get(ident, 0) + 1
        key = identity(1, "Aave V4", row.get("spoke"), row.get("borrower"))
        identity_counts[key] = identity_counts.get(key, 0) + 1
    scope = _near_scope(raw) if source == NEAR_WATCH and not batch.coverage["truncated"] else None
    if source == NEAR_WATCH and scope is None:
        batch.coverage["read_state"] = "PARTIAL"
        batch.coverage["limitations"].append("Explicit complete armed/held scope lists are required for runner-state attribution.")
    for item in candidates:
        row = obj(item)
        key = identity(1, "Aave V4", row.get("spoke"), row.get("borrower"))
        ident = row.get("id")
        binding = _near_binding(ident, row, raw.get("chainId", 1)) if source == NEAR_WATCH else None
        if source == NEAR_WATCH and (binding is None or id_counts.get(ident) != 1 or identity_counts.get(key) != 1):
            batch.add(None)
            continue
        evidence = health(batch, row, 1, raw.get("pin"), hf_raw=row.get("healthFactorRaw"),
                          eligible=row.get("isLiquidatableBothProviders"), bps=row.get("bpsToLiquidation"))
        if raw.get("ok") is not True or ("blockNumber" in raw and raw["blockNumber"] != obj(raw.get("pin")).get("number")):
            evidence.health_known = False
            evidence.pin = {}
        if source == NEAR_WATCH:
            evidence.at = ops._iso(raw.get("checkedAt"))
            if scope is not None:
                evidence.runner = _near_runner(raw, ident, binding[1], scope)
        batch.add(key, evidence)


def _join_near_heartbeat(batches: dict, reads: dict):
    """Join only after both sources survived the final fingerprint check."""
    read = reads[NEAR_WATCH]
    fallback, batch = batches[NEAR_IDENTITIES], batches[NEAR_WATCH]
    if not read.current or batch.coverage["read_state"] not in {"OK", "PARTIAL"} or not fallback.near_bindings:
        return
    raw = obj(read.value)
    if "targets" in raw and raw["targets"] != []:
        return  # Never repair conflicting/malformed full target bindings by ID.
    scope = _near_scope(raw)
    if scope is None or ("chainId" in raw and (type(raw["chainId"]) is not int or raw["chainId"] != 1)):
        return
    for ident, (key, executor) in fallback.near_bindings.items():
        batch.add(key, Evidence(NEAR_WATCH, ops._iso(raw.get("checkedAt")), {},
                               runner=_near_runner(raw, ident, executor, scope)))
    batch.coverage.update(read_state="PARTIAL", input_rows=None, accepted_rows=len(batch.identities))
    batch.coverage["limitations"].append("Health target rows are absent; scoped heartbeat uses separately validated public identities only.")


def sentinel(batch: Batch, raw: dict):
    targets = obj(raw.get("targets"))
    groups = [(name, [targets[name]]) for name in SINGLES if name in targets]
    groups += [(name, targets[name]) for name in ARRAYS if name in targets]
    if not groups:
        batch.coverage["read_state"] = "PARTIAL"
        batch.coverage["limitations"].append("No structured sentinel targets were published.")
    for name, candidates in groups:
        for value in batch.take(candidates):
            row = _clean(value)
            b11 = name == "targetB11_Fluid_sUSDai_USDC_Vault48"
            b12 = name == "targetB12_EulerV2_wtSPYM_USDC_0x1791"
            b13 = name == "targetB13_EulerV2_wtCOIN_USDC_0x1791"
            b14 = name == "targetB14_Base_USDe_USDC_0x6efc"
            b15 = name == "targetB15_Base_yoUSD_USDC_0x5c2a"
            e7 = name == "targetE7_EulerV2_RLUSD_USDe_0x1066"
            e8 = name == "targetE8_Euler_eUSDC2_eXAUt1"
            e9 = name == "targetE9_Euler_eUSDT9_eUSDC22"
            e10 = name == "targetE10_Euler_eRLUSD7_eUSDC70"
            base = b14 or b15 or name in {"base_Morpho_Whales", "targetB0_Base_USDe_USDC", "extra_Base_USDe_Whales", "targetB11_Fluid_sUSDai_USDC_Vault48", "targetB12_EulerV2_wtSPYM_USDC_0x1791", "targetB13_EulerV2_wtCOIN_USDC_0x1791"}
            f1 = name == "targetF1_Fluid_USDe_USDT_Vault93"
            f2 = name == "targetF2_Fluid_eBTC_cbBTC_Vault96"
            f3 = name == "targetF3_Fluid_ETH_osETH_Vault159"
            f4 = name == "targetF4_Fluid_PAXG_XAUt_Vault123"
            f5 = name == "targetF5_Fluid_WBTC_LBTC_Vault115"
            f6 = name == "targetF6_Fluid_syrupUSDC_USDC_Vault145"
            m33 = name == "targetM33_Morpho_PT_reUSD_USDT"
            m35 = name == "targetM35_Morpho_PT_USD3_USDC"
            m36 = name == "targetM36_Morpho_sUSDS_USDT"
            m37 = name == "targetM37_Morpho_PST_USDT"
            m38 = name == "targetM38_Morpho_sUSDS_USDT"
            m42 = name == "targetM42_Morpho_strUSD_USDC"
            m43 = name == "targetM43_Morpho_PRIME_PYUSD"
            m44 = name == "targetM44_Morpho_srUSD_USDC"
            m45 = name == "targetM45_Morpho_reUSDe_USDC"
            m46 = name == "targetM46_Morpho_apyUSD_apxUSD"
            m47 = name == "targetM47_Morpho_USDe_RLUSD"
            m48 = name == "targetM48_Morpho_reUSD_USDT"
            m49 = name == "targetM49_Morpho_sUSDe_USDT"
            morpho = base or "morpho" in name.casefold()
            yn = name == "targetYnEthx_Curve_NavArb"
            e3 = name == "targetE3_EulerV2_WETH_ynETHx_0x831e"
            e4 = name == "targetE4_EulerV2_WETH_ynETHx_0x8062"
            a12 = name == "targetA12_AaveV4_WBTC_USDT_0xac90"
            a13 = name == "targetA13_AaveV4_wstETH_WETH_0x4cd7"
            aave_usdg_whale = name in {"targetA14_AaveV4_syrupUSDG_USDG_0xabcc", "targetA16_AaveV4_syrupUSDG_USDG_0x9cd7", "targetA18_AaveV4_syrupUSDG_USDG_0xdd64"}
            aave_weeth_whale = name in {"targetA15_AaveV4_weETH_WETH_0x3519", "targetA17_AaveV4_weETH_WETH_0xa751"}
            v3_whale = SINGLES.get(name) in V3_WHALE_BINDINGS
            spark_whale = SINGLES.get(name) in SPARK_WHALE_BINDINGS
            syrup_usdg = aave_usdg_whale or name in {
                "targetA5_AaveV4_syrupUSDG_USDG_0x080c",
                "targetA6_AaveV4_syrupUSDG_USDG_0xbd81",
                "targetA7_AaveV4_syrupUSDG_USDG_0x28e8",
                "targetA8_AaveV4_syrupUSDG_USDG_0x707e",
                "targetA9_AaveV4_syrupUSDG_USDG_0x90ff",
                "targetA10_AaveV4_syrupUSDG_USDG_0x6efc",
                "targetA12_AaveV4_WBTC_USDT_0xac90",
            }
            euler = e3 or e4 or b12 or b13 or e7 or e8 or e9 or e10 or name in {"targetE1_EulerV2_RLUSD_USDC_0xbf21", "targetE2_EulerV2_USDC_syrupUSDC_0x9f09",
                                       "targetE5_EulerV2_USDC_USDT_0xd1ed", "targetE6_EulerV2_USDT_USDC_0x079d"}
            chain = 8453 if base else 1
            protocol = "Fluid" if (f1 or f2 or f3 or f4 or f5 or f6 or b11) else "Euler" if euler else "Curve/NAV" if yn else "Morpho Blue" if morpho else "SparkLend" if spark_whale else "Aave V4" if "V4" in name else "Aave V3"
            market_record = name == "target3_Morpho_PAXG_USDC"
            venue = (row.get("spoke") or "0x973a023a77420ba610f06b3858ad991df6d85a08") if a12 else row.get("spoke") or row.get("pool")
            if a13:
                venue = row.get("spoke") or "0xe1900480ac69f0b296841cd01cc37546d92f35cd"
            elif aave_usdg_whale:
                venue = row.get("spoke") or row.get("marketId") or "0x774b9655413c34809c1f1b16b654465a89ebe989"
            elif aave_weeth_whale:
                venue = row.get("spoke") or row.get("marketId") or "0xbf10bdfe177de0336afd7fccf80a904e15386219"
            elif v3_whale:
                venue = row.get("pool") or row.get("marketId") or POOL
            elif spark_whale:
                venue = row.get("pool") or row.get("marketId") or SPARK_POOL
            key = identity(chain, protocol, row.get("marketId") if yn or euler or b11 or f4 or f5 or f6 else MORPHO if morpho or f1 or f2 or f3 else venue,
                           row.get("user"), row.get("marketId"), "market" if market_record else "position")
            pinned = obj(raw.get("baseObservation")).get("pin") if base else raw.get("pin")
            m7 = name == "targetM7_Morpho_ynETHx_msETH_Canary"
            m7b = name == "targetM7B_Morpho_ynETHx_msETH_0x9b13"
            b7 = name == "extra_Base_USDe_Whales" and row.get("rank") == "#B7"
            eligible = row.get("hfUnderwaterNow") if (m7 or m7b or yn or e3 or e4) and isinstance(row.get("hfUnderwaterNow"), bool) else row.get("liquidatableNow")
            notes = ()
            if (m7 or m7b or yn or e3 or e4) and eligible and row.get("executableNow") is not True:
                notes = ("Protocol health is underwater, but execution remains blocked by ynETHx/MCwETH withdrawal buffer capacity.",)
            elif b7:
                q_repay = decimal(obj(row.get("liveQuote")).get("repayUsdc"))
                debt_val = decimal(row.get("debtUsdc", row.get("debtUsd")))
                if q_repay is not None and debt_val is not None and q_repay > debt_val:
                    notes = ("Fixed 4,100 yoUSD quote exceeds current borrower debt/repayment shares; share-bounded cap is required.",)
            if yn:
                notes += ("Curve/NAV discount and buffer observations are not borrower liquidation health or executable arbitrage.",)
            evidence = health(batch, row, chain, pinned, hf=row.get("healthFactor"), eligible=eligible,
                              bps=row.get("bpsToLiquidation"), known=False if market_record or yn else None, notes=notes)
            # Unlike fixed single-chain runners, the multichain sentinel must
            # explicitly identify its pin's chain and supply its own UTC field.
            if raw.get("ok") is False or type(obj(pinned).get("chainId")) is not int or obj(pinned).get("chainId") != chain or ops._iso(obj(pinned).get("utc")) is None:
                evidence.pin = {}
                evidence.health_known = False
            if base:
                capture = obj(raw.get("baseObservation"))
                clean_pin = _clean(pinned)
                consistent = all(row.get(k) in (None, clean_pin.get(p)) for k, p in (("observationBlock", "number"), ("observationHash", "hash"), ("observationUtc", "utc")))
                if capture.get("status") != "COMPLETE" or not consistent:
                    evidence.pin = {}
            if row.get("observationStatus") in ("INCOMPLETE", "UNAVAILABLE"):
                evidence.health_known = False
            if evidence.pin and row.get("observationStatus") not in ("INCOMPLETE", "UNAVAILABLE"):
                evidence.position_status = _position_debt_status(SINGLES.get(name), row, _clean(pinned))
                if evidence.position_status == "CLOSED":
                    evidence.eligible = False
                    evidence.notes = (CLOSED_POSITION_NOTE,)
            symbol = "wstETH" if f3 else "WBTC" if f2 or f5 else "USDT" if f1 or f4 or m33 or m36 or m37 or m38 or m48 or m49 or e9 else "PYUSD" if m43 else "apxUSD" if m46 else "RLUSD" if e7 or e10 or m47 else "USDC" if base or f6 or m35 or m42 or m44 or m45 or e8 or name == "targetM12_Morpho_PT_USD3_USDC" or "reUSD" in name else "DAI" if "USDe_DAI" in name else "USD"
            coll_symbol = "USD" if f1 or f2 or f3 or f4 or f5 or f6 or m33 or m35 or m36 or m37 or m38 or m42 or m43 or m44 or m45 or m46 or m47 or m48 or m49 or e7 or e8 or e9 or e10 else "USDe" if symbol == "DAI" else symbol
            if name == "targetM34_Morpho_beraSTONE_WETH":
                symbol, coll_symbol = "WETH", "beraSTONE"
            evidence.position = {"debt_amount": amount(row.get("debtUsdc", row.get("debtUsd"))), "debt_symbol": symbol,
                                 "collateral_amount": amount(row.get("collateralValueUsdc", row.get("collateralUsd"))), "collateral_symbol": coll_symbol,
                                 "borrow_apr_pct": amount(row.get("borrowAprPct")), "passive_hours": amount(row.get("passiveHoursToCrossing")),
                                 "heartbeat_hours": amount(row.get("hoursUntil24hHeartbeat")), "is_estimate": base and row.get("healthIsEstimate") is not False}
            reusd_quote = "reUSD" in name or name in {
                "targetM10_Morpho_USDe_RLUSD",
                "targetM12_Morpho_PT_USD3_USDC",
                "targetM13_Morpho_PT_USD3_USDC",
                "targetM14_Morpho_PT_USDat_USDC",
                "targetM15_Morpho_yoUSD_Edge_USDC",
                "targetM16_Morpho_apyUSD_apxUSD",
                "targetM17_Morpho_eUSDe_USDe",
                "targetM18_Morpho_USD3_USDC",
                "targetM19_Morpho_USD3_USDC",
                "targetM20_Morpho_USD3_USDC",
                "targetM21_Morpho_PT_apyUSD_apxUSD",
                "targetM22_Morpho_PT_apyUSD_apxUSD",
                "targetM23_Morpho_PT_reUSD_USDC",
                "targetM24_Morpho_PT_reUSD_USDC",
                "targetM25_Morpho_USD3_USDC",
                "targetM26_Morpho_USD3_USDC",
                "targetM27_Morpho_PT_reUSD_USDC",
                "targetM28_Morpho_PT_reUSD_USDC",
                "targetM29_Morpho_PT_srUSDe_USDC",
                "targetM31_Morpho_syrupUSDC_USDC",
                "targetM32_Morpho_sUSDe_USDtb",
                "targetF1_Fluid_USDe_USDT_Vault93",
                "targetF2_Fluid_eBTC_cbBTC_Vault96",
                "targetF3_Fluid_ETH_osETH_Vault159",
                "targetF4_Fluid_PAXG_XAUt_Vault123",
                "targetF5_Fluid_WBTC_LBTC_Vault115",
                "targetF6_Fluid_syrupUSDC_USDC_Vault145",
                "targetM33_Morpho_PT_reUSD_USDT",
                "targetM34_Morpho_beraSTONE_WETH",
                "targetM35_Morpho_PT_USD3_USDC",
                "targetM36_Morpho_sUSDS_USDT",
                "targetM37_Morpho_PST_USDT",
                "targetM38_Morpho_sUSDS_USDT",
                "targetM39_Morpho_reUSD_USDC",
                "targetM42_Morpho_strUSD_USDC",
                "targetM43_Morpho_PRIME_PYUSD",
                "targetM44_Morpho_srUSD_USDC",
                "targetM45_Morpho_reUSDe_USDC",
                "targetM46_Morpho_apyUSD_apxUSD",
                "targetM47_Morpho_USDe_RLUSD",
                "targetM48_Morpho_reUSD_USDT",
                "targetM49_Morpho_sUSDe_USDT",
                "targetB11_Fluid_sUSDai_USDC_Vault48",
                "targetB12_EulerV2_wtSPYM_USDC_0x1791",
                "targetB13_EulerV2_wtCOIN_USDC_0x1791",
                "targetB14_Base_USDe_USDC_0x6efc",
                "targetB15_Base_yoUSD_USDC_0x5c2a",
                "targetE7_EulerV2_RLUSD_USDe_0x1066",
                "targetE8_Euler_eUSDC2_eXAUt1",
                "targetE9_Euler_eUSDT9_eUSDC22",
                "targetE10_Euler_eRLUSD7_eUSDC70",
            }
            kind = "wbtc-usdt" if a12 else "syrup-usdg" if syrup_usdg else "mseth" if (m7 or m7b) else "same-asset-usdc" if name == "targetA4_AaveV4_SameAsset_0xa429" else "reusd" if b11 or b12 or b13 or b14 or b15 or e7 or e8 or e9 or e10 else "observation" if base or market_record or yn or euler else "dai" if symbol == "DAI" else "reusd" if reusd_quote else "wsteth" if spark_whale or name in {"targetM11_Morpho_weETH_WETH", "targetM30_Morpho_wstETH_WETH", "targetM40_Morpho_weETH_WETH", "targetM41_Morpho_wstETH_WETH", "targetA13_AaveV4_wstETH_WETH_0x4cd7"} else "usdc" if name in {"target1_AaveV4_USDe_USDC", "targetA3_AaveV4_USDe_USDC_0x1d9c", "targetA11_AaveV4_USDe_USDC_0x5c43"} else "weth"
            evidence.quote = _quote({} if evidence.position_status == "CLOSED" else row, observation(batch.source.id, batch.at, evidence.pin, batch.now), kind)
            batch.add(key, evidence)


def arb_morpho(batch: Batch, raw: dict):
    if not arb_morpho_watch_valid(raw):
        batch.coverage["read_state"] = "INVALID"
        return
    pinned = _arb_morpho_pin(raw.get("pin"))
    consistent = raw.get("ok") is True and ("blockNumber" not in raw or raw["blockNumber"] == pinned.get("number"))
    for value in batch.take(raw["targets"]):
        row = _arb_morpho_row(value)
        if row is None:
            batch.add(None)
            continue
        position = usd_position(row.get("debtUsd"), row.get("collateralUsd"))
        position["passive_hours"] = amount(row.get("passiveHoursToCrossing"))
        fluid = row.get("rank") in {"#ARB5", "#ARB6", "#ARB7"}
        if fluid:
            position["debt_symbol"] = "USDT0"
        elif row.get("rank") in ARB_SINGLES:
            position["debt_symbol"] = "USDG"
        evidence = health(batch, row, 42161, pinned if consistent else {},
                          hf=row.get("healthFactor"), eligible=row.get("liquidatableNow"),
                          bps=row.get("bpsToLiquidation"), position=position, known=None if consistent else False)
        if row.get("rank") in ARB_SINGLES:
            evidence.quote = _arb_usdg_quote(row, observation(batch.source.id, batch.at, evidence.pin, batch.now))
        batch.add(identity(42161, "Fluid" if fluid else "Morpho Blue", row["marketId"] if fluid else ARB_MORPHO,
                           row["user"], row["marketId"], "market" if fluid else "position"), evidence)


def aave(batch: Batch, raw: dict):
    source = batch.source.id
    if source == "aave_v3_borrower_universe":
        for value in batch.take(raw.get("borrowerUniverse")):
            row = obj(value)
            batch.add(identity(raw.get("chainId"), "Aave V3", raw.get("pool"), row.get("user")))
        batch.coverage["reported_total"] = integer(raw.get("dedupedBorrowersCount"))
        if raw.get("borrowerUniverseTruncated") is True:
            batch.coverage["limitations"].append("Producer published a truncated identity preview; the separate CSV supplies the full stored index.")
        return
    if source == "aave_v3_route_distance":
        chains = raw.get("chains")
        if not isinstance(chains, list):
            batch.coverage["read_state"] = "INVALID"
            return
        for chain in containers(batch, chains):
            chain = obj(chain)
            for value in batch.take(chain.get("topRows")):
                row = obj(value)
                cid = row.get("chainId", chain.get("chainId"))
                key = identity(cid, "Aave V3", row.get("pool", chain.get("pool")), row.get("user"))
                batch.add(key, health(batch, row, cid, row.get("pin"), hf=row.get("healthFactor"), eligible=row.get("liquidatable"),
                                      bps=row.get("bpsToLiquidation"), position=usd_position(row.get("totalDebtUsd"), row.get("totalCollateralUsd"))))
        for value in lists(batch, raw, tuple(n for n in ("globalTopRows", "globalShadowRows") if n in raw)) if any(n in raw for n in ("globalTopRows", "globalShadowRows")) else ():
            row = obj(value); cid = row.get("chainId")
            batch.add(identity(cid, "Aave V3", row.get("pool"), row.get("user")),
                      health(batch, row, cid, row.get("pin"), hf=row.get("healthFactor"), eligible=row.get("liquidatable"), bps=row.get("bpsToLiquidation")))
        batch.coverage["reported_total"] = integer(obj(raw.get("summary")).get("borrowersDiscovered"))
        return
    if source in {"aave_v4_spoke_borrowers", "aave_v4"}:
        root = obj(raw.get("latest")) if source == "aave_v4" else raw
        chain = obj(root.get("chain")); cid = chain.get("id")
        groups = []
        if source == "aave_v4_spoke_borrowers":
            spokes = raw.get("spokes")
            if not isinstance(spokes, list):
                batch.coverage["read_state"] = "INVALID"
                return
            groups = [(obj(s).get("spoke"), obj(s).get("topUsers")) for s in containers(batch, spokes)]
            groups += [(None, raw[n]) for n in ("topUsers", "watchCandidates") if n in raw]
        else:
            groups = [(None, root[n]) for n in ("topRows", "closestRows", "profitRankedRows", "triggerRows", "materialTriggerRows", "quoteRequiredRows") if n in root]
        if not groups:
            batch.coverage["read_state"] = "INVALID"
        for spoke, values in groups:
            for value in batch.take(values):
                row = obj(value); account = obj(row.get("account"))
                key = identity(cid, "Aave V4", row.get("spoke", spoke), row.get("user"))
                batch.add(key, health(batch, row, cid, chain, at=root.get("sourceGeneratedAt", root.get("generatedAt", batch.at)),
                                      hf_raw=account.get("healthFactorRaw"), hf=account.get("healthFactor", row.get("healthFactor")),
                                      eligible=row.get("liquidatable"), bps=row.get("bpsToLiquidation"),
                                      position=usd_position(row.get("debtUsd"), row.get("collateralUsd"))))
        batch.coverage["reported_total"] = integer(obj(root.get("summary")).get("usersDiscovered"))
        return
    # Singleton stored readiness/quote records. Never invent a hash from a block number.
    top, live = obj(raw.get("topRow")), obj(raw.get("live"))
    cid = raw.get("chainId", next((c for c, label in CHAINS.items() if label == top.get("chain")), None))
    borrower = raw.get("borrower", top.get("borrower", live.get("borrower")))
    venue = raw.get("pool", top.get("pool"))
    account = obj(raw.get("liveAccountData")) or obj(live.get("account"))
    hf_raw = account.get("healthFactor") if "liveAccountData" in raw else None
    factor = scaled(hf_raw, 10**18) if hf_raw is not None else decimal(account.get("healthFactor", top.get("healthFactor")))
    batch.one(identity(cid, "Aave V3", venue, borrower), health(batch, account, cid, raw.get("pin"),
              hf_raw=hf_raw, hf=account.get("healthFactor", top.get("healthFactor")), eligible=factor < 1 if factor is not None else None,
              bps=account.get("bpsToLiquidation", top.get("bpsToLiquidation")),
              position=usd_position(account.get("totalDebtUsd"), account.get("totalCollateralUsd"))))


def compound(batch: Batch, raw: dict):
    scope = obj(raw.get("identity")); cid, venue = scope.get("chainId"), scope.get("market")
    scale = decimal(obj(raw.get("marketState")).get("baseScaleRaw"))
    for name, values in (("discovery", obj(raw.get("discovery")).get("candidates")), ("screened", raw.get("screenedBorrowers"))):
        for value in batch.take(values):
            row = obj(value)
            scope_matches = row.get("chainId", cid) == cid and row.get("market", venue) == venue
            key = identity(cid, "Compound V3", venue, row.get("user")) if scope_matches else None
            debt = decimal(row.get("debtRaw")); zero = debt == 0 if debt is not None else False
            evidence = health(batch, row, cid, raw.get("pin"), hf_raw=row.get("hfWad"), hf=row.get("hf"),
                              eligible=False if zero else row.get("protocolLiquidatableAtPin"),
                              known=zero or (name == "screened" and row.get("status") == "COMPLETE" and row.get("protocolFlagMatchesHf") is not False),
                              position=usd_position(row.get("debtUsd"), row.get("collateralUsd")))
            if not evidence.position["debt_amount"]:
                evidence.position = raw_position(row.get("debtRaw"))
                if debt is not None and scale is not None and scale > 0:
                    with localcontext() as ctx:
                        ctx.prec = 160
                        evidence.position.update(debt_amount=amount(debt / scale), debt_symbol="base token units")
            if zero:
                evidence.notes = ("Zero debt was explicitly read at this source pin; not an assumption about undiscovered accounts.",)
            if obj(raw.get("pin")).get("valid") is False or row.get("status") not in ("COMPLETE", None):
                evidence.health_known = False
            batch.add(key, evidence)
    batch.coverage["reported_total"] = integer(obj(raw.get("discovery")).get("candidateCount"))


def current_screen(batch: Batch, raw: dict):
    cid = raw.get("chainId"); protocols = obj(raw.get("protocols"))
    if type(cid) is not int or cid != 1:
        batch.coverage["read_state"] = "INVALID"
        batch.unknown_rows = True
        return
    euler, silo = obj(protocols.get("euler")), obj(protocols.get("silo"))
    for value in batch.take(euler.get("vaults")):
        row = obj(value)
        batch.add(identity(cid, "Euler", row.get("vault"), kind="market"),
                  health(batch, row, cid, raw.get("pin"), position=raw_position(call_value(row, "totalBorrows")), known=False))
    for value in batch.take(euler.get("accounts")):
        row = obj(value); debt = decimal(call_value(row, "debt")); liquidity = obj(row.get("liquidity"))
        legs = row.get("liquidations")
        positive = isinstance(legs, list) and any(obj(leg).get("positiveCapacity") is True and obj(obj(leg).get("read")).get("status") == "ok" for leg in legs[:16])
        known = row.get("complete") is True and debt is not None and (debt == 0 or liquidity.get("status") == "ok")
        evidence = health(batch, row, cid, raw.get("pin"), eligible=positive if known else None, known=known,
                          position=raw_position(call_value(row, "debt")),
                          notes=("Liquidation legs are capacity observations only, not liquid exits or executable profit.",))
        if row.get("collateralsTruncated") is True:
            evidence.health_known = False
        batch.add(identity(cid, "Euler", row.get("vault"), row.get("account")), evidence)
    for value in batch.take(silo.get("accounts")):
        row = obj(value); mapping = row.get("debtSiloMapping")
        venue = address(row.get("resolvedDebtSilo"))
        if venue is None and mapping in ("VERIFIED", "NO_DEBT_ZERO_CONFIG"):
            venue = row.get("debtSilo")
        solvent = row.get("protocolSolvent")
        known = row.get("complete") is True and mapping in ("VERIFIED", "NO_DEBT_ZERO_CONFIG") and isinstance(solvent, bool)
        evidence = health(batch, row, cid, raw.get("pin"), eligible=not solvent if isinstance(solvent, bool) else None,
                          known=known, position={**raw_position(row.get("maxRepayRaw")),
                          "ltv_raw": amount(row.get("currentLtvRaw")), "lt_raw": amount(row.get("currentLtRaw"))},
                          notes=("Protocol solvency is reported directly; raw LTV/LT values are not a guessed floating threshold.",))
        batch.add(identity(cid, "Silo", venue, row.get("account")), evidence)


def euler(batch: Batch, raw: dict):
    cid = raw.get("chainId", 1)
    if batch.source.id == "euler_l_valuation":
        for value in batch.take(raw.get("rows")):
            row = obj(value)
            batch.add(identity(cid, "Euler", row.get("vault"), row.get("violator")))
        return
    for value in batch.take(raw.get("vaults")):
        row = obj(value); vault = row.get("vault")
        batch.add(identity(cid, "Euler", vault, kind="market"))
        field_name = "violatorChecks" if batch.source.id == "euler_l_watch" else "topLiquidateEvents"
        for check in batch.take(row.get(field_name, [])):
            check = obj(check)
            batch.add(identity(cid, "Euler", vault, check.get("violator")))
    if "topLiquidateEvents" in raw:
        for value in batch.take(raw["topLiquidateEvents"]):
            row = obj(value)
            batch.add(identity(cid, "Euler", row.get("vault"), row.get("violator")))


def silo(batch: Batch, raw: dict):
    if batch.source.id == "silo_l_surface":
        chains = raw.get("chains")
        if not isinstance(chains, list):
            batch.coverage["read_state"] = "INVALID"
            return
        for item in containers(batch, chains):
            chain = obj(item); cid = chain.get("chainId")
            for value in batch.take(chain.get("markets")):
                market = obj(value)
                batch.add(identity(cid, "Silo", market.get("config"), kind="market"))
                for value in batch.take(obj(market.get("nearLt")).get("accounts", [])):
                    row = obj(value)
                    # Saved band strings are not current protocol solvency evidence.
                    batch.add(identity(cid, "Silo", row.get("silo"), row.get("account")))
        batch.coverage["reported_total"] = integer(obj(raw.get("totals")).get("marketsSurfaced"))
    else:
        for value in batch.take(raw.get("rows" if batch.source.id == "silo_l_economics" else "trackedAccounts")):
            row = obj(value)
            batch.add(identity(row.get("chainId"), "Silo", row.get("debtSilo", row.get("silo")), row.get("borrower", row.get("account"))))


def morpho(batch: Batch, raw: dict):
    cid = raw.get("chainId")
    groups = [raw.get("rows")]
    if "candidates" in obj(raw.get("valuation")):
        groups.append(raw["valuation"]["candidates"])
    for values in groups:
        for value in batch.take(values):
            row = obj(value)
            batch.add(identity(cid, "Morpho Blue", MORPHO, row.get("borrower"), row.get("marketId")),
                      health(batch, row, cid, raw.get("pin"), position=raw_position(row.get("fullDebtRaw")), known=False,
                             notes=("Stored candidate amounts have unscaled loan-token units; event/valuation outputs are not current profit quotes.",)))


def coverage_only(batch: Batch, raw: dict):
    source = batch.source.id
    if source == "research_watch":
        entries = raw.get("entries")
        if not isinstance(entries, list):
            batch.coverage["read_state"] = "INVALID"
        else:
            batch.coverage.update(input_rows=len(entries), reported_total=len(entries))
        return
    if source == "aave_v3_liquidation_watch":
        batch.coverage["reported_total"] = integer(obj(raw.get("latest")).get("watchCandidates"))
        return
    if source == "morpho_ws_status":
        for value in batch.take(raw.get("recent")):
            row = obj(value)
            batch.add(identity(row.get("chainId"), "Morpho Blue", MORPHO, row.get("borrower"), row.get("marketId")))
        batch.coverage["reported_total"] = integer(raw.get("cachedBorrowers"))
    elif source == "state":
        conditions = obj(raw.get("conditions"))
        result = obj(obj(conditions.get("aave-v3-hf-watch")).get("lastResult"))
        for value in batch.take(result.get("results", [])):
            row = obj(value); cid = row.get("chainId")
            batch.add(identity(cid, "Aave V3", row.get("pool"), row.get("user", row.get("borrower"))))
        for name, proto, field_name in (("euler-vault-donation-watch", "Euler", "newVaults"), ("silo-oracle-watch", "Silo", "results")):
            records = obj(obj(conditions.get(name)).get("lastResult")).get(field_name)
            if isinstance(records, list):
                for value in batch.take(records):
                    row = obj(value)
                    if row.get("vault") or row.get("silo") or row.get("config"):
                        batch.add(identity(row.get("chainId"), proto, row.get("vault") or row.get("silo") or row.get("config"), kind="market"))
            elif records is not None and not isinstance(records, (int, dict)):
                batch.coverage["read_state"] = "PARTIAL"
        batch.coverage["reported_total"] = len(conditions)
    elif source == "venus_psr":
        for value in obj(raw.get("chains")).values():
            chain = obj(value)
            for market in batch.take(obj(chain.get("current")).get("markets", [])):
                row = obj(market)
                batch.add(identity(chain.get("chainId"), "Venus", row.get("vToken", row.get("market")), kind="market"))


def adapt(source: Source, read: Any, now: float) -> Batch:
    state = read.read_state if read.read_state in STATES else "UNAVAILABLE"
    current = read.current is True and state in {"OK", "PARTIAL"}
    raw = obj(read.value) if current and source.kind == "json" else {}
    # Identity documents have no observation date, regardless of approval metadata.
    at = None if source.id == NEAR_IDENTITIES else read.generated_at if source.kind == "index" and current else source_date(raw)
    if source.id == NEAR_WATCH:
        at = ops._iso(raw.get("checkedAt"))
    fresh, age = ops._freshness_view(at, now)
    coverage = {"id": source.id, "label": source.label, "read_state": state if current or state not in {"OK", "PARTIAL"} else "UNAVAILABLE",
                "freshness": fresh, "age_text": ops._age_text(age), "input_rows": 0 if current else None,
                "accepted_rows": 0 if current else None, "rejected_rows": 0 if current else None,
                "omitted_rows": 0 if current else None, "truncated": False, "reported_total": None,
                "limitations": [f"Fixed input bound: {source.max_bytes} bytes / {source.max_rows} candidate records.", source.note]}
    batch = Batch(source, coverage, at, now)
    if not current:
        return batch
    if source.kind == "index":
        for name in ("input_rows", "accepted_rows", "rejected_rows", "omitted_rows", "truncated"):
            coverage[name] = getattr(read, name)
        return batch
    if not isinstance(read.value, dict):
        coverage["read_state"] = "INVALID"
        return batch
    try:
        _adapt_json(batch, raw)
    except (TypeError, ValueError, KeyError, AttributeError, OverflowError, InvalidOperation):
        # One malformed source cannot take down unrelated admitted sources. No raw
        # exception, source prose or partial pre-error evidence is projected.
        batch.identities.clear()
        batch.evidence.clear()
        batch.near_bindings.clear()
        batch.unknown_rows = batch.unknown_omissions = True
        coverage["read_state"] = "INVALID"
        coverage["limitations"].append("Structured source shape is invalid; its contribution was excluded.")
    if coverage["read_state"] == "INVALID":
        batch.identities.clear()
        batch.evidence.clear()
        batch.near_bindings.clear()
        batch.unknown_rows = batch.unknown_omissions = True
        coverage["rejected_rows"] = None
    coverage["accepted_rows"] = len(batch.identities)
    if batch.unknown_rows:
        coverage["input_rows"] = None
    if batch.unknown_omissions:
        coverage["omitted_rows"] = None
    coverage["limitations"] = list(dict.fromkeys(coverage["limitations"]))
    return batch


def _adapt_json(batch: Batch, raw: dict):
    key = batch.source.id
    if key == SENTINEL:
        sentinel(batch, raw)
    elif key == ARB_WATCH:
        arb_morpho(batch, raw)
    elif key == BASE_WATCH:
        if not _base_watch(raw):
            batch.coverage["read_state"] = "INVALID"
        else:
            batch.coverage["input_rows"] = len(raw["targets"])
    elif key == NEAR_IDENTITIES:
        near_identities(batch, raw)
    elif key in {V4_WATCH, "aave_v4_near_watch"}:
        runner_targets(batch, raw)
    elif key in {"aave_v3_borrower_universe", "aave_v3_route_distance", "aave_v3_trigger_readiness", "aave_v3_liquidation_exact_quotes", "aave_v3_liquidation_trigger_quotes", "aave_v4", "aave_v4_spoke_borrowers"}:
        aave(batch, raw)
    elif key == "compound_v3_base_watch":
        compound(batch, raw)
    elif key == "euler_silo_current_screen":
        current_screen(batch, raw)
    elif key in {"euler_l_surface", "euler_l_watch", "euler_l_valuation"}:
        euler(batch, raw)
    elif key in {"silo_l_surface", "silo_l_economics", "silo_default_watch_status"}:
        silo(batch, raw)
    elif key in {"morpho_blue_liquidatable", "morpho_blue_liquidatable_base"}:
        morpho(batch, raw)
    else:
        coverage_only(batch, raw)


def _exclude(read: Any) -> Any:
    if hasattr(read, "entries"):
        return replace(read, entries=(), current=False, read_state="UNAVAILABLE", input_rows=None,
                       accepted_rows=0, rejected_rows=0, omitted_rows=None, truncated=False)
    return replace(read, value=None, current=False, read_state="UNAVAILABLE")


def _read(reader: Any, source: Source) -> Any:
    return reader.read_target_index(source.id) if source.kind == "index" else reader.read_target_json(source.id)


def _capture(reader: Any, sources=SOURCES) -> dict:
    reads = {s.id: _read(reader, s) for s in sources}
    # One bounded retry per changed input. No stale cached contribution survives.
    for source in sources:
        read = reads[source.id]
        if read.current and (read.fingerprint is None or reader.target_fingerprint(source.id) != read.fingerprint):
            read = _read(reader, source)
            if read.current and (read.fingerprint is None or reader.target_fingerprint(source.id) != read.fingerprint):
                read = _exclude(read)
            reads[source.id] = read
    return reads


class _CuratedSnapshot:
    """Feed the unchanged legacy subprojection from this request's admitted snapshot."""

    def __init__(self, reads: dict):
        self.reads = reads

    def read_json(self, key: str, validator=None) -> JsonRead:
        if key not in READS:
            raise KeyError(key)
        read = self.reads[key]
        current = read.current is True and read.read_state in {"OK", "PARTIAL"} and isinstance(read.value, dict)
        value = read.value if current else None
        if current and validator is not None:
            try:
                current = validator(value) is True
            except (TypeError, ValueError, KeyError, AttributeError, OverflowError):
                current = False
        return JsonRead(value if current else None, current, read.read_state != "MISSING", current, False)


def _generation(reader: Any, reads: dict) -> Generation:
    specs = [s for s in SOURCES if s.kind == "index"]
    version = tuple((s.id, reads[s.id].current, reads[s.id].read_state, reads[s.id].fingerprint,
                     reads[s.id].accepted_rows, reads[s.id].rejected_rows, reads[s.id].omitted_rows) for s in specs)
    with _GENERATION_LOCK:
        cached = _GENERATIONS.get(reader)
        if cached is not None and cached.version == version:
            return cached
        masks = {}
        for source in specs:
            read = reads[source.id]
            if not read.current or read.read_state not in {"OK", "PARTIAL"}:
                continue
            # The fixed reader API has already validated/canonicalized these tuples.
            for entry in read.entries:
                chain, protocol, venue, borrower, market = entry
                key = ("position", chain, protocol, venue, borrower, market)
                masks[key] = masks.get(key, 0) | SOURCE_BITS[source.id]
        by_identity = {key: descriptor(key, mask) for key, mask in masks.items()}
        generation = Generation(version, tuple(sorted(by_identity.values(), key=lambda d: d.digest)), MappingProxyType(by_identity))
        _GENERATIONS[reader] = generation  # only the current generation is retained
        return generation


def _curated_key(row: dict) -> Identity | None:
    protocol = row.get("protocol")
    if row.get("chain_id") == 8453 and protocol == "Morpho Blue (Base)":
        protocol = "Morpho Blue"  # Fixed curated adapter alias; chain remains part of identity.
    if row.get("chain_id") == 42161 and protocol == "Morpho Blue (Arbitrum)":
        protocol = "Morpho Blue"
    if protocol in {"Euler V2", "Euler V2 (Base)"}:
        protocol = "Euler"  # Preserve the canonical vault/account join with stored Euler sources.
    if protocol == "Aave V4 (Spoke C)":
        protocol = "Aave V4"  # Keep the display alias joined to its spoke/borrower identity.
    return identity(row.get("chain_id"), protocol, row.get("venue_address"), row.get("borrower_address"),
                    row.get("market_id"), "market" if row.get("id") in {SINGLES["target3_Morpho_PAXG_USDC"], ARB_FLUID_ID, ARB_FLUID_54_ID, ARB_FLUID_42_ID} else "position")


def _attribute_unified_runner(batches: dict, reads: dict, curated: dict):
    for source in (V3_WATCH, BASE_WATCH):
        batch = batches[source]
        if not reads[source].current or batch.coverage["read_state"] not in {"OK", "PARTIAL"}:
            continue
        raw = _base_watch(reads[source].value) if source == BASE_WATCH else _clean(reads[source].value)
        pinned = pin(raw.get("pin"), 8453) if source == BASE_WATCH else pin(_runner_pin(raw.get("pin"), source), 1)
        for row in curated["targets"]:
            # Marker follows full identity/executor/scope checks, never labels
            # or candidate counts. Only existing curated positions are enriched.
            if row["runner"].get("source") == source:
                key = _curated_key(row)
                if key is not None:
                    batch.one(key, Evidence(source, row["runner"].get("checked_at"), pinned))
        batch.coverage["accepted_rows"] = len(batch.identities)


@dataclass
class Resolved:
    status: str
    protocol_status: str
    observation: dict
    evidence: Evidence | None
    runner: dict
    quote: dict | None
    blockers: list
    observation_only: bool


def _empty_runner() -> dict:
    return {"label": None, "mode": None, "freshness": UNKNOWN, "age_text": None, "checked_at": None,
            "reported_armed": None, "held": None, "notes": ["Observation only; no execution runner is assigned."]}


def _resolve(key: Identity, bundles: list[Evidence], curated: dict | None, now: float) -> Resolved:
    observations = [(bundle, observation(bundle.source, bundle.at, bundle.pin, now)) for bundle in bundles if bundle.source not in {V3_WATCH, BASE_WATCH}]
    if curated and (curated.get("id") in {SINGLES["targetA13_AaveV4_wstETH_WETH_0x4cd7"], SINGLES["target1_AaveV4_USDe_USDC"]}
                    or str(curated.get("id", "")).startswith("spoke-c-")):
        sentinel_health = [(bundle, obs) for bundle, obs in observations
                           if bundle.source == SENTINEL and bundle.health_known
                           and bundle.hf is not None and obs["freshness"] == FRESH]
        # Float HF and the runner's 18-decimal HF can differ slightly by
        # representation. Prefer the complete sentinel bundle for this duplicate;
        # retain all original bundles below for provenance and runner/hold evidence.
        with localcontext() as ctx:
            ctx.prec = 160
            observations = [(bundle, obs) for bundle, obs in observations if not (
                bundle.source in {NEAR_WATCH, V4_WATCH} and bundle.health_known and bundle.hf is not None
                and obs["freshness"] != UNKNOWN and not bundle.position and bundle.quote is None
                and any(obs["block"] == sentinel_obs["block"] and obs["hash"] == sentinel_obs["hash"]
                        and bundle.eligible == sentinel_bundle.eligible
                        and abs(bundle.hf - sentinel_bundle.hf) <= (Decimal("1e-9") if bundle.source == NEAR_WATCH else Decimal("1e-3"))
                        for sentinel_bundle, sentinel_obs in sentinel_health))]
    # An identity-only/unpinned/stale source cannot displace fresh measured health.
    def priority(item):
        bundle, obs = item
        valid = (bundle.health_known or bundle.position_status is not None) and obs["freshness"] != UNKNOWN
        return (valid and obs["freshness"] == FRESH, valid, bool(bundle.pin),
                obs["block"] or -1, timestamp(bundle.at) or 0, bundle.source)
    selected, observed = max(observations, key=priority) if observations else (None, observation("", None, {}, now))
    conflict = False
    if selected and (selected.health_known or selected.position_status is not None) and observed["freshness"] != UNKNOWN:
        for other, other_obs in observations:
            if not (other.health_known or other.position_status is not None) or other_obs["freshness"] == UNKNOWN or other_obs["block"] != observed["block"]:
                continue
            if other.position_status is not None and selected.position_status is not None and other.position_status != selected.position_status:
                conflict = True
            if other_obs["hash"] != observed["hash"] or other.eligible != selected.eligible:
                conflict = True
            with localcontext() as ctx:
                ctx.prec = 160
                if other.hf is not None and selected.hf is not None and abs(other.hf - selected.hf) > other.tolerance + selected.tolerance:
                    conflict = True
            for field_name in ("ltv_raw", "lt_raw"):
                left, right = other.position.get(field_name), selected.position.get(field_name)
                if left is not None and right is not None and left != right:
                    conflict = True
    closed = selected is not None and selected.position_status == "CLOSED" and observed["freshness"] != UNKNOWN and not conflict
    known = selected is not None and (selected.health_known or closed) and observed["freshness"] != UNKNOWN and not conflict
    protocol_status = "UNKNOWN" if not known else "STALE" if observed["freshness"] != FRESH else "INACTIVE" if closed else "ELIGIBLE" if selected.eligible else "WATCH"
    runner = {**curated["runner"], "held": None} if curated else _empty_runner()
    runners = [(b, b.runner) for b in bundles if b.runner is not None]
    if runners:
        bundle, reported = max(runners, key=lambda item: timestamp(item[0].at) or 0)
        fresh, age = ops._freshness_view(bundle.at, now)
        if not runner.get("checked_at") or (timestamp(bundle.at) or 0) >= (timestamp(runner["checked_at"]) or 0):
            runner = {**reported, "freshness": fresh, "age_text": ops._age_text(age), "checked_at": bundle.at,
                      "reported_armed": reported["reported_armed"] if fresh == FRESH else None,
                      "notes": ["Reported scoped telemetry only; not authorization or executable profitability."]}
            if runner["reported_armed"] is True and observation(bundle.source, bundle.at, bundle.pin, now)["freshness"] != FRESH:
                runner["reported_armed"] = None
    fresh_holds = [(b, report) for b, report in runners if report.get("held") is True and ops._freshness_view(b.at, now)[0] == FRESH]
    if fresh_holds:
        bundle, reported = max(fresh_holds, key=lambda item: timestamp(item[0].at) or 0)
        _, age = ops._freshness_view(bundle.at, now)
        runner = {**reported, "held": True, "reported_armed": False, "freshness": FRESH,
                  "age_text": ops._age_text(age), "checked_at": bundle.at,
                  "notes": ["A fresh identity-scoped hold takes precedence over another runner's newer armed report."]}
    observation_only = bool(curated.get("observation_only")) if curated else runner.get("label") is None
    status = protocol_status
    if (key[0] == "market" and not (curated and curated.get("id") in {ARB_FLUID_ID, ARB_FLUID_54_ID, ARB_FLUID_42_ID})) or (curated and curated.get("observation_only")):
        status = "OBSERVATION_ONLY"
    if runner.get("held") is True and runner.get("freshness") == FRESH:
        status = "HELD"
        runner["reported_armed"] = False
    if protocol_status == "INACTIVE":
        status = "INACTIVE"  # Fresh raw-zero debt overrides historical readiness/holds.
        runner["reported_armed"] = False
    blockers = list(selected.notes) if selected else []
    if curated and curated.get("observation_only") and curated.get("readiness_note"):
        blockers.append(curated["readiness_note"])
    if conflict:
        observed = {**observed, "freshness": UNKNOWN}
        blockers.append("Conflicting health or block hashes at the same height; protocol status is unknown.")
    if not known:
        blockers.append("No compatible complete hash-pinned health evidence; indexed identities are not proof of active debt or solvency.")
    elif observed["freshness"] != FRESH:
        blockers.append("Stored health is aged; current eligibility is not established.")
    if runner.get("held"):
        blockers.append("A scoped runner hold is reported." if runner.get("freshness") == FRESH else "The stored runner hold is aged; current execution state is unknown.")
    if runner.get("reason_text"):
        blockers.append(runner["reason_text"])
    blockers.append("Stored observations do not establish chain-wide coverage, authorization, a liquid exit, or conservative profit.")
    quote = curated.get("quote") if curated else None
    if quote is None:
        quotes = [b for b in bundles if b.quote is not None]
        if quotes:
            quote = max(quotes, key=lambda b: timestamp(b.at) or 0).quote
    if closed:
        quote = _empty_quote()
        quote["notes"] = [CLOSED_POSITION_NOTE]
    return Resolved(status, protocol_status, observed, selected, runner, quote, blockers, observation_only)


def _options(sources=SOURCES, identities=None) -> dict:
    labels = {"passive_time": "Passive time: soonest", "curated": "Curated first", "distance-asc": "Distance: low to high", "distance-desc": "Distance: high to low",
              "gross-asc": "Gross USD: low to high", "gross-desc": "Gross USD: high to low", "chain": "Chain", "protocol": "Protocol", "status": "Status"}
    return {"chains": [{"value": v, "label": v} for cid, v in CHAINS.items() if identities is None or any(k[1] == cid for k in identities)],
            "protocols": [{"value": v, "label": v} for v in PROTOCOLS if identities is None or any(k[2] == v for k in identities)],
            "sources": [{"value": s.id, "label": s.label} for s in sources],
            "statuses": [{"value": v, "label": v.replace("_", " ").title()} for v in STATUSES],
            "sorts": [{"value": v, "label": labels[v]} for v in SORTS]}


def normalize_query(query: Any, sources=SOURCES, *, trade_candidates: bool = False) -> tuple[dict, list]:
    query = query or {}
    normalized = {"q": "", "chain": "", "protocol": "", "source": "", "status": "", "sort": "passive_time" if trade_candidates else "curated", "page": 1, "page_size": 50}
    warnings = []
    choices = {"chain": set(CHAINS.values()), "protocol": set(PROTOCOLS), "source": {s.id for s in sources}, "status": set(STATUSES), "sort": set(SORTS)}
    for key in normalized:
        values = query.getlist(key) if hasattr(query, "getlist") else ([query[key]] if key in query else [])
        if not values:
            continue
        if len(values) > 1:
            warnings.append({"parameter": key, "code": "FIRST_VALUE_USED"})
        value = values[0]
        if not isinstance(value, str):
            warnings.append({"parameter": key, "code": "DEFAULTED"})
            continue
        if key == "q":
            value = " ".join(value.split())
            if len(value) > 128:
                value = value[:128]
                warnings.append({"parameter": key, "code": "TRUNCATED"})
            normalized[key] = value
        elif key in {"page", "page_size"}:
            if re.fullmatch(r"[1-9][0-9]{0,8}", value) is None:
                warnings.append({"parameter": key, "code": "DEFAULTED"})
            else:
                parsed = int(value)
                if key == "page_size" and parsed > 200:
                    parsed = 200
                    warnings.append({"parameter": key, "code": "CLAMPED"})
                normalized[key] = parsed
        elif value in choices[key] or (value == "" and key != "sort"):
            normalized[key] = value
        else:
            warnings.append({"parameter": key, "code": "DEFAULTED"})
    return normalized, warnings


def _empty_quote() -> dict:
    return {"available": False, "gross_token_amount": None, "gross_token_symbol": None, "gross_usd": None,
            "repay_amount": None, "repay_symbol": None, "seize_amount": None, "seize_symbol": None,
            "freshness": UNKNOWN, "age_text": None, "block": None, "hash": None, "utc": None, "source": None,
            "notes": ["No compatible live quote; historical events and market liquidity are not profit."]}


def _project(desc: Descriptor, mask: int, resolved: Resolved | None, curated: dict | None, batches: dict, now: float) -> dict:
    key = desc.identity
    kind, chain, protocol, venue, borrower, market = key
    if resolved is None:
        resolved = _resolve(key, [], curated, now)
    row = dict(curated) if curated else {}
    quote = resolved.quote or _empty_quote()
    measured = resolved.evidence
    position = {"debt_amount": None, "debt_symbol": None, "collateral_amount": None, "collateral_symbol": None,
                "borrow_apr_pct": None, "passive_hours": None, "heartbeat_hours": None, "is_estimate": False}
    if measured:
        position.update(measured.position)
    source_ids = [s.id for s in SOURCES if mask & SOURCE_BITS[s.id]]
    provenance = []
    for source in source_ids:
        batch = batches[source]
        candidates = batch.evidence.get(key, [])
        evidence = max(candidates, key=lambda e: timestamp(e.at) or 0) if candidates else None
        at = evidence.at if evidence else batch.at
        fresh, age = ops._freshness_view(at, now)
        pinned = evidence.pin if evidence else {}
        age_text = ops._age_text(age)
        if source in {V3_WATCH, BASE_WATCH}:
            runner_observation = observation(source, at, pinned, now)
            fresh, age_text = runner_observation["freshness"], runner_observation["age_text"]
        provenance.append({"source": source, "generated_at": at, "freshness": fresh, "age_text": age_text,
                           "block": pinned.get("block"), "hash": pinned.get("hash"), "utc": pinned.get("utc")})
    labels = {"HELD": "Held", "ELIGIBLE": "Protocol eligible", "WATCH": "Watching", "INACTIVE": "Inactive / closed", "OBSERVATION_ONLY": "Observation only", "STALE": "Stale observation", "UNKNOWN": "Health unknown"}
    code = resolved.status
    bps = measured.bps if measured else None
    if resolved.protocol_status == "UNKNOWN":
        bps = None
    # Exact decimal strings are used for presentation/sort; no float overflow or raw scaling guess.
    row.update(position_key=desc.digest.hex(), record_type=kind, source_ids=source_ids, provenance=provenance,
               id=row.get("id", desc.digest.hex()), chain_id=chain, chain_name=CHAINS[chain], protocol=protocol,
               borrower_address=borrower, venue_address=venue, market_id=market,
               user_short=ops._short_address(borrower), rank=row.get("rank"), pair=row.get("pair"),
               label=row.get("label") or f"{protocol} {'market / vault' if kind == 'market' else 'stored account'}",
               protocol_status=resolved.protocol_status, status={"code": code, "label": labels[code], "tone": "positive" if code == "ELIGIBLE" else "warning" if code in {"HELD", "STALE", "UNKNOWN"} else "neutral"},
               observation=resolved.observation, quote=quote, position=position, runner=resolved.runner,
               blockers=resolved.blockers, observation_only=resolved.observation_only,
               health_factor=amount(measured.hf) if measured and resolved.protocol_status != "UNKNOWN" else None,
               health_is_estimate=position["is_estimate"], bps_numeric=amount(bps, True), bps_to_liq=amount(bps, True),
               gross_usd_numeric=amount(quote.get("gross_usd"), True), liquidatable_now=measured.eligible if measured and resolved.protocol_status in {"ELIGIBLE", "WATCH"} else None,
               observation_block=resolved.observation["block"], observation_utc=resolved.observation["utc"],
               executor_address=resolved.runner.get("executor_address", row.get("executor_address")),
               executable_now=False, calldata_ready=row.get("calldata_ready", False),
               readiness_note=row.get("readiness_note") or "Read-only stored observation; no execution readiness inferred.")
    row.setdefault("executor", ops._short_address(row["executor_address"]))
    if resolved.protocol_status == "INACTIVE":
        row.update(inactive=True, position_status="CLOSED", armed=False, executable_now=False, liquidatable_now=False,
                   calldata_ready=False, readiness_note=CLOSED_POSITION_NOTE, surplus_usd=None, repay_summary=None, seized_summary=None)
    else:
        row.update(inactive=False, position_status=measured.position_status if measured else None)
        if curated and curated.get("inactive") and (not measured or measured.position_status != "CLOSED"):
            row["readiness_note"] = "Read-only stored observation; current execution readiness is not established."
    for field_name in ("passive_hours_left", "heartbeat_hours_left", "repay_summary", "seized_summary", "surplus_usd"):
        row.setdefault(field_name, None)
    return row


def aggregate_targets(reader: Any, now: float, query: Any = None, *, trade_candidates: bool = False) -> dict:
    """Internal inventory remains available; public callers fix shortlist mode."""
    sources = TRADE_SOURCES if trade_candidates else SOURCES
    reads = _capture(reader, sources)
    batches = {source.id: adapt(source, reads[source.id], now) for source in sources}
    curated = build_curated_targets(_CuratedSnapshot(reads), now)
    # Final version-vector check after adapters/panels. Unstable sources are excluded,
    # rather than keeping an old merged generation or retrying indefinitely.
    changed = []
    for source in sources:
        read = reads[source.id]
        if read.current and reader.target_fingerprint(source.id) != read.fingerprint:
            reads[source.id] = _exclude(read)
            batches[source.id] = adapt(source, reads[source.id], now)
            batches[source.id].coverage["limitations"].append("Input changed during this request; its contribution was excluded.")
            changed.append(source.id)
    if changed:
        curated = build_curated_targets(_CuratedSnapshot(reads), now)
    _join_near_heartbeat(batches, reads)
    _attribute_unified_runner(batches, reads, curated)
    generation = Generation((), (), {}) if trade_candidates else _generation(reader, reads)
    masks, evidence = {}, {}
    for batch in batches.values():
        for key, mask in batch.identities.items():
            masks[key] = masks.get(key, 0) | mask
        for key, bundles in batch.evidence.items():
            evidence.setdefault(key, []).extend(bundles)
    curated_rows, order = {}, {}
    for row in curated["targets"]:
        key = _curated_key(row)
        if key is not None and key in masks and key not in curated_rows:
            order[key] = len(order)
            curated_rows[key] = row
    if trade_candidates:
        # Membership is full canonical position scope, never readiness, label,
        # runner counts or an address-only match. Apply before all global views.
        # Arbitrum Fluid targets are vault-level targets, not invented borrower positions.
        admitted = {key for key, row in curated_rows.items() if key[0] == "position" or row.get("id") in {ARB_FLUID_ID, ARB_FLUID_54_ID, ARB_FLUID_42_ID}}
        admitted.update(batches[NEAR_IDENTITIES].identities)
        admitted.update(batches[NEAR_WATCH].identities)
        masks = {key: mask for key, mask in masks.items() if key in admitted}
        evidence = {key: bundles for key, bundles in evidence.items() if key in admitted}
        curated_rows = {key: row for key, row in curated_rows.items() if key in admitted}
        order = {key: value for key, value in order.items() if key in admitted}
        for batch in batches.values():
            if batch.coverage["accepted_rows"] is not None:
                batch.coverage["accepted_rows"] = len(admitted.intersection(batch.identities))
            batch.coverage["reported_total"] = None
            batch.coverage["limitations"].append("Input counts describe the consulted source; accepted rows include shortlist positions only, not other valid source rows.")
    resolved = {key: _resolve(key, bundles, curated_rows.get(key), now) for key, bundles in evidence.items()}
    extras = [descriptor(key, mask) for key, mask in masks.items() if key not in generation.by_identity]
    extras.sort(key=lambda item: item.digest)
    total = len(generation.ordered) + len(extras)
    summary = {"total": total, "eligible": sum(r.status == "ELIGIBLE" for r in resolved.values()),
               "observation_only": total - sum(not r.observation_only for r in resolved.values()),
               "stale": sum(r.observation["freshness"] in {AGING, STALE} for r in resolved.values())}
    normalized, warnings = normalize_query(query, sources, trade_candidates=trade_candidates)
    terms = normalized["q"].casefold().split()
    source_bit = SOURCE_BITS.get(normalized["source"], 0)
    def code(desc):
        state = resolved.get(desc.identity)
        return state.status if state else "OBSERVATION_ONLY" if desc.identity[0] == "market" else "UNKNOWN"
    filtered = []
    for desc in heapq.merge(generation.ordered, extras, key=lambda item: item.digest):
        key = desc.identity
        if normalized["chain"] and CHAINS[key[1]] != normalized["chain"]:
            continue
        if normalized["protocol"] and key[2] != normalized["protocol"]:
            continue
        if source_bit and not (desc.mask | masks.get(key, 0)) & source_bit:
            continue
        if normalized["status"] and code(desc) != normalized["status"]:
            continue
        if terms:
            fields = [key[0], CHAINS[key[1]], key[2], key[3], key[4] or "", key[5] or ""]
            if key in curated_rows:
                fields += [curated_rows[key].get(name) or "" for name in ("id", "pair", "label", "rank")]
            fields = tuple(value.casefold() for value in fields)
            if not all(any(term in value for value in fields) for term in terms):
                continue
        filtered.append(desc)
    sort = normalized["sort"]
    if sort == "curated":
        prefix = sorted((d for d in filtered if d.identity in order), key=lambda d: order[d.identity])
        filtered = prefix + [d for d in filtered if d.identity not in order]
    elif sort in {"chain", "protocol", "status"}:
        filtered.sort(key=lambda d: (CHAINS[d.identity[1]] if sort == "chain" else d.identity[2] if sort == "protocol" else code(d), d.digest))
    elif sort == "passive_time" or sort.startswith(("distance-", "gross-")):
        values, unknown = [], []
        for desc in filtered:
            state = resolved.get(desc.identity)
            value = state.evidence.bps if sort.startswith("distance-") and state and state.evidence and state.protocol_status != "UNKNOWN" else (
                decimal(state.quote.get("gross_usd"), True) if sort.startswith("gross-") and state and state.quote else None)
            if (sort == "passive_time" and state and state.evidence and state.evidence.health_known
                    and state.evidence.position_status != "CLOSED" and state.observation["freshness"] == FRESH
                    and state.protocol_status not in {"UNKNOWN", "INACTIVE", "STALE"}):
                value = decimal(state.evidence.position.get("passive_hours"))
            (unknown if value is None else values).append(desc if value is None else (value, desc))
        descending = sort.endswith("desc")
        values.sort(key=lambda item: (item[0].copy_negate() if descending else item[0], item[1].digest))
        filtered = [desc for _, desc in values] + unknown
    size = normalized["page_size"]
    pages = max(1, (len(filtered) + size - 1) // size)
    if normalized["page"] > pages:
        normalized["page"] = pages
        warnings.append({"parameter": "page", "code": "CLAMPED"})
    start = (normalized["page"] - 1) * size
    selected = filtered[start:start + size]
    rows = [_project(desc, desc.mask | masks.get(desc.identity, 0), resolved.get(desc.identity), curated_rows.get(desc.identity), batches, now) for desc in selected]
    coverage = [batch.coverage for batch in batches.values()]
    result = {**curated, "schema": "dashboard-targets/v2", "available": bool(total), "targets": rows, "summary": summary,
              "query": normalized, "query_warnings": warnings, "options": _options(sources, masks if trade_candidates else None),
              "pagination": {"page": normalized["page"], "page_size": size, "pages": pages, "filtered_total": len(filtered),
                             "returned": len(rows), "start": start + 1 if rows else 0, "end": start + len(rows) if rows else 0,
                             "has_prev": normalized["page"] > 1, "has_next": normalized["page"] < pages},
              "coverage": {"complete": all(s["read_state"] == "OK" and not s["rejected_rows"] and not s["omitted_rows"] and not s["truncated"] for s in coverage),
                           "limits": {"max_bytes_per_source": max(s.max_bytes for s in sources), "max_rows_per_source": max(s.max_rows for s in sources)}, "sources": coverage}}
    result["warnings"] = list(dict.fromkeys(result["warnings"] + [
        "The top-level pin is the curated reference only, not a synthesized multichain snapshot.",
        "Counts cover admitted stored records only; source snapshots are not atomic and do not establish all-chain coverage or profit."]))
    if trade_candidates:
        result["view_mode"] = "trade_candidates"
        result["warnings"].append("Curated borrower shortlist and strictly bound near targets only; historical identities and market-only observations are excluded. Waiting, held and observation stages are not execution or profit readiness.")
    return result
