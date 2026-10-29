"""Focused fail-closed coverage for the fixed R20 dashboard source."""

from __future__ import annotations

import hashlib
import json

from dashboard.artifacts import ALLOWLIST, MAX_BYTES
from conftest import get


def claims() -> dict:
    return {"status": "REJECT", "profitabilityClaim": False, "routePositive": "unknown", "signedActionJustified": False, "shadowOnly": True, "counterfactual": True, "executionAtomic": False, "fillEvidence": "none"}


def artifact(with_row: bool = True) -> dict:
    row = {"bundleType": "SAME_CONDITION_MERGE_PARITY", "bundleId": "1" * 64, "marketId": "7", "conditionId": "0x" + "2" * 64, "reasonCode": "r20-authoritative-runtime-call-unknown", "positionDerived": True, "authoritativeTokenBinding": False, "mergeabilityVerified": False, "economics": None, **claims()}
    rows = [row] if with_row else []
    value = {"schemaVersion": 1, "schema": "r20-public-read-only-merge-backed-parity", "mode": "r20-public-read-only-merge-backed-parity", "asOfMs": 1_800_000, "discovery": {}, "rejectionFunnel": {"selected": len(rows), "positionDerived": len(rows), "authoritativeBound": 0, "mergeabilityVerified": 0, "evaluated": len(rows)}, "rows": rows, "bundles": rows, "reasonCode": "r20-authoritative-runtime-call-unknown" if rows else "r20-no-exact-candidate", "actualFills": None, "realizedPnlUsd": None, **claims()}
    value["resultHash"] = hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
    return value


def write(root, value: object) -> None:
    target = root / ALLOWLIST["polymarket_r20"]
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(value), encoding="utf8")


def snapshot(client) -> dict:
    response = get(client, "/api/v1/snapshot")
    assert response.status_code == 200
    return response.get_json()["polymarket_r20"]


def test_current_r20_snapshot_exposes_merge_gates_without_execution_claims(root, client):
    assert ALLOWLIST["polymarket_r20"] == "reports/monitor/polymarket-r20-monitor.json"
    write(root, artifact())
    value = snapshot(client)
    assert value["availability"] is True
    assert value["status"] == "REJECT"
    assert value["ranking"][0]["mergeability_state"] == "UNVERIFIED"
    assert value["merge_identity"] == {"position_derived": True, "authoritative_token_binding": False}
    assert value["economics"] is None
    assert value["actual_fills"] is None and value["realized_pnl_usd"] is None
    assert value["profitability_claim"] is False and value["route_positive"] == "unknown"


def test_no_candidate_r20_snapshot_is_available_reject_and_empty(root, client):
    write(root, artifact(False))
    value = snapshot(client)
    assert value["availability"] is True
    assert value["status"] == "REJECT"
    assert value["reason"] == "r20-no-exact-candidate"
    assert value["ranking"] == []
    assert value["mergeability_state"] == "UNKNOWN"
    assert value["economics"] is None


def test_malformed_and_oversize_r20_artifacts_fail_closed(root, client):
    bad = artifact()
    bad["rows"][0]["status"] = "WATCH"
    write(root, bad)
    invalid = snapshot(client)
    assert invalid["availability"] is False
    assert invalid["status"] == "REJECT"
    assert invalid["ranking"] == [] and invalid["economics"] is None
    target = root / ALLOWLIST["polymarket_r20"]
    target.write_bytes(b"{" + b" " * MAX_BYTES + b"}")
    oversized = snapshot(client)
    assert oversized["availability"] is False
    assert oversized["reason"] == "r20-artifact-unavailable"
    assert oversized["actual_fills"] is None and oversized["realized_pnl_usd"] is None
