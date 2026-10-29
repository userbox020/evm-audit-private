#!/usr/bin/env node
// scan-gas-accounting-tip-race.js - static EIP-150 bounded-call failure/tip race scan.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT_JSON = path.join(WORKSPACE, "reports", "raw", "fast", "gas-accounting-tip-race.json");
const OUT_MD = path.join(WORKSPACE, "reports", "gas-accounting-tip-race-triage.md");

const TARGETS = [
  { name: "Synapse Sanguine Core", chain: "Optimism/dormant mainnet", priority: 10, dirs: ["targets/synapse-sanguine/packages/contracts-core/contracts"] },
  { name: "Hyperlane", chain: "multi-chain", priority: 7, dirs: ["targets/hyperlane-monorepo/solidity/contracts"] },
  { name: "LayerZero V2", chain: "multi-chain", priority: 7, dirs: ["targets/layerzero-v2/packages/layerzero-v2/evm/protocol/contracts", "targets/layerzero-v2/packages/layerzero-v2/evm/oapp/contracts"] },
  { name: "Stargate V2", chain: "multi-chain", priority: 6, dirs: ["targets/stargate-v2/packages/stg-evm-v2/src"] },
  { name: "deBridge DLN", chain: "multi-chain", priority: 6, dirs: ["targets/dln-contracts/contracts"] },
  { name: "Across", chain: "multi-chain", priority: 5, dirs: ["targets/across-contracts/contracts", "targets/across-contracts-v2/contracts"] },
];

const TEXT_EXTS = new Set([".sol"]);
const EXCLUDED_DIRS = new Set([".git", "node_modules", "target", "build", "dist", "out", "cache", "artifacts", "coverage", "lib", "vendor"]);
const EXCLUDED_PATH_RE = /[\\/](test|tests|mock|mocks|script|scripts|examples?|interfaces)[\\/]/i;

const GAS_CHECK_TERMS = ["gasleft()", "gasLimit", "gasleft", "suppliedGas"];
const BOUNDED_CALL_TERMS = ["call{gas", "call(gasLimit", "safeCall", "excessivelySafeCall", "functionCallWithValue"];
const HEADROOM_TERMS = ["64 / 63", "64/63", "63 / 64", "63/64", "EIP-150", "eip150", "POST_CALL_BUFFER", "gasLimit * 64", "gasLimit.mul(64)", "gasleft() - gasleft() / 64"];
const FAILURE_TERMS = ["Failed", "failed", "firstExecutor", "_firstExecutor", "AlreadyFailed", "MessageStatus.Failed", "success =", "!success", "receipt"];
const TIP_TERMS = ["tip", "tips", "fee", "reward", "executor", "relayer", "firstExecutor", "awardTips"];

function rel(filePath) {
  return path.relative(WORKSPACE, filePath).replace(/\\/g, "/");
}

function exists(filePath) {
  try { return fs.existsSync(filePath); } catch (_) { return false; }
}

function readText(filePath) {
  try { return fs.readFileSync(filePath, "utf8"); } catch (_) { return ""; }
}

function walk(root, out = []) {
  if (!exists(root)) return out;
  const stat = fs.statSync(root);
  if (stat.isFile()) {
    if (stat.size <= 2_000_000 && TEXT_EXTS.has(path.extname(root).toLowerCase()) && !EXCLUDED_PATH_RE.test(root)) out.push(root);
    return out;
  }
  if (!stat.isDirectory()) return out;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && EXCLUDED_DIRS.has(entry.name)) continue;
    walk(path.join(root, entry.name), out);
  }
  return out;
}

function matchedTerms(text, terms) {
  const lower = String(text || "").toLowerCase();
  return terms.filter((term) => lower.includes(term.toLowerCase()));
}

function firstLine(text, terms) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (matchedTerms(lines[i], terms).length) return i + 1;
  }
  return 1;
}

function firstRegexLine(text, regexes) {
  const lines = text.split(/\r?\n/);
  for (const re of regexes) {
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) return i + 1;
    }
  }
  return firstLine(text, [...GAS_CHECK_TERMS, ...BOUNDED_CALL_TERMS, ...FAILURE_TERMS]);
}

function snippet(text, line, radius = 3) {
  const lines = text.split(/\r?\n/);
  const start = Math.max(0, line - 1 - radius);
  const end = Math.min(lines.length, line + radius);
  return lines.slice(start, end).map((l, i) => `${start + i + 1}: ${l.trim()}`).join(" ").slice(0, 600);
}

function classify(target, filePath, text) {
  const gasCheckTerms = matchedTerms(text, GAS_CHECK_TERMS);
  const boundedCallTerms = matchedTerms(text, BOUNDED_CALL_TERMS);
  const headroomTerms = matchedTerms(text, HEADROOM_TERMS);
  const failureTerms = matchedTerms(text, FAILURE_TERMS);
  const tipTerms = matchedTerms(text, TIP_TERMS);
  const hasWeakGasCheck = gasCheckTerms.length > 0 && headroomTerms.length === 0;
  const hasBoundedCall = boundedCallTerms.length > 0;
  const hasFailureRecording = failureTerms.some((term) => /firstExecutor|Failed|failed|AlreadyFailed|MessageStatus|receipt/i.test(term));
  const hasTipAttribution = tipTerms.some((term) => /tip|fee|reward|executor|relayer/i.test(term));

  let confidence = "context-only";
  if (hasWeakGasCheck && hasBoundedCall && hasFailureRecording && hasTipAttribution) confidence = "high-static";
  else if (hasWeakGasCheck && hasBoundedCall && hasFailureRecording) confidence = "medium-static";
  else if (headroomTerms.length > 0 && hasBoundedCall) confidence = "headroom-protected";
  else if (hasBoundedCall || gasCheckTerms.length > 0) confidence = "low-static";

  const score = target.priority * 5
    + (confidence === "high-static" ? 45 : confidence === "medium-static" ? 24 : confidence === "headroom-protected" ? 8 : 4)
    + (hasBoundedCall ? 8 : 0)
    + (hasTipAttribution ? 8 : 0)
    - (headroomTerms.length ? 18 : 0);
  const blocker = confidence === "high-static"
    ? "weak gasleft gate plus bounded call and first-failure/tip accounting; current impact is tip/liveness unless positive principal route is proven"
    : confidence === "headroom-protected"
      ? "bounded call has EIP-150 headroom guard"
      : "no complete weak-gas/failure-tip race shape in this file";
  const line = firstRegexLine(text, [/gasleft\s*\(\s*\)/i, /safeCall\s*\(/i, /\.call\s*\{\s*gas/i, /call\s*\(\s*gasLimit/i, /\bgasLimit\b/i]);
  return {
    target: target.name,
    chain: target.chain,
    file: rel(filePath),
    line,
    confidence,
    priorityScore: Math.round(score * 100) / 100,
    gasCheckTerms,
    boundedCallTerms,
    headroomTerms,
    failureTerms: failureTerms.slice(0, 10),
    tipTerms: tipTerms.slice(0, 10),
    hasWeakGasCheck,
    hasBoundedCall,
    hasFailureRecording,
    hasTipAttribution,
    routePositive: false,
    signedActionJustified: false,
    blocker,
    snippet: snippet(text, line, 3),
  };
}

function scanTarget(target) {
  const files = [];
  for (const dir of target.dirs) walk(path.join(WORKSPACE, dir), files);
  const rows = [];
  for (const filePath of files) {
    const text = readText(filePath);
    if (!text) continue;
    const relevant = /gasleft\s*\(/i.test(text)
      || matchedTerms(text, BOUNDED_CALL_TERMS).length
      || (matchedTerms(text, FAILURE_TERMS).length && matchedTerms(text, TIP_TERMS).length);
    if (!relevant) continue;
    rows.push(classify(target, filePath, text));
  }
  rows.sort((a, b) => b.priorityScore - a.priorityScore);
  return {
    name: target.name,
    chain: target.chain,
    dirs: target.dirs,
    filesScanned: files.length,
    gasRelevantRows: rows.length,
    highStaticRows: rows.filter((row) => row.confidence === "high-static").length,
    mediumStaticRows: rows.filter((row) => row.confidence === "medium-static").length,
    headroomProtectedRows: rows.filter((row) => row.confidence === "headroom-protected").length,
    topRows: rows.slice(0, 14),
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
  const rankedRows = sourceRows.flatMap((row) => row.topRows).sort((a, b) => b.priorityScore - a.priorityScore);
  const highStaticRows = rankedRows.filter((row) => row.confidence === "high-static");
  const mediumStaticRows = rankedRows.filter((row) => row.confidence === "medium-static");
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-gas-accounting-tip-race.js",
    scope: "Synapse-style EIP-150 gas under-supply / first-failure tip race variant scan",
    safety: {
      rpcInventoryRead: false,
      rpcUrlsStored: false,
      signedActions: false,
      exploitExecuteCalls: false,
      routePositive: false,
      signedActionJustified: false,
    },
    summary: {
      targetsScanned: sourceRows.length,
      filesScanned: sourceRows.reduce((acc, row) => acc + row.filesScanned, 0),
      gasRelevantRows: sourceRows.reduce((acc, row) => acc + row.gasRelevantRows, 0),
      highStaticRows: highStaticRows.length,
      mediumStaticRows: mediumStaticRows.length,
      headroomProtectedRows: sourceRows.reduce((acc, row) => acc + row.headroomProtectedRows, 0),
      routePositive: 0,
      executableNow: 0,
      signedActionJustified: false,
      blocker: highStaticRows.length
        ? "High-static gas/tip rows are tip/liveness scoped and need live message-flow plus positive value proof before fork gate."
        : "No complete weak-gas/failure-tip race shape found outside protected/context rows.",
    },
    sourceRows,
    rankedRows: rankedRows.slice(0, 80),
    requiredForRoutePositive: [
      "executor path is live/mainnet and permissionless",
      "EIP-150 under-supply can force a recorded failure before successful execution",
      "first-failure attribution captures material fees/tips or asset movement",
      "controlled/fork proof shows positive net value after gas",
    ],
  };

  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, `${JSON.stringify(artifact, null, 2)}\n`);

  const top = rankedRows.slice(0, 12).map((row) => ({
    Target: row.target,
    File: `${row.file}:${row.line}`,
    Confidence: row.confidence,
    Gas: row.hasWeakGasCheck ? "weak" : row.headroomTerms.length ? "headroom" : "context",
    Call: row.hasBoundedCall ? "bounded" : "none",
    Verdict: row.blocker,
  }));
  const highStaticWord = artifact.summary.highStaticRows === 1 ? "row" : "rows";
  const mediumStaticWord = artifact.summary.mediumStaticRows === 1 ? "row" : "rows";
  const md = [
    "# 🟢 DORMANT — Gas-Accounting Tip-Race Variant Scan",
    "",
    `Date: ${new Date().toISOString().slice(0, 10)}`,
    "",
    "## Result",
    "",
    `Scanned ${artifact.summary.filesScanned} source files across ${artifact.summary.targetsScanned} targets for Synapse-style EIP-150 gas under-supply, bounded call failure recording, and tip/executor attribution. Route gate remains closed: \`routePositive=0\`, \`executableNow=0\`, \`signedActionJustified=false\`.`,
    "",
    `The scan found ${artifact.summary.highStaticRows} high-static ${highStaticWord} and ${artifact.summary.mediumStaticRows} medium-static ${mediumStaticWord}. High-static rows are tip/liveness scoped until a live message flow and positive value route are proven.`,
    "",
    "## Top Rows",
    "",
    table(top, ["Target", "File", "Confidence", "Gas", "Call", "Verdict"]),
    "",
    "## Gate",
    "",
    "No fork, signed action, executor change, or exploit call is justified until a permissionless executor path proves gas-race capture of material value with positive net economics.",
    "",
    "## Artifacts",
    "",
    "- JSON: `reports/raw/fast/gas-accounting-tip-race.json`",
    "- Scanner: `tools/scan-gas-accounting-tip-race.js`",
    "- Seed report: `reports/synapse-hypercall-triage.md`",
  ].join("\n");
  fs.writeFileSync(OUT_MD, `${md}\n`);

  console.log(`Gas accounting tip race: targets=${artifact.summary.targetsScanned}; files=${artifact.summary.filesScanned}; highStatic=${artifact.summary.highStaticRows}; routePositive=0`);
}

main();
