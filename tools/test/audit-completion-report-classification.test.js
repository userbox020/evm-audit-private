"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { completionStatus, isNonTriageReport, NON_TRIAGE_REPORT_SUFFIXES } = require("../scan-audit-completion-gates");

const routeSummary = { routePositive: 0, executableNow: false, executableNowCount: 0, signedActionJustified: false };
const proximitySummary = { signedActionJustified: false };

function statusFor(untagged) {
  return completionStatus({
    routeSummary,
    proximitySummary,
    reportSignals: {
      files: { CONFIRMED: [], VULNERABLE: [], WATCH: [], DORMANT: [], CLEAN: [], UNTAGGED: untagged },
      counts: {},
      totalReports: untagged.length,
    },
    branches: [],
    criticalArtifacts: [],
    missingRequiredBranchIds: [],
  });
}

test("the non-triage allowlist is explicit, documented, and narrow", () => {
  assert.deepEqual(NON_TRIAGE_REPORT_SUFFIXES, ["-definitions.md", "-sources.md", "-exact-source-acquisition.md"]);
  for (const file of [
    "foo-definitions.md",
    "bar-sources.md",
    "baz-exact-source-acquisition.md",
    "bounty-eligibility-matrix.md",
  ]) {
    assert.equal(isNonTriageReport(file), true, file);
  }
  for (const file of [
    "aave-v4-hubs-triage.md",
    "morpho-liquidatable-marketability-triage.md",
    "critical-unit-proxy-control.md",
    "overview-sources-extra.md",
    "some-findings-report.md",
  ]) {
    assert.equal(isNonTriageReport(file), false, file);
  }
});

test("historical-kind untagged reports are classified while genuine triage reports stay actionable, and raw totals remain", () => {
  const summary = statusFor([
    "aave-v36-exact-source-acquisition.md",
    "synapse-cctp-step8-definitions.md",
    "babylon-mintscan-pre-retention-enumerator-sources.md",
    "aave-v4-hubs-triage.md",
    "morpho-liquidatable-marketability-triage.md",
  ]);

  assert.equal(summary.untaggedReportCount, 5, "raw untagged total is retained");
  assert.equal(summary.classifiedNonTriageUntaggedReportCount, 3);
  assert.equal(summary.actionableUntaggedReportCount, 2);
  assert.deepEqual(summary.classifiedNonTriageUntaggedReports, [
    "aave-v36-exact-source-acquisition.md",
    "synapse-cctp-step8-definitions.md",
    "babylon-mintscan-pre-retention-enumerator-sources.md",
  ]);
  assert.equal(summary.completeForNow, false, "a genuine untagged triage report still blocks closure");
  assert.equal(summary.status, "report-signal-housekeeping");
});

test("only historical filings leave the actionable count; a fully classified set closes", () => {
  const summary = statusFor([
    "a-exact-source-acquisition.md",
    "b-definitions.md",
    "c-sources.md",
  ]);
  assert.equal(summary.untaggedReportCount, 3);
  assert.equal(summary.classifiedNonTriageUntaggedReportCount, 3);
  assert.equal(summary.actionableUntaggedReportCount, 0);
  assert.equal(summary.completeForNow, true);
});
