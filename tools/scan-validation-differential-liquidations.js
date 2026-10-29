#!/usr/bin/env node
// scan-validation-differential-liquidations.js - find Kamino-style reduced validation liquidation patterns.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT_JSON = path.join(WORKSPACE, "reports", "raw", "fast", "validation-differential-liquidations.json");
const OUT_MD = path.join(WORKSPACE, "reports", "validation-differential-liquidations-triage.md");
const KAMINO_MONITOR = path.join(WORKSPACE, "targets", "kamino-klend", "monitor-liquidation-window.js");

const TARGETS = [
  { name: "Kamino Klend", dirs: ["targets/kamino-klend"], chain: "Solana", priority: 10 },
  { name: "Kamino Kvault", dirs: ["targets/kamino-kvault"], chain: "Solana", priority: 8 },
  { name: "Drift Protocol", dirs: ["targets/drift-protocol-v2"], chain: "Solana", priority: 7 },
  { name: "Jupiter Lend", dirs: ["targets/jupiter-lend"], chain: "Solana", priority: 6 },
  { name: "Save/Solend", dirs: ["targets/save-public", "targets/save-solana-program-library"], chain: "Solana", priority: 6 },
  { name: "Suilend", dirs: ["targets/suilend"], chain: "Sui", priority: 6 },
  { name: "Scallop", dirs: ["targets/scallop-sui-lending-protocol"], chain: "Sui", priority: 5 },
  { name: "Aave V4", dirs: ["targets/aave-v3-origin", "targets/aave-governance-v3"], chain: "Ethereum", priority: 4 },
  { name: "HyperLend", dirs: ["targets/hyperlend-core", "targets/hyperlend-isolated"], chain: "HyperEVM", priority: 4 },
];

const EXCLUDED_DIRS = new Set([".git", "node_modules", "target", "build", "dist", "cache", "out", "artifacts", "coverage", ".next"]);
const TEXT_EXTS = new Set([".rs", ".move", ".sol", ".ts", ".tsx", ".js", ".jsx", ".go", ".md"]);
const STRONG_TERMS = ["LIQUIDATION_CHECKS", "ALL_CHECKS", "PriceStatusFlags", "PRICE_USAGE_ALLOWED", "HEURISTIC_CHECKED", "TWAP_CHECKED"];
const LIQUIDATION_TERMS = ["liquidation", "liquidate", "liquidatable"];
const VALIDATION_TERMS = ["twap", "heuristic", "stale", "price_status", "status", "fresh", "validate", "checks", "oracle"];

function rel(filePath) {
  return path.relative(WORKSPACE, filePath).replace(/\\/g, "/");
}

function sanitize(text) {
  return String(text || "")
    .replace(/https?:\/\/[^\s'"<>]+/g, "[redacted-url]")
    .replace(/(PRIVATE_KEY=)0x[0-9a-fA-F]{64}/g, "$1[redacted]");
}

function walkFiles(root, out = []) {
  if (!fs.existsSync(root)) return out;
  const stat = fs.statSync(root);
  if (stat.isFile()) {
    if (stat.size <= 2_000_000 && TEXT_EXTS.has(path.extname(root).toLowerCase())) out.push(root);
    return out;
  }
  if (!stat.isDirectory()) return out;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && EXCLUDED_DIRS.has(entry.name)) continue;
    walkFiles(path.join(root, entry.name), out);
  }
  return out;
}

function readText(filePath) {
  try { return fs.readFileSync(filePath, "utf8"); } catch (_) { return ""; }
}

function lineHits(text, terms) {
  const hits = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lower = line.toLowerCase();
    const matched = terms.filter((term) => lower.includes(term.toLowerCase()));
    if (!matched.length) continue;
    hits.push({ line: i + 1, matchedTerms: matched, snippet: line.trim().slice(0, 220) });
  }
  return hits;
}

function scanTarget(target) {
  const files = [];
  for (const dir of target.dirs) walkFiles(path.join(WORKSPACE, dir), files);
  const candidates = [];
  for (const filePath of files) {
    const text = readText(filePath);
    if (!text) continue;
    const lower = text.toLowerCase();
    const strongCount = STRONG_TERMS.filter((term) => lower.includes(term.toLowerCase())).length;
    const hasLiquidation = LIQUIDATION_TERMS.some((term) => lower.includes(term));
    const validationCount = VALIDATION_TERMS.filter((term) => lower.includes(term)).length;
    const hasAllAndLiquidationChecks = lower.includes("all_checks") && lower.includes("liquidation_checks");
    const hasDifferentialHint = hasAllAndLiquidationChecks || (hasLiquidation && validationCount >= 3) || (strongCount >= 2 && hasLiquidation);
    if (!hasDifferentialHint) continue;
    const hits = [
      ...lineHits(text, STRONG_TERMS),
      ...lineHits(text, LIQUIDATION_TERMS),
      ...lineHits(text, VALIDATION_TERMS),
    ].slice(0, 18);
    candidates.push({
      file: rel(filePath),
      confidence: hasAllAndLiquidationChecks || strongCount >= 3 ? "high" : "medium",
      strongCount,
      validationCount,
      hasAllAndLiquidationChecks,
      hits,
    });
  }
  candidates.sort((a, b) => (b.confidence === "high") - (a.confidence === "high") || b.strongCount - a.strongCount || b.validationCount - a.validationCount);
  return {
    name: target.name,
    chain: target.chain,
    dirs: target.dirs,
    filesScanned: files.length,
    candidateFiles: candidates.length,
    highConfidenceFiles: candidates.filter((row) => row.confidence === "high").length,
    topCandidates: candidates.slice(0, 12),
  };
}

function intAfter(output, label) {
  const match = output.match(new RegExp(`${label}=(-?\\d+)`, "i"));
  return match ? Number(match[1]) : 0;
}

function parseKamino(output, ok) {
  const liveLine = output.split(/\r?\n/).find((line) => /LIVE_WINDOW:/i.test(line)) || "LIVE_WINDOW: unknown";
  const candidateMatch = liveLine.match(/LIVE_WINDOW:\s*(\d+)/i);
  return {
    ok,
    liveWindowLine: liveLine.trim(),
    liveWindowCandidates: /LIVE_WINDOW:\s*none/i.test(liveLine) ? 0 : candidateMatch ? Number(candidateMatch[1]) : 0,
    slot: intAfter(output, "slot"),
    reserves: intAfter(output, "reserves"),
    obligations: intAfter(output, "obligations"),
    debtRows: intAfter(output, "debt_rows"),
    sameSlotReducedReserves: intAfter(output, "same_slot_reduced_reserves"),
    staleReducedDebtRows: intAfter(output, "stale_reduced_debt_rows"),
    sameSlotReducedDebtRows: intAfter(output, "same_slot_reduced_debt_rows"),
    sameSlotLiquidatableRows: intAfter(output, "same_slot_liquidatable_rows"),
  };
}

function runKaminoMonitor() {
  if (!fs.existsSync(KAMINO_MONITOR)) return { ok: false, error: "missing monitor", parsed: null, output: "" };
  const result = spawnSync(process.execPath, [KAMINO_MONITOR, "--once"], {
    cwd: WORKSPACE,
    env: { ...process.env, FORCE_COLOR: "0" },
    encoding: "utf8",
    timeout: 180_000,
  });
  const output = sanitize(`${result.stdout || ""}\n${result.stderr || ""}`);
  return {
    ok: result.status === 0 && !result.error,
    status: result.status,
    error: result.error ? sanitize(result.error.message) : null,
    parsed: parseKamino(output, result.status === 0 && !result.error),
    output: output.split(/\r?\n/).filter(Boolean).slice(-14),
  };
}

function table(rows, headers) {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${headers.map((h) => row[h] ?? "").join(" | ")} |`),
  ].join("\n");
}

function main() {
  const sourceRows = TARGETS.map(scanTarget);
  const kamino = runKaminoMonitor();
  const highConfidenceFiles = sourceRows.reduce((acc, row) => acc + row.highConfidenceFiles, 0);
  const candidateFiles = sourceRows.reduce((acc, row) => acc + row.candidateFiles, 0);
  const liveWindowCandidates = kamino.parsed?.liveWindowCandidates || 0;
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-validation-differential-liquidations.js",
    scope: "Kamino-style validation-differential liquidation source/live scan",
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      signedActions: false,
      exploitExecuteCalls: false,
      routePositive: false,
      signedActionJustified: false,
    },
    summary: {
      targetsScanned: sourceRows.length,
      filesScanned: sourceRows.reduce((acc, row) => acc + row.filesScanned, 0),
      candidateFiles,
      highConfidenceFiles,
      liveWindowCandidates,
      kaminoStaleReducedDebtRows: kamino.parsed?.staleReducedDebtRows || 0,
      kaminoSameSlotReducedDebtRows: kamino.parsed?.sameSlotReducedDebtRows || 0,
      kaminoSameSlotLiquidatableRows: kamino.parsed?.sameSlotLiquidatableRows || 0,
      routePositive: 0,
      executableNow: 0,
      signedActionJustified: false,
      blocker: liveWindowCandidates > 0
        ? "Live window requires exact route modeling and local/fork proof before any signed action."
        : "No same-slot reduced-status liquidatable row; current Kamino monitor reports LIVE_WINDOW: none.",
    },
    kaminoLiveWindow: kamino.parsed,
    sourceRows,
    requiredForRoutePositive: [
      "reduced liquidation gate excludes configured full-check oracle safety",
      "live same-slot reduced-status liquidatable obligation exists",
      "repay token acquisition and collateral exit are exactly quoted positive",
      "local/fork proof succeeds before any signed action",
    ],
  };
  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, `${JSON.stringify(artifact, null, 2)}\n`);

  const topRows = sourceRows
    .filter((row) => row.candidateFiles > 0)
    .map((row) => ({ Target: row.name, Chain: row.chain, Files: String(row.filesScanned), Candidates: String(row.candidateFiles), High: String(row.highConfidenceFiles), Verdict: row.highConfidenceFiles ? "Review source differential" : "Heuristic hits only" }));
  const md = [
    "# 🟢 DORMANT — Validation-Differential Liquidation Scan",
    "",
    `Date: ${new Date().toISOString().slice(0, 10)}`,
    "",
    "## Result",
    "",
    `Kamino-style reduced validation remains a reusable pattern, but the current live Kamino monitor reports \`${kamino.parsed?.liveWindowLine || "unknown"}\`. Route gate remains closed.`,
    "",
    "## Live Window",
    "",
    table([
      {
        Monitor: "Kamino Main Market",
        Slot: String(kamino.parsed?.slot || 0),
        Reserves: String(kamino.parsed?.reserves || 0),
        Obligations: String(kamino.parsed?.obligations || 0),
        "Debt Rows": String(kamino.parsed?.debtRows || 0),
        "Stale Reduced": String(kamino.parsed?.staleReducedDebtRows || 0),
        "Same-Slot Reduced": String(kamino.parsed?.sameSlotReducedDebtRows || 0),
        "Same-Slot Liquidatable": String(kamino.parsed?.sameSlotLiquidatableRows || 0),
      },
    ], ["Monitor", "Slot", "Reserves", "Obligations", "Debt Rows", "Stale Reduced", "Same-Slot Reduced", "Same-Slot Liquidatable"]),
    "",
    "## Source Sweep",
    "",
    topRows.length ? table(topRows, ["Target", "Chain", "Files", "Candidates", "High", "Verdict"]) : "No source candidates found.",
    "",
    "## Gate",
    "",
    "No fork, signed action, or liquidation test is justified until a same-slot reduced-status liquidatable row appears and exact repay/collateral-exit economics are positive.",
    "",
    "## Artifacts",
    "",
    "- JSON: `reports/raw/fast/validation-differential-liquidations.json`",
    "- Scanner: `tools/scan-validation-differential-liquidations.js`",
    "- Live monitor: `targets/kamino-klend/monitor-liquidation-window.js`",
    "",
  ].join("\n");
  fs.writeFileSync(OUT_MD, md);

  console.log(`Validation-differential scan: candidates=${candidateFiles}; high=${highConfidenceFiles}; liveWindow=${liveWindowCandidates}; routePositive=0`);
}

main();
