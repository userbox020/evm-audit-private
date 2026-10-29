"""Focused fail-closed coverage for the R17 dashboard adapter."""

from __future__ import annotations

import hashlib
import json

from dashboard.artifacts import ALLOWLIST, MAX_BYTES
from conftest import get


def artifact() -> dict:
    value = {
        "schemaVersion": 1,
        "schema": "r17-public-read-only-monitor",
        "mode": "public",
        "generatedAtMs": 1_000_000,
        "invocationKey": "1" * 64,
        "schedule": {"scheduleKey": "test", "intervalMs": 1000, "intervals": 1},
        "intervalKeys": ["2" * 64],
        "sourceRuns": [],
        "scanCounts": {"intervals": 1, "sourceScans": 0, "r15": 0, "r16": 0},
        "rejectionFunnel": {
            "sourceScans": 0,
            "rowsSeen": 0,
            "exactCandidates": 0,
            "rankingInputs": 0,
            "completeEconomics": 0,
            "positiveConservativeNet": 0,
            "rankedNumericalRejects": 0,
            "rejected": 0,
        },
        "ranking": [],
        "killGates": ["SETTLEMENT_COMPLETE"],
        "reasonCode": "r17-no-positive-complete-ranking",
        "journalHeadHash": "3" * 64,
        "positiveNumericalEstimateDoesNotEstablishProfitFillOrAction": True,
        "actualFills": None,
        "realizedPnlUsd": None,
        "status": "REJECT",
        "highestStatus": "REJECT",
        "profitabilityClaim": False,
        "routePositive": "unknown",
        "signedActionJustified": False,
        "shadowOnly": True,
    }
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    value["artifactHash"] = hashlib.sha256(encoded).hexdigest()
    return value


def write_r17(root, value: object) -> None:
    path = root / ALLOWLIST["polymarket_r17"]
    path.write_text(json.dumps(value), encoding="utf8")


def snapshot(client) -> dict:
    response = get(client, "/api/v1/snapshot")
    assert response.status_code == 200
    return response.get_json()["polymarket_r17"]


def test_r17_snapshot_available_and_missing_is_explicit_reject(root, client):
    assert ALLOWLIST["polymarket_r17"] == "reports/monitor/polymarket-r17-monitor.json"
    missing = snapshot(client)
    assert missing["available"] is False
    assert missing["status"] == "REJECT"
    assert missing["reason"] == "r17-artifact-unavailable"
    assert missing["economics"]["conservative_expected_net_usd"] is None
    assert missing["profitability_claim"] is False
    assert missing["route_positive"] == "unknown"

    write_r17(root, artifact())
    available = snapshot(client)
    assert available["available"] is True
    assert available["status"] == "REJECT"
    assert available["ranking"] == []
    assert available["actual_fills"] is None
    assert available["realized_pnl_usd"] is None


def test_r17_malformed_and_oversize_artifacts_fail_closed(root, client):
    write_r17(root, {"schema": "r17-public-read-only-monitor", "status": "WATCH"})
    malformed = snapshot(client)
    assert malformed["available"] is False
    assert malformed["status"] == "REJECT"
    assert malformed["ranking"] == []

    path = root / ALLOWLIST["polymarket_r17"]
    path.write_bytes(b"{" + b" " * MAX_BYTES + b"}")
    oversized = snapshot(client)
    assert oversized["available"] is False
    assert oversized["reason"] == "r17-artifact-unavailable"
    assert all(value is None for value in oversized["economics"].values())
