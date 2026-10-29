"""Small, defensive normalization helpers for dashboard source values."""

from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Any

FRESH = "FRESH"
AGING = "AGING"
STALE = "STALE"
CLOCK_SKEW = "CLOCK_SKEW"
UNKNOWN = "UNKNOWN"
NA = "NOT_APPLICABLE"
ZERO = "ZERO"
NOT_CONTINUOUSLY_SOURCED = "NOT_CONTINUOUSLY_SOURCED"
MAX_SAFE_METRIC_FLOAT = 1_000_000_000_000_000.0

KNOWN_SEVERITIES = {"CRITICAL", "HIGH", "WARN", "INFO"}


def timestamp(value: Any) -> float | None:
    """Normalize ISO strings and second/millisecond epochs to seconds."""

    try:
        if isinstance(value, bool):
            return None
        if isinstance(value, str):
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            result = parsed.timestamp()
        else:
            result = float(value)
            if result > 10_000_000_000:
                result /= 1000
        return result if math.isfinite(result) else None
    except (OverflowError, TypeError, ValueError):
        return None


def freshness(value: Any, now: float, aging: float = 900, stale: float = 3600) -> tuple[str, float | None]:
    """Classify source age, including timestamps over five minutes ahead."""

    observed_at = timestamp(value)
    if observed_at is None:
        return UNKNOWN, None
    age = now - observed_at
    if age < -300:
        return CLOCK_SKEW, age
    if age > stale:
        return STALE, age
    if age > aging:
        return AGING, age
    return FRESH, age


def severity(value: Any) -> str | None:
    """Return only recognized normalized alert severities."""

    normalized = {"MEDIUM": "WARN", "DORMANT": "INFO"}.get(
        str(value).upper(), str(value).upper()
    )
    return normalized if normalized in KNOWN_SEVERITIES else None


def safe_value(value: Any) -> str | int | float | bool | None:
    """Return a JSON-safe scalar while preserving large integers exactly."""

    if value is None or isinstance(value, (str, bool)):
        return value
    if isinstance(value, int):
        return str(value) if abs(value) > 9_007_199_254_740_991 else value
    if isinstance(value, float):
        return value if math.isfinite(value) and abs(value) <= MAX_SAFE_METRIC_FLOAT else None
    return None
