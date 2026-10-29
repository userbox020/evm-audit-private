#!/usr/bin/env node
"use strict";

// scan-ring-few-full-test.js
// Defensive Ring Few full-test scanner. Artifact/static-source only; no endpoint inventory, RPC, or transactions.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_DIR = path.join(WORKSPACE, "reports", "raw", "fast");
const REPORTS_DIR = path.join(WORKSPACE, "reports");
const OUT_JSON = path.join(RAW_DIR, "ring-few-full-test.json");
const OUT_MD = path.join(REPORTS_DIR, "ring-few-full-test-triage.md");
const OUT_JSON_REL = "reports/raw/fast/ring-few-full-test.json";
const OUT_MD_REL = "reports/ring-few-full-test-triage.md";

const QUIET = process.argv.includes("--quiet");
const GENERATED_AT = process.env.SCAN_GENERATED_AT || "2026-07-07T00:00:00.000Z";

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_LOCAL_MATCH_ROWS = 460;
const MAX_LOCAL_OBJECT_ROWS = 360;
const MAX_ROWS_PER_FILE = 36;
const MAX_JSON_DEPTH = 9;

const TARGET = {
  slug: "ring-few",
  name: "Ring Few",
  kind: "protocol",
  category: "Bridge",
  discoveryRank: 13,
  tvlContextUsd: 23_243_474.21,
  tvlContext: "$23.243M",
  surface: "bridge-proof-custody-consumer",
  primaryChains: ["Ethereum", "Binance", "Blast", "Base"],
  routeGraph: "custody/backing or proof state -> wrapped asset -> lending/DEX consumer -> borrow/unlock/exit",
  module: "projects/ring-few/index.js",
  adapterPathLabel: "defillama-adapter:projects/ring-few/index.js",
  caveat: "Hyperliquid L1/HyperEVM is context/caveat unless locally supported by artifacts.",
};

const CHAIN_SEEDS = [
  { chain: "Ethereum", chainLabel: "Ethereum", chainId: 1, adapterKey: "ethereum", discoveryPrimary: true, accessibleEvm: true, classification: "primary-discovery-chain" },
  { chain: "Binance", chainLabel: "BNB/BSC", chainId: 56, adapterKey: "bsc", discoveryPrimary: true, accessibleEvm: true, classification: "primary-discovery-chain" },
  { chain: "Blast", chainLabel: "Blast", chainId: 81457, adapterKey: "blast", discoveryPrimary: true, accessibleEvm: true, classification: "primary-discovery-chain" },
  { chain: "Base", chainLabel: "Base", chainId: 8453, adapterKey: "base", discoveryPrimary: true, accessibleEvm: true, classification: "primary-discovery-chain" },
  { chain: "Arbitrum", chainLabel: "Arbitrum", chainId: 42161, adapterKey: "arbitrum", discoveryPrimary: false, accessibleEvm: true, classification: "public-static-adapter-chain" },
  { chain: "Hyperliquid L1", chainLabel: "Hyperliquid L1 / HyperEVM context", chainId: null, adapterKey: "hyperliquid", discoveryPrimary: false, accessibleEvm: false, caveat: true, classification: "caveat-context-not-locally-supported" },
];

const FACTORY_SEEDS = [
  { chain: "Ethereum", chainId: 1, role: "FewFactory", address: "0x7D86394139bf1122E82FDF45Bb4e3b038A4464DD", sourceLabel: "public-adapter-factory-label", classification: "factory-seed-static-not-live-code-proof" },
  { chain: "Blast", chainId: 81457, role: "FewFactory", address: "0x455b20131D59f01d082df1225154fDA813E8CeE9", sourceLabel: "public-adapter-factory-label", classification: "factory-seed-static-not-live-code-proof" },
  { chain: "BNB/BSC", chainId: 56, role: "FewFactory", address: "0xEeE400Eabfba8F60f4e6B351D8577394BeB972CD", sourceLabel: "public-adapter-factory-label", classification: "factory-seed-static-not-live-code-proof" },
  { chain: "Base", chainId: 8453, role: "FewFactory", address: "0xb3Ad7754f363af676dC1C5be40423FE538a47920", sourceLabel: "public-adapter-factory-label", classification: "factory-seed-static-not-live-code-proof" },
  { chain: "Arbitrum", chainId: 42161, role: "FewFactory", address: "0x974Cc3F3468cd9C12731108148C4DABFB5eE556F", sourceLabel: "public-adapter-factory-label", classification: "factory-seed-static-not-live-code-proof" },
  { chain: "HyperEVM context", chainId: null, role: "FewFactory", address: "0x6B65ed7315274eB9EF06A48132EB04D808700b86", sourceLabel: "public-adapter-factory-label", caveat: true, classification: "hyperevm-context-caveat-not-live-code-proof" },
];

const CORE_SURFACES = [
  { label: "FewFactory.createToken", category: "factory" },
  { label: "FewFactory.getWrappedToken", category: "factory" },
  { label: "FewFactory.allWrappedTokens", category: "factory" },
  { label: "FewFactory.allWrappedTokensLength", category: "factory" },
  { label: "FewFactory.paused", category: "factory" },
  { label: "CREATE2 wrapper deployment", category: "factory" },
  { label: "FewWrappedToken.token", category: "wrapper" },
  { label: "FewWrappedToken.wrap", category: "wrapper" },
  { label: "FewWrappedToken.wrapTo", category: "wrapper" },
  { label: "FewWrappedToken.unwrap", category: "wrapper" },
  { label: "FewWrappedToken.unwrapTo", category: "wrapper" },
  { label: "FewWrappedToken.role-gated mint", category: "role" },
  { label: "FewWrappedToken.role-gated burnFrom", category: "role" },
  { label: "FewWrappedToken.self burn", category: "wrapper" },
  { label: "ERC20 permit", category: "permit" },
  { label: "CoreRef governor role", category: "role" },
  { label: "CoreRef guardian role", category: "role" },
  { label: "CoreRef minter role", category: "role" },
  { label: "CoreRef burner role", category: "role" },
  { label: "CoreRef pauser role", category: "role" },
  { label: "Few V2 AMM factory/pair/router", category: "dex" },
  { label: "Ring V2 AMM factory/pair/router", category: "dex" },
  { label: "Tokenized stock wrappers", category: "wrapper" },
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
    module: "ring-few/index.js",
    adapterAddressCount: FACTORY_SEEDS.length,
    routePositive: 0,
    classification: "structured-target-seed-route-negative",
  },
  {
    sourceLabel: "local-public-audit-target-discovery-row",
    kind: "local-discovery-json",
    firstReadOnlyChecks: ["bridge contracts/escrows/wrapped tokens", "proof/domain/nonce binding", "lending/DEX joins", "backing mismatch"],
    classification: "first-read-only-checks-seed",
  },
  {
    sourceLabel: "defillama-protocol-label:ring-few",
    kind: "public-static-label",
    slug: TARGET.slug,
    module: TARGET.module,
    adapterChains: CHAIN_SEEDS.map((row) => row.adapterKey),
    classification: "source-label-only-no-url-stored",
  },
  {
    sourceLabel: "public-adapter-factory-labels",
    kind: "public-static-label",
    factoryRows: FACTORY_SEEDS.length,
    classification: "addresses-are-static-seeds-not-live-code-or-state-proof",
  },
  {
    sourceLabel: "public-source-surface-labels",
    kind: "public-static-label",
    components: CORE_SURFACES.map((row) => row.label),
    classification: "source-label-only-no-url-stored",
  },
];

const EXACT_RULES = [
  { label: "ring-few", regex: /\bring[\s_-]*few\b/i },
  { label: "Ring Few", regex: /\bRing\s+Few\b/ },
  { label: "projects/ring-few/index.js", regex: /projects[\\/]ring-few[\\/]index\.js/i },
  { label: "ring-few/index.js", regex: /\bring-few[\\/]index\.js/i },
  { label: "FewFactory", regex: /\bFewFactory\b/ },
  { label: "FewWrappedToken", regex: /\bFewWrappedToken\b/ },
  { label: "CoreRef", regex: /\bCoreRef\b/ },
  { label: "few-v2", regex: /\bfew[\s_-]*v2\b/i },
  { label: "ring-v2", regex: /\bring[\s_-]*v2\b/i },
  { label: "fwTSLAon", regex: /\bfwTSLAon\b/i },
  { label: "fwAAPLon", regex: /\bfwAAPLon\b/i },
  { label: "fwJPMON", regex: /\bfwJPMON\b/i },
  { label: "fwSPYON", regex: /\bfwSPYON\b/i },
  ...FACTORY_SEEDS.map((row) => ({ label: `${row.chain} FewFactory`, regex: new RegExp(row.address.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") })),
];

const STRONG_DOMAIN_RULES = [
  { label: "allWrappedTokensLength", regex: /\ballWrappedTokensLength\b/ },
  { label: "allWrappedTokens", regex: /\ballWrappedTokens\b/ },
  { label: "getWrappedToken", regex: /\bgetWrappedToken\b/ },
  { label: "createToken", regex: /\bcreateToken\b/ },
  { label: "wrapped token", regex: /\bwrapped\s+tokens?\b/i },
  { label: "Few wrapper symbol", regex: /\bfw[A-Za-z0-9]+\b/ },
  { label: "wrapTo", regex: /\bwrapTo\b/ },
  { label: "unwrapTo", regex: /\bunwrapTo\b/ },
  { label: "wrap", regex: /\bwrap\b/i },
  { label: "unwrap", regex: /\bunwrap\b/i },
  { label: "mint", regex: /\bmint(?:er|ing)?\b/i },
  { label: "burnFrom", regex: /\bburnFrom\b/ },
  { label: "burner", regex: /\bburner\b/i },
  { label: "pauser", regex: /\bpauser\b/i },
  { label: "guardian", regex: /\bguardian\b/i },
  { label: "governor", regex: /\bgovernor\b/i },
  { label: "bridge", regex: /\bbridge\b/i },
  { label: "custody", regex: /\bcustody\b/i },
  { label: "proof", regex: /\bproof\b/i },
  { label: "domain", regex: /\bdomain\b/i },
  { label: "nonce", regex: /\bnonce\b/i },
  { label: "escrow", regex: /\bescrow\b/i },
  { label: "backing", regex: /\bbacking\b/i },
];

const CONTEXT_RULES = [
  ...STRONG_DOMAIN_RULES,
  { label: "factory", regex: /\bfactory\b/i },
  { label: "router", regex: /\brouter\b/i },
  { label: "AMM", regex: /\bamm\b/i },
  { label: "pair", regex: /\bpair\b/i },
  { label: "pool", regex: /\bpool\b/i },
  { label: "DEX", regex: /\bdex\b/i },
  { label: "lending", regex: /\blending\b/i },
  { label: "borrow", regex: /\bborrow\b/i },
  { label: "consumer", regex: /\bconsumer\b/i },
  { label: "oracle", regex: /\boracle\b/i },
  { label: "permit", regex: /\bpermit\b/i },
  { label: "CREATE2", regex: /\bcreate2\b/i },
  { label: "paused", regex: /\bpaused?\b/i },
  { label: "role", regex: /\brole\b/i },
  { label: "tokenized stock", regex: /\btokeni[sz]ed\s+stock\b/i },
  { label: "transfer restriction", regex: /\btransfer\s+restriction\b/i },
  { label: "unlock", regex: /\bunlock\b/i },
  { label: "exit", regex: /\bexit\b/i },
];

const CATEGORY_RULES = {
  consumer: ["consumer", "accepted", "collateral", "borrow", "lending", "market", "morpho", "euler", "silo", "aave", "compound", "comet", "vault", "lltv", "ltv", "supplycap", "cash", "exit venue"],
  dex: ["dex", "swap", "pool", "amm", "pair", "router", "few-v2", "ring-v2", "uniswap", "curve", "liquidity", "quote", "exit"],
  oracle: ["oracle", "price", "feed", "exchange rate", "chainlink", "pyth", "redstone", "proof price", "valuation"],
  bridgeCustody: ["bridge", "custody", "escrow", "backing", "proof", "domain", "nonce", "unlock", "wrapped", "cross-chain", "hyperliquid", "hyperevm"],
  wrapper: ["fewwrappedtoken", "wrapped token", "wrap", "wrapto", "unwrap", "unwrapto", "allwrappedtokens", "fw", "tokenized stock", "token()", "underlying"],
  role: ["role", "governor", "guardian", "minter", "burner", "pauser", "core ref", "coreref", "owner", "admin", "permission", "gated"],
  proofBinding: ["proof", "domain", "nonce", "recipient", "token binding", "replay", "message", "signature", "attestation"],
  factory: ["fewfactory", "factory", "createtoken", "getwrappedtoken", "create2", "allwrappedtokens", "paused"],
  economics: ["routepositive", "positive", "profit", "backing mismatch", "supply", "custody", "liquidity", "slippage", "tvl", "borrowusd", "supplyusd", "exacteconomics"],
};

const JSON_FIELD_ALLOWLIST = [
  "rank", "kind", "slug", "name", "category", "tvlUsd", "tvl", "currentTvlUsd", "chains", "primaryChain", "evmChains", "accessibleEvmChains", "blockedOrCaveatChains", "surface", "routeGraph", "firstReadOnlyChecks", "module", "score", "chain", "chainId", "adapterKey", "adapterChain", "symbol", "assetSymbol", "assetName", "asset", "underlying", "token", "wrappedToken", "wrapper", "wrapped", "factory", "pair", "pool", "router", "oracle", "priceFeed", "feedDescription", "market", "collateral", "loan", "vault", "address", "implementation", "role", "paused", "mint", "burn", "wrap", "unwrap", "domain", "nonce", "recipient", "escrow", "custody", "backing", "supply", "totalSupply", "totalSupplyRaw", "balance", "balanceRaw", "usdTotal", "liquidity", "borrowUsd", "supplyUsd", "routePositive", "executableNow", "signedActionJustified", "forkJustified", "classification", "status", "watchCandidate",
];

const BLOCKERS = [
  "No exact permissionless Ring Few value movement is proven from local artifacts; rows remain source/static/context only.",
  "No backing mismatch or proof bypass is quantified for a specific wrapped token, custody asset, domain, nonce, recipient, and chain pair.",
  "Wrapper supply versus custody holdings is not locally proven at route scale; factory addresses are static seeds and not live code/state proof.",
  "FewWrappedToken mint, burnFrom, and core role surfaces appear role-gated in public/static context; no public role bypass is proven.",
  "Wrap/unwrap routes remain blocked unless token transfer restrictions, paused state, allowlists, underlying custody, and same-asset redemption are proven open.",
  "No exact consumer acceptance row proves current lending/borrow capacity, caps, oracle freshness, and borrower-side overvaluation for a Ring Few wrapped asset.",
  "Few/Ring V2 AMM or other DEX liquidity is not tied to exact acquisition/unlock/unwrap/swap/borrow economics after fees, slippage, restrictions, and gas.",
  "Hyperliquid L1/HyperEVM remains caveat/context without local support for chain semantics, endpoint-free state, and exit path.",
  "Fork and signed-action gates remain closed because routePositive=0 and exactEconomicsRows=0.",
];

const REQUIRED_FOR_ROUTE_POSITIVE = [
  "Backing mismatch/proof bypass: exact proof/domain/nonce/token/recipient binding flaw that permissionlessly unlocks or mints value without equivalent custody movement.",
  "Wrapper supply versus custody: current wrapped supply and wrapper-held underlying balances must show exploitable divergence at route scale, not just static factory labels.",
  "Role-gated blockers: prove mint, burnFrom, unwrap, pause, governor/guardian/minter/burner/pauser checks are bypassable or irrelevant to the route.",
  "Token transfer restrictions: validate wrapped/underlying token transfer, allowlist, blacklist, tokenized-stock, and permit behavior along the full route.",
  "Exact consumer acceptance: identify a live lending/vault/borrow consumer accepting the specific wrapped asset with material caps, liquidity, oracle configuration, and no pause/role blocker.",
  "DEX/AMM liquidity: quantify Few/Ring V2 or external AMM liquidity, price impact, fees, transfer restrictions, and exit depth for the same asset.",
  "Exact acquisition/unlock/unwrap/swap/borrow economics: compute all route legs including proof costs, bridge fees, AMM slippage, borrow limits, liquidation factors, and gas.",
  "HyperEVM caveat: handle Hyperliquid L1/HyperEVM chain semantics and bridge finality before treating that context as executable.",
  "Fork/static value-delta proof: local static proof or fork simulation must show positive attacker-controlled balance delta before any live preflight or signed action is considered.",
  "Explicit route-specific authorization and independent defensive review are required before any signed transaction path is discussed.",
];

const NEXT_READ_ONLY_STEP = "Map Ring Few FewFactory/FewWrappedToken wrappers from static verified source labels and local artifacts, then join each wrapped token to local lending/DEX/oracle rows to compare wrapper supply, custody backing, and exact exit economics without endpoint inventory or signed actions.";

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
  const roots = [path.join(WORKSPACE, "reports"), path.join(WORKSPACE, "targets")];
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

function matchForLine(line, windowText) {
  const exact = firstRuleMatch(line, EXACT_RULES) || firstRuleMatch(windowText, EXACT_RULES);
  if (exact) return { matchType: "exact-name-or-address", matched: exact.label, termType: "text" };
  const strong = firstRuleMatch(line, STRONG_DOMAIN_RULES);
  if (strong) return { matchType: "context-domain", matched: strong.label, termType: "text" };
  const context = firstRuleMatch(line, CONTEXT_RULES);
  if (!context) return null;
  if (hasRuleMatch(windowText, EXACT_RULES) || hasRuleMatch(windowText, STRONG_DOMAIN_RULES)) {
    return { matchType: "context", matched: context.label, termType: "text" };
  }
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
    if (!hasRuleMatch(text, [...EXACT_RULES, ...STRONG_DOMAIN_RULES])) continue;
    const lines = text.split(/\r?\n/);
    let sampled = 0;
    let fileMatched = false;
    let fileExact = false;
    const seen = new Set();
    for (let i = 0; i < lines.length && rows.length < MAX_LOCAL_MATCH_ROWS && sampled < MAX_ROWS_PER_FILE; i += 1) {
      const line = String(lines[i] || "");
      if (!line.trim()) continue;
      const windowText = [lines[i - 2], lines[i - 1], lines[i], lines[i + 1], lines[i + 2]].map((x) => String(x || "")).join(" ");
      const match = matchForLine(line, windowText);
      if (!match) continue;
      const key = `${rel(file)}:${i + 1}:${match.matchType}:${match.matched}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fileMatched = true;
      if (match.matchType === "exact-name-or-address") fileExact = true;
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
        classification: "local-artifact-watch-context-only-no-route-positive",
      });
      sampled += 1;
    }
    if (fileMatched) filesWithMatch += 1;
    if (fileExact) filesWithExact += 1;
    if (rows.length >= MAX_LOCAL_MATCH_ROWS) break;
  }

  return { filesScanned, filesWithMatch, filesWithExact, rows, exactRows: rows.filter((row) => row.matchType === "exact-name-or-address"), categoryCounts };
}

function shouldSkipJsonKey(key) {
  return /(url|uri|endpoint|hostname|host|secret|password|private|api[-_]?key|access[-_]?key|auth|bearer|cookie)/i.test(String(key || ""));
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
    const match = matchForLine(blob, `${blob} ${context || ""}`);
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
          classification: match.matchType === "exact-name-or-address" ? "exact-local-watch-context-only-no-positive-economics" : "local-artifact-watch-context-only-no-route-positive",
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
    const json = readJson(file);
    if (json === null) continue;
    jsonFilesParsed += 1;
    visit(json, file, "$", 0);
    if (rows.length >= MAX_LOCAL_OBJECT_ROWS) break;
  }

  return { jsonFilesParsed, rows, exactRows: rows.filter((row) => row.matchType === "exact-name-or-address"), categoryCounts };
}

function exactish(row) {
  return row.matchType === "exact-name-or-address";
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
  const highSignal = rows.filter((row) => row.categories.some((cat) => ["bridgeCustody", "wrapper", "role", "proofBinding", "consumer", "dex", "oracle"].includes(cat)));
  return uniqBy([...exact, ...highSignal], (row) => `${sourceForRow(row)}:${row.matchType}:${row.matched}`).slice(0, 28);
}

function buildPayload({ lineScan, objectScan }) {
  const combinedRows = uniqBy([...objectScan.rows, ...lineScan.rows], (row) => `${sourceForRow(row)}:${row.matchType}:${row.matched}:${row.rowSource}`);
  const exactRows = combinedRows.filter(exactish);
  const consumerJoinRows = pickRows(combinedRows, (row) => row.categories.includes("consumer"), 140);
  const exactConsumerJoinRows = pickRows(consumerJoinRows, exactish, 120);
  const dexLiquidityRows = pickRows(combinedRows, (row) => row.categories.includes("dex"), 140);
  const oracleRows = pickRows(combinedRows, (row) => row.categories.includes("oracle"), 140);
  const bridgeCustodyRows = pickRows(combinedRows, (row) => row.categories.includes("bridgeCustody"), 140);
  const wrapperRows = pickRows(combinedRows, (row) => row.categories.includes("wrapper"), 140);
  const roleRows = pickRows(combinedRows, (row) => row.categories.includes("role"), 140);
  const proofBindingRows = pickRows(combinedRows, (row) => row.categories.includes("proofBinding"), 140);
  const factoryRows = pickRows(combinedRows, (row) => row.categories.includes("factory"), 100);
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
    factorySeedRows: FACTORY_SEEDS.length,
    coreSurfaceRows: CORE_SURFACES.length,
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
    bridgeCustodyRows: bridgeCustodyRows.length,
    wrapperRows: wrapperRows.length,
    roleRows: roleRows.length,
    proofBindingRows: proofBindingRows.length,
    localFactoryContextRows: factoryRows.length,
    publicFetchRows: 0,
    rpcInventoryRows: 0,
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
    scanner: "tools/scan-ring-few-full-test.js",
    target: TARGET,
    scope: {
      kind: "defensive route-first full-test scanner",
      artifactOnly: true,
      evmFirst: true,
      discoveryChains: TARGET.primaryChains,
      staticAdapterChains: CHAIN_SEEDS.map((row) => row.chainLabel),
      caveatChains: CHAIN_SEEDS.filter((row) => row.caveat).map((row) => row.chainLabel),
      routeGraph: TARGET.routeGraph,
      writesLimitedTo: [OUT_JSON_REL, OUT_MD_REL],
      aggregatePromotionStateHandoffEdited: false,
    },
    safety: {
      localArtifactsRead: true,
      publicSourcesRead: true,
      publicNetworkFetch: false,
      rpcInventoryRead: false,
      rpcInventoryRows: 0,
      graphqlInventoryRead: false,
      envFilesRead: false,
      privateKeysRead: false,
      keyMaterialRead: false,
      rpcUrlsStored: false,
      rawUrlsStored: false,
      rawDomainsStored: false,
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
      factorySeeds: FACTORY_SEEDS,
      coreSurfaces: CORE_SURFACES,
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
      bridgeCustodyRows,
      wrapperRows,
      roleRows,
      proofBindingRows,
      factoryRows,
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
    "sourceFactRows", "chainSeedRows", "factorySeedRows", "coreSurfaceRows", "filesScanned", "filesWithLocalMatches", "filesWithExactLocalMatches", "jsonFilesParsed", "localArtifactMatchRows", "exactLocalArtifactMatchRows", "localLineRows", "localObjectRows", "consumerJoinRows", "exactConsumerJoinRows", "dexLiquidityRows", "oracleRows", "bridgeCustodyRows", "wrapperRows", "roleRows", "proofBindingRows", "localFactoryContextRows", "publicFetchRows", "rpcInventoryRows", "exactEconomicsRows", "routePositive", "executableNow", "signedActionJustified", "forkJustified", "forkGate",
  ];
  return keys.map((key) => `| ${key} | ${mdEscape(summary[key])} |`).join("\n");
}

function safetyRows(safety) {
  const keys = [
    "localArtifactsRead", "publicSourcesRead", "publicNetworkFetch", "rpcInventoryRead", "graphqlInventoryRead", "envFilesRead", "privateKeysRead", "keyMaterialRead", "rpcUrlsStored", "rawUrlsStored", "rawDomainsStored", "signedActions", "liveTransactions", "broadcasts", "forkTransactions", "ethCallOnly", "sanitizedOutputOnly", "secretLikePathsExcluded",
  ];
  return keys.map((key) => `| ${key} | ${mdEscape(safety[key])} |`).join("\n");
}

function formatRow(row) {
  const source = sourceForRow(row);
  const categories = (row.categories || []).join(",");
  const detail = row.context || row.sample || fieldsContext(row.fields || {}) || "context-only";
  return `| ${mdEscape(source)} | ${mdEscape(categories)} | ${mdEscape(row.matched)} | ${mdEscape(detail)} | ${mdEscape(row.routePositive)} | ${mdEscape(row.classification)} |`;
}

function formatFactorySeed(row) {
  return `| ${mdEscape(row.chain)} | ${mdEscape(row.chainId ?? "n/a")} | ${mdEscape(row.role)} | ${mdEscape(row.address)} | ${mdEscape(row.classification)} |`;
}

function buildMarkdown(payload) {
  const signal = payload.routeGate.routePositive === 0 ? "🟢 DORMANT" : "🔴 ROUTE-POSITIVE";
  const notableRows = payload.localArtifacts.notableRows.length
    ? payload.localArtifacts.notableRows.map(formatRow).join("\n")
    : "| (none) | n/a | n/a | no local context rows found | 0 | dormant |";
  const factoryRows = payload.discoveredSeeds.factorySeeds.map(formatFactorySeed).join("\n");

  return `# ${signal} - Ring Few Full Test

Generated: ${payload.generatedAt}

Route remains closed: routePositive=${payload.routeGate.routePositive}, executableNow=${payload.routeGate.executableNow}, signedActionJustified=${payload.routeGate.signedActionJustified}, forkJustified=${payload.routeGate.forkJustified}, forkGate=${payload.routeGate.forkGate}.

## Summary

| Metric | Value |
|---|---:|
${metricRows(payload.summary)}

## Target

- Target: ${payload.target.name} (${payload.target.slug}), kind=${payload.target.kind}, category=${payload.target.category}, surface=${payload.target.surface}, module=${payload.target.module}, rank≈${payload.target.discoveryRank}, TVL context≈${payload.target.tvlContext}.
- Discovery chains: ${payload.target.primaryChains.join(", ")}.
- Route graph: ${payload.target.routeGraph}.
- Static public source labels only: ${payload.sourceFacts.map((row) => row.sourceLabel).join(", ")}.

## Scope

- Scanner kind: ${payload.scope.kind}; artifactOnly=${payload.scope.artifactOnly}; evmFirst=${payload.scope.evmFirst}.
- Writes limited to: ${payload.scope.writesLimitedTo.join(", ")}.
- Static adapter chains: ${payload.scope.staticAdapterChains.join(", ")}.
- Caveat chains/context: ${payload.scope.caveatChains.join(", ") || "none"}.
- No aggregate gate scripts, state/context files, handoff files, secret/endpoint inventories, or wallet/key material are written or read.

## Safety

| Field | Value |
|---|---:|
${safetyRows(payload.safety)}

## Chain / Factory Seeds (static, not live code proof)

| Chain | Chain ID | Role | Address | Classification |
|---|---:|---|---|---|
${factoryRows}

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
  log("Scanning Ring Few local artifacts (sanitized, no endpoint inventory)...");
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
