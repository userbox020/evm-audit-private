#!/usr/bin/env node
// audit-route-gate-consistency.js - read-only consistency audit across route/gate artifacts.
// No RPC, no env/key reads, no signed actions.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const ROUTE_SWEEP = path.join(WORKSPACE, "reports", "raw", "fast", "route-positive-sweep.json");
const LOW_FUND = path.join(WORKSPACE, "reports", "raw", "fast", "low-fund-executable-route-filter.json");
const COMPLETION = path.join(WORKSPACE, "reports", "raw", "fast", "audit-completion-gates.json");
const DISABLED = path.join(WORKSPACE, "reports", "monitor", "autopilot-disabled-routes.json");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "route-gate-consistency-audit.json");

const COMPLETION_REPORT_SUGGESTIONS = {
  "aave-v3-route-distance-sweep": "reports/aave-v3-route-distance-triage.md",
  "current-liquidatable-exit-route-sweep": "reports/current-liquidatable-exit-routes-triage.md",
  "morpho-liquidatable-marketability-sweep": "reports/morpho-liquidatable-marketability-triage.md",
};

function loadJson(file, fallback = {}) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return { ...fallback, __loadError: String(error.message || error) };
  }
}

function rel(file) {
  return path.relative(WORKSPACE, file).replace(/\\/g, "/");
}

function asNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const n = Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function bool(value) {
  return value === true || value === 1 || value === "true";
}

function hoursBetween(a, b) {
  const ta = Date.parse(a || "");
  const tb = Date.parse(b || "");
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  return Math.round(Math.abs(tb - ta) / 36_000) / 100;
}

function ageHours(iso) {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) return null;
  return Math.round(Math.max(0, Date.now() - t) / 36_000) / 100;
}

function byId(rows) {
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.id) map.set(row.id, row);
  }
  return map;
}

function disabledRouteNames(disabled) {
  return new Set((disabled.disabledRoutes || []).flatMap((row) => [row.id, row.name].filter(Boolean)));
}

function classifySeverity(issue) {
  if (/signed|executable/i.test(issue.type)) return "critical";
  if (/route-positive|missing-completion|disabled-route-positive|stale-top/i.test(issue.type)) return "high";
  if (/missing-filter-row|filter-mismatch|stale-source|mapping-suggestion/i.test(issue.type)) return "medium";
  return "low";
}

function issue(type, id, message, details = {}) {
  const out = { type, severity: classifySeverity({ type }), id, message, details };
  return out;
}

function topRows(rows, n = 20) {
  return (Array.isArray(rows) ? rows : []).slice(0, n).map((row) => ({
    rank: row.rank,
    id: row.id,
    protocol: row.protocol,
    status: row.status,
    routePositive: asNumber(row.routePositive) || 0,
    executableNow: false,
    executableNowCount: Number.isSafeInteger(row.executableNowCount) && row.executableNowCount >= 0
      ? row.executableNowCount
      : row.executableNow === true ? 1 : 0,
    signedActionJustified: bool(row.signedActionJustified),
  }));
}

function main() {
  const sweep = loadJson(ROUTE_SWEEP, {});
  const lowFund = loadJson(LOW_FUND, {});
  const completion = loadJson(COMPLETION, {});
  const disabled = loadJson(DISABLED, {});

  const ranked = Array.isArray(sweep.ranked) ? sweep.ranked : [];
  const filterRows = [
    ...(lowFund.escalationReady || []),
    ...(lowFund.routePositiveNeedsProof || []),
    ...(lowFund.watchOnly || []),
    ...(lowFund.disabledOrCapital || []),
  ];
  const completionRows = Array.isArray(completion.branchCompletion) ? completion.branchCompletion : [];

  const rankedById = byId(ranked);
  const filterById = byId(filterRows);
  const completionById = byId(completionRows);
  const disabledNames = disabledRouteNames(disabled);
  const issues = [];

  const sweepRoutePositive = asNumber(sweep.summary?.routePositive) || 0;
  const filterEscalationReady = asNumber(lowFund.summary?.escalationReady) || 0;
  const filterExecutableNow = lowFund.summary?.executableNow === true;
  const filterExecutableNowCount = Number.isSafeInteger(lowFund.summary?.executableNowCount)
    && lowFund.summary.executableNowCount >= 0 ? lowFund.summary.executableNowCount : 0;
  const completionRoutePositive = asNumber(completion.summary?.routePositive) || 0;

  if (sweepRoutePositive !== completionRoutePositive) {
    issues.push(issue("route-positive-summary-mismatch", null, "Route sweep and completion gates disagree on routePositive count.", {
      routeSweep: sweepRoutePositive,
      completion: completionRoutePositive,
    }));
  }

  if (typeof lowFund.summary?.executableNow !== "boolean") {
    issues.push(issue("executable-type-mismatch", null, "Low-fund filter executableNow must be a canonical boolean.", {
      actualType: typeof lowFund.summary?.executableNow,
    }));
  }

  if (filterEscalationReady > 0 && !filterExecutableNow && filterExecutableNowCount === 0) {
    issues.push(issue("filter-summary-mismatch", null, "Low-fund filter has escalationReady rows but executableNow and executableNowCount are closed.", {
      escalationReady: filterEscalationReady,
      executableNow: false,
      executableNowCount: filterExecutableNowCount,
    }));
  }

  const filterLagHours = hoursBetween(sweep.generatedAt, lowFund.summary?.sourceGeneratedAt || lowFund.generatedAt);
  if (filterLagHours !== null && filterLagHours > 0.25) {
    issues.push(issue("stale-source-summary", null, "Low-fund filter sourceGeneratedAt lags route sweep by more than 15 minutes.", {
      routeSweepGeneratedAt: sweep.generatedAt || null,
      lowFundSourceGeneratedAt: lowFund.summary?.sourceGeneratedAt || null,
      lagHours: filterLagHours,
    }));
  }

  for (const row of ranked) {
    const id = row.id;
    const routePositive = asNumber(row.routePositive) || 0;
    const executableNow = row.executableNow === true;
    const executableNowCount = Number.isSafeInteger(row.executableNowCount) && row.executableNowCount >= 0
      ? row.executableNowCount
      : executableNow ? 1 : 0;
    const signedActionJustified = bool(row.signedActionJustified);
    const filterRow = filterById.get(id);
    const completionRow = completionById.get(id);
    const isTop = (asNumber(row.rank) || 999) <= 12;

    if (typeof row.executableNow !== "boolean") {
      issues.push(issue("executable-type-mismatch", id, "Route-sweep row executableNow must be a canonical boolean.", {
        actualType: typeof row.executableNow,
      }));
    }

    if ((routePositive > 0 || executableNow || executableNowCount > 0 || isTop) && !filterRow) {
      issues.push(issue("missing-filter-row", id, "Route-sweep row is route-positive/executable/top-ranked but absent from low-fund filter categories.", {
        rank: row.rank,
        routePositive,
        executableNow: false,
        executableNowCount,
      }));
    }

    if ((executableNow || executableNowCount > 0) && !signedActionJustified) {
      issues.push(issue("executable-without-signed-justification", id, "Row claims executableNow but signedActionJustified is false.", {
        rank: row.rank,
        status: row.status,
      }));
    }

    if (routePositive > 0) {
      const filterCapitalBlocked = bool(filterRow?.capitalOrDelayBlocked);
      const disabledMatched = disabledNames.has(filterRow?.disabledRouteId) || disabledNames.has(filterRow?.protocol) || filterCapitalBlocked;
      if (!filterRow) {
        issues.push(issue("route-positive-missing-filter", id, "Route-positive row is absent from low-fund filter output.", { rank: row.rank }));
      } else if (filterRow.filterState === "watch-only-needs-route-positive") {
        issues.push(issue("route-positive-classified-watch-only", id, "Route-positive row is classified as watch-only in low-fund filter.", {
          filterState: filterRow.filterState,
        }));
      } else if (filterCapitalBlocked && !disabledMatched) {
        issues.push(issue("route-positive-capital-blocked-without-disabled-policy", id, "Route-positive row is capital/delay blocked without matching disabled-route policy.", {
          disabledRouteId: filterRow.disabledRouteId || null,
          capitalOrDelayReason: filterRow.capitalOrDelayReason || null,
        }));
      }
    }

    if (isTop && !completionRow) {
      issues.push(issue("missing-completion-row", id, "Top-ranked route-sweep row is absent from completion gate branches.", {
        rank: row.rank,
      }));
    } else if (completionRow && Array.isArray(completionRow.incompleteReasons) && completionRow.incompleteReasons.length) {
      issues.push(issue("incomplete-completion-branch", id, "Completion gate branch is incomplete.", {
        rank: completionRow.rank,
        incompleteReasons: completionRow.incompleteReasons,
        suggestedReport: COMPLETION_REPORT_SUGGESTIONS[id] || null,
      }));
    }

    if (COMPLETION_REPORT_SUGGESTIONS[id] && completionRow?.incompleteReasons?.includes("report mapping missing from completion scanner")) {
      issues.push(issue("mapping-suggestion", id, "Known triage report mapping candidate is missing from completion scanner.", {
        suggestedReport: COMPLETION_REPORT_SUGGESTIONS[id],
      }));
    }
  }

  const topCompletionStale = completionRows
    .filter((row) => (asNumber(row.rank) || 999) <= 12)
    .flatMap((row) => (row.sourceArtifacts || []).filter((artifact) => artifact.stale).map((artifact) => ({ id: row.id, artifact })));
  for (const stale of topCompletionStale) {
    issues.push(issue("stale-top-branch-artifact", stale.id, "Top completion branch has a stale source artifact.", stale.artifact));
  }

  const severityCounts = issues.reduce((acc, row) => {
    acc[row.severity] = (acc[row.severity] || 0) + 1;
    return acc;
  }, {});
  const incompleteCompletionRows = completionRows.filter((row) => Array.isArray(row.incompleteReasons) && row.incompleteReasons.length);
  const mappingSuggestions = issues.filter((row) => row.type === "mapping-suggestion");
  const actionableFixes = [
    ...mappingSuggestions.map((row) => ({
      action: "add-completion-report-mapping",
      id: row.id,
      file: "tools/scan-audit-completion-gates.js",
      suggestedReport: row.details.suggestedReport,
      reason: row.message,
    })),
  ];

  const out = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/audit-route-gate-consistency.js",
    scope: "Read-only consistency audit across route sweep, low-fund filter, disabled routes, and completion gates",
    safety: {
      rpcInventoryRead: false,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      routePositive: false,
      executableNow: false,
      signedActionJustified: false,
    },
    sourceArtifacts: {
      routeSweep: rel(ROUTE_SWEEP),
      lowFundFilter: rel(LOW_FUND),
      completionGates: rel(COMPLETION),
      disabledRoutes: rel(DISABLED),
    },
    summary: {
      routeSweepGeneratedAt: sweep.generatedAt || null,
      lowFundGeneratedAt: lowFund.generatedAt || null,
      lowFundSourceGeneratedAt: lowFund.summary?.sourceGeneratedAt || null,
      completionGeneratedAt: completion.generatedAt || null,
      routeRows: ranked.length,
      filterRows: filterRows.length,
      completionRows: completionRows.length,
      routePositive: sweepRoutePositive,
      executableNow: false,
      executableNowCount: Number.isSafeInteger(sweep.summary?.executableNowCount) && sweep.summary.executableNowCount >= 0
        ? sweep.summary.executableNowCount
        : sweep.summary?.executableNow === true ? 1 : 0,
      signedActionJustified: bool(sweep.summary?.signedActionJustified),
      lowFundEscalationReady: filterEscalationReady,
      completionIncompleteBranches: incompleteCompletionRows.length,
      issues: issues.length,
      criticalIssues: severityCounts.critical || 0,
      highIssues: severityCounts.high || 0,
      mediumIssues: severityCounts.medium || 0,
      lowIssues: severityCounts.low || 0,
      actionableFixes: actionableFixes.length,
      status: actionableFixes.length ? "actionable-consistency-fixes" : issues.length ? "consistency-issues-observed" : "consistent-no-action",
      nextAction: actionableFixes.length
        ? "Apply minimal metadata/mapping fixes, then rerun completion gates and this audit."
        : "No classifier fix identified; proceed to route-specific proof-gap work.",
    },
    topRouteRows: topRows(ranked, 12),
    incompleteCompletionRows: incompleteCompletionRows.map((row) => ({
      rank: row.rank,
      id: row.id,
      status: row.status,
      incompleteReasons: row.incompleteReasons,
      suggestedReport: COMPLETION_REPORT_SUGGESTIONS[row.id] || null,
    })),
    actionableFixes,
    issues,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`routeGateConsistency status=${out.summary.status} issues=${out.summary.issues} actionableFixes=${out.summary.actionableFixes}`);
  console.log(`Report: ${rel(OUT)}`);
}

main();
