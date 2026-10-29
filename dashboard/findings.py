"""Curated findings register; reads one bundled catalog, never its evidence paths."""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any


CATALOG_PATH = Path(__file__).with_name("findings_catalog.json")
CATEGORIES = {
    "market-supply": "Market supply",
    "postmortem": "Postmortem",
    "infrastructure": "Infrastructure",
    "live-capability": "Live capability",
    "routes": "Routes",
    "signing": "Signing",
    "economic": "Economics",
    "defect": "Defect",
    "research": "Research",
    "oracle": "Oracle integrity",
    "coverage": "Coverage & monitoring",
    "composition": "Composition",
    "limitation": "Standing limitation",
}
STATUSES = {
    "CLOSED_NEGATIVE": "Closed · negative",
    "ARMED": "Armed · firing nothing",
    "VERIFIED": "Verified · not profit",
    "FIXED": "Fixed",
    "BLOCKED": "Blocked",
    "OPEN_LANE": "Open research",
}
PRIORITIES = {priority: f"P{priority}" for priority in range(6)}


def _text(value: Any) -> str:
    if isinstance(value, dict):
        return " ".join(f"{key} {_text(item)}" for key, item in value.items())
    if isinstance(value, list):
        return " ".join(_text(item) for item in value)
    return str(value)


def _magnitude(row: dict[str, Any]) -> float:
    """Largest absolute net/debt/bonus USD metric; missing sorts after zero."""
    magnitudes = []
    for key, value in row["measured"].items():
        if key not in {"netUsd", "cleanDebtUsd"} and not key.endswith(("BonusUsd", "DebtUsd")):
            continue
        if value is None or isinstance(value, bool):
            continue
        try:
            number = float(value)
        except (TypeError, ValueError):
            continue
        if math.isfinite(number):
            magnitudes.append(abs(number))
    return max(magnitudes, default=-1)


def build_findings(args: Any = None) -> dict[str, Any]:
    """Build a dated, read-only view without changing any catalog facts."""
    catalog = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    args = args if args is not None else {}
    filters = {key: str(args.get(key, "")) for key in ("q", "priority", "status")}
    filters["q"] = filters["q"].strip()[:200]
    rows = [
        {
            **entry,
            "priority_label": PRIORITIES[entry["priority"]],
            "status_label": STATUSES[entry["status"]],
            "category_label": CATEGORIES.get(entry["category"], entry["category"]),
        }
        for entry in catalog["findings"]
    ]
    # One ordering: priority ascending, largest absolute USD magnitude descending,
    # then stable catalog ID ascending. Missing magnitudes follow measured zero.
    rows.sort(key=lambda row: (row["priority"], -_magnitude(row), row["id"]))
    summary = {
        "total": len(rows),
        "matched": 0,
        "by_priority": {label: sum(row["priority"] == key for row in rows) for key, label in PRIORITIES.items()},
        "by_status": {key: sum(row["status"] == key for row in rows) for key in STATUSES},
    }
    options = {
        "priorities": [{"value": str(key), "label": label} for key, label in PRIORITIES.items()],
        "statuses": [{"value": key, "label": label} for key, label in STATUSES.items()],
    }
    query = filters["q"].casefold()
    matched = [
        row for row in rows
        if (not filters["priority"] or str(row["priority"]) == filters["priority"])
        and (not filters["status"] or row["status"] == filters["status"])
        and (not query or query in _text(row).casefold())
    ]
    summary["matched"] = len(matched)
    return {
        "catalog_as_of": catalog["catalogAsOf"],
        "read_only": True,
        "source_mode": "curated_snapshot",
        "live_checked_at": None,
        "summary": summary,
        "filters": filters,
        "options": options,
        "findings": matched,
        "priority_legend": catalog["priorityLegend"],
        "status_legend": catalog["statusLegend"],
        "notices": [
            catalog["scopeNote"],
            "A negative result is a result. Absence of a route is not absence of analysis.",
        ],
    }
