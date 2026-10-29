#!/usr/bin/env node
// audit-phase0-coverage.js - coverage sanity audit for Phase 0 closeouts.
// Does not read RPC inventory, env files, private keys, or live endpoints.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_DIR = path.join(WORKSPACE, "reports", "raw", "fast");
const OUT = path.join(RAW_DIR, "phase0-coverage-audit.json");
const REPORT = path.join(WORKSPACE, "reports", "phase0-coverage-audit.md");
const QUIET = process.argv.includes("--quiet");

const REPORT_OVERRIDES = {
  "reports/raw/fast/reservoir-phase0.json": "reports/reservoir-deep-triage.md",
};

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return fallback; }
}

function readText(file, fallback = "") {
  try { return fs.readFileSync(file, "utf8"); } catch (_) { return fallback; }
}

function asNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const n = Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function round(value, decimals = 2) {
  const n = asNumber(value);
  if (n === null) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function safeText(value, max = 180) {
  return String(value ?? "").replace(/https?:\/\/\S+/g, "[redacted-url]").replace(/\s+/g, " ").trim().slice(0, max);
}

function rel(file) {
  return path.relative(WORKSPACE, file).replace(/\\/g, "/");
}

function walk(value, visitor, pathParts = []) {
  visitor(value, pathParts);
  if (Array.isArray(value)) value.forEach((item, i) => walk(item, visitor, [...pathParts, String(i)]));
  else if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) walk(child, visitor, [...pathParts, key]);
}

function addIssue(issues, severity, type, detail, evidence = null) {
  issues.push({ severity, type, detail: safeText(detail, 240), evidence });
}

function hasSignalReport(file) {
  const report = REPORT_OVERRIDES[file] || file.replace(/reports\/raw\/fast\//, "reports/").replace(/\.json$/, "-triage.md");
  const abs = path.join(WORKSPACE, report);
  const text = readText(abs, "");
  return { report, exists: Boolean(text), signal: /DORMANT|CONFIRMED|VULNERABLE|CLEAN|No confirmed permissionless/i.test(text) };
}

function sampleNumeric(summary, keys) {
  for (const key of keys) {
    const n = asNumber(summary?.[key]);
    if (n !== null) return { key, value: n };
  }
  return null;
}

function classifyCoverage(issues) {
  if (issues.some((i) => i.severity === "HIGH" && ["rpc-unavailable", "log-errors", "historical-log-gap", "required-endpoint-unavailable", "declared-partial-scope"].includes(i.type))) return "partial-or-blocked";
  if (issues.some((i) => i.severity === "MEDIUM" && ["bounded-selection", "cap-hit", "unsupported-chains", "endpoint-caveat", "declared-bounded-scope", "log-caveat"].includes(i.type))) return "bounded-with-caveats";
  return "full-enough-for-declared-scope";
}

function auditArtifact(file) {
  const json = readJson(file, {});
  const summary = json.summary || {};
  const target = json.target || {};
  const safety = json.safety || {};
  const issues = [];
  const reportInfo = hasSignalReport(rel(file));
  const declaredCoverage = summary.coverageClassification || json.coverageClassification || null;
  const declaredBounded = declaredCoverage === "bounded-with-caveats";

  if (!reportInfo.exists) addIssue(issues, "HIGH", "missing-triage", "No matching triage report found", { expected: reportInfo.report });
  else if (!reportInfo.signal) addIssue(issues, "MEDIUM", "untagged-triage", "Matching triage report lacks an explicit signal banner", { report: reportInfo.report });

  if (safety.rpcUrlsStored) addIssue(issues, "CRITICAL", "secret-hygiene", "Artifact claims RPC URLs were stored", null);
  if (safety.privateKeysRead) addIssue(issues, "CRITICAL", "secret-hygiene", "Artifact claims private keys were read", null);
  if (safety.signedActions || safety.exploitExecuteCalls) addIssue(issues, "CRITICAL", "execution-safety", "Artifact claims signed or exploit execution calls occurred", null);

  if ((asNumber(summary.routePositive) || 0) > 0) addIssue(issues, "HIGH", "route-positive-open", "Route-positive branch should not be considered closed", { routePositive: summary.routePositive });
  if ((asNumber(summary.executableNow) || 0) > 0 || summary.signedActionJustified) addIssue(issues, "CRITICAL", "signed-gate-open", "Executable/signed gate is open in Phase 0 artifact", { executableNow: summary.executableNow, signedActionJustified: summary.signedActionJustified });
  if (declaredCoverage === "partial-or-blocked") addIssue(issues, "HIGH", "declared-partial-scope", "Artifact declares partial-or-blocked coverage", { coverageClassification: declaredCoverage });
  else if (declaredCoverage === "bounded-with-caveats") addIssue(issues, "MEDIUM", "declared-bounded-scope", "Artifact declares bounded-with-caveats coverage", { coverageClassification: declaredCoverage });

  const rpcAvailability = summary.rpcAvailability || json.rpcAvailability || null;
  if (rpcAvailability && typeof rpcAvailability === "object") {
    const unavailable = Object.entries(rpcAvailability).filter(([, ok]) => !ok).map(([chain]) => chain);
    if (unavailable.length) addIssue(issues, "HIGH", "rpc-unavailable", "One or more declared RPC chains were unavailable", { unavailable });
  }
  for (const [key, value] of Object.entries(summary)) {
    if (/RpcAvailable$/i.test(key) && value === false) addIssue(issues, "HIGH", "rpc-unavailable", `${key} is false`, null);
  }

  if ((asNumber(summary.logErrors) || 0) > 0) {
    addIssue(issues, declaredBounded ? "MEDIUM" : "HIGH", declaredBounded ? "log-caveat" : "log-errors", "Log scan reported bounded errors", { logErrors: summary.logErrors });
  }
  const factoryLogErrors = summary.factoryLogErrors ?? (Array.isArray(json.factoryLogErrors) ? json.factoryLogErrors.length : null);
  if ((asNumber(factoryLogErrors) || 0) > 0) addIssue(issues, "MEDIUM", "log-caveat", "Factory log scan reported bounded errors", { factoryLogErrors });
  if (summary.historicalLogSupportedChains !== undefined && summary.chainsWithRpc !== undefined && asNumber(summary.historicalLogSupportedChains) < asNumber(summary.chainsWithRpc)) {
    addIssue(issues, "HIGH", "historical-log-gap", "Not all RPC chains support required historical logs", { historicalLogSupportedChains: summary.historicalLogSupportedChains, chainsWithRpc: summary.chainsWithRpc });
  }

  walk(json, (value, parts) => {
    const key = parts[parts.length - 1] || "";
    if ((key === "errors" || key === "logErrors" || key === "chunksFailed") && (asNumber(value) || 0) > 0) {
      addIssue(issues, declaredBounded ? "MEDIUM" : "HIGH", declaredBounded ? "log-caveat" : "log-errors", `Nested ${key} is non-zero`, { path: parts.join("."), value });
    }
    if (/unsupported.*chains?/i.test(key) && Array.isArray(value) && value.length) {
      addIssue(issues, "MEDIUM", "unsupported-chains", "Artifact declares unsupported chains", { path: parts.join("."), count: value.length, sample: value.slice(0, 8) });
    }
    if (/endpointResults$/i.test(key) && Array.isArray(value) && value.length) {
      const ok = value.filter((row) => row && row.ok).length;
      if (ok === 0) addIssue(issues, "HIGH", "required-endpoint-unavailable", "Endpoint result set has no successful endpoint", { path: parts.join("."), count: value.length });
      else if (ok < value.length) addIssue(issues, "LOW", "endpoint-caveat", "Some endpoint probes failed", { path: parts.join("."), ok, count: value.length });
    }
  });

  const thresholds = json.thresholds || {};
  for (const [key, cap] of Object.entries(thresholds)) {
    if (!/^max/i.test(key)) continue;
    const base = key.replace(/^max/i, "");
    const candidates = [base.charAt(0).toLowerCase() + base.slice(1), `${base.charAt(0).toLowerCase()}${base.slice(1)}s`, key.replace(/^max/i, "").replace(/Rows$/, "Rows")];
    for (const c of candidates) {
      if (summary[c] !== undefined && asNumber(summary[c]) !== null && asNumber(summary[c]) >= asNumber(cap)) {
        addIssue(issues, "MEDIUM", "cap-hit", `Summary field ${c} hit configured cap ${key}`, { field: c, value: summary[c], cap });
        break;
      }
    }
  }

  const available = sampleNumeric(summary, ["poolsAvailable", "pairsAvailable", "apiPoolsAvailable", "poolsDiscovered", "availablePairs", "totalPoolsAvailable"]);
  const inspected = sampleNumeric(summary, ["poolsInspected", "pairsInspected", "selectedPools", "selectedPairs", "poolRows", "materialPoolRows", "materialPairRows"]);
  if (available && inspected && available.value > 0 && inspected.value > 0 && inspected.value / available.value < 0.25) {
    addIssue(issues, "MEDIUM", "bounded-selection", "Only a bounded subset of available pools/pairs was inspected", { available, inspected, inspectedPct: round((inspected.value / available.value) * 100, 4) });
  }

  const blockerText = [...(json.blockers || []), summary.closedReason, json.nextReadOnlyStep].filter(Boolean).join(" | ");
  if (/unavailable|blocked|missing current RPC|HTTP 429|transport|not publicly accessible|partial|timed out/i.test(blockerText)) {
    addIssue(issues, "MEDIUM", "declared-caveat", "Artifact/report declares a coverage or endpoint caveat", { text: safeText(blockerText, 240) });
  }

  return {
    file: rel(file),
    report: reportInfo.report,
    target: target.name || target.slug || path.basename(file, ".json"),
    generatedAt: json.generatedAt || null,
    scanner: json.scanner || null,
    summary: {
      routePositive: summary.routePositive ?? null,
      watchCandidates: summary.watchCandidates ?? null,
      chainsWithRpc: summary.chainsWithRpc ?? null,
      logErrors: summary.logErrors ?? summary.factoryLogErrors ?? null,
      poolsAvailable: summary.poolsAvailable ?? summary.pairsAvailable ?? summary.apiPoolsAvailable ?? null,
      inspected: inspected?.value ?? null,
      materialRows: summary.materialPoolRows ?? summary.materialPairRows ?? summary.materialTokenRows ?? summary.materialBalanceRows ?? null,
      directConsumers: summary.directConsumerRows ?? summary.directPoolConsumerRows ?? summary.directPairConsumerRows ?? summary.ownerSpecificJoinRows ?? summary.contractSpecificJoinRows ?? summary.inboundSpecificJoinRows ?? null,
    },
    coverage: classifyCoverage(issues),
    issueCounts: ["CRITICAL", "HIGH", "MEDIUM", "LOW"].reduce((acc, sev) => ({ ...acc, [sev]: issues.filter((i) => i.severity === sev).length }), {}),
    issues,
  };
}

function renderReport(artifact) {
  const rows = artifact.rows;
  const highRows = rows.filter((r) => r.issueCounts.CRITICAL || r.issueCounts.HIGH);
  const caveatRows = rows.filter((r) => r.coverage !== "full-enough-for-declared-scope");
  const tableRows = caveatRows.map((r) => `| ${r.target} | ${r.coverage} | C${r.issueCounts.CRITICAL}/H${r.issueCounts.HIGH}/M${r.issueCounts.MEDIUM}/L${r.issueCounts.LOW} | ${r.issues.slice(0, 2).map((i) => `${i.type}: ${i.detail}`).join("; ")} |`).join("\n") || "| none | full-enough-for-declared-scope | 0 | none |";
  return `# Phase 0 Coverage Audit

Date: ${artifact.generatedAt}

## Result

This is a coverage audit, not an exploit finding. It checks whether Phase 0 closeouts have hidden caveats such as unavailable RPCs, failed historical logs, unsupported chains, endpoint failures, bounded pool sampling, or capped token scans.

| Metric | Value |
|---|---:|
| Phase 0 artifacts audited | ${artifact.summary.artifactsAudited} |
| Full enough for declared scope | ${artifact.summary.fullEnough} |
| Bounded with caveats | ${artifact.summary.boundedWithCaveats} |
| Partial or blocked | ${artifact.summary.partialOrBlocked} |
| Critical issues | ${artifact.summary.criticalIssues} |
| High issues | ${artifact.summary.highIssues} |

## Caveat Rows

| Target | Coverage | Issues | Top Evidence |
|---|---|---:|---|
${tableRows}

## Required Follow-Up

- Treat \`partial-or-blocked\` rows as not fully closed until the missing endpoint/RPC/log coverage is resolved or explicitly scoped out.
- Treat \`bounded-with-caveats\` rows as route-negative only for the scanner's declared bounded scope, not as exhaustive protocol-wide proof.
- Before each future closeout, verify adapter/source coverage and required historical queries first.

Artifacts: \`${rel(OUT)}\`.
`;
}

function main() {
  const files = fs.readdirSync(RAW_DIR)
    .filter((file) => file.endsWith("phase0.json"))
    .map((file) => path.join(RAW_DIR, file))
    .sort();
  const rows = files.map(auditArtifact).sort((a, b) => {
    const sev = (r) => r.issueCounts.CRITICAL * 1000 + r.issueCounts.HIGH * 100 + r.issueCounts.MEDIUM * 10 + r.issueCounts.LOW;
    return sev(b) - sev(a) || a.target.localeCompare(b.target);
  });
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/audit-phase0-coverage.js",
    safety: { rpcInventoryRead: false, rpcUrlsStored: false, envFilesRead: false, privateKeysRead: false, signedActions: false, exploitExecuteCalls: false },
    summary: {
      artifactsAudited: rows.length,
      fullEnough: rows.filter((r) => r.coverage === "full-enough-for-declared-scope").length,
      boundedWithCaveats: rows.filter((r) => r.coverage === "bounded-with-caveats").length,
      partialOrBlocked: rows.filter((r) => r.coverage === "partial-or-blocked").length,
      criticalIssues: rows.reduce((sum, r) => sum + r.issueCounts.CRITICAL, 0),
      highIssues: rows.reduce((sum, r) => sum + r.issueCounts.HIGH, 0),
      mediumIssues: rows.reduce((sum, r) => sum + r.issueCounts.MEDIUM, 0),
      lowIssues: rows.reduce((sum, r) => sum + r.issueCounts.LOW, 0),
    },
    rows,
  };
  fs.writeFileSync(OUT, `${JSON.stringify(artifact, null, 2)}\n`);
  fs.writeFileSync(REPORT, renderReport(artifact));
  if (!QUIET) console.log(`phase0Coverage artifacts=${artifact.summary.artifactsAudited} full=${artifact.summary.fullEnough} bounded=${artifact.summary.boundedWithCaveats} partial=${artifact.summary.partialOrBlocked} high=${artifact.summary.highIssues}`);
}

main();
