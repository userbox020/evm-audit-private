"""Fixture-only coverage for the local dashboard boundary and adapters."""

from __future__ import annotations

import json
import os
import re
import threading
import time
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
from datetime import datetime, timezone

import pytest
from werkzeug.test import EnvironBuilder

import dashboard.artifacts as artifact_module
import dashboard.wallets as wallets_module
import dashboard.execution as execution_module
from dashboard.artifacts import MAX_BYTES, MAX_EVENTS, MAX_LINE, ArtifactReader
from dashboard.catalog import CATALOG
from dashboard.normalize import freshness, safe_value, severity, timestamp
from dashboard.service import (
    aave_v3_arbitrum_config_oracle_events_valid,
    aave_v3_borrower_universe_valid,
    aave_v3_liquidation_quotes_valid,
    aave_v3_liquidation_watch_valid,
    aave_v3_trigger_readiness_valid,
    base_paper_valid,
    current_audit_state_valid,
    etherfi_debtmanager_profit_trigger_valid,
    euler_l_surface_valid,
    euler_l_valuation_valid,
    euler_l_watch_valid,
    lista_auction_incentive_profit_trigger_valid,
    morpho_blue_liquidatable_valid,
    morpho_ws_status_valid,
    official_deployed_delta_sentinel_valid,
    snapshot,
    stex_profit_trigger_valid,
    trigger_watch_scheduler_valid,
)
from dashboard.ops import (
    approver_registry_valid,
    autopilot_state_valid,
    autopilot_status_valid,
    dispatcher_status_valid,
    profit_trigger_watch_valid,
    trigger_coverage_valid,
    wallet_balances_valid,
    watchdog_status_valid,
)

from conftest import get, post_json

SENTINEL_REPOSITORIES = (
    ("silo-finance/silo-contracts-v3", "implementation"),
    ("VenusProtocol/venus-protocol", "implementation"),
    ("aave-dao/aave-v3-origin", "implementation"),
    ("aave-dao/aave-governance-v3", "governance"),
    ("aave-dao/aave-address-book", "deployment-registry"),
    ("morpho-org/morpho-blue", "implementation"),
    ("yearn/yearn-vaults-v3", "implementation"),
    ("etherfi-protocol/cash-v3", "implementation"),
    ("lista-dao/lista-dao-contracts", "historical"),
    ("AladdinDAO/fx-protocol-contracts", "implementation"),
    ("compound-finance/comet", "implementation"),
    ("Instadapp/fluid-contracts-public", "implementation"),
    ("curvefi/curve-core", "deployment-registry"),
    ("basalt-vault/basalt-vault", "implementation"),
    ("Enhanced-Finance/contracts", "implementation"),
    ("vetro-protocol/vetro-contracts", "implementation"),
    ("basedollar/basedollar", "implementation"),
)
AAVE_V3_ARBITRUM_EVENT_NAMES = (
    "ReserveInitialized", "ReserveBorrowing", "CollateralConfigurationChanged", "ReserveActive", "ReserveFrozen", "ReservePaused",
    "BorrowCapChanged", "SupplyCapChanged", "AssetCollateralInEModeChanged", "AssetBorrowableInEModeChanged", "AssetLtvzeroInEModeChanged",
    "EModeCategoryAdded", "EModeCategoryIsolationChanged", "ReserveInterestRateStrategyChanged", "ReserveInterestRateDataChanged", "ATokenUpgraded",
    "VariableDebtTokenUpgraded", "AssetSourceUpdated", "PriceOracleUpdated", "PoolUpdated", "PoolConfiguratorUpdated",
)


def write(root, relative, value):
    (root / relative).write_text(json.dumps(value), encoding="utf8")


def monitor(data, ident):
    return next(item for item in data["monitors"] if item["id"] == ident)


def state(root, conditions):
    write(root, "reports/monitor/state.json", {"conditions": conditions})


def current_audit_state(root):
    value = {
        "schema": "current-audit-state/v1",
        "generatedAt": "2026-10-11T00:00:00Z",
        "overall": "NO_CURRENT_NET_POSITIVE_ROUTE",
        "routePositive": False,
        "executableNow": False,
        "signedActionJustified": False,
        "candidates": [
            {"name": "STEX", "status": "WATCH_TRIGGER", "detail": "Observed paused with zero pending."},
            {"name": "Mellow", "status": "CLOSED_DEPLOYMENT_UNBOUND", "detail": "Deployment is unbound."},
            {"name": "Aave v3.7", "status": "CLOSED_FIXED", "detail": "Fixed."},
            {"name": "Yearn v3.0.4", "status": "CLOSED_PRIVILEGED", "detail": "Privileged."},
            {"name": "40 Acres", "status": "CLOSED_REFUTED", "detail": "Refuted."},
            {"name": "EtherFi DebtManager", "status": "HISTORICAL_WATCH_CURRENT_NEGATIVE", "detail": "Current economics are negative."},
        ],
        "nextMove": {
            "primary": "Run a lightweight STEX primary trigger check.",
            "secondary": "Then run a lightweight EtherFi secondary trigger check.",
            "forkCondition": "Use a keyless fork only after a positive trigger.",
        },
    }
    write(root, "reports/monitor/current-audit-state.json", value)
    return value


def stex_profit_trigger(root, *, paused=False, positive_gap=True, economics_raw=None):
    economics_raw = economics_raw or {}
    value = {
        "schema": "stex-profit-trigger/v1",
        "generatedAt": "1970-01-01T00:16:40Z",
        "chainId": 999,
        "evidenceClass": "SCREENING_ONLY_OFFICIAL_LATEST_REORGABLE",
        "blockWindow": {
            "before": {"number": "100", "hash": "0x" + "1" * 64, "timestamp": "999"},
            "after": {"number": "101", "hash": "0x" + "2" * 64, "timestamp": "1000"},
            "stable": True,
        },
        "trigger": {
            "status": "TRIGGERED" if positive_gap else "NO_TRIGGER",
            "paused": paused,
            "pendingCount": 2,
            "activeRows": 1,
            "positiveGap": positive_gap,
            "totalGapRaw": "42",
        },
        "requests": [{"id": "1", "kHYPEAmountRaw": "2", "fixedHypeAmountRaw": "3", "currentHypeValueRaw": "4", "gapRaw": "1"}],
        "liquidity": {"status": "UNKNOWN", "whypeBalanceRaw": None, "whypeReserveRaw": None, "liabilityHaircutRaw": None, "conservativeAvailableRaw": None},
        "economics": {"status": "UNKNOWN", "capitalRaw": economics_raw.get("capitalRaw"), "grossCeilingRaw": economics_raw.get("grossCeilingRaw"), "feesRaw": economics_raw.get("feesRaw"), "gasRaw": economics_raw.get("gasRaw"), "carryRaw": economics_raw.get("carryRaw"), "exitHaircutRaw": economics_raw.get("exitHaircutRaw"), "uncertaintyRaw": economics_raw.get("uncertaintyRaw"), "conservativeNetRaw": economics_raw.get("conservativeNetRaw"), "netBps": economics_raw.get("netBps"), "capacityRaw": economics_raw.get("capacityRaw")},
        "gates": {"triggerObserved": "PASS" if positive_gap else "FAIL", "sourceCurrent": "PASS", "runtimeReachability": "UNKNOWN", "economicsComplete": "UNKNOWN", "liquidityExit": "UNKNOWN", "conservativeNetPositive": "UNKNOWN", "keylessForkJustified": "UNKNOWN"},
        "safety": {"networkCalls": 1, "automaticRetries": 0, "transactions": 0, "signing": False, "broadcast": False},
    }
    write(root, "reports/monitor/stex-profit-trigger.json", value)
    return value


def stex_incomplete_profit_trigger(root):
    value = stex_profit_trigger(root)
    value["blockWindow"] = {
        "before": {"number": None, "hash": None, "timestamp": None},
        "after": {"number": None, "hash": None, "timestamp": None},
        "stable": None,
    }
    value["trigger"] = {"status": "INCOMPLETE", "paused": None, "pendingCount": None, "activeRows": None, "positiveGap": None, "totalGapRaw": None}
    value["requests"] = []
    value["liquidity"] = {"status": "NOT_RUN", "whypeBalanceRaw": None, "whypeReserveRaw": None, "liabilityHaircutRaw": None, "conservativeAvailableRaw": None}
    value["economics"] = {"status": "NOT_RUN", "capitalRaw": None, "grossCeilingRaw": None, "feesRaw": None, "gasRaw": None, "carryRaw": None, "exitHaircutRaw": None, "uncertaintyRaw": None, "conservativeNetRaw": None, "netBps": None, "capacityRaw": None}
    write(root, "reports/monitor/stex-profit-trigger.json", value)
    return value


def stex_partial_incomplete_profit_trigger(root, *, generated_at="2026-08-28T23:56:20.067Z"):
    value = stex_incomplete_profit_trigger(root)
    value["generatedAt"] = generated_at
    value["blockWindow"] = {
        "before": {"number": "44788412", "hash": "0x" + "a" * 64, "timestamp": "1788310408"},
        "after": {"number": None, "hash": None, "timestamp": None},
        "stable": None,
    }
    value["trigger"] = {
        "status": "INCOMPLETE", "paused": True, "pendingCount": None,
        "activeRows": 0, "positiveGap": False, "totalGapRaw": "0",
    }
    write(root, "reports/monitor/stex-profit-trigger.json", value)
    return value


def etherfi_profit_trigger(root, *, complete=False, positive=False):
    zero = "0"
    value = {
        "schema": "etherfi-debtmanager-profit-trigger/v1",
        "generatedAt": "2026-08-28T16:53:02.388Z",
        "chainId": 10,
        "evidenceClass": "FINALIZED_MULTI_FAMILY_READ_ONLY",
        "pin": {"number": "0" if not complete else "100", "hash": "0x" + "0" * 64, "timestamp": "0" if not complete else "1000", "finalized": True, "headerFamilies": 0 if not complete else 2, "stateFamilies": 0 if not complete else 2},
        "runtime": {"implementation": "0x" + "1" * 40, "proxyRuntimeHash": "0x" + "2" * 64, "implementationRuntimeHash": "0x" + "3" * 64, "changedFromHistorical": False, "exactCurrentSourceBound": complete},
        "paused": False,
        "pools": [
            {"token": "0x" + "4" * 40, "decimals": 6, "assetsRaw": zero if not complete else "100", "sharesRaw": zero if not complete else "100", "liquidRaw": zero if not complete else "80", "minSharesRaw": zero if not complete else "1", "zeroShareMaxRaw": None if not complete else "0", "recentSupplyEventCount": 0 if not complete else 1, "recentNonDustSupply": False if not complete else True, "recentWindowFrom": "0" if not complete else "900", "recentWindowTo": "0" if not complete else "1000"},
            {"token": "0x" + "5" * 40, "decimals": 6, "assetsRaw": zero if not complete else "200", "sharesRaw": zero if not complete else "200", "liquidRaw": zero if not complete else "160", "minSharesRaw": zero if not complete else "1", "zeroShareMaxRaw": None if not complete else "0", "recentSupplyEventCount": 0 if not complete else 1, "recentNonDustSupply": False if not complete else True, "recentWindowFrom": "0" if not complete else "900", "recentWindowTo": "0" if not complete else "1000"},
        ],
        "trigger": {"status": "INCOMPLETE" if not complete else "TRIGGERED", "positive": positive, "reason": "EVIDENCE_INCOMPLETE" if not complete else "POSITIVE_FLOW"},
        "economics": {"status": "NOT_RUN" if not complete else "NEGATIVE", "capitalRaw": None if not complete else "10", "grossCeilingRaw": None if not complete else "9", "gasRaw": None if not complete else "1", "l1FeeRaw": None if not complete else "0", "carryRaw": None if not complete else "0", "acquisitionUnwindRaw": None if not complete else "0", "competitionRaw": None if not complete else "0", "uncertaintyRaw": None if not complete else "0", "conservativeNetRaw": None if not complete else "0", "netBps": None if not complete else "0", "capacityRaw": None if not complete else "80"},
        "gates": {"sourceCurrent": "UNKNOWN" if not complete else "PASS", "runtimeBound": "UNKNOWN" if not complete else "PASS", "nonDustFlow": "UNKNOWN" if not complete else "PASS", "feasibleCapital": "UNKNOWN" if not complete else "PASS", "liquidExit": "UNKNOWN" if not complete else "PASS", "economicsComplete": "UNKNOWN" if not complete else "PASS", "conservativeNetPositive": "UNKNOWN" if not complete else "FAIL", "keylessForkJustified": "UNKNOWN" if not complete else "FAIL"},
        "safety": {"inventoryReadInMemoryOnly": True, "networkCalls": 5, "automaticRetries": 0, "transactions": 0, "signing": False, "broadcast": False},
    }
    write(root, "reports/monitor/etherfi-debtmanager-profit-trigger.json", value)
    return value


def etherfi_profit_trigger_v2(root, *, disagreement=False):
    value = etherfi_profit_trigger(root)
    value["schema"] = "etherfi-debtmanager-profit-trigger/v2"
    value["diagnostics"] = {
        "candidatesConsidered": 2, "qualificationAttempts": 2, "chainMatches": 2,
        "finalizedQualified": 2, "pinConsensusFamilies": 2, "stateAttempts": 2,
        "stateSuccesses": 2 if disagreement else 1, "stateConsensusFamilies": 1,
        "stateDistinctGroups": 2 if disagreement else 1, "flowAttempts": 2,
        "flowSuccesses": 2, "flowConsensusFamilies": 1, "flowDistinctGroups": 1,
        "failurePhase": "STATE", "failureCode": "STATE_CONSENSUS_UNAVAILABLE",
    }
    write(root, "reports/monitor/etherfi-debtmanager-profit-trigger.json", value)
    return value


def lista_profit_trigger(root, *, positive_gross=False):
    value = {
        "schema": "lista-auction-incentive-profit-trigger/v1", "generatedAt": "2026-08-28T17:10:39.455Z", "chainId": 56, "evidenceClass": "FINALIZED_MULTI_FAMILY_READ_ONLY",
        "pin": {"number": "118613229", "hash": "0x" + "a" * 64, "stateRoot": "0x" + "b" * 64, "timestamp": "1787937040", "finalized": True, "headerFamilies": 2, "stateFamilies": 2},
        "runtime": {"interactionImplementation": "0x" + "1" * 40, "clipImplementation": "0x" + "2" * 40, "interactionImplementationRuntimeHash": "0x" + "3" * 64, "clipImplementationRuntimeHash": "0x" + "4" * 64, "changedFromBaseline": False, "sourceRuntimeAttested": False},
        "controls": {"auctionWhitelistModeRaw": "1", "publicAuctionCaller": False, "stoppedRaw": "0", "tipRad": "5000000000000000000000000000000000000000000000", "chipWad": "0", "chostRad": "0"},
        "auctions": {"activeCount": 1 if positive_gross else 0, "scannedCount": 1 if positive_gross else 0, "needsRedoCount": 1 if positive_gross else 0, "rewardEligibleRedoCount": 1 if positive_gross else 0, "scanComplete": True},
        "economics": {"status": "POSITIVE_GROSS_ONLY" if positive_gross else "NOT_RUN", "maximumGrossRewardRad": "5" if positive_gross else "0", "maximumGrossRewardLisUSDRaw": "5" if positive_gross else "0", "gasRaw": "1" if positive_gross else None, "l1FeeRaw": "0" if positive_gross else None, "competitionRaw": "0" if positive_gross else None, "uncertaintyRaw": "0" if positive_gross else None, "conservativeNetRaw": None, "netBps": None},
        "trigger": {"status": "POSITIVE_GROSS_FORK_WARRANTED" if positive_gross else "BLOCKED_WHITELIST", "positive": positive_gross, "reason": "POSITIVE_GROSS_ONLY" if positive_gross else "AUCTION_CALLER_NOT_PUBLIC"},
        "gates": {"sourceCurrent": "UNKNOWN", "runtimeBaseline": "PASS", "publicCaller": "FAIL", "activeAuction": "PASS" if positive_gross else "FAIL", "eligibleRedo": "PASS" if positive_gross else "FAIL", "grossPositive": "PASS" if positive_gross else "FAIL", "economicsComplete": "UNKNOWN", "conservativeNetPositive": "UNKNOWN", "keylessForkJustified": "FAIL"},
        "safety": {"inventoryReadInMemoryOnly": True, "networkCalls": 32, "automaticRetries": 0, "transactions": 0, "signing": False, "broadcast": False, "borrowerScanning": False, "auctionIdsPersisted": False},
    }
    write(root, "reports/monitor/lista-auction-incentive-profit-trigger.json", value)
    return value


def aave_v3_arbitrum_events(root, generated_at, *, outcome="COMPLETE_ZERO_EVENTS"):
    incomplete, survivor = outcome == "INCOMPLETE", outcome == "EVENT_SURVIVOR_NO_ROUTE"
    value = {
        "schema": "aave-v3-arbitrum-config-oracle-events/v2", "generatedAt": generated_at,
        "status": "INCOMPLETE" if incomplete else "EVENT_SURVIVOR" if survivor else "COMPLETE", "outcome": outcome,
        "phase": "QUALIFICATION" if incomplete else "NONE", "code": "TWO_FAMILIES_UNAVAILABLE" if incomplete else "NONE",
        "chainId": 42161, "eventOnly": True, "sourcePinned": True,
        "qualification": {"anonymousCandidateCount": 2, "anonymousChainMatchedCount": 2, "anonymousLogQualifiedCount": 1 if incomplete else 2, "selectedFamilyCount": 0 if incomplete else 2},
        "blockRange": {"fromBlock": None, "toBlock": None} if incomplete else {"fromBlock": "100", "toBlock": "101"},
        "reads": {"count": 6 if incomplete else 16, "maximum": 40, "retries": 0},
        "lastCompleteCursor": None if incomplete else {"fromBlock": "100", "toBlock": "101"},
        "continuation": {"mode": "INCOMPLETE", "previousToBlock": None, "nextFromBlock": None, "cursorAdvanced": False, "backlogRemaining": None, "blocksScanned": 0} if incomplete else {"mode": "FIRST_WINDOW", "previousToBlock": None, "nextFromBlock": "102", "cursorAdvanced": True, "backlogRemaining": False, "blocksScanned": 2},
        "route": {"routeObserved": False, "routePositive": "n/a", "stateInterpretationPerformed": False},
        "safety": {"readOnlyRpc": True, "transactions": False, "signing": False, "broadcast": False, "walletAccess": False, "productionMutation": False},
    }
    if not incomplete:
        value["eventCount"] = 1 if survivor else 0
        value["categoryCounts"] = {name: int(survivor and name == "ReserveBorrowing") for name in AAVE_V3_ARBITRUM_EVENT_NAMES}
        value["events"] = [{"category": "ReserveBorrowing", "blockNumber": "101", "transactionIndex": "1", "logIndex": "1", "commitment": "sha256-" + "a" * 43}] if survivor else []
    write(root, "reports/monitor/aave-v3-arbitrum-config-oracle-events.json", value)
    return value


def scheduler_state(root, stx_at, etherfi_at, lista_at, *, running=True, status="PASS", rotation=None, aave_outcome="COMPLETE_ZERO_EVENTS"):
    aave = aave_v3_arbitrum_events(root, lista_at, outcome=aave_outcome)
    aave_row_status = "FAILED" if aave_outcome == "INCOMPLETE" else "PASS"
    aave_reason = aave["code"] if aave_outcome == "INCOMPLETE" else None
    value = {"schema": "trigger-watch-scheduler/v1", "generatedAt": "2026-08-28T23:56:25.067Z", "cadenceSeconds": 900, "discoveryCadenceSeconds": 21600, "running": running, "pid": 1, "startedAt": "2026-08-28T20:11:14.371Z", "cycle": {"sequence": 16, "startedAt": "2026-08-28T23:56:14.548Z", "completedAt": "2026-08-28T23:56:25.067Z", "status": status}, "producers": [{"id": "valantis-stex", "status": "PASS", "exitCode": 0, "durationMs": 1, "artifactPath": "reports/monitor/stex-profit-trigger.json", "triggerStatus": "TRIGGERED", "triggerReason": None, "generatedAt": stx_at}, {"id": "etherfi-debtmanager", "status": "PASS", "exitCode": 0, "durationMs": 1, "artifactPath": "reports/monitor/etherfi-debtmanager-profit-trigger.json", "triggerStatus": "INCOMPLETE", "triggerReason": "EVIDENCE_INCOMPLETE", "generatedAt": etherfi_at}, {"id": "lista-auction-incentive", "status": "PASS", "exitCode": 0, "durationMs": 1, "artifactPath": "reports/monitor/lista-auction-incentive-profit-trigger.json", "triggerStatus": "BLOCKED_WHITELIST", "triggerReason": "AUCTION_CALLER_NOT_PUBLIC", "generatedAt": lista_at}, {"id": "aave-v3-arbitrum-config-oracle-events", "status": aave_row_status, "exitCode": 1 if aave_outcome == "INCOMPLETE" else 0, "durationMs": 1, "artifactPath": "reports/monitor/aave-v3-arbitrum-config-oracle-events.json", "triggerStatus": aave_outcome, "triggerReason": aave_reason, "generatedAt": aave["generatedAt"]}], "discovery": {"status": "NOT_DUE", "lastAttemptAt": "2026-08-28T20:11:25.198Z", "nextDueAt": "2026-08-29T02:11:25.198Z", "exitCode": None, "durationMs": 0, "artifactPath": "reports/monitor/official-deployed-delta-sentinel.json"}, "safety": {"localOnly": True, "sequential": True, "overlap": False, "automaticRetries": 0, "transactionsInitiatedByScheduler": 0, "signing": False, "broadcast": False}}
    if rotation is not None:
        value["capabilityRotation"] = rotation
    write(root, "reports/monitor/trigger-watch-scheduler.json", value)
    return value


def delta_sentinel(root, *, status="incomplete"):
    rows = []
    for repository_id, source_class in SENTINEL_REPOSITORIES:
        url = f"https://github.com/{repository_id}"
        evidence = [f"https://api.github.com/repos/{repository_id}"]
        rows.append({"id": repository_id, "officialUrl": url, "defaultBranch": "main", "sourceClass": source_class, "observedHeadSha": "a" * 40, "previousHeadSha": None, "releaseIds": [], "tags": [], "configuredManifestPaths": ["contracts/"], "changedManifestPaths": [], "changeHints": [], "chainTextHints": [], "evidenceUrls": evidence, "etagByUrl": {evidence[0]: 'W/"secret-etag"'}, "pollStatus": "incomplete" if status == "incomplete" else status, "observedAt": "2026-08-28T20:11:25.252Z"})
    value = {"schema": "official-deployed-delta-sentinel/v1", "generatedAt": "2026-08-28T20:11:25.252Z", "runId": "2026-08-28_run-1", "status": status, "baselineCreated": False, "repositories": rows}
    write(root, "reports/monitor/official-deployed-delta-sentinel.json", value)
    return value


def aave_v4_state(root, *, at=1_000, source_health="OK", summary=None, coverage=None):
    generated_at = datetime.fromtimestamp(at, timezone.utc).isoformat().replace("+00:00", "Z")
    summary_value = {
        "activeBorrowers": 10,
        "nearLiquidation": 0,
        "liquidatable": 0,
        "routePositive": 0,
        "signedActionJustified": False,
        "sampleOnly": False,
        "observational": False,
        "sampleTelemetryUsable": True,
        "triggerRows": 0,
        "materialTriggerRows": 0,
        "materialRows": 0,
        "quoteRequiredRows": 0,
        "topHealthFactor": 1.2,
        "topBpsToLiquidation": 2_000,
        "topDebtUsd": 100,
    }
    summary_value.update(summary or {})
    exhaustive_proof = {
        "type": "V4_BOUND_REGISTRY_AND_FULL_BORROW_HISTORY",
        "exact": True,
        "evidence": "aave-v4-registry@1",
    }
    reserve_links = [
        {
            "hubAddress": "0x0000000000000000000000000000000000000011",
            "assetId": 0,
            "spoke": "0x0000000000000000000000000000000000000001",
            "reserveId": 0,
        },
        {
            "hubAddress": "0x0000000000000000000000000000000000000012",
            "assetId": 1,
            "spoke": "0x0000000000000000000000000000000000000001",
            "reserveId": 1,
        },
        {
            "hubAddress": "0x0000000000000000000000000000000000000011",
            "assetId": 1,
            "spoke": "0x0000000000000000000000000000000000000002",
            "reserveId": 0,
        },
    ]
    coverage_value = {
        "schema": "aave-source-coverage/v1",
        "schemaVersion": 1,
        "protocolVersion": "V4",
        "coverageKind": "monitor",
        "producerKind": "monitor",
        "classification": "EXHAUSTIVE_COMPLETE",
        "complete": True,
        "sampleComplete": True,
        "promotionEligible": False,
        "promotionClosure": {
            "eligible": False,
            "routePositive": False,
            "executableNow": False,
            "signedActionJustified": False,
        },
        "exhaustiveProof": exhaustive_proof,
        "proof": deepcopy(exhaustive_proof),
        "observedRange": {"fromBlock": 0, "toBlock": 100},
        "historyScope": "GENESIS_TO_TIP",
        "historyStartBound": None,
        "fullHistoryProven": True,
        "topologyGeneratedAt": generated_at,
        "topologyAgeMs": 0,
        "topologyRefreshAttempted": False,
        "topologyRefreshOk": True,
        "topologySourceComplete": True,
        "topologySourceSampleComplete": True,
        "topologyUniverse": {
            "type": "DECLARED_STATIC_HUB_SET",
            "bound": True,
            "registry": "aave-v4-registry",
            "version": "1",
        },
        "spokeReserveLinks": [
            {
                "spoke": "0x0000000000000000000000000000000000000001",
                "expected": 2,
                "observed": 2,
                "consumed": 2,
                "cap": 80,
                "wasTruncated": False,
                "links": deepcopy(reserve_links[:2]),
            },
            {
                "spoke": "0x0000000000000000000000000000000000000002",
                "expected": 1,
                "observed": 1,
                "consumed": 1,
                "cap": 80,
                "wasTruncated": False,
                "links": deepcopy(reserve_links[2:]),
            },
        ],
        "consumedReserveLinks": deepcopy(reserve_links),
        "reserveLinksExpected": 3,
        "reserveLinksObserved": 3,
        "reserveLinksConsumed": 3,
        "reserveLinksCap": 160,
        "reserveLinksTruncated": False,
        "chainsExpected": 1,
        "chainsObserved": 1,
        "spokesExpected": 2,
        "spokesObserved": 2,
        "excludedSpokes": [],
        "spokeFilteringApplied": False,
        "logChunksAttempted": 1,
        "logChunksSucceeded": 1,
        "logChunksFailed": 0,
        "discoveredBorrowers": 10,
        "checkedBorrowers": 10,
        "accountReadsAttempted": 10,
        "accountReadsSucceeded": 10,
        "accountReadsFailed": 0,
        "reserveReadsAttempted": 1,
        "reserveReadsSucceeded": 1,
        "reserveReadsFailed": 0,
        "stateReadsAttempted": 11,
        "stateReadsSucceeded": 11,
        "stateReadsFailed": 0,
        "truncationLimit": 20,
        "wasTruncated": False,
        "errors": [],
    }
    coverage_value.update(coverage or {})
    value = {
        "schema": "aave-v4-liquidation-watch/v1",
        "generatedAt": generated_at,
        "scanner": "tools/watch-aave-v4-liquidation-triggers.js",
        "sourceScanner": "tools/scan-aave-v4-spoke-borrowers.js",
        "sourceArtifact": "reports/raw/fast/aave-v4-spoke-borrowers.json",
        "source": {
            "scanner": "tools/scan-aave-v4-spoke-borrowers.js",
            "artifact": "reports/raw/fast/aave-v4-spoke-borrowers.json",
        },
        "scope": "Read-only Aave V4 near-liquidation trigger watcher",
        "classification": coverage_value["classification"],
        "complete": coverage_value["complete"],
        "blocker": None,
        "sourceCoverage": coverage_value,
        "sourceHealth": source_health,
        "safety": {
            "rpcInventoryRead": False,
            "rpcUrlsStored": False,
            "signedActions": False,
            "exploitExecuteCalls": False,
            "signedActionJustified": False,
            "routePositive": False,
            "executableNow": False,
        },
        "latest": {
            "generatedAt": generated_at,
            "sourceGeneratedAt": generated_at,
            "sourceScanner": "tools/scan-aave-v4-spoke-borrowers.js",
            "sourceArtifact": "reports/raw/fast/aave-v4-spoke-borrowers.json",
            "sourceHealth": source_health,
            "classification": coverage_value["classification"],
            "complete": coverage_value["complete"],
            "blocker": None,
            "sourceCoverage": coverage_value,
            "summary": summary_value,
            "topRows": [],
            "closestRows": [],
            "profitRankedRows": [],
            "triggerRows": [],
            "materialTriggerRows": [],
            "quoteRequiredRows": [],
        },
        "history": [],
    }
    write(root, "reports/raw/fast/aave-v4-liquidation-watch.json", value)
    return value


def research_watch_state(root, *, disposition="SCHEDULED", review_at="2026-08-27T00:00:00Z", status="COMPLETE"):
    entry = {
        "id": "morpho-post-27aug-review",
        "protocol": "Morpho PT post-27AUG",
        "disposition": disposition,
        "trigger": "A human starts a read-only re-evaluation.",
        "reason": "No automatic switch and no route claim.",
        "gates": {"runtimeBound": "unknown", "conservativeNetPositive": "unknown"},
        "routePositive": "unknown",
        "executableNow": "unknown",
        "signedActionJustified": False,
        "status": status,
        "effectiveDisposition": disposition if status == "COMPLETE" else "INCOMPLETE",
        "sources": [{"path": "reports/source.md", "exists": status == "COMPLETE", "mtime": 1_000 if status == "COMPLETE" else None}],
    }
    if disposition == "SCHEDULED":
        entry["reviewAt"] = review_at
    value = {
        "schema": "monitor-research-watch/v1",
        "generatedAt": 1_000,
        "entries": [entry],
        "safety": {"readOnly": True, "networkAccess": False, "execution": False, "signedActions": False},
    }
    write(root, "reports/monitor/research-watch-state.json", value)
    return value


def venus_state(root, *, attempt=1_000, statuses=None, chain_ids=None, interval=3600):
    statuses = statuses or {"bnb": "CLEAR", "ethereum": "CLEAR", "arbitrum": "CLEAR"}
    chain_ids = chain_ids or {"bnb": 56, "ethereum": 1, "arbitrum": 42161}
    chains = {}
    for key in ("bnb", "ethereum", "arbitrum"):
        status = statuses[key]
        categories = ["DISTRIBUTION"] if status == "DRIFT" else []
        successful = None if status == "ERROR" else {
            "at": attempt,
            "status": status,
            "blockNumber": 11,
            "blockHash": "0x" + "3" * 64,
            "digest": "0x" + "4" * 64,
            "driftCategories": categories,
        }
        chains[key] = {
            "chainId": chain_ids[key],
            "name": key,
            "status": status,
            "attemptAt": attempt,
            "lastSuccessfulAt": None if status == "ERROR" else attempt,
            "lastSuccessfulObservation": successful,
            "unresolvedDrift": successful if status == "DRIFT" else None,
            "baseline": {"blockNumber": 10, "blockHash": "0x" + "1" * 64, "digest": "0x" + "2" * 64},
            "current": None if status == "ERROR" else {"blockNumber": 11, "blockHash": "0x" + "3" * 64, "digest": "0x" + "4" * 64},
            "driftCategories": categories,
            "errorClass": "CURRENT_READ_FAILED" if status == "ERROR" else None,
        }
    value = {
        "schema": "venus-psr-state/v1",
        "attemptAt": attempt,
        "status": "ERROR" if all(value == "ERROR" for value in statuses.values()) else (
            "DEGRADED" if "ERROR" in statuses.values() else (
                "DRIFT" if "DRIFT" in statuses.values() else "CLEAR"
            )
        ),
        "intervalSeconds": interval,
        "chains": chains,
        "readOnly": True,
        "upstreamTransactions": 0,
        "signedActionJustified": False,
        "providerMaterialAbsent": True,
    }
    write(root, "reports/monitor/venus-psr-state.json", value)
    return value


def ostium_artifacts(
    root,
    *,
    deployment_time=1_000,
    settlement_time=1_000,
    deployment_pin_time=1_000,
    settlement_pin_time=1_000,
    deployment_block=7,
    settlement_block=7,
    block_hash="hash",
    settlement_hash=None,
    chain_id="42161",
    eligible=False,
    runtime_compatible=False,
    profit_claim="NONE",
    duration=0.291,
    pending=True,
    proven=True,
    deployment_schema="ostium.step3.pinned-deployment-evidence",
    settlement_schema="ostium.step3b.authenticated-omitted-mark-evidence",
    assessment_scope="DETERMINISTIC_RECENT_WINDOW_SCREEN_NOT_FULL_30_DAY_ASSESSMENT",
):
    deployment = {
        "schema": deployment_schema,
        "generatedAt": deployment_time,
        "chain": {
            "chainId": chain_id,
            "pin": {
                "blockNumber": deployment_block,
                "blockHash": block_hash,
                "timestamp": deployment_pin_time,
            },
        },
        "routeGate": {
            "runtimeCompatible": runtime_compatible,
            "currentStatePrerequisites": {"settlementEligible": eligible},
        },
        "tradingRuntime": {"runtimeCompatible": runtime_compatible},
        "vault": {"settlement": {"eligible": eligible}},
    }
    settlement = {
        "schema": settlement_schema,
        "generatedAt": settlement_time,
        "chain": {
            "chainId": chain_id,
            "pin": {
                "blockNumber": settlement_block,
                "blockHash": settlement_hash if settlement_hash is not None else block_hash,
                "timestamp": settlement_pin_time,
            }
        },
        "coverage": {
            "assessmentScope": assessment_scope,
            "noEventCoverage": "OLDER_HISTORY_OPEN_BEFORE_RECENT_WINDOW",
            "recentWindow": {
                "approximateDurationDays": duration,
                "fromBlock": 1,
                "toBlock": 7,
                "fromTimestamp": deployment_pin_time - int(duration * 86_400),
                "toTimestamp": deployment_pin_time,
            },
        },
        "economics": {
            "assessmentScope": "RECENT_WINDOW_ONLY_NOT_FULL_30_DAY_OR_COMPLETE_HISTORICAL_ASSESSMENT",
            "deployedProfitClaim": profit_claim,
            "provenCandidateAggregateDelta": "38528037574697570895",
            "withdrawalPriceDifference": "1292844446415",
        },
        "pairs": [
            {
                "candidate": {
                    "status": "PROVEN_AUTHENTICATED_OMITTED_MARK_CANDIDATE_IN_RECENT_WINDOW"
                    if proven
                    else "NO_CANDIDATE_IN_BOUNDED_WINDOW",
                    "olderHistory": "OPEN_BEFORE_RECENT_WINDOW",
                }
            }
        ],
        "settlements": {
            "inspected": [
                {"settlementId": "126", "status": "PENDING_GLOBAL" if pending else "SETTLED"}
            ]
        },
    }
    write(root, "reports/raw/fast/ostium-stale-mark-deployment-step3.json", deployment)
    write(root, "reports/raw/fast/ostium-stale-mark-settlement-step3b.json", settlement)


def test_timestamp_units_clock_skew_severity_and_large_integer():
    assert freshness(1_700_000_000_000, 1_700_000_001)[0] == "FRESH"
    assert freshness("2030-01-01T00:00:00Z", 1_700_000_000)[0] == "CLOCK_SKEW"
    assert freshness(None, 1)[0] == "UNKNOWN"
    assert severity("medium") == "WARN"
    assert severity("dormant") == "INFO"
    assert severity("active") is None
    assert severity("unexpected") is None
    assert safe_value(9_007_199_254_740_992) == "9007199254740992"
    assert safe_value(1e16) is None
    assert safe_value(-1e16) is None


def test_jsonl_reads_latest_bounded_tail_in_chronological_order(root):
    path = root / "reports/monitor/alerts.jsonl"
    with path.open("wb") as stream:
        stream.write(b"x" * MAX_BYTES)
        stream.write(b"\n")
        for index in range(MAX_EVENTS + 25):
            stream.write(json.dumps({"index": index}).encode() + b"\n")

    result = ArtifactReader(root).jsonl()
    assert len(result["events"]) == MAX_EVENTS
    assert [row["index"] for row in result["events"][:2]] == [25, 26]
    assert result["events"][-1]["index"] == MAX_EVENTS + 24
    # The huge prefix starts outside the bounded tail and is never parsed.
    assert result["malformed"] == 0


def test_jsonl_exact_window_boundary_uses_preceding_byte(root, monkeypatch):
    suffix = b'{"index":0}\n{"index":1}\n'
    monkeypatch.setattr(artifact_module, "MAX_BYTES", len(suffix) + 1)
    path = root / "reports/monitor/alerts.jsonl"
    path.write_bytes(b"outside\n" + suffix)

    result = ArtifactReader(root).jsonl()
    assert [row["index"] for row in result["events"]] == [0, 1]


def test_jsonl_dense_tiny_records_stops_at_newest_valid_thousand(root):
    path = root / "reports/monitor/alerts.jsonl"
    with path.open("wb") as stream:
        stream.write(b"malformed\n")
        for index in range(2_000):
            stream.write(json.dumps({"i": index}).encode() + b"\n")

    result = ArtifactReader(root).jsonl()
    assert len(result["events"]) == MAX_EVENTS
    assert result["events"][0]["i"] == 1_000
    assert result["events"][-1]["i"] == 1_999
    assert result["malformed"] == 0


def test_jsonl_drops_unterminated_and_counts_malformed_and_overlong(root):
    path = root / "reports/monitor/alerts.jsonl"
    path.write_bytes(
        b'{"condition":"ok"}\n'
        + b"not-json\n"
        + b"x" * (MAX_LINE + 1)
        + b"\n"
        + b"[]\n"
        + b'{"condition":"partial"}'
    )
    result = ArtifactReader(root).jsonl()
    assert result["events"] == [{"condition": "ok"}]
    assert result["malformed"] == 3


def test_bounded_json_size_last_good_and_key_isolation(root):
    reader = ArtifactReader(root)
    write(root, "reports/monitor/state.json", {"conditions": {"good": {}}})
    write(root, "reports/raw/fast/ostium-stale-mark-deployment-step3.json", {"value": "deployment"})
    assert reader.json("state") == {"conditions": {"good": {}}}
    assert reader.json("ostium_deployment") == {"value": "deployment"}

    (root / "reports/monitor/state.json").write_text("{", encoding="utf8")
    (root / "reports/raw/fast/ostium-stale-mark-deployment-step3.json").write_bytes(
        b'{' + b' ' * MAX_BYTES
    )
    assert reader.json("state") == {"conditions": {"good": {}}}
    assert reader.json("ostium_deployment") == {"value": "deployment"}

    fresh_reader = ArtifactReader(root)
    assert fresh_reader.json("state") is None
    assert fresh_reader.json("ostium_deployment") is None


def test_json_rejects_symlink_when_supported(root, tmp_path):
    path = root / "reports/monitor/state.json"
    target = tmp_path / "target.json"
    target.write_text("{}", encoding="utf8")
    path.unlink()
    try:
        path.symlink_to(target)
    except (NotImplementedError, OSError):
        pytest.skip("symlink creation is unavailable on this platform")
    assert ArtifactReader(root).json("state") is None


def test_json_rejects_identity_swap_between_lstat_and_open(root, monkeypatch):
    reader = ArtifactReader(root)
    original = reader._validated
    replacement = root / "reports/monitor/replacement.json"
    replacement.write_text('{"replacement":true}', encoding="utf8")

    def swap_after_lstat(key, allow_large=False):
        validated = original(key, allow_large)
        path = reader.path(key)
        os.replace(replacement, path)
        return validated

    monkeypatch.setattr(reader, "_validated", swap_after_lstat)
    assert reader.read_json("state").current is False


def test_json_rejects_hardlink_when_supported(root, tmp_path):
    path = root / "reports/monitor/state.json"
    target = tmp_path / "hardlink-target.json"
    target.write_text("{}", encoding="utf8")
    path.unlink()
    try:
        os.link(target, path)
    except OSError:
        pytest.skip("hardlink creation is unavailable on this filesystem")
    assert ArtifactReader(root).json("state") is None


def test_aave_v3_timestamp_thresholds_and_explicit_clear(root):
    state(
        root,
        {
            "aave-v3-hf-watch": {
                "lastScan": 1,
                "lastResult": {"checkedAt": 1_000, "chains": 1, "results": [{"healthFactor": 1.0}]},
            }
        },
    )
    row = monitor(snapshot(ArtifactReader(root), now=1_001), "aave-v3-hf-watch")
    assert row["observation"] == "TRIGGERED"
    assert row["freshness"] == "FRESH"

    state(root, {"aave-v3-hf-watch": {"lastResult": {"checkedAt": 1_000, "chains": 1, "results": [{"healthFactor": 1.05}]}}})
    assert monitor(snapshot(ArtifactReader(root), now=1_001), "aave-v3-hf-watch")["observation"] == "WATCH"

    state(root, {"aave-v3-hf-watch": {"lastResult": {"checkedAt": 1_000, "chains": 2, "results": []}}})
    assert monitor(snapshot(ArtifactReader(root), now=1_001), "aave-v3-hf-watch")["observation"] == "UNKNOWN"

    state(root, {"aave-v3-hf-watch": {"lastResult": {"checkedAt": 1_000, "chains": 0, "results": []}}})
    assert monitor(snapshot(ArtifactReader(root), now=1_001), "aave-v3-hf-watch")["observation"] == "UNKNOWN"


def test_aave_v4_authoritative_current_stale_and_malformed(root):
    # Contradictory legacy STATE must not influence the dedicated watcher card.
    state(root, {"aave-v4-liquidation-watch": {"lastResult": {"generatedAt": 1_000, "liquidatable": 99}}})
    aave_v4_state(root, summary={"nearLiquidation": 1})
    row = monitor(snapshot(ArtifactReader(root), now=1_001), "aave-v4-liquidation-watch")
    assert row["observation"] == "WATCH"
    assert row["alarm"] == "NONE"
    assert row["provenance"] == ["aave-v4-authoritative-watch"]

    stale = monitor(snapshot(ArtifactReader(root), now=10_000), "aave-v4-liquidation-watch")
    assert stale["freshness"] == "STALE"
    assert stale["observation"] == "HISTORICAL"
    assert stale["alarm"] != "CURRENT"

    value = aave_v4_state(root, summary={"nearLiquidation": 1})
    value["latest"]["summary"]["routePositive"] = 1
    write(root, "reports/raw/fast/aave-v4-liquidation-watch.json", value)
    malformed = monitor(snapshot(ArtifactReader(root), now=1_001), "aave-v4-liquidation-watch")
    assert malformed["observation"] == "UNKNOWN"
    assert malformed["source_health"] in {"INVALID", "ERROR"}


@pytest.mark.parametrize(
    "classification, complete",
    [
        ("BOUNDED_WINDOW_INCOMPLETE", False),
        ("BOUNDED_OBSERVATIONAL", True),
    ],
)
def test_aave_v4_zero_result_bounded_coverage_is_never_clear(
    root, classification, complete
):
    aave_v4_state(
        root,
        coverage={
            "classification": classification,
            "complete": complete,
            "errors": ["bounded-window-incomplete"],
        },
    )
    row = monitor(snapshot(ArtifactReader(root), now=1_001), "aave-v4-liquidation-watch")
    assert row["observation"] == "UNKNOWN"
    assert row["source_health"] == "DEGRADED"
    assert "zero samples do not establish a clear result" in row["warnings"][0]


def test_aave_v4_missing_coverage_is_unknown(root):
    value = aave_v4_state(root)
    value["latest"].pop("sourceCoverage")
    write(root, "reports/raw/fast/aave-v4-liquidation-watch.json", value)
    row = monitor(snapshot(ArtifactReader(root), now=1_001), "aave-v4-liquidation-watch")
    assert row["observation"] == "UNKNOWN"
    assert row["source_health"] in {"INVALID", "ERROR"}


def test_aave_v4_stale_exhaustive_zero_result_is_unknown(root):
    aave_v4_state(root)
    row = monitor(snapshot(ArtifactReader(root), now=10_000), "aave-v4-liquidation-watch")
    assert row["freshness"] == "STALE"
    assert row["observation"] == "UNKNOWN"
    assert row["source_health"] == "STALE"

    aave_v4_state(root, source_health="STALE")
    declared_stale = monitor(
        snapshot(ArtifactReader(root), now=1_001), "aave-v4-liquidation-watch"
    )
    assert declared_stale["observation"] == "UNKNOWN"
    assert declared_stale["source_health"] == "STALE"


def test_aave_v4_partial_failure_preserves_findings_without_promotion(root):
    aave_v4_state(
        root,
        summary={"nearLiquidation": 2},
        coverage={
            "classification": "SOURCE_INCOMPLETE",
            "complete": False,
            "errors": ["log-chunk-failed"],
        },
    )
    row = monitor(snapshot(ArtifactReader(root), now=1_001), "aave-v4-liquidation-watch")
    assert row["observation"] == "HISTORICAL"
    assert row["source_health"] == "DEGRADED"
    assert row["alarm"] != "CURRENT"
    assert ("near liquidation", 2) in row["metrics"]


def test_aave_v4_fresh_exhaustive_zero_result_is_clear(root):
    aave_v4_state(root)
    row = monitor(snapshot(ArtifactReader(root), now=1_001), "aave-v4-liquidation-watch")
    assert row["freshness"] == "FRESH"
    assert row["observation"] == "CLEAR"
    assert row["source_health"] == "OK"


def test_aave_v4_minimal_unversioned_coverage_is_unknown_never_clear(root):
    value = aave_v4_state(root)
    minimal = {"classification": "EXHAUSTIVE_COMPLETE", "complete": True, "errors": []}
    value["sourceCoverage"] = minimal
    value["latest"]["sourceCoverage"] = minimal
    write(root, "reports/raw/fast/aave-v4-liquidation-watch.json", value)

    row = monitor(snapshot(ArtifactReader(root), now=1_001), "aave-v4-liquidation-watch")
    assert row["observation"] == "UNKNOWN"
    assert row["source_health"] == "DEGRADED"


def _set_path(value, path, replacement):
    target = value
    for key in path[:-1]:
        target = target[key]
    if replacement is _DELETE:
        target.pop(path[-1])
    else:
        target[path[-1]] = replacement


_DELETE = object()


@pytest.mark.parametrize(
    "family, path, replacement",
    [
        ("coverage-schema", ("latest", "sourceCoverage", "schema"), _DELETE),
        ("coverage-schema-version", ("latest", "sourceCoverage", "schemaVersion"), 2),
        ("coverage-schema-version-bool", ("latest", "sourceCoverage", "schemaVersion"), True),
        ("coverage-protocol", ("latest", "sourceCoverage", "protocolVersion"), "V3"),
        ("coverage-kind", ("latest", "sourceCoverage", "coverageKind"), "borrower-scan"),
        ("producer-kind", ("latest", "sourceCoverage", "producerKind"), "borrower-scan"),
        ("classification", ("latest", "sourceCoverage", "classification"), "SOURCE_INCOMPLETE"),
        ("complete", ("latest", "sourceCoverage", "complete"), False),
        ("sample-complete", ("latest", "sourceCoverage", "sampleComplete"), False),
        ("promotion-eligible", ("latest", "sourceCoverage", "promotionEligible"), True),
        ("promotion-closure", ("latest", "sourceCoverage", "promotionClosure", "eligible"), True),
        ("promotion-closure-shape", ("latest", "sourceCoverage", "promotionClosure", "extra"), False),
        ("history-scope", ("latest", "sourceCoverage", "historyScope"), "RECENT_BLOCK_SUFFIX"),
        ("history-range", ("latest", "sourceCoverage", "observedRange", "fromBlock"), 1),
        ("history-proof", ("latest", "sourceCoverage", "fullHistoryProven"), False),
        ("exhaustive-proof-type", ("latest", "sourceCoverage", "exhaustiveProof", "type"), "WRONG_PROOF"),
        ("proof-equality", ("latest", "sourceCoverage", "proof", "evidence"), "different@1"),
        ("chain-count", ("latest", "sourceCoverage", "chainsObserved"), True),
        ("chain-equality", ("latest", "sourceCoverage", "chainsExpected"), 2),
        ("log-count", ("latest", "sourceCoverage", "logChunksSucceeded"), 0),
        ("log-nonempty", ("latest", "sourceCoverage", "logChunksAttempted"), 0),
        ("borrower-count", ("latest", "sourceCoverage", "checkedBorrowers"), 9),
        ("account-count", ("latest", "sourceCoverage", "accountReadsFailed"), 1),
        ("reserve-count", ("latest", "sourceCoverage", "reserveReadsAttempted"), 2),
        ("state-count", ("latest", "sourceCoverage", "stateReadsAttempted"), 10),
        ("spoke-count", ("latest", "sourceCoverage", "spokesObserved"), 1),
        # Three reserve links do not imply three unique spokes.
        ("spoke-vs-link-cardinality", ("latest", "sourceCoverage", "spokesExpected"), 3),
        ("source-errors", ("latest", "sourceCoverage", "errors"), ["source-error"]),
        ("scan-truncation", ("latest", "sourceCoverage", "wasTruncated"), True),
        ("topology-time", ("latest", "sourceCoverage", "topologyGeneratedAt"), None),
        ("topology-age", ("latest", "sourceCoverage", "topologyAgeMs"), 300_001),
        ("topology-refresh", ("latest", "sourceCoverage", "topologyRefreshOk"), False),
        ("topology-source-complete", ("latest", "sourceCoverage", "topologySourceComplete"), False),
        ("topology-sample-complete", ("latest", "sourceCoverage", "topologySourceSampleComplete"), False),
        ("topology-authority-type", ("latest", "sourceCoverage", "topologyUniverse", "type"), "OBSERVED_SET"),
        ("topology-authority-bound", ("latest", "sourceCoverage", "topologyUniverse", "bound"), False),
        ("topology-authority-registry", ("latest", "sourceCoverage", "topologyUniverse", "registry"), ""),
        ("excluded-spoke", ("latest", "sourceCoverage", "excludedSpokes"), [{"spoke": "filtered"}]),
        ("spoke-filtering", ("latest", "sourceCoverage", "spokeFilteringApplied"), True),
        ("reserve-link-truncation", ("latest", "sourceCoverage", "reserveLinksTruncated"), True),
        ("aggregate-truncation", ("latest", "sourceCoverage", "spokeReserveLinks", 0, "wasTruncated"), True),
        ("aggregate-equality", ("latest", "sourceCoverage", "spokeReserveLinks", 0, "observed"), 1),
        ("aggregate-count", ("latest", "sourceCoverage", "spokeReserveLinks", 0, "consumed"), 1),
        ("reserve-link-global-count", ("latest", "sourceCoverage", "reserveLinksObserved"), 2),
        ("reserve-link-cap", ("latest", "sourceCoverage", "reserveLinksCap"), 2),
        ("consumed-count", ("latest", "sourceCoverage", "reserveLinksConsumed"), 2),
    ],
    ids=lambda value: value if isinstance(value, str) else None,
)
def test_aave_v4_exhaustive_coverage_mutations_are_never_clear(
    root, family, path, replacement
):
    value = aave_v4_state(root)
    coverage = deepcopy(value["latest"]["sourceCoverage"])
    value["latest"]["sourceCoverage"] = coverage
    value["sourceCoverage"] = coverage
    _set_path(value, path, replacement)
    write(root, "reports/raw/fast/aave-v4-liquidation-watch.json", value)

    row = monitor(snapshot(ArtifactReader(root), now=1_001), "aave-v4-liquidation-watch")
    assert row["observation"] == "UNKNOWN"
    assert row["source_health"] == "DEGRADED"


def _duplicate_consumed_link(coverage):
    coverage["consumedReserveLinks"][2] = deepcopy(coverage["consumedReserveLinks"][0])


def _duplicate_aggregate_link(coverage):
    coverage["spokeReserveLinks"][0]["links"][1] = deepcopy(
        coverage["spokeReserveLinks"][0]["links"][0]
    )


def _break_aggregate_consumed_linkage(coverage):
    coverage["consumedReserveLinks"][2]["reserveId"] = 9


def _duplicate_aggregate_spoke(coverage):
    first = coverage["spokeReserveLinks"][0]["spoke"]
    coverage["spokeReserveLinks"][1]["spoke"] = first
    coverage["spokeReserveLinks"][1]["links"][0]["spoke"] = first


@pytest.mark.parametrize(
    "mutation",
    [
        _duplicate_consumed_link,
        _duplicate_aggregate_link,
        _break_aggregate_consumed_linkage,
        _duplicate_aggregate_spoke,
    ],
    ids=["consumed-unique", "aggregate-unique", "aggregate-consumed-equality", "spoke-unique"],
)
def test_aave_v4_reserve_link_mutations_are_never_clear(root, mutation):
    value = aave_v4_state(root)
    coverage = deepcopy(value["latest"]["sourceCoverage"])
    value["latest"]["sourceCoverage"] = coverage
    value["sourceCoverage"] = coverage
    mutation(coverage)
    write(root, "reports/raw/fast/aave-v4-liquidation-watch.json", value)

    row = monitor(snapshot(ArtifactReader(root), now=1_001), "aave-v4-liquidation-watch")
    assert row["observation"] == "UNKNOWN"
    assert row["source_health"] == "DEGRADED"


def test_aave_v4_noncanonical_finding_is_historical_never_current(root):
    value = aave_v4_state(root, summary={"nearLiquidation": 1})
    coverage = deepcopy(value["latest"]["sourceCoverage"])
    coverage["producerKind"] = "borrower-scan"
    value["latest"]["sourceCoverage"] = coverage
    value["sourceCoverage"] = coverage
    write(root, "reports/raw/fast/aave-v4-liquidation-watch.json", value)

    row = monitor(snapshot(ArtifactReader(root), now=1_001), "aave-v4-liquidation-watch")
    assert row["observation"] == "HISTORICAL"
    assert row["alarm"] != "CURRENT"


@pytest.mark.parametrize(
    "path, replacement",
    [
        (("schema",), "wrong-wrapper/v1"),
        (("scanner",), "tools/not-the-aave-v4-wrapper.js"),
        (("classification",), "SOURCE_INCOMPLETE"),
        (("complete",), False),
        (("latest", "classification"), "SOURCE_INCOMPLETE"),
        (("latest", "complete"), False),
    ],
)
def test_aave_v4_noncanonical_wrapper_identity_is_never_clear(root, path, replacement):
    value = aave_v4_state(root)
    _set_path(value, path, replacement)
    write(root, "reports/raw/fast/aave-v4-liquidation-watch.json", value)

    row = monitor(snapshot(ArtifactReader(root), now=1_001), "aave-v4-liquidation-watch")
    assert row["observation"] == "UNKNOWN"
    assert row["source_health"] in {"DEGRADED", "INVALID", "ERROR"}


def test_absurd_adapter_float_is_not_displayed_or_classified(root):
    state(root, {"morpho-liq": {"lastResult": {"checkedAt": 1_000, "liquidatable": 1e99, "totalBorrowers": 1}}})
    row = monitor(snapshot(ArtifactReader(root), now=1_001), "morpho-liq")
    assert row["observation"] == "UNKNOWN"
    assert all(value != 1e99 for _, value in row["metrics"])


def test_hyperlend_lists_and_explicit_clear(root):
    state(
        root,
        {
            "hyperlend": {
                "lastCheck": 1_000,
                "routeCandidates": [{}],
                "divergentStaleSources": [{}],
                "staleSourceWatchpoints": [],
            }
        },
    )
    row = monitor(snapshot(ArtifactReader(root), now=1_001), "hyperlend")
    assert row["observation"] == "TRIGGERED"
    assert ("priority", "CRITICAL") in row["metrics"]

    state(root, {"hyperlend": {"lastCheck": 1_000, "routeCandidates": [], "divergentStaleSources": [], "staleSourceWatchpoints": []}})
    assert monitor(snapshot(ArtifactReader(root), now=1_001), "hyperlend")["observation"] == "CLEAR"


def test_kamino_same_slot_rules_ignore_generic_and_stale_candidates(root):
    base = {"generatedAt": 1_000, "sameSlotLiquidatableRows": 0, "sameSlotReducedRows": 0, "staleReducedRows": 99, "candidates": [{}]}
    state(root, {"kamino-liquidation-window": {"lastResult": base}})
    row = monitor(snapshot(ArtifactReader(root), now=1_001), "kamino-liquidation-window")
    assert row["observation"] == "CLEAR"
    assert row["alarm"] == "NONE"

    base["sameSlotReducedRows"] = 1
    state(root, {"kamino-liquidation-window": {"lastResult": base}})
    assert monitor(snapshot(ArtifactReader(root), now=1_001), "kamino-liquidation-window")["observation"] == "WATCH"

    base["sameSlotLiquidatableRows"] = 1
    state(root, {"kamino-liquidation-window": {"lastResult": base}})
    assert monitor(snapshot(ArtifactReader(root), now=1_001), "kamino-liquidation-window")["observation"] == "TRIGGERED"

    state(root, {"kamino-liquidation-window": {"lastResult": {"at": 1_000, "sameSlotLiquidatable": 0, "sameSlotReduced": 1}}})
    assert monitor(snapshot(ArtifactReader(root), now=1_001), "kamino-liquidation-window")["observation"] == "WATCH"


def test_morpho_and_fraxlend_explicit_clear_rules(root):
    state(
        root,
        {
            "morpho-liq": {"lastResult": {"checkedAt": 1_000, "liquidatable": 0, "totalBorrowers": 120}},
            "fraxlend-pair-watch": {"lastResult": {"checkedAt": 1_000, "isBadData": False, "availableAssets": 2**60}},
        },
    )
    data = snapshot(ArtifactReader(root), now=1_001)
    morpho = monitor(data, "morpho-liq")
    fraxlend = monitor(data, "fraxlend-pair-watch")
    assert morpho["observation"] == "CLEAR"
    assert fraxlend["observation"] == "CLEAR"
    assert ("available assets", str(2**60)) in fraxlend["metrics"]

    state(root, {"morpho-liq": {"lastResult": {"checkedAt": 1_000, "liquidatable": 0}}, "fraxlend-pair-watch": {"lastResult": {"checkedAt": 1_000, "isBadData": None}}})
    data = snapshot(ArtifactReader(root), now=1_001)
    assert monitor(data, "morpho-liq")["observation"] == "UNKNOWN"
    assert monitor(data, "fraxlend-pair-watch")["observation"] == "UNKNOWN"

    state(root, {"fraxlend-pair-watch": {"lastResult": {"checkedAt": 1_000, "isBadData": True, "availableUsd": 9_999}}})
    assert monitor(snapshot(ArtifactReader(root), now=1_001), "fraxlend-pair-watch")["observation"] == "WATCH"
    state(root, {"fraxlend-pair-watch": {"lastResult": {"checkedAt": 1_000, "isBadData": True, "availableUsd": 10_000}}})
    row = monitor(snapshot(ArtifactReader(root), now=1_001), "fraxlend-pair-watch")
    assert row["observation"] == "TRIGGERED"
    assert row["alarm"] == "NONE"  # event-only evidence is not an ongoing alarm


@pytest.mark.parametrize("now, expected_freshness", [(12_000, "STALE"), (0, "CLOCK_SKEW")])
def test_legacy_clear_requires_current_freshness(root, now, expected_freshness):
    state(
        root,
        {
            "morpho-liq": {
                "lastResult": {
                    "checkedAt": 1_000,
                    "liquidatable": 0,
                    "totalBorrowers": 1,
                }
            }
        },
    )
    row = monitor(snapshot(ArtifactReader(root), now=now), "morpho-liq")
    assert row["freshness"] == expected_freshness
    assert row["observation"] == "UNKNOWN"
    assert row["alarm"] == "NONE"
    assert "current negative claim" in row["warnings"][0]


def test_legacy_current_clear_remains_clear(root):
    state(
        root,
        {
            "morpho-liq": {
                "lastResult": {
                    "checkedAt": 1_000,
                    "liquidatable": 0,
                    "totalBorrowers": 1,
                }
            }
        },
    )
    row = monitor(snapshot(ArtifactReader(root), now=1_001), "morpho-liq")
    assert row["freshness"] == "FRESH"
    assert row["observation"] == "CLEAR"
    assert row["warnings"] == []


def test_freshness_gates_monitor_alarm(root):
    state(root, {"morpho-liq": {"lastResult": {"checkedAt": 1_000, "liquidatable": 1, "totalBorrowers": 1}}})
    current = monitor(snapshot(ArtifactReader(root), now=1_001), "morpho-liq")
    stale = monitor(snapshot(ArtifactReader(root), now=12_000), "morpho-liq")
    assert current["alarm"] == "CURRENT"
    assert stale["freshness"] == "STALE"
    assert stale["alarm"] == "HISTORICAL"


def test_catalog_preserves_existing_monitors_and_adds_authoritative_sources():
    assert len(CATALOG) == 35
    assert [item.id for item in CATALOG[-7:-4]] == [
        "venus-psr-bnb-drift",
        "venus-psr-ethereum-drift",
        "venus-psr-arbitrum-drift",
    ]
    assert all(item.source == "VENUS_PSR" and item.cadence == 3600 for item in CATALOG[-7:-4])
    assert all(item.freshness_limits() == (7200, 21600) for item in CATALOG[-7:-4])
    assert next(item for item in CATALOG if item.id == "aave-v4-liquidation-watch").source == "AAVE_V4"
    assert CATALOG[-4].source == "RESEARCH_WATCH"
    assert CATALOG[-3].source == "POLYMARKET_R17"
    assert CATALOG[-2].source == "POLYMARKET_R19"
    assert CATALOG[-1].source == "POLYMARKET_R20"
    trigger_watch = next(item for item in CATALOG if item.id == "aave-v3-liquidation-trigger-watch")
    assert trigger_watch.source == "AAVE_V3_LIQ_WATCH"
    assert trigger_watch.mode == "CONTINUOUS" and trigger_watch.cadence == 60
    assert trigger_watch.freshness_limits() == (120, 360)
    morpho_watch = next(item for item in CATALOG if item.id == "morpho-blue-liquidation-watch")
    assert morpho_watch.source == "MORPHO_BLUE_LIQ"
    assert morpho_watch.disposition == "KEEP_HOT" and morpho_watch.protocol == "Morpho"
    assert morpho_watch.mode == "CONTINUOUS" and morpho_watch.cadence == 60
    assert morpho_watch.freshness_limits() == (120, 360)
    ids = [item.id for item in CATALOG]
    assert ids.index("morpho-blue-liquidation-watch") > ids.index("aave-v3-liquidation-trigger-watch")


def test_venus_chain_statuses_are_isolated_and_drift_is_current_only_when_fresh(root):
    venus_state(
        root,
        statuses={"bnb": "DRIFT", "ethereum": "ERROR", "arbitrum": "CLEAR"},
    )
    data = snapshot(ArtifactReader(root), now=1_001)
    bnb = monitor(data, "venus-psr-bnb-drift")
    ethereum = monitor(data, "venus-psr-ethereum-drift")
    arbitrum = monitor(data, "venus-psr-arbitrum-drift")
    assert bnb["observation"] == "TRIGGERED" and bnb["alarm"] == "CURRENT"
    assert ethereum["observation"] == "ERROR" and ethereum["alarm"] == "NONE"
    assert ethereum["producer_health"]["last_success"] is None
    assert "no clear status inferred" in ethereum["warnings"][0]
    assert arbitrum["observation"] == "CLEAR" and arbitrum["alarm"] == "NONE"
    assert bnb["producer_health"] == {
        "latest_observation": datetime.fromtimestamp(1_000, timezone.utc).isoformat(),
        "last_success": datetime.fromtimestamp(1_000, timezone.utc).isoformat(),
        "next_expected_update": datetime.fromtimestamp(4_600, timezone.utc).isoformat(),
        "legacy_context": None,
    }


def test_venus_stale_drift_is_watch_not_exploit_alarm(root):
    venus_state(root, statuses={"bnb": "DRIFT", "ethereum": "CLEAR", "arbitrum": "CLEAR"})
    row = monitor(snapshot(ArtifactReader(root), now=30_000), "venus-psr-bnb-drift")
    assert row["freshness"] == "STALE"
    assert row["observation"] == "WATCH"
    assert row["alarm"] == "NONE"
    assert row["unresolved_drift"]["categories"] == ["DISTRIBUTION"]


@pytest.mark.parametrize("now, expected_freshness", [(30_000, "STALE"), (0, "CLOCK_SKEW")])
def test_venus_clear_requires_current_freshness(root, now, expected_freshness):
    venus_state(root)
    row = monitor(snapshot(ArtifactReader(root), now=now), "venus-psr-bnb-drift")
    assert row["freshness"] == expected_freshness
    assert row["observation"] == "UNKNOWN"
    assert row["alarm"] == "NONE"
    assert "current negative claim" in row["warnings"][0]


def test_venus_current_clear_remains_clear(root):
    venus_state(root)
    row = monitor(snapshot(ArtifactReader(root), now=1_001), "venus-psr-bnb-drift")
    assert row["freshness"] == "FRESH"
    assert row["observation"] == "CLEAR"
    assert row["warnings"] == ["Single-provider comparison only; independent corroboration is not established"]


def test_venus_interval_drives_freshness_and_next_expected_update(root):
    venus_state(
        root,
        interval=10_000,
        statuses={"bnb": "DRIFT", "ethereum": "CLEAR", "arbitrum": "CLEAR"},
    )
    aging = monitor(snapshot(ArtifactReader(root), now=25_000), "venus-psr-bnb-drift")
    assert aging["freshness"] == "AGING"
    assert aging["alarm"] == "CURRENT"
    assert aging["producer_health"]["next_expected_update"] == datetime.fromtimestamp(11_000, timezone.utc).isoformat()
    stale = monitor(snapshot(ArtifactReader(root), now=62_000), "venus-psr-bnb-drift")
    assert stale["freshness"] == "STALE"
    assert stale["observation"] == "WATCH"
    assert stale["alarm"] == "NONE"


def test_venus_error_exposes_prior_unresolved_drift_without_current_alarm(root):
    value = venus_state(
        root,
        statuses={"bnb": "DRIFT", "ethereum": "CLEAR", "arbitrum": "CLEAR"},
    )
    bnb = value["chains"]["bnb"]
    bnb.update(status="ERROR", current=None, driftCategories=[], errorClass="CURRENT_READ_FAILED", attemptAt=2_000)
    value["attemptAt"] = 2_000
    value["status"] = "DEGRADED"
    for key in ("ethereum", "arbitrum"):
        value["chains"][key]["attemptAt"] = 2_000
        value["chains"][key]["lastSuccessfulAt"] = 2_000
        value["chains"][key]["lastSuccessfulObservation"]["at"] = 2_000
    write(root, "reports/monitor/venus-psr-state.json", value)
    row = monitor(snapshot(ArtifactReader(root), now=2_001), "venus-psr-bnb-drift")
    assert row["observation"] == "ERROR"
    assert row["alarm"] == "NONE"
    assert row["unresolved_drift"]["categories"] == ["DISTRIBUTION"]
    assert "remains unresolved" in row["warnings"][-1]
    assert row["baseline_block"] == 10
    assert row["baseline_hash"] == "0x" + "1" * 64
    data = snapshot(ArtifactReader(root), now=2_001)
    unresolved_alarm = next(
        alarm for alarm in data["alarms"]
        if alarm["monitor_id"] == "venus-psr-bnb-drift"
    )
    assert unresolved_alarm["alarm"] == "HISTORICAL"
    assert unresolved_alarm["categories"] == ["DISTRIBUTION"]
    assert unresolved_alarm["event_at"] == datetime.fromtimestamp(1_000, timezone.utc).isoformat()

    reader = ArtifactReader(root)
    cached = monitor(snapshot(reader, now=2_001), "venus-psr-bnb-drift")
    assert cached["unresolved_drift"] is not None
    (root / "reports/monitor/venus-psr-state.json").write_text("{", encoding="utf8")
    historical = monitor(snapshot(reader, now=2_002), "venus-psr-bnb-drift")
    assert historical["observation"] == "UNKNOWN"
    assert historical["alarm"] == "NONE"
    assert historical["unresolved_drift"]["status"] == "UNRESOLVED"

    clear = venus_state(root)
    clear_data = snapshot(ArtifactReader(root), now=1_001)
    row = monitor(clear_data, "venus-psr-bnb-drift")
    assert clear["chains"]["bnb"]["unresolvedDrift"] is None
    assert row["unresolved_drift"] is None
    assert not any(
        alarm["monitor_id"] == "venus-psr-bnb-drift" and alarm.get("message") == "Prior configuration drift remains unresolved"
        for alarm in clear_data["alarms"]
    )


@pytest.mark.parametrize("contradiction", ["drift-missing", "clear-present", "drift-changed"])
def test_venus_contradictory_unresolved_lifecycle_is_rejected(root, contradiction):
    value = venus_state(
        root,
        statuses={"bnb": "DRIFT", "ethereum": "CLEAR", "arbitrum": "CLEAR"},
    )
    bnb = value["chains"]["bnb"]
    bnb.update(status="ERROR", current=None, driftCategories=[], errorClass="CURRENT_READ_FAILED", attemptAt=2_000)
    value["attemptAt"] = 2_000
    value["status"] = "DEGRADED"
    for key in ("ethereum", "arbitrum"):
        value["chains"][key]["attemptAt"] = 2_000
        value["chains"][key]["lastSuccessfulAt"] = 2_000
        value["chains"][key]["lastSuccessfulObservation"]["at"] = 2_000
    if contradiction == "drift-missing":
        bnb["unresolvedDrift"] = None
    elif contradiction == "clear-present":
        bnb["lastSuccessfulObservation"]["status"] = "CLEAR"
        bnb["lastSuccessfulObservation"]["driftCategories"] = []
    else:
        bnb["unresolvedDrift"] = dict(bnb["unresolvedDrift"])
        bnb["unresolvedDrift"]["digest"] = "0x" + "9" * 64
    write(root, "reports/monitor/venus-psr-state.json", value)
    rows = snapshot(ArtifactReader(root), now=2_001)["monitors"]
    assert all(
        row["observation"] == "UNKNOWN"
        for row in rows if row["id"].startswith("venus-psr-")
    )


def test_semantically_invalid_venus_json_cannot_poison_last_valid_cache(root):
    venus_state(root, statuses={"bnb": "DRIFT", "ethereum": "CLEAR", "arbitrum": "CLEAR"})
    reader = ArtifactReader(root)
    initial = monitor(snapshot(reader, now=1_001), "venus-psr-bnb-drift")
    assert initial["observation"] == "TRIGGERED"
    path = root / "reports/monitor/venus-psr-state.json"
    path.write_text("{}", encoding="utf8")
    poisoned = monitor(snapshot(reader, now=1_002), "venus-psr-bnb-drift")
    assert poisoned["observation"] == "UNKNOWN"
    assert poisoned["cached_observation"] == "TRIGGERED"
    assert poisoned["unresolved_drift"]["categories"] == ["DISTRIBUTION"]
    path.unlink()
    missing = monitor(snapshot(reader, now=1_003), "venus-psr-bnb-drift")
    assert missing["cached_observation"] == "TRIGGERED"
    assert missing["unresolved_drift"] == poisoned["unresolved_drift"]


def test_venus_schema_and_chain_identity_validation_fail_closed(root):
    value = venus_state(root, chain_ids={"bnb": 999, "ethereum": 1, "arbitrum": 42161})
    data = snapshot(ArtifactReader(root), now=1_001)
    assert monitor(data, "venus-psr-bnb-drift")["observation"] == "UNKNOWN"
    assert monitor(data, "venus-psr-ethereum-drift")["observation"] == "UNKNOWN"

    value["schema"] = "wrong"
    write(root, "reports/monitor/venus-psr-state.json", value)
    data = snapshot(ArtifactReader(root), now=1_001)
    assert all(
        monitor(data, ident)["observation"] == "UNKNOWN"
        for ident in ("venus-psr-bnb-drift", "venus-psr-ethereum-drift", "venus-psr-arbitrum-drift")
    )


@pytest.mark.parametrize(
    "mutation",
    [
        lambda value: value["chains"].__setitem__("extra", value["chains"]["bnb"]),
        lambda value: value.__setitem__("status", "CLEAR"),
        lambda value: value.__setitem__("intervalSeconds", 299),
        lambda value: value["chains"]["bnb"].__setitem__("attemptAt", 999),
        lambda value: value.__setitem__("upstreamTransactions", 1),
        lambda value: value.__setitem__("providerMaterialAbsent", False),
    ],
)
def test_venus_top_schema_contradictions_are_unknown_never_clear(root, mutation):
    value = venus_state(
        root,
        statuses={"bnb": "DRIFT", "ethereum": "CLEAR", "arbitrum": "CLEAR"},
    )
    mutation(value)
    write(root, "reports/monitor/venus-psr-state.json", value)
    data = snapshot(ArtifactReader(root), now=1_001)
    rows = [monitor(data, ident) for ident in (
        "venus-psr-bnb-drift", "venus-psr-ethereum-drift", "venus-psr-arbitrum-drift"
    )]
    assert all(row["observation"] == "UNKNOWN" and row["alarm"] != "CURRENT" for row in rows)


def test_cached_venus_state_is_historical_only(root):
    venus_state(root, statuses={"bnb": "DRIFT", "ethereum": "CLEAR", "arbitrum": "CLEAR"})
    reader = ArtifactReader(root)
    assert monitor(snapshot(reader, now=1_001), "venus-psr-bnb-drift")["alarm"] == "CURRENT"
    (root / "reports/monitor/venus-psr-state.json").write_text("{", encoding="utf8")
    row = monitor(snapshot(reader, now=1_002), "venus-psr-bnb-drift")
    assert row["observation"] == "UNKNOWN"
    assert row["cached_observation"] == "TRIGGERED"
    assert row["alarm"] == "HISTORICAL"
    assert row["producer_health"]["legacy_context"] == "cached Venus PSR producer state is historical only"


def test_snapshot_exposes_producer_health_and_legacy_state_context(root):
    state(root, {"morpho-liq": {"lastResult": {"checkedAt": 1, "liquidatable": 0, "totalBorrowers": 1}}})
    venus_state(root)
    data = snapshot(ArtifactReader(root), now=1_000_000)
    morpho = monitor(data, "morpho-liq")
    assert morpho["producer_health"]["latest_observation"] is not None
    assert morpho["producer_health"]["legacy_context"] == "legacy STATE producer observation is stale"
    assert data["producer_health"]["legacy_state_current_read"] is True
    assert data["producer_health"]["venus_psr_current_read"] is True


def test_ostium_matching_pin_oldest_freshness_and_bounded_semantics(root):
    # Processing timestamps differ, but evidence freshness comes from the pin.
    ostium_artifacts(root, deployment_time=1_500, settlement_time=1_600)
    row = monitor(snapshot(ArtifactReader(root), now=1_601), "ostium-stale-mark")
    assert row["observation"] == "WATCH"
    assert row["alarm"] == "NONE"
    assert row["age"] == 601
    assert row["warnings"] == ["older history remains open"]
    assert ("proven bounded candidates", 1) in row["metrics"]
    assert ("candidate aggregate delta", "38528037574697570895") in row["metrics"]
    assert ("withdrawal price difference", "1292844446415") in row["metrics"]


@pytest.mark.parametrize(
    "changes, warning",
    [
        ({"settlement_block": 8}, "matching chain pin invalid"),
        ({"settlement_pin_time": 999}, "matching chain pin invalid"),
        ({"chain_id": "1"}, "chain identity invalid"),
        ({"deployment_schema": "wrong"}, "deployment schema invalid"),
        ({"settlement_schema": "wrong"}, "settlement schema invalid"),
        ({"profit_claim": "CLAIMED"}, "deployed profit claim inconsistent"),
        ({"duration": 30}, "bounded coverage invalid"),
        ({"assessment_scope": "COMPLETE"}, "bounded coverage invalid"),
    ],
)
def test_ostium_mismatch_or_contradiction_fails_unknown(root, changes, warning):
    ostium_artifacts(root, **changes)
    row = monitor(snapshot(ArtifactReader(root), now=1_001), "ostium-stale-mark")
    assert row["observation"] == "UNKNOWN"
    assert warning in row["warnings"]
    assert row["alarm"] == "NONE"
    assert row["metrics"] == []


@pytest.mark.parametrize(
    "changes, caution",
    [
        ({"eligible": True}, "settlement eligibility requires separate current review"),
        ({"runtime_compatible": True}, "runtime compatibility does not establish executability"),
        ({"pending": False}, None),
    ],
)
def test_ostium_updated_runtime_or_pending_values_remain_watch(root, changes, caution):
    ostium_artifacts(root, **changes)
    row = monitor(snapshot(ArtifactReader(root), now=1_001), "ostium-stale-mark")
    assert row["observation"] == "WATCH"
    assert row["alarm"] == "NONE"
    if caution:
        assert caution in row["warnings"]


def test_ostium_future_timestamp_is_clock_skew(root):
    ostium_artifacts(root, deployment_pin_time=2_000, settlement_pin_time=2_000)
    row = monitor(snapshot(ArtifactReader(root), now=1_001), "ostium-stale-mark")
    assert row["freshness"] == "CLOCK_SKEW"
    assert row["alarm"] == "NONE"


def test_alert_normalization_sanitization_deduplication_and_counts(root):
    state(root, {"aave-v3-hf-watch": {"lastResult": {"checkedAt": 1_000, "chains": 1, "results": [{"healthFactor": 0.99}]}}})
    events = [
        {"condition": "aave-v3", "severity": "MEDIUM", "timestamp": 1_000, "message": "C:\\secret\\file https://example.test 0x123"},
        {"condition": "aave-v3", "severity": "MEDIUM", "timestamp": 1_000, "message": "duplicate"},
        {"condition": "/private/path", "severity": "HIGH", "timestamp": 1},
        {"condition": "hyperlend", "severity": "DORMANT", "timestamp": 1_000},
        {"condition": "kamino", "severity": "ACTIVE", "timestamp": 1_000},
        {"condition": "morpho", "severity": "ALIEN", "timestamp": 1_000},
    ]
    path = root / "reports/monitor/alerts.jsonl"
    path.write_bytes(b"".join(json.dumps(row).encode() + b"\n" for row in events))
    data = snapshot(ArtifactReader(root), now=1_001)
    assert len(data["alarms"]) == 3
    assert data["alarm_counts"] == {"current": 1, "historical": 1}
    assert data["alarms"][0]["monitor_id"] == "aave-v3-hf-watch"
    assert data["alarms"][0]["event_at"] == datetime.fromtimestamp(1_000, timezone.utc).isoformat()
    unknown = next(row for row in data["alarms"] if row["condition"] == "monitor-event")
    info = next(row for row in data["alarms"] if row["severity"] == "INFO")
    assert unknown["alarm"] == "HISTORICAL"
    assert info["alarm"] == "NONE"
    encoded = json.dumps(data["alarms"])
    assert "secret" not in encoded and "https://" not in encoded and "0x123" not in encoded


def test_alert_dedupe_uses_hidden_entity_fields_and_alias(root):
    state(root, {"hyperlend": {"lastCheck": 1_000, "routeCandidates": [{}], "divergentStaleSources": [], "staleSourceWatchpoints": []}})
    events = [
        {"condition": "hyperlend-stale-source", "severity": "HIGH", "timestamp": 1_000, "market": "one", "fingerprint": "not-exposed-a"},
        {"condition": "hyperlend-stale-source", "severity": "HIGH", "timestamp": 1_000, "market": "two", "fingerprint": "not-exposed-b"},
    ]
    path = root / "reports/monitor/alerts.jsonl"
    path.write_bytes(b"".join(json.dumps(row).encode() + b"\n" for row in events))
    data = snapshot(ArtifactReader(root), now=1_001)
    related = [row for row in data["alarms"] if row["monitor_id"] == "hyperlend"]
    assert len(related) == 2
    encoded = json.dumps(related)
    assert "not-exposed" not in encoded and '"market"' not in encoded


def test_fresh_event_cannot_override_stale_or_error_monitor_state(root):
    state(root, {"morpho-liq": {"lastResult": {"checkedAt": 1, "liquidatable": 1, "totalBorrowers": 1}}})
    path = root / "reports/monitor/alerts.jsonl"
    path.write_bytes(json.dumps({"condition": "morpho", "severity": "HIGH", "timestamp": 20_000}).encode() + b"\n")
    data = snapshot(ArtifactReader(root), now=20_001)
    event = next(row for row in data["alarms"] if row["monitor_id"] == "morpho-liq")
    assert monitor(data, "morpho-liq")["alarm"] == "HISTORICAL"
    assert event["alarm"] == "HISTORICAL"
    assert data["alarm_counts"]["current"] == 0

    state(root, {"aave-v4-liquidation-watch": {"lastCheck": 20_000, "lastError": "failed", "lastResult": {"generatedAt": 1, "liquidatable": 1}}})
    path.write_bytes(json.dumps({"condition": "aave-v4", "severity": "HIGH", "timestamp": 20_000}).encode() + b"\n")
    data = snapshot(ArtifactReader(root), now=20_001)
    event = next(row for row in data["alarms"] if row["monitor_id"] == "aave-v4-liquidation-watch")
    assert event["alarm"] == "HISTORICAL"


def test_fresh_wrapper_with_stale_source_is_health_only_historical(root):
    state(root, {"morpho-liq": {"lastResult": {"checkedAt": 20_000, "liquidatable": 1, "totalBorrowers": 1}}})
    event = {
        "condition": "morpho",
        "severity": "CRITICAL",
        "timestamp": 20_000,
        "sourceGeneratedAt": 1,
        "sourceHealth": "STALE",
    }
    (root / "reports/monitor/alerts.jsonl").write_bytes(json.dumps(event).encode() + b"\n")
    data = snapshot(ArtifactReader(root), now=20_001)
    wrapped = next(row for row in data["alarms"] if row.get("health_only"))
    assert wrapped["alarm"] == "HISTORICAL"
    assert wrapped["freshness"] == "STALE"
    assert wrapped["message"] == "Source health event"
    assert data["alarm_counts"]["current"] == 1  # current source record only


def test_unknown_stale_novelty_alert_is_never_current_high(root):
    event = {"condition": "uncatalogued-novelty", "severity": "HIGH", "timestamp": 1}
    (root / "reports/monitor/alerts.jsonl").write_bytes(json.dumps(event).encode() + b"\n")
    data = snapshot(ArtifactReader(root), now=20_001)
    assert data["alarms"][0]["alarm"] == "HISTORICAL"
    assert data["alarm_counts"]["current"] == 0


def test_fresh_trigger_without_jsonl_event_creates_current_state_alarm(root):
    state(root, {"morpho-liq": {"lastResult": {"checkedAt": 1_000, "liquidatable": 1, "totalBorrowers": 1}}})
    data = snapshot(ArtifactReader(root), now=1_001)
    assert monitor(data, "morpho-liq")["alarm"] == "CURRENT"
    current = [row for row in data["alarms"] if row["alarm"] == "CURRENT"]
    assert len(current) == 1
    assert current[0]["monitor_id"] == "morpho-liq"
    assert current[0]["message"] == "Current source-backed monitor trigger"


def test_aging_event_and_monitor_use_same_catalog_limits(root):
    state(root, {"aave-v3-hf-watch": {"lastResult": {"checkedAt": 1_000, "chains": 1, "results": [{"healthFactor": 0.99}]}}})
    path = root / "reports/monitor/alerts.jsonl"
    path.write_bytes(json.dumps({"condition": "aave-v3", "severity": "HIGH", "timestamp": 1_000}).encode() + b"\n")
    data = snapshot(ArtifactReader(root), now=1_700)
    row = monitor(data, "aave-v3-hf-watch")
    event = next(item for item in data["alarms"] if item["monitor_id"] == row["id"])
    assert row["freshness"] == "AGING" and row["alarm"] == "CURRENT"
    assert event["freshness"] == "AGING" and event["alarm"] == "CURRENT"


def test_event_only_fresh_event_is_recent_not_current(root):
    path = root / "reports/monitor/alerts.jsonl"
    path.write_bytes(json.dumps({"condition": "fraxlend-pair-watch", "severity": "HIGH", "timestamp": 1_000}).encode() + b"\n")
    data = snapshot(ArtifactReader(root), now=1_001)
    event = next(row for row in data["alarms"] if row["monitor_id"] == "fraxlend-pair-watch")
    assert event["alarm"] == "RECENT_EVENT"
    assert data["alarm_counts"]["current"] == 0


def test_event_only_unavailable_uses_not_continuously_sourced_label(root):
    data = snapshot(ArtifactReader(root), now=1_001)
    row = monitor(data, "silo-publicallocator")
    assert row["freshness"] == "NOT_CONTINUOUSLY_SOURCED"
    assert row["source_health"] == "NOT_CONTINUOUSLY_SOURCED"


def test_research_watch_groups_and_due_review_info_only(root):
    research_watch_state(root)
    before = snapshot(ArtifactReader(root), now=datetime(2026, 8, 26, tzinfo=timezone.utc).timestamp())
    assert len(before["research_watches"]["scheduled"]) == 1
    assert not any(event.get("due_for_review") for event in before["alarms"])

    after = snapshot(ArtifactReader(root), now=datetime(2026, 8, 28, tzinfo=timezone.utc).timestamp())
    due = next(event for event in after["alarms"] if event.get("due_for_review"))
    assert due["severity"] == "INFO" and due["alarm"] == "NONE"
    watch = after["research_watches"]["scheduled"][0]
    assert watch["route_positive"] == "unknown"
    assert watch["executable_now"] == "unknown"
    assert watch["signed_action_justified"] is False
    assert "sources" not in watch


@pytest.mark.parametrize("failure", ["corrupt", "delete"])
def test_research_watch_failed_current_read_hides_groups_and_due_reviews(root, failure):
    research_watch_state(root)
    now = datetime(2026, 8, 28, tzinfo=timezone.utc).timestamp()
    reader = ArtifactReader(root)
    current = snapshot(reader, now=now)
    assert len(current["research_watches"]["scheduled"]) == 1
    assert any(event.get("due_for_review") for event in current["alarms"])

    path = root / "reports/monitor/research-watch-state.json"
    if failure == "corrupt":
        path.write_text("{", encoding="utf8")
    else:
        path.unlink()
    failed = snapshot(reader, now=now + 1)
    assert failed["producer_health"]["research_watch_current_read"] is False
    assert all(not entries for entries in failed["research_watches"].values())
    assert not any(event.get("due_for_review") for event in failed["alarms"])


@pytest.mark.parametrize("disposition, group", [("HOLD", "hold"), ("SUPPRESSED", "suppressed")])
def test_research_hold_and_suppressed_are_separate_never_alerts(root, disposition, group):
    research_watch_state(root, disposition=disposition)
    data = snapshot(ArtifactReader(root), now=2_000)
    assert len(data["research_watches"][group]) == 1
    assert not any(event["monitor_id"] == "research-watch-registry" for event in data["alarms"])


def test_research_watch_schema_and_source_status_fail_closed(root):
    value = research_watch_state(root, status="INCOMPLETE")
    data = snapshot(ArtifactReader(root), now=2_000)
    assert data["research_watches"]["scheduled"] == []
    assert data["research_watches"]["incomplete"][0]["status"] == "INCOMPLETE"
    value["entries"][0]["status"] = "COMPLETE"
    write(root, "reports/monitor/research-watch-state.json", value)
    data = snapshot(ArtifactReader(root), now=2_000)
    assert data["research_watches"]["scheduled"] == []
    assert monitor(data, "research-watch-registry")["observation"] == "UNKNOWN"


def test_alarm_sort_current_first_then_newest(root):
    state(root, {"morpho-liq": {"lastResult": {"checkedAt": 1_000, "liquidatable": 1, "totalBorrowers": 1}}})
    events = [
        {"condition": "fraxlend-pair-watch", "severity": "HIGH", "timestamp": 1_001},
        {"condition": "unknown", "severity": "HIGH", "timestamp": 1},
    ]
    path = root / "reports/monitor/alerts.jsonl"
    path.write_bytes(b"".join(json.dumps(row).encode() + b"\n" for row in events))
    alarms = snapshot(ArtifactReader(root), now=1_002)["alarms"]
    assert alarms[0]["alarm"] == "CURRENT"
    timestamps = [row["event_at"] for row in alarms if row["alarm"] == "CURRENT"]
    assert timestamps == sorted(timestamps, reverse=True)


@pytest.mark.parametrize("failure", ["corrupt", "delete"])
def test_same_reader_cached_state_is_never_current(root, failure):
    state(root, {"morpho-liq": {"lastResult": {"checkedAt": 1_000, "liquidatable": 1, "totalBorrowers": 1}}})
    reader = ArtifactReader(root)
    first = snapshot(reader, now=1_001)
    assert monitor(first, "morpho-liq")["alarm"] == "CURRENT"

    path = root / "reports/monitor/state.json"
    if failure == "corrupt":
        path.write_text("{", encoding="utf8")
    else:
        path.unlink()
    second = snapshot(reader, now=1_002)
    row = monitor(second, "morpho-liq")
    assert row["observation"] == "UNKNOWN"
    assert row["freshness"] == "UNKNOWN"
    assert row["alarm"] == "HISTORICAL"
    assert row["cached_observation"] == "TRIGGERED"
    assert row["source_health"] == ("ERROR" if failure == "corrupt" else "UNKNOWN")
    assert second["alarm_counts"]["current"] == 0
    assert second["no_current_live_status"] is True


def test_same_reader_cached_clear_becomes_unknown_without_alarm(root):
    state(root, {"hyperlend": {"lastCheck": 1_000, "routeCandidates": [], "divergentStaleSources": [], "staleSourceWatchpoints": []}})
    reader = ArtifactReader(root)
    assert monitor(snapshot(reader, now=1_001), "hyperlend")["observation"] == "CLEAR"
    (root / "reports/monitor/state.json").write_text("{", encoding="utf8")
    row = monitor(snapshot(reader, now=1_002), "hyperlend")
    assert row["observation"] == "UNKNOWN"
    assert row["cached_observation"] == "CLEAR"
    assert row["alarm"] == "NONE"


def test_ostium_requires_both_current_reads_on_same_reader(root):
    ostium_artifacts(root)
    reader = ArtifactReader(root)
    assert monitor(snapshot(reader, now=1_001), "ostium-stale-mark")["observation"] == "WATCH"
    (root / "reports/raw/fast/ostium-stale-mark-settlement-step3b.json").write_text("{", encoding="utf8")
    row = monitor(snapshot(reader, now=1_002), "ostium-stale-mark")
    assert row["observation"] == "UNKNOWN"
    assert row["cached_observation"] == "WATCH"
    assert row["source_health"] == "ERROR"
    assert row["alarm"] == "NONE"
    assert row["metrics"] == []


def test_no_live_status_and_generated_at_use_supplied_now(root):
    data = snapshot(ArtifactReader(root), now=1_000)
    assert data["no_current_live_status"] is True
    assert data["generated_at"] == datetime.fromtimestamp(1_000, timezone.utc).isoformat()

    state(root, {"hyperlend": {"lastCheck": 1_000, "routeCandidates": [], "divergentStaleSources": [], "staleSourceWatchpoints": []}})
    assert snapshot(ArtifactReader(root), now=1_001)["no_current_live_status"] is False

    state(root, {"aave-v4-liquidation-watch": {"lastCheck": 1_001, "lastError": "failed", "lastResult": {"generatedAt": 1, "liquidatable": 1}}})
    assert snapshot(ArtifactReader(root), now=1_002)["no_current_live_status"] is True


def test_current_audit_state_is_separate_normalized_local_summary(root, client):
    current_audit_state(root)
    data = snapshot(ArtifactReader(root), now=1_788_000_001)
    summary = data["current_audit_state"]
    assert summary["available"] is True
    assert summary["overall"] == "NO_CURRENT_NET_POSITIVE_ROUTE"
    assert summary["route_positive"] is False
    assert [row["status"] for row in summary["candidates"]] == [
        "WATCH_TRIGGER",
        "CLOSED_DEPLOYMENT_UNBOUND",
        "CLOSED_FIXED",
        "CLOSED_PRIVILEGED",
        "CLOSED_REFUTED",
        "HISTORICAL_WATCH_CURRENT_NEGATIVE",
    ]
    body = get(client, "/").get_data(as_text=True)
    assert "Current audit state" in body
    assert "not an inference from stale monitor artifacts" in body
    assert "EtherFi DebtManager" in body


def test_overview_prioritizes_operations_and_discloses_archived_research(root, client):
    current_audit_state(root)
    body = get(client, "/").get_data(as_text=True)

    assert "CURRENT OPERATIONS" in body
    assert "FRESH REJECT-ONLY RESEARCH" in body
    assert body.index("CURRENT OPERATIONS") < body.index("FRESH REJECT-ONLY RESEARCH")
    assert re.search(r'<details\b(?=[^>]*\bid="research-details")(?=[^>]*\bclass="secondary-section research-cards")[^>]*>', body)
    assert "No active gate entries were reported." in body
    assert "Unknown <span>ACTIVE</span>" not in body


def test_invalid_current_audit_state_fails_closed(root, client):
    value = current_audit_state(root)
    value["routePositive"] = True
    write(root, "reports/monitor/current-audit-state.json", value)
    assert current_audit_state_valid(value) is False
    assert snapshot(ArtifactReader(root))["current_audit_state"] == {"available": False}
    assert "Current audit summary unavailable" in get(client, "/").get_data(as_text=True)


def test_stex_trigger_is_normalized_without_profit_inference(root, client):
    current_audit_state(root)
    stex_profit_trigger(root, paused=True, positive_gap=True, economics_raw={"conservativeNetRaw": "7"})
    trigger = snapshot(ArtifactReader(root), now=1_001)["stex_profit_trigger"]
    assert trigger["available"] is True
    assert trigger["paused"] is True
    assert trigger["positive_gap"] is True
    assert trigger["block_window"]["before"]["number"] == "100"
    assert dict(trigger["economics"]["raw"])["conservativeNetRaw"] == "7"
    body = get(client, "/").get_data(as_text=True)
    assert "TRIGGERED" in body
    assert "Paused / pending / active rows" in body
    assert "conservativeNetRaw: 7" in body
    assert "Next command</dt><dd>Not provided" in body


def test_stex_missing_or_invalid_artifact_is_unavailable(root, client):
    current_audit_state(root)
    assert snapshot(ArtifactReader(root), now=1_001)["stex_profit_trigger"] == {"available": False}
    value = stex_profit_trigger(root)
    value["trigger"]["pendingCount"] = -1
    write(root, "reports/monitor/stex-profit-trigger.json", value)
    assert stex_profit_trigger_valid(value) is False
    assert snapshot(ArtifactReader(root), now=1_001)["stex_profit_trigger"] == {"available": False}
    assert "STEX trigger evidence is unavailable" in get(client, "/").get_data(as_text=True)


def test_stex_partial_incomplete_shape_aligns_without_becoming_actionable(root):
    current_audit_state(root)
    stx = stex_partial_incomplete_profit_trigger(root)
    assert stex_profit_trigger_valid(stx) is True
    etherfi, lista = etherfi_profit_trigger(root), lista_profit_trigger(root)
    scheduler = scheduler_state(root, stx["generatedAt"], etherfi["generatedAt"], lista["generatedAt"])
    scheduler["producers"][0]["triggerStatus"] = "INCOMPLETE"
    write(root, "reports/monitor/trigger-watch-scheduler.json", scheduler)
    delta_sentinel(root)
    data = snapshot(ArtifactReader(root), now=timestamp(scheduler["generatedAt"]))
    trigger = data["stex_profit_trigger"]
    assert trigger["available"] is True and trigger["freshness"] == "FRESH"
    assert trigger["paused"] is True and trigger["active_rows"] == 0
    assert trigger["positive_gap"] is False and trigger["total_gap_raw"] == "0"
    assert data["continuous_watch"]["producers"][0]["aligned"] is True
    assert dict(trigger["economics"]["raw"])["conservativeNetRaw"] is None
    assert data["current_audit_state"]["route_positive"] is False
    assert data["current_audit_state"]["executable_now"] is False
    assert data["current_audit_state"]["signed_action_justified"] is False


def test_stex_incomplete_rejects_malformed_partial_header_and_contradictory_aggregate(root):
    value = stex_partial_incomplete_profit_trigger(root)
    value["blockWindow"]["before"]["hash"] = None
    assert stex_profit_trigger_valid(value) is False

    value = stex_partial_incomplete_profit_trigger(root)
    value["trigger"]["positiveGap"] = True
    assert stex_profit_trigger_valid(value) is False


def test_stex_complete_artifact_keeps_full_header_and_observation_requirements(root):
    value = stex_profit_trigger(root)
    assert stex_profit_trigger_valid(value) is True
    value["blockWindow"]["after"] = {"number": None, "hash": None, "timestamp": None}
    value["blockWindow"]["stable"] = None
    assert stex_profit_trigger_valid(value) is False

    value = stex_profit_trigger(root)
    value["trigger"]["activeRows"] = None
    assert stex_profit_trigger_valid(value) is False


def test_stex_stale_scheduler_or_mismatched_identity_stays_fail_closed(root):
    stx = stex_partial_incomplete_profit_trigger(root)
    etherfi, lista = etherfi_profit_trigger(root), lista_profit_trigger(root)
    scheduler = scheduler_state(root, stx["generatedAt"], etherfi["generatedAt"], lista["generatedAt"])
    scheduler["producers"][0]["triggerStatus"] = "INCOMPLETE"
    write(root, "reports/monitor/trigger-watch-scheduler.json", scheduler)
    delta_sentinel(root)

    stale = snapshot(ArtifactReader(root), now=timestamp(scheduler["generatedAt"]) + 5_401)
    assert stale["continuous_watch"]["freshness"] == "STALE"
    assert stale["continuous_watch"]["operational"] is False

    stx["chainId"] = 1
    write(root, "reports/monitor/stex-profit-trigger.json", stx)
    mismatched = snapshot(ArtifactReader(root), now=timestamp(scheduler["generatedAt"]))
    assert mismatched["stex_profit_trigger"] == {"available": False}
    assert mismatched["continuous_watch"]["producers"][0]["aligned"] is False


def test_stex_missing_economics_is_not_reported(root, client):
    current_audit_state(root)
    stex_profit_trigger(root, economics_raw={})
    body = get(client, "/").get_data(as_text=True)
    assert "capitalRaw: Not reported" in body
    assert "conservativeNetRaw: Not reported" in body


def test_stex_real_producer_shape_accepts_nullable_incomplete_fields(root, client):
    current_audit_state(root)
    value = stex_incomplete_profit_trigger(root)
    assert stex_profit_trigger_valid(value) is True
    trigger = snapshot(ArtifactReader(root), now=1_001)["stex_profit_trigger"]
    assert trigger["paused"] is None and trigger["pending_count"] is None
    body = get(client, "/").get_data(as_text=True)
    assert "Not reported / Not reported" in body

    value["blockWindow"]["before"]["hash"] = "not-a-hash"
    assert stex_profit_trigger_valid(value) is False


def test_stex_current_producer_artifact_shape_regression(root):
    value = stex_profit_trigger(root)
    value.update(
        generatedAt="2026-08-28T08:48:00.085Z",
        chainId=999,
        evidenceClass="SCREENING_ONLY_OFFICIAL_LATEST_REORGABLE",
        blockWindow={"before": {"number": "44788412", "hash": "0x" + "a" * 64, "timestamp": "1788310408"}, "after": {"number": None, "hash": None, "timestamp": None}, "stable": None},
        trigger={"status": "INCOMPLETE", "paused": True, "pendingCount": None, "activeRows": 0, "positiveGap": False, "totalGapRaw": "0"},
        requests=[],
        liquidity={"status": "NOT_RUN", "whypeBalanceRaw": None, "whypeReserveRaw": None, "liabilityHaircutRaw": None, "conservativeAvailableRaw": None},
        economics={"status": "NOT_RUN", "capitalRaw": None, "grossCeilingRaw": None, "feesRaw": None, "gasRaw": None, "carryRaw": None, "exitHaircutRaw": None, "uncertaintyRaw": None, "conservativeNetRaw": None, "netBps": None, "capacityRaw": None},
        gates={"triggerObserved": "UNKNOWN", "sourceCurrent": "PASS", "runtimeReachability": "PASS", "economicsComplete": "FAIL", "liquidityExit": "UNKNOWN", "conservativeNetPositive": "UNKNOWN", "keylessForkJustified": "UNKNOWN"},
        safety={"networkCalls": 4, "automaticRetries": 0, "transactions": 0, "signing": False, "broadcast": False},
    )
    assert stex_profit_trigger_valid(value) is True


def test_etherfi_current_incomplete_shape_hides_zero_placeholders(root, client):
    current_audit_state(root)
    value = etherfi_profit_trigger(root)
    assert etherfi_debtmanager_profit_trigger_valid(value) is True
    trigger = snapshot(ArtifactReader(root))["etherfi_debtmanager_profit_trigger"]
    assert trigger["available"] is True
    assert trigger["pool_evidence_complete"] is False
    assert trigger["pools"] == []
    body = get(client, "/").get_data(as_text=True)
    assert "EVIDENCE_INCOMPLETE" in body
    assert "zero placeholders are not observations" in body
    assert "capitalRaw: Not reported" in body


def test_etherfi_v1_and_v2_diagnostics_are_strict_and_rendered(root, client):
    current_audit_state(root)
    v1 = etherfi_profit_trigger(root)
    assert etherfi_debtmanager_profit_trigger_valid(v1) is True
    assert snapshot(ArtifactReader(root))["etherfi_debtmanager_profit_trigger"]["diagnostics"] is None

    v2 = etherfi_profit_trigger_v2(root)
    assert etherfi_debtmanager_profit_trigger_valid(v2) is True
    body = get(client, "/").get_data(as_text=True)
    assert "Phase diagnostics" in body
    assert "state 1/2" in body
    assert "failure STATE/STATE_CONSENSUS_UNAVAILABLE" in body
    assert "rawError" not in body
    assert "endpoint" not in body

    disagreement = etherfi_profit_trigger_v2(root, disagreement=True)
    assert etherfi_debtmanager_profit_trigger_valid(disagreement) is True
    normalized = snapshot(ArtifactReader(root))["etherfi_debtmanager_profit_trigger"]["diagnostics"]
    assert normalized["stateSuccesses"] == 2 and normalized["stateDistinctGroups"] == 2
    disagreement["diagnostics"]["rawError"] = "endpoint"
    assert etherfi_debtmanager_profit_trigger_valid(disagreement) is False
    v1["diagnostics"] = {}
    assert etherfi_debtmanager_profit_trigger_valid(v1) is False


def test_etherfi_complete_negative_and_positive_flow_are_display_only(root, client):
    current_audit_state(root)
    value = etherfi_profit_trigger(root, complete=True, positive=True)
    assert etherfi_debtmanager_profit_trigger_valid(value) is True
    trigger = snapshot(ArtifactReader(root))["etherfi_debtmanager_profit_trigger"]
    assert trigger["pool_evidence_complete"] is True
    assert trigger["positive"] is True
    assert dict(trigger["economics"]["raw"])["conservativeNetRaw"] == "0"
    body = get(client, "/").get_data(as_text=True)
    assert "POSITIVE_FLOW" in body
    assert "conservativeNetRaw: 0" in body
    assert "reported positive" not in body


def test_etherfi_missing_invalid_and_cached_artifacts_fail_closed(root):
    assert snapshot(ArtifactReader(root))["etherfi_debtmanager_profit_trigger"] == {"available": False}
    value = etherfi_profit_trigger(root)
    value["gates"]["sourceCurrent"] = "MAYBE"
    write(root, "reports/monitor/etherfi-debtmanager-profit-trigger.json", value)
    assert etherfi_debtmanager_profit_trigger_valid(value) is False
    reader = ArtifactReader(root)
    assert snapshot(reader)["etherfi_debtmanager_profit_trigger"] == {"available": False}


def test_lista_current_blocked_artifact_renders_controls_not_zero_reward(root, client):
    current_audit_state(root)
    value = lista_profit_trigger(root)
    assert lista_auction_incentive_profit_trigger_valid(value) is True
    trigger = snapshot(ArtifactReader(root))["lista_auction_incentive_profit_trigger"]
    assert trigger["available"] is True
    assert trigger["economics"]["reported"] is False
    body = get(client, "/").get_data(as_text=True)
    assert "BLOCKED_WHITELIST" in body
    assert "Public caller False" in body
    assert "Not reported: no active auction or economics run" in body
    detail = get(client, "/monitors/lista-auction-incentive").get_data(as_text=True)
    assert "LISTA AUCTION-RESET READINESS" in detail


def test_lista_positive_gross_is_not_a_net_positive_route(root, client):
    current_audit_state(root)
    value = lista_profit_trigger(root, positive_gross=True)
    assert lista_auction_incentive_profit_trigger_valid(value) is True
    body = get(client, "/").get_data(as_text=True)
    assert "POSITIVE_GROSS_FORK_WARRANTED" in body
    assert "conservativeNetRaw: Not reported" in body
    assert "reported positive" not in body


def test_lista_missing_invalid_and_cached_artifacts_fail_closed(root, client):
    current_audit_state(root)
    assert snapshot(ArtifactReader(root))["lista_auction_incentive_profit_trigger"] == {"available": False}
    value = lista_profit_trigger(root)
    value["chainId"] = 1
    write(root, "reports/monitor/lista-auction-incentive-profit-trigger.json", value)
    assert lista_auction_incentive_profit_trigger_valid(value) is False
    reader = ArtifactReader(root)
    assert snapshot(reader)["lista_auction_incentive_profit_trigger"] == {"available": False}
    valid = lista_profit_trigger(root)
    assert snapshot(reader)["lista_auction_incentive_profit_trigger"]["available"] is True
    (root / "reports/monitor/lista-auction-incentive-profit-trigger.json").write_text("{", encoding="utf8")
    assert snapshot(reader)["lista_auction_incentive_profit_trigger"] == {"available": False}
    assert "Lista auction-reset readiness" in get(client, "/").get_data(as_text=True)


def test_deployed_delta_sentinel_accepts_exact_seventeen_and_rejects_malformed_lists(root):
    sentinel = delta_sentinel(root)
    assert [(row["id"], row["sourceClass"]) for row in sentinel["repositories"]] == list(SENTINEL_REPOSITORIES)
    assert official_deployed_delta_sentinel_valid(sentinel) is True

    reordered = deepcopy(sentinel)
    reordered["repositories"][0], reordered["repositories"][1] = reordered["repositories"][1], reordered["repositories"][0]
    assert official_deployed_delta_sentinel_valid(reordered) is False

    malformed = deepcopy(sentinel)
    malformed["repositories"][-1]["sourceClass"] = "deployment-registry"
    assert official_deployed_delta_sentinel_valid(malformed) is False

    missing = deepcopy(sentinel)
    missing["repositories"].pop()
    assert official_deployed_delta_sentinel_valid(missing) is False

    extra = deepcopy(sentinel)
    extra["repositories"].append(deepcopy(extra["repositories"][-1]))
    assert official_deployed_delta_sentinel_valid(extra) is False


def test_continuous_watch_current_pass_and_stale_summary_are_separate(root, client):
    current_audit_state(root)
    stx = stex_profit_trigger(root)
    etherfi = etherfi_profit_trigger(root)
    lista = lista_profit_trigger(root)
    live_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    for value, path in (
        (stx, "reports/monitor/stex-profit-trigger.json"),
        (etherfi, "reports/monitor/etherfi-debtmanager-profit-trigger.json"),
        (lista, "reports/monitor/lista-auction-incentive-profit-trigger.json"),
    ):
        value["generatedAt"] = live_at
        write(root, path, value)
    scheduler = scheduler_state(root, live_at, live_at, live_at)
    scheduler["generatedAt"] = live_at
    scheduler["startedAt"] = live_at
    scheduler["cycle"].update(startedAt=live_at, completedAt=live_at)
    write(root, "reports/monitor/trigger-watch-scheduler.json", scheduler)
    sentinel = delta_sentinel(root)
    assert trigger_watch_scheduler_valid(scheduler)
    assert official_deployed_delta_sentinel_valid(sentinel)
    now = timestamp(live_at)
    data = snapshot(ArtifactReader(root), now=now)
    assert data["continuous_watch"]["operational"] is True
    assert all(row["aligned"] for row in data["continuous_watch"]["producers"])
    assert data["current_audit_state"]["freshness"] == "STALE"
    body = get(client, "/").get_data(as_text=True)
    assert "Four-producer cycle aligned" in body
    assert "this does not establish daemon liveness" in body
    assert "separate from the scheduled campaign producer snapshots" in body
    assert "No current continuous monitor status" not in body
    assert "No current legacy monitor status" in body
    assert "Incomplete: fail-closed, no baseline, no candidate claim" in body
    assert "secret-etag" not in body
    assert "No manual command; triage only on a positive trigger or candidate-change" in body


def test_stale_legacy_scheduler_does_not_claim_a_live_watch(root, client):
    old_at = "2026-08-28T23:56:25.067Z"
    scheduler_state(root, old_at, old_at, old_at, running=True)
    assert snapshot(ArtifactReader(root))["continuous_watch"]["operational"] is False
    body = get(client, "/").get_data(as_text=True)
    assert "Legacy scheduler record is stale" in body
    assert "Persisted PASS or running fields are not proof of current operation" in body
    assert "Continuous watch active" not in body
    assert "Running, but needs review" not in body


def test_aave_event_watch_outcomes_alignment_and_fail_closed_states(root):
    live_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    stx, etherfi, lista = stex_profit_trigger(root), etherfi_profit_trigger(root), lista_profit_trigger(root)
    for value, path in ((stx, "reports/monitor/stex-profit-trigger.json"), (etherfi, "reports/monitor/etherfi-debtmanager-profit-trigger.json"), (lista, "reports/monitor/lista-auction-incentive-profit-trigger.json")):
        value["generatedAt"] = live_at
        write(root, path, value)

    scheduler = scheduler_state(root, live_at, live_at, live_at, aave_outcome="EVENT_SURVIVOR_NO_ROUTE")
    scheduler["generatedAt"] = live_at
    scheduler["startedAt"] = live_at
    scheduler["cycle"].update(startedAt=live_at, completedAt=live_at)
    write(root, "reports/monitor/trigger-watch-scheduler.json", scheduler)
    survivor = snapshot(ArtifactReader(root), now=timestamp(live_at))
    aave = survivor["aave_v3_arbitrum_config_oracle_events"]
    assert aave_v3_arbitrum_config_oracle_events_valid(aave_v3_arbitrum_events(root, live_at, outcome="EVENT_SURVIVOR_NO_ROUTE"))
    assert aave["event_survivor"] is True and aave["positive"] is False and aave["route_positive"] == "n/a"
    assert survivor["continuous_watch"]["producers"][3] == {"id": "aave-v3-arbitrum-config-oracle-events", "status": "PASS", "trigger_status": "EVENT_SURVIVOR_NO_ROUTE", "aligned": True}

    incomplete_scheduler = scheduler_state(root, live_at, live_at, live_at, status="DEGRADED", aave_outcome="INCOMPLETE")
    incomplete_scheduler["generatedAt"] = live_at
    incomplete_scheduler["startedAt"] = live_at
    incomplete_scheduler["cycle"].update(startedAt=live_at, completedAt=live_at)
    write(root, "reports/monitor/trigger-watch-scheduler.json", incomplete_scheduler)
    incomplete = snapshot(ArtifactReader(root), now=timestamp(live_at))
    assert incomplete["aave_v3_arbitrum_config_oracle_events"]["status"] == "INCOMPLETE"
    assert incomplete["continuous_watch"]["operational"] is False

    stale_at = "2026-08-28T00:00:00Z"
    stale_scheduler = scheduler_state(root, live_at, live_at, stale_at)
    stale_scheduler["generatedAt"] = live_at
    stale_scheduler["startedAt"] = live_at
    stale_scheduler["cycle"].update(startedAt=live_at, completedAt=live_at)
    write(root, "reports/monitor/trigger-watch-scheduler.json", stale_scheduler)
    stale = snapshot(ArtifactReader(root), now=timestamp(live_at))
    assert stale["continuous_watch"]["producers"][3]["aligned"] is False
    assert stale["continuous_watch"]["operational"] is False

    malformed = aave_v3_arbitrum_events(root, live_at)
    malformed["reads"]["maximum"] = 41
    write(root, "reports/monitor/aave-v3-arbitrum-config-oracle-events.json", malformed)
    assert aave_v3_arbitrum_config_oracle_events_valid(malformed) is False
    assert snapshot(ArtifactReader(root), now=timestamp(live_at))["continuous_watch"]["producers"][3]["aligned"] is False


def test_continuous_watch_alignment_and_scheduler_fail_closed(root):
    stx = stex_profit_trigger(root)
    etherfi = etherfi_profit_trigger(root)
    lista = lista_profit_trigger(root)
    scheduler = scheduler_state(root, stx["generatedAt"], etherfi["generatedAt"], lista["generatedAt"])
    delta_sentinel(root)
    scheduler["producers"][0]["generatedAt"] = "2026-08-28T00:00:00Z"
    write(root, "reports/monitor/trigger-watch-scheduler.json", scheduler)
    data = snapshot(ArtifactReader(root), now=timestamp(scheduler["generatedAt"]))
    assert data["continuous_watch"]["producers"][0]["aligned"] is False
    assert data["continuous_watch"]["operational"] is False
    scheduler["running"] = False
    write(root, "reports/monitor/trigger-watch-scheduler.json", scheduler)
    assert snapshot(ArtifactReader(root))["continuous_watch"]["operational"] is False
    reader = ArtifactReader(root)
    scheduler["running"] = True
    scheduler["producers"][0]["generatedAt"] = stx["generatedAt"]
    write(root, "reports/monitor/trigger-watch-scheduler.json", scheduler)
    assert snapshot(reader)["continuous_watch"]["available"] is True
    (root / "reports/monitor/trigger-watch-scheduler.json").write_text("{", encoding="utf8")
    assert snapshot(reader)["continuous_watch"] == {"available": False}


def test_sentinel_candidate_change_is_metadata_only_and_legacy_venus_stays_stale(root, client):
    current_audit_state(root)
    stx = stex_profit_trigger(root)
    etherfi = etherfi_profit_trigger(root)
    lista = lista_profit_trigger(root)
    scheduler_state(root, stx["generatedAt"], etherfi["generatedAt"], lista["generatedAt"])
    delta_sentinel(root, status="candidate-change")
    venus_state(root)
    now = timestamp("2026-08-28T23:56:25.067Z")
    data = snapshot(ArtifactReader(root), now=now)
    assert monitor(data, "venus-psr-bnb-drift")["freshness"] == "STALE"
    body = get(client, "/").get_data(as_text=True)
    assert "Metadata candidate requiring coordinator triage; not deployment, vulnerability, or route proof" in body


def test_scheduler_capability_rotation_legacy_and_expanded_health(root, client):
    current_audit_state(root)
    stx, etherfi, lista = stex_profit_trigger(root), etherfi_profit_trigger(root), lista_profit_trigger(root)
    legacy = scheduler_state(root, stx["generatedAt"], etherfi["generatedAt"], lista["generatedAt"])
    assert trigger_watch_scheduler_valid(legacy) is True
    rotation = {"artifactPath": "reports/monitor/etherfi-optimism-provider-capability-rotation.json", "status": "READY", "lastAttemptAt": "2026-08-28T23:00:00Z", "nextDueAt": "2026-08-29T05:00:00Z", "durationMs": 1, "exitCode": 0}
    expanded = scheduler_state(root, stx["generatedAt"], etherfi["generatedAt"], lista["generatedAt"], rotation=rotation)
    delta_sentinel(root)
    assert trigger_watch_scheduler_valid(expanded) is True
    data = snapshot(ArtifactReader(root), now=timestamp(expanded["generatedAt"]))
    assert data["continuous_watch"]["capability_rotation"]["status"] == "READY"
    body = get(client, "/").get_data(as_text=True)
    assert "Provider rotation" in body
    assert "additional anonymous state-capable family available for future replacement; no route claim" in body
    assert "provider rotation.*profit" not in body.lower()


def test_scheduler_capability_rotation_rejects_invalid_and_incomplete_copy(root, client):
    current_audit_state(root)
    stx, etherfi, lista = stex_profit_trigger(root), etherfi_profit_trigger(root), lista_profit_trigger(root)
    rotation = {"artifactPath": "reports/monitor/etherfi-optimism-provider-capability-rotation.json", "status": "INCOMPLETE", "lastAttemptAt": "2026-08-28T23:00:00Z", "nextDueAt": "2026-08-29T05:00:00Z", "durationMs": 1, "exitCode": 0}
    scheduler = scheduler_state(root, stx["generatedAt"], etherfi["generatedAt"], lista["generatedAt"], rotation=rotation)
    delta_sentinel(root)
    assert trigger_watch_scheduler_valid(scheduler) is True
    assert "no bounded replacement observed; no route claim" in get(client, "/").get_data(as_text=True)
    scheduler["capabilityRotation"]["exitCode"] = 1
    assert trigger_watch_scheduler_valid(scheduler) is False
    scheduler["capabilityRotation"].pop("durationMs")
    assert trigger_watch_scheduler_valid(scheduler) is False


def test_scheduler_aave_v4_binder_refresh_additive_health(root, client):
    current_audit_state(root)
    stx, etherfi, lista = stex_profit_trigger(root), etherfi_profit_trigger(root), lista_profit_trigger(root)
    scheduler = scheduler_state(root, stx["generatedAt"], etherfi["generatedAt"], lista["generatedAt"])
    scheduler["aaveV4BinderRefresh"] = {"status": "PASS", "lastAttemptAt": "2026-08-28T23:55:00Z", "durationMs": 4, "exitCode": 0}
    assert trigger_watch_scheduler_valid(scheduler) is True
    scheduler["aaveV4BinderRefresh"] = {"status": "PASS", "lastAttemptAt": None, "durationMs": 4, "exitCode": 0}
    assert trigger_watch_scheduler_valid(scheduler) is False
    scheduler["aaveV4BinderRefresh"] = {"status": "NOT_INSTALLED", "lastAttemptAt": "2026-08-28T23:55:00Z", "durationMs": 0, "exitCode": None}
    assert trigger_watch_scheduler_valid(scheduler) is True
    scheduler["aaveV4BinderRefresh"] = {"status": "NOT_INSTALLED", "lastAttemptAt": "2026-08-28T23:55:00Z", "durationMs": 0, "exitCode": 0}
    assert trigger_watch_scheduler_valid(scheduler) is False
    scheduler["aaveV4BinderRefresh"] = {"status": "NOT_DUE", "lastAttemptAt": None, "durationMs": 0, "exitCode": None}
    assert trigger_watch_scheduler_valid(scheduler) is True


def test_monitor_status_is_separate_from_disposition_and_stale_is_unknown(root):
    state(root, {"morpho-liq": {"lastResult": {"checkedAt": 1_000, "liquidatable": 0, "totalBorrowers": 1}}})
    current = monitor(snapshot(ArtifactReader(root), now=1_001), "morpho-liq")
    assert current["disposition"] == "KEEP_COLD"
    assert current["status"] == "CLEAR"
    assert current["status_source"] == "STATE"
    assert current["status_at"] is not None
    stale = monitor(snapshot(ArtifactReader(root), now=12_000), "morpho-liq")
    assert stale["status"] == "UNKNOWN"
    assert stale["status_at"] is None


def test_snapshot_partitions_current_and_historical_alarms(root, client):
    now = datetime.now(timezone.utc).timestamp()
    state(root, {"hyperlend": {"lastCheck": now, "routeCandidates": [{}], "divergentStaleSources": [], "staleSourceWatchpoints": []}})
    (root / "reports/monitor/alerts.jsonl").write_text(
        json.dumps({"condition": "unmapped", "severity": "HIGH", "timestamp": now - 1_000_000}) + "\n",
        encoding="utf8",
    )
    data = snapshot(ArtifactReader(root), now=now + 1)
    assert len(data["current_alarms"]) == 1
    assert len(data["historical_alarms"]) == 1
    body = get(client, "/alarms").get_data(as_text=True)
    assert "1 current" in body
    assert "HISTORICAL CONTEXT" in body
    assert "NOT ACTIONABLE NOW" in body


def request_with_host(client, host, remote="127.0.0.1", method="GET", path="/"):
    # Invoke WSGI directly so malformed Host fixtures reach the application's
    # validator instead of failing in Werkzeug's test-client URL bookkeeping.
    environ = EnvironBuilder(
        path=path,
        method=method,
        base_url="http://127.0.0.1:5050",
    ).get_environ()
    environ.update(HTTP_HOST=host, REMOTE_ADDR=remote)
    captured = {}

    def start_response(status, _headers, _exc_info=None):
        captured["status"] = status

    response = client.application.wsgi_app(environ, start_response)
    try:
        list(response)
    finally:
        if hasattr(response, "close"):
            response.close()
    return SimpleNamespace(status_code=int(captured["status"].split()[0]))


@pytest.mark.parametrize("host", ["127.0.0.1", "127.0.0.1:5050", "localhost", "LOCALHOST:65535", "[::1]", "[::1]:5050", "::1"])
def test_loopback_hosts_are_accepted(client, host):
    assert request_with_host(client, host).status_code == 200


@pytest.mark.parametrize("host", ["example.test", "localhost.evil", "localhost:0", "localhost:65536", "localhost:-1", "[::1", "[::1]evil", "[::1]:99999", "::1:5050", "user@localhost", "localhost,evil", " localhost"])
def test_hostile_or_malformed_hosts_are_rejected(client, host):
    assert request_with_host(client, host).status_code == 403


def test_ipv6_remote_and_non_loopback_remote(client):
    assert request_with_host(client, "[::1]:5050", remote="::1").status_code == 200
    assert request_with_host(client, "localhost", remote="192.0.2.1").status_code == 403


@pytest.mark.parametrize("method", ["GET", "HEAD", "OPTIONS"])
def test_read_only_methods(client, method):
    assert request_with_host(client, "127.0.0.1:5050", method=method).status_code == 200


@pytest.mark.parametrize("method", ["POST", "PUT", "PATCH", "DELETE"])
def test_modifying_methods_are_rejected(client, method):
    assert request_with_host(client, "127.0.0.1:5050", method=method).status_code == 405


def test_headers_health_empty_object_and_404(client):
    response = get(client, "/api/v1/snapshot")
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-store"
    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert response.headers["Referrer-Policy"] == "no-referrer"
    assert "default-src 'self'" in response.headers["Content-Security-Policy"]
    assert get(client, "/healthz").get_json() == {
        "available": True,
        "parser": "ready",
        "sources": {
            "legacy": {"available": True, "source": "available"},
            "venus_psr": {"available": False, "source": "unavailable"},
        },
    }
    missing = get(client, "/monitors/not-real")
    assert missing.status_code == 404
    assert missing.headers["Cache-Control"] == "no-store"


def test_health_does_not_report_cached_state_available(client, root):
    assert get(client, "/healthz").get_json()["available"] is True
    (root / "reports/monitor/state.json").write_text("{", encoding="utf8")
    health = get(client, "/healthz").get_json()
    assert health == {
        "available": False,
        "parser": "ready",
        "sources": {
            "legacy": {"available": False, "source": "invalid"},
            "venus_psr": {"available": False, "source": "unavailable"},
        },
    }
    data = get(client, "/api/v1/snapshot").get_json()
    assert data["no_current_live_status"] is True
    assert all(
        row["alarm"] != "CURRENT"
        for row in data["monitors"]
        if row["source_health"] != "OK"
    )

    venus_state(root)
    health = get(client, "/healthz").get_json()
    assert health["available"] is True
    assert health["sources"]["legacy"]["available"] is False
    assert health["sources"]["venus_psr"] == {"available": True, "source": "available"}


def test_detail_event_matching_uses_exact_alias_map(client, root):
    path = root / "reports/monitor/alerts.jsonl"
    now = datetime.now(timezone.utc).timestamp()
    path.write_bytes(
        json.dumps({"condition": "aave-v3", "severity": "HIGH", "timestamp": now}).encode()
        + b"\n"
        + json.dumps({"condition": "aave-v4", "severity": "HIGH", "timestamp": now}).encode()
        + b"\n"
    )
    body = get(client, "/monitors/aave-v3-hf-watch").get_data(as_text=True)
    assert "aave-v3-hf-watch" in body
    assert "aave-v4-liquidation-watch" not in body


def test_detail_page_uses_newest_twenty_related_events(client, root):
    now = datetime.now(timezone.utc).timestamp()
    events = []
    for index in range(25):
        events.append(
            {
                "condition": "aave-v3",
                "severity": "HIGH" if index >= 5 else "WARN",
                "timestamp": now - (24 - index),
                "market": str(index),
            }
        )
    path = root / "reports/monitor/alerts.jsonl"
    path.write_bytes(b"".join(json.dumps(row).encode() + b"\n" for row in events))
    body = get(client, "/monitors/aave-v3-hf-watch").get_data(as_text=True)
    assert body.count('class="event"') == 20
    assert ">WARN<" not in body


def test_api_leak_scan(client):
    body = get(client, "/api/v1/snapshot").get_data(as_text=True)
    forbidden_literals = (
        "http://",
        "https://",
        "rpc_endpoints",
        "graphql_endpoints",
        ".env",
        "private_key",
        "api_key",
        "secret_key",
        "reports/monitor",
        "reports/raw",
    )
    for forbidden in forbidden_literals:
        assert forbidden.lower() not in body.lower()
    assert not re.search(r"[A-Za-z]:[\\/]", body)
    assert not re.search(r'(?:(?<=\")|(?<=\s))/(?:home|Users|var|tmp|etc)/', body)


def test_overview_renders_venus_chain_cards_and_fresh_drift_context(client, root):
    venus_state(
        root,
        attempt=datetime.now(timezone.utc).timestamp(),
        statuses={"bnb": "DRIFT", "ethereum": "ERROR", "arbitrum": "CLEAR"},
    )
    body = get(client, "/").get_data(as_text=True)
    assert "VENUS PSR / MULTICHAIN" in body
    assert "BNB Chain" in body and "Ethereum" in body and "Arbitrum" in body
    assert "Drift confirmed" in body
    assert "Read error — status not confirmed" in body
    assert "No drift observed" in body
    assert "Current finalized block" in body and "Baseline block" in body
    assert "Drift is a comparison result, not an exploit or route-positive claim." in body


def test_overview_renders_venus_empty_state_without_source_paths(client):
    body = get(client, "/").get_data(as_text=True)
    assert "No current Venus producer state" in body
    assert "./tools/start-dashboard-live.ps1 -UseAuthorizedInventory" in body
    assert "reports/monitor" not in body and "reports/raw" not in body


def test_overview_uses_same_origin_progressive_refresh_under_existing_csp(client):
    response = get(client, "/")
    body = response.get_data(as_text=True)
    assert 'src="/static/refresh.js" defer' in body
    assert 'data-refresh-interval="60000"' in body
    assert "Automatic refresh paused while this tab is hidden." in (
        get(client, "/static/refresh.js").get_data(as_text=True)
    )
    csp = response.headers["Content-Security-Policy"]
    assert "default-src 'self'" in csp and "script-src" not in csp


def base_paper(root, study="R9"):
    generated = "2026-09-05T19:44:46.684Z"
    value = {
        "schema": "base-paper-cycle/v8" if study == "R8" else "base-paper-usds/v9",
        "chainId": 8453, "generatedAt": generated, "completedAt": "2026-09-05T19:45:43.441Z",
        "study": "ORDINARY_MARKET_QUOTES_ONLY", "status": "OBSERVED_UNPROMOTED", "phase": "TERMINAL",
        "code": "NO_CAPACITY_BACKED_POSITIVE_QUOTE_AT_TESTED_SIZES",
        "addresses": {
            "usdc": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", "psm": "0x1601843c5e9bc251a3272907010afa41fa18347e",
            "pool": "0xaa9780e54843013ff2ee957d103e96f4777a54e7" if study == "R8" else "0x81057171115672ac7d08bbebb04481e19aa0bfeb",
            "susds": "0x5875eee11cf8398102fdad704c9e96607675467a", "usds": "0x820c137fa70c8691f0e44dc420a5e53c168921dc",
            "weth": "0x4200000000000000000000000000000000000006",
        },
        "inputSizesUsdcRaw": [str(n * 1_000_000) for n in (1, 5, 10, 25, 50, 100)],
        "source": {"sourceRuntimeBound": "unknown"},
        "qualification": {"attempted": 4, "qualified": 3, "selectedFamilyCount": 2},
        "economics": {"costsComplete": False, "allSizesDisproved": False, **{key: None for key in ("conservativeNetUsdc", "conservativeNetUsd", "conservativeNetNative", "netBps", "fills", "realizedPnl")}},
        "gates": {"profitabilityClaim": False, "signedActionJustified": False, "executableNow": "unknown", "transferSuccess": "unknown"},
        "safety": {"readOnly": True, "readOnlyRpc": True, "endpointMaterialPersisted": False, "walletAccess": False, "signing": False, "transactions": 0, "retries": 0},
        "observation": {
            "pin": {"number": "50923161", "hash": "0x" + "ab" * 32, "parentHash": "0x" + "cd" * 32, "stateRoot": "0x" + "ef" * 32, "timestamp": str(int(timestamp(generated)) - 60)},
            "rpcStrength": "corroborated-operator-families", "upstreamIndependenceProven": False,
            "psm": {"capacityIsTransferProof": False, "balanceAllowanceCapacityRaw": "1000000000"}, "rows": [],
        },
    }
    for size in value["inputSizesUsdcRaw"]:
        surplus = -73 * (int(size) // 1_000_000)
        value["observation"]["rows"].append({"inputUsdcRaw": size, "outputUsdcRaw": str(int(size) + surplus), "quotedSurplusUsdcRaw": str(surplus),
            "quotedSurplusBps": {"numerator": str(surplus * 10000), "denominator": size}, "quoteIncludesPoolFeesAndImpact": True,
            "conservativeNetUsdc": None, "executable": "unknown", "pocketBalanceAllowanceSufficient": True,
            "fullInputExecutionVerified": False, "quoterGasIsCycleGas": False})
    write(root, artifact_module.ALLOWLIST[f"base_paper_{study.lower()}"], value)
    return value


@pytest.mark.parametrize("study", ["R8", "R9"])
def test_base_paper_negative_quotes_preserve_unknown_net_and_original_pin(root, study):
    value = base_paper(root, study)
    assert base_paper_valid(value, study)
    data = snapshot(ArtifactReader(root), now=timestamp(value["generatedAt"]) + 100)
    card = next(card for card in data["base_paper"] if card["study"] == study)
    assert card["status"] == "PARK" and card["freshness"] == "FRESH"
    assert card["best_quoted_change_usdc"] == "-0.000073" and card["best_input_usdc"] == "1.000000"
    assert len(card["rows"]) == 6 and card["conservative_net_usdc"] is None
    assert card["generated_at"] == value["generatedAt"] and card["block_hash"] == value["observation"]["pin"]["hash"]
    assert card["profitability_claim"] is False and card["executable_now"] == "unknown"


@pytest.mark.parametrize("age,expected", [(2000, "AGING"), (6000, "STALE"), (-600, "CLOCK_SKEW")])
def test_base_paper_source_age_is_not_refreshed_by_page_load(root, age, expected):
    value = base_paper(root)
    card = snapshot(ArtifactReader(root), now=timestamp(value["generatedAt"]) + age)["base_paper"][1]
    assert card["freshness"] == expected and card["generated_at"] == value["generatedAt"]
    assert card["executable_now"] == "unknown"


@pytest.mark.parametrize("keys,bad", [
    (("schema",), "base-paper-usds/v10"), (("chainId",), 1), (("status",), "PROFITABLE"),
    (("code",), "https://private.invalid/key"), (("generatedAt",), None), (("completedAt",), "2026-01-01T00:00:00Z"),
    (("addresses", "usdc"), "0x" + "00" * 20), (("qualification", "selectedFamilyCount"), True),
    (("gates", "profitabilityClaim"), True), (("gates", "executableNow"), "true"), (("gates", "signedActionJustified"), True),
    (("economics", "costsComplete"), True), (("economics", "conservativeNetUsdc"), "1"), (("economics", "fills"), 0),
    (("safety", "transactions"), False), (("safety", "signing"), True), (("source", "sourceRuntimeBound"), "true"),
    (("observation", "upstreamIndependenceProven"), True), (("observation", "pin", "hash"), "bad"),
    (("observation", "psm", "capacityIsTransferProof"), True), (("observation", "rows", 0, "quotedSurplusUsdcRaw"), "100"),
    (("observation", "rows", 0, "pocketBalanceAllowanceSufficient"), 1), (("observation", "rows", 0, "quoterGasIsCycleGas"), True),
    (("observation", "rows"), []), (("observation",), None),
])
def test_base_paper_malformed_or_promotional_artifact_is_rejected(root, keys, bad):
    value = base_paper(root)
    parent = value
    for key in keys[:-1]:
        parent = parent[key]
    parent[keys[-1]] = bad
    assert not base_paper_valid(value, "R9")
    write(root, artifact_module.ALLOWLIST["base_paper_r9"], value)
    card = snapshot(ArtifactReader(root))["base_paper"][1]
    assert card["status"] == "UNAVAILABLE" and card["rows"] == []


def test_base_paper_positive_quote_with_incomplete_costs_is_watch_only(root, client):
    value = base_paper(root)
    row = value["observation"]["rows"][0]
    row.update(outputUsdcRaw="1000100", quotedSurplusUsdcRaw="100", quotedSurplusBps={"numerator": "1000000", "denominator": "1000000"})
    value["code"] = "QUOTED_SURPLUS_REQUIRES_VALIDATION"
    write(root, artifact_module.ALLOWLIST["base_paper_r9"], value)
    card = snapshot(ArtifactReader(root))["base_paper"][1]
    assert card["status"] == "WATCH" and card["best_quoted_change_usdc"] == "0.000100"
    assert card["conservative_net_usdc"] is None and card["profitability_claim"] is False
    assert "Unknown: full costs and transfers unverified" in get(client, "/").get_data(as_text=True)


def test_base_paper_missing_and_cached_artifacts_never_supply_current_quotes(root):
    reader = ArtifactReader(root)
    assert all(card["status"] == "UNAVAILABLE" for card in snapshot(reader)["base_paper"])
    base_paper(root)
    assert snapshot(reader)["base_paper"][1]["available"]
    write(root, artifact_module.ALLOWLIST["base_paper_r9"], {"broken": True})
    card = snapshot(reader)["base_paper"][1]
    assert card["cached"] is True and card["available"] is False and card["rows"] == []


def test_base_paper_incomplete_observation_is_not_zero_or_negative(root):
    value = base_paper(root)
    value.update(status="INCOMPLETE", code="TWO_QUOTE_CAPABLE_FAMILIES_UNAVAILABLE", observation=None)
    value["qualification"].update(selectedFamilyCount=0, qualified=1)
    write(root, artifact_module.ALLOWLIST["base_paper_r9"], value)
    card = snapshot(ArtifactReader(root))["base_paper"][1]
    assert card["status"] == "INCOMPLETE" and card["rows"] == []
    assert card["conservative_net_usdc"] is None


def test_base_paper_html_api_and_read_only_boundary(client, root):
    base_paper(root, "R8")
    base_paper(root, "R9")
    body = get(client, "/").get_data(as_text=True)
    assert body.index("CURRENT OPERATIONS") < body.index("ORDINARY MARKET RESEARCH") < body.index("CURRENT AUDIT STATE")
    assert "BASE R8" in body and "BASE R9" in body and "Show six-size quote table" in body
    assert "upstream independence unproven" in body and "not transfer proof" in body
    assert "reports/raw" not in body
    response = get(client, "/api/v1/snapshot")
    assert len(response.get_json()["base_paper"]) == 2
    assert "reports/raw" not in response.get_data(as_text=True)


# --------------------------------------------------------------------------- #
# Operational panels: campaign, pipeline, mode, wallets
# --------------------------------------------------------------------------- #


def iso_utc(epoch):
    return datetime.fromtimestamp(epoch, timezone.utc).isoformat().replace("+00:00", "Z")


def coverage_row(rid, status, observed_at, expires_at=None, evidence=None, blockers=None):
    return {
        "id": rid,
        "status": status,
        "observedAt": observed_at,
        "expiresAt": expires_at,
        "artifactPath": f"reports/monitor/trigger-coverage/{rid}.json",
        "artifactSha256": "b" * 64,
        "evidence": evidence if evidence is not None else ["reports/raw/fast/source.json#totals"],
        "blockers": blockers or [],
    }


def trigger_coverage_audit(root, rows, *, audited_at=None, done=True):
    audited_at = audited_at or iso_utc(datetime.now(timezone.utc).timestamp())
    value = {
        "schema": "trigger-coverage-audit/v1",
        "auditedAt": audited_at,
        "universeSha256": "a" * 64,
        "rows": rows,
        "done": done,
    }
    write(root, "reports/monitor/trigger-coverage-audit.json", value)
    return value


def profit_trigger_watch(root, producers, *, generated_at=None, running=True):
    generated_at = generated_at or iso_utc(datetime.now(timezone.utc).timestamp())
    value = {
        "schema": "profit-trigger-watch/v1",
        "generatedAt": generated_at,
        "running": running,
        "producers": producers,
        "safety": {
            "localOnly": True,
            "readOnly": True,
            "automaticRetries": 0,
            "transactionsInitiated": 0,
            "signing": False,
            "broadcast": False,
        },
    }
    write(root, "reports/monitor/profit-trigger-watch.json", value)
    return value


def producer(pid, status, reason, at):
    return {"id": pid, "status": status, "reason": reason, "evidence": {"chainId": 1}, "generatedAt": at}


def autopilot_status(root, *, classification="NO_FIRED_EVENT", generated_at=None, blocker=None, summary=None):
    generated_at = generated_at or iso_utc(datetime.now(timezone.utc).timestamp())
    base_summary = {
        "producers": 16, "fired": 0, "eligible": 0, "planned": 0, "executed": 0,
        "succeeded": 0, "failed": 0, "deduped": 0, "history": 3,
    }
    base_summary.update(summary or {})
    value = {
        "schema": "trigger-fork-autopilot-status/v1",
        "generatedAt": generated_at,
        "mode": "APPLY",
        "classification": classification,
        "blocker": blocker,
        "source": {"path": "reports/monitor/profit-trigger-watch.json", "schema": "profit-trigger-watch/v1", "fresh": True},
        "plan": [],
        "summary": base_summary,
        "execution": None,
        "safety": {
            "localOnly": True, "keyless": True, "sequential": True, "noSigning": True,
            "noBroadcast": True, "maxForksPerPass": 1, "maxWallMs": 210000,
            "lockLeaseMs": 300000, "endpointMaterialPersisted": False,
        },
    }
    write(root, "reports/monitor/trigger-fork-autopilot-status.json", value)
    return value


def autopilot_event(pid, *, promoted=False, terminal=True, at=None, net=None, result="FAIL_CLOSED", blocker: "str | None" = "SCENARIO_TX_REVERTED", phase="FAILED"):
    at = at or iso_utc(datetime.now(timezone.utc).timestamp())
    return {
        "producerId": pid, "firedStatus": "ATOMIC_FORK_REQUIRED", "phase": phase,
        "terminal": terminal, "attempts": 1, "firstSeenAt": at, "lastAttemptAt": at,
        "success": promoted, "result": result, "blocker": blocker,
        "forkArtifact": "reports/raw/fast/fork-poc/probe.json", "net": net, "promoted": promoted,
    }


def autopilot_state(root, events, *, updated_at=None):
    updated_at = updated_at or iso_utc(datetime.now(timezone.utc).timestamp())
    value = {
        "schema": "trigger-fork-autopilot-state/v1",
        "updatedAt": updated_at,
        "events": events,
        "routeCooldowns": {},
        "history": [],
    }
    write(root, "reports/monitor/trigger-fork-autopilot-state.json", value)
    return value


def alert_dispatcher(root, *, generated_at=None, summary=None, result="PASS"):
    generated_at = generated_at or iso_utc(datetime.now(timezone.utc).timestamp())
    base = {
        "observations": 1, "wouldAlert": 0, "enqueued": 0, "dispatched": 0, "delivered": 0,
        "deliveryUnavailable": 0, "pending": 0, "acknowledged": 0, "queueSize": 0, "dropped": 0,
    }
    base.update(summary or {})
    value = {
        "schema": "monitor-alert-dispatcher-status/v1",
        "generatedAt": generated_at,
        "mode": "apply",
        "baselineEstablished": False,
        "summary": base,
        "wouldAlerts": [],
        "lastDelivery": None,
        "queue": {"path": "reports/monitor/monitor-alert-queue.json", "pending": base["pending"], "acknowledged": base["acknowledged"], "size": base["queueSize"]},
        "lastRun": {"startedAt": generated_at, "completedAt": generated_at, "result": result},
    }
    write(root, "reports/monitor/monitor-alert-dispatcher-status.json", value)
    return value


def set_watchdog(root, *, generated_at=None, summary=None, inspection="ok"):
    generated_at = generated_at or iso_utc(datetime.now(timezone.utc).timestamp())
    base = {"total": 1, "running": 1, "missing": 0, "relaunched": 0, "failed": 0, "cooldown": 0, "wouldRelaunch": 0}
    base.update(summary or {})
    value = {
        "schema": "monitor-set-watchdog-status/v1",
        "generatedAt": generated_at,
        "mode": "apply",
        "inspection": inspection,
        "wallClockCapped": False,
        "limits": {"maxRelaunchesPerPass": 3, "maxAttemptsPerService": 5, "maxWallClockMs": 25000},
        "summary": base,
        "services": [{"id": "novelty-monitor", "running": True}],
    }
    write(root, "reports/monitor/monitor-set-watchdog-status.json", value)
    return value


def watch_addresses(root, addresses):
    value = {"addresses": addresses}
    write(root, "coordination/watch-addresses.json", value)
    return value


def approver_registry(root, approvers):
    value = {"schema": "live-execution-approver-registry/v1", "approvers": approvers}
    write(root, "coordination/live-execution-approvers.json", value)
    return value


def live_execution_batch(root, *, status="APPROVED", expires_at=None, actions=None, approvers=None):
    now = datetime.now(timezone.utc).timestamp()
    value = {
        "batchId": "batch-1",
        "status": status,
        "expiresAt": expires_at or iso_utc(now + 3600),
        "actions": actions if actions is not None else [{"kind": "review"}],
        "approvers": approvers if approvers is not None else ["windows-local-approver-20260912-01"],
    }
    write(root, "coordination/live-execution-batch.json", value)
    return value


def wallet_balances(root, *, as_of=None, addresses=None, chains=None, errors=None, duration_ms=120, totals=None, solana=None):
    as_of = as_of or iso_utc(datetime.now(timezone.utc).timestamp())
    value = {
        "schema": "wallet-balances/v1",
        "asOf": as_of,
        "durationMs": duration_ms,
        "watchlistPath": "coordination/watch-addresses.json",
        "addresses": addresses or [],
        "chains": chains or [],
        "errors": errors or [],
    }
    if totals is not None:
        value["totals"] = totals
    if solana is not None:
        value["solana"] = solana
    write(root, "reports/monitor/wallet-balances.json", value)
    return value


def test_trigger_coverage_summary_stale_and_filter(root, client):
    now = datetime.now(timezone.utc).timestamp()
    rows = [
        coverage_row("ethereum-morpho-blue-l", "COVERED", iso_utc(now - 60), iso_utc(now + 300)),
        coverage_row("base-morpho-blue-l", "COVERED", iso_utc(now - 900), iso_utc(now - 300)),
        coverage_row("ethereum-morpho-blue-o", "BLOCKED", iso_utc(now - 120), None, blockers=["oracle observations are incomplete", "on-fire dispatch is disabled"]),
        coverage_row("ethereum-morpho-blue-f", "MISSING", iso_utc(now - 30), None),
    ]
    state = trigger_coverage_audit(root, rows, audited_at=iso_utc(now))
    assert trigger_coverage_valid(state)
    coverage = snapshot(ArtifactReader(root), now=now + 1)["trigger_coverage"]
    assert coverage["available"] and coverage["total"] == 4
    assert coverage["counts"] == {"COVERED": 1, "BLOCKED": 1, "MISSING": 1, "STALE": 1, "OTHER": 0}
    assert coverage["stale_count"] == 1 and coverage["blocked_count"] == 1
    assert coverage["counts"]["COVERED"] + coverage["counts"]["STALE"] == 2
    body = get(client, "/").get_data(as_text=True)
    assert "Trigger coverage audit" in body
    assert "oracle observations are incomplete" in body
    assert "Ethereum · morpho-blue-l" in body
    filtered = get(client, "/?coverage=BLOCKED").get_data(as_text=True)
    assert "ethereum-morpho-blue-o" in filtered
    assert "ethereum-morpho-blue-l" not in filtered


def test_trigger_coverage_absent_and_malformed_fail_closed(root, client):
    empty = snapshot(ArtifactReader(root))["trigger_coverage"]
    assert empty["available"] is False and empty["counts"]["COVERED"] == 0
    assert "Coverage audit unavailable" in get(client, "/").get_data(as_text=True)

    trigger_coverage_audit(root, [coverage_row("bad-row", "covered", "2026-01-01T00:00:00Z")])
    invalid = json.loads((root / "reports/monitor/trigger-coverage-audit.json").read_text())
    assert trigger_coverage_valid(invalid) is False
    assert snapshot(ArtifactReader(root))["trigger_coverage"]["available"] is False

    write(root, "reports/monitor/trigger-coverage-audit.json", {"schema": "trigger-coverage-audit/v1", "auditedAt": "2026-01-01T00:00:00Z", "universeSha256": "a" * 64, "rows": {}, "done": True})
    assert trigger_coverage_valid(json.loads((root / "reports/monitor/trigger-coverage-audit.json").read_text())) is False
    assert snapshot(ArtifactReader(root))["trigger_coverage"]["available"] is False


def test_trigger_coverage_blocker_paths_are_scrubbed(root, client):
    now = datetime.now(timezone.utc).timestamp()
    trigger_coverage_audit(
        root,
        [coverage_row("ethereum-morpho-blue-o", "BLOCKED", iso_utc(now - 10), None, evidence=["reports/raw/fast/x.json#market"], blockers=["artifact reports/monitor/trigger-coverage/x.json is stale"])],
        audited_at=iso_utc(now),
    )
    api = get(client, "/api/v1/snapshot").get_data(as_text=True)
    html = get(client, "/").get_data(as_text=True)
    for body in (api, html):
        assert "reports/monitor" not in body and "reports/raw" not in body
    assert "is stale" in html and "artifact" in html


def test_pipeline_producer_attention_and_strips(root, client):
    now = datetime.now(timezone.utc).timestamp()
    profit_trigger_watch(root, [
        producer("kelp-composite", "BLOCKED_PAUSED", "POOL_PAUSED", iso_utc(now - 60)),
        producer("ostium-settlement-window", "FAILED", "RPC_FAILED", iso_utc(now - 30)),
        producer("clever-harvest", "TIMEOUT", "WALL_CLOCK", iso_utc(now - 20)),
        producer("frax-usdc-cross-venue", "NO_GROSS_EDGE", "NO_GROSS_EDGE", iso_utc(now - 10)),
    ])
    assert profit_trigger_watch_valid(json.loads((root / "reports/monitor/profit-trigger-watch.json").read_text()))
    watch = snapshot(ArtifactReader(root), now=now)["pipeline"]["profit_watch"]
    assert watch["available"] and watch["attention_count"] == 2
    attention = {row["id"] for row in watch["producers"] if row["attention"]}
    assert attention == {"ostium-settlement-window", "clever-harvest"}
    body = get(client, "/").get_data(as_text=True)
    assert "RPC_FAILED" in body and "WALL_CLOCK" in body and "need attention" in body
    assert "loop-mode snapshot" in body
    assert "current process liveness is not established" in body
    profit_trigger_watch(root, [producer("kelp-composite", "BLOCKED_PAUSED", "POOL_PAUSED", iso_utc(now - 60))], running=False)
    body = get(client, "/").get_data(as_text=True)
    assert "one-shot snapshot" in body
    assert "stopped" not in body


def test_profit_watch_malformed_is_unavailable(root):
    value = profit_trigger_watch(root, [producer("kelp-composite", "BLOCKED_PAUSED", "POOL_PAUSED", iso_utc(1_000_000))])
    value["safety"]["signing"] = True
    write(root, "reports/monitor/profit-trigger-watch.json", value)
    assert profit_trigger_watch_valid(value) is False
    assert snapshot(ArtifactReader(root))["pipeline"]["profit_watch"]["available"] is False


def test_pipeline_autopilot_promoted_event_is_distinct(root, client):
    now = datetime.now(timezone.utc).timestamp()
    autopilot_status(root, generated_at=iso_utc(now))
    key = "base-usdc-usdt-cross-venue:ATOMIC_FORK_REQUIRED:deadbeef"
    autopilot_state(root, {key: autopilot_event("base-usdc-usdt-cross-venue", promoted=True, net="12.5", result="PROMOTED", phase="PROMOTED", blocker=None)})
    assert autopilot_status_valid(json.loads((root / "reports/monitor/trigger-fork-autopilot-status.json").read_text()))
    assert autopilot_state_valid(json.loads((root / "reports/monitor/trigger-fork-autopilot-state.json").read_text()))
    autopilot = snapshot(ArtifactReader(root), now=now)["pipeline"]["autopilot"]
    assert autopilot["status_available"] and autopilot["state_available"]
    assert autopilot["promoted_count"] == 1 and autopilot["events"][0]["promoted"] is True
    body = get(client, "/").get_data(as_text=True)
    assert "PROMOTED CANDIDATE" in body and "event-item promoted" in body
    assert "reports/raw" not in body


def test_autopilot_state_malformed_is_unknown(root):
    value = autopilot_state(root, {})
    assert autopilot_state_valid(value) is True
    value["events"] = {"a": {"producerId": "x", "terminal": "yes", "promoted": False}}
    write(root, "reports/monitor/trigger-fork-autopilot-state.json", value)
    assert autopilot_state_valid(value) is False
    assert snapshot(ArtifactReader(root))["pipeline"]["autopilot"]["state_available"] is False


def test_pipeline_dispatch_and_watchdog_strips(root, client):
    now = datetime.now(timezone.utc).timestamp()
    alert_dispatcher(
        root,
        generated_at=iso_utc(now),
        summary={"observations": 56, "deliveryUnavailable": 2, "dropped": 1, "pending": 1, "queueSize": 101},
        result="FAILED",
    )
    set_watchdog(root, generated_at=iso_utc(now), inspection="degraded", summary={"total": 10, "running": 8, "missing": 1, "relaunched": 1, "failed": 1})
    assert dispatcher_status_valid(json.loads((root / "reports/monitor/monitor-alert-dispatcher-status.json").read_text()))
    assert watchdog_status_valid(json.loads((root / "reports/monitor/monitor-set-watchdog-status.json").read_text()))
    pipeline = snapshot(ArtifactReader(root), now=now)["pipeline"]
    assert pipeline["dispatcher"]["available"] and pipeline["dispatcher"]["attention"] is True
    assert pipeline["dispatcher"]["summary"]["delivery_unavailable"] == 2
    assert pipeline["watchdog"]["available"] and pipeline["watchdog"]["attention"] is True
    body = get(client, "/").get_data(as_text=True)
    assert "Delivery unavailable" in body and "Relaunched" in body and "degraded" in body


def test_mode_defaults_to_read_only_and_fails_closed(root, client):
    mode = snapshot(ArtifactReader(root))["mode"]
    assert mode["current"] == "READ_ONLY"
    assert mode["go_live_ready"] is False and mode["pass_count"] == 0
    assert mode["readiness"] == "NOT_READY" and mode["scope"] == "NOT_VERIFIED"
    assert mode["readiness_reason"] == "No route-specific verified arming controller is connected"
    assert mode["batch"]["state"] == "MISSING"
    states = {gate["key"]: gate["state"] for gate in mode["gates"]}
    assert states["batch"] == "UNKNOWN"
    assert states["watchlist"] == "UNKNOWN"
    assert states["fork_candidate"] == "UNKNOWN"
    assert states["approvers"] == "UNKNOWN"
    assert states["runtime"] == "UNKNOWN"
    assert mode["gate_count"] == 6
    body = get(client, "/").get_data(as_text=True)
    assert "READ_ONLY" in body
    assert "node tools/live-execution-batch.js" in body
    # The mode panel is informational: no POST form and no signing surface anywhere.
    assert 'method="post"' not in body.lower()
    assert "eth_sendTransaction" not in body and "eth_sign" not in body


def test_mode_all_gates_pass_still_caps_at_five_of_six_and_never_ready(root, client, monkeypatch):
    now = int(datetime.now(timezone.utc).timestamp())
    report = {"ok": True, "authorizationState": "VALID", "batch": {
        "chainId": "1", "notBefore": iso_utc(now - 60), "expiresAt": iso_utc(now + 3600),
    }}
    monkeypatch.setattr(execution_module.subprocess, "run", lambda *args, **kw: SimpleNamespace(
        returncode=0, stdout=json.dumps(report).encode(),
    ))
    watch_addresses(root, [{"label": "Treasury", "address": "0x" + "1" * 40}])
    trigger_coverage_audit(
        root,
        [coverage_row("ethereum-morpho-blue-l", "COVERED", iso_utc(now - 30), iso_utc(now + 300), evidence=["dispatch enabled for ethereum-morpho-blue-l"])],
        audited_at=iso_utc(now),
    )
    autopilot_status(root, generated_at=iso_utc(now))
    autopilot_state(root, {"k": autopilot_event("base-usdc-usdt-cross-venue", promoted=True)})
    approver_registry(root, [{"approverId": "windows-local-approver-20260912-01", "algorithm": "Ed25519", "publicKeySpkiDerBase64": "MCowBQYDK2VwAyEA5/Xt=="}])
    live_execution_batch(root, status="APPROVED", expires_at=iso_utc(now + 3600), actions=[{"kind": "review"}], approvers=["windows-local-approver-20260912-01"])

    mode = snapshot(ArtifactReader(root), now=now)["mode"]
    # A valid batch keeps its own verifier semantics, but never implies runtime.
    assert mode["current"] == "READ_ONLY"
    assert mode["go_live_ready"] is False
    assert mode["pass_count"] == 5 and mode["gate_count"] == 6
    assert mode["batch"]["state"] == "VALID"
    runtime = next(gate for gate in mode["gates"] if gate["key"] == "runtime")
    assert runtime["state"] == "UNKNOWN" and runtime["ok"] is False
    assert mode["readiness"] == "NOT_READY" and mode["scope"] == "NOT_VERIFIED"
    assert mode["warnings"], "a valid batch must still surface the unverified-runtime warning"
    body = get(client, "/").get_data(as_text=True)
    assert "READ_ONLY" in body and "5/6" in body
    assert "fixed status verifier" in body


def test_mode_expired_and_malformed_batch_are_not_ok(root):
    now = datetime.now(timezone.utc).timestamp()
    live_execution_batch(root, status="APPROVED", expires_at=iso_utc(now - 60))
    mode = snapshot(ArtifactReader(root), now=now)["mode"]
    assert mode["current"] == "READ_ONLY" and mode["batch"]["state"] == "EXPIRED"
    assert next(g for g in mode["gates"] if g["key"] == "batch")["state"] == "FAIL"

    (root / "coordination/live-execution-batch.json").write_text("{", encoding="utf8")
    malformed = snapshot(ArtifactReader(root), now=now)["mode"]
    assert malformed["batch"]["state"] == "INVALID"
    assert next(g for g in malformed["gates"] if g["key"] == "batch")["state"] == "FAIL"


def test_mode_unverified_batch_is_unknown_not_pass(root):
    now = datetime.now(timezone.utc).timestamp()
    live_execution_batch(root, status="DRAFT", expires_at=iso_utc(now + 3600), actions=[{"kind": "review"}], approvers=[])
    mode = snapshot(ArtifactReader(root), now=now)["mode"]
    assert mode["batch"]["state"] == "PRESENT_UNVERIFIED"
    gate = next(g for g in mode["gates"] if g["key"] == "batch")
    assert gate["state"] == "UNKNOWN" and gate["ok"] is False
    assert mode["current"] == "READ_ONLY"


def test_approver_registry_validation(root):
    assert approver_registry_valid({"schema": "live-execution-approver-registry/v1", "approvers": []}) is True
    assert approver_registry_valid({"schema": "live-execution-approver-registry/v1", "approvers": [{"approverId": "a", "algorithm": "Ed25519", "publicKeySpkiDerBase64": "x"}]}) is True
    assert approver_registry_valid({"schema": "live-execution-approver-registry/v1", "approvers": [{"approverId": "", "algorithm": "Ed25519", "publicKeySpkiDerBase64": "x"}]}) is False
    assert approver_registry_valid({"schema": "live-execution-approver-registry/v1", "approvers": [{"approverId": "a", "algorithm": "Ed25519"}]}) is False


def test_wallets_populated_cards_and_errors(root, client):
    now = datetime.now(timezone.utc).timestamp()
    address = "0x" + "a" * 40
    watch_addresses(root, [{"label": "Treasury", "address": address}])
    wallet_balances(
        root,
        as_of=iso_utc(now),
        addresses=[{"label": "Treasury", "address": address}],
        chains=[{
            "chainId": 1,
            "name": "Ethereum",
            "addressRows": [
                {"address": address, "blockNumber": 26_000_000, "native": {"symbol": "ETH", "raw": "1234567890000000000", "formatted": "1.23456789"}, "tokens": [{"symbol": "USDC", "address": "0x" + "b" * 40, "decimals": 6, "raw": "5000000", "formatted": "5.0"}], "error": None},
                {"address": "0x" + "c" * 40, "blockNumber": 26_000_001, "native": None, "tokens": [], "error": "RPC_TIMEOUT"},
            ],
        }],
        errors=[{"scope": "chain-1", "message": "one address read failed"}],
    )
    assert wallet_balances_valid(json.loads((root / "reports/monitor/wallet-balances.json").read_text()))
    wallets = snapshot(ArtifactReader(root), now=now + 1)["wallets"]
    assert wallets["available"] and wallets["total_rows"] == 2 and wallets["error_rows"] == 1
    body = get(client, "/").get_data(as_text=True)
    assert "Treasury" in body and "1.23456789" in body and "ETH" in body and "USDC" in body
    assert "RPC_TIMEOUT" in body and "one address read failed" in body
    # Balance rows render short forms; the watchlist exposes the full address only
    # in the per-address remove control.
    assert "0xaaaa…aaaa" in body
    assert f'data-wallet-remove="{address}"' in body


def test_wallets_empty_watchlist_and_missing_snapshot_states(root, client):
    empty = snapshot(ArtifactReader(root))["wallets"]
    assert empty["empty_reason"] == "NO_WATCHLIST" and empty["available"] is False
    body = get(client, "/").get_data(as_text=True)
    assert "No watch addresses configured" in body
    assert "coordination/watch-addresses.json" in body

    watch_addresses(root, [{"label": "Treasury", "address": "0x" + "a" * 40}])
    configured = snapshot(ArtifactReader(root))["wallets"]
    assert configured["empty_reason"] == "NO_ARTIFACT"
    assert "Wallet balance snapshot unavailable" in get(client, "/").get_data(as_text=True)


def test_wallets_malformed_and_stale_asof(root, client):
    now = datetime.now(timezone.utc).timestamp()
    address = "0x" + "a" * 40
    watch_addresses(root, [{"label": "Treasury", "address": address}])
    bad = wallet_balances(root, as_of=iso_utc(now), addresses=[{"label": "Treasury", "address": address}], chains=[{"chainId": "1", "name": "Ethereum", "addressRows": []}])
    assert wallet_balances_valid(bad) is False
    assert snapshot(ArtifactReader(root), now=now)["wallets"]["empty_reason"] == "NO_ARTIFACT"

    wallet_balances(
        root,
        as_of=iso_utc(now - 7200),
        addresses=[{"label": "Treasury", "address": address}],
        chains=[{"chainId": 1, "name": "Ethereum", "addressRows": [{"address": address, "blockNumber": 1, "native": {"symbol": "ETH", "raw": "1", "formatted": "0.00000001"}, "tokens": [], "error": None}]}],
    )
    wallets = snapshot(ArtifactReader(root), now=now)["wallets"]
    assert wallets["freshness"] == "STALE" and wallets["empty_reason"] is None
    assert "Stale" in get(client, "/").get_data(as_text=True)


def test_ops_api_keys_headers_and_leak_scan(root, client):
    now = datetime.now(timezone.utc).timestamp()
    address = "0x" + "a" * 40
    watch_addresses(root, [{"label": "Treasury", "address": address}])
    trigger_coverage_audit(
        root,
        [coverage_row("ethereum-morpho-blue-o", "BLOCKED", iso_utc(now), None, evidence=["reports/raw/fast/x.json"], blockers=["artifact reports/monitor/x.json is unreadable"])],
        audited_at=iso_utc(now),
    )
    profit_trigger_watch(root, [producer("kelp-composite", "FAILED", "RPC_FAILED", iso_utc(now))])
    autopilot_status(root, generated_at=iso_utc(now))
    autopilot_state(root, {"k": autopilot_event("base-usdc-usdt-cross-venue", promoted=True)})
    alert_dispatcher(root, generated_at=iso_utc(now))
    set_watchdog(root, generated_at=iso_utc(now))
    approver_registry(root, [{"approverId": "a", "algorithm": "Ed25519", "publicKeySpkiDerBase64": "x"}])
    live_execution_batch(root, expires_at=iso_utc(now + 3600))
    wallet_balances(
        root,
        as_of=iso_utc(now),
        addresses=[{"label": "Treasury", "address": address}],
        chains=[{"chainId": 1, "name": "Ethereum", "addressRows": [{"address": address, "blockNumber": 1, "native": {"symbol": "ETH", "raw": "1", "formatted": "0.00000001"}, "tokens": [], "error": None}]}],
    )

    response = get(client, "/api/v1/ops")
    assert response.status_code == 200 and response.headers["Cache-Control"] == "no-store"
    assert set(response.get_json()) == {"trigger_coverage", "pipeline", "mode", "wallets", "envelopes", "offensive"}
    snapshot_body = get(client, "/api/v1/snapshot").get_json()
    for key in ("trigger_coverage", "pipeline", "mode", "wallets"):
        assert key in snapshot_body

    forbidden = ("reports/monitor", "reports/raw", "http://", "https://", ".env", "private_key", "api_key", "secret_key", "rpc_endpoints", "graphql_endpoints")
    for body in (
        response.get_data(as_text=True),
        get(client, "/api/v1/snapshot").get_data(as_text=True),
        get(client, "/").get_data(as_text=True),
    ):
        lowered = body.lower()
        for literal in forbidden:
            assert literal.lower() not in lowered
        assert not re.search(r"[A-Za-z]:[\\/]", body)

    assert get(client, "/api/v1/snapshot", environ_overrides={"REQUEST_METHOD": "POST"}).status_code == 405


# --------------------------------------------------------------------------- #
# Dark theme + wallet integration
# --------------------------------------------------------------------------- #


def test_base_template_references_theme_and_wallet_assets(client):
    body = get(client, "/").get_data(as_text=True)
    assert "/static/theme.js" in body
    assert "/static/wallets.js" in body
    assert "data-theme-toggle" in body
    theme = get(client, "/static/theme.js").get_data(as_text=True)
    assert "watchboard-theme" in theme and "dataset.theme" in theme
    wallet_js = get(client, "/static/wallets.js").get_data(as_text=True)
    assert "eth_requestAccounts" in wallet_js and "/api/v1/wallets/addresses" in wallet_js
    response = get(client, "/")
    assert response.headers["Cache-Control"] == "no-store"
    assert "default-src 'self'" in response.headers["Content-Security-Policy"]


def test_theme_stylesheets_define_dark_default_and_light_override(client):
    dashboard = get(client, "/static/dashboard.css").get_data(as_text=True)
    assert ":root{color-scheme:dark" in dashboard
    assert ':root[data-theme="light"]' in dashboard
    assert "--paper:" in dashboard and "--card:" in dashboard and "--on-lime:" in dashboard
    for name in ("ops.css", "overview.css", "venus-states.css"):
        css = get(client, f"/static/{name}").get_data(as_text=True)
        assert "var(--" in css
    assert "progress.progress" in get(client, "/static/ops.css").get_data(as_text=True)


def test_wallets_add_valid_atomic_schema_and_dedupe(root, client):
    address = "0x" + "AB" * 20
    response = post_json(client, "/api/v1/wallets/addresses", {"address": address, "label": "Treasury"})
    assert response.status_code == 201
    assert response.get_json()["refresh"] in {"started", "already_running"}
    path = root / "coordination/watch-addresses.json"
    payload = json.loads(path.read_text())
    assert payload == {"schema": "watch-addresses/v1", "addresses": [{"label": "Treasury", "address": address.lower()}]}
    assert list((root / "coordination").glob(".watch-addresses-*.tmp")) == []

    duplicate = post_json(client, "/api/v1/wallets/addresses", {"address": address.lower()})
    assert duplicate.status_code == 409 and duplicate.get_json()["reason"] == "DUPLICATE_ADDRESS"
    assert json.loads(path.read_text())["addresses"] == [{"label": "Treasury", "address": address.lower()}]


def test_wallets_add_validation_and_limits(root, client):
    for bad in ("0x123", "0x" + "g" * 40, "", None, "0x" + "a" * 39, "0x" + "a" * 41):
        response = post_json(client, "/api/v1/wallets/addresses", {"address": bad})
        assert response.status_code == 400, bad
        assert response.get_json()["reason"] == "INVALID_ADDRESS"

    seeded = [{"address": "0x" + f"{index:040x}"} for index in range(20)]
    (root / "coordination/watch-addresses.json").write_text(
        json.dumps({"schema": "watch-addresses/v1", "addresses": seeded}), encoding="utf8"
    )
    limit = post_json(client, "/api/v1/wallets/addresses", {"address": "0x" + "f" * 40})
    assert limit.status_code == 409 and limit.get_json()["reason"] == "ADDRESS_LIMIT_REACHED"
    assert len(json.loads((root / "coordination/watch-addresses.json").read_text())["addresses"]) == 20


def test_wallets_add_rejects_unreadable_and_bad_requests(root, client):
    path = root / "coordination/watch-addresses.json"
    path.write_text("{not json", encoding="utf8")
    unreadable = post_json(client, "/api/v1/wallets/addresses", {"address": "0x" + "a" * 40})
    assert unreadable.status_code == 409 and unreadable.get_json()["reason"] == "WATCHLIST_UNREADABLE"
    assert path.read_text() == "{not json"
    path.write_text(json.dumps({"schema": "watch-addresses/v1", "addresses": []}), encoding="utf8")

    wrong_type = client.post("/api/v1/wallets/addresses", base_url="http://127.0.0.1:5050", environ_base={"REMOTE_ADDR": "127.0.0.1"}, data="plain", content_type="text/plain")
    assert wrong_type.status_code == 415 and wrong_type.get_json()["reason"] == "UNSUPPORTED_MEDIA_TYPE"

    oversized = client.post("/api/v1/wallets/addresses", base_url="http://127.0.0.1:5050", environ_base={"REMOTE_ADDR": "127.0.0.1"}, data=b"{" + b" " * 5000, content_type="application/json")
    assert oversized.status_code == 413 and oversized.get_json()["reason"] == "BODY_TOO_LARGE"

    cross_origin = post_json(client, "/api/v1/wallets/addresses", {"address": "0x" + "a" * 40}, headers={"Origin": "http://evil.test"})
    assert cross_origin.status_code == 403 and cross_origin.get_json()["reason"] == "FORBIDDEN_ORIGIN"

    allowed_origin = post_json(client, "/api/v1/wallets/addresses", {"address": "0x" + "a" * 40}, headers={"Origin": "http://127.0.0.1:5050"})
    assert allowed_origin.status_code == 201

    bad_json = client.post("/api/v1/wallets/addresses", base_url="http://127.0.0.1:5050", environ_base={"REMOTE_ADDR": "127.0.0.1"}, data="{bad", content_type="application/json")
    assert bad_json.status_code == 400


def test_wallets_remove(root, client):
    address = "0x" + "d" * 40
    post_json(client, "/api/v1/wallets/addresses", {"address": address, "label": "Temp"})
    removed = post_json(client, "/api/v1/wallets/addresses/remove", {"address": address})
    assert removed.status_code == 200
    assert json.loads((root / "coordination/watch-addresses.json").read_text()) == {"schema": "watch-addresses/v1", "addresses": []}

    missing = post_json(client, "/api/v1/wallets/addresses/remove", {"address": address})
    assert missing.status_code == 404 and missing.get_json()["reason"] == "ADDRESS_NOT_FOUND"
    invalid = post_json(client, "/api/v1/wallets/addresses/remove", {"address": "nope"})
    assert invalid.status_code == 400


def test_wallets_refresh_single_flight_and_fixed_command(root, client, monkeypatch):
    release = threading.Event()
    calls = []

    def blocking_run(argv, **kwargs):
        calls.append((list(argv), kwargs))
        release.wait(timeout=5)
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr(wallets_module.subprocess, "run", blocking_run)
    wallets_module.reset_collector()

    first = post_json(client, "/api/v1/wallets/refresh", {})
    assert first.status_code == 202
    second = post_json(client, "/api/v1/wallets/refresh", {})
    assert second.status_code == 409 and second.get_json()["reason"] == "COLLECTOR_RUNNING"

    deadline = time.time() + 5
    while not calls and time.time() < deadline:
        time.sleep(0.02)
    assert calls, "collector did not spawn"
    argv, kwargs = calls[0]
    assert argv == ["node", "tools/watch-wallet-balances.js", "--once"]
    assert kwargs["shell"] is False
    assert Path(kwargs["cwd"]).resolve() == root.resolve()

    release.set()
    deadline = time.time() + 5
    while wallets_module.collector_status()["running"] and time.time() < deadline:
        time.sleep(0.02)
    assert wallets_module.collector_status()["running"] is False
    assert wallets_module.collector_status()["last_exit"] == 0


def test_ops_wallets_includes_collector_status(root, client):
    wallets = get(client, "/api/v1/ops").get_json()["wallets"]
    assert set(wallets["collector"]) == {
        "running", "last_started", "last_finished", "last_exit", "last_error",
        "timeout_seconds", "deadline_at", "state",
    }
    assert wallets["collector"]["running"] is False
    assert wallets["collector"]["timeout_seconds"] == 240
    assert wallets["collector"]["deadline_at"] is None
    assert wallets["collector"]["state"] == "IDLE"
    assert wallets["watchlist"] == []


def test_wallets_unresolved_token_read_keeps_snapshot_valid_and_renders_no_data(root, client):
    """One failed token read is a display gap, never a reason to hide the panel."""

    now = datetime.now(timezone.utc).timestamp()
    address = "0x" + "a" * 40
    watch_addresses(root, [{"label": "Treasury", "address": address}])
    value = wallet_balances(
        root,
        as_of=iso_utc(now),
        addresses=[{"label": "Treasury", "address": address}],
        chains=[{
            "chainId": 1,
            "name": "Ethereum",
            "addressRows": [
                {
                    "address": address,
                    "blockNumber": 1,
                    "native": {"symbol": "ETH", "raw": "1", "formatted": "0.00000001"},
                    "tokens": [
                        {"symbol": "USDC", "address": "0x" + "b" * 40, "decimals": 6, "raw": None, "formatted": None, "usd": None}
                    ],
                    "error": None,
                }
            ],
        }],
    )
    assert wallet_balances_valid(value) is True
    wallets = snapshot(ArtifactReader(root), now=now + 1)["wallets"]
    assert wallets["available"] is True
    body = get(client, "/").get_data(as_text=True)
    assert "no data" in body
    assert "<b>None</b>" not in body


def test_auto_refresh_states_and_cooldown(monkeypatch):
    wallets_module.reset_collector()
    monkeypatch.setattr(wallets_module, "node_available", lambda: True)

    fresh = wallets_module.auto_refresh("workspace", available=True, age=10)
    assert fresh == {"state": "FRESH", "attempted": False, "running": False}

    started = wallets_module.auto_refresh("workspace", available=False, age=None)
    assert started["state"] == "STARTED" and started["attempted"] is True

    deadline = time.time() + 2
    while wallets_module.collector_status()["running"] and time.time() < deadline:
        time.sleep(0.01)
    cooldown = wallets_module.auto_refresh("workspace", available=False, age=None)
    assert cooldown["state"] == "COOLDOWN" and cooldown["attempted"] is False
    wallets_module.reset_collector()


def test_auto_refresh_reports_missing_node(monkeypatch):
    wallets_module.reset_collector()
    monkeypatch.setattr(wallets_module, "node_available", lambda: False)
    result = wallets_module.auto_refresh("workspace", available=False, age=None)
    assert result["state"] == "NODE_UNAVAILABLE"
    assert result["attempted"] is False
    assert "collector unavailable" in result["hint"]
    hint = wallets_module.collector_hint()
    assert hint is not None and "collector unavailable" in hint
    wallets_module.reset_collector()


def test_canary_page_auto_triggers_background_refresh(root, client, monkeypatch, collector_guard):
    monkeypatch.setattr(wallets_module, "node_available", lambda: True)
    get(client, "/canary")
    deadline = time.time() + 2
    while wallets_module.collector_status()["last_started"] is None and time.time() < deadline:
        time.sleep(0.01)
    assert wallets_module.collector_status()["last_started"] is not None
    assert collector_guard, "collector spawn is stubbed by the fixture"


def test_canary_page_reports_missing_node(root, client, monkeypatch):
    monkeypatch.setattr(wallets_module, "node_available", lambda: False)
    body = get(client, "/canary").get_data(as_text=True)
    assert "NODE UNAVAILABLE" in body
    assert "collector unavailable" in body


def test_wallets_panel_renders_controls_and_watchlist(root, client):
    body = get(client, "/").get_data(as_text=True)
    assert "Connect wallet" in body and "Add address" in body and "Refresh balances" in body
    assert "Read-only connect" in body and "never asks for keys" in body
    assert "data-wallet-connect" in body and "data-wallet-add" in body

    address = "0x" + "a" * 40
    post_json(client, "/api/v1/wallets/addresses", {"address": address, "label": "Treasury"})
    body = get(client, "/").get_data(as_text=True)
    assert "Watched wallets" in body
    assert f'data-wallet-remove="{address}"' in body
    assert "0xaaaa…aaaa" in body


def test_post_rejected_outside_wallet_paths(client):
    response = client.post("/api/v1/snapshot", base_url="http://127.0.0.1:5050", environ_base={"REMOTE_ADDR": "127.0.0.1"}, json={})
    assert response.status_code == 405
    assert response.get_json()["reason"] == "METHOD_NOT_ALLOWED"


def test_progress_bars_render_for_campaign_gates_and_collector(root, client):
    now = datetime.now(timezone.utc).timestamp()
    trigger_coverage_audit(
        root,
        [
            coverage_row("ethereum-morpho-blue-l", "COVERED", iso_utc(now - 10), iso_utc(now + 300)),
            coverage_row("base-morpho-blue-o", "BLOCKED", iso_utc(now - 10), None),
        ],
        audited_at=iso_utc(now),
        done=True,
    )
    body = get(client, "/").get_data(as_text=True)
    assert 'aria-label="Coverage segments"' in body
    assert 'aria-label="Live-readiness progress"' in body
    assert "data-collector-bar" in body
    assert '<progress class="progress ok" value="1" max="2">' in body
    assert '<progress class="progress danger" value="1" max="2">' in body
    assert 'value="0" max="6"' in body
    assert "Audit complete · 1 of 2 campaign rows covered." in body


def test_wallets_usd_totals_per_token_and_panel_chip(root, client):
    now = datetime.now(timezone.utc).timestamp()
    address = "0x" + "a" * 40
    watch_addresses(root, [{"label": "Treasury", "address": address}])
    wallet_balances(
        root,
        as_of=iso_utc(now),
        addresses=[{"label": "Treasury", "address": address}],
        chains=[{"chainId": 1, "name": "Ethereum", "addressRows": [
            {"address": address, "blockNumber": 1, "native": {"symbol": "ETH", "raw": "1", "formatted": "0.00000001"}, "tokens": [
                {"symbol": "USDC", "address": "0x" + "b" * 40, "decimals": 6, "raw": "12340000", "formatted": "12.34", "usd": "12.34"},
                {"symbol": "DAI", "address": "0x" + "c" * 40, "decimals": 18, "raw": "5000000000000000000", "formatted": "5.0", "usd": "5.00"},
            ], "stableUsdTotal": "17.34", "error": None},
        ]}],
        totals={"stableUsd": "17.34", "note": "stablecoins at $1.00", "unpricedChains": ["polygon"]},
    )
    data = snapshot(ArtifactReader(root), now=now + 1)["wallets"]
    assert data["totals"] == {"stable_usd": "17.34", "note": "stablecoins at $1.00", "unpriced_chains": ["polygon"], "native_usd": None, "total_usd": None, "price_source": None}
    row = data["chains"][0]["rows"][0]
    assert row["stable_usd_total"] == "17.34"
    assert [token["usd"] for token in row["tokens"]] == ["12.34", "5.00"]
    body = get(client, "/").get_data(as_text=True)
    assert "≈ $12.34" in body and "≈ $5.00" in body
    assert "Stable ≈ $17.34" in body
    assert "stablecoins at $1.00" in body
    assert "Unpriced: polygon" in body


def test_wallets_unpriced_tokens_show_units_only(root, client):
    now = datetime.now(timezone.utc).timestamp()
    address = "0x" + "d" * 40
    watch_addresses(root, [{"label": "Treasury", "address": address}])
    wallet_balances(
        root,
        as_of=iso_utc(now),
        addresses=[{"label": "Treasury", "address": address}],
        chains=[{"chainId": 1, "name": "Ethereum", "addressRows": [
            {"address": address, "blockNumber": 1, "native": None, "tokens": [
                {"symbol": "USDC", "address": "0x" + "b" * 40, "decimals": 6, "raw": "12340000", "formatted": "12.34", "usd": None},
                {"symbol": "MKR", "address": "0x" + "c" * 40, "decimals": 18, "raw": "1", "formatted": "0.000000000000000001"},
            ], "error": None},
        ]}],
    )
    data = snapshot(ArtifactReader(root), now=now + 1)["wallets"]
    assert data["totals"] == {"stable_usd": None, "note": None, "unpriced_chains": [], "native_usd": None, "total_usd": None, "price_source": None}
    row = data["chains"][0]["rows"][0]
    assert [token["usd"] for token in row["tokens"]] == [None, None]
    assert row["stable_usd_total"] is None
    body = get(client, "/").get_data(as_text=True)
    assert "12.34" in body and "USDC" in body and "MKR" in body
    assert "≈ $" not in body
    assert "Stable ≈ $" not in body


def test_wallets_malformed_usd_fields_degrade_without_fake_totals(root, client):
    now = datetime.now(timezone.utc).timestamp()
    address = "0x" + "e" * 40
    watch_addresses(root, [{"label": "Treasury", "address": address}])
    wallet_balances(
        root,
        as_of=iso_utc(now),
        addresses=[{"label": "Treasury", "address": address}],
        chains=[{"chainId": 1, "name": "Ethereum", "addressRows": [
            {"address": address, "blockNumber": 1, "native": None, "tokens": [
                {"symbol": "USDC", "address": "0x" + "b" * 40, "decimals": 6, "raw": "1", "formatted": "1.0", "usd": 5},
                {"symbol": "DAI", "address": "0x" + "c" * 40, "decimals": 18, "raw": "1", "formatted": "1.0", "usd": "1.2"},
            ], "stableUsdTotal": "not-a-number", "error": None},
        ]}],
        totals={"stableUsd": 12.34, "note": None, "unpricedChains": "polygon"},
    )
    data = snapshot(ArtifactReader(root), now=now + 1)["wallets"]
    assert data["available"] is True
    row = data["chains"][0]["rows"][0]
    assert [token["usd"] for token in row["tokens"]] == [None, None]
    assert row["stable_usd_total"] is None
    assert data["totals"] == {"stable_usd": None, "note": None, "unpriced_chains": [], "native_usd": None, "total_usd": None, "price_source": None}
    body = get(client, "/").get_data(as_text=True)
    assert "≈ $" not in body
    assert "Stable ≈ $" not in body


def test_wallets_rejects_more_than_64_tokens(root):
    now = datetime.now(timezone.utc).timestamp()
    address = "0x" + "f" * 40
    watch_addresses(root, [{"label": "Treasury", "address": address}])
    tokens = [
        {"symbol": f"T{index}", "address": "0x" + f"{index:040x}", "decimals": 6, "raw": "1", "formatted": "0.000001", "usd": "0.00"}
        for index in range(65)
    ]
    value = wallet_balances(
        root,
        as_of=iso_utc(now),
        addresses=[{"label": "Treasury", "address": address}],
        chains=[{"chainId": 1, "name": "Ethereum", "addressRows": [
            {"address": address, "blockNumber": 1, "native": None, "tokens": tokens, "stableUsdTotal": "0.00", "error": None},
        ]}],
    )
    assert wallet_balances_valid(value) is False
    data = snapshot(ArtifactReader(root), now=now + 1)["wallets"]
    assert data["available"] is False and data["empty_reason"] == "NO_ARTIFACT"


def test_wallets_native_usd_and_portfolio_chips(root, client):
    now = datetime.now(timezone.utc).timestamp()
    address = "0x" + "1" * 40
    watch_addresses(root, [{"label": "Treasury", "address": address}])
    wallet_balances(
        root,
        as_of=iso_utc(now),
        addresses=[{"label": "Treasury", "address": address}],
        chains=[{"chainId": 1, "name": "Ethereum", "addressRows": [
            {"address": address, "blockNumber": 1,
             "native": {"symbol": "ETH", "raw": "1000000000000000000", "formatted": "1.0", "usd": "3000.00"},
             "tokens": [{"symbol": "USDC", "address": "0x" + "b" * 40, "decimals": 6, "raw": "5000000", "formatted": "5.0", "usd": "5.00"}],
             "stableUsdTotal": "5.00", "totalUsd": "3005.00", "error": None},
        ]}],
        totals={"stableUsd": "5.00", "nativeUsd": "3000.00", "totalUsd": "3005.00", "note": "stablecoins at $1.00", "priceSource": "defillama", "unpricedChains": []},
    )
    data = snapshot(ArtifactReader(root), now=now + 1)["wallets"]
    assert data["totals"]["native_usd"] == "3000.00"
    assert data["totals"]["total_usd"] == "3005.00"
    assert data["totals"]["price_source"] == "defillama"
    row = data["chains"][0]["rows"][0]
    assert row["native"]["usd"] == "3000.00"
    assert row["total_usd"] == "3005.00"
    body = get(client, "/").get_data(as_text=True)
    assert "≈ $3000.00" in body
    assert "Total ≈ <strong>$3005.00</strong>" in body
    assert "Wallet ≈ $3005.00" in body
    assert "Stable ≈ $5.00" in body
    assert "Natives priced via DefiLlama" in body


def test_wallets_total_usd_null_keeps_stable_only_and_unavailable_source(root, client):
    now = datetime.now(timezone.utc).timestamp()
    address = "0x" + "2" * 40
    watch_addresses(root, [{"label": "Treasury", "address": address}])
    wallet_balances(
        root,
        as_of=iso_utc(now),
        addresses=[{"label": "Treasury", "address": address}],
        chains=[{"chainId": 1, "name": "Ethereum", "addressRows": [
            {"address": address, "blockNumber": 1,
             "native": {"symbol": "ETH", "raw": "1", "formatted": "0.00000001", "usd": None},
             "tokens": [{"symbol": "USDC", "address": "0x" + "b" * 40, "decimals": 6, "raw": "5000000", "formatted": "5.0", "usd": "5.00"}],
             "stableUsdTotal": "5.00", "totalUsd": None, "error": None},
        ]}],
        totals={"stableUsd": "5.00", "nativeUsd": None, "totalUsd": None, "note": "stablecoins at $1.00", "priceSource": "unavailable", "unpricedChains": ["polygon"]},
    )
    data = snapshot(ArtifactReader(root), now=now + 1)["wallets"]
    assert data["totals"]["total_usd"] is None
    assert data["chains"][0]["rows"][0]["total_usd"] is None
    assert data["chains"][0]["rows"][0]["native"]["usd"] is None
    body = get(client, "/").get_data(as_text=True)
    assert "Stable total ≈ <strong>$5.00</strong>" in body
    assert "Total ≈" not in body
    assert "Wallet ≈ $" not in body
    assert "Native pricing unavailable" in body
    assert "Unpriced: polygon" in body


def test_wallets_malformed_native_and_portfolio_fields_degrade(root, client):
    now = datetime.now(timezone.utc).timestamp()
    address = "0x" + "3" * 40
    watch_addresses(root, [{"label": "Treasury", "address": address}])
    wallet_balances(
        root,
        as_of=iso_utc(now),
        addresses=[{"label": "Treasury", "address": address}],
        chains=[{"chainId": 1, "name": "Ethereum", "addressRows": [
            {"address": address, "blockNumber": 1,
             "native": {"symbol": "ETH", "raw": "1", "formatted": "0.00000001", "usd": 5},
             "tokens": [],
             "stableUsdTotal": "5.00", "totalUsd": "1.2", "error": None},
        ]}],
        totals={"stableUsd": "5.00", "nativeUsd": 5, "totalUsd": "1.2", "note": None, "priceSource": "coingecko", "unpricedChains": []},
    )
    data = snapshot(ArtifactReader(root), now=now + 1)["wallets"]
    assert data["available"] is True
    row = data["chains"][0]["rows"][0]
    assert row["native"]["usd"] is None
    assert row["total_usd"] is None
    assert data["totals"]["native_usd"] is None
    assert data["totals"]["total_usd"] is None
    assert data["totals"]["price_source"] is None
    body = get(client, "/").get_data(as_text=True)
    assert "Stable total ≈ <strong>$5.00</strong>" in body
    assert "Total ≈" not in body
    assert "Wallet ≈ $" not in body
    assert "Native price source not reported" in body


def test_wallets_watched_summary_lists_two_addresses_with_totals(root, client):
    now = datetime.now(timezone.utc).timestamp()
    main = "0x" + "a" * 40
    trading = "0x" + "b" * 40
    watch_addresses(root, [{"label": "Main", "address": main}, {"label": "Trading", "address": trading}])
    wallet_balances(
        root,
        as_of=iso_utc(now),
        addresses=[{"label": "Main", "address": main}, {"label": "Trading", "address": trading}],
        chains=[
            {"chainId": 1, "name": "Ethereum", "addressRows": [
                {"address": main, "blockNumber": 1, "native": {"symbol": "ETH", "raw": "1", "formatted": "1.0", "usd": "10.00"}, "tokens": [], "stableUsdTotal": "0.00", "totalUsd": "10.00", "error": None},
                {"address": trading, "blockNumber": 1, "native": None, "tokens": [], "stableUsdTotal": "20.00", "totalUsd": "20.00", "error": None},
            ]},
            {"chainId": 8453, "name": "Base", "addressRows": [
                {"address": main, "blockNumber": 2, "native": {"symbol": "ETH", "raw": "1", "formatted": "0.5", "usd": "5.00"}, "tokens": [], "stableUsdTotal": "0.00", "totalUsd": "5.00", "error": None},
            ]},
        ],
    )
    data = snapshot(ArtifactReader(root), now=now + 1)["wallets"]
    totals = {item["label"]: item["total_usd"] for item in data["watchlist"]}
    assert totals == {"Main": "15.00", "Trading": None}
    body = get(client, "/").get_data(as_text=True)
    assert "Watched wallets" in body
    assert "Total ≈ $15.00" in body and "Total ≈ $20.00" not in body
    assert "0xaaaa…aaaa" in body and "0xbbbb…bbbb" in body
    assert body.count('data-wallet-remove="') == 2


def test_wallets_watched_summary_total_is_unknown_when_any_chain_unpriced(root, client):
    now = datetime.now(timezone.utc).timestamp()
    address = "0x" + "c" * 40
    watch_addresses(root, [{"label": "Main", "address": address}])
    wallet_balances(
        root,
        as_of=iso_utc(now),
        addresses=[{"label": "Main", "address": address}],
        chains=[
            {"chainId": 1, "name": "Ethereum", "addressRows": [
                {"address": address, "blockNumber": 1, "native": None, "tokens": [], "stableUsdTotal": "0.00", "totalUsd": "10.00", "error": None},
            ]},
            {"chainId": 8453, "name": "Base", "addressRows": [
                {"address": address, "blockNumber": 2, "native": None, "tokens": [], "stableUsdTotal": "0.00", "totalUsd": None, "error": None},
            ]},
        ],
    )
    data = snapshot(ArtifactReader(root), now=now + 1)["wallets"]
    assert data["watchlist"][0]["total_usd"] is None
    body = get(client, "/").get_data(as_text=True)
    assert "Total not reported" in body
    # The pinned per-chain row may still show its own priced total; only the
    # per-address aggregate must stay unknown when any chain is unpriced.
    assert 'class="watch-total">Total ≈ $' not in body


def test_wallet_per_address_outcome_mapping_matches_api(root, client):
    address = "0x" + "a" * 40
    assert post_json(client, "/api/v1/wallets/addresses", {"address": address}).status_code == 201
    duplicate = post_json(client, "/api/v1/wallets/addresses", {"address": address})
    assert duplicate.status_code == 409 and duplicate.get_json()["reason"] == "DUPLICATE_ADDRESS"
    invalid = post_json(client, "/api/v1/wallets/addresses", {"address": "0x123"})
    assert invalid.status_code == 400 and invalid.get_json()["reason"] == "INVALID_ADDRESS"

    seeded = [{"address": "0x" + f"{index:040x}"} for index in range(19)] + [{"address": address}]
    (root / "coordination/watch-addresses.json").write_text(
        json.dumps({"schema": "watch-addresses/v1", "addresses": seeded}), encoding="utf8"
    )
    limit = post_json(client, "/api/v1/wallets/addresses", {"address": "0x" + "f" * 40})
    assert limit.status_code == 409 and limit.get_json()["reason"] == "ADDRESS_LIMIT_REACHED"

    script = get(client, "/static/wallets.js").get_data(as_text=True)
    for reason in ("DUPLICATE_ADDRESS", "INVALID_ADDRESS", "ADDRESS_LIMIT_REACHED", "WATCHLIST_UNREADABLE", "WRITE_FAILED"):
        assert reason in script
    assert "skipped — already watched" in script
    assert "rejected — watchlist limit reached (20)" in script
    assert "Add selected & refresh" in script


def test_wallet_empty_accounts_state_copy_and_outcomes_container(root, client):
    script = get(client, "/static/wallets.js").get_data(as_text=True)
    assert "No EVM (0x…) accounts were returned" in script
    assert "paste a Solana address" in script
    assert "NO EVM ACCOUNTS" in script
    assert "eth_requestAccounts" in script
    body = get(client, "/").get_data(as_text=True)
    assert "data-wallet-outcomes" in body


def test_wallet_multi_provider_discovery_helper(client):
    script = get(client, "/static/wallets.js").get_data(as_text=True)
    assert "candidateProviders" in script
    assert "discoverEvmAccounts" in script
    assert "window.ethereum" in script
    assert "ethereum.providers" in script
    assert "window.phantom && window.phantom.ethereum" in script
    assert "EVM_ADDRESS" in script
    assert "sawNonEvm" in script


SOLANA_OPS = "ChCU36kRCYqZ14SDMiHHYrvFLQWVyR2zUBx6FiRqvBZ2"


def test_wallet_store_accepts_solana_and_preserves_family(root):
    store = wallets_module.WalletStore(root)
    solana = SOLANA_OPS
    evm = "0x" + "AB" * 20

    store.add(solana, "solana-ops", "solana")
    payload = json.loads((root / "coordination/watch-addresses.json").read_text())
    assert payload["addresses"] == [{"label": "solana-ops", "address": solana, "family": "solana"}]

    # Adding an EVM address must not strip or reorder the Solana entry.
    store.add(evm, "main")
    payload = json.loads((root / "coordination/watch-addresses.json").read_text())
    assert payload["addresses"][0] == {"label": "solana-ops", "address": solana, "family": "solana"}
    assert payload["addresses"][1] == {"label": "main", "address": evm.lower()}

    with pytest.raises(wallets_module.WatchlistError) as duplicate:
        store.add(solana, None, "solana")
    assert duplicate.value.reason == "DUPLICATE_ADDRESS"
    with pytest.raises(wallets_module.WatchlistError) as mismatch:
        store.add(evm, None, "solana")
    assert mismatch.value.reason == "INVALID_ADDRESS"
    with pytest.raises(wallets_module.WatchlistError) as bad_family:
        store.add("0x" + "a" * 40, None, "cosmos")
    assert bad_family.value.reason == "INVALID_ADDRESS"

    store.remove(solana, "solana")
    payload = json.loads((root / "coordination/watch-addresses.json").read_text())
    assert payload["addresses"] == [{"label": "main", "address": evm.lower()}]


def test_watch_address_entries_projects_family_and_preserves_base58_case(root):
    evm = "0x" + "AB" * 20
    entries = wallets_module.watch_address_entries(
        {"addresses": [{"address": SOLANA_OPS, "label": "ops", "family": "solana"}, {"address": evm, "label": "main"}]},
        True,
    )
    assert entries[0] == {"address": SOLANA_OPS, "family": "solana", "label": "ops"}
    assert entries[1] == {"address": evm.lower(), "family": "evm", "label": "main"}
    # A base58 address with no explicit family is inferred as Solana.
    inferred = wallets_module.watch_address_entries({"addresses": [{"address": SOLANA_OPS}]}, True)
    assert inferred == [{"address": SOLANA_OPS, "family": "solana"}]
    # Unrecognized shapes are dropped, never coerced.
    assert wallets_module.watch_address_entries({"addresses": [{"address": "not-an-address"}]}, True) == []


def test_wallets_api_add_and_remove_solana(root, client):
    added = post_json(client, "/api/v1/wallets/addresses", {"address": SOLANA_OPS, "label": "solana-ops", "family": "solana"})
    assert added.status_code == 201
    payload = json.loads((root / "coordination/watch-addresses.json").read_text())
    assert payload["addresses"][0]["family"] == "solana"
    assert payload["addresses"][0]["address"] == SOLANA_OPS

    removed = post_json(client, "/api/v1/wallets/addresses/remove", {"address": SOLANA_OPS, "family": "solana"})
    assert removed.status_code == 200
    assert json.loads((root / "coordination/watch-addresses.json").read_text())["addresses"] == []


def test_wallets_renders_solana_rows_and_family_marker(root, client):
    now = datetime.now(timezone.utc).timestamp()
    watch_addresses(root, [{"label": "solana-ops", "address": SOLANA_OPS, "family": "solana"}])
    wallet_balances(
        root,
        as_of=iso_utc(now),
        addresses=[],
        chains=[],
        solana=[{
            "address": SOLANA_OPS, "label": "solana-ops", "slot": 449163675,
            "native": {"symbol": "SOL", "raw": "0", "formatted": "0", "usd": "0.00"},
            "tokens": [{"symbol": "USDC", "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "decimals": 6, "raw": "0", "formatted": "0", "usd": "0.00"}],
            "stableUsdTotal": "0.00", "totalUsd": "0.00", "error": None,
        }],
    )
    data = snapshot(ArtifactReader(root), now=now + 1)["wallets"]
    assert data["available"] is True
    assert data["empty_reason"] is None
    assert len(data["solana"]) == 1
    row = data["solana"][0]
    assert row["address"] == SOLANA_OPS and row["slot"] == 449163675
    assert row["native"] == {"symbol": "SOL", "raw": "0", "formatted": "0", "usd": "0.00"}
    assert row["tokens"][0]["symbol"] == "USDC" and row["tokens"][0]["usd"] == "0.00"
    assert row["total_usd"] == "0.00"
    assert data["watchlist"][0]["family"] == "solana"
    assert data["watchlist"][0]["total_usd"] == "0.00"

    body = get(client, "/").get_data(as_text=True)
    assert 'class="wallet-chain solana"' in body
    assert "family-tag" in body and ">solana<" in body
    assert "Solana" in body and "SOL" in body and "USDC" in body
    assert "≈ $0.00" in body
    assert f'data-wallet-family="solana"' in body


def test_wallets_without_solana_renders_nothing_new(root, client):
    now = datetime.now(timezone.utc).timestamp()
    address = "0x" + "a" * 40
    watch_addresses(root, [{"label": "main", "address": address}])
    wallet_balances(
        root,
        as_of=iso_utc(now),
        addresses=[{"label": "main", "address": address}],
        chains=[{"chainId": 1, "name": "Ethereum", "addressRows": [
            {"address": address, "blockNumber": 1, "native": None, "tokens": [], "stableUsdTotal": "0.00", "totalUsd": "0.00", "error": None},
        ]}],
    )
    data = snapshot(ArtifactReader(root), now=now + 1)["wallets"]
    assert data["solana"] == []
    body = get(client, "/").get_data(as_text=True)
    assert 'class="wallet-chain solana"' not in body
    assert "family-tag" not in body


def test_wallets_malformed_solana_rows_reject_the_snapshot(root, client):
    now = datetime.now(timezone.utc).timestamp()
    watch_addresses(root, [{"label": "solana-ops", "address": SOLANA_OPS, "family": "solana"}])
    value = wallet_balances(
        root,
        as_of=iso_utc(now),
        addresses=[],
        chains=[],
        solana=[
            "not-a-row",
            {"address": "0x" + "a" * 40},
            {"address": SOLANA_OPS, "label": "ops", "slot": 1, "native": None, "tokens": [], "stableUsdTotal": None, "totalUsd": None, "error": None},
        ],
    )
    assert wallet_balances_valid(value) is False
    data = snapshot(ArtifactReader(root), now=now + 1)["wallets"]
    assert data["available"] is False and data["solana"] == []
    assert data["watchlist"][0]["total_usd"] is None


def test_overview_renders_prominent_hunt_thesis(client):
    body = get(client, "/").get_data(as_text=True)
    assert "VENTAJA REAL / HUNT THESIS" in body
    assert "What this workspace actually hunts" in body
    assert "CLASES QUE CAZAMOS" in body and "VENTAJA DE MÉTODO" in body
    for phrase in (
        "feeds stale",
        "inconsistencias cross-feed",
        "timing cross-domain",
        "accounting inducido",
        "estado de cola",
        "precisión / rounding",
        "quirks de composición",
        "transiciones públicas one-shot",
        "decode sin código fuente",
        "fork proofs locales",
        "retention / eligibility specs",
    ):
        assert phrase in body, phrase
    assert "Ganamos donde otros no pueden mirar — no donde gana la latencia." in body
    # Prominent placement: the thesis precedes the operational panels.
    assert body.index("VENTAJA REAL / HUNT THESIS") < body.index("CURRENT OPERATIONS")


def test_overview_safety_copy_distinguishes_local_wallet_actions(client):
    body = get(client, "/").get_data(as_text=True)
    assert "No on-chain signing, broadcast, or transaction controls" in body
    assert "Wallet controls below can update the local watchlist and request read-only balance collection" in body
    assert "Wallet controls only update the local watchlist or request read-only balances" in body
    assert "No UI control can sign, broadcast, or mutate" not in body


def test_overview_thesis_counters_come_from_the_coverage_audit(root, client):
    now = datetime.now(timezone.utc).timestamp()
    trigger_coverage_audit(
        root,
        [
            coverage_row("ethereum-morpho-blue-l", "COVERED", iso_utc(now - 10), iso_utc(now + 300)),
            coverage_row("base-morpho-blue-o", "BLOCKED", iso_utc(now - 10), None),
        ],
        audited_at=iso_utc(now),
        done=True,
    )
    body = get(client, "/").get_data(as_text=True)
    assert 'class="thesis-counters"' in body
    assert "<b>1</b><span>Covered</span>" in body
    assert "<b>1</b><span>Blocked</span>" in body
    assert "<b>2</b><span>Rows</span>" in body


def test_overview_thesis_counters_absent_without_coverage(root, client):
    body = get(client, "/").get_data(as_text=True)
    assert "VENTAJA REAL / HUNT THESIS" in body
    assert 'class="thesis-counters"' not in body


def test_overview_thesis_styles_are_themed(client):
    css = get(client, "/static/overview.css").get_data(as_text=True)
    assert ".thesis{" in css
    assert "var(--lime)" in css and "var(--shadow)" in css
    assert ".thesis-tags.method li" in css


AAVE_V3_WATCH_AT = "2026-10-11T20:59:27.833Z"
AAVE_V3_READINESS_AT = "2026-10-11T20:59:24.933Z"
AAVE_V3_EXACT_AT = "2026-10-11T01:51:01.254Z"
AAVE_V3_UNIVERSE_AT = "2026-10-10T23:24:21.406Z"
AAVE_V3_UNIVERSE_HASH = "5f039a95fbf8224818e08fc643af88d5fd965ad67c4bbd01da46ca1d7f5ea8a1"
AAVE_V3_ROW = "aave-v3-liquidation-trigger-watch"
AAVE_V3_ENDPOINT_MATCHER = re.compile(
    r"http|://|blockscout|drpc|tenderly|mevblocker|publicnode", re.IGNORECASE
)


def aave_v3_liquidation_watch(
    root,
    *,
    generated_at=AAVE_V3_WATCH_AT,
    classification="SAMPLE_INCOMPLETE_HISTORICAL_COVERAGE_PROVEN",
    complete=False,
    coverage_verified=True,
    current_liquidatable=0,
    trigger_ready=False,
    exact_ready=False,
):
    coverage = {
        "schema": "aave-source-coverage/v1",
        "schemaVersion": 1,
        "protocolVersion": "V3",
        "coverageKind": "monitor",
        "producerKind": "monitor",
        "classification": classification,
        "complete": complete,
        "sampleComplete": False,
        "promotionEligible": False,
        "promotionClosure": {
            "eligible": False,
            "routePositive": False,
            "executableNow": False,
            "signedActionJustified": False,
        },
        "chainsExpected": 9,
        "chainsObserved": 9,
        "logChunksAttempted": 153,
        "logChunksSucceeded": 153,
        "logChunksFailed": 0,
        "discoveredBorrowers": 4592,
        "checkedBorrowers": 702,
        "coverageProofVerified": coverage_verified,
        "blocker": "Bounded live-state sample per cycle.",
    }
    if coverage_verified:
        coverage["coverageProof"] = {
            "schema": "aave-v3-borrower-universe/v1",
            "artifact": "reports/raw/fast/aave-v3-borrower-universe.json",
            "universeSha256": AAVE_V3_UNIVERSE_HASH,
            "verifiedAt": "2026-10-11T20:59:27.811Z",
        }
    value = {
        "generatedAt": generated_at,
        "scanner": "tools/aave-v3-liquidation-watch.js",
        "scope": "Read-only Aave V3 continuous liquidation/HF monitor",
        "classification": classification,
        "complete": complete,
        "blocker": "Bounded live-state sample per cycle.",
        "cycle": 205,
        "startedAt": "2026-10-11T01:54:01.491Z",
        "sourceCoverage": coverage,
        "safety": {
            "signedActions": False,
            "signedActionJustified": False,
            "routePositive": False,
            "globalRoutePositive": False,
            "executableNow": False,
        },
        "latest": {
            "watchCandidates": 0,
            "currentLiquidatable": current_liquidatable,
            "triggerReady": trigger_ready,
            "exactReady": exact_ready,
            "sourceAbiReady": False,
            "deployedSelectorReady": False,
            "flashLiquidityReady": False,
            "forkProofReady": False,
            "liveExecutorReady": False,
            "routePositive": 0,
            "globalRoutePositive": 0,
            "executableNow": False,
            "signedActionJustified": False,
        },
    }
    write(root, artifact_module.ALLOWLIST["aave_v3_liquidation_watch"], value)
    return value


def aave_v3_trigger_readiness(root, *, generated_at=AAVE_V3_READINESS_AT):
    value = {
        "generatedAt": generated_at,
        "scanner": "tools/audit-aave-v3-trigger-readiness.js",
        "scope": "Read-only Aave V3 trigger and executor readiness audit",
        "classification": "SOURCE_INCOMPLETE",
        "complete": False,
        "sourceCoverage": {
            "schema": "aave-source-coverage/v1",
            "classification": "SOURCE_INCOMPLETE",
            "complete": False,
        },
        "safety": {
            "signedActions": False,
            "signedActionJustified": False,
            "routePositive": False,
            "executableNow": False,
        },
        "summary": {
            "status": "not-trigger-ready-executor-blocked",
            "routePositive": 0,
            "executableNow": False,
            "signedActionJustified": False,
            "currentHealthFactor": 1.002023358,
            "bpsToLiquidation": 20.23,
            "routeWatchCandidates": 15,
            "currentLiquidatable": 0,
            "exactEconomicsRows": 0,
            "rowsWithAnyQuote": 0,
            "triggerReady": False,
            "exactEconomicsReady": False,
            "sourceAbiReady": True,
            "monitorMathReady": True,
            "deployedSelectorReady": False,
            "flashLiquidityReady": True,
            "forkProofReady": False,
            "liveExecutorReady": False,
            "findingCount": 1,
            "blocker": "HF is above 1 and executor/readiness gates remain blocked",
        },
        "topRow": {
            "economics": {
                "shadowNetUsd": 111614.52,
                "exactQuoteMissing": True,
                "blocker": "Shadow liquidation bonus is not an executable route",
            }
        },
        "live": {
            "account": {
                "healthFactor": 1.0020233579257258,
                "bpsToLiquidation": 20.233579257258327,
            }
        },
        "findings": [
            {
                "severity": "high",
                "title": "HF trigger closed",
                "detail": "current HF=1.002023358; exact work waits for HF < 1.0",
            }
        ],
    }
    write(root, artifact_module.ALLOWLIST["aave_v3_trigger_readiness"], value)
    return value


def _aave_v3_quote_body(schema, *, drained=True, exact_complete=True):
    return {
        "schema": schema,
        "generatedAt": AAVE_V3_EXACT_AT,
        "scanner": "tools/quote-aave-v3-liquidation-exact.js",
        "readonly": True,
        "rpcUrlsStored": False,
        "routePositive": "unknown",
        "executableNow": False,
        "autoExecutable": False,
        "signedActionJustified": False,
        "forkJustified": False,
        "exactQuoteComplete": exact_complete,
        "flash": {"balancerPoolDrainedAtObservation": drained},
        "scenarios": [
            {
                "executable": False,
                "executableNow": False,
                "autoExecutable": False,
                "signedActionJustified": False,
                "forkJustified": False,
                "routePositive": "unknown",
                "blockers": [],
            }
        ],
        "blockers": [
            "route-positive-requires-fork-proof",
            "signed-action-requires-explicit-authorization",
        ],
        "requestsUsed": 39,
    }


def aave_v3_exact_quotes(root, *, drained=True, exact_complete=True):
    value = _aave_v3_quote_body(
        "aave-v3-liquidation-exact-quotes/v1",
        drained=drained,
        exact_complete=exact_complete,
    )
    write(root, artifact_module.ALLOWLIST["aave_v3_liquidation_exact_quotes"], value)
    return value


def aave_v3_trigger_quotes(root, *, drained=True, exact_complete=True):
    value = _aave_v3_quote_body(
        "aave-v3-liquidation-trigger-quotes/v1",
        drained=drained,
        exact_complete=exact_complete,
    )
    write(root, artifact_module.ALLOWLIST["aave_v3_liquidation_trigger_quotes"], value)
    return value


def aave_v3_borrower_universe(root, *, generated_at=AAVE_V3_UNIVERSE_AT):
    value = {
        "schema": "aave-v3-borrower-universe/v1",
        "generatedAt": generated_at,
        "scanner": "tools/scan-aave-v3-borrower-universe.js",
        "readonly": True,
        "rpcUrlsStored": False,
        "signedActionJustified": False,
        "floorBlock": 16291127,
        "headBlock": 26165211,
        "coverageClass": "FULL_HISTORICAL_BORROWERS_MAINNET_V3",
        "fullHistoryProven": True,
        "dedupedBorrowersCount": 87188,
        "universeSha256": AAVE_V3_UNIVERSE_HASH,
        "borrowerUniverse": [{"user": "0x" + "1" * 40, "lastBorrowBlock": 123}],
    }
    write(root, artifact_module.ALLOWLIST["aave_v3_borrower_universe"], value)
    return value


def aave_v3_now():
    return timestamp("2026-10-11T21:00:00Z") + 10


def test_aave_v3_liquidation_row_renders_all_five_artifacts(root, client):
    aave_v3_liquidation_watch(root)
    aave_v3_trigger_readiness(root)
    aave_v3_exact_quotes(root)
    aave_v3_borrower_universe(root)

    data = snapshot(ArtifactReader(root), now=aave_v3_now())
    row = monitor(data, AAVE_V3_ROW)
    liq = row["aave_v3_liquidation"]

    assert liq["watch"]["available"] is True
    assert liq["watch"]["classification"] == "SAMPLE_INCOMPLETE_HISTORICAL_COVERAGE_PROVEN"
    assert liq["watch"]["coverage_verified"] is True
    assert liq["watch"]["coverage_proof"]["universe_sha256"] == "5f039a95fbf8"
    assert liq["readiness"]["available"] is True
    assert liq["readiness"]["health_factor"] == 1.002023358
    assert liq["readiness"]["bps_to_liquidation"] == 20.23
    assert liq["readiness"]["current_liquidatable"] == 0
    assert liq["readiness"]["findings_count"] == 1
    assert dict(liq["readiness"]["gates"])["deployedSelectorReady"] is False
    assert liq["exact_quote"]["available"] is True
    assert liq["exact_quote"]["exact_quote_complete"] is True
    assert liq["exact_quote"]["drained_balancer"] is True
    assert liq["exact_quote"]["requests_used"] == 39
    assert liq["trigger_quote"] == {"available": False}
    assert liq["universe"]["available"] is True
    assert liq["universe"]["coverage_class"] == "FULL_HISTORICAL_BORROWERS_MAINNET_V3"
    assert liq["universe"]["universe_sha256"] == "5f039a95fbf8"
    assert len(liq["universe"]["universe_sha256"]) == 12
    assert liq["universe"]["floor_block"] == 16291127
    assert liq["fail_closed_notice"] == "readonly · signedActionJustified:false"

    overview = get(client, "/").get_data(as_text=True)
    assert AAVE_V3_ROW in overview

    detail = get(client, f"/monitors/{AAVE_V3_ROW}")
    assert detail.status_code == 200
    body = detail.get_data(as_text=True)
    for needle in (
        "AAVE V3 LIQUIDATION TRIGGER",
        "SAMPLE_INCOMPLETE",
        "5f039a95fbf8",
        "FULL_HISTORICAL",
        "No trigger yet",
        "signedActionJustified:false",
    ):
        assert needle in body

    snap = get(client, "/api/v1/snapshot").get_json()
    api_row = next(item for item in snap["monitors"] if item["id"] == AAVE_V3_ROW)
    assert api_row["aave_v3_liquidation"]["universe"]["universe_sha256"] == "5f039a95fbf8"
    assert snap["producer_health"]["aave_v3_liquidation_watch_current_read"] is True
    assert snap["producer_health"]["aave_v3_borrower_universe_current_read"] is True


def test_aave_v3_liquidation_missing_artifacts_fail_closed(root, client):
    data = snapshot(ArtifactReader(root), now=aave_v3_now())
    row = monitor(data, AAVE_V3_ROW)
    liq = row["aave_v3_liquidation"]
    for section in ("watch", "readiness", "exact_quote", "trigger_quote", "universe"):
        assert liq[section] == {"available": False}
    assert row["observation"] == "UNKNOWN"
    assert row["aave_v3_liquidation"]["fail_closed_notice"] == "readonly · signedActionJustified:false"

    detail = get(client, f"/monitors/{AAVE_V3_ROW}")
    assert detail.status_code == 200
    body = detail.get_data(as_text=True)
    assert body.count("unavailable or invalid") >= 3
    assert "No trigger yet" in body


def test_aave_v3_liquidation_malformed_samples_bounce(root):
    watch = aave_v3_liquidation_watch(root)
    bad = deepcopy(watch)
    bad["scanner"] = "tools/other.js"
    assert aave_v3_liquidation_watch_valid(bad) is False
    bad = deepcopy(watch)
    bad["safety"]["signedActionJustified"] = True
    assert aave_v3_liquidation_watch_valid(bad) is False
    bad = deepcopy(watch)
    bad["sourceCoverage"]["coverageProofVerified"] = True
    bad["sourceCoverage"].pop("coverageProof")
    assert aave_v3_liquidation_watch_valid(bad) is False
    bad = deepcopy(watch)
    bad["sourceCoverage"]["blocker"] = "https://example.invalid"
    assert aave_v3_liquidation_watch_valid(bad) is False
    assert aave_v3_liquidation_watch_valid(watch) is True

    readiness = aave_v3_trigger_readiness(root)
    bad = deepcopy(readiness)
    bad["summary"]["executableNow"] = True
    assert aave_v3_trigger_readiness_valid(bad) is False
    bad = deepcopy(readiness)
    bad["findings"] = []
    assert aave_v3_trigger_readiness_valid(bad) is False
    assert aave_v3_trigger_readiness_valid(readiness) is True

    exact = aave_v3_exact_quotes(root)
    bad = deepcopy(exact)
    bad["signedActionJustified"] = True
    assert aave_v3_liquidation_quotes_valid(bad, "aave-v3-liquidation-exact-quotes/v1") is False
    bad = deepcopy(exact)
    bad["scenarios"][0]["executable"] = True
    assert aave_v3_liquidation_quotes_valid(bad, "aave-v3-liquidation-exact-quotes/v1") is False
    assert aave_v3_liquidation_quotes_valid(exact, "aave-v3-liquidation-exact-quotes/v1") is True

    universe = aave_v3_borrower_universe(root)
    bad = deepcopy(universe)
    bad["universeSha256"] = "zz"
    assert aave_v3_borrower_universe_valid(bad) is False
    bad = deepcopy(universe)
    bad["headBlock"] = 1
    assert aave_v3_borrower_universe_valid(bad) is False
    assert aave_v3_borrower_universe_valid(universe) is True


def test_aave_v3_coverage_proof_verified_surface(root, client):
    aave_v3_liquidation_watch(root, coverage_verified=True)
    data = snapshot(ArtifactReader(root), now=aave_v3_now())
    liq = monitor(data, AAVE_V3_ROW)["aave_v3_liquidation"]
    assert liq["watch"]["coverage_verified"] is True
    assert liq["watch"]["coverage_proof"] == {
        "schema": "aave-v3-borrower-universe/v1",
        "universe_sha256": "5f039a95fbf8",
        "verified_at": "2026-10-11T20:59:27.811000+00:00",
    }
    body = get(client, f"/monitors/{AAVE_V3_ROW}").get_data(as_text=True)
    assert "aave-v3-borrower-universe/v1" in body
    assert "5f039a95fbf8" in body

    aave_v3_liquidation_watch(root, coverage_verified=False)
    data = snapshot(ArtifactReader(root), now=aave_v3_now())
    liq = monitor(data, AAVE_V3_ROW)["aave_v3_liquidation"]
    assert liq["watch"]["available"] is True
    assert liq["watch"]["coverage_verified"] is False
    assert liq["watch"]["coverage_proof"] is None


def test_aave_v3_trigger_quote_row_surfaces_when_present(root, client):
    aave_v3_exact_quotes(root)
    aave_v3_trigger_quotes(root)

    data = snapshot(ArtifactReader(root), now=aave_v3_now())
    liq = monitor(data, AAVE_V3_ROW)["aave_v3_liquidation"]
    assert liq["exact_quote"]["available"] is True
    assert liq["trigger_quote"]["available"] is True
    assert liq["trigger_quote"]["exact_quote_complete"] is True
    assert liq["trigger_quote"]["drained_balancer"] is True

    body = get(client, f"/monitors/{AAVE_V3_ROW}").get_data(as_text=True)
    assert "Trigger row present" in body
    assert "No trigger yet" not in body


def test_aave_v3_pages_have_no_endpoint_leak(root, client):
    aave_v3_liquidation_watch(root)
    aave_v3_trigger_readiness(root)
    aave_v3_exact_quotes(root)
    aave_v3_trigger_quotes(root)
    aave_v3_borrower_universe(root)

    for url in ("/", f"/monitors/{AAVE_V3_ROW}", "/api/v1/snapshot", "/healthz"):
        response = get(client, url)
        assert response.status_code == 200
        assert AAVE_V3_ENDPOINT_MATCHER.search(response.get_data(as_text=True)) is None


def test_aave_v3_malformed_artifact_renders_unavailable_without_partial_render(root):
    aave_v3_liquidation_watch(root)
    write(root, artifact_module.ALLOWLIST["aave_v3_trigger_readiness"], {"summary": "broken"})
    data = snapshot(ArtifactReader(root), now=aave_v3_now())
    liq = monitor(data, AAVE_V3_ROW)["aave_v3_liquidation"]
    assert liq["readiness"] == {"available": False}
    assert liq["watch"]["available"] is True
    assert liq["universe"] == {"available": False}
    assert liq["exact_quote"] == {"available": False}


def test_aave_v3_allowlist_keys_are_the_bounded_five():
    expected = {
        "aave_v3_liquidation_watch": "reports/raw/fast/aave-v3-liquidation-watch-status.json",
        "aave_v3_trigger_readiness": "reports/raw/fast/aave-v3-trigger-readiness.json",
        "aave_v3_liquidation_exact_quotes": "reports/raw/fast/aave-v3-liquidation-exact-quotes.json",
        "aave_v3_liquidation_trigger_quotes": "reports/raw/fast/aave-v3-liquidation-trigger-quotes.json",
        "aave_v3_borrower_universe": "reports/raw/fast/aave-v3-borrower-universe.json",
        "aave_v3_borrower_csv": "reports/raw/fast/aave-v3-borrower-universe-users.csv",
        "aave_v3_route_distance": "reports/raw/fast/aave-v3-route-distance.json",
    }
    for key, path in expected.items():
        assert artifact_module.ALLOWLIST[key] == path
    aave_keys = [key for key in artifact_module.ALLOWLIST if key.startswith("aave_v3_")]
    assert set(aave_keys) - {"aave_v3_arbitrum_config_oracle_events"} == set(expected)
    assert not any(
        path.lower().endswith((".env", ".dotenv"))
        for path in artifact_module.ALLOWLIST.values()
    )


@pytest.mark.parametrize("key,path,chain", [
    ("eth_morpho_pt_usde_rehearsal", "reports/raw/fast/fork-poc/verify-eth-morpho-pt-usde-dai-liquidation.json", 1),
    ("base_morpho_yousd_rehearsal", "reports/raw/fast/fork-poc/verify-base-yousd-usdc-liquidation.json", 8453),
])
def test_pt_and_yousd_rehearsals_are_explicit_allowlisted_artifacts(root, key, path, chain):
    from dashboard.ops import _fork_poc_rehearsal_valid

    assert artifact_module.ALLOWLIST[key] == path
    value = {"schema": "fork-poc/v1", "status": "PASS", "chainId": chain,
             "generatedAt": "2026-10-20T05:29:40Z", "block": "26231521" if chain == 1 else "52841837", "observations": []}
    (root / path).parent.mkdir(parents=True, exist_ok=True)
    write(root, path, value)
    result = ArtifactReader(root).read_json(key, validator=lambda state: _fork_poc_rehearsal_valid(state, chain))
    assert result.current is True
    assert result.value == value


def test_homepage_links(client):
    """Homepage exposes server-rendered links to monitor pages and API feeds."""
    html = get(client, "/").get_data(as_text=True)
    for href in (
        "/monitors/aave-v3-liquidation-trigger-watch",
        "/monitors/aave-v3-hf-watch",
        "/monitors/aave-v4-liquidation-watch",
        "/monitors/euler-liquidation-watch",
        "/alarms",
        "/canary",
        "/healthz",
        "/api/v1/snapshot",
        "/api/v1/ops",
        "/api/v1/canary",
    ):
        assert 'href="' + href + '"' in html, href


MORPHO_ETH_AT = "2026-10-11T21:33:17.487Z"
MORPHO_BASE_AT = "2026-10-11T21:34:47.415Z"
MORPHO_WS_AT = "2026-10-11T21:35:32.723Z"
MORPHO_ROW = "morpho-blue-liquidation-watch"
MORPHO_ENDPOINT_MATCHER = re.compile(
    r"http|://|blockscout|drpc|tenderly|mevblocker|publicnode", re.IGNORECASE
)


def _morpho_rows(route_positive=True):
    rows = [
        {
            "eventKey": "0x" + "1" * 64 + "0x" + "2" * 40,
            "marketId": "0x" + "1" * 64,
            "borrower": "0x" + "2" * 40,
            "collateralToken": "0x" + "3" * 40,
            "loanToken": "0x" + "4" * 40,
            "netUsdcRaw": None,
            "quoteExecutable": False,
            "probeStatus": "NOT_REQUIRED",
            "routePositive": False,
            "valuationStatus": "UNQUALIFIED_ROUTE",
        },
        {
            "eventKey": "0x" + "5" * 64 + "0x" + "6" * 40,
            "marketId": "0x" + "5" * 64,
            "borrower": "0x" + "6" * 40,
            "collateralToken": "0x" + "7" * 40,
            "loanToken": "0x" + "8" * 40,
            "netUsdcRaw": "-100",
            "quoteExecutable": False,
            "probeStatus": "PROBED",
            "routePositive": route_positive,
            "valuationStatus": "QUALIFIED_VIEW",
        },
    ]
    return rows


def morpho_blue_liquidatable(
    root,
    *,
    key="morpho_blue_liquidatable",
    scanned_at=MORPHO_ETH_AT,
    chain_id=1,
    pin_block=26171845,
    raw=1651,
    exact=1715,
    active=10485,
    oracle_unavailable=109,
    coverage_complete=True,
    coverage_blockers=None,
    route_positive=True,
):
    value = {
        "schema": "morpho-blue-liquidatable-observation/v1",
        "scannedAt": scanned_at,
        "scanner": "tools/scan-morpho-blue-l.js",
        "chainId": chain_id,
        "safety": {
            "readOnly": True,
            "signedActions": False,
            "transactions": False,
            "endpointMaterialPersisted": False,
        },
        "pin": {
            "number": pin_block,
            "hash": "0x" + "a" * 64,
            "timestamp": scanned_at,
            "finality": "finalized",
        },
        "historyStartBound": {"block": 18883124, "proven": True},
        "failureReconciliation": None,
        "index": {
            "cursor": pin_block + 1,
            "logs": 231718,
            "pairCount": 43268,
            "failures": 0,
            "chunkReads": 5267,
            "newPairsThisCycle": 0,
            "mode": "cycle",
        },
        "enumeration": {
            "candidatePairsThisCycle": 10594,
            "activeNow": active,
            "zeroNow": 0,
            "assumedZero": 32674,
            "unresolvedNow": 0,
            "oracleUnavailableNow": oracle_unavailable,
        },
        "totals": {
            "rawDirectionalLiquidatable": raw,
            "exactLiquidatable": exact,
            "activeEvaluated": active,
            "oracleUnavailable": oracle_unavailable,
        },
        "valuation": {
            "status": "QUALIFIED_VIEW",
            "qualifiedRoutes": 29,
            "qualifiedCandidates": 0,
            "routedCandidates": 1232,
            "unknownCandidates": 483,
            "routes": [],
            "candidates": [],
        },
        "rows": _morpho_rows(route_positive),
        "reads": {"attempted": 19981, "succeeded": 19981, "failed": 0, "unclassifiedFailures": 0},
        "coverage": {"complete": coverage_complete, "blockers": list(coverage_blockers or [])},
    }
    write(root, artifact_module.ALLOWLIST[key], value)
    return value


def morpho_blue_liquidatable_base(root, **kwargs):
    kwargs.setdefault("key", "morpho_blue_liquidatable_base")
    kwargs.setdefault("scanned_at", MORPHO_BASE_AT)
    kwargs.setdefault("chain_id", 8453)
    kwargs.setdefault("pin_block", 52482030)
    kwargs.setdefault("raw", 179)
    kwargs.setdefault("exact", 191)
    kwargs.setdefault("active", 78781)
    kwargs.setdefault("oracle_unavailable", 52)
    return morpho_blue_liquidatable(root, **kwargs)


def morpho_ws_status(root, *, updated_at=MORPHO_WS_AT, liquidations_seen=0):
    value = {
        "updatedAt": updated_at,
        "trigger": "event",
        "eventStats": {"Borrow": 41838, "Liquidate": 0, "Repay": 24379, "Supply": 177412},
        "liquidationsSeen": liquidations_seen,
        "cachedBorrowers": 5000,
        "cachedMarkets": 441,
        "recent": [],
        "chains": [
            {
                "key": "ethereum",
                "id": 1,
                "name": "ETH",
                "connected": True,
                "degraded": False,
                "sourceClass": "public-fallback",
                "errorClass": None,
                "subscriptionState": "SUBSCRIBED",
                "lastObservedBlock": 26171938,
            },
            {
                "key": "base",
                "id": 8453,
                "name": "Base",
                "connected": True,
                "degraded": False,
                "sourceClass": "public-fallback",
                "errorClass": None,
                "subscriptionState": "SUBSCRIBED",
                "lastObservedBlock": 52482601,
            },
        ],
        "status": "RUNNING",
    }
    write(root, artifact_module.ALLOWLIST["morpho_ws_status"], value)
    return value


def morpho_now():
    return timestamp("2026-10-11T21:36:00Z") + 10


def test_morpho_blue_liquidation_row_renders_all_artifacts(root, client):
    morpho_blue_liquidatable(root)
    morpho_blue_liquidatable_base(root)
    morpho_ws_status(root)

    data = snapshot(ArtifactReader(root), now=morpho_now())
    row = monitor(data, MORPHO_ROW)
    mb = row["morpho_blue_liquidation"]

    assert mb["eth"]["available"] is True
    assert mb["eth"]["chain_id"] == 1
    assert mb["eth"]["pin_block"] == 26171845
    assert mb["eth"]["pin_finality"] == "finalized"
    assert mb["eth"]["coverage_complete"] is True
    assert mb["eth"]["coverage_blockers"] == []
    assert mb["eth"]["totals"] == {
        "raw_directional_liquidatable": 1651,
        "exact_liquidatable": 1715,
        "active_evaluated": 10485,
        "oracle_unavailable": 109,
    }
    assert mb["eth"]["route_positive_count"] == 1
    assert dict(mb["eth"]["probe_status_counts"]) == {"NOT_REQUIRED": 1, "PROBED": 1}
    assert dict(mb["eth"]["valuation_status_counts"]) == {
        "QUALIFIED_VIEW": 1,
        "UNQUALIFIED_ROUTE": 1,
    }
    assert mb["base"]["available"] is True
    assert mb["base"]["chain_id"] == 8453
    assert mb["base"]["totals"]["exact_liquidatable"] == 191
    assert mb["base"]["pin_block"] == 52482030
    assert mb["watch"]["available"] is True
    assert mb["watch"]["liquidations_seen"] == 0
    assert mb["watch"]["chains"] == 2
    assert dict(mb["watch"]["event_stats"])["Borrow"] == 41838
    assert mb["fail_closed_notice"] == "readonly · signedActionJustified:false"

    overview = get(client, "/").get_data(as_text=True)
    assert MORPHO_ROW in overview

    detail = get(client, f"/monitors/{MORPHO_ROW}")
    assert detail.status_code == 200
    body = detail.get_data(as_text=True)
    for needle in (
        "MORPHO BLUE",
        "finalized",
        "QUALIFIED_VIEW",
        "UNQUALIFIED_ROUTE",
        "Liquidations seen",
        "signedActionJustified:false",
    ):
        assert needle in body

    snap = get(client, "/api/v1/snapshot").get_json()
    api_row = next(item for item in snap["monitors"] if item["id"] == MORPHO_ROW)
    assert api_row["morpho_blue_liquidation"]["watch"]["liquidations_seen"] == 0
    assert snap["producer_health"]["morpho_blue_liquidatable_current_read"] is True
    assert snap["producer_health"]["morpho_blue_liquidatable_base_current_read"] is True
    assert snap["producer_health"]["morpho_ws_status_current_read"] is True


def test_morpho_blue_liquidation_missing_artifacts_fail_closed(root, client):
    data = snapshot(ArtifactReader(root), now=morpho_now())
    row = monitor(data, MORPHO_ROW)
    mb = row["morpho_blue_liquidation"]
    assert mb["eth"] == {"available": False}
    assert mb["base"] == {"available": False}
    assert mb["watch"] == {"available": False}
    assert row["observation"] == "UNKNOWN"
    assert mb["fail_closed_notice"] == "readonly · signedActionJustified:false"

    detail = get(client, f"/monitors/{MORPHO_ROW}")
    assert detail.status_code == 200
    body = detail.get_data(as_text=True)
    assert body.count("unavailable or invalid") >= 3


def test_morpho_blue_liquidation_malformed_samples_bounce(root):
    eth = morpho_blue_liquidatable(root)
    bad = deepcopy(eth)
    bad["schema"] = "other/v1"
    assert morpho_blue_liquidatable_valid(bad) is False
    bad = deepcopy(eth)
    bad["safety"]["signedActions"] = True
    assert morpho_blue_liquidatable_valid(bad) is False
    bad = deepcopy(eth)
    bad["rows"][0]["routePositive"] = "yes"
    assert morpho_blue_liquidatable_valid(bad) is False
    bad = deepcopy(eth)
    bad["rows"][0]["valuationStatus"] = 5
    assert morpho_blue_liquidatable_valid(bad) is False
    bad = deepcopy(eth)
    bad["coverage"]["complete"] = "true"
    assert morpho_blue_liquidatable_valid(bad) is False
    bad = deepcopy(eth)
    bad["totals"]["exactLiquidatable"] = "many"
    assert morpho_blue_liquidatable_valid(bad) is False
    bad = deepcopy(eth)
    bad["pin"]["hash"] = "0xshort"
    assert morpho_blue_liquidatable_valid(bad) is False
    assert morpho_blue_liquidatable_valid(eth) is True

    ws = morpho_ws_status(root)
    bad = deepcopy(ws)
    bad["liquidationsSeen"] = "zero"
    assert morpho_ws_status_valid(bad) is False
    bad = deepcopy(ws)
    bad["eventStats"].pop("Supply")
    assert morpho_ws_status_valid(bad) is False
    bad = deepcopy(ws)
    bad["updatedAt"] = "not-a-time"
    assert morpho_ws_status_valid(bad) is False
    assert morpho_ws_status_valid(ws) is True


def test_morpho_blue_malformed_artifact_renders_unavailable_without_partial_render(root):
    morpho_blue_liquidatable(root)
    write(root, artifact_module.ALLOWLIST["morpho_ws_status"], {"status": "broken"})
    data = snapshot(ArtifactReader(root), now=morpho_now())
    mb = monitor(data, MORPHO_ROW)["morpho_blue_liquidation"]
    assert mb["eth"]["available"] is True
    assert mb["base"] == {"available": False}
    assert mb["watch"] == {"available": False}


def test_morpho_blue_route_positive_reads_zero_not_null(root):
    morpho_blue_liquidatable(root, route_positive=False, exact=0, raw=0, active=10)
    data = snapshot(ArtifactReader(root), now=morpho_now())
    mb = monitor(data, MORPHO_ROW)["morpho_blue_liquidation"]
    assert mb["eth"]["route_positive_count"] == 0
    assert mb["eth"]["totals"]["exact_liquidatable"] == 0
    assert monitor(data, MORPHO_ROW)["observation"] == "CLEAR"


def test_morpho_ws_liquidations_seen_surface(root, client):
    morpho_blue_liquidatable(root)
    morpho_ws_status(root, liquidations_seen=7)
    data = snapshot(ArtifactReader(root), now=morpho_now())
    mb = monitor(data, MORPHO_ROW)["morpho_blue_liquidation"]
    assert mb["watch"]["liquidations_seen"] == 7
    body = get(client, f"/monitors/{MORPHO_ROW}").get_data(as_text=True)
    assert "Liquidations seen" in body
    assert ">7<" in body


def test_morpho_pages_have_no_endpoint_leak(root, client):
    morpho_blue_liquidatable(root)
    morpho_blue_liquidatable_base(root)
    morpho_ws_status(root)

    for url in ("/", f"/monitors/{MORPHO_ROW}", "/api/v1/snapshot", "/healthz"):
        response = get(client, url)
        assert response.status_code == 200
        assert MORPHO_ENDPOINT_MATCHER.search(response.get_data(as_text=True)) is None


def test_morpho_allowlist_keys_are_the_bounded_three():
    expected = {
        "morpho_blue_liquidatable": "reports/raw/fast/morpho-blue-liquidatable.json",
        "morpho_blue_liquidatable_base": "reports/raw/fast/morpho-blue-liquidatable-base.json",
        "morpho_ws_status": "reports/monitor/morpho-ws-status.json",
        "morpho_blue_index": "reports/monitor/morpho-blue-l-index.json",
        "morpho_blue_base_index": "reports/monitor/morpho-blue-l-base-index.json",
    }
    for key, path in expected.items():
        assert artifact_module.ALLOWLIST[key] == path
    morpho_keys = [key for key in artifact_module.ALLOWLIST if key.startswith("morpho_")]
    assert set(morpho_keys) == set(expected)
    assert not any(
        path.lower().endswith((".env", ".dotenv"))
        for path in artifact_module.ALLOWLIST.values()
    )


EULER_WATCH_AT = "2026-10-12T02:26:51.501Z"
EULER_SURFACE_AT = "2026-10-11T23:54:14.929Z"
EULER_VALUATION_AT = "2026-10-12T00:44:07.405Z"
EULER_ROW = "euler-liquidation-watch"
EULER_ENDPOINT_MATCHER = re.compile(
    r"http|://|blockscout|drpc|tenderly|mevblocker|publicnode", re.IGNORECASE
)


def euler_l_watch_status(
    root,
    *,
    generated_at=EULER_WATCH_AT,
    ok=False,
    reason="surface-artifact-missing",
    sweep_completed=False,
    live_state_read=False,
    fail_closed=True,
    liquidatable=0,
    sweep_selected=0,
    sweep_swept=0,
):
    value = {
        "schema": "euler-l-watch/v1",
        "generatedAt": generated_at,
        "scanner": "tools/watch-euler-l.js",
        "scope": "Read-only Euler EVK continuous liquidation/violator monitor",
        "cycle": 1,
        "startedAt": "2026-10-12T02:26:51.474Z",
        "ok": ok,
        "reason": reason,
        "blockNumber": 26173390,
        "surface": {
            "artifact": "reports/raw/fast/euler-l.json",
            "present": True,
            "fresh": False,
            "scannedAt": EULER_SURFACE_AT,
            "ageMs": 9156571,
            "pin": {"number": 26172547, "hash": "0x" + "a" * 64},
            "vaultsWithBorrows": None,
            "reason": "surface-artifact-stale",
        },
        "rpcQualification": {
            "qualified": True,
            "archiveCapable": True,
            "tier": "PUBLIC_KEYLESS_ARCHIVE",
            "candidatesQualified": 1,
        },
        "safety": {
            "readOnly": True,
            "rpcInventoryRead": True,
            "rpcUrlsStored": False,
            "envFilesRead": False,
            "privateKeysRead": False,
            "signedActions": False,
            "exploitExecuteCalls": False,
            "forkTransactions": False,
            "routePositive": False,
        },
        "producer_health": {
            "surfaceArtifactPresent": True,
            "surfaceArtifactFresh": False,
            "surfaceArtifactAgeMs": 9156571,
            "rpcQualified": True,
            "rpcArchiveCapable": True,
            "rpcCandidatesQualified": 1,
            "sweepCompleted": sweep_completed,
            "liveStateRead": live_state_read,
            "multicallSucceeded": sweep_completed,
            "multicallFallbacks": 0,
            "vaultsSelected": sweep_selected,
            "vaultsSwept": sweep_swept,
            "consecutiveQualificationFailures": 0,
            "failClosed": fail_closed,
            "routePositive": False,
            "requests": 7,
        },
        "config": {"intervalMs": 300000, "maxSurfaceAgeMs": 5400000},
        "rotation": {"cursor": 40, "nextCursor": 40},
        "totals": {
            "vaultsWithBorrowsInSurface": None,
            "vaultsSelected": sweep_selected,
            "vaultsSwept": sweep_swept,
            "vaultsWithStateRead": sweep_swept,
            "vaultsReadFailed": 0,
            "liquidatableVaults": liquidatable,
            "violatorChecksAttempted": 0,
            "violatorChecksHealthy": 0,
            "violatorChecksLiquidatable": 0,
            "violatorChecksNotProven": 0,
            "stateReadsAttempted": sweep_swept,
            "stateReadsSucceeded": sweep_swept,
            "requests": 7,
        },
        "vaults": [],
        "blockers": [] if ok else ["surface-artifact-stale"],
        "liveBatchStatus": {
            "authorizationState": "INVALID",
            "reason": "FILESYSTEM_SECURE_IDENTITY_UNSUPPORTED",
        },
    }
    write(root, artifact_module.ALLOWLIST["euler_l_watch"], value)
    return value


def euler_l_surface(root, *, scanned_at=EULER_SURFACE_AT, coverage_complete=True, truncated=False):
    value = {
        "schema": "euler-l-observation/v1",
        "scannedAt": scanned_at,
        "scanner": "tools/scan-euler-l.js",
        "chainId": 1,
        "safety": {
            "readOnly": True,
            "signedActions": False,
            "transactions": False,
            "endpointMaterialPersisted": False,
        },
        "pin": {
            "number": 26172547,
            "hash": "0x" + "b" * 64,
            "timestamp": scanned_at,
            "finality": "finalized",
        },
        "contracts": {"factory": "0x" + "c" * 40, "evc": "0x" + "d" * 40},
        "derivedTopics": {"source": "targets/euler-evk/src/EVault/shared/Events.sol"},
        "historyStartBound": {"block": 20529225, "proven": True},
        "enumeration": {"method": "factory ProxyCreated inventory", "windowSize": 10000},
        "inventory": {
            "factoryProxyListLength": 890,
            "vaultsInSurface": 890,
            "vaultsWithCode": 890,
        },
        "totals": {
            "evVaultCount": 890,
            "liquidateEventCount": 2437,
            "vaultsWithLiquidations": 87,
            "vaultsWithBorrows": 112,
            "vaultsWithCurrentStateRead": 890,
            "currentStateReadFailures": 0,
            "truncated": truncated,
        },
        "reads": {"logWindows": 1130, "logWindowsPending": 560, "logWindowFailures": 0},
        "csv": {"path": "reports/raw/fast/euler-l.csv", "rowCount": 2437, "bounded": True},
        "topLiquidateEvents": [],
        "vaults": [],
        "coverage": {
            "complete": coverage_complete,
            "blockers": [] if coverage_complete else ["pending-windows"],
        },
    }
    write(root, artifact_module.ALLOWLIST["euler_l_surface"], value)
    return value


def euler_l_valuation(root, *, generated_at=EULER_VALUATION_AT, net_positive=20, route_positive=20):
    value = {
        "schema": "euler-l-valuation/v1",
        "generatedAt": generated_at,
        "scanner": "tools/calc-euler-l-valuation.js",
        "chainId": 1,
        "safety": {
            "readOnly": True,
            "signedActions": False,
            "transactions": False,
            "endpointMaterialPersisted": False,
            "externalPriceApi": False,
            "fetchPriceUsed": False,
        },
        "source": {
            "path": "reports/raw/fast/euler-l.json",
            "schema": "euler-l-observation/v1",
            "scannedAt": EULER_SURFACE_AT,
            "pin": {"number": 26172547, "hash": "0x" + "b" * 64},
            "liquidateEventCount": 2437,
        },
        "pin": {
            "number": 26172547,
            "hash": "0x" + "b" * 64,
            "timestamp": EULER_SURFACE_AT,
        },
        "gasPolicy": {"gasCeiling": "2000000"},
        "model": {"configScale": "10000"},
        "maxLiquidationDiscountSweep": {"vaultsRead": 36, "vaultsPerSweepCap": 40},
        "candidates": {
            "evaluated": 200,
            "maxCandidates": 200,
            "quoteReadsUsed": 213,
            "quoteReadsBudget": 240,
        },
        "summary": {
            "candidatesEvaluated": 200,
            "netPositive": net_positive,
            "netBeforeGasPositive": 13,
            "routePositive": route_positive,
            "qualifiedView": 68,
            "unqualified": 132,
            "valuationStatusCounts": {"UNQUALIFIED_ROUTE": 132, "QUALIFIED_VIEW": 68},
            "probeStatusCounts": {"NOT_REQUIRED": 180, "PENDING_KEYLESS_FORK": 20},
            "quoteExecutableCount": 0,
            "netUsdcSumRaw": "-940611508450",
        },
        "routes": [{"collateralAsset": "0x" + "e" * 40, "liabilityAsset": "0x" + "f" * 40}],
        "rows": [],
        "topNetPositive": [],
        "csv": {"path": "reports/raw/fast/euler-l-valuation.csv", "bounded": True},
    }
    write(root, artifact_module.ALLOWLIST["euler_l_valuation"], value)
    return value


def euler_now():
    return timestamp("2026-10-12T02:27:00Z") + 10


def test_euler_evk_liquidation_row_renders_all_artifacts(root, client):
    euler_l_watch_status(
        root,
        ok=True,
        sweep_completed=True,
        live_state_read=True,
        fail_closed=False,
        sweep_selected=40,
        sweep_swept=40,
        liquidatable=3,
    )
    euler_l_surface(root)
    euler_l_valuation(root)

    data = snapshot(ArtifactReader(root), now=euler_now())
    row = monitor(data, EULER_ROW)
    ev = row["euler_evk_liquidation"]

    assert ev["watch"]["available"] is True
    assert ev["watch"]["sweep"]["vaults_swept"] == 40
    assert ev["watch"]["sweep"]["liquidatable_vaults"] == 3
    assert ev["watch"]["route_positive"] is False
    assert ev["watch"]["fail_closed"] is False
    assert ev["surface"]["available"] is True
    assert ev["surface"]["ev_vault_count"] == 890
    assert ev["surface"]["liquidate_event_count"] == 2437
    assert ev["surface"]["vaults_with_liquidations"] == 87
    assert ev["surface"]["coverage_complete"] is True
    assert ev["valuation"]["available"] is True
    assert ev["valuation"]["candidates_evaluated"] == 200
    assert ev["valuation"]["net_positive"] == 20
    assert dict(ev["valuation"]["valuation_status_counts"])["QUALIFIED_VIEW"] == 68
    assert dict(ev["valuation"]["probe_status_counts"])["PENDING_KEYLESS_FORK"] == 20
    assert ev["route_positive"] is False
    assert ev["fail_closed_notice"] == "readonly · routePositive:false · signedActionJustified:false"
    assert row["observation"] == "WATCH"

    overview = get(client, "/").get_data(as_text=True)
    assert EULER_ROW in overview
    assert 'href="/monitors/euler-liquidation-watch"' in overview

    detail = get(client, f"/monitors/{EULER_ROW}")
    assert detail.status_code == 200
    body = detail.get_data(as_text=True)
    for needle in (
        "EULER EVK LIQUIDATION WATCH",
        "EULER EVK SURFACE",
        "EULER EVK VALUATION",
        "EVault count",
        "routePositive:false",
        "No route claim",
    ):
        assert needle in body

    snap = get(client, "/api/v1/snapshot").get_json()
    api_row = next(item for item in snap["monitors"] if item["id"] == EULER_ROW)
    assert api_row["euler_evk_liquidation"]["surface"]["ev_vault_count"] == 890
    assert snap["producer_health"]["euler_l_watch_current_read"] is True
    assert snap["producer_health"]["euler_l_surface_current_read"] is True
    assert snap["producer_health"]["euler_l_valuation_current_read"] is True


def test_euler_evk_liquidation_missing_artifacts_fail_closed(root, client):
    data = snapshot(ArtifactReader(root), now=euler_now())
    row = monitor(data, EULER_ROW)
    ev = row["euler_evk_liquidation"]
    assert ev["watch"] == {"available": False}
    assert ev["surface"] == {"available": False}
    assert ev["valuation"] == {"available": False}
    assert row["observation"] == "UNKNOWN"
    assert ev["route_positive"] is False
    assert ev["fail_closed_notice"] == "readonly · routePositive:false · signedActionJustified:false"

    detail = get(client, f"/monitors/{EULER_ROW}")
    assert detail.status_code == 200
    body = detail.get_data(as_text=True)
    assert body.count("unavailable or invalid") >= 3
    assert "No route claim" in body


def test_euler_evk_liquidation_malformed_samples_bounce(root):
    watch = euler_l_watch_status(root)
    bad = deepcopy(watch)
    bad["schema"] = "other/v1"
    assert euler_l_watch_valid(bad) is False
    bad = deepcopy(watch)
    bad["safety"]["signedActions"] = True
    assert euler_l_watch_valid(bad) is False
    bad = deepcopy(watch)
    bad["safety"]["routePositive"] = True
    assert euler_l_watch_valid(bad) is False
    bad = deepcopy(watch)
    bad["totals"]["liquidatableVaults"] = "many"
    assert euler_l_watch_valid(bad) is False
    bad = deepcopy(watch)
    bad["producer_health"]["failClosed"] = "yes"
    assert euler_l_watch_valid(bad) is False
    bad = deepcopy(watch)
    bad["reason"] = "https://example.invalid"
    assert euler_l_watch_valid(bad) is False
    assert euler_l_watch_valid(watch) is True

    surface = euler_l_surface(root)
    bad = deepcopy(surface)
    bad["scanner"] = "tools/other.js"
    assert euler_l_surface_valid(bad) is False
    bad = deepcopy(surface)
    bad["totals"]["evVaultCount"] = "many"
    assert euler_l_surface_valid(bad) is False
    bad = deepcopy(surface)
    bad["coverage"]["complete"] = "true"
    assert euler_l_surface_valid(bad) is False
    bad = deepcopy(surface)
    bad["pin"]["hash"] = "0xshort"
    assert euler_l_surface_valid(bad) is False
    assert euler_l_surface_valid(surface) is True

    valuation = euler_l_valuation(root)
    bad = deepcopy(valuation)
    bad["safety"]["externalPriceApi"] = True
    assert euler_l_valuation_valid(bad) is False
    bad = deepcopy(valuation)
    bad["summary"]["routePositive"] = "yes"
    assert euler_l_valuation_valid(bad) is False
    bad = deepcopy(valuation)
    bad["candidates"]["evaluated"] = "many"
    assert euler_l_valuation_valid(bad) is False
    assert euler_l_valuation_valid(valuation) is True


def test_euler_evk_malformed_artifact_renders_unavailable_without_partial_render(root):
    euler_l_watch_status(root)
    write(root, artifact_module.ALLOWLIST["euler_l_valuation"], {"summary": "broken"})
    data = snapshot(ArtifactReader(root), now=euler_now())
    ev = monitor(data, EULER_ROW)["euler_evk_liquidation"]
    assert ev["watch"]["available"] is True
    assert ev["surface"] == {"available": False}
    assert ev["valuation"] == {"available": False}


def test_euler_pages_have_no_endpoint_leak(root, client):
    euler_l_watch_status(root)
    euler_l_surface(root)
    euler_l_valuation(root)

    for url in ("/", f"/monitors/{EULER_ROW}", "/api/v1/snapshot", "/healthz"):
        response = get(client, url)
        assert response.status_code == 200
        assert EULER_ENDPOINT_MATCHER.search(response.get_data(as_text=True)) is None


def test_euler_allowlist_keys_are_the_bounded_three():
    expected = {
        "euler_l_watch": "reports/raw/fast/euler-l-watch-status.json",
        "euler_l_surface": "reports/raw/fast/euler-l.json",
        "euler_l_valuation": "reports/raw/fast/euler-l-valuation.json",
    }
    for key, path in expected.items():
        assert artifact_module.ALLOWLIST[key] == path
    euler_keys = [key for key in artifact_module.ALLOWLIST if key.startswith("euler_l_")]
    assert set(euler_keys) == set(expected)
    assert not any(
        path.lower().endswith((".env", ".dotenv"))
        for path in artifact_module.ALLOWLIST.values()
    )
    assert {
        key for key, path in artifact_module.ALLOWLIST.items()
        if path.lower().endswith(".csv")
    } == {"aave_v3_borrower_csv", "euler_liquidation_history"}


def test_euler_catalog_row_placement():
    ids = [item.id for item in CATALOG]
    row = next(item for item in CATALOG if item.id == EULER_ROW)
    assert row.name == "Euler EVK liquidation watch"
    assert row.disposition == "KEEP_HOT"
    assert row.protocol == "Euler"
    assert row.mode == "CONTINUOUS"
    assert row.cadence == 300
    assert row.source == "EULER_EVK_LIQ"
    assert row.note == "Euler EVK Liquidate/VaultStatus observations; no route claim"
    assert row.freshness_limits() == (600, 1800)
    assert ids.index(EULER_ROW) > ids.index("morpho-blue-liquidation-watch")
