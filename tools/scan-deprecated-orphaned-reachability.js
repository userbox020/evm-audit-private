#!/usr/bin/env node
// Read-only deprecated/orphaned contract reachability scanner.
// RPC URLs are resolved in memory only and never written to artifacts.

const fs = require("fs");
const path = require("path");
const { resolveRpcPool, rpcCall } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT_JSON = path.join(WORKSPACE, "reports", "raw", "fast", "deprecated-orphaned-reachability.json");
const OUT_MD = path.join(WORKSPACE, "reports", "deprecated-orphaned-reachability-triage.md");
const QUIET = process.argv.includes("--quiet");

const MAX_FILES = Number(process.env.DEPRECATED_REACHABILITY_MAX_FILES || "6000");
const MAX_FILE_BYTES = Number(process.env.DEPRECATED_REACHABILITY_MAX_FILE_BYTES || "1000000");
const MAX_CANDIDATES = Number(process.env.DEPRECATED_REACHABILITY_MAX_CANDIDATES || "220");
const MAX_LIVE_CHECKS = Number(process.env.DEPRECATED_REACHABILITY_MAX_LIVE_CHECKS || "72");
const MAX_LIVE_PER_CHAIN = Number(process.env.DEPRECATED_REACHABILITY_MAX_LIVE_PER_CHAIN || "16");

const INPUT_ROOTS = [
  path.join(WORKSPACE, "targets"),
  path.join(WORKSPACE, "contracts"),
];

const ARTIFACT_INPUTS = [
  "reports/raw/fast/router-rfq-settlement-drift.json",
  "reports/raw/fast/post-audit-deployed-map.json",
  "reports/raw/fast/post-audit-scope-drift.json",
  "reports/raw/fast/bridge-proof-binding.json",
  "reports/raw/fast/fake-asset-pool-validation.json",
  "reports/raw/fast/pool-share-snapshot-drift.json",
];

const TEXT_EXTS = new Set([".sol", ".json", ".ts", ".js", ".md", ".toml", ".txt"]);
const EXCLUDED_DIRS = new Set([".git", "node_modules", "artifacts", "cache", "out", "dist", "build", "coverage", "generated", "types", "lib"]);
const EXCLUDED_PATH_RE = /[\\/](solcInputs|test|tests|mock|mocks|script|scripts|docs?|examples?)[\\/]/i;

const CHAIN_IDS = new Map([
  ["ethereum", 1], ["eth", 1], ["mainnet", 1], ["eth-mainnet", 1],
  ["optimism", 10], ["op", 10], ["bsc", 56], ["bnb", 56], ["polygon", 137],
  ["gnosis", 100], ["xdai", 100], ["base", 8453], ["arbitrum", 42161], ["arb", 42161],
  ["avalanche", 43114], ["avax", 43114], ["fantom", 250], ["ftm", 250],
  ["celo", 42220], ["mantle", 5000], ["linea", 59144], ["scroll", 534352],
  ["blast", 81457], ["unichain", 130], ["ink", 57073], ["worldchain", 480], ["world-chain", 480],
  ["bera", 80094], ["berachain", 80094], ["hyperevm", 999],
]);

const DEPRECATED_TERMS = [
  "deprecated", "deprecate", "legacy", "old", "orphan", "unused", "retired", "sunset",
  "obsolete", "migration", "migrate", "replaced", "previous", "former",
  "fallback", "emergency", "rescue", "sweep", "stale", "disabled",
];

const REACHABILITY_TERMS = [
  "router", "adapter", "settlement", "exchange", "proxy", "implementation", "factory", "market",
  "vault", "pool", "bridge", "verifier", "escrow", "spoke", "gateway", "module", "facet",
  "handler", "executor", "migrator", "claim", "withdraw", "redeem", "borrow", "liquidate", "settle",
  "fill", "swap", "execute", "call", "delegatecall", "transferfrom", "permit", "approve",
];

const VALUE_SELECTORS = [
  { selector: "23b872dd", name: "transferFrom(address,address,uint256)", kind: "token-transfer" },
  { selector: "a9059cbb", name: "transfer(address,uint256)", kind: "token-transfer" },
  { selector: "095ea7b3", name: "approve(address,uint256)", kind: "approval" },
  { selector: "2e1a7d4d", name: "withdraw(uint256)", kind: "withdraw" },
  { selector: "db006a75", name: "redeem(uint256)", kind: "redeem" },
  { selector: "ba087652", name: "redeem(uint256,address,address)", kind: "redeem" },
  { selector: "6e553f65", name: "deposit(uint256,address)", kind: "deposit" },
  { selector: "b6b55f25", name: "deposit(uint256)", kind: "deposit" },
  { selector: "1249c58b", name: "mint()", kind: "mint" },
  { selector: "a0712d68", name: "mint(uint256)", kind: "mint" },
  { selector: "c5ebeaec", name: "borrow(uint256)", kind: "borrow" },
  { selector: "f5e3c462", name: "liquidateBorrow(address,uint256,address)", kind: "liquidation" },
  { selector: "00a718a9", name: "liquidationCall(address,address,address,uint256,bool)", kind: "liquidation" },
  { selector: "3598d8ab", name: "execute(bytes,bytes[])", kind: "execution" },
  { selector: "1cff79cd", name: "execute(address,uint256,bytes)", kind: "execution" },
  { selector: "5ae401dc", name: "multicall(bytes[])", kind: "batch" },
  { selector: "ac9650d8", name: "multicall(bytes[])", kind: "batch" },
  { selector: "12aa3caf", name: "swap(...)", kind: "swap" },
  { selector: "bc80f1a8", name: "swap(...)", kind: "swap" },
  { selector: "4e71d92d", name: "claim()", kind: "claim" },
  { selector: "3d13f874", name: "claim(address)", kind: "claim" },
];

const PSEUDO_ADDRESSES = new Set([
  "0x0000000000000000000000000000000000000000",
  "0x0000000000000000000000000000000000001010",
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  "0xffffffffffffffffffffffffffffffffffffffff",
]);

function exists(filePath) {
  try { return fs.existsSync(filePath); } catch (_) { return false; }
}

function isSecretLikePath(filePath) {
  const normalized = rel(filePath).replace(/\\/g, "/").toLowerCase();
  const base = path.basename(filePath).toLowerCase();
  if (base === ".env" || base.startsWith(".env.")) return true;
  if (base === "rpc_endpoints.txt" || base === "graphql_endpoints.txt") return true;
  if (/\.(pem|key|p12|pfx|keystore)$/i.test(base)) return true;
  if (/(^|[\/\\])(?:private|secret|secrets|mnemonic|seed|wallet|keypair|keystore|api[-_]?key|access[-_]?key)(?:[\/\\._-]|$)/i.test(normalized)) return true;
  return false;
}

function rel(filePath) {
  return path.relative(WORKSPACE, filePath).replace(/\\/g, "/");
}

function safeRead(filePath) {
  try { return fs.readFileSync(filePath, "utf8"); } catch (_) { return ""; }
}

function asNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const n = Number(String(value).replace(/[$,%\s,_]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function round(value, decimals = 4) {
  const n = asNumber(value);
  if (n === null) return null;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function unique(items) {
  return [...new Set((items || []).filter(Boolean))];
}

function isPseudoAddress(address) {
  const s = lower(address);
  if (PSEUDO_ADDRESSES.has(s)) return true;
  try {
    const n = BigInt(s);
    return n > 0n && n < 0x1000000000000n;
  } catch (_) {
    return false;
  }
}

function lower(text) {
  return String(text || "").toLowerCase();
}

function matchedTerms(text, terms) {
  const raw = lower(text);
  const normalized = raw.replace(/[_-]/g, "");
  return terms.filter((term) => {
    const t = lower(term);
    if (t.length <= 3) return new RegExp(`(^|[^a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i").test(raw);
    return normalized.includes(t.replace(/[_-]/g, ""));
  });
}

function walk(root, out = []) {
  if (!exists(root) || out.length >= MAX_FILES) return out;
  const stat = fs.statSync(root);
  if (stat.isFile()) {
    if (stat.size <= MAX_FILE_BYTES && TEXT_EXTS.has(path.extname(root).toLowerCase()) && !EXCLUDED_PATH_RE.test(root) && !isSecretLikePath(root)) out.push(root);
    return out;
  }
  if (!stat.isDirectory()) return out;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (out.length >= MAX_FILES) break;
    if (entry.isDirectory() && EXCLUDED_DIRS.has(entry.name)) continue;
    walk(path.join(root, entry.name), out);
  }
  return out;
}

function lineNumberAt(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
}

function contextAround(text, index, radius = 360) {
  return text.slice(Math.max(0, index - radius), Math.min(text.length, index + radius)).replace(/\s+/g, " ").trim().slice(0, 520);
}

function addressRole(text, index) {
  const before = text.slice(Math.max(0, index - 140), index);
  const after = text.slice(index, Math.min(text.length, index + 140));
  if (/"contractAddress"\s*:\s*"?$/i.test(before) || /"deployedTo"\s*:\s*"?$/i.test(before)) return "deployed-contract";
  if (/"address"\s*:\s*"?$/i.test(before) && /"(contractName|abi|bytecode|deployedBytecode)"/i.test(`${before}${after}`)) return "deployment-address";
  if (/"(?:target|to|router|adapter|implementation|proxy|factory|market|vault|pool|bridge|verifier|escrow|gateway)"\s*:\s*"?$/i.test(before)) return "named-target";
  if (/"(?:arguments|args|constructorArguments)"\s*:\s*\[[^\]]*$/i.test(before)) return "constructor-arg";
  if (/"topics"\s*:\s*\[[^\]]*$/i.test(before)) return "event-topic";
  return "reference";
}

function chainIdFromText(text) {
  const jsonLike = String(text || "");
  const chainIdMatch = jsonLike.match(/"?chainId"?\s*[:=]\s*"?(\d{1,9})"?/i);
  if (chainIdMatch) return Number(chainIdMatch[1]);
  const networkMatch = jsonLike.match(/"?(?:chain|network)"?\s*[:=]\s*"?([A-Za-z0-9_-]{2,40})"?/i);
  if (networkMatch) {
    const value = lower(networkMatch[1]);
    if (CHAIN_IDS.has(value)) return CHAIN_IDS.get(value);
  }
  return null;
}

function chainIdFromPath(filePath) {
  const parts = rel(filePath).split(/[\\/]/).map((part) => lower(part.replace(/\.[^.]+$/, "")));
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (/^\d{1,9}$/.test(part)) return Number(part);
    if (CHAIN_IDS.has(part)) return CHAIN_IDS.get(part);
    const joined = `${part}-${parts[i + 1] || ""}`;
    if (CHAIN_IDS.has(joined)) return CHAIN_IDS.get(joined);
  }
  return null;
}

function inferChainId(filePath, text, context) {
  return chainIdFromText(context) || chainIdFromText(text.slice(0, 20000)) || chainIdFromPath(filePath);
}

function extractAddressRows(filePath, text, sourceKind) {
  const rows = [];
  const file = rel(filePath);
  const pathDeprecatedTerms = matchedTerms(file, DEPRECATED_TERMS);
  const pathReachabilityTerms = matchedTerms(file, REACHABILITY_TERMS);
  const re = /(?<![0-9a-fA-F])0x[a-fA-F0-9]{40}(?![0-9a-fA-F])/g;
  const seen = new Set();
  let match;
  while ((match = re.exec(text))) {
    const address = match[0];
    const lowerAddress = lower(address);
    if (isPseudoAddress(lowerAddress)) continue;
    if (seen.has(lowerAddress)) continue;
    seen.add(lowerAddress);
    const context = contextAround(text, match.index);
    const role = addressRole(text, match.index);
    const terms = unique([...pathDeprecatedTerms, ...matchedTerms(context, DEPRECATED_TERMS)]);
    const reachabilityTerms = unique([...pathReachabilityTerms, ...matchedTerms(context, REACHABILITY_TERMS)]);
    if (!terms.length) continue;
    rows.push({
      sourceKind,
      source: file,
      line: lineNumberAt(text, match.index),
      address,
      chainId: inferChainId(filePath, text, context),
      role,
      deprecatedTerms: terms,
      reachabilityTerms,
      context,
    });
  }
  return rows;
}

function collectSourceRows() {
  const files = [];
  for (const root of INPUT_ROOTS) walk(root, files);
  const rows = [];
  for (const file of files) {
    const text = safeRead(file);
    if (!text || !/0x[a-fA-F0-9]{40}/.test(text)) continue;
    const relFile = rel(file);
    const likelyRelevant = /deprecated|legacy|old|orphan|retired|sunset|obsolete|migration|migrate|routerV1|v1|v2|implementation|proxy|deployments|broadcast/i.test(relFile)
      || /deprecated|legacy|old|orphan|retired|sunset|obsolete|migration|migrate|previous|former/i.test(text.slice(0, 60000));
    if (!likelyRelevant) continue;
    rows.push(...extractAddressRows(file, text, "source"));
  }
  return { filesScanned: files.length, rows };
}

function collectArtifactRows() {
  const rows = [];
  for (const relPath of ARTIFACT_INPUTS) {
    const file = path.join(WORKSPACE, relPath);
    if (!exists(file)) continue;
    const text = safeRead(file);
    rows.push(...extractAddressRows(file, text, "artifact"));
  }
  return rows;
}

function mergeRows(rows) {
  const byKey = new Map();
  for (const row of rows) {
    const key = `${row.chainId || "unknown"}:${lower(row.address)}`;
    const existing = byKey.get(key) || {
      address: row.address,
      chainId: row.chainId,
      sources: [],
      deprecatedTerms: [],
      reachabilityTerms: [],
      contexts: [],
      sourceKinds: [],
      roles: [],
      localEvidenceRows: 0,
    };
    existing.sources.push(`${row.source}:${row.line}`);
    existing.deprecatedTerms.push(...row.deprecatedTerms);
    existing.reachabilityTerms.push(...row.reachabilityTerms);
    existing.contexts.push(row.context);
    existing.sourceKinds.push(row.sourceKind);
    existing.roles.push(row.role);
    existing.localEvidenceRows += 1;
    if (!existing.chainId && row.chainId) existing.chainId = row.chainId;
    byKey.set(key, existing);
  }
  return [...byKey.values()].map((row) => ({
    ...row,
    sources: unique(row.sources).slice(0, 8),
    deprecatedTerms: unique(row.deprecatedTerms).slice(0, 12),
    reachabilityTerms: unique(row.reachabilityTerms).slice(0, 12),
    sourceKinds: unique(row.sourceKinds),
    roles: unique(row.roles),
    contexts: unique(row.contexts).slice(0, 3),
  }));
}

function hexToBigInt(hex) {
  const s = String(hex || "0x0");
  if (!/^0x[0-9a-fA-F]*$/.test(s) || s === "0x") return 0n;
  return BigInt(s);
}

function formatEth(wei) {
  const value = typeof wei === "bigint" ? wei : hexToBigInt(wei);
  return Number(value) / 1e18;
}

function selectorHits(code) {
  const lowerCode = lower(code).replace(/^0x/, "");
  return VALUE_SELECTORS.filter((item) => lowerCode.includes(item.selector)).map((item) => item.name);
}

function localPriority(row) {
  const roleScore = row.roles.includes("deployed-contract") ? 20
    : row.roles.includes("deployment-address") ? 14
      : row.roles.includes("named-target") ? 10
        : row.roles.includes("constructor-arg") ? -18
          : row.roles.includes("event-topic") ? -12
            : 0;
  return (row.deprecatedTerms.length * 8)
    + (row.reachabilityTerms.length * 5)
    + (row.chainId ? 8 : 0)
    + (row.sourceKinds.includes("artifact") ? 8 : 0)
    + Math.min(16, row.localEvidenceRows * 2)
    + roleScore;
}

async function annotateLive(rows) {
  const perChain = new Map();
  const sorted = rows.slice().sort((a, b) => localPriority(b) - localPriority(a));
  const selected = [];
  for (const row of sorted) {
    if (!row.chainId) continue;
    const count = perChain.get(row.chainId) || 0;
    if (count >= MAX_LIVE_PER_CHAIN) continue;
    perChain.set(row.chainId, count + 1);
    selected.push(row);
    if (selected.length >= MAX_LIVE_CHECKS) break;
  }
  const chainIds = unique(selected.map((row) => Number(row.chainId))).filter(Boolean);
  const rpcByChain = await resolveRpcPool(chainIds);
  const liveByKey = new Map();
  for (const row of selected) {
    const rpc = rpcByChain[row.chainId];
    if (!rpc) continue;
    const [code, balance, implSlot] = await Promise.all([
      rpcCall(rpc, "eth_getCode", [row.address, "latest"], 7000),
      rpcCall(rpc, "eth_getBalance", [row.address, "latest"], 7000),
      rpcCall(rpc, "eth_getStorageAt", [row.address, "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc", "latest"], 7000),
    ]);
    const codePresent = Boolean(code && code !== "0x");
    const balanceWei = hexToBigInt(balance);
    const selectors = codePresent ? selectorHits(code) : [];
    const impl = implSlot && implSlot !== "0x" && !/^0x0{64}$/i.test(implSlot) ? `0x${implSlot.slice(-40)}` : null;
    liveByKey.set(`${row.chainId || "unknown"}:${lower(row.address)}`, {
      liveChecked: true,
      codePresent,
      codeBytes: codePresent ? Math.floor((code.length - 2) / 2) : 0,
      balanceWei: balanceWei.toString(),
      balanceEth: round(formatEth(balanceWei), 8),
      eip1967Implementation: impl,
      selectorHits: selectors,
      selectorHitCount: selectors.length,
    });
  }
  return rows.map((row) => ({
    ...row,
    ...(liveByKey.get(`${row.chainId || "unknown"}:${lower(row.address)}`) || { liveChecked: false, codePresent: null, codeBytes: null, balanceWei: null, balanceEth: null, eip1967Implementation: null, selectorHits: [], selectorHitCount: 0 }),
  }));
}

function rankRows(rows) {
  return rows.map((row) => {
    const liveScore = row.codePresent ? 18 : row.liveChecked ? -6 : 0;
    const selectorScore = Math.min(24, (row.selectorHitCount || 0) * 4);
    const balanceScore = (asNumber(row.balanceEth) || 0) > 0 ? 16 : 0;
    const priorityScore = Math.round(Math.max(0, Math.min(100, localPriority(row) + liveScore + selectorScore + balanceScore)));
    const contractLikeRole = row.roles.includes("deployed-contract") || row.roles.includes("deployment-address") || row.roles.includes("named-target");
    const deployedReachability = Boolean(contractLikeRole && row.codePresent && row.selectorHitCount > 0 && row.deprecatedTerms.length > 0);
    return {
      ...row,
      priorityScore,
      deployedReachability,
      orphanCandidate: Boolean(contractLikeRole && row.codePresent && matchedTerms(`${row.sources.join(" ")} ${row.contexts.join(" ")}`, ["implementation", "old", "legacy", "previous", "former", "unused", "orphan"]).length > 0),
      permissionlessValuePath: false,
      exactEconomics: false,
      forkProof: false,
      routePositive: false,
      blockers: [
        "Deprecated/orphaned reachability is inventory only; selector presence does not prove permissionless value movement",
        "No live approvals, escrow accounting, balances-to-owner path, or registry reachability is proven",
        "No exact positive economics or fork extraction proof",
      ],
    };
  }).sort((a, b) => Number(b.deployedReachability) - Number(a.deployedReachability)
    || Number(b.orphanCandidate) - Number(a.orphanCandidate)
    || b.priorityScore - a.priorityScore
    || (b.selectorHitCount || 0) - (a.selectorHitCount || 0));
}

function table(rows, cols) {
  const header = `| ${cols.join(" | ")} |`;
  const sep = `| ${cols.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${cols.map((col) => String(row[col] ?? "").replace(/\|/g, "/")).join(" | ")} |`);
  return [header, sep, ...body].join("\n");
}

function renderReport(artifact) {
  const s = artifact.summary;
  const top = artifact.rankedRows.slice(0, 12).map((row) => ({
    Address: `${row.address.slice(0, 6)}...${row.address.slice(-4)}`,
    Chain: row.chainId || "unknown",
    Code: row.codePresent === true ? "yes" : row.codePresent === false ? "no" : "n/a",
    Selectors: row.selectorHitCount || 0,
    BalanceETH: row.balanceEth ?? "n/a",
    Role: row.roles.slice(0, 2).join(", "),
    Terms: row.deprecatedTerms.slice(0, 4).join(", "),
    Source: row.sources[0] || "",
    Blocker: row.blockers[0],
  }));
  return [
    "# 🟢 DORMANT - Deprecated/Orphaned Reachability Scan",
    "",
    `Date: ${artifact.generatedAt.slice(0, 10)}`,
    "",
    "## Result",
    "",
    `Scanned local deployment/source/report inventory for deprecated, legacy, retired, and orphan-like addresses, then verified live code/balance for bounded candidates where RPC was available. This remains fail-closed: \`deployedReachabilityRows=${s.deprecatedReachabilityRows}\`, \`permissionlessValuePathRows=0\`, \`liveApprovalOrEscrowRows=0\`, \`exactEconomicsRows=0\`, \`forkProofRows=0\`, \`routePositive=0\`, \`executableNow=0\`, \`signedActionJustified=false\`.`,
    "",
    "## Coverage",
    "",
    table([{
      Files: s.filesScanned,
      SourceRows: s.sourceCandidateRows,
      ArtifactRows: s.artifactCandidateRows,
      Unique: s.uniqueAddressCandidates,
      LiveChecked: s.liveCheckedRows,
      LiveCode: s.liveCodeRows,
      SelectorRows: s.selectorReachabilityRows,
      DeprecatedReachability: s.deprecatedReachabilityRows,
      OrphanCandidates: s.orphanImplementationCandidateRows,
    }], ["Files", "SourceRows", "ArtifactRows", "Unique", "LiveChecked", "LiveCode", "SelectorRows", "DeprecatedReachability", "OrphanCandidates"]),
    "",
    "## Top Inventory Rows",
    "",
    top.length ? table(top, ["Address", "Chain", "Code", "Selectors", "BalanceETH", "Role", "Terms", "Source", "Blocker"]) : "No deprecated/orphaned address inventory rows found under current bounds.",
    "",
    "## Route-Positive Gate",
    "",
    "Do not fork or build executors from this scanner unless a row is proven permissionlessly callable, reaches live approvals/escrow/protocol balances or registry-consumed accounting, has exact positive extraction economics after gas/slippage/fees, and a fork proof demonstrates net value extraction.",
    "",
    "## Artifacts",
    "",
    "- JSON: `reports/raw/fast/deprecated-orphaned-reachability.json`",
    "- Scanner: `tools/scan-deprecated-orphaned-reachability.js`",
    "- Related: `reports/router-rfq-settlement-drift-triage.md`, `reports/post-audit-deployed-map-triage.md`",
    "",
  ].join("\n");
}

async function main() {
  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  const source = collectSourceRows();
  const artifactRows = collectArtifactRows();
  const merged = mergeRows([...source.rows, ...artifactRows]).slice(0, MAX_CANDIDATES);
  const liveAnnotated = await annotateLive(merged);
  const rankedRows = rankRows(liveAnnotated);
  const topRows = rankedRows.slice(0, 40);
  const summary = {
    filesScanned: source.filesScanned,
    sourceCandidateRows: source.rows.length,
    artifactCandidateRows: artifactRows.length,
    uniqueAddressCandidates: rankedRows.length,
    chainResolvedCandidates: rankedRows.filter((row) => row.chainId).length,
    liveCheckedRows: rankedRows.filter((row) => row.liveChecked).length,
    liveCodeRows: rankedRows.filter((row) => row.codePresent === true).length,
    liveBalanceRows: rankedRows.filter((row) => (asNumber(row.balanceEth) || 0) > 0).length,
    selectorReachabilityRows: rankedRows.filter((row) => row.selectorHitCount > 0).length,
    deprecatedReachabilityRows: rankedRows.filter((row) => row.deployedReachability).length,
    orphanImplementationCandidateRows: rankedRows.filter((row) => row.orphanCandidate).length,
    permissionlessValuePathRows: 0,
    liveApprovalOrEscrowRows: 0,
    exactEconomicsRows: 0,
    forkProofRows: 0,
    watchCandidates: 0,
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
  };
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-deprecated-orphaned-reachability.js",
    scope: "Read-only local deprecated/orphaned contract inventory plus bounded live code/balance checks",
    safety: {
      rpcInventoryRead: true,
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
    thresholds: {
      maxFiles: MAX_FILES,
      maxFileBytes: MAX_FILE_BYTES,
      maxCandidates: MAX_CANDIDATES,
      maxLiveChecks: MAX_LIVE_CHECKS,
      maxLivePerChain: MAX_LIVE_PER_CHAIN,
    },
    sourceArtifacts: ARTIFACT_INPUTS,
    summary,
    topRows,
    rankedRows,
    requiredForRoutePositive: [
      "deprecated/orphaned deployed path is permissionlessly callable without trusted role compromise",
      "path reaches live approvals, escrow, protocol balances, or registry-consumed accounting",
      "exact extraction, borrow, redeem, claim, swap, or liquidation economics are positive after gas/slippage/fees",
      "fork/local proof demonstrates net value extraction",
    ],
    nextReadOnlyStep: summary.deprecatedReachabilityRows > 0
      ? "Manually inspect top code-positive deprecated rows for live approvals/escrow/registry references before any fork work."
      : "Keep as inventory; expand target-specific deprecated address lists or registry joins before treating rows as proof candidates.",
  };
  fs.writeFileSync(OUT_JSON, `${JSON.stringify(artifact, null, 2)}\n`);
  fs.writeFileSync(OUT_MD, renderReport(artifact));
  if (!QUIET) {
    console.log(`Deprecated/orphaned reachability: unique=${summary.uniqueAddressCandidates} liveCode=${summary.liveCodeRows} selectorRows=${summary.selectorReachabilityRows} deprecatedReachability=${summary.deprecatedReachabilityRows} routePositive=0`);
    console.log(`Artifact: ${rel(OUT_JSON)}`);
  }
}

main().catch((err) => {
  console.error(String(err?.message || err).replace(/https?:\/\/[^\s'"<>]+/g, "[redacted-rpc]").slice(0, 240));
  process.exitCode = 1;
});
