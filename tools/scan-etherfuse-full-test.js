#!/usr/bin/env node
"use strict";

// scan-etherfuse-full-test.js
// Defensive Etherfuse full-test scanner. Deterministic local/static artifacts
// only; no endpoint inventories, network calls, RPC, forks, signed actions,
// broadcasts, or wallets.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_DIR = path.join(WORKSPACE, "reports", "raw", "fast");
const REPORTS_DIR = path.join(WORKSPACE, "reports");
const OUT_JSON = path.join(RAW_DIR, "etherfuse-full-test.json");
const OUT_MD = path.join(REPORTS_DIR, "etherfuse-full-test-triage.md");
const OUT_JSON_REL = "reports/raw/fast/etherfuse-full-test.json";
const OUT_MD_REL = "reports/etherfuse-full-test-triage.md";
const PREFILTER_JSON_REL = "reports/raw/fast/prefilter-etherfuse-route-prefilter.json";
const PREFILTER_MD_REL = "reports/prefilter-etherfuse-route-prefilter.md";

const QUIET = process.argv.includes("--quiet");
const GENERATED_AT = process.env.SCAN_GENERATED_AT || "2026-07-07T00:00:00.000Z";
const MAX_FILE_BYTES = 24 * 1024 * 1024;
const MAX_LOCAL_MATCH_ROWS = 760;
const MAX_ROWS_PER_FILE = 36;

const TARGET = {
  slug: "etherfuse",
  protocolSlug: "etherfuse",
  name: "Etherfuse",
  category: "RWA / tokenized government bonds",
  surface: "rwa-tokenized-bond-consumer",
  tvlContext: "$1.191M",
  evmScopeChains: ["Polygon", "Base"],
  caveatChains: ["Solana", "Stellar", "Monad"],
  routeGraph: "tokenized bond -> transfer/redeem/NAV/oracle -> lending/DEX consumer -> borrow/redeem/unwind/exit",
  module: "etherfuse/index.js",
  coordinatorClaim: "coordinator-etherfuse-fulltest-01",
};

const CHAIN_SEEDS = [
  { chain: "Polygon", chainId: 137, adapterKey: "polygon", evmFirst: true, caveat: false, classification: "evm-tokenized-bond-chain" },
  { chain: "Base", chainId: 8453, adapterKey: "base", evmFirst: true, caveat: false, classification: "evm-tokenized-bond-chain" },
  { chain: "Solana", chainId: null, adapterKey: "solana", evmFirst: false, caveat: true, classification: "non-evm-token-supply-caveat" },
  { chain: "Stellar", chainId: null, adapterKey: "stellar", evmFirst: false, caveat: true, classification: "non-evm-token-supply-caveat" },
  { chain: "Monad", chainId: null, adapterKey: "monad", evmFirst: false, caveat: true, classification: "unavailable-sanitized-coverage-caveat" },
];

const STATIC_TOKEN_SEEDS = [
  { chainId: 137, chain: "Polygon", address: "0x834df4C1d8f51Be24322E39e4766697BE015512F", symbol: "CETES", name: "Etherfuse CETES" },
  { chainId: 137, chain: "Polygon", address: "0xC6221856E45ed806F8325a084bED3D69D32C526d", symbol: "EUROB", name: "Etherfuse EUROB" },
  { chainId: 137, chain: "Polygon", address: "0x46080F31351A6568f44575E3EFfDE7f0C86867f9", symbol: "GILTS", name: "Etherfuse GILTS" },
  { chainId: 137, chain: "Polygon", address: "0xd574b191B5a00262Ff19953d3CE25543AB7C8098", symbol: "TESOURO", name: "Etherfuse TESOURO" },
  { chainId: 137, chain: "Polygon", address: "0xc2C1f8Eb98C0468Be0232DD4166705d0Dea3Fe31", symbol: "USTRY", name: "Etherfuse USTRY" },
  { chainId: 8453, chain: "Base", address: "0x834df4C1d8f51Be24322E39e4766697BE015512F", symbol: "CETES", name: "Etherfuse CETES" },
  { chainId: 8453, chain: "Base", address: "0xC6221856E45ed806F8325a084bED3D69D32C526d", symbol: "EUROB", name: "Etherfuse EUROB" },
  { chainId: 8453, chain: "Base", address: "0x46080F31351A6568f44575E3EFfDE7f0C86867f9", symbol: "GILTS", name: "Etherfuse GILTS" },
  { chainId: 8453, chain: "Base", address: "0x7ceE47e7B7CD04CF984e8Dd86C42595B5771A9B2", symbol: "TESOURO", name: "Etherfuse TESOURO" },
  { chainId: 8453, chain: "Base", address: "0xc2C1f8Eb98C0468Be0232DD4166705d0Dea3Fe31", symbol: "USTRY", name: "Etherfuse USTRY" },
];

const SURFACE_ROWS = [
  { component: "tokenized bond ERC20", surface: "CETES/EUROB/GILTS/TESOURO/USTRY on Polygon/Base", routeRole: "producer asset prerequisite", watchTerms: ["CETES", "EUROB", "GILTS", "TESOURO", "USTRY"] },
  { component: "NAV/oracle", surface: "off-chain RWA/bond value, accepted value, or oracle/NAV source", routeRole: "accepted-value divergence prerequisite", watchTerms: ["NAV", "oracle", "price", "reference", "bond"] },
  { component: "redemption", surface: "redeem, withdraw, burn, claim, settlement, maturity", routeRole: "exit/NAV realization prerequisite", watchTerms: ["redeem", "withdraw", "burn", "settle", "maturity"] },
  { component: "transfer restrictions", surface: "KYC, allowlist, whitelist, pause, blacklist, restricted transfer", routeRole: "acquisition/exit blocker", watchTerms: ["KYC", "allowlist", "whitelist", "blacklist", "pause"] },
  { component: "role/admin", surface: "minter, owner, admin, upgrade, pauser, compliance roles", routeRole: "permissioned-control blocker", watchTerms: ["owner", "admin", "role", "minter", "upgrade"] },
  { component: "consumer joins", surface: "lending/oracle/borrow/liquidation consumers", routeRole: "borrow/liquidation path", watchTerms: ["Aave", "Morpho", "Euler", "Silo", "collateral", "borrow"] },
  { component: "DEX/exit", surface: "DEX, redemption, pool, swap, exit, unwind liquidity", routeRole: "exit/economics prerequisite", watchTerms: ["DEX", "swap", "pool", "liquidity", "exit"] },
  { component: "non-EVM coverage", surface: "Solana/Stellar/Monad token supply and transfer semantics", routeRole: "coverage caveat", watchTerms: ["Solana", "Stellar", "Monad"] },
  { component: "local fork/value-delta", surface: "local-only fork harness gate", routeRole: "non-meaningful until route-positive candidate", watchTerms: ["fork", "anvil", "valueDelta", "routePositive"] },
];

const BUG_CLASS_ROWS = [
  { label: "RWA/NAV accepted-value overvaluation", surface: "bond token NAV/oracle vs acquisition/exit value", classification: "bug-class-context-no-current-nav-consumer-edge" },
  { label: "permissionless redemption or settlement bypass", surface: "redeem/withdraw/burn/claim/maturity", classification: "bug-class-context-no-public-redemption-bypass" },
  { label: "transfer restriction bypass", surface: "KYC/allowlist/blacklist/paused transfer", classification: "bug-class-context-no-transfer-bypass" },
  { label: "role/admin mint or upgrade abuse", surface: "minter/admin/owner/upgrader/pauser roles", classification: "bug-class-role-controlled-no-permissionless-path" },
  { label: "lending consumer collateral overvaluation", surface: "Aave/Morpho/Euler/Silo consumer join", classification: "bug-class-context-no-etherfuse-consumer-join" },
  { label: "DEX/redeem exit value positive", surface: "DEX/redeem/borrow/unwind liquidity", classification: "bug-class-context-no-dex-liquidity-or-economics" },
  { label: "fork attempted before route-positive", surface: "local fork harness", classification: "bug-class-gated-by-route-positive-zero" },
];

const SOURCE_FACTS = [
  { sourceLabel: "target-context:Etherfuse", kind: "target-seed", slug: TARGET.slug, protocolSlug: TARGET.protocolSlug, name: TARGET.name, category: TARGET.category, surface: TARGET.surface, tvlContext: TARGET.tvlContext, chains: [...TARGET.evmScopeChains, ...TARGET.caveatChains], module: TARGET.module, routePositive: 0, classification: "structured-target-seed-route-negative" },
  { sourceLabel: "prior-prefilter-artifact:etherfuse-route-prefilter", kind: "local-prefilter-context", artifacts: [PREFILTER_JSON_REL, PREFILTER_MD_REL], priorRoutePositive: 0, classification: "prior-prefilter-context-no-route-positive" },
  { sourceLabel: "route-model:rwa-tokenized-bond-consumer", kind: "route-graph", model: TARGET.routeGraph, routePositiveOnlyIf: "permissionless redemption/transfer/NAV/oracle flaw or consumer overvaluation joins material borrow/DEX/redeem exit with exact positive economics", classification: "route-model-fail-closed" },
  { sourceLabel: "non-evm-caveats:solana-stellar-monad", kind: "coverage-caveat", caveats: TARGET.caveatChains, classification: "non-evm-and-unavailable-coverage-not-route-negative-closeout" },
];

const STATIC_CONTEXT_ROWS = [
  { sourceLabel: "prior-dormant-result", matched: "prefilter route-negative", categories: ["token", "navOracle", "redemption", "exactEconomics"], sample: "Prior prefilter found 10 code-present Polygon/Base Etherfuse token rows, no ERC4626 interface rows, no local consumer join, no DEX liquidity, exactEconomicsRows=0, routePositive=0.", classification: "prior-prefilter-dormant-no-route-positive" },
  { sourceLabel: "tokenized-bond-context", matched: "tokenized bond", categories: ["token", "navOracle"], sample: "Etherfuse tokenized government bonds are producer-asset context only until a public redemption/NAV/consumer/exit path is proven.", classification: "tokenized-bond-context-only" },
  { sourceLabel: "redemption-permission-caveat", matched: "permissioned redemption", categories: ["redemption", "transferRestriction", "roleAdmin"], sample: "RWA token issuance/redemption/transferability is treated as permissioned or restricted absent public same-block execution proof.", classification: "permissioned-redemption-transfer-caveat" },
  { sourceLabel: "consumer-dex-absence", matched: "no consumer or DEX joins", categories: ["consumerJoin", "dexExit", "exactEconomics"], sample: "No Etherfuse-specific token joins a local material lending/oracle/liquidation consumer or DEX exit with exact positive economics.", classification: "no-consumer-dex-or-economics" },
  { sourceLabel: "non-evm-caveat", matched: "Solana/Stellar/Monad caveat", categories: ["nonEvmCaveat"], sample: "Solana and Stellar token supplies plus Monad coverage are caveats and are not closed route-negative by this EVM-first local scan.", classification: "non-evm-coverage-caveat" },
  { sourceLabel: "fork-prereq-row", matched: "local fork prerequisites", categories: ["forkPrereq", "exactEconomics"], sample: "Fork harness remains inert until routePositive > 0, a code-present permissionless value-moving candidate, exact current economics, and local value-delta proof exist.", classification: "fork-gated-route-positive-zero" },
].map((row) => ({ rowSource: "static-public-fact", matchType: "static-public-fact", termType: "static", routePositive: 0, sourceRoutePositiveNotPromoted: false, ...row }));

const EXPLICIT_FILES = [
  PREFILTER_JSON_REL,
  PREFILTER_MD_REL,
  "reports/raw/fast/rwa-nav-consumer-graph.json",
  "reports/raw/fast/consumer-first-high-ltv-collateral.json",
  "reports/raw/fast/aave-euler-silo-consumer-graph.json",
  "reports/raw/fast/euler-v2-phase0.json",
  "reports/raw/fast/silo-v2-phase0.json",
  "reports/raw/fast/morpho-high-apy-liquidation-routes.json",
  "reports/raw/fast/morpho-liquidatable-marketability.json",
  "reports/raw/fast/erc4626-consumer-joiner.json",
  "reports/raw/fast/dex-consumer-routes.json",
  "reports/raw/fast/dex-exit-quotes.json",
  "reports/raw/fast/current-liquidatable-exit-routes.json",
  "reports/raw/fast/stablecoin-depeg-lending-routes.json",
  "reports/raw/fast/fake-asset-pool-validation.json",
  "reports/raw/fast/validation-differential-liquidations.json",
];

function escapeRegExp(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function log(...args) { if (!QUIET) console.log(...args); }
function ensureDir(filePath) { fs.mkdirSync(path.dirname(filePath), { recursive: true }); }
function rel(filePath) { return path.relative(WORKSPACE, filePath).replace(/\\/g, "/"); }
function jsonReplacer(_key, value) { return typeof value === "bigint" ? value.toString() : value; }
function isEvmAddress(value) { return /^0x[0-9a-fA-F]{40}$/.test(String(value || "")); }
function normalizeAddress(value) { return isEvmAddress(value) ? `0x${String(value).slice(2).toLowerCase()}` : null; }

function sanitizeText(value, max = 420) {
  let text = String(value ?? "").replace(/[\r\n|]+/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  text = text
    .replace(/\brpc_endpoints\.txt\b/gi, "[redacted-endpoint-inventory]")
    .replace(/\bgraphql_endpoints\.txt\b/gi, "[redacted-endpoint-inventory]")
    .replace(/\bhttps?:\/\/[^\s"'`<>|)]+/gi, "[redacted-url]")
    .replace(/\bwww\.[^\s"'`<>|)]+/gi, "[redacted-url]")
    .replace(/\b(?:[a-z0-9-]+\.)+(?:com|org|net|io|fi|app|xyz|finance|protocol|dev|co|so|network|tech|exchange|build|money|info|ai|eth|gg)\b/gi, "[redacted-domain]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/= -]+/gi, "Bearer [redacted]")
    .replace(/\b(authorization|api[-_]?key|access[-_]?key|private[-_]?key|secret[-_]?key|secret|token|password|pwd)\s*[:=]\s*["']?[^\s"',}\]]{8,}/gi, "$1=[redacted]")
    .replace(/\b0x[0-9a-fA-F]{64}\b/g, "[redacted-hex-key]")
    .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9._-]{20,}\.[A-Za-z0-9._-]{20,}\b/g, "[redacted-jwt]");
  return text.slice(0, max) || null;
}

function mdEscape(value) { return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim(); }
function safeNumber(value) { const n = Number(String(value ?? "").replace(/[$,%\s,]/g, "")); return Number.isFinite(n) ? n : 0; }
function safeBool(value) { return Boolean(value); }

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

function pickRows(rows, predicate, max = 180) {
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
  if (/(^|[\/\\])(?:private|secret|secrets|mnemonic|seed|wallet|keypair|keystore|api[-_]?key|access[-_]?key)(?:[\/\\._-]|$)/i.test(r)) return true;
  return false;
}

function isExcludedScanPath(filePath) {
  const r = rel(filePath).toLowerCase();
  const base = path.basename(filePath).toLowerCase();
  if (r === OUT_JSON_REL.toLowerCase() || r === OUT_MD_REL.toLowerCase()) return true;
  if (r === "tools/scan-etherfuse-full-test.js" || r === "tools/fork-test-etherfuse-routes.js") return true;
  if (isSecretLikePath(filePath)) return true;
  if (base.includes("endpoint")) return true;
  if (r.includes("/node_modules/") || r.includes("/.git/")) return true;
  if (r.includes("/cache/") || r.includes("/out/") || r.includes("/broadcast/") || r.includes("/artifacts/")) return true;
  if (r.startsWith(".opencode/") || r.startsWith("coordination/")) return true;
  if (/(?:handoff|shared_context|state\.md|audit-completion-gates|route-positive-sweep|low-fund-executable-route-filter|exploit-findings-summary|full-test|fork-route-test)/i.test(r)) return true;
  return false;
}

function isUnsafeSampleText(text) {
  return /\b(?:rpc_endpoints\.txt|graphql_endpoints\.txt|private[-_]?key|secret[-_]?key|mnemonic|seed\s+phrase|bearer\s+|authorization\s*[:=]|password\s*[:=]|pwd\s*[:=])\b/i.test(String(text || ""));
}

function readText(filePath) {
  try {
    if (isSecretLikePath(filePath)) return null;
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    return fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  } catch (_error) { return null; }
}

function readJson(filePath) {
  const text = readText(filePath);
  if (!text) return null;
  try { return JSON.parse(text); } catch (_error) { return null; }
}

function writeJson(filePath, value) { ensureDir(filePath); fs.writeFileSync(filePath, `${JSON.stringify(value, jsonReplacer, 2)}\n`, "utf8"); }
function writeText(filePath, value) { ensureDir(filePath); fs.writeFileSync(filePath, value, "utf8"); }

function listFilesRecursive(rootDir, filterFn = null) {
  const out = [];
  if (!fs.existsSync(rootDir)) return out;
  function walk(dir) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_error) { return; }
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
      if (filterFn && !filterFn(full)) continue;
      out.push(full);
    }
  }
  walk(rootDir);
  return out;
}

function listRelatedReportFiles() {
  const fast = path.join(WORKSPACE, "reports", "raw", "fast");
  return listFilesRecursive(fast, (file) => /(?:etherfuse|cetes|eurob|gilts|tesouro|ustry|rwa|nav|bond|token|collateral|consumer|aave|euler|silo|morpho|dex|exit|oracle|redeem|redemption|transfer|restriction|role|admin|econom|liquid|erc4626)/i.test(path.basename(file)));
}

function listScanFiles() {
  const files = [];
  for (const file of EXPLICIT_FILES) {
    const full = path.join(WORKSPACE, file);
    if (fs.existsSync(full) && !isExcludedScanPath(full)) files.push(full);
  }
  files.push(...listRelatedReportFiles());
  return uniqBy(files, (file) => path.resolve(file)).sort((a, b) => rel(a).localeCompare(rel(b)));
}

const ADDRESS_RULES = STATIC_TOKEN_SEEDS
  .map((row) => row.address)
  .filter(isEvmAddress)
  .map((address) => ({ label: address, regex: new RegExp(escapeRegExp(address), "i") }));

const EXACT_RULES = [
  { label: "Etherfuse", regex: /\bEtherfuse\b/i },
  { label: "etherfuse", regex: /\betherfuse\b/i },
  { label: "etherfuse/index.js", regex: /\betherfuse[\\/]index\.js\b/i },
  { label: "CETES", regex: /\bCETES\b/i },
  { label: "EUROB", regex: /\bEUROB\b/i },
  { label: "GILTS", regex: /\bGILTS\b/i },
  { label: "TESOURO", regex: /\bTESOURO\b/i },
  { label: "USTRY", regex: /\bUSTRY\b/i },
  ...ADDRESS_RULES,
];

const CONTEXT_RULES = [
  { label: "tokenized bond/RWA", regex: /\b(?:RWA|bond|tokenized|treasury|government|CETES|EUROB|GILTS|TESOURO|USTRY)\b/i },
  { label: "NAV/oracle", regex: /\b(?:NAV|net\s*asset|oracle|price|reference|feed|valuation|accepted[-\s]?value|collateral\s*factor)\b/i },
  { label: "redemption", regex: /\b(?:redeem|redemption|withdraw|burn|claim|settle|settlement|maturity|coupon|cash)\b/i },
  { label: "transfer restriction", regex: /\b(?:KYC|whitelist|allowlist|blacklist|restricted|paused?|transfer\s*gate|compliance)\b/i },
  { label: "role/admin", regex: /\b(?:owner|admin|role|MINTER_ROLE|minter|pauser|upgrader|upgrade|proxy|implementation)\b/i },
  { label: "consumer", regex: /\b(?:consumer|collateral|borrow|lending|market|Aave|Compound|Comet|Euler|Morpho|Silo|liquidation)\b/i },
  { label: "DEX/exit", regex: /\b(?:DEX|swap|pool|liquidity|Uniswap|Curve|Balancer|Pancake|Aerodrome|exit|unwind|slippage)\b/i },
  { label: "economics/fork", regex: /\b(?:routePositive|executableNow|exactEconomics|netLiquidUsd|valueDelta|profit|fork|anvil|txAttempts|gas)\b/i },
  { label: "non-EVM caveat", regex: /\b(?:Solana|Stellar|Monad|non[-\s]?EVM|unsupported)\b/i },
  { label: "ERC4626", regex: /\b(?:ERC4626|asset\(\)|totalAssets|convertToAssets|previewRedeem|maxRedeem|maxDeposit)\b/i },
];

const CATEGORY_RULES = {
  token: ["etherfuse", "cetes", "eurob", "gilts", "tesouro", "ustry", "token", "tokenized", "bond", "rwa"],
  codePresent: ["codepresent", "code bytes", "codebytes", "implementation", "proxy", "sourcify", "verified"],
  erc4626: ["erc4626", "asset()", "totalassets", "converttoassets", "previewredeem", "maxredeem", "maxdeposit"],
  navOracle: ["nav", "net asset", "oracle", "price", "reference", "feed", "valuation", "accepted-value", "accepted value"],
  redemption: ["redeem", "redemption", "withdraw", "burn", "claim", "settle", "settlement", "maturity", "coupon", "cash"],
  transferRestriction: ["kyc", "whitelist", "allowlist", "blacklist", "restricted", "paused", "pause", "compliance", "transfer gate"],
  roleAdmin: ["owner", "admin", "role", "minter", "pauser", "upgrader", "upgrade", "proxy", "implementation"],
  consumerJoin: ["consumer", "collateral", "borrow", "lending", "market", "aave", "compound", "comet", "euler", "morpho", "silo", "liquidation"],
  dexExit: ["dex", "swap", "pool", "liquidity", "uniswap", "curve", "balancer", "pancake", "aerodrome", "exit", "unwind", "slippage"],
  exactEconomics: ["routepositive", "executable", "exacteconomics", "netliquidusd", "valuedelta", "profit", "positive", "gas"],
  forkPrereq: ["fork", "anvil", "localhost", "txattempts", "valuedelta", "routepositive"],
  nonEvmCaveat: ["solana", "stellar", "monad", "non-evm", "nonevm", "unsupported"],
  addressSchema: ["address", "0x834df4c1", "0xc6221856", "0x46080f31", "0xd574b191", "0x7cee47e7", "0xc2c1f8eb"],
};

function firstRuleMatch(text, rules) {
  const raw = String(text || "");
  for (const rule of rules) { rule.regex.lastIndex = 0; if (rule.regex.test(raw)) return rule; }
  return null;
}
function hasRuleMatch(text, rules) { return Boolean(firstRuleMatch(text, rules)); }
function isContextualFile(filePath) { return /(?:etherfuse|cetes|eurob|gilts|tesouro|ustry|rwa|nav|bond|token|consumer|dex|exit|oracle|redeem|restriction|role|admin|econom|liquid|erc4626)/i.test(path.basename(filePath)); }

function matchForText(line, windowText, filePath) {
  const exact = firstRuleMatch(line, EXACT_RULES) || firstRuleMatch(windowText, EXACT_RULES);
  if (exact) return { matchType: "exact-name-address-token", matched: exact.label, termType: "text" };
  const context = firstRuleMatch(line, CONTEXT_RULES) || firstRuleMatch(windowText, CONTEXT_RULES);
  if (!context) return null;
  if (hasRuleMatch(windowText, EXACT_RULES) || isContextualFile(filePath)) return { matchType: "context", matched: context.label, termType: "text" };
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

function classificationForRow(file, match, categories, routeValue) {
  const r = rel(file).toLowerCase();
  if (routeValue === true || routeValue === "true" || routeValue === 1) return "prior-positive-or-watch-signal-not-promoted-without-current-exact-economics";
  if (r.includes("prefilter-etherfuse")) return "prior-prefilter-context-only-no-route-positive";
  if (categories.includes("navOracle")) return "nav-oracle-context-only-no-current-accepted-value-edge";
  if (categories.includes("redemption")) return "redemption-context-only-no-public-same-block-exit";
  if (categories.includes("transferRestriction")) return "transfer-restriction-context-only-blocker";
  if (categories.includes("roleAdmin")) return "role-admin-context-only-no-permissionless-path";
  if (categories.includes("consumerJoin")) return "consumer-context-only-no-etherfuse-specific-join";
  if (categories.includes("dexExit") || categories.includes("exactEconomics")) return "dex-economics-context-only-no-exact-positive-route";
  if (categories.includes("nonEvmCaveat")) return "non-evm-coverage-caveat-not-route-negative";
  if (categories.includes("erc4626")) return "erc4626-context-only-prefilter-found-zero-erc4626-rows";
  return match.matchType === "exact-name-address-token" ? "exact-local-watch-context-only-no-route-positive" : "local-artifact-watch-context-only-no-route-positive";
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
    if (!fileHasExact && !hasRuleMatch(text, CONTEXT_RULES)) continue;
    const lines = text.split(/\r?\n/);
    let sampled = 0;
    let fileMatched = false;
    let fileExact = false;
    const seen = new Set();
    for (let i = 0; i < lines.length && rows.length < MAX_LOCAL_MATCH_ROWS && sampled < MAX_ROWS_PER_FILE; i += 1) {
      const line = String(lines[i] || "");
      if (!line.trim()) continue;
      const windowText = [lines[i - 2], lines[i - 1], lines[i], lines[i + 1], lines[i + 2]].map((x) => String(x || "")).join(" ");
      if (isUnsafeSampleText(line) || isUnsafeSampleText(windowText)) continue;
      const match = matchForText(line, windowText, file);
      if (!match) continue;
      const key = `${rel(file)}:${i + 1}:${match.matchType}:${match.matched}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fileMatched = true;
      if (match.matchType === "exact-name-address-token") fileExact = true;
      const categories = categoriesFor(windowText, rel(file));
      for (const category of categories) categoryCounts[category] = (categoryCounts[category] || 0) + 1;
      const routeValue = /\broutePositive\b[^\n,}]*\b(?:true|1)\b/i.test(windowText);
      rows.push({ rowSource: "line-scan", file: rel(file), line: i + 1, matchType: match.matchType, termType: match.termType, matched: sanitizeText(match.matched, 160), count: countOccurrences(line, match.matched), categories, sample: sanitizeText(windowText, 540), routePositive: 0, sourceRoutePositiveNotPromoted: Boolean(routeValue), classification: classificationForRow(file, match, categories, routeValue) });
      sampled += 1;
    }
    if (fileMatched) filesWithMatch += 1;
    if (fileExact) filesWithExact += 1;
    if (rows.length >= MAX_LOCAL_MATCH_ROWS) break;
  }
  return { filesScanned, filesWithMatch, filesWithExact, rows, exactRows: rows.filter((row) => row.matchType === "exact-name-address-token"), categoryCounts };
}

function exactish(row) { return row.matchType === "exact-name-address-token"; }
function sourceForRow(row) { return row.file ? `${row.file}${row.line ? `:${row.line}` : ""}` : (row.sourceLabel || row.rowSource || "static"); }
function includesAnyTerm(text, terms) { const hay = String(text || "").toLowerCase(); return terms.some((term) => term && hay.includes(String(term).toLowerCase())); }
function rowSearchText(row) { return `${row.file || ""} ${row.matched || ""} ${row.sample || ""} ${row.classification || ""}`; }
function firstSources(rows, max = 4) { return uniqBy(rows, sourceForRow).slice(0, max).map(sourceForRow); }
function proofCheck({ key, status, evidenceRows = [], blocker }) { return { key, status, evidenceRows: evidenceRows.length, evidenceSources: firstSources(evidenceRows), routeBlocking: true, blocker }; }

function loadPriorPrefilter() {
  const artifact = readJson(path.join(WORKSPACE, PREFILTER_JSON_REL)) || {};
  const summary = artifact.summary || {};
  return {
    generatedAt: artifact.generatedAt || null,
    scanner: artifact.scanner || "tools/scan-etherfuse-prefilter.js",
    metadata: artifact.metadata ? {
      ok: Boolean(artifact.metadata.ok),
      name: sanitizeText(artifact.metadata.name, 80),
      slug: sanitizeText(artifact.metadata.slug, 80),
      category: sanitizeText(artifact.metadata.category, 120),
      currentTvlUsd: safeNumber(artifact.metadata.currentTvlUsd),
      chains: Array.isArray(artifact.metadata.chains) ? artifact.metadata.chains.map((x) => sanitizeText(x, 80)).filter(Boolean) : [],
      adapter: sanitizeText(artifact.metadata.adapter, 120),
      chainTvls: artifact.metadata.chainTvls || {},
    } : null,
    adapter: artifact.adapter ? { source: sanitizeText(artifact.adapter.source, 120), methodology: sanitizeText(artifact.adapter.methodology, 300) } : null,
    tokenRows: Array.isArray(artifact.tokenRows) ? artifact.tokenRows : [],
    rpcBlocked: Array.isArray(artifact.rpcBlocked) ? artifact.rpcBlocked : [],
    tokenRowsCount: safeNumber(summary.tokenRows),
    codePresentRows: safeNumber(summary.codePresentRows),
    erc4626Rows: safeNumber(summary.erc4626Rows),
    localArtifactMatchRows: safeNumber(summary.localArtifactMatchRows),
    consumerJoinRows: safeNumber(summary.consumerJoinRows),
    dexLiquidityRows: safeNumber(summary.dexLiquidityRows),
    maxDexLiquidityUsd: safeNumber(summary.maxDexLiquidityUsd),
    exactEconomicsRows: safeNumber(summary.exactEconomicsRows),
    rpcBlockedRows: safeNumber(summary.rpcBlockedRows),
    routePositive: safeNumber(summary.routePositive),
    executableNow: safeNumber(summary.executableNow),
    signedActionJustified: Boolean(summary.signedActionJustified || false),
    forkJustified: Boolean(summary.forkJustified || false),
    priorSafetyRpcInventoryRead: Boolean(artifact.safety?.rpcInventoryRead),
    priorSafetyRpcUrlsStored: Boolean(artifact.safety?.rpcUrlsStored),
    blockers: Array.isArray(artifact.blockers) ? artifact.blockers.map((x) => sanitizeText(x, 260)).filter(Boolean) : [],
    nextRoutePositiveCriteria: Array.isArray(artifact.nextRoutePositiveCriteria) ? artifact.nextRoutePositiveCriteria.map((x) => sanitizeText(x, 260)).filter(Boolean) : [],
  };
}

function summarizedPriorPrefilter(priorPrefilter) {
  const { tokenRows: _tokenRows, ...safe } = priorPrefilter;
  return safe;
}

function sanitizeTokenRows(priorPrefilter) {
  const rawRows = priorPrefilter.tokenRows.length ? priorPrefilter.tokenRows : STATIC_TOKEN_SEEDS;
  return rawRows.map((row) => ({
    chain: sanitizeText(row.chain, 80),
    chainId: row.chainId ?? null,
    address: row.address || row.token || null,
    addressValid: isEvmAddress(row.address || row.token),
    symbol: sanitizeText(row.symbol, 80),
    name: sanitizeText(row.name, 120),
    decimals: row.decimals ?? null,
    codePresent: safeBool(row.codePresent),
    codeBytes: safeNumber(row.codeBytes),
    eip1967Implementation: isEvmAddress(row.proxy?.eip1967Implementation) ? row.proxy.eip1967Implementation : null,
    sourceVerified: Boolean(row.sourceStatus?.verified),
    sourceStatus: row.sourceStatus ? { verified: Boolean(row.sourceStatus.verified), source: sanitizeText(row.sourceStatus.source, 80) } : null,
    totalSupplyRaw: sanitizeText(row.totalSupplyRaw, 120),
    totalSupply: sanitizeText(row.totalSupply, 120),
    erc4626: row.erc4626 ? {
      asset: isEvmAddress(row.erc4626.asset) ? row.erc4626.asset : null,
      totalAssets: sanitizeText(row.erc4626.totalAssets, 120),
      totalAssetsRaw: sanitizeText(row.erc4626.totalAssetsRaw, 120),
      convertToAssetsOneShare: sanitizeText(row.erc4626.convertToAssetsOneShare, 120),
      maxDeposit: sanitizeText(row.erc4626.maxDeposit, 120),
      maxRedeem: sanitizeText(row.erc4626.maxRedeem, 120),
      previewRedeemOneShare: sanitizeText(row.erc4626.previewRedeemOneShare, 120),
    } : null,
    dexPools: Array.isArray(row.dexPools) ? row.dexPools.map((p) => ({ pool: sanitizeText(p.pool, 120), name: sanitizeText(p.name, 160), reserveUsd: safeNumber(p.reserveUsd), priceUsd: safeNumber(p.priceUsd) })) : [],
    topDexLiquidityUsd: safeNumber(row.topDexLiquidityUsd),
    localMatches: Array.isArray(row.localMatches) ? row.localMatches.map((m) => ({ file: sanitizeText(m.file, 160), count: safeNumber(m.count) })) : [],
    classification: "etherfuse-tokenized-bond-context-only",
  }));
}

function assertCandidateAddressSchema(candidates) {
  const invalid = [];
  let validAddressCandidateRows = 0;
  let nonAddressExcludedRows = 0;
  for (const candidate of candidates) {
    if (candidate.excludedFromAddressSchema || candidate.isCandidateAddress === false) {
      nonAddressExcludedRows += 1;
      continue;
    }
    if (isEvmAddress(candidate.address)) validAddressCandidateRows += 1;
    else invalid.push({ role: candidate.role, chain: candidate.chain, address: candidate.address, candidateType: candidate.candidateType });
  }
  if (invalid.length) {
    throw new Error(`Invalid EVM candidate address schema rows: ${invalid.map((row) => `${row.role}:${row.address}`).join(", ")}`);
  }
  return {
    candidateRows: candidates.length,
    addressCandidateRows: candidates.filter((candidate) => candidate.isCandidateAddress !== false && !candidate.excludedFromAddressSchema).length,
    validAddressCandidateRows,
    invalidAddressCandidateRows: invalid.length,
    nonAddressExcludedRows,
    schemaAssertionPassed: true,
  };
}

function buildCandidateMatrix(tokenRows, localRows) {
  const seeds = tokenRows.map((row) => ({
    candidateType: "etherfuse-tokenized-bond-token",
    role: `${row.chain || "EVM"} ${row.symbol || row.name || "Etherfuse token"}`,
    chain: row.chain,
    chainId: row.chainId,
    address: row.address,
    rawAddress: row.address,
    isCandidateAddress: true,
    excludedFromAddressSchema: false,
    symbol: row.symbol || null,
    name: row.name || null,
    codePresent: row.codePresent,
    codeBytes: row.codeBytes,
    sourceVerified: row.sourceVerified,
    eip1967Implementation: row.eip1967Implementation,
    totalSupply: row.totalSupply,
    erc4626Asset: row.erc4626?.asset || null,
    topDexLiquidityUsd: row.topDexLiquidityUsd,
    classification: "etherfuse-token-candidate-context-only",
  }));
  const addressSchema = assertCandidateAddressSchema(seeds);
  const candidates = seeds.map((candidate) => {
    const terms = [candidate.address, candidate.rawAddress, candidate.role, candidate.symbol, candidate.name].filter(Boolean);
    const candidateRows = localRows.filter((row) => includesAnyTerm(rowSearchText(row), terms));
    const categories = Array.from(new Set(candidateRows.flatMap((row) => row.categories || []))).sort();
    const codeRows = candidateRows.filter((row) => (row.categories || []).includes("codePresent"));
    const erc4626Rows = candidateRows.filter((row) => (row.categories || []).includes("erc4626"));
    const navRows = candidateRows.filter((row) => (row.categories || []).includes("navOracle"));
    const redemptionRows = candidateRows.filter((row) => (row.categories || []).includes("redemption"));
    const transferRows = candidateRows.filter((row) => (row.categories || []).includes("transferRestriction"));
    const roleRows = candidateRows.filter((row) => (row.categories || []).includes("roleAdmin"));
    const consumerRows = candidateRows.filter((row) => (row.categories || []).includes("consumerJoin"));
    const dexRows = candidateRows.filter((row) => (row.categories || []).includes("dexExit"));
    const economicsRows = candidateRows.filter((row) => (row.categories || []).includes("exactEconomics"));
    const forkRows = candidateRows.filter((row) => (row.categories || []).includes("forkPrereq"));
    const checks = [
      proofCheck({ key: "addressSchemaValid", status: "valid-20-byte-evm-address", evidenceRows: [], blocker: "Address schema is only a prerequisite; it is not route proof." }),
      proofCheck({ key: "codePresent", status: candidate.codePresent ? "code-present-context-only" : "missing-code", evidenceRows: codeRows, blocker: "Code-present token rows do not prove permissionless value movement." }),
      proofCheck({ key: "erc4626NavInterface", status: candidate.erc4626Asset ? "erc4626-asset-context-only" : "missing-or-non-erc4626", evidenceRows: erc4626Rows, blocker: "Prefilter found zero ERC4626 asset/totalAssets rows for Etherfuse tokens; no share-rate redeem edge is proven." }),
      proofCheck({ key: "navOracleAcceptedValue", status: navRows.length ? "context-only-no-current-accepted-value-edge" : "missing", evidenceRows: navRows, blocker: "No current NAV/oracle/accepted-value divergence is proven for a material consumer." }),
      proofCheck({ key: "publicRedemptionOrSettlement", status: redemptionRows.length ? "context-only-no-public-same-block-exit" : "missing", evidenceRows: redemptionRows, blocker: "No public same-block redeem, withdraw, burn, claim, maturity, or settlement extraction path is proven." }),
      proofCheck({ key: "transferRestrictionBypass", status: transferRows.length ? "restriction-context-only-no-bypass" : "missing", evidenceRows: transferRows, blocker: "KYC/allowlist/blacklist/pause/transfer gates are treated as blockers unless bypassed by proof." }),
      proofCheck({ key: "roleAdminBypass", status: roleRows.length ? "role-context-only-no-public-bypass" : "missing", evidenceRows: roleRows, blocker: "Owner/admin/minter/upgrade controls are role-gated and not permissionless route proof." }),
      proofCheck({ key: "consumerJoin", status: consumerRows.length ? "context-only-no-etherfuse-specific-join" : "missing", evidenceRows: consumerRows, blocker: "No Etherfuse-specific token is accepted by a material lending/oracle/liquidation consumer." }),
      proofCheck({ key: "dexExitAndExactEconomics", status: dexRows.length || economicsRows.length ? "context-only-no-exact-positive-economics" : "missing", evidenceRows: [...dexRows, ...economicsRows], blocker: "No DEX/redeem/borrow/unwind route has exact positive economics." }),
      proofCheck({ key: "forkValueDeltaProof", status: forkRows.length ? "context-only-gated" : "missing", evidenceRows: forkRows, blocker: "No local fork/static value-delta proof exists; harness must skip while routePositive=0." }),
    ];
    return {
      candidateType: candidate.candidateType,
      role: candidate.role,
      chain: candidate.chain,
      chainId: candidate.chainId,
      address: candidate.address,
      rawAddress: candidate.rawAddress,
      isCandidateAddress: candidate.isCandidateAddress,
      excludedFromAddressSchema: candidate.excludedFromAddressSchema,
      addressSchemaValid: isEvmAddress(candidate.address),
      symbol: candidate.symbol || null,
      name: candidate.name || null,
      codePresent: Boolean(candidate.codePresent),
      codeBytes: candidate.codeBytes || 0,
      sourceVerified: Boolean(candidate.sourceVerified),
      eip1967Implementation: candidate.eip1967Implementation || null,
      totalSupply: candidate.totalSupply || null,
      erc4626Asset: candidate.erc4626Asset || null,
      topDexLiquidityUsd: candidate.topDexLiquidityUsd || 0,
      localArtifactRows: candidateRows.length,
      exactLocalRows: candidateRows.filter(exactish).length,
      categories,
      codeContextRows: codeRows.length,
      erc4626ContextRows: erc4626Rows.length,
      navOracleContextRows: navRows.length,
      redemptionContextRows: redemptionRows.length,
      transferRestrictionRows: transferRows.length,
      roleAdminRows: roleRows.length,
      consumerContextRows: consumerRows.length,
      dexExitContextRows: dexRows.length,
      exactEconomicsContextRows: economicsRows.length,
      forkContextRows: forkRows.length,
      proofChecks: checks,
      routeBlockingProofGaps: checks.map((check) => check.key),
      routePositive: 0,
      executableNow: 0,
      signedActionJustified: false,
      forkJustified: false,
      status: "tokenized-bond-context-no-consumer-dex-redemption-economics",
      blocker: "Missing public redemption/NAV/oracle edge, transfer/role bypass, Etherfuse-specific consumer join, DEX exit, exact economics, and fork value-delta proof.",
    };
  });
  const proofGapRows = candidates.flatMap((candidate) => candidate.proofChecks.map((check) => ({ role: candidate.role, chain: candidate.chain, gate: check.key, status: check.status, evidenceRows: check.evidenceRows, blocker: check.blocker })));
  return {
    candidates,
    proofGapRows,
    addressSchema,
    summary: {
      candidateRows: candidates.length,
      tokenCandidates: candidates.length,
      addressCandidateRows: addressSchema.addressCandidateRows,
      validAddressCandidateRows: addressSchema.validAddressCandidateRows,
      invalidAddressCandidateRows: addressSchema.invalidAddressCandidateRows,
      nonAddressExcludedRows: addressSchema.nonAddressExcludedRows,
      candidatesWithCodePresent: candidates.filter((c) => c.codePresent).length,
      candidatesWithErc4626Asset: candidates.filter((c) => c.erc4626Asset).length,
      candidatesWithConsumerContext: candidates.filter((c) => c.consumerContextRows > 0).length,
      candidatesWithDexExitContext: candidates.filter((c) => c.dexExitContextRows > 0).length,
      candidatesWithExactEconomics: 0,
      candidatesWithForkValueDeltaProof: 0,
      candidateMatrixProofGapRows: proofGapRows.length,
      routePositive: 0,
    },
  };
}

function selectNotableRows(rows) {
  const priority = [];
  const files = new Set();
  for (const row of rows) {
    const key = row.file || row.sourceLabel || row.matched;
    const cats = row.categories || [];
    if (row.rowSource === "static-public-fact" || exactish(row) || cats.some((cat) => ["token", "codePresent", "erc4626", "navOracle", "redemption", "transferRestriction", "roleAdmin", "consumerJoin", "dexExit", "exactEconomics", "forkPrereq", "nonEvmCaveat", "addressSchema"].includes(cat))) {
      if (!files.has(key) || exactish(row) || row.rowSource === "static-public-fact") { priority.push(row); files.add(key); }
    }
    if (priority.length >= 54) break;
  }
  return priority.length ? priority : rows.slice(0, 28);
}

const BLOCKERS = [
  "Solana, Stellar, and Monad coverage remains a caveat and is not closed route-negative by this EVM-first local/static scan.",
  "No Etherfuse tokenized bond is proven to be accepted by a material lending/oracle/liquidation consumer in local artifacts.",
  "No DEX liquidity or public same-block redeem/unwind path exists for route-size Etherfuse token acquisition or exit.",
  "Prefilter ERC4626 probes found zero ERC4626 asset/totalAssets rows; no share-rate redemption edge is proven.",
  "RWA issuance/redemption/transferability is treated as permissioned or restricted absent a public transfer/redeem bypass proof.",
  "Owner/admin/minter/upgrade/pauser controls remain role-gated context and are not permissionless route proof.",
  "No exact positive borrow, liquidation, redemption, NAV, accepted-value, or unwind economics are proven.",
  "No local fork/static value-delta proof and no signed action justified.",
];

const REQUIRED_FOR_ROUTE_POSITIVE = [
  "A code-present Etherfuse Polygon/Base token or non-EVM representation maps to a permissionless transfer, redeem, burn, claim, settlement, NAV/oracle, or role-bypass value path.",
  "Or an Etherfuse token is accepted by a material lending/oracle/liquidation consumer with current collateral factor, borrow cash, and attacker-favorable accepted value.",
  "Solana/Stellar/Monad dependencies are resolved if the route depends on those chains; caveat rows cannot be used as EVM route-negative proof.",
  "Public acquisition and exit liquidity exists through DEX/redeem/borrow/unwind venues at route size without KYC/allowlist/blacklist/pause blockers.",
  "Exact economics show netLiquidUsd > 0 after gas, fees, slippage, redemption/settlement timing, transfer restrictions, caps, and LTV/LLTV haircuts.",
  "Local fork/static value-delta proof demonstrates attacker-controlled positive balance movement with ephemeral local accounts only and no broadcast.",
  "Independent defensive review and explicit route-specific authorization before any signed transaction consideration.",
];

const NEXT_READ_ONLY_STEP = "Keep Etherfuse dormant unless a tokenized-bond row gains a proven public redemption/NAV/oracle/transfer path or material consumer/DEX/redeem route with exact positive economics; only then run the local-only fork harness.";

function buildPayload({ lineScan, priorPrefilter }) {
  const tokenRows = sanitizeTokenRows(priorPrefilter);
  const localRows = lineScan.rows;
  const combinedRows = [...STATIC_CONTEXT_ROWS, ...localRows];
  const exactRows = lineScan.exactRows;
  const categoryRows = {};
  for (const category of Object.keys(CATEGORY_RULES)) categoryRows[`${category}Rows`] = pickRows(combinedRows, (row) => (row.categories || []).includes(category), 220);
  const priorPrefilterRows = pickRows(localRows, (row) => row.file && row.file.includes("prefilter-etherfuse"), 220);
  const consumerJoinRows = pickRows(combinedRows, (row) => (row.categories || []).includes("consumerJoin"), 240);
  const dexExitRows = pickRows(combinedRows, (row) => (row.categories || []).some((cat) => ["dexExit", "exactEconomics"].includes(cat)), 240);
  const oracleNavRows = pickRows(combinedRows, (row) => (row.categories || []).includes("navOracle"), 240);
  const redemptionRows = pickRows(combinedRows, (row) => (row.categories || []).includes("redemption"), 240);
  const transferRestrictionRows = pickRows(combinedRows, (row) => (row.categories || []).includes("transferRestriction"), 240);
  const roleAdminRows = pickRows(combinedRows, (row) => (row.categories || []).includes("roleAdmin"), 240);
  const nonEvmCaveatRows = pickRows(combinedRows, (row) => (row.categories || []).includes("nonEvmCaveat"), 120);
  const candidateMatrix = buildCandidateMatrix(tokenRows, localRows);
  const notableRows = selectNotableRows(combinedRows);
  const routePositive = 0;
  const executableNow = 0;
  const signedActionJustified = false;
  const forkJustified = false;
  const forkGate = "closed-route-positive-zero";
  const exactEconomicsRows = 0;
  const summary = {
    sourceFactRows: SOURCE_FACTS.length,
    chainSeedRows: CHAIN_SEEDS.length,
    tokenRows: tokenRows.length,
    evmTokenRows: tokenRows.filter((row) => row.chainId === 137 || row.chainId === 8453).length,
    surfaceRows: SURFACE_ROWS.length,
    bugClassRows: BUG_CLASS_ROWS.length,
    staticContextRows: STATIC_CONTEXT_ROWS.length,
    priorPrefilterRows: priorPrefilterRows.length,
    priorPrefilterTokenRows: priorPrefilter.tokenRowsCount,
    priorPrefilterCodePresentRows: priorPrefilter.codePresentRows,
    priorPrefilterErc4626Rows: priorPrefilter.erc4626Rows,
    priorPrefilterConsumerJoinRows: priorPrefilter.consumerJoinRows,
    priorPrefilterDexLiquidityRows: priorPrefilter.dexLiquidityRows,
    priorPrefilterExactEconomicsRows: priorPrefilter.exactEconomicsRows,
    codePresentRows: tokenRows.filter((row) => row.codePresent).length,
    erc4626Rows: tokenRows.filter((row) => row.erc4626?.asset).length,
    sourcifyVerifiedRows: tokenRows.filter((row) => row.sourceVerified).length,
    proxyImplementationRows: tokenRows.filter((row) => row.eip1967Implementation).length,
    filesScanned: lineScan.filesScanned,
    filesWithLocalMatches: lineScan.filesWithMatch,
    filesWithExactLocalMatches: lineScan.filesWithExact,
    localArtifactMatchRows: localRows.length,
    exactLocalArtifactMatchRows: exactRows.length,
    tokenContextRows: categoryRows.tokenRows.length,
    codePresentContextRows: categoryRows.codePresentRows.length,
    erc4626ContextRows: categoryRows.erc4626Rows.length,
    oracleNavContextRows: oracleNavRows.length,
    redemptionContextRows: redemptionRows.length,
    transferRestrictionRows: transferRestrictionRows.length,
    roleAdminRows: roleAdminRows.length,
    consumerJoinRows: consumerJoinRows.length,
    exactConsumerJoinRows: 0,
    dexExitContextRows: dexExitRows.length,
    exactEconomicsContextRows: categoryRows.exactEconomicsRows.length,
    forkPrereqRows: categoryRows.forkPrereqRows.length,
    nonEvmCaveatRows: nonEvmCaveatRows.length,
    addressSchemaRows: categoryRows.addressSchemaRows.length,
    candidateMatrixRows: candidateMatrix.summary.candidateRows,
    tokenCandidates: candidateMatrix.summary.tokenCandidates,
    addressCandidateRows: candidateMatrix.summary.addressCandidateRows,
    validAddressCandidateRows: candidateMatrix.summary.validAddressCandidateRows,
    invalidAddressCandidateRows: candidateMatrix.summary.invalidAddressCandidateRows,
    nonAddressExcludedRows: candidateMatrix.summary.nonAddressExcludedRows,
    addressSchemaAssertionPassed: candidateMatrix.addressSchema.schemaAssertionPassed,
    candidatesWithCodePresent: candidateMatrix.summary.candidatesWithCodePresent,
    candidatesWithErc4626Asset: candidateMatrix.summary.candidatesWithErc4626Asset,
    candidatesWithConsumerContext: candidateMatrix.summary.candidatesWithConsumerContext,
    candidatesWithDexExitContext: candidateMatrix.summary.candidatesWithDexExitContext,
    candidatesWithExactEconomics: candidateMatrix.summary.candidatesWithExactEconomics,
    candidatesWithForkValueDeltaProof: candidateMatrix.summary.candidatesWithForkValueDeltaProof,
    candidateMatrixProofGapRows: candidateMatrix.summary.candidateMatrixProofGapRows,
    publicFetchRows: 0,
    rpcInventoryRows: 0,
    graphqlInventoryRows: 0,
    ethCallRows: 0,
    forkRows: 0,
    exactEconomicsRows,
    routePositive,
    executableNow,
    signedActionJustified,
    forkJustified,
    forkGate,
    fullTestReadOnlyComplete: true,
  };
  return {
    generatedAt: GENERATED_AT,
    deterministicOutput: true,
    scanner: "tools/scan-etherfuse-full-test.js",
    target: TARGET,
    scope: { kind: "bounded defensive/read-only full-test scanner", artifactStaticLocalFirst: true, publicFactsOnly: true, evmFirst: true, evmScopeChains: TARGET.evmScopeChains, caveatChains: TARGET.caveatChains, routeGraph: TARGET.routeGraph, writesLimitedTo: [OUT_JSON_REL, OUT_MD_REL], coordinatorClaim: TARGET.coordinatorClaim, aggregatePromotionStateHandoffEdited: false, endpointPolicy: "No endpoint inventory was read by this full-test scanner; no raw endpoints, domains, keys, or tokens are persisted." },
    safety: { localArtifactsRead: true, publicSourcesRead: false, publicStaticLabelsUsed: true, publicNetworkFetch: false, endpointInventoryRead: false, rpcInventoryRead: false, rpcInventoryRows: 0, graphqlInventoryRead: false, graphqlInventoryRows: 0, envFilesRead: false, privateKeyEnvRead: false, privateKeysRead: false, keyFilesRead: false, keyMaterialRead: false, pemFilesRead: false, keypairJsonRead: false, rawEndpointUrlsStored: false, rpcUrlsStored: false, graphqlUrlsStored: false, rawUrlsStored: false, rawDomainsStored: false, rawKeysTokensStored: false, signedActions: false, liveTransactions: false, broadcasts: false, walletOperations: false, exploitExecuteCalls: false, forkTransactions: false, ethCallOnly: false, sanitizedOutputOnly: true, secretLikePathsExcluded: true },
    sourceFacts: SOURCE_FACTS,
    discoveredSeeds: { chainSeeds: CHAIN_SEEDS, tokenRows, surfaceRows: SURFACE_ROWS },
    bugClasses: BUG_CLASS_ROWS,
    caveats: [
      "Solana token supply/transfer/redeem semantics were not queried and remain coverage caveats.",
      "Stellar token supply/transfer/redeem semantics were not queried and remain coverage caveats.",
      "Monad is unavailable in sanitized local coverage for this scanner and remains a caveat.",
    ],
    priorPrefilter: summarizedPriorPrefilter(priorPrefilter),
    staticContextRows: STATIC_CONTEXT_ROWS,
    priorPrefilterRows,
    localArtifacts: { filesScanned: lineScan.filesScanned, filesWithMatch: lineScan.filesWithMatch, filesWithExact: lineScan.filesWithExact, categoryCounts: lineScan.categoryCounts, rows: localRows, exactRows: exactRows.slice(0, 240), notableRows },
    categoryRows: { ...categoryRows, consumerJoinRows, exactConsumerJoinRows: [], dexExitRows, oracleNavRows, redemptionRows, transferRestrictionRows, roleAdminRows, nonEvmCaveatRows },
    candidateMatrix,
    rows: notableRows.slice(0, 20),
    routeGate: { routePositive, executableNow, signedActionJustified, forkJustified, forkGate, exactPermissionlessValueMovement: false, navOracleAcceptedValueEdge: false, publicRedemptionOrSettlement: false, transferRestrictionBypass: false, roleAdminBypass: false, wrappedAssetConsumerJoin: false, exactPositiveEconomics: false, localForkStaticProof: false, exactEconomicsRows, status: "dormant-fail-closed", reason: "Static/local scan found Etherfuse tokenized-bond, NAV/oracle, redemption, transfer-restriction, role/admin, consumer, DEX, economics, and non-EVM caveat context only; no public redemption or transfer bypass, material consumer join, DEX exit, exact positive economics, or fork value-delta proof is present." },
    blockers: BLOCKERS,
    requiredForRoutePositive: REQUIRED_FOR_ROUTE_POSITIVE,
    nextReadOnlyStep: NEXT_READ_ONLY_STEP,
    summary,
  };
}

function metricRows(summary) {
  const keys = ["sourceFactRows", "chainSeedRows", "tokenRows", "evmTokenRows", "surfaceRows", "bugClassRows", "staticContextRows", "priorPrefilterRows", "priorPrefilterTokenRows", "priorPrefilterCodePresentRows", "priorPrefilterErc4626Rows", "priorPrefilterConsumerJoinRows", "priorPrefilterDexLiquidityRows", "priorPrefilterExactEconomicsRows", "codePresentRows", "erc4626Rows", "sourcifyVerifiedRows", "proxyImplementationRows", "filesScanned", "filesWithLocalMatches", "filesWithExactLocalMatches", "localArtifactMatchRows", "exactLocalArtifactMatchRows", "tokenContextRows", "codePresentContextRows", "erc4626ContextRows", "oracleNavContextRows", "redemptionContextRows", "transferRestrictionRows", "roleAdminRows", "consumerJoinRows", "exactConsumerJoinRows", "dexExitContextRows", "exactEconomicsContextRows", "forkPrereqRows", "nonEvmCaveatRows", "addressSchemaRows", "candidateMatrixRows", "tokenCandidates", "addressCandidateRows", "validAddressCandidateRows", "invalidAddressCandidateRows", "nonAddressExcludedRows", "addressSchemaAssertionPassed", "candidatesWithCodePresent", "candidatesWithErc4626Asset", "candidatesWithConsumerContext", "candidatesWithDexExitContext", "candidatesWithExactEconomics", "candidatesWithForkValueDeltaProof", "candidateMatrixProofGapRows", "publicFetchRows", "rpcInventoryRows", "graphqlInventoryRows", "ethCallRows", "forkRows", "exactEconomicsRows", "routePositive", "executableNow", "signedActionJustified", "forkJustified", "forkGate", "fullTestReadOnlyComplete"];
  return keys.map((key) => `| ${key} | ${mdEscape(summary[key])} |`).join("\n");
}
function safetyRows(safety) { return ["localArtifactsRead", "publicSourcesRead", "publicStaticLabelsUsed", "publicNetworkFetch", "endpointInventoryRead", "rpcInventoryRead", "graphqlInventoryRead", "envFilesRead", "privateKeysRead", "keyMaterialRead", "rawEndpointUrlsStored", "rpcUrlsStored", "graphqlUrlsStored", "rawUrlsStored", "rawDomainsStored", "rawKeysTokensStored", "signedActions", "liveTransactions", "broadcasts", "walletOperations", "exploitExecuteCalls", "forkTransactions", "sanitizedOutputOnly", "secretLikePathsExcluded"].map((key) => `| ${key} | ${mdEscape(safety[key])} |`).join("\n"); }
function shortAddress(value) { const text = String(value || ""); return /^0x[0-9a-fA-F]{40}$/.test(text) ? `${text.slice(0, 6)}...${text.slice(-4)}` : text; }
function formatTokenRow(row) { return `| ${mdEscape(row.chain)} | ${mdEscape(row.symbol)} | ${mdEscape(row.name)} | ${mdEscape(shortAddress(row.address))} | ${mdEscape(row.totalSupply)} | ${mdEscape(row.codePresent)} | ${mdEscape(row.codeBytes)} | ${mdEscape(row.erc4626?.asset ? shortAddress(row.erc4626.asset) : "no")} | ${mdEscape(row.topDexLiquidityUsd)} | ${mdEscape(row.classification)} |`; }
function formatSurfaceRow(row) { return `| ${mdEscape(row.component)} | ${mdEscape(row.surface)} | ${mdEscape(row.routeRole)} | ${mdEscape((row.watchTerms || []).join(", "))} |`; }
function formatCandidateRow(row) { const evidence = `local=${row.localArtifactRows}, exact=${row.exactLocalRows}, addressValid=${row.addressSchemaValid}, code=${row.codePresent}, erc4626=${row.erc4626Asset ? "yes" : "no"}, nav=${row.navOracleContextRows}, redeem=${row.redemptionContextRows}, transfer=${row.transferRestrictionRows}, role=${row.roleAdminRows}, consumer=${row.consumerContextRows}, dex=${row.dexExitContextRows}, econ=${row.exactEconomicsContextRows}`; return `| ${mdEscape(row.role)} | ${mdEscape(row.chain)} | ${mdEscape(row.address ? shortAddress(row.address) : row.rawAddress)} | ${mdEscape(row.candidateType)} | ${mdEscape(evidence)} | ${mdEscape(row.routeBlockingProofGaps.join(", "))} | ${mdEscape(row.status)} |`; }
function formatBugClassRow(row) { return `| ${mdEscape(row.label)} | ${mdEscape(row.surface)} | ${mdEscape(row.classification)} |`; }
function formatLocalRow(row) { return `| ${mdEscape(sourceForRow(row))} | ${mdEscape((row.categories || []).join(","))} | ${mdEscape(row.matched)} | ${mdEscape(row.sample || "context-only")} | ${mdEscape(row.routePositive)} | ${mdEscape(row.classification)} |`; }

function buildMarkdown(payload) {
  const notableRows = payload.localArtifacts.notableRows.length ? payload.localArtifacts.notableRows.map(formatLocalRow).join("\n") : "| (none) | n/a | n/a | no local context rows found | 0 | dormant |";
  return `# 🟢 DORMANT - Etherfuse Full Test

Generated: ${payload.generatedAt}

Route remains closed: routePositive=${payload.routeGate.routePositive}, executableNow=${payload.routeGate.executableNow}, signedActionJustified=${payload.routeGate.signedActionJustified}, forkJustified=${payload.routeGate.forkJustified}, forkGate=${payload.routeGate.forkGate}.

## Target Context

- Target: ${payload.target.name} (${payload.target.protocolSlug}/${payload.target.slug}), category=${payload.target.category}, surface=${payload.target.surface}, TVL context≈${payload.target.tvlContext}.
- EVM scope: ${payload.scope.evmScopeChains.join(", ")}; non-EVM/unavailable caveats: ${payload.scope.caveatChains.join(", ")}.
- Route graph: ${payload.target.routeGraph}.
- Existing coverage: prior prefilter has tokenRows=${payload.priorPrefilter.tokenRowsCount}, codePresentRows=${payload.priorPrefilter.codePresentRows}, erc4626Rows=${payload.priorPrefilter.erc4626Rows}, consumerJoinRows=${payload.priorPrefilter.consumerJoinRows}, dexLiquidityRows=${payload.priorPrefilter.dexLiquidityRows}, exactEconomicsRows=${payload.priorPrefilter.exactEconomicsRows}, routePositive=${payload.priorPrefilter.routePositive}.
- Fail-closed caveat: Solana, Stellar, and Monad are not closed route-negative by this EVM-first scanner.

## Metrics

| Metric | Value |
|---|---:|
${metricRows(payload.summary)}

## Safety Summary

| Field | Value |
|---|---:|
${safetyRows(payload.safety)}

## Token Seeds From Prior Prefilter

| Chain | Symbol | Name | Address | Supply | Code Present | Code Bytes | ERC4626 Asset | Top DEX Liq USD | Classification |
|---|---|---|---|---:|---:|---:|---|---:|---|
${payload.discoveredSeeds.tokenRows.map(formatTokenRow).join("\n")}

## Surface Checklist

| Component | Surface | Route Role | Watch Terms |
|---|---|---|---|
${payload.discoveredSeeds.surfaceRows.map(formatSurfaceRow).join("\n")}

## Candidate Matrix / Address Schema Gate

| Candidate | Chain | Address/Raw | Type | Local Evidence | Missing Current Proofs | Status |
|---|---|---|---|---|---|---|
${payload.candidateMatrix.candidates.map(formatCandidateRow).join("\n")}

Address schema assertion: validAddressCandidateRows=${payload.summary.validAddressCandidateRows}, invalidAddressCandidateRows=${payload.summary.invalidAddressCandidateRows}, nonAddressExcludedRows=${payload.summary.nonAddressExcludedRows}, passed=${payload.summary.addressSchemaAssertionPassed}.

## Bug Classes / Proof Gaps

| Class | Surface | Classification |
|---|---|---|
${payload.bugClasses.map(formatBugClassRow).join("\n")}

## Notable Local / Static Rows

| Source | Categories | Match | Detail | Route | Classification |
|---|---|---|---|---:|---|
${notableRows}

## Caveats

${payload.caveats.map((item) => `- ${item}`).join("\n")}

## Route Gate

- Status: ${payload.routeGate.status}.
- Required fail-closed conjunction is absent: exactPermissionlessValueMovement=${payload.routeGate.exactPermissionlessValueMovement}, navOracleAcceptedValueEdge=${payload.routeGate.navOracleAcceptedValueEdge}, publicRedemptionOrSettlement=${payload.routeGate.publicRedemptionOrSettlement}, transferRestrictionBypass=${payload.routeGate.transferRestrictionBypass}, roleAdminBypass=${payload.routeGate.roleAdminBypass}, exactPositiveEconomics=${payload.routeGate.exactPositiveEconomics}, localForkStaticProof=${payload.routeGate.localForkStaticProof}.
- No Etherfuse public redemption/settlement, transfer restriction bypass, role/admin bypass, material consumer join, DEX/redeem exit, exact positive economics, or fork value-delta proof was resolved.
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
  log("Scanning Etherfuse local artifacts (sanitized, no endpoint inventory read)...");
  const files = listScanFiles();
  const lineScan = scanLocalArtifactLines(files);
  const priorPrefilter = loadPriorPrefilter();
  const payload = buildPayload({ lineScan, priorPrefilter });
  writeJson(OUT_JSON, payload);
  writeText(OUT_MD, buildMarkdown(payload));
  log(`Wrote ${OUT_JSON_REL} and ${OUT_MD_REL}`);
  log(`routePositive=${payload.summary.routePositive}; exactEconomicsRows=${payload.summary.exactEconomicsRows}; candidateMatrixRows=${payload.summary.candidateMatrixRows}; invalidAddressCandidateRows=${payload.summary.invalidAddressCandidateRows}`);
}

main();
