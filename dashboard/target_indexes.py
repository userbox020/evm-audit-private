"""Fixed-source target reads; compact enumeration identities, never health claims."""

from __future__ import annotations

import csv
import hashlib
import io
import itertools
import json
import os
import re
import stat
import threading
import time
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

DEFAULT_BYTES = 5 * 1024 * 1024
CACHE_SECONDS = 60
REPARSE_POINT = 0x400
SAFE_INTEGER = (1 << 53) - 1
AAVE_POOL = "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2"
MORPHO = "0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb"
V4_IDENTITY_DIGEST = "f02e798c722ab41c8256c94a031666b1a551c566fdff77c1d3cf4dcb6942040f"
V4_TOPIC = "0xef18174796a5d2f91d51dc5e907a4d7867bbd6e800f6225168e0453d581d0dcd"
TARGET_PATHS = {
    "aave_v3_borrower_csv": "reports/raw/fast/aave-v3-borrower-universe-users.csv",
    "aave_v4_borrower_index": "reports/raw/fast/aave-v4-borrower-history/" + V4_IDENTITY_DIGEST + ".json",
    "morpho_blue_index": "reports/monitor/morpho-blue-l-index.json",
    "morpho_blue_base_index": "reports/monitor/morpho-blue-l-base-index.json",
    "euler_liquidation_history": "reports/raw/fast/euler-l.csv",
    "aave_v4_near_watch": "reports/raw/fast/aave-v4-near-liquidation-live-watch.json",
    "aave_v3_route_distance": "reports/raw/fast/aave-v3-route-distance.json",
    "aave_v4_spoke_borrowers": "reports/raw/fast/aave-v4-spoke-borrowers.json",
    "compound_v3_base_watch": "reports/monitor/compound-v3-base-watch.json",
    "euler_silo_current_screen": "reports/raw/fast/euler-silo-wallet-20261019/current-screen-1792447252503.json",
    "silo_l_surface": "reports/raw/fast/silo-l.json",
    "silo_l_economics": "reports/raw/fast/silo-l-economics.json",
}
INDEX_LIMITS = {
    "aave_v3_borrower_csv": (8388608, 125000),
    "aave_v4_borrower_index": (8388608, 100000),
    "morpho_blue_index": (16777216, 100000),
    "morpho_blue_base_index": (67108864, 250000),
    "euler_liquidation_history": (5242880, 10000),
}
Entry = tuple[int, str, str, str, str | None]


@dataclass(frozen=True)
class TargetIndexRead:
    entries: tuple[Entry, ...]
    current: bool
    read_state: str
    input_rows: int | None
    accepted_rows: int
    rejected_rows: int
    omitted_rows: int | None
    truncated: bool
    generated_at: str | None
    fingerprint: tuple | None
    max_bytes: int
    max_rows: int


@dataclass(frozen=True)
class TargetJsonRead:
    value: dict[str, Any] | None
    current: bool
    read_state: str
    fingerprint: tuple | None
    max_bytes: int


class _ReadFailure(Exception):
    def __init__(self, state: str):
        super().__init__(state)
        self.state = state


class _Changed(Exception):
    pass


def _need(condition: bool) -> None:
    if not condition:
        raise ValueError("INVALID")


def _uint(value: Any, maximum: int = SAFE_INTEGER, minimum: int = 0) -> bool:
    return type(value) is int and minimum <= value <= maximum


def _decimal(value: str, maximum: int = SAFE_INTEGER) -> bool:
    return bool(re.fullmatch(r"(?:0|[1-9][0-9]{0,77})", value)) and int(value) <= maximum


def _address(value: Any) -> bool:
    return isinstance(value, str) and bool(re.fullmatch(r"0x[0-9a-fA-F]{40}", value)) and int(value[2:], 16) != 0


def _hash(value: Any) -> bool:
    return isinstance(value, str) and bool(re.fullmatch(r"0x[0-9a-fA-F]{64}", value))


def _date(value: Any) -> str | None:
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)", value):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    except (ValueError, OverflowError):
        return None


def _json(raw: bytes) -> dict:
    def pairs(items):
        result = {}
        for key, value in items:
            _need(key not in result)
            result[key] = value
        return result

    def invalid_constant(_value):
        raise ValueError("INVALID")

    value = json.loads(raw.decode("utf-8"), object_pairs_hook=pairs, parse_constant=invalid_constant)
    _need(isinstance(value, dict))
    return value


def _digest(value: dict) -> str:
    # Producer digest() hashes JSON.stringify(value), NOT sorted keys or file bytes.
    # The validated V4 schema consists solely of safe integers and ASCII strings.
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")).hexdigest()


def _result(key, entries, total, rejected, omitted, generated_at=None):
    max_bytes, max_rows = INDEX_LIMITS[key]
    return TargetIndexRead(tuple(entries), True, "PARTIAL" if rejected or omitted else "OK", total,
                           len(entries), rejected, omitted, bool(omitted), generated_at, None, max_bytes, max_rows)


def _csv_index(key: str, raw: bytes) -> TargetIndexRead:
    aave = key == "aave_v3_borrower_csv"
    expected = ["user", "lastBorrowBlock"] if aave else [
        "vault", "liquidator", "violator", "collateralAsset", "repayAssetsRaw", "yieldBalanceRaw", "blockNumber", "txHash", "logIndex"]
    # The exact observed Euler producer header has NINE columns (parent-approved
    # correction to the handoff's ten-column typo); extra columns are rejected.
    line_limit, max_rows = (256 if aave else 1024), INDEX_LIMITS[key][1]
    stream = io.BytesIO(raw)
    first = stream.readline(line_limit + 1)
    _need(len(first) <= line_limit)
    _need(next(csv.reader([first.decode("utf-8").rstrip("\r\n")], strict=True)) == expected)
    total = raw.count(b"\n") + int(bool(raw) and not raw.endswith(b"\n")) - 1
    entries, rejected = [], 0
    for _ in range(min(total, max_rows)):
        line = stream.readline(line_limit + 1)
        if len(line) > line_limit:
            while line and not line.endswith(b"\n"):
                line = stream.readline(line_limit + 1)
            rejected += 1
            continue
        try:
            fields = next(csv.reader([line.decode("utf-8").rstrip("\r\n")], strict=True))
            _need(len(fields) == len(expected))
            if aave:
                _need(_address(fields[0]) and _decimal(fields[1]))
                # Fixed producer is Ethereum's canonical Aave V3 pool. CSV carries
                # no source timestamp or health; never substitute filesystem dates.
                entries.append((1, "Aave V3", AAVE_POOL, fields[0].lower(), None))
            else:
                _need(all(_address(field) for field in fields[:4]))
                _need(all(_decimal(fields[i], (1 << 256) - 1) for i in (4, 5)))
                _need(_decimal(fields[6]) and _hash(fields[7]) and _decimal(fields[8]))
                entries.append((1, "Euler", fields[0].lower(), fields[2].lower(), None))
        except (ValueError, UnicodeError, csv.Error, StopIteration):
            rejected += 1
    return _result(key, entries, total, rejected, max(0, total - max_rows))


def _morpho_index(key: str, raw: bytes) -> TargetIndexRead:
    data = _json(raw)
    chain, deployment = (1, 18883124) if key == "morpho_blue_index" else (8453, 13977148)
    _need(data.get("schema") == "morpho-blue-l-index/v1" and type(data.get("chainId")) is int and data["chainId"] == chain)
    _need(type(data.get("version")) is int and data["version"] == 1 and data.get("deploymentBlock") == deployment)
    _need(_uint(data.get("cursor"), minimum=deployment) and _uint(data.get("logs")) and isinstance(data.get("pairs"), dict))
    pairs, entries, rejected, markets = data["pairs"], [], 0, {}
    for compound, count in itertools.islice(pairs.items(), INDEX_LIMITS[key][1]):
        if not re.fullmatch(r"0x[0-9a-f]{64}0x0{24}[0-9a-f]{40}", compound) or not _uint(count, minimum=1):
            rejected += 1
            continue
        borrower, market = "0x" + compound[-40:], compound[:66]
        if not _address(borrower):
            rejected += 1
            continue
        market = markets.setdefault(market, market)
        entries.append((chain, "Morpho Blue", MORPHO, borrower, market))
    evaluation = data.get("evaluation")
    generated = _date(evaluation.get("evaluatedAt")) if isinstance(evaluation, dict) else None
    return _result(key, entries, len(pairs), rejected, max(0, len(pairs) - INDEX_LIMITS[key][1]), generated)


def _v4_index(key: str, raw: bytes) -> TargetIndexRead:
    wrapper = _json(raw)
    _need(set(wrapper) == {"index", "contentDigest"} and isinstance(wrapper["index"], dict))
    data = wrapper["index"]
    _need(set(data) == {"schema", "identity", "identityDigest", "throughBlock", "throughBlockHash", "committedChunks", "logs", "users"})
    identity = data["identity"]
    _need(isinstance(identity, dict) and set(identity) == {"chainId", "fromBlock", "borrowTopic", "registryDigest", "spokes"})
    _need(type(identity["chainId"]) is int and identity["chainId"] == 1 and type(identity["fromBlock"]) is int and identity["fromBlock"] == 0)
    _need(identity["borrowTopic"] == V4_TOPIC and isinstance(identity["registryDigest"], str) and bool(re.fullmatch(r"[0-9a-f]{64}", identity["registryDigest"])))
    spokes = identity["spokes"]
    _need(isinstance(spokes, list) and 0 < len(spokes) <= 64 and all(_address(s) and s == s.lower() for s in spokes))
    _need(spokes == sorted(set(spokes)))
    # Computed identity binds this exact registry/spoke scope, not just its filename.
    _need(data["identityDigest"] == V4_IDENTITY_DIGEST == _digest(identity))
    _need(data["schema"] == "aave-v4-borrower-history/v1" and type(data["throughBlock"]) is int and -1 <= data["throughBlock"] <= SAFE_INTEGER)
    _need(_uint(data["committedChunks"]) and _uint(data["logs"]))
    _need(isinstance(data["users"], dict) and set(data["users"]) == set(spokes) and all(isinstance(rows, list) for rows in data["users"].values()))
    _need(wrapper["contentDigest"] == _digest(data))
    total = sum(len(rows) for rows in data["users"].values())
    if data["throughBlock"] == -1:
        _need(data["throughBlockHash"] is None and data["committedChunks"] == 0 and data["logs"] == 0 and total == 0)
    else:
        _need(_hash(data["throughBlockHash"]) and data["committedChunks"] > 0)
    entries, rejected, events, inspected = [], 0, 0, 0
    for spoke in spokes:
        seen = set()
        for row in itertools.islice(data["users"][spoke], max(0, INDEX_LIMITS[key][1] - inspected)):
            inspected += 1
            if not (isinstance(row, dict) and set(row) == {"user", "firstBorrowBlock", "lastBorrowBlock", "borrowEvents"}
                    and _address(row["user"]) and row["user"] == row["user"].lower() and row["user"] not in seen
                    and _uint(row["firstBorrowBlock"]) and _uint(row["lastBorrowBlock"])
                    and row["firstBorrowBlock"] <= row["lastBorrowBlock"] <= data["throughBlock"] and _uint(row["borrowEvents"], minimum=1)):
                rejected += 1
                continue
            seen.add(row["user"])
            events += row["borrowEvents"]
            entries.append((1, "Aave V4", spoke, row["user"], None))
    omitted = total - inspected
    if not rejected and not omitted:
        _need(events == data["logs"] and events <= SAFE_INTEGER)
    return _result(key, entries, total, rejected, omitted)


def _parse_index(key: str, raw: bytes) -> TargetIndexRead:
    if key in ("aave_v3_borrower_csv", "euler_liquidation_history"):
        return _csv_index(key, raw)
    if key == "aave_v4_borrower_index":
        return _v4_index(key, raw)
    return _morpho_index(key, raw)


def _fingerprint(info: os.stat_result) -> tuple:
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def _redirected(info: os.stat_result) -> bool:
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, "st_file_attributes", 0) & REPARSE_POINT)


class TargetReader:
    """Separate, instance-local compact cache; never touches ArtifactReader.last_good."""

    def __init__(self, root: Path, allowlist: dict[str, str]):
        self.root = root
        self._paths = dict(allowlist)
        self._lock = threading.RLock()
        self._cache: dict[str, tuple[float, TargetIndexRead]] = {}

    def _bound(self, key: str) -> int:
        return INDEX_LIMITS[key][0] if key in INDEX_LIMITS else 16777216 if key == "morpho_blue_liquidatable" else DEFAULT_BYTES

    def _validated(self, key: str, limit: int):
        path = self.root / self._paths[key]
        try:
            current = self.root
            parts = Path(self._paths[key]).parts
            _need(not Path(self._paths[key]).is_absolute() and ".." not in parts)
            info = os.lstat(current)
            if _redirected(info) or not stat.S_ISDIR(info.st_mode):
                raise _ReadFailure("UNAVAILABLE")
            for i, part in enumerate(parts):
                current = current / part
                info = os.lstat(current)
                if _redirected(info):
                    raise _ReadFailure("UNAVAILABLE")
                if i < len(parts) - 1 and not stat.S_ISDIR(info.st_mode):
                    raise _ReadFailure("UNAVAILABLE")
            if path.resolve(strict=True) != path or not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise _ReadFailure("UNAVAILABLE")
            if info.st_size > limit:
                raise _ReadFailure("OVERSIZED")
            return path, info
        except FileNotFoundError:
            raise _ReadFailure("MISSING") from None
        except (OSError, ValueError, RuntimeError):
            raise _ReadFailure("UNAVAILABLE") from None

    def _open(self, key: str, limit: int):
        path, before = self._validated(key, limit)
        fd = None
        try:
            fd = os.open(path, os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
            after = os.fstat(fd)
            if not os.path.samestat(before, after) or _fingerprint(before) != _fingerprint(after):
                raise _Changed()
            if _redirected(after) or not stat.S_ISREG(after.st_mode) or after.st_nlink != 1:
                raise _ReadFailure("UNAVAILABLE")
            stream = os.fdopen(fd, "rb")
            fd = None
            return stream, after
        except FileNotFoundError:
            raise _Changed() from None
        except OSError:
            raise _ReadFailure("UNAVAILABLE") from None
        finally:
            if fd is not None:
                os.close(fd)

    def _verify(self, key, limit, stream, before):
        try:
            after = os.fstat(stream.fileno())
            _, current = self._validated(key, limit)
            if _redirected(after) or after.st_nlink != 1 or not stat.S_ISREG(after.st_mode):
                raise _Changed()
            if _fingerprint(after) != _fingerprint(before) or _fingerprint(current) != _fingerprint(before):
                raise _Changed()
        except (OSError, _ReadFailure):
            raise _Changed() from None

    def _load(self, key, parse=None, cache=None):
        limit = self._bound(key)
        for attempt in range(2):
            try:
                stream, before = self._open(key, limit)
                with stream:
                    fingerprint = _fingerprint(before)
                    hit = cache and cache[1].fingerprint == fingerprint and 0 <= time.monotonic() - cache[0] < CACHE_SECONDS
                    error = None
                    value = cache[1] if hit else None
                    if parse is not None and not hit:
                        try:
                            raw = stream.read(limit + 1)
                            if len(raw) > limit or len(raw) != before.st_size:
                                raise _Changed()
                            value = parse(raw)
                        except _Changed:
                            raise
                        except Exception:
                            error = _ReadFailure("INVALID")
                    self._verify(key, limit, stream, before)
                    if error:
                        raise error
                    return value, fingerprint, bool(hit)
            except _Changed:
                if attempt == 1:
                    raise _ReadFailure("UNAVAILABLE") from None
            except _ReadFailure:
                if attempt:
                    raise _ReadFailure("UNAVAILABLE") from None
                raise
            except OSError:
                raise _ReadFailure("UNAVAILABLE") from None

    def fingerprint(self, key: str) -> tuple | None:
        if not isinstance(key, str) or key not in self._paths:
            return None
        with self._lock:
            try:
                _, fingerprint, _ = self._load(key)
                if key in self._cache and self._cache[key][1].fingerprint != fingerprint:
                    self._cache.pop(key, None)
                return fingerprint
            except _ReadFailure:
                self._cache.pop(key, None)
                return None

    def read_index(self, key: str) -> TargetIndexRead:
        if not isinstance(key, str) or key not in INDEX_LIMITS:
            return TargetIndexRead((), False, "INVALID", None, 0, 0, None, False, None, None, 0, 0)
        with self._lock:
            try:
                result, fingerprint, hit = self._load(key, lambda raw: _parse_index(key, raw), self._cache.get(key))
                if not hit:
                    result = replace(result, fingerprint=fingerprint)
                    self._cache[key] = (time.monotonic(), result)
                return result
            except _ReadFailure as error:
                self._cache.pop(key, None)
                max_bytes, max_rows = INDEX_LIMITS[key]
                return TargetIndexRead((), False, error.state, None, 0, 0, None, False, None, None, max_bytes, max_rows)

    def read_json(self, key: str, validator: Callable[[dict], bool] | None = None) -> TargetJsonRead:
        if not isinstance(key, str) or key not in self._paths or key in INDEX_LIMITS:
            return TargetJsonRead(None, False, "INVALID", None, 0)
        def parse(raw):
            value = _json(raw)
            if validator is not None:
                _need(validator(value) is True)
            return value

        with self._lock:
            try:
                value, fingerprint, _ = self._load(key, parse)
                return TargetJsonRead(value, True, "OK", fingerprint, self._bound(key))
            except _ReadFailure as error:
                return TargetJsonRead(None, False, error.state, None, self._bound(key))
