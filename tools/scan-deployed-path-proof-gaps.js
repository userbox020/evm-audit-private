#!/usr/bin/env node
// scan-deployed-path-proof-gaps.js - artifact-only deployed-path proof gap aggregator.
// Does not read RPC inventory, env files, private keys, or perform live calls.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "deployed-path-proof-gaps.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "deployed-path-proof-gaps-triage.md");

const INPUTS = [
  {
    key: "bridgeProofBinding",
    label: "Bridge Proof Binding",
    artifact: "reports/raw/fast/bridge-proof-binding.json",
    staticFields: ["proofRows", "staticProofRows"],
    highFields: ["highStaticRows"],
    deployedFields: ["deployedProofAcceptanceRows", "liquidMintUnlockRows"],
    valueFields: ["liquidMintUnlockRows"],
    blocker: "No deployed forged/replayed proof acceptance row mints or unlocks liquid assets.",
  },
  {
    key: "fakeAssetPoolValidation",
    label: "Fake Asset / Pool Validation",
    artifact: "reports/raw/fast/fake-asset-pool-validation.json",
    staticFields: ["validationRows", "staticSourceRows"],
    highFields: ["highStaticRows"],
    deployedFields: ["deployedAcceptanceRows", "consumerLinkedRows"],
    valueFields: ["consumerLinkedRows"],
    blocker: "No deployed consumer acceptance row maps attacker-created assets or pools to live value.",
  },
  {
    key: "poolShareSnapshotDrift",
    label: "Pool-Share Snapshot Drift",
    artifact: "reports/raw/fast/pool-share-snapshot-drift.json",
    staticFields: ["snapshotRows", "staticSnapshotRows"],
    highFields: ["highStaticRows"],
    deployedFields: ["deployedSnapshotDriftRows", "sameBlockMutationProofRows"],
    valueFields: ["sameBlockMutationProofRows"],
    blocker: "No deployed same-block snapshot-drift row changes value accounting.",
  },
  {
    key: "routerRfqSettlementDrift",
    label: "Router / RFQ Settlement Drift",
    artifact: "reports/raw/fast/router-rfq-settlement-drift.json",
    staticFields: ["sourceRows", "fieldBindingProofRows"],
    highFields: ["highStaticRows", "mediumStaticRows"],
    deployedFields: ["deployedRows", "deployedWatchRows", "deprecatedReachabilityRows"],
    valueFields: ["verifiedFieldDiffRows", "liveApprovalOrEscrowRows", "balanceDeltaMismatchRows"],
    blocker: "Deployed routers are inventory-only; no verified field drift, live approvals/escrow, or balance-delta mismatch.",
  },
  {
    key: "postAuditDeployedMap",
    label: "Post-Audit Deployed Map",
    artifact: "reports/raw/fast/post-audit-deployed-map.json",
    staticFields: ["driftRowsConsidered"],
    highFields: ["findings"],
    deployedFields: ["deployedAddressRows", "liveCodeRows"],
    valueFields: ["permissionlessAcceptedMarketRows", "permissionlessValuePathRows"],
    blocker: "Live-code drift rows remain role/state blocked and do not reach a permissionless accepted market/value path.",
  },
  {
    key: "deprecatedOrphanedReachability",
    label: "Deprecated / Orphaned Reachability",
    artifact: "reports/raw/fast/deprecated-orphaned-reachability.json",
    staticFields: ["sourceCandidateRows", "artifactCandidateRows"],
    highFields: ["deprecatedReachabilityRows", "orphanImplementationCandidateRows"],
    deployedFields: ["liveCodeRows", "selectorReachabilityRows", "liveBalanceRows"],
    valueFields: ["permissionlessValuePathRows", "liveApprovalOrEscrowRows"],
    blocker: "Deprecated live-code rows have no permissionless value path, live approval/escrow row, or exact economics.",
  },
  {
    key: "bridgeDomainSeparation",
    label: "Bridge Domain Separation",
    artifact: "reports/raw/fast/bridge-domain-separation.json",
    staticFields: ["identifierRows", "missingDomainRows"],
    highFields: ["highStaticRows", "knownHopPatternRows"],
    deployedFields: ["deployedDomainCollisionRows", "permissionlessCollisionRows"],
    valueFields: ["permissionlessCollisionRows"],
    blocker: "Domain-omission rows have no deployed permissionless collision with extractable funds.",
  },
  {
    key: "gasAccountingTipRace",
    label: "Gas Accounting / Tip Race",
    artifact: "reports/raw/fast/gas-accounting-tip-race.json",
    staticFields: ["gasRelevantRows"],
    highFields: ["highStaticRows", "mediumStaticRows"],
    deployedFields: ["liveMessageFlowRows", "materialTipRows"],
    valueFields: ["materialTipRows"],
    blocker: "Gas/tip pattern remains liveness/tip scoped; no live material message flow or principal value path is proven.",
  },
];

function exists(filePath) {
  try { return fs.existsSync(filePath); } catch (_) { return false; }
}

function readJson(relativePath, fallback = null) {
  const file = path.join(WORKSPACE, relativePath);
  try {
    if (!exists(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function rel(filePath) {
  return path.relative(WORKSPACE, filePath).replace(/\\/g, "/");
}

function asNumber(value) {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function sumFields(summary, fields) {
  return (fields || []).reduce((sum, field) => sum + asNumber(summary?.[field]), 0);
}

function firstField(summary, fields) {
  for (const field of fields || []) {
    const value = asNumber(summary?.[field]);
    if (value > 0) return { field, value };
  }
  return null;
}

function shortPath(value) {
  const text = String(value || "");
  if (!text) return null;
  return text.replace(/\\/g, "/").replace(/^.*?(targets\/)/, "$1");
}

function rowIdentity(row = {}) {
  return {
    target: row.target || row.name || row.protocol || null,
    chain: row.chain || null,
    file: shortPath(row.file || row.pair || row.source || null),
    line: row.line || null,
    function: row.function || row.symbol || row.name || null,
    confidence: row.confidence || null,
    blocker: row.blocker || row.verdict || row.reason || null,
  };
}

function collectRows(value, out = []) {
  if (!value || out.length >= 12) return out;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (out.length >= 12) break;
      if (item && typeof item === "object") {
        if (item.file || item.function || item.target || item.blocker || item.confidence) out.push(rowIdentity(item));
        collectRows(item.topRows, out);
        collectRows(item.rows, out);
      }
    }
    return out;
  }
  if (typeof value === "object") {
    collectRows(value.topRows, out);
    collectRows(value.sourceRows, out);
    collectRows(value.sourceTargets, out);
    collectRows(value.results, out);
    collectRows(value.rows, out);
  }
  return out;
}

function branchStatus(cfg, artifact) {
  const summary = artifact?.summary || {};
  const staticRows = sumFields(summary, cfg.staticFields);
  const highStaticRows = sumFields(summary, cfg.highFields);
  const deployedRows = sumFields(summary, cfg.deployedFields);
  const valuePathRows = sumFields(summary, cfg.valueFields);
  const exactEconomicsRows = asNumber(summary.exactEconomicsRows);
  const forkProofRows = asNumber(summary.forkProofRows);
  const routePositive = asNumber(summary.routePositive);
  const deployedSignal = firstField(summary, cfg.deployedFields);
  const valueSignal = firstField(summary, cfg.valueFields);
  const status = routePositive > 0
    ? "route-positive-needs-proof-review"
    : forkProofRows > 0
      ? "fork-proof-present-review"
      : exactEconomicsRows > 0
        ? "exact-economics-needs-fork"
        : valuePathRows > 0
          ? "deployed-value-path-needs-economics"
          : deployedRows > 0
            ? "deployed-inventory-no-value-path"
            : "source-only-no-deployed-path";
  return {
    key: cfg.key,
    label: cfg.label,
    artifact: cfg.artifact,
    artifactPresent: Boolean(artifact),
    generatedAt: artifact?.generatedAt || null,
    staticRows,
    highStaticRows,
    deployedPathRows: deployedRows,
    deployedSignal,
    valuePathRows,
    valueSignal,
    exactEconomicsRows,
    forkProofRows,
    routePositive,
    status,
    blocker: routePositive > 0 ? "Route-positive row requires independent proof review." : cfg.blocker,
    topRows: collectRows(artifact).slice(0, 5),
  };
}

function markdown(out) {
  const s = out.summary;
  const lines = [
    "# 🟢 DORMANT - Deployed-Path Proof Gaps",
    "",
    "Date: 2026-06-17",
    "",
    "## Result",
    "",
    `Aggregated static/source-only scans and existing deployed inventory artifacts. The branch remains fail-closed: \`deployedValuePathRows=${s.deployedValuePathRows}\`, \`exactEconomicsRows=${s.exactEconomicsRows}\`, \`forkProofRows=${s.forkProofRows}\`, \`routePositive=${s.routePositive}\`, \`executableNow=0\`, \`signedActionJustified=false\`. Deployed code or selector reachability is treated as inventory unless it maps to a permissionless value path plus exact positive economics and fork proof.`,
    "",
    "## Coverage",
    "",
    "| Branches | Artifacts | Static Rows | High Static | Deployed/Live Rows | Value Path Rows | Exact Econ | Fork Proof | Route+ |",
    "|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    `| ${s.branchesScanned} | ${s.artifactsPresent} | ${s.staticRows} | ${s.highStaticRows} | ${s.deployedPathRows} | ${s.deployedValuePathRows} | ${s.exactEconomicsRows} | ${s.forkProofRows} | ${s.routePositive} |`,
    "",
    "## Branch Rows",
    "",
    "| Branch | Status | Static | High | Deployed/Live | Value Path | Exact Econ | Blocker |",
    "|---|---|---:|---:|---:|---:|---:|---|",
  ];
  for (const row of out.branchRows) {
    lines.push(`| ${row.label} | ${row.status} | ${row.staticRows} | ${row.highStaticRows} | ${row.deployedPathRows} | ${row.valuePathRows} | ${row.exactEconomicsRows} | ${row.blocker} |`);
  }
  lines.push(
    "",
    "## Top Source-Only Rows",
    "",
    "| Branch | Target | Function | File | Blocker |",
    "|---|---|---|---|---|",
  );
  for (const row of out.topProofGaps.slice(0, 12)) {
    lines.push(`| ${row.branch} | ${row.target || "n/a"} | ${row.function || "n/a"} | ${row.file || "n/a"}${row.line ? `:${row.line}` : ""} | ${row.blocker || row.branchBlocker} |`);
  }
  lines.push(
    "",
    "## Route-Positive Gate",
    "",
    "Do not fork or build executors from this aggregate branch unless a specific static row is mapped to deployed code, the deployed path is permissionlessly reachable, the path moves or prices live value, exact economics are positive after gas/slippage/fees, and fork/local proof demonstrates net extraction.",
    "",
    "## Artifacts",
    "",
    "- JSON: `reports/raw/fast/deployed-path-proof-gaps.json`",
    "- Scanner: `tools/scan-deployed-path-proof-gaps.js`",
  );
  return lines.join("\n") + "\n";
}

function main() {
  fs.mkdirSync(path.dirname(RAW_OUT), { recursive: true });
  fs.mkdirSync(path.dirname(REPORT_OUT), { recursive: true });
  const branchRows = INPUTS.map((cfg) => branchStatus(cfg, readJson(cfg.artifact, null)));
  const postAuditSummary = readJson("reports/raw/fast/post-audit-deployed-map.json", {})?.summary || {};
  const deprecatedSummary = readJson("reports/raw/fast/deprecated-orphaned-reachability.json", {})?.summary || {};
  const topProofGaps = branchRows.flatMap((branch) => branch.topRows.map((row) => ({
    branch: branch.label,
    branchKey: branch.key,
    branchBlocker: branch.blocker,
    ...row,
  })));
  const summary = {
    branchesScanned: branchRows.length,
    artifactsPresent: branchRows.filter((row) => row.artifactPresent).length,
    staticRows: branchRows.reduce((sum, row) => sum + row.staticRows, 0),
    highStaticRows: branchRows.reduce((sum, row) => sum + row.highStaticRows, 0),
    deployedPathRows: branchRows.reduce((sum, row) => sum + row.deployedPathRows, 0),
    liveCodeRows: asNumber(postAuditSummary.liveCodeRows) + asNumber(deprecatedSummary.liveCodeRows),
    deployedReachabilityRows: asNumber(deprecatedSummary.deprecatedReachabilityRows),
    selectorReachabilityRows: asNumber(deprecatedSummary.selectorReachabilityRows),
    deployedValuePathRows: branchRows.reduce((sum, row) => sum + row.valuePathRows, 0),
    exactEconomicsRows: branchRows.reduce((sum, row) => sum + row.exactEconomicsRows, 0),
    forkProofRows: branchRows.reduce((sum, row) => sum + row.forkProofRows, 0),
    routePositive: branchRows.reduce((sum, row) => sum + row.routePositive, 0),
    executableNow: 0,
    signedActionJustified: false,
    status: "deployed-path-proof-gaps-no-value-path",
    blocker: "Static/source-only rows and deployed inventories do not yet join to permissionless value paths, exact positive economics, and fork proof.",
  };
  const out = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-deployed-path-proof-gaps.js",
    scope: "Artifact-only aggregate deployed-path proof-gap coverage for static/source-only scans",
    safety: {
      rpcInventoryRead: false,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: false,
      executableNow: false,
      signedActionJustified: false,
    },
    sourceArtifacts: INPUTS.map((cfg) => cfg.artifact),
    summary,
    branchRows,
    topProofGaps,
    requiredForRoutePositive: [
      "specific static row maps to deployed bytecode or verified deployed source",
      "entrypoint is permissionless or attacker-reachable without privileged compromise",
      "deployed path moves, mints, unlocks, prices, or accounts for live value",
      "exact acquisition/borrow/redeem/liquidation/unwind economics are positive after costs",
      "fork/local proof demonstrates net value extraction",
    ],
  };
  fs.writeFileSync(RAW_OUT, JSON.stringify(out, null, 2) + "\n");
  fs.writeFileSync(REPORT_OUT, markdown(out));
  console.log(`Deployed-path proof gaps: branches=${summary.branchesScanned}; deployedValuePathRows=${summary.deployedValuePathRows}; exactEconomicsRows=${summary.exactEconomicsRows}; routePositive=${summary.routePositive}`);
  console.log(`Wrote ${rel(RAW_OUT)}`);
  console.log(`Wrote ${rel(REPORT_OUT)}`);
}

main();
