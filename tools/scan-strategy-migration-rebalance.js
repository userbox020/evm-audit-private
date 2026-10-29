#!/usr/bin/env node
// Read-only strategy migration, rebalance, withdrawal-queue, and vault accounting drift scanner.
// Consumes local sanitized artifacts plus any available target source. No RPC, env, keys, txs, or fork calls.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW = path.join(WORKSPACE, "reports", "raw", "fast");
const OUT_JSON = path.join(RAW, "strategy-migration-rebalance.json");
const OUT_MD = path.join(WORKSPACE, "reports", "strategy-migration-rebalance-triage.md");
const QUIET = process.argv.includes("--quiet");

const MAX_SOURCE_FILES = Number(process.env.STRATEGY_MIGRATION_MAX_SOURCE_FILES || "6000");
const MAX_ARTIFACT_BYTES = Number(process.env.STRATEGY_MIGRATION_MAX_ARTIFACT_BYTES || String(8 * 1024 * 1024));
const MATERIAL_USD = Number(process.env.STRATEGY_MIGRATION_MATERIAL_USD || "10000");

const SOURCE_TARGETS = [
  { name: "Vault and tokenized strategy sources", chain: "multi-chain", priority: 10, dirs: ["targets/yearn-vaults-v3", "targets/tokenized-strategy", "targets/spark-vaults-v2", "targets/etherfi-contracts", "targets/morpho-metamorpho", "targets/morpho-vault-v2"] },
  { name: "Lending vault integrations", chain: "multi-chain", priority: 8, dirs: ["targets/euler-evk", "targets/euler-periphery", "targets/llamalend", "targets/curve-stablecoin", "targets/crvusd", "targets/silo-contracts-v2"] },
  { name: "Generic local target sources", chain: "multi-chain", priority: 4, dirs: ["targets"] },
];

const TEXT_EXTS = new Set([".sol", ".vy", ".ts", ".js", ".rs", ".go", ".move"]);
const EXCLUDED_DIRS = new Set([".git", "node_modules", "target", "build", "dist", "out", "cache", "artifacts", "coverage", "generated", "abi", "lib", "vendor", "docs", "doc"]);
const EXCLUDED_PATH_RE = /[\\/](test|tests|foundry_tests|mock|mocks|script|scripts|examples?|fixtures?|audits?|cypress|support)[\\/]/i;

const EXCLUDED_ARTIFACT_FILES = new Set([
  "audit-completion-gates.json",
  "evaluator-proximity.json",
  "low-fund-executable-route-filter.json",
  "non-borrow-drain-surface.json",
  "route-positive-sweep.json",
  "strategy-migration-rebalance.json",
]);

const STRATEGY_TERMS = ["strategy", "strategies", "strategyAssets", "TokenizedStrategy", "BaseStrategy", "assetStrategy", "debtRatio", "creditAvailable", "estimatedTotalAssets"];
const MIGRATION_TERMS = ["migrate", "migration", "migrateStrategy", "migrateTo", "migrateFrom", "prepareMigration", "acceptMigration", "rollover"];
const QUEUE_TERMS = ["withdrawalQueue", "withdrawQueue", "defaultQueue", "queue", "requestWithdraw", "pendingWithdraw", "pendingRedeem", "cooldown", "claimWithdrawal", "redeemQueue"];
const REBALANCE_TERMS = ["rebalance", "harvest", "tend", "report", "processReport", "process_report", "updateDebt", "update_debt", "adjustPosition", "liquidatePosition"];
const ACCOUNTING_TERMS = ["totalAssets", "totalSupply", "convertToAssets", "previewRedeem", "pricePerShare", "lockedProfit", "unrealizedLoss", "profit", "loss", "nav", "netAssetValue", "liquidationValue"];
const VALUE_TERMS = ["withdraw", "redeem", "transfer", "safeTransfer", "transferFrom", "mint", "burn", "claim", "borrow", "liquidate"];
const ROLE_TERMS = ["onlyOwner", "onlyRole", "onlyAdmin", "onlyGovernance", "onlyManagement", "onlyKeeper", "requiresAuth", "auth", "AccessControl", "Ownable", "governance", "guardian", "manager", "keeper", "strategist"];
const STRONG_GUARD_TERMS = ["onlyRole", "onlyGovernance", "onlyManagement", "onlyKeeper", "onlyOwner", "msg.sender", "hasRole", "governance", "guardian", "management"];

const ARTIFACT_HINT_RE = /strategy|strategies|migration|migrate|rebalance|withdrawalqueue|withdrawqueue|requestwithdraw|pendingwithdraw|pendingredeem|cooldown|harvest|tokenizedstrategy|netassetvalue|liquidationvalue/i;

function rel(file) {
  return path.relative(WORKSPACE, file).replace(/\\/g, "/");
}

function exists(file) {
  try { return fs.existsSync(file); } catch (_) { return false; }
}

function safeRead(file) {
  try { return fs.readFileSync(file, "utf8"); } catch (_) { return ""; }
}

function readJson(file) {
  try {
    if (!exists(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    return { parseError: String(err && err.message ? err.message : err) };
  }
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

function bool(value) {
  const n = asNumber(value);
  return n !== null ? n > 0 : Boolean(value === true);
}

function lower(value) {
  return String(value || "").toLowerCase();
}

function matchedTerms(text, terms) {
  const source = lower(text);
  return terms.filter((term) => source.includes(lower(term)));
}

function termCount(text, terms) {
  const source = lower(text);
  return terms.reduce((acc, term) => {
    const needle = lower(term);
    let count = 0;
    let idx = source.indexOf(needle);
    while (idx !== -1) {
      count++;
      idx = source.indexOf(needle, idx + Math.max(needle.length, 1));
    }
    return acc + count;
  }, 0);
}

function unique(items) {
  return [...new Set((items || []).filter(Boolean))];
}

function stripComments(text) {
  return String(text || "")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1 ")
    .replace(/#.*$/gm, " ");
}

function walk(root, out = []) {
  if (out.length >= MAX_SOURCE_FILES || !exists(root)) return out;
  const stat = fs.statSync(root);
  if (stat.isFile()) {
    if (stat.size <= 2_000_000 && TEXT_EXTS.has(path.extname(root).toLowerCase()) && !EXCLUDED_PATH_RE.test(root)) out.push(root);
    return out;
  }
  if (!stat.isDirectory()) return out;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (out.length >= MAX_SOURCE_FILES) break;
    if (entry.isDirectory() && EXCLUDED_DIRS.has(entry.name)) continue;
    walk(path.join(root, entry.name), out);
  }
  return out;
}

function lineNumberAt(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
}

function snippet(text, line, radius = 2) {
  const lines = text.split(/\r?\n/);
  const start = Math.max(0, line - 1 - radius);
  const end = Math.min(lines.length, line + radius);
  return lines.slice(start, end).map((l, i) => `${start + i + 1}: ${l.trim()}`).join(" ").slice(0, 500);
}

function findBlockEnd(text, openBrace) {
  let depth = 0;
  for (let i = openBrace; i < text.length; i++) {
    const c = text[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return text.length;
}

function extractFunctions(text, ext) {
  const rows = [];
  if (ext === ".vy") {
    const re = /^\s*@external[\s\S]*?^\s*def\s+([A-Za-z0-9_]+)\s*\([^\n]*\):/gm;
    let match;
    while ((match = re.exec(text))) {
      const start = match.index;
      const next = text.slice(match.index + 1).search(/^\s*(?:@external|def\s+)/m);
      const end = next === -1 ? text.length : match.index + 1 + next;
      rows.push({ name: match[1], line: lineNumberAt(text, start), header: match[0], body: stripComments(text.slice(start, end)) });
    }
    return rows;
  }
  const re = /function\s+([A-Za-z0-9_]+)\s*\([^;{]*\)[^{;]*\{/g;
  let match;
  while ((match = re.exec(text))) {
    const open = text.indexOf("{", match.index);
    if (open === -1) continue;
    const end = findBlockEnd(text, open);
    rows.push({ name: match[1], line: lineNumberAt(text, match.index), header: text.slice(match.index, open + 1), body: stripComments(text.slice(match.index, end)) });
    re.lastIndex = end;
  }
  return rows;
}

function accessKind(header) {
  if (/\bexternal\b|@external/i.test(header)) return "external";
  if (/\bpublic\b/i.test(header)) return "public";
  if (/\binternal\b/i.test(header)) return "internal";
  if (/\bprivate\b/i.test(header)) return "private";
  return "unknown";
}

function classifySourceRow(target, base) {
  const publicSurface = ["external", "public"].includes(base.access);
  const roleGated = base.roleTerms.length > 0 || base.strongGuardTerms.length > 0;
  const hasAccounting = base.accountingTerms.length > 0;
  const hasValue = base.valueTerms.length > 0;
  const hasMigrationOrQueue = base.migrationTerms.length > 0 || base.queueTerms.length > 0;
  let confidence = "review";
  if (publicSurface && hasMigrationOrQueue && hasAccounting && hasValue && !roleGated) confidence = "high-static";
  else if (publicSurface && (hasMigrationOrQueue || base.rebalanceTerms.length > 0) && hasAccounting) confidence = "medium-static";
  else if (roleGated) confidence = "role-gated-context";

  const priorityScore = target.priority * 5
    + (confidence === "high-static" ? 40 : confidence === "medium-static" ? 24 : confidence === "role-gated-context" ? 8 : 5)
    + (publicSurface ? 8 : 0)
    + (hasValue ? 6 : 0)
    + (hasAccounting ? 6 : 0)
    - (roleGated ? 10 : 0);

  return {
    ...base,
    publicSurface,
    roleGated,
    confidence,
    priorityScore: round(priorityScore, 2),
    routePositive: false,
    signedActionJustified: false,
    blocker: roleGated
      ? "strategy migration/rebalance path is role-gated in source context"
      : "static source row needs deployed state, accepted-value consumer join, exact economics, and fork/local proof",
  };
}

function rowsFromSourceFile(target, filePath) {
  const text = safeRead(filePath);
  if (!text) return [];
  const ext = path.extname(filePath).toLowerCase();
  const funcs = extractFunctions(text, ext);
  const rows = [];
  for (const fn of funcs) {
    const combined = `${fn.header}\n${fn.body}`;
    const strategyTerms = matchedTerms(combined, STRATEGY_TERMS);
    const migrationTerms = matchedTerms(combined, MIGRATION_TERMS);
    const queueTerms = matchedTerms(combined, QUEUE_TERMS);
    const rebalanceTerms = matchedTerms(combined, REBALANCE_TERMS);
    const nameHit = /strategy|migrat|rebalance|harvest|tend|report|queue|withdraw|redeem/i.test(fn.name);
    if (!strategyTerms.length && !migrationTerms.length && !queueTerms.length && !rebalanceTerms.length && !nameHit) continue;
    rows.push(classifySourceRow(target, {
      target: target.name,
      chain: target.chain,
      file: rel(filePath),
      line: fn.line,
      function: fn.name,
      access: accessKind(fn.header),
      strategyTerms: strategyTerms.slice(0, 10),
      migrationTerms: migrationTerms.slice(0, 10),
      queueTerms: queueTerms.slice(0, 10),
      rebalanceTerms: rebalanceTerms.slice(0, 10),
      accountingTerms: matchedTerms(combined, ACCOUNTING_TERMS).slice(0, 12),
      valueTerms: matchedTerms(combined, VALUE_TERMS).slice(0, 10),
      roleTerms: matchedTerms(combined, ROLE_TERMS).slice(0, 10),
      strongGuardTerms: matchedTerms(combined, STRONG_GUARD_TERMS).slice(0, 10),
      snippet: snippet(text, fn.line, 2),
    }));
  }
  return rows;
}

function scanSourceTarget(target, seenFiles) {
  const dirsPresent = target.dirs.filter((dir) => exists(path.join(WORKSPACE, dir)));
  const files = [];
  for (const dir of target.dirs) walk(path.join(WORKSPACE, dir), files);
  const uniqueFiles = files.filter((file) => {
    const key = rel(file);
    if (seenFiles.has(key)) return false;
    seenFiles.add(key);
    return true;
  });
  const rows = uniqueFiles.flatMap((file) => rowsFromSourceFile(target, file));
  return {
    name: target.name,
    chain: target.chain,
    dirsExpected: target.dirs.length,
    dirsPresent: dirsPresent.map((dir) => dir.replace(/\\/g, "/")),
    filesScanned: uniqueFiles.length,
    sourceRows: rows.length,
    highStaticRows: rows.filter((row) => row.confidence === "high-static").length,
    mediumStaticRows: rows.filter((row) => row.confidence === "medium-static").length,
    roleGatedRows: rows.filter((row) => row.confidence === "role-gated-context").length,
    topRows: rows.sort((a, b) => b.priorityScore - a.priorityScore).slice(0, 40),
  };
}

function metric(obj, fields) {
  if (!obj || typeof obj !== "object") return 0;
  return fields.reduce((acc, field) => acc + (asNumber(obj[field]) || 0), 0);
}

function maxMetric(obj, fields) {
  if (!obj || typeof obj !== "object") return null;
  let best = null;
  for (const field of fields) {
    const n = asNumber(obj[field]);
    if (n === null) continue;
    best = best === null ? n : Math.max(best, n);
  }
  return best;
}

function artifactFiles() {
  if (!exists(RAW)) return [];
  return fs.readdirSync(RAW)
    .filter((file) => file.endsWith(".json"))
    .filter((file) => !EXCLUDED_ARTIFACT_FILES.has(file))
    .map((file) => path.join(RAW, file))
    .filter((file) => {
      try { return fs.statSync(file).size <= MAX_ARTIFACT_BYTES; } catch (_) { return false; }
    })
    .sort();
}

function artifactRow(file) {
  const text = safeRead(file);
  if (!ARTIFACT_HINT_RE.test(text) && !ARTIFACT_HINT_RE.test(path.basename(file))) return null;
  const json = readJson(file);
  if (!json || json.parseError) return null;
  const summary = json.summary && typeof json.summary === "object" ? json.summary : {};
  const strategyTermRows = termCount(text, STRATEGY_TERMS);
  const migrationTermRows = termCount(text, MIGRATION_TERMS);
  const queueTermRows = termCount(text, QUEUE_TERMS);
  const rebalanceTermRows = termCount(text, REBALANCE_TERMS);
  const accountingTermRows = termCount(text, ACCOUNTING_TERMS);
  const routePositive = metric(summary, ["routePositive", "localRoutePositiveRows", "researchPositiveRoutes", "positiveRoutes"])
    + (json.safety?.routePositive === true ? 1 : 0);
  const executableNow = metric(summary, ["executableNow", "executableRows"])
    + (json.safety?.executableNow === true ? 1 : 0);
  const exactEconomicsRows = metric(summary, ["exactEconomicsRows", "exactPositiveRows", "localRoutePositiveRows", "forkProofRows", "sameBlockMutationProofRows"]);
  const consumerJoinRows = metric(summary, ["consumerJoinRows", "directConsumerRows", "artifactJoinRows", "localArtifactMatchRows", "localArtifactRows", "matches", "consumerMatches", "currentConsumerMatches", "materialConsumerRows"]);
  const dexLiquidityRows = metric(summary, ["dexLiquidityRows", "materialDexLiquidityRows", "publicDexRows", "dexRows"]);
  const strategyRows = metric(summary, ["strategyProbeRows", "totalStrategyRows", "strategiesScanned", "wrappersWithStrategies", "strategyRows", "yieldBasisHarvestRows"])
    || Math.min(strategyTermRows, 200);
  const migrationRows = metric(summary, ["migrationRows", "publicRedeemRows", "claimableMigrationRows"]) || Math.min(migrationTermRows, 100);
  const withdrawalQueueRows = metric(summary, ["withdrawalQueueRows", "queueRows", "pendingWithdrawRows", "requestWithdrawPublicObserved"]) || Math.min(queueTermRows, 100);
  const rebalanceRows = metric(summary, ["rebalanceRows", "harvestRows", "yieldBasisHarvestRows"]) || Math.min(rebalanceTermRows, 100);
  const materialUsd = maxMetric(summary, [
    "strategyNetAssetValueUsd", "strategyLiquidationValueUsd", "totalStrategyUsd", "totalAssetsUsd", "defillamaCurrentTvlUsd",
    "mappedPoolAssetsUsd", "vaultLiquidAssetsUsd", "totalPoolTvlUsd", "maxDexLiquidityUsd", "topDexLiquidityUsd", "materialDexLiquidityUsd",
  ]);
  const strategyValueGapUsd = maxMetric(summary, ["strategyValueGapUsd", "navValueGapUsd", "acceptedValueGapUsd", "liquidationValueGapUsd"]);
  const watchCandidate = !routePositive && !executableNow && (
    exactEconomicsRows > 0
    || (Math.abs(strategyValueGapUsd || 0) >= MATERIAL_USD && (consumerJoinRows > 0 || dexLiquidityRows > 0))
  );
  const reviewRows = strategyRows + migrationRows + withdrawalQueueRows + rebalanceRows;
  if (reviewRows <= 0 && accountingTermRows <= 0) return null;
  return {
    artifact: rel(file),
    scanner: json.scanner || null,
    scope: json.scope || null,
    generatedAt: json.generatedAt || json.timestamp || null,
    strategyRows,
    migrationRows,
    withdrawalQueueRows,
    rebalanceRows,
    accountingTermRows: Math.min(accountingTermRows, 500),
    consumerJoinRows,
    dexLiquidityRows,
    exactEconomicsRows,
    materialUsd: round(materialUsd, 2),
    strategyValueGapUsd: round(strategyValueGapUsd, 2),
    watchCandidate: Boolean(watchCandidate),
    routePositive,
    executableNow,
    signedActionJustified: bool(summary.signedActionJustified || json.safety?.signedActionJustified),
    priorityScore: round(
      Math.min(30, reviewRows / 8)
      + Math.min(20, consumerJoinRows / 2)
      + Math.min(20, exactEconomicsRows * 10)
      + Math.min(15, Math.abs(strategyValueGapUsd || 0) / MATERIAL_USD * 5)
      + (routePositive ? 50 : 0),
      2,
    ),
    blocker: routePositive || executableNow
      ? "route-positive or executable input requires manual fork-gate review"
      : exactEconomicsRows > 0
        ? "exact-economics context exists but no route-positive/fork proof is emitted by the source artifact"
        : "strategy/migration/queue context lacks joined accepted-value consumer, exact positive economics, and fork/local proof",
  };
}

function buildMarkdown(out) {
  const lines = [];
  lines.push("# Strategy Migration Rebalance Triage");
  lines.push("");
  lines.push(`Generated: ${out.generatedAt}`);
  lines.push("");
  lines.push("Signal: No confirmed permissionless strategy migration/rebalance drain or route-positive extraction path.");
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Artifacts scanned: ${out.summary.artifactsScanned}`);
  lines.push(`- Strategy artifact rows: ${out.summary.strategyArtifactRows}`);
  lines.push(`- Source files scanned: ${out.summary.sourceFilesScanned}`);
  lines.push(`- Source rows: ${out.summary.sourceRows}`);
  lines.push(`- Migration rows: ${out.summary.migrationRows}`);
  lines.push(`- Withdrawal queue rows: ${out.summary.withdrawalQueueRows}`);
  lines.push(`- Rebalance rows: ${out.summary.rebalanceRows}`);
  lines.push(`- Consumer join rows: ${out.summary.consumerJoinRows}`);
  lines.push(`- Exact economics rows: ${out.summary.exactEconomicsRows}`);
  lines.push(`- Watch candidates: ${out.summary.watchCandidates}`);
  lines.push(`- Route-positive: ${out.summary.routePositive}`);
  lines.push(`- Executable now: ${out.summary.executableNow}`);
  lines.push("");
  lines.push("## Top Artifact Rows");
  lines.push("");
  lines.push("| Artifact | Strategy | Migration | Queue | Rebalance | Consumers | Exact | Material USD | Watch | Blocker |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---|");
  for (const row of out.topArtifactRows.slice(0, 20)) {
    lines.push(`| ${escapeCell(row.artifact)} | ${row.strategyRows} | ${row.migrationRows} | ${row.withdrawalQueueRows} | ${row.rebalanceRows} | ${row.consumerJoinRows} | ${row.exactEconomicsRows} | ${row.materialUsd ?? ""} | ${row.watchCandidate ? "yes" : "no"} | ${escapeCell(row.blocker)} |`);
  }
  lines.push("");
  lines.push("## Top Source Rows");
  lines.push("");
  if (!out.topSourceRows.length) {
    lines.push("No local target source row was available for this scanner pass; coverage is artifact-driven.");
  } else {
    lines.push("| Target | File | Function | Confidence | Access | Blocker |");
    lines.push("|---|---|---|---|---|---|");
    for (const row of out.topSourceRows.slice(0, 20)) {
      lines.push(`| ${escapeCell(row.target)} | ${escapeCell(row.file)}:${row.line} | ${escapeCell(row.function)} | ${row.confidence} | ${row.access} | ${escapeCell(row.blocker)} |`);
    }
  }
  lines.push("");
  lines.push("## Gate");
  lines.push("");
  lines.push(out.summary.blocker);
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function escapeCell(value) {
  return String(value === null || value === undefined ? "" : value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function main() {
  fs.mkdirSync(RAW, { recursive: true });
  const seenFiles = new Set();
  const sourceRows = SOURCE_TARGETS.map((target) => scanSourceTarget(target, seenFiles));
  const flatSourceRows = sourceRows.flatMap((row) => row.topRows).sort((a, b) => b.priorityScore - a.priorityScore);
  const artifactsScanned = artifactFiles();
  const artifactRows = artifactsScanned.map(artifactRow).filter(Boolean).sort((a, b) => b.priorityScore - a.priorityScore);

  const sourceFilesScanned = sourceRows.reduce((acc, row) => acc + row.filesScanned, 0);
  const totalSourceRows = sourceRows.reduce((acc, row) => acc + row.sourceRows, 0);
  const routePositive = artifactRows.reduce((acc, row) => acc + (asNumber(row.routePositive) || 0), 0);
  const executableNow = artifactRows.reduce((acc, row) => acc + (asNumber(row.executableNow) || 0), 0);
  const signedActionJustified = artifactRows.some((row) => row.signedActionJustified);
  const exactEconomicsRows = artifactRows.reduce((acc, row) => acc + (asNumber(row.exactEconomicsRows) || 0), 0);
  const consumerJoinRows = artifactRows.reduce((acc, row) => acc + (asNumber(row.consumerJoinRows) || 0), 0);
  const watchCandidates = artifactRows.filter((row) => row.watchCandidate).length;
  const out = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-strategy-migration-rebalance.js",
    scope: "Read-only strategy migration, rebalance, withdrawal-queue, and vault accounting drift surface scanner",
    safety: {
      rpcInventoryRead: false,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: routePositive > 0,
      executableNow: executableNow > 0,
      signedActionJustified,
    },
    thresholds: {
      materialUsd: MATERIAL_USD,
      maxSourceFiles: MAX_SOURCE_FILES,
      maxArtifactBytes: MAX_ARTIFACT_BYTES,
    },
    summary: {
      artifactsScanned: artifactsScanned.length,
      strategyArtifactRows: artifactRows.length,
      sourceTargetsScanned: sourceRows.length,
      sourceFilesScanned,
      sourceRows: totalSourceRows,
      sourceDirsPresent: sourceRows.reduce((acc, row) => acc + row.dirsPresent.length, 0),
      highStaticRows: sourceRows.reduce((acc, row) => acc + row.highStaticRows, 0),
      mediumStaticRows: sourceRows.reduce((acc, row) => acc + row.mediumStaticRows, 0),
      roleGatedRows: sourceRows.reduce((acc, row) => acc + row.roleGatedRows, 0),
      strategyRows: artifactRows.reduce((acc, row) => acc + (asNumber(row.strategyRows) || 0), 0),
      migrationRows: artifactRows.reduce((acc, row) => acc + (asNumber(row.migrationRows) || 0), 0),
      withdrawalQueueRows: artifactRows.reduce((acc, row) => acc + (asNumber(row.withdrawalQueueRows) || 0), 0),
      rebalanceRows: artifactRows.reduce((acc, row) => acc + (asNumber(row.rebalanceRows) || 0), 0),
      consumerJoinRows,
      dexLiquidityRows: artifactRows.reduce((acc, row) => acc + (asNumber(row.dexLiquidityRows) || 0), 0),
      exactEconomicsRows,
      watchCandidates,
      routePositive,
      executableNow,
      signedActionJustified,
      blocker: routePositive > 0 || executableNow > 0
        ? "At least one strategy migration/rebalance input requires route-specific fork-gate review before any signed action."
        : "No strategy migration, rebalance, or withdrawal-queue row proves a permissionless same-block accounting drift with joined accepted-value consumer, exact positive economics, and fork/local extraction proof.",
    },
    sourceRows,
    artifactRows,
    topSourceRows: flatSourceRows.slice(0, 40),
    topArtifactRows: artifactRows.slice(0, 40),
    topRows: artifactRows.slice(0, 20).map((row) => ({
      protocol: "strategy-migration-rebalance",
      chain: "multi-chain",
      source: row.artifact,
      symbol: path.basename(row.artifact, ".json"),
      strategyRows: row.strategyRows,
      migrationRows: row.migrationRows,
      withdrawalQueueRows: row.withdrawalQueueRows,
      rebalanceRows: row.rebalanceRows,
      consumerJoinRows: row.consumerJoinRows,
      exactEconomicsRows: row.exactEconomicsRows,
      liquidityUsd: row.materialUsd,
      routePositive: row.routePositive > 0,
      blocker: row.blocker,
    })),
    blockers: [
      "Artifact rows are context until mapped to deployed value-moving entrypoints and exact economics.",
      "Role-gated strategy migration, rebalance, report, and queue controls are not permissionless drain paths.",
      "Withdrawal queue, cooldown, NAV, and liquidation-value context needs same-block acquisition/redeem/borrow/exit proof before fork work.",
      "No fork/local extraction proof is present.",
    ],
    requiredForRoutePositive: [
      "specific deployed vault/strategy migration, rebalance, report, or withdrawal-queue path is permissionless or attacker-reachable without role compromise",
      "path changes share price, NAV, queue claim, withdrawal value, reward value, or accepted collateral value in attacker-favorable direction",
      "affected share/token is accepted by a material consumer or has permissionless redeem/DEX exit liquidity",
      "acquisition/action/redeem/borrow/liquidation/unwind economics are exact-quoted positive after gas, slippage, fees, queues, and timing",
      "fork/local proof demonstrates net value extraction",
    ],
  };

  fs.writeFileSync(OUT_JSON, `${JSON.stringify(out, null, 2)}\n`);
  fs.writeFileSync(OUT_MD, buildMarkdown(out));
  if (!QUIET) {
    console.log(`Strategy migration scanner: artifacts=${out.summary.strategyArtifactRows} sourceRows=${out.summary.sourceRows} watch=${out.summary.watchCandidates} routePositive=${out.summary.routePositive}`);
    console.log(`Artifact: ${rel(OUT_JSON)}`);
  }
}

main();
