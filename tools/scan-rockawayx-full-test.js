#!/usr/bin/env node
"use strict";

// scan-rockawayx-full-test.js
// Defensive RockawayX full-test scanner. Artifact/static-source first; no endpoint details are persisted.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_DIR = path.join(WORKSPACE, "reports", "raw", "fast");
const REPORTS_DIR = path.join(WORKSPACE, "reports");
const OUT_JSON = path.join(RAW_DIR, "rockawayx-full-test.json");
const OUT_MD = path.join(REPORTS_DIR, "rockawayx-full-test-triage.md");
const OUT_JSON_REL = "reports/raw/fast/rockawayx-full-test.json";
const OUT_MD_REL = "reports/rockawayx-full-test-triage.md";

const QUIET = process.argv.includes("--quiet");
const GENERATED_AT = process.env.SCAN_GENERATED_AT || "2026-07-07T00:00:00.000Z";

const MAX_FILE_BYTES = 24 * 1024 * 1024;
const MAX_LOCAL_MATCH_ROWS = 440;
const MAX_LOCAL_OBJECT_ROWS = 360;
const MAX_ROWS_PER_FILE = 34;
const MAX_JSON_DEPTH = 9;

const TARGET = {
  slug: "rockawayx",
  name: "RockawayX",
  kind: "protocol",
  category: "Risk Curators",
  discoveryRank: 14,
  tvlContextUsd: 163_755_098.8,
  tvlContext: "$163.755M",
  surface: "generic-route-discovery",
  primaryChains: ["Ethereum", "BNB/BSC", "Base"],
  routeGraph: "producer asset -> accepted value -> consumer -> exit liquidity",
  module: "projects/rockawayx/index.js",
  adapterPathLabel: "defillama-adapter:projects/rockawayx/index.js",
};

const CHAIN_SEEDS = [
  { chain: "Ethereum", chainLabel: "Ethereum", chainId: 1, adapterKey: "ethereum", evmFirst: true, caveat: false, classification: "primary-evm-discovery-chain" },
  { chain: "Binance", chainLabel: "BNB/BSC", chainId: 56, adapterKey: "bsc", evmFirst: true, caveat: false, classification: "primary-evm-discovery-chain" },
  { chain: "Base", chainLabel: "Base", chainId: 8453, adapterKey: "base", evmFirst: true, caveat: false, classification: "primary-evm-discovery-chain" },
  { chain: "Solana", chainLabel: "Solana", chainId: null, adapterKey: "solana", evmFirst: false, caveat: true, classification: "non-evm-context-caveat" },
  { chain: "Sei", chainLabel: "Sei", chainId: null, adapterKey: "sei", evmFirst: false, caveat: true, classification: "blocked-or-caveat-unless-safe-coverage" },
  { chain: "Etherlink", chainLabel: "Etherlink", chainId: null, adapterKey: "etherlink", evmFirst: false, caveat: true, classification: "blocked-or-caveat-unless-safe-coverage" },
  { chain: "Plume Mainnet", chainLabel: "Plume Mainnet", chainId: null, adapterKey: "plume", evmFirst: false, caveat: true, classification: "blocked-or-caveat-unless-safe-coverage" },
];

const ADDRESS_SEEDS = [
  { chain: "Ethereum", role: "Morpho curator/owner", address: "0x5f829B1B473cBA86838E1B7BB7E144DbDE228e21", surface: "morpho-curator", classification: "static-address-seed-not-live-state-proof" },
  { chain: "Ethereum", role: "Morpho curator/owner", address: "0xE0181090c22579B6A217f1522cbf8c9f1F0C1965", surface: "morpho-curator", classification: "static-address-seed-not-live-state-proof" },
  { chain: "Ethereum", role: "Morpho curator/owner", address: "0x64C18DCC4Ccb3b8D27877a4aeBB4C3126CB39cB9", surface: "morpho-curator", classification: "static-address-seed-not-live-state-proof" },
  { chain: "Ethereum", role: "Morpho curator/owner", address: "0xd65d6E8dbC3Cd3D12418199E6f4014dB3aaa0097", surface: "morpho-curator", classification: "static-address-seed-not-live-state-proof" },
  { chain: "Ethereum", role: "Morpho curator/owner", address: "0xe99A27169c2aA26a8f2757949d09Fa3f9A8f0B3B", surface: "morpho-curator", classification: "static-address-seed-not-live-state-proof" },
  { chain: "Ethereum", role: "Morpho curator/owner", address: "0x8aC91877b93330f52b2979a31a4879506021475c", surface: "morpho-curator", classification: "static-address-seed-not-live-state-proof" },
  { chain: "Base", role: "Morpho curator/owner", address: "0xAE4181CFB5aaA08bbE77d269c6B595672b9F9Edc", surface: "morpho-curator", classification: "static-address-seed-not-live-state-proof" },
  { chain: "Ethereum", role: "Upshift Earn ctUSD", symbol: "ctUSD", address: "0xc87DBBB8C67e4F19fCD2E297c05937567b2572Ce", surface: "erc4626-vault", classification: "static-vault-seed-not-live-state-proof" },
  { chain: "Ethereum", role: "Upshift Tori/trUSD", symbol: "trUSD", address: "0xcd69123b3FBBfC666E1f6a501da27B564C00De54", surface: "direct-usd-tvl-caveat", classification: "static-vault-seed-direct-tvl-caveat" },
  { chain: "Ethereum", role: "EMBER eY10K", symbol: "eY10K", address: "0x953972ea0C1703c58F09FB6fD2477Fdcf0FEe074", surface: "erc4626-vault", classification: "static-vault-seed-not-live-state-proof" },
  { chain: "Ethereum", role: "Accountable USDC yield strategy", address: "0x0F0a9d3F0bc6006143c96E6995572b51413CB3c4", surface: "accountable-strategy", classification: "static-strategy-seed-not-live-state-proof" },
  { chain: "Ethereum", role: "mMEV token/strategy", symbol: "mMEV", address: "0x030b69280892c888670EDCDCD8B69Fd8026A0BF3", surface: "midas-token-or-strategy", classification: "static-token-seed-not-live-state-proof" },
  { chain: "Ethereum", role: "mevBTC token/strategy", symbol: "mevBTC", address: "0xb64C014307622eB15046C66fF71D04258F5963DC", surface: "midas-token-or-strategy", classification: "static-token-seed-not-live-state-proof" },
  { chain: "Ethereum", role: "mROX token/strategy", symbol: "mROX", address: "0x67E1F506B148d0Fc95a4E3fFb49068ceB6855c05", surface: "midas-token-or-strategy", classification: "static-token-seed-not-live-state-proof" },
  { chain: "BNB/BSC", role: "Lista ERC4626-style vault", address: "0xb5a30e1fa2cf3c8dea882124b3ab5a47a27c5dd2", surface: "erc4626-vault", classification: "static-vault-seed-not-live-state-proof" },
  { chain: "unknown/caveat", role: "Adapter sample extra", address: "0x7d611dC23267F508DE90724731Dc88CA28Ef7473", surface: "adapter-sample-context", caveat: true, classification: "local-discovery-sample-caveat-not-live-state-proof" },
];

const SURFACE_ROWS = [
  { label: "Morpho curator/owner vault discovery", category: "curator" },
  { label: "ERC4626 asset/totalAssets/totalSupply/convertToAssets", category: "erc4626" },
  { label: "ERC4626 deposit/withdraw/mint/redeem", category: "erc4626" },
  { label: "Upshift V2 asset/decimals/getTotalAssets", category: "upshift" },
  { label: "Accountable asset/lastTotalAssets", category: "accountable" },
  { label: "Midas totalSupply/token pricing", category: "midas" },
  { label: "oracle and accepted-value caveats", category: "oracle" },
  { label: "bridge/custody/backing caveats", category: "custody" },
  { label: "role/access/proxy/owner surfaces", category: "role-access-proxy" },
  { label: "consumer join and exit liquidity", category: "consumer-dex" },
];

const SOURCE_FACTS = [
  {
    sourceLabel: "local-prefilter-discovery-row-2026-06-24",
    kind: "local-discovery",
    slug: TARGET.slug,
    name: TARGET.name,
    surface: TARGET.surface,
    tvlContext: TARGET.tvlContext,
    chains: TARGET.primaryChains,
    routeGraph: TARGET.routeGraph,
    classification: "target-seed",
  },
  {
    sourceLabel: "local-structured-discovery-row-2026-06-24",
    kind: "local-discovery-json",
    slug: TARGET.slug,
    module: "rockawayx/index.js",
    adapterFetched: true,
    adapterAddressCount: 18,
    adapterHints: ["ERC4626", "oracle", "bridge/custody"],
    routePositive: 0,
    classification: "structured-target-seed-route-negative",
  },
  {
    sourceLabel: "defillama-protocol-label:rockawayx",
    kind: "public-static-label",
    slug: TARGET.slug,
    module: TARGET.module,
    adapterChains: CHAIN_SEEDS.map((row) => row.adapterKey),
    classification: "source-label-only-no-url-stored",
  },
  {
    sourceLabel: "defillama-adapter-label:projects/rockawayx/index.js",
    kind: "public-static-label",
    addressSeedRows: ADDRESS_SEEDS.length,
    classification: "address-seeds-static-not-live-code-or-state-proof",
  },
  {
    sourceLabel: "defillama-curator-helper-label:projects/helper/curators/index.js",
    kind: "public-static-label",
    classification: "curator-helper-label-only-no-url-stored",
  },
  {
    sourceLabel: "official-site-label",
    kind: "public-static-label",
    classification: "source-label-only-no-domain-stored",
  },
];

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const EXACT_RULES = [
  { label: "rockawayx", regex: /\brockawayx\b/i },
  { label: "RockawayX", regex: /\bRockawayX\b/ },
  { label: "projects/rockawayx/index.js", regex: /projects[\\/]rockawayx[\\/]index\.js/i },
  { label: "rockawayx/index.js", regex: /\brockawayx[\\/]index\.js/i },
  { label: "eY10K", regex: /\beY10K\b/i },
  { label: "mMEV", regex: /\bmMEV\b/i },
  { label: "mevBTC", regex: /\bmevBTC\b/i },
  { label: "mROX", regex: /\bmROX\b/i },
  ...ADDRESS_SEEDS.map((row) => ({ label: `${row.chain} ${row.role}`, regex: new RegExp(escapeRegExp(row.address), "i") })),
];

const CONTEXT_RULES = [
  { label: "Morpho", regex: /\bmorpho\b/i },
  { label: "curator", regex: /\bcurators?\b/i },
  { label: "owner", regex: /\bowner\b/i },
  { label: "ERC4626", regex: /\berc[-_]?4626\b/i },
  { label: "asset", regex: /\basset\b/i },
  { label: "totalAssets", regex: /\btotalAssets\b/i },
  { label: "totalSupply", regex: /\btotalSupply\b/i },
  { label: "convertToAssets", regex: /\bconvertToAssets\b/i },
  { label: "deposit", regex: /\bdeposit\b/i },
  { label: "withdraw", regex: /\bwithdraw\b/i },
  { label: "mint", regex: /\bmint\b/i },
  { label: "redeem", regex: /\bredeem\b/i },
  { label: "Upshift", regex: /\bupshift\b/i },
  { label: "getTotalAssets", regex: /\bgetTotalAssets\b/i },
  { label: "Accountable", regex: /\baccountable\b/i },
  { label: "lastTotalAssets", regex: /\blastTotalAssets\b/i },
  { label: "Midas", regex: /\bmidas\b/i },
  { label: "oracle", regex: /\boracle\b/i },
  { label: "price", regex: /\bprice\b/i },
  { label: "bridge", regex: /\bbridge\b/i },
  { label: "custody", regex: /\bcustody\b/i },
  { label: "backing", regex: /\bbacking\b/i },
  { label: "proxy", regex: /\bproxy\b/i },
  { label: "role/access", regex: /\b(role|access|admin|governance|guardian|pauser)\b/i },
  { label: "consumer", regex: /\bconsumer\b/i },
  { label: "lending", regex: /\blending\b/i },
  { label: "DEX", regex: /\bdex\b/i },
  { label: "liquidity", regex: /\bliquidity\b/i },
  { label: "exit", regex: /\bexit\b/i },
  { label: "routePositive", regex: /\broutePositive\b/i },
];

const CATEGORY_RULES = {
  consumer: ["consumer", "accepted", "collateral", "borrow", "lending", "market", "morpho", "vault", "lltv", "ltv", "supplycap", "cash", "exit venue"],
  dex: ["dex", "swap", "pool", "amm", "curve", "uniswap", "balancer", "liquidity", "router", "quote", "exit"],
  oracle: ["oracle", "price", "feed", "rate", "exchange rate", "accounting", "valuation", "midas", "token pricing", "totalassets"],
  custody: ["bridge", "custody", "backing", "escrow", "proof", "wrapper", "wrapped", "cross-chain"],
  roleAccessProxy: ["role", "access", "owner", "admin", "governance", "guardian", "pauser", "proxy", "implementation", "curator"],
  curator: ["rockawayx", "curator", "morpho", "owner", "risk curator"],
  erc4626: ["erc4626", "erc-4626", "vault", "share", "asset", "totalassets", "totalsupply", "converttoassets", "deposit", "withdraw", "mint", "redeem"],
  upshift: ["upshift", "ctusd", "trusd", "gettotalassets"],
  accountable: ["accountable", "lasttotalassets"],
  midas: ["midas", "mmev", "mevbtc", "mrox"],
  economics: ["routepositive", "positive", "profit", "overvalue", "overvaluation", "tvl", "liquidity", "slippage", "supplyusd", "borrowusd", "exacteconomics"],
};

const JSON_FIELD_ALLOWLIST = [
  "rank", "kind", "slug", "name", "category", "tvlUsd", "tvl", "currentTvlUsd", "chains", "primaryChain", "evmChains", "accessibleEvmChains", "accessibleNonEvmChains", "blockedOrCaveatChains", "surface", "routeGraph", "firstReadOnlyChecks", "audits", "module", "score", "chain", "chainId", "adapterKey", "adapterChain", "symbol", "assetSymbol", "assetName", "asset", "underlying", "token", "vault", "vaultSymbol", "vaultName", "vaultDecimals", "market", "owner", "curator", "factory", "registry", "router", "oracle", "priceFeed", "feedDescription", "collateral", "loan", "implementation", "proxy", "role", "totalAssets", "totalAssetsRaw", "lastTotalAssets", "totalSupply", "totalSupplyRaw", "convertToAssets", "cashRaw", "supplyUsd", "borrowUsd", "usdTotal", "liquidity", "routePositive", "executableNow", "signedActionJustified", "forkJustified", "classification", "status", "watchCandidate",
];

const BLOCKERS = [
  "No exact-positive RockawayX producer asset -> accepted value -> consumer -> exit route is proven in local artifacts; address rows are static seeds only.",
  "Adapter TVL and curator labels do not prove live code, current vault state, accepted collateral value, or exit liquidity.",
  "Morpho curator/owner rows require exact vault/market membership, caps, oracle configuration, cash/borrow capacity, and borrower-side value delta before route-positive status.",
  "ERC4626/Upshift/Accountable/Midas rows require current asset, totalAssets, totalSupply, convertToAssets, token pricing, and redeem/withdraw behavior with no pause/role/proxy blockers.",
  "No oracle/accounting overvaluation is quantified versus immediate redeem, swap, or unwind value after fees, slippage, caps, and gas.",
  "Bridge/custody/backing caveats remain context-only; no permissionless custody mismatch, proof bypass, or unlock path is locally proven.",
  "DEX/exit liquidity rows are context only until a concrete acquisition and unwind route is quantified at size.",
  "Solana, Sei, Etherlink, and Plume Mainnet remain caveats unless safe read-only coverage exists and endpoint details remain sanitized.",
  "Fork and signed-action gates remain closed because routePositive=0 and exactEconomicsRows=0.",
];

const REQUIRED_FOR_ROUTE_POSITIVE = [
  "Exact producer asset and consumer: identify a specific RockawayX-linked vault/token/curator asset accepted by a current consumer with material caps and liquidity.",
  "Accepted-value proof: quantify the consumer/oracle/accounting value and show it exceeds immediate market/redeem/unwind value after all fees and slippage.",
  "ERC4626/vault proof: verify asset(), totalAssets(), totalSupply(), convertToAssets(), deposit/withdraw/mint/redeem limits, and no role/pause/proxy blocker for the exact asset.",
  "Morpho proof: verify market/vault membership, curator/owner authority implications, LLTV, oracle freshness/scaling, supply/borrow cash, and liquidation/borrow route viability.",
  "Midas/Upshift/Accountable proof: verify token pricing, getTotalAssets/lastTotalAssets/totalSupply semantics, custody/backing, and redeemability.",
  "Bridge/custody proof: show a permissionless backing mismatch/proof bypass/unlock path if relying on bridge/custody accounting.",
  "Exit liquidity proof: compute acquisition and DEX/AMM/CEX unwind liquidity, price impact, fees, transfer restrictions, and gas at route scale.",
  "Caveat-chain proof: only include Solana/Sei/Etherlink/Plume if safe read-only coverage exists and endpoint details remain fully sanitized.",
  "Fork/static value-delta proof: local static proof or fork simulation must show positive attacker-controlled balance delta before any live preflight or signed action is considered.",
  "Explicit route-specific authorization and independent defensive review are required before any signed transaction path is discussed.",
];

const NEXT_READ_ONLY_STEP = "Map RockawayX static address seeds to local Morpho/ERC4626/Upshift/Accountable/Midas artifacts, then compare accepted accounting value against redeem/swap/exit liquidity with sanitized read-only coverage only if local rows identify a concrete candidate.";

function log(...args) {
  if (!QUIET) console.log(...args);
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function rel(filePath) {
  return path.relative(WORKSPACE, filePath).replace(/\\/g, "/");
}

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function sanitizeText(value, max = 320) {
  let text = String(value ?? "")
    .replace(/[\r\n|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  text = text
    .replace(/\bhttps?:\/\/[^\s"'`<>|)]+/gi, "[redacted-url]")
    .replace(/\bwww\.[^\s"'`<>|)]+/gi, "[redacted-url]")
    .replace(/\b(?:[a-z0-9-]+\.)+(?:com|org|net|io|fi|app|xyz|finance|protocol|dev|co|so|network|tech|exchange|build|money|info|ai)\b/gi, "[redacted-domain]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/= -]+/gi, "Bearer [redacted]")
    .replace(/\b(authorization|api[-_]?key|access[-_]?key|private[-_]?key|secret[-_]?key|secret|password|pwd)\s*[:=]\s*["']?[^\s"',}\]]{8,}/gi, "$1=[redacted]")
    .replace(/\b0x[0-9a-fA-F]{64}\b/g, "[redacted-hex-key]")
    .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9._-]{20,}\.[A-Za-z0-9._-]{20,}\b/g, "[redacted-jwt]");
  return text.slice(0, max) || null;
}

function mdEscape(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

function pickRows(rows, predicate, max = 120) {
  const out = [];
  for (const row of rows) {
    if (!predicate(row)) continue;
    out.push(row);
    if (out.length >= max) break;
  }
  return out;
}

function isSecretLikePath(filePath) {
  const r = rel(filePath).replace(/\\/g, "/").toLowerCase();
  const base = path.basename(filePath).toLowerCase();
  if (base === ".env" || base.startsWith(".env.")) return true;
  if (base === "rpc_endpoints.txt" || base === "graphql_endpoints.txt") return true;
  if (/\.(pem|key|p12|pfx|keystore)$/i.test(base)) return true;
  if (/(^|[\/\\])(private|secret|secrets|mnemonic|seed|wallet|keypair|keystore|api[-_]?key|access[-_]?key)([\/\\._-]|$)/i.test(r)) return true;
  return false;
}

function isExcludedScanPath(filePath) {
  const r = rel(filePath).toLowerCase();
  const base = path.basename(filePath).toLowerCase();
  if (r === OUT_JSON_REL.toLowerCase() || r === OUT_MD_REL.toLowerCase()) return true;
  if (r === "tools/scan-rockawayx-full-test.js") return true;
  if (isSecretLikePath(filePath)) return true;
  if (base.includes("endpoint")) return true;
  if (r.includes("/node_modules/") || r.includes("/.git/")) return true;
  if (r.includes("/cache/") || r.includes("/out/") || r.includes("/broadcast/") || r.includes("/artifacts/")) return true;
  if (r.startsWith(".opencode/") || r.startsWith("coordination/")) return true;
  if (/(?:handoff|shared_context|state\.md|audit-completion-gates|route-positive-sweep|low-fund-executable-route-filter|exploit-findings-summary|full-test)/i.test(r)) return true;
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

function readJson(filePath) {
  const text = readText(filePath);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_error) {
    return null;
  }
}

function writeJson(filePath, value) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(value, jsonReplacer, 2)}\n`, "utf8");
}

function writeText(filePath, value) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, value, "utf8");
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
      if (entry.isDirectory()) {
        const relDir = rel(full).toLowerCase();
        if (relDir.startsWith("reports/") && relDir !== "reports/raw" && !relDir.startsWith("reports/raw/")) continue;
        if (/^(?:node_modules|\.git|cache|out|broadcast|artifacts|lib)$/i.test(entry.name)) continue;
        if (rel(full).toLowerCase().startsWith("coordination/")) continue;
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
  const roots = [path.join(WORKSPACE, "reports"), path.join(WORKSPACE, "tools")];
  return uniqBy(roots.flatMap(listFilesRecursive), (file) => path.resolve(file)).sort((a, b) => rel(a).localeCompare(rel(b)));
}

function firstRuleMatch(text, rules) {
  const raw = String(text || "");
  for (const rule of rules) {
    if (rule.regex.test(raw)) return rule;
  }
  return null;
}

function hasRuleMatch(text, rules) {
  return Boolean(firstRuleMatch(text, rules));
}

function matchForText(line, windowText, fileHasExact) {
  const exact = firstRuleMatch(line, EXACT_RULES) || firstRuleMatch(windowText, EXACT_RULES);
  if (exact) return { matchType: "exact-name-address-or-symbol", matched: exact.label, termType: "text" };
  const context = firstRuleMatch(line, CONTEXT_RULES);
  if (!context) return null;
  if (fileHasExact || hasRuleMatch(windowText, EXACT_RULES)) return { matchType: "context", matched: context.label, termType: "text" };
  return null;
}

function categoriesFor(text, filePath = "") {
  const hay = `${filePath} ${String(text || "")}`.toLowerCase();
  const categories = [];
  for (const [category, terms] of Object.entries(CATEGORY_RULES)) {
    if (terms.some((term) => hay.includes(term.toLowerCase()))) categories.push(category);
  }
  return categories.length ? categories : ["context"];
}

function countOccurrences(text, term) {
  if (!text || !term) return 0;
  let count = 0;
  let cursor = 0;
  const hay = String(text).toLowerCase();
  const needle = String(term).toLowerCase();
  while (needle && cursor <= hay.length) {
    const pos = hay.indexOf(needle, cursor);
    if (pos < 0) break;
    count += 1;
    cursor = pos + Math.max(needle.length, 1);
  }
  return count;
}

function scanLocalArtifactLines(files) {
  const rows = [];
  let filesScanned = 0;
  let filesWithMatch = 0;
  let filesWithExact = 0;
  const categoryCounts = {};

  for (const file of files) {
    const text = readText(file);
    if (!text) continue;
    filesScanned += 1;
    const fileHasExact = hasRuleMatch(text, EXACT_RULES);
    if (!fileHasExact) continue;
    const lines = text.split(/\r?\n/);
    let sampled = 0;
    let fileMatched = false;
    let fileExact = false;
    const seen = new Set();
    for (let i = 0; i < lines.length && rows.length < MAX_LOCAL_MATCH_ROWS && sampled < MAX_ROWS_PER_FILE; i += 1) {
      const line = String(lines[i] || "");
      if (!line.trim()) continue;
      const windowText = [lines[i - 2], lines[i - 1], lines[i], lines[i + 1], lines[i + 2]].map((x) => String(x || "")).join(" ");
      const match = matchForText(line, windowText, fileHasExact);
      if (!match) continue;
      const key = `${rel(file)}:${i + 1}:${match.matchType}:${match.matched}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fileMatched = true;
      if (match.matchType === "exact-name-address-or-symbol") fileExact = true;
      const categories = categoriesFor(windowText, rel(file));
      for (const category of categories) categoryCounts[category] = (categoryCounts[category] || 0) + 1;
      rows.push({
        rowSource: "line-scan",
        file: rel(file),
        line: i + 1,
        matchType: match.matchType,
        termType: match.termType,
        matched: sanitizeText(match.matched, 120),
        count: countOccurrences(line, match.matched),
        categories,
        sample: sanitizeText(windowText, 420),
        routePositive: 0,
        classification: match.matchType === "exact-name-address-or-symbol" ? "exact-local-watch-context-only-no-positive-economics" : "local-artifact-watch-context-only-no-route-positive",
      });
      sampled += 1;
    }
    if (fileMatched) filesWithMatch += 1;
    if (fileExact) filesWithExact += 1;
    if (rows.length >= MAX_LOCAL_MATCH_ROWS) break;
  }

  return { filesScanned, filesWithMatch, filesWithExact, rows, exactRows: rows.filter((row) => row.matchType === "exact-name-address-or-symbol"), categoryCounts };
}

function shouldSkipJsonKey(key) {
  return /(url|uri|endpoint|hostname|host|domain|secret|password|private|api[-_]?key|access[-_]?key|auth|bearer|cookie|header)/i.test(String(key || ""));
}

function compactValue(value) {
  if (value === null || value === undefined) return null;
  if (["string", "number", "boolean"].includes(typeof value)) return typeof value === "string" ? sanitizeText(value, 220) : value;
  if (Array.isArray(value)) return value.slice(0, 12).map((item) => compactValue(item)).filter((item) => item !== null);
  if (isObject(value)) {
    const out = {};
    for (const [key, val] of Object.entries(value).slice(0, 18)) {
      if (shouldSkipJsonKey(key)) continue;
      const compacted = compactValue(val);
      if (compacted !== null && !(Array.isArray(compacted) && compacted.length === 0)) out[key] = compacted;
    }
    return out;
  }
  return sanitizeText(String(value), 220);
}

function extractFields(value) {
  const fields = {};
  if (!isObject(value)) return fields;
  for (const field of JSON_FIELD_ALLOWLIST) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) continue;
    if (shouldSkipJsonKey(field)) continue;
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
  if (isObject(value.routeGate)) {
    fields.routeGateStatus = compactValue(value.routeGate.status);
    fields.exactAccountingBypass = compactValue(value.routeGate.exactAccountingBypass);
    fields.exactEconomicsPositive = compactValue(value.routeGate.exactEconomicsPositive);
    fields.forkProof = compactValue(value.routeGate.forkProof);
  }
  return fields;
}

function fieldsContext(fields) {
  const parts = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined) continue;
    const rendered = typeof value === "object" ? JSON.stringify(value, jsonReplacer).slice(0, 180) : String(value);
    parts.push(`${key}=${rendered}`);
  }
  return sanitizeText(parts.join("; "), 520);
}

function primitiveBlob(value, jsonPath) {
  const parts = [jsonPath];
  if (!isObject(value)) return parts.join(" ");
  for (const [key, val] of Object.entries(value)) {
    if (shouldSkipJsonKey(key)) continue;
    if (val === null || val === undefined) continue;
    if (["string", "number", "boolean"].includes(typeof val)) parts.push(key, String(val));
    else if (Array.isArray(val) && val.every((item) => item === null || ["string", "number", "boolean"].includes(typeof item))) {
      parts.push(key, val.slice(0, 18).join(" "));
    }
  }
  return parts.join(" ");
}

function scanLocalJsonObjects(files) {
  const rows = [];
  let jsonFilesParsed = 0;
  const categoryCounts = {};
  const seen = new Set();

  function visit(value, file, jsonPath, depth) {
    if (rows.length >= MAX_LOCAL_OBJECT_ROWS || depth > MAX_JSON_DEPTH) return;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length && rows.length < MAX_LOCAL_OBJECT_ROWS; i += 1) visit(value[i], file, `${jsonPath}[${i}]`, depth + 1);
      return;
    }
    if (!isObject(value)) return;

    const blob = primitiveBlob(value, jsonPath);
    const fields = extractFields(value);
    const context = fieldsContext(fields) || sanitizeText(blob, 420);
    const objectHasExact = hasRuleMatch(`${blob} ${context || ""}`, EXACT_RULES);
    const match = objectHasExact ? matchForText(blob, `${blob} ${context || ""}`, true) : null;
    if (match && context) {
      const categories = categoriesFor(`${blob} ${context}`, rel(file));
      const key = `${rel(file)}:${jsonPath}:${match.matchType}:${match.matched}`;
      if (!seen.has(key)) {
        seen.add(key);
        for (const category of categories) categoryCounts[category] = (categoryCounts[category] || 0) + 1;
        rows.push({
          rowSource: "json-object-scan",
          file: rel(file),
          jsonPath,
          matchType: match.matchType,
          termType: match.termType,
          matched: sanitizeText(match.matched, 120),
          categories,
          fields,
          context,
          routePositive: value.routePositive === true ? "local-row-true-untrusted-not-promoted" : (value.routePositive ?? 0),
          classification: match.matchType === "exact-name-address-or-symbol" ? "exact-local-watch-context-only-no-positive-economics" : "local-artifact-watch-context-only-no-route-positive",
        });
      }
    }

    for (const [key, child] of Object.entries(value)) {
      if (shouldSkipJsonKey(key)) continue;
      if (isObject(child) || Array.isArray(child)) visit(child, file, `${jsonPath}.${key}`, depth + 1);
      if (rows.length >= MAX_LOCAL_OBJECT_ROWS) break;
    }
  }

  for (const file of files) {
    if (!/\.json$/i.test(file)) continue;
    const text = readText(file);
    if (!text || !hasRuleMatch(text, EXACT_RULES)) continue;
    let json;
    try {
      json = JSON.parse(text);
    } catch (_error) {
      continue;
    }
    jsonFilesParsed += 1;
    visit(json, file, "$", 0);
    if (rows.length >= MAX_LOCAL_OBJECT_ROWS) break;
  }

  return { jsonFilesParsed, rows, exactRows: rows.filter((row) => row.matchType === "exact-name-address-or-symbol"), categoryCounts };
}

function exactish(row) {
  return row.matchType === "exact-name-address-or-symbol";
}

function sourceForRow(row) {
  if (row.line) return `${row.file}:${row.line}`;
  return `${row.file}:${row.jsonPath || "$"}`;
}

function mergeCategoryCounts(...countMaps) {
  const out = {};
  for (const map of countMaps) {
    for (const [key, value] of Object.entries(map || {})) out[key] = (out[key] || 0) + value;
  }
  return out;
}

function selectNotableRows(rows) {
  const exact = rows.filter(exactish);
  const highSignal = rows.filter((row) => row.categories.some((cat) => ["curator", "erc4626", "consumer", "dex", "oracle", "custody", "roleAccessProxy", "upshift", "accountable", "midas"].includes(cat)));
  return uniqBy([...exact, ...highSignal], (row) => `${sourceForRow(row)}:${row.matchType}:${row.matched}`).slice(0, 28);
}

function buildPayload({ lineScan, objectScan }) {
  const combinedRows = uniqBy([...objectScan.rows, ...lineScan.rows], (row) => `${sourceForRow(row)}:${row.matchType}:${row.matched}:${row.rowSource}`);
  const exactRows = combinedRows.filter(exactish);
  const consumerJoinRows = pickRows(combinedRows, (row) => row.categories.includes("consumer"), 140);
  const exactConsumerJoinRows = pickRows(consumerJoinRows, exactish, 120);
  const dexLiquidityRows = pickRows(combinedRows, (row) => row.categories.includes("dex"), 140);
  const oracleRows = pickRows(combinedRows, (row) => row.categories.includes("oracle"), 140);
  const custodyRows = pickRows(combinedRows, (row) => row.categories.includes("custody"), 140);
  const roleAccessProxyRows = pickRows(combinedRows, (row) => row.categories.includes("roleAccessProxy"), 140);
  const curatorRows = pickRows(combinedRows, (row) => row.categories.includes("curator"), 140);
  const erc4626Rows = pickRows(combinedRows, (row) => row.categories.includes("erc4626"), 140);
  const upshiftRows = pickRows(combinedRows, (row) => row.categories.includes("upshift"), 100);
  const accountableRows = pickRows(combinedRows, (row) => row.categories.includes("accountable"), 80);
  const midasRows = pickRows(combinedRows, (row) => row.categories.includes("midas"), 80);
  const notableRows = selectNotableRows(combinedRows);
  const exactEconomicsRows = 0;
  const routePositive = 0;
  const executableNow = 0;
  const signedActionJustified = false;
  const forkJustified = false;
  const forkGate = "closed-route-positive-zero";

  const summary = {
    sourceFactRows: SOURCE_FACTS.length,
    chainSeedRows: CHAIN_SEEDS.length,
    addressSeedRows: ADDRESS_SEEDS.length,
    surfaceRows: SURFACE_ROWS.length,
    filesScanned: lineScan.filesScanned,
    filesWithLocalMatches: lineScan.filesWithMatch,
    filesWithExactLocalMatches: lineScan.filesWithExact,
    jsonFilesParsed: objectScan.jsonFilesParsed,
    localArtifactMatchRows: combinedRows.length,
    exactLocalArtifactMatchRows: exactRows.length,
    localLineRows: lineScan.rows.length,
    localObjectRows: objectScan.rows.length,
    exactLocalObjectRows: objectScan.exactRows.length,
    consumerJoinRows: consumerJoinRows.length,
    exactConsumerJoinRows: exactConsumerJoinRows.length,
    dexLiquidityRows: dexLiquidityRows.length,
    oracleRows: oracleRows.length,
    custodyRows: custodyRows.length,
    roleAccessProxyRows: roleAccessProxyRows.length,
    curatorRows: curatorRows.length,
    erc4626Rows: erc4626Rows.length,
    upshiftRows: upshiftRows.length,
    accountableRows: accountableRows.length,
    midasRows: midasRows.length,
    publicFetchRows: 0,
    rpcInventoryRows: 0,
    graphqlInventoryRows: 0,
    exactEconomicsRows,
    routePositive,
    executableNow,
    signedActionJustified,
    forkJustified,
    forkGate,
  };

  return {
    generatedAt: GENERATED_AT,
    deterministicOutput: true,
    scanner: "tools/scan-rockawayx-full-test.js",
    target: TARGET,
    scope: {
      kind: "defensive route-first full-test scanner",
      artifactStaticLocalFirst: true,
      evmFirst: true,
      evmFirstChains: CHAIN_SEEDS.filter((row) => row.evmFirst).map((row) => row.chainLabel),
      caveatChains: CHAIN_SEEDS.filter((row) => row.caveat).map((row) => row.chainLabel),
      routeGraph: TARGET.routeGraph,
      writesLimitedTo: [OUT_JSON_REL, OUT_MD_REL],
      aggregatePromotionStateHandoffEdited: false,
      endpointPolicy: "Endpoint inventories are authorized for read-only use when needed, but this first pass did not read them and raw endpoints/domains/keys are never persisted.",
    },
    safety: {
      localArtifactsRead: true,
      publicSourcesRead: true,
      publicNetworkFetch: false,
      rpcInventoryRead: false,
      rpcInventoryRows: 0,
      graphqlInventoryRead: false,
      graphqlInventoryRows: 0,
      envFilesRead: false,
      privateKeysRead: false,
      keyMaterialRead: false,
      rpcUrlsStored: false,
      rawUrlsStored: false,
      rawDomainsStored: false,
      graphqlUrlsStored: false,
      signedActions: false,
      liveTransactions: false,
      broadcasts: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      ethCallOnly: false,
      sanitizedOutputOnly: true,
      secretLikePathsExcluded: true,
    },
    sourceFacts: SOURCE_FACTS,
    discoveredSeeds: {
      chainSeeds: CHAIN_SEEDS,
      addressSeeds: ADDRESS_SEEDS,
      surfaceRows: SURFACE_ROWS,
    },
    localArtifacts: {
      filesScanned: lineScan.filesScanned,
      filesWithMatch: lineScan.filesWithMatch,
      filesWithExact: lineScan.filesWithExact,
      jsonFilesParsed: objectScan.jsonFilesParsed,
      categoryCounts: mergeCategoryCounts(lineScan.categoryCounts, objectScan.categoryCounts),
      rows: combinedRows,
      exactRows: exactRows.slice(0, 160),
      notableRows,
    },
    categoryRows: {
      consumerJoinRows,
      exactConsumerJoinRows,
      dexLiquidityRows,
      oracleRows,
      custodyRows,
      roleAccessProxyRows,
      curatorRows,
      erc4626Rows,
      upshiftRows,
      accountableRows,
      midasRows,
    },
    routeGate: {
      routePositive,
      executableNow,
      signedActionJustified,
      forkJustified,
      forkGate,
      exactPermissionlessValueMovement: false,
      exactPositiveEconomics: false,
      localForkStaticProof: false,
      exactEconomicsRows,
      status: "dormant-fail-closed",
      reason: "Artifact/static scan found context rows only; exact permissionless value movement + positive economics + local/fork/static proof are absent.",
    },
    blockers: BLOCKERS,
    requiredForRoutePositive: REQUIRED_FOR_ROUTE_POSITIVE,
    nextReadOnlyStep: NEXT_READ_ONLY_STEP,
    summary,
  };
}

function metricRows(summary) {
  const keys = [
    "sourceFactRows", "chainSeedRows", "addressSeedRows", "surfaceRows", "filesScanned", "filesWithLocalMatches", "filesWithExactLocalMatches", "jsonFilesParsed", "localArtifactMatchRows", "exactLocalArtifactMatchRows", "localLineRows", "localObjectRows", "consumerJoinRows", "exactConsumerJoinRows", "dexLiquidityRows", "oracleRows", "custodyRows", "roleAccessProxyRows", "curatorRows", "erc4626Rows", "upshiftRows", "accountableRows", "midasRows", "publicFetchRows", "rpcInventoryRows", "graphqlInventoryRows", "exactEconomicsRows", "routePositive", "executableNow", "signedActionJustified", "forkJustified", "forkGate",
  ];
  return keys.map((key) => `| ${key} | ${mdEscape(summary[key])} |`).join("\n");
}

function safetyRows(safety) {
  const keys = [
    "localArtifactsRead", "publicSourcesRead", "publicNetworkFetch", "rpcInventoryRead", "graphqlInventoryRead", "envFilesRead", "privateKeysRead", "keyMaterialRead", "rpcUrlsStored", "rawUrlsStored", "rawDomainsStored", "graphqlUrlsStored", "signedActions", "liveTransactions", "broadcasts", "forkTransactions", "ethCallOnly", "sanitizedOutputOnly", "secretLikePathsExcluded",
  ];
  return keys.map((key) => `| ${key} | ${mdEscape(safety[key])} |`).join("\n");
}

function formatRow(row) {
  const source = sourceForRow(row);
  const categories = (row.categories || []).join(",");
  const detail = row.context || row.sample || fieldsContext(row.fields || {}) || "context-only";
  return `| ${mdEscape(source)} | ${mdEscape(categories)} | ${mdEscape(row.matched)} | ${mdEscape(detail)} | ${mdEscape(row.routePositive)} | ${mdEscape(row.classification)} |`;
}

function formatAddressSeed(row) {
  return `| ${mdEscape(row.chain)} | ${mdEscape(row.role)} | ${mdEscape(row.symbol || "-")} | ${mdEscape(row.address)} | ${mdEscape(row.surface)} | ${mdEscape(row.classification)} |`;
}

function buildMarkdown(payload) {
  const signal = payload.routeGate.routePositive === 0 ? "🟢 DORMANT" : "🔴 ROUTE-POSITIVE";
  const notableRows = payload.localArtifacts.notableRows.length
    ? payload.localArtifacts.notableRows.map(formatRow).join("\n")
    : "| (none) | n/a | n/a | no local context rows found | 0 | dormant |";
  const seedRows = payload.discoveredSeeds.addressSeeds.map(formatAddressSeed).join("\n");

  return `# ${signal} - RockawayX Full Test

Generated: ${payload.generatedAt}

Route remains closed: routePositive=${payload.routeGate.routePositive}, executableNow=${payload.routeGate.executableNow}, signedActionJustified=${payload.routeGate.signedActionJustified}, forkJustified=${payload.routeGate.forkJustified}, forkGate=${payload.routeGate.forkGate}.

## Summary

| Metric | Value |
|---|---:|
${metricRows(payload.summary)}

## Target

- Target: ${payload.target.name} (${payload.target.slug}), kind=${payload.target.kind}, category=${payload.target.category}, surface=${payload.target.surface}, module=${payload.target.module}, rank≈${payload.target.discoveryRank}, TVL context≈${payload.target.tvlContext}.
- EVM-first chains: ${payload.scope.evmFirstChains.join(", ")}.
- Caveat chains/context: ${payload.scope.caveatChains.join(", ") || "none"}.
- Route graph: ${payload.target.routeGraph}.
- Static public source labels only: ${payload.sourceFacts.map((row) => row.sourceLabel).join(", ")}.

## Scope / Endpoint Policy

- Scanner kind: ${payload.scope.kind}; artifactStaticLocalFirst=${payload.scope.artifactStaticLocalFirst}; evmFirst=${payload.scope.evmFirst}.
- Writes limited to: ${payload.scope.writesLimitedTo.join(", ")}.
- ${payload.scope.endpointPolicy}
- No aggregate gate scripts, state/context files, handoff files, secret/endpoint details, or wallet/key material are written or persisted.

## Safety

| Field | Value |
|---|---:|
${safetyRows(payload.safety)}

## Address Seeds (static, not live code/state proof)

| Chain | Role | Symbol | Address | Surface | Classification |
|---|---|---|---|---|---|
${seedRows}

## Notable Local Rows (watch/context only)

| Source | Categories | Match | Detail | Route | Classification |
|---|---|---|---|---:|---|
${notableRows}

## Route Gate

- Status: ${payload.routeGate.status}.
- Required fail-closed conjunction is absent: exactPermissionlessValueMovement=${payload.routeGate.exactPermissionlessValueMovement}, exactPositiveEconomics=${payload.routeGate.exactPositiveEconomics}, localForkStaticProof=${payload.routeGate.localForkStaticProof}.
- Fork gate: ${payload.routeGate.forkGate}.

## Blockers

${payload.blockers.map((item) => `- ${item}`).join("\n")}

## Required For RoutePositive

${payload.requiredForRoutePositive.map((item) => `- ${item}`).join("\n")}

## Next Read-Only Step

${payload.nextReadOnlyStep}
`;
}

function main() {
  log("Scanning RockawayX local artifacts (sanitized, no endpoint inventory read)...");
  const files = listScanFiles();
  const lineScan = scanLocalArtifactLines(files);
  const objectScan = scanLocalJsonObjects(files);
  const payload = buildPayload({ lineScan, objectScan });
  writeJson(OUT_JSON, payload);
  writeText(OUT_MD, buildMarkdown(payload));
  log(`Wrote ${OUT_JSON_REL} and ${OUT_MD_REL}`);
  log(`routePositive=${payload.summary.routePositive}; localArtifactMatchRows=${payload.summary.localArtifactMatchRows}; exactLocalArtifactMatchRows=${payload.summary.exactLocalArtifactMatchRows}`);
}

main();
