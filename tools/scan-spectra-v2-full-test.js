#!/usr/bin/env node
"use strict";

// scan-spectra-v2-full-test.js
// Defensive Spectra V2 full-test scanner. Artifact/static-source only; no endpoint inventory, RPC, or transactions.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_DIR = path.join(WORKSPACE, "reports", "raw", "fast");
const REPORTS_DIR = path.join(WORKSPACE, "reports");
const OUT_JSON = path.join(RAW_DIR, "spectra-v2-full-test.json");
const OUT_MD = path.join(REPORTS_DIR, "spectra-v2-full-test-triage.md");
const OUT_JSON_REL = "reports/raw/fast/spectra-v2-full-test.json";
const OUT_MD_REL = "reports/spectra-v2-full-test-triage.md";

const QUIET = process.argv.includes("--quiet");
const GENERATED_AT = process.env.SCAN_GENERATED_AT || "2026-07-07T00:00:00.000Z";

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_LOCAL_MATCH_ROWS = 460;
const MAX_LOCAL_OBJECT_ROWS = 360;
const MAX_ROWS_PER_FILE = 36;
const MAX_JSON_DEPTH = 9;

const TARGET = {
  slug: "spectra-v2",
  name: "Spectra V2",
  kind: "protocol",
  category: "Yield",
  discoveryRank: 12,
  tvlContextUsd: 30_347_000,
  tvlContext: "$30.347M",
  surface: "vault-yield-allocator",
  primaryChains: ["Avalanche", "Ethereum", "Base", "Sonic"],
  routeGraph: "vault share -> rate/strategy accounting -> consumer or exit venue -> borrow/redeem/unwind",
  module: "projects/spectra/index.js",
  adapterPathLabel: "defillama-adapter:projects/spectra/index.js",
  branchCaveat: "Spectra MetaVaults Outside V2 is related/context-only and is not closure proof for spectra-v2.",
};

const CHAIN_SEEDS = [
  { chain: "Avalanche", chainLabel: "Avalanche", chainId: 43114, adapterKey: "avax", discoveryPrimary: true, publicStatic: true },
  { chain: "Ethereum", chainLabel: "Ethereum", chainId: 1, adapterKey: "ethereum", discoveryPrimary: true, publicStatic: true },
  { chain: "Base", chainLabel: "Base", chainId: 8453, adapterKey: "base", discoveryPrimary: true, publicStatic: true },
  { chain: "Sonic", chainLabel: "Sonic", chainId: 146, adapterKey: "sonic", discoveryPrimary: true, publicStatic: true },
  { chain: "Arbitrum", chainLabel: "Arbitrum", chainId: 42161, adapterKey: "arbitrum", discoveryPrimary: false, publicStatic: true },
  { chain: "Optimism", chainLabel: "Optimism", chainId: 10, adapterKey: "optimism", discoveryPrimary: false, publicStatic: true },
  { chain: "Hemi", chainLabel: "Hemi", chainId: null, adapterKey: "hemi", discoveryPrimary: false, publicStatic: true, chainIdUnknown: true },
  { chain: "BNB/BSC", chainLabel: "BNB/BSC", chainId: 56, adapterKey: "bsc", discoveryPrimary: false, publicStatic: true },
  { chain: "Hyperliquid", chainLabel: "Hyperliquid", chainId: null, adapterKey: "hyperliquid", discoveryPrimary: false, publicStatic: true, chainIdUnknown: true },
  { chain: "Katana", chainLabel: "Katana", chainId: 747474, adapterKey: "katana", discoveryPrimary: false, publicStatic: true },
  { chain: "Flare", chainLabel: "Flare", chainId: 14, adapterKey: "flare", discoveryPrimary: false, publicStatic: true },
  { chain: "Monad", chainLabel: "Monad", chainId: null, adapterKey: "monad", discoveryPrimary: false, publicStatic: true, chainIdUnknown: true },
];

const CORE_COMPONENTS = [
  { label: "Registry", category: "registry" },
  { label: "Factory", category: "factory" },
  { label: "Router", category: "router" },
  { label: "RouterUtil", category: "router" },
  { label: "SPECTRA Token", category: "token" },
  { label: "veSPECTRA", category: "token" },
  { label: "Price Oracle Factory", category: "oracle" },
  { label: "Discount Model", category: "oracle" },
  { label: "Oracle Factory", category: "oracle" },
  { label: "Access Manager", category: "access" },
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
    sourceLabel: "defillama-protocol-label:spectra-v2",
    kind: "public-static-label",
    slug: TARGET.slug,
    module: TARGET.module,
    adapterChains: CHAIN_SEEDS.map((row) => row.adapterKey),
    classification: "source-label-only-no-url-stored",
  },
  {
    sourceLabel: "official-core-docs-label",
    kind: "public-static-label",
    components: CORE_COMPONENTS.map((row) => row.label),
    classification: "source-label-only-no-url-stored",
  },
  {
    sourceLabel: "spectra-metavaults-prior-prefilter-label",
    kind: "related-context-only",
    relatedSlug: "spectra-metavaults-outside-v2",
    priorArtifacts: ["tools/scan-spectra-metavaults-prefilter.js", "reports/prefilter-spectra-metavaults-route-prefilter.md", "reports/raw/fast/prefilter-spectra-metavaults-route-prefilter.json"],
    notClosureProofForSpectraV2: true,
    classification: "metavaults-separate-branch-context-only",
  },
];

const EXACT_RULES = [
  { label: "spectra-v2", regex: /\bspectra[\s_-]*v2\b/i },
  { label: "spectra", regex: /\bspectra\b/i },
  { label: "SPECTRA", regex: /\bSPECTRA\b/ },
  { label: "veSPECTRA", regex: /\bveSPECTRA\b/i },
  { label: "projects/spectra/index.js", regex: /projects[\\/]spectra[\\/]index\.js/i },
];

const STRONG_DOMAIN_RULES = [
  { label: "PT", regex: /\bpt(?:[-_\s]|$)/i },
  { label: "YT", regex: /\byt(?:[-_\s]|$)/i },
  { label: "principal token", regex: /\bprincipal\s+tokens?\b/i },
  { label: "yield token", regex: /\byield\s+tokens?\b/i },
  { label: "SY", regex: /\bsy(?:[-_\s]|$)/i },
  { label: "standardized yield", regex: /\bstandardi[sz]ed\s+yield\b/i },
  { label: "IBT", regex: /\bibt(?:[-_\s]|$)/i },
  { label: "interest bearing token", regex: /\binterest[-\s]?bearing\s+tokens?\b/i },
  { label: "ERC4626", regex: /\berc[-_]?4626\b/i },
];

const CONTEXT_RULES = [
  ...STRONG_DOMAIN_RULES,
  { label: "registry", regex: /\bregistry\b/i },
  { label: "factory", regex: /\bfactory\b/i },
  { label: "router", regex: /\brouter(?:util)?\b/i },
  { label: "oracle", regex: /\boracle\b/i },
  { label: "price oracle factory", regex: /\bprice\s+oracle\s+factory\b/i },
  { label: "discount model", regex: /\bdiscount\s+model\b/i },
  { label: "oracle factory", regex: /\boracle\s+factory\b/i },
  { label: "Curve", regex: /\bcurve\b/i },
  { label: "AMM", regex: /\bamm\b/i },
  { label: "market", regex: /\bmarket\b/i },
  { label: "maturity", regex: /\bmaturity\b/i },
  { label: "negative yield", regex: /\bnegative\s+yield\b/i },
  { label: "rate", regex: /\brate\b/i },
  { label: "strategy accounting", regex: /\bstrategy\s+accounting\b/i },
  { label: "redeem", regex: /\bredeem\b/i },
  { label: "swap", regex: /\bswap\b/i },
  { label: "unwind", regex: /\bunwind\b/i },
];

const CATEGORY_RULES = {
  consumer: ["consumer", "accepted", "collateral", "borrow", "lending", "market", "morpho", "euler", "silo", "aave", "compound", "comet", "vault", "lltv", "ltv", "supplycap", "cash", "exit venue"],
  dex: ["dex", "swap", "pool", "amm", "curve", "uniswap", "balancer", "liquidity", "router", "quote", "exit", "unwind"],
  oracle: ["oracle", "price", "feed", "rate", "exchange rate", "discount model", "maturity", "negative yield", "chainlink", "pyth", "redstone"],
  erc4626: ["erc4626", "erc-4626", "vault", "share", "converttoassets", "previewredeem", "totalassets", "asset()"],
  ptYt: ["pt", "yt", "principal token", "yield token", "maturity", "sy", "ibt", "standardized yield", "interest bearing token"],
  market: ["market", "factory", "pool", "amm", "curve", "principal", "yield", "ibt", "sy"],
  router: ["router", "routerutil", "route", "swap", "redeem", "issue", "split", "merge", "unwind"],
  registry: ["registry", "factory", "access manager", "accessmanager"],
  metavaults: ["metavault", "meta vault", "spectra-metavaults", "spectra metavaults", "outside v2"],
  economics: ["routepositive", "positive", "profit", "discount", "premium", "overvalue", "overvaluation", "tvl", "liquidity", "slippage", "same-block"],
};

const JSON_FIELD_ALLOWLIST = [
  "rank", "kind", "slug", "name", "category", "tvlUsd", "tvl", "currentTvlUsd", "chains", "primaryChain", "evmChains", "surface", "routeGraph", "module", "score", "chain", "chainId", "adapterKey", "adapterChain", "symbol", "assetSymbol", "assetName", "asset", "assetAddr", "collateral", "collateralAddr", "loan", "loanAddr", "vault", "vaultSymbol", "vaultName", "vaultDecimals", "market", "factory", "registry", "router", "routerUtil", "oracle", "priceFeed", "feedDescription", "exchangeRate", "rate", "maturity", "pt", "yt", "sy", "ibt", "isPT", "isYT", "isSY", "isIBT", "pool", "lpToken", "gauge", "usdTotal", "liquidity", "borrowUsd", "supplyUsd", "cashRaw", "totalAssetsRaw", "totalSupplyRaw", "totalBorrowsRaw", "routePositive", "executableNow", "signedActionJustified", "forkJustified", "classification", "status", "watchCandidate",
];

const BLOCKERS = [
  "No exact permissionless Spectra V2 value movement is proven from local artifacts; rows remain source/static/context only.",
  "No accepted-value/accounting overvaluation is quantified for a PT/YT/SY/IBT/vault share versus immediate redeem, swap, or unwind value.",
  "No consumer acceptance row proves current borrow/redeem/exit capacity, caps, oracle freshness, and borrower-side overvaluation in the same route.",
  "No exact acquisition -> redeem/swap/unwind economics, including Curve/AMM liquidity, fees, slippage, maturity discount, negative-yield behavior, and gas, is present.",
  "No same-block exit path is proven from acquisition through router/market/factory/registry accounting into a liquid exit venue.",
  "Maturity and negative-yield caveats remain unresolved for PT/YT pricing, discount model behavior, and any IBT/SY exchange-rate assumptions.",
  "No oracle/rate manipulation proof shows a permissionless actor can move accepted accounting value without equivalent market/redeem cost.",
  "Spectra MetaVaults prior artifacts are related/context-only and do not close the distinct spectra-v2 target.",
  "Fork and signed-action gates remain closed because routePositive=0 and exactEconomicsRows=0.",
];

const REQUIRED_FOR_ROUTE_POSITIVE = [
  "Accepted-value/accounting overvaluation: exact current Spectra V2 registry/factory/market state must price PT/YT/SY/IBT/vault shares above immediate market/redeem value after all fees.",
  "Consumer acceptance: a lending/vault/exit consumer must currently accept the specific Spectra asset with material caps, cash/borrow capacity, oracle freshness, and no allowlist/pause/role blocker.",
  "Exact acquisition/redeem/swap/unwind economics: compute buy/split/merge/redeem/router/Curve/AMM path amounts, slippage, maturity discounts, negative-yield effects, and gas at route scale.",
  "Same-block exit: prove the full acquisition -> accounting acceptance -> borrow/redeem/unwind -> exit sequence can settle atomically or without exploitable inventory/price drift.",
  "Maturity/negative-yield caveats: handle matured/expired markets, PT/YT redemption rules, SY/IBT exchange-rate changes, and discount model edge cases.",
  "Oracle/rate manipulation proof: show a permissionless manipulation of oracle/rate/accounting inputs, not merely admin-controlled setters or stale labels.",
  "Fork/static value-delta proof: local static proof or fork simulation must show positive attacker-controlled balance delta before any live preflight or signed action is considered.",
  "Explicit route-specific authorization and independent defensive review are required before any signed transaction path is discussed.",
];

const NEXT_READ_ONLY_STEP = "Map Spectra V2 Registry/Factory/Router/RouterUtil market assets from verified public/static sources, then refresh local-only PT/YT/SY/IBT consumer and Curve/AMM/oracle rows to test accepted-value versus redeem/swap/unwind value without endpoint inventory or signed actions.";

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
    .replace(/\b(authorization|api[-_]?key|access[-_]?key|private[-_]?key|secret[-_]?key|secret|token|password|pwd)\s*[:=]\s*["']?[^\s"',}\]]{8,}/gi, "$1=[redacted]")
    .replace(/\b0x[0-9a-fA-F]{64}\b/g, "[redacted-hex-key]")
    .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9._-]{20,}\.[A-Za-z0-9._-]{20,}\b/g, "[redacted-jwt]");
  return text.slice(0, max) || null;
}

function mdEscape(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
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
  const files = roots.flatMap(listFilesRecursive);
  const extraFiles = [path.join(WORKSPACE, "tmp-spectra-adapter.js")];
  for (const file of extraFiles) {
    if (fs.existsSync(file) && !isExcludedScanPath(file)) files.push(file);
  }
  return uniqBy(files, (file) => path.resolve(file)).sort((a, b) => rel(a).localeCompare(rel(b)));
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
  if (exact) return { matchType: "exact-name", matched: exact.label, termType: "text" };
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
      if (match.matchType === "exact-name") fileExact = true;
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
        classification: categories.includes("metavaults") ? "related-metavaults-context-only-not-spectra-v2-closure" : "local-artifact-watch-context-only-no-route-positive",
      });
      sampled += 1;
    }
    if (fileMatched) filesWithMatch += 1;
    if (fileExact) filesWithExact += 1;
    if (rows.length >= MAX_LOCAL_MATCH_ROWS) break;
  }

  return { filesScanned, filesWithMatch, filesWithExact, rows, exactRows: rows.filter((row) => row.matchType === "exact-name"), categoryCounts };
}

function shouldSkipJsonKey(key) {
  return /(url|uri|endpoint|domain|hostname|host|secret|password|private|key|token|auth|bearer|cookie)/i.test(String(key || ""));
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
    let rendered;
    if (typeof value === "object") rendered = JSON.stringify(value, jsonReplacer).slice(0, 180);
    else rendered = String(value);
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
          classification: categories.includes("metavaults") ? "related-metavaults-context-only-not-spectra-v2-closure" : "exact-local-watch-context-only-no-positive-economics",
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

  return { jsonFilesParsed, rows, exactRows: rows.filter((row) => row.matchType === "exact-name"), categoryCounts };
}

function exactish(row) {
  return row.matchType === "exact-name";
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
  const highSignal = rows.filter((row) => row.categories.some((cat) => ["consumer", "dex", "oracle", "erc4626", "ptYt", "router", "market"].includes(cat)));
  return uniqBy([...exact, ...highSignal], (row) => `${sourceForRow(row)}:${row.matchType}:${row.matched}`).slice(0, 24);
}

function buildPayload({ lineScan, objectScan }) {
  const combinedRows = uniqBy([...objectScan.rows, ...lineScan.rows], (row) => `${sourceForRow(row)}:${row.matchType}:${row.matched}:${row.rowSource}`);
  const exactRows = combinedRows.filter(exactish);
  const consumerJoinRows = pickRows(combinedRows, (row) => row.categories.includes("consumer"), 140);
  const exactConsumerJoinRows = pickRows(consumerJoinRows, exactish, 120);
  const dexLiquidityRows = pickRows(combinedRows, (row) => row.categories.includes("dex"), 140);
  const oracleRows = pickRows(combinedRows, (row) => row.categories.includes("oracle"), 140);
  const erc4626Rows = pickRows(combinedRows, (row) => row.categories.includes("erc4626"), 140);
  const ptYtRows = pickRows(combinedRows, (row) => row.categories.includes("ptYt"), 140);
  const marketRows = pickRows(combinedRows, (row) => row.categories.includes("market"), 140);
  const routerRows = pickRows(combinedRows, (row) => row.categories.includes("router"), 140);
  const metaVaultsContextRows = pickRows(combinedRows, (row) => row.categories.includes("metavaults"), 80);
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
    coreComponentRows: CORE_COMPONENTS.length,
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
    erc4626Rows: erc4626Rows.length,
    ptYtRows: ptYtRows.length,
    marketRows: marketRows.length,
    routerRows: routerRows.length,
    metaVaultsContextRows: metaVaultsContextRows.length,
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
    scanner: "tools/scan-spectra-v2-full-test.js",
    target: TARGET,
    scope: {
      kind: "defensive route-first full-test scanner",
      artifactOnly: true,
      evmFirst: true,
      discoveryChains: TARGET.primaryChains,
      staticAdapterChains: CHAIN_SEEDS.map((row) => row.chainLabel),
      routeGraph: TARGET.routeGraph,
      writesLimitedTo: [OUT_JSON_REL, OUT_MD_REL],
      relatedContextOnly: ["spectra-metavaults-outside-v2"],
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
      coreComponents: CORE_COMPONENTS,
      metaVaultsContext: {
        relatedSlug: "spectra-metavaults-outside-v2",
        relatedArtifacts: ["tools/scan-spectra-metavaults-prefilter.js", "reports/prefilter-spectra-metavaults-route-prefilter.md", "reports/raw/fast/prefilter-spectra-metavaults-route-prefilter.json"],
        separateDocsBranch: true,
        notClosureProofForSpectraV2: true,
        classification: "related-context-only",
      },
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
      erc4626Rows,
      ptYtRows,
      marketRows,
      routerRows,
      metaVaultsContextRows,
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
    "sourceFactRows",
    "chainSeedRows",
    "coreComponentRows",
    "filesScanned",
    "filesWithLocalMatches",
    "filesWithExactLocalMatches",
    "jsonFilesParsed",
    "localArtifactMatchRows",
    "exactLocalArtifactMatchRows",
    "localLineRows",
    "localObjectRows",
    "consumerJoinRows",
    "exactConsumerJoinRows",
    "dexLiquidityRows",
    "oracleRows",
    "erc4626Rows",
    "ptYtRows",
    "marketRows",
    "routerRows",
    "metaVaultsContextRows",
    "publicFetchRows",
    "rpcInventoryRows",
    "exactEconomicsRows",
    "routePositive",
    "executableNow",
    "signedActionJustified",
    "forkJustified",
    "forkGate",
  ];
  return keys.map((key) => `| ${key} | ${mdEscape(summary[key])} |`).join("\n");
}

function safetyRows(safety) {
  const keys = [
    "localArtifactsRead",
    "publicSourcesRead",
    "publicNetworkFetch",
    "rpcInventoryRead",
    "graphqlInventoryRead",
    "envFilesRead",
    "privateKeysRead",
    "keyMaterialRead",
    "rpcUrlsStored",
    "rawUrlsStored",
    "rawDomainsStored",
    "signedActions",
    "liveTransactions",
    "broadcasts",
    "forkTransactions",
    "ethCallOnly",
    "sanitizedOutputOnly",
    "secretLikePathsExcluded",
  ];
  return keys.map((key) => `| ${key} | ${mdEscape(safety[key])} |`).join("\n");
}

function formatRow(row) {
  const source = sourceForRow(row);
  const categories = (row.categories || []).join(",");
  const detail = row.context || row.sample || fieldsContext(row.fields || {}) || "context-only";
  return `| ${mdEscape(source)} | ${mdEscape(categories)} | ${mdEscape(row.matched)} | ${mdEscape(detail)} | ${mdEscape(row.routePositive)} | ${mdEscape(row.classification)} |`;
}

function buildMarkdown(payload) {
  const signal = payload.routeGate.routePositive === 0 ? "🟢 DORMANT" : "🔴 ROUTE-POSITIVE";
  const notableRows = payload.localArtifacts.notableRows.length
    ? payload.localArtifacts.notableRows.map(formatRow).join("\n")
    : "| (none) | n/a | n/a | no local context rows found | 0 | dormant |";
  const metaRows = payload.categoryRows.metaVaultsContextRows.length
    ? payload.categoryRows.metaVaultsContextRows.slice(0, 10).map(formatRow).join("\n")
    : "| (none) | n/a | n/a | no MetaVaults context rows sampled | 0 | related-context-only |";

  return `# ${signal} - Spectra V2 Full Test

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
- Related/context-only branch: spectra-metavaults-outside-v2 is separate from spectra-v2 and does not prove closure.
- No aggregate gate scripts, state/context files, handoff files, secret/endpoint inventories, or wallet/key material are written or read.

## Safety

| Field | Value |
|---|---:|
${safetyRows(payload.safety)}

## Notable Local Rows (watch/context only)

| Source | Categories | Match | Detail | Route | Classification |
|---|---|---|---|---:|---|
${notableRows}

## MetaVaults Context Only

Prior MetaVaults artifacts are retained as related context only. They cover \`spectra-metavaults-outside-v2\`, not the distinct \`spectra-v2\` target.

| Source | Categories | Match | Detail | Route | Classification |
|---|---|---|---|---:|---|
${metaRows}

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
  log("Scanning Spectra V2 local artifacts (sanitized, no endpoint inventory)...");
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
