"""Watchlist writes and the fixed balance-collector trigger.

This module is the only place the dashboard writes anything, and it writes
exactly one path: ``coordination/watch-addresses.json``. Writes are atomic
(temp file plus ``os.replace``) and preserve the fixed
``{"schema": "watch-addresses/v1", "addresses": [{"label"?, "address"}]}``
shape. The collector is a fixed first-party script spawned with a fixed argv,
``shell=False``, the workspace as ``cwd``, and single-flight semantics. No
client input reaches the command line.
"""

from __future__ import annotations

import json
import math
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

WATCHLIST_SCHEMA = "watch-addresses/v1"
ADDRESS_PATTERN = re.compile(r"0x[0-9a-fA-F]{40}")
SOLANA_PATTERN = re.compile(r"[1-9A-HJ-NP-Za-km-z]{32,44}")
BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
MAX_ADDRESSES = 20
MAX_LABEL_LENGTH = 64
MAX_BODY_BYTES = 4 * 1024
MAX_WATCHLIST_BYTES = 256 * 1024
COLLECTOR_ARGV = ["node", "tools/watch-wallet-balances.js", "--once"]
COLLECTOR_TIMEOUT_SECONDS = 240
COLLECTOR_EXIT_ERRORS = {
    2: "OUTPUT_BUSY", 3: "TIMEOUT", 4: "OUTPUT_OWNERSHIP_LOST", 5: "DRAIN_UNCONFIRMED",
}
# Server-side freshness trigger for the balance artifact. The dashboard reloads
# itself every 60s, so a stale snapshot is re-collected in the background long
# before it would be rendered as STALE. One in-flight run at a time, and a short
# cooldown prevents a failing collector from being retried on every page load.
AUTO_REFRESH_AFTER_SECONDS = 900
AUTO_REFRESH_COOLDOWN_SECONDS = 120
COLLECTOR_HINT = "collector unavailable \u2014 run node tools/watch-wallet-balances.js --once"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def normalize_family(value: Any) -> str | None:
    """Map an explicit family to ``evm``/``solana``; ``None`` when unrecognized."""

    if value is None:
        return "evm"
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered == "solana":
            return "solana"
        if lowered == "evm":
            return "evm"
    return None


def valid_solana_address(address: Any) -> bool:
    """Require the same 32 decoded bytes as the balance collector."""

    if not isinstance(address, str) or SOLANA_PATTERN.fullmatch(address) is None:
        return False
    value = 0
    for character in address:
        value = value * 58 + BASE58_ALPHABET.index(character)
    leading_zeroes = len(address) - len(address.lstrip("1"))
    return leading_zeroes + (value.bit_length() + 7) // 8 == 32


def address_family(address: Any) -> str | None:
    """Infer the family from an address shape; ``None`` when neither matches."""

    if not isinstance(address, str):
        return None
    if ADDRESS_PATTERN.fullmatch(address):
        return "evm"
    if valid_solana_address(address):
        return "solana"
    return None


def is_valid_address(address: Any, family: str) -> bool:
    if family == "evm":
        return isinstance(address, str) and ADDRESS_PATTERN.fullmatch(address) is not None
    if family == "solana":
        return valid_solana_address(address)
    return False


def canonical_address(address: str, family: str) -> str:
    """EVM addresses are lowercased; base58 Solana addresses are case-sensitive."""

    return address.lower() if family == "evm" else address


def clean_label(value: Any) -> str | None:
    """Return a bounded single-line label or ``None``; never a path or control text."""

    if not isinstance(value, str):
        return None
    text = "".join(" " if ord(character) < 32 else character for character in value).strip()
    if not text:
        return None
    return text[:MAX_LABEL_LENGTH]


def watch_address_entries(value: Any, available: bool) -> list[dict[str, str]]:
    """Project the canonical watchlist into validated ``{address, family, label?}`` rows."""

    if not available or not isinstance(value, dict):
        return []
    entries = value.get("addresses")
    if not isinstance(entries, list) or len(entries) > 512:
        return []
    projected: list[dict[str, str]] = []
    for entry in entries:
        address: Any = None
        label: Any = None
        explicit_family: Any = None
        has_family = False
        if isinstance(entry, str):
            address = entry
        elif isinstance(entry, dict):
            address = entry.get("address")
            label = entry.get("label")
            has_family = "family" in entry
            explicit_family = entry.get("family")
        if has_family:
            family = normalize_family(explicit_family)
            if family is None or not is_valid_address(address, family):
                continue
        else:
            family = address_family(address)
            if family is None:
                continue
        row = {"address": canonical_address(address, family), "family": family}
        cleaned = clean_label(label)
        if cleaned:
            row["label"] = cleaned
        projected.append(row)
    return projected


# Mutation-time limits. They are deliberately separate from the tolerant display
# projection above: display may skip or truncate unsupported rows, but a mutation
# must reject unreadable/unsupported state so it never rewrites (and therefore
# never silently drops) records it did not fully validate.
MAX_WATCHLIST_ENTRIES = 512
MAX_WATCHLIST_LABEL = 80  # matches the collector's label bound in tools/watch-wallet-balances.js
ENTRY_KEYS = frozenset({"address", "label", "family"})
TOP_LEVEL_KEYS = frozenset({"schema", "addresses"})


def _label_acceptable(label: Any) -> bool:
    """Accept only a bounded single-line label within the collector's label limit."""

    if not isinstance(label, str) or not label or len(label) > MAX_WATCHLIST_LABEL:
        return False
    return all(ord(character) >= 32 for character in label)


def _strict_entry(entry: Any) -> dict[str, str] | None:
    """Validate one stored watchlist entry for a mutation; ``None`` when unsupported."""

    if isinstance(entry, str):
        family = address_family(entry)
        if family is None:
            return None
        return {"address": canonical_address(entry, family), "family": family}
    if not isinstance(entry, dict) or set(entry) - ENTRY_KEYS or "address" not in entry:
        return None
    address = entry.get("address")
    if "family" in entry:
        family = normalize_family(entry.get("family"))
        if family is None or not is_valid_address(address, family):
            return None
    else:
        family = address_family(address)
        if family is None:
            return None
    row = {"address": canonical_address(address, family), "family": family}
    label = entry.get("label")
    if label is not None:
        if not _label_acceptable(label):
            return None
        row["label"] = label
    return row


def parse_watchlist(value: Any) -> list[dict[str, str]] | None:
    """Strictly parse stored watchlist state; ``None`` means the mutation is rejected.

    Accepts only the documented container and the supported legacy entry forms
    (a bare EVM/Solana address string, or ``{"address", "label"?, "family"?}``).
    Unsupported schema, container, entry, family, address or an excessive entry
    count returns ``None`` so the caller preserves the original bytes.
    """

    if not isinstance(value, dict) or set(value) - TOP_LEVEL_KEYS:
        return None
    schema = value.get("schema")
    if schema is not None and schema != WATCHLIST_SCHEMA:
        return None
    entries = value.get("addresses")
    if not isinstance(entries, list) or len(entries) > MAX_WATCHLIST_ENTRIES:
        return None
    rows: list[dict[str, str]] = []
    for entry in entries:
        row = _strict_entry(entry)
        if row is None:
            return None
        rows.append(row)
    return rows


class WatchlistError(Exception):
    """A sanitized mutation failure safe to return to the client."""

    def __init__(self, status: int, reason: str) -> None:
        super().__init__(reason)
        self.status = status
        self.reason = reason


class WalletStore:
    """Serialize mutations across app instances in the single dashboard process."""

    _locks: dict[Path, Any] = {}
    _locks_guard = threading.Lock()

    def __init__(self, root: str | os.PathLike[str]) -> None:
        self.root = Path(root).resolve()
        self.path = self.root / "coordination" / "watch-addresses.json"
        with self._locks_guard:
            self._lock = self._locks.setdefault(self.path, threading.RLock())

    @staticmethod
    def _entry(item: dict[str, Any]) -> dict[str, Any]:
        """Serialize one entry, preserving the ``family`` marker for Solana."""

        entry: dict[str, Any] = {}
        if item.get("label"):
            entry["label"] = item["label"]
        entry["address"] = item["address"]
        if item.get("family") == "solana":
            entry["family"] = "solana"
        return entry

    def load(self) -> list[dict[str, str]]:
        with self._lock:
            return self._load()

    def _load(self) -> list[dict[str, str]]:
        try:
            raw = self.path.read_bytes()
        except FileNotFoundError:
            return []
        except OSError:
            raise WatchlistError(409, "WATCHLIST_UNREADABLE")
        if len(raw) > MAX_WATCHLIST_BYTES:
            raise WatchlistError(409, "WATCHLIST_UNREADABLE")
        try:
            value = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeError):
            raise WatchlistError(409, "WATCHLIST_UNREADABLE")
        rows = parse_watchlist(value)
        if rows is None:
            raise WatchlistError(409, "WATCHLIST_UNREADABLE")
        return rows

    def save(self, addresses: list[dict[str, str]]) -> dict[str, Any]:
        with self._lock:
            return self._save(addresses)

    def _save(self, addresses: list[dict[str, str]]) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "schema": WATCHLIST_SCHEMA,
            "addresses": [self._entry(item) for item in addresses],
        }
        encoded = json.dumps(payload, indent=2) + "\n"
        directory = self.path.parent
        try:
            directory.mkdir(parents=True, exist_ok=True)
            descriptor, temp_name = tempfile.mkstemp(
                prefix=".watch-addresses-", suffix=".tmp", dir=str(directory)
            )
            try:
                with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
                    stream.write(encoded)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temp_name, self.path)
            except OSError:
                try:
                    os.unlink(temp_name)
                except OSError:
                    pass
                raise
        except OSError:
            raise WatchlistError(500, "WRITE_FAILED")
        return payload

    def add(self, raw_address: Any, raw_label: Any, raw_family: Any = None) -> dict[str, Any]:
        family = normalize_family(raw_family) if raw_family is not None else address_family(raw_address)
        if family is None or not is_valid_address(raw_address, family):
            raise WatchlistError(400, "INVALID_ADDRESS")
        address = canonical_address(raw_address, family)
        with self._lock:
            addresses = self.load()
            if any(item["family"] == family and item["address"] == address for item in addresses):
                raise WatchlistError(409, "DUPLICATE_ADDRESS")
            if len(addresses) >= MAX_ADDRESSES:
                raise WatchlistError(409, "ADDRESS_LIMIT_REACHED")
            item: dict[str, Any] = {"address": address, "family": family}
            cleaned = clean_label(raw_label)
            if cleaned:
                item["label"] = cleaned
            addresses.append(item)
            return self.save(addresses)

    def remove(self, raw_address: Any, raw_family: Any = None) -> dict[str, Any]:
        family = normalize_family(raw_family) if raw_family is not None else address_family(raw_address)
        if family is None or not is_valid_address(raw_address, family):
            raise WatchlistError(400, "INVALID_ADDRESS")
        address = canonical_address(raw_address, family)
        with self._lock:
            addresses = self.load()
            remaining = [
                item
                for item in addresses
                if not (item["family"] == family and item["address"] == address)
            ]
            if len(remaining) == len(addresses):
                raise WatchlistError(404, "ADDRESS_NOT_FOUND")
            return self.save(remaining)


class Collector:
    """Single-flight controller for the fixed balance-collector command."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._running = False
        self._dirty = False
        self._last_started: str | None = None
        self._last_started_epoch: float | None = None
        self._last_finished: str | None = None
        self._last_exit: int | None = None
        self._last_error: str | None = None
        self._deadline_at: str | None = None
        self._started_monotonic: float | None = None
        self._state = "IDLE"

    def status(self) -> dict[str, Any]:
        with self._lock:
            return {
                "running": self._running,
                "last_started": self._last_started,
                "last_finished": self._last_finished,
                "last_exit": self._last_exit,
                "last_error": self._last_error,
                "timeout_seconds": COLLECTOR_TIMEOUT_SECONDS,
                "deadline_at": self._deadline_at if self._running else None,
                "state": self._state,
            }

    def started_within(self, seconds: float, now: float | None = None) -> bool:
        """Return whether a run was started less than ``seconds`` ago."""

        with self._lock:
            if self._last_started_epoch is None:
                return False
            reference = time.time() if now is None else now
            return 0 <= (reference - self._last_started_epoch) < seconds

    def _begin_attempt(self) -> None:
        self._last_started = _now()
        self._last_started_epoch = time.time()
        self._started_monotonic = time.monotonic()
        self._deadline_at = (datetime.fromisoformat(self._last_started) + timedelta(seconds=COLLECTOR_TIMEOUT_SECONDS)).isoformat()
        self._last_finished = None
        self._last_exit = None
        self._last_error = None
        self._state = "RUNNING"

    def start(self, workspace: str | os.PathLike[str], *, changed: bool = False) -> bool:
        with self._lock:
            if self._running:
                self._dirty = self._dirty or changed
                return False
            self._running = True
            self._dirty = False
            self._begin_attempt()
        threading.Thread(target=self._run, args=(str(workspace),), daemon=True).start()
        return True

    def _run(self, workspace: str) -> None:
        while True:
            exit_code: int | None = None
            error: str | None = None
            try:
                # The timeout starts with this attempt, never with a status poll.
                remaining = COLLECTOR_TIMEOUT_SECONDS - (time.monotonic() - self._started_monotonic)
                if remaining <= 0:
                    raise subprocess.TimeoutExpired(COLLECTOR_ARGV, COLLECTOR_TIMEOUT_SECONDS)
                completed = subprocess.run(
                    list(COLLECTOR_ARGV),
                    shell=False,
                    cwd=workspace,
                    timeout=remaining,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    check=False,
                )
                exit_code = completed.returncode
                if exit_code != 0:
                    error = COLLECTOR_EXIT_ERRORS.get(exit_code, "COLLECT_FAILED")
            except subprocess.TimeoutExpired:
                error = "TIMEOUT"
            except FileNotFoundError:
                error = "NODE_NOT_FOUND"
            except OSError:
                error = "SPAWN_FAILED"
            with self._lock:
                self._last_exit = exit_code
                self._last_error = error
                if self._dirty:
                    # Keep running true across the coalesced follow-up so the UI
                    # waits for a snapshot of the latest persisted watchlist.
                    self._dirty = False
                    self._begin_attempt()
                else:
                    self._running = False
                    self._deadline_at = None
                    self._state = "DEFERRED" if error == "OUTPUT_BUSY" else "TIMEOUT" if error == "TIMEOUT" else "FAILED" if error else "SUCCEEDED"
                    self._last_finished = _now()
                    return


_COLLECTOR = Collector()


def collector_status() -> dict[str, Any]:
    return _COLLECTOR.status()


def start_refresh(workspace: str | os.PathLike[str], *, changed: bool = False) -> bool:
    return _COLLECTOR.start(workspace, changed=changed)


def node_available() -> bool:
    """Return whether the collector's interpreter is resolvable on PATH."""

    return shutil.which("node") is not None


def collector_hint(status: dict[str, Any] | None = None) -> str | None:
    """Describe the last collector failure as an actionable, non-fatal hint."""

    status = status or _COLLECTOR.status()
    if not node_available():
        return COLLECTOR_HINT
    error = status.get("last_error")
    if error is None:
        if status.get("last_exit") not in (None, 0):
            return f"collector exited {status['last_exit']} \u2014 {COLLECTOR_HINT}"
        return None
    if error == "TIMEOUT":
        return f"collector timed out \u2014 {COLLECTOR_HINT}"
    if error == "OUTPUT_BUSY":
        return "collector deferred \u2014 another balance writer owns the output"
    return f"collector failed ({error}) \u2014 {COLLECTOR_HINT}"


def auto_refresh(
    workspace: str | os.PathLike[str],
    *,
    available: bool,
    age: float | None,
    now: float | None = None,
) -> dict[str, Any]:
    """Start one bounded background balance refresh when the snapshot is stale.

    Never fabricates data: it only asks the fixed first-party collector to run.
    Returns a small, template-safe outcome describing what happened.
    """

    reference = time.time() if now is None else now
    if available and isinstance(age, (int, float)) and math.isfinite(age) and 0 <= age <= AUTO_REFRESH_AFTER_SECONDS:
        return {"state": "FRESH", "attempted": False, "running": False}
    status = _COLLECTOR.status()
    if status["running"]:
        return {"state": "RUNNING", "attempted": False, "running": True}
    if not node_available():
        return {"state": "NODE_UNAVAILABLE", "attempted": False, "running": False, "hint": COLLECTOR_HINT}
    if _COLLECTOR.started_within(AUTO_REFRESH_COOLDOWN_SECONDS, reference):
        return {"state": "COOLDOWN", "attempted": False, "running": False}
    started = _COLLECTOR.start(workspace)
    return {"state": "STARTED" if started else "RUNNING", "attempted": started, "running": started}


def reset_collector() -> None:
    """Replace the process-wide collector; used by tests for isolation."""

    global _COLLECTOR
    _COLLECTOR = Collector()
