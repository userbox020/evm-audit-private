#!/usr/bin/env node
"use strict";

// scan-coinbase-wrapped-staked-eth-full-test.js
// Defensive cbETH full-test scanner. Deterministic local/static/public-context
// only; no endpoint inventory reads, network calls, RPC, forks, signed actions,
// broadcasts, or wallets.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_DIR = path.join(WORKSPACE, "reports", "raw", "fast");
const REPORTS_DIR = path.join(WORKSPACE, "reports");
const OUT_JSON = path.join(RAW_DIR, "coinbase-wrapped-staked-eth-full-test.json");
const OUT_MD = path.join(REPORTS_DIR, "coinbase-wrapped-staked-eth-full-test-triage.md");
const OUT_JSON_REL = "reports/raw/fast/coinbase-wrapped-staked-eth-full-test.json";
const OUT_MD_REL = "reports/coinbase-wrapped-staked-eth-full-test-triage.md";
const PREFILTER_JSON_REL = "reports/raw/fast/prefilter-coinbase-wrapped-staked-eth-route-prefilter.json";
const PREFILTER_MD_REL = "reports/prefilter-coinbase-wrapped-staked-eth-route-prefilter.md";

const QUIET = process.argv.includes("--quiet");
const GENERATED_AT = process.env.SCAN_GENERATED_AT || "2026-07-07T00:00:00.000Z";

const MAX_FILE_BYTES = 24 * 1024 * 1024;
const MAX_LOCAL_MATCH_ROWS = 900;
const MAX_ROWS_PER_FILE = 44;

const TARGET = {
  slug: "coinbase-wrapped-staked-eth",
  name: "Coinbase Wrapped Staked ETH",
  symbol: "cbETH",
  kind: "protocol-token",
  category: "Liquid Staking",
  surface: "vault-yield-allocator",
  tvlContextUsd: 259_298_000,
  tvlContext: "$259.298M",
  primaryChains: ["Ethereum"],
  bridgeContextChains: ["Base"],
  routeGraph: "vault share -> rate/strategy accounting -> consumer or exit venue -> borrow/redeem/unwind",
  module: "cbETH/index.js",
  adapterFetched: true,
  adapterAddressCount: 0,
  coordinatorClaim: "coordinator-cbeth-fulltest-01",
};

const CHAIN_SEEDS = [
  { chain: "Ethereum", chainLabel: "Ethereum", chainId: 1, adapterKey: "ethereum", evmFirst: true, caveat: false, classification: "primary-evm-token-chain" },
  { chain: "Base", chainLabel: "Base", chainId: 8453, adapterKey: "base", evmFirst: true, caveat: false, classification: "bridge-liquidity-context-chain" },
];

const TOKEN_ROWS = [
  {
    role: "cbETH token/proxy",
    chain: "Ethereum",
    chainId: 1,
    symbol: "cbETH",
    address: "0xBe9895146f7AF43049ca1c1AE358B0541Ea49704",
    surface: "ERC20-compatible non-rebasing liquid-staking receipt; exchangeRate()-accruing producer asset",
    classification: "public-static-token-address-not-live-state-proof",
  },
  {
    role: "bridged/liquidity cbETH context",
    chain: "Base",
    chainId: 8453,
    symbol: "cbETH",
    address: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22",
    surface: "Base bridge/liquidity context; local consumer and DEX mentions are context-only",
    classification: "public-static-bridged-token-address-not-custody-proof",
  },
];

const PRODUCER_EXCHANGE_RATE_ROWS = [
  { component: "exchangeRate()", surface: "1e18-scaled cbETH/ETH accounting rate", routeRole: "producer accepted-value input", watchTerms: ["exchangeRate", "scaled 1e18", "non-rebasing"], classification: "public-docs-context-no-current-rate-proof" },
  { component: "updateExchangeRate(uint256)", surface: "off-chain/oracle rate update path", routeRole: "current-rate and stale/incorrect update proof gap", watchTerms: ["updateExchangeRate", "ExchangeRateUpdater", "oracle"], classification: "public-docs-context-no-permissionless-rate-anomaly" },
  { component: "ExchangeRateUpdater", surface: "rate-limit caller deltas", routeRole: "oracle/rate governance and delta guard", watchTerms: ["ExchangeRateUpdater", "rate limit", "delta"], classification: "public-docs-context-no-bypass-proof" },
];

const ORACLE_PRICE_FEED_ROWS = [
  { component: "consumer price feeds", surface: "Aave/Compound/Euler/Morpho/Moonwell cbETH oracle context", routeRole: "accepted-value proof gap", watchTerms: ["oracle", "feed", "cbETH/ETH", "price"], classification: "local-consumer-oracle-context-no-current-accepted-value-proof" },
  { component: "off-chain rate updater", surface: "oracle-controlled exchange-rate update", routeRole: "producer exchange-rate currentness", watchTerms: ["oracle", "updateOracle", "updateExchangeRate"], classification: "admin-oracle-context-no-permissionless-proof" },
];

const ADMIN_PROXY_ROLE_ROWS = [
  { component: "proxy/admin", surface: "admin, implementation, upgradeTo, upgradeToAndCall, changeAdmin", routeRole: "upgrade/admin trust blocker", watchTerms: ["admin", "implementation", "upgradeTo", "changeAdmin"], classification: "proxy-admin-context-no-permissionless-proof" },
  { component: "roles", surface: "owner, pauser, blacklister, masterMinter, oracle", routeRole: "role-gated action blocker", watchTerms: ["owner", "pauser", "blacklister", "masterMinter", "oracle"], classification: "role-context-no-bypass-proof" },
  { component: "minter controls", surface: "MintForwarder, configureMinter, removeMinter, isMinter", routeRole: "mint/supply accounting proof gap", watchTerms: ["MintForwarder", "configureMinter", "removeMinter", "isMinter"], classification: "minter-context-no-public-mint-proof" },
];

const PATH_ROWS = [
  { component: "mint/wrap", surface: "minting via MintForwarder and minter roles", routeRole: "acquisition/mint path proof gap", watchTerms: ["mint", "MintForwarder", "configureMinter"], classification: "mint-path-role-gated-context" },
  { component: "burn/redeem/withdraw", surface: "burn or redeem/unwind semantics; no exact same-block redeem path proven", routeRole: "exit route proof gap", watchTerms: ["burn", "redeem", "withdraw", "unwind"], classification: "redeem-path-context-no-current-proof" },
  { component: "pause/blacklist", surface: "pause, unpause, blacklist, unBlacklist", routeRole: "transfer/action availability blocker", watchTerms: ["pause", "unpause", "blacklist", "unBlacklist"], classification: "pause-blacklist-context-no-route-proof" },
];

const SURFACE_ROWS = [
  { component: "cbETH producer token", surface: "ERC20-compatible non-rebasing share token", routeRole: "producer asset", watchTerms: ["cbETH", TOKEN_ROWS[0].address] },
  { component: "exchange-rate accounting", surface: "exchangeRate() and updateExchangeRate(uint256)", routeRole: "share-rate / accepted-value proof", watchTerms: ["exchangeRate", "updateExchangeRate", "ExchangeRateUpdater"] },
  { component: "oracle/consumer pricing", surface: "consumer oracle and accepted collateral value", routeRole: "borrow/liquidation accepted value", watchTerms: ["oracle", "price", "feed", "accepted value"] },
  { component: "proxy/admin/roles", surface: "proxy upgrade and owner/pauser/blacklister/masterMinter/oracle roles", routeRole: "role/admin blocker", watchTerms: ["admin", "implementation", "upgradeTo", "owner", "pauser", "blacklister", "masterMinter", "oracle"] },
  { component: "mint/burn/redeem", surface: "MintForwarder, mint, burn, redeem, withdraw", routeRole: "acquire/redeem/exit path", watchTerms: ["MintForwarder", "mint", "burn", "redeem", "withdraw"] },
  { component: "blacklist/pause", surface: "blacklist and pause controls", routeRole: "availability/transfer blocker", watchTerms: ["pause", "blacklist", "unBlacklist"] },
  { component: "Base bridge context", surface: "L1 cbETH to Base cbETH bridge/liquidity mapping", routeRole: "remote custody/supply proof gap", watchTerms: ["Base", TOKEN_ROWS[1].address, "bridge", "custody"] },
  { component: "consumer joins", surface: "Aave, Compound V3, Euler, Morpho, Moonwell contexts", routeRole: "borrow/liquidation consumer", watchTerms: ["Aave", "Compound", "Euler", "Morpho", "Moonwell", "collateral", "borrow"] },
  { component: "DEX/exit", surface: "Uniswap, Curve, Base DEX/exit rows", routeRole: "unwind/exit economics", watchTerms: ["Uniswap", "Curve", "DEX", "pool", "liquidity", "slippage"] },
];

const PUBLIC_CONTEXT_ROWS = [
  "Public docs context: cbETH-style staked token is ERC20-compatible, proxy-based, non-rebasing, and value accrues through exchangeRate() scaled 1e18.",
  "Public docs context: exchange-rate updates use updateExchangeRate(uint256), an oracle/updater path, and ExchangeRateUpdater-style delta limits.",
  "Public docs context: minting is role-gated via MintForwarder/masterMinter-style controls; roles include owner, pauser, blacklister, masterMinter, and oracle.",
  "Public docs context: proxy/admin functions such as admin, implementation, upgradeTo, upgradeToAndCall, and changeAdmin are trust/upgrade proof gaps, not permissionless routes.",
  "Local recon context: Aave Ethereum cbETH, Compound V3 Base cbETH, Euler Base ecbETH, Morpho Base cbETH, Moonwell remediation/oracle, Base bridge, and Uniswap/Curve/Base DEX rows are context-only.",
];

const BUG_CLASS_ROWS = [
  { label: "exchangeRate currentness or stale accepted value", surface: "exchangeRate/updateExchangeRate", classification: "bug-class-context-no-current-route-proof" },
  { label: "consumer prices cbETH above realizable redeem/DEX value", surface: "lending/oracle consumer", classification: "bug-class-context-no-exact-economics" },
  { label: "oracle/updater delta-limit bypass or stale update", surface: "ExchangeRateUpdater/oracle", classification: "bug-class-context-no-permissionless-proof" },
  { label: "proxy/admin upgrade or implementation mismatch", surface: "proxy admin", classification: "bug-class-context-role-admin-blocked" },
  { label: "MintForwarder/minter role misconfiguration", surface: "mint/supply", classification: "bug-class-context-no-public-mint-proof" },
  { label: "pause/blacklist transfer or redemption blocker", surface: "pause/blacklist", classification: "bug-class-context-no-route-proof" },
  { label: "bridge supply/custody mismatch on Base", surface: "bridge/custody", classification: "bug-class-context-no-bridge-delta-proof" },
  { label: "DEX/redeem exit unavailable or value-negative", surface: "DEX/exit liquidity", classification: "bug-class-context-no-exact-exit-economics" },
];

const SOURCE_FACTS = [
  {
    sourceLabel: "target-context:Coinbase Wrapped Staked ETH",
    kind: "target-seed",
    slug: TARGET.slug,
    name: TARGET.name,
    symbol: TARGET.symbol,
    category: TARGET.category,
    surface: TARGET.surface,
    tvlContext: TARGET.tvlContext,
    chains: [...TARGET.primaryChains, ...TARGET.bridgeContextChains],
    module: TARGET.module,
    adapterFetched: TARGET.adapterFetched,
    adapterAddressCount: TARGET.adapterAddressCount,
    routePositive: 0,
    classification: "structured-target-seed-route-negative",
  },
  {
    sourceLabel: "prior-prefilter-artifact:coinbase-wrapped-staked-eth-route-prefilter",
    kind: "local-prefilter-context",
    artifacts: [PREFILTER_JSON_REL, PREFILTER_MD_REL],
    priorStatus: "dormant-route-negative",
    priorProducerConsumerStateDirectlyProbed: false,
    priorRoutePositive: 0,
    classification: "prior-prefilter-context-no-route-positive",
  },
  {
    sourceLabel: "public-docs-cbeth-style-model",
    kind: "public-static-label",
    model: "ERC20-compatible proxy-based non-rebasing token with 1e18-scaled exchangeRate(), oracle/updater role, MintForwarder, pause/blacklist, and proxy/admin controls.",
    classification: "public-docs-context-no-current-route-proof",
  },
  {
    sourceLabel: "local-consumer-and-exit-context",
    kind: "local-artifact-context",
    artifacts: [
      "reports/raw/fast/aave-v3-emode-escalation.json",
      "reports/raw/fast/compound-v3-phase0.json",
      "reports/raw/fast/euler-v2-phase0.json",
      "reports/raw/fast/morpho-high-apy-liquidation-routes.json",
      "reports/raw/fast/moonwell-lending-phase0.json",
      "reports/raw/fast/base-bridge-phase0.json",
      "reports/raw/fast/dex-exit-quotes.json",
      "reports/raw/fast/dex-consumer-routes.json",
    ],
    classification: "local-consumer-exit-context-only-no-cbeth-route-positive",
  },
];

const STATIC_CONTEXT_ROWS = [
  { sourceLabel: "cbeth-token-row", matched: "Ethereum and Base cbETH token rows", categories: ["token", "producerAccounting", "bridgeBaseCustody"], sample: "Ethereum cbETH and Base bridged/liquidity cbETH public static addresses; not live code/state/custody proof", classification: "static-token-context-no-route-positive" },
  { sourceLabel: "exchange-rate-row", matched: "exchangeRate/updateExchangeRate", categories: ["producerAccounting", "exchangeRate", "oraclePriceFeed", "economics"], sample: "exchangeRate() 1e18-scaled non-rebasing accrual; updateExchangeRate(uint256) requires current updater/oracle state before accepted-value claims", classification: "rate-context-no-current-value-proof" },
  { sourceLabel: "roles-proxy-row", matched: "proxy/admin/role controls", categories: ["adminProxyRole", "pauseBlacklist", "mintWrapBurnRedeem"], sample: "Owner/pauser/blacklister/masterMinter/oracle and proxy admin/implementation/upgrade controls are blockers until proven irrelevant", classification: "role-admin-context-no-bypass-proof" },
  { sourceLabel: "consumer-context-row", matched: "Aave/Compound/Euler/Morpho/Moonwell cbETH context", categories: ["consumerJoin", "oraclePriceFeed", "economics"], sample: "Local cbETH consumer mentions are context-only and do not prove current caps, liquidity, accepted value, or liquidatable state", classification: "consumer-context-no-exact-economics" },
  { sourceLabel: "dex-exit-row", matched: "Uniswap/Curve/Base DEX rows", categories: ["dexLiquidity", "exitLiquidity", "economics"], sample: "DEX/liquidity rows do not prove exact route-size acquisition/redeem/unwind economics after slippage and gas", classification: "dex-exit-context-no-route-proof" },
  { sourceLabel: "bridge-row", matched: "Base bridge/custody mapping", categories: ["bridgeBaseCustody", "consumerJoin", "dexLiquidity", "exitLiquidity"], sample: "Base bridged cbETH context requires live supply, escrow/custody, bridge semantics, and exit liquidity proof before route-positive status", classification: "bridge-context-no-custody-delta-proof" },
].map((row) => ({ rowSource: "static-public-fact", matchType: "static-public-fact", termType: "static", routePositive: 0, sourceRoutePositiveNotPromoted: false, ...row }));

const EXPLICIT_FILES = [
  PREFILTER_JSON_REL,
  PREFILTER_MD_REL,
  "reports/raw/fast/aave-v3-emode-escalation.json",
  "reports/raw/fast/aave-euler-silo-consumer-graph.json",
  "reports/raw/fast/chainlink-feed-consumer-map.json",
  "reports/raw/fast/compound-v3-phase0.json",
  "reports/raw/fast/consumer-first-high-ltv-collateral.json",
  "reports/raw/fast/euler-v2-phase0.json",
  "reports/raw/fast/morpho-high-apy-liquidation-routes.json",
  "reports/raw/fast/morpho-liquidatable-marketability.json",
  "reports/raw/fast/morpho-wrapper-exit-proof-gaps.json",
  "reports/raw/fast/moonwell-lending-phase0.json",
  "reports/raw/fast/base-bridge-phase0.json",
  "reports/raw/fast/dex-exit-quotes.json",
  "reports/raw/fast/dex-consumer-routes.json",
  "reports/raw/fast/uniswap-v2-phase0.json",
  "reports/raw/fast/uniswap-v3-phase0.json",
  "reports/raw/fast/curve-dex-phase0.json",
  "reports/raw/fast/balancer-v3-phase0.json",
  "reports/raw/fast/two-market-leverage-loops.json",
  "reports/raw/fast/lrt-oracle-drift-routes.json",
  "reports/raw/fast/base-bridge-phase0.json",
];

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const ADDRESS_RULES = TOKEN_ROWS.map((row) => ({ label: `${row.symbol} ${row.chain} ${row.address}`, regex: new RegExp(escapeRegExp(row.address), "i") }));

const EXACT_RULES = [
  { label: "coinbase-wrapped-staked-eth", regex: /\bcoinbase[-_\s]?wrapped[-_\s]?staked[-_\s]?eth\b/i },
  { label: "Coinbase Wrapped Staked ETH", regex: /\bCoinbase\s+Wrapped\s+Staked\s+ETH\b/i },
  { label: "cbETH", regex: /\bcbETH\b/i },
  { label: "ecbETH", regex: /\becbETH\b/i },
  { label: "cbETH/index.js", regex: /\bcbETH[\\/]index\.js\b/i },
  ...ADDRESS_RULES,
];

const CONTEXT_RULES = [
  { label: "producer accounting", regex: /\b(?:exchangeRate|updateExchangeRate|non[-\s]?rebasing|share|shares?|rate\s*accounting|staked\s+token)\b/i },
  { label: "oracle/price", regex: /\b(?:oracle|price|feed|rate\s*updater|ExchangeRateUpdater|accepted\s+value|Chainlink|Moonwell)\b/i },
  { label: "proxy/admin/roles", regex: /\b(?:admin|implementation|upgradeTo|upgradeToAndCall|changeAdmin|owner|pauser|blacklister|masterMinter|role|proxy)\b/i },
  { label: "mint/redeem/burn", regex: /\b(?:MintForwarder|mint|burn|redeem|withdraw|wrap|unwrap|claim|unwind|isMinter|configureMinter|removeMinter)\b/i },
  { label: "pause/blacklist", regex: /\b(?:pause|unpause|blacklist|unBlacklist|paused)\b/i },
  { label: "bridge/base", regex: /\b(?:Base|bridge|bridged|L1|L2|custody|escrow|remote|superchain)\b/i },
  { label: "consumer", regex: /\b(?:consumer|collateral|borrow|lending|market|liquidation|Aave|Compound|Comet|Euler|Morpho|Moonwell|Silo)\b/i },
  { label: "DEX/exit", regex: /\b(?:DEX|swap|pool|liquidity|Uniswap|Curve|Balancer|exit|redeem|withdraw|slippage|AMM)\b/i },
  { label: "routePositive", regex: /\broutePositive\b/i },
];

const CATEGORY_RULES = {
  token: ["cbeth", "coinbase wrapped staked eth", TOKEN_ROWS[0].address.toLowerCase(), TOKEN_ROWS[1].address.toLowerCase(), "ecbeth"],
  producerAccounting: ["exchangeRate", "exchange rate", "updateExchangeRate", "non-rebasing", "staked token", "shares", "vault share", "totalSupply"],
  exchangeRate: ["exchangeRate", "exchange rate", "updateExchangeRate", "ExchangeRateUpdater", "rate limit", "delta"],
  oraclePriceFeed: ["oracle", "price", "feed", "chainlink", "redstone", "accepted value", "moonwell", "rate updater"],
  adminProxyRole: ["admin", "implementation", "upgradeTo", "upgradeToAndCall", "changeAdmin", "owner", "pauser", "blacklister", "masterMinter", "role", "proxy", "oracle"],
  mintWrapBurnRedeem: ["mint", "MintForwarder", "configureMinter", "removeMinter", "isMinter", "burn", "redeem", "withdraw", "wrap", "unwrap"],
  pauseBlacklist: ["pause", "unpause", "blacklist", "unBlacklist", "paused"],
  bridgeBaseCustody: ["base", "bridge", "bridged", "l1", "l2", "superchain", "escrow", "custody", TOKEN_ROWS[1].address.toLowerCase()],
  consumerJoin: ["consumer", "collateral", "borrow", "lending", "market", "reserve", "aave", "compound", "comet", "euler", "morpho", "moonwell", "silo", "liquidation"],
  dexLiquidity: ["dex", "swap", "pool", "liquidity", "curve", "balancer", "uniswap", "amm", "slippage"],
  exitLiquidity: ["exit", "unwind", "redeem", "redemption", "withdraw", "swap", "liquidity", "burn"],
  economics: ["routePositive", "executable", "profit", "netbps", "positive", "liquidityUsd", "exactEconomics", "forkProof", "slippage", "gas", "ltv", "lltv"],
};

const BLOCKERS = [
  "No exact-positive cbETH vault share -> exchange-rate/accounting -> consumer or exit venue -> borrow/redeem/unwind route is proven in local artifacts.",
  "Existing cbETH prefilter is dormant/route-negative; it contains local context joins only and did not directly probe producer or consumer contract state.",
  "exchangeRate(), updateExchangeRate(uint256), oracle/updater delta limits, and accepted consumer values require current read-only state before any value-mismatch claim.",
  "Aave, Compound V3, Euler, Morpho, Moonwell, bridge, and DEX rows are local context only; current caps, liquidity, oracle freshness, collateral factors, and borrower states are not proven.",
  "MintForwarder/minter, owner, pauser, blacklister, masterMinter, oracle, and proxy/admin controls are role/admin blockers until proven irrelevant to a permissionless path.",
  "Base bridged cbETH rows do not prove live L1 escrow/custody, supply reconciliation, bridge finality, or route-size exit liquidity.",
  "No exact acquisition, borrow/liquidation, redeem/burn/withdraw, DEX unwind, or bridge route economics are positive after LTV/LLTV, fees, slippage, caps, queues, and gas.",
  "No local static/fork value-delta proof and no signed action justified.",
];

const REQUIRED_FOR_ROUTE_POSITIVE = [
  "Exact producer state: cbETH implementation/proxy, totalSupply, exchangeRate(), oracle/updater, last/current rate, rate-limit state, and role assignments are resolved from sanitized read-only state.",
  "Exact consumer acceptance: the same cbETH token/bridge representation is accepted by a material lending/oracle/settlement consumer with current collateral factor, caps, liquidity, and oracle freshness.",
  "Exact redeem/wrap/exit path: mint/wrap/burn/redeem/withdraw or DEX/bridge exit is permissionless at route size and not blocked by pause/blacklist/minter/admin controls.",
  "Exact economics: accepted borrow/liquidation/redeem/unwind value exceeds acquisition and exit costs after LTV/LLTV, fees, slippage, bridge/finality, caps, queues, and gas.",
  "Bridge proof for Base rows: L1 escrow/custody, L2 supply, bridge semantics, and remote liquidity reconcile for the exact token and route size.",
  "Local static/fork value-delta proof shows positive attacker-controlled balance movement before routePositive, forkJustified, or signedActionJustified can change.",
  "Independent defensive review and explicit route-specific authorization are required before any signed transaction path is discussed.",
];

const NEXT_READ_ONLY_STEP = "Keep cbETH dormant unless a concrete Ethereum or Base cbETH candidate maps to a material consumer or permissionless redeem/DEX/bridge exit; then refresh sanitized read-only producer exchange-rate state, consumer oracle/caps/liquidity, role/proxy/blacklist/pause controls, bridge custody/supply, and exact exit economics before any fork/static proof.";

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

function sanitizeText(value, max = 380) {
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
  if (r === "tools/scan-coinbase-wrapped-staked-eth-full-test.js") return true;
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
  return listFilesRecursive(fast, (file) => /(?:cbeth|coinbase-wrapped-staked-eth|chainlink|oracle|consumer|aave|compound|comet|euler|morpho|moonwell|bridge|base|dex|exit|curve|balancer|uniswap|lrt|liquidation)/i.test(path.basename(file)));
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
  if (r.includes("prefilter-coinbase-wrapped-staked-eth")) return "prior-prefilter-context-only-no-route-positive";
  if (r.includes("base-bridge")) return "bridge-context-only-no-custody-or-exact-economics";
  if (r.includes("chainlink") || r.includes("oracle") || categories.includes("oraclePriceFeed")) return "oracle-context-only-no-current-accepted-value-proof";
  if (r.includes("morpho") || r.includes("aave") || r.includes("euler") || r.includes("compound") || r.includes("moonwell") || categories.includes("consumerJoin")) return "consumer-artifact-context-only-no-cbeth-exact-route";
  if (r.includes("curve") || r.includes("balancer") || r.includes("uniswap") || r.includes("dex") || r.includes("exit") || categories.includes("dexLiquidity") || categories.includes("exitLiquidity")) return "dex-exit-context-only-no-cbeth-exact-economics";
  if (categories.includes("adminProxyRole") || categories.includes("pauseBlacklist") || categories.includes("mintWrapBurnRedeem")) return "role-admin-context-only-no-permissionless-route";
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
      const match = matchForText(line, windowText);
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
        matched: sanitizeText(match.matched, 140),
        count: countOccurrences(line, match.matched),
        categories,
        sample: sanitizeText(windowText, 500),
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

function includesAnyTerm(text, terms) {
  const hay = String(text || "").toLowerCase();
  return terms.some((term) => term && hay.includes(String(term).toLowerCase()));
}

function rowSearchText(row) {
  return `${row.file || ""} ${row.matched || ""} ${row.sample || ""} ${row.classification || ""}`;
}

function sourceForRow(row) {
  if (row.file) return `${row.file}${row.line ? `:${row.line}` : ""}`;
  return row.sourceLabel || row.rowSource || "static";
}

function firstSources(rows, max = 4) {
  return uniqBy(rows, sourceForRow).slice(0, max).map(sourceForRow);
}

function proofCheck({ key, status, evidenceRows = [], blocker }) {
  return { key, status, evidenceRows: evidenceRows.length, evidenceSources: firstSources(evidenceRows), routeBlocking: true, blocker };
}

function buildCandidateMatrix(localRows) {
  const candidates = TOKEN_ROWS.map((token) => {
    const chainHints = token.chain === "Base" ? ["base", "8453", "l2", "bridged", "bridge", "ecbeth"] : ["ethereum", "chainid\": 1", "l1", "mainnet"];
    const tokenRows = localRows.filter((row) => {
      const text = rowSearchText(row);
      if (includesAnyTerm(text, [token.address])) return true;
      if (!/\b(?:cbETH|ecbETH|coinbase[-_\s]?wrapped[-_\s]?staked[-_\s]?eth)\b/i.test(text)) return false;
      return includesAnyTerm(text, chainHints);
    });
    const categories = Array.from(new Set(tokenRows.flatMap((row) => row.categories || []))).sort();
    const producerRows = tokenRows.filter((row) => (row.categories || []).some((cat) => ["producerAccounting", "token"].includes(cat)));
    const exchangeRows = tokenRows.filter((row) => (row.categories || []).includes("exchangeRate"));
    const oracleConsumerRows = tokenRows.filter((row) => (row.categories || []).some((cat) => ["oraclePriceFeed", "consumerJoin"].includes(cat)));
    const redeemRows = tokenRows.filter((row) => (row.categories || []).some((cat) => ["mintWrapBurnRedeem", "exitLiquidity"].includes(cat)));
    const roleRows = tokenRows.filter((row) => (row.categories || []).some((cat) => ["adminProxyRole", "pauseBlacklist"].includes(cat)));
    const bridgeRows = tokenRows.filter((row) => (row.categories || []).includes("bridgeBaseCustody"));
    const dexRows = tokenRows.filter((row) => (row.categories || []).some((cat) => ["dexLiquidity", "exitLiquidity", "economics"].includes(cat)));
    const checks = [
      proofCheck({ key: "producerAccountingProof", status: producerRows.length ? "context-only-no-current-state" : "missing", evidenceRows: producerRows, blocker: "No current producer accounting, totalSupply, implementation, exchangeRate, or state-delta proof is resolved for this token row." }),
      proofCheck({ key: "exchangeRateCurrentness", status: exchangeRows.length ? "context-only-no-current-rate" : "missing", evidenceRows: exchangeRows, blocker: "No current exchangeRate(), update timestamp/updater, delta-limit, or stale/incorrect-rate impact is proven." }),
      proofCheck({ key: "oracleConsumerAcceptanceProof", status: oracleConsumerRows.length ? "context-only-no-exact-consumer-state" : "missing", evidenceRows: oracleConsumerRows, blocker: "No material consumer joins this exact cbETH row with current caps, liquidity, oracle freshness, and accepted-value mismatch." }),
      proofCheck({ key: "redeemWrapPathProof", status: redeemRows.length ? "context-only-no-permissionless-exit" : "missing", evidenceRows: redeemRows, blocker: "No permissionless mint/wrap/burn/redeem/withdraw path is proven available at route size." }),
      proofCheck({ key: "pauseBlacklistUpgradeMinterRoleProof", status: roleRows.length ? "context-only-no-role-bypass-proof" : "missing", evidenceRows: roleRows, blocker: "Pause, blacklist, minter, oracle, owner, and proxy/admin controls are not proven irrelevant to the path." }),
      proofCheck({ key: "bridgeSupplyCustodyProof", status: bridgeRows.length ? "context-only-no-supply-custody-reconcile" : "missing", evidenceRows: bridgeRows, blocker: "Bridge/custody/supply reconciliation is not proven for the exact L1/L2 token and route size." }),
      proofCheck({ key: "dexExitEconomicsProof", status: dexRows.length ? "context-only-no-exact-route-size-quote" : "missing", evidenceRows: dexRows, blocker: "No exact route-size DEX/redeem/bridge exit quote is positive after slippage, fees, caps, and gas." }),
    ];
    return {
      symbol: token.symbol,
      chain: token.chain,
      address: token.address,
      role: token.role,
      localArtifactRows: tokenRows.length,
      exactLocalRows: tokenRows.filter(exactish).length,
      categories,
      producerContextRows: producerRows.length,
      exchangeRateContextRows: exchangeRows.length,
      oracleConsumerContextRows: oracleConsumerRows.length,
      redeemWrapContextRows: redeemRows.length,
      roleContextRows: roleRows.length,
      bridgeContextRows: bridgeRows.length,
      dexExitContextRows: dexRows.length,
      proofChecks: checks,
      routeBlockingProofGaps: checks.map((check) => check.key),
      routePositive: 0,
      executableNow: 0,
      signedActionJustified: false,
      status: oracleConsumerRows.length || dexRows.length ? "watch-context-needs-current-state-and-exact-economics" : "blocked-no-exact-consumer-or-exit",
      blocker: "Static/local context only; exact current state, role constraints, consumer acceptance, exit liquidity, and positive economics are unproven.",
    };
  });
  const proofGapRows = candidates.flatMap((candidate) => candidate.proofChecks.map((check) => ({
    symbol: candidate.symbol,
    chain: candidate.chain,
    gate: check.key,
    status: check.status,
    evidenceRows: check.evidenceRows,
    blocker: check.blocker,
  })));
  return {
    candidates,
    proofGapRows,
    summary: {
      candidateRows: candidates.length,
      candidatesWithLocalArtifactRows: candidates.filter((candidate) => candidate.localArtifactRows > 0).length,
      candidatesWithProducerContext: candidates.filter((candidate) => candidate.producerContextRows > 0).length,
      candidatesWithOracleConsumerContext: candidates.filter((candidate) => candidate.oracleConsumerContextRows > 0).length,
      candidatesWithDexExitContext: candidates.filter((candidate) => candidate.dexExitContextRows > 0).length,
      candidatesWithProducerAccountingProof: 0,
      candidatesWithExchangeRateCurrentnessProof: 0,
      candidatesWithExactOracleConsumerProof: 0,
      candidatesWithRedeemWrapPathProof: 0,
      candidatesWithPauseBlacklistUpgradeMinterRoleProof: 0,
      candidatesWithBridgeSupplyCustodyProof: 0,
      candidatesWithDexExitEconomicsProof: 0,
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
    if (row.rowSource === "static-public-fact" || exactish(row) || cats.some((cat) => ["token", "producerAccounting", "exchangeRate", "oraclePriceFeed", "adminProxyRole", "mintWrapBurnRedeem", "pauseBlacklist", "bridgeBaseCustody", "consumerJoin", "dexLiquidity", "exitLiquidity"].includes(cat))) {
      if (!files.has(key) || exactish(row) || row.rowSource === "static-public-fact") {
        priority.push(row);
        files.add(key);
      }
    }
    if (priority.length >= 48) break;
  }
  return priority.length ? priority : rows.slice(0, 28);
}

function loadPriorPrefilter() {
  const artifact = readJson(path.join(WORKSPACE, PREFILTER_JSON_REL)) || {};
  const summary = artifact.summary || {};
  return {
    generatedAt: artifact.generatedAt || null,
    scanner: artifact.scanner || "tools/scan-coinbase-wrapped-staked-eth-prefilter.js",
    localArtifactMatchRows: Number(summary.localArtifactMatchRows || artifact.localArtifactMatchRows || 0) || 0,
    consumerJoinRows: Number(summary.consumerJoinRows || artifact.consumerJoinRows || 0) || 0,
    dexLiquidityRows: Number(summary.dexLiquidityRows || (Array.isArray(artifact.dexLiquidityRows) ? artifact.dexLiquidityRows.length : 0) || 0) || 0,
    exactEconomicsRows: Number(summary.exactEconomicsRows || 0) || 0,
    routePositive: Number(summary.routePositive || 0) || 0,
    executableNow: Number(summary.executableNow || 0) || 0,
    signedActionJustified: Boolean(summary.signedActionJustified || false),
    producerConsumerStateDirectlyProbed: false,
  };
}

function buildPayload({ lineScan, priorPrefilter }) {
  const localRows = lineScan.rows;
  const combinedRows = [...STATIC_CONTEXT_ROWS, ...localRows];
  const exactRows = lineScan.exactRows;
  const categoryRows = {};
  for (const category of Object.keys(CATEGORY_RULES)) categoryRows[`${category}Rows`] = pickRows(combinedRows, (row) => (row.categories || []).includes(category), 220);
  const priorPrefilterRows = pickRows(localRows, (row) => row.file && row.file.includes("prefilter-coinbase-wrapped-staked-eth"), 220);
  const consumerJoinRows = pickRows(combinedRows, (row) => (row.categories || []).includes("consumerJoin"), 240);
  const contextConsumerJoinRows = consumerJoinRows;
  const exactConsumerJoinRows = [];
  const dexExitRows = pickRows(combinedRows, (row) => (row.categories || []).some((cat) => ["dexLiquidity", "exitLiquidity"].includes(cat)), 240);
  const exactEconomicsRows = 0;
  const candidateMatrix = buildCandidateMatrix(localRows);
  const notableRows = selectNotableRows(combinedRows);
  const priorArtifactPositiveRowsNotPromoted = localRows.filter((row) => row.sourceRoutePositiveNotPromoted).length;
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
    tokenRows: TOKEN_ROWS.length,
    producerExchangeRateRows: PRODUCER_EXCHANGE_RATE_ROWS.length,
    oraclePriceFeedRows: ORACLE_PRICE_FEED_ROWS.length,
    adminProxyRoleRows: ADMIN_PROXY_ROLE_ROWS.length,
    pathRows: PATH_ROWS.length,
    surfaceRows: SURFACE_ROWS.length,
    publicContextRows: PUBLIC_CONTEXT_ROWS.length,
    bugClassRows: BUG_CLASS_ROWS.length,
    staticContextRows: STATIC_CONTEXT_ROWS.length,
    priorPrefilterRows: priorPrefilterRows.length,
    priorPrefilterLocalArtifactMatchRows: priorPrefilter.localArtifactMatchRows,
    priorPrefilterConsumerJoinRows: priorPrefilter.consumerJoinRows,
    priorPrefilterDexLiquidityRows: priorPrefilter.dexLiquidityRows,
    filesScanned: lineScan.filesScanned,
    filesWithLocalMatches: lineScan.filesWithMatch,
    filesWithExactLocalMatches: lineScan.filesWithExact,
    localArtifactMatchRows: localRows.length,
    exactLocalArtifactMatchRows: exactRows.length,
    localLineRows: localRows.length,
    tokenContextRows: categoryRows.tokenRows.length,
    producerAccountingRows: categoryRows.producerAccountingRows.length,
    exchangeRateRows: categoryRows.exchangeRateRows.length,
    oraclePriceFeedContextRows: categoryRows.oraclePriceFeedRows.length,
    adminProxyRoleContextRows: categoryRows.adminProxyRoleRows.length,
    mintWrapBurnRedeemContextRows: categoryRows.mintWrapBurnRedeemRows.length,
    pauseBlacklistContextRows: categoryRows.pauseBlacklistRows.length,
    bridgeBaseCustodyRows: categoryRows.bridgeBaseCustodyRows.length,
    consumerJoinRows: consumerJoinRows.length,
    contextConsumerJoinRows: contextConsumerJoinRows.length,
    exactConsumerJoinRows: exactConsumerJoinRows.length,
    dexLiquidityRows: categoryRows.dexLiquidityRows.length,
    exitLiquidityRows: categoryRows.exitLiquidityRows.length,
    dexExitContextRows: dexExitRows.length,
    economicsContextRows: categoryRows.economicsRows.length,
    candidateMatrixRows: candidateMatrix.summary.candidateRows,
    candidatesWithLocalArtifactRows: candidateMatrix.summary.candidatesWithLocalArtifactRows,
    candidatesWithProducerContext: candidateMatrix.summary.candidatesWithProducerContext,
    candidatesWithOracleConsumerContext: candidateMatrix.summary.candidatesWithOracleConsumerContext,
    candidatesWithDexExitContext: candidateMatrix.summary.candidatesWithDexExitContext,
    candidatesWithProducerAccountingProof: candidateMatrix.summary.candidatesWithProducerAccountingProof,
    candidatesWithExchangeRateCurrentnessProof: candidateMatrix.summary.candidatesWithExchangeRateCurrentnessProof,
    candidatesWithExactOracleConsumerProof: candidateMatrix.summary.candidatesWithExactOracleConsumerProof,
    candidatesWithRedeemWrapPathProof: candidateMatrix.summary.candidatesWithRedeemWrapPathProof,
    candidatesWithPauseBlacklistUpgradeMinterRoleProof: candidateMatrix.summary.candidatesWithPauseBlacklistUpgradeMinterRoleProof,
    candidatesWithBridgeSupplyCustodyProof: candidateMatrix.summary.candidatesWithBridgeSupplyCustodyProof,
    candidatesWithDexExitEconomicsProof: candidateMatrix.summary.candidatesWithDexExitEconomicsProof,
    candidateMatrixProofGapRows: candidateMatrix.summary.candidateMatrixProofGapRows,
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
    scanner: "tools/scan-coinbase-wrapped-staked-eth-full-test.js",
    target: TARGET,
    scope: {
      kind: "bounded defensive/read-only full-test scanner",
      artifactStaticLocalFirst: true,
      publicFactsOnly: true,
      evmFirst: true,
      evmFirstChains: TARGET.primaryChains,
      bridgeContextChains: TARGET.bridgeContextChains,
      routeGraph: TARGET.routeGraph,
      writesLimitedTo: [OUT_JSON_REL, OUT_MD_REL],
      coordinatorClaim: TARGET.coordinatorClaim,
      aggregatePromotionStateHandoffEdited: false,
      endpointPolicy: "No endpoint inventory was read by this full-test scanner; no raw endpoints, domains, keys, or tokens are persisted.",
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
    publicContextRows: PUBLIC_CONTEXT_ROWS,
    bugClasses: BUG_CLASS_ROWS,
    discoveredSeeds: { chainSeeds: CHAIN_SEEDS, tokenRows: TOKEN_ROWS, producerExchangeRateRows: PRODUCER_EXCHANGE_RATE_ROWS, oraclePriceFeedRows: ORACLE_PRICE_FEED_ROWS, adminProxyRoleRows: ADMIN_PROXY_ROLE_ROWS, pathRows: PATH_ROWS, surfaceRows: SURFACE_ROWS },
    priorPrefilter: priorPrefilter,
    staticContextRows: STATIC_CONTEXT_ROWS,
    priorPrefilterRows,
    localArtifacts: {
      filesScanned: lineScan.filesScanned,
      filesWithMatch: lineScan.filesWithMatch,
      filesWithExact: lineScan.filesWithExact,
      categoryCounts: lineScan.categoryCounts,
      rows: localRows,
      exactRows: exactRows.slice(0, 220),
      notableRows,
    },
    categoryRows: { ...categoryRows, consumerJoinRows, contextConsumerJoinRows, exactConsumerJoinRows, dexExitRows },
    candidateMatrix,
    rows: notableRows.slice(0, 16),
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
      reason: "Static/local scan found cbETH token, exchange-rate, oracle/consumer, proxy/admin/role, mint/redeem, pause/blacklist, bridge/Base, and DEX/exit context rows only; no current exact permissionless value movement, positive economics, or local/fork/static value-delta proof is present.",
    },
    blockers: BLOCKERS,
    requiredForRoutePositive: REQUIRED_FOR_ROUTE_POSITIVE,
    nextReadOnlyStep: NEXT_READ_ONLY_STEP,
    summary,
  };
}

function metricRows(summary) {
  const keys = [
    "sourceFactRows", "chainSeedRows", "tokenRows", "producerExchangeRateRows", "oraclePriceFeedRows", "adminProxyRoleRows", "pathRows", "surfaceRows", "publicContextRows", "bugClassRows", "staticContextRows", "priorPrefilterRows", "priorPrefilterLocalArtifactMatchRows", "priorPrefilterConsumerJoinRows", "priorPrefilterDexLiquidityRows", "filesScanned", "filesWithLocalMatches", "filesWithExactLocalMatches", "localArtifactMatchRows", "exactLocalArtifactMatchRows", "producerAccountingRows", "exchangeRateRows", "oraclePriceFeedContextRows", "adminProxyRoleContextRows", "mintWrapBurnRedeemContextRows", "pauseBlacklistContextRows", "bridgeBaseCustodyRows", "consumerJoinRows", "contextConsumerJoinRows", "exactConsumerJoinRows", "dexLiquidityRows", "exitLiquidityRows", "dexExitContextRows", "economicsContextRows", "candidateMatrixRows", "candidatesWithLocalArtifactRows", "candidatesWithProducerContext", "candidatesWithOracleConsumerContext", "candidatesWithDexExitContext", "candidatesWithProducerAccountingProof", "candidatesWithExchangeRateCurrentnessProof", "candidatesWithExactOracleConsumerProof", "candidatesWithRedeemWrapPathProof", "candidatesWithPauseBlacklistUpgradeMinterRoleProof", "candidatesWithBridgeSupplyCustodyProof", "candidatesWithDexExitEconomicsProof", "candidateMatrixProofGapRows", "producerAnomalies", "watchCandidates", "publicFetchRows", "rpcInventoryRows", "graphqlInventoryRows", "ethCallRows", "forkRows", "exactEconomicsRows", "routePositive", "executableNow", "signedActionJustified", "forkJustified", "forkGate", "fullTestReadOnlyComplete",
  ];
  return keys.map((key) => `| ${key} | ${mdEscape(summary[key])} |`).join("\n");
}

function safetyRows(safety) {
  const keys = [
    "localArtifactsRead", "publicSourcesRead", "publicStaticLabelsUsed", "publicNetworkFetch", "endpointInventoryRead", "rpcInventoryRead", "graphqlInventoryRead", "envFilesRead", "privateKeysRead", "keyMaterialRead", "rawEndpointUrlsStored", "rpcUrlsStored", "graphqlUrlsStored", "rawUrlsStored", "rawDomainsStored", "rawKeysTokensStored", "signedActions", "liveTransactions", "broadcasts", "walletOperations", "forkTransactions", "sanitizedOutputOnly", "secretLikePathsExcluded",
  ];
  return keys.map((key) => `| ${key} | ${mdEscape(safety[key])} |`).join("\n");
}

function formatLocalRow(row) {
  const categories = (row.categories || []).join(",");
  const detail = row.sample || "context-only";
  return `| ${mdEscape(sourceForRow(row))} | ${mdEscape(categories)} | ${mdEscape(row.matched)} | ${mdEscape(detail)} | ${mdEscape(row.routePositive)} | ${mdEscape(row.classification)} |`;
}

function shortAddress(value) {
  const text = String(value || "");
  return /^0x[0-9a-fA-F]{40}$/.test(text) ? `${text.slice(0, 6)}...${text.slice(-4)}` : text;
}

function formatTokenRow(row) {
  return `| ${mdEscape(row.role)} | ${mdEscape(row.chain)} | ${mdEscape(row.symbol)} | ${mdEscape(row.address)} | ${mdEscape(row.surface)} | ${mdEscape(row.classification)} |`;
}

function formatSurfaceRow(row) {
  return `| ${mdEscape(row.component)} | ${mdEscape(row.surface)} | ${mdEscape(row.routeRole)} | ${mdEscape((row.watchTerms || []).join(", "))} |`;
}

function formatCandidateRow(row) {
  const evidence = `local=${row.localArtifactRows}, exact=${row.exactLocalRows}, producer=${row.producerContextRows}, oracleConsumer=${row.oracleConsumerContextRows}, dexExit=${row.dexExitContextRows}`;
  const missing = row.routeBlockingProofGaps.join(", ");
  return `| ${mdEscape(row.symbol)} | ${mdEscape(row.chain)} | ${mdEscape(shortAddress(row.address))} | ${mdEscape(evidence)} | ${mdEscape(missing)} | ${mdEscape(row.status)} |`;
}

function formatBugClassRow(row) {
  return `| ${mdEscape(row.label)} | ${mdEscape(row.surface)} | ${mdEscape(row.classification)} |`;
}

function buildMarkdown(payload) {
  const notableRows = payload.localArtifacts.notableRows.length
    ? payload.localArtifacts.notableRows.map(formatLocalRow).join("\n")
    : "| (none) | n/a | n/a | no local context rows found | 0 | dormant |";
  const tokenRows = payload.discoveredSeeds.tokenRows.map(formatTokenRow).join("\n");
  const surfaceRows = payload.discoveredSeeds.surfaceRows.map(formatSurfaceRow).join("\n");
  const candidateRows = payload.candidateMatrix.candidates.map(formatCandidateRow).join("\n");
  const bugClassRows = payload.bugClasses.map(formatBugClassRow).join("\n");
  const contextRows = payload.publicContextRows.map((item) => `- ${item}`).join("\n");

  return `# 🟢 DORMANT - Coinbase Wrapped Staked ETH / cbETH Full Test

Generated: ${payload.generatedAt}

Route remains closed: routePositive=${payload.routeGate.routePositive}, executableNow=${payload.routeGate.executableNow}, signedActionJustified=${payload.routeGate.signedActionJustified}, forkJustified=${payload.routeGate.forkJustified}, forkGate=${payload.routeGate.forkGate}.

## Target Context

- Target: ${payload.target.name} (${payload.target.slug}), symbol=${payload.target.symbol}, category=${payload.target.category}, surface=${payload.target.surface}, TVL context≈${payload.target.tvlContext}.
- EVM scope: ${payload.scope.evmFirstChains.join(", ")}; bridge/liquidity context: ${payload.scope.bridgeContextChains.join(", ")}.
- Route graph: ${payload.target.routeGraph}.
- Adapter context: module=${payload.target.module}, adapterFetched=${payload.target.adapterFetched}, adapterAddressCount=${payload.target.adapterAddressCount}.
- Existing coverage: prior prefilter artifact is dormant/route-negative and context-only; no producer/consumer contract state was directly probed here.

## Metrics

| Metric | Value |
|---|---:|
${metricRows(payload.summary)}

## Safety Summary

| Field | Value |
|---|---:|
${safetyRows(payload.safety)}

## Public Static Context (allowed context; not fetched here)

${contextRows}

## Token / Address Seeds

| Role | Chain | Symbol | Address | Surface | Classification |
|---|---|---|---|---|---|
${tokenRows}

## Surface Checklist

| Component | Surface | Route Role | Watch Terms |
|---|---|---|---|
${surfaceRows}

## Static Candidate Matrix (fail-closed)

| Candidate | Chain | Address | Local Evidence | Missing Current Proofs | Status |
|---|---|---|---|---|---|
${candidateRows}

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
- No exact cbETH exchange-rate/accounting anomaly, material current consumer acceptance, permissionless redeem/bridge/DEX exit, or route-size positive economics was resolved.
- Existing cbETH prefilter rows remain prior context only; this full-test did not read endpoint inventories or perform live calls.
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
  log("Scanning cbETH local artifacts (sanitized, no endpoint inventory read)...");
  const files = listScanFiles();
  const lineScan = scanLocalArtifactLines(files);
  const priorPrefilter = loadPriorPrefilter();
  const payload = buildPayload({ lineScan, priorPrefilter });
  writeJson(OUT_JSON, payload);
  writeText(OUT_MD, buildMarkdown(payload));
  log(`Wrote ${OUT_JSON_REL} and ${OUT_MD_REL}`);
  log(`routePositive=${payload.summary.routePositive}; exactEconomicsRows=${payload.summary.exactEconomicsRows}; localArtifactMatchRows=${payload.summary.localArtifactMatchRows}; exactConsumerJoinRows=${payload.summary.exactConsumerJoinRows}`);
}

main();
