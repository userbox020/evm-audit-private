#!/usr/bin/env node
"use strict";

// scan-pumpbtc-full-test.js
// Defensive PumpBTC full-test scanner. Local artifacts + optional sanitized read-only RPC probes only.

const fs = require("fs");
const path = require("path");

let sharedRpc = null;
try {
  sharedRpc = require("./shared-rpc");
} catch (_error) {
  sharedRpc = null;
}

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_DIR = path.join(WORKSPACE, "reports", "raw", "fast");
const REPORTS_DIR = path.join(WORKSPACE, "reports");
const OUT_JSON = path.join(RAW_DIR, "pumpbtc-full-test.json");
const OUT_MD = path.join(REPORTS_DIR, "pumpbtc-full-test-triage.md");
const OUT_JSON_REL = "reports/raw/fast/pumpbtc-full-test.json";
const OUT_MD_REL = "reports/pumpbtc-full-test-triage.md";

const DEEP_DISCOVERY_FILE = path.join(RAW_DIR, "prefilter-deep-new-target-search-2026-06-24.json");
const PUBLIC_DISCOVERY_FILE = path.join(RAW_DIR, "public-audit-target-discovery.json");

const QUIET = process.argv.includes("--quiet");
const MAX_LOCAL_MATCH_ROWS = 320;
const MAX_LOCAL_OBJECT_ROWS = 260;
const MAX_ROWS_PER_FILE = 36;
const MAX_FILE_BYTES = 80 * 1024 * 1024;
const RPC_TIMEOUT_MS = 3_000;
const ETH_CALL_TIMEOUT_MS = 3_000;

const TARGET = {
  slug: "pumpbtc",
  name: "PumpBTC",
  category: "Bridge",
  discoveryRank: 10,
  tvlContextUsd: 43_750_969.96,
  tvlContext: "$43.751M",
  surface: "bridge-proof-custody-consumer",
  module: "pumpbtc/index.js",
  adapterAddressCountContext: 0,
  adapterHint: "bridge/custody",
  routeGraph: "custody/backing or proof state -> wrapped asset -> lending/DEX consumer -> borrow/unlock/exit",
};

const CHAIN_SEEDS = [
  { chain: "Binance", chainLabel: "BNB/BSC", chainId: 56, adapterKey: "bsc", evmAccessible: true, caveat: false },
  { chain: "Ethereum", chainLabel: "Ethereum", chainId: 1, adapterKey: "ethereum", evmAccessible: true, caveat: false },
  { chain: "Base", chainLabel: "Base", chainId: 8453, adapterKey: "base", evmAccessible: true, caveat: false },
  { chain: "Arbitrum", chainLabel: "Arbitrum", chainId: 42161, adapterKey: "arbitrum", evmAccessible: true, caveat: false },
  { chain: "Mantle", chainLabel: "Mantle", chainId: 5000, adapterKey: "mantle", evmAccessible: true, caveat: false },
  { chain: "Bitcoin", chainLabel: "Bitcoin", chainId: null, adapterKey: "bitcoin", evmAccessible: false, caveat: true },
  { chain: "Sei", chainLabel: "Sei", chainId: null, adapterKey: "sei", evmAccessible: false, caveat: true },
  { chain: "BOB", chainLabel: "BOB", chainId: null, adapterKey: "bob", evmAccessible: false, caveat: true },
];

const TOKEN_SEEDS = [
  {
    chain: "Ethereum",
    chainLabel: "Ethereum",
    chainId: 1,
    symbol: "pumpBTC",
    address: "0xF469fBD2abcd6B9de8E169d128226C0Fc90a012e",
    expectedDecimals: 8,
    source: "coingecko-listed-token/user-recon",
  },
  {
    chain: "Binance",
    chainLabel: "BNB/BSC",
    chainId: 56,
    symbol: "pumpBTC",
    address: "0xf9c4ff105803a77ecb5dae300871ad76c2794fa4",
    expectedDecimals: 8,
    source: "coingecko-listed-token/user-recon",
  },
];

const CONSUMER_CONTEXT_SEEDS = [
  { role: "compound-comet-wbtc", chainId: 1, address: "0xe85Dc543813B8c2CFEaAc371517b925a166a9293", source: "reports/raw/fast/compound-v3-phase0.json" },
  { role: "compound-pumpbtc-oracle", chainId: 1, address: "0x351a133Fd850ea81ed8a782016e308aCBADDec91", source: "reports/raw/fast/compound-v3-phase0.json" },
  { role: "curve-pumpbtc-wbtc-pool", chainId: 1, address: "0xEA659B615b48EC6e2D55cD82FCBE5F43d79aeea0", source: "reports/raw/fast/curve-dex-phase0.json" },
  { role: "euler-epumpbtc-vault", chainId: 1, address: "0x94Dc4b34948a8196Bf4fcF55c8496b11501669d2", source: "reports/raw/fast/euler-v2-phase0.json" },
  { role: "euler-epumpbtc-oracle", chainId: 1, address: "0xEb2a3f54832c09bE4A80c5f70E2816e755aFeF74", source: "reports/raw/fast/euler-v2-phase0.json" },
  { role: "morpho-pumpbtc-wbtc-oracle", chainId: 1, address: "0x427C6C90bFcbb69e0Df2e7Ac0aBeDEe7001b9EAc", source: "reports/raw/fast/near-empty-morpho-rounding.json" },
];

const WBTC_ETH = "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599";

const EXACT_TEXT_TERMS = [
  "pumpbtc",
  "pump btc",
  "pumptoken",
  "pump-token",
  "epumpbtc",
  "epumpbtc-1",
  "pump-wbtc",
  "pumpbtc/wbtc",
];

const CONTEXT_TERMS = [
  "bridge-proof-custody-consumer",
  "bridge/custody",
  "custody",
  "backing",
  "proof",
  "wrapped",
  "mint",
  "burn",
  "redeem",
  "collateral",
  "borrow",
  "lending",
  "market",
  "oracle",
  "price feed",
  "exchange rate",
  "curve",
  "pool",
  "liquidity",
  "compound",
  "comet",
  "euler",
  "morpho",
  "dolomite",
  "wbtc",
  "fbtc",
  "btcb",
];

const CATEGORY_RULES = {
  consumer: ["consumer", "accepted", "collateral", "market", "borrow", "lending", "morpho", "euler", "compound", "comet", "dolomite", "vault", "lltv", "ltv", "borrowcf", "liquidatecf", "supplycap"],
  dex: ["dex", "swap", "pool", "amm", "curve", "uniswap", "balancer", "pancake", "liquidity", "router", "quote", "wbtc", "exit liquidity"],
  oracle: ["oracle", "price", "feed", "chainlink", "pyth", "redstone", "rate", "exchange rate", "aggregator", "freshness"],
  bridgeCustody: ["bridge", "custody", "proof", "backing", "wrapper", "wrapped", "mint", "burn", "redeem", "unlock", "btcb", "fbtc", "bitcoin", "domain", "nonce"],
  token: ["erc20", "token", "symbol", "decimals", "totalsupply", "supply", "minter", "pump token", "pumptoken"],
  access: ["owner", "admin", "governance", "role", "permission", "pauser", "minter", "guardian"],
  economics: ["routepositive", "positive", "profit", "discount", "divergence", "supplyusd", "borrowusd", "cash", "liquidation", "liquidate", "supply cap", "supplycap", "liquidity", "slippage", "tvl"],
};

const JSON_FIELD_ALLOWLIST = [
  "rank", "kind", "slug", "name", "category", "tvlUsd", "change1dPct", "change7dPct",
  "chains", "primaryChain", "evmChains", "accessibleEvmChains", "accessibleNonEvmChains", "blockedOrCaveatChains",
  "surface", "routeGraph", "firstReadOnlyChecks", "audits", "module", "score",
  "chainId", "chain", "adapterChain", "market", "comet", "assetIndex", "asset", "assetSymbol", "assetName", "assetDecimals", "assetCodePresent",
  "priceFeed", "feedDescription", "feedAgeSeconds", "feedAnswerRaw", "feedTags", "scaleRaw",
  "borrowCF", "borrowCFBps", "liquidateCF", "liquidateCFBps", "liquidationFactor", "liquidationFactorBps", "liquidationFactorRaw",
  "supplyCap", "supplyCapRaw", "cometAssetBalanceRaw", "collateralReservesRaw", "cometPriceRaw",
  "assetAmount", "assetValueBase", "assetValueUsd", "collateralReserveAmount", "collateralReserveValueBase", "collateralReserveValueUsd", "supplyCapAmount",
  "externalTokenPriceUsd", "cometImpliedTokenPriceUsd", "externalDivergenceBps", "estimatedBuyDiscountBps", "estimatedBuyDiscountUsd",
  "highCF", "materialBalance", "materialBorrowCash", "staleFeedWatch", "divergenceWatch", "buyOpportunityWatch", "watchCandidate", "baseSymbol",
  "curveApi", "registry", "id", "symbol", "pool", "lpToken", "gauge", "implementation", "coinCount", "usdTotal", "usdTotalExcludingBasePool", "virtualPrice", "totalSupply", "isBroken", "isMetaPool", "usesRateOracle", "assetTypeName", "material", "yieldMatched", "rpcAvailable",
  "factory", "vault", "proxyListIndex", "discoverySource", "codePresent", "codeBytes", "implementationSource", "oracle", "unitOfAccount", "vaultSymbol", "vaultName", "vaultDecimals", "cashRaw", "totalAssetsRaw", "totalBorrowsRaw", "totalSupplyRaw", "maxDepositRaw", "maxMintRaw", "ltvListLength", "ltvRowsScanned", "ltvRowsCapped",
  "collateral", "collateralAddr", "loan", "loanAddr", "lltv", "supplyUsd", "borrowUsd", "supplyShares", "smallShares", "exchangeRate", "riskScore", "risks",
  "routePositive", "executableNow", "signedActionJustified", "forkJustified",
];

const ERC20_PROBES = [
  { name: "name", signature: "name()", selector: "0x06fdde03", decode: "string" },
  { name: "symbol", signature: "symbol()", selector: "0x95d89b41", decode: "string" },
  { name: "decimals", signature: "decimals()", selector: "0x313ce567", decode: "uint" },
  { name: "totalSupply", signature: "totalSupply()", selector: "0x18160ddd", decode: "uint" },
];

function log(...args) {
  if (!QUIET) console.log(...args);
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function rel(filePath) {
  return path.relative(WORKSPACE, filePath).replace(/\\/g, "/");
}

function safeText(value, max = 260) {
  const text = String(value ?? "")
    .replace(/[\r\n|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.slice(0, max) : null;
}

function sanitizeText(value, max = 320) {
  let text = safeText(value, max);
  if (text === null) return null;
  text = text
    .replace(/\bhttps?:\/\/[^\s"'`<>|)]+/gi, "[redacted-url]")
    .replace(/\bwww\.[^\s"'`<>|)]+/gi, "[redacted-url]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/= -]+/gi, "Bearer [redacted]")
    .replace(/\b(authorization|api[-_]?key|access[-_]?key|private[-_]?key|secret[-_]?key|secret|token|password|pwd)\s*[:=]\s*["']?[^\s"',}\]]{8,}/gi, "$1=[redacted]")
    .replace(/\b0x[0-9a-fA-F]{64}\b/g, "[redacted-hex-key]")
    .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9._-]{20,}\.[A-Za-z0-9._-]{20,}\b/g, "[redacted-jwt]");
  return text;
}

function sanitizeError(error, max = 220) {
  return sanitizeText(error?.shortMessage || error?.message || error || "call failed", max);
}

function normalizeAddress(value) {
  const raw = String(value || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) return null;
  return `0x${raw.slice(2).toLowerCase()}`;
}

function uniqBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = keyFn(item);
    if (!key) continue;
    const norm = String(key).toLowerCase();
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(item);
  }
  return out;
}

function uniq(items) {
  return uniqBy(items, (item) => item);
}

function asNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSecretLikePath(filePath) {
  const r = rel(filePath).replace(/\\/g, "/").toLowerCase();
  const base = path.basename(filePath).toLowerCase();
  if (base === ".env" || base.startsWith(".env.")) return true;
  if (base === "rpc_endpoints.txt" || base === "graphql_endpoints.txt") return true;
  if (/\.(pem|key|p12|pfx)$/i.test(base)) return true;
  if (/(^|[\/\\])(private|secret|mnemonic|seed|wallet|keypair|api[-_]?key|access[-_]?key)([\/\\._-]|$)/i.test(r)) return true;
  return false;
}

function isExcludedScanPath(filePath) {
  const r = rel(filePath).toLowerCase();
  const own = [OUT_JSON_REL, OUT_MD_REL].map((p) => p.toLowerCase());
  if (own.includes(r)) return true;
  if (isSecretLikePath(filePath)) return true;
  if (r.includes("/node_modules/") || r.includes("/.git/")) return true;
  if (r.includes("/cache/") || r.includes("/out/") || r.includes("/broadcast/")) return true;
  if (r.startsWith("coordination/claims/") || r.startsWith("coordination/archive/") || r.startsWith("coordination/handoffs/")) return true;
  if (/(?:handoff|shared_context|state|audit-completion-gates|route-positive-sweep|low-fund-executable-route-filter|exploit-findings-summary|full-test)/i.test(r)) return true;
  return false;
}

function readText(filePath) {
  try {
    if (isSecretLikePath(filePath)) return null;
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    return fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  } catch (_error) {
    return null;
  }
}

function readJson(filePath, fallback = null) {
  const text = readText(filePath);
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch (_error) {
    return fallback;
  }
}

function writeJson(filePath, value) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(value, jsonReplacer, 2)}\n`, "utf8");
}

const PUMP_TOKEN_ADDRESS_TERMS = uniq(TOKEN_SEEDS.map((row) => normalizeAddress(row.address)).filter(Boolean));
const CONTEXT_ADDRESS_TERMS = uniq(CONSUMER_CONTEXT_SEEDS.map((row) => normalizeAddress(row.address)).filter(Boolean));
const EXACT_ADDRESS_TERMS = PUMP_TOKEN_ADDRESS_TERMS;

function lowerContainsAny(haystack, terms) {
  return terms.some((term) => haystack.includes(String(term).toLowerCase()));
}

function findFirstTerm(haystack, terms) {
  for (const term of terms) {
    const needle = String(term).toLowerCase();
    if (needle && haystack.includes(needle)) return term;
  }
  return null;
}

function hasPumpContext(text) {
  const lower = String(text || "").toLowerCase();
  return lowerContainsAny(lower, EXACT_TEXT_TERMS) || lowerContainsAny(lower, PUMP_TOKEN_ADDRESS_TERMS);
}

function categoriesFor(text, filePath = "") {
  const hay = `${filePath} ${String(text || "")}`.toLowerCase();
  const categories = [];
  for (const [category, terms] of Object.entries(CATEGORY_RULES)) {
    if (terms.some((term) => hay.includes(term.toLowerCase()))) categories.push(category);
  }
  return categories.length ? categories : ["context"];
}

function listFilesRecursive(rootDir) {
  const out = [];
  if (!fs.existsSync(rootDir)) return out;
  function walk(dir) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_error) {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const relLower = rel(full).toLowerCase();
      if (entry.isDirectory()) {
        if (/\b(node_modules|\.git|cache|out|broadcast|artifacts|lib)\b/i.test(entry.name)) continue;
        if (relLower.startsWith("coordination/claims/") || relLower.startsWith("coordination/archive/") || relLower.startsWith("coordination/handoffs/")) continue;
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!/\.(json|md|txt|js|ts|sol|yaml|yml|toml|csv)$/i.test(entry.name)) continue;
      if (isExcludedScanPath(full)) continue;
      out.push(full);
    }
  }
  walk(rootDir);
  return out;
}

function listScanFiles() {
  const roots = [
    path.join(WORKSPACE, "reports"),
    path.join(WORKSPACE, "targets", "compound-comet", "deployments", "mainnet", "wbtc"),
  ];
  return uniqBy(roots.flatMap(listFilesRecursive), (file) => path.resolve(file)).sort((a, b) => rel(a).localeCompare(rel(b)));
}

function countOccurrences(text, term) {
  if (!text || !term) return 0;
  let count = 0;
  let cursor = 0;
  const needle = String(term).toLowerCase();
  while (true) {
    const pos = text.indexOf(needle, cursor);
    if (pos < 0) break;
    count += 1;
    cursor = pos + needle.length;
  }
  return count;
}

function scanLocalArtifactLines(files) {
  const rows = [];
  let filesScanned = 0;
  let filesWithMatch = 0;
  let filesWithExact = 0;
  const categoryCounts = {};
  const allTerms = uniq([...EXACT_TEXT_TERMS, ...EXACT_ADDRESS_TERMS, ...CONTEXT_ADDRESS_TERMS, ...CONTEXT_TERMS.map((x) => x.toLowerCase())]);

  for (const file of files) {
    const text = readText(file);
    if (!text) continue;
    filesScanned += 1;
    const lower = text.toLowerCase();
    if (!lowerContainsAny(lower, allTerms)) continue;
    const lines = text.split(/\r?\n/);
    let sampled = 0;
    let fileMatched = false;
    let fileExact = false;
    const seen = new Set();
    for (let i = 0; i < lines.length && rows.length < MAX_LOCAL_MATCH_ROWS && sampled < MAX_ROWS_PER_FILE; i += 1) {
      const line = String(lines[i] || "");
      const lineLower = line.toLowerCase();
      if (!lineLower.trim()) continue;
      const window = [lines[i - 2], lines[i - 1], lines[i], lines[i + 1], lines[i + 2]].map((x) => String(x || "")).join(" ");
      const windowLower = window.toLowerCase();
      const exactAddress = findFirstTerm(lineLower, EXACT_ADDRESS_TERMS);
      const exactText = findFirstTerm(lineLower, EXACT_TEXT_TERMS);
      const contextAddress = hasPumpContext(windowLower) ? findFirstTerm(lineLower, CONTEXT_ADDRESS_TERMS) : null;
      const contextTerm = hasPumpContext(windowLower) ? findFirstTerm(lineLower, CONTEXT_TERMS) : null;
      if (!exactAddress && !exactText && !contextAddress && !contextTerm) continue;
      const matchType = exactAddress ? "exact-address" : exactText ? "exact-name" : contextAddress ? "context-address" : "context";
      const term = exactAddress || exactText || contextAddress || contextTerm;
      const categories = categoriesFor(windowLower, rel(file));
      const key = `${rel(file)}:${i + 1}:${matchType}:${term}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fileMatched = true;
      if (matchType !== "context") fileExact = true;
      for (const category of categories) categoryCounts[category] = (categoryCounts[category] || 0) + 1;
      rows.push({
        file: rel(file),
        line: i + 1,
        matchType,
        termType: exactAddress ? "address" : "text",
        matched: sanitizeText(term, 120),
        count: countOccurrences(lineLower, term),
        categories,
        sample: sanitizeText(window, 420),
        classification: "local-artifact-watch-only-not-route-positive",
      });
      sampled += 1;
    }
    if (fileMatched) filesWithMatch += 1;
    if (fileExact) filesWithExact += 1;
    if (rows.length >= MAX_LOCAL_MATCH_ROWS) break;
  }

  return {
    filesScanned,
    filesWithMatch,
    filesWithExact,
    rows,
    exactRows: rows.filter((row) => row.matchType === "exact-address" || row.matchType === "exact-name"),
    contextRows: rows.filter((row) => row.matchType === "context"),
    categoryCounts,
  };
}

function primitiveBlob(value, jsonPath) {
  const parts = [jsonPath];
  if (!isObject(value)) return parts.join(" ");
  for (const [key, val] of Object.entries(value)) {
    if (val === null || val === undefined) continue;
    if (["string", "number", "boolean"].includes(typeof val)) parts.push(key, String(val));
    else if (Array.isArray(val) && val.every((item) => item === null || ["string", "number", "boolean"].includes(typeof item))) {
      parts.push(key, val.slice(0, 20).join(" "));
    }
  }
  return parts.join(" ");
}

function compactValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (["string", "number", "boolean"].includes(typeof value)) return typeof value === "string" ? sanitizeText(value, 220) : value;
  if (Array.isArray(value)) {
    return value.slice(0, 12).map((item) => compactValue(item)).filter((item) => item !== null);
  }
  if (isObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 16)) {
      if (k.toLowerCase().includes("url")) continue;
      const compacted = compactValue(v);
      if (compacted !== null) out[k] = compacted;
    }
    return out;
  }
  return sanitizeText(String(value), 220);
}

function extractFields(value, jsonPath = "") {
  const fields = {};
  if (!isObject(value)) return fields;
  for (const field of JSON_FIELD_ALLOWLIST) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) continue;
    const compacted = compactValue(value[field]);
    if (compacted !== null && !(Array.isArray(compacted) && compacted.length === 0)) fields[field] = compacted;
  }
  if (isObject(value.adapter)) {
    fields.adapterModule = compactValue(value.adapter.module);
    fields.adapterFetched = compactValue(value.adapter.adapterFetched);
    fields.adapterAddressCount = compactValue(value.adapter.adapterAddressCount);
    fields.adapterHints = compactValue(value.adapter.adapterHints);
    fields.adapterAddressSamples = compactValue(value.adapter.adapterAddressSamples);
  }
  if (isObject(value.coverage)) {
    fields.coverageState = compactValue(value.coverage.state);
    fields.coverageMatchCount = compactValue(value.coverage.matchCount);
    fields.coverageProcessed = compactValue(value.coverage.processed);
  }
  if (isObject(value.routeGate)) {
    fields.routeGateStatus = compactValue(value.routeGate.status);
    fields.exactAccountingBypass = compactValue(value.routeGate.exactAccountingBypass);
    fields.exactBorrowExitRoute = compactValue(value.routeGate.exactBorrowExitRoute);
    fields.exactEconomicsPositive = compactValue(value.routeGate.exactEconomicsPositive);
    fields.forkProof = compactValue(value.routeGate.forkProof);
  }
  if (Array.isArray(value.coins)) {
    fields.coins = value.coins.slice(0, 8).map((coin) => ({
      index: coin?.index ?? null,
      symbol: sanitizeText(coin?.symbol, 80),
      address: normalizeAddress(coin?.address) || sanitizeText(coin?.address, 80),
      decimals: coin?.decimals ?? null,
      usdPrice: coin?.usdPrice ?? null,
    }));
  }
  if (jsonPath.toLowerCase().includes("assets.pumpbtc")) {
    fields.configAssetKey = "pumpBTC";
  }
  return fields;
}

function fieldsContext(fields) {
  const parts = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined) continue;
    let rendered;
    if (typeof value === "object") rendered = JSON.stringify(value, jsonReplacer).slice(0, 180);
    else rendered = String(value);
    parts.push(`${key}=${rendered}`);
    if (parts.join("; ").length > 620) break;
  }
  return sanitizeText(parts.join("; "), 700);
}

function findLineForTerms(lines, terms) {
  const needles = uniq(terms.map((term) => String(term || "").toLowerCase()).filter(Boolean));
  if (!needles.length) return null;
  for (const term of needles) {
    for (let i = 0; i < lines.length; i += 1) {
      const line = String(lines[i] || "").toLowerCase();
      if (line.includes(term)) return i + 1;
    }
  }
  return null;
}

function objectMatch(value, jsonPath) {
  const blob = primitiveBlob(value, jsonPath).toLowerCase();
  const exactAddress = findFirstTerm(blob, EXACT_ADDRESS_TERMS);
  const exactText = findFirstTerm(blob, EXACT_TEXT_TERMS);
  const contextAddress = hasPumpContext(blob) ? findFirstTerm(blob, CONTEXT_ADDRESS_TERMS) : null;
  const contextTerm = hasPumpContext(blob) ? findFirstTerm(blob, CONTEXT_TERMS) : null;
  if (exactAddress) return { matchType: "exact-address", matched: exactAddress };
  if (exactText) return { matchType: "exact-name", matched: exactText };
  if (contextAddress) return { matchType: "context-address", matched: contextAddress };
  if (contextTerm) return { matchType: "context", matched: contextTerm };
  return null;
}

function collectJsonObjectRows(files) {
  const rows = [];
  const seen = new Set();
  let jsonFilesParsed = 0;
  const allNeedles = uniq([...EXACT_TEXT_TERMS, ...EXACT_ADDRESS_TERMS, ...CONTEXT_ADDRESS_TERMS]);

  function addRow(row) {
    const key = `${row.file}:${row.jsonPath}:${row.matchType}:${row.context}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push(row);
  }

  for (const file of files.filter((candidate) => candidate.toLowerCase().endsWith(".json"))) {
    if (rows.length >= MAX_LOCAL_OBJECT_ROWS) break;
    const text = readText(file);
    if (!text) continue;
    const lower = text.toLowerCase();
    if (!lowerContainsAny(lower, allNeedles)) continue;
    let data;
    try {
      data = JSON.parse(text);
    } catch (_error) {
      continue;
    }
    jsonFilesParsed += 1;
    const lines = text.split(/\r?\n/);

    function visit(value, jsonPath, depth = 0) {
      if (rows.length >= MAX_LOCAL_OBJECT_ROWS || depth > 12 || value === null || value === undefined) return;
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length && rows.length < MAX_LOCAL_OBJECT_ROWS; i += 1) visit(value[i], `${jsonPath}[${i}]`, depth + 1);
        return;
      }
      if (!isObject(value)) return;
      const match = objectMatch(value, jsonPath);
      if (match) {
        const fields = extractFields(value, jsonPath);
        const context = fieldsContext(fields) || sanitizeText(primitiveBlob(value, jsonPath), 700);
        const categoryBlob = `${jsonPath} ${context} ${primitiveBlob(value, jsonPath)}`;
        const categories = categoriesFor(categoryBlob, rel(file));
        const termsForLine = [fields.asset, fields.collateralAddr, fields.pool, fields.vault, fields.name, fields.assetSymbol, fields.vaultSymbol, fields.collateral, fields.configAssetKey, match.matched, fields.oracle].filter(Boolean);
        addRow({
          file: rel(file),
          line: findLineForTerms(lines, termsForLine),
          jsonPath,
          matchType: match.matchType,
          matched: sanitizeText(match.matched, 120),
          categories,
          fields,
          context,
          routePositive: value.routePositive ?? fields.routePositive ?? null,
          executableNow: value.executableNow ?? fields.executableNow ?? null,
          signedActionJustified: value.signedActionJustified ?? fields.signedActionJustified ?? null,
          exactEconomicsPositive: value.routeGate?.exactEconomicsPositive ?? fields.exactEconomicsPositive ?? null,
          classification: "exact-local-watch-context-only-no-positive-economics",
        });
      }
      for (const [key, child] of Object.entries(value)) {
        if (child && typeof child === "object") visit(child, `${jsonPath}.${key}`, depth + 1);
        if (rows.length >= MAX_LOCAL_OBJECT_ROWS) break;
      }
    }

    visit(data, "$", 0);
  }

  const exactRows = rows.filter((row) => row.matchType === "exact-address" || row.matchType === "exact-name");
  return { rows, exactRows, jsonFilesParsed };
}

function findRowsBySlug(data, slug, max = 8) {
  const out = [];
  const seen = new Set();
  function visit(value, depth = 0) {
    if (out.length >= max || depth > 10 || value === null || value === undefined) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (!isObject(value)) return;
    if (String(value.slug || "").toLowerCase() === slug) {
      const key = JSON.stringify({ slug: value.slug, name: value.name, rank: value.rank, tvlUsd: value.tvlUsd, module: value.module || value.adapter?.module });
      if (!seen.has(key)) {
        seen.add(key);
        out.push(value);
      }
    }
    for (const child of Object.values(value)) visit(child, depth + 1);
  }
  visit(data, 0);
  return out;
}

function sanitizeDiscoveryRow(row, source, sourceKind) {
  if (!row) return null;
  return {
    source,
    sourceKind,
    rank: row.rank ?? null,
    kind: row.kind ?? null,
    slug: row.slug || null,
    name: row.name || null,
    category: row.category || null,
    surface: row.surface || null,
    routeGraph: row.routeGraph || null,
    tvlUsd: asNumber(row.tvlUsd ?? row.tvl) ?? null,
    chains: Array.isArray(row.chains) ? row.chains : [],
    primaryChain: row.primaryChain || null,
    accessibleEvmChains: Array.isArray(row.accessibleEvmChains) ? row.accessibleEvmChains : Array.isArray(row.evmChains) ? row.evmChains : [],
    accessibleNonEvmChains: Array.isArray(row.accessibleNonEvmChains) ? row.accessibleNonEvmChains : [],
    blockedOrCaveatChains: Array.isArray(row.blockedOrCaveatChains) ? row.blockedOrCaveatChains : [],
    firstReadOnlyChecks: Array.isArray(row.firstReadOnlyChecks) ? row.firstReadOnlyChecks : [],
    module: row.adapter?.module || row.module || null,
    adapterFetched: row.adapter?.adapterFetched ?? null,
    adapterAddressCount: asNumber(row.adapter?.adapterAddressCount) ?? null,
    adapterHints: Array.isArray(row.adapter?.adapterHints) ? row.adapter.adapterHints : [],
    adapterAddressSamples: Array.isArray(row.adapter?.adapterAddressSamples) ? row.adapter.adapterAddressSamples.map(normalizeAddress).filter(Boolean) : [],
    routePositive: asNumber(row.routePositive) ?? 0,
    executableNow: asNumber(row.executableNow) ?? 0,
    signedActionJustified: Boolean(row.signedActionJustified),
    forkJustified: Boolean(row.forkJustified),
  };
}

function loadSourceFacts() {
  const facts = [];
  const deep = readJson(DEEP_DISCOVERY_FILE, null);
  for (const row of findRowsBySlug(deep, TARGET.slug, 6)) {
    const sanitized = sanitizeDiscoveryRow(row, rel(DEEP_DISCOVERY_FILE), "local-prefilter-deep-discovery");
    if (sanitized) facts.push(sanitized);
  }
  const publicDiscovery = readJson(PUBLIC_DISCOVERY_FILE, null);
  for (const row of findRowsBySlug(publicDiscovery, TARGET.slug, 4)) {
    const sanitized = sanitizeDiscoveryRow(row, rel(PUBLIC_DISCOVERY_FILE), "local-public-audit-target-discovery");
    if (sanitized) facts.push(sanitized);
  }
  facts.push(
    {
      source: "user-recon-public-context",
      sourceKind: "official-repo-summary",
      fact: "pumpbtc/pumpBTC-contract includes PumpToken with 8 decimals, owner-controlled minter mapping, PumpStaking, and OFT bridge contracts.",
      classification: "public-context-watch-only",
    },
    {
      source: "user-recon-public-context",
      sourceKind: "token-addresses",
      fact: "CoinGecko-listed pumpBTC token addresses supplied for Ethereum and BNB/BSC.",
      tokens: TOKEN_SEEDS.map((row) => ({ chain: row.chainLabel, chainId: row.chainId, symbol: row.symbol, address: normalizeAddress(row.address), expectedDecimals: row.expectedDecimals })),
      classification: "seed-addresses-only",
    },
    {
      source: "user-recon-public-context",
      sourceKind: "defillama-adapter-context",
      fact: "DefiLlama adapter context uses dashboard token owner/custody data and backing WBTC/FBTC/BTCB across bitcoin/ethereum/bsc/mantle/base/arbitrum/bob/sei; adapter is double-counted/heavy.",
      classification: "bridge-custody-context-only",
    },
  );
  return uniqBy(facts, (row) => `${row.source}:${row.sourceKind}:${row.slug || row.fact || row.tvlUsd}`);
}

function pickRows(rows, predicate, max = 80) {
  return rows.filter(predicate).slice(0, max);
}

function exactish(row) {
  return row.matchType === "exact-address" || row.matchType === "exact-name";
}

function selectNotableRows(rows) {
  const wanted = [
    { id: "compound-phase0", re: /reports\/raw\/fast\/compound-v3-phase0\.json/i },
    { id: "compound-config", re: /targets\/compound-comet\/deployments\/mainnet\/wbtc\/configuration\.json/i },
    { id: "curve", re: /reports\/raw\/fast\/curve-dex-phase0\.json/i },
    { id: "euler", re: /reports\/raw\/fast\/euler-v2-phase0\.json/i },
    { id: "morpho", re: /reports\/raw\/fast\/near-empty-morpho-rounding\.json/i },
  ];
  const pumpSpecific = (row) => hasPumpContext(`${row.matched || ""} ${row.context || ""} ${JSON.stringify(row.fields || {}, jsonReplacer)}`);
  const out = [];
  for (const item of wanted) {
    const row = rows.find((candidate) => item.re.test(candidate.file) && exactish(candidate) && pumpSpecific(candidate))
      || rows.find((candidate) => item.re.test(candidate.file) && pumpSpecific(candidate))
      || rows.find((candidate) => item.re.test(candidate.file) && exactish(candidate));
    if (row) out.push({ sourceId: item.id, ...row });
  }
  for (const row of rows) {
    if (out.length >= 18) break;
    if (!exactish(row)) continue;
    if (out.some((existing) => existing.file === row.file && existing.jsonPath === row.jsonPath)) continue;
    if (/dolomite|curve|compound|euler|morpho|oracle|custody|bridge/i.test(`${row.file} ${row.context}`)) out.push({ sourceId: "additional-local", ...row });
  }
  return out;
}

function hexPayload(raw) {
  return String(raw || "").replace(/^0x/, "").toLowerCase();
}

function toBigIntFromHex(raw) {
  const clean = hexPayload(raw);
  if (!clean) return null;
  try {
    return BigInt(`0x${clean}`);
  } catch (_error) {
    return null;
  }
}

function decodeAbiString(raw) {
  if (!raw || raw === "0x") return null;
  const hex = hexPayload(raw);
  if (!hex) return null;
  if (hex.length <= 64) {
    try {
      return Buffer.from(hex, "hex").toString("utf8").replace(/\u0000+$/g, "").trim() || null;
    } catch (_error) {
      return null;
    }
  }
  try {
    const offset = Number(BigInt(`0x${hex.slice(0, 64)}`));
    if (!Number.isFinite(offset) || offset < 32) return null;
    const lenStart = offset * 2;
    if (lenStart + 64 > hex.length) return null;
    const length = Number(BigInt(`0x${hex.slice(lenStart, lenStart + 64)}`));
    const dataStart = lenStart + 64;
    const dataHex = hex.slice(dataStart, dataStart + length * 2);
    if (dataHex.length < length * 2) return null;
    return Buffer.from(dataHex, "hex").toString("utf8");
  } catch (_error) {
    return null;
  }
}

function decodeProbeResult(probe, raw) {
  if (!raw || raw === "0x") return null;
  if (probe.decode === "string") return sanitizeText(decodeAbiString(raw) || raw, 180);
  if (probe.decode === "uint") {
    const value = toBigIntFromHex(raw);
    return value === null ? null : value.toString();
  }
  return sanitizeText(raw, 180);
}

function rpcCallClassification(resp) {
  if (!resp) return { ok: false, status: "unknown", transportOk: false, rpcError: "no-response" };
  if (resp.ok) return { ok: true, status: "ok", transportOk: true, rpcError: null };
  const err = sanitizeText(resp.error || "rpc-error", 180);
  if (!resp.transport) return { ok: false, status: err || "transport-error", transportOk: false, rpcError: err };
  return { ok: false, status: err || "rpc-error", transportOk: true, rpcError: err };
}

async function rpcPost(url, method, params, timeoutMs = RPC_TIMEOUT_MS) {
  if (!url) return { ok: false, transport: false, error: "no-rpc-url" };
  if (typeof fetch !== "function") return { ok: false, transport: false, error: "fetch-unavailable" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = { "content-type": "application/json" };
  try {
    const origin = sharedRpc?.getOrigin ? sharedRpc.getOrigin(url) : null;
    if (origin) headers.origin = origin;
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (_error) {
      json = null;
    }
    if (!res.ok) return { ok: false, status: res.status, transport: true, error: `http-${res.status}` };
    if (!json) return { ok: false, status: res.status, transport: true, error: "invalid-json" };
    if (json.error && !("result" in json)) return { ok: false, status: res.status, transport: true, error: sanitizeText(json.error.message || json.error.code || "rpc-error", 180) };
    return { ok: true, status: res.status, transport: true, result: json.result ?? null };
  } catch (error) {
    return { ok: false, status: 0, transport: false, error: error?.name === "AbortError" ? "timeout" : sanitizeError(error, 80) || "network" };
  } finally {
    clearTimeout(timer);
  }
}

async function probeChainState(chainSeed, rpcUrl, rpcInventoryRows) {
  const row = {
    chain: chainSeed.chain,
    chainLabel: chainSeed.chainLabel,
    chainId: chainSeed.chainId,
    rpcInventoryRows,
    rpcResolved: false,
    rpcSource: "none",
    rpcStatus: "not-probed",
    chainIdObserved: null,
    chainIdMatch: null,
    blockNumber: null,
    blockNumberHex: null,
    blockStatus: "not-probed",
    rpcError: null,
    _rpcUrl: rpcUrl || null,
  };
  if (!Number.isFinite(chainSeed.chainId)) {
    row.rpcStatus = "no-evm-chain-id";
    return row;
  }
  if (!rpcUrl) {
    row.rpcStatus = "unresolved";
    return row;
  }
  row.rpcResolved = true;
  row.rpcSource = "shared-rpc-helper-or-public-fallback";
  const chainResp = await rpcPost(rpcUrl, "eth_chainId", [], RPC_TIMEOUT_MS);
  const chainClass = rpcCallClassification(chainResp);
  if (!chainClass.ok) {
    row.rpcStatus = chainClass.status;
    row.rpcError = chainClass.rpcError;
    return row;
  }
  row.rpcStatus = "ready";
  const observed = toBigIntFromHex(chainResp.result);
  if (observed !== null) {
    row.chainIdObserved = Number(observed);
    row.chainIdMatch = row.chainIdObserved === chainSeed.chainId;
  }
  const blockResp = await rpcPost(rpcUrl, "eth_blockNumber", [], RPC_TIMEOUT_MS);
  const blockClass = rpcCallClassification(blockResp);
  if (blockClass.ok && blockResp.result) {
    row.blockStatus = "ok";
    row.blockNumberHex = String(blockResp.result);
    const block = toBigIntFromHex(blockResp.result);
    row.blockNumber = block === null ? null : block.toString();
  } else {
    row.blockStatus = blockClass.status;
  }
  return row;
}

function sanitizeChainProbe(row) {
  return {
    chain: row.chain,
    chainLabel: row.chainLabel,
    chainId: row.chainId,
    rpcInventoryRows: row.rpcInventoryRows,
    rpcResolved: row.rpcResolved,
    rpcSource: row.rpcSource,
    rpcStatus: row.rpcStatus,
    chainIdObserved: row.chainIdObserved,
    chainIdMatch: row.chainIdMatch,
    blockNumber: row.blockNumber,
    blockNumberHex: row.blockNumberHex,
    blockStatus: row.blockStatus,
    rpcError: row.rpcError,
  };
}

async function probeToken(seed, chainProbe) {
  const row = {
    chain: seed.chain,
    chainLabel: seed.chainLabel,
    chainId: seed.chainId,
    blockNumber: chainProbe.blockNumber,
    symbolExpected: seed.symbol,
    expectedDecimals: seed.expectedDecimals,
    address: normalizeAddress(seed.address) || seed.address,
    source: seed.source,
    rpcStatus: chainProbe.rpcStatus,
    codePresent: false,
    codeBytes: null,
    codeStatus: "not-probed",
    selectorResults: [],
    name: null,
    symbol: null,
    decimals: null,
    totalSupplyRaw: null,
    classification: "metadata-only-not-route-positive",
  };
  if (!chainProbe.rpcResolved || chainProbe.rpcStatus !== "ready" || !chainProbe._rpcUrl) {
    row.codeStatus = "no-rpc";
    return row;
  }
  const codeResp = await rpcPost(chainProbe._rpcUrl, "eth_getCode", [row.address, "latest"], RPC_TIMEOUT_MS);
  const codeClass = rpcCallClassification(codeResp);
  if (!codeClass.ok) {
    row.codeStatus = codeClass.status;
  } else {
    const codeHex = codeResp.result || "0x";
    const codeBytes = Math.max(0, Math.floor(hexPayload(codeHex).length / 2));
    row.codePresent = codeHex !== "0x" && codeBytes > 0;
    row.codeBytes = codeBytes;
    row.codeStatus = row.codePresent ? "present" : "empty";
  }
  if (!row.codePresent) return row;

  for (const probe of ERC20_PROBES) {
    const callResp = await rpcPost(chainProbe._rpcUrl, "eth_call", [{ to: row.address, data: probe.selector }, "latest"], ETH_CALL_TIMEOUT_MS);
    const cls = rpcCallClassification(callResp);
    const decoded = cls.ok ? decodeProbeResult(probe, callResp.result) : null;
    const resultRow = {
      chain: row.chainLabel,
      chainId: row.chainId,
      address: row.address,
      blockNumber: row.blockNumber,
      name: probe.name,
      signature: probe.signature,
      selector: probe.selector,
      success: cls.ok && decoded !== null,
      status: cls.ok ? "ok" : cls.status,
      result: decoded,
      errorSnippet: cls.ok ? null : sanitizeText(cls.rpcError || cls.status, 160),
      classification: "read-only-erc20-metadata-probe",
    };
    row.selectorResults.push(resultRow);
    if (resultRow.success) {
      if (probe.name === "name") row.name = decoded;
      if (probe.name === "symbol") row.symbol = decoded;
      if (probe.name === "decimals") row.decimals = Number(decoded);
      if (probe.name === "totalSupply") row.totalSupplyRaw = decoded;
    }
  }
  return row;
}

async function runLiveProbes() {
  const rpcInventorySkipped = process.env.PUMPBTC_SKIP_RPC_INVENTORY === "1";
  const rpcInventoryRows = [];
  let rpcInventoryRead = false;
  let rpcInventoryError = null;
  if (!rpcInventorySkipped && sharedRpc?.loadRpcUrls) {
    try {
      const loaded = sharedRpc.loadRpcUrls();
      if (Array.isArray(loaded)) rpcInventoryRows.push(...loaded);
      rpcInventoryRead = true;
    } catch (error) {
      rpcInventoryRead = true;
      rpcInventoryError = sanitizeError(error);
    }
  }
  const evmProbeSeeds = TOKEN_SEEDS.map((seed) => CHAIN_SEEDS.find((chain) => chain.chainId === seed.chainId) || seed);
  let pool = {};
  if (sharedRpc?.PUBLIC_FALLBACKS) {
    for (const chainId of uniq(evmProbeSeeds.map((seed) => seed.chainId).filter(Number.isFinite))) {
      if (sharedRpc.PUBLIC_FALLBACKS[chainId]) pool[chainId] = sharedRpc.PUBLIC_FALLBACKS[chainId];
    }
  }
  const chainProbeMap = new Map();
  for (const chainSeed of evmProbeSeeds) {
    const chainProbe = await probeChainState(chainSeed, pool[chainSeed.chainId] || null, rpcInventoryRows.length);
    chainProbeMap.set(chainSeed.chainId, chainProbe);
  }
  const liveProbeRows = [];
  for (const tokenSeed of TOKEN_SEEDS) {
    const chainProbe = chainProbeMap.get(tokenSeed.chainId) || { rpcResolved: false, rpcStatus: "missing-chain-probe", blockNumber: null, _rpcUrl: null };
    liveProbeRows.push(await probeToken(tokenSeed, chainProbe));
  }
  const chainProbes = [...chainProbeMap.values()];
  const selectorProbeRows = liveProbeRows.flatMap((row) => row.selectorResults || []);
  const rpcBlockedRows = [
    ...chainProbes.filter((row) => row.rpcStatus !== "ready").map(sanitizeChainProbe),
    ...liveProbeRows.filter((row) => row.codeStatus === "no-rpc" || row.rpcStatus !== "ready").map((row) => ({ chain: row.chainLabel, chainId: row.chainId, address: row.address, rpcStatus: row.rpcStatus, codeStatus: row.codeStatus })),
  ];
  return {
    rpcInventorySkipped,
    rpcInventoryRead,
    rpcInventoryRows: rpcInventoryRows.length,
    rpcInventoryError,
    chainProbes,
    liveProbeRows,
    selectorProbeRows,
    rpcBlockedRows,
  };
}

function buildPayload({ generatedAt, sourceFacts, lineScan, objectScan, live }) {
  const objectRows = objectScan.rows;
  const exactObjectRows = objectScan.exactRows;
  const consumerJoinRows = pickRows(objectRows, (row) => row.categories.includes("consumer"), 120);
  const exactConsumerJoinRows = pickRows(consumerJoinRows, exactish, 100);
  const dexLiquidityRows = pickRows(objectRows, (row) => row.categories.includes("dex"), 100);
  const oracleRows = pickRows(objectRows, (row) => row.categories.includes("oracle"), 100);
  const bridgeCustodyContextRows = pickRows(objectRows, (row) => row.categories.includes("bridgeCustody"), 100);
  const exactLocalRows = uniqBy([...exactObjectRows, ...lineScan.exactRows], (row) => `${row.file}:${row.line || row.jsonPath}:${row.matchType}:${row.matched || row.context}`);
  const notableExactRows = selectNotableRows(objectRows);
  const selectorProbeSuccessRows = live.selectorProbeRows.filter((row) => row.success).length;
  const codePresentRows = live.liveProbeRows.filter((row) => row.codePresent).length;
  const routePositive = 0;
  const executableNow = 0;
  const signedActionJustified = false;
  const forkJustified = false;
  const forkGate = "closed-route-positive-zero";
  const exactEconomicsRows = 0;

  const blockers = [
    "No exact-positive PumpBTC producer->consumer->exit route is proven in local artifacts; all high-signal rows are watch/context only.",
    "Compound WBTC market rows show pumpBTC collateral/oracle configuration but routePositive=false and no material positive borrow/unwind economics in the local phase0 artifact.",
    "Curve pumpBTC/WBTC liquidity is local DEX context only; no attacker-favorable acquisition, manipulation, or exit-profit route was quantified.",
    "Euler epumpBTC vault row has zero cash/assets/borrows/supply in the local artifact, so it does not prove a material consumer route.",
    "Morpho pumpBTC/WBTC near-empty row is a watch candidate with borrowUsd=0 and routeGate exactEconomicsPositive=false/forkProof=false.",
    "Bridge/custody/backing proof, owner-controlled minter mapping, OFT bridge roles, domain/nonce/token/recipient binding, and custody attestations are unresolved route gates.",
    "Read-only ERC20/code probes, if available, are metadata availability checks only and do not justify signed actions or fork execution.",
    "Fork and signed-action gates remain closed because routePositive=0 and exactEconomicsRows=0.",
  ];

  const requiredForRoutePositive = [
    "Authoritative bridge/custody contract map with verified source/ABI, minter/owner/role graph, and no role/allowlist/pause blockers.",
    "Exact proof/backing invariant that can be violated permissionlessly, including domain, nonce, token, recipient, replay, and custody-balance checks.",
    "Material consumer join with current accepted collateral state, caps, cash/borrow liquidity, oracle freshness/scaling, and no zero-supply/zero-borrow blocker.",
    "Concrete acquisition and unwind path through DEX/CEX/on-chain liquidity with slippage, fees, oracle impact, liquidation penalties, and gas included.",
    "Local static/fork value-delta proof showing attacker-controlled positive balance movement before any live preflight.",
    "Independent defensive review and explicit route-specific authorization before any signed transaction consideration.",
  ];

  const caveatChains = uniq([
    ...CHAIN_SEEDS.filter((row) => row.caveat).map((row) => row.chainLabel),
    ...sourceFacts.flatMap((row) => Array.isArray(row.blockedOrCaveatChains) ? row.blockedOrCaveatChains : []),
  ]);

  const summary = {
    sourceFactRows: sourceFacts.length,
    chainSeedRows: CHAIN_SEEDS.length,
    tokenSeedRows: TOKEN_SEEDS.length,
    consumerContextSeedRows: CONSUMER_CONTEXT_SEEDS.length,
    filesScanned: lineScan.filesScanned,
    filesWithLocalMatches: lineScan.filesWithMatch,
    filesWithExactLocalMatches: lineScan.filesWithExact,
    localArtifactMatchRows: lineScan.rows.length,
    exactLocalArtifactMatchRows: lineScan.exactRows.length,
    localObjectRows: objectRows.length,
    exactLocalObjectRows: exactObjectRows.length,
    jsonFilesParsed: objectScan.jsonFilesParsed,
    consumerJoinRows: consumerJoinRows.length,
    exactConsumerJoinRows: exactConsumerJoinRows.length,
    dexLiquidityRows: dexLiquidityRows.length,
    oracleRows: oracleRows.length,
    bridgeCustodyContextRows: bridgeCustodyContextRows.length,
    liveProbeRows: live.liveProbeRows.length,
    codePresentRows,
    selectorProbeRows: live.selectorProbeRows.length,
    selectorProbeSuccessRows,
    rpcBlockedRows: live.rpcBlockedRows.length,
    rpcInventorySkipped: live.rpcInventorySkipped,
    rpcInventoryRows: live.rpcInventoryRows,
    rpcInventoryRead: live.rpcInventoryRead,
    exactEconomicsRows,
    routePositive,
    executableNow,
    signedActionJustified,
    forkJustified,
    forkGate,
    caveatChains,
  };

  return {
    generatedAt,
    scanner: "tools/scan-pumpbtc-full-test.js",
    target: TARGET,
    scope: {
      kind: "defensive route-first full-test scanner",
      evmFirst: true,
      evmChains: CHAIN_SEEDS.filter((row) => row.evmAccessible).map((row) => row.chainLabel),
      caveatChains,
      routeGraph: TARGET.routeGraph,
      writesLimitedTo: [OUT_JSON_REL, OUT_MD_REL],
    },
    safety: {
      localArtifactsRead: true,
      rpcInventorySkipped: live.rpcInventorySkipped,
      rpcInventoryRead: live.rpcInventoryRead,
      rpcInventoryRows: live.rpcInventoryRows,
      rpcInventoryError: live.rpcInventoryError,
      graphqlInventoryRead: false,
      envFilesRead: false,
      privateKeysRead: false,
      keyMaterialRead: false,
      rpcUrlsStored: false,
      rawUrlsStored: false,
      signedActions: false,
      liveTransactions: false,
      broadcasts: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      ethCallOnly: true,
      sanitizedOutputOnly: true,
    },
    discoveredSeeds: {
      chainSeeds: CHAIN_SEEDS,
      tokenSeeds: TOKEN_SEEDS.map((row) => ({ ...row, address: normalizeAddress(row.address) || row.address })),
      consumerContextSeeds: CONSUMER_CONTEXT_SEEDS.map((row) => ({ ...row, address: normalizeAddress(row.address) || row.address })),
      canonicalWbtcEthereum: WBTC_ETH,
    },
    sourceFacts,
    sourceArtifacts: uniq([rel(DEEP_DISCOVERY_FILE), rel(PUBLIC_DISCOVERY_FILE), ...notableExactRows.map((row) => row.file)]),
    localArtifactMatches: lineScan.rows,
    localArtifactExactMatches: lineScan.exactRows,
    localArtifactCategoryCounts: lineScan.categoryCounts,
    localObjectRows: objectRows,
    exactLocalRows,
    notableExactRows,
    consumerJoinRows,
    exactConsumerJoinRows,
    dexLiquidityRows,
    oracleRows,
    bridgeCustodyContextRows,
    exactEconomicsRows,
    exactEconomicsEvidenceRows: [],
    endpointCoverage: {
      rpcInventorySkipped: live.rpcInventorySkipped,
      rpcInventoryRead: live.rpcInventoryRead,
      rpcInventoryRows: live.rpcInventoryRows,
      chainProbes: live.chainProbes.map(sanitizeChainProbe),
      rpcBlockedRows: live.rpcBlockedRows,
    },
    liveProbeRows: live.liveProbeRows,
    selectorProbeRows: live.selectorProbeRows,
    routePositive,
    executableNow,
    signedActionJustified,
    forkJustified,
    forkGate,
    blockers,
    requiredForRoutePositive,
    nextReadOnlyStep: "Resolve PumpBTC bridge/custody and minter/owner role graph from verified source/ABI, then refresh exact Compound/Curve/Euler/Morpho consumer state; only if a row becomes exact-positive run a local fork/value-delta proof.",
    summary,
  };
}

function mdEscape(value) {
  return String(value ?? "").replace(/\|/g, " ").replace(/\r?\n/g, " ");
}

function renderSummaryTable(summary) {
  const keys = [
    "sourceFactRows", "chainSeedRows", "tokenSeedRows", "localArtifactMatchRows", "exactLocalArtifactMatchRows",
    "localObjectRows", "exactLocalObjectRows", "consumerJoinRows", "exactConsumerJoinRows", "dexLiquidityRows", "oracleRows",
    "bridgeCustodyContextRows", "liveProbeRows", "codePresentRows", "selectorProbeRows", "selectorProbeSuccessRows",
    "rpcBlockedRows", "exactEconomicsRows", "routePositive", "executableNow", "signedActionJustified", "forkJustified", "forkGate",
  ];
  return [
    "| Metric | Value |",
    "|---|---:|",
    ...keys.map((key) => `| ${key} | ${mdEscape(summary[key])} |`),
  ].join("\n");
}

function rowFieldSummary(row) {
  const fields = row.fields || {};
  const preferred = ["chain", "market", "comet", "assetSymbol", "asset", "priceFeed", "feedDescription", "borrowCFBps", "liquidateCFBps", "supplyCapRaw", "name", "pool", "usdTotal", "vault", "vaultSymbol", "oracle", "cashRaw", "totalAssetsRaw", "totalBorrowsRaw", "collateral", "loan", "lltv", "supplyUsd", "borrowUsd", "routePositive", "routeGateStatus", "exactEconomicsPositive"];
  const parts = [];
  for (const key of preferred) {
    if (fields[key] === null || fields[key] === undefined) continue;
    let value = fields[key];
    if (typeof value === "object") value = JSON.stringify(value, jsonReplacer);
    parts.push(`${key}=${value}`);
  }
  return sanitizeText(parts.join("; ") || row.context || "context", 260);
}

function renderMarkdown(payload) {
  const lines = [];
  lines.push("# 🟢 DORMANT - PumpBTC Full Test");
  lines.push("");
  lines.push(`Generated: ${payload.generatedAt}`);
  lines.push("");
  lines.push("Route remains closed: routePositive=0, executableNow=0, signedActionJustified=false, forkJustified=false, forkGate=closed-route-positive-zero.");
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(renderSummaryTable(payload.summary));
  lines.push("");
  lines.push("## Safety");
  lines.push("");
  for (const [key, value] of Object.entries(payload.safety)) lines.push(`- ${key}: ${value}`);
  lines.push("");
  lines.push("## Source/Scope Facts");
  lines.push("");
  lines.push(`- Target: ${payload.target.name} (${payload.target.slug}), category=${payload.target.category}, surface=${payload.target.surface}, module=${payload.target.module}, rank≈${payload.target.discoveryRank}, TVL context≈${payload.target.tvlContext}.`);
  lines.push(`- EVM accessible chain seeds: ${payload.scope.evmChains.join(", ")}.`);
  lines.push(`- Caveat chains: ${payload.scope.caveatChains.join(", ") || "none"}.`);
  lines.push("- Public/context seed includes PumpToken 8-decimal owner-controlled minter mapping, PumpStaking/OFT bridge contracts, and DefiLlama bridge/custody backing-token context.");
  lines.push("");
  lines.push("## Notable Exact Local Rows (watch/context only)");
  lines.push("");
  if (!payload.notableExactRows.length) {
    lines.push("- No notable exact local rows were extracted.");
  } else {
    lines.push("| Source | Categories | Match | Fields | Route | Classification |");
    lines.push("|---|---|---|---|---:|---|");
    for (const row of payload.notableExactRows.slice(0, 16)) {
      lines.push(`| ${mdEscape(`${row.file}${row.line ? `:${row.line}` : ""}`)} | ${mdEscape(row.categories.join(","))} | ${mdEscape(row.matched)} | ${mdEscape(rowFieldSummary(row))} | ${mdEscape(row.routePositive ?? "n/a")} | ${mdEscape(row.classification)} |`);
    }
  }
  lines.push("");
  lines.push("## Live Probe Rows");
  lines.push("");
  if (!payload.liveProbeRows.length) {
    lines.push("- No live probe rows were produced.");
  } else {
    lines.push("| Chain | Address | Code | Name | Symbol | Decimals | TotalSupplyRaw | SelectorHits |");
    lines.push("|---|---|---:|---|---|---:|---:|---:|");
    for (const row of payload.liveProbeRows) {
      const hits = (row.selectorResults || []).filter((probe) => probe.success).length;
      lines.push(`| ${mdEscape(row.chainLabel)} | ${mdEscape(row.address)} | ${row.codePresent ? "yes" : "no"} | ${mdEscape(row.name || "n/a")} | ${mdEscape(row.symbol || "n/a")} | ${mdEscape(row.decimals ?? "n/a")} | ${mdEscape(row.totalSupplyRaw || "n/a")} | ${hits}/${(row.selectorResults || []).length} |`);
    }
  }
  lines.push("");
  lines.push("## Blockers");
  lines.push("");
  for (const blocker of payload.blockers) lines.push(`- ${blocker}`);
  lines.push("");
  lines.push("## Required For RoutePositive");
  lines.push("");
  for (const req of payload.requiredForRoutePositive) lines.push(`- ${req}`);
  lines.push("");
  lines.push("## Next Read-Only Step");
  lines.push("");
  lines.push(payload.nextReadOnlyStep);
  lines.push("");
  return `${lines.join("\n")}\n`;
}

async function main() {
  const generatedAt = new Date().toISOString();
  const scanFiles = listScanFiles();
  const sourceFacts = loadSourceFacts();
  const lineScan = scanLocalArtifactLines(scanFiles);
  const objectScan = collectJsonObjectRows(scanFiles);
  const live = await runLiveProbes();
  const payload = buildPayload({ generatedAt, sourceFacts, lineScan, objectScan, live });
  writeJson(OUT_JSON, payload);
  ensureDir(OUT_MD);
  fs.writeFileSync(OUT_MD, renderMarkdown(payload), "utf8");
  log(JSON.stringify({ raw: OUT_JSON_REL, report: OUT_MD_REL, summary: payload.summary }, jsonReplacer, 2));
}

main().catch((error) => {
  console.error(sanitizeError(error) || "scan failed");
  process.exit(1);
});
