#!/usr/bin/env node
// plan-top100-full-test-gap-fill.js - plan the focused gap-fill sweep for top-100 full-test rows.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const SOURCE = path.join(WORKSPACE, "reports", "raw", "fast", "top100-full-test.json");
const OUT_JSON = path.join(WORKSPACE, "reports", "raw", "fast", "top100-full-test-gap-plan.json");
const OUT_MD = path.join(WORKSPACE, "reports", "top100-full-test-gap-plan.md");

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
];

const ROW_LIMIT = Number(process.env.TOP100_FULL_TEST_GAP_PLAN_LIMIT || "100");
const QUIET = process.argv.includes("--quiet");

function readJson(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const text = fs.readFileSync(file, "utf8");
    return JSON.parse(text);
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

function asPercent(value) {
  const n = asNumber(value);
  if (n === null) return null;
  return Math.round(n * 100) / 100;
}

function safeRelative(file) {
  return path.relative(WORKSPACE, file).replace(/\\/g, "/");
}

function normalizeSourceArtifacts(row) {
  if (!row || !Array.isArray(row.sourceArtifacts)) return [];
  const artifacts = new Set();
  for (const a of row.sourceArtifacts) {
    if (!a) continue;
    if (typeof a === "string") {
      const p = a.trim();
      if (p) artifacts.add(p);
      continue;
    }
    if (typeof a === "object") {
      const p = (typeof a.path === "string" ? a.path : typeof a.file === "string" ? a.file : "").trim();
      if (p) artifacts.add(p);
    }
  }
  return Array.from(artifacts);
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

function rowSourceId(row) {
  return String(row.id || row.rowId || row.routeId || row.targetId || row.rank || "");
}

function rowCoveragePercent(row) {
  return asPercent(row?.checklist?.coveragePercent ?? row?.coveragePercent ?? 0) || 0;
}

function pickTopByRank(rows, limit) {
  return rows
    .slice()
    .sort((a, b) => {
      const aRank = asNumber(a.rank);
      const bRank = asNumber(b.rank);
      if (aRank !== null && bRank !== null && aRank !== bRank) return aRank - bRank;
      const aPriority = asNumber(a.priorityScore) || 0;
      const bPriority = asNumber(b.priorityScore) || 0;
      if (aPriority !== bPriority) return bPriority - aPriority;
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

function hasMissing(row, key) {
  if (!row || typeof row !== "object") return false;
  return rowMissingItems(row).some((item) => String(item) === String(key));
}

function rowLabel(row) {
  return [
    row.rank != null ? `#${row.rank}` : null,
    row.protocol || "",
    row.surface || row.status || "",
  ]
    .filter(Boolean)
    .join(" | ");
}

function buildCategoryStatsFromSource(source, key, fallbackTotal) {
  const cat = (source && source.categorySummary && source.categorySummary[key]) || {};
  const total = asNumber(cat.total);
  const covered = asNumber(cat.covered);
  const safeTotal = Number.isFinite(total) ? total : fallbackTotal;
  const safeCovered = Number.isFinite(covered) ? covered : 0;
  const gap = Math.max(0, safeTotal - safeCovered);
  const coveragePercent = safeTotal > 0 ? (safeCovered / safeTotal) * 100 : 0;
  return {
    total: safeTotal,
    covered: safeCovered,
    gap,
    coveragePercent: asPercent(coveragePercent),
  };
}

function weightedPriority(rows) {
  return rows.reduce((acc, row) => {
    const priority = asNumber(row.priorityScore) || 0;
    const rank = asNumber(row.rank);
    const rankBoost = Number.isFinite(rank) ? Math.max(0, 101 - rank) : 0;
    return acc + priority + rankBoost;
  }, 0);
}

function buildCategoryRows(rows, sourceRowsSummary) {
  const out = [];
  for (const row of rows) {
    out.push({
      rowId: rowSourceId(row),
      id: rowSourceId(row),
      rank: asNumber(row.rank),
      protocol: row.protocol || "",
      chain: row.chain || "",
      surface: row.surface || "",
      status: row.status || "",
      priorityScore: asNumber(row.priorityScore) || 0,
      finalClassification: row.finalClassification || "",
      missing: hasMissing(row, row.__gapFillCategory),
      missingChecklistItems: rowMissingItems(row),
      coveragePercent: rowCoveragePercent(row),
      sourceArtifacts: normalizeSourceArtifacts(row),
      nextReadOnlyStep: row.nextReadOnlyStep || "",
    });
  }
  return out;
}

function toMarkdownArtifactList(artifacts) {
  if (!artifacts.length) return "- none";
  return artifacts
    .slice(0, 4)
    .map((artifact) => `- ${artifact}`)
    .concat(artifacts.length > 4 ? [`- ... +${artifacts.length - 4} more artifacts`] : [])
    .join("\n");
}

function renderMarkdown(plan) {
  const lines = [];
  const { summary, categories } = plan;

  lines.push("# 🟢 DORMANT - Top-100 Full-Test Gap-Fill Plan");
  lines.push("");
  lines.push(`Generated: ${plan.generatedAt}`);
  lines.push(`Source: \`${safeRelative(SOURCE)}\``);
  lines.push("");
  lines.push("## Plan summary");
  lines.push(`- Top rows analyzed: ${summary.rowsAnalyzed}`);
  lines.push(`- Planned categories: ${summary.categoriesPlanned}`);
  lines.push(`- Missing pairs before: ${summary.missingPairsBefore}`);
  lines.push(`- Planned batch size: ${summary.batchRowLimit}`);
  lines.push(`- Weighted priority total: ${summary.weightedPriorityTotal}`);
  lines.push("");

  lines.push("## Category queue (weighted priority)");
  lines.push("| Category | Missing pairs | Total | Covered | Gap | Coverage | Weighted priority |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|");
  for (const c of categories) {
    lines.push(`| ${c.label} | ${c.missingPairs} | ${c.total} | ${c.covered} | ${c.gap} | ${c.coveragePercent ?? 0}% | ${c.weightedPriority} |`);
  }
  lines.push("");

  lines.push("## Top rows per category");
  for (const category of categories) {
    lines.push(`### ${category.label} (${category.key})`);
    lines.push(`- Weighted priority: ${category.weightedPriority}`);
    lines.push(`- Coverage: ${category.coveragePercent ?? 0}% (total ${category.total}, covered ${category.covered}, gap ${category.gap})`);
    if (!category.rows.length) {
      lines.push("- No row currently requires this gap-fill label in current top rows.");
      lines.push("");
      continue;
    }
    lines.push("- Coverage and source artifacts:");
    for (const row of category.rows.slice(0, 10)) {
      lines.push(`  - ${rowLabel(row)} (rowId=${row.id || row.rowId}), coverage=${row.coveragePercent}%`);
      lines.push(`    - Source artifacts:`);
      lines.push(toMarkdownArtifactList(row.sourceArtifacts)
        .split("\n")
        .map((line) => `      ${line}`)
        .join("\n"));
    }
    lines.push("");
  }

  lines.push("## Scope and constraints");
  lines.push("- Artifact-only scan; no RPC calls, no env file reads, no signed actions.");
  lines.push("- Fail-closed posture: route/executable/signed gates remain closed unless route-positive proof appears.");
  lines.push("- Category labels are preserved verbatim for scanner pattern matching.");
  lines.push("- Weighted priority uses `(priorityScore || 0) + max(0, 101-rank)` per top-row category gap entry.");

  return lines.join("\n");
}

function main() {
  const source = readJson(SOURCE, {});
  const rows = extractRows(source.rows ? { rows: source.rows } : source);
  const limit = Number.isFinite(ROW_LIMIT) && ROW_LIMIT > 0 ? Math.min(100, ROW_LIMIT) : 100;
  const topRows = pickTopByRank(rows, limit);

  const allCategoryRows = new Map();
  for (const row of topRows) {
    const missingSet = new Set(rowMissingItems(row));
    for (const category of CATEGORY_ORDER) {
      if (missingSet.has(category.key)) {
        if (!allCategoryRows.has(category.key)) allCategoryRows.set(category.key, []);
        const bucket = allCategoryRows.get(category.key);
        const next = Object.assign({}, row, { __gapFillCategory: category.key });
        bucket.push(next);
      }
    }
  }

  const categories = CATEGORY_ORDER.map((entry) => {
    const missingRows = allCategoryRows.get(entry.key) || [];
    const stat = buildCategoryStatsFromSource(source, entry.key, topRows.length);
    const withMeta = buildCategoryRows(missingRows).map((row) => {
      row.missing = hasMissing(row, entry.key);
      return row;
    });

    return {
      ...entry,
      missingPairs: withMeta.length,
      weightedPriority: Math.round(weightedPriority(withMeta)),
      total: stat.total,
      covered: stat.covered,
      gap: stat.gap,
      coveragePercent: stat.coveragePercent,
      rows: withMeta,
    };
  });

  const rowsAnalyzed = topRows.length;
  const missingPairsBefore = categories.reduce((acc, category) => acc + (category.missingPairs || 0), 0);
  const weightedPriorityTotal = categories.reduce((acc, category) => acc + (category.weightedPriority || 0), 0);
  const allPairs = [];
  for (const category of categories) {
    for (const row of category.rows) {
      allPairs.push({
        rowId: row.rowId,
        category: category.key,
        reason: `${category.label} gap remains before explicit proof`,
      });
    }
  }

  const out = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/plan-top100-full-test-gap-fill.js",
    safety: {
      rpcCallsBlocked: true,
      rpcInventoryRead: false,
      envFilesRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      routePositive: false,
      executableNow: false,
      signedActionJustified: false,
    },
    source: {
      top100FullTest: safeRelative(SOURCE),
      top100FullTestGeneratedAt: source.generatedAt || source.summary?.sourceGeneratedAt || null,
    },
    summary: {
      rowsAnalyzed,
      categoriesPlanned: CATEGORY_ORDER.length,
      rowsSelected: rowsAnalyzed,
      missingPairsBefore,
      weightedPriorityTotal,
      reviewedPairs: 0,
      blockedPairs: 0,
      routePositive: 0,
      executableNow: 0,
      signedActionJustified: false,
      batchRowLimit: CATEGORY_ORDER.length,
      batchCount: 1,
    },
    categories,
    pairs: allPairs,
  };

  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  fs.writeFileSync(OUT_MD, `${renderMarkdown(out)}\n`, "utf8");

  if (!QUIET) {
    console.log(`Top-100 gap-fill plan written: ${safeRelative(OUT_JSON)} and ${safeRelative(OUT_MD)}`);
    console.log(`Plan missing pairs: ${missingPairsBefore}; categories: ${CATEGORY_ORDER.length}; rows analyzed: ${rowsAnalyzed}`);
  }
}

main();
