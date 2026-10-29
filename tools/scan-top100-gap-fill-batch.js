#!/usr/bin/env node
// scan-top100-gap-fill-batch.js - run an artifact-only gap-fill batch for top-100 rows.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const TOP100_SOURCE = path.join(WORKSPACE, "reports", "raw", "fast", "top100-full-test.json");
const PLAN_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "top100-full-test-gap-plan.json");
const OUTPUT_DIR = path.join(WORKSPACE, "reports", "raw", "fast");
const REPORT_DIR = path.join(WORKSPACE, "reports");

const CATEGORY_ORDER = [
  { key: "strategyAdapterAccountingMismatch", label: "Strategy adapter accounting mismatch" },
  { key: "publicAllocatorExploitation", label: "Public allocator exploitation" },
  { key: "feeOnTransferAmplification", label: "Fee-on-transfer amplification" },
  { key: "callbackReentrancy", label: "Cross-function/callback reentrancy" },
  { key: "oracleSandwich", label: "Oracle sandwich/manipulate-exploit-revert" },
  { key: "governanceAttacks", label: "Governance and flash-loan voting attacks" },
  { key: "roundingPredictionMarket", label: "Rounding and prediction-market attacks" },
  { key: "fakeAssetPoolValidation", label: "Fake asset/pool validation" },
  { key: "permitDelegatedAuthorization", label: "Permit/delegated authorization edge cases" },
  { key: "crossChainMessageOrdering", label: "Cross-chain message ordering" },
  { key: "vaultSharePriceManipulation", label: "Vault share-price manipulation" },
  { key: "epochQueueWindowTransitions", label: "Epoch/queue/window state transitions" },
  { key: "upgradeModuleInitialization", label: "Upgrade/module initialization state" },
  { key: "rewardIndexIncentiveAccounting", label: "Reward-index/incentive accounting" },
  { key: "consumerGraphValidation", label: "Consumer graph validation" },
  { key: "donationErC4626", label: "Donation/ERC4626/share accounting" },
  { key: "permissionlessReturndataControl", label: "Permissionless surface with returndata/random-selector controls" },
  { key: "liquidationAuctionSequencing", label: "Liquidation/auction sequencing" },
  { key: "eventLogs", label: "Event/log active-surface discovery" },
];

const DEFAULT_CATEGORIES_PER_BATCH = Number(process.env.TOP100_FULL_TEST_GAP_BATCH_CATEGORIES || "10");
const QUIET = process.argv.includes("--quiet");

function safeRelative(file) {
  return path.relative(WORKSPACE, file).replace(/\\/g, "/");
}

function safePadNumber(value) {
  return String(Number.isFinite(Number(value)) ? Math.max(1, Number(value)) : 1).padStart(2, "0");
}

function readJson(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function asNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const n = Number(String(value).replace(/[^0-9+-.eE]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function pickTopByRank(rows, limit) {
  return rows
    .slice()
    .sort((a, b) => {
      const rankA = asNumber(a.rank);
      const rankB = asNumber(b.rank);
      if (rankA !== null && rankB !== null && rankA !== rankB) return rankA - rankB;
      const pA = asNumber(a.priorityScore) || 0;
      const pB = asNumber(b.priorityScore) || 0;
      if (pA !== pB) return pB - pA;
      return String(a.id || "").localeCompare(String(b.id || ""));
    })
    .slice(0, limit);
}

function extractRows(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];

  const directKeys = ["rows", "ranked", "targets", "items", "results", "candidates", "top", "entries"];
  for (const key of directKeys) {
    if (Array.isArray(data[key])) return data[key];
  }
  return [];
}

function rowMissingItems(row) {
  const out = new Set();
  for (const item of Array.isArray(row?.missingChecklistItems) ? row.missingChecklistItems : []) {
    const key = String(item || "").trim();
    if (key) out.add(key);
  }
  for (const item of Array.isArray(row?.checklist?.missing) ? row.checklist.missing : []) {
    const key = String(item || "").trim();
    if (key) out.add(key);
  }
  return Array.from(out);
}

function parseList(value) {
  return Array.isArray(value) ? value.map((v) => String(v || "").trim()).filter(Boolean) : [];
}

function normalizeSourceArtifacts(row) {
  if (!row || !Array.isArray(row.sourceArtifacts)) return [];
  const artifacts = new Set();
  for (const artifact of row.sourceArtifacts) {
    if (!artifact) continue;
    if (typeof artifact === "string") {
      const p = artifact.trim();
      if (p) artifacts.add(p);
      continue;
    }
    if (typeof artifact === "object") {
      const p = (typeof artifact.path === "string" ? artifact.path : typeof artifact.file === "string" ? artifact.file : "").trim();
      if (p) artifacts.add(p);
    }
  }
  return Array.from(artifacts);
}

function asPercent(value) {
  const n = asNumber(value);
  if (n === null) return 0;
  return Math.round(n * 100) / 100;
}

function hasExactAndForkProof(row) {
  const exact = asNumber(row?.exactEconomicsRows);
  const fork = asNumber(row?.forkProofRows);
  return Number.isFinite(exact) && Number.isFinite(fork) && exact > 0 && fork > 0;
}

function rowApplicability(row) {
  const text = (
    `${row?.protocol || ""} ${row?.surface || ""} ${row?.status || ""} ${row?.nextReadOnlyStep || ""} ${Array.isArray(row?.blockers) ? row.blockers.join(" ") : ""}`
  ).toLowerCase();

  if (/cross-chain|bridge|ccip|relay|l2/.test(text)) return "cross-chain/bridge";
  if (/oracle/.test(text)) return "oracle";
  if (/governance|dao|vote|voting/.test(text)) return "governance";
  if (/dex|swap|amm|router|liquidat|path/.test(text)) return "dex/router";
  if (/lending|borrow|vault|loan|liquidat|aave|morpho|resupply|solv/.test(text)) return "lending/vault";
  return "generic";
}

function isRowBlocked(row) {
  if (!row || typeof row !== "object") return true;
  const sourceArtifactErrors = parseList(row.sourceArtifactErrors).length;
  const sourceArtifactsMissing = parseList(row.sourceArtifactsMissing).length;
  const staleOrMissingArtifacts = parseList(row.staleOrMissingArtifacts).length;
  return Boolean(row.rpcBlocked) || sourceArtifactErrors > 0 || sourceArtifactsMissing > 0 || staleOrMissingArtifacts > 0;
}

function blockedReasons(row) {
  const reasons = [];
  if (Boolean(row?.rpcBlocked)) reasons.push("rpcBlocked");
  if (parseList(row?.sourceArtifactErrors).length > 0) reasons.push("sourceArtifactErrors");
  if (parseList(row?.sourceArtifactsMissing).length > 0) reasons.push("sourceArtifactsMissing");
  if (parseList(row?.staleOrMissingArtifacts).length > 0) reasons.push("staleOrMissingArtifacts");
  return reasons;
}

function categoryReviewText(category, row, decision, reasons, applicability) {
  const evidenceState = hasExactAndForkProof(row)
    ? "route-specific exact economics and fork proof are independently confirmed"
    : "route-specific exact economics and fork proof are both present";

  const base = `${category.label} (${category.key}) artifact-only review (${applicability})`;
  if (decision === "already-covered-by-source-artifacts") {
    return `${base}; no additional gap-fill artifact is required. No route-positive proof is asserted in this batch; gates remain closed unless ${evidenceState}.`;
  }
  if (decision === "blocked-rpc-or-source-gap") {
    return `${base}; blocked by ${reasons.join(", ")}. No route-positive proof is asserted in this batch; gates remain closed unless ${evidenceState}.`;
  }
  return `${base}; queue for artifact-only watch/review. No route-positive proof is asserted in this batch. Gates remain closed unless ${evidenceState}.`;
}

function parseBatchIndex() {
  const direct = process.argv.find((arg) => /^--batch(=\d+)?$/i.test(arg));
  if (direct) {
    const eq = direct.split("=")[1];
    if (eq) {
      const n = Number(eq);
      if (Number.isFinite(n) && n > 0) return Math.round(n);
    }
  }

  const idxPos = process.argv.findIndex((arg) => arg === "--batchIndex" || arg === "--batch-index");
  if (idxPos !== -1 && process.argv[idxPos + 1]) {
    const n = Number(process.argv[idxPos + 1]);
    if (Number.isFinite(n) && n > 0) return Math.round(n);
  }

  const envIdx = Number(process.env.TOP100_FULL_TEST_GAP_BATCH_INDEX || "0");
  if (Number.isFinite(envIdx) && envIdx > 0) return Math.round(envIdx);

  return 1;
}

function buildCategoryReviewMap(row, categories, missingMap) {
  const applicability = rowApplicability(row);
  const blocked = isRowBlocked(row);
  const reasons = blockedReasons(row);
  const out = {};

  for (const cat of categories) {
    const has = missingMap.has(cat.key);
    const decision = has
      ? (blocked ? "blocked-rpc-or-source-gap" : "artifact-only-gap-reviewed-watch-only")
      : "already-covered-by-source-artifacts";
    out[cat.key] = {
      key: cat.key,
      label: cat.label,
      categoryLabel: cat.label,
      applicability,
      decision,
      routePositive: false,
      executableNow: false,
      signedActionJustified: false,
      reviewText: categoryReviewText(cat, row, decision, reasons, applicability),
    };
  }

  return out;
}

function buildScannedRows(rows, categories) {
  return rows.map((row) => {
    const id = String(row.id || row.rowId || row.routeId || row.targetId || row.rank || "");
    const missingSet = new Set(rowMissingItems(row));
    const missingBefore = categories.map((c) => c.key).filter((k) => missingSet.has(k));
    const blocked = isRowBlocked(row);
    const reasons = blockedReasons(row);
    return {
      rowId: id,
      id,
      rank: asNumber(row.rank),
      protocol: row.protocol || "",
      chain: row.chain || "",
      surface: row.surface || "",
      status: row.status || "",
      priorityScore: asNumber(row.priorityScore) || 0,
      finalClassification: row.finalClassification || "",
      preCoveragePercent: asPercent(row?.checklist?.coveragePercent ?? row?.coveragePercent ?? 0),
      sourceArtifacts: normalizeSourceArtifacts(row),
      missingBefore,
      categoryReview: buildCategoryReviewMap(row, categories, missingSet),
      blocked,
      blockedReasons: reasons,
      routePositive: 0,
      executableNow: false,
      signedActionJustified: false,
      requiredForRoutePositive: parseList(row.requiredForRoutePositive),
    };
  });
}

function renderReport(payload) {
  const lines = [];
  const { summary, categorySummary, source, rows, scannedCategories } = payload;

  const batchLabel = safePadNumber(payload.batch);
  lines.push(`# 🟢 DORMANT - Top-100 Full-Test Gap-Fill Batch ${batchLabel}`);
  lines.push("");
  lines.push(`Generated: ${payload.generatedAt}`);
  lines.push(`Batch: ${payload.batch} (${payload.batchLabel})`);
  lines.push(`Source: \`${safeRelative(TOP100_SOURCE)}\``);
  if (source?.gapFillPlan) lines.push(`Plan source: \`${safeRelative(PLAN_FILE)}\``);
  lines.push(`Rows analyzed from source: ${source.topRowsAnalyzed || 0}`);
  lines.push(`Rows output by batch: ${summary.rowsAnalyzed}`);
  lines.push(`Categories reviewed: ${summary.categoriesReviewed}`);
  lines.push(`Missing pairs before: ${summary.missingPairsBefore}`);
  lines.push(`Reviewed pairs: ${summary.reviewedPairs}`);
  lines.push(`Blocked pairs: ${summary.blockedPairs}`);
  lines.push("");

  lines.push("## Route gate posture");
  lines.push(`- routePositive: ${summary.routePositive}`);
  lines.push(`- executableNow: ${summary.executableNow}`);
  lines.push(`- signedActionJustified: ${summary.signedActionJustified}`);
  lines.push("- Artifact-only pass; no route-positive proof is asserted in this batch.");

  lines.push("");
  lines.push("## Category summaries (batch)");
  lines.push("| Category | Missing before | Blocked rows | Reviewed rows |");
  lines.push("|---|---:|---:|---:|");
  for (const row of categorySummary) {
    lines.push(`| ${row.label} | ${row.missingBefore} | ${row.blocked} | ${row.reviewed} |`);
  }

  lines.push("");
  lines.push("## Scanned categories");
  for (const c of scannedCategories) {
    lines.push(`- ${c.label} (${c.key})`);
  }

  const blockedRows = rows.filter((row) => row.blocked);
  if (blockedRows.length) {
    lines.push("");
    lines.push("## Blocked rows");
    for (const row of blockedRows) {
      const rank = row.rank != null ? `#${row.rank}` : "#?";
      lines.push(`- ${rank} ${row.id}: ${row.blockedReasons.join(", ") || "blocked"}`);
    }
  }

  lines.push("");
  lines.push("## Top scanned rows");
  for (const row of rows.slice(0, 80)) {
    const rank = row.rank != null ? `#${row.rank}` : "#?";
    lines.push(`- ${rank} ${row.id} [coverage ${row.preCoveragePercent}%]`);
    lines.push(`  - Missing-before: ${row.missingBefore.length ? row.missingBefore.join(", ") : "(none)"}`);
    lines.push(`  - Blocked: ${row.blocked ? "yes" : "no"}`);
  }

  lines.push("");
  lines.push("## Scope");
  lines.push("- Artifact-only, read-only evidence pass.");
  lines.push("- No RPC calls, no env reads, no signed/exploit actions.");

  return lines.join("\n");
}

function main() {
  const top100 = readJson(TOP100_SOURCE, null);
  if (!top100 || typeof top100 !== "object") {
    throw new Error(`Top-100 source missing or invalid: ${safeRelative(TOP100_SOURCE)}`);
  }

  const planSource = readJson(PLAN_FILE, null);

  const batchIndex = parseBatchIndex();
  const categoriesPerBatch = Number.isFinite(DEFAULT_CATEGORIES_PER_BATCH) && DEFAULT_CATEGORIES_PER_BATCH > 0
    ? Math.round(DEFAULT_CATEGORIES_PER_BATCH)
    : CATEGORY_ORDER.length;

  const rows = extractRows(top100.rows ? { rows: top100.rows } : top100);
  const limit = Number.isFinite(asNumber(top100.summary?.rowsAnalyzed))
    ? Math.min(100, top100.summary.rowsAnalyzed)
    : 100;
  const topRows = pickTopByRank(rows, limit);

  const batchCategories = CATEGORY_ORDER.slice((batchIndex - 1) * categoriesPerBatch, batchIndex * categoriesPerBatch);
  if (!batchCategories.length) {
    throw new Error(`No categories selected for batch ${batchIndex}; category order has ${CATEGORY_ORDER.length}.`);
  }

  const scannedRows = buildScannedRows(topRows, batchCategories);
  const categorySummary = [];
  for (const category of batchCategories) {
    const withMissing = scannedRows.filter((row) => row.missingBefore.includes(category.key));
    const blocked = withMissing.filter((row) => row.blocked);
    categorySummary.push({
      key: category.key,
      label: category.label,
      missingBefore: withMissing.length,
      blocked: blocked.length,
      reviewed: scannedRows.length,
    });
  }

  const rowsAnalyzed = scannedRows.length;
  const missingPairsBefore = scannedRows.reduce((acc, row) => acc + (row.missingBefore.length || 0), 0);
  const blockedPairs = scannedRows.filter((row) => row.blocked).length;
  const reviewedPairs = rowsAnalyzed;

  const padded = String(batchIndex).padStart(2, "0");
  const outJson = path.join(OUTPUT_DIR, `top100-full-test-gap-fill-batch-${padded}.json`);
  const outMd = path.join(REPORT_DIR, `top100-full-test-gap-fill-batch-${padded}.md`);

  const out = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-top100-gap-fill-batch.js",
    batch: batchIndex,
    batchLabel: `top100-full-test-gap-fill-batch-${padded}`,
    safety: {
      rpcInventoryRead: false,
      rpcUrlsStored: false,
      envFilesRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      routePositive: false,
      executableNow: false,
      signedActionJustified: false,
    },
    source: {
      top100FullTest: safeRelative(TOP100_SOURCE),
      top100FullTestGeneratedAt: top100.generatedAt || top100.summary?.sourceGeneratedAt || null,
      topRowsAnalyzed: topRows.length,
      gapFillPlan: planSource ? safeRelative(PLAN_FILE) : null,
      gapFillPlanGeneratedAt: planSource?.generatedAt || null,
    },
    summary: {
      batch: batchIndex,
      rowsAnalyzed,
      categoriesReviewed: batchCategories.length,
      categoriesAvailable: CATEGORY_ORDER.length,
      missingPairsBefore,
      reviewedPairs,
      blockedPairs,
      routePositive: 0,
      executableNow: 0,
      signedActionJustified: false,
    },
    categorySummary,
    scannedCategories: batchCategories.map((c) => ({ key: c.key, label: c.label })),
    rows: scannedRows,
    pairs: scannedRows.flatMap((row) => row.missingBefore.map((category) => ({
      rowId: row.rowId,
      id: row.id,
      category,
      decision: row.categoryReview[category]?.decision,
      routePositive: false,
      executableNow: false,
      signedActionJustified: false,
    }))),
  };

  fs.mkdirSync(path.dirname(outJson), { recursive: true });
  fs.writeFileSync(outJson, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(REPORT_DIR, `top100-full-test-gap-fill-batch-${padded}.md`), `${renderReport(out)}\n`, "utf8");

  if (!QUIET) {
    console.log(`Top100 gap-fill batch written: ${safeRelative(outJson)} and reports/top100-full-test-gap-fill-batch-${padded}.md`);
    console.log(`batch=${batchIndex} categoriesReviewed=${batchCategories.length} rows=${rowsAnalyzed} reviewedPairs=${reviewedPairs}`);
  }
}

main();
