#!/usr/bin/env node
"use strict";

// scan-meme-dollar-full-test.js
// Defensive Meme Dollar full-test scanner. Static/local/public-facts only; no
// endpoint inventory reads, network fetches, RPC calls, forks, signed actions,
// broadcasts, or wallets.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_DIR = path.join(WORKSPACE, "reports", "raw", "fast");
const REPORTS_DIR = path.join(WORKSPACE, "reports");
const OUT_JSON = path.join(RAW_DIR, "meme-dollar-full-test.json");
const OUT_MD = path.join(REPORTS_DIR, "meme-dollar-full-test-triage.md");
const OUT_JSON_REL = "reports/raw/fast/meme-dollar-full-test.json";
const OUT_MD_REL = "reports/meme-dollar-full-test-triage.md";

const QUIET = process.argv.includes("--quiet");
const GENERATED_AT = process.env.SCAN_GENERATED_AT || "2026-07-07T00:00:00.000Z";

const MAX_FILE_BYTES = 24 * 1024 * 1024;
const MAX_LOCAL_MATCH_ROWS = 720;
const MAX_ROWS_PER_FILE = 34;

const TARGET = {
  slug: "meme-dollar",
  name: "Meme Dollar",
  kind: "yield",
  category: "stable-yield-depeg-oracle",
  discoveryRank: 20,
  chain: "Ethereum",
  symbol: "PINA",
  tokenName: "Meme Dollar",
  poolId: "e2078236-a4ad-4c8c-b575-69f57cdc26d8",
  tvlContextUsd: 742_568,
  tvlContext: "$742,568",
  apyContext: "87.14%",
  stablecoin: true,
  ilRisk: "no",
  surface: "stable-yield-depeg-oracle",
  primaryChains: ["Ethereum"],
  caveatChains: [],
  routeGraph: "stable deposit/receipt -> peg/NAV assumption -> lending or DEX exit",
  firstReadOnlyChecks: [
    "resolve exact PINA/MemeDollar stable receipt and any deposit/redeem accounting",
    "probe peg/NAV/oracle assumptions including bootstrap fixed oracle and Uniswap price transition",
    "join PINA to lending/oracle consumers and DEX/exit liquidity with exact economics",
  ],
  tokenAddress: "0x02814F435dD04e254Be7ae69F61FCa19881a780D",
};

const CHAIN_SEEDS = [
  { chain: "Ethereum", chainLabel: "Ethereum", chainId: 1, adapterKey: "ethereum", evmFirst: true, caveat: false, classification: "primary-evm-discovery-chain" },
];

const ADDRESS_SEEDS = [
  {
    role: "PINA / Meme Dollar token from discovery and public token page",
    chain: "Ethereum",
    address: TARGET.tokenAddress,
    surface: "stable receipt / algo-stable token seed",
    classification: "public-static-address-not-live-state-proof",
  },
];

const SURFACE_ROWS = [
  { component: "PINA / Meme Dollar receipt", surface: "stablecoin/deposit receipt identity", routeRole: "producer asset identity", watchTerms: ["PINA", "Meme Dollar", "MemeDollar", TARGET.tokenAddress] },
  { component: "Peg/NAV assumption", surface: "bootstrap fixed oracle and later market-price transition", routeRole: "accepted-value/reference-price proof gap", watchTerms: ["peg", "NAV", "$1.5", "bootstrap", "Uniswap price"] },
  { component: "Algo-stable mechanics", surface: "epochs, coupons, contraction/expansion, and redemption-like state", routeRole: "supply/accounting and redeemability", watchTerms: ["epoch", "coupon", "redeem", "burn", "mint"] },
  { component: "Role-controlled mint", surface: "MINTER_ROLE and AccessControlEnumerable", routeRole: "privileged supply mutation blocker", watchTerms: ["MINTER_ROLE", "AccessControlEnumerable", "mint", "DEFAULT_ADMIN_ROLE"] },
  { component: "Transfer/operational gates", surface: "pause/upgrade/transfer restrictions", routeRole: "transferability and liquidation gate", watchTerms: ["pause", "upgrade", "blacklist", "transfer"] },
  { component: "DEX exit", surface: "Uniswap/Dexscreener liquidity and no-current-pair context", routeRole: "acquire/unwind liquidity", watchTerms: ["Uniswap", "Dexscreener", "pair", "liquidity", "swap"] },
  { component: "Consumer joins", surface: "lending/oracle/DEX consumers", routeRole: "borrow/redeem/liquidate/exit economics", watchTerms: ["Morpho", "Aave", "Euler", "Silo", "Compound", "consumer"] },
  { component: "Hard backing/collateral", surface: "collateral or reserve backing proof gap", routeRole: "NAV/solvency blocker", watchTerms: ["collateral", "reserve", "backing", "treasury"] },
];

const PUBLIC_DOCS = [
  `https://etherscan.io/token/${TARGET.tokenAddress}`,
  `https://etherscan.io/address/${TARGET.tokenAddress}#code`,
  "Official website public label: dontdiememe (not fetched; URL not persisted by this scanner)",
  "Medium docs public context: bootstrap fixed oracle at $1.5, later Uniswap price, epochs/coupons/upgrade pause (not fetched here)",
  "Dexscreener public lookup context: no current pairs observed in prior recon (not fetched here)",
];

const BUG_CLASS_ROWS = [
  { label: "bootstrap fixed oracle or peg assumption overvalues PINA", surface: "peg/NAV/oracle", classification: "bug-class-context-no-current-route-proof" },
  { label: "Uniswap price transition manipulation or stale reference", surface: "oracle/market price", classification: "bug-class-context-no-current-route-proof" },
  { label: "hard collateral or NAV backing unproven", surface: "reserve/backing", classification: "bug-class-context-no-current-route-proof" },
  { label: "role-controlled unbacked minting", surface: "MINTER_ROLE/AccessControl", classification: "bug-class-context-no-current-route-proof" },
  { label: "epoch/coupon accounting mismatch", surface: "epochs/coupons/redeem", classification: "bug-class-context-no-current-route-proof" },
  { label: "upgrade/pause governance blocks execution", surface: "operational controls", classification: "bug-class-context-no-current-route-proof" },
  { label: "consumer accepts illiquid algo-stable at peg", surface: "lending/oracle consumer", classification: "bug-class-context-no-current-route-proof" },
  { label: "DEX no-pair or thin-liquidity exit blocker", surface: "DEX/exit", classification: "bug-class-context-no-current-route-proof" },
  { label: "permit/allowance replay or allowance drift", surface: "ERC20Permit", classification: "bug-class-context-no-current-route-proof" },
  { label: "burn/mint/redeem semantics mismatch", surface: "ERC20Burnable/supply accounting", classification: "bug-class-context-no-current-route-proof" },
];

const SOURCE_FACTS = [
  {
    sourceLabel: "local-prefilter-discovery-json:2026-06-24:1235-1274",
    kind: "local-discovery-json",
    slug: TARGET.slug,
    name: TARGET.name,
    category: TARGET.category,
    poolId: TARGET.poolId,
    chain: TARGET.chain,
    symbol: TARGET.symbol,
    tokenAddress: TARGET.tokenAddress,
    surface: TARGET.surface,
    tvlContext: TARGET.tvlContext,
    apyContext: TARGET.apyContext,
    stablecoin: TARGET.stablecoin,
    ilRisk: TARGET.ilRisk,
    routePositive: 0,
    classification: "structured-target-seed-route-negative",
  },
  {
    sourceLabel: "local-prefilter-discovery-json:duplicate:3566-3583",
    kind: "local-discovery-json",
    poolId: TARGET.poolId,
    symbol: TARGET.symbol,
    tokenAddress: TARGET.tokenAddress,
    classification: "duplicate-target-seed-route-negative",
  },
  {
    sourceLabel: "current-profit-leads:76-95",
    kind: "local-artifact-context",
    finding: "Current-profit lead rows include Meme Dollar/PINA but keep routePositive=0 and executableNow=0.",
    classification: "lead-context-only-no-route-positive",
  },
  {
    sourceLabel: "current-profit-lead-triage:292-311",
    kind: "local-artifact-context",
    finding: "Lead triage context remains route-negative without exact peg/oracle consumer or exit economics.",
    classification: "lead-triage-context-only-no-route-positive",
  },
  {
    sourceLabel: "current-profit-public-leads-triage:48",
    kind: "local-markdown-context",
    finding: "Public lead summary references Meme Dollar context; no positive route was promoted.",
    classification: "summary-context-only-no-route-positive",
  },
  {
    sourceLabel: "prefilter-deep-search-ranks-11-20-assessment:20",
    kind: "local-markdown-context",
    finding: "Prior rank assessment treated meme-dollar as small/below materiality; this scanner refreshes full-test context without route-positive promotion.",
    classification: "prior-materiality-context-not-route-proof",
  },
  {
    sourceLabel: "public-token-verification-context",
    kind: "public-static-label",
    contract: "MemeDollar",
    compiler: "Solidity 0.8.9",
    surfaces: ["ERC20", "ERC20Burnable", "ERC20Permit", "AccessControlEnumerable", "role-controlled mint MINTER_ROLE"],
    classification: "verified-token-surface-no-live-state-proof",
  },
  {
    sourceLabel: "public-docs-algo-stable-context",
    kind: "public-static-label",
    finding: "Category Algo-Stables; docs context mentions bootstrap fixed oracle at $1.5, later Uniswap price, epochs/coupons/upgrade pause; hard collateral/NAV backing remains unproven.",
    classification: "public-doc-context-no-current-route-proof",
  },
  {
    sourceLabel: "public-dex-recon-context",
    kind: "public-static-label",
    finding: "Dexscreener public lookup had no current pairs in prior recon; this scanner performs no live lookup and treats DEX exit as unresolved.",
    classification: "dex-exit-unresolved-fail-closed",
  },
  {
    sourceLabel: "local-stable-peg-consumer-artifacts",
    kind: "local-artifact-context",
    artifacts: [
      "reports/raw/fast/current-profit-leads.json",
      "reports/raw/fast/current-profit-lead-triage.json",
      "reports/raw/fast/public-lead-consumer-joins.json",
      "reports/raw/fast/public-lead-compound-like-routes.json",
      "reports/raw/fast/stablecoin-depeg-lending-routes.json",
      "reports/raw/fast/consumer-first-high-ltv-collateral.json",
      "reports/raw/fast/aave-euler-silo-consumer-graph.json",
      "reports/raw/fast/euler-v2-phase0.json",
      "reports/raw/fast/silo-v2-phase0.json",
      "reports/raw/fast/compound-v3-phase0.json",
      "reports/raw/fast/dex-exit-quotes.json",
      "reports/raw/fast/dex-consumer-routes.json",
    ],
    classification: "local-consumer-exit-context-only-no-meme-dollar-route-positive",
  },
];

const STATIC_CONTEXT_ROWS = [
  { sourceLabel: "discovery-target-row", matched: "Meme Dollar PINA pool and token seed", categories: ["stableReceipt", "underlyingToken", "oraclePegNav", "shareRateAccounting"], sample: `rank=20 pool=${TARGET.poolId} chain=Ethereum symbol=PINA tvl=${TARGET.tvlContext} apy=${TARGET.apyContext} token=${TARGET.tokenAddress}`, classification: "static-target-seed-no-route-positive" },
  { sourceLabel: "public-token-row", matched: "MemeDollar verified token", categories: ["stableReceipt", "underlyingToken", "roleMinterAdmin"], sample: "MemeDollar verified ERC20/Burnable/Permit/AccessControlEnumerable with MINTER_ROLE mint surface", classification: "static-token-surface-no-permissionless-value-proof" },
  { sourceLabel: "peg-oracle-row", matched: "bootstrap fixed oracle / Uniswap price context", categories: ["oraclePegNav", "shareRateAccounting", "economics"], sample: "Public docs context mentions bootstrap fixed oracle at $1.5 then Uniswap price; no current oracle/peg consumer economics proven", classification: "static-oracle-context-no-current-route-proof" },
  { sourceLabel: "redemption-epoch-row", matched: "epochs/coupons/upgrade pause context", categories: ["redemptionCouponEpoch", "transferRestriction", "roleMinterAdmin"], sample: "Epochs, coupons, and upgrade pause are accounting/operational risk context only", classification: "public-docs-state-machine-context-no-live-route-proof" },
  { sourceLabel: "dex-no-pair-row", matched: "Dexscreener no-current-pair context", categories: ["dexLiquidity", "exitLiquidity", "economics"], sample: "Prior public recon had no current pairs; no same-block DEX acquisition or unwind route is proven", classification: "dex-exit-context-no-current-liquidity-proof" },
  { sourceLabel: "route-gap-row", matched: "stable deposit/receipt -> peg/NAV -> consumer/exit", categories: ["consumerJoin", "dexLiquidity", "exitLiquidity", "economics"], sample: "No exact peg/NAV consumer join, DEX exit, redeem/coupon path, or positive route economics was proven from local artifacts", classification: "route-gap-fail-closed" },
].map((row) => ({
  rowSource: "static-public-fact",
  matchType: "static-public-fact",
  termType: "static",
  routePositive: 0,
  sourceRoutePositiveNotPromoted: false,
  ...row,
}));

const EXPLICIT_FILES = [
  "reports/raw/fast/prefilter-deep-new-target-search-2026-06-24.json",
  "reports/raw/fast/current-profit-leads.json",
  "reports/raw/fast/current-profit-lead-triage.json",
  "reports/current-profit-public-leads-triage.md",
  "reports/prefilter-deep-search-ranks-11-20-assessment-2026-06-27.md",
  "reports/raw/defillama-filtered-top.json",
  "reports/raw/defillama-scored-candidates.json",
  "reports/raw/defillama-flashloan-top25.json",
  "reports/raw/fast/public-lead-consumer-joins.json",
  "reports/raw/fast/public-lead-compound-like-routes.json",
  "reports/raw/fast/stablecoin-depeg-lending-routes.json",
  "reports/raw/fast/consumer-first-high-ltv-collateral.json",
  "reports/raw/fast/aave-euler-silo-consumer-graph.json",
  "reports/raw/fast/euler-v2-phase0.json",
  "reports/raw/fast/silo-v2-phase0.json",
  "reports/raw/fast/compound-v3-phase0.json",
  "reports/raw/fast/morpho-pyth-unsafe-consumers.json",
  "reports/raw/fast/morpho-high-apy-liquidation-routes.json",
  "reports/raw/fast/dex-exit-quotes.json",
  "reports/raw/fast/dex-consumer-routes.json",
  "reports/raw/fast/curve-dex-phase0.json",
  "reports/raw/fast/balancer-v3-phase0.json",
  "reports/raw/fast/uniswap-v2-phase0.json",
  "reports/raw/fast/uniswap-v3-phase0.json",
  "reports/raw/fast/oracle-staleness-cross-ref.json",
];

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const ADDRESS_RULES = ADDRESS_SEEDS.map((row) => ({ label: `${row.role} ${row.address}`, regex: new RegExp(escapeRegExp(row.address), "i") }));

const EXACT_RULES = [
  { label: "Meme Dollar", regex: /\bMeme\s+Dollar\b/i },
  { label: "MemeDollar", regex: /\bMemeDollar\b/i },
  { label: "meme-dollar", regex: /\bmeme[-_\s]?dollar\b/i },
  { label: "PINA", regex: /\bPINA\b/i },
  { label: "Meme Dollar pool id", regex: new RegExp(escapeRegExp(TARGET.poolId), "i") },
  { label: "MINTER_ROLE", regex: /\bMINTER_ROLE\b/i },
  { label: "Algo-Stables", regex: /\bAlgo[-\s]?Stables\b/i },
  { label: "bootstrap fixed oracle", regex: /\bbootstrap\s+fixed\s+oracle\b/i },
  { label: "coupon", regex: /\bcoupons?\b/i },
  { label: "epoch", regex: /\bepochs?\b/i },
  ...ADDRESS_RULES,
];

const CONTEXT_RULES = [
  { label: "stable receipt", regex: /\b(?:stable|stablecoin|receipt|deposit|algo[-\s]?stable)\b/i },
  { label: "peg/NAV/oracle", regex: /\b(?:peg|depeg|NAV|oracle|price|fixed\s+oracle|twap|Uniswap\s+price|reference)\b/i },
  { label: "accounting/share-rate", regex: /\b(?:APY|yield|rate|share[-\s]?rate|accounting|supply|mint|burn)\b/i },
  { label: "role/minter/admin", regex: /\b(?:role|admin|owner|minter|MINTER_ROLE|AccessControl|upgrade|governance)\b/i },
  { label: "redemption/coupon/epoch", regex: /\b(?:redeem|redemption|coupon|epoch|contraction|expansion|bond|burn)\b/i },
  { label: "transfer restriction", regex: /\b(?:pause|paused|upgrade|blacklist|whitelist|transfer\s+restriction|frozen|blocked)\b/i },
  { label: "consumer", regex: /\b(?:consumer|collateral|borrow|lending|Morpho|Aave|Euler|Silo|Compound|oracle)\b/i },
  { label: "DEX/exit", regex: /\b(?:DEX|swap|pair|pool|liquidity|Uniswap|Curve|Balancer|Dexscreener|exit|unwind|slippage)\b/i },
  { label: "routePositive", regex: /\broutePositive\b/i },
];

const CATEGORY_RULES = {
  stableReceipt: ["meme dollar", "memedollar", "pina", "stable", "stablecoin", "receipt", "deposit", "algo-stable", "algo stable"],
  underlyingToken: [TARGET.tokenAddress.toLowerCase(), "underlying", "token", "pina", "meme dollar", "memedollar"],
  oraclePegNav: ["peg", "depeg", "nav", "oracle", "price", "fixed oracle", "bootstrap", "$1.5", "1.5", "uniswap price", "twap"],
  shareRateAccounting: ["apy", "yield", "rate", "accounting", "supply", "mint", "burn", "totalSupply", "algo-stables"],
  roleMinterAdmin: ["role", "admin", "owner", "minter", "minter_role", "accesscontrol", "default_admin_role", "upgrade", "governance"],
  redemptionCouponEpoch: ["redeem", "redemption", "coupon", "coupons", "epoch", "epochs", "contraction", "expansion", "bond", "burn"],
  transferRestriction: ["pause", "paused", "upgrade pause", "blacklist", "whitelist", "transfer restriction", "frozen", "blocked"],
  consumerJoin: ["consumer", "collateral", "borrow", "lending", "reserve", "accepted", "morpho", "aave", "euler", "silo", "compound"],
  dexLiquidity: ["dex", "swap", "pair", "pool", "liquidity", "curve", "balancer", "uniswap", "dexscreener", "slippage"],
  exitLiquidity: ["exit", "unwind", "redeem", "redemption", "swap", "liquidity", "pair", "pool"],
  economics: ["routepositive", "executable", "profit", "netbps", "positive", "liquidityusd", "tvl", "apy", "exacteconomics", "forkproof"],
};

const BLOCKERS = [
  "No exact-positive Meme Dollar/PINA stable receipt -> peg/NAV assumption -> lending or DEX exit route is proven in local artifacts; token rows are static seeds only.",
  "The PINA token is public verified context, but verified ERC20/Burnable/Permit/AccessControl surfaces do not prove live collateral backing, redeemability, or accepted-value semantics.",
  "Role-controlled MINTER_ROLE minting and admin/upgrade controls remain proof gaps; no permissionless unbacked mint or role bypass is proven.",
  "Bootstrap fixed oracle at $1.5 and later Uniswap price are public-doc context only; no current oracle/feed consumer, freshness, scale, or accepted-value divergence is proven.",
  "Hard collateral/NAV backing is unproven; peg or Algo-Stables labels cannot support route-positive impact without current backing, supply, and consumer state.",
  "Epoch/coupon/redemption semantics are not joined to a same-block permissionless redeem/borrow/unwind path with exact positive economics.",
  "Prior Dexscreener no-pair context and local DEX artifacts do not provide exact PINA acquisition or unwind liquidity at route size.",
  "Local lending/consumer artifacts do not show a Meme Dollar/PINA-specific material collateral/oracle consumer with caps, cash/borrow capacity, and borrower-side value delta.",
  "Prior current-profit/public lead rows remain routeNegative/executableNow=0 context and are not promoted without current exact economics.",
  "No endpoint inventory was read and no live eth_call/fork refresh was performed in this bounded pass, so route gate stays fail-closed.",
  "Fork and signed-action gates remain closed because routePositive=0 and exactEconomicsRows=0.",
];

const REQUIRED_FOR_ROUTE_POSITIVE = [
  "Exact producer asset: identify the deployed PINA/MemeDollar token, supply, decimals, minter/admin state, and any deposit/receipt or redeem/coupon contract used for value.",
  "Exact peg/oracle proof: resolve the current oracle/peg/NAV source, bootstrap-to-Uniswap transition, decimals, freshness, manipulation bounds, and whether a trusted consumer uses that value.",
  "Exact consumer/exit join: prove PINA is accepted by a material lending/oracle/settlement consumer or has immediate permissionless DEX/redeem/coupon exit liquidity at route size.",
  "Backing/redeemability proof: quantify hard collateral, reserves, coupon/epoch liabilities, mint/burn state, and public redeemability without admin/upgrade/pause blockers.",
  "Transferability proof: no pause, transfer restriction, blacklist, upgrade, epoch, or role gate blocks acquisition, collateralization, liquidation, redemption, or exit.",
  "Positive economics: accepted value must exceed exact acquisition, redeem/coupon, borrow/liquidation, or DEX unwind value after fees, slippage, gas, caps, locks, epochs, and LTV/LLTV haircuts.",
  "Local static/fork value-delta proof must show positive attacker-controlled balance movement before routePositive, forkJustified, or signedActionJustified can change.",
  "Explicit route-specific authorization and independent defensive review are required before any signed transaction path is discussed.",
];

const NEXT_READ_ONLY_STEP = "Keep Meme Dollar dormant unless PINA maps to a material consumer or permissionless DEX/redeem/coupon exit; then refresh sanitized read-only state for token supply, MINTER_ROLE/admin controls, peg/oracle/NAV source, backing/redeemability, consumer caps/cash/oracles, DEX pairs, and exact exit economics before any fork/static proof.";

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

function sanitizeText(value, max = 360) {
  let text = String(value ?? "")
    .replace(/[\r\n|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

function mdEscape(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
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
  if (/(^|[\/\\])(?:private|secret|secrets|mnemonic|seed|wallet|keypair|keystore|api[-_]?key|access[-_]?key)(?:[\/\\._-]|$)/i.test(r)) return true;
  return false;
}

function isExcludedScanPath(filePath) {
  const r = rel(filePath).toLowerCase();
  const base = path.basename(filePath).toLowerCase();
  if (r === OUT_JSON_REL.toLowerCase() || r === OUT_MD_REL.toLowerCase()) return true;
  if (r === "tools/scan-meme-dollar-full-test.js") return true;
  if (isSecretLikePath(filePath)) return true;
  if (base.includes("endpoint")) return true;
  if (r.includes("/node_modules/") || r.includes("/.git/")) return true;
  if (r.includes("/cache/") || r.includes("/out/") || r.includes("/broadcast/") || r.includes("/artifacts/")) return true;
  if (r.startsWith(".opencode/") || r.startsWith("coordination/")) return true;
  if (/(?:handoff|shared_context|state\.md|audit-completion-gates|route-positive-sweep|low-fund-executable-route-filter|exploit-findings-summary|full-test)/i.test(r)) return true;
  return false;
}

function isUnsafeSampleText(text) {
  const raw = String(text || "");
  return /\b(?:rpc_endpoints\.txt|graphql_endpoints\.txt|private[-_]?key|secret[-_]?key|mnemonic|seed\s+phrase|bearer\s+|authorization\s*[:=]|password\s*[:=]|pwd\s*[:=])\b/i.test(raw);
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

function writeJson(filePath, value) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(value, jsonReplacer, 2)}\n`, "utf8");
}

function writeText(filePath, value) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, value, "utf8");
}

function listFilesRecursive(rootDir, filterFn = null) {
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
      if (filterFn && !filterFn(full)) continue;
      out.push(full);
    }
  }
  walk(rootDir);
  return out;
}

function listRelatedReportFiles() {
  const fast = path.join(WORKSPACE, "reports", "raw", "fast");
  return listFilesRecursive(fast, (file) => /(?:meme|pina|stable|depeg|oracle|peg|coupon|current-profit|public-lead|consumer|aave|euler|silo|compound|morpho-|dex|exit|curve|balancer|uniswap)/i.test(path.basename(file)));
}

function listScanFiles() {
  const files = [];
  for (const file of EXPLICIT_FILES) {
    const full = path.join(WORKSPACE, file);
    if (fs.existsSync(full) && !isExcludedScanPath(full)) files.push(full);
  }
  files.push(...listRelatedReportFiles());
  return uniqBy(files, (file) => path.resolve(file));
}

function firstRuleMatch(text, rules) {
  const raw = String(text || "");
  for (const rule of rules) {
    rule.regex.lastIndex = 0;
    if (rule.regex.test(raw)) return rule;
  }
  return null;
}

function hasRuleMatch(text, rules) {
  return Boolean(firstRuleMatch(text, rules));
}

function matchForText(line, windowText) {
  const exact = firstRuleMatch(line, EXACT_RULES) || firstRuleMatch(windowText, EXACT_RULES);
  if (exact) return { matchType: "exact-name-address-token-module", matched: exact.label, termType: "text" };
  const context = firstRuleMatch(line, CONTEXT_RULES) || firstRuleMatch(windowText, CONTEXT_RULES);
  if (!context) return null;
  if (hasRuleMatch(windowText, EXACT_RULES)) return { matchType: "context", matched: context.label, termType: "text" };
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
  if (r.includes("prefilter-deep-new-target-search")) return "discovery-context-only-no-route-positive";
  if (r.includes("current-profit-lead")) return "current-profit-lead-context-only-no-exact-route";
  if (r.includes("current-profit-public-leads")) return "public-lead-summary-context-only-no-current-route-proof";
  if (r.includes("prefilter-deep-search-ranks-11-20")) return "prior-assessment-context-only-no-current-route-proof";
  if (r.includes("stablecoin") || r.includes("depeg") || r.includes("oracle")) return "stable-peg-oracle-context-only-no-meme-dollar-exact-route";
  if (r.includes("morpho") || r.includes("aave") || r.includes("euler") || r.includes("silo") || r.includes("compound")) return "consumer-artifact-context-only-no-meme-dollar-exact-route";
  if (r.includes("curve") || r.includes("balancer") || r.includes("uniswap") || r.includes("dex") || r.includes("exit")) return "dex-exit-context-only-no-meme-dollar-exact-economics";
  if (categories.includes("consumerJoin") || categories.includes("dexLiquidity") || categories.includes("exitLiquidity") || categories.includes("oraclePegNav")) return "consumer-or-exit-context-only-no-positive-economics";
  return match.matchType === "exact-name-address-token-module" ? "exact-local-watch-context-only-no-current-positive-economics" : "local-artifact-watch-context-only-no-route-positive";
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
      const match = matchForText(line, windowText, fileHasExact);
      if (!match) continue;
      const key = `${rel(file)}:${i + 1}:${match.matchType}:${match.matched}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fileMatched = true;
      if (match.matchType === "exact-name-address-token-module") fileExact = true;
      const categories = categoriesFor(windowText, rel(file));
      for (const category of categories) categoryCounts[category] = (categoryCounts[category] || 0) + 1;
      const routeValue = /\broutePositive\b[^\n,}]*\b(?:true|1)\b/i.test(windowText);
      rows.push({
        rowSource: "line-scan",
        file: rel(file),
        line: i + 1,
        matchType: match.matchType,
        termType: match.termType,
        matched: sanitizeText(match.matched, 120),
        count: countOccurrences(line, match.matched),
        categories,
        sample: sanitizeText(windowText, 460),
        routePositive: 0,
        sourceRoutePositiveNotPromoted: Boolean(routeValue),
        classification: classificationForRow(file, match, categories, routeValue),
      });
      sampled += 1;
    }
    if (fileMatched) filesWithMatch += 1;
    if (fileExact) filesWithExact += 1;
    if (rows.length >= MAX_LOCAL_MATCH_ROWS) break;
  }
  return { filesScanned, filesWithMatch, filesWithExact, rows, exactRows: rows.filter((row) => row.matchType === "exact-name-address-token-module"), categoryCounts };
}

function exactish(row) {
  return row.matchType === "exact-name-address-token-module";
}

function discoveryContextOnly(row) {
  return row.classification === "discovery-context-only-no-route-positive";
}

function selectNotableRows(rows) {
  const priority = [];
  const files = new Set();
  for (const row of rows) {
    const key = row.file || row.sourceLabel || row.matched;
    const cats = row.categories || [];
    if (row.rowSource === "static-public-fact" || exactish(row) || cats.some((cat) => ["stableReceipt", "underlyingToken", "oraclePegNav", "shareRateAccounting", "roleMinterAdmin", "redemptionCouponEpoch", "transferRestriction", "consumerJoin", "dexLiquidity", "exitLiquidity"].includes(cat))) {
      if (!files.has(key) || exactish(row) || row.rowSource === "static-public-fact") {
        priority.push(row);
        files.add(key);
      }
    }
    if (priority.length >= 42) break;
  }
  return priority.length ? priority : rows.slice(0, 22);
}

function sourceForRow(row) {
  if (row.file) return `${row.file}${row.line ? `:${row.line}` : ""}`;
  return row.sourceLabel || row.rowSource || "static";
}

function buildPayload({ lineScan }) {
  const localRows = lineScan.rows;
  const combinedRows = [...STATIC_CONTEXT_ROWS, ...localRows];
  const exactRows = lineScan.exactRows;
  const categoryRows = {};
  for (const category of Object.keys(CATEGORY_RULES)) categoryRows[`${category}Rows`] = pickRows(combinedRows, (row) => row.categories.includes(category), 170);
  const discoveryContextRows = localRows.filter(discoveryContextOnly).length;
  const consumerJoinRows = pickRows(
    combinedRows,
    (row) => !discoveryContextOnly(row) && row.categories.includes("consumerJoin"),
    190,
  );
  const exactConsumerJoinRows = pickRows(
    consumerJoinRows,
    (row) => exactish(row) && /(?:morpho|aave|euler|silo|compound|stablecoin-depeg-lending|consumer-first-high-ltv)/i.test(row.file || "") && /\b(?:collateral|borrow|lending|accepted|morpho|aave|euler|silo|compound)\b/i.test(`${row.sample || ""}`),
    150,
  );
  const notableRows = selectNotableRows(combinedRows);
  const priorArtifactPositiveRowsNotPromoted = localRows.filter((row) => row.sourceRoutePositiveNotPromoted).length;
  const exactEconomicsRows = 0;
  const producerAnomalies = 0;
  const watchCandidates = 0;
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
    publicDocRows: PUBLIC_DOCS.length,
    bugClassRows: BUG_CLASS_ROWS.length,
    staticContextRows: STATIC_CONTEXT_ROWS.length,
    filesScanned: lineScan.filesScanned,
    filesWithLocalMatches: lineScan.filesWithMatch,
    filesWithExactLocalMatches: lineScan.filesWithExact,
    localArtifactMatchRows: localRows.length,
    exactLocalArtifactMatchRows: exactRows.length,
    localLineRows: lineScan.rows.length,
    discoveryContextRows,
    stableReceiptRows: categoryRows.stableReceiptRows.length,
    underlyingTokenRows: categoryRows.underlyingTokenRows.length,
    oraclePegNavRows: categoryRows.oraclePegNavRows.length,
    shareRateAccountingRows: categoryRows.shareRateAccountingRows.length,
    roleMinterAdminRows: categoryRows.roleMinterAdminRows.length,
    redemptionCouponEpochRows: categoryRows.redemptionCouponEpochRows.length,
    transferRestrictionRows: categoryRows.transferRestrictionRows.length,
    consumerJoinRows: consumerJoinRows.length,
    exactConsumerJoinRows: exactConsumerJoinRows.length,
    dexLiquidityRows: categoryRows.dexLiquidityRows.length,
    exitLiquidityRows: categoryRows.exitLiquidityRows.length,
    economicsContextRows: categoryRows.economicsRows.length,
    producerAnomalies,
    watchCandidates,
    priorArtifactPositiveRowsNotPromoted,
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
    scanner: "tools/scan-meme-dollar-full-test.js",
    target: TARGET,
    scope: {
      kind: "bounded defensive/read-only full-test scanner",
      artifactStaticLocalFirst: true,
      publicFactsOnly: true,
      evmFirst: true,
      evmFirstChains: CHAIN_SEEDS.map((row) => row.chainLabel),
      caveatChains: [],
      routeGraph: TARGET.routeGraph,
      writesLimitedTo: [OUT_JSON_REL, OUT_MD_REL],
      coordinatorClaim: "coordinator-meme-dollar-fulltest-01",
      aggregatePromotionStateHandoffEdited: false,
      endpointPolicy: "No endpoint inventory was read; no raw endpoints, domains, keys, or tokens are persisted.",
    },
    safety: {
      localArtifactsRead: true,
      publicSourcesRead: true,
      publicStaticLabelsUsed: true,
      publicNetworkFetch: false,
      endpointInventoryRead: false,
      rpcInventoryRead: false,
      rpcInventoryRows: 0,
      graphqlInventoryRead: false,
      graphqlInventoryRows: 0,
      envFilesRead: false,
      privateKeyEnvRead: false,
      privateKeysRead: false,
      keyFilesRead: false,
      keyMaterialRead: false,
      pemFilesRead: false,
      keypairJsonRead: false,
      rawEndpointUrlsStored: false,
      rpcUrlsStored: false,
      graphqlUrlsStored: false,
      rawUrlsStored: false,
      rawDomainsStored: false,
      rawKeysTokensStored: false,
      signedActions: false,
      liveTransactions: false,
      broadcasts: false,
      walletOperations: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      ethCallOnly: false,
      sanitizedOutputOnly: true,
      secretLikePathsExcluded: true,
    },
    sourceFacts: SOURCE_FACTS,
    publicDocs: PUBLIC_DOCS,
    bugClasses: BUG_CLASS_ROWS,
    discoveredSeeds: { chainSeeds: CHAIN_SEEDS, addressSeedRows: ADDRESS_SEEDS, surfaceRows: SURFACE_ROWS },
    staticContextRows: STATIC_CONTEXT_ROWS,
    localArtifacts: {
      filesScanned: lineScan.filesScanned,
      filesWithMatch: lineScan.filesWithMatch,
      filesWithExact: lineScan.filesWithExact,
      categoryCounts: lineScan.categoryCounts,
      rows: localRows,
      exactRows: exactRows.slice(0, 190),
      notableRows,
    },
    categoryRows: { ...categoryRows, consumerJoinRows, exactConsumerJoinRows },
    rows: notableRows.slice(0, 14),
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
      reason: "Static/local scan found Meme Dollar/PINA discovery, public token, peg/oracle, role/minter/admin, coupon/epoch, DEX/exit, and consumer context rows only; no current exact permissionless value movement, positive economics, or local/fork/static value-delta proof is present.",
    },
    blockers: BLOCKERS,
    requiredForRoutePositive: REQUIRED_FOR_ROUTE_POSITIVE,
    nextReadOnlyStep: NEXT_READ_ONLY_STEP,
    summary,
  };
}

function metricRows(summary) {
  const keys = [
    "sourceFactRows", "chainSeedRows", "addressSeedRows", "surfaceRows", "publicDocRows", "bugClassRows", "staticContextRows", "filesScanned", "filesWithLocalMatches", "filesWithExactLocalMatches", "localArtifactMatchRows", "exactLocalArtifactMatchRows", "stableReceiptRows", "underlyingTokenRows", "oraclePegNavRows", "shareRateAccountingRows", "roleMinterAdminRows", "redemptionCouponEpochRows", "transferRestrictionRows", "consumerJoinRows", "exactConsumerJoinRows", "dexLiquidityRows", "exitLiquidityRows", "economicsContextRows", "producerAnomalies", "watchCandidates", "priorArtifactPositiveRowsNotPromoted", "publicFetchRows", "rpcInventoryRows", "graphqlInventoryRows", "ethCallRows", "forkRows", "exactEconomicsRows", "routePositive", "executableNow", "signedActionJustified", "forkJustified", "forkGate", "fullTestReadOnlyComplete",
  ];
  return keys.map((key) => `| ${key} | ${mdEscape(summary[key])} |`).join("\n");
}

function safetyRows(safety) {
  const keys = [
    "localArtifactsRead", "publicSourcesRead", "publicNetworkFetch", "endpointInventoryRead", "rpcInventoryRead", "graphqlInventoryRead", "envFilesRead", "privateKeysRead", "keyMaterialRead", "rawEndpointUrlsStored", "rpcUrlsStored", "graphqlUrlsStored", "rawUrlsStored", "rawDomainsStored", "rawKeysTokensStored", "signedActions", "liveTransactions", "broadcasts", "walletOperations", "forkTransactions", "sanitizedOutputOnly", "secretLikePathsExcluded",
  ];
  return keys.map((key) => `| ${key} | ${mdEscape(safety[key])} |`).join("\n");
}

function formatLocalRow(row) {
  const categories = (row.categories || []).join(",");
  const detail = row.sample || "context-only";
  return `| ${mdEscape(sourceForRow(row))} | ${mdEscape(categories)} | ${mdEscape(row.matched)} | ${mdEscape(detail)} | ${mdEscape(row.routePositive)} | ${mdEscape(row.classification)} |`;
}

function formatAddressRow(row) {
  return `| ${mdEscape(row.role)} | ${mdEscape(row.chain)} | ${mdEscape(row.address)} | ${mdEscape(row.surface)} | ${mdEscape(row.classification)} |`;
}

function formatSurfaceRow(row) {
  return `| ${mdEscape(row.component)} | ${mdEscape(row.surface)} | ${mdEscape(row.routeRole)} | ${mdEscape((row.watchTerms || []).join(", "))} |`;
}

function formatBugClassRow(row) {
  return `| ${mdEscape(row.label)} | ${mdEscape(row.surface)} | ${mdEscape(row.classification)} |`;
}

function buildMarkdown(payload) {
  const notableRows = payload.localArtifacts.notableRows.length
    ? payload.localArtifacts.notableRows.map(formatLocalRow).join("\n")
    : "| (none) | n/a | n/a | no local context rows found | 0 | dormant |";
  const addressRows = payload.discoveredSeeds.addressSeedRows.map(formatAddressRow).join("\n");
  const surfaceRows = payload.discoveredSeeds.surfaceRows.map(formatSurfaceRow).join("\n");
  const bugClassRows = payload.bugClasses.map(formatBugClassRow).join("\n");
  const docRows = payload.publicDocs.map((url) => `- ${url}`).join("\n");

  return `# 🟢 DORMANT - Meme Dollar Full Test

Generated: ${payload.generatedAt}

Route remains closed: routePositive=${payload.routeGate.routePositive}, executableNow=${payload.routeGate.executableNow}, signedActionJustified=${payload.routeGate.signedActionJustified}, forkJustified=${payload.routeGate.forkJustified}, forkGate=${payload.routeGate.forkGate}.

## Summary

| Metric | Value |
|---|---:|
${metricRows(payload.summary)}

## Target / Scope

- Target: ${payload.target.name} (${payload.target.slug}), kind=${payload.target.kind}, category=${payload.target.category}, surface=${payload.target.surface}, pool=${payload.target.poolId}, TVL context≈${payload.target.tvlContext}, APY context≈${payload.target.apyContext}.
- EVM chains: ${payload.scope.evmFirstChains.join(", ")}; caveat chains: none from discovery row.
- Token/symbol: ${payload.target.symbol} / ${payload.target.tokenName}; token seed: ${payload.target.tokenAddress}; stablecoin=${payload.target.stablecoin}; ilRisk=${payload.target.ilRisk}.
- Route graph: ${payload.target.routeGraph}.
- Writes limited to: ${payload.scope.writesLimitedTo.join(", ")}.

## Safety

| Field | Value |
|---|---:|
${safetyRows(payload.safety)}

## Public Static Docs / Deployment Facts (allowed context; not fetched here)

${docRows}

## Address Rows (static, not live state proof)

| Role | Chain | Address | Surface | Classification |
|---|---|---|---|---|
${addressRows}

## Surface Rows

| Component | Surface | Route Role | Watch Terms |
|---|---|---|---|
${surfaceRows}

## Bug Classes / Proof Gaps (context only)

| Class | Surface | Classification |
|---|---|---|
${bugClassRows}

## Notable Local / Static Rows (watch/context only)

| Source | Categories | Match | Detail | Route | Classification |
|---|---|---|---|---:|---|
${notableRows}

## Route Gate

- Status: ${payload.routeGate.status}.
- Required fail-closed conjunction is absent: exactPermissionlessValueMovement=${payload.routeGate.exactPermissionlessValueMovement}, exactPositiveEconomics=${payload.routeGate.exactPositiveEconomics}, localForkStaticProof=${payload.routeGate.localForkStaticProof}.
- No exact Meme Dollar/PINA peg-oracle, backing, consumer acceptance, coupon/redeem path, or DEX exit route was resolved with positive economics.
- Local current-profit, stable-depeg, lending, DEX, and oracle rows are not promoted without a Meme Dollar-specific exact consumer/exit join and current economics.
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
  log("Scanning Meme Dollar local artifacts (sanitized, no endpoint inventory read)...");
  const files = listScanFiles();
  const lineScan = scanLocalArtifactLines(files);
  const payload = buildPayload({ lineScan });
  writeJson(OUT_JSON, payload);
  writeText(OUT_MD, buildMarkdown(payload));
  log(`Wrote ${OUT_JSON_REL} and ${OUT_MD_REL}`);
  log(`routePositive=${payload.summary.routePositive}; exactEconomicsRows=${payload.summary.exactEconomicsRows}; localArtifactMatchRows=${payload.summary.localArtifactMatchRows}; exactConsumerJoinRows=${payload.summary.exactConsumerJoinRows}`);
}

main();
