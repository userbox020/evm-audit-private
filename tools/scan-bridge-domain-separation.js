#!/usr/bin/env node
// scan-bridge-domain-separation.js - static Hop-style bridge identifier/domain binding scan.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT_JSON = path.join(WORKSPACE, "reports", "raw", "fast", "bridge-domain-separation.json");
const OUT_MD = path.join(WORKSPACE, "reports", "bridge-domain-separation-triage.md");

const TARGETS = [
  { name: "Hop v1", chain: "Ethereum/L2s", priority: 10, dirs: ["targets/hop-contracts/contracts/bridges"] },
  { name: "deBridge Core", chain: "multi-chain", priority: 8, dirs: ["targets/debridge-contracts/contracts"] },
  { name: "deBridge DLN", chain: "multi-chain", priority: 8, dirs: ["targets/dln-contracts/contracts"] },
  { name: "LayerZero V2", chain: "multi-chain", priority: 7, dirs: ["targets/layerzero-v2/packages/layerzero-v2/evm/protocol/contracts", "targets/layerzero-v2/packages/layerzero-v2/evm/oapp/contracts"] },
  { name: "Stargate V2", chain: "multi-chain", priority: 7, dirs: ["targets/stargate-v2/packages/stg-evm-v2/src"] },
  { name: "Hyperlane", chain: "multi-chain", priority: 7, dirs: ["targets/hyperlane-monorepo/solidity/contracts"] },
  { name: "Axelar", chain: "multi-chain", priority: 6, dirs: ["targets/axelar-cgp-solidity/contracts", "targets/interchain-token-service/contracts"] },
  { name: "Wormhole", chain: "multi-chain", priority: 6, dirs: ["targets/wormhole/ethereum/contracts", "targets/native-token-transfers/evm/src"] },
  { name: "Across", chain: "multi-chain", priority: 5, dirs: ["targets/across-contracts/contracts", "targets/across-contracts-v2/contracts"] },
];

const TEXT_EXTS = new Set([".sol", ".ts", ".js"]);
const EXCLUDED_DIRS = new Set([".git", "node_modules", "build", "dist", "out", "cache", "artifacts", "coverage", "generated", "abi"]);
const EXCLUDED_PATH_RE = /[\\/](test|tests|mock|mocks|interfaces|script|scripts|docs?)[\\/]/i;

const ORIGIN_TERMS = ["originChainId", "originChain", "originDomain", "sourceChainId", "sourceDomain", "srcChainId", "srcEid", "srcDomain", "fromChainId", "giveChainId"];
const DEST_TERMS = ["destinationChainId", "destinationChainid", "destinationDomain", "destination", "dstChainId", "dstEid", "dstDomain", "toChainId", "takeChainId"];
const LOCAL_TERMS = ["block.chainid", "chainid()", "getChainId()", "localDomain", "localEid", "DOMAIN_SEPARATOR", "verifyingContract"];
const GENERIC_CHAIN_TERMS = ["chainId", "chainid", "eid", "domain"];
const TYPE_TERMS = ["messageType", "packetType", "action", "operation", "version", "command", "bridge", "token", "asset"];
const VALUE_TERMS = ["rootHash", "totalAmount", "amount", "nonce", "recipient", "receiver", "sender", "payload", "message", "token", "asset", "maker", "taker", "order"];
const ID_TERMS = ["id", "hash", "root", "guid", "packet", "message", "commit", "proof", "order", "receipt", "request", "payload"];

function rel(filePath) {
  return path.relative(WORKSPACE, filePath).replace(/\\/g, "/");
}

function safeRead(filePath) {
  try { return fs.readFileSync(filePath, "utf8"); } catch (_) { return ""; }
}

function exists(filePath) {
  try { return fs.existsSync(filePath); } catch (_) { return false; }
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

function hasAny(text, terms) {
  const lower = String(text || "").toLowerCase();
  return terms.some((term) => lower.includes(term.toLowerCase()));
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

function extractFunctions(text) {
  const rows = [];
  const re = /function\s+([A-Za-z0-9_]+)\s*\([^;{]*\)[^{;]*\{/g;
  let match;
  while ((match = re.exec(text))) {
    const open = text.indexOf("{", match.index);
    if (open === -1) continue;
    const end = findBlockEnd(text, open);
    const raw = text.slice(match.index, end);
    const header = text.slice(match.index, open + 1);
    rows.push({ name: match[1], start: match.index, line: lineNumberAt(text, match.index), header, raw, body: stripComments(raw) });
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

function isRelevantFunction(fn) {
  const text = `${fn.name}\n${fn.body}`;
  const hasHash = /\bkeccak256\b|\bsha256\b|\babi\.encode(?:Packed)?\b|\bhash\w*\s*\(/i.test(fn.body);
  const idShaped = hasAny(text, ID_TERMS);
  const bridgeValued = hasAny(text, VALUE_TERMS);
  return hasHash && idShaped && bridgeValued;
}

function expandedBody(fn, fnMap) {
  const calls = [...fn.body.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)]
    .map((match) => match[1])
    .filter((name) => name !== fn.name && fnMap.has(name));
  const calleeText = [...new Set(calls)].map((name) => fnMap.get(name).body).join("\n");
  return `${fn.body}\n${calleeText}`;
}

function usageContexts(fnName, files, selfFile) {
  const contexts = [];
  const callRe = new RegExp(`\\b${fnName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\(`);
  for (const filePath of files) {
    const text = safeRead(filePath);
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!callRe.test(line) || new RegExp(`function\\s+${fnName}\\s*\\(`).test(line)) continue;
      const ctx = lines.slice(Math.max(0, i - 3), Math.min(lines.length, i + 4)).join("\n");
      const domainTerms = [...matchedTerms(ctx, ORIGIN_TERMS), ...matchedTerms(ctx, DEST_TERMS), ...matchedTerms(ctx, LOCAL_TERMS)];
      contexts.push({ file: rel(filePath), line: i + 1, hasDomainContext: domainTerms.length > 0, domainTerms, snippet: snippet(text, i + 1, 2) });
    }
  }
  return contexts.filter((ctx) => ctx.file !== selfFile || ctx.snippet.includes(`${fnName}(`));
}

function analyzeFunction(target, filePath, fileText, fn, files, fnMap) {
  const body = expandedBody(fn, fnMap);
  const originTerms = matchedTerms(body, ORIGIN_TERMS);
  const destinationTerms = matchedTerms(body, DEST_TERMS);
  const localTerms = matchedTerms(body, LOCAL_TERMS);
  const genericChainTerms = matchedTerms(body, GENERIC_CHAIN_TERMS);
  const semanticBinding = /keccak256\s*\(\s*_?message\s*\)/i.test(fn.body) && /ORIGIN_OFFSET/i.test(fileText) && /DESTINATION_OFFSET/i.test(fileText)
    ? "encoded-message-origin-destination"
    : /(interchainTokenId|DeploySalt)/i.test(fn.name) && /salt/i.test(fn.body) && /(sender|deployer|token)/i.test(fn.body)
      ? "token-identity-salt"
      : null;
  const typeTerms = matchedTerms(body, TYPE_TERMS);
  const valueTerms = matchedTerms(body, VALUE_TERMS);
  const access = accessKind(fn.header);
  const returnsBytes32 = /returns\s*\([^)]*bytes32/i.test(fn.header) || /returns\s+bytes32/i.test(fn.header);
  const identifierLike = returnsBytes32 || /(id|hash|root|guid|digest|order|receipt|request)/i.test(fn.name);
  const uses = usageContexts(fn.name, files, rel(filePath));
  const callerDomainContexts = uses.filter((row) => row.hasDomainContext).length;
  const includesAnyDomain = originTerms.length > 0 || destinationTerms.length > 0 || localTerms.length > 0 || genericChainTerms.length > 0 || Boolean(semanticBinding);
  const missingBothDirections = originTerms.length === 0 && destinationTerms.length === 0 && localTerms.length === 0 && genericChainTerms.length === 0 && !semanticBinding;
  const missingOneDirection = includesAnyDomain && genericChainTerms.length === 0 && !semanticBinding && !(originTerms.length > 0 && destinationTerms.length > 0);
  const hashLine = fn.raw.split(/\r?\n/).find((line) => /keccak256|sha256|abi\.encode|hash|guid/i.test(line)) || fn.header;

  let score = target.priority * 4;
  if (missingBothDirections) score += 48;
  else if (missingOneDirection) score += 18;
  if (callerDomainContexts > 0 && missingBothDirections) score += 32;
  if (/root|message|packet|guid|order|request|receipt/i.test(fn.name)) score += 12;
  if (/public|external/.test(access)) score += 10;
  if (typeTerms.length === 0) score += 6;
  score += Math.min(12, valueTerms.length * 2);

  const confidence = callerDomainContexts > 0 && missingBothDirections && identifierLike
    ? "high-static"
    : missingBothDirections
      ? identifierLike ? "medium-static" : "low-static"
      : missingOneDirection
        ? "low-static"
        : "domain-bound";
  const blocker = confidence === "high-static"
    ? "identifier omits domain fields while callers carry domain context; needs role/access and extractability proof"
    : confidence === "domain-bound"
      ? "identifier includes domain/path fields"
      : "static omission needs deployed-path and caller-impact validation";

  return {
    target: target.name,
    chain: target.chain,
    file: rel(filePath),
    line: fn.line,
    function: fn.name,
    access,
    confidence,
    priorityScore: Math.round(score * 100) / 100,
    returnsBytes32,
    identifierLike,
    includesOriginScope: originTerms.length > 0,
    includesDestinationScope: destinationTerms.length > 0,
    includesLocalChainScope: localTerms.length > 0,
    includesGenericChainScope: genericChainTerms.length > 0,
    semanticBinding,
    includesMessageTypeScope: typeTerms.length > 0,
    originTerms,
    destinationTerms,
    localTerms,
    genericChainTerms,
    typeTerms,
    valueTerms: valueTerms.slice(0, 8),
    callerContexts: uses.length,
    callerDomainContexts,
    representativeLine: hashLine.trim().slice(0, 260),
    snippet: snippet(fileText, fn.line, 2),
    routePositive: false,
    signedActionJustified: false,
    blocker,
    callSites: uses.slice(0, 6),
  };
}

function scanTarget(target) {
  const files = [];
  for (const dir of target.dirs) walk(path.join(WORKSPACE, dir), files);
  const rows = [];
  for (const filePath of files) {
    const text = safeRead(filePath);
    if (!text) continue;
    const allFns = extractFunctions(text);
    const fnMap = new Map(allFns.map((fn) => [fn.name, fn]));
    const fns = allFns.filter(isRelevantFunction);
    for (const fn of fns) rows.push(analyzeFunction(target, filePath, text, fn, files, fnMap));
  }
  rows.sort((a, b) => b.priorityScore - a.priorityScore || b.callerDomainContexts - a.callerDomainContexts);
  return {
    name: target.name,
    chain: target.chain,
    dirs: target.dirs,
    filesScanned: files.length,
    identifierRows: rows.length,
    highStaticRows: rows.filter((row) => row.confidence === "high-static").length,
    missingDomainRows: rows.filter((row) => row.confidence !== "domain-bound").length,
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
  const allRows = sourceRows.flatMap((row) => row.topRows.map((top) => ({ ...top, sourceTarget: row.name })));
  const rankedRows = allRows.sort((a, b) => {
    const ah = a.confidence === "high-static" ? 1 : 0;
    const bh = b.confidence === "high-static" ? 1 : 0;
    return bh - ah || b.priorityScore - a.priorityScore || b.callerDomainContexts - a.callerDomainContexts;
  });
  const highStaticRows = rankedRows.filter((row) => row.confidence === "high-static");
  const missingDomainRows = rankedRows.filter((row) => row.confidence !== "domain-bound");
  const knownHopPatternRows = highStaticRows.filter((row) => row.target === "Hop v1" && row.function === "getTransferRootId").length;
  const nonHopHighStaticRows = highStaticRows.filter((row) => !(row.target === "Hop v1" && row.function === "getTransferRootId"));
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-bridge-domain-separation.js",
    scope: "Hop-style bridge root/message/order identifier domain-separation variant scan",
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
      identifierRows: sourceRows.reduce((acc, row) => acc + row.identifierRows, 0),
      missingDomainRows: missingDomainRows.length,
      highStaticRows: highStaticRows.length,
      knownHopPatternRows,
      nonHopHighStaticRows: nonHopHighStaticRows.length,
      routePositive: 0,
      executableNow: 0,
      signedActionJustified: false,
      blocker: highStaticRows.length
        ? "Static domain-omission rows exist, but no row proves permissionless extractable funds or exact route-positive settlement economics."
        : "Scanned bridge identifiers are domain-bound or require non-static impact validation.",
    },
    sourceRows,
    rankedRows: rankedRows.slice(0, 80),
    requiredForRoutePositive: [
      "domain-colliding identifier exists in a deployed bridge path",
      "colliding action is callable by an attacker without privileged bridge/bonder/operator role",
      "collision maps to extractable funds or settlement capture rather than liveness only",
      "fork/local proof demonstrates positive value after fees/gas/slippage",
    ],
  };

  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, `${JSON.stringify(artifact, null, 2)}\n`);

  const top = rankedRows.slice(0, 12).map((row) => ({
    Target: row.target,
    Function: `${row.function}`,
    File: `${row.file}:${row.line}`,
    Confidence: row.confidence,
    Domain: `${row.includesOriginScope ? "src" : "-"}/${row.includesDestinationScope ? "dst" : "-"}/${row.semanticBinding || row.includesLocalChainScope ? (row.semanticBinding || "local") : row.includesGenericChainScope ? "chain" : "-"}`,
    Callers: String(row.callerDomainContexts),
    Verdict: row.blocker,
  }));
  const highStaticWord = artifact.summary.highStaticRows === 1 ? "row" : "rows";
  const nonHopSentence = artifact.summary.nonHopHighStaticRows > 0
    ? "Non-Hop high-static rows require manual deployed-path review before they can be promoted."
    : "No non-Hop high-static rows survived semantic binding filters.";
  const md = [
    "# 🟢 DORMANT — Bridge Domain-Separation Variant Scan",
    "",
    `Date: ${new Date().toISOString().slice(0, 10)}`,
    "",
    "## Result",
    "",
    `Scanned ${artifact.summary.filesScanned} bridge source files across ${artifact.summary.targetsScanned} targets for Hop-style root/message/order identifiers that omit origin/destination/domain fields. Route gate remains closed: \`routePositive=0\`, \`executableNow=0\`, \`signedActionJustified=false\`.`,
    "",
    `The scan found ${artifact.summary.highStaticRows} high-static ${highStaticWord}. The known Hop \`getTransferRootId(rootHash,totalAmount)\` pattern is represented, but it remains a registered-bonder/liveness prerequisite rather than a permissionless TVL extraction path. ${nonHopSentence}`,
    "",
    "## Top Rows",
    "",
    table(top, ["Target", "Function", "File", "Confidence", "Domain", "Callers", "Verdict"]),
    "",
    "## Gate",
    "",
    "No fork, signed action, executor change, or exploit call is justified until a row proves a deployed domain collision that is permissionlessly callable and maps to exact positive extraction economics.",
    "",
    "## Artifacts",
    "",
    "- JSON: `reports/raw/fast/bridge-domain-separation.json`",
    "- Scanner: `tools/scan-bridge-domain-separation.js`",
    "- Seed report: `reports/hop-triage.md`",
  ].join("\n");
  fs.writeFileSync(OUT_MD, `${md}\n`);

  console.log(`Bridge domain separation: targets=${artifact.summary.targetsScanned}; files=${artifact.summary.filesScanned}; highStatic=${artifact.summary.highStaticRows}; nonHopHighStatic=${artifact.summary.nonHopHighStaticRows}; routePositive=0`);
}

main();
