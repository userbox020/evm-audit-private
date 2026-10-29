#!/usr/bin/env node
"use strict";

// scan-b2-buzz-full-test.js
// Defensive B2 Buzz / BSquared full-test scanner. Deterministic local/static
// artifacts only; no endpoint inventories, network calls, RPC, forks, signed
// actions, broadcasts, or wallets.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_DIR = path.join(WORKSPACE, "reports", "raw", "fast");
const REPORTS_DIR = path.join(WORKSPACE, "reports");
const OUT_JSON = path.join(RAW_DIR, "b2-buzz-full-test.json");
const OUT_MD = path.join(REPORTS_DIR, "b2-buzz-full-test-triage.md");
const OUT_JSON_REL = "reports/raw/fast/b2-buzz-full-test.json";
const OUT_MD_REL = "reports/b2-buzz-full-test-triage.md";
const PREFILTER_JSON_REL = "reports/raw/fast/prefilter-b2-buzz-route-prefilter.json";
const PREFILTER_MD_REL = "reports/prefilter-b2-buzz-route-prefilter.md";

const QUIET = process.argv.includes("--quiet");
const GENERATED_AT = process.env.SCAN_GENERATED_AT || "2026-07-07T00:00:00.000Z";
const MAX_FILE_BYTES = 24 * 1024 * 1024;
const MAX_LOCAL_MATCH_ROWS = 760;
const MAX_ROWS_PER_FILE = 36;

const TARGET = {
  slug: "b2-buzz",
  protocolSlug: "bsquared",
  name: "B2 Buzz / BSquared",
  category: "Canonical Bridge / BTC staking custody",
  surface: "bridge-proof-custody-consumer",
  tvlContext: "$171.647M",
  bitcoinTvlContext: "$171.438M",
  evmScopeChains: ["Ethereum", "Polygon", "BSC/BNB"],
  caveatChains: ["Bitcoin"],
  routeGraph: "BTC/offchain custody or EVM multisig custody -> wrapped/claimed asset or proof/mint/unlock -> lending/DEX consumer -> borrow/unwind/exit",
  module: "bsquared/index.js",
  coordinatorClaim: "coordinator-b2-buzz-fulltest-01",
};

const CHAIN_SEEDS = [
  { chain: "Ethereum", chainLabel: "Ethereum", chainId: 1, adapterKey: "ethereum", evmFirst: true, caveat: false, classification: "evm-custody-wallet-chain" },
  { chain: "Polygon", chainLabel: "Polygon", chainId: 137, adapterKey: "polygon", evmFirst: true, caveat: false, classification: "evm-custody-wallet-chain" },
  { chain: "BSC/BNB", chainLabel: "BNB Chain", chainId: 56, adapterKey: "bsc", evmFirst: true, caveat: false, classification: "evm-custody-wallet-chain" },
  { chain: "Bitcoin", chainLabel: "Bitcoin", chainId: null, adapterKey: "bitcoin", evmFirst: false, caveat: true, classification: "non-evm-offchain-btc-custody-caveat" },
];

const STATIC_CUSTODY_SEEDS = [
  { chainId: 1, chain: "Ethereum", label: "Ethereum-Multisig-WBTC", owner: "0xeea3A032f381AB1E415e82Fe08ebeb20F513c42c", tokens: ["0x7122985656e38BDC0302Db86685bb972b145bD3C", "0xA0b86991c6218b36c1d19D4a2e9Eb0eE360FBeB6", "0xdAC17F958D2eE523a2206206994597C13D831ec7", "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599"], surface: "Safe/multisig custody wallet with near-zero bridge-route balances", classification: "prefilter-custody-wallet-context-only" },
  { chainId: 137, chain: "Polygon", label: "Polygon-Multisig", owner: "0x01cE88498ED095d386e09834D32Fd8f1FeCd184a", tokens: ["0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"], surface: "Safe/multisig native-token custody wallet; native sentinel excluded from candidate-address schema", classification: "prefilter-native-sentinel-context-only" },
  { chainId: 56, chain: "BSC/BNB", label: "BSC-Multisig-BTCB", owner: "0x0A80028d73Faaee6e57484E3335BeFda0de7f455", tokens: ["0x7130d2A12BfeBC0F1A4bd379D7E60B0d18eBdB6E", "0xc5F05b5d4F0616F3a0ccB5055Dc1854c68BD14F8"], surface: "Safe/multisig custody wallet with zero BTCB/FDUSD balances", classification: "prefilter-custody-wallet-context-only" },
];

const SURFACE_ROWS = [
  { component: "offchain BTC custody", surface: "dominant TVL is non-EVM Bitcoin custody/staking", routeRole: "coverage caveat/backing proof gap", watchTerms: ["Bitcoin", "BTC custody", "staking", "backing"] },
  { component: "EVM custody wallet", surface: "Ethereum/Polygon/BSC Safe or multisig owner rows", routeRole: "custody wallet / sweep proof gap", watchTerms: ["Safe", "multisig", "owner", "custody"] },
  { component: "bridge/proof logic", surface: "proof verifier, message domain, nonce, claim, unlock", routeRole: "proof/mint/unlock producer prerequisite", watchTerms: ["proof", "claim", "unlock", "mint", "burn", "nonce", "domain"] },
  { component: "wrapped/claimed asset", surface: "BSquared-issued wrapped asset or receipt", routeRole: "consumer-accepted producer asset prerequisite", watchTerms: ["wrapped", "receipt", "claim", "token", "issuance"] },
  { component: "backing mismatch", surface: "custody balances vs user claimed deposits", routeRole: "accepted value / solvency proof gap", watchTerms: ["backing", "custody", "reserve", "mismatch", "supply"] },
  { component: "consumer joins", surface: "lending/oracle/borrow/liquidation consumers", routeRole: "borrow/liquidation path", watchTerms: ["Aave", "Morpho", "Euler", "Silo", "consumer", "collateral", "borrow"] },
  { component: "DEX/exit", surface: "DEX, redemption, bridge exit, unwind liquidity", routeRole: "exit/economics prerequisite", watchTerms: ["DEX", "swap", "pool", "liquidity", "exit", "unwind"] },
  { component: "local fork/value-delta", surface: "local-only fork harness gate", routeRole: "non-meaningful until route-positive candidate", watchTerms: ["fork", "anvil", "valueDelta", "routePositive", "exactEconomics"] },
];

const BUG_CLASS_ROWS = [
  { label: "custody multisig sweep or compromised owner", surface: "Safe/multisig custody owner", classification: "bug-class-context-no-permissionless-sweep-proof" },
  { label: "offchain BTC custody/backing mismatch", surface: "Bitcoin custody vs user claims", classification: "bug-class-caveat-no-local-bitcoin-query" },
  { label: "proof verifier or bridge message bypass", surface: "proof/domain/nonce/claim/unlock", classification: "bug-class-context-no-bridge-contract-proof" },
  { label: "permissionless mint/burn/unlock", surface: "wrapped asset issuance", classification: "bug-class-context-no-mint-burn-unlock-contract" },
  { label: "wrapped/claimed asset consumer overvaluation", surface: "lending/oracle consumer", classification: "bug-class-context-no-bsquared-consumer-join" },
  { label: "DEX/redeem exit value positive", surface: "DEX/exit liquidity", classification: "bug-class-context-no-dex-liquidity-or-economics" },
  { label: "fork attempted before route-positive", surface: "local fork harness", classification: "bug-class-gated-by-route-positive-zero" },
];

const SOURCE_FACTS = [
  { sourceLabel: "target-context:B2 Buzz", kind: "target-seed", slug: TARGET.slug, protocolSlug: TARGET.protocolSlug, name: TARGET.name, category: TARGET.category, surface: TARGET.surface, tvlContext: TARGET.tvlContext, chains: [...TARGET.evmScopeChains, ...TARGET.caveatChains], module: TARGET.module, routePositive: 0, classification: "structured-target-seed-route-negative" },
  { sourceLabel: "prior-prefilter-artifact:b2-buzz-route-prefilter", kind: "local-prefilter-context", artifacts: [PREFILTER_JSON_REL, PREFILTER_MD_REL], priorRoutePositive: 0, classification: "prior-prefilter-context-no-route-positive" },
  { sourceLabel: "route-model:bridge-proof-custody-consumer", kind: "route-graph", model: TARGET.routeGraph, routePositiveOnlyIf: "permissionless custody sweep/proof bypass/mint-unlock or backing mismatch is joined to material consumer/DEX exit with exact positive economics", classification: "route-model-fail-closed" },
  { sourceLabel: "local-consumer-and-exit-context", kind: "local-artifact-context", artifacts: ["bridge/proof", "consumer", "DEX", "oracle/economics"], classification: "local-context-only-no-b2-buzz-route-positive" },
];

const STATIC_CONTEXT_ROWS = [
  { sourceLabel: "prior-dormant-result", matched: "prefilter route-negative", categories: ["custody", "bridgeProof", "exactEconomics"], sample: "Prior prefilter found EVM-side Safe/multisig custody rows with near-zero balances, no smart-contract bridge logic, no mint/burn/proof verification/wrapped-token issuance, no consumer joins, no DEX liquidity, exactEconomicsRows=0, routePositive=0.", classification: "prior-prefilter-dormant-no-route-positive" },
  { sourceLabel: "bitcoin-custody-caveat", matched: "Bitcoin custody non-EVM caveat", categories: ["bitcoinCustody", "backingMismatch"], sample: "Dominant TVL is Bitcoin custody and was not queried locally; this is a coverage caveat, not EVM route-positive proof.", classification: "bitcoin-non-evm-caveat-not-closed-by-evm-scan" },
  { sourceLabel: "evm-custody-near-zero", matched: "near-zero EVM balances", categories: ["custody", "safeMultisig", "backingMismatch"], sample: "EVM custody rows are Safe/multisig-style owners with STONE/native dust-like context and zero WBTC/BTCB/FDUSD route balances in prior prefilter; no low/no-capital route is implied.", classification: "evm-custody-balances-near-zero-context-only" },
  { sourceLabel: "native-sentinel-exclusion", matched: "native token sentinel", categories: ["addressSchema", "custody"], sample: "Polygon native-token sentinel is explicitly excluded from EVM address candidate schema and is not treated as a candidate token contract.", classification: "native-sentinel-excluded-from-candidate-addresses" },
  { sourceLabel: "bridge-proof-absence", matched: "no bridge/proof contract", categories: ["bridgeProof", "mintBurnUnlock"], sample: "No B2 Buzz EVM bridge contract, proof verifier, mint/burn/unlock path, wrapped-token issuance, or permissionless claim path is proven in local artifacts.", classification: "no-evm-bridge-proof-contract" },
  { sourceLabel: "consumer-dex-absence", matched: "no consumer or DEX joins", categories: ["consumerJoin", "dexExit", "exactEconomics"], sample: "No BSquared-specific asset joins a local lending/oracle consumer or DEX exit with exact positive economics.", classification: "no-consumer-dex-or-economics" },
  { sourceLabel: "fork-prereq-row", matched: "local fork prerequisites", categories: ["forkPrereq", "exactEconomics"], sample: "Fork harness remains inert until routePositive > 0, a code-present value-moving candidate, exact current economics, and local value-delta proof exist.", classification: "fork-gated-route-positive-zero" },
].map((row) => ({ rowSource: "static-public-fact", matchType: "static-public-fact", termType: "static", routePositive: 0, sourceRoutePositiveNotPromoted: false, ...row }));

const EXPLICIT_FILES = [
  PREFILTER_JSON_REL,
  PREFILTER_MD_REL,
  "reports/raw/fast/bridge-proof-binding.json",
  "reports/raw/fast/bridge-domain-separation.json",
  "reports/raw/fast/bridge-nonlossless-collateral-join.json",
  "reports/raw/fast/bridge-delta-preflight.json",
  "reports/raw/fast/bridge-synthetic-consumer-exposure.json",
  "reports/raw/fast/bridge-lending-collateral-join.json",
  "reports/raw/fast/fake-asset-pool-validation.json",
  "reports/raw/fast/consumer-first-high-ltv-collateral.json",
  "reports/raw/fast/aave-euler-silo-consumer-graph.json",
  "reports/raw/fast/morpho-high-apy-liquidation-routes.json",
  "reports/raw/fast/morpho-liquidatable-marketability.json",
  "reports/raw/fast/morpho-wrapper-exit-proof-gaps.json",
  "reports/raw/fast/erc4626-consumer-joiner.json",
  "reports/raw/fast/dex-consumer-routes.json",
  "reports/raw/fast/dex-exit-quotes.json",
  "reports/raw/fast/current-liquidatable-exit-routes.json",
  "reports/raw/fast/stale-oracle-liquidity-candidates.json",
  "reports/raw/fast/oracle-staleness-cross-ref.json",
  "reports/raw/fast/validation-differential-liquidations.json",
  "reports/raw/fast/mev-sandwich-order-economics.json",
];

function escapeRegExp(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function log(...args) { if (!QUIET) console.log(...args); }
function ensureDir(filePath) { fs.mkdirSync(path.dirname(filePath), { recursive: true }); }
function rel(filePath) { return path.relative(WORKSPACE, filePath).replace(/\\/g, "/"); }
function jsonReplacer(_key, value) { return typeof value === "bigint" ? value.toString() : value; }
function isEvmAddress(value) { return /^0x[0-9a-fA-F]{40}$/.test(String(value || "")); }
function normalizeAddress(value) { return isEvmAddress(value) ? `0x${String(value).slice(2).toLowerCase()}` : null; }
function isNativeSentinel(value) { return String(value || "").toLowerCase() === "native" || /^0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee$/i.test(String(value || "")); }

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
  if (r === "tools/scan-b2-buzz-full-test.js" || r === "tools/fork-test-b2-buzz-routes.js") return true;
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
  return listFilesRecursive(fast, (file) => /(?:b2|buzz|bsquared|bitcoin|btc|btcb|wbtc|stone|bridge|proof|custody|consumer|aave|euler|silo|morpho|dex|exit|oracle|econom|liquid|backing)/i.test(path.basename(file)));
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

const ADDRESS_RULES = STATIC_CUSTODY_SEEDS.flatMap((row) => [row.owner, ...row.tokens.filter((token) => !isNativeSentinel(token))])
  .filter(isEvmAddress)
  .map((address) => ({ label: address, regex: new RegExp(escapeRegExp(address), "i") }));

const EXACT_RULES = [
  { label: "b2-buzz", regex: /\bb2[-_\s]?buzz\b/i },
  { label: "B2 Buzz", regex: /\bB2\s+Buzz\b/i },
  { label: "BSquared", regex: /\bBSquared\b/i },
  { label: "bsquared/index.js", regex: /\bbsquared[\\/]index\.js\b/i },
  { label: "STONE", regex: /\bSTONE\b/i },
  { label: "WBTC", regex: /\bWBTC\b/i },
  { label: "BTCB", regex: /\bBTCB\b/i },
  { label: "FDUSD", regex: /\bFDUSD\b/i },
  ...ADDRESS_RULES,
];

const CONTEXT_RULES = [
  { label: "custody/multisig", regex: /\b(?:custody|multisig|multi[-\s]?sig|Safe|owner|wallet|signer|threshold|reserve|backing)\b/i },
  { label: "bridge/proof", regex: /\b(?:bridge|proof|verifier|message|domain|nonce|claim|unlock|mint|burn|wrapped|receipt|issuance)\b/i },
  { label: "Bitcoin/BTC", regex: /\b(?:Bitcoin|BTC|WBTC|BTCB|staking|off[-\s]?chain)\b/i },
  { label: "consumer", regex: /\b(?:consumer|collateral|borrow|lending|market|Aave|Compound|Comet|Euler|Morpho|Silo|liquidation)\b/i },
  { label: "DEX/exit", regex: /\b(?:DEX|swap|pool|liquidity|Uniswap|Curve|Balancer|Pancake|exit|redeem|withdraw|slippage|unwind)\b/i },
  { label: "economics/fork", regex: /\b(?:routePositive|executableNow|exactEconomics|netLiquidUsd|valueDelta|profit|fork|anvil|txAttempts)\b/i },
  { label: "address schema", regex: /\b(?:address|native|sentinel|0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee)\b/i },
];

const CATEGORY_RULES = {
  custody: ["custody", "multisig", "safe", "owner", "wallet", "reserve", "backing", "b2", "bsquared"],
  safeMultisig: ["safe", "multisig", "multi-sig", "threshold", "signer", "owneriscontract", "171"],
  bitcoinCustody: ["bitcoin", "btc", "offchain", "staking"],
  bridgeProof: ["bridge", "proof", "verifier", "message", "domain", "nonce", "claim", "unlock"],
  mintBurnUnlock: ["mint", "burn", "unlock", "claim", "withdraw", "redeem", "issuance"],
  wrappedAsset: ["wrapped", "receipt", "token", "wbtc", "btcb", "stone", "fdusd"],
  backingMismatch: ["backing", "mismatch", "custodyshare", "reserve", "supply", "balance", "solvency"],
  consumerJoin: ["consumer", "collateral", "borrow", "lending", "market", "aave", "compound", "comet", "euler", "morpho", "silo", "liquidation"],
  dexExit: ["dex", "swap", "pool", "liquidity", "uniswap", "curve", "balancer", "pancake", "exit", "unwind", "slippage"],
  exactEconomics: ["routepositive", "executable", "exacteconomics", "netliquidusd", "valuedelta", "profit", "positive", "gas"],
  forkPrereq: ["fork", "anvil", "localhost", "txattempts", "valuedelta", "routepositive"],
  addressSchema: ["address", "native", "sentinel", "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"],
};

function firstRuleMatch(text, rules) {
  const raw = String(text || "");
  for (const rule of rules) { rule.regex.lastIndex = 0; if (rule.regex.test(raw)) return rule; }
  return null;
}
function hasRuleMatch(text, rules) { return Boolean(firstRuleMatch(text, rules)); }
function isContextualFile(filePath) { return /(?:b2|buzz|bsquared|bitcoin|btc|bridge|proof|custody|consumer|dex|exit|oracle|econom|liquid)/i.test(path.basename(filePath)); }

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
  if (r.includes("prefilter-b2-buzz")) return "prior-prefilter-context-only-no-route-positive";
  if (categories.includes("bitcoinCustody")) return "bitcoin-custody-context-caveat-no-local-query";
  if (categories.includes("bridgeProof") || categories.includes("mintBurnUnlock")) return "bridge-proof-mint-unlock-context-only-no-deployed-path";
  if (categories.includes("custody") || categories.includes("safeMultisig")) return "custody-safe-context-only-no-permissionless-sweep";
  if (categories.includes("consumerJoin")) return "consumer-context-only-no-bsquared-specific-join";
  if (categories.includes("dexExit") || categories.includes("exactEconomics")) return "dex-economics-context-only-no-exact-positive-route";
  if (categories.includes("addressSchema")) return "address-schema-context-only";
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
    scanner: artifact.scanner || "tools/scan-b2-buzz-prefilter.js",
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
    custodyRows: Array.isArray(artifact.custodyRows) ? artifact.custodyRows : [],
    dexLiquidity: Array.isArray(artifact.dexLiquidity) ? artifact.dexLiquidity : [],
    custodyRowsCount: safeNumber(summary.custodyRows),
    contractOwnerRows: safeNumber(summary.contractOwnerRows),
    eoaOwnerRows: safeNumber(summary.eoaOwnerRows),
    tokenRows: safeNumber(summary.tokenRows),
    totalCustodyValueHints: safeNumber(summary.totalCustodyValueHints),
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
  const { custodyRows: _custodyRows, ...safe } = priorPrefilter;
  return safe;
}

function tokenLabel(row) {
  return [row.symbol, row.name].filter(Boolean).join(" / ") || row.token || row.address || "native";
}

function sanitizeCustodyRows(priorPrefilter) {
  const rawRows = priorPrefilter.custodyRows.length ? priorPrefilter.custodyRows : STATIC_CUSTODY_SEEDS;
  return rawRows.map((row) => ({
    label: sanitizeText(row.label, 120),
    chain: sanitizeText(row.chain, 80),
    chainId: row.chainId ?? null,
    owner: row.owner,
    ownerValidAddress: isEvmAddress(row.owner),
    ownerIsContract: row.ownerIsContract ?? null,
    ownerCodeBytes: safeNumber(row.ownerCodeBytes),
    eip1967Implementation: isEvmAddress(row.eip1967Implementation) ? row.eip1967Implementation : null,
    tokens: Array.isArray(row.tokens) ? row.tokens : [],
    tokenRows: Array.isArray(row.tokenRows) ? row.tokenRows.map((token) => ({
      token: token.token || token.address || null,
      address: token.address || token.token || null,
      isNativeSentinel: isNativeSentinel(token.token) || isNativeSentinel(token.address),
      symbol: sanitizeText(token.symbol, 80),
      name: sanitizeText(token.name, 120),
      decimals: token.decimals ?? null,
      balanceRaw: sanitizeText(token.balanceRaw, 120),
      balanceFormatted: sanitizeText(token.balanceFormatted || token.balanceEther, 120),
      balanceUsd: token.balanceUsd ?? null,
      totalSupplyFormatted: sanitizeText(token.totalSupplyFormatted, 120),
      custodySharePct: sanitizeText(token.custodySharePct, 80),
      note: sanitizeText(token.note, 160),
    })) : [],
    localMatches: Array.isArray(row.localMatches) ? row.localMatches.map((m) => ({ file: sanitizeText(m.file, 160), count: safeNumber(m.count) })) : [],
    classification: row.ownerIsContract === true ? "safe-multisig-custody-context-only" : "custody-context-only",
  }));
}

function buildCandidateSeeds(custodyRows) {
  const seeds = [];
  for (const row of custodyRows) {
    seeds.push({
      candidateType: "custody-owner",
      role: row.label || "custody-owner",
      chain: row.chain,
      chainId: row.chainId,
      address: row.owner,
      rawAddress: row.owner,
      isCandidateAddress: true,
      excludedFromAddressSchema: false,
      ownerIsContract: row.ownerIsContract,
      ownerCodeBytes: row.ownerCodeBytes,
      balanceContext: "custody owner only; no permissionless sweep path",
      classification: "custody-owner-candidate-context-only",
    });
    for (const token of row.tokenRows || []) {
      const raw = token.token || token.address;
      if (token.isNativeSentinel || isNativeSentinel(raw)) {
        seeds.push({
          candidateType: "native-token-sentinel",
          role: `${row.label || row.chain} native-token sentinel`,
          chain: row.chain,
          chainId: row.chainId,
          address: null,
          rawAddress: raw || "native",
          isCandidateAddress: false,
          excludedFromAddressSchema: true,
          symbol: token.symbol || "NATIVE",
          balanceContext: token.balanceFormatted ? `native balance ${token.balanceFormatted}` : "native balance context",
          classification: "native-token-sentinel-excluded-from-address-candidates",
        });
        continue;
      }
      seeds.push({
        candidateType: "custody-token",
        role: `${row.label || row.chain} token ${tokenLabel(token)}`,
        chain: row.chain,
        chainId: row.chainId,
        address: raw,
        rawAddress: raw,
        isCandidateAddress: true,
        excludedFromAddressSchema: false,
        symbol: token.symbol || null,
        name: token.name || null,
        balanceContext: token.balanceFormatted ? `custody balance ${token.balanceFormatted}` : "custody balance context",
        totalSupplyContext: token.totalSupplyFormatted || null,
        classification: "custody-token-candidate-context-only",
      });
    }
  }
  return seeds;
}

function assertCandidateAddressSchema(seeds) {
  const invalid = [];
  let validAddressCandidateRows = 0;
  let nativeSentinelExcludedRows = 0;
  let nonAddressExcludedRows = 0;
  for (const seed of seeds) {
    if (seed.excludedFromAddressSchema || seed.isCandidateAddress === false) {
      if (seed.candidateType === "native-token-sentinel") nativeSentinelExcludedRows += 1;
      else nonAddressExcludedRows += 1;
      continue;
    }
    if (isEvmAddress(seed.address)) validAddressCandidateRows += 1;
    else invalid.push({ role: seed.role, chain: seed.chain, address: seed.address, candidateType: seed.candidateType });
  }
  if (invalid.length) {
    throw new Error(`Invalid EVM candidate address schema rows: ${invalid.map((row) => `${row.role}:${row.address}`).join(", ")}`);
  }
  return {
    candidateRows: seeds.length,
    addressCandidateRows: seeds.filter((seed) => seed.isCandidateAddress !== false && !seed.excludedFromAddressSchema).length,
    validAddressCandidateRows,
    invalidAddressCandidateRows: invalid.length,
    nativeSentinelExcludedRows,
    nonAddressExcludedRows,
    schemaAssertionPassed: true,
  };
}

function buildCandidateMatrix(custodyRows, localRows) {
  const seeds = buildCandidateSeeds(custodyRows);
  const addressSchema = assertCandidateAddressSchema(seeds);
  const candidates = seeds.map((candidate) => {
    const terms = [candidate.address, candidate.rawAddress, candidate.role, candidate.symbol, candidate.name].filter(Boolean);
    const candidateRows = localRows.filter((row) => includesAnyTerm(rowSearchText(row), terms));
    const categories = Array.from(new Set(candidateRows.flatMap((row) => row.categories || []))).sort();
    const custodyCtxRows = candidateRows.filter((row) => (row.categories || []).some((cat) => ["custody", "safeMultisig", "bitcoinCustody", "backingMismatch"].includes(cat)));
    const bridgeRows = candidateRows.filter((row) => (row.categories || []).some((cat) => ["bridgeProof", "mintBurnUnlock", "wrappedAsset"].includes(cat)));
    const consumerRows = candidateRows.filter((row) => (row.categories || []).includes("consumerJoin"));
    const dexRows = candidateRows.filter((row) => (row.categories || []).includes("dexExit"));
    const economicsRows = candidateRows.filter((row) => (row.categories || []).includes("exactEconomics"));
    const forkRows = candidateRows.filter((row) => (row.categories || []).includes("forkPrereq"));
    const checks = [
      proofCheck({ key: "addressSchemaValid", status: candidate.isCandidateAddress === false ? "excluded-native-sentinel" : "valid-20-byte-evm-address", evidenceRows: [], blocker: "Address schema is only a prerequisite; it is not route proof." }),
      proofCheck({ key: "custodyWalletPermissionlessSweep", status: custodyCtxRows.length ? "context-only-no-sweep-proof" : "missing", evidenceRows: custodyCtxRows, blocker: "No permissionless sweep or custody-wallet bypass is proven; multisig compromise is not in scope." }),
      proofCheck({ key: "safeMultisigOwnershipThreshold", status: candidate.candidateType === "custody-owner" ? "not-queried-context-only" : "not-applicable-or-missing", evidenceRows: custodyCtxRows, blocker: "Safe threshold/signers/owners were not queried by this deterministic local scan and no threshold bypass is proven." }),
      proofCheck({ key: "bridgeProofLogic", status: bridgeRows.length ? "context-only-no-deployed-proof-bypass" : "missing", evidenceRows: bridgeRows, blocker: "No EVM bridge/proof verifier/domain/nonce/claim/unlock bypass is proven." }),
      proofCheck({ key: "mintBurnUnlockWrappedIssuance", status: bridgeRows.length ? "context-only-no-mint-unlock-path" : "missing", evidenceRows: bridgeRows, blocker: "No BSquared wrapped asset issuance, mint, burn, unlock, or permissionless claim path is proven." }),
      proofCheck({ key: "backingMismatch", status: custodyCtxRows.length ? "context-only-no-claim-reconciliation" : "missing", evidenceRows: custodyCtxRows, blocker: "No custody backing mismatch against user claims or wrapped supply is proven; Bitcoin custody is not queried." }),
      proofCheck({ key: "consumerJoin", status: consumerRows.length ? "context-only-no-bsquared-specific-join" : "missing", evidenceRows: consumerRows, blocker: "No BSquared-specific asset is accepted by a material lending/oracle/liquidation consumer." }),
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
      addressSchemaValid: candidate.isCandidateAddress === false ? null : isEvmAddress(candidate.address),
      symbol: candidate.symbol || null,
      name: candidate.name || null,
      balanceContext: candidate.balanceContext || null,
      ownerIsContract: candidate.ownerIsContract ?? null,
      ownerCodeBytes: candidate.ownerCodeBytes ?? null,
      localArtifactRows: candidateRows.length,
      exactLocalRows: candidateRows.filter(exactish).length,
      categories,
      custodyContextRows: custodyCtxRows.length,
      bridgeProofContextRows: bridgeRows.length,
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
      status: candidate.candidateType === "native-token-sentinel" ? "native-sentinel-excluded-no-token-contract" : candidate.candidateType === "custody-owner" ? "custody-wallet-context-no-permissionless-sweep" : "custody-token-context-no-bsquared-wrapper-consumer-economics",
      blocker: "Missing permissionless custody sweep/proof bypass/mint-unlock/wrapped issuance, backing mismatch, consumer join, DEX exit, exact economics, and fork value-delta proof.",
    };
  });
  const proofGapRows = candidates.flatMap((candidate) => candidate.proofChecks.map((check) => ({ role: candidate.role, chain: candidate.chain, gate: check.key, status: check.status, evidenceRows: check.evidenceRows, blocker: check.blocker })));
  return {
    candidates,
    proofGapRows,
    addressSchema,
    summary: {
      candidateRows: candidates.length,
      custodyOwnerCandidates: candidates.filter((c) => c.candidateType === "custody-owner").length,
      tokenCandidates: candidates.filter((c) => c.candidateType === "custody-token").length,
      nativeSentinelExcludedRows: candidates.filter((c) => c.candidateType === "native-token-sentinel").length,
      addressCandidateRows: addressSchema.addressCandidateRows,
      validAddressCandidateRows: addressSchema.validAddressCandidateRows,
      invalidAddressCandidateRows: addressSchema.invalidAddressCandidateRows,
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
    if (row.rowSource === "static-public-fact" || exactish(row) || cats.some((cat) => ["custody", "safeMultisig", "bitcoinCustody", "bridgeProof", "mintBurnUnlock", "wrappedAsset", "backingMismatch", "consumerJoin", "dexExit", "exactEconomics", "forkPrereq", "addressSchema"].includes(cat))) {
      if (!files.has(key) || exactish(row) || row.rowSource === "static-public-fact") { priority.push(row); files.add(key); }
    }
    if (priority.length >= 54) break;
  }
  return priority.length ? priority : rows.slice(0, 28);
}

const BLOCKERS = [
  "Off-chain Bitcoin custody was not queried; dominant Bitcoin TVL remains a non-EVM coverage caveat and not an EVM route-positive proof.",
  "No B2 Buzz EVM bridge contract, proof verifier, mint/burn/unlock path, or wrapped-token issuance contract is proven in local artifacts.",
  "EVM-side custody rows are Safe/multisig wallets with near-zero route balances and no permissionless sweep path; Safe compromise/signature collection is out of scope.",
  "Native token sentinel is explicitly excluded from candidate-address schema and is not treated as a token-contract candidate.",
  "No BSquared-specific wrapped/claimed asset joins a local lending/oracle/liquidation consumer.",
  "No DEX liquidity or redeem/unwind path exists for a BSquared-specific wrapped asset.",
  "No exact positive borrow, liquidation, redemption, backing mismatch, or unwind economics are proven.",
  "No local fork/static value-delta proof and no signed action justified.",
];

const REQUIRED_FOR_ROUTE_POSITIVE = [
  "A code-present BSquared EVM bridge/proof/wrapped-token contract is mapped to a permissionless proof, mint, burn, unlock, claim, sweep, or custody-backing path.",
  "Or a custody backing mismatch is proven between user claims/wrapped supply and verifiable custody balances, including Bitcoin if the route depends on Bitcoin.",
  "Or a BSquared-issued wrapped/claimed asset appears and is accepted by a material lending/oracle/liquidation consumer with current borrow or liquidation liquidity.",
  "A public acquisition and exit path exists through DEX/redeem/bridge/unwind liquidity at route size.",
  "Exact economics show netLiquidUsd > 0 after gas, fees, slippage, custody/bridge/finality constraints, and any LTV/LLTV haircuts.",
  "Local fork/static value-delta proof demonstrates attacker-controlled positive balance movement with ephemeral local accounts only and no broadcast.",
  "Independent defensive review and explicit route-specific authorization before any signed transaction consideration.",
];

const NEXT_READ_ONLY_STEP = "Keep B2 Buzz dormant unless a BSquared bridge/proof/wrapped-token contract or custody-backing mismatch is proven locally and joins a material consumer/DEX/redeem route with exact positive economics; only then run the local-only fork harness.";

function buildPayload({ lineScan, priorPrefilter }) {
  const custodyRows = sanitizeCustodyRows(priorPrefilter);
  const localRows = lineScan.rows;
  const combinedRows = [...STATIC_CONTEXT_ROWS, ...localRows];
  const exactRows = lineScan.exactRows;
  const categoryRows = {};
  for (const category of Object.keys(CATEGORY_RULES)) categoryRows[`${category}Rows`] = pickRows(combinedRows, (row) => (row.categories || []).includes(category), 220);
  const priorPrefilterRows = pickRows(localRows, (row) => row.file && row.file.includes("prefilter-b2-buzz"), 220);
  const consumerJoinRows = pickRows(combinedRows, (row) => (row.categories || []).includes("consumerJoin"), 240);
  const dexExitRows = pickRows(combinedRows, (row) => (row.categories || []).some((cat) => ["dexExit", "exactEconomics"].includes(cat)), 240);
  const candidateMatrix = buildCandidateMatrix(custodyRows, localRows);
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
    custodyRows: custodyRows.length,
    surfaceRows: SURFACE_ROWS.length,
    bugClassRows: BUG_CLASS_ROWS.length,
    staticContextRows: STATIC_CONTEXT_ROWS.length,
    priorPrefilterRows: priorPrefilterRows.length,
    priorPrefilterCustodyRows: priorPrefilter.custodyRowsCount,
    priorPrefilterContractOwnerRows: priorPrefilter.contractOwnerRows,
    priorPrefilterTokenRows: priorPrefilter.tokenRows,
    priorPrefilterConsumerJoinRows: priorPrefilter.consumerJoinRows,
    priorPrefilterDexLiquidityRows: priorPrefilter.dexLiquidityRows,
    priorPrefilterExactEconomicsRows: priorPrefilter.exactEconomicsRows,
    filesScanned: lineScan.filesScanned,
    filesWithLocalMatches: lineScan.filesWithMatch,
    filesWithExactLocalMatches: lineScan.filesWithExact,
    localArtifactMatchRows: localRows.length,
    exactLocalArtifactMatchRows: exactRows.length,
    custodyContextRows: categoryRows.custodyRows.length,
    safeMultisigRows: categoryRows.safeMultisigRows.length,
    bitcoinCustodyRows: categoryRows.bitcoinCustodyRows.length,
    bridgeProofRows: categoryRows.bridgeProofRows.length,
    mintBurnUnlockRows: categoryRows.mintBurnUnlockRows.length,
    wrappedAssetRows: categoryRows.wrappedAssetRows.length,
    backingMismatchRows: categoryRows.backingMismatchRows.length,
    consumerJoinRows: consumerJoinRows.length,
    exactConsumerJoinRows: 0,
    dexExitContextRows: dexExitRows.length,
    exactEconomicsContextRows: categoryRows.exactEconomicsRows.length,
    forkPrereqRows: categoryRows.forkPrereqRows.length,
    addressSchemaRows: categoryRows.addressSchemaRows.length,
    candidateMatrixRows: candidateMatrix.summary.candidateRows,
    custodyOwnerCandidates: candidateMatrix.summary.custodyOwnerCandidates,
    tokenCandidates: candidateMatrix.summary.tokenCandidates,
    nativeSentinelExcludedRows: candidateMatrix.summary.nativeSentinelExcludedRows,
    addressCandidateRows: candidateMatrix.summary.addressCandidateRows,
    validAddressCandidateRows: candidateMatrix.summary.validAddressCandidateRows,
    invalidAddressCandidateRows: candidateMatrix.summary.invalidAddressCandidateRows,
    addressSchemaAssertionPassed: candidateMatrix.addressSchema.schemaAssertionPassed,
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
    scanner: "tools/scan-b2-buzz-full-test.js",
    target: TARGET,
    scope: { kind: "bounded defensive/read-only full-test scanner", artifactStaticLocalFirst: true, publicFactsOnly: true, evmFirst: true, evmScopeChains: TARGET.evmScopeChains, caveatChains: TARGET.caveatChains, routeGraph: TARGET.routeGraph, writesLimitedTo: [OUT_JSON_REL, OUT_MD_REL], coordinatorClaim: TARGET.coordinatorClaim, aggregatePromotionStateHandoffEdited: false, endpointPolicy: "No endpoint inventory was read by this full-test scanner; no raw endpoints, domains, keys, or tokens are persisted." },
    safety: { localArtifactsRead: true, publicSourcesRead: false, publicStaticLabelsUsed: true, publicNetworkFetch: false, endpointInventoryRead: false, rpcInventoryRead: false, rpcInventoryRows: 0, graphqlInventoryRead: false, graphqlInventoryRows: 0, envFilesRead: false, privateKeyEnvRead: false, privateKeysRead: false, keyFilesRead: false, keyMaterialRead: false, pemFilesRead: false, keypairJsonRead: false, rawEndpointUrlsStored: false, rpcUrlsStored: false, graphqlUrlsStored: false, rawUrlsStored: false, rawDomainsStored: false, rawKeysTokensStored: false, signedActions: false, liveTransactions: false, broadcasts: false, walletOperations: false, exploitExecuteCalls: false, forkTransactions: false, ethCallOnly: false, sanitizedOutputOnly: true, secretLikePathsExcluded: true },
    sourceFacts: SOURCE_FACTS,
    discoveredSeeds: { chainSeeds: CHAIN_SEEDS, custodyRows, surfaceRows: SURFACE_ROWS },
    bugClasses: BUG_CLASS_ROWS,
    priorPrefilter: summarizedPriorPrefilter(priorPrefilter),
    staticContextRows: STATIC_CONTEXT_ROWS,
    priorPrefilterRows,
    localArtifacts: { filesScanned: lineScan.filesScanned, filesWithMatch: lineScan.filesWithMatch, filesWithExact: lineScan.filesWithExact, categoryCounts: lineScan.categoryCounts, rows: localRows, exactRows: exactRows.slice(0, 240), notableRows },
    categoryRows: { ...categoryRows, consumerJoinRows, exactConsumerJoinRows: [], dexExitRows },
    candidateMatrix,
    rows: notableRows.slice(0, 20),
    routeGate: { routePositive, executableNow, signedActionJustified, forkJustified, forkGate, exactPermissionlessValueMovement: false, bridgeProofBypass: false, custodyBackingMismatch: false, wrappedAssetConsumerJoin: false, exactPositiveEconomics: false, localForkStaticProof: false, exactEconomicsRows, status: "dormant-fail-closed", reason: "Static/local scan found custody, Safe/multisig, Bitcoin caveat, bridge/proof, consumer, DEX, and economics context only; no permissionless custody sweep, proof verifier, mint/unlock, BSquared wrapped asset, consumer join, DEX exit, exact positive economics, or fork value-delta proof is present." },
    blockers: BLOCKERS,
    requiredForRoutePositive: REQUIRED_FOR_ROUTE_POSITIVE,
    nextReadOnlyStep: NEXT_READ_ONLY_STEP,
    summary,
  };
}

function metricRows(summary) {
  const keys = ["sourceFactRows", "chainSeedRows", "custodyRows", "surfaceRows", "bugClassRows", "staticContextRows", "priorPrefilterRows", "priorPrefilterCustodyRows", "priorPrefilterContractOwnerRows", "priorPrefilterTokenRows", "priorPrefilterConsumerJoinRows", "priorPrefilterDexLiquidityRows", "priorPrefilterExactEconomicsRows", "filesScanned", "filesWithLocalMatches", "filesWithExactLocalMatches", "localArtifactMatchRows", "exactLocalArtifactMatchRows", "custodyContextRows", "safeMultisigRows", "bitcoinCustodyRows", "bridgeProofRows", "mintBurnUnlockRows", "wrappedAssetRows", "backingMismatchRows", "consumerJoinRows", "exactConsumerJoinRows", "dexExitContextRows", "exactEconomicsContextRows", "forkPrereqRows", "addressSchemaRows", "candidateMatrixRows", "custodyOwnerCandidates", "tokenCandidates", "nativeSentinelExcludedRows", "addressCandidateRows", "validAddressCandidateRows", "invalidAddressCandidateRows", "addressSchemaAssertionPassed", "candidatesWithConsumerContext", "candidatesWithDexExitContext", "candidatesWithExactEconomics", "candidatesWithForkValueDeltaProof", "candidateMatrixProofGapRows", "publicFetchRows", "rpcInventoryRows", "graphqlInventoryRows", "ethCallRows", "forkRows", "exactEconomicsRows", "routePositive", "executableNow", "signedActionJustified", "forkJustified", "forkGate", "fullTestReadOnlyComplete"];
  return keys.map((key) => `| ${key} | ${mdEscape(summary[key])} |`).join("\n");
}
function safetyRows(safety) { return ["localArtifactsRead", "publicSourcesRead", "publicStaticLabelsUsed", "publicNetworkFetch", "endpointInventoryRead", "rpcInventoryRead", "graphqlInventoryRead", "envFilesRead", "privateKeysRead", "keyMaterialRead", "rawEndpointUrlsStored", "rpcUrlsStored", "graphqlUrlsStored", "rawUrlsStored", "rawDomainsStored", "rawKeysTokensStored", "signedActions", "liveTransactions", "broadcasts", "walletOperations", "forkTransactions", "sanitizedOutputOnly", "secretLikePathsExcluded"].map((key) => `| ${key} | ${mdEscape(safety[key])} |`).join("\n"); }
function shortAddress(value) { const text = String(value || ""); return /^0x[0-9a-fA-F]{40}$/.test(text) ? `${text.slice(0, 6)}...${text.slice(-4)}` : text; }
function formatCustodyRow(row) { const balances = (row.tokenRows || []).map((t) => `${t.symbol || t.token || "native"}:${t.balanceFormatted || t.balanceRaw || "n/a"}${t.isNativeSentinel ? " (native sentinel excluded)" : ""}`).join(", "); return `| ${mdEscape(row.label)} | ${mdEscape(row.chain)} | ${mdEscape(shortAddress(row.owner))} | ${mdEscape(row.ownerIsContract)} | ${mdEscape(row.ownerCodeBytes)} | ${mdEscape(balances)} | ${mdEscape(row.classification)} |`; }
function formatSurfaceRow(row) { return `| ${mdEscape(row.component)} | ${mdEscape(row.surface)} | ${mdEscape(row.routeRole)} | ${mdEscape((row.watchTerms || []).join(", "))} |`; }
function formatCandidateRow(row) { const evidence = `local=${row.localArtifactRows}, exact=${row.exactLocalRows}, addressValid=${row.addressSchemaValid}, excluded=${row.excludedFromAddressSchema}, consumer=${row.consumerContextRows}, dex=${row.dexExitContextRows}, econ=${row.exactEconomicsContextRows}`; return `| ${mdEscape(row.role)} | ${mdEscape(row.chain)} | ${mdEscape(row.address ? shortAddress(row.address) : row.rawAddress)} | ${mdEscape(row.candidateType)} | ${mdEscape(evidence)} | ${mdEscape(row.routeBlockingProofGaps.join(", "))} | ${mdEscape(row.status)} |`; }
function formatBugClassRow(row) { return `| ${mdEscape(row.label)} | ${mdEscape(row.surface)} | ${mdEscape(row.classification)} |`; }
function formatLocalRow(row) { return `| ${mdEscape(sourceForRow(row))} | ${mdEscape((row.categories || []).join(","))} | ${mdEscape(row.matched)} | ${mdEscape(row.sample || "context-only")} | ${mdEscape(row.routePositive)} | ${mdEscape(row.classification)} |`; }

function buildMarkdown(payload) {
  const notableRows = payload.localArtifacts.notableRows.length ? payload.localArtifacts.notableRows.map(formatLocalRow).join("\n") : "| (none) | n/a | n/a | no local context rows found | 0 | dormant |";
  return `# 🟢 DORMANT - B2 Buzz Full Test

Generated: ${payload.generatedAt}

Route remains closed: routePositive=${payload.routeGate.routePositive}, executableNow=${payload.routeGate.executableNow}, signedActionJustified=${payload.routeGate.signedActionJustified}, forkJustified=${payload.routeGate.forkJustified}, forkGate=${payload.routeGate.forkGate}.

## Target Context

- Target: ${payload.target.name} (${payload.target.protocolSlug}/${payload.target.slug}), category=${payload.target.category}, surface=${payload.target.surface}, TVL context≈${payload.target.tvlContext}.
- EVM scope: ${payload.scope.evmScopeChains.join(", ")}; non-EVM caveat: ${payload.scope.caveatChains.join(", ")}.
- Route graph: ${payload.target.routeGraph}.
- Existing coverage: prior prefilter has custodyRows=${payload.priorPrefilter.custodyRowsCount}, tokenRows=${payload.priorPrefilter.tokenRows}, consumerJoinRows=${payload.priorPrefilter.consumerJoinRows}, dexLiquidityRows=${payload.priorPrefilter.dexLiquidityRows}, exactEconomicsRows=${payload.priorPrefilter.exactEconomicsRows}, routePositive=${payload.priorPrefilter.routePositive}.
- Fail-closed caveat: Bitcoin custody was not queried; native token sentinel is excluded from candidate-address schema and does not become a token-contract candidate.

## Metrics

| Metric | Value |
|---|---:|
${metricRows(payload.summary)}

## Safety Summary

| Field | Value |
|---|---:|
${safetyRows(payload.safety)}

## Custody Seeds From Prior Prefilter

| Label | Chain | Owner | Owner Contract | Code Bytes | Token Balances | Classification |
|---|---|---|---:|---:|---|---|
${payload.discoveredSeeds.custodyRows.map(formatCustodyRow).join("\n")}

## Surface Checklist

| Component | Surface | Route Role | Watch Terms |
|---|---|---|---|
${payload.discoveredSeeds.surfaceRows.map(formatSurfaceRow).join("\n")}

## Candidate Matrix / Address Schema Gate

| Candidate | Chain | Address/Raw | Type | Local Evidence | Missing Current Proofs | Status |
|---|---|---|---|---|---|---|
${payload.candidateMatrix.candidates.map(formatCandidateRow).join("\n")}

Address schema assertion: validAddressCandidateRows=${payload.summary.validAddressCandidateRows}, invalidAddressCandidateRows=${payload.summary.invalidAddressCandidateRows}, nativeSentinelExcludedRows=${payload.summary.nativeSentinelExcludedRows}, passed=${payload.summary.addressSchemaAssertionPassed}.

## Bug Classes / Proof Gaps

| Class | Surface | Classification |
|---|---|---|
${payload.bugClasses.map(formatBugClassRow).join("\n")}

## Notable Local / Static Rows

| Source | Categories | Match | Detail | Route | Classification |
|---|---|---|---|---:|---|
${notableRows}

## Route Gate

- Status: ${payload.routeGate.status}.
- Required fail-closed conjunction is absent: exactPermissionlessValueMovement=${payload.routeGate.exactPermissionlessValueMovement}, bridgeProofBypass=${payload.routeGate.bridgeProofBypass}, custodyBackingMismatch=${payload.routeGate.custodyBackingMismatch}, wrappedAssetConsumerJoin=${payload.routeGate.wrappedAssetConsumerJoin}, exactPositiveEconomics=${payload.routeGate.exactPositiveEconomics}, localForkStaticProof=${payload.routeGate.localForkStaticProof}.
- No EVM bridge/proof verifier, mint/burn/unlock, BSquared wrapped-asset consumer join, DEX/redeem exit, backing mismatch, exact positive economics, or fork value-delta proof was resolved.
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
  log("Scanning B2 Buzz local artifacts (sanitized, no endpoint inventory read)...");
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
