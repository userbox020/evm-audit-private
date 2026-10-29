"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { branchCompletion, completionStatus, terminalNonClosable } = require("../scan-audit-completion-gates");

const routeSummary = { routePositive: 0, executableNow: false, executableNowCount: 0, signedActionJustified: false };
const proximitySummary = { signedActionJustified: false };
const reportSignals = {
  files: { CONFIRMED: [], VULNERABLE: [], WATCH: [], DORMANT: [], CLEAN: [], UNTAGGED: [] },
  counts: {},
  totalReports: 0,
};

function branchRow(overrides = {}) {
  return {
    rank: 1,
    id: "synthetic-branch",
    status: "watching-near-trigger",
    routePositive: 0,
    sourceArtifacts: [],
    blockers: ["blocked"],
    requiredForRoutePositive: ["fork proof"],
    nextReadOnlyStep: "wait for a changed causal input",
    ...overrides,
  };
}

function statusFor(rows) {
  return completionStatus({
    routeSummary,
    proximitySummary,
    reportSignals,
    branches: rows.map(branchCompletion),
    criticalArtifacts: [],
    missingRequiredBranchIds: [],
  });
}

test("terminal-non-closable flags are excluded from incompleteBranchCount but stay visible in branchCompletion", () => {
  for (const flag of [{ closureEligible: false }, { coverageOpen: true }, { historicalCoverageComplete: false }]) {
    const row = branchRow(flag);
    const branch = branchCompletion(row);
    assert.equal(branch.terminal, true, JSON.stringify(flag));
    assert.equal(branch.completionStatus, "terminal-non-closable", JSON.stringify(flag));
    assert.equal(branch.complete, false, "terminal branch retains its incomplete state");
    assert.ok(branch.incompleteReasons.length > 0, "terminal branch retains its reasons");

    const summary = statusFor([row]);
    assert.equal(summary.incompleteBranchCount, 0, JSON.stringify(flag));
    assert.equal(summary.terminalBranchCount, 1, JSON.stringify(flag));
    assert.deepEqual(summary.terminalBranchIds, ["synthetic-branch"]);
    assert.equal(summary.completeForNow, true, "permanent non-closable branches no longer block closure");
  }
});

test("a non-terminal branch remains incomplete exactly as before", () => {
  const summary = statusFor([branchRow()]);
  assert.equal(summary.incompleteBranchCount, 1);
  assert.equal(summary.terminalBranchCount, 0);
  assert.equal(summary.completeForNow, false);
  assert.equal(summary.status, "branch-closeout-incomplete");

  const branch = branchCompletion(branchRow());
  assert.equal(branch.terminal, false);
  assert.equal(branch.completionStatus, "incomplete");
});

test("terminal classification requires one of the three explicit flags", () => {
  assert.equal(terminalNonClosable(branchRow()), false);
  assert.equal(terminalNonClosable(branchRow({ closureEligible: true })), false);
  assert.equal(terminalNonClosable(branchRow({ coverageOpen: false })), false);
  assert.equal(terminalNonClosable(branchRow({ historicalCoverageComplete: true })), false);
  assert.equal(terminalNonClosable(branchRow({ closureEligible: false })), true);
  assert.equal(terminalNonClosable(branchRow({ coverageOpen: true })), true);
  assert.equal(terminalNonClosable(branchRow({ historicalCoverageComplete: false })), true);
});

test("mixed terminal and active branches keep the active blocker counted", () => {
  const summary = statusFor([
    branchRow({ id: "terminal", rank: 1, closureEligible: false }),
    branchRow({ id: "active", rank: 2 }),
  ]);
  assert.equal(summary.incompleteBranchCount, 1);
  assert.equal(summary.terminalBranchCount, 1);
  assert.deepEqual(summary.terminalBranchIds, ["terminal"]);
  assert.equal(summary.completeForNow, false);
});
