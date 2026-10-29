"""Curated funding/exit inventory; no chain queries or evidence-file traversal."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


CATALOG_PATH = Path(__file__).with_name("liquidity_catalog.json")
CATEGORIES = {
    "funding": "Atomic funding & capital",
    "credit": "Collateralized credit",
    "swap": "Swap exits",
    "redemption": "Redemptions & vault exits",
    "lp": "LP join / exit studies",
    "delayed": "Delayed exits",
    "coverage": "Coverage & unsupported paths",
}
STATUSES = {
    "implemented": "Implemented",
    "quote_only": "Quote only",
    "discovery_only": "Discovery only",
    "study_only": "Study only",
    "blocked": "Blocked",
    "unsupported": "Unsupported",
}


def _text(value: Any) -> str:
    """Search all displayed facts, including chain names and source annotations."""
    if isinstance(value, dict):
        return " ".join(_text(item) for item in value.values())
    if isinstance(value, list):
        return " ".join(_text(item) for item in value)
    return str(value)


def build_liquidity(args: Any = None) -> dict[str, Any]:
    """Build a dated snapshot from the one bundled, editable JSON catalog."""
    catalog = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    args = args if args is not None else {}
    filters = {key: str(args.get(key, "")) for key in ("q", "chain", "category", "status")}
    filters["q"] = filters["q"].strip()[:200]
    routes = []
    for entry in catalog["routes"]:
        row = {key: value for key, value in entry.items() if key != "atomic_funding"}
        row["category_label"] = CATEGORIES[row["category"]]
        row["status_label"] = STATUSES[row["status"]]
        row["reviewed_at"] = catalog["catalog_as_of"]
        routes.append(row)

    summary = {"total": len(routes), "matched": 0}
    summary.update({status: sum(row["status"] == status for row in routes) for status in STATUSES})
    summary["atomic_funding"] = sum(entry.get("atomic_funding") is True for entry in catalog["routes"])
    chains = {str(chain["id"]): chain["name"] for row in routes for chain in row["chains"]}
    options = {
        "chains": [{"value": value, "label": label} for value, label in sorted(chains.items(), key=lambda item: item[1])],
        "categories": [{"value": value, "label": label} for value, label in CATEGORIES.items()],
        "statuses": [{"value": value, "label": label} for value, label in STATUSES.items()],
    }
    query = filters["q"].casefold()
    matched = [
        row for row in routes
        if (not filters["chain"] or any(str(chain["id"]) == filters["chain"] for chain in row["chains"]))
        and (not filters["category"] or row["category"] == filters["category"])
        and (not filters["status"] or row["status"] == filters["status"])
        and (not query or query in _text(row).casefold())
    ]
    summary["matched"] = len(matched)
    return {
        "catalog_as_of": catalog["catalog_as_of"],
        "read_only": True,
        "source_mode": "curated_snapshot",
        "live_checked_at": None,
        "summary": summary,
        "filters": filters,
        "options": options,
        "routes": matched,
        "notices": catalog["notices"],
        "scan": catalog["scan"],
    }
