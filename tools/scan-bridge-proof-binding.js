#!/usr/bin/env node
// Read-only bridge proof-binding scanner.
// Finds verifier paths where proof/message hashes appear under-bound to domain, nonce, token, amount, recipient, or finality.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT_JSON = path.join(WORKSPACE, "reports", "raw", "fast", "bridge-proof-binding.json");
const OUT_MD = path.join(WORKSPACE, "reports", "bridge-proof-binding-triage.md");
const QUIET = process.argv.includes("--quiet");

const TARGETS = [
  { name: "Verus-Ethereum Bridge", chain: "Ethereum", priority: 10, dirs: ["targets/verus-ethereum-bridge/contracts", "targets/verus-bridge/contracts"] },
  { name: "deBridge Core", chain: "multi-chain", priority: 9, dirs: ["targets/debridge-contracts/contracts", "targets/debridge-contracts-v2/contracts"] },
  { name: "deBridge DLN", chain: "multi-chain", priority: 9, dirs: ["targets/dln-contracts/contracts"] },
  { name: "LayerZero V2", chain: "multi-chain", priority: 8, dirs: ["targets/layerzero-v2/packages/layerzero-v2/evm/protocol/contracts", "targets/layerzero-v2/packages/layerzero-v2/evm/oapp/contracts"] },
  { name: "Stargate V2", chain: "multi-chain", priority: 8, dirs: ["targets/stargate-v2/packages/stg-evm-v2/src"] },
  { name: "Hyperlane", chain: "multi-chain", priority: 8, dirs: ["targets/hyperlane-monorepo/solidity/contracts"] },
  { name: "Wormhole / NTT", chain: "multi-chain", priority: 8, dirs: ["targets/wormhole/ethereum/contracts", "targets/native-token-transfers/evm/src"] },
  { name: "Across", chain: "multi-chain", priority: 6, dirs: ["targets/across-contracts/contracts", "targets/across-contracts-v2/contracts"] },
  { name: "Hop v1", chain: "Ethereum/L2s", priority: 6, dirs: ["targets/hop-contracts/contracts/bridges"] },
  { name: "Synapse Sanguine", chain: "multi-chain", priority: 6, dirs: ["targets/synapse-sanguine/packages/contracts-core/contracts", "targets/synapse-contracts/contracts"] },
];

const TEXT_EXTS = new Set([".sol", ".ts", ".js", ".rs", ".go"]);
const EXCLUDED_DIRS = new Set([".git", "node_modules", "target", "build", "dist", "out", "cache", "artifacts", "coverage", "generated", "abi", "lib", "vendor"]);
const EXCLUDED_PATH_RE = /[\\/](test|tests|mock|mocks|script|scripts|docs?|examples?)[\\/]/i;

const PROOF_TERMS = ["proof", "verify", "verifier", "merkle", "root", "leaf", "branch", "message", "packet", "payload", "vaa", "signature", "attestation", "receipt", "finality", "checkpoint", "nonce", "sequence", "guid"];
const VALUE_TERMS = ["mint", "unlock", "redeem", "withdraw", "transfer", "safeTransfer", "release", "claim", "fulfill"];
const HASH_TERMS = ["keccak256", "sha256", "hash", "digest", "encode", "encodePacked", "abi.encode", "abi.encodePacked"];
const FALLBACK_TERMS = ["fallback", "default", "relayer", "trusted", "override", "emergency", "rescue"];
const ROLE_GATED_TERMS = ["onlyOwner", "onlyAdmin", "onlyRole", "onlyRelayer", "onlyExecutor", "onlyGuardian", "onlyBridge", "onlyMessenger", "onlyEndpoint", "requiresAuth", "auth", "OwnableUnauthorizedAccount", "AccessControl"];
const CATEGORIES = {
  sourceDomain: ["sourceChain", "srcChain", "srcChainId", "srcEid", "sourceDomain", "origin", "originChain", "emitterChain", "fromChain", "remoteDomain"],
  destinationDomain: ["destinationChain", "dstChain", "dstChainId", "dstEid", "destinationDomain", "localDomain", "block.chainid", "chainid", "address(this)", "toChain"],
  messageType: ["messageType", "payloadType", "packetType", "action", "command", "operation", "version", "selector", "msgType"],
  nonce: ["nonce", "sequence", "seq", "guid", "messageId", "messageNonce", "packetId", "transferId", "rootId", "id"],
  token: ["token", "asset", "underlying", "currency", "tokenAddress", "srcToken", "dstToken", "giveToken", "takeToken"],
  amount: ["amount", "value", "totalAmount", "quantity", "balance", "giveAmount", "takeAmount"],
  recipient: ["recipient", "receiver", "to", "beneficiary", "account", "user", "dstAddress", "recipientAddress"],
  finality: ["finality", "confirmations", "blockNumber", "blockhash", "checkpoint", "maturity", "rootTimestamp", "challenge", "optimistic", "proofMaturity"],
  rootMembership: ["merkle", "root", "leaf", "branch", "proof", "verifyProof", "inclusion", "membership"],
  sourceAddress: ["sender", "emitter", "sourceAddress", "sourceBridge", "bridge", "peer", "endpoint", "oApp", "remote", "verifyingContract"],
};

function exists(filePath) {
  try { return fs.existsSync(filePath); } catch (_) { return false; }
}

function rel(filePath) {
  return path.relative(WORKSPACE, filePath).replace(/\\/g, "/");
}

function safeRead(filePath) {
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

function lower(text) {
  return String(text || "").toLowerCase();
}

function matchedTerms(text, terms) {
  const l = lower(text);
  return terms.filter((term) => l.includes(lower(term)));
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

function rowsFromTextFile(fileText) {
  const rows = [];
  const lines = fileText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (/proof|verify|merkle|root|message|packet|payload|mint|unlock|finalize|claim/i.test(lines[i])) {
      const start = Math.max(0, i - 4);
      const end = Math.min(lines.length, i + 12);
      rows.push({ name: "text-context", line: i + 1, header: lines[i], body: stripComments(lines.slice(start, end).join("\n")) });
      if (rows.length >= 12) break;
    }
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

function categoryHits(text) {
  const out = {};
  for (const [category, terms] of Object.entries(CATEGORIES)) out[category] = matchedTerms(text, terms);
  return out;
}

function missingCategories(hits) {
  return Object.entries(hits).filter(([, terms]) => terms.length === 0).map(([category]) => category);
}

function targetScope(files) {
  const sample = files.map(safeRead).join("\n").slice(0, 12_000_000);
  return categoryHits(sample);
}

function mergeHits(a, b) {
  const out = {};
  for (const key of Object.keys(CATEGORIES)) out[key] = [...new Set([...(a[key] || []), ...(b[key] || [])])];
  return out;
}

function analyzeRow(target, filePath, fileText, fn, scopeHits) {
  const combined = `${fn.header}\n${fn.body}`;
  const proofTerms = matchedTerms(combined, PROOF_TERMS);
  const valueTerms = matchedTerms(combined, VALUE_TERMS);
  const hashTerms = matchedTerms(combined, HASH_TERMS);
  const fallbackTerms = matchedTerms(combined, FALLBACK_TERMS);
  const roleGatedTerms = matchedTerms(combined, ROLE_GATED_TERMS);
  const localHits = categoryHits(combined);
  const scopedHits = mergeHits(localHits, scopeHits);
  const missingLocal = missingCategories(localHits);
  const missingScoped = missingCategories(scopedHits);
  const publicSurface = /\b(external|public)\b/i.test(fn.header) || fn.name === "text-context";
  const proofRelevant = proofTerms.length > 0 || hashTerms.length > 0 || /proof|verify|message|packet|root|vaa|attestation|finalize|process|receive/i.test(fn.name);
  const valueMoving = valueTerms.length > 0 || /mint|unlock|withdraw|redeem|claim|fulfill|finalize/i.test(fn.name);
  const rootMembership = localHits.rootMembership.length > 0 || scopedHits.rootMembership.length > 0;
  const underBoundCore = ["sourceDomain", "destinationDomain", "messageType", "nonce", "token", "amount", "recipient", "finality", "sourceAddress"].filter((key) => localHits[key].length === 0);

  let confidence = "context";
  if (publicSurface && proofRelevant && valueMoving && underBoundCore.length >= 5 && roleGatedTerms.length === 0) confidence = "high-static";
  else if (publicSurface && proofRelevant && valueMoving && underBoundCore.length >= 3 && roleGatedTerms.length === 0) confidence = "medium-static";
  else if (publicSurface && proofRelevant && underBoundCore.length >= 4) confidence = "review";
  else if (proofRelevant) confidence = "context";

  const priorityScore = Math.round(
    target.priority * 6
    + (confidence === "high-static" ? 45 : confidence === "medium-static" ? 30 : confidence === "review" ? 16 : 5)
    + (valueMoving ? 10 : 0)
    + (publicSurface ? 5 : 0)
    + (fallbackTerms.length ? 6 : 0)
    - (roleGatedTerms.length ? 18 : 0)
    - (rootMembership ? 5 : 0)
    - Math.max(0, 10 - missingScoped.length)
  );
  const blocker = confidence === "high-static"
    ? "Static proof path appears under-bound in local function context, but no deployed forged-proof mint/unlock route or exact economics are proven."
    : confidence === "medium-static"
      ? "Proof path needs manual message-hash binding review and deployed-path validation."
      : "Context row only; target-wide bindings or non-value-moving semantics may close this path.";

  return {
    target: target.name,
    chain: target.chain,
    file: rel(filePath),
    line: fn.line,
    function: fn.name,
    access: accessKind(fn.header),
    confidence,
    priorityScore,
    publicSurface,
    proofRelevant,
    valueMoving,
    proofTerms: proofTerms.slice(0, 10),
    valueTerms: valueTerms.slice(0, 8),
    hashTerms: hashTerms.slice(0, 8),
    fallbackTerms: fallbackTerms.slice(0, 8),
    roleGatedTerms: roleGatedTerms.slice(0, 8),
    missingLocalBindings: missingLocal,
    missingScopedBindings: missingScoped,
    underBoundCore,
    localBindings: Object.fromEntries(Object.entries(localHits).filter(([, terms]) => terms.length).map(([key, terms]) => [key, terms.slice(0, 5)])),
    routePositive: false,
    signedActionJustified: false,
    blocker,
    snippet: snippet(fileText, fn.line, 2),
  };
}

function scanTarget(target) {
  const files = [];
  const existingDirs = [];
  for (const dir of target.dirs) {
    const abs = path.join(WORKSPACE, dir);
    if (exists(abs)) existingDirs.push(dir);
    walk(abs, files);
  }
  const scopeHits = targetScope(files);
  const rows = [];
  for (const filePath of files) {
    const text = safeRead(filePath);
    if (!text) continue;
    const functions = path.extname(filePath).toLowerCase() === ".sol" ? extractSolFunctions(text) : rowsFromTextFile(text);
    for (const fn of functions) {
      const combined = `${fn.header}\n${fn.body}`;
      if (matchedTerms(combined, PROOF_TERMS).length === 0 && matchedTerms(combined, HASH_TERMS).length === 0) continue;
      const row = analyzeRow(target, filePath, text, fn, scopeHits);
      if (row.confidence !== "context" || row.priorityScore >= target.priority * 6 + 8) rows.push(row);
    }
  }
  rows.sort((a, b) => b.priorityScore - a.priorityScore || a.file.localeCompare(b.file));
  return {
    name: target.name,
    chain: target.chain,
    dirs: target.dirs,
    existingDirs,
    filesScanned: files.length,
    proofRows: rows.length,
    highStaticRows: rows.filter((row) => row.confidence === "high-static").length,
    mediumStaticRows: rows.filter((row) => row.confidence === "medium-static").length,
    reviewRows: rows.filter((row) => row.confidence === "review").length,
    mintUnlockRows: rows.filter((row) => row.valueMoving).length,
    underBoundProofRows: rows.filter((row) => row.underBoundCore.length >= 3).length,
    topRows: rows.slice(0, 20),
  };
}

function table(rows, headers) {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${headers.map((h) => String(row[h] ?? "").replace(/\r?\n/g, " ").replace(/\|/g, "/")).join(" | ")} |`),
  ].join("\n");
}

function renderReport(artifact) {
  const top = artifact.rankedRows.slice(0, 12).map((row) => ({
    Target: row.target,
    Function: row.function,
    File: `${row.file}:${row.line}`,
    Confidence: row.confidence,
    Missing: row.underBoundCore.slice(0, 6).join(", "),
    Blocker: row.blocker,
  }));
  const sourceRows = artifact.sourceTargets.map((row) => ({
    Target: row.name,
    Dirs: row.existingDirs.length ? row.existingDirs.length : "missing",
    Files: row.filesScanned,
    Rows: row.proofRows,
    High: row.highStaticRows,
    Medium: row.mediumStaticRows,
    ValueRows: row.mintUnlockRows,
  }));
  return [
    "# 🟢 DORMANT — Bridge Proof-Binding Scan",
    "",
    `Date: ${artifact.generatedAt.slice(0, 10)}`,
    "",
    "## Result",
    "",
    `Scanned ${artifact.summary.filesScanned} bridge source files across ${artifact.summary.targetsScanned} targets for proof/message hashes that omit source/destination domain, message type, nonce, token, amount, recipient, finality, or root membership. Route gate remains closed: \`routePositive=0\`, \`executableNow=0\`, \`signedActionJustified=false\`.`,
    "",
    `The scan found ${artifact.summary.highStaticRows} high-static rows, ${artifact.summary.mediumStaticRows} medium-static rows, and ${artifact.summary.underBoundProofRows} under-bound proof context rows. These are static review leads only until a deployed forged-proof mint/unlock route and exact positive economics are proven.`,
    "",
    `Route-relevant gates remain closed: deployed proof-acceptance rows \`${artifact.summary.deployedProofAcceptanceRows}\`, liquid mint/unlock rows \`${artifact.summary.liquidMintUnlockRows}\`, exact-economics rows \`${artifact.summary.exactEconomicsRows}\`, and fork-proof rows \`${artifact.summary.forkProofRows}\`.`,
    "",
    "## Target Coverage",
    "",
    table(sourceRows, ["Target", "Dirs", "Files", "Rows", "High", "Medium", "ValueRows"]),
    "",
    "## Top Rows",
    "",
    top.length ? table(top, ["Target", "Function", "File", "Confidence", "Missing", "Blocker"]) : "No proof-binding rows found in local source checkouts.",
    "",
    "## Route-Positive Gate",
    "",
    "Do not fork or build executors until a row proves: verifier accepts a replayed/forged/under-bound proof, the deployed path mints or unlocks a liquid asset, and exact unwind or collateralization economics are positive after gas.",
    "",
    "## Artifacts",
    "",
    "- JSON: `reports/raw/fast/bridge-proof-binding.json`",
    "- Scanner: `tools/scan-bridge-proof-binding.js`",
    "- Related artifact: `reports/raw/fast/bridge-domain-separation.json`",
    "",
  ].join("\n");
}

function main() {
  const sourceTargets = TARGETS.map(scanTarget);
  const rankedRows = sourceTargets.flatMap((target) => target.topRows).sort((a, b) => b.priorityScore - a.priorityScore || a.file.localeCompare(b.file));
  const summary = {
    targetsScanned: sourceTargets.length,
    targetsWithSource: sourceTargets.filter((row) => row.filesScanned > 0).length,
    filesScanned: sourceTargets.reduce((acc, row) => acc + row.filesScanned, 0),
    proofRows: sourceTargets.reduce((acc, row) => acc + row.proofRows, 0),
    staticProofRows: sourceTargets.reduce((acc, row) => acc + row.proofRows, 0),
    highStaticRows: sourceTargets.reduce((acc, row) => acc + row.highStaticRows, 0),
    mediumStaticRows: sourceTargets.reduce((acc, row) => acc + row.mediumStaticRows, 0),
    reviewRows: sourceTargets.reduce((acc, row) => acc + row.reviewRows, 0),
    mintUnlockRows: sourceTargets.reduce((acc, row) => acc + row.mintUnlockRows, 0),
    underBoundProofRows: sourceTargets.reduce((acc, row) => acc + row.underBoundProofRows, 0),
    deployedProofAcceptanceRows: 0,
    liquidMintUnlockRows: 0,
    exactEconomicsRows: 0,
    forkProofRows: 0,
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    blocker: "No row proves a deployed forged/replayed proof that mints or unlocks liquid assets with exact positive economics.",
  };
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-bridge-proof-binding.js",
    scope: "Read-only bridge proof verifier binding scan",
    safety: {
      rpcInventoryRead: false,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: false,
      signedActionJustified: false,
    },
    bindingCategories: Object.keys(CATEGORIES),
    summary,
    sourceTargets,
    rankedRows: rankedRows.slice(0, 100),
    requiredForRoutePositive: [
      "deployed verifier accepts replayed, forged, or under-bound proof",
      "proof path is permissionless or attacker-reachable without trusted operator compromise",
      "accepted proof mints/unlocks/transfers liquid assets",
      "exact unwind or lending-collateral route is positive after gas/fees/slippage",
      "fork/local proof demonstrates value extraction",
    ],
    nextReadOnlyStep: "Manually compare top high/static rows against deployed verifier state and bridge escrow balances; fork only if a forged-proof mint/unlock route becomes exact and positive.",
  };

  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, `${JSON.stringify(artifact, null, 2)}\n`);
  fs.writeFileSync(OUT_MD, `${renderReport(artifact)}\n`);

  if (!QUIET) {
    console.log(`bridge-proof-binding: targets=${summary.targetsScanned}; sourceTargets=${summary.targetsWithSource}; files=${summary.filesScanned}; highStatic=${summary.highStaticRows}; medium=${summary.mediumStaticRows}; routePositive=0`);
    console.log(`Report: ${rel(OUT_MD)}`);
  }
}

main();
