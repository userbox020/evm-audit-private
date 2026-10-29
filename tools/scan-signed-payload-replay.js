#!/usr/bin/env node
// scan-signed-payload-replay.js - static signed-write nonce/domain/action replay variant scan.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT_JSON = path.join(WORKSPACE, "reports", "raw", "fast", "signed-payload-replay.json");
const OUT_MD = path.join(WORKSPACE, "reports", "signed-payload-replay-triage.md");

const TARGETS = [
  { name: "Polymarket CTF Exchange V2", chain: "Polygon", priority: 9, dirs: ["targets/polymarket-ctf-exchange-v2/src/exchange", "targets/polymarket-ctf-exchange-v2/src/collateral"] },
  { name: "CoW Protocol GPv2", chain: "Ethereum/multi-chain", priority: 8, dirs: ["targets/cow-protocol-contracts/src/contracts"] },
  { name: "deBridge DLN", chain: "multi-chain", priority: 7, dirs: ["targets/dln-contracts/contracts"] },
  { name: "Synapse RFQ/Core", chain: "multi-chain", priority: 7, dirs: ["targets/synapse-sanguine/packages/contracts-rfq/contracts", "targets/synapse-sanguine/packages/contracts-core/contracts", "targets/synapse-contracts/contracts"] },
  { name: "NEAR Intents", chain: "NEAR", priority: 6, dirs: ["targets/near-intents/contracts", "targets/near-intents/crates"] },
];

const REPORT_SEEDS = [
  { name: "Hypercall", chain: "testnet/prelaunch", file: "reports/synapse-hypercall-triage.md", priority: 10 },
];

const TEXT_EXTS = new Set([".sol", ".ts", ".js", ".rs", ".go"]);
const EXCLUDED_DIRS = new Set([".git", "node_modules", "target", "build", "dist", "out", "cache", "artifacts", "coverage", "lib", "vendor"]);
const EXCLUDED_PATH_RE = /[\\/](test|tests|mock|mocks|script|scripts|external|examples?)[\\/]/i;

const STRONG_SIGNATURE_TERMS = ["ecrecover", "ECDSA", "SignatureChecker", "isValidSignature", "_hashTypedData", "hashTypedData", "EIP712", "DOMAIN_SEPARATOR", "domainSeparator", "permit(", "verify_signature", "ed25519_verify", "secp256k1"];
const WEAK_SIGNATURE_TERMS = ["signature", "signed", "signer", "recover", "permit", "authorized", "agent"];
const DOMAIN_TERMS = ["DOMAIN_SEPARATOR", "domainSeparator", "EIP712", "chainId", "block.chainid", "verifyingContract", "address(this)", "_domainNameAndVersion", "domain_separator"];
const NONCE_TERMS = ["nonce", "nonces", "salt", "deadline", "validTo", "expiry", "expiration", "timestamp", "rfq_id", "client_id"];
const CONSUMPTION_TERMS = ["usedNonce", "usedNonces", "consumeNonce", "nonces[", "nonces.", "orderStatus", "filled", "remaining", "preSignature", "cancelled", "canceled", "executed", "filledAmount", "spent", "claimed", "revoked"];
const ACTION_TERMS = ["TYPEHASH", "typehash", "messageType", "action", "operation", "Order", "Permit", "Approve", "Cancel", "Set", "RFQ", "Bridge", "request", "settlement"];
const VALUE_TERMS = ["amount", "token", "asset", "order", "maker", "taker", "owner", "wallet", "agent", "position", "margin", "recipient", "receiver"];

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

function stripComments(text) {
  return String(text || "")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1 ");
}

function matchedTerms(text, terms) {
  const lower = String(text || "").toLowerCase();
  return terms.filter((term) => lower.includes(term.toLowerCase()));
}

function lineNumberAt(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
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

function extractSolFunctions(text) {
  const rows = [];
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

function snippet(text, line, radius = 2) {
  const lines = text.split(/\r?\n/);
  const start = Math.max(0, line - 1 - radius);
  const end = Math.min(lines.length, line + radius);
  return lines.slice(start, end).map((l, i) => `${start + i + 1}: ${l.trim()}`).join(" ").slice(0, 500);
}

function accessKind(header) {
  if (/\bexternal\b/i.test(header)) return "external";
  if (/\bpublic\b/i.test(header)) return "public";
  if (/\binternal\b/i.test(header)) return "internal";
  if (/\bprivate\b/i.test(header)) return "private";
  return "unknown";
}

function isWriteSurface(header, body) {
  return /\b(external|public)\b/i.test(header)
    && /signature|permit|signer|signed|preSignature|approve|cancel|order|settle|execute|fulfill|claim/i.test(`${header}\n${body}`);
}

function targetFeatures(files) {
  const sample = files.map(readText).join("\n").slice(0, 10_000_000);
  return {
    hasDomainScope: matchedTerms(sample, DOMAIN_TERMS).length > 0,
    hasNonceLike: matchedTerms(sample, NONCE_TERMS).length > 0,
    hasConsumptionState: matchedTerms(sample, CONSUMPTION_TERMS).length > 0,
    hasActionScope: matchedTerms(sample, ACTION_TERMS).length > 0,
    domainTerms: matchedTerms(sample, DOMAIN_TERMS).slice(0, 10),
    nonceTerms: matchedTerms(sample, NONCE_TERMS).slice(0, 10),
    consumptionTerms: matchedTerms(sample, CONSUMPTION_TERMS).slice(0, 10),
    actionTerms: matchedTerms(sample, ACTION_TERMS).slice(0, 10),
  };
}

function classifyRow(target, base, targetScope) {
  const hasDomainScope = base.domainTerms.length > 0 || targetScope.hasDomainScope;
  const hasNonceLike = base.nonceTerms.length > 0 || targetScope.hasNonceLike;
  const hasConsumptionState = base.consumptionTerms.length > 0 || targetScope.hasConsumptionState;
  const hasActionScope = base.actionTerms.length > 0 || targetScope.hasActionScope;
  const missing = [];
  if (!hasDomainScope) missing.push("domain");
  if (!hasNonceLike) missing.push("nonce-or-expiry");
  if (!hasConsumptionState) missing.push("consumption-state");
  if (!hasActionScope) missing.push("action-type");

  let confidence = "low-static";
  if (base.writeSurface && missing.includes("nonce-or-expiry") && missing.includes("consumption-state")) confidence = "high-static";
  else if (base.writeSurface && missing.includes("consumption-state")) confidence = "medium-static";
  else if (missing.length >= 3) confidence = "medium-static";
  else if (missing.length === 0) confidence = "replay-scoped";

  const score = target.priority * 5
    + (confidence === "high-static" ? 45 : confidence === "medium-static" ? 22 : 6)
    + (base.writeSurface ? 10 : 0)
    + Math.min(12, base.strongSignatureTerms.length * 4)
    - (hasDomainScope ? 8 : 0)
    - (hasNonceLike ? 8 : 0)
    - (hasConsumptionState ? 10 : 0);
  const blocker = confidence === "replay-scoped"
    ? "domain, uniqueness/expiry, and consumption/fill-state are present"
    : confidence === "high-static"
      ? "signed write path lacks visible nonce/expiry and consumption state; needs manual path proof"
      : "static replay preconditions incomplete or protected at target scope";
  return {
    ...base,
    confidence,
    priorityScore: Math.round(score * 100) / 100,
    hasDomainScope,
    hasNonceLike,
    hasConsumptionState,
    hasActionScope,
    missingScopes: missing,
    routePositive: false,
    signedActionJustified: false,
    blocker,
  };
}

function rowsFromSolFile(target, filePath, text, targetScope) {
  const rows = [];
  for (const fn of extractSolFunctions(text)) {
    const combined = `${fn.header}\n${fn.body}`;
    const strongSignatureTerms = matchedTerms(combined, STRONG_SIGNATURE_TERMS);
    const weakSignatureTerms = matchedTerms(combined, WEAK_SIGNATURE_TERMS);
    const signatureRelevant = strongSignatureTerms.length > 0 || (weakSignatureTerms.length >= 2 && /verify|recover|hash|permit|signature/i.test(fn.name));
    if (!signatureRelevant) continue;
    rows.push(classifyRow(target, {
      target: target.name,
      chain: target.chain,
      file: rel(filePath),
      line: fn.line,
      function: fn.name,
      access: accessKind(fn.header),
      writeSurface: isWriteSurface(fn.header, fn.body),
      strongSignatureTerms,
      weakSignatureTerms: weakSignatureTerms.slice(0, 8),
      domainTerms: matchedTerms(combined, DOMAIN_TERMS),
      nonceTerms: matchedTerms(combined, NONCE_TERMS),
      consumptionTerms: matchedTerms(combined, CONSUMPTION_TERMS),
      actionTerms: matchedTerms(combined, ACTION_TERMS),
      valueTerms: matchedTerms(combined, VALUE_TERMS).slice(0, 8),
      snippet: snippet(text, fn.line, 2),
    }, targetScope));
  }
  return rows;
}

function rowsFromTextFile(target, filePath, text, targetScope) {
  const strong = matchedTerms(text, STRONG_SIGNATURE_TERMS);
  const weak = matchedTerms(text, WEAK_SIGNATURE_TERMS);
  if (!strong.length && weak.length < 4) return [];
  const lines = text.split(/\r?\n/);
  const line = Math.max(1, lines.findIndex((l) => /signature|EIP712|verify|nonce|permit/i.test(l)) + 1);
  return [classifyRow(target, {
    target: target.name,
    chain: target.chain,
    file: rel(filePath),
    line,
    function: path.basename(filePath),
    access: "file",
    writeSurface: /post|put|handler|mutat|execute|settle|order|agent|approve|cancel/i.test(text),
    strongSignatureTerms: strong.slice(0, 8),
    weakSignatureTerms: weak.slice(0, 8),
    domainTerms: matchedTerms(text, DOMAIN_TERMS),
    nonceTerms: matchedTerms(text, NONCE_TERMS),
    consumptionTerms: matchedTerms(text, CONSUMPTION_TERMS),
    actionTerms: matchedTerms(text, ACTION_TERMS),
    valueTerms: matchedTerms(text, VALUE_TERMS).slice(0, 8),
    snippet: snippet(text, line, 2),
  }, targetScope)];
}

function scanTarget(target) {
  const files = [];
  for (const dir of target.dirs) walk(path.join(WORKSPACE, dir), files);
  const scope = targetFeatures(files);
  const rows = [];
  for (const filePath of files) {
    const text = readText(filePath);
    if (!text) continue;
    if (path.extname(filePath).toLowerCase() === ".sol") rows.push(...rowsFromSolFile(target, filePath, text, scope));
    else rows.push(...rowsFromTextFile(target, filePath, text, scope));
  }
  rows.sort((a, b) => b.priorityScore - a.priorityScore);
  return {
    name: target.name,
    chain: target.chain,
    dirs: target.dirs,
    filesScanned: files.length,
    signatureRows: rows.length,
    highStaticRows: rows.filter((row) => row.confidence === "high-static").length,
    mediumStaticRows: rows.filter((row) => row.confidence === "medium-static").length,
    replayScopedRows: rows.filter((row) => row.confidence === "replay-scoped").length,
    targetScope: scope,
    topRows: rows.slice(0, 14),
  };
}

function reportSeedRows() {
  return REPORT_SEEDS.flatMap((seed) => {
    const filePath = path.join(WORKSPACE, seed.file);
    const text = readText(filePath);
    if (!text) return [];
    const replayVectorCount = (text.match(/replay/gi) || []).length;
    const hasMainnet = /mainnet does not exist|pre-launch|testnet/i.test(text);
    return [{
      target: seed.name,
      chain: seed.chain,
      file: seed.file,
      line: 120,
      function: "HYPERCALL-2 report seed",
      access: "report",
      confidence: "confirmed-seed-testnet",
      priorityScore: seed.priority * 5 + 20,
      writeSurface: true,
      strongSignatureTerms: ["EIP712"],
      weakSignatureTerms: ["signature", "agent", "replay"],
      hasDomainScope: true,
      hasNonceLike: true,
      hasConsumptionState: false,
      hasActionScope: true,
      missingScopes: ["consumption-state"],
      replayVectorCount,
      routePositive: false,
      signedActionJustified: false,
      blocker: hasMainnet ? "confirmed testnet/prelaunch replay seed; no Hypercall mainnet route" : "report seed requires current mainnet/live verification",
      snippet: "Order, agent approval, and margin-mode payloads were replayable on controlled Hypercall testnet wallets; source/mainnet path unavailable.",
    }];
  });
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
  const reportRows = reportSeedRows();
  const rankedRows = [...reportRows, ...sourceRows.flatMap((row) => row.topRows)].sort((a, b) => b.priorityScore - a.priorityScore);
  const highStaticRows = rankedRows.filter((row) => row.confidence === "high-static");
  const confirmedSeedRows = rankedRows.filter((row) => row.confidence === "confirmed-seed-testnet");
  const mediumStaticRows = rankedRows.filter((row) => row.confidence === "medium-static");
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-signed-payload-replay.js",
    scope: "Hypercall-style signed payload replay and nonce/domain/action-scope variant scan",
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
      signatureRows: sourceRows.reduce((acc, row) => acc + row.signatureRows, 0),
      confirmedSeedRows: confirmedSeedRows.length,
      highStaticRows: highStaticRows.length,
      mediumStaticRows: mediumStaticRows.length,
      replayScopedRows: sourceRows.reduce((acc, row) => acc + row.replayScopedRows, 0),
      routePositive: 0,
      executableNow: 0,
      signedActionJustified: false,
      blocker: highStaticRows.length
        ? "Static high-risk signed-write rows need manual source proof and controlled-account/fork validation before any route-positive gate."
        : "Confirmed replay seed is testnet/prelaunch and scanned source rows show domain/nonce/fill-state or no current write route.",
    },
    reportRows,
    sourceRows,
    rankedRows: rankedRows.slice(0, 80),
    requiredForRoutePositive: [
      "signed write endpoint or contract is live/mainnet",
      "valid captured signature can be replayed after intended one-time use, fill, cancellation, or revocation",
      "replay causes asset movement or position-control impact",
      "controlled-account or fork proof demonstrates positive extractable value",
    ],
  };

  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, `${JSON.stringify(artifact, null, 2)}\n`);

  const top = rankedRows.slice(0, 12).map((row) => ({
    Target: row.target,
    Function: row.function,
    File: `${row.file}:${row.line}`,
    Confidence: row.confidence,
    Missing: Array.isArray(row.missingScopes) ? row.missingScopes.join(", ") : "",
    Verdict: row.blocker,
  }));
  const md = [
    "# 🟢 DORMANT — Signed-Payload Replay Variant Scan",
    "",
    `Date: ${new Date().toISOString().slice(0, 10)}`,
    "",
    "## Result",
    "",
    `Scanned ${artifact.summary.filesScanned} source files across ${artifact.summary.targetsScanned} targets for signed-write replay variants. Route gate remains closed: \`routePositive=0\`, \`executableNow=0\`, \`signedActionJustified=false\`.`,
    "",
    `The confirmed Hypercall replay seed is preserved as testnet/prelaunch evidence only. Static source rows found ${artifact.summary.highStaticRows} high-risk candidates and ${artifact.summary.mediumStaticRows} medium-risk candidates; none has current controlled-account/fork proof or route-positive economics.`,
    "",
    "## Top Rows",
    "",
    table(top, ["Target", "Function", "File", "Confidence", "Missing", "Verdict"]),
    "",
    "## Gate",
    "",
    "No fork, signed action, executor change, or exploit call is justified until a live signed-write path proves replay after fill/cancel/revoke and maps to positive asset or position-control impact.",
    "",
    "## Artifacts",
    "",
    "- JSON: `reports/raw/fast/signed-payload-replay.json`",
    "- Scanner: `tools/scan-signed-payload-replay.js`",
    "- Seed report: `reports/synapse-hypercall-triage.md`",
  ].join("\n");
  fs.writeFileSync(OUT_MD, `${md}\n`);

  console.log(`Signed payload replay: targets=${artifact.summary.targetsScanned}; files=${artifact.summary.filesScanned}; highStatic=${artifact.summary.highStaticRows}; confirmedSeeds=${artifact.summary.confirmedSeedRows}; routePositive=0`);
}

main();
