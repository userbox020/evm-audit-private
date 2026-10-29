"""Focused fail-closed coverage for the fixed R19 dashboard source."""

from __future__ import annotations

import hashlib
import json

from dashboard.artifacts import ALLOWLIST, MAX_BYTES
from conftest import get


def claims() -> dict:
    return {"status": "REJECT", "profitabilityClaim": False, "routePositive": "unknown", "signedActionJustified": False, "shadowOnly": True, "counterfactual": True, "executionAtomic": False, "fillEvidence": "none"}


def artifact() -> dict:
    economics = {"quantity": "2.000000", "minimumPayoutUsd": "2.000000", "allInCostUsd": "1.500000", "conservativeNetUsd": "0.500000", "returnOnCapitalBps": "3333.333333", "worstLossUsd": "1.500000", "capacityUnits": "2.000000", "legs": [{"analyticalLabel": "BUY YES", "tokenId": "1002", "grossUsd": "0.800000", "feeUsd": "0.000000", "levels": []}, {"analyticalLabel": "BUY NO", "tokenId": "1003", "grossUsd": "0.700000", "feeUsd": "0.000000", "levels": []}], "reserves": {}}
    bundle = {"bundleType": "SAME_CONDITION_PARITY", "bundleId": "1" * 64, "bundleHash": "2" * 64, "marketId": "1", "conditionId": "0x" + "3" * 64, "reasonCode": "r19-positive-numerical-reject-only", "gates": {"CONSERVATIVE_NET_POSITIVE": "PASS", "ACCOUNT_CONFIRMED_FILL": "UNKNOWN"}, "economics": economics, **claims()}
    value = {"schemaVersion": 1, "schema": "r19-public-read-only-structural-scan", "mode": "r19-public-read-only-structural-scan", "asOfMs": 1_800_000, "previousHash": None, "rejectionFunnel": {"discovered": 1, "parityEvaluated": 1}, "rejections": [], "rows": [bundle], "bundles": [bundle], "ladders": [], "actualFills": None, "realizedPnlUsd": None, "reasonCode": "r19-positive-numerical-reject-only", **claims()}
    value["resultHash"] = hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
    return value


def write(root, value: object) -> None:
    target = root / ALLOWLIST["polymarket_r19"]
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(value), encoding="utf8")


def snapshot(client) -> dict:
    response = get(client, "/api/v1/snapshot")
    assert response.status_code == 200
    return response.get_json()["polymarket_r19"]


def test_current_r19_snapshot_is_reject_only_and_contains_no_fake_execution(root, client):
    assert ALLOWLIST["polymarket_r19"] == "reports/monitor/polymarket-r19-monitor.json"
    write(root, artifact())
    value = snapshot(client)
    assert value["availability"] is True
    assert value["status"] == "REJECT"
    assert value["funnel"]["parityEvaluated"] == 1
    assert value["ranking"][0]["bundle_type"] == "SAME_CONDITION_PARITY"
    assert value["ranking"][0]["counterfactual"] is True
    assert value["actual_fills"] is None
    assert value["realized_pnl_usd"] is None
    assert value["route_positive"] == "unknown"


def test_invalid_and_oversize_r19_artifacts_fail_closed_without_fake_values(root, client):
    write(root, {**artifact(), "status": "WATCH"})
    invalid = snapshot(client)
    assert invalid["availability"] is False
    assert invalid["status"] == "REJECT"
    assert invalid["ranking"] == []
    assert invalid["actual_fills"] is None and invalid["realized_pnl_usd"] is None
    target = root / ALLOWLIST["polymarket_r19"]
    target.write_bytes(b"{" + b" " * MAX_BYTES + b"}")
    oversized = snapshot(client)
    assert oversized["availability"] is False
    assert oversized["reason"] == "r19-artifact-unavailable"
