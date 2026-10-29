"""Offline findings snapshot, presentation and read-only route contracts."""

import importlib
import json
import re
from html import escape
from html.parser import HTMLParser
from pathlib import Path
from types import SimpleNamespace

import pytest
from flask import url_for

from conftest import get
from dashboard import findings
from dashboard.app import create_app


ENDPOINTS = ("/findings", "/api/v1/findings")
FIELDS = {
    "id", "priority", "severity", "status", "category", "title", "summary",
    "measured", "evidence", "action", "lane",
}
DERIVED_FIELDS = {"priority_label", "status_label", "category_label"}


def catalog():
    return json.loads(findings.CATALOG_PATH.read_text(encoding="utf-8"))


def stub_catalog(monkeypatch, source):
    monkeypatch.setattr(findings, "CATALOG_PATH", SimpleNamespace(read_text=lambda **kwargs: json.dumps(source)))


class Structure(HTMLParser):
    def __init__(self, html):
        super().__init__()
        self.tags = []
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        self.tags.append({"tag": tag, **dict(attrs)})


def test_catalog_schema_labels_original_facts_and_global_counts():
    source = catalog()
    view = findings.build_findings()
    assert source["schema"] == "findings-catalog/v1"
    assert view["read_only"] is True
    assert view["source_mode"] == "curated_snapshot"
    assert view["live_checked_at"] is None
    assert view["catalog_as_of"] == source["catalogAsOf"] == "2026-10-27"
    assert view["filters"] == {"q": "", "priority": "", "status": ""}
    originals = {row["id"]: row for row in source["findings"]}
    expected_total = len(source["findings"])
    assert len(originals) == view["summary"]["total"] == view["summary"]["matched"] == expected_total
    for row in view["findings"]:
        assert set(row) == FIELDS | DERIVED_FIELDS
        assert {key: row[key] for key in FIELDS} == originals[row["id"]]
        assert row["priority_label"] == row["severity"] == f"P{row['priority']}"
        assert row["status_label"] == findings.STATUSES[row["status"]]
        assert row["category_label"] == findings.CATEGORIES[row["category"]]
    expected_by_priority = {
        f"P{priority}": sum(row["priority"] == priority for row in source["findings"])
        for priority in range(6)
    }
    expected_by_status = {
        status: sum(row["status"] == status for row in source["findings"])
        for status in findings.STATUSES
    }
    assert view["summary"]["by_priority"] == expected_by_priority
    assert view["summary"]["by_status"] == expected_by_status
    for key in ("by_priority", "by_status"):
        assert sum(view["summary"][key].values()) == expected_total
    assert view["priority_legend"] == source["priorityLegend"]
    assert view["status_legend"] == source["statusLegend"]
    assert view["notices"][0] == source["scopeNote"]
    assert "A negative result is a result" in view["notices"][1]
    assert "Absence of a route is not absence of analysis" in view["notices"][1]
    assert view["options"]["priorities"] == [{"value": str(i), "label": f"P{i}"} for i in range(6)]
    assert {option["value"] for option in view["options"]["statuses"]} == set(findings.STATUSES)


@pytest.mark.parametrize(("ident", "pid", "bonus_key", "bonus"), [
    ("F-05", 32980, "historicalB8BonusUsd", 458),
    ("F-06", 37640, "historicalArb9BonusUsd", 119536),
])
def test_l2_observed_armed_telemetry_does_not_promote_signing_readiness(ident, pid, bonus_key, bonus):
    row = next(row for row in catalog()["findings"] if row["id"] == ident)
    assert (row["status"], row["lane"]) == ("BLOCKED", "blocked")
    metrics = row["measured"]
    assert metrics["observedPid"] == pid
    assert metrics["observedArmed"] is True and metrics["fired"] == 0
    assert metrics["processObservedAt"] == "2026-10-28 05:35 UTC"
    assert metrics["telemetryObservedAt"] == "2026-10-28 05:36 UTC"
    assert metrics[bonus_key] == bonus
    assert metrics["finalProfitEvidence"] == "PROFIT_UNVERIFIED"
    assert "executeGuarded.prepare lacks conservativeProfitBeforeGasWei" in row["summary"]
    assert "historical, not new measurements" in row["summary"]
    assert "left untouched, not stopped" in row["summary"]
    assert "reports/raw/fast/next-moves-20261028/funded-final-summary.json" in row["evidence"]
    if ident == "F-05":
        assert metrics["latestSnapshotCheckedAt"] == "2026-10-28T06:03:44.706Z"
        assert metrics["latestSnapshotBlock"] == 53189037
        assert metrics["latestSnapshotTimestampRaw"] == "1793167421"
        assert metrics["latestSnapshotStatus"] == "CURRENTLY_INELIGIBLE"
        assert metrics["latestSnapshotCoverage"] == "COMPLETE_CURRENT_DIAGNOSTIC"
        assert metrics["latestHealthFactorRaw"] == "1000254294242056343"
        assert metrics["latestAccruedDebtWethRaw"] == "18453023585281114939"
        assert metrics["latestAccruedDebtWeth"] == "18.453023585281114939"
        assert metrics["latestRouteFactoryGetter"] == "factory"
        assert metrics["latestRouteFactory"] == "0x33128a8fc17869897dce68ed026d694621f6fdfd"
        assert metrics["latestRoutePool"] == "0x20e068d76f9e90b90604500b84c7e19dcb923e7e"
        assert metrics["latestCanonicalAtClose"] is True
        assert "reports/raw/fast/next-moves-20261028/base-current-corrected.json" in row["evidence"]
        for caveat in ("complete current negative control", "Exact eth_call and eth_estimateGas",
                       "canonical MORPHO_HEALTHY reverts on both qualified independent witnesses",
                       "terminal headers agree", "not liquidatable at that pin",
                       "router factory() getter and factory.getPool", "quote is not profit",
                       "L1 getter used execution calldata only, not a signed transaction",
                       "transaction fee remains unknown"):
            assert caveat in row["action"]
    else:
        assert metrics["latestQualificationCheckedAt"] == "2026-10-28T05:58:46.658Z"
        assert metrics["latestQualificationTarget"] == "#ARB1"
        assert metrics["latestQualificationOutcome"] == "UNKNOWN"
        assert metrics["latestQualificationCode"] == "STATE_CONSENSUS_UNAVAILABLE"
        assert "reports/raw/fast/next-moves-20261028/funded-current-expanded-pool.json" in row["evidence"]
        assert "not healthy or a negative result" in row["action"]
        assert "Current eligibility, fees and profit are unknown" in row["action"]
    assert "overall eligible and profitable counts remain UNKNOWN, not zero" in row["action"]


def test_f29_keeps_crossing_and_receipt_hypothetical_not_live_profit():
    row = next(row for row in catalog()["findings"] if row["id"] == "F-29")
    assert (row["status"], row["lane"]) == ("BLOCKED", "blocked")
    metrics = row["measured"]
    assert metrics["historicalBpsToLiquidation"] == 0.1269
    assert metrics["frozenStateHypotheticalCrossingHours"] == 17.55
    assert metrics["frozenStateHypotheticalCrossingUtc"] == "2026-10-28 20:49 UTC"
    assert metrics["eligibilityFixtureReceiptWeth"] == "0.042852411473245507"
    assert metrics["historicalEligibilityFixtureReceiptUsd"] == 100.27
    assert metrics["observedAbsentPid"] == 28260
    assert (metrics["observedJournalCount"], metrics["observedPendingJournalCount"]) == (2, 0)
    assert metrics["executionHoldReason"] == "UNVERIFIED_STABLE_VALUATION_CONTAINMENT"
    assert metrics["latestSnapshotCheckedAt"] == "2026-10-28T05:58:46.658Z"
    assert metrics["latestSnapshotBlock"] == 26289282
    assert metrics["latestSnapshotTimestampRaw"] == "1793167103"
    assert metrics["latestSnapshotStatus"] == "CURRENTLY_INELIGIBLE"
    assert metrics["latestHealthFactorRaw"] == "1000010801009031900"
    assert metrics["latestCanonicalAtClose"] is True
    assert "reports/raw/fast/next-moves-20261028/funded-current-expanded-pool.json" in row["evidence"]
    assert not {"bpsNow", "crossingHours", "simulatedProfitWeth", "netUsd"} & metrics.keys()
    for caveat in (
        "only for unchanged WETH/WETH composition and configuration",
        "rates, utilization, account actions and governance",
        "not a forecast or eligibility",
        "simulated token receipt under an eligibility fixture",
        "not proven realized profit or all-cost net",
    ):
        assert caveat in row["summary"]
    for caveat in (
        "#M29 (43.64h, 85.04 USDC)", "#M10 (52.25h, 887.79 RLUSD)",
        "frozen-state hypothetical scenarios, not forecasts or eligibility",
        "does not prove fresh-process route hydration or live profitability",
        "already absent at 05:45 UTC", "No signer was restarted or killed",
        "160/160 do not establish profit or rearming",
        "stopped before simulation with TWO_FAMILIES_UNAVAILABLE",
        "0/3 current-verified, profit unknown",
    ):
        assert caveat in row["action"]
    assert not re.search(r"deterministic|guaranteed|--watch", row["title"] + row["summary"] + row["action"])


def test_f30_retains_bounded_samples_and_unknown_failures_in_open_lane():
    row = next(row for row in catalog()["findings"] if row["id"] == "F-30")
    assert (row["status"], row["lane"]) == ("OPEN_LANE", "open")
    metrics = row["measured"]
    assert (metrics["venusFluxVaults"], metrics["venusFluxSampledPositions"], metrics["venusFluxDebtPositions"]) == (35, 594, 122)
    assert (metrics["venusCoreMarketInventory"], metrics["venusCoreSampledBorrowers"]) == (55, 3)
    assert metrics["aaveBnbClosestSampledHf"] == 1.096948
    assert (metrics["avalonBorrowerDiscoveryWindowBlocks"], metrics["avalonBorrowersDiscoveredInWindow"]) == (45000, 0)
    assert metrics["failedReadCount"] is None
    assert "does not exhaust the chain or all venues" in row["summary"]
    assert "not the chain's closest borrower" in row["summary"]
    assert "not zero active historic borrowers" in row["summary"]
    assert "Do not add funding, bridge gas or deploy an executor without a qualified route" in row["action"]


def test_f31_separates_capture_scope_and_preserves_hyper_coverage_gaps():
    row = next(row for row in catalog()["findings"] if row["id"] == "F-31")
    assert (row["status"], row["lane"]) == ("OPEN_LANE", "open")
    metrics = row["measured"]
    assert metrics["historicalHyperLendMorphoRecentEventProbeBlock"] == 49716899
    assert metrics["historicalFelixCapturedAt"] == "2026-10-28T03:37:24.743Z"
    assert (metrics["historicalFelixBranches"], metrics["historicalFelixPlannedIds"], metrics["historicalFelixStatus1Count"]) == (4, 136, 115)
    assert metrics["historicalFelixSuccessfulIds"] is None and metrics["historicalFelixFailedReadCount"] is None
    assert metrics["historicalFelixReportedDebtUsd"] == 9252145.51
    assert metrics["historicalMorphoRecentEventMarketIds"] == 35
    assert metrics["historicalMorphoClosestSampledStoredTotalsHf"] == 1.063843
    assert (metrics["historicalHyperLendAddressCandidates"], metrics["historicalHyperLendDebtBearingAccounts"]) == (50, 23)
    assert metrics["historicalHyperLendClosestSampledHf"] == 1.074449
    assert metrics["historicalDexSampleDate"] == "2026-10-21"
    assert metrics["stexDexScreenBlock"] == 49724482
    assert metrics["stexPaused"] is True and metrics["stexPendingRequestCount"] == "0"
    assert metrics["stexClaimableToken1LiabilityRaw"] == "303505505078537752034"
    assert metrics["stexClaimableToken1Liability"] == "303.505505078537752034"
    assert tuple(metrics[key] for key in ("dexRoutes", "dexQuoteNonpositive", "dexAbiUnverified", "dexIncomplete", "dexQualifiedQuotePositive")) == (32, 8, 21, 3, 0)
    assert metrics["felixDiagnosticBlock"] == 49724865
    assert tuple(metrics[key] for key in ("felixUbtcIds", "felixUbtcStatusReads", "felixUbtcDebtReads", "felixUbtcIcrReads", "felixUbtcStatus1", "felixUbtcStatus4", "felixUbtcIcrFailures")) == (29, 29, 29, 28, 26, 3, 1)
    assert tuple(metrics[key] for key in ("felixKhypePlannedIds", "felixKhypeIds", "felixKhypeStatusReads", "felixKhypeDebtReads", "felixKhypeIcrReads")) == (21, 17, 13, 10, 11)
    assert metrics["ubtcFetchRedemptionPricePresent"] is False and metrics["ubtcRedemptionPriceRaw"] is None
    assert metrics["khypeExactImplementationSourceEquivalent"] == "unknown"
    assert metrics["expandedLendingBlock"] == 49725171
    assert tuple(metrics[key] for key in ("hyperLendIsolatedPairs", "eulerVaults", "eulerAccruedDebtViewsDecoded", "eulerDebtBearingVaults", "eulerDebtVaultsWithLogWindows", "eulerFailedLogRequests", "eulerBorrowerSeeds")) == (4, 58, 58, 12, 8, 80, 0)
    assert metrics["eulerBorrowerCoverage"] == "UNKNOWN_LOG_FAILURES"
    assert metrics["reviewedIndependentFamilies"] is False
    assert metrics["stateRoot"] == "0x" + "0" * 64
    assert metrics["finality"] == "PROVIDER_FINALIZED_TAG_ONLY" and metrics["conservativeNet"] is None
    assert metrics["missingDataCount"] is None and metrics["failedReadCount"] is None
    assert metrics["historicalWalletHypeBalance"] == 0
    assert not {"hyperBlock", "morphoHyperMarkets", "walletHypeBalance", "felixTroveIdsResolved", "felixTroveIdsEnumerated"} & metrics.keys()
    for caveat in (
        "liability, not free inventory", "unknown borrower coverage, not no borrowers",
        "136 IDs were planned, not successfully enumerated", "excluded status 4",
        "failures are unknown outcomes, not negatives", "observation-only, no route promotion",
        "stored totals are not complete fresh accrual", "wallet balance is historical only",
    ):
        assert caveat in row["summary"]
    for caveat in ("no fetchRedemptionPrice()", "missing ABI is not a zero price", "which discards updates",
                   "exact implementation-source equivalence remains unverified", "No oracle bug is proved"):
        assert caveat in row["action"]
    assert "No funding, HYPE bridge or executor deployment until an exact deployed route is validated" in row["action"]


def test_containment_fixed_is_separate_from_unresolved_authorization_and_profit():
    rows = {row["id"]: row for row in catalog()["findings"]}
    fixed, blocked = rows["F-33"], rows["F-34"]
    assert (fixed["priority"], fixed["category"], fixed["status"], fixed["lane"]) == (1, "defect", "FIXED", "fixed")
    assert (blocked["priority"], blocked["category"], blocked["status"], blocked["lane"]) == (1, "defect", "BLOCKED", "blocked")
    assert (fixed["measured"]["focusedTestsPassed"], fixed["measured"]["focusedTestsFailed"]) == (160, 0)
    assert (fixed["measured"]["m1TestsPassed"], fixed["measured"]["m1TestsFailed"]) == (5, 11)
    assert fixed["measured"]["m1BaselineFailureEquivalence"] is None
    assert fixed["measured"]["conservativeNativeProfitWei"] is None
    assert "not that stable routes are unlocked or profit verified" in fixed["summary"]
    for row in (rows["F-29"], fixed):
        for caveat in (
            "ORIGINAL failed attempt at 2026-10-28 05:56:50 UTC",
            "stopped before simulation with TWO_FAMILIES_UNAVAILABLE",
            "0/3 current-verified, profit unknown; historical only, not the terminal outcome",
            "Terminal summary at 2026-10-28T06:05:17.032Z",
            "two scoped targets verified healthy at their current pins",
            "#2K block 26289282, HF raw 1000010801009031900",
            "#B8 block 53189037, HF raw 1000254294242056343",
            "Exact eth_call AND eth_estimateGas return canonical healthy reverts on both qualified independent witnesses",
            "terminal headers agree", "Neither is liquidatable at its pin",
            "eligible among these two verified targets is 0",
            "#ARB1 remains UNKNOWN at STATE_CONSENSUS_UNAVAILABLE, not healthy or a negative result",
            "Overall eligible and profitable counts remain UNKNOWN, not zero", "Safety hold unchanged",
        ):
            assert caveat in row["action"]
        assert "reports/raw/fast/next-moves-20261028/funded-current-readonly.json" in row["evidence"]
        assert "reports/raw/fast/next-moves-20261028/funded-final-summary.json" in row["evidence"]
    assert "Passing source tests does not authorize activation or establish profit" in fixed["action"]
    assert blocked["title"] == "Approval lifecycle repaired; #2K+#2L guarded waiting armed"
    assert (blocked["measured"]["lifecycleTestsPassed"], blocked["measured"]["lifecycleTestsFailed"]) == (92, 0)
    assert blocked["measured"]["remediationVerified"] is True
    for caveat in ("approvedAt checks absent", "revoked=true not rejected", "directly loads primary approvals",
                   "amendments bind historical bytes and are expired", "No unauthorized signature or loss is established"):
        assert caveat in blocked["summary"]
    metrics = blocked["measured"]
    assert metrics["remediationScope"] == "ETHEREUM_AUTHORIZATION_LIFECYCLE_ONLY"
    assert metrics["ethereumApprovedAtChecksEnforced"] is True
    assert "baseApprovedAtChecksEnforced" not in metrics
    assert metrics["unifiedRevokedTrueRejected"] is True and metrics["warmWrapperUsesRenewalHelper"] is True
    assert metrics["reactivationReady"] is False and metrics["eligiblePreparationExercised"] is False
    assert metrics["reactivationScope"] == "BROAD_MULTI_ROUTE"
    assert metrics["eligiblePreparationScope"] == "NATURAL_CURRENT_CHAIN_ONLY"
    assert metrics["current2KGuardedWaitingArmed"] is False and metrics["current2KSingletonVerified"] is True
    assert metrics["current2KLocalSpendCeilingWei"] == "750000000000000"
    assert metrics["current2KMinimumProfitWethWei"] == "10000000000000000"
    assert metrics["current2KFullGuardUnsignedVerified"] is True
    assert metrics["current2KActivationTestsPassed"] == 320 and metrics["current2KPendingAtVerification"] == 0
    assert metrics["current2KRealizedProfitEstablished"] is False
    assert metrics["current2K2LGuardedWaitingArmed"] is True and metrics["current2K2LSingletonVerified"] is True
    assert metrics["current2K2LScope"] == "CURRENT_2K_2L_ONLY"
    assert metrics["current2K2LLocalSpendCeilingWei"] == "750000000000000"
    assert metrics["current2K2LTargets"] == ["#2K", "#2L"]
    assert metrics["current2K2LCandidateCountAtVerification"] == 0 and metrics["current2K2LPendingAtVerification"] == 0
    assert metrics["current2K2LActivationTestsPassed"] == 274
    assert metrics["current2K2LRealizedProfitEstablished"] is False
    assert metrics["current2KOnlyRunnerStoppedAt"] == "2026-10-28T19:40:26.337Z"
    assert blocked["action"].startswith("Current scoped action: preserve exactly one CURRENT #2K+#2L guarded runner PID 19916")
    assert (metrics["focusedTestsPassed"], metrics["focusedTestsFailed"]) == (252, 0)
    assert (metrics["focusedReconciliationTestsPassed"], metrics["focusedReconciliationTestsFailed"]) == (3, 1)
    assert metrics["postFixAuthorizationCheckedAt"] == "2026-10-28T06:36:49.816Z"
    assert metrics["postFixActualBatchValidatorsPassed"] == 2
    assert (metrics["postFixInMemoryNegativeControlsRejected"], metrics["postFixInMemoryNegativeControlsAccepted"]) == (8, 0)
    assert metrics["postFixApprovalBytesUnchanged"] is True and metrics["postFixRenewalBytesUnchanged"] is True
    assert metrics["postFixHistoricalAmendmentBytesUnchanged"] is True
    assert metrics["approvalFilesChangedByRemediation"] is False and metrics["authorityRenewedByRemediation"] is False
    assert metrics["authorizationReviewCheckedAt"] == "2026-10-28T05:59:05.224Z"
    assert metrics["inMemoryUnifiedFutureApprovalAccepted"] is True
    assert metrics["inMemoryMorphoFutureApprovalAccepted"] is True
    assert metrics["inMemoryUnifiedRevokedAccepted"] is True
    assert metrics["inMemoryMorphoRevokedAccepted"] is False
    assert metrics["historicalAmendmentsExpiredAt"] == "2026-10-26T23:59:59Z"
    assert metrics["approvalFilesChangedByReview"] is False and metrics["authorityRenewedByReview"] is False
    for caveat in ("synthetic in-memory negative probes", "future approval accepted by both unified and morpho validators",
                   "unified revoked=true accepted", "morpho rejected revoked=true with BATCH_INVALID_OR_EXPIRED",
                   "defect reproductions, not successful lifecycle remediation tests",
                   "no approval file changed or authority was renewed by the review"):
        assert caveat in blocked["summary"]
    assert "reports/raw/fast/next-moves-20261028/authorization-review.json" in blocked["evidence"]
    for evidence in (
        "tools/test/execution-authorization-lifecycle.test.cjs",
        "reports/raw/fast/readiness-current-20261028T0619/authorization-final-verification.json",
        "reports/raw/fast/readiness-current-20261028T0619/healthy-runner-replay.json",
        "coordination/handoffs/20261028-readiness-current-validation.md",
    ):
        assert evidence in blocked["evidence"]
    for caveat in (
        "Historical reproduction at 2026-10-28T05:59:05.224Z",
        "Current correction verified at 2026-10-28T06:36:49.816Z",
        "Ethereum approval-document checks, not Base L2 validator checks",
        "Lifecycle remediation only is verified", "full integration is not green",
        "PROFIT_UNVERIFIED before expected expiry rejection", "no new grant or authority renewal",
        "Execution reactivation remains BLOCKED", "actual eligible preparation remains unexercised",
    ):
        assert caveat in blocked["summary"]
    assert "Do not repin expired amendments" in blocked["action"]
    for caveat in (
        "Keep Ethereum stopped; no reactivation by this lane",
        "#2K and #B8 observations are healthy WAIT", "#ARB1 remains provider-capability HOLD_UNKNOWN",
        "WAIT_HEALTHY with zero candidates and zero preparation attempts",
        "armed=true is execute-mode telemetry, not readiness",
        "exact WETH floor already reaches the prepare callback in source",
        "actual eligible current prepare remains unexercised", "native-weth-readiness-20261028",
        "#B8 has no unconditional 0.05 WETH inclusion floor", "minLoanOut minus execution principal",
        "Native-proof payload", "full rollup fee evidence remain missing",
        "#ARB1 ends in USDT0 with no native exit proof", "separate 3-pass/1-fail reconciliation result",
    ):
        assert caveat in blocked["action"]


def test_priority_then_usd_magnitude_then_id_sort():
    source = catalog()
    rows = findings.build_findings()["findings"]
    assert [row["priority"] for row in rows] == sorted(row["priority"] for row in rows)
    assert rows[0]["severity"] == "P0" and rows[-1]["severity"] == "P5"

    def magnitude(row):
        from math import isfinite

        values = []
        for metric, value in row["measured"].items():
            if metric not in {"netUsd", "cleanDebtUsd"} and not metric.endswith(("BonusUsd", "DebtUsd")):
                continue
            try:
                number = float(value)
            except (TypeError, ValueError):
                continue
            if isfinite(number):
                values.append(abs(number))
        return max(values, default=-1)

    order = [(row["priority"], -magnitude(row), row["id"]) for row in rows]
    assert order == sorted(order)
    assert {row["id"] for row in rows} == {row["id"] for row in source["findings"]}


def test_sort_uses_absolute_largest_matching_metric_and_keeps_unknown_after_zero(monkeypatch):
    source = catalog()
    base = source["findings"][0]
    cases = [
        ("P5-large", 5, {"netUsd": 1_000_000}),
        ("missing-b", 2, {"netUsd": None}),
        ("zero", 2, {"netUsd": 0}),
        ("negative", 2, {"netUsd": -500}),
        ("debt", 2, {"cleanDebtUsd": 100, "targetBonusUsd": 300, "targetDebtUsd": 400}),
        ("positive", 2, {"netUsd": 50}),
        ("missing-a", 2, {"grossUsd": 999_999, "netUsd": "unavailable"}),
        ("numeric-string", 2, {"targetBonusUsd": "200"}),
        ("P0-missing", 0, {}),
    ]
    source["findings"] = [{**base, "id": ident, "priority": priority, "measured": measured} for ident, priority, measured in cases]
    stub_catalog(monkeypatch, source)
    assert [row["id"] for row in findings.build_findings()["findings"]] == [
        "P0-missing", "negative", "debt", "numeric-string", "positive", "zero", "missing-a", "missing-b", "P5-large",
    ]


@pytest.mark.parametrize(("key", "options_key"), [("priority", "priorities"), ("status", "statuses")])
def test_filters_keep_global_counts_options_and_sort(key, options_key):
    whole = findings.build_findings()
    for option in whole["options"][options_key]:
        value = option["value"]
        view = findings.build_findings({key: value})
        expected = [row for row in whole["findings"] if str(row[key]) == value]
        assert view["findings"] == expected
        assert view["summary"] == {**whole["summary"], "matched": len(expected)}
        assert view["options"] == whole["options"]
        assert view["filters"][key] == value


@pytest.mark.parametrize("args", [{"priority": "9"}, {"priority": " 0 "}, {"status": "ready"}, {"status": "armed"}])
def test_invalid_filters_do_not_silently_widen(args):
    view = findings.build_findings(args)
    assert view["findings"] == []
    assert view["summary"]["total"] == len(catalog()["findings"]) and view["summary"]["matched"] == 0
    assert all(view["filters"][key] == value for key, value in args.items())


def test_search_is_bounded_case_insensitive_and_composes_with_filters():
    view = findings.build_findings({"q": "  aRb9DeBtUsD  ", "priority": "1", "status": "BLOCKED"})
    assert [row["id"] for row in view["findings"]] == ["F-06"]
    assert view["filters"]["q"] == "aRb9DeBtUsD"
    assert findings.build_findings({"q": "x" * 201})["filters"]["q"] == "x" * 200
    assert findings.build_findings({"q": "m32-postmortem-20261027.md"})["findings"][0]["id"] == "F-03"
    assert findings.build_findings({"q": "arb9DebtUsd", "status": "FIXED"})["findings"] == []


def test_only_bundled_catalog_is_read_and_evidence_is_not_followed(monkeypatch):
    original = Path.read_text
    reads = []

    def fixed_only(path, *args, **kwargs):
        reads.append(path)
        assert path == findings.CATALOG_PATH
        return original(path, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", fixed_only)
    view = findings.build_findings({"path": "../../unrelated.json"})
    assert reads == [findings.CATALOG_PATH]
    assert view["summary"]["total"] == len(catalog()["findings"])


def test_html_and_api_work_without_artifacts_collectors_or_jobs(tmp_path, collector_guard, monkeypatch):
    app = create_app(tmp_path)
    module = importlib.import_module("dashboard.app")

    def forbidden(*args, **kwargs):
        pytest.fail("Findings must not read artifacts or invoke collectors")

    for name in ("snapshot", "build_canary", "build_ops", "build_targets", "auto_refresh", "start_refresh", "collector_status"):
        monkeypatch.setattr(module, name, forbidden)
    monkeypatch.setattr(module.ArtifactReader, "read_json", forbidden)
    monkeypatch.setattr(app.extensions["jobs_inspector"], "snapshot", forbidden)
    client = app.test_client(use_cookies=False)
    assert get(client, "/api/v1/findings").get_json() == findings.build_findings()
    assert get(client, "/findings").status_code == 200
    assert collector_guard == [] and list(tmp_path.iterdir()) == []


def test_routes_pass_filters_and_retain_security_headers(client, collector_guard):
    args = {"q": "arb9", "priority": "1", "status": "BLOCKED"}
    response = get(client, "/api/v1/findings", query_string=args)
    assert response.status_code == 200
    assert response.get_json() == findings.build_findings(args)
    html = get(client, "/findings", query_string=args).get_data(as_text=True)
    assert 'id="finding-F-06"' in html and 'id="finding-F-05"' not in html
    assert 'value="1" selected' in html and 'value="BLOCKED" selected' in html
    assert 'value="arb9"' in html
    assert response.headers["Cache-Control"] == "no-store"
    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert "default-src 'self'" in response.headers["Content-Security-Policy"]
    with client.application.test_request_context():
        assert url_for("findings_page") == "/findings"
        assert url_for("findings_api") == "/api/v1/findings"
    assert collector_guard == []


@pytest.mark.parametrize("endpoint", ENDPOINTS)
@pytest.mark.parametrize("method", ["POST", "PUT", "PATCH", "DELETE"])
def test_findings_rejects_writes(client, collector_guard, endpoint, method):
    response = client.open(endpoint, method=method, base_url="http://127.0.0.1:5050", environ_base={"REMOTE_ADDR": "127.0.0.1"})
    assert response.status_code == 405
    assert collector_guard == []


@pytest.mark.parametrize("endpoint", ENDPOINTS)
def test_query_size_guard(client, endpoint):
    assert get(client, endpoint + "?q=" + "x" * 4094).status_code == 200
    assert get(client, endpoint + "?q=" + "x" * 4095).status_code == 400


def test_null_metrics_are_explicitly_missing_not_zero_and_real_zero_survives(client):
    source = catalog()
    html = get(client, "/findings").get_data(as_text=True)
    null_rows = [
        entry for entry in source["findings"]
        if any(value is None for value in entry["measured"].values())
    ]
    assert null_rows, "the catalog must retain at least one explicitly missing metric"
    for entry in null_rows:
        row = re.search(
            rf'<details class="f-finding" id="finding-{entry["id"]}">(.*?)</details>', html, re.S
        ).group(1)
        for metric, value in entry["measured"].items():
            if value is not None:
                continue
            assert f'<dt><code>{escape(metric)}</code></dt>' in row
            assert '<span aria-hidden="true">—</span> <span>Not recorded</span>' in row
    zero_rows = [
        entry for entry in source["findings"]
        if any(value == 0 and not isinstance(value, bool) for value in entry["measured"].values())
    ]
    assert zero_rows, "the catalog must retain a genuine zero to contrast with null"
    for entry in zero_rows:
        row = re.search(
            rf'<details class="f-finding" id="finding-{entry["id"]}">(.*?)</details>', html, re.S
        ).group(1)
        assert re.search(r"<dd>\s*0\s*</dd>", row)
    assert re.search(r'<dt><code>fired</code></dt><dd>\s*0\s*</dd>', html)
    assert re.search(r'<dt><code>netUsd</code></dt><dd>\s*-9\.74\s*</dd>', html)
    for formatted in ("1,983", "1,500,000", "4,568,256", "121.37", "1.00392358e-07", "0.000097640945073089"):
        assert formatted in html
    first_null = null_rows[0]
    api_row = get(client, f"/api/v1/findings?q={first_null['id']}").get_json()["findings"][0]
    assert any(value is None for value in api_row["measured"].values())


def test_register_retains_all_facts_and_legends_without_profit_or_readiness_promotion(client):
    source = catalog()
    html = get(client, "/findings").get_data(as_text=True)
    assert "No live check performed by this page" in html
    assert "Most entries are negative results or closed defects" in html
    assert "ARMED means authorised and firing nothing" in html
    assert "Code, quotes, and rehearsals do not establish readiness or profit" in html
    for legend in (source["priorityLegend"], source["statusLegend"]):
        for meaning in legend.values():
            assert escape(meaning, quote=False) in html
    for row in source["findings"]:
        body = re.search(rf'<details class="f-finding" id="finding-{row["id"]}">(.*?)</details>', html, re.S).group(1)
        for key in ("title", "summary", "action"):
            # Jinja escapes apostrophes as numeric entities, unlike html.escape.
            assert escape(row[key], quote=True).replace("&#x27;", "&#39;").replace("&quot;", "&#34;") in body
        assert "no live readiness or profit established by this page" in body
        if row["status"] == "ARMED":
            assert "Armed · firing nothing" in body and "Authorised · snapshot only" in body
        if row["status"] == "VERIFIED":
            assert "Verified · not profit" in body
        for path in row["evidence"]:
            assert f"<code>{escape(path)}</code>" in body
    tags = Structure(html).tags
    assert sum(tag["tag"] == "details" for tag in tags) == len(source["findings"])
    assert all(tag.get("method") == "get" for tag in tags if tag["tag"] == "form")
    assert not any(tag.get("class", "").startswith(("profitable", "ready", "f-state-READY")) for tag in tags)
    evidence = {path for row in source["findings"] for path in row["evidence"]}
    assert not any(tag.get("href") in evidence for tag in tags)
    assert 'Liquidity Paths</a><a href="/findings" aria-current="page">Findings</a>' in html


def test_empty_metrics_evidence_and_filtered_view_make_no_absence_claim(client):
    html = get(client, "/findings?q=F-17").get_data(as_text=True)
    assert "No measured metrics recorded. Missing values are not zero." in html
    assert "No evidence paths recorded; this does not establish an absence of analysis." in html
    empty = get(client, "/findings?q=not-a-real-finding").get_data(as_text=True)
    assert "No entries shown for this view" in empty
    assert "An empty view does not mean there are no findings or no analysis." in empty
    assert 'id="finding-F-' not in empty


def test_rendered_catalog_and_search_text_are_escaped(client, monkeypatch):
    source = catalog()
    source["findings"][0]["title"] = '<script>alert("title")</script>'
    source["findings"][0]["evidence"] = ['<img src=x onerror="bad()">']
    stub_catalog(monkeypatch, source)
    html = get(client, "/findings").get_data(as_text=True)
    assert '<script>alert("title")</script>' not in html and "&lt;script&gt;" in html
    assert '<img src=x' not in html and '<code>&lt;img' in html
    searched = get(client, "/findings", query_string={"q": '<script>alert("search")</script>'}).get_data(as_text=True)
    assert '<script>alert("search")</script>' not in searched and "&lt;script&gt;" in searched


@pytest.mark.parametrize("theme", ["dark", "light"])
def test_page_text_and_controls_meet_aa_contrast_in_both_themes(theme):
    static = Path(__file__).resolve().parents[2] / "dashboard" / "static"
    css = (static / "dashboard.css").read_text(encoding="utf-8")
    page_css = (static / "findings.css").read_text(encoding="utf-8")
    selector = r':root\{' if theme == "dark" else r':root\[data-theme="light"\]\{'
    rules = re.search(selector + r'([^}]+)', css).group(1)
    tokens = dict(re.findall(r'(--[\w-]+):([^;]+)', rules))
    if theme == "light":
        tokens["--muted"] = re.search(r':root\[data-theme="light"\] \.findings-shell\{--muted:(#[0-9a-f]+)', page_css).group(1)

    def luminance(value):
        raw = value.lstrip("#")
        if len(raw) == 3:
            raw = "".join(char * 2 for char in raw)
        channels = [int(raw[i:i + 2], 16) / 255 for i in (0, 2, 4)]
        linear = [n / 12.92 if n <= .04045 else ((n + .055) / 1.055) ** 2.4 for n in channels]
        return sum(a * b for a, b in zip(linear, (.2126, .7152, .0722)))

    pairs = [(fg, bg) for fg in ("--ink", "--muted", "--blue") for bg in ("--paper", "--card", "--surface-2", "--neutral-bg", "--info-bg")]
    pairs += [("--warn-fg", "--warn-bg"), ("--danger-fg", "--danger-bg"), ("--on-solid", "--blue")]
    for fg, bg in pairs:
        high, low = sorted((luminance(tokens[fg]), luminance(tokens[bg])), reverse=True)
        assert (high + .05) / (low + .05) >= 4.5, (theme, fg, bg)
    # Inputs/selects use the same readable muted token for their visible boundary.
    assert "border:1px solid var(--muted)" in page_css
