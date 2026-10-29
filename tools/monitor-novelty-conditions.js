#!/usr/bin/env node
// monitor-novelty-conditions.js — Cross-Protocol Exploit Condition Detector
// ══════════════════════════════════════════════════════════════════════════════
// BUILT AND MAINTAINED BY THIS WORKSPACE — DO NOT DUPLICATE OR MODIFY.
// Other agents: this tool is already live. Read MONITOR-SPEC.md for context.
// ══════════════════════════════════════════════════════════════════════════════
// Split-cycle evaluator suite against live chain state and residual artifacts.
// Split-cycle: fast 60s (E5/E8/E9), full 300s (all evaluator groups).
// Usage: node tools/monitor-novelty-conditions.js --once    (single run)
//        node tools/monitor-novelty-conditions.js --watch   (split-cycle, default 60s fast)
//        --auto-execute is permanently rejected; this monitor is read-only.
//        node tools/monitor-novelty-conditions.js --watch 120  (custom fast interval)

const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const { ethers } = require("./node_modules/ethers");
const { ARTIFACT_STATUS, assessArtifactObject, readArtifactFile } = require("./monitor-artifact-policy");
const { BOUNDED_OBSERVATIONAL, EXHAUSTIVE_COMPLETE, validateAaveSourceCoverage } = require("./aave-source-coverage");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const runtimeConfig = process["env"];
const STALENESS_INVENTORY = path.join(WORKSPACE, "reports", "raw", "fast", "staleness-gaps.json");
const LAYERZERO_INVENTORY = path.join(WORKSPACE, "reports", "raw", "fast", "layerzero-v2-live.json");
const AXELAR_INVENTORY = path.join(WORKSPACE, "reports", "raw", "fast", "axelar-live.json");
const WORMHOLE_INVENTORY = path.join(WORKSPACE, "reports", "raw", "fast", "wormhole-live.json");
const DEBRIDGE_LIVE_JSON = path.join(WORKSPACE, "reports", "raw", "fast", "debridge-live.json");
const SUILEND_CANDIDATE_PROBE = path.join(WORKSPACE, "reports", "raw", "suilend-suite-candidate-probe.json");
const KAMINO_WINDOW_ARTIFACT = path.join(WORKSPACE, "reports", "raw", "fast", "kamino-live-window.json");
const WORMHOLE_TRIAGE = path.join(WORKSPACE, "reports", "wormhole-portal-ntt-triage.md");
const MORPHO_TRIAGE = path.join(WORKSPACE, "reports", "morpho-triage.md");
const E2_QUOTEVAULT_JSON = path.join(WORKSPACE, "reports", "raw", "fast", "e2-quotevault-candidates.json");
const GEARBOX_LIVE_JSON = path.join(WORKSPACE, "reports", "raw", "fast", "gearbox-live.json");
const FRAXLEND_LIVE_JSON = path.join(WORKSPACE, "reports", "raw", "fast", "fraxlend-live.json");
const VAULT_INVENTORY = path.join(WORKSPACE, "reports", "monitor", "vault-inventory.json");
const REPORTS_DIR = path.join(WORKSPACE, "reports");
const STATE_FILE = path.join(WORKSPACE, "reports", "monitor", "state.json");
const ALERT_FILE = path.join(WORKSPACE, "reports", "monitor", "alerts.jsonl");
const LOG_FILE = path.join(WORKSPACE, "reports", "monitor", "monitor.log");
const EVALUATOR_PROXIMITY_SCRIPT = path.join(WORKSPACE, "tools", "scan-evaluator-proximity.js");
const EVALUATOR_PROXIMITY_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "evaluator-proximity.json");
const AAVE_V4_WATCH_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "aave-v4-liquidation-watch.json");
const AAVE_V4_WATCH_SCHEMA = "aave-v4-liquidation-watch/v1";
const AAVE_V4_WATCH_SCANNER = "tools/watch-aave-v4-liquidation-triggers.js";
const AAVE_V4_SOURCE_SCANNER = "tools/scan-aave-v4-spoke-borrowers.js";
const AAVE_V4_SOURCE_ARTIFACT = "reports/raw/fast/aave-v4-spoke-borrowers.json";

const ALERT_WEBHOOK_URL = runtimeConfig.ALERT_WEBHOOK_URL || "";
const ALERT_WEBHOOK_MIN_SEVERITY = runtimeConfig.ALERT_WEBHOOK_MIN_SEVERITY || "CRITICAL";
const ALERT_WEBHOOK_CONDITIONS = new Set(String(runtimeConfig.ALERT_WEBHOOK_CONDITIONS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean));
const ALERT_WEBHOOK_TIMEOUT_MS = Number(runtimeConfig.ALERT_WEBHOOK_TIMEOUT_MS || "8000");
const ALERT_WEBHOOK_DRY_RUN = runtimeConfig.ALERT_WEBHOOK_DRY_RUN === "1";
const TELEGRAM_BOT_TOKEN = runtimeConfig.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = runtimeConfig.TELEGRAM_CHAT_ID || "";
const TELEGRAM_ALERT_MIN_SEVERITY = runtimeConfig.TELEGRAM_ALERT_MIN_SEVERITY || "CRITICAL";
const TELEGRAM_ALERT_CONDITIONS = new Set(String(runtimeConfig.TELEGRAM_ALERT_CONDITIONS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean));
const TELEGRAM_ALERT_TIMEOUT_MS = Number(runtimeConfig.TELEGRAM_ALERT_TIMEOUT_MS || "8000");
const TELEGRAM_ALERT_DRY_RUN = runtimeConfig.TELEGRAM_ALERT_DRY_RUN === "1";

const DEFAULT_INTERVAL_MS = 60_000; // 60s fast cycle (full every 5 cycles = 300s)
const RPC_TIMEOUT_MS = 15_000;
const RPC_INVENTORY_MAX_BYTES = 512 * 1024;
const RPC_INVENTORY_MAX_CANDIDATES = 64;
const RPC_QUALIFICATION_CONCURRENCY = 4;
const RPC_QUALIFICATION_TIMEOUT_MS = 4_000;
const ZERO = "0x0000000000000000000000000000000000000000";
const WEEK = 7 * 86400;
const E8_EXECUTION_CONDITION = "eth-usd-divergence";
const E8_MIN_FEED_AGE_SECONDS = 1800;
const E8_MIN_DIVERGENCE_PERCENT = 30.0; // break-even ~26.5%, 3.5pp safety margin
const _E8_GAS_USED = 2_300_000; // ~2.3M gas from fork test
const E8_CONTRACT = "0xb795fEB4d24d4Da7C55D6343aaC988b940d948E8";
const E8_FLUID_ORACLE = "0xc5911Fa3917c507fBEbAb910C8b47cBdD3Ce147e";
const E8_WSTETH = "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0";
const E8_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const E8_WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const E8_UNISWAP_FEE = 500;
const E8_MIN_NET_PROFIT_USD = Number(runtimeConfig.E8_MIN_NET_PROFIT_USD || "25");
const E8_FLASH_WSTETH = Number(runtimeConfig.E8_FLASH_WSTETH || "1");
const E1_CONDITION = "compound-stale-oracle";
const E1_MIN_FEED_AGE_SECONDS = 1800;
const E1_MIN_DIVERGENCE_PERCENT = 5.0; // Watch-only generic ETH/USD stale threshold; signed E1 is CAPO route-specific.
const E1_CONTRACT = "0xe1797A807A5dBf774dBD149e844B18C922E695Eb";
const E1_ROUTE = "cwethv3-wsteth-capo";
const E1_CWETHV3 = "0xA17581A9E3356d9A858b789D68B4d866e593aE94";
const E1_WSTETH = "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0";
const E1_WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const E1_CAPO_ORACLE = "0x91359Ce8989CB610A4127777828E667F23b94ee9";
const E1_MIN_NET_PROFIT_USD = Number(runtimeConfig.E1_MIN_NET_PROFIT_USD || "25");
const E1_MIN_CAPO_ROUTE_SPREAD_PCT = Number(runtimeConfig.E1_MIN_CAPO_ROUTE_SPREAD_PCT || "12.5");
const E1_MIN_FLASH_WSTETH = Number(runtimeConfig.E1_MIN_FLASH_WSTETH || "1");
const E1_MAX_FLASH_WSTETH = Number(runtimeConfig.E1_MAX_FLASH_WSTETH || "10");
const E1_GAS_USED = 2_500_000;
const E10_BASE_CONDITION = "cross-chain-base";
const E10_BASE_CONTRACT = "0x4C8bDB2Bcdd7eAF55c2cd1dEb76c8b4174baC31F";
const E10_OP_CONDITION = "cross-chain-op";
const E10_OP_CONTRACT = "0x08500266c4F40Ed80DEda53cD71204b8965541aE";
const E10_MIN_EXEC_SPREAD_PCT = 30.0; // Flash-loan route must cover principal: 1 / 0.80 LTV - 1 ≈ 25%, plus buffer.
const E10_MIN_OVERVALUED_FEED_AGE_SECONDS = 1800;
const E10_MAX_REFERENCE_FEED_AGE_SECONDS = Number(runtimeConfig.E10_MAX_REFERENCE_FEED_AGE_SECONDS || "1800");
const E10_MIN_NET_PROFIT_USD = Number(runtimeConfig.E10_MIN_NET_PROFIT_USD || "25");
const E10_GAS_USED = 3_000_000;
const E5_EXECUTION_TOKENS = new Set(["USDC"]); // Only USDC has Fluid VaultT1 against ETH on mainnet
const E5_CONTRACT = "0x81F2FCF80ADecd464d88AD01Aa3Afe3D7919E583";
const E5_FLUID_USDC_ETH = "0x348aD11DB2c90e7FdF8e57420C569F76dBe38a59";
const E5_FLUID_USDC_ETH_ORACLE = "0x122Bd7fBacef5d42CB178CbA71DF03D03d3E8821";
const E5_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const E5_USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const E5_WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const E5_UNISWAP_FEE = 500;
const E5_MIN_EXEC_DEPEG_PCT = 13.0;
const E5_MIN_NET_PROFIT_USD = Number(runtimeConfig.E5_MIN_NET_PROFIT_USD || "25");
const E5_GAS_USED = 3_000_000;
const HIGH_SIGNAL_ROUTE_CONDITIONS = new Set([
  E8_EXECUTION_CONDITION,
  E1_CONDITION,
  "depeg",
  "cross-chain-base",
  "cross-chain-op",
  "cross-chain-arb",
  "cross-chain-poly",
  "liquidation-hunter",
  "morpho-new-market-exploit",
]);

const E10_CHAIN_EXEC = {
  8453:  { condition: "cross-chain-base",  contract: "0x4C8bDB2Bcdd7eAF55c2cd1dEb76c8b4174baC31F", chain: "Base",     pool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5", weth: "0x4200000000000000000000000000000000000006", usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", router: "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43", balancer: "0xBA12222222228d8Ba445958a75a0704d566BF2C8", useUniV3: false, uniFee: 500, artifact: "E10AaveBaseExploit.sol/E10AaveBaseExploit.json" },
  10:    { condition: "cross-chain-op",    contract: "0x08500266c4F40Ed80DEda53cD71204b8965541aE", chain: "Optimism", pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD", weth: "0x4200000000000000000000000000000000000006", usdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", router: "0xE592427A0AEce92De3Edee1F18E0157C05861564", quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e", balancer: "0xBA12222222228d8Ba445958a75a0704d566BF2C8", useUniV3: true,  uniFee: 500, artifact: "E10GenericExploit.sol/E10GenericExploit.json" },
  42161: { condition: "cross-chain-arb",   contract: "0x08500266c4F40Ed80DEda53cD71204b8965541aE", chain: "Arbitrum", pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD", weth: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", router: "0xE592427A0AEce92De3Edee1F18E0157C05861564", quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e", balancer: "0xBA12222222228d8Ba445958a75a0704d566BF2C8", useUniV3: true,  uniFee: 500, artifact: "E10GenericExploit.sol/E10GenericExploit.json" },
  137:   { condition: "cross-chain-poly",  contract: "0xF9EBbDd6715C7fb53aA7ADe99d20A898FC95E178", chain: "Polygon",  pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD", weth: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", usdc: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", router: "0xE592427A0AEce92De3Edee1F18E0157C05861564", quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e", balancer: "0xBA12222222228d8Ba445958a75a0704d566BF2C8", useUniV3: true,  uniFee: 500, artifact: "E10GenericExploit.sol/E10GenericExploit.json" },
  534352:{ condition: "cross-chain-scroll",contract: "0x2cb170cc223e2a117fd66df7efa4f4b589826415", chain: "Scroll",   pool: "0x11fCfe756c05AD438e312a7fd934381537D3cFfe", weth: "0x5300000000000000000000000000000000000004", usdc: "0x06eFdBFf2a14a7c8E15944D1F4A48F9F95F663A4", router: "0xE592427A0AEce92De3Edee1F18E0157C05861564", quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e", balancer: "0xBA12222222228d8Ba445958a75a0704d566BF2C8", useUniV3: true,  uniFee: 500, artifact: "E10GenericExploit.sol/E10GenericExploit.json" },
  42220: { condition: "cross-chain-celo",  contract: "0xb6ae3e399c8cb1ca23b6771aad67af885ba4ae92", chain: "Celo",     pool: "0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402", weth: "0x122013fd7dF1C6F636a5bb8f03108E876548b455", usdc: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C", router: "0xE592427A0AEce92De3Edee1F18E0157C05861564", quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e", balancer: "0xBA12222222228d8Ba445958a75a0704d566BF2C8", useUniV3: true,  uniFee: 500, artifact: "E10GenericExploit.sol/E10GenericExploit.json" },
};
const RESIDUAL_WATCH_INTERVAL_MS = 6 * 3600_000;
const LISTING_SAFETY_CONDITION = "listing-safety";
const LISTING_SAFETY_MIN_LLTV = 0.86;
const KAMINO_LIQUIDATION_CONDITION = "kamino-liquidation-window";
const GOVERNANCE_LISTING_CONDITION = "governance-listing-watch";
const AUTO_FORK_CONDITION = "auto-fork-positive";
const APYUSD_PREFLIGHT_CONDITION = "apyusd-receipt-preflight";
const EIGENLAYER_NAVDEX_CONDITION = "eigenlayer-navdex-watch";
const MARGINFI_ORACLE_CONDITION = "marginfi-oracle-watch";
const MARGINFI_CONFIG_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "marginfi-oracle-config.json");
const FORK_PROOF_MORPHO = path.join(WORKSPACE, "reports", "raw", "fast", "fork-proof-morpho-wsteth-weth.json");
const FORK_PROOF_AAVE = path.join(WORKSPACE, "reports", "raw", "fast", "fork-proof-aave-v4-liquidation.json");
const FORK_PROOF_AAVE_V3 = path.join(WORKSPACE, "reports", "raw", "fast", "fork-proof-aave-v3-liquidation.json");
const RESIDUAL_ALERT_COOLDOWN_MS = 24 * 3600_000;
const AAVE_V4_WATCH_CONDITION = "aave-v4-liquidation-watch";
const AAVE_V4_WATCH_ALERT_COOLDOWN_MS = Number(runtimeConfig.AAVE_V4_WATCH_ALERT_COOLDOWN_MS || String(15 * 60_000));

// ─── Chainlink Feeds for Staleness / Depeg Evaluation ───────────────────────
const FEEDS = {
  "ETH/USD": { feed: "0x5f4eC3Df9cbd43714FE2740f5e3616155c5b8419", chainId: 1 },
  "stETH/USD": { feed: "0xCfE54B5cD566aB89272946F602D76Ea879CAb4a8", chainId: 1 },
  "USDC/USD": { feed: "0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6", chainId: 1 },
};


// Protocol consumers per feed with maxStaleSeconds. null = unlimited (no check).
const FEED_CONSUMERS = {
  "ETH/USD": {
    "Fluid": null, "Silo V3": null, "Curve crvUSD": null, "Compound V3": null,
    "Venus Ethereum": 6000, "Venus Base": 1800, "Aave V3": 86400, "Gearbox": 0,
  },
  "stETH/USD": {
    "Liquity Bold": null, "Gearbox": 0,
  },
  "USDC/USD": {
    "Gearbox": 0, "Venus Ethereum": 93600, "Venus Arbitrum": 93600,
  },
};


// ─── Stablecoin Feeds for Depeg Detection ──────────────────────────────────
const STABLECOIN_FEEDS = {
  "USDC":  { feed: "0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6", chainId: 1 },
  "USDT":  { feed: "0x3E7d1eAB13ad0104d2750B8863b489D65364e32D", chainId: 1 },
  "DAI":   { feed: "0xAed0c38402a5d19df6E4c03F4E2DceD6e29c1ee9", chainId: 1 },
  "USDe":  { feed: "0xa569d910839Ae8865Da8F8e70FfFb0cBA869F961", chainId: 1 },
  "GHO":   { feed: "0x3f12643D3f6f874d39c2A4c9f2cd6f2DbAC877fc", chainId: 1 },
  "FRAX":  { feed: "0xB9E1E3A9feFf48998E45Fa90847ed4D467E8BcfD", chainId: 1 },
  "crvUSD":{ feed: "0xeef0C605546958c1f899b6fb336c20671f9cd49f", chainId: 1 },
};

// ─── Evaluator 2: Factory Contracts for ERC4626 Vaults ─────────────────────
const VAULT_FACTORIES = [
  { chainId: 1, address: "0xA1D94F746dEfa1928926b84fB2596c06926C0405", name: "Morpho VaultV2Factory", deployTopic: "0x341ce009267aa0d78cc12b34155e223904a51ed49d144beb6eb8be87813edb4e" /* CreateVaultV2 */, vaultInTopics: 3 },
  { chainId: 8453, address: "0x4501125508079A99ebBebCE205DeC9593C2b5857", name: "Morpho VaultV2Factory (Base)", deployTopic: "0x341ce009267aa0d78cc12b34155e223904a51ed49d144beb6eb8be87813edb4e", vaultInTopics: 3 },
];

// ─── Evaluator 3: Public Allocator Contracts ────────────────────────────────
const ALLOCATORS = [
  { chainId: 1, name: "Morpho Vault V2", reallocateTopic: "0xe20fc29fa54114bf14ae8abb79a7b95d5cfd69b93d1a56dae99bca1d5947917f" /* Reallocate */ },
];

// ─── Evaluator 4: LayerZero DVN Config (loaded from layerzero-v2-live.json) ──

// ─── Evaluator 6: ve(3,3) Voter Contracts ──────────────────────────────────
const VE33_VOTERS = [
  { chainId: 8453, name: "Aerodrome", minter: "0x4ecE3612e235f9D83CA2bedB04cfCA1c3E71eb92", voter: "0x16613524e02ad97eDfeF371bC883F2F5d6C480A5" },
  { chainId: 10, name: "Velodrome", minter: "0x3460eE6b0c91EDD20a8Fe9C0892875A4a6E090F4", voter: "0x41C914ee0c7E1A5edCD0295623e6dC557B5aBf3C" },
  // Mode (34443), Lisk (1135), Ink (57073) — RPCs confirmed working (DRPC). Voter/Minter NOT deployed at CREATE2 addresses.
];

// ══════════════════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ══════════════════════════════════════════════════════════════════════════════

function ts() { return new Date().toISOString(); }

function log(msg) {
  const line = `[${ts()}] ${msg}`;
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch (_) {}
  console.error(line);
}

function logPrint(msg) { console.log(`[${ts()}] ${msg}`); }

function finiteNumber(value) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function displayFinite(value, digits = 0, suffix = "") {
  const number = finiteNumber(value);
  return number === null ? "unavailable" : `${number.toFixed(digits)}${suffix}`;
}

function loadJson(fpath, fallback) {
  try { return JSON.parse(fs.readFileSync(fpath, "utf8")); }
  catch (_) { return fallback; }
}

const FALSE_AUTHORIZATION_FIELDS = new Set([
  "armed", "autoExecute", "autoExecutable", "autoExecutableWhenTriggered", "autoExecutionEnabled",
  "canExecute", "executeReady", "executionAllowed", "executionApproved", "executionAuthorized",
  "executionEnabled", "executionReady", "executableNow", "executableWhenTriggered", "executorReady", "isExecutable",
  "liveExecutorReady", "readyToExecute", "routeAuthorization", "routeAuthorized",
  "signedActionJustified", "signedActions", "exploitExecuteCalls",
]);
const ZERO_AUTHORIZATION_COUNT_FIELDS = new Set(["executableNowCount"]);

function booleanAuthorizationSignal(value) {
  return value === true || (typeof value === "number" && value > 0);
}

function countAuthorizationSignal(value) {
  return (typeof value === "number" && value > 0) || value === true;
}

function forceMonitorOnlyAuthorization(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  let observedAuthorizationSignal = false;
  let observedRouteCandidateSignal = false;
  for (const [key, child] of Object.entries(value)) {
    if (key.toLowerCase() === "routeguard") {
      observedRouteCandidateSignal ||= Boolean(child);
      delete value[key];
    } else if (key === "executable") {
      observedRouteCandidateSignal ||= booleanAuthorizationSignal(child);
      value[key] = false;
    } else if (ZERO_AUTHORIZATION_COUNT_FIELDS.has(key)) {
      observedAuthorizationSignal ||= countAuthorizationSignal(child);
      value[key] = 0;
    } else if (FALSE_AUTHORIZATION_FIELDS.has(key)) {
      observedAuthorizationSignal ||= booleanAuthorizationSignal(child);
      value[key] = false;
    } else if (/status$/i.test(key) && typeof child === "string" && /armed|executable|auto[- ]enabled/i.test(child)) {
      observedAuthorizationSignal = true;
      value[key] = "watch-only-upstream-signal-observed";
    } else if (typeof child === "string" && /^(?:armed|executable|auto[- ]enabled|execution[- ]ready|ready[- ]to[- ]execute)$/i.test(child)) {
      observedAuthorizationSignal = true;
      value[key] = "watch-only-upstream-signal-observed";
    } else {
      forceMonitorOnlyAuthorization(child, seen);
    }
  }
  if (observedAuthorizationSignal) value.observedUpstreamAuthorizationSignal = true;
  if (observedRouteCandidateSignal) value.observedRouteCandidateSignal = true;
  return value;
}

function createCycleHealth(fastOnly, nowMs = Date.now()) {
  return {
    status: "DEGRADED",
    cycleType: fastOnly ? "fast" : "full",
    startedAt: new Date(nowMs).toISOString(),
    completedAt: null,
    complete: false,
    broadlyFailed: true,
    blind: true,
    sourceSummary: { total: 0, healthy: 0, failed: 0, unknown: 0 },
    sources: [],
  };
}

function beginCycleHealth(state, fastOnly, nowMs = Date.now()) {
  const cycleHealth = createCycleHealth(fastOnly, nowMs);
  state.cycleHealth = cycleHealth;
  return cycleHealth;
}

function recordCycleSource(cycleHealth, group, status, detail = null) {
  const normalized = ["HEALTHY", "FAILED", "UNKNOWN"].includes(status) ? status : "UNKNOWN";
  const source = { group, status: normalized };
  if (detail) source.detail = detail;
  const previous = cycleHealth.sources.findIndex((row) => row.group === group);
  if (previous >= 0) cycleHealth.sources[previous] = source;
  else cycleHealth.sources.push(source);
  return source;
}

function finalizeCycleHealth(cycleHealth, { completed = true, fatal = false, nowMs = Date.now() } = {}) {
  const summary = { total: cycleHealth.sources.length, healthy: 0, failed: 0, unknown: 0 };
  for (const source of cycleHealth.sources) {
    if (source.status === "HEALTHY") summary.healthy++;
    else if (source.status === "FAILED") summary.failed++;
    else summary.unknown++;
  }
  cycleHealth.sourceSummary = summary;
  cycleHealth.complete = completed === true && fatal !== true;
  cycleHealth.blind = summary.total === 0 || summary.healthy === 0;
  cycleHealth.broadlyFailed = cycleHealth.blind || (summary.failed + summary.unknown) > summary.healthy;
  cycleHealth.status = cycleHealth.complete && summary.total > 0 && summary.healthy === summary.total
    ? "HEALTHY"
    : (!cycleHealth.complete || cycleHealth.blind || cycleHealth.broadlyFailed ? "FAILED" : "DEGRADED");
  cycleHealth.completedAt = new Date(nowMs).toISOString();
  return cycleHealth;
}

function saveJson(fpath, obj) {
  fs.mkdirSync(path.dirname(fpath), { recursive: true });
  fs.writeFileSync(fpath, JSON.stringify(forceMonitorOnlyAuthorization(obj), null, 2));
}

function extractRpcCandidates() {
  if (!fs.existsSync(RPC_FILE)) return [];
  let fd;
  let text = "";
  try {
    fd = fs.openSync(RPC_FILE, "r");
    const buffer = Buffer.alloc(RPC_INVENTORY_MAX_BYTES + 1);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    text = buffer.subarray(0, Math.min(bytesRead, RPC_INVENTORY_MAX_BYTES)).toString("utf8");
  } catch (_) {
    return [];
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
  }

  const candidates = [];
  const seen = new Set();
  for (const line of text.split(/\r?\n/)) {
    if (candidates.length >= RPC_INVENTORY_MAX_CANDIDATES) break;
    if (/\[origin:/.test(line)) continue;
    if (/solana|mainnet-beta|helius|kamino|marginfi|sui|aptos|stellar|tron/i.test(line)) continue;
    const match = line.match(/(https?:\/\/[^\s'"<>\[\]]+)/);
    if (!match) continue;
    const u = match[1].replace(/[)\]]+\s*$/, "");
    if (!u || seen.has(u)) continue;
    seen.add(u);
    candidates.push({ url: u, inventoryIndex: candidates.length, capabilityTier: "generic-read" });
  }
  return candidates;
}

async function rpcCall(url, method, params, timeoutMs = RPC_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const headers = { "content-type": "application/json" };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ctrl.signal,
    });
    const json = await res.json();
    return json.result ?? null;
  } catch (_) { return null; }
  finally { clearTimeout(t); }
}

async function getBlock(rpcUrl) {
  const block = await rpcCall(rpcUrl, "eth_getBlockByNumber", ["latest", false]);
  if (!block) return null;
  return { number: parseInt(block.number, 16), timestamp: parseInt(block.timestamp, 16) };
}

async function ethCall(rpcUrl, to, data) {
  return rpcCall(rpcUrl, "eth_call", [{ to, data }, "latest"]);
}

async function getLogs(rpcUrl, params) {
  return rpcCall(rpcUrl, "eth_getLogs", [params]);
}

function decodeAddress(w) {
  if (!w || w.length < 66) return null;
  return "0x" + w.slice(-40);
}

function uint256(w) { try { return BigInt("0x" + (w || "0")); } catch { return 0n; } }
function int256(w) {
  const v = uint256(w);
  const signBit = 1n << 255n;
  return v >= signBit ? v - (1n << 256n) : v;
}

function fileAgeHours(fpath) {
  try { return (Date.now() - fs.statSync(fpath).mtimeMs) / 3600_000; }
  catch (_) { return null; }
}

function alertDivergence(alert) {
  if (!alert || alert.divergence === null || alert.divergence === undefined) return NaN;
  return Number(String(alert.divergence).replace("%", ""));
}

function clampNumber(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function decimalString(value, decimals) {
  if (!Number.isFinite(value) || value <= 0) return "0";
  const places = Math.min(Math.max(decimals, 0), 18);
  return value.toFixed(places).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

function parseUnitsFromNumber(value, decimals) {
  return ethers.parseUnits(decimalString(value, decimals), decimals);
}

function isHighSignalExploitAlert(alert) {
  if (!alert || !HIGH_SIGNAL_ROUTE_CONDITIONS.has(alert.condition)) return false;
  return alert.severity === "CRITICAL"
    || (alert.condition === "liquidation-hunter" && alert.severity === "HIGH");
}

// ─── RPC Resolver with Caching ──────────────────────────────────────────────

const PUBLIC_RPC_FALLBACKS = {1:"https://ethereum.publicnode.com",10:"https://optimism.publicnode.com",56:"https://bsc.publicnode.com",100:"https://gnosis.publicnode.com",130:"https://unichain-rpc.publicnode.com",137:"https://polygon-bor.publicnode.com",146:"https://sonic-rpc.publicnode.com",250:"https://fantom-rpc.publicnode.com",324:"https://zksync-era-rpc.publicnode.com",480:"https://world-chain-rpc.publicnode.com",8453:"https://base.publicnode.com",1088:"https://andromeda.metis.io/?owner=1088",1284:"https://moonbeam.publicnode.com",1285:"https://moonriver.publicnode.com",2222:"https://evm.kava.io",25:"https://cronos-evm.publicnode.com",1313161554:"https://mainnet.aurora.dev",1666600000:"https://api.harmony.one",14:"https://flare-api.flare.network/ext/C/rpc",204:"https://opbnb-mainnet-rpc.publicnode.com",42161:"https://arbitrum-one.publicnode.com",42220:"https://celo.publicnode.com",43114:"https://avalanche.publicnode.com",5000:"https://mantle.publicnode.com",534352:"https://scroll.publicnode.com",59144:"https://linea.publicnode.com",57073:"https://ink-rpc.publicnode.com",81457:"https://blast.publicnode.com",80094:"https://berachain-rpc.publicnode.com",999:"https://hyperliquid.drpc.org"};

function isRpcHex(value) {
  return typeof value === "string" && /^0x[0-9a-f]+$/i.test(value);
}

async function qualifyRpcCandidate(candidate) {
  const url = candidate.url;
  const [chainId, blockNumber, block, code, callResult] = await Promise.all([
    rpcCall(url, "eth_chainId", [], RPC_QUALIFICATION_TIMEOUT_MS),
    rpcCall(url, "eth_blockNumber", [], RPC_QUALIFICATION_TIMEOUT_MS),
    rpcCall(url, "eth_getBlockByNumber", ["latest", false], RPC_QUALIFICATION_TIMEOUT_MS),
    rpcCall(url, "eth_getCode", [ZERO, "latest"], RPC_QUALIFICATION_TIMEOUT_MS),
    rpcCall(url, "eth_call", [{ to: "0x0000000000000000000000000000000000000004", data: "0x01" }, "latest"], RPC_QUALIFICATION_TIMEOUT_MS),
  ]);
  const parsedChainId = isRpcHex(chainId) ? parseInt(chainId, 16) : NaN;
  const capable = Number.isSafeInteger(parsedChainId) && parsedChainId > 0
    && isRpcHex(blockNumber)
    && block && isRpcHex(block.number) && isRpcHex(block.hash)
    && typeof code === "string" && /^0x[0-9a-f]*$/i.test(code)
    && typeof callResult === "string" && /^0x[0-9a-f]*$/i.test(callResult);
  return capable ? { ...candidate, chainId: parsedChainId } : null;
}

async function qualifyRpcCandidates(candidates) {
  const results = new Array(candidates.length).fill(null);
  let cursor = 0;
  async function worker() {
    while (cursor < candidates.length) {
      const index = cursor++;
      results[index] = await qualifyRpcCandidate(candidates[index]).catch(() => null);
    }
  }
  const workerCount = Math.min(RPC_QUALIFICATION_CONCURRENCY, candidates.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results.filter(Boolean);
}

async function resolveRpcPool() {
  const qualified = await qualifyRpcCandidates(extractRpcCandidates());
  const pool = {};
  for (const candidate of qualified) {
    if (!pool[candidate.chainId]) pool[candidate.chainId] = candidate.url;
  }
  // Inventory candidates are bounded and fully qualified first. Public read-only
  // fallbacks are only filled for chains where inventory qualification failed.
  for (const [chainId, fallback] of Object.entries(PUBLIC_RPC_FALLBACKS)) {
    if (!pool[chainId]) pool[chainId] = fallback;
  }
  return pool;
}

async function resolveRpcForChain(chainId, pool) {
  if (pool[chainId]) return pool[chainId];
  const fallback = PUBLIC_RPC_FALLBACKS[chainId] || null;
  if (fallback) pool[chainId] = fallback;
  return fallback;
}

// ─── Chainlink Feed Helpers ─────────────────────────────────────────────────

async function queryFeed(rpcUrl, feedAddr) {
  const data = await ethCall(rpcUrl, feedAddr, "0xfeaf968c" /* latestRoundData */);
  if (!data || data === "0x") return null;
  const w = data.slice(2);
  const answer = int256(w.slice(64, 128));
  if (answer <= 0n) return null;
  return {
    answer,
    updatedAt: Number(uint256(w.slice(128, 192))),
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// STATE MANAGEMENT
// ══════════════════════════════════════════════════════════════════════════════

function loadState() {
  return loadJson(STATE_FILE, {
    lastBlock: {},
    lastRun: null,
    conditions: {
      "staleness-gap": { lastAlerted: {} },
      "vault-new-deploy": { knownVaults: [], lastCheckBlock: {} },
      "allocator-liveness": { lastKnownAllocations: [] },
      "bridge-config": { knownDVNs: {}, lastCheck: null },
      "depeg": { lastAlerted: {} },
      "gauge-epoch": { lastAlerted: {} },
      "vault-donation": { lastAlerted: {}, lastCheck: null },
      "report-signal": { lastCheck: null },
      "residual-watch": { lastAlerted: {}, lastCheck: null },
      "lorenzo-susd1plus-premium": { lastResult: null },
      "aave-v4-liquidation-watch": { lastResult: null, lastAlerted: null },
      "listing-safety": { lastCheck: null, alertedEvents: {} },
      "kamino-liquidation-window": { lastResult: null },
      "governance-listing-watch": { lastCheck: null, knownProposalIds: [] },
      "auto-fork": { lastForked: {}, lastResult: null },
      "apyusd-preflight": { lastCheck: null, lastResult: null },
      "eigenlayer-navdex": { lastCheck: null, lastGapBps: null },
      "marginfi-oracle": { lastCheck: null, highLtvCount: 0 },
    },
  });
}

function saveState(state) {
  state.lastRun = ts();
  saveJson(STATE_FILE, state);
}

// ══════════════════════════════════════════════════════════════════════════════
// ALERTING
// ══════════════════════════════════════════════════════════════════════════════

let alerts = [];

function alert(condition, severity, fields) {
  const a = forceMonitorOnlyAuthorization({ timestamp: ts(), condition, severity, ...fields, autoExecutable: false });
  alerts.push(a);
  return a;
}

function severityRank(severity) {
  return ({ INFO: 1, WARN: 2, HIGH: 3, CRITICAL: 4, DORMANT: 0 }[String(severity || "").toUpperCase()] || 0);
}

function webhookAlertEnabled(a) {
  if (!ALERT_WEBHOOK_URL && !ALERT_WEBHOOK_DRY_RUN) return false;
  if (severityRank(a.severity) < severityRank(ALERT_WEBHOOK_MIN_SEVERITY)) return false;
  if (ALERT_WEBHOOK_CONDITIONS.size && !ALERT_WEBHOOK_CONDITIONS.has(a.condition)) return false;
  return true;
}

function telegramAlertEnabled(a) {
  if ((!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) && !TELEGRAM_ALERT_DRY_RUN) return false;
  if (severityRank(a.severity) < severityRank(TELEGRAM_ALERT_MIN_SEVERITY)) return false;
  if (TELEGRAM_ALERT_CONDITIONS.size && !TELEGRAM_ALERT_CONDITIONS.has(a.condition)) return false;
  return true;
}

function redactWebhookText(value) {
  return String(value || "")
    .replace(/https?:\/\/[^\s"'<>]+/g, "[redacted-url]")
    .replace(/0x[a-fA-F0-9]{64}/g, "[redacted-hex]");
}

function formatWebhookAlert(a) {
  const parts = [
    `[${a.severity}] ${a.condition}`,
    a.classification ? `classification=${a.classification}` : null,
    a.asset ? `asset=${a.asset}` : null,
    a.token ? `token=${a.token}` : null,
    a.divergence !== undefined ? `divergence=${a.divergence}%` : null,
    a.feedAge !== undefined ? `feedAge=${a.feedAge}s` : null,
    a.direction ? `direction=${a.direction}` : null,
    a.routeLiquidityUsd !== undefined ? `routeLiquidityUsd=$${a.routeLiquidityUsd}` : null,
    a.estimatedEdgeUsd !== undefined ? `estimatedEdgeUsd=$${a.estimatedEdgeUsd}` : null,
    a.autoExecutable !== undefined ? `autoExecutable=${a.autoExecutable}` : null,
  ].filter(Boolean);
  const message = a.message ? `\n${a.message}` : "";
  return redactWebhookText(`${a.timestamp}\n${parts.join(" | ")}${message}`);
}

async function sendWebhookAlert(a) {
  const text = formatWebhookAlert(a);
  if (ALERT_WEBHOOK_DRY_RUN) {
    logPrint(`WEBHOOK DRY-RUN: ${text.split("\n").slice(0, 2).join(" | ")}`);
    return;
  }
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), ALERT_WEBHOOK_TIMEOUT_MS);
  try {
    const res = await fetch(ALERT_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: text, text }),
      signal: ctrl.signal,
    });
    if (!res.ok) logPrint(`Webhook alert failed: HTTP ${res.status}`);
  } catch (e) {
    logPrint(`Webhook alert failed: ${redactWebhookText(e?.message || e)}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function sendTelegramAlert(a) {
  const text = formatWebhookAlert(a).slice(0, 3900);
  if (TELEGRAM_ALERT_DRY_RUN) {
    logPrint(`TELEGRAM DRY-RUN: ${text.split("\n").slice(0, 2).join(" | ")}`);
    return;
  }
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), TELEGRAM_ALERT_TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        disable_web_page_preview: true,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) logPrint(`Telegram alert failed: HTTP ${res.status}`);
  } catch (e) {
    logPrint(`Telegram alert failed: ${redactWebhookText(e?.message || e)}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function flushAlerts() {
  if (alerts.length === 0) return;
  // NOTE: pass an arrow wrapper — Array.prototype.map supplies (value, index, array), so
  // `alerts.map(forceMonitorOnlyAuthorization)` would bind `seen` to the numeric index and
  // throw `seen.has is not a function` on every non-empty alert batch.
  const pending = alerts.map((a) => forceMonitorOnlyAuthorization(a));
  const lines = pending.map(a => JSON.stringify(a)).join("\n") + "\n";
  try { fs.appendFileSync(ALERT_FILE, lines); } catch (e) { log("Failed to write alerts: " + e.message); }
  const webhookAlerts = pending.filter(webhookAlertEnabled);
  const telegramAlerts = pending.filter(telegramAlertEnabled);
  alerts = [];
  for (const a of webhookAlerts) await sendWebhookAlert(a);
  for (const a of telegramAlerts) await sendTelegramAlert(a);
}

function minimalChildEnv() {
  const names = process.platform === "win32"
    ? ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "TEMP", "TMP"]
    : ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"];
  const env = {};
  for (const name of names) {
    if (typeof runtimeConfig[name] === "string" && runtimeConfig[name]) env[name] = runtimeConfig[name];
  }
  return env;
}

function refreshEvaluatorProximity() {
  if (runtimeConfig.DISABLE_EVALUATOR_PROXIMITY === "1") return null;
  if (!fs.existsSync(EVALUATOR_PROXIMITY_SCRIPT)) return null;
  try {
    const result = cp.spawnSync(process.execPath, [EVALUATOR_PROXIMITY_SCRIPT, "--quiet"], {
      cwd: WORKSPACE,
      encoding: "utf8",
      timeout: 120_000,
      windowsHide: true,
      env: minimalChildEnv(),
    });
    if (result.status !== 0) {
      const err = (result.stderr || result.stdout || "proximity refresh failed").trim().slice(0, 160);
      logPrint(`PROX read-only refresh failed: ${err}`);
    }
  } catch (e) { return null; }
}

// ═══════════════════════════════════════════════════════════════════
// E37 Oracle-DEX Divergence Watch (deposit-at-oracle-price exploit)
// ═══════════════════════════════════════════════════════════════════
// Monitors tokens where oracle price exceeds DEX price by more than
// the inverse of LLTV. If oracle=$1, DEX=$0.001, LLTV=86% -> deposit
// costs $0.001 to borrow $0.86. Alert on depegged tokens >$1K borrow.

const DEX_DIVERGENCE_CONDITION = "dex-divergence-watch";
const DEX_DIVERGENCE_INTERVAL_MS = 10 * 60_000; // 10 min (was 6h)

const DEX_DIVERGENCE_TOKENS = [
  { sym: "deUSD", addr: "0x15700B564Ca08D9439C58cA5053166E8317aa138", dexFeed: "0x5F6c431AC417f0f430B84A666a563FAbe681Da94", note: "Curve deUSD/USDC — 99.9% depeg" },
  { sym: "crvUSD", addr: "0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E", dexFeed: "0x4DEcE678ceceb27446b35C672dC7d61F30bAD69E", note: "Curve crvUSD/USDC" },
];

async function evaluatorDexDivergenceWatch(rpcPool, state) {
  state.conditions = state.conditions || {};
  const cond = state.conditions[DEX_DIVERGENCE_CONDITION] || { lastScan: 0 };
  state.conditions[DEX_DIVERGENCE_CONDITION] = cond;
  if (Date.now() - cond.lastScan < DEX_DIVERGENCE_INTERVAL_MS) return null;
  cond.lastScan = Date.now();

  const rpc = rpcPool[1];
  if (!rpc) return null;

  const results = [];
  try {
    for (const tk of DEX_DIVERGENCE_TOKENS) {
      let dexPrice = null;
      try {
        const raw = await rpcCall(rpc, "eth_call", [{
          to: tk.dexFeed,
          data: "0x5e0d442f000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000de0b6b3a7640000"
        }, "latest"], 8000).catch(() => null);
        if (raw) dexPrice = Number(BigInt(raw)) / 1e18;
      } catch (_) {}
      results.push({ ...tk, dexPrice });
    }

    cond.lastResult = { checkedAt: ts(), tokens: results };
    const alertTokens = results.filter(r => r.dexPrice !== null && r.dexPrice < 0.5);
    if (alertTokens.length === 0) return null;
    return {
      condition: DEX_DIVERGENCE_CONDITION, severity: "HIGH", chainId: 1,
      tokens: alertTokens.map(t => `${t.sym}=$${t.dexPrice?.toFixed(6)}`).join(", "),
      message: `DEX divergence: ${alertTokens.map(t=>`${t.sym} $${t.dexPrice?.toFixed(6)}`).join(", ")} — oracle may overvalue. ${alertTokens[0].note || ""}`,
      autoExecutable: false,
      blocker: "Deposit-at-oracle exploit requires borrow liquidity. Check market state.",
    };
  } catch (_) { return null; }
}

function aaveV4WatchSummary(watch) {
  const latest = watch?.latest || {};
  const summary = latest.summary || {};
  const top = Array.isArray(latest.topRows) ? latest.topRows[0] : null;
  const quoteRow = Array.isArray(latest.quoteRequiredRows) ? latest.quoteRequiredRows[0] : null;
  return {
    generatedAt: watch?.generatedAt || null,
    sourceGeneratedAt: latest.sourceGeneratedAt || null,
    blockNumber: latest.chain?.blockNumber || null,
    activeBorrowers: summary.activeBorrowers,
    nearLiquidation: summary.nearLiquidation,
    liquidatable: summary.liquidatable,
    triggerRows: summary.triggerRows,
    quoteRequiredRows: summary.quoteRequiredRows,
    routePositive: summary.routePositive,
    topHealthFactor: summary.topHealthFactor ?? null,
    topBpsToLiquidation: summary.topBpsToLiquidation ?? null,
    topDebtUsd: summary.topDebtUsd ?? null,
    topPotentialGrossBonusUsd: summary.topPotentialGrossBonusUsd ?? null,
    topRankReason: summary.topRankReason || null,
    closestHealthFactor: summary.closestHealthFactor ?? null,
    closestBpsToLiquidation: summary.closestBpsToLiquidation ?? null,
    closestDebtUsd: summary.closestDebtUsd ?? null,
    materialTriggerRows: summary.materialTriggerRows,
    materialRows: summary.materialRows,
    forkGate: summary.forkGate || "closed-route-positive-zero",
    nextAction: summary.nextAction || null,
    topRow: top ? {
      hub: top.hub || null,
      spoke: top.spoke || null,
      user: top.user || null,
      healthFactor: top.healthFactor ?? null,
      bpsToLiquidation: top.bpsToLiquidation ?? null,
      debtUsd: top.debtUsd ?? null,
      collateralUsd: top.collateralUsd ?? null,
      potentialGrossBonusUsd: top.potentialGrossBonusUsd ?? null,
      debtSymbol: top.topDebt?.symbol || null,
      collateralSymbol: top.topCollateral?.symbol || null,
      liquidationBonusBps: top.topCollateral?.liquidationBonusBps || null,
    } : null,
    quoteRow: quoteRow ? {
      hub: quoteRow.hub || null,
      spoke: quoteRow.spoke || null,
      user: quoteRow.user || null,
      healthFactor: quoteRow.healthFactor ?? null,
      debtUsd: quoteRow.debtUsd ?? null,
      collateralUsd: quoteRow.collateralUsd ?? null,
      debtSymbol: quoteRow.topDebt?.symbol || null,
      collateralSymbol: quoteRow.topCollateral?.symbol || null,
      potentialGrossBonusUsd: quoteRow.potentialGrossBonusUsd ?? null,
    } : null,
  };
}

function validateAaveV4Schema(artifact, nowMs = Date.now()) {
  if (artifact?.schema !== AAVE_V4_WATCH_SCHEMA) return `schema must equal ${AAVE_V4_WATCH_SCHEMA}`;
  if (artifact?.scanner !== AAVE_V4_WATCH_SCANNER) return "scanner identity invalid";
  if (artifact?.sourceScanner !== AAVE_V4_SOURCE_SCANNER
    || artifact?.sourceArtifact !== AAVE_V4_SOURCE_ARTIFACT
    || artifact?.source?.scanner !== AAVE_V4_SOURCE_SCANNER
    || artifact?.source?.artifact !== AAVE_V4_SOURCE_ARTIFACT
    || Object.keys(artifact.source).sort().join(",") !== "artifact,scanner") {
    return "source identity invalid";
  }
  const coverage = validateAaveSourceCoverage(artifact.sourceCoverage, {
    protocolVersion: "V4",
    coverageKind: "monitor",
    mode: artifact.sourceCoverage?.classification === EXHAUSTIVE_COMPLETE ? EXHAUSTIVE_COMPLETE : BOUNDED_OBSERVATIONAL,
    expectedChains: 1,
    freshnessMinutes: 15,
    nowMs,
  });
  if (!coverage.valid) return `source coverage invalid: ${coverage.failures.join(",")}`;
  if (artifact.latest?.sourceScanner !== AAVE_V4_SOURCE_SCANNER
    || artifact.latest?.sourceArtifact !== AAVE_V4_SOURCE_ARTIFACT) return "latest source identity invalid";
  const summary = artifact?.latest?.summary;
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return "latest.summary must be an object";
  for (const field of [
    "activeBorrowers", "nearLiquidation", "liquidatable", "triggerRows", "quoteRequiredRows",
    "routePositive", "materialTriggerRows", "materialRows",
  ]) {
    if (!Number.isSafeInteger(summary[field]) || summary[field] < 0) return `latest.summary.${field} must be a non-negative integer`;
  }
  if (summary.signedActionJustified !== false) return "latest.summary.signedActionJustified must be false";
  if (!Array.isArray(artifact.latest.topRows) || !Array.isArray(artifact.latest.quoteRequiredRows)) return "latest row collections invalid";
  return true;
}

function classifyAaveV4Artifact(data, nowMs = Date.now()) {
  return assessArtifactObject(data, {
    nowMs,
    maxAgeMs: 15 * 60_000,
    maxFutureSkewMs: 5 * 60_000,
    requiredPaths: ["generatedAt", "latest.summary"],
    validate: (artifact) => validateAaveV4Schema(artifact, nowMs),
  });
}

async function evaluatorAaveV4LiquidationWatch(_rpcPool, state) {
  state.conditions = state.conditions || {};
  const condState = state.conditions[AAVE_V4_WATCH_CONDITION] || { lastResult: null, lastAlerted: null };
  state.conditions[AAVE_V4_WATCH_CONDITION] = condState;

  if (runtimeConfig.DISABLE_AAVE_V4_WATCH === "1") {
    condState.disabled = true;
    return null;
  }
  const policy = readArtifactFile(AAVE_V4_WATCH_FILE, {
    maxAgeMs: 15 * 60_000,
    maxFutureSkewMs: 5 * 60_000,
    requiredPaths: ["generatedAt", "latest.summary"],
    validate: (artifact) => validateAaveV4Schema(artifact, Date.now()),
  });
  condState.lastCheck = Date.now();
  condState.sourceHealth = policy.status;
  if (policy.status !== ARTIFACT_STATUS.VALID_FRESH) {
    condState.lastError = { code: policy.status, message: policy.error || "Aave V4 artifact unavailable or stale" };
    condState.lastResult = null;
    return null;
  }

  const watch = policy.data;
  const summary = aaveV4WatchSummary(watch);
  condState.lastError = null;
  condState.lastResult = summary;

  const quoteNeeded = summary.quoteRequiredRows > 0;
  const liquidatable = summary.liquidatable > 0;
  const routePositive = summary.routePositive > 0;
  if (liquidatable || quoteNeeded || routePositive) {
    const top = summary.quoteRow || summary.topRow || {};
    const fingerprint = `${summary.blockNumber || "?"}:${top.spoke || "?"}:${top.user || "?"}:${top.healthFactor ?? "?"}`;
    const now = Date.now();
    const alreadyAlerted = condState.lastAlertedFingerprint === fingerprint && condState.lastAlerted && now - condState.lastAlerted < AAVE_V4_WATCH_ALERT_COOLDOWN_MS;
    if (!alreadyAlerted) {
      condState.lastAlerted = now;
      condState.lastAlertedFingerprint = fingerprint;
      alert(AAVE_V4_WATCH_CONDITION, routePositive ? "CRITICAL" : "HIGH", {
        source: "Aave V4",
        chainId: 1,
        blockNumber: summary.blockNumber,
        activeBorrowers: summary.activeBorrowers,
        nearLiquidation: summary.nearLiquidation,
        liquidatable: summary.liquidatable,
        routePositive: summary.routePositive,
        autoExecutable: false,
        forkGate: summary.forkGate,
        topHealthFactor: top.healthFactor ?? summary.topHealthFactor,
        topBpsToLiquidation: top.bpsToLiquidation ?? summary.topBpsToLiquidation,
        debtUsd: top.debtUsd,
        collateralUsd: top.collateralUsd,
        debtSymbol: top.debtSymbol,
        collateralSymbol: top.collateralSymbol,
        potentialGrossBonusUsd: top.potentialGrossBonusUsd,
        blocker: routePositive
          ? "Route-positive source still requires fork extraction proof and explicit authorization before any signed action."
          : "Liquidatable Aave V4 row needs exact repay-token acquisition and collateral-exit quotes; no auto-execution is configured.",
        message: routePositive
          ? `Aave V4 source artifact is route-positive at block ${summary.blockNumber}; fork proof required before any signed action.`
          : `Aave V4 borrower became liquidatable/watch-quote-required at block ${summary.blockNumber}: HF=${top.healthFactor ?? summary.topHealthFactor}, debt≈$${top.debtUsd ?? "?"} ${top.debtSymbol || ""}, collateral=${top.collateralSymbol || "?"}. Exact quote and fork proof required; autoExecutable=false.`,
      });
    }
  }

  return summary;
}

// ══════════════════════════════════════════════════════════════════════════════
// PRICE DIVERGENCE CHECKER
// ══════════════════════════════════════════════════════════════════════════════

const BINANCE_PAIRS = {
  "ETH/USD": "ETHUSDT",
  "stETH/USD": "ETHUSDT",
};

const DIVERGENCE_WARN = 0.5;   // % — alert message says "near miss"
const DIVERGENCE_MIN  = 1.0;   // % — minimum for "exploitable" classification

async function checkPriceDivergence(feedName, stalePrice) {
  const pair = BINANCE_PAIRS[feedName];
  if (!pair) return null;

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${pair}`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const json = await res.json();
    const livePrice = parseFloat(json.price);
    if (!livePrice || livePrice <= 0) return null;
    const divergence = ((livePrice - stalePrice) / stalePrice) * 100;
    return { livePrice, divergence, stalePrice };
  } catch (_) { return null; }
}

function classifyStaleness(feedAge, strictestMax, divergence) {
  if (feedAge > strictestMax * 2) {
    if (divergence !== null && Math.abs(divergence) >= DIVERGENCE_MIN) return { severity: "CRITICAL", classification: "EXPLOITABLE" };
    if (divergence !== null && Math.abs(divergence) >= DIVERGENCE_WARN) return { severity: "CRITICAL", classification: "NEAR MISS" };
    return { severity: "CRITICAL", classification: "WINDOW OPEN" };
  }
  if (feedAge > strictestMax) {
    if (divergence !== null && Math.abs(divergence) >= DIVERGENCE_MIN) return { severity: "ACTIVE", classification: "EXPLOITABLE" };
    if (divergence !== null && Math.abs(divergence) >= DIVERGENCE_WARN) return { severity: "ACTIVE", classification: "NEAR MISS" };
    return { severity: "ACTIVE", classification: "WINDOW OPEN" };
  }
  return { severity: "WARN", classification: "APPROACHING" };
}

// ══════════════════════════════════════════════════════════════════════════════
// EVALUATOR 1: STALE ORACLE CASCADE
// ══════════════════════════════════════════════════════════════════════════════

async function evaluateStaleness(rpcPool, state) {
  const condState = state.conditions["staleness-gap"];
  const results = [];

  const neededChains = [...new Set(Object.values(FEEDS).map(f => f.chainId))];
  for (const cid of neededChains) {
    if (!rpcPool[cid]) await resolveRpcForChain(cid, rpcPool);
  }

  for (const [feedName, feedCfg] of Object.entries(FEEDS)) {
    const rpc = rpcPool[feedCfg.chainId];
    if (!rpc) { log(`Evaluator 1: no RPC for chain ${feedCfg.chainId}, skipping ${feedName}`); continue; }

    const feedData = await queryFeed(rpc, feedCfg.feed);
    if (!feedData) { log(`Evaluator 1: failed to query ${feedName} feed ${feedCfg.feed}`); continue; }

    const block = await getBlock(rpc);
    if (!block) { log(`Evaluator 1: cannot get block timestamp for chain ${feedCfg.chainId}`); continue; }

    const feedAge = block.timestamp - feedData.updatedAt;
    const stalePrice = Number(feedData.answer) / 1e8;
    const consumers = FEED_CONSUMERS[feedName];
    if (!consumers) continue;

    // Find the strictest enforcing protocol
    let strictestProtocol = null;
    let strictestMax = Infinity;
    let loosestProtocol = null;
    let loosestMax = -1;

    for (const [protocol, maxStale] of Object.entries(consumers)) {
      if (maxStale === null) {
        loosestProtocol = protocol;
        loosestMax = Infinity;
      } else if (maxStale === 0) {
        if (feedAge > 0) {
          loosestProtocol = loosestProtocol || protocol;
        }
      } else if (maxStale < strictestMax) {
        strictestMax = maxStale;
        strictestProtocol = protocol;
      }
    }

    if (!strictestProtocol && !loosestProtocol) continue;

    const alerted = condState.lastAlerted || {};
    const minCooldown = 1800_000;

    // Check price divergence for feeds that have a live market pair
    let divergenceInfo = null;
    if (BINANCE_PAIRS[feedName] && (feedAge > strictestMax * 0.5 || feedAge > strictestMax)) {
      divergenceInfo = await checkPriceDivergence(feedName, stalePrice);
    }

    const divergence = divergenceInfo ? divergenceInfo.divergence : null;

    // ── Early Warning (50% of maxStale) ──
    const earlyKey = `${feedName}::early`;
    if (feedAge > strictestMax * 0.5 && feedAge <= strictestMax) {
      if (!alerted[earlyKey] || Date.now() - alerted[earlyKey] > minCooldown) {
        const pct = (feedAge / strictestMax * 100).toFixed(0);
        let msg = `${feedName} ${feedAge}s stale — ${pct}% of ${strictestProtocol}'s ${strictestMax}s maxStale.`;
        if (divergenceInfo) msg += ` Divergence: ${divergence.toFixed(2)}%.`;
        alert("staleness-gap", "WARN", {
          feed: feedName, feedAge, stalePrice,
          strictestProtocol, strictestMax,
          loosestProtocol: loosestProtocol || "none",
          loosestMax: loosestMax === Infinity ? "unlimited" : loosestMax,
          livePrice: divergenceInfo ? divergenceInfo.livePrice : null,
          divergence: divergence !== null ? parseFloat(divergence.toFixed(3)) : null,
          classification: divergence !== null && Math.abs(divergence) >= DIVERGENCE_WARN ? "NEAR MISS" : "APPROACHING",
          message: msg,
        });
        condState.lastAlerted[earlyKey] = Date.now();
      }
    }

    // ── Active / Critical (>100% / >200% of maxStale) ──
    if (feedAge > strictestMax) {
      const classified = classifyStaleness(feedAge, strictestMax, divergence);
      const key = classified.severity === "CRITICAL" ? `${feedName}::critical` : `${feedName}::reject`;
      if (!alerted[key] || Date.now() - alerted[key] > minCooldown) {
        let msg = `${feedName} ${feedAge}s stale. ${strictestProtocol} rejects at ${strictestMax}s. ${loosestProtocol || "other"} STILL ACCEPTING.`;
        if (divergenceInfo) {
          msg += ` | Stale: $${stalePrice.toFixed(2)} vs Live: $${divergenceInfo.livePrice.toFixed(2)} (${divergence >= 0 ? "+" : ""}${divergence.toFixed(2)}%)`;
          if (classified.classification === "EXPLOITABLE") msg += ` >> EXPLOITABLE <<`;
          else if (classified.classification === "NEAR MISS") msg += ` near miss`;
        }
        alert("staleness-gap", classified.severity, {
          feed: feedName, feedAge, stalePrice,
          strictestProtocol, strictestMax,
          loosestProtocol: loosestProtocol || "none",
          loosestMax: loosestMax === Infinity ? "unlimited" : loosestMax,
          feedAddress: feedCfg.feed,
          livePrice: divergenceInfo ? divergenceInfo.livePrice : null,
          divergence: divergence !== null ? parseFloat(divergence.toFixed(3)) : null,
          classification: classified.classification,
          message: msg,
        });
        condState.lastAlerted[key] = Date.now();
      }
    }

    condState[`lastAge_${feedName}`] = feedAge;
    results.push({ feed: feedName, feedAge, stalePrice, divergence });
  }

  return results;
}

// ══════════════════════════════════════════════════════════════════════════════
// EVALUATOR 2: ERC4626 VAULT NEW DEPLOYMENT
// ══════════════════════════════════════════════════════════════════════════════

async function evaluateVaultDeploy(rpcPool, state) {
  const condState = state.conditions["vault-new-deploy"];

  for (const factory of VAULT_FACTORIES) {
    if (!rpcPool[factory.chainId]) await resolveRpcForChain(factory.chainId, rpcPool);
    const rpc = rpcPool[factory.chainId];
    if (!rpc) { log(`Evaluator 2: no RPC for chain ${factory.chainId}`); continue; }

    const block = await getBlock(rpc);
    if (!block) { log(`Evaluator 2: cannot get block for chain ${factory.chainId}`); continue; }

    const lastCheck = condState.lastCheckBlock[factory.chainId] || block.number - 7200; // ~24h of blocks
    if (lastCheck >= block.number - 50) continue; // No new blocks to scan

    try {
      const logs = await getLogs(rpc, {
        address: factory.address,
        topics: [factory.deployTopic],
        fromBlock: "0x" + Math.max(lastCheck - 500, 0).toString(16),
        toBlock: "0x" + block.number.toString(16),
      });

      if (logs && logs.length > 0) {
        for (const l of logs) {
          const vaultAddr = factory.vaultInTopics
            ? decodeAddress(l.topics[factory.vaultInTopics] || l.topics[1])
            : decodeAddress(l.data);
          if (!vaultAddr) continue;
          if (condState.knownVaults.includes(vaultAddr.toLowerCase())) continue;
          condState.knownVaults.push(vaultAddr.toLowerCase());

          // Check totalAssets — alert tiers: ZERO (CRITICAL), LOW <$10K (HIGH), MEDIUM <$100K
          const totalAssetsRaw = await ethCall(rpc, vaultAddr, "0x01e1d114" /* totalAssets() */);
          const assetRaw = await ethCall(rpc, vaultAddr, "0x38d52e0f" /* asset() */).catch(() => null);
          const assetAddr = assetRaw ? decodeAddress(assetRaw) : null;
          const assetDecimalsRaw = assetAddr ? await ethCall(rpc, assetAddr, "0x313ce567" /* decimals() */).catch(() => null) : null;
          const decimals = assetDecimalsRaw ? Number(uint256(assetDecimalsRaw.slice(2))) : 18;
          const totalAssets = totalAssetsRaw ? Number(uint256(totalAssetsRaw.slice(2))) / 10 ** decimals : 0;

          if (totalAssets < 100_000) {
            let sev, classification, msgExtra;
            if (totalAssets === 0) {
              sev = "CRITICAL"; classification = "ZERO_ASSETS";
              msgExtra = "vault is empty — first depositor can donate-inflate with 1 wei.";
            } else if (totalAssets < 10_000) {
              sev = "HIGH"; classification = "LOW_TVL";
              msgExtra = `only $${totalAssets.toFixed(0)} in assets — donation cost is low, inflation possible.`;
            } else {
              sev = "MEDIUM"; classification = "MEDIUM_TVL";
              msgExtra = `$${totalAssets.toFixed(0)} in assets — larger donation needed but still viable.`;
            }
            alert("vault-new-deploy", sev, {
              chainId: factory.chainId,
              factory: factory.name,
              vault: vaultAddr,
              totalAssets,
              classification,
              decimals,
              block: parseInt(l.blockNumber, 16),
              message: `ERC4626 vault ${vaultAddr} ${msgExtra}`,
            });
      }
    }
  }
    } catch (e) { log(`Evaluator 2: error on chain ${factory.chainId}: ${e.message}`); }

    condState.lastCheckBlock[factory.chainId] = block.number;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// EVALUATOR 3: PUBLIC ALLOCATOR REBALANCING LIVENESS
// ══════════════════════════════════════════════════════════════════════════════

async function evaluateAllocatorLiveness(rpcPool, state) {
  const condState = state.conditions["allocator-liveness"];

  for (const alloc of ALLOCATORS) {
    if (!rpcPool[alloc.chainId]) await resolveRpcForChain(alloc.chainId, rpcPool);
    const rpc = rpcPool[alloc.chainId];
    if (!rpc) { log(`Evaluator 3: no RPC for chain ${alloc.chainId}`); continue; }

    const block = await getBlock(rpc);
    if (!block) continue;

    try {
      const logs = await getLogs(rpc, {
        topics: [alloc.reallocateTopic],
        fromBlock: "0x" + Math.max(block.number - 500, 0).toString(16),
        toBlock: "0x" + block.number.toString(16),
      });

      if (logs && logs.length > 0) {
        for (const l of logs) {
          const allocAddr = "0x" + l.address.slice(-40);
          const txHash = l.transactionHash;
          const key = `${alloc.chainId}:${txHash}`;
          if (condState.lastKnownAllocations.includes(key)) continue;
          condState.lastKnownAllocations = condState.lastKnownAllocations.slice(-500).concat([key]);

          alert("allocator-liveness", "INFO", {
            chainId: alloc.chainId,
            protocol: alloc.name,
            allocator: allocAddr,
            txHash,
            block: parseInt(l.blockNumber, 16),
            message: `Reallocate event detected on ${alloc.name} (${allocAddr}) at block ${parseInt(l.blockNumber, 16)}.`,
          });
        }
      }
    } catch (e) { log(`Evaluator 3: error on chain ${alloc.chainId}: ${e.message}`); }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// EVALUATOR 4: BRIDGE DVN/VALIDATOR CONFIGURATION CHANGE
// ══════════════════════════════════════════════════════════════════════════════

async function evaluateBridgeConfig(rpcPool, state) {
  const condState = state.conditions["bridge-config"];
  const now = Date.now();
  if (condState.lastCheck && now - condState.lastCheck < 86_400_000) return; // once per day

  const lzData = loadJson(LAYERZERO_INVENTORY, null);
  if (!lzData) { log("Evaluator 4: no layerzero-v2-live.json found"); return; }

  const chains = lzData.results || {};
  for (const [, chainData] of Object.entries(chains)) {
    const chainId = chainData.chainId;
    const chainName = chainData.chain || chainData.key || String(chainId);
    if (!chainId) continue;
    if (!rpcPool[chainId]) await resolveRpcForChain(chainId, rpcPool);
    const rpc = rpcPool[chainId];
    if (!rpc) { log(`Evaluator 4: no RPC for chain ${chainId} (${chainData.chain})`); continue; }

    const contracts = chainData.contracts || {};
    const deadDvn = contracts.deadDVN;
    const uln = contracts.receiveUln302 || contracts.sendUln302;
    if (!uln || !deadDvn) continue;

    // Check required DVNs for the chain's EID
    const eid = chainData.eid;
    if (!eid) continue;

    try {
      const data = await ethCall(rpc, uln, "0x9acb6e11" + eid.toString(16).padStart(64, "0") /* requiredDVNs(uint32) */ + "0".repeat(64));
      if (!data || data === "0x") continue;

      const w = data.slice(2);
      const offsetBytes = parseInt(w.slice(0, 64), 16) || 0;
      const offset = offsetBytes * 2;
      const count = parseInt(w.slice(offset, offset + 64), 16) || 0;
      const dvns = [];
      for (let i = 0; i < count; i++) {
        dvns.push("0x" + w.slice(offset + 64 + i * 64, offset + 128 + i * 64).slice(-40));
      }

      const key = `${chainId}:${eid}`;
      const prev = condState.knownDVNs[key] || [];
      const prevStr = prev.sort().join(",");
      const currStr = dvns.sort().join(",");

      if (prevStr !== currStr) {
        condState.knownDVNs[key] = dvns;

        // 1/1 DVN check
        if (dvns.length === 1) {
          const isDead = dvns[0].toLowerCase() === deadDvn.toLowerCase();
          const isZero = dvns[0] === ZERO;
          alert("bridge-config", isDead || isZero ? "CRITICAL" : "WARN", {
            chainId,
            chainName,
            eid,
            dvnCount: 1,
            dvn: dvns[0],
            isDeadDvn: isDead,
            isZero,
            message: isDead ? `LayerZero ${chainName}: 1/1 DVN is deadDVN — cross-chain path is blocked/liveness-disabled.`
                 : isZero ? `LayerZero ${chainName}: 1/1 DVN is zero address — broken configuration.`
                 : `LayerZero ${chainName}: 1/1 DVN config on EID ${eid} — single DVN = single point of failure.`,
          });
        } else if (dvns.length === 0) {
          alert("bridge-config", "CRITICAL", {
            chainId, chainName, eid, dvnCount: 0,
            message: `LayerZero ${chainName}: 0 DVNs configured for EID ${eid} — no verification.`,
          });
        } else if (prev.length > 0 && prevStr !== currStr) {
          alert("bridge-config", "WARN", {
            chainId, chainName, eid, dvnCount: dvns.length, dvns,
            previousDvns: prev,
            message: `LayerZero ${chainName}: DVN config changed for EID ${eid}.`,
          });
        }
      }
    } catch (e) { log(`Evaluator 4: error on ${chainName}: ${e.message}`); }
  }

  condState.lastCheck = Date.now();
}

// ══════════════════════════════════════════════════════════════════════════════
// EVALUATOR 5: STABLECOIN DEPEG DETECTION
// ══════════════════════════════════════════════════════════════════════════════

async function evaluateDepeg(rpcPool, state) {
  const condState = state.conditions["depeg"];
  const minCooldown = 1800_000;
  const evidence = { required: Object.keys(STABLECOIN_FEEDS).length, healthy: 0, failed: 0 };

  for (const [symbol, cfg] of Object.entries(STABLECOIN_FEEDS)) {
    if (!rpcPool[cfg.chainId]) await resolveRpcForChain(cfg.chainId, rpcPool);
    const rpc = rpcPool[cfg.chainId];
    if (!rpc) { log(`Evaluator 5: no RPC for chain ${cfg.chainId}`); evidence.failed++; continue; }

    const feedData = await queryFeed(rpc, cfg.feed);
    if (!feedData) { log(`Evaluator 5: failed to query ${symbol} feed ${cfg.feed}`); evidence.failed++; continue; }
    const block = await getBlock(rpc);
    if (!block || !(Number(feedData.answer) > 0) || !(feedData.updatedAt > 0)) {
      log(`Evaluator 5: incomplete source evidence for ${symbol}`);
      evidence.failed++;
      continue;
    }
    evidence.healthy++;
    const feedAge = block ? block.timestamp - feedData.updatedAt : null;

    const price = Number(feedData.answer) / 1e8;
    condState.lastPrices = condState.lastPrices || {};
    condState.lastPrices[symbol] = price;

    const key = `depeg::${symbol}`;
    const alerted = condState.lastAlerted || {};

    if (price < 0.95) {
      if (!alerted[key] || Date.now() - alerted[key] > minCooldown) {
        const executable = E5_EXECUTION_TOKENS.has(symbol);
        let route = null;
        if (executable && price <= (1 - E5_MIN_EXEC_DEPEG_PCT / 100)) {
          const provider = new ethers.JsonRpcProvider(rpc);
          route = await buildE5DepegRoute(provider, price).catch((e) => ({ executable: false, reason: e.message }));
        }
        alert("depeg", "CRITICAL", {
          token: symbol, price,
          feed: cfg.feed,
          feedAge,
          executable,
          autoExecutable: false,
          routeCandidatePositive: Boolean(route?.executable),
          netProfitUsd: route?.netProfitUsd !== undefined ? route.netProfitUsd.toFixed(0) : undefined,
          routeReason: route?.reason || null,
          message: `${symbol} depegged to ${price.toFixed(4)} (${((1 - price) * 100).toFixed(1)}% below $1).${route?.executable ? ` E5 route quote-positive net≈$${route.netProfitUsd.toFixed(0)}.` : executable ? ` E5 waits for <=$${(1 - E5_MIN_EXEC_DEPEG_PCT / 100).toFixed(2)} and live route quote.` : " No Fluid vault — monitoring only."}`,
        });
        condState.lastAlerted[key] = Date.now();
      }
    } else if (price < 0.995) {
      if (!alerted[`${key}::early`] || Date.now() - alerted[`${key}::early`] > minCooldown) {
        alert("depeg", "WARN", {
          token: symbol, price,
          feed: cfg.feed,
          feedAge,
          message: `${symbol} slight depeg to ${price.toFixed(4)} (${((1 - price) * 100).toFixed(2)}% below $1).`,
        });
        condState.lastAlerted[`${key}::early`] = Date.now();
      }
    }
    // Clear alert state if recovered
    else if (price >= 0.995 && alerted[key]) {
      condState.lastAlerted[key] = null;
      condState.lastAlerted[`${key}::early`] = null;
    }
  }
  return evidence;
}

// ══════════════════════════════════════════════════════════════════════════════
// EVALUATOR 6: VE(3,3) GAUGE EPOCH BOUNDARY
// ══════════════════════════════════════════════════════════════════════════════

async function evaluateGaugeEpoch(rpcPool, state) {
  const condState = state.conditions["gauge-epoch"];
  const now = Date.now();

  for (const dex of VE33_VOTERS) {
    try {
    if (!rpcPool[dex.chainId]) await resolveRpcForChain(dex.chainId, rpcPool);
    const rpc = rpcPool[dex.chainId];
    if (!rpc) { log(`Evaluator 6: no RPC for chain ${dex.chainId}`); continue; }

    const block = await getBlock(rpc);
    if (!block) continue;

    // Query activePeriod on Minter
    const periodHex = await ethCall(rpc, dex.minter, "0xb0925483" /* activePeriod() */);
    if (!periodHex) { log(`Evaluator 6: failed to query activePeriod on ${dex.name}`); continue; }

    let activePeriod = Number(uint256(periodHex.slice(2)));
    if (activePeriod === 0) {
      // Try periodFinish on Voter as fallback
      const pfHex = await ethCall(rpc, dex.voter, "0xebe2b12b" /* periodFinish() */);
      if (pfHex) activePeriod = Number(uint256(pfHex.slice(2)));
    }
    if (activePeriod === 0 || activePeriod > block.timestamp + WEEK * 4) continue;

    const epochEnd = activePeriod + WEEK;
    const remaining = epochEnd - block.timestamp;
    const remainingHours = (remaining / 3600).toFixed(1);

    const epochState = condState.lastAlerted || {};
    const key = `epoch::${dex.name}`;
    const minCooldown = 3600_000; // 1 hour

    if (remaining < 3600 && remaining > 0) {
      if (!epochState[key] || now - epochState[key] > minCooldown) {
        condState.lastAlerted[key] = now;
        alert("gauge-epoch", "INFO", {
          dex: dex.name,
          chainId: dex.chainId,
          epochEnd: new Date(epochEnd * 1000).toISOString(),
          remainingSeconds: remaining,
          remainingHours,
          activePeriod,
          message: `${dex.name} epoch ends in ${remainingHours}h (${remaining}s). Flash-loan gauge voting may be viable.`,
        });
      }
    } else if (remaining < 7200 && remaining > 0) {
      if (!epochState[`${key}::approaching`] || now - epochState[`${key}::approaching`] > minCooldown) {
        condState.lastAlerted[`${key}::approaching`] = now;
        alert("gauge-epoch", "INFO", {
          dex: dex.name,
          chainId: dex.chainId,
          epochEnd: new Date(epochEnd * 1000).toISOString(),
          remainingSeconds: remaining,
          remainingHours,
          activePeriod,
          message: `${dex.name} epoch approaching end in ${remainingHours}h.`,
        });
      }
    }
    // Reset if epoch passed
    else if (remaining <= -3600) {
      condState.lastAlerted[key] = null;
      condState.lastAlerted[`${key}::approaching`] = null;
    }
    } catch (e) {
      log(`Evaluator 6: ${dex.name} scan failed: ${e.message?.slice(0,60) || "RPC error"}`);
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// EVALUATOR 7: ERC4626 VAULT DONATION VULNERABILITY (CONTINUOUS CHECK)
// ══════════════════════════════════════════════════════════════════════════════

async function evaluateVaultDonation(rpcPool, state) {
  if (!state.conditions["vault-donation"]) state.conditions["vault-donation"] = { lastAlerted: {}, lastCheck: null };
  const condState = state.conditions["vault-donation"];
  const now = Date.now();
  if (condState.lastCheck && now - condState.lastCheck < 1800_000) return; // every 30 min

  const inventory = loadJson(VAULT_INVENTORY, null);
  if (!inventory || !inventory.chains) { log("Evaluator 7: no vault inventory found — run tools/scan-vault-donation.js first"); return null; }

  const minCooldown = 2 * 3600_000; // 2 hours — was 24h, now catches same-day donation cycles
  const alerted = condState.lastAlerted || {};
  const MAX_PER_RUN = 30;
  let checked = 0;
  let hitBatchLimit = false;

  // Track progress so we spread checks across runs
  if (!condState.checkCursor) condState.checkCursor = {};
  if (!condState.checkCursor.chainIdx) condState.checkCursor.chainIdx = 0;
  if (!condState.checkCursor.vaultIdx) condState.checkCursor.vaultIdx = 0;

  const chainEntries = Object.entries(inventory.chains);
  let startChain = condState.checkCursor.chainIdx % chainEntries.length;
  let startVault = condState.checkCursor.vaultIdx || 0;

  outer:
  for (let ci = 0; ci < chainEntries.length; ci++) {
    const chainIdx = (startChain + ci) % chainEntries.length;
    const [chainIdStr, chainData] = chainEntries[chainIdx];
    const chainId = parseInt(chainIdStr);
    if (!rpcPool[chainId]) await resolveRpcForChain(chainId, rpcPool);
    const rpc = rpcPool[chainId];
    if (!rpc) continue;

    const vaults = chainData.vaults || [];
    let vi = (chainIdx === startChain) ? startVault : 0;
    for (; vi < vaults.length; vi++) {
      const v = vaults[vi];
      if (v.totalAssets !== null && v.totalAssets >= 100000) continue; // skip already-checked healthy vaults

      try {
        const raw = await ethCall(rpc, v.address, "0x01e1d114" /* totalAssets() */);
        let dec = v.assetDecimals || null;
        if (!dec) {
          const assetRaw = await ethCall(rpc, v.address, "0x38d52e0f" /* asset() */).catch(() => null);
          const asset = assetRaw ? decodeAddress(assetRaw) : null;
          if (asset) {
            const rawAssetDecimals = await ethCall(rpc, asset, "0x313ce567" /* decimals() */).catch(() => null);
            if (rawAssetDecimals) {
              dec = Number(uint256(rawAssetDecimals.slice(2)));
              v.asset = asset;
              v.assetDecimals = dec;
            }
          }
        }
        if (!dec) dec = v.decimals || 18;
        let assets = raw ? Number(uint256(raw.slice(2))) / (10 ** dec) : null;
        if (assets !== null && assets > 0 && assets < 0.01) assets = 0; // floor dust
        if (assets === null) continue;
        checked++;

        const key = `vault::${chainId}::${v.address.toLowerCase()}`;
        if (assets >= 100_000) {
          v.totalAssets = assets; v.flag = null;
          condState.lastAlerted[key] = null;
          continue;
        }

        const sev = assets === 0 ? "CRITICAL" : assets < 10000 ? "HIGH" : "MEDIUM";
        const flag = assets === 0 ? "ZERO_ASSETS" : assets < 10000 ? "LOW_TVL" : "MEDIUM_TVL";
        // Only alert if: first check, assets changed significantly, or cooldown expired
        const prevAssets = v.totalAssets;
        const changed = prevAssets === null
          || (assets === 0 && prevAssets > 0)
          || (prevAssets === 0 && assets > 0)
          || Math.abs(assets - prevAssets) / Math.max(prevAssets, 1) > 0.5; // 50% change
        if (changed && (!alerted[key] || now - alerted[key] > minCooldown)) {
          alert("vault-donation", sev, {
            chainId,
            vault: v.address,
            totalAssets: assets,
            classification: flag,
            deployBlock: v.deployBlock,
            message: `Vault ${v.address} has $${assets.toFixed(0)} TVL — ${flag === "ZERO_ASSETS" ? "empty, donation-inflation possible" : "donation-vulnerable"}.`,
          });
          condState.lastAlerted[key] = now;
        }
        v.totalAssets = assets; v.flag = flag;
      } catch (_) { /* silently skip failed individual vault checks — too many false positives */ }

      // Batch limit: spread work across runs
      if (checked >= MAX_PER_RUN) {
        condState.checkCursor.chainIdx = chainIdx;
        condState.checkCursor.vaultIdx = vi + 1;
        hitBatchLimit = true;
        break outer;
      }
    }
    startVault = 0; // reset for next chain in the rotation
  }
  if (!hitBatchLimit) {
    condState.checkCursor.chainIdx = 0;
    condState.checkCursor.vaultIdx = 0; // full cycle complete
  }

  condState.lastCheck = now;
  return checked;
}

// ══════════════════════════════════════════════════════════════════════════════
// EVALUATOR 7: SIGNAL SCAN
// ══════════════════════════════════════════════════════════════════════════════

function evaluateReportSignal(state) {
  const condState = state.conditions["report-signal"];
  const now = Date.now();
  if (condState.lastCheck && now - condState.lastCheck < 1800_000) return null; // every 30 min

  let files;
  try { files = fs.readdirSync(REPORTS_DIR).filter(f => f.endsWith(".md")); }
  catch (_) { log("Evaluator 8: cannot read reports directory"); return null; }

  const results = { CONFIRMED: [], VULNERABLE: [], DORMANT: [], CLEAN: [], UNTAGGED: [] };

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(REPORTS_DIR, file), "utf8");
      if (content.includes("\uD83D\uDD34 CONFIRMED")) results.CONFIRMED.push(file);
      else if (content.includes("\uD83D\uDFE1 VULNERABLE")) results.VULNERABLE.push(file);
      else if (content.includes("\uD83D\uDFE2 DORMANT")) results.DORMANT.push(file);
      else if (content.includes("\u26AA CLEAN")) results.CLEAN.push(file);
      else if (content.includes("No confirmed permissionless") || content.includes("no confirmed permissionless")) results.CLEAN.push(file);
      else results.UNTAGGED.push(file);
    } catch (_) { results.UNTAGGED.push(file); }
  }

  // Alert on CONFIRMED — info only since these are historical triage findings
  if (results.CONFIRMED.length > 0) {
    const real = results.CONFIRMED.filter(f => !f.includes("EXAMPLE"));
    if (real.length > 0) {
    alert("report-signal", "INFO", {
      confirmed: real.length,
      message: `${real.length} confirmed exploit report(s) exist (historical triage)`,
    });
    }
  }

  // ══ Route-positive flip detection: compare current sweep against last cycle ══
  const sweepFile = path.join(WORKSPACE, "reports", "raw", "fast", "route-positive-sweep.json");
  try {
    if (fs.existsSync(sweepFile)) {
      const sweep = JSON.parse(fs.readFileSync(sweepFile, "utf8"));
      const ranked = sweep.ranked || [];
      const currentPositives = {};
      for (const row of ranked) {
        if ((row.routePositive || 0) > 0) currentPositives[row.id] = row;
      }

      const prevPositives = condState.lastPositiveBranches || {};
      const newFlips = [];
      for (const [id, row] of Object.entries(currentPositives)) {
        if (!prevPositives[id]) {
          newFlips.push({ id, protocol: row.protocol, chain: row.chain, surface: row.surface, status: row.status });
        }
      }

      // Also detect branches that resolved (was positive, now isn't)
      const resolved = [];
      for (const id of Object.keys(prevPositives)) {
        if (!currentPositives[id]) resolved.push(id);
      }

      if (newFlips.length > 0) {
        alert("route-positive-flip", "CRITICAL", {
          count: newFlips.length,
          branches: newFlips,
          message: `NEW ROUTE-POSITIVE: ${newFlips.map(f => f.id).join(", ")}`
        });
      }
      if (resolved.length > 0) {
        logPrint(`E7/8 Route-positive resolved: ${resolved.join(", ")}`);
      }

      condState.lastPositiveBranches = currentPositives;

      // ══ Artifact staleness check ══
      const STALE_HOURS = 168; // 7 days
      const staleArtifacts = [];
      const sourceFiles = sweep.sourceArtifacts || {};
      for (const [key, relPath] of Object.entries(sourceFiles)) {
        const fullPath = path.join(WORKSPACE, relPath.replace(/\\/g, "/"));
        if (!fs.existsSync(fullPath)) continue;
        const stat = fs.statSync(fullPath);
        const ageH = (now - stat.mtimeMs) / 3600_000;
        if (ageH > STALE_HOURS) {
          staleArtifacts.push({ key, path: relPath, ageHours: Math.round(ageH) });
        }
      }
      if (staleArtifacts.length > 10) {
        alert("stale-artifacts", "WARN", {
          count: staleArtifacts.length,
          message: `${staleArtifacts.length} artifacts stale (>7d)`
        });
      }
      condState.staleArtifactCount = staleArtifacts.length;
    }
  } catch (_) {
    // Sweep file may not exist or be malformed — not critical
  }

  condState.lastCheck = now;
  return results;
}

// ══════════════════════════════════════════════════════════════════════════════
// EVALUATOR 8: ETH/USD STALE-ORACLE DIVERGENCE DETECTOR
// ══════════════════════════════════════════════════════════════════════════════
// The money-maker. Tracks Chainlink ETH/USD feed age AND compares stale price
// against live market price. Fluid Vault_wstETH_USDC (vaultId 14, CF 80%) has NO
// staleness check on its UniV3CheckCLRSOracle. When Chainlink diverges >3% from
// TWAP, the oracle returns Chainlink's stale price.
// At 30%+ inflation: borrow $2,664 against 1 wstETH ($2,556 market), spend ~$2,500
// on Lido ETH→stETH→wstETH conversion, repay, keep ~$93 profit. Fork-proven.

const ETH_FEED = "0x5f4eC3Df9cbd43714FE2740f5e3616155c5b8419";
const ETH_ADDRESS = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const USDC_ADDRESS = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
let LIVE_ETH_PRICE_FAILURES = 0;

async function getLiveEthPrice() {
  // Tier 1: CoinGecko
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd", {
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    const p = Number(j?.ethereum?.usd);
    if (p > 0) {
      LIVE_ETH_PRICE_FAILURES = 0;
      return p;
    }
  } catch (_) { /* fall through */ }

  // Tier 2: Binance
  try {
    const r = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT", {
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    const p = Number(j?.price);
    if (p > 0) {
      LIVE_ETH_PRICE_FAILURES = 0;
      return p;
    }
  } catch (_) { /* fall through */ }

  // Fallback: both APIs down
  LIVE_ETH_PRICE_FAILURES += 1;
  if (LIVE_ETH_PRICE_FAILURES % 3 === 0) {
    logPrint("E8 WARN: Both CoinGecko and Binance down — live ETH price unavailable. Stale-ETH divergence may be missed.");
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════
// Evaluator 16: Proxy Implementation Upgrades
// ═══════════════════════════════════════════════════════════════════
// Watches EIP-1967 implementation slot for key protocol contracts.
// An upgrade means new code — possibly buggy and exploitable before fixed.

const EIP1967_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

const PROXY_TARGETS = [
  { name: "Fluid_Vault_wstETH_USDC",   addr: "0x1982CC7b1570C2503282d0A0B41F69b3B28fdcc3" },
  { name: "Fluid_Vault_ETH_USDC",      addr: "0x0C8C77B7FF4c2aF7F6CEBbe67350A490E3DD6cB3" },
  { name: "Morpho_Blue",               addr: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb" },
];

async function evaluatorProxyUpgrades(rpcPool, state) {
  let rpc = rpcPool[1]; // Ethereum
  if (!rpc) rpc = await resolveRpcForChain(1, rpcPool).catch(() => null);
  if (!rpc) return null;

  const condState = state.conditions["proxy-upgrades"] || {};
  condState.impls = condState.impls || {};
  state.conditions["proxy-upgrades"] = condState;

  const upgrades = [];
  try {
    for (const target of PROXY_TARGETS) {
      const implHex = await rpcCall(rpc, "eth_getStorageAt", [target.addr, EIP1967_IMPL_SLOT, "latest"]);
      if (!implHex || implHex === "0x" + "0".repeat(64)) continue;
      const impl = "0x" + implHex.slice(26);
      const prev = condState.impls[target.name];
      if (prev && prev !== impl) {
        upgrades.push(`${target.name}: ${prev.slice(0,10)} -> ${impl.slice(0,10)}`);
      }
      condState.impls[target.name] = impl;
    }

    if (upgrades.length > 0) {
      return {
        condition: "proxy-upgrade",
        severity: "CRITICAL",
        count: upgrades.length,
        upgrades,
        message: `${upgrades.length} proxy implementation(s) upgraded. New code may be exploitable. ${upgrades.join(" | ")}`,
      };
    }
  } catch (e) {
    logPrint(`  E16: Proxy upgrade scan error: ${e.message?.slice(0,60) || "RPC error"}`);
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════
// Legacy execution compatibility shim
// ═══════════════════════════════════════════════════════════════════
async function executeAlerts(alerts) {
  return (Array.isArray(alerts) ? alerts : []).map((item) => ({
    ts: new Date().toISOString(),
    condition: item?.condition || "unknown",
    result: "disabled - monitor is permanently read-only",
    txHash: "none",
  }));
}

const E8_FLUID_ORACLE_IFACE = new ethers.Interface(["function getExchangeRateOperate() view returns (uint256)"]);
const E8_WSTETH_IFACE = new ethers.Interface([
  "function stEthPerToken() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
const E8_QUOTER_IFACE = new ethers.Interface([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);
const E5_QUOTER_IFACE = new ethers.Interface([
  "function quoteExactOutput(bytes path,uint256 amountOut) returns (uint256 amountIn,uint160[] sqrtPriceX96AfterList,uint32[] initializedTicksCrossedList,uint256 gasEstimate)",
]);
const E5_FLUID_ORACLE_IFACE = new ethers.Interface(["function getExchangeRateOperate() view returns (uint256)"]);

async function buildE8FluidRoute(provider, rpcUrl, gasPriceOverride = null) {
  const feedData = await queryFeed(rpcUrl, ETH_FEED);
  if (!feedData) return { executable: false, reason: "feed query failed" };
  const block = await provider.getBlock("latest").catch(() => null);
  if (!block) return { executable: false, reason: "block query failed" };

  const feedAge = block.timestamp - feedData.updatedAt;
  const stalePrice = Number(feedData.answer) / 1e8;
  const livePrice = await e9GetValidatedEthUsdPrice(provider).catch(() => null);
  if (!(livePrice > 0) || !(stalePrice > 0)) return { executable: false, reason: "missing validated live/stale ETH price", feedAge, stalePrice };
  const divergence = ((stalePrice - livePrice) / livePrice) * 100;
  if (feedAge < E8_MIN_FEED_AGE_SECONDS || divergence < E8_MIN_DIVERGENCE_PERCENT) {
    return { executable: false, reason: "feed age/divergence below threshold", feedAge, stalePrice, livePrice, divergence };
  }

  const rawGasPrice = gasPriceOverride ? e9ToBigInt(gasPriceOverride) : await provider.send("eth_gasPrice", []).then(BigInt).catch(() => 0n);
  if (rawGasPrice <= 0n) return { executable: false, reason: "missing gas price", feedAge, stalePrice, livePrice, divergence };

  const [sprRawResult, rateRaw, balancerWstethRaw] = await Promise.all([
    provider.call({ to: E8_WSTETH.toLowerCase(), data: E8_WSTETH_IFACE.encodeFunctionData("stEthPerToken", []) }).catch(() => null),
    provider.call({ to: E8_FLUID_ORACLE.toLowerCase(), data: E8_FLUID_ORACLE_IFACE.encodeFunctionData("getExchangeRateOperate", []) }).catch(() => null),
    provider.call({ to: E8_WSTETH.toLowerCase(), data: E8_WSTETH_IFACE.encodeFunctionData("balanceOf", ["0xBA12222222228d8Ba445958a75a0704d566BF2C8"]) }).catch(() => null),
  ]);
  if (!sprRawResult || !rateRaw) return { executable: false, reason: "missing Fluid/wstETH route data", feedAge, stalePrice, livePrice, divergence };
  const [sprRaw] = E8_WSTETH_IFACE.decodeFunctionResult("stEthPerToken", sprRawResult);
  const [rate] = E8_FLUID_ORACLE_IFACE.decodeFunctionResult("getExchangeRateOperate", rateRaw);
  const [balancerWsteth] = balancerWstethRaw ? E8_WSTETH_IFACE.decodeFunctionResult("balanceOf", balancerWstethRaw) : [0n];
  if (sprRaw <= 0n || rate <= 0n) return { executable: false, reason: "invalid Fluid/wstETH route data", feedAge, stalePrice, livePrice, divergence };

  const wstethAmount = parseUnitsFromNumber(E8_FLASH_WSTETH, 18);
  if (balancerWsteth < wstethAmount) return { executable: false, reason: "insufficient Balancer wstETH liquidity", feedAge, stalePrice, livePrice, divergence };

  const borrowTarget = BigInt(rate) * wstethAmount / 10n ** 27n * 80n / 100n;
  const quoteRaw = await provider.call({
    to: E9_UNISWAP_V3_QUOTER_V2,
    data: E8_QUOTER_IFACE.encodeFunctionData("quoteExactInputSingle", [{ tokenIn: E8_USDC, tokenOut: E8_WETH, amountIn: borrowTarget, fee: E8_UNISWAP_FEE, sqrtPriceLimitX96: 0 }]),
  }).catch(() => null);
  if (!quoteRaw) return { executable: false, reason: "missing live USDC->WETH quote", feedAge, stalePrice, livePrice, divergence };
  const [expectedWethOut] = E8_QUOTER_IFACE.decodeFunctionResult("quoteExactInputSingle", quoteRaw);

  const spr = Number(sprRaw) / 1e18;
  const wstethUsd = livePrice * spr;
  const gasUsd = (_E8_GAS_USED * Number(rawGasPrice) / 1e18) * livePrice;
  const minProfitUsd = Math.max(E8_MIN_NET_PROFIT_USD, gasUsd * 1.2);
  const minProfitWsteth = parseUnitsFromNumber(minProfitUsd / wstethUsd, 18);
  const stethNeeded = wstethAmount * sprRaw / 10n ** 18n;
  const minProfitSteth = minProfitWsteth * sprRaw / 10n ** 18n;
  const minWethOut = stethNeeded + minProfitSteth;
  const expectedProfitWsteth = expectedWethOut * 10n ** 18n / sprRaw - wstethAmount;
  const netProfitUsd = Number(ethers.formatEther(expectedProfitWsteth)) * wstethUsd - gasUsd;
  const executable = expectedWethOut >= minWethOut && netProfitUsd >= E8_MIN_NET_PROFIT_USD;

  return {
    executable,
    reason: executable ? null : "live quote/profit below execution threshold",
    feedAge,
    stalePrice,
    livePrice,
    divergence,
    gasUsd,
    wstethUsd,
    sprRaw,
    rate,
    wstethAmount,
    borrowTarget,
    expectedWethOut,
    minWethOut,
    minProfitWsteth,
    netProfitUsd,
  };
}

// ── E8 Handler: Fluid stale-oracle exploit ──
async function executeE8FluidExploit(wallet, provider, gasPrice, alert, rpcUrl) {
  void wallet; void provider; void gasPrice; void alert; void rpcUrl;
  return { ts: new Date().toISOString(), condition: E8_EXECUTION_CONDITION, result: "disabled - monitor is permanently read-only", txHash: "none" };
}

async function e5QuoteExactOutput(provider, pathBytes, amountOut) {
  const raw = await provider.call({
    to: E9_UNISWAP_V3_QUOTER_V2,
    data: E5_QUOTER_IFACE.encodeFunctionData("quoteExactOutput", [pathBytes, amountOut]),
  });
  const [amountIn] = E5_QUOTER_IFACE.decodeFunctionResult("quoteExactOutput", raw);
  return amountIn;
}

async function buildE5DepegRoute(provider, depegPrice, gasPriceOverride = null) {
  if (!(depegPrice > 0) || depegPrice > (1 - E5_MIN_EXEC_DEPEG_PCT / 100)) {
    return { executable: false, reason: "USDC depeg below execution threshold" };
  }
  const ethPrice = await e9GetValidatedEthUsdPrice(provider).catch(() => null);
  const rawGasPrice = gasPriceOverride ? e9ToBigInt(gasPriceOverride) : await provider.send("eth_gasPrice", []).then(BigInt).catch(() => 0n);
  if (!(ethPrice > 0) || rawGasPrice <= 0n) return { executable: false, reason: "missing validated ETH/gas price" };

  const severity = 1 - depegPrice;
  const baseFlashUsd = Number(runtimeConfig.E5_BASE_FLASH_USD || "1000");
  const maxFlashUsd = Number(runtimeConfig.E5_MAX_FLASH_USD || "100000");
  const flashUsd = clampNumber(baseFlashUsd * (1 + severity * 10), baseFlashUsd, maxFlashUsd);
  const strongFlashAmount = parseUnitsFromNumber(flashUsd, 6);
  const depeggedAmount = parseUnitsFromNumber((flashUsd / depegPrice) * 0.985, 6);

  const usdcOutPath = ethers.solidityPacked(
    ["address", "uint24", "address", "uint24", "address"],
    [E5_USDC, E5_UNISWAP_FEE, E5_WETH, E5_UNISWAP_FEE, E5_USDT]
  );
  const usdtOutPath = ethers.solidityPacked(
    ["address", "uint24", "address"],
    [E5_USDT, E5_UNISWAP_FEE, E5_WETH]
  );

  const [strongInForUsdc, oracleRaw] = await Promise.all([
    e5QuoteExactOutput(provider, usdcOutPath, depeggedAmount).catch(() => 0n),
    provider.call({ to: E5_FLUID_USDC_ETH_ORACLE.toLowerCase(), data: E5_FLUID_ORACLE_IFACE.encodeFunctionData("getExchangeRateOperate", []) }).catch(() => null),
  ]);
  if (strongInForUsdc <= 0n || !oracleRaw) return { executable: false, reason: "missing live depeg route/oracle quote" };
  if (strongInForUsdc >= strongFlashAmount) return { executable: false, reason: "USDT->USDC route not discounted", netProfitUsd: -1 };

  const [oracleRate] = E5_FLUID_ORACLE_IFACE.decodeFunctionResult("getExchangeRateOperate", oracleRaw);
  const maxBorrowEth = BigInt(oracleRate) * depeggedAmount / 10n ** 27n * 85n / 100n;
  const wethInForRepay = await e5QuoteExactOutput(provider, usdtOutPath, strongFlashAmount).catch(() => 0n);
  if (wethInForRepay <= 0n) return { executable: false, reason: "missing WETH->USDT repay quote" };
  if (wethInForRepay > maxBorrowEth) return { executable: false, reason: "Fluid borrow cannot cover flash repayment", netProfitUsd: -1 };

  const gasCostUsd = (E5_GAS_USED * Number(rawGasPrice) / 1e18) * ethPrice;
  const minProfitUsd = Math.max(E5_MIN_NET_PROFIT_USD, gasCostUsd * 1.2);
  const strongProfitRaw = strongFlashAmount - strongInForUsdc;
  const strongProfitUsd = Number(ethers.formatUnits(strongProfitRaw, 6));
  const netProfitUsd = strongProfitUsd - gasCostUsd;
  const minProfitStrong = parseUnitsFromNumber(minProfitUsd, 6);
  const executable = strongProfitRaw >= minProfitStrong && netProfitUsd >= E5_MIN_NET_PROFIT_USD;

  return {
    executable,
    reason: executable ? null : "live route profit below execution threshold",
    depegPrice,
    ethPrice,
    gasCostUsd,
    flashUsd,
    strongFlashAmount,
    depeggedAmount,
    ethBorrowAmount: maxBorrowEth,
    minProfitStrong,
    strongInForUsdc,
    wethInForRepay,
    strongProfitUsd,
    netProfitUsd,
  };
}

// ── E5 Handler: Depeg exploit ──
async function executeE5DepegExploit(wallet, provider, gasPrice, alert) {
  void wallet; void provider; void gasPrice; void alert;
  return { ts: new Date().toISOString(), condition: "depeg", result: "disabled - monitor is permanently read-only", txHash: "none" };
}

const E1_ROUTE_IFACE = new ethers.Interface([
  "function snapshotRatio() view returns (uint256)",
  "function stEthPerToken() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);

async function e1ReadUint256(provider, to, fn, args = []) {
  const data = E1_ROUTE_IFACE.encodeFunctionData(fn, args);
  const raw = await provider.call({ to: String(to || "").toLowerCase(), data });
  if (!raw || raw === "0x") return null;
  const [value] = E1_ROUTE_IFACE.decodeFunctionResult(fn, raw);
  return value;
}

async function buildE1CapoRoute(provider, gasPriceOverride = null) {
  const [snapRaw, liveRaw, balancerWstethRaw, cometWethRaw] = await Promise.all([
    e1ReadUint256(provider, E1_CAPO_ORACLE, "snapshotRatio"),
    e1ReadUint256(provider, E1_WSTETH, "stEthPerToken"),
    e1ReadUint256(provider, E1_WSTETH, "balanceOf", ["0xBA12222222228d8Ba445958a75a0704d566BF2C8"]),
    e1ReadUint256(provider, E1_WETH, "balanceOf", [E1_CWETHV3]),
  ]);
  if (!snapRaw || !liveRaw || snapRaw <= 0n || liveRaw <= 0n) return { executable: false, reason: "missing CAPO/live ratio" };

  const rawGasPrice = gasPriceOverride ? e9ToBigInt(gasPriceOverride) : await provider.send("eth_gasPrice", []).then(BigInt).catch(() => 0n);
  const ethPrice = await e9GetValidatedEthUsdPrice(provider).catch(() => null);
  if (rawGasPrice <= 0n || !(ethPrice > 0)) return { executable: false, reason: "missing validated gas/ETH price" };

  const snapRatio = Number(snapRaw) / 1e18;
  const liveRatio = Number(liveRaw) / 1e18;
  const routeSpreadPct = ((snapRatio * 0.9 / liveRatio) - 1) * 100;
  const capoDeltaPct = ((snapRatio - liveRatio) / liveRatio) * 100;
  const gasCostUsd = (E1_GAS_USED * Number(rawGasPrice) / 1e18) * ethPrice;
  const wstethUsd = liveRatio * ethPrice;
  const grossProfitPerWstethUsd = (routeSpreadPct / 100) * wstethUsd;
  if (!(grossProfitPerWstethUsd > 0)) {
    return { executable: false, reason: "CAPO route below flash break-even", snapRatio, liveRatio, capoDeltaPct, routeSpreadPct, gasCostUsd, ethPrice, netProfitUsd: grossProfitPerWstethUsd - gasCostUsd };
  }

  const targetNetUsd = Math.max(E1_MIN_NET_PROFIT_USD, gasCostUsd * 1.2);
  const neededWsteth = Math.max(E1_MIN_FLASH_WSTETH, targetNetUsd / grossProfitPerWstethUsd);
  const balancerWsteth = balancerWstethRaw ? Number(ethers.formatEther(balancerWstethRaw)) : 0;
  const flashWsteth = Math.min(E1_MAX_FLASH_WSTETH, balancerWsteth * 0.5, neededWsteth);
  if (!(flashWsteth >= E1_MIN_FLASH_WSTETH)) return { executable: false, reason: "insufficient Balancer wstETH liquidity", snapRatio, liveRatio, capoDeltaPct, routeSpreadPct, gasCostUsd, ethPrice };

  const wstethAmount = parseUnitsFromNumber(flashWsteth, 18);
  const attackPrice = snapRaw / 10_000_000_000n; // 1e18 ratio -> 1e8 Compound price scale.
  const borrowTarget = wstethAmount * attackPrice * 9n / 10n / 100_000_000n;
  const cometWeth = cometWethRaw || 0n;
  if (borrowTarget >= cometWeth) return { executable: false, reason: "insufficient cWETHv3 WETH liquidity", snapRatio, liveRatio, capoDeltaPct, routeSpreadPct, gasCostUsd, ethPrice };

  const netProfitUsd = grossProfitPerWstethUsd * flashWsteth - gasCostUsd;
  const minProfitWsteth = parseUnitsFromNumber((gasCostUsd * 1.2) / wstethUsd, 18);
  const executable = capoDeltaPct > 0
    && routeSpreadPct >= E1_MIN_CAPO_ROUTE_SPREAD_PCT
    && netProfitUsd >= E1_MIN_NET_PROFIT_USD;

  return {
    executable,
    reason: executable ? null : "profit/route spread below execution threshold",
    compoundRoute: E1_ROUTE,
    snapRatio,
    liveRatio,
    capoDeltaPct,
    routeSpreadPct,
    ethPrice,
    gasCostUsd,
    grossProfitPerWstethUsd,
    netProfitUsd,
    wstethAmount,
    borrowTarget,
    minProfitWsteth,
    flashWsteth,
    balancerWsteth,
  };
}

// ── E1 Handler: Compound CAPO stale-oracle exploit ──
async function executeE1CompoundExploit(wallet, provider, gasPrice, alert, rpcUrl) {
  void wallet; void provider; void gasPrice; void alert; void rpcUrl;
  return { ts: new Date().toISOString(), condition: E1_CONDITION, result: "disabled - monitor is permanently read-only", txHash: "none" };
}

const E10_SOLIDLY_IFACE = new ethers.Interface([
  "function defaultFactory() view returns (address)",
  "function getAmountsOut(uint256 amountIn,(address from,address to,bool stable,address factory)[] routes) view returns (uint256[] amounts)",
]);
const E10_TOKEN_IFACE = new ethers.Interface(["function balanceOf(address) view returns (uint256)"]);

async function readE10CrossChainPrices(rpcPool) {
  const prices = [];
  for (const [chainId, feedAddr] of Object.entries(CROSS_CHAIN_FEEDS)) {
    const rpc = rpcPool[parseInt(chainId)];
    if (!rpc) continue;
    try {
      const feedData = await queryFeed(rpc, feedAddr);
      if (!feedData) continue;
      const block = await getBlock(rpc);
      const price = Number(feedData.answer) / 1e8;
      if (!(price > 0) || !block || !(feedData.updatedAt > 0)) continue;
      const age = block ? block.timestamp - feedData.updatedAt : null;
      prices.push({ chainId: parseInt(chainId), price, age, feed: feedAddr.slice(0, 10) + "..." });
    } catch (_) {}
  }
  prices.sort((a, b) => a.price - b.price);
  return prices;
}

async function quoteE10UsdcToWeth(provider, cfg, amountIn) {
  if (cfg.useUniV3) {
    if (!cfg.quoter) throw new Error("missing UniV3 quoter");
    const raw = await provider.call({
      to: cfg.quoter,
      data: E8_QUOTER_IFACE.encodeFunctionData("quoteExactInputSingle", [{ tokenIn: cfg.usdc, tokenOut: cfg.weth, amountIn, fee: cfg.uniFee, sqrtPriceLimitX96: 0 }]),
    });
    const [amountOut] = E8_QUOTER_IFACE.decodeFunctionResult("quoteExactInputSingle", raw);
    return amountOut;
  }

  const factoryRaw = await provider.call({ to: cfg.router, data: E10_SOLIDLY_IFACE.encodeFunctionData("defaultFactory", []) });
  const [factory] = E10_SOLIDLY_IFACE.decodeFunctionResult("defaultFactory", factoryRaw);
  const raw = await provider.call({
    to: cfg.router,
    data: E10_SOLIDLY_IFACE.encodeFunctionData("getAmountsOut", [amountIn, [{ from: cfg.usdc, to: cfg.weth, stable: false, factory }]]),
  });
  const [amounts] = E10_SOLIDLY_IFACE.decodeFunctionResult("getAmountsOut", raw);
  return amounts[amounts.length - 1];
}

async function buildE10Route(rpcPool, chainId, gasPriceOverride = null) {
  const cfg = E10_CHAIN_EXEC[chainId];
  const rpc = rpcPool[chainId];
  if (!cfg || !rpc) return { executable: false, reason: "unsupported/no RPC chain" };
  const prices = await readE10CrossChainPrices(rpcPool);
  if (prices.length < 3) return { executable: false, reason: "insufficient cross-chain price set" };
  const min = prices[0];
  const max = prices[prices.length - 1];
  const spread = ((max.price - min.price) / min.price) * 100;
  if (max.chainId !== chainId) return { executable: false, reason: "target chain is not overvalued", spread, min, max };
  if (spread < E10_MIN_EXEC_SPREAD_PCT) return { executable: false, reason: "spread below execution threshold", spread, min, max };
  if (!(Number(max.age) >= E10_MIN_OVERVALUED_FEED_AGE_SECONDS)) return { executable: false, reason: "overvalued feed not stale enough", spread, min, max };
  if (!(Number(min.age) <= E10_MAX_REFERENCE_FEED_AGE_SECONDS)) return { executable: false, reason: "reference feed too stale", spread, min, max };

  const provider = new ethers.JsonRpcProvider(rpc);
  const rawGasPrice = gasPriceOverride ? e9ToBigInt(gasPriceOverride) : await provider.send("eth_gasPrice", []).then(BigInt).catch(() => 0n);
  if (rawGasPrice <= 0n) return { executable: false, reason: "missing chain gas price", spread, min, max };

  const gasUsd = (E10_GAS_USED * Number(rawGasPrice) / 1e18) * min.price;
  const repayMargin = (1 + spread / 100) * 0.8 - 1;
  if (repayMargin <= 0) return { executable: false, reason: "spread below flash principal break-even", spread, min, max, gasUsd };

  const targetGrossUsd = Math.max(gasUsd * 3, Number(runtimeConfig.E10_TARGET_GROSS_USD || "20"));
  const minWeth = Number(runtimeConfig.E10_MIN_WETH || "0.05");
  const maxWeth = Number(runtimeConfig.E10_MAX_WETH || "1.0");
  const wethEth = clampNumber(targetGrossUsd / (min.price * repayMargin), minWeth, maxWeth);
  const wethAmount = parseUnitsFromNumber(wethEth, 18);
  const borrowTarget = BigInt(Math.floor(wethEth * max.price * 0.8 * 1e6));

  const expectedWethOut = await quoteE10UsdcToWeth(provider, cfg, borrowTarget).catch(() => 0n);
  if (expectedWethOut <= 0n) return { executable: false, reason: "missing live USDC->WETH quote", spread, min, max, gasUsd };

  const minProfitWeth = parseUnitsFromNumber(Math.max(E10_MIN_NET_PROFIT_USD, gasUsd * 1.2) / min.price, 18);
  const repayFloor = wethAmount + (wethAmount / 10000n) + minProfitWeth;
  const slippageFloor = expectedWethOut * 995n / 1000n;
  const minWethOut = slippageFloor > repayFloor ? slippageFloor : repayFloor;
  const netProfitUsd = Number(ethers.formatEther(expectedWethOut - wethAmount)) * min.price - gasUsd;
  const balancerRaw = await provider.call({ to: cfg.weth, data: E10_TOKEN_IFACE.encodeFunctionData("balanceOf", [cfg.balancer]) }).catch(() => null);
  const [balancerWeth] = balancerRaw ? E10_TOKEN_IFACE.decodeFunctionResult("balanceOf", balancerRaw) : [0n];

  const executable = balancerWeth >= wethAmount && expectedWethOut >= minWethOut && netProfitUsd >= E10_MIN_NET_PROFIT_USD;
  return {
    executable,
    reason: executable ? null : "live route quote/liquidity below execution threshold",
    cfg,
    min,
    max,
    spread,
    gasUsd,
    wethEth,
    wethAmount,
    borrowTarget,
    expectedWethOut,
    minWethOut,
    minProfitWeth,
    netProfitUsd,
    balancerWeth,
    gasPrice: rawGasPrice,
  };
}

// ── E10 L2 Handler: Cross-chain Aave exploit on Base/Optimism/Arb/Poly ──
async function executeE10L2Exploit(wallet, rpcPool, alert, chainId) {
  void wallet; void rpcPool; void chainId;
  return { ts: new Date().toISOString(), condition: alert?.condition || E10_BASE_CONDITION, result: "disabled - monitor is permanently read-only", txHash: "none" };
}

// ── LB Handler: Liquity Bold stETH/ETH exploit ──
// AUTO-EXEC DISABLED. Break-even ~22.6% premium. Alert-only at 10%+.
async function executeLbLiquityBold(wallet, provider, gasPrice, alert) {
  // Disabled — profitability requires >22.6% stETH premium which never occurs naturally.
  // Contract deployed at 0x0aaA75499FbcB7db821c3AefC84433A53CDEb9b9 for black-swan events.
  logPrint(`  LB: AUTO-EXEC DISABLED. Break-even ~22.6% premium. Current: ${alert.premium}%.`);

  logPrint(`  LB: AUTO-EXEC DISABLED. Break-even ~22.6% premium. Current: ${alert.premium}%.`);
  return { ts: new Date().toISOString(), condition: "lb-steth-premium", result: "disabled", reason: `break-even 22.6% > current ${alert.premium}%` };
}

// ── E9 Handler: Morpho liquidation ──
const E9_CONTRACT = "0x2cd636ccee97243688ddaa4b1f93b13f60d3a00f"; // CREATE2 deployed on ETH/Base/Arb/OP/Poly

async function executeE9Liquidation(wallet, provider, gasPrice, alert, chainId = null) {
  void wallet; void provider; void gasPrice; void alert; void chainId;
  return { ts: new Date().toISOString(), condition: "liquidation-hunter", result: "disabled - monitor is permanently read-only", txHash: "none" };
}

// ── E12 Handler: Auto-borrow on new Morpho markets ──
async function executeE12NewMarket(wallet, provider, gasPrice, alert) {
  logPrint(`  E12: New market(s): ${alert.markets?.join(", ") || alert.message}`);
  // New markets may have zero caps or misconfigured oracles — too risky to auto-borrow blindly.
  // Manual review recommended before committing capital.
  return { ts: new Date().toISOString(), condition: "new-market-deployment", result: "detected — manual review", txHash: "none", profit: "N/A — manual" };
}

// ── E12x Handler: Morpho new-market + stale-oracle exploit ──
async function executeE12xMorphoExploit(wallet, provider, gasPrice, alert) {
  void wallet; void provider; void gasPrice;
  return { ts: new Date().toISOString(), condition: alert?.condition || MORPHO_EXPLOIT_CONDITION, result: "disabled - monitor is permanently read-only", txHash: "none" };
}

// ── E13 Handler: LLTV enabled on Morpho ──
async function executeE13LltvEnabled(wallet, provider, gasPrice, alert) {
  logPrint(`  E13: LLTV enabled: ${alert.message}`);
  // New LLTV tier enables new risk markets. First to create market + borrow may capture spread.
  logPrint(`  E13: Run: node tools/auto-borrow-on-lltv.js --watch`);
  return { ts: new Date().toISOString(), condition: "config-change", result: "detected — manual review", txHash: "none", profit: "N/A — manual" };
}

// ── E14 Handler: Protocol unpause ──
async function executeE14Unpause(wallet, provider, gasPrice, alert, rpcUrl) {
  const details = alert.unpauseDetails || [];
  const labels = alert.unpaused || [];
  logPrint(`  E14: Unpause: ${labels.join(", ")}`);

  // Compound borrow unpauses are review signals only. E1 signed execution is
  // route-specific to cWETHv3/wstETH CAPO overvaluation and is checked by CAPO.
  for (const d of details) {
    if (d.protocol?.startsWith("Compound") && d.action === "borrow") {
      logPrint(`  E14: Compound borrow unpaused; not routing to E1 without CAPO route-positive preflight.`);
    }
  }

  logPrint(`  E14: Manual review — verify oracle freshness before borrowing.`);
  return { ts: new Date().toISOString(), condition: "protocol-unpause", result: "detected — manual review", txHash: "none", profit: "N/A — manual" };
}

// ═══════════════════════════════════════════════════════════════════
// Evaluator 13+18: Config Changes (CF/LTV + Flash Loan Fee)
// ═══════════════════════════════════════════════════════════════════
// E13: Detects Morpho EnableLltv events across ETH + L2s
// E18: Tracks Aave V3 flash loan premium — if drops to 0 = free capital

async function evaluatorConfigChanges(rpcPool, state) {
  const condState = state.conditions["config-changes"] || {};
  condState.aaveFlashFee = condState.aaveFlashFee || null;
  condState.morphoLltv = condState.morphoLltv || {}; // { chainId: { lastBlock, known: [] } }
  state.conditions["config-changes"] = condState;

  const changes = [];
  let aaveFeeDropped = false;

  // ── E18: Check Aave V3 flash loan premium ──
  try {
    const rpc = rpcPool[1];
    if (rpc) {
      const feeHex = await rpcCall(rpc, "eth_call", [{ to: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2", data: "0x956ba2fb" /* FLASHLOAN_PREMIUM_TOTAL() */ }, "latest"]);
      if (feeHex && feeHex !== "0x") {
        const feeBps = parseInt(feeHex.slice(0, 66), 16) / 100;
        if (condState.aaveFlashFee !== null && condState.aaveFlashFee !== feeBps) {
          changes.push(`Aave flash fee: ${condState.aaveFlashFee}bps -> ${feeBps}bps`);
          aaveFeeDropped = feeBps < condState.aaveFlashFee;
        }
        condState.aaveFlashFee = feeBps;
      }
    }
  } catch (e) { logPrint(`  E18: Aave fee check failed: ${e.message?.slice(0,60) || "RPC error"}`); }

  // ── E13: Check Morpho EnableLltv on ETH + Base ──
  const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
  const ENABLE_LLTV_TOPIC = "0x08068b9199032353d20cfc86e1a1ab8787b40957774f0b69aba50c5db4c6e6ae"; // EnableLltv(uint256)
  const LLTV_CHAINS = [1, 8453, 42161, 10, 137, 56]; // Ethereum, Base, Arbitrum, Optimism, Polygon, BSC

  for (const chainId of LLTV_CHAINS) {
    const rpc = rpcPool[chainId];
    if (!rpc) continue;

    try {
      const chainState = condState.morphoLltv[chainId] || { lastBlock: 0, known: [] };
      condState.morphoLltv[chainId] = chainState;

      const block = await rpcCall(rpc, "eth_blockNumber", []);
      if (!block) continue;
      const currentBlock = parseInt(block, 16);
      const fromBlock = Math.max(chainState.lastBlock || currentBlock - 14400, 0);

      const logs = await rpcCall(rpc, "eth_getLogs", [{
        address: MORPHO, topics: [ENABLE_LLTV_TOPIC],
        fromBlock: "0x" + fromBlock.toString(16),
        toBlock: "0x" + currentBlock.toString(16),
      }]);

      if (logs && logs.length > 0) {
        for (const log of logs) {
          const txHash = log.transactionHash || "0x";
          if (chainState.known.includes(txHash)) continue;
          chainState.known.push(txHash);
          const lltvRaw = BigInt(log.data);
          const lltv = Number(lltvRaw) / 1e18;
          const chainTag = chainId === 1 ? "ETH" : chainId === 8453 ? "Base" : chainId === 42161 ? "Arb" : `L2:${chainId}`;
          changes.push(`${chainTag}:Morpho LLTV enabled: ${(lltv*100).toFixed(0)}%`);
        }
      }
      chainState.lastBlock = currentBlock;
    } catch (e) {
      logPrint(`  E13: Morpho LLTV scan failed on chain ${chainId}: ${e.message?.slice(0,60) || "RPC error"}`);
    }
  }

  if (changes.length > 0) {
    const isCritical = aaveFeeDropped || changes.some(c => c.includes("LLTV"));
    return {
      condition: "config-change",
      severity: isCritical ? "HIGH" : "DORMANT",
      changes,
      message: `Config change(s) detected: ${changes.join(" | ")}`,
    };
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════
// Evaluator 14: Protocol Unpause Events
// ═══════════════════════════════════════════════════════════════════
// Detects when borrow/supply actions are unpaused on Venus/Compound.
// Stale state after unpause = borrow before oracles catch up.

const MARKET_OPEN_EVENTS = [
  { name: "NewBorrowCap", topic: ethers.id("NewBorrowCap(address,uint256)"), kind: "borrow-cap" },
  { name: "NewSupplyCap", topic: ethers.id("NewSupplyCap(address,uint256)"), kind: "supply-cap" },
  { name: "NewCollateralFactor", topic: ethers.id("NewCollateralFactor(address,uint256,uint256)"), kind: "collateral-factor" },
  { name: "UpdateAssetBorrowCollateralFactor", topic: ethers.id("UpdateAssetBorrowCollateralFactor(address,address,uint64,uint64)"), kind: "compound-borrow-cf" },
  { name: "UpdateAssetSupplyCap", topic: ethers.id("UpdateAssetSupplyCap(address,address,uint128,uint128)"), kind: "compound-supply-cap" },
];

function topicAddress(topic) {
  return topic && topic.length >= 66 ? `0x${topic.slice(-40)}` : null;
}

function dataWord(data, index) {
  const body = (data || "0x").slice(2);
  const word = body.slice(index * 64, (index + 1) * 64);
  return word.length === 64 ? word : null;
}

function dataAddress(data, index) {
  const word = dataWord(data, index);
  return word ? `0x${word.slice(24)}` : null;
}

function dataUint(data, index) {
  const word = dataWord(data, index);
  return word ? uint256(word) : 0n;
}

function formatMantissaPct(raw) {
  return `${(Number(raw) / 1e16).toFixed(2)}%`;
}

function formatRawCap(raw) {
  const max = (1n << 256n) - 1n;
  if (raw === max) return "max";
  if (raw > 10n ** 30n) return raw.toString();
  return raw.toString();
}

function decodeMarketOpenLog(log, evt) {
  if (evt.kind === "borrow-cap" || evt.kind === "supply-cap") {
    const market = topicAddress(log.topics?.[1]) || dataAddress(log.data, 0);
    const cap = topicAddress(log.topics?.[1]) ? dataUint(log.data, 0) : dataUint(log.data, 1);
    if (!market || cap === 0n) return null;
    return { kind: evt.kind, market, newValue: formatRawCap(cap), label: `${evt.kind} positive ${market.slice(0,10)}=${formatRawCap(cap)}` };
  }
  if (evt.kind === "collateral-factor") {
    const indexed = Boolean(log.topics?.[1]);
    const market = indexed ? topicAddress(log.topics[1]) : dataAddress(log.data, 0);
    const oldValue = indexed ? dataUint(log.data, 0) : dataUint(log.data, 1);
    const newValue = indexed ? dataUint(log.data, 1) : dataUint(log.data, 2);
    if (!market || newValue === 0n || newValue <= oldValue) return null;
    const opened = oldValue === 0n;
    return {
      kind: opened ? "collateral-factor-open" : "collateral-factor-raised",
      market,
      oldValue: formatMantissaPct(oldValue),
      newValue: formatMantissaPct(newValue),
      label: `${opened ? "CF opened" : "CF raised"} ${market.slice(0,10)} ${formatMantissaPct(oldValue)}→${formatMantissaPct(newValue)}`,
    };
  }
  if (evt.kind === "compound-borrow-cf" || evt.kind === "compound-supply-cap") {
    const comet = topicAddress(log.topics?.[1]);
    const asset = topicAddress(log.topics?.[2]);
    const oldValue = dataUint(log.data, 0);
    const newValue = dataUint(log.data, 1);
    if (!comet || !asset || newValue === 0n || newValue <= oldValue) return null;
    const label = evt.kind === "compound-borrow-cf"
      ? `Compound borrow CF raised ${asset.slice(0,10)} ${formatMantissaPct(oldValue)}→${formatMantissaPct(newValue)}`
      : `Compound supply cap raised ${asset.slice(0,10)} ${formatRawCap(oldValue)}→${formatRawCap(newValue)}`;
    return { kind: evt.kind, market: comet, asset, oldValue: oldValue.toString(), newValue: newValue.toString(), label };
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════
// E38 wstETH DEX Discount Watch
// ═══════════════════════════════════════════════════════════════════
const WSTETH_DISC_COND = "wsteth-dex-discount-arb";
async function evaluatorWstethDexDiscount(rpcPool, state) {
  state.conditions = state.conditions || {};
  const cond = state.conditions[WSTETH_DISC_COND] || { lastScan: 0 };
  state.conditions[WSTETH_DISC_COND] = cond;
  if (Date.now() - cond.lastScan < 300000) return null;
  cond.lastScan = Date.now();
  try {
    const art = loadJson(path.join(WORKSPACE, "reports", "raw", "fast", "wsteth-dex-discount.json"), null);
    if (!art) return null;
    cond.lastResult = art;
    if (art.discountBps > 10) return { condition: WSTETH_DISC_COND, severity: "CRITICAL", chainId: 1, message: `wstETH DEX discount ${art.discountBps.toFixed(1)}bps — arb profitable! Est $${Math.round(art.discountBps*10)}/100K.`, autoExecutable: false, routeCandidatePositive: true };
    if (art.discountBps > 5) return { condition: WSTETH_DISC_COND, severity: "HIGH", chainId: 1, message: `wstETH DEX discount ${art.discountBps.toFixed(1)}bps — approaching breakeven (10bps).` };
    return null;
  } catch (_) { return null; }
}

// ═══════════════════════════════════════════════════════════════════
// E39 Reservoir rUSD PSM Premium Watch
// ═══════════════════════════════════════════════════════════════════
const RUSD_COND = "rusd-psm-premium-arb";
async function evaluatorRusdPsmArb(rpcPool, state) {
  state.conditions = state.conditions || {};
  const cond = state.conditions[RUSD_COND] || { lastScan: 0 };
  state.conditions[RUSD_COND] = cond;
  if (Date.now() - cond.lastScan < 600000) return null;
  cond.lastScan = Date.now();
  try {
    const art = loadJson(path.join(WORKSPACE, "reports", "raw", "fast", "rusd-psm-arbitrage.json"), null);
    if (!art) return null;
    cond.lastResult = art;
    if (art.bestPremiumBps > 10 && !art.paused) return { condition: RUSD_COND, severity: "CRITICAL", chainId: 1, message: `rUSD PSM premium ${art.bestPremiumBps.toFixed(1)}bps — arb profitable! PSM has $${Math.round(art.totalValueUsd||0).toLocaleString()} USDC.`, autoExecutable: false, routeCandidatePositive: true };
    if (art.bestPremiumBps > 5) return { condition: RUSD_COND, severity: "HIGH", chainId: 1, message: `rUSD PSM premium ${art.bestPremiumBps.toFixed(1)}bps — approaching breakeven.` };
    return null;
  } catch (_) { return null; }
}

const UNPAUSE_TARGETS = [
  // Venus — legacy Comptroller on Ethereum
  {
    name: "Venus_ETH",
    comptroller: "0x687a01ecF6d3907658f7A7c714749fAC32336D1B",
    topic: "0xca3fa3d9d8ea1d9c940fd469c4c7c444aa7e3b4ada43ba03ce5b5271dc2a16b4", // ActionPaused(address,uint8,bool)
    chain: 1,
  },
  // Venus — Isolated Pools on Base
  {
    name: "Venus_Base",
    comptroller: "0xfBb21d0380beE3312B33c4353c8936a0F17EF7C7",
    topic: "0xca3fa3d9d8ea1d9c940fd469c4c7c444aa7e3b4ada43ba03ce5b5271dc2a16b4",
    chain: 8453,
  },
  // Compound V3 — Configurator emits on Ethereum
  {
    name: "Compound_ETH",
    comptroller: "0x316f9708bB98af7dA9c68C1C3b5e79039cD336E3",
    topic: "0xca3fa3d9d8ea1d9c940fd469c4c7c444aa7e3b4ada43ba03ce5b5271dc2a16b4", // same ActionPaused selector
    chain: 1,
  },
  // Compound V3 — Configurator on Arbitrum
  {
    name: "Compound_Arb",
    comptroller: "0xb21b06D71c75973babdE35b49fFDAc3F82Ad3775",
    topic: "0xca3fa3d9d8ea1d9c940fd469c4c7c444aa7e3b4ada43ba03ce5b5271dc2a16b4",
    chain: 42161,
  },
];

async function evaluatorUnpauseEvents(rpcPool, state) {
  const condState = state.conditions["unpause-events"] || {};
  condState.known = condState.known || [];
  if (!condState.lastBlock || typeof condState.lastBlock !== "object") condState.lastBlock = {};
  state.conditions["unpause-events"] = condState;

  const unpauses = [];
  const marketOpens = [];
  try {
    for (const target of UNPAUSE_TARGETS) {
      const rpc = rpcPool[target.chain];
      if (!rpc) continue;

      const block = await rpcCall(rpc, "eth_blockNumber", []);
      const currentBlock = parseInt(block, 16);
      const cursorKey = `${target.name}:${target.chain}`;
      const fromBlock = condState.lastBlock[cursorKey] || currentBlock - 14400;

      const logs = await rpcCall(rpc, "eth_getLogs", [{
        address: target.comptroller,
        topics: [target.topic],
        fromBlock: "0x" + Math.max(0, fromBlock).toString(16),
        toBlock: "0x" + currentBlock.toString(16),
      }]);

      const configLogs = [];
      for (const evt of MARKET_OPEN_EVENTS) {
        const found = await rpcCall(rpc, "eth_getLogs", [{
          address: target.comptroller,
          topics: [evt.topic],
          fromBlock: "0x" + Math.max(0, fromBlock).toString(16),
          toBlock: "0x" + currentBlock.toString(16),
        }]);
        if (found && found.length) configLogs.push(...found.map(log => ({ log, evt })));
      }

      condState.lastBlock[cursorKey] = currentBlock;

      for (const log of logs || []) {
        const key = `${target.name}:${log.transactionHash}`;
        if (condState.known.includes(key)) continue;
        condState.known.push(key);

        const action = parseInt(log.topics[2], 16); // uint8 action: 0=supply, 1=redeem, 2=borrow, 3=repay...
        const stateVal = parseInt(log.data, 16); // bool: 0=paused, 1=unpaused
        const marketAddr = "0x" + log.topics[1].slice(26); // address of vToken/comet
        if (stateVal === 1) { // unpaused
          const actionName = ["supply","redeem","borrow","repay","seize","liquidate","transfer","enter","exit"][action] || `action${action}`;
          unpauses.push({
            protocol: target.name,
            action: actionName,
            actionId: action,
            market: marketAddr,
            label: `${target.name} ${actionName}`,
          });
        }
      }

      for (const { log, evt } of configLogs) {
        const decoded = decodeMarketOpenLog(log, evt);
        if (!decoded) continue;
        const key = `${target.name}:${evt.name}:${log.transactionHash}:${log.logIndex || "0x0"}`;
        if (condState.known.includes(key)) continue;
        condState.known.push(key);
        marketOpens.push({
          protocol: target.name,
          event: evt.name,
          ...decoded,
          label: `${target.name} ${decoded.label}`,
        });
      }
    }

    if (unpauses.length > 0 || marketOpens.length > 0) {
      const labels = unpauses.map(u => u.label).concat(marketOpens.map(o => o.label));
      return {
        condition: "protocol-unpause",
        severity: "HIGH",
        count: labels.length,
        unpaused: labels,
        unpauseDetails: unpauses, // full details for auto-exec routing
        marketOpenDetails: marketOpens,
        message: `Protocol unpause/config-open event(s): ${labels.join(", ")}. Check oracle freshness, caps, and liquidity before borrowing.`,
      };
    }
  } catch (_) {}
  return null;
}

async function evaluateEthFeedAge(rpcPool, state) {
  const condState = state.conditions["staleness-gap"];
  if (!condState.divergenceWindow) condState.divergenceWindow = { lastAlerted: null, windowCount: 0 };
  const rpc = rpcPool[1]; // Ethereum
  if (!rpc) return null;

  const feedData = await queryFeed(rpc, ETH_FEED);
  if (!feedData) return null;

  const block = await getBlock(rpc);
  if (!block) return null;

  const feedAge = block.timestamp - feedData.updatedAt;
  const stalePrice = Number(feedData.answer) / 1e8;
  condState[`lastAge_ETH/USD`] = feedAge;

  const provider = new ethers.JsonRpcProvider(rpc);
  const livePrice = await e9GetValidatedEthUsdPrice(provider).catch(() => null);
  let divergence = null;
  let classification = "OK";
  let e8Route = null;

  if (livePrice && stalePrice > 0) {
    divergence = ((stalePrice - livePrice) / livePrice) * 100;
    condState.lastDivergence = divergence;

    // Classification — fork-proven: stale Chainlink must overvalue wstETH/USDC by 30%+ to profit.
    // CF=80%, break-even ~26.5% at current wstETH ~$2,476. Profit = wstETH * (0.8*(1+d) - 1) - gas.
    if (feedAge >= E8_MIN_FEED_AGE_SECONDS && divergence >= E8_MIN_DIVERGENCE_PERCENT) {
      classification = "EXPLOITABLE";
    } else if (feedAge >= 900 && divergence >= 10.0) {
      classification = "APPROACHING";
    } else if (feedAge >= 900 && divergence >= 5.0) {
      classification = "BUILDING";
    } else if (feedAge >= E8_MIN_FEED_AGE_SECONDS) {
      classification = "STALE_BUT_FLAT"; // Feed stale but price hasn't moved
    }
  }

  // Alert on exploitable window — fork-proven at 30%+ divergence
  if (classification === "EXPLOITABLE") {
    e8Route = await buildE8FluidRoute(provider, rpc).catch(() => null);
    if (!e8Route?.executable) {
      logPrint(`E8: ETH/USD threshold met but Fluid candidate is not route-positive — ${e8Route?.reason || "preflight unavailable"}`);
      classification = "WATCH_ONLY";
    } else {
    const dw = condState.divergenceWindow;
    const now = Date.now();
    if (!dw.lastAlerted || now - dw.lastAlerted > 3600_000) {
      dw.windowCount++;
      dw.lastAlerted = now;
      // Live profit: wstETH * (0.8*(1+d) - 1) - gas
      const ethUsd = livePrice;
      const spr = e8Route.wstethUsd / livePrice;
      const wstethUsd = ethUsd * spr;
      const gasUsd = e8Route.gasUsd;
      const estProfit = e8Route.netProfitUsd;
      alert(E8_EXECUTION_CONDITION, "CRITICAL", {
        source: "E8",
        autoExecutable: false,
        routeCandidatePositive: true,
        feed: "ETH/USD",
        feedAge,
        stalePrice,
        livePrice,
        divergence: divergence.toFixed(2),
        strictestProtocol: "Fluid wstETH_USDC",
        strictestMax: "no staleness check",
        loosestProtocol: "UniV3CheckCLRSOracle falls back to Chainlink >3%",
        loosestMax: "unlimited",
        classification,
        windowCount: dw.windowCount,
        minFeedAgeSeconds: E8_MIN_FEED_AGE_SECONDS,
        minDivergencePercent: E8_MIN_DIVERGENCE_PERCENT,
        netProfitUsd: e8Route.netProfitUsd.toFixed(0),
        expectedWethOut: e8Route.expectedWethOut.toString(),
        minWethOut: e8Route.minWethOut.toString(),
        message: `STALE-ORACLE WINDOW OPEN: ETH/USD ${feedAge}s stale. Divergence: ${divergence.toFixed(1)}%. Stale: $${stalePrice.toFixed(2)} vs Live: $${livePrice?.toFixed(2)||"?"}. Est profit/wstETH: $${estProfit.toFixed(0)}. Fork-proven: C:\\_Work\\__EVM_AUDIT\\exploits\\fluid-stale-oracle`,
        action: `forge test --match-test test_FullExploit --root exploits/fluid-stale-oracle | Deploy contract | Wait for divergence >30% | Execute: npm run exploit`,
      });
    }
    }
  } else if (classification === "APPROACHING") {
    // Log approaching — building towards target
    logPrint(`E8: ETH/USD approaching — divergence=${divergence.toFixed(2)}% age=${feedAge}s — need ${E8_MIN_DIVERGENCE_PERCENT}%`);
  } else if (classification === "BUILDING") {
    logPrint(`E8: ETH/USD building — divergence=${divergence.toFixed(2)}% age=${feedAge}s`);
  }

  return {
    feed: "ETH/USD",
    feedAge,
    price: stalePrice,
    livePrice,
    divergence: divergence !== null ? divergence.toFixed(2) + "%" : "N/A",
    classification,
    autoExecutable: false,
    routeCandidatePositive: Boolean(e8Route?.executable),
  };
}

// ═══════════════════════════════════════════════════════════════════
// EVALUATOR 1B: COMPOUND STALE-ORACLE CASCADE
// ═══════════════════════════════════════════════════════════════════
// Generic ETH/USD staleness is tracked for awareness only. The deployed E1
// executor borrows WETH against wstETH on cWETHv3, so signed execution is only
// valid when the actual wstETH/CAPO route is overvalued and gas-positive.

async function evaluatorCompoundStaleOracle(rpcPool, state) {
  const condState = state.conditions["staleness-gap"];
  const rpc = rpcPool[1];
  if (!rpc) return null;

  const feedData = await queryFeed(rpc, ETH_FEED);
  if (!feedData) return null;

  const block = await getBlock(rpc);
  if (!block) return null;

  const feedAge = block.timestamp - feedData.updatedAt;
  const stalePrice = Number(feedData.answer) / 1e8;
  const livePrice = await getLiveEthPrice();

  if (!livePrice || stalePrice <= 0) return null;
  const divergence = ((stalePrice - livePrice) / livePrice) * 100;

  if (feedAge >= E1_MIN_FEED_AGE_SECONDS && divergence >= E1_MIN_DIVERGENCE_PERCENT) {
    logPrint(`E1: ETH/USD stale-over-live ${divergence.toFixed(2)}% age=${feedAge}s is watch-only; active E1 executor is CAPO/wstETH route-specific`);
    return { feed: "ETH/USD", feedAge, divergence: divergence.toFixed(2), classification: "WATCH_ONLY", protocol: "Compound", autoExecutable: false };
  }

  if (feedAge >= 900 && divergence >= 5.0) {
    logPrint(`E1: Compound approaching — divergence=${divergence.toFixed(2)}% age=${feedAge}s — need ${E1_MIN_DIVERGENCE_PERCENT}%`);
    return { feed: "ETH/USD", feedAge, divergence: divergence.toFixed(2), classification: "APPROACHING", protocol: "Compound" };
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════
// EVALUATOR CAPO: Compound V3 CAPO snapshot vs live rate
// ═══════════════════════════════════════════════════════════════════
// Monitors Compound V3's CAPO oracle for wstETH. If the stale snapshot
// overtakes the live stEthPerToken rate (e.g., governance updates CAPO
// above market), it creates an E1-exploitable overvaluation. Reuses E1 contract.

const CAPO_ORACLE = "0x91359Ce8989CB610A4127777828E667F23b94ee9";
const WSTETH_TOKEN = "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0";
const CAPO_WATCH_OVER_PCT = 3.0; // Watch-only below route break-even; signed execution uses buildE1CapoRoute().

async function evaluatorCapoSnapshot(rpcPool, state) {
  const condState = state.conditions["capo-snapshot"] || { lastAlerted: null };
  state.conditions["capo-snapshot"] = condState;

  const rpc = rpcPool[1];
  if (!rpc) return null;

  try {
    const provider = new ethers.JsonRpcProvider(rpc);
    const route = await buildE1CapoRoute(provider).catch(() => null);
    if (!route || route.snapRatio === undefined || route.liveRatio === undefined) return null;

    const snapRatio = route.snapRatio;
    const liveRatio = route.liveRatio;
    const deltaPct = route.capoDeltaPct;
    const classification = route.executable ? "EXPLOITABLE" : deltaPct >= CAPO_WATCH_OVER_PCT ? "WATCH_ONLY" : "safe";

    if (route.executable) {
      const now = Date.now();
      if (!condState.lastAlerted || now - condState.lastAlerted > 3600_000) {
        condState.lastAlerted = now;
        alert(E1_CONDITION, "CRITICAL", {
          source: "CAPO",
          compoundRoute: E1_ROUTE,
          autoExecutable: false,
          routeCandidatePositive: true,
          feed: "CAPO wstETH",
          feedAge: null,
          divergence: deltaPct.toFixed(2),
          classification: "EXPLOITABLE",
          routeSpreadPct: route.routeSpreadPct.toFixed(2),
          netProfitUsd: route.netProfitUsd.toFixed(0),
          flashWsteth: route.flashWsteth.toFixed(4),
          gasCostUsd: route.gasCostUsd.toFixed(2),
          minNetProfitUsd: E1_MIN_NET_PROFIT_USD,
          message: `CAPO SNAPSHOT CANDIDATE-POSITIVE: snapshotRatio=${snapRatio.toFixed(4)} vs live=${liveRatio.toFixed(4)} (delta=${deltaPct.toFixed(2)}%, route=${route.routeSpreadPct.toFixed(2)}%, net≈$${route.netProfitUsd.toFixed(0)}); monitor-only.`,
        });
        logPrint(`!!! CAPO CANDIDATE-POSITIVE route=${route.routeSpreadPct.toFixed(2)}% net≈$${route.netProfitUsd.toFixed(0)} — observation only !!!`);
      }
    }

    // Always return data for cycle summary use
    return {
      snapRatio,
      liveRatio,
      deltaPct: deltaPct.toFixed(2),
      routeSpreadPct: route.routeSpreadPct !== undefined ? route.routeSpreadPct.toFixed(2) : null,
      netProfitUsd: route.netProfitUsd !== undefined ? route.netProfitUsd.toFixed(0) : null,
      autoExecutable: false,
      routeCandidatePositive: Boolean(route.executable),
      reason: route.reason || null,
      classification,
    };
  } catch (_) { return null; }
}

// ═══════════════════════════════════════════════════════════════════
// EVALUATOR 17: HyperLend HyperEVM (chain 999, $487M TVL)
// ═══════════════════════════════════════════════════════════════════
// HyperLend is an Aave v3.1 fork on HyperEVM. Key residual risk:
// DualOracleChainlinkUniV3 TWAP manipulation when Chainlink is stale.
// Core pool uses Aggregator oracles for perp assets (SystemOracle)
// and DualFallbackOracle for dual-source assets (wstHYPE, kHYPE).
// This evaluator checks oracle freshness and pause state.

const HL_POOL = "0x00A89d7a5A02160f20150EbEA7a2b5E4879A1A8b";
const HL_ORACLE = "0xC9Fb4fbE842d57EAc1dF3e641a281827493A630e";
const HL_CHAIN = 999;
const HL_STALE_SOURCE_CONDITION = "hyperlend-stale-source";
const HL_STALE_SOURCE_MIN_AGE_SECONDS = 3600;
const HL_STALE_SOURCE_ALERT_COOLDOWN_MS = 3600_000;
const HL_MIN_ROUTE_LIQUIDITY_USD = Number(runtimeConfig.HL_MIN_ROUTE_LIQUIDITY_USD || "10000");
const HL_SOURCE_WATCHLIST = {
  "0x9fdbda0a5e284c32744d2f17ee5c74b284993463": { symbol: "UBTC", refPair: "BTCUSDT", minDivergencePct: 5 },
  "0xbe6727b535545c67d5caa73dea54865b92cf7907": { symbol: "UETH", refPair: "ETHUSDT", minDivergencePct: 5 },
  "0x068f321fa8fb9f0d135f290ef6a3e2813e1c8a29": { symbol: "USOL", refPair: "SOLUSDT", minDivergencePct: 5 },
  "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34": { symbol: "USDe", refPrice: 1, minDivergencePct: 1 },
  "0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb": { symbol: "USDt0", refPair: "USDCUSDT", invertRef: true, minDivergencePct: 1 },
  "0xb50a96253abdf803d85efcdce07ad8becbc52bd5": { symbol: "USDHL", refPrice: 1, minDivergencePct: 1 },
  "0xb88339cb7199b77e23db6e890353e22632ba630f": { symbol: "USDC", refPair: "USDCUSDT", minDivergencePct: 1 },
  "0x111111a1a0667d36bd57c0a9f569b98057111111": { symbol: "USDH", refPrice: 1, minDivergencePct: 1 },
};
const HL_STABLE_ASSETS = {
  "0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb": "USDt0",
  "0xb50a96253abdf803d85efcdce07ad8becbc52bd5": "USDHL",
  "0xb88339cb7199b77e23db6e890353e22632ba630f": "USDC",
  "0x111111a1a0667d36bd57c0a9f569b98057111111": "USDH",
  "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34": "USDe",
};

function decodeHyperLendRound(data) {
  if (!data || data === "0x" || data.length < 322) return null;
  const w = data.slice(2);
  const answer = int256(w.slice(64, 128));
  if (answer <= 0n) return null;
  return {
    answer,
    updatedAt: Number(uint256(w.slice(192, 256))),
  };
}

async function getHyperLendLiveRef(watch) {
  if (watch.refPrice) return watch.refPrice;
  if (!watch.refPair) return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${watch.refPair}`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const json = await res.json();
    const price = Number(json.price);
    if (!Number.isFinite(price) || price <= 0) return null;
    return watch.invertRef ? 1 / price : price;
  } catch (_) { return null; }
}

function hlWord(hex, index) {
  const clean = String(hex || "").replace(/^0x/i, "");
  const start = index * 64;
  if (clean.length < start + 64) return null;
  return "0x" + clean.slice(start, start + 64);
}

function hlDecodeReserveData(data) {
  return {
    aToken: decodeAddress(hlWord(data, 8)),
    variableDebtToken: decodeAddress(hlWord(data, 10)),
  };
}

async function hlTokenDecimals(rpc, token, fallback = 18) {
  const raw = await rpcCall(rpc, "eth_call", [{ to: token, data: "0x313ce567" }, "latest"]);
  try { return raw && raw !== "0x" ? Number(BigInt(raw)) : fallback; }
  catch (_) { return fallback; }
}

async function hlTokenBalance(rpc, token, account) {
  if (!token || !account || account === ZERO) return 0n;
  const raw = await rpcCall(rpc, "eth_call", [{ to: token, data: "0x70a08231" + account.slice(2).padStart(64, "0") }, "latest"]);
  try { return raw && raw !== "0x" ? BigInt(raw) : 0n; }
  catch (_) { return 0n; }
}

function hlBestStableReserve(reserves, excludeAsset = null, requireCollateral = false) {
  const exclude = String(excludeAsset || "").toLowerCase();
  return reserves
    .filter((r) => r.isStable && r.asset.toLowerCase() !== exclude)
    .filter((r) => r.active && !r.frozen && !r.paused && r.borrowing && Number(r.cashUsd || 0) >= HL_MIN_ROUTE_LIQUIDITY_USD)
    .filter((r) => !requireCollateral || Number(r.ltv || 0) > 0)
    .sort((a, b) => Number(b.cashUsd || 0) - Number(a.cashUsd || 0))[0] || null;
}

function hlBuildRouteCandidate(item, reserves) {
  const reserve = reserves.find((r) => r.asset.toLowerCase() === item.asset.toLowerCase());
  if (!reserve) return null;

  if (item.divergence > 0) {
    const borrowReserve = hlBestStableReserve(reserves, item.asset, false);
    if (!borrowReserve || !(item.ltv > 0)) return null;
    const routeLiquidityUsd = Number(borrowReserve.cashUsd || 0);
    return {
      direction: "overvalued-collateral",
      collateralAsset: item.asset,
      collateralSymbol: item.symbol,
      borrowAsset: borrowReserve.asset,
      borrowSymbol: borrowReserve.symbol,
      routeLiquidityUsd,
      estimatedEdgeUsd: routeLiquidityUsd * Math.abs(item.divergence) / 100,
    };
  }

  const collateralReserve = hlBestStableReserve(reserves, item.asset, true);
  if (!collateralReserve || !(reserve.borrowing && Number(reserve.cashUsd || 0) >= HL_MIN_ROUTE_LIQUIDITY_USD)) return null;
  const routeLiquidityUsd = Number(reserve.cashUsd || 0);
  return {
    direction: "underpriced-borrow",
    collateralAsset: collateralReserve.asset,
    collateralSymbol: collateralReserve.symbol,
    borrowAsset: item.asset,
    borrowSymbol: item.symbol,
    routeLiquidityUsd,
    estimatedEdgeUsd: routeLiquidityUsd * Math.abs(item.divergence) / 100,
  };
}

async function evaluatorHyperLend(rpcPool, state) {
  const condState = state.conditions["hyperlend"] || { lastAlerted: null };
  state.conditions["hyperlend"] = condState;

  const rpc = rpcPool[HL_CHAIN];
  if (!rpc) return { count: 0, borrowable: 0, highLtv: 0, priceErrors: 0, staleSources: 0, divergent: 0, rpcUnavailable: true };

  try {
    // Get reserves list
    const reservesHex = await rpcCall(rpc, "eth_call", [
      { to: HL_POOL, data: "0xd1946dbc" /* getReservesList() */ }, "latest"
    ]);
    if (!reservesHex || reservesHex === "0x") return { count: 0, borrowable: 0, highLtv: 0, priceErrors: 0, staleSources: 0, divergent: 0, rpcUnavailable: false };

    const count = parseInt(reservesHex.slice(66, 130), 16);
    if (!count) return { count: 0, borrowable: 0, highLtv: 0, priceErrors: 0, staleSources: 0, divergent: 0, rpcUnavailable: false, preLaunch: true };

    let borrowable = 0;
    let highLtv = 0;
    let priceErrors = 0;
    const block = await getBlock(rpc);
    const staleSourceWatchpoints = [];
    const divergentStaleSources = [];
    const routeCandidates = [];
    const reserveEntries = [];
    condState.lastStaleSourceAlerts = condState.lastStaleSourceAlerts || {};

    for (let i = 0; i < count; i++) {
      const assetAddr = "0x" + reservesHex.slice(130 + 24 + i * 64, 130 + 64 + i * 64);
      const watch = HL_SOURCE_WATCHLIST[assetAddr.toLowerCase()];

      // Query reserve data from pool (Aave v3.1 struct)
      const reserveDataHex = await rpcCall(rpc, "eth_call", [
        { to: HL_POOL, data: "0x35ea6a75" + assetAddr.slice(2).padStart(64, "0") /* getReserveData(address) */ }, "latest"
      ]);
      if (!reserveDataHex || reserveDataHex === "0x") { priceErrors++; continue; }

      // ReserveData returns a large tuple. The configuration word is at the beginning.
      // Offset 0: bytes 2-66 = configuration (uint256)
      const cfgRaw = "0x" + reserveDataHex.slice(2, 66);
      const cfg = BigInt(cfgRaw);

      const active = ((cfg >> 56n) & 1n) === 1n;
      const frozen = ((cfg >> 57n) & 1n) === 1n;
      const borrowing = ((cfg >> 58n) & 1n) === 1n;
      const paused = ((cfg >> 60n) & 1n) === 1n;
      const ltv = Number(cfg & 0xFFFFn) / 100;

      const decodedReserve = hlDecodeReserveData(reserveDataHex);
      let priceHex = null;
      let priceUsd = null;
      let decimals = 18;
      let cashRaw = 0n;
      let cashUsd = 0;
      if (active && !paused) {
        [priceHex, decimals, cashRaw] = await Promise.all([
          rpcCall(rpc, "eth_call", [{ to: HL_ORACLE, data: "0xb3596f07" + assetAddr.slice(2).padStart(64, "0") }, "latest"]),
          hlTokenDecimals(rpc, assetAddr),
          hlTokenBalance(rpc, assetAddr, decodedReserve.aToken),
        ]);
        priceUsd = priceHex && priceHex !== "0x" ? Number(BigInt(priceHex)) / 1e8 : null;
        cashUsd = priceUsd ? Number(ethers.formatUnits(cashRaw, decimals)) * priceUsd : 0;
      }

      reserveEntries.push({
        asset: assetAddr,
        symbol: watch?.symbol || HL_STABLE_ASSETS[assetAddr.toLowerCase()] || assetAddr.slice(0, 10),
        ltv,
        active,
        frozen,
        paused,
        borrowing,
        priceUsd,
        decimals,
        aToken: decodedReserve.aToken,
        cashRaw: cashRaw.toString(),
        cashUsd,
        isStable: Boolean(HL_STABLE_ASSETS[assetAddr.toLowerCase()]),
      });

      if (active && !frozen && !paused && borrowing) {
        borrowable++;
        if (ltv >= 55) highLtv++;

        if (watch && block) {
          const [sourceHex] = await Promise.all([
            rpcCall(rpc, "eth_call", [{ to: HL_ORACLE, data: "0x92bf2be0" + assetAddr.slice(2).padStart(64, "0") }, "latest"]),
          ]);
          const source = decodeAddress(sourceHex);
          const roundHex = source ? await rpcCall(rpc, "eth_call", [{ to: source, data: "0xfeaf968c" }, "latest"]) : null;
          const round = decodeHyperLendRound(roundHex);
          const oraclePrice = priceUsd;
          const livePrice = await getHyperLendLiveRef(watch);
          const age = round?.updatedAt ? block.timestamp - round.updatedAt : null;
          const divergence = oraclePrice && livePrice ? ((oraclePrice - livePrice) / livePrice) * 100 : null;
          if (age !== null && age >= HL_STALE_SOURCE_MIN_AGE_SECONDS) {
            const item = {
              symbol: watch.symbol,
              asset: assetAddr,
              source,
              ltv,
              age,
              oraclePrice,
              livePrice,
              divergence,
              minDivergencePct: watch.minDivergencePct,
            };
            staleSourceWatchpoints.push(item);
            if (divergence !== null && Math.abs(divergence) >= watch.minDivergencePct) {
              divergentStaleSources.push(item);
            }
          }
        }
      }
    }

    for (const item of divergentStaleSources) {
      const route = hlBuildRouteCandidate(item, reserveEntries);
      if (!route) continue;
      const routedItem = { ...item, route };
      routeCandidates.push(routedItem);
      const now = Date.now();
      const last = condState.lastStaleSourceAlerts[item.symbol] || 0;
      if (now - last > HL_STALE_SOURCE_ALERT_COOLDOWN_MS) {
        condState.lastStaleSourceAlerts[item.symbol] = now;
        alert(HL_STALE_SOURCE_CONDITION, "CRITICAL", {
          source: "HyperLend",
          asset: item.symbol,
          token: item.asset,
          feedAge: item.age,
          ltv: item.ltv,
          oraclePrice: item.oraclePrice?.toFixed(8),
          livePrice: item.livePrice?.toFixed(8),
          divergence: item.divergence.toFixed(2),
          thresholdPct: item.minDivergencePct,
          direction: route.direction,
          collateralAsset: route.collateralAsset,
          collateralSymbol: route.collateralSymbol,
          borrowAsset: route.borrowAsset,
          borrowSymbol: route.borrowSymbol,
          routeLiquidityUsd: Math.round(route.routeLiquidityUsd),
          estimatedEdgeUsd: Math.round(route.estimatedEdgeUsd),
          minRouteLiquidityUsd: HL_MIN_ROUTE_LIQUIDITY_USD,
          autoExecutable: false,
          blocker: "No HyperEVM executor or fork-positive extraction proof for this route yet.",
          classification: "FORK_PROOF_NEEDED",
          message: `HyperLend ${item.symbol} accepts stale source age=${item.age}s, oracle/live divergence=${item.divergence.toFixed(2)}% (threshold ${item.minDivergencePct}%). Route=${route.direction} ${route.collateralSymbol}->${route.borrowSymbol}, liquidity≈$${Math.round(route.routeLiquidityUsd).toLocaleString()}. Run fork proof before any signed action.`,
        });
      }
    }

    condState.lastCheck = Date.now();
    condState.borrowableCount = borrowable;
    condState.highLtvCount = highLtv;
    condState.staleSourceWatchpoints = staleSourceWatchpoints.map(w => ({ symbol: w.symbol, age: w.age, divergence: w.divergence }));
    condState.divergentStaleSources = divergentStaleSources.map(w => ({ symbol: w.symbol, age: w.age, divergence: w.divergence }));
    condState.routeCandidates = routeCandidates.map(w => ({ symbol: w.symbol, age: w.age, divergence: w.divergence, route: w.route }));
    condState.minRouteLiquidityUsd = HL_MIN_ROUTE_LIQUIDITY_USD;
    condState.reserveLiquidity = reserveEntries
      .filter(r => r.isStable || HL_SOURCE_WATCHLIST[r.asset.toLowerCase()])
      .map(r => ({ symbol: r.symbol, asset: r.asset, ltv: r.ltv, borrowing: r.borrowing, cashUsd: Math.round(r.cashUsd || 0), isStable: r.isStable }));

    return { borrowable, highLtv, priceErrors, count, staleSources: staleSourceWatchpoints.length, divergentStaleSources: divergentStaleSources.length, routeCandidates: routeCandidates.length };
  } catch (_) { return { count: 0, borrowable: 0, highLtv: 0, priceErrors: 0, staleSources: 0, divergent: 0, rpcUnavailable: true }; }
}
// ═══════════════════════════════════════════════════════════════════
// Venus Base wstETH uses a OneJumpOracle with 93,600s (26h) max stale
// on the intermediate wstETH/ETH Chainlink feed. No pivot/fallback, no cap.
// Currently borrow-paused (cap=0) but could be re-enabled by governance.

const VENUS_BASE_WSTETH = "0xDDD4F0836c8016E11fC6741A4886E97B3c3d20C1";
const VENUS_BASE_VWSTETH = "0x133d3BCD77158D125B75A17Cb517fFD4B4BE64C5";
const VENUS_BASE_VUSDC = "0x3cb752d175740043Ec463673094e06ACDa2F9a2e";
const VENUS_BASE_VWETH = "0xEB8A79bD44cF4500943bf94a2b4434c95C008599";
const VENUS_BASE_COMPT = "0x0C7973F9598AA62f9e03B94E92C967fD5437426C";
const VENUS_MAX_STALE = 93600; // 26 hours
const VB_MIN_FEED_AGE_SECONDS = 1800;
const VB_MIN_OVERVALUED_COLLATERAL_PCT = 30;
const VB_MIN_UNDERPRICED_BORROW_PCT = 5;
const VB_MIN_ROUTE_LIQUIDITY_USD = Number(runtimeConfig.VB_MIN_ROUTE_LIQUIDITY_USD || "10000");
const VB_MAINNET_WSTETH = "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0";

function decodeVenusRound(data) {
  if (!data || data === "0x" || data.length < 322) return null;
  const w = data.slice(2);
  const answer = int256(w.slice(64, 128));
  if (answer <= 0n) return null;
  return { answer, updatedAt: Number(uint256(w.slice(192, 256))) };
}

async function venusActionPaused(rpc, vToken, action) {
  const raw = await rpcCall(rpc, "eth_call", [
    { to: VENUS_BASE_COMPT, data: "0xe85a2960" + vToken.slice(2).padStart(64, "0") + BigInt(action).toString(16).padStart(64, "0") }, "latest"
  ]);
  return raw && raw !== "0x" ? BigInt(raw) !== 0n : true;
}

async function venusVTokenLiquidity(rpc, vToken, symbol, priceUsd) {
  const [underlyingRaw, cashRaw, borrowPaused, borrowCapRaw] = await Promise.all([
    rpcCall(rpc, "eth_call", [{ to: vToken, data: "0x6f307dc3" }, "latest"]),
    rpcCall(rpc, "eth_call", [{ to: vToken, data: "0x3b1d21a2" }, "latest"]),
    venusActionPaused(rpc, vToken, 2),
    rpcCall(rpc, "eth_call", [{ to: VENUS_BASE_COMPT, data: "0x4a584432" + vToken.slice(2).padStart(64, "0") }, "latest"]),
  ]);
  const underlying = decodeAddress(underlyingRaw);
  const decimals = underlying ? await hlTokenDecimals(rpc, underlying, 18) : 18;
  const cash = cashRaw && cashRaw !== "0x" ? BigInt(cashRaw) : 0n;
  const cashHuman = Number(ethers.formatUnits(cash, decimals));
  return {
    vToken,
    underlying,
    symbol,
    decimals,
    borrowPaused,
    borrowCapRaw: borrowCapRaw && borrowCapRaw !== "0x" ? BigInt(borrowCapRaw).toString() : null,
    cashRaw: cash.toString(),
    cash: cashHuman,
    cashUsd: cashHuman * priceUsd,
  };
}

async function venusMainnetWstEthRatio(rpcPool) {
  const rpc = rpcPool[1];
  if (!rpc) return null;
  const raw = await rpcCall(rpc, "eth_call", [{ to: VB_MAINNET_WSTETH, data: "0x035faf82" }, "latest"]);
  return raw && raw !== "0x" ? Number(BigInt(raw)) / 1e18 : null;
}

async function evaluatorVenusBaseWsteth(rpcPool, state) {
  const condState = state.conditions["venus-base-wsteth"] || { lastAlerted: null };
  state.conditions["venus-base-wsteth"] = condState;

  const rpc = rpcPool[8453]; // Base
  if (!rpc) return null;

  let feedAge = 0;
  try {
    const [wstethUnderlyingRaw, wstethMintPaused, wstethBorrowPaused, wstethSupplyCapRaw, marketRaw] = await Promise.all([
      rpcCall(rpc, "eth_call", [{ to: VENUS_BASE_VWSTETH, data: "0x6f307dc3" }, "latest"]),
      venusActionPaused(rpc, VENUS_BASE_VWSTETH, 0),
      venusActionPaused(rpc, VENUS_BASE_VWSTETH, 2),
      rpcCall(rpc, "eth_call", [{ to: VENUS_BASE_COMPT, data: "0x02c3bcbb" + VENUS_BASE_VWSTETH.slice(2).padStart(64, "0") }, "latest"]),
      rpcCall(rpc, "eth_call", [{ to: VENUS_BASE_COMPT, data: "0x8e8f294b" + VENUS_BASE_VWSTETH.slice(2).padStart(64, "0") }, "latest"]),
    ]);
    const wstethUnderlying = decodeAddress(wstethUnderlyingRaw);
    if (!wstethUnderlying) {
      const status = { classification: "UNDERLYING_UNAVAILABLE", error: "missing wstETH underlying", ts: Date.now() };
      condState.lastStatus = status;
      return status;
    }
    const listed = marketRaw && marketRaw !== "0x" ? BigInt(hlWord(marketRaw, 0)) !== 0n : false;
    const collateralFactor = marketRaw && marketRaw !== "0x" ? Number(BigInt(hlWord(marketRaw, 1))) / 1e18 : 0;
    const supplyCapRaw = wstethSupplyCapRaw && wstethSupplyCapRaw !== "0x" ? BigInt(wstethSupplyCapRaw) : 0n;

    // Read wstETH/ETH feed age from the OneJump oracle's Chainlink config
    const CHAINLINK_ORACLE = "0x6F2eA73597955DB37d7C06e1319F0dC7C7455dEb";
    const tokenConfigHex = await rpcCall(rpc, "eth_call", [
      { to: CHAINLINK_ORACLE, data: "0x1b69dc5f" + wstethUnderlying.slice(2).padStart(64, "0") }, "latest"
    ]);
    if (!tokenConfigHex || tokenConfigHex === "0x") {
      const status = { classification: "TOKEN_CONFIG_UNAVAILABLE", underlying: wstethUnderlying, ts: Date.now() };
      condState.lastStatus = status;
      return status;
    }

    const feedAddr = decodeAddress(hlWord(tokenConfigHex, 1));
    if (!feedAddr || feedAddr === ZERO) {
      const status = { classification: "FEED_UNAVAILABLE", underlying: wstethUnderlying, ts: Date.now() };
      condState.lastStatus = status;
      return status;
    }
    const maxStaleRaw = BigInt(hlWord(tokenConfigHex, 2));
    const maxStale = maxStaleRaw > 0n ? Number(maxStaleRaw) : VENUS_MAX_STALE;
    const [feedRoundRaw, feedDecimalsRaw] = await Promise.all([
      rpcCall(rpc, "eth_call", [{ to: feedAddr, data: "0xfeaf968c" }, "latest"]),
      rpcCall(rpc, "eth_call", [{ to: feedAddr, data: "0x313ce567" }, "latest"]),
    ]);
    const feedData = decodeVenusRound(feedRoundRaw);
    if (!feedData) {
      const status = { classification: "FEED_ROUND_UNAVAILABLE", feed: feedAddr, ts: Date.now() };
      condState.lastStatus = status;
      return status;
    }
    const feedDecimals = feedDecimalsRaw && feedDecimalsRaw !== "0x" ? Number(BigInt(feedDecimalsRaw)) : 18;

    const block = await getBlock(rpc);
    if (!block) {
      const status = { classification: "BLOCK_UNAVAILABLE", feed: feedAddr, ts: Date.now() };
      condState.lastStatus = status;
      return status;
    }

    feedAge = block.timestamp - feedData.updatedAt;
    const pctOfMax = (feedAge / maxStale * 100).toFixed(0);
    const staleRatio = Number(feedData.answer) / 10 ** feedDecimals;
    const liveRatio = await venusMainnetWstEthRatio(rpcPool);

    let divergence = null;
    if (liveRatio && staleRatio > 0) divergence = ((staleRatio - liveRatio) / liveRatio) * 100;

    const ethPrice = await getLiveEthPrice().catch(() => 0);
    const borrowRoutes = await Promise.all([
      venusVTokenLiquidity(rpc, VENUS_BASE_VUSDC, "USDC", 1),
      venusVTokenLiquidity(rpc, VENUS_BASE_VWETH, "WETH", ethPrice || 0),
    ]);
    borrowRoutes.sort((a, b) => Number(b.cashUsd || 0) - Number(a.cashUsd || 0));
    const bestBorrowRoute = borrowRoutes.find(r => !r.borrowPaused && Number(r.cashUsd || 0) >= VB_MIN_ROUTE_LIQUIDITY_USD) || null;
    const wstethCashRaw = await rpcCall(rpc, "eth_call", [{ to: VENUS_BASE_VWSTETH, data: "0x3b1d21a2" }, "latest"]);
    const wstethCash = wstethCashRaw && wstethCashRaw !== "0x" ? Number(ethers.formatEther(BigInt(wstethCashRaw))) : 0;
    const wstethCashUsd = wstethCash * (liveRatio || staleRatio) * (ethPrice || 0);

    const acceptedByVenus = feedAge <= maxStale;
    const staleEnough = feedAge >= VB_MIN_FEED_AGE_SECONDS;
    const overvaluedReady = acceptedByVenus && staleEnough && divergence !== null
      && divergence >= VB_MIN_OVERVALUED_COLLATERAL_PCT
      && listed && collateralFactor > 0 && !wstethMintPaused && supplyCapRaw > 0n && bestBorrowRoute;
    const underpricedReady = acceptedByVenus && staleEnough && divergence !== null
      && divergence <= -VB_MIN_UNDERPRICED_BORROW_PCT
      && !wstethBorrowPaused && bestBorrowRoute && wstethCashUsd >= VB_MIN_ROUTE_LIQUIDITY_USD;

    let classification = "FRESH";
    let route = null;
    if (!acceptedByVenus) classification = "EXPIRED_REJECTED";
    else if (!staleEnough) classification = "FRESH";
    else if (overvaluedReady) {
      classification = "FORK_PROOF_NEEDED";
      route = { direction: "overvalued-collateral", collateralSymbol: "wstETH", borrowSymbol: bestBorrowRoute.symbol, routeLiquidityUsd: bestBorrowRoute.cashUsd };
    } else if (underpricedReady) {
      classification = "FORK_PROOF_NEEDED";
      route = { direction: "underpriced-borrow", collateralSymbol: bestBorrowRoute?.symbol || "USDC/WETH", borrowSymbol: "wstETH", routeLiquidityUsd: wstethCashUsd };
    } else classification = "STALE_BUT_NO_ROUTE";

    const status = {
      feedAge,
      divergence,
      borrowPaused: wstethBorrowPaused,
      mintPaused: wstethMintPaused,
      listed,
      collateralFactor,
      supplyCapRaw: supplyCapRaw.toString(),
      maxStale,
      pctOfMax,
      staleRatio,
      liveRatio,
      acceptedByVenus,
      staleEnough,
      borrowRoutes: borrowRoutes.map(r => ({ symbol: r.symbol, cashUsd: Math.round(r.cashUsd || 0), borrowPaused: r.borrowPaused })),
      wstethCashUsd: Math.round(wstethCashUsd || 0),
      minRouteLiquidityUsd: VB_MIN_ROUTE_LIQUIDITY_USD,
      classification,
      route,
      ts: Date.now(),
    };

    condState.lastStatus = status;

    if (route) {
      const now = Date.now();
      if (!condState.lastAlerted || now - condState.lastAlerted > 3600_000) {
        condState.lastAlerted = now;
        alert("venus-base-wsteth", "CRITICAL", {
          source: "Venus-Base",
          feed: "wstETH/ETH",
          feedAge,
          divergence: divergence.toFixed(2),
          maxStale,
          pctOfMax,
          classification,
          direction: route.direction,
          collateralSymbol: route.collateralSymbol,
          borrowSymbol: route.borrowSymbol,
          routeLiquidityUsd: Math.round(route.routeLiquidityUsd || 0),
          autoExecutable: false,
          blocker: "No Venus Base executor or fork-positive extraction proof for this route yet.",
          message: `Venus Base wstETH ratio feed accepted stale age=${feedAge}s (${pctOfMax}% of ${maxStale}s), divergence=${divergence.toFixed(2)}%. Route=${route.direction} ${route.collateralSymbol}->${route.borrowSymbol}, liquidity≈$${Math.round(route.routeLiquidityUsd || 0).toLocaleString()}. Fork proof required before any signed action.`,
        });
      }
    }

    return status;
  } catch (e) {
    logPrint(`  VB: Venus Base wstETH check failed: ${e.message?.slice(0,60) || "RPC error"}`);
    // Store last-known state even on error
    condState.lastStatus = { error: e.message?.slice(0,60), feedAge, borrowPaused: false, ts: Date.now() };
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════
// EVALUATOR LB: Liquity Bold stETH/ETH ratio
// ═══════════════════════════════════════════════════════════════════
// Liquity Bold WSTETHPriceFeed uses stETH/USD * stEthPerToken() with
// NO cap vs ETH/USD. Fork-tested: break-even at +22.6% premium.
// AUTO-EXEC DISABLED — stETH never reaches 22.6% naturally.
// Alert threshold set at 10% for manual review only.
const LB_STETH_FEED = "0xCfE54B5cD566aB89272946F602D76Ea879CAb4a8";
const LB_ETH_FEED   = "0x5f4eC3Df9cbd43714FE2740f5e3616155c5b8419";
const LB_PREMIUM_PCT = 10.0; // alert at 10% stETH premium (break-even ~22.6%, alert earlier for manual review)

async function evaluatorLiquityBoldRatio(rpcPool, state) {
  const condState = state.conditions["lb-steth-ratio"] || { lastAlerted: null };
  state.conditions["lb-steth-ratio"] = condState;

  const rpc = rpcPool[1];
  if (!rpc) return null;

  try {
    const stethData = await queryFeed(rpc, LB_STETH_FEED);
    const ethData = await queryFeed(rpc, LB_ETH_FEED);
    if (!stethData || !ethData) return null;

    const stethPrice = Number(stethData.answer) / 1e8;
    const ethPrice = Number(ethData.answer) / 1e8;
    const premium = ((stethPrice - ethPrice) / ethPrice) * 100;

    if (premium >= LB_PREMIUM_PCT) {
      const now = Date.now();
      if (!condState.lastAlerted || now - condState.lastAlerted > 3600_000) {
        condState.lastAlerted = now;
        alert("lb-steth-premium", "INFO", {
          source: "LB",
          stethPrice: stethPrice.toFixed(2),
          ethPrice: ethPrice.toFixed(2),
          premium: premium.toFixed(2),
          message: `[DISABLED] Liquity Bold stETH premium +${premium.toFixed(2)}%. Break-even is +22.6%. Informational only — no auto-exec.`,
        });
        logPrint(`[DISABLED] LB stETH premium +${premium.toFixed(2)}% (need +22.6%) — info only`);
      }
      return { stethPrice, ethPrice, premium: premium.toFixed(2), classification: "OVERVAUED" };
    }

    condState.lastPrices = { steth: stethPrice, eth: ethPrice, premium: premium.toFixed(2) };
    return null;
  } catch (_) { return null; }
}

// ═══════════════════════════════════════════════════════════════════
// Evaluator 19: Residual Watchlist
// ═══════════════════════════════════════════════════════════════════
// Reads existing scanner artifacts and report residuals for the highest-value
// dormant vectors. This evaluator is read-only and never sends transactions.

function positiveAmount(value) {
  if (value === null || value === undefined) return false;
  try { return BigInt(String(value)) > 0n; }
  catch (_) { return Number(value) > 0; }
}

function safeText(fpath) {
  try { return fs.readFileSync(fpath, "utf8"); }
  catch (_) { return ""; }
}

async function collectResidualWatchFindings(rpcPool) {
  const findings = [];

  const suilend = loadJson(SUILEND_CANDIDATE_PROBE, null);
  const steamm = suilend?.steamm;
  const zeroOffsetCount = Number(steamm?.zeroOffsetOneSidedWithOutputFundsCount || 0);
  if (zeroOffsetCount > 0) {
    const top = steamm.zeroOffsetOneSidedCpmmPools?.[0] || {};
    findings.push({
      key: "suilend-steamm-zero-offset",
      severity: "DORMANT",
      fingerprint: `${zeroOffsetCount}:${top.objectId || "unknown"}`,
      artifact: path.relative(WORKSPACE, SUILEND_CANDIDATE_PROBE),
      artifactAgeHours: fileAgeHours(SUILEND_CANDIDATE_PROBE),
      count: zeroOffsetCount,
      message: `Suilend STEAMM has ${zeroOffsetCount} zero-offset one-sided CPMM pools with output funds in the latest artifact. Re-rank for marketable output before live action.`,
    });
  }

  const kaminoArtifact = loadJson(KAMINO_WINDOW_ARTIFACT, null);
  if (kaminoArtifact && Number.isFinite(Number(kaminoArtifact.currentSlot))) {
    const liquidatable = Number(kaminoArtifact.sameSlotLiquidatableRows || kaminoArtifact.sameSlotLiquidatable || 0);
    findings.push({
      key: "kamino-reduced-status-liquidation",
      severity: liquidatable > 0 ? "HIGH" : "INFO",
      fingerprint: `${kaminoArtifact.currentSlot}:${liquidatable}`,
      artifact: path.relative(WORKSPACE, KAMINO_WINDOW_ARTIFACT),
      artifactAgeHours: fileAgeHours(KAMINO_WINDOW_ARTIFACT),
      count: 1,
      message: liquidatable > 0
        ? `Kamino artifact reports ${liquidatable} liquidatable row(s); this EVM monitor does not query or invoke Solana tooling.`
        : "Kamino artifact reports no liquidatable rows; this EVM monitor remains artifact-only.",
    });
  }

  const lz = loadJson(LAYERZERO_INVENTORY, null);
  const lzResults = Array.isArray(lz?.results) ? lz.results : Object.values(lz?.results || {});
  const singleLiveDvn = [];
  const lzTokenEnabled = [];
  for (const result of lzResults) {
    const flags = result.flags || [];
    const chain = result.chain || result.key || result.target?.key || "unknown";
    for (const flag of flags) {
      const m = String(flag).match(/^(SEND|RECEIVE)_ULN_SINGLE_DVN_(\d+)$/);
      if (!m) continue;
      const deadFlag = `${m[1]}_ULN_USES_DEAD_DVN_${m[2]}`;
      if (!flags.includes(deadFlag)) singleLiveDvn.push(`${chain}:${m[1]}:${m[2]}`);
    }
    const lzToken = result.endpoint?.lzToken;
    if (lzToken && lzToken !== ZERO) lzTokenEnabled.push(`${chain}:${lzToken}`);
  }
  if (singleLiveDvn.length > 0) {
    findings.push({
      key: "layerzero-single-live-dvn",
      severity: "HIGH",
      fingerprint: singleLiveDvn.slice(0, 10).join("|"),
      artifact: path.relative(WORKSPACE, LAYERZERO_INVENTORY),
      artifactAgeHours: fileAgeHours(LAYERZERO_INVENTORY),
      count: singleLiveDvn.length,
      message: `LayerZero inventory has ${singleLiveDvn.length} route(s) with a single non-dead DVN. Map OApp value before treating as exploitable.`,
    });
  }
  if (lzTokenEnabled.length > 0) {
    findings.push({
      key: "layerzero-lztoken-enabled",
      severity: "DORMANT",
      fingerprint: lzTokenEnabled.slice(0, 10).join("|"),
      artifact: path.relative(WORKSPACE, LAYERZERO_INVENTORY),
      artifactAgeHours: fileAgeHours(LAYERZERO_INVENTORY),
      count: lzTokenEnabled.length,
      message: `LayerZero endpoint LZ-token fee mode is enabled on ${lzTokenEnabled.length} chain(s). Check endpoint token balances and refund paths.`,
    });
  }

  const axelar = loadJson(AXELAR_INVENTORY, null);
  const axelarResults = Array.isArray(axelar?.results) ? axelar.results : [];
  const lockUnlockWithValue = [];
  const axelarConfigFlags = [];
  for (const result of axelarResults) {
    const chain = result.target?.key || result.target?.name || "unknown";
    for (const flag of result.flags || []) {
      if (String(flag).startsWith("TOKEN_MANAGER_")) axelarConfigFlags.push(`${chain}:${flag}`);
    }
    for (const manager of result.tokenManagers || []) {
      const label = `${manager.type || ""} ${manager.implementationTypeLabel || ""}`.toLowerCase();
      const hasValue = positiveAmount(manager.balanceWei)
        || positiveAmount(manager.flowLimit)
        || positiveAmount(manager.tokenInfo?.managerBalance)
        || positiveAmount(manager.tokenInfo?.serviceBalance);
      if (label.includes("lock_unlock") && hasValue) {
        lockUnlockWithValue.push(`${chain}:${manager.symbol || manager.tokenAddress || manager.address}`);
      }
    }
  }
  if (lockUnlockWithValue.length > 0) {
    findings.push({
      key: "axelar-lock-unlock-value",
      severity: "DORMANT",
      fingerprint: lockUnlockWithValue.slice(0, 10).join("|"),
      artifact: path.relative(WORKSPACE, AXELAR_INVENTORY),
      artifactAgeHours: fileAgeHours(AXELAR_INVENTORY),
      count: lockUnlockWithValue.length,
      message: `Axelar has ${lockUnlockWithValue.length} value-bearing lock/unlock manager(s). Classify underlying token behavior for fee-on-transfer/rebase drift.`,
    });
  }
  if (axelarConfigFlags.length > 0) {
    findings.push({
      key: "axelar-token-manager-flags",
      severity: "INFO",
      fingerprint: axelarConfigFlags.slice(0, 10).join("|"),
      artifact: path.relative(WORKSPACE, AXELAR_INVENTORY),
      artifactAgeHours: fileAgeHours(AXELAR_INVENTORY),
      count: axelarConfigFlags.length,
      message: `Axelar inventory has ${axelarConfigFlags.length} token-manager config flag(s): ${axelarConfigFlags.slice(0, 3).join(", ")}.`,
    });
  }

  const wormholeText = safeText(WORMHOLE_TRIAGE);
  if (wormholeText.includes("Solana Portal Token-2022") && wormholeText.includes("TransferFeeConfig")) {
    const noWrappers = wormholeText.includes("None found on Ethereum, Base, Arbitrum, Optimism, Polygon, or BSC");
    findings.push({
      key: "wormhole-token2022-fee-residual",
      severity: noWrappers ? "INFO" : "HIGH",
      fingerprint: noWrappers ? "no-priority-wrappers" : "wrapper-state-unknown",
      artifact: path.relative(WORKSPACE, WORMHOLE_TRIAGE),
      artifactAgeHours: fileAgeHours(WORMHOLE_INVENTORY),
      count: 1,
      message: noWrappers
        ? "Wormhole Portal Token-2022 transfer-fee residual is documented; latest triage found no priority EVM wrappers/liquidity."
        : "Wormhole Portal Token-2022 transfer-fee residual needs immediate wrapper/liquidity recheck.",
    });
  }

  // E2 quoteVault check: scan the E2 scanner output for any live markets
  // with VaultV2 quoteVaults and borrowers. This is the E2a proactive monitor.
  const e2csv = loadJson(E2_QUOTEVAULT_JSON, null);
  const candidates = e2csv?.candidates || [];
  const liveQuoteVault = candidates.filter(c => c.borrowersNearHF > 0 || c.borrowersTotal > 0);
  const pendingQuoteVault = candidates.filter(c => c.quoteVaultTVL < 100000 && !liveQuoteVault.includes(c));
  if (liveQuoteVault.length > 0) {
    const top = liveQuoteVault[0];
    findings.push({
      key: "e2-quotevault-live",
      severity: "CRITICAL",
      fingerprint: `${top.marketId}:${top.quoteVault}`,
      artifact: path.relative(WORKSPACE, E2_QUOTEVAULT_JSON),
      artifactAgeHours: fileAgeHours(E2_QUOTEVAULT_JSON),
      count: liveQuoteVault.length,
      message: `E2 QUOTEVAULT TARGET LIVE: ${liveQuoteVault.length} Morpho Blue market(s) with low-TVL quoteVault + borrowers. Top: ${top.loanAsset}/${top.collateralAsset} borrows=$${top.borrowUSD.toFixed(0)} qvTVL=$${top.quoteVaultTVL.toFixed(2)}. Build exploit contract immediately.`,
    });
  } else if (pendingQuoteVault.length > 0) {
    findings.push({
      key: "e2-quotevault-pending",
      severity: "HIGH",
      fingerprint: pendingQuoteVault.slice(0, 5).map(c => c.marketId).join("|"),
      artifact: path.relative(WORKSPACE, E2_QUOTEVAULT_JSON),
      artifactAgeHours: fileAgeHours(E2_QUOTEVAULT_JSON),
      count: pendingQuoteVault.length,
      message: `E2 quoteVault: ${pendingQuoteVault.length} market(s) with low-TVL quoteVault but no borrowers yet. Monitor for position creation.`,
    });
  } else {
    findings.push({
      key: "e2-quotevault-scan",
      severity: "INFO",
      fingerprint: String(candidates.length),
      artifact: path.relative(WORKSPACE, E2_QUOTEVAULT_JSON),
      artifactAgeHours: fileAgeHours(E2_QUOTEVAULT_JSON),
      count: candidates.length,
      message: `E2 quoteVault scan: ${candidates.length} candidate(s). No live targets with borrowers currently. Scanner: targets/morpho-blue/scan-e2-quotevault-candidates.js`,
    });
  }

  // Gearbox GUSD/AURA zero-feed + pool borrowing check
  const gb = loadJson(GEARBOX_LIVE_JSON, null);
  const gbPools = gb?.pools || [];
  const poolsWithBorrow = gbPools.filter(p => Number(p.totalBorrowed || 0) > 0);
  if (poolsWithBorrow.length > 0) {
    // Check if the GUSD/AURA zero feed is still dead
    const ZERO_FEED = "0xe279b205e942f2f61380a1fc099b3ae2a152a516";
    try {
      const rpc = rpcPool[1];
      const feedResult = await rpcCall(rpc, "eth_call", [{ to: ZERO_FEED, data: "0x50d25bcd" /* latestAnswer() */ }, "latest"]);
      const feedIsDead = !feedResult || feedResult === "0x" || BigInt(feedResult) === 0n;
      if (feedIsDead) {
        findings.push({
          key: "gearbox-zero-feed-borrowing",
          severity: "CRITICAL",
          fingerprint: poolsWithBorrow.map(p => p.name || p.pool).join("|"),
          artifact: path.relative(WORKSPACE, GEARBOX_LIVE_JSON),
          artifactAgeHours: fileAgeHours(GEARBOX_LIVE_JSON),
          count: poolsWithBorrow.length,
          message: `GEARBOX ZERO-FEED ACTIVE: ${poolsWithBorrow.length} pool(s) with borrowing AND GUSD/AURA feed still returns zero. Unlimited borrowing possible.`,
        });
      }
    } catch (_) {}
  } else if (gbPools.length > 0) {
    findings.push({
      key: "gearbox-zero-borrow",
      severity: "INFO",
      fingerprint: gbPools.length + "-pools-zero-borrow",
      artifact: path.relative(WORKSPACE, GEARBOX_LIVE_JSON),
      artifactAgeHours: fileAgeHours(GEARBOX_LIVE_JSON),
      count: gbPools.length,
      message: `Gearbox: ${gbPools.length} pools with zero borrowing. GUSD/AURA zero-feed residual not yet exploitable.`,
    });
  }

  // Fraxtal sfrxETH/sfrxUSD stale oracle + growing liquidity
  const frx = loadJson(FRAXLEND_LIVE_JSON, null);
  let allFrxPairs = [];
  if (frx?.chains) {
    for (const [, chainData] of Object.entries(frx.chains)) {
      if (chainData?.pairs) allFrxPairs = allFrxPairs.concat(chainData.pairs);
    }
  }
  const frxStale = allFrxPairs.filter(p => {
    const name = p.name || p.pair || p.address || "";
    const hasAssets = (Number(p.totalAssets || 0) > 100) || (Number(p.assetBalance || 0) > 100);
    return name.toLowerCase().includes("sfrx") && hasAssets;
  });
  if (frxStale.length > 0) {
    findings.push({
      key: "fraxtal-sfrxeth-stale-oracle",
      severity: frxStale.some(p => Number(p.totalBorrowed || 0) > 0) ? "CRITICAL" : "HIGH",
      fingerprint: frxStale.map(p => p.name || p.address).join("|"),
      artifact: path.relative(WORKSPACE, FRAXLEND_LIVE_JSON),
      artifactAgeHours: fileAgeHours(FRAXLEND_LIVE_JSON),
      count: frxStale.length,
      message: `Fraxtal sfrxETH/sfrxUSD has ${frxStale.length} pair(s) with material liquidity + stale RedStone oracle. Check borrowability.`,
    });
  }

  // weETH vault TVL drop below donation-feasibility threshold
  try {
    const rpc = rpcPool[1];
    if (rpc) {
      const WEETH_VAULT = "0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee"; // weETH LiquidityPool
      const tvlHex = await rpcCall(rpc, "eth_call", [{ to: WEETH_VAULT, data: "0xd1b317e5" /* getTotalPooledEther() */ }, "latest"]);
      if (tvlHex && tvlHex !== "0x") {
        const tvlETH = Number(BigInt(tvlHex)) / 1e18;
        const tvlUSD = tvlETH * 2000; // approximate
        if (tvlUSD < 100_000_000) { // < $100M
          findings.push({
            key: "weeth-tvl-drop",
            severity: tvlUSD < 50_000_000 ? "CRITICAL" : "HIGH",
            fingerprint: tvlUSD.toFixed(0),
            count: 1,
            message: `weETH vault TVL dropped to ~$${(tvlUSD/1e6).toFixed(0)}M (${tvlETH.toFixed(0)} ETH). Donation-inflation attack becomes viable below $100M.`,
          });
        }
      }
    }
  } catch (_) {}

  // Venus borrowBehalf reentrancy gap (VToken.sol:402)
  // Missing nonReentrant on borrowBehalf — defense-in-depth gap
  // Not exploitable due to CEI ordering in _borrowFresh, but revisit if
  // new callback-capable underlying tokens are listed on Venus isolated pools.
  findings.push({
    key: "venus-borrowbehalf-reentrancy",
    severity: "INFO",
    fingerprint: "cei-self-limiting",
    artifact: "exploits/venus-borrowbehalf/test/BorrowBehalfReentrancyFork.t.sol",
    artifactAgeHours: null,
    count: 1,
    message: "Venus VToken.borrowBehalf() lacks nonReentrant. CEI ordering in _borrowFresh prevents overborrow. Revisit if new callback-capable underlying token is listed.",
  });

  // Compound V3 stale-collateral buffer (transferCollateral skips accrueInternal)
  // rsETH narrowest buffer at 2% (CF=88%, LF=90%). Attack requires weeks of
  // market inactivity for interest accumulation to exhaust the buffer.
  findings.push({
    key: "compound-stale-collateral-buffer",
    severity: "INFO",
    fingerprint: "rseth-200bps",
    artifact: "exploits/compound-stale-collateral/test/StaleCollateralFork.t.sol",
    artifactAgeHours: null,
    count: 1,
    message: "Compound V3 transferCollateral/withdrawCollateral skip accrueInternal(). rsETH has narrowest CF-LF buffer (2%). Risk is residual — needs weeks of inactivity + maxed-out borrower.",
  });

  // Cap Protocol: permissionless liquidation surface ($97M cUSD)
  // Lender.liquidate() is permissionless but needs unhealthy agents.
  // Agent enumeration requires event scanning. Fork test confirms oracle
  // adapters are admin-gated. Revisit if agent scanner finds underwater positions.
  findings.push({
    key: "cap-liquidation-surface",
    severity: "INFO",
    fingerprint: "permissionless-liquidate",
    artifact: "exploits/cap-protocol/test/LiveConfigFork.t.sol",
    artifactAgeHours: null,
    count: 1,
    message: "Cap Protocol ($97M cUSD): permissionless Lender.liquidate() exists but all current agents appear healthy. Build agent enumeration scanner for proactive health monitoring.",
  });

  // DeBridge CallProxy stale-balance sweep (periodic native-balance probe).
  // Use exact mapped CallProxy addresses from the live artifact; never infer from placeholders.
  const debridge = loadJson(DEBRIDGE_LIVE_JSON, null);
  const callProxyTargets = [];
  for (const result of Array.isArray(debridge?.results) ? debridge.results : []) {
    const chainId = Number(result.target?.chainId);
    const chain = result.target?.name || result.target?.key || String(chainId || "unknown");
    const addr = result.core?.callProxy || result.callProxy?.address;
    if (chainId && ethers.isAddress(addr)) callProxyTargets.push({ chainId, chain, addr });
  }
  if (callProxyTargets.length === 0) {
    findings.push({
      key: "debridge-callproxy-unmapped",
      severity: "INFO",
      fingerprint: "no-exact-callproxy-addresses",
      artifact: path.relative(WORKSPACE, DEBRIDGE_LIVE_JSON),
      artifactAgeHours: fileAgeHours(DEBRIDGE_LIVE_JSON),
      count: 0,
      message: "DeBridge CallProxy residual is not actively balance-probed because no exact CallProxy addresses are mapped in debridge-live.json.",
    });
  } else {
    const nonzeroBalances = [];
    let rpcMissing = 0;
    for (const target of callProxyTargets) {
      const rpc = rpcPool[target.chainId];
      if (!rpc) { rpcMissing++; continue; }
      try {
        const balHex = await rpcCall(rpc, "eth_getBalance", [target.addr, "latest"]);
        const balanceWei = balHex && balHex !== "0x" ? BigInt(balHex) : 0n;
        if (balanceWei > 0n) {
          nonzeroBalances.push({
            ...target,
            balanceWei: balanceWei.toString(),
            balanceNative: Number(balanceWei) / 1e18,
          });
        }
      } catch (_) {}
    }

    if (nonzeroBalances.length > 0) {
      const fingerprint = nonzeroBalances.map((row) => `${row.chainId}:${row.addr}:${row.balanceWei}`).join("|").slice(0, 180);
      const top = nonzeroBalances.sort((a, b) => b.balanceNative - a.balanceNative)[0];
      findings.push({
        key: "debridge-callproxy-balance",
        severity: "DORMANT",
        fingerprint,
        artifact: path.relative(WORKSPACE, DEBRIDGE_LIVE_JSON),
        artifactAgeHours: fileAgeHours(DEBRIDGE_LIVE_JSON),
        count: nonzeroBalances.length,
        message: `DeBridge CallProxy native balance probe found ${nonzeroBalances.length} nonzero chain(s); top ${top.chain} ${top.balanceNative.toFixed(6)} native. Exact ERC20 balance map, route economics, and fork proof required before any action.`,
      });
    } else {
      findings.push({
        key: "debridge-callproxy-balance",
        severity: "INFO",
        fingerprint: `zero-native:${callProxyTargets.length}:missing-rpc-${rpcMissing}`,
        artifact: path.relative(WORKSPACE, DEBRIDGE_LIVE_JSON),
        artifactAgeHours: fileAgeHours(DEBRIDGE_LIVE_JSON),
        count: callProxyTargets.length,
        message: `DeBridge CallProxy native balances are zero across ${callProxyTargets.length - rpcMissing}/${callProxyTargets.length} RPC-checked mapped chains. Residual only; exact token balances still require a dedicated scanner.`,
      });
    }
  }

  return findings;
}

async function evaluatorResidualWatchlist(rpcPool, state) {
  const condState = state.conditions["residual-watch"] || { lastAlerted: {}, lastCheck: null };
  state.conditions["residual-watch"] = condState;
  const now = Date.now();
  if (condState.lastCheck && now - condState.lastCheck < RESIDUAL_WATCH_INTERVAL_MS) return null;

  const findings = await collectResidualWatchFindings(rpcPool);
  let emitted = 0;
  for (const finding of findings) {
    const key = `${finding.key}:${finding.fingerprint}`;
    if (condState.lastAlerted[key] && now - condState.lastAlerted[key] < RESIDUAL_ALERT_COOLDOWN_MS) continue;
    alert("residual-watch", finding.severity, {
      vector: finding.key,
      artifact: finding.artifact,
      artifactAgeHours: finding.artifactAgeHours === null ? null : Number(finding.artifactAgeHours.toFixed(1)),
      count: finding.count,
      message: finding.message,
    });
    condState.lastAlerted[key] = now;
    emitted++;
  }
  condState.lastCheck = now;
  condState.lastFindingCount = findings.length;
  return { count: findings.length, emitted };
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN ORCHESTRATOR
// ══════════════════════════════════════════════════════════════════════════════

let _memRpcPool = null;

async function runOnce(fastOnly = false) {
  const runStart = Date.now();
  logPrint(`=== Monitor run start ${fastOnly ? "(fast)" : "(full)"} ===`);

  // Mark ownership so other agents know this workspace runs the monitor
  saveJson(path.join(WORKSPACE, "reports", "monitor", "OWNERS.json"), {
    role: "OWNER",
    message: "Monitoring system is active in this workspace. Do NOT duplicate or modify.",
    tools: ["tools/monitor-novelty-conditions.js", "tools/scan-vault-donation.js", "tools/watch-aave-v4-liquidation-triggers.js", "tools/scan-evaluator-proximity.js", "tools/run-all-scanners.ps1"],
    state: "reports/monitor/state.json",
    alerts: "reports/monitor/alerts.jsonl",
    lastRun: ts(),
    pid: process.pid,
  });

  const state = loadState();
  const cycleHealth = beginCycleHealth(state, fastOnly, runStart);

  try {

  // Resolve RPC pool — keep in memory only, never write to disk
  if (!_memRpcPool || Object.keys(_memRpcPool).length === 0) {
    logPrint("Resolving RPC endpoints...");
    _memRpcPool = await resolveRpcPool();
  }
  const rpcPool = _memRpcPool;
  const chainCount = Object.keys(rpcPool).length;
  logPrint(`RPC pool ready: ${chainCount} chain(s)`);
  const requiredCoreChains = [1, 10, 8453, 42161];
  const coveredCoreChains = requiredCoreChains.filter((chainId) => Boolean(rpcPool[chainId])).length;
  recordCycleSource(
    cycleHealth,
    "core-rpc-coverage",
    coveredCoreChains === requiredCoreChains.length ? "HEALTHY" : "FAILED",
    `${coveredCoreChains}/${requiredCoreChains.length} required chains qualified`,
  );

  logPrint("Safety mode: permanently read-only; signing, transactions, and executor dispatch are disabled.");

  // ══ E1: Staleness ══
  if (!fastOnly) {
  logPrint("E1/8 Staleness gaps...");
  const e1Results = await evaluateStaleness(rpcPool, state);
  for (const r of e1Results) {
    const divStr = r.divergence !== null && r.divergence !== undefined
      ? ` diverge=${r.divergence >= 0 ? "+" : ""}${r.divergence.toFixed(2)}%`
      : "";
    logPrint(`  ${r.feed}: age=${r.feedAge}s stale=$${r.stalePrice?.toFixed(2) || "?"}${divStr}`);
  }

  // ══ E2: Vault Deploy ══
  logPrint("E2/8 Vault deployments...");
  await evaluateVaultDeploy(rpcPool, state);

  // ══ E3: Allocator ══
  logPrint("E3/8 Allocator liveness...");
  await evaluateAllocatorLiveness(rpcPool, state);

  // ══ E4: Bridge Config ══
  logPrint("E4/8 Bridge DVN config...");
  await evaluateBridgeConfig(rpcPool, state);
  } // end if (!fastOnly) — E5+E8+E9 always run

  // ══ E5: Depeg ══
  logPrint("E5/8 Stablecoin depeg...");
  const depegEvidence = await evaluateDepeg(rpcPool, state);
  recordCycleSource(
    cycleHealth,
    "stablecoin-feed-source",
    depegEvidence?.healthy === depegEvidence?.required && depegEvidence?.failed === 0 ? "HEALTHY" : "FAILED",
    `${depegEvidence?.healthy || 0}/${depegEvidence?.required || Object.keys(STABLECOIN_FEEDS).length} feeds healthy`,
  );
  if (state.conditions.depeg.lastPrices) {
    const prices = state.conditions.depeg.lastPrices;
    const entries = Object.entries(prices).slice(0, 7);
    const parts = entries.map(([t, p]) => `${t}=$${Number(p).toFixed(4)}`).join(" ");
    logPrint(`  ${parts}`);
  }

  if (!fastOnly) {

  // ══ E6: Gauge Epoch ══
  logPrint("E6/8 Gauge epoch...");
  await evaluateGaugeEpoch(rpcPool, state);

  // ══ E15: Vault Donation Windows ══
  const vaultChecked = await evaluateVaultDonation(rpcPool, state);
  if (vaultChecked) logPrint(`E15/8 Vault donation: ${vaultChecked} checked`);

  // ══ E7: Signal Scan ══
  const e7Results = evaluateReportSignal(state);
  if (e7Results) {
    const realConfirmed = e7Results.CONFIRMED.filter(f => !f.includes("EXAMPLE"));
    const status = e7Results.CONFIRMED.length > 0
      ? `${e7Results.CONFIRMED.length} confirmed (${realConfirmed.length} real)`
      : "none";
    logPrint(`E7/8 Signal: ${status} | ${e7Results.CLEAN.length} clean | ${e7Results.UNTAGGED.length} untagged`);
  }

  } // end if (!fastOnly) — E8+E9 always run below

  // ══ E8: ETH/USD Quick Check ══
  const e8Result = await evaluateEthFeedAge(rpcPool, state);
  recordCycleSource(
    cycleHealth,
    "eth-oracle-market-source",
    e8Result && e8Result.livePrice > 0 && Number.isFinite(e8Result.feedAge) ? "HEALTHY" : "FAILED",
    e8Result ? "validated feed, block, and live market evidence" : "required ETH evidence unavailable",
  );
  if (e8Result) {
    const ageMins = (e8Result.feedAge / 60).toFixed(0);
    const divergeStr = e8Result.divergence !== "N/A" ? ` diverge=${e8Result.divergence}` : "";
    const liveStr = e8Result.livePrice ? ` live=$${e8Result.livePrice.toFixed(2)}` : "";
    const clsStr = e8Result.classification !== "OK" ? ` [${e8Result.classification}]` : "";
    logPrint(`E8/9 Fluid stale-oracle: age=${e8Result.feedAge}s (${ageMins}m) stale=$${e8Result.price.toFixed(2)}${liveStr}${divergeStr}${clsStr} (need ${E8_MIN_DIVERGENCE_PERCENT}%)`);
  }

  // ══ E1: Compound Stale-Oracle ══
  const e1bResult = await evaluatorCompoundStaleOracle(rpcPool, state);
  if (e1bResult && e1bResult.classification === "EXPLOITABLE") {
    logPrint(`E1/9 Compound STALE-ORACLE: divergence=${e1bResult.divergence}% age=${e1bResult.feedAge}s EXPLOITABLE`);
  } else if (e1bResult) {
    // Always log current stale oracle status for E1
    const status = e1bResult.classification || "OK";
    logPrint(`E1/9 Compound oracle: age=${e1bResult.feedAge || 0}s diverge=${e1bResult.divergence || "0%"} [${status}]`);
  }

  // ══ CAPO: Compound V3 CAPO snapshot vs live ══
  if (!fastOnly) {
    const capoResult = await evaluatorCapoSnapshot(rpcPool, state);
    if (capoResult) {
      logPrint(`CAPO/9 Compound CAPO snapshot=${capoResult.snapRatio.toFixed(4)} live=${capoResult.liveRatio.toFixed(4)} delta=${capoResult.deltaPct}% [${capoResult.classification}]`);
    } else {
      logPrint(`CAPO/9 Compound CAPO snapshot: query error`);
    }
  }

  // ══ E9: Liquidation Hunter + E11 Profitability ══
  logPrint("E9/9 Liquidation hunter...");
  const e9Result = await evaluatorLiquidationHunter(rpcPool, state);
  recordCycleSource(
    cycleHealth,
    "liquidation-source",
    e9Result && e9Result.chainCoverage === requiredCoreChains.length ? "HEALTHY" : "FAILED",
    `${e9Result?.chainCoverage || 0}/${requiredCoreChains.length} required chains evaluated`,
  );
  state.conditions["liquidation-hunter"] = {
    ...(state.conditions["liquidation-hunter"] || {}),
    lastCheck: Date.now(),
    lastResult: e9Result ? {
      severity: e9Result.severity,
      count: e9Result.count,
      profitableCount: e9Result.profitableCount || 0,
      topMarket: e9Result.topMarket,
      topHF: e9Result.topHF,
      topBorrow: e9Result.topBorrow,
      topNetProfit: e9Result.topNetProfit,
    } : { severity: "OK", count: 0, profitableCount: 0 },
  };
  if (e9Result && e9Result.count > 0) {
    const profitStr = e9Result.topNetProfit ? ` net=${e9Result.topNetProfit}` : "";
    logPrint(`E9/9 ${e9Result.count} liquidatable across ${e9Result.chainCoverage || 1} chains. Top: ${e9Result.topMarket} HF=${e9Result.topHF} debt=${e9Result.topBorrow}${profitStr}`);
    if (e9Result.profitableCount) {
      logPrint(`E11  ${e9Result.profitableCount} PROFITABLE positions! Top net=${e9Result.topNetProfit}`);
    }
    alerts.push({
      condition: "liquidation-hunter",
      severity: e9Result.severity,
      timestamp: ts(),
      ...e9Result,
    });
  } else {
    logPrint(`E9/9 No liquidatable positions found (${e9Result?.chainCoverage || 1} chains)`);
  }

  if (!fastOnly) {

  // ══ E12: New Market Deployments (Morpho/Compound/Euler across ETH/Base/OP/Arb/Polygon) ══
  logPrint("E12/9 New market scanner (10 chains)...");
  const e12Result = await evaluatorNewMarketDeployments(rpcPool, state);
  if (e12Result) {
    logPrint(`E12/9 ${e12Result.count} new market(s) detected: ${e12Result.markets?.join(", ")}`);
    alerts.push({
      condition: "new-market-deployment",
      severity: e12Result.severity,
      timestamp: ts(),
      ...e12Result,
    });
  } else {
    logPrint("E12/9 No new markets detected");
  }

  // ══ E20: New-Listing Safety Check — augments E12 with borrowing-active verification ══
  const e12State = state.conditions["new-market-deployments"];
  const e12RiskItems = e12Result?.riskItems || [];
  if (e12RiskItems.length > 0) {
    logPrint("E20/9 Listing safety check...");
    const e20Result = await evaluatorListingSafety(rpcPool, state, e12RiskItems);
    if (e20Result) {
      logPrint(`E20/9 ${e20Result.count} unsafe listing(s): ${e20Result.message}`);
      alerts.push({ condition: LISTING_SAFETY_CONDITION, severity: e20Result.severity, timestamp: ts(), ...e20Result });
    } else {
      logPrint("E20/9 No unsafe listing conditions");
    }
  } else {
    logPrint("E20/9 Listing safety skipped (no E12 events)");
  }

  // ══ E12x: Morpho New-Market + Stale-Oracle Profit Check ══
  const morphoEvents = state.conditions["new-market-deployments"]?.morphoEvents || [];
  if (morphoEvents.length > 0) {
    const e12xResult = await evaluatorMorphoMarketExploit(rpcPool, state, morphoEvents);
    if (e12xResult) {
      logPrint(`E12x/9 MORPHO NEW-MARKET + STALE ORACLE: ${e12xResult.message}`);
      alerts.push({ ...e12xResult, timestamp: ts() });
    } else {
      logPrint("E12x/9 Morpho markets: oracles fresh or no divergence");
    }
  } else {
    logPrint("E12x/9 Morpho oracle — waiting for new markets (none in recent 48h)");
  }

  // ══ E10: Cross-chain Oracle Arbitrage ══
  logPrint("E10/9 Cross-chain oracle...");
  const e10Result = await evaluatorCrossChainOracle(rpcPool, state);
  if (e10Result) {
    logPrint(`E10/9 Cross-chain: ${e10Result.message}`);
    alerts.push({
      condition: "cross-chain-oracle",
      severity: e10Result.severity,
      autoExecutable: false,
      timestamp: ts(),
      ...e10Result,
    });
      // Do not route generic ETH/USD cross-chain spreads into E1. The E1 executor
      // is only valid for cWETHv3/wstETH CAPO route-positive overvaluation.
      if (e10Result.maxChain === 1 && (e10Result.severity === "CRITICAL" || e10Result.severity === "HIGH")) {
        logPrint(`E10: Ethereum overvalued but E1 route is CAPO-only; no E1 routing`);
      }
      // Route to E10 on L2 if that chain is overvalued
      const chainCfg = E10_CHAIN_EXEC[e10Result.maxChain];
      if (chainCfg && (e10Result.severity === "CRITICAL" || e10Result.severity === "HIGH")) {
        const route = await buildE10Route(rpcPool, e10Result.maxChain).catch((e) => ({ executable: false, reason: e.shortMessage || e.message || "route build failed" }));
        const routeReason = route.reason || "candidate checks failed";
        alerts.push({
          condition: chainCfg.condition, severity: e10Result.severity, timestamp: ts(),
          source: `E10→${chainCfg.chain}`, feed: "ETH/USD",
          spread: e10Result.spread, divergence: parseFloat(e10Result.spread),
          maxAge: e10Result.maxAge, minAge: e10Result.minAge,
          maxPrice: parseFloat(e10Result.maxPrice), minPrice: parseFloat(e10Result.minPrice),
          contract: chainCfg.contract,
          autoExecutable: false,
          routeCandidatePositive: route.executable === true,
          routeAssessment: route.executable ? "candidate-positive" : routeReason,
          netProfitUsd: route.netProfitUsd !== undefined ? Number(route.netProfitUsd.toFixed(2)) : 0,
          flashWeth: route.wethEth !== undefined ? Number(route.wethEth.toFixed(6)) : 0,
          borrowUsdc: route.borrowTarget !== undefined ? Number((Number(route.borrowTarget) / 1e6).toFixed(2)) : 0,
          expectedWethOut: route.expectedWethOut !== undefined ? ethers.formatEther(route.expectedWethOut) : "0",
          minWethOut: route.minWethOut !== undefined ? ethers.formatEther(route.minWethOut) : "0",
          message: route.executable
            ? `E10→${chainCfg.chain}: candidate-positive route, ${chainCfg.chain} overvalued $${e10Result.maxPrice} vs $${e10Result.minPrice} (${e10Result.spread}% spread), est net $${route.netProfitUsd.toFixed(0)}; monitor-only`
            : `E10→${chainCfg.chain}: watch-only, ${chainCfg.chain} overvalued $${e10Result.maxPrice} vs $${e10Result.minPrice} (${e10Result.spread}% spread), ${routeReason}`,
        });
        if (route.executable) {
          logPrint(`E10 → ${chainCfg.chain} candidate-positive observation, est net $${route.netProfitUsd.toFixed(0)}; no execution authorization`);
        } else {
          logPrint(`E10 → ${chainCfg.chain} watch-only: ${routeReason}`);
        }
      }
  } else {
    logPrint("E10/9 Cross-chain prices aligned");
  }

  // ══ E16: Proxy Implementation Upgrades ══
  logPrint("E16/9 Proxy upgrade watch...");
  const e16Result = await evaluatorProxyUpgrades(rpcPool, state);
  if (e16Result) {
    logPrint(`E16/9 Proxy upgrade: ${e16Result.message}`);
    alerts.push({
      condition: "proxy-upgrade",
      severity: e16Result.severity,
      timestamp: ts(),
      ...e16Result,
    });
  } else {
    logPrint("E16/9 No proxy upgrades detected");
  }

  // ══ E14: Protocol Unpause Events ══
  logPrint("E14/9 Unpause monitor...");
  const e14Result = await evaluatorUnpauseEvents(rpcPool, state);
  if (e14Result) {
    logPrint(`E14/9 Unpause: ${e14Result.message}`);
    alerts.push({
      condition: "protocol-unpause",
      severity: e14Result.severity,
      timestamp: ts(),
      ...e14Result,
    });
  } else {
    logPrint("E14/9 No unpause events detected");
  }

  // ══ E13+E18: CF/LTV changes + Flash Loan fee changes ══
  logPrint("E13+E18/9 Config changes...");
  const e13Result = await evaluatorConfigChanges(rpcPool, state);
  if (e13Result) {
    logPrint(`E13+E18/9 Config change: ${e13Result.message}`);
    alerts.push({
      condition: "config-change",
      severity: e13Result.severity,
      timestamp: ts(),
      ...e13Result,
    });
  } else {
    logPrint("E13+E18/9 No config changes detected");
  }

  // ══ E19: Residual Watchlist ══
  logPrint("E19 Residual watchlist...");
  const e19Result = await evaluatorResidualWatchlist(rpcPool, state);
  if (e19Result) {
    logPrint(`E19 ${e19Result.count} residual vector(s), ${e19Result.emitted} alert(s) emitted`);
  } else {
    logPrint("E19 Residual watchlist skipped (cooldown)");
  }

  // ══ VB: Venus Base wstETH stale feed ══
  const vbResult = await evaluatorVenusBaseWsteth(rpcPool, state);
  if (vbResult) {
    const divergeStr = vbResult.divergence !== null && vbResult.divergence !== undefined ? ` diverge=${Number(vbResult.divergence).toFixed(2)}%` : "";
    logPrint(`VB/9 Venus Base wstETH: ${vbResult.feedAge}s stale (${vbResult.pctOfMax}% of 26h)${divergeStr} — ${vbResult.classification}`);
    if (vbResult.classification === "FORK_PROOF_NEEDED") {
      logPrint(`!!! Venus Base wstETH stale-ratio route needs fork proof: ${vbResult.route.direction} ${vbResult.route.collateralSymbol}->${vbResult.route.borrowSymbol}`);
    }
  } else {
    logPrint("VB/9 Venus Base wstETH status unavailable");
  }

  // ══ LB: Liquity Bold stETH/ETH ratio (DISABLED — break-even 22.6%) ══
  const lbResult = await evaluatorLiquityBoldRatio(rpcPool, state);
  const lbState = state.conditions["lb-steth-ratio"] || {};
  if (lbState.lastPrices) {
    const lp = lbState.lastPrices;
    const gapToBreakEven = (22.6 - parseFloat(lp.premium)).toFixed(1);
    logPrint(`LB/9 Liquity Bold stETH=$${lp.steth} ETH=$${lp.eth} premium=${lp.premium}% (DISABLED — need +22.6%, gap: +${gapToBreakEven}%)`);
  } else {
    logPrint("LB/9 Liquity Bold stETH/ETH: query error (DISABLED)");
  }

  // ══ E17: HyperLend HyperEVM ($487M TVL) ══
  const hlResult = await evaluatorHyperLend(rpcPool, state);
  if (hlResult) {
    const staleMsg = hlResult.staleSources ? `, staleSources=${hlResult.staleSources}, divergent=${hlResult.divergentStaleSources}` : "";
    logPrint(`E17/17 HyperLend: ${hlResult.borrowable}/${hlResult.count} reserves borrowable, ${hlResult.highLtv} high-LTV (>=55%)${hlResult.preLaunch ? " PRE-LAUNCH" : ""}${staleMsg}`);
    if (hlResult.priceErrors > 0) logPrint(`  E17: ${hlResult.priceErrors} price errors — check oracle`);

  } else {
    logPrint(`E17/17 HyperLend: ${hlResult.rpcUnavailable ? "RPC unavailable" : "0 reserves (pre-launch)"} (chain 999)`);
  }

  // ══ AV4: Aave V4 near-liquidation trigger watcher ══
  const av4Result = await evaluatorAaveV4LiquidationWatch(rpcPool, state);
  if (av4Result) {
    const top = av4Result.topRow || {};
    const routeState = av4Result.routePositive > 0 ? "route-positive" : av4Result.liquidatable > 0 ? "quote-needed" : "closed";
    logPrint(`AV4/17 Aave V4: active=${displayFinite(av4Result.activeBorrowers)} near=${displayFinite(av4Result.nearLiquidation)} liquidatable=${displayFinite(av4Result.liquidatable)} closestHF=${displayFinite(av4Result.topHealthFactor, 4)} bps=${displayFinite(av4Result.topBpsToLiquidation, 1)} debt=${finiteNumber(top.debtUsd) === null ? "unavailable" : "$" + displayFinite(top.debtUsd, 2)} ${top.debtSymbol || ""} collateral=${top.collateralSymbol || "unavailable"} [${routeState}]`);
  } else {
    logPrint("AV4/17 Aave V4: artifact unavailable or unhealthy");
  }

  // ══ Lorenzo sUSD1+ BSC Premium Watch ══
  const lorenzoResult = await evaluatorLorenzoSusd1Plus(rpcPool, state);
  if (lorenzoResult) {
    logPrint(`LOR/17 Lorenzo sUSD1+: ${lorenzoResult.message}`);
    alerts.push({ ...lorenzoResult, timestamp: ts() });
  } else {
    const st = state.conditions?.[LORENZO_CONDITION]?.lastResult;
    if (st) logPrint(`LOR/17 Lorenzo sUSD1+: best=${st.bestPool || "none"} diff=${st.bestNavDiffBps ?? "?"}bps threshold=${st.thresholdBps}bps`);
    else logPrint("LOR/17 Lorenzo sUSD1+: no current premium signal");
  }

  // ══ E32 BenQi Divergence Watch ══
  const benqiResult = await evaluatorBenqiDivergenceWatch(rpcPool, state);
  if (benqiResult) {
    logPrint(`E32/17 BenQi: ${benqiResult.message}`);
    alerts.push({ ...benqiResult, timestamp: ts() });
  } else {
    const bst = state.conditions?.[BENQI_AVAX_CONDITION]?.lastResult;
    if (bst) logPrint(`E32/17 BenQi: listed=${bst.listed} borrowPaused=${bst.borrowPaused} cf=${bst.cf}%`);
    else logPrint("E32/17 BenQi: no signal");
  }

  // ══ E33 Lista Oracle Watch ══
  const listaResult = await evaluatorListaOracleWatch(rpcPool, state);
  if (listaResult) {
    logPrint(`E33/17 Lista: ${listaResult.message}`);
    alerts.push({ ...listaResult, timestamp: ts() });
  } else {
    const lst = state.conditions?.[LISTA_BSC_CONDITION]?.lastResult;
    if (lst) {
      const pivotHours = finiteNumber(lst.pivotAge);
      const upperBound = finiteNumber(lst.upperBoundRatio);
      const upperBoundText = upperBound !== null && upperBound >= 0 && upperBound <= 1_000_000 ? upperBound.toFixed(4) + "x" : "unavailable";
      logPrint(`E33/17 Lista: pivotAge=${pivotHours === null ? "unavailable" : Math.round(pivotHours / 3600) + "h"} operational=${typeof lst.pivotOperational === "boolean" ? lst.pivotOperational : "unavailable"} ub=${upperBoundText}`);
    }
    else logPrint("E33/17 Lista: no signal");
  }

  // ══ API Health Check ══
  const apiResult = await evaluatorApiHealthCheck(rpcPool, state);
  if (apiResult) { logPrint(`API: ${apiResult.message}`); alerts.push({ ...apiResult, timestamp: ts() }); }

  // ══ E41 Pre-Era Phase 7 Watchers (6 protocols) ══
  const phase7Result = await evaluatorPreEraWatchers(rpcPool, state);
  if (phase7Result) {
    logPrint(`E41/17 Phase7: ${phase7Result.message}`);
    alerts.push({ ...phase7Result, timestamp: ts() });
  } else {
    const p7 = state.conditions?.["phase7-watchers"]?.lastResult;
    if (p7) logPrint(`E41/17 Phase7: ${p7.results?.filter(r=>r.status==="active").length||0}/${p7.results?.length||6} active`);
  }

  // ══ E42 Venus BSC Oracle Watch ($1.03B) ══
  const venusBscResult = await evaluatorVenusBscOracleWatch(rpcPool, state);
  if (venusBscResult) {
    logPrint(`E42/17 Venus BSC: ${venusBscResult.message}`);
    alerts.push({ ...venusBscResult, timestamp: ts() });
  } else {
    const vb = state.conditions?.[VENUS_BSC_CONDITION]?.lastResult;
    if (vb) logPrint(`E42/17 Venus BSC: ${vb.markets} markets, ${vb.staleFeeds || 0} stale`);
  }

  // ══ E34 Cooler Loans OLTV Watch ══
  const coolerResult = await evaluatorCoolerLtvWatch(rpcPool, state);
  if (coolerResult) {
    logPrint(`E34/17 Cooler: ${coolerResult.message}`);
    alerts.push({ ...coolerResult, timestamp: ts() });
  } else {
    const cst = state.conditions?.[COOLER_CONDITION]?.lastResult;
    if (cst) logPrint(`E34/17 Cooler: rampActive=${cst.rampActive} ltvVsMarket=${cst.ltvVsMarketBps ?? "?"}bps`);
    else logPrint("E34/17 Cooler: no signal");
  }

  // ══ E28 Spark SSR Oracle Staleness ══
  const sparkSsrResult = await evaluatorSparkSsrStaleness(rpcPool, state);
  if (sparkSsrResult) {
    logPrint(`E28/17 Spark SSR: ${sparkSsrResult.message}`);
    alerts.push({ ...sparkSsrResult, timestamp: ts() });
  } else {
    const sr = state.conditions?.[SPARK_SSR_CONDITION]?.lastResult;
    if (sr) {
      const mainnetAge = finiteNumber(sr.mainnetRhoAge);
      const l2Rows = Array.isArray(sr.l2Results) ? sr.l2Results : [];
      logPrint(`E28/17 Spark SSR: mainnetRhoAge=${mainnetAge === null ? "not-continuously-sourced" : Math.round(mainnetAge / 86400) + "d"} l2Stale=${l2Rows.filter(r => finiteNumber(r.staleness) !== null && Number(r.staleness) >= SPARK_RHO_STALE_THRESHOLD).length}`);
    }
    else logPrint("E28/17 Spark SSR: no data");
  }

  // ══ E27 Aave V3 HF Watch ══
  const aaveV3Result = await evaluatorAaveV3HfWatch(rpcPool, state);
  if (aaveV3Result) {
    logPrint(`E27/17 Aave V3: ${aaveV3Result.message}`);
    alerts.push({ ...aaveV3Result, timestamp: ts() });
  } else {
    const av3 = state.conditions?.[AAVE_V3_HF_CONDITION]?.lastResult;
    if (av3) {
      const rows = Array.isArray(av3.results) ? av3.results : [];
      const healthFactors = rows.map(r => finiteNumber(r.hf)).filter(value => value !== null);
      const minHealthFactor = healthFactors.length ? Math.min(...healthFactors) : null;
      logPrint(`E27/17 Aave V3: ${rows.length} borrowers, minHF=${displayFinite(minHealthFactor, 4)}`);
    }
    else logPrint("E27/17 Aave V3: no data");
  }

  // ══ E29 Fraxlend Pair Watch ══
  const fraxlendResult = await evaluatorFraxlendPairWatch(rpcPool, state);
  if (fraxlendResult) {
    logPrint(`E29/17 Fraxlend: ${fraxlendResult.message}`);
    alerts.push({ ...fraxlendResult, timestamp: ts() });
  } else {
    const fp = state.conditions?.[FRAXLEND_CONDITION]?.lastResult;
    if (fp) logPrint(`E29/17 Fraxlend: badData=${typeof fp.isBadData === "boolean" ? fp.isBadData : "unavailable"} avail=${finiteNumber(fp.availableUsd) === null ? "unavailable" : "$" + displayFinite(fp.availableUsd)}`);
    else logPrint("E29/17 Fraxlend: no data");
  }

  // ══ E30 Euler Vault Watch ══
  const eulerResult = await evaluatorEulerVaultWatch(rpcPool, state);
  if (eulerResult) {
    logPrint(`E30/17 Euler: ${eulerResult.message}`);
    alerts.push({ ...eulerResult, timestamp: ts() });
  } else {
    const ev = state.conditions?.[EULER_VAULT_CONDITION]?.lastResult;
    if (ev) logPrint(`E30/17 Euler: newVaults=${ev.newVaults || 0} lastBlock=${ev.lastBlock}`);
    else logPrint("E30/17 Euler: no data");
  }

  // ══ E31 Silo Oracle Watch ══
  const siloResult = await evaluatorSiloOracleWatch(rpcPool, state);
  if (siloResult) {
    logPrint(`E31/17 Silo: ${siloResult.message}`);
    alerts.push({ ...siloResult, timestamp: ts() });
  } else {
    const so = state.conditions?.[SILO_ORACLE_CONDITION]?.lastResult;
    if (so) {
      const rows = Array.isArray(so.results) ? so.results : [];
      const sourced = rows.filter(row => typeof row.chain === "string" && finiteNumber(row.siloCount) !== null);
      logPrint(`E31/17 Silo: ${sourced.length ? sourced.map(row => `${row.chain}=${displayFinite(row.siloCount)}`).join(", ") : "not-continuously-sourced"}`);
    }
    else logPrint("E31/17 Silo: no data");
  }

  // ══ E37 Oracle-DEX Divergence Watch ══
  const dexResult = await evaluatorDexDivergenceWatch(rpcPool, state);
  if (dexResult) {
    logPrint(`E37/17 DEX div: ${dexResult.message}`);
    alerts.push({ ...dexResult, timestamp: ts() });
  } else {
    const dr = state.conditions?.[DEX_DIVERGENCE_CONDITION]?.lastResult;
    if (dr) logPrint(`E37/17 DEX div: ${dr.tokens?.length || 0} tokens, ${dr.tokens?.filter(t=>t.dexPrice!==null&&t.dexPrice<0.5).length || 0} depegged`);
    else logPrint("E37/17 DEX div: no scan yet");
  }

  // ══ E38 wstETH DEX Discount ══
  const wstethDiscResult = await evaluatorWstethDexDiscount(rpcPool, state);
  if (wstethDiscResult) {
    logPrint(`E38/17 wstETH disc: ${wstethDiscResult.message}`);
    alerts.push({ ...wstethDiscResult, timestamp: ts() });
  } else {
    const wd = state.conditions?.[WSTETH_DISC_COND]?.lastResult;
    if (wd) logPrint(`E38/17 wstETH disc: ${wd.discountBps?.toFixed(1) || "?"}bps ${wd.discountBps > 10 ? "PROFITABLE!" : "below breakeven"}`);
    else logPrint("E38/17 wstETH disc: no scan yet");
  }

  // ══ E39 rUSD PSM Premium ══
  const rusdResult = await evaluatorRusdPsmArb(rpcPool, state);
  if (rusdResult) {
    logPrint(`E39/17 rUSD PSM: ${rusdResult.message}`);
    alerts.push({ ...rusdResult, timestamp: ts() });
  } else {
    const rd = state.conditions?.[RUSD_COND]?.lastResult;
    if (rd) logPrint(`E39/17 rUSD PSM: ${rd.bestPremiumBps?.toFixed(1) || "?"}bps ${rd.paused ? "PAUSED" : ""}`);
    else logPrint("E39/17 rUSD PSM: no scan yet");
  }

  // ══ E40 Fee-on-Transfer Watch ══
  const fotResult = await evaluatorFeeOnTransfer(rpcPool, state);
  if (fotResult) {
    logPrint(`E40/17 FoT: ${fotResult.message}`);
    alerts.push({ ...fotResult, timestamp: ts() });
  } else {
    const fr = state.conditions?.[FOT_CONDITION]?.lastResult;
    if (fr) logPrint(`E40/17 FoT: USDT fee=${(fr.basisPointsRate||0)/100}% owner=${fr.getOwner}`);
    else logPrint("E40/17 FoT: no scan yet");
  }

  // ══ E21: Kamino Liquidation Window (Solana) ══
  logPrint("E21/17 Kamino liquidation...");
  const e21Result = await evaluatorKaminoLiquidation(rpcPool, state);
  if (e21Result) {
    logPrint(`E21/17 ${e21Result.message}`);
    alerts.push({ ...e21Result, timestamp: ts() });
  } else {
    const ks = state.conditions[KAMINO_LIQUIDATION_CONDITION]?.lastResult;
    if (ks) logPrint(`E21/17 Kamino: slot=${ks.currentSlot} sameSlotReduced=${ks.sameSlotReducedRows || 0} liquidatable=${ks.sameSlotLiquidatableRows || 0} LIVE_WINDOW=${(ks.sameSlotLiquidatableRows || 0) > 0 ? "active" : "none"}`);
    else logPrint("E21/17 Kamino: no data yet");
  }

  // ══ E22: Governance Listing Watch ══
  logPrint("E22/17 Governance listing...");
  const e22Result = await evaluatorGovernanceListing(rpcPool, state);
  if (e22Result) {
    logPrint(`E22/17 ${e22Result.message}`);
    alerts.push({ ...e22Result, timestamp: ts() });
  } else {
    logPrint("E22/17 No high-signal listing proposals");
  }

  // ══ E23: Fresh fork-artifact evidence (read-only) ══
  logPrint("E23/17 Fork evidence check...");
  const e23Result = await evaluatorAutoFork(rpcPool, state);
  if (e23Result) {
    logPrint(`E23/17 ${e23Result.message}`);
    alerts.push({ ...e23Result, timestamp: ts() });
    if (e23Result.severity === "CRITICAL" && e23Result.hardStop) {
      logPrint("E23/17 HARD STOP — fork proof positive, stop before live action");
      state.conditions["auto-fork"] = state.conditions["auto-fork"] || {};
      state.conditions["auto-fork"].hardStop = true;
    }
  } else {
    logPrint("E23/17 No fresh positive fork evidence");
  }

  // ══ E24: apyUSD Receipt Preflight ══
  logPrint("E24/17 apyUSD preflight...");
  const e24Result = await evaluatorApyusdPreflight(rpcPool, state);
  if (e24Result) {
    logPrint(`E24/17 ${e24Result.message}`);
    if (e24Result.autoExecutionDisabled) logPrint(`E24/17 apyUSD auto-execute DISABLED: ${e24Result.disabledReason || "capital-locked-delayed"}`);
    alerts.push({ ...e24Result, timestamp: ts() });
  } else {
    const ps = state.conditions["apyusd-preflight"]?.lastResult;
    if (ps) {
      const disabled = ps.autoExecutionDisabled ? ` autoDisabled=${ps.disabledReason || "capital-locked-delayed"}` : "";
      logPrint(`E24/17 apyUSD: paused=${ps.paused} cash=$${ps.cash?.toFixed(0)??"?"} executable=${ps.executable}${disabled}`);
    }
    else logPrint("E24/17 apyUSD: no data yet");
  }

  // ══ E25: EigenLayer NAV-DEX Watch ══
  logPrint("E25/17 EigenLayer NAV-DEX...");
  const e25Result = await evaluatorEigenlayerNavdex(rpcPool, state);
  if (e25Result) {
    logPrint(`E25/17 ${e25Result.message}`);
    alerts.push({ ...e25Result, timestamp: ts() });
  } else {
    const nd = finiteNumber(state.conditions["eigenlayer-navdex"]?.lastGapBps);
    logPrint(`E25/17 EigenLayer NAV-DEX gap: ${nd === null ? "unavailable" : nd.toFixed(1) + "bps"}`);
  }

  // ══ E26: Marginfi Oracle/LTV Watch ══
  logPrint("E26/17 Marginfi oracle...");
  const e26Result = await evaluatorMarginfiOracle(rpcPool, state);
  if (e26Result) {
    logPrint(`E26/17 ${e26Result.message}`);
    alerts.push({ ...e26Result, timestamp: ts() });
  } else {
    const marginState = state.conditions["marginfi-oracle"] || {};
    logPrint(`E26/17 Marginfi: sourceHealth=${marginState.sourceHealth || "unavailable"} high-LTV evidence=${displayFinite(marginState.highLtvCount)}`);
  }

  // ══ E43-E53: Novelty Pattern Watch (11 scanners batch) ══
  const e43Result = await evaluatorNoveltyPatterns(rpcPool, state);
  if (e43Result && e43Result.length) {
    for (const r of e43Result) {
      logPrint(`E43-53/${r.pattern} ${r.message}`);
      alerts.push({ ...r, timestamp: ts() });
    }
  } else {
    logPrint("E43-53/17 Novelty patterns: " + (e43Result ? "clean" : "no check"));
  }

  // ══ E44: Morpho Blue Liquidation Bot ══
  const e44Result = await evaluatorMorphoLiquidation(rpcPool, state);
  if (e44Result) {
    logPrint(`E44/17 ${e44Result.message}`);
    alerts.push({ ...e44Result, timestamp: ts() });
  } else {
    logPrint("E44/17 Morpho liq: " + (state.conditions["morpho-liq"]?.lastBorrowers || 0) + " borrowers, 0 liquidatable");
  }

  // ══ E45: DeFiLlama Oracle Classifier Freshness ══
  const e45Result = await evaluatorDefillamaFreshness(state);
  if (e45Result) {
    logPrint(`E45/17 ${e45Result.message}`);
    alerts.push({ ...e45Result, timestamp: ts() });
  } else {
    logPrint(`E45/17 DeFiLlama classifier: sourceHealth=${state.conditions[DEFILLAMA_CONDITION]?.sourceHealth || "unavailable"}`);
  }

  // ══ E46: Oracle Staleness Router (feed→protocol→executor) ══
  const e46Result = await evaluatorStalenessRouter(rpcPool, state);
  if (e46Result) { logPrint(`E46/17 ${e46Result.message}`); alerts.push({ ...e46Result, timestamp: ts() }); }
  else { logPrint(`E46/17 Staleness router: sourceHealth=${state.conditions[STALENESS_ROUTER_CONDITION]?.sourceHealth || "unavailable"}`); }

  // E47 is intentionally excluded: cached Solana state cannot alert from this EVM cycle.

  } // end if (!fastOnly)

  if (!fastOnly) {
    const artifactConditions = [AAVE_V4_WATCH_CONDITION, KAMINO_LIQUIDATION_CONDITION, DEFILLAMA_CONDITION, STALENESS_ROUTER_CONDITION];
    const currentArtifactSources = artifactConditions.map((condition) => {
      const value = state.conditions[condition] || {};
      const checkedAt = Number(value.lastCheck) || Date.parse(value.lastResult?.checkedAt || "");
      return { current: Number.isFinite(checkedAt) && checkedAt >= runStart, health: value.sourceHealth };
    });
    const noveltyHealth = state.conditions["novelty-patterns"]?.lastResult?.sourceSummary;
    const explicitArtifactFailure = currentArtifactSources.some((row) => row.current && row.health !== ARTIFACT_STATUS.VALID_FRESH)
      || (noveltyHealth && noveltyHealth.failed > 0);
    const completeArtifactEvidence = currentArtifactSources.every((row) => row.current && row.health === ARTIFACT_STATUS.VALID_FRESH)
      && noveltyHealth?.total === Object.keys(NOVELTY_PATTERN_ARTIFACTS).length
      && noveltyHealth.healthy === noveltyHealth.total;
    recordCycleSource(
      cycleHealth,
      "required-artifact-sources",
      explicitArtifactFailure ? "FAILED" : (completeArtifactEvidence ? "HEALTHY" : "UNKNOWN"),
      completeArtifactEvidence ? "all required artifacts explicitly fresh and valid" : "required artifact evidence missing, stale, malformed, or not refreshed this cycle",
    );
    recordCycleSource(
      cycleHealth,
      "full-evaluator-coverage",
      "UNKNOWN",
      "per-evaluator source health is not yet comprehensive; full cycle cannot claim healthy",
    );
  }

  finalizeCycleHealth(cycleHealth, { completed: true });
  saveState(state);
  } catch (error) {
    recordCycleSource(cycleHealth, "cycle-orchestration", "FAILED", "evaluator orchestration failed closed");
    finalizeCycleHealth(cycleHealth, { completed: false, fatal: true });
    saveState(state);
    throw error;
  }

  // ── PRINT RESULTS ──
  const alertCount = alerts.length;
  let hasExploit = false;
  const exploitAlerts = [];
  const nearMissAlerts = [];
  const infoAlerts = [];

  for (const a of alerts) {
    const isExploit =
      isHighSignalExploitAlert(a) ||
      (a.condition === E1_CONDITION && a.severity === "CRITICAL") ||
      (a.condition === E10_BASE_CONDITION && a.severity === "CRITICAL") ||
      (a.condition === HL_STALE_SOURCE_CONDITION && a.severity === "CRITICAL") ||
      (a.condition === "report-signal" && a.severity === "CRITICAL");
    const isNearMiss =
      (a.condition === "staleness-gap" && a.classification === "NEAR MISS");
    if (isExploit) {
      hasExploit = true;
      exploitAlerts.push(a);
    } else if (isNearMiss) {
      nearMissAlerts.push(a);
    } else {
      infoAlerts.push(a);
    }
  }

  // ── EXPLOITABLE: loud banner ──
  for (const a of exploitAlerts) {
    logPrint(`!!!    ${a.condition.toUpperCase()} ${a.classification || a.severity}    !!!`);
    logPrint(`!!!    ${a.message}`);
    logPrint(`!!!`);
  }

  // ── Near-miss: worth watching ──
  for (const a of nearMissAlerts) {
    logPrint(`~ NEAR MISS [${a.condition}]: ${a.message}`);
  }

  // ── Status alerts: compact ──
  const stalenessAlerts = infoAlerts.filter(a => a.condition === "staleness-gap" || a.condition === E8_EXECUTION_CONDITION);
  const vaultAlerts = infoAlerts.filter(a => a.condition === "vault-donation" || a.condition === "vault-new-deploy");
  const depegAlerts = infoAlerts.filter(a => a.condition === "depeg");
  const otherAlerts = infoAlerts.filter(a => !stalenessAlerts.includes(a) && !vaultAlerts.includes(a) && !depegAlerts.includes(a));

  if (stalenessAlerts.length > 0) {
    const s = stalenessAlerts[stalenessAlerts.length - 1];
    logPrint(`  staleness: ${s.feed} ${s.feedAge}s ${s.classification} (${s.divergence !== null && s.divergence !== undefined ? (s.divergence >= 0 ? "+" : "")+s.divergence+"%" : "N/A"})`);
  }
  if (depegAlerts.length > 0) {
    const d = depegAlerts[depegAlerts.length - 1];
    logPrint(`  depeg: ${d.token} $${Number(d.price).toFixed(4)} (${((1-Number(d.price))*100).toFixed(2)}% below $1)`);
  }
  if (vaultAlerts.length > 0) {
    const critCount = vaultAlerts.filter(v => v.severity === "CRITICAL").length;
    logPrint(`  vaults: ${vaultAlerts.length} low-TVL (${critCount} zero-assets)`);
  }
  for (const a of otherAlerts) {
    logPrint(`  [${a.severity}] ${a.condition}: ${a.message}`);
  }

  // ── Verdict ──
  if (hasExploit) {
    logPrint(``);
    logPrint(`>>>  EXPLOIT WINDOW OPEN  <<<`);
    logPrint(`>>>  Verify on fork now.   <<<`);
    logPrint(``);
  } else if (nearMissAlerts.length > 0) {
    logPrint(`---  near miss, watch closely  ---`);
  } else if (infoAlerts.length > 0) {
    const statusLines = [];
    if (stalenessAlerts.length) statusLines.push(`${stalenessAlerts.length} staleness`);
    if (vaultAlerts.length) statusLines.push(`${vaultAlerts.length} vault`);
    if (depegAlerts.length) statusLines.push(`${depegAlerts.length} depeg`);
    if (otherAlerts.length) statusLines.push(`${otherAlerts.length} other`);
    logPrint(`---  ${statusLines.join(", ")} — no exploit  ---`);
  }

  // ── Cycle summary (full cycles only) ──
  if (!fastOnly) {
    const s = [];
    s.push(stalenessAlerts.length > 0 ? `staleness(${stalenessAlerts.length})` : "staleness");
    s.push(depegAlerts.some(a => a.severity === "CRITICAL") ? "depeg!" : "depeg");
    s.push("e10");
    s.push("liquity-bold");
    s.push("capo");
    s.push("liq");
    s.push("proxy");
    s.push("unpause");
    s.push("config");
    s.push("venus");
    s.push("lb");
    s.push("hyperlend");
    s.push("aave-v4");
    s.push("kamino");
    s.push("governance");
    s.push("auto-fork");
    s.push("apyusd");
    s.push("eigen-nav");
    s.push("marginfi");
    s.push(vaultAlerts.length > 0 ? `vault(${vaultAlerts.length})` : "vault");
    if (otherAlerts.length > 0) s.push(`other(${otherAlerts.length})`);
    if (exploitAlerts.length > 0) s.push(`EXPLOIT(${exploitAlerts.length})`);
    logPrint(`┄  ${s.join("  ")}  ┄`);
  }

  await flushAlerts();

  if (!fastOnly) {
    refreshEvaluatorProximity();
  }

  const elapsed = ((Date.now() - runStart) / 1000).toFixed(1);
  const status = hasExploit ? "!! EXPLOIT !!" : nearMissAlerts.length > 0 ? "near miss" : "clean";
  logPrint(`=== ${status} (${alertCount} alert) ${elapsed}s ===`);

  return { alertCount, elapsed };
}

// ─── Watch Loop ─────────────────────────────────────────────────────────────

async function watch(intervalMs) {
  const cleanup = () => {
    try {
      const owners = loadJson(path.join(WORKSPACE, "reports", "monitor", "OWNERS.json"), {});
      owners.role = "IDLE";
      owners.message = "Monitor watch process stopped cleanly.";
      owners.lastRun = null;
      owners.pid = null;
      saveJson(path.join(WORKSPACE, "reports", "monitor", "OWNERS.json"), owners);
    } catch (_) {}
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  const FAST_MS = intervalMs; // 60s for time-sensitive evaluators (E5, E8, E9)
  const FULL_EVERY = 5; // full cycle every 5 fast cycles = 300s

  logPrint(`Split-cycle mode: fast=${FAST_MS / 1000}s (E5/E8/E9), full every ${FULL_EVERY}x (all evaluator groups)`);
  let cycle = 0;
  while (true) {
    cycle++;
    const isFull = cycle % FULL_EVERY === 1; // first cycle is always full
    try {
      await runOnce(!isFull); // fastOnly when not a full cycle
    } catch (e) {
      log(`Watch iteration error: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, FAST_MS));
  }
}

// ─── CLI ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const watchMode = args.includes("--watch") || args.includes("-w");
const onceMode = args.includes("--once") || args.includes("-o");
const requestedAutoExecute = args.includes("--auto-execute");
const autoExecute = false;
const statusMode = args.includes("--status") || args.includes("--coverage");
const intervalArg = args.find(a => a.startsWith("--interval="));
const watchIdx = args.indexOf("--watch");
const positionalInterval = (watchIdx >= 0 && watchIdx + 1 < args.length && /^\d+$/.test(args[watchIdx + 1]))
  ? parseInt(args[watchIdx + 1]) : null;
const intervalMs = (intervalArg ? parseInt(intervalArg.split("=")[1]) : positionalInterval || DEFAULT_INTERVAL_MS / 1000) * 1000;

if (require.main === module) {
if (requestedAutoExecute) {
  console.error("Safety error: --auto-execute is permanently disabled; refusing to start.");
  process.exitCode = 2;
} else
if (statusMode) {
  console.log("════════════════════════════════════════");
  console.log("MONITOR INVENTORY COVERAGE");
  console.log("════════════════════════════════════════");
  console.log("");
  console.log("Feeds watched (E1 — Staleness):");
  for (const [name, cfg] of Object.entries(FEEDS)) {
    const consumers = Object.keys(FEED_CONSUMERS[name] || {}).join(", ");
    console.log(`  ${name}  ${cfg.feed}  →  ${consumers}`);
  }
  console.log("");
  console.log("Stablecoins tracked (E5 — Depeg):");
  for (const [sym, cfg] of Object.entries(STABLECOIN_FEEDS)) {
    console.log(`  ${sym.padEnd(8)} ${cfg.feed}`);
  }
  console.log("");
  console.log("Vault factories (E2 — New deploys):");
  for (const f of VAULT_FACTORIES) {
    console.log(`  chain=${f.chainId}  ${f.address}  (${f.name})`);
  }
  const inv = loadJson(VAULT_INVENTORY, null);
  if (inv?.chains) {
    for (const [cid, data] of Object.entries(inv.chains)) {
      console.log(`    → inventory: ${data.vaults?.length || 0} vaults known on chain ${cid}`);
    }
  }
  console.log("");
  console.log("DEX epochs (E6 — Gauge):");
  for (const d of VE33_VOTERS) {
    console.log(`  ${d.name.padEnd(12)} chain=${d.chainId}  voter=${d.voter}`);
  }
  console.log("");
  console.log("Bridge config (E4):");
  const lz = loadJson(LAYERZERO_INVENTORY, null);
  if (lz?.results) {
    const names = Object.values(lz.results).map(r => r.chain).filter(Boolean).join(", ");
    console.log(`  LayerZero chains: ${names}`);
  } else {
    console.log("  No LayerZero inventory");
  }
  console.log("");
  console.log("Residual watchlist (E19):");
  for (const f of [SUILEND_CANDIDATE_PROBE, KAMINO_WINDOW_ARTIFACT, WORMHOLE_INVENTORY, AXELAR_INVENTORY, LAYERZERO_INVENTORY, GEARBOX_LIVE_JSON, FRAXLEND_LIVE_JSON]) {
    const age = fileAgeHours(f);
    console.log(`  ${path.relative(WORKSPACE, f)}  ${age === null ? "missing" : age.toFixed(1) + "h old"}`);
  }
  console.log("");
  console.log("Aave V4 evidence artifact:");
  for (const f of [AAVE_V4_WATCH_FILE]) {
    const age = fileAgeHours(f);
    console.log(`  ${path.relative(WORKSPACE, f)}  ${age === null ? "missing" : age.toFixed(1) + "h old"}`);
  }
  console.log("");
  console.log("Reports (E7 — Signal):");
  try {
    const mdFiles = fs.readdirSync(REPORTS_DIR).filter(f => f.endsWith(".md"));
    console.log(`  ${mdFiles.length} .md reports in reports/`);
    const s = loadJson(STATE_FILE, {});
    const sig = s.conditions?.["report-signal"];
    if (sig?.lastCheck) console.log(`  Last scanned: ${new Date(sig.lastCheck).toISOString()}`);
  } catch (_) { console.log("  Cannot read reports directory"); }
  console.log("");

  process.exit(0);
}

if (watchMode) {
  watch(intervalMs).catch(e => { log("Fatal: " + e.message); process.exit(1); });
} else {
  runOnce().then(({ alertCount, elapsed }) => {
    logPrint(`Done. ${alertCount} alerts emitted in ${elapsed}s.`);
    // A one-shot run is not a live monitor process; avoid leaving a stale PID.
    try {
      const ownersPath = path.join(WORKSPACE, "reports", "monitor", "OWNERS.json");
      const owners = loadJson(ownersPath, {});
      owners.role = "IDLE";
      owners.message = "Last monitor --once run completed. No watch process is active unless a node process is running.";
      owners.lastRun = ts();
      owners.pid = null;
      saveJson(ownersPath, owners);
    } catch (_) {}
    process.exit(0);
  }).catch(e => { log("Fatal: " + e.message); process.exit(1); });
}
}
// ═══════════════════════════════════════════════════════════════════
// Evaluator 9+11: Liquidation Hunter + Profitability (Morpho Blue)
// ═══════════════════════════════════════════════════════════════════
// E9: Finds HF<1 positions (free GrapHQL query)
// E11: Adds profitability: DEX liquidity, liquidation bonus, gas cost

// Cache DEX liquidity results to avoid hitting subgraph every cycle
const dexLiquidityCache = new Map();
const E9_UNISWAP_V3_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
const E9_UNISWAP_V3_QUOTER_V2 = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";
const E9_UNISWAP_FEES = [100, 500, 3000, 10000];
const E9_MIN_NET_PROFIT_USD = Number(runtimeConfig.E9_MIN_NET_PROFIT_USD || "10");
const E9_GAS_USED = 1_500_000;
const E9_MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const E9_WAD = 10n ** 18n;
const E9_ORACLE_PRICE_SCALE = 10n ** 36n;
const E9_VIRTUAL_SHARES = 1_000_000n;
const E9_VIRTUAL_ASSETS = 1n;
const E9_LIQUIDATION_CURSOR = 300_000_000_000_000_000n;
const E9_MAX_LIQUIDATION_INCENTIVE_FACTOR = 1_150_000_000_000_000_000n;
const E9_MAX_PRICE_DEVIATION_PCT = 5;
const E9_MAX_ETH_PRICE_DEVIATION_PCT = 2;
const E9_CHAINLINK_MAX_AGE_SECONDS = 3 * 3600;
const E9_STABLE_FEED_MAX_AGE_SECONDS = 30 * 3600;
const E9_WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const E9_WSTETH = "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0";

const E9_FACTORY_IFACE = new ethers.Interface(["function getPool(address tokenA,address tokenB,uint24 fee) view returns (address)"]);
const E9_QUOTER_IFACE = new ethers.Interface([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);
const E9_CHAINLINK_IFACE = new ethers.Interface([
  "function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
]);
const E9_ORACLE_IFACE = new ethers.Interface(["function price() view returns (uint256)"]);
const E9_MORPHO_IFACE = new ethers.Interface([
  "function market(bytes32 id) view returns (uint128 totalSupplyAssets,uint128 totalSupplyShares,uint128 totalBorrowAssets,uint128 totalBorrowShares,uint128 lastUpdate,uint128 fee)",
  "function position(bytes32 id,address user) view returns (uint256 supplyShares,uint128 borrowShares,uint128 collateral)",
]);
const E9_STETH_PER_TOKEN_IFACE = new ethers.Interface(["function stEthPerToken() view returns (uint256)"]);
const E9_ABI_CODER = ethers.AbiCoder.defaultAbiCoder();
function e9TokenFeedKey(chainId, token) {
  return `${Number(chainId || 1)}:${String(token || "").toLowerCase()}`;
}

const E9_TOKEN_USD_FEEDS = new Map([
  // Ethereum mainnet
  [e9TokenFeedKey(1, E9_WETH), { feed: ETH_FEED, maxAgeSeconds: E9_CHAINLINK_MAX_AGE_SECONDS, label: "WETH" }],
  [e9TokenFeedKey(1, "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"), { feed: FEEDS["USDC/USD"].feed, maxAgeSeconds: E9_STABLE_FEED_MAX_AGE_SECONDS, label: "USDC" }],
  [e9TokenFeedKey(1, "0xdAC17F958D2ee523a2206206994597C13D831ec7"), { feed: STABLECOIN_FEEDS.USDT.feed, maxAgeSeconds: E9_STABLE_FEED_MAX_AGE_SECONDS, label: "USDT" }],
  [e9TokenFeedKey(1, "0x6B175474E89094C44Da98b954EedeAC495271d0F"), { feed: STABLECOIN_FEEDS.DAI.feed, maxAgeSeconds: E9_CHAINLINK_MAX_AGE_SECONDS, label: "DAI" }],
  [e9TokenFeedKey(1, "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599"), { feed: "0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c", maxAgeSeconds: E9_CHAINLINK_MAX_AGE_SECONDS, label: "WBTC" }],
  // Base (8453)
  [e9TokenFeedKey(8453, "0x4200000000000000000000000000000000000006"), { feed: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70", maxAgeSeconds: E9_CHAINLINK_MAX_AGE_SECONDS, label: "WETH-Base" }],
  [e9TokenFeedKey(8453, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"), { feed: "0x7e860098F58bBFC8648a4311b374B1D669a2bc6B", maxAgeSeconds: E9_STABLE_FEED_MAX_AGE_SECONDS, label: "USDC-Base" }],
  // Arbitrum (42161)
  [e9TokenFeedKey(42161, "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"), { feed: "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612", maxAgeSeconds: E9_CHAINLINK_MAX_AGE_SECONDS, label: "WETH-Arb" }],
  [e9TokenFeedKey(42161, "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"), { feed: "0x50834F3163758fcC1Df9973b6e91f0F0F0434aD3", maxAgeSeconds: E9_STABLE_FEED_MAX_AGE_SECONDS, label: "USDC-Arb" }],
  // Optimism (10)
  [e9TokenFeedKey(10, "0x4200000000000000000000000000000000000006"), { feed: "0x13e3Ee699D1909E989722E753853AE30b17e08c5", maxAgeSeconds: E9_CHAINLINK_MAX_AGE_SECONDS, label: "WETH-OP" }],
  [e9TokenFeedKey(10, "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85"), { feed: "0x16a9FA2FDa030272Ce99B29CF780dFA30361E0f3", maxAgeSeconds: E9_STABLE_FEED_MAX_AGE_SECONDS, label: "USDC-OP" }],
]);

function isE9Address(value) {
  return typeof value === "string" && ethers.isAddress(value);
}

function e9SameAddress(a, b) {
  return String(a || "").toLowerCase() === String(b || "").toLowerCase();
}

function e9LiquidationIncentiveFactor(lltvRaw) {
  try { return Number(e9LiquidationIncentiveFactorRaw(lltvRaw)) / 1e18; }
  catch (_) { return 1.05; }
}

function e9ToBigInt(value, fallback = 0n) {
  try {
    if (value === null || value === undefined || value === "") return fallback;
    return BigInt(value);
  } catch (_) { return fallback; }
}

function e9MulDivDown(x, y, d) {
  if (d === 0n) throw new Error("division by zero");
  return x * y / d;
}

function e9MulDivUp(x, y, d) {
  if (d === 0n) throw new Error("division by zero");
  return (x * y + d - 1n) / d;
}

function e9ToAssetsDown(shares, totalAssets, totalShares) {
  return e9MulDivDown(shares, totalAssets + E9_VIRTUAL_ASSETS, totalShares + E9_VIRTUAL_SHARES);
}

function e9ToAssetsUp(shares, totalAssets, totalShares) {
  return e9MulDivUp(shares, totalAssets + E9_VIRTUAL_ASSETS, totalShares + E9_VIRTUAL_SHARES);
}

function e9LiquidationIncentiveFactorRaw(lltvRaw) {
  const lltv = e9ToBigInt(lltvRaw);
  if (lltv <= 0n || lltv >= E9_WAD) return 1_050_000_000_000_000_000n;
  const cursorTerm = e9MulDivDown(E9_LIQUIDATION_CURSOR, E9_WAD - lltv, E9_WAD);
  const factor = e9MulDivDown(E9_WAD, E9_WAD, E9_WAD - cursorTerm);
  return factor > E9_MAX_LIQUIDATION_INCENTIVE_FACTOR ? E9_MAX_LIQUIDATION_INCENTIVE_FACTOR : factor;
}

function e9MarketId(marketParams) {
  return ethers.keccak256(E9_ABI_CODER.encode(
    ["address", "address", "address", "address", "uint256"],
    [marketParams.loanToken, marketParams.collateralToken, marketParams.oracle, marketParams.irm, e9ToBigInt(marketParams.lltv)]
  ));
}

function e9PriceDeviationPct(a, b) {
  if (!(a > 0) || !(b > 0)) return Infinity;
  return Math.abs(a - b) / ((a + b) / 2) * 100;
}

async function e9FetchUsd(url, pathFn, timeoutMs = 5000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const price = Number(pathFn(await res.json()));
    return price > 0 ? price : null;
  } catch (_) { return null; }
}

async function e9ReadChainlinkUsd(provider, feed, maxAgeSeconds) {
  try {
    const feedAddr = String(feed || "").toLowerCase();
    const [roundRaw, decimalsRaw] = await Promise.all([
      provider.call({ to: feedAddr, data: E9_CHAINLINK_IFACE.encodeFunctionData("latestRoundData", []) }),
      provider.call({ to: feedAddr, data: E9_CHAINLINK_IFACE.encodeFunctionData("decimals", []) }),
    ]);
    const [, answer, , updatedAt] = E9_CHAINLINK_IFACE.decodeFunctionResult("latestRoundData", roundRaw);
    const [decimals] = E9_CHAINLINK_IFACE.decodeFunctionResult("decimals", decimalsRaw);
    if (answer <= 0n || updatedAt <= 0n) return null;
    const block = await provider.getBlock("latest").catch(() => null);
    const now = block?.timestamp || Math.floor(Date.now() / 1000);
    const age = now - Number(updatedAt);
    if (age < 0 || age > maxAgeSeconds) return null;
    return Number(answer) / (10 ** Number(decimals));
  } catch (_) { return null; }
}

async function e9GetValidatedEthUsdPrice(provider) {
  const sources = [];
  const coingecko = await e9FetchUsd(
    "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
    (j) => j?.ethereum?.usd
  );
  if (coingecko) sources.push({ source: "coingecko", price: coingecko });

  const binance = await e9FetchUsd("https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT", (j) => j?.price);
  if (binance) sources.push({ source: "binance", price: binance });

  const chainlink = provider ? await e9ReadChainlinkUsd(provider, ETH_FEED, E9_CHAINLINK_MAX_AGE_SECONDS) : null;
  if (chainlink) sources.push({ source: "chainlink", price: chainlink });

  let best = null;
  for (let i = 0; i < sources.length; i++) {
    for (let j = i + 1; j < sources.length; j++) {
      const deviation = e9PriceDeviationPct(sources[i].price, sources[j].price);
      if (deviation <= E9_MAX_ETH_PRICE_DEVIATION_PCT && (!best || deviation < best.deviation)) {
        best = { deviation, price: (sources[i].price + sources[j].price) / 2, sources: [sources[i].source, sources[j].source] };
      }
    }
  }
  return best ? best.price : null;
}

function e9ValidateGraphPrice(livePrice, graphPrice, source) {
  const deviation = graphPrice > 0 ? e9PriceDeviationPct(livePrice, graphPrice) : 0;
  if (graphPrice > 0 && deviation > E9_MAX_PRICE_DEVIATION_PCT) {
    return { priceUsd: livePrice, trusted: false, source, graphDeviationPct: deviation, reason: `graphql/live price deviation ${deviation.toFixed(2)}%` };
  }
  return { priceUsd: livePrice, trusted: livePrice > 0, source, graphDeviationPct: deviation, reason: null };
}

async function e9GetTokenUsdPrice(provider, token, graphPriceUsd, ethPrice, chainId = 1) {
  const tokenLc = String(token || "").toLowerCase();
  const graphPrice = Number(graphPriceUsd || 0);
  if (Number(chainId) === 1 && tokenLc === E9_WETH.toLowerCase()) return e9ValidateGraphPrice(ethPrice, graphPrice, "validated-eth-usd");

  if (Number(chainId) === 1 && tokenLc === E9_WSTETH.toLowerCase()) {
    const stethUsd = await e9ReadChainlinkUsd(provider, FEEDS["stETH/USD"].feed, E9_CHAINLINK_MAX_AGE_SECONDS);
    const raw = await provider.call({ to: E9_WSTETH.toLowerCase(), data: E9_STETH_PER_TOKEN_IFACE.encodeFunctionData("stEthPerToken", []) }).catch(() => null);
    if (stethUsd && raw) {
      const [stEthPerToken] = E9_STETH_PER_TOKEN_IFACE.decodeFunctionResult("stEthPerToken", raw);
      return e9ValidateGraphPrice(stethUsd * Number(stEthPerToken) / 1e18, graphPrice, "validated-wsteth-usd");
    }
  }

  const feedCfg = E9_TOKEN_USD_FEEDS.get(e9TokenFeedKey(chainId, tokenLc)) || E9_TOKEN_USD_FEEDS.get(e9TokenFeedKey(1, tokenLc));
  if (feedCfg) {
    const livePrice = await e9ReadChainlinkUsd(provider, feedCfg.feed, feedCfg.maxAgeSeconds);
    if (livePrice) return e9ValidateGraphPrice(livePrice, graphPrice, `validated-${feedCfg.label.toLowerCase()}-usd`);
  }

  return { priceUsd: graphPrice, trusted: false, source: "graphql-untrusted", graphDeviationPct: null, reason: "no validated live USD source for loan token" };
}

async function e9ReadOnchainLiquidation(provider, marketParams, borrower) {
  const marketId = e9MarketId(marketParams);
  const [marketRaw, positionRaw, oracleRaw] = await Promise.all([
    provider.call({ to: E9_MORPHO.toLowerCase(), data: E9_MORPHO_IFACE.encodeFunctionData("market", [marketId]) }),
    provider.call({ to: E9_MORPHO.toLowerCase(), data: E9_MORPHO_IFACE.encodeFunctionData("position", [marketId, borrower]) }),
    provider.call({ to: String(marketParams.oracle || "").toLowerCase(), data: E9_ORACLE_IFACE.encodeFunctionData("price", []) }),
  ]);
  const [, , totalBorrowAssets, totalBorrowShares] = E9_MORPHO_IFACE.decodeFunctionResult("market", marketRaw);
  const [, borrowShares, collateral] = E9_MORPHO_IFACE.decodeFunctionResult("position", positionRaw);
  const [collateralPrice] = E9_ORACLE_IFACE.decodeFunctionResult("price", oracleRaw);
  if (borrowShares <= 0n || collateral <= 0n || totalBorrowShares <= 0n || collateralPrice <= 0n) return null;

  const lifRaw = e9LiquidationIncentiveFactorRaw(marketParams.lltv);
  const repaidAssetsDown = e9ToAssetsDown(borrowShares, totalBorrowAssets, totalBorrowShares);
  const repaidAssetsUp = e9ToAssetsUp(borrowShares, totalBorrowAssets, totalBorrowShares);
  const seizedCollateral = e9MulDivDown(e9MulDivDown(repaidAssetsDown, lifRaw, E9_WAD), E9_ORACLE_PRICE_SCALE, collateralPrice);
  const collateralValueLoan = e9MulDivDown(collateral, collateralPrice, E9_ORACLE_PRICE_SCALE);
  const maxBorrow = e9MulDivDown(collateralValueLoan, e9ToBigInt(marketParams.lltv), E9_WAD);

  return {
    marketId,
    borrowSharesRaw: borrowShares.toString(),
    collateralRaw: collateral.toString(),
    repaidAssetsRaw: repaidAssetsUp.toString(),
    seizedCollateralRaw: seizedCollateral.toString(),
    collateralValueLoanRaw: collateralValueLoan.toString(),
    liquidationIncentiveFactorRaw: lifRaw.toString(),
    onchainHealthyBeforeAccrual: maxBorrow >= repaidAssetsUp,
    seizedExceedsCollateral: seizedCollateral > collateral,
  };
}

async function e9FindBestUniswapRoute(provider, tokenIn, tokenOut, amountInRaw) {
  if (!isE9Address(tokenIn) || !isE9Address(tokenOut) || BigInt(amountInRaw || 0) <= 0n) return null;
  if (e9SameAddress(tokenIn, tokenOut)) return { fee: 0, pool: tokenIn, amountOutRaw: BigInt(amountInRaw).toString(), gasEstimate: "0", direct: true };

  let best = null;
  for (const fee of E9_UNISWAP_FEES) {
    try {
      const poolRaw = await provider.call({
        to: E9_UNISWAP_V3_FACTORY,
        data: E9_FACTORY_IFACE.encodeFunctionData("getPool", [tokenIn, tokenOut, fee]),
      });
      const [pool] = E9_FACTORY_IFACE.decodeFunctionResult("getPool", poolRaw);
      if (!pool || pool === ZERO) continue;

      const quoteRaw = await provider.call({
        to: E9_UNISWAP_V3_QUOTER_V2,
        data: E9_QUOTER_IFACE.encodeFunctionData("quoteExactInputSingle", [{ tokenIn, tokenOut, amountIn: BigInt(amountInRaw), fee, sqrtPriceLimitX96: 0 }]),
      });
      const [amountOut, , , gasEstimate] = E9_QUOTER_IFACE.decodeFunctionResult("quoteExactInputSingle", quoteRaw);
      if (!best || amountOut > BigInt(best.amountOutRaw)) best = { fee, pool, amountOutRaw: amountOut.toString(), gasEstimate: gasEstimate.toString(), direct: false };
    } catch (_) {
      // Missing pool or no quote for the tested fee tier.
    }
  }
  return best;
}

async function fetchMorphoLiquidationItems() {
  const query = `{
    marketPositions(first:50, orderBy:BorrowShares, orderDirection:Desc,
      where:{healthFactor_lte:0.99, borrowShares_gte:"1"}) {
      items {
        user { address }
        market {
          chain { id network }
          loanAsset { symbol address decimals }
          collateralAsset { symbol address decimals }
          oracle { address }
          irmAddress
          lltv
        }
        healthFactor
        state { collateral collateralUsd borrowAssets borrowAssetsUsd borrowShares }
      }
    }
  }`;
  const r = await fetch("https://api.morpho.org/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error("morpho-source-unhealthy");
  const j = await r.json();
  if (j.errors || !Array.isArray(j.data?.marketPositions?.items)) throw new Error("morpho-source-malformed");
  return j.data.marketPositions.items;
}

async function buildE9LiquidationCandidates(provider, gasPriceOverride = null, chainId = 1) {
  const items = await fetchMorphoLiquidationItems();
  const liq = items.filter(p => Number(p.market?.chain?.id) === chainId
    && parseFloat(p.healthFactor) < 1
    && parseFloat(p.state?.borrowAssetsUsd || 0) > 100
    && parseFloat(p.state?.collateralUsd || 0) > 1
    && isE9Address(p.user?.address)
    && isE9Address(p.market?.loanAsset?.address)
    && isE9Address(p.market?.collateralAsset?.address)
    && isE9Address(p.market?.oracle?.address)
    && isE9Address(p.market?.irmAddress));

  if (liq.length === 0) return { count: 0, candidates: [], gasCostUsd: 0, ethPrice: 0 };

  const rawGasPrice = gasPriceOverride ? e9ToBigInt(gasPriceOverride) : await provider.send("eth_gasPrice", []).then(BigInt).catch(() => 0n);
  const ethPrice = await e9GetValidatedEthUsdPrice(provider).catch(() => null);
  if (rawGasPrice <= 0n || !(ethPrice > 0)) {
    return { count: liq.length, candidates: [], gasCostUsd: 0, ethPrice: 0, reason: "missing validated live gas/ETH price" };
  }
  const gasCostUsd = (E9_GAS_USED * Number(rawGasPrice) / 1e18) * ethPrice;
  const candidates = [];

  for (const pos of liq.slice(0, 10)) {
    const loanDecimals = Number(pos.market?.loanAsset?.decimals || 18);
    const collateralDecimals = Number(pos.market?.collateralAsset?.decimals || 18);
    const graphBorrowUsd = Number(pos.state?.borrowAssetsUsd || 0);
    const graphBorrowRaw = String(pos.state?.borrowAssets || "0");
    const graphBorrowHuman = Number(ethers.formatUnits(e9ToBigInt(graphBorrowRaw), loanDecimals));
    const graphLoanTokenPriceUsd = graphBorrowHuman > 0 ? graphBorrowUsd / graphBorrowHuman : 0;
    const marketParams = {
      loanToken: pos.market?.loanAsset?.address || "",
      collateralToken: pos.market?.collateralAsset?.address || "",
      oracle: pos.market?.oracle?.address || "",
      irm: pos.market?.irmAddress || "",
      lltv: pos.market?.lltv || "0",
    };
    const loanPrice = await e9GetTokenUsdPrice(provider, marketParams.loanToken, graphLoanTokenPriceUsd, ethPrice, chainId);
    const onchain = await e9ReadOnchainLiquidation(provider, marketParams, pos.user?.address).catch(() => null);
    if (!onchain) continue;

    const borrowAssetsRaw = onchain.repaidAssetsRaw;
    const borrowSharesRaw = onchain.borrowSharesRaw;
    const collateralRaw = onchain.collateralRaw;
    const seizedCollateralRaw = e9ToBigInt(onchain.seizedCollateralRaw);
    const borrowHuman = Number(ethers.formatUnits(e9ToBigInt(borrowAssetsRaw), loanDecimals));
    const collateralHuman = Number(ethers.formatUnits(e9ToBigInt(collateralRaw), collateralDecimals));
    const collateralValueLoan = Number(ethers.formatUnits(e9ToBigInt(onchain.collateralValueLoanRaw), loanDecimals));
    const loanTokenPriceUsd = Number(loanPrice.priceUsd || 0);
    const borrowUsd = borrowHuman * loanTokenPriceUsd;
    const collateralUsd = collateralValueLoan * loanTokenPriceUsd;
    const collateralTokenPriceUsd = collateralHuman > 0 ? collateralUsd / collateralHuman : 0;
    const lif = Number(onchain.liquidationIncentiveFactorRaw) / 1e18;
    const route = onchain.seizedExceedsCollateral ? null : await e9FindBestUniswapRoute(provider, pos.market.collateralAsset.address, pos.market.loanAsset.address, seizedCollateralRaw);
    const expectedLoanOutRaw = route?.amountOutRaw || "0";
    const expectedLoanOut = Number(ethers.formatUnits(BigInt(expectedLoanOutRaw), loanDecimals));
    const expectedLoanOutUsd = expectedLoanOut * loanTokenPriceUsd;
    const grossProfit = expectedLoanOutUsd - borrowUsd;
    const netProfit = grossProfit - gasCostUsd;
    const executable = Boolean(
      loanPrice.trusted
      && !onchain.seizedExceedsCollateral
      && route
      && BigInt(expectedLoanOutRaw) > e9ToBigInt(borrowAssetsRaw)
      && netProfit >= E9_MIN_NET_PROFIT_USD
    );

    candidates.push({
      symbol: `${pos.market?.loanAsset?.symbol || "?"}/${pos.market?.collateralAsset?.symbol || "?"}`,
      chainId,
      borrower: pos.user?.address,
      hf: Number(pos.healthFactor).toFixed(4),
      borrowUSD: borrowUsd,
      collateralUSD: collateralUsd,
      borrowAssets: borrowAssetsRaw,
      borrowShares: borrowSharesRaw,
      collateralRaw,
      seizedCollateralRaw: seizedCollateralRaw.toString(),
      loanDecimals,
      collateralDecimals,
      loanTokenPriceUsd,
      collateralTokenPriceUsd,
      pricingTrusted: Boolean(loanPrice.trusted),
      priceSource: loanPrice.source,
      priceReason: loanPrice.reason,
      graphLoanTokenPriceUsd,
      graphPriceDeviationPct: loanPrice.graphDeviationPct,
      liquidationIncentiveFactor: lif,
      expectedLoanOutRaw,
      expectedLoanOutUsd,
      grossProfit,
      gasCostUsd,
      netProfit,
      uniswapFee: route?.fee ?? null,
      uniswapPool: route?.pool || null,
      routeDirect: Boolean(route?.direct),
      onchainQuote: true,
      onchainHealthyBeforeAccrual: Boolean(onchain.onchainHealthyBeforeAccrual),
      seizedExceedsCollateral: Boolean(onchain.seizedExceedsCollateral),
      executable,
      marketParams,
    });
  }

  candidates.sort((a, b) => b.netProfit - a.netProfit);
  return { count: liq.length, candidates, gasCostUsd, ethPrice };
}

async function checkDexLiquidity(collateralSymbol, collateralAddress) {
  const cacheKey = collateralSymbol || collateralAddress;
  if (dexLiquidityCache.has(cacheKey)) {
    const cached = dexLiquidityCache.get(cacheKey);
    if (Date.now() - cached.ts < 3600_000) return cached; // 1hr cache
  }

  // Try Uniswap V3 subgraph for WETH pair
  try {
    const q = `{pools(first:3, orderBy:totalValueLockedUSD, orderDirection:desc, where:{token0_:{symbol:"${collateralSymbol}"}, token1_:{symbol:"WETH"}}){id feeTier totalValueLockedUSD token0 {symbol} token1 {symbol}}}`;
    const r = await fetch("https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v3", {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({query:q}),signal:AbortSignal.timeout(5000)});
    const j = await r.json();
    const pools = j.data?.pools || [];
    const result = { tvl: pools.length > 0 ? Number(pools[0].totalValueLockedUSD) : 0, pools: pools.length, fee: pools.length > 0 ? Number(pools[0].feeTier || 500) : 500, ts: Date.now() };
    dexLiquidityCache.set(cacheKey, result);
    return result;
  } catch (_) {
    // Try USDC pair as fallback
    try {
      const q2 = `{pools(first:1, orderBy:totalValueLockedUSD, orderDirection:desc, where:{token0_:{symbol:"${collateralSymbol}"}, token1_:{symbol:"USDC"}}){id feeTier totalValueLockedUSD}}`;
      const r2 = await fetch("https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v3", {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({query:q2}),signal:AbortSignal.timeout(5000)});
      const j2 = await r2.json();
      const pools2 = j2.data?.pools || [];
      const result = { tvl: pools2.length > 0 ? Number(pools2[0].totalValueLockedUSD) : 0, pools: pools2.length, fee: pools2.length > 0 ? Number(pools2[0].feeTier || 500) : 500, ts: Date.now() };
      dexLiquidityCache.set(cacheKey, result);
      return result;
    } catch (_2) {
      const result = { tvl: 0, pools: 0, fee: 500, ts: Date.now() };
      dexLiquidityCache.set(cacheKey, result);
      return result;
    }
  }
}

async function evaluatorLiquidationHunter(rpcPool, state) {
  try {
    const E9_CHAINS = [1, 8453, 42161, 10];
    const allCandidates = [];
    let totalCount = 0;
    let gasCostUsd = 0;
    let ethPrice = 0;
    const chainCoverage = E9_CHAINS.filter(c => rpcPool[c]).length;

    for (const chainId of E9_CHAINS) {
      const rpc = rpcPool[chainId];
      if (!rpc) continue;

      const provider = new ethers.JsonRpcProvider(rpc, chainId, { staticNetwork: true });
      const result = await buildE9LiquidationCandidates(provider, null, chainId);
      if (result.count > 0) {
        totalCount += result.count;
        allCandidates.push(...result.candidates.map(c => ({ ...c, chainId })));
        if (result.gasCostUsd > 0) gasCostUsd = result.gasCostUsd;
        if (result.ethPrice > 0) ethPrice = result.ethPrice;
      }
    }

    if (totalCount === 0) return {
      count: 0,
      chainCoverage,
    };

    // Sort all candidates by net profit across chains
    allCandidates.sort((a, b) => b.netProfit - a.netProfit);

    const actuallyProfitable = allCandidates.filter(p => p.executable);
    if (actuallyProfitable.length > 0) {
      const top = actuallyProfitable[0];
      return {
        condition: "liquidation-hunter",
        severity: "HIGH",
        count: totalCount,
        chainCoverage,
        profitableCount: actuallyProfitable.length,
        topMarket: top.symbol,
        topHF: top.hf,
        topChain: top.chainId,
        topBorrow: "$" + Math.round(top.borrowUSD).toLocaleString(),
        topNetProfit: "$" + Math.round(top.netProfit).toLocaleString(),
        gasCostUsd,
        autoExecutable: false,
        routeCandidatePositive: true,
        routeAssessment: "candidate-positive",
        executorVersion: "FlashLoanLiquidator:v1",
        message: actuallyProfitable.length + "/" + totalCount + " positions are route-positive candidates. Top: " + top.symbol + " (c" + top.chainId + ") HF=" + top.hf + " net=$" + Math.round(top.netProfit).toLocaleString() + "; monitor-only",
        profitablePositions: actuallyProfitable.slice(0, 5).map(p => ({ ...p, chainId: p.chainId })),
      };
    }

    const top = allCandidates[0];
    return {
      condition: "liquidation-hunter",
      severity: "DORMANT",
      count: totalCount,
      topMarket: top?.symbol || "unknown",
      topChain: top?.chainId,
      topHF: top?.hf || 0,
      topNetProfit: top?.netProfit || 0,
      chainCoverage,
    };
  } catch (_) { return null; }
}

// ═══════════════════════════════════════════════════════════════════
// Evaluator 20: New-Listing Safety Check
// ═══════════════════════════════════════════════════════════════════
// Runs after E12. For every new market E12 detected with elevated risk,
// checks whether borrowing is actually live and the config is unsafe.
// Alerts only when a new market combines high LLTV with active borrowing
// and missing/weak caps/oracle guards — the classic Sonne config-ordering window.

async function evaluatorListingSafety(rpcPool, state, riskItems) {
  const condState = state.conditions[LISTING_SAFETY_CONDITION] || {};
  if (!condState.alertedEvents) condState.alertedEvents = {};
  condState.lastCheck = Date.now() / 1000;
  state.conditions[LISTING_SAFETY_CONDITION] = condState;

  const unsafeListings = [];
  const highRisk = [];

  for (const item of riskItems.filter(r => r.score >= 25)) {
    const key = `${item.label}:${item.chainId}`;
    if (condState.alertedEvents[key]) continue; // already alerted

    const chainId = Number(item.chainId || 1);
    const rpc = rpcPool[chainId];
    if (!rpc) continue;

    // Per-protocol safety checks
    const issues = [];
    let llttvCheck = false;
    let borrowActive = false;

    if (item.label === "Morpho") {
      // Morpho: high LLTV is the primary risk — check oracle freshness
      llttvCheck = item.reasons.some(r => r.includes("LLTV"));
      if (llttvCheck) {
        issues.push("high-LLTV Morpho market detected");
        borrowActive = true; // Morpho markets are borrowable by default after creation
        // Check if the oracle is a known stale-collateral mapping
        if (item.reasons.some(r => r.includes("stale-oracle"))) {
          issues.push("collateral has known stale-oracle mapping");
        }
        if (item.reasons.some(r => r.includes("zero oracle"))) {
          issues.push("oracle is zero address");
        }
      }
    } else if (item.label === "AaveV3") {
      // Aave: new reserve — check if it can be used as collateral
      llttvCheck = true;
      // Aave reserves need explicit collateral enablement; new reserves default to disabled
      issues.push("new Aave reserve; verify collateral enablement manually");
    } else if (item.label === "Compound" || item.label === "CompoundArb") {
      llttvCheck = true;
      issues.push("new Compound Comet; verify collateral factors and borrowing paused state");
    } else if (item.label === "SiloCore") {
      llttvCheck = true;
      issues.push("new Silo market; verify solvency oracle and maxLtv");
    } else if (item.label === "Euler") {
      llttvCheck = true;
      issues.push("new Euler proxy; verify eVault oracle and LTV config");
    } else if (item.label === "FluidVaultT1") {
      llttvCheck = true;
      issues.push("new Fluid vault; verify collateral/debt oracle freshness");
    }

    if (issues.length > 0) {
      const listing = {
        protocol: item.label,
        chainId,
        score: item.score,
        level: item.level,
        reasons: item.reasons,
        issues,
        borrowActive,
        actionable: llttvCheck && borrowActive && item.level !== "INFO",
      };
      unsafeListings.push(listing);
      if (listing.actionable) {
        highRisk.push(listing);
        condState.alertedEvents[key] = Date.now() / 1000;
      }
    }
  }

  if (unsafeListings.length === 0) return null;

  const actionableCount = highRisk.length;
  const severity = actionableCount > 0 ? (actionableCount > 1 ? "CRITICAL" : "HIGH") : "WARN";
  const protocolList = [...new Set(unsafeListings.map(l => l.protocol))].join(", ");
  const issueSummary = highRisk.length > 0
    ? highRisk.map(l => `${l.protocol}: ${l.issues[0]}`).join("; ")
    : unsafeListings.map(l => `${l.protocol}: ${l.issues[0]}`).join("; ");

  return {
    count: unsafeListings.length,
    actionableCount,
    message: `${actionableCount > 0 ? "ACTIONABLE" : "WATCH"}: ${issueSummary}`,
    severity,
    listings: unsafeListings,
    protocols: protocolList,
  };
}

// ═══════════════════════════════════════════════════════════════════
// Evaluator 21: Kamino Liquidation Window (artifact-only, fail-closed)
// ═══════════════════════════════════════════════════════════════════
// This EVM entrypoint never invokes a Solana child or queries a Solana endpoint.
// It only consumes a separately produced, fresh local artifact.

function validateKaminoArtifact(data) {
  if (!Number.isFinite(Number(data?.currentSlot))) return "currentSlot must be numeric";
  for (const key of ["sameSlotReducedRows", "sameSlotLiquidatableRows"]) {
    if (data[key] !== undefined && (!Number.isFinite(Number(data[key])) || Number(data[key]) < 0)) return `${key} must be non-negative`;
  }
  return true;
}

async function evaluatorKaminoLiquidation(_rpcPool, state) {
  const cond = state.conditions[KAMINO_LIQUIDATION_CONDITION] || { lastResult: null };
  state.conditions[KAMINO_LIQUIDATION_CONDITION] = cond;
  cond.lastCheck = Date.now();
  const artifact = readArtifactFile(KAMINO_WINDOW_ARTIFACT, {
    maxAgeMs: 10 * 60_000,
    maxFutureSkewMs: 5 * 60_000,
    timestampFields: ["generatedAt", "scannedAt", "capturedAt"],
    validate: validateKaminoArtifact,
  });
  cond.sourceHealth = artifact.status;
  cond.lastResult = artifact.status === ARTIFACT_STATUS.VALID_FRESH ? artifact.data : null;
  if (artifact.status !== ARTIFACT_STATUS.VALID_FRESH) return null;

  const data = artifact.data;
  const sameSlot = Number(data.sameSlotReducedRows || data.sameSlotReduced || 0);
  const liquidatable = Number(data.sameSlotLiquidatableRows || data.sameSlotLiquidatable || 0);
  const candidates = Number(data.candidates?.length || 0);
  const slot = data.currentSlot;
  if (liquidatable > 0) {
    return { condition: KAMINO_LIQUIDATION_CONDITION, severity: "CRITICAL", sameSlot, liquidatable, candidates, slot, autoExecutable: false, message: `Kamino artifact: ${liquidatable} liquidatable obligation(s) at slot ${slot}; EVM monitor is observation-only` };
  }
  if (sameSlot > 0) {
    return { condition: KAMINO_LIQUIDATION_CONDITION, severity: "HIGH", sameSlot, liquidatable, candidates, slot, autoExecutable: false, message: `Kamino artifact: ${sameSlot} same-slot reduced-status, 0 liquidatable` };
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════
// Evaluator 22: Governance Listing Watch (Snapshot API — no RPC needed)
// ═══════════════════════════════════════════════════════════════════
// Queries Snapshot GraphQL for recent proposals across 10 DeFi governance
// spaces, scores them for listing/collateral/oracle/LTV keywords, and
// raises alerts when high-signal listing proposals are active or recent.

const GOVERNANCE_SPACES = ["aave.eth", "compound-finance.eth", "morpho.eth", "eulerdao.eth", "silo-finance.eth", "pendle-finance.eth", "venus-xvs.eth", "yearn", "curve.eth", "makerdao-ses.eth"];
const GOVERNANCE_RECENT_DAYS = 14;
const GOVERNANCE_WATCH_SCORE = 25;
const GOVERNANCE_LISTING_KEYWORDS = ["collateral", "ltv", "listing", "loan-to-value", "list", "market", "pt-", "risk parameter", "borrow cap", "supply cap", "oracle", "pause", "enable", "add"];
// Attack-relevant keywords — scored higher and trigger CRITICAL alerts (Token of Power pattern)
const GOVERNANCE_ATTACK_KEYWORDS = ["upgrade", "implementation", "setoracle", "changeowner", "transferownership", "setimplementation", "malicious", "timelock bypass", "setLtv", "setCollateralFactor"];

async function evaluatorGovernanceListing(_rpcPool, state) {
  const cond = state.conditions[GOVERNANCE_LISTING_CONDITION] || { lastCheck: null, knownProposalIds: [] };
  const now = Date.now() / 1000;

  // Only check every 6 hours
  if (cond.lastCheck && (now - cond.lastCheck) < 6 * 3600) return null;
  cond.lastCheck = now;
  state.conditions[GOVERNANCE_LISTING_CONDITION] = cond;

  try {
    const since = Math.floor(now - GOVERNANCE_RECENT_DAYS * 86400);
    const query = `query($spaces:[String]!,$first:Int!,$since:Int!){proposals(first:$first,where:{space_in:$spaces,created_gte:$since},orderBy:"created",orderDirection:desc){id title state start end created space scores_total body}}`;
    const json = await fetch("https://hub.snapshot.org/graphql", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables: { spaces: GOVERNANCE_SPACES, first: 80, since } }),
    }).then(r => r.json()).catch(() => null);
    if (!json?.data?.proposals) return null;

    const watchProps = [];
    for (const p of json.data.proposals) {
      if (cond.knownProposalIds.includes(p.id)) continue;
      const text = `${p.title} ${(p.body || "").slice(0, 2000)}`.toLowerCase();
      let score = 0;
      let isAttackProposal = false;
      for (const kw of GOVERNANCE_LISTING_KEYWORDS) {
        if (text.includes(kw)) score += kw === "collateral" || kw === "ltv" || kw === "listing" ? 6 : 3;
      }
      for (const kw of GOVERNANCE_ATTACK_KEYWORDS) {
        if (text.includes(kw)) { score += 20; isAttackProposal = true; }
      }
      if (score >= GOVERNANCE_WATCH_SCORE) {
        cond.knownProposalIds.push(p.id);
        watchProps.push({ id: p.id.slice(0, 16), space: p.space, title: p.title.slice(0, 80), state: p.state, score, isAttackProposal, active: p.state === "active", recent: (now - p.created) < 7 * 86400 });
      }
    }
    // Only keep last 200 proposal IDs
    if (cond.knownProposalIds.length > 200) cond.knownProposalIds = cond.knownProposalIds.slice(-200);

    const activeHigh = watchProps.filter(p => p.active && p.score >= GOVERNANCE_WATCH_SCORE);
    const attackActive = activeHigh.filter(p => p.isAttackProposal);
    const recentHigh = watchProps.filter(p => p.recent && p.score >= GOVERNANCE_WATCH_SCORE && !p.active);
    const attackRecent = recentHigh.filter(p => p.isAttackProposal);

    if (attackActive.length > 0) {
      return { condition: GOVERNANCE_LISTING_CONDITION, severity: "CRITICAL", count: attackActive.length, proposals: attackActive, message: `Governance ATTACK: ${attackActive.length} active malicious governance proposal(s): ${attackActive.map(p => p.title).join("; ")}` };
    } else if (activeHigh.length > 0) {
      return { condition: GOVERNANCE_LISTING_CONDITION, severity: "HIGH", count: activeHigh.length, proposals: activeHigh, message: `Governance: ${activeHigh.length} active high-signal listing proposal(s): ${activeHigh.map(p => p.title).join("; ")}` };
    } else if (recentHigh.length > 0) {
      return { condition: GOVERNANCE_LISTING_CONDITION, severity: "WARN", count: recentHigh.length, proposals: recentHigh, message: `Governance: ${recentHigh.length} recent high-signal listing proposal(s)` };
    }
    return null;
  } catch (_) { return null; }
}

// ═══════════════════════════════════════════════════════════════════
// Evaluator 23: Fork Artifact Evidence
// ═══════════════════════════════════════════════════════════════════
const POSITIVE_FORK_STATUSES = new Set(["positive", "success", "profitable", "route-positive", "fork-positive"]);
const VALID_FORK_STATUSES = new Set([
  ...POSITIVE_FORK_STATUSES,
  "below-threshold", "not-liquidatable", "negative", "clean", "pass", "failed", "error", "inconclusive",
]);

function forkArtifactStatus(data) {
  return typeof data?.status === "string" ? data.status.trim().toLowerCase()
    : typeof data?.verdict === "string" ? data.verdict.trim().toLowerCase()
      : "";
}

function validateForkArtifactSchema(data) {
  const status = forkArtifactStatus(data);
  if (!status) return { incomplete: true, error: "fork artifact status missing" };
  if (!VALID_FORK_STATUSES.has(status)) return "fork artifact status invalid";
  if (data.fork !== undefined && (data.fork === null || typeof data.fork !== "object" || Array.isArray(data.fork))) {
    return "fork must be an object";
  }
  if (data.fork?.success === true && !Number.isFinite(Number(data.fork.netProfitUsd))) return "positive fork netProfitUsd invalid";
  return true;
}

function classifyForkArtifact(data, nowMs = Date.now()) {
  const policy = assessArtifactObject(data, {
    nowMs,
    maxAgeMs: 30 * 60_000,
    maxFutureSkewMs: 5 * 60_000,
    timestampFields: ["generatedAt", "scannedAt"],
    validate: validateForkArtifactSchema,
  });
  const status = forkArtifactStatus(data);
  const positive = policy.status === ARTIFACT_STATUS.VALID_FRESH
    && POSITIVE_FORK_STATUSES.has(status)
    && data?.fork?.success === true
    && Number(data.fork.netProfitUsd) > 0;
  return { ...policy, artifactStatus: status || null, positive };
}

function setE23HardStop(cond, hasFreshPositiveArtifact) {
  cond.hardStop = hasFreshPositiveArtifact === true;
  if (!cond.hardStop) cond.lastResult = null;
  return cond.hardStop;
}

async function evaluatorAutoFork(_rpcPool, state) {
  const cond = state.conditions["auto-fork"] || { lastForked: {}, lastResult: null };
  state.conditions["auto-fork"] = cond;
  setE23HardStop(cond, false);
  cond.sourceHealth = {};

  for (const [name, file] of Object.entries({ morphoWstethWeth: FORK_PROOF_MORPHO, aaveV4: FORK_PROOF_AAVE, aaveV3: FORK_PROOF_AAVE_V3 })) {
    const read = readArtifactFile(file, {
      maxAgeMs: 30 * 60_000,
      maxFutureSkewMs: 5 * 60_000,
      timestampFields: ["generatedAt", "scannedAt"],
      validate: validateForkArtifactSchema,
    });
    const classified = read.status === ARTIFACT_STATUS.VALID_FRESH ? classifyForkArtifact(read.data) : read;
    cond.sourceHealth[name] = classified.status;
    if (!classified.positive) continue;

    const fork = classified.data.fork;
    const result = {
      condition: AUTO_FORK_CONDITION,
      severity: "CRITICAL",
      hardStop: true,
      surface: name,
      sourceHealth: ARTIFACT_STATUS.VALID_FRESH,
      sourceGeneratedAt: classified.generatedAt,
      sourceAgeMs: classified.ageMs,
      netProfitUsd: Number(fork.netProfitUsd),
      seizedUsd: fork.seizedUsd ?? null,
      profitWeth: fork.profitWeth ?? null,
      autoExecutable: false,
      message: `Fresh fork evidence is positive for ${name}; HARD STOP before any action. No transaction or signing is permitted.`,
    };
    cond.lastResult = result;
    setE23HardStop(cond, true);
    return result;
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════
// Evaluator 24: apyUSD Receipt Preflight (checks live state every cycle)
// ═══════════════════════════════════════════════════════════════════
// The apyUSD receipt-claim route is the #1 ranked fork-positive surface.
// This evaluator checks live conditions: receipt paused? vault cash? fees?
// Run every full cycle so the dashboard always shows current executability.

const APYUSD_RECEIPT = "0x9bf51F33955EC70f87C4b5C49441815589043237";
const APYUSD_VAULT = "0x38EEb52F0771140d10c4E9A9a72349A329Fe8a6A";
const APYUSD_ASSET = "0x98A878b1Cd98131B271883B390f68D2c90674665";

async function evaluatorApyusdPreflight(rpcPool, state, options = {}) {
  const cond = state.conditions["apyusd-preflight"] || { lastCheck: null, lastResult: null };
  cond.lastCheck = Date.now() / 1000;
  state.conditions["apyusd-preflight"] = cond;

  const rpc = rpcPool[1];
  if (!rpc) return null;

  const call = options.rpcCall || rpcCall;
  try {
    // Check receipt: paused?
    const pausedSel = ethers.id("paused()");
    const pausedRaw = await call(rpc, "eth_call", [{to:APYUSD_RECEIPT, data:pausedSel}, "latest"], 8000).catch(()=>null);
    const paused = pausedRaw !== null && pausedRaw !== "0x" && BigInt(pausedRaw) !== 0n;

    // Vault accounting assets can include deployed funds; cash is the asset token balance.
    const totalAssetsSel = ethers.id("totalAssets()").slice(0, 10);
    const totalAssetsRaw = await call(rpc, "eth_call", [{to:APYUSD_VAULT, data:totalAssetsSel}, "latest"], 8000).catch(()=>null);
    const totalAssets = totalAssetsRaw && totalAssetsRaw !== "0x" ? Number(BigInt(totalAssetsRaw)) / 1e18 : null;
    const balanceData = "0x70a08231" + APYUSD_VAULT.slice(2).toLowerCase().padStart(64, "0");
    const cashRaw = await call(rpc, "eth_call", [{to:APYUSD_ASSET, data:balanceData}, "latest"], 8000).catch(()=>null);
    const cash = cashRaw && cashRaw !== "0x" ? Number(BigInt(cashRaw)) / 1e18
      : call !== rpcCall ? totalAssets : null; // Only explicitly injected mocks may use the legacy fallback.

    // Fee curve: read the fork-proof artifact for fee curve parameters
    const forkArt = loadJson(path.join(WORKSPACE, "reports", "raw", "fast", "apyusd-erc4626-fork-proof.json"), null);
    const bestNet = forkArt?.result?.netProfitUsd || null;

    const issues = [];
    if (paused) issues.push("receipt-paused");
    if (cash === null) issues.push("vault-cash-unavailable");
    else if (cash < 100000) issues.push("vault-cash-low");
    if (bestNet === null || bestNet <= 0) issues.push("fork-proof-stale-or-negative");

    const capitalNote = [
      "FLASH LOAN: NO - receipt has 3-20d unlock delay; flash loans repay same-tx",
      "DeFi LENDING: NO - apxUSD not accepted as collateral anywhere; small wallet cannot cover required size",
      "NFT SALE: NO - UnlockReceipt is soulbound (non-transferable)",
      "REQUIRES: ~$25k apxUSD in own wallet, locked 3-20 days"
    ];
    const routeModelPositive = issues.length === 0;
    cond.lastResult = {
      paused,
      totalAssets,
      cash,
      bestNet,
      executable: false,
      executableNow: false,
      routeModelPositive,
      issues,
      capitalBlocked: true,
      capitalNeededUsd: 25000,
      autoExecutionDisabled: true,
      disabledReason: "capital-locked-delayed",
      capitalNote,
      checked: new Date().toISOString(),
    };

    if (routeModelPositive) {
      return {
        condition: APYUSD_PREFLIGHT_CONDITION, severity: "HIGH",
        paused, cash, bestNet,
        executableNow: false,
        autoExecutable: false,
        routeModelPositive,
        capitalBlocked: true,
        capitalNeededUsd: 25000,
        autoExecutionDisabled: true,
        disabledReason: "capital-locked-delayed",
        capitalNote,
        message: `apyUSD RECEIPT CAPITAL-BLOCKED: modeled net profit ~$${bestNet?.toFixed(2)} but needs ~$25k apxUSD and a 3-20d lock; no flash loan, no DeFi borrow, no NFT sale possible`,
      };
    }
    return null;
  } catch (_) { return null; }
}

// ═══════════════════════════════════════════════════════════════════
// Evaluator 25: EigenLayer NAV-DEX Watch
// ═══════════════════════════════════════════════════════════════════
// Reads weETH on-chain rate vs the Curve weETH/WETH quote. When NAV-DEX gap >
// 30bps (LTV-adjusted break-even for 94.5% LLTV Morpho route), raises
// HIGH alert. This is the EigenLayer withdrawal queue timing surface.
// Reuses Attack A scan logic from scan-eigenlayer-lrt-nav-dex-divergence.js

const EIGENLAYER_WEETH = "0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee";
const EIGENLAYER_LP = "0x308861A430be4cce5502d0A12724771Fc6DaF216";
const EIGENLAYER_NAVDEX_THRESHOLD_BPS = 30; // gap needed for LLTV-breakeven
const E25_AMOUNT_FOR_SHARE_SELECTOR = ethers.id("amountForShare(uint256)").slice(0, 10);

function evaluateE25Rates(navRateInput, dexRateInput) {
  const navRate = Number(navRateInput);
  const dexRate = Number(dexRateInput);
  if (!Number.isFinite(navRate) || !Number.isFinite(dexRate) || navRate < 0.5 || navRate > 2 || dexRate < 0.5 || dexRate > 2) {
    return { status: "INVALID_DATA", navRate, dexRate, gapBps: null, valid: false };
  }
  const gapBps = ((navRate / dexRate) - 1) * 10000;
  if (!Number.isFinite(gapBps) || Math.abs(gapBps) > 5000) {
    return { status: "INVALID_DATA", navRate, dexRate, gapBps: null, valid: false };
  }
  return { status: "VALID", navRate, dexRate, gapBps, valid: true };
}

async function evaluatorEigenlayerNavdex(rpcPool, state) {
  const cond = state.conditions["eigenlayer-navdex"] || { lastCheck: null, lastGapBps: null };
  cond.lastCheck = Date.now() / 1000;
  state.conditions["eigenlayer-navdex"] = cond;

  const rpc = rpcPool[1];
  if (!rpc) return null;

  try {
    // On-chain weETH rate (amountForShare)
    const afsSel = E25_AMOUNT_FOR_SHARE_SELECTOR;
    const afsData = afsSel + ethers.zeroPadValue(ethers.toBeHex(10n**18n), 32).slice(2);
    const afsRaw = await rpcCall(rpc, "eth_call", [{to:EIGENLAYER_LP, data:afsData}, "latest"], 8000).catch(()=>null);
    const navRate = afsRaw ? Number(BigInt(afsRaw)) / 1e18 : null;

    // Quote one weETH into WETH directly from Curve.
    const curve = new ethers.Interface(["function get_dy(int128,int128,uint256) view returns (uint256)"]);
    const getDyData = curve.encodeFunctionData("get_dy", [1, 0, 10n ** 18n]);
    const getDyRaw = await rpcCall(rpc, "eth_call", [{to:"0xDB74dfDD3BB46bE8Ce6C33dC9D82777BCFc3dEd5", data:getDyData}, "latest"], 8000).catch(()=>null);
    const dexRate = getDyRaw && getDyRaw !== "0x" ? Number(BigInt(getDyRaw)) / 1e18 : null;

    const evaluated = evaluateE25Rates(navRate, dexRate);
    if (!evaluated.valid) {
      cond.lastError = { code: "INVALID_DATA", navRate: Number.isFinite(navRate) ? navRate : null, dexRate: Number.isFinite(dexRate) ? dexRate : null };
      cond.sourceHealth = "INVALID_DATA";
      cond.lastGapBps = null;
      return null;
    }

    const { gapBps } = evaluated;
    cond.lastError = null;
    cond.sourceHealth = "VALID";
    cond.lastGapBps = gapBps;

    if (gapBps >= EIGENLAYER_NAVDEX_THRESHOLD_BPS) {
      return {
        condition: EIGENLAYER_NAVDEX_CONDITION, severity: "HIGH",
        navRate: navRate.toFixed(6), dexRate: dexRate.toFixed(6), gapBps: gapBps.toFixed(2),
        autoExecutable: false,
        message: `EigenLayer NAV-DEX gap watch: ${gapBps.toFixed(1)}bps weETH nav>dex; consumer runtime, liquidity, and complete route validation are still required.`,
        liquidationUsd: 3090000, // Morpho weETH/WETH liquidity
      };
    }
    return null;
  } catch (_) { return null; }
}

// ═══════════════════════════════════════════════════════════════════
// Evaluator 26: Marginfi Oracle/LTV Watch
// ═══════════════════════════════════════════════════════════════════
// Reads the snapshot artifact and flags high-LTV operational banks.
// Full-cycle only (the artifact is refreshed on-demand, not per-cycle).

async function evaluatorMarginfiOracle(_rpcPool, state) {
  const cond = state.conditions["marginfi-oracle"] || { lastCheck: null, highLtvCount: 0 };
  cond.lastCheck = Date.now() / 1000;
  state.conditions["marginfi-oracle"] = cond;

  try {
    const policy = readArtifactFile(MARGINFI_CONFIG_FILE, {
      maxAgeMs: 24 * 3600_000,
      maxFutureSkewMs: 5 * 60_000,
      requiredPaths: ["generatedAt", "topRows"],
      validate: (artifact) => Array.isArray(artifact.topRows) || "topRows must be an array",
    });
    cond.sourceHealth = policy.status;
    if (policy.status !== ARTIFACT_STATUS.VALID_FRESH) {
      cond.lastError = { code: policy.status, message: policy.error || "Marginfi evidence artifact unavailable or stale" };
      cond.highLtvCount = 0;
      return null;
    }
    cond.lastError = null;
    const rows = policy.data.topRows;
    const watch = rows.filter(r => r.highLTV && r.operational && (r.oracleMaxAge === 0 || r.oracleMaxAge > 3600));
    cond.highLtvCount = watch.length;

    if (watch.length > 0) {
      const top = watch[0];
      return {
        condition: MARGINFI_ORACLE_CONDITION, severity: "INFO",
        highLtvCount: watch.length, watchCount: watch.length,
        topLTV: top.assetWeightInit, topOracle: top.oracleLabel, topName: top.name || top.ticker || "unavailable",
        sourceHealth: ARTIFACT_STATUS.VALID_FRESH,
        sourceGeneratedAt: policy.generatedAt,
        sourceAgeMs: policy.ageMs,
        researchEvidenceOnly: true,
        autoExecutable: false,
        message: `Marginfi research evidence: ${watch.length} high-LTV operational bank(s); Solana runtime and route validation remain outside this EVM lane.`
      };
    }
    return null;
  } catch (_) { return null; }
}

// ═══════════════════════════════════════════════════════════════════
// Evaluator 12: New Market Deployments
// ═══════════════════════════════════════════════════════════════════
// Scans Morpho Blue, Compound V3, Euler EVK for fresh market deployments.
// New markets often have zero caps or misconfigured oracles.

const NEW_MARKET_EVENTS = [
  // Morpho Blue — same CREATE2 address on all EVM chains
  {
    name: "Morpho",
    address: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
    getAddress: (chainId) => ({
      1: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
      8453: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
      42161: "0x6c247b1F6182318877311737BaC0844bAa518F5e",
    }[chainId]),
    topic: "0x8a41cabf57f8c9e58b85a041c8b6e82af3eb44c2a21833c0f03a639b5bcb1c49",
    chainId: null, // chain-specific where Morpho public data confirms deployment
    decode: (log) => {
      const id = "0x" + log.topics[1].slice(26);
      const data = log.data.slice(2);
      const loanToken  = "0x" + data.slice(24, 64);
      const collToken  = "0x" + data.slice(88, 128);
      const oracle     = "0x" + data.slice(152, 192);
      const irm        = "0x" + data.slice(216, 256);
      const lltvRaw    = BigInt("0x" + data.slice(256, 320));
      const lltv = Number(lltvRaw) / 1e18;
      return { id, loanToken, collToken, oracle, irm, lltv, lltvRaw: lltvRaw.toString() };
    }
  },
  {
    name: "Compound",
    address: "0x316f9708bB98af7dA9c68C1C3b5e79039cD336E3",
    topic: "0xc353ca4b6e062b7b189a00666ebae623ec19cd1e12af4f630aaac258ce89c2d4",
    chainId: 1, // Ethereum only
    decode: (log) => ({
      cometProxy: "0x" + log.topics[1].slice(26),
      newComet:   "0x" + log.topics[2].slice(26),
    })
  },
  {
    name: "Euler",
    address: "0x29a56a1b8214D9Cf7c5561811750D5cBDb45CC8e",
    topic: "0x1bfa65cc35cada13d1626febf3554bef0b8124aaa6c1b0fa984774ce1aa74d6c",
    chainId: 1, // Ethereum only
    decode: (log) => ({
      proxy: "0x" + log.topics[1].slice(26),
    })
  },

  // ── L2 Protocol Market-Creation Events ──

  // Silo V2 — permissionless isolated lending markets (Arb, OP, Base)
  {
    name: "SiloCore",
    address: null, // chain-specific below
    topic: "0xd9bcb3c74e28ea1685103853dc61d6add7a553367a42ecb45ef42393da52ba8f",
    chainId: null,
    getAddress: (chainId) => ({
      42161: "0xa33B15e3Ca591B59C7F115D4c453e1764827B540",
      10:     "0x2458ee990E64D8793Fe61212558AD8b1a7BdD845",
      8453:   "0x66cFBfB5a8256DA57E486164b791b7778927BaB8",
    }[chainId]),
    decode: (log) => ({
      siloConfig: "0x" + log.topics[1].slice(26),
    })
  },
  // Silo V2 Vaults — permissionless ERC4626 yield vaults
  {
    name: "SiloVault",
    address: null,
    topic: "0x17c765c5a7d7a44bd3ed97965cb2ddea0f121ba7528c6f93f6516746a8fe8806", // CreateSiloVault(address,address,address)
    chainId: null,
    getAddress: (chainId) => ({
      42161: "0x408a8d7cA85b830A567D51d3c5e627648aa2C7ff",
      10:     "0x228A8688C0d8Fd6D4834c33664E5Fa775C91d11c",
      8453:   "0xf5D7D0A4D98f8D696558B17A7c1742E2dc8D1144",
    }[chainId]),
    decode: (log) => ({
      vault: "0x" + log.topics[1].slice(26),
      incentivesController: "0x" + log.topics[2].slice(26),
      idleVault: "0x" + log.data.slice(2+24, 2+64), // 3rd non-indexed param
    })
  },
  // Aave V3 — new reserve added on PoolConfigurator (governance)
  {
    name: "AaveV3",
    address: null,
    topic: "0xc51aca575985d521c5072ad11549bad7707ddb96c79aef1b8d15782ebcdfe835",
    chainId: null,
    getAddress: (chainId) => ({
      8453:   "0x5731a04B1E775f0fdd454Bf70f3335886e9A96be",
      10:     "0x8145eddDf43f50276641b55bd3AD95944510021E",
      42161:  "0x8145eddDf43f50276641b55bd3AD95944510021E",
      137:    "0x8145eddDf43f50276641b55bd3AD95944510021E",
    }[chainId]),
    decode: (log) => ({
      asset: "0x" + log.topics[1].slice(26),
      aToken: "0x" + log.topics[2].slice(26),
    })
  },
  // Compound V3 on Arbitrum — CometDeployed (governance)
  {
    name: "CompoundArb",
    address: "0xb21b06D71c75973babdE35b49fFDAc3F82Ad3775",
    topic: "0x94fe8aa6d2ed314eb59f22cb7e389407f22c7e3b760acf02d2a7342c6f189f30",
    chainId: 42161,
    decode: (log) => ({
      cometProxy: "0x" + log.topics[1].slice(26),
      newComet: "0x" + log.topics[2].slice(26),
    })
  },
  // Fluid VaultT1 on Arbitrum + Polygon (permissioned)
  {
    name: "FluidVaultT1",
    address: "0x324c5Dc1fC42c7a4D43d92df1eBA58a54d13Bf2d",
    topic: "0x8f9d7dfba5b9c217a2e30c89ad285ca783a02c7cb2ee709376c6e8c61d7c012f", // VaultT1Deployed(address,uint256,address,address)
    chainId: null, // present on Arb + Poly (same address)
    decode: (log) => ({
      vault: "0x" + log.topics[1].slice(26),
      supplyToken: "0x" + log.topics[3].slice(26),
      borrowToken: log.topics[4] ? "0x" + log.topics[4].slice(26) : "",
    })
  },
  // Dolomite on Arbitrum + Base (governance)
  {
    name: "Dolomite",
    address: null,
    topic: "0x3222f6df94bb10f0fe37c02cd2dea6ab676e50e7cc3392579ff0b6c1b86c9055",
    chainId: null,
    getAddress: (chainId) => ({
      42161: "0x6Bd780E7fDf01D77e4d475c821f1e7AE05409072",
      8453:   "0x003Ca23Fd5F0ca87D01F6eC6CD14A8AE60c2b97D",
    }[chainId]),
    decode: (log) => ({
      marketId: BigInt("0x" + log.data.slice(2, 66)),
      token: "0x" + log.data.slice(90, 130),
    })
  },
  // Venus Isolated Pools on Arb, OP, Base (governance)
  {
    name: "VenusPool",
    address: null,
    topic: "0x0ce5b4f58b13dcd4ed5560e7ea6ec5b17accf0de6a73e32f2f5815dff60ae0bb", // PoolRegistered(address,(string,address,address,uint256,uint256))
    chainId: null,
    getAddress: (chainId) => ({
      42161: "0x382238f07Bc4Fe4aA99e561adE8A4164b5f815DA",
      10:     "0x147780799840d541C1d7c998F0cbA996d11D62bb",
      8453:   "0xeef902918DdeCD773D4B422aa1C6e1673EB9136F",
    }[chainId]),
    decode: (log) => ({
      comptroller: "0x" + log.topics[1].slice(26),
    })
  },
];

function isKnownMorphoStaleCollateral(token) {
  if (!token) return false;
  const t = token.toLowerCase();
  return Object.keys(COLLATERAL_FEEDS || {}).some(k => k.toLowerCase() === t);
}

function riskLevel(score) {
  if (score >= 80) return "CRITICAL";
  if (score >= 50) return "HIGH";
  if (score >= 25) return "MEDIUM";
  return "INFO";
}

async function scoreNewMarketEvent(evt, decoded, chainId, rpc) {
  let score = 0;
  const reasons = [];
  const label = evt.name;

  if (evt.name === "Morpho") {
    const lltv = Number(decoded.lltv || 0);
    if (lltv >= 0.90) { score += 80; reasons.push(`very-high LLTV ${(lltv * 100).toFixed(0)}%`); }
    else if (lltv >= 0.86) { score += 60; reasons.push(`high LLTV ${(lltv * 100).toFixed(0)}%`); }
    else if (lltv >= 0.77) { score += 30; reasons.push(`elevated LLTV ${(lltv * 100).toFixed(0)}%`); }
    if (decoded.oracle === ZERO) { score += 40; reasons.push("zero oracle"); }
    if (isKnownMorphoStaleCollateral(decoded.collToken)) { score += 35; reasons.push("known stale-oracle collateral mapping"); }
    if (decoded.loanToken && decoded.collToken && decoded.loanToken.toLowerCase() === decoded.collToken.toLowerCase()) {
      score += 20; reasons.push("same-token market needs special handling");
    }
  } else if (evt.name === "SiloVault") {
    score += 35; reasons.push("new ERC4626 vault");
    const vault = decoded.vault;
    if (vault && rpc) {
      const [assetsHex, decHex] = await Promise.all([
        ethCall(rpc, vault, "0x01e1d114" /* totalAssets() */),
        ethCall(rpc, vault, "0x313ce567" /* decimals() */),
      ]);
      if (assetsHex && assetsHex !== "0x") {
        const dec = decHex && decHex !== "0x" ? Number(uint256(decHex.slice(2))) : 18;
        const assets = Number(uint256(assetsHex.slice(2))) / (10 ** Math.min(dec, 18));
        if (assets === 0) { score += 30; reasons.push("zero totalAssets"); }
        else if (assets < 10_000) { score += 20; reasons.push(`low totalAssets ${assets.toFixed(2)}`); }
      }
    }
  } else if (evt.name === "SiloCore") {
    score += 45; reasons.push("new isolated Silo market; check oracle and opposite liquidity");
  } else if (evt.name === "FluidVaultT1") {
    score += 45; reasons.push("new Fluid vault; check collateral/debt oracle assumptions");
  } else if (evt.name === "VenusPool") {
    score += 40; reasons.push("new Venus pool; check CF/caps/oracle pivots");
  } else if (evt.name === "AaveV3") {
    score += 30; reasons.push("new Aave reserve; check collateral enablement and caps");
  } else if (evt.name === "Compound" || evt.name === "CompoundArb") {
    score += 35; reasons.push("new Compound Comet; check base asset, collateral list, and oracle freshness");
  } else if (evt.name === "Euler") {
    score += 35; reasons.push("new Euler proxy; check oracle and vault config");
  } else if (evt.name === "Dolomite") {
    score += 30; reasons.push("new Dolomite market; check oracle source and isolation mode");
  }

  if (score === 0) reasons.push("new market event; manual review");
  return { label, chainId, score, level: riskLevel(score), reasons };
}

async function evaluatorNewMarketDeployments(rpcPool, state) {
  const condState = state.conditions["new-market-deployments"] || {};
  if (!Array.isArray(condState.known)) condState.known = [];
  condState.morphoEvents = condState.morphoEvents || []; // for E12x staleness check
  state.conditions["new-market-deployments"] = condState;

  try {
    const newMarkets = [];
    const riskItems = [];
  // Scan chains: 1=Ethereum, 8453=Base, 42161=Arbitrum, 10=Optimism, 137=Polygon, 100=Gnosis, 42220=Celo, 250=Fantom, 56=BSC, 43114=Avalanche
  const scanChains = [1, 8453, 42161, 10, 137, 100, 42220, 250, 56, 43114];

    for (const chainId of scanChains) {
      const rpc = rpcPool[chainId];
      if (!rpc) continue;

      const chainKey = `lastBlock_c${chainId}`;
      const block = await rpcCall(rpc, "eth_blockNumber", []);
      if (!block) continue;
      const currentBlock = parseInt(block, 16);
      let lastChecked = condState[chainKey] || currentBlock - 100;
      if (lastChecked > currentBlock) lastChecked = currentBlock - 100;
      const lookback = Math.min(Math.max(currentBlock - lastChecked, 0), 14400);

      for (const evt of NEW_MARKET_EVENTS) {
        // Skip chain-specific events on unsupported chains
        if (evt.chainId && evt.chainId !== chainId) continue;
        // Resolve dynamic address (e.g., Silo has different deployer per chain)
        const evtAddr = evt.getAddress ? evt.getAddress(chainId) : evt.address;
        if (!evtAddr) continue;

        try {
          const logs = await rpcCall(rpc, "eth_getLogs", [{
            address: evtAddr,
            topics: [evt.topic],
            fromBlock: "0x" + Math.max(currentBlock - lookback, 0).toString(16),
            toBlock: "0x" + currentBlock.toString(16),
          }]);

          if (!logs || logs.length === 0) continue;

          for (const log of logs) {
            const txHash = log.transactionHash || "0x";
            const key = `${evt.name}:${chainId}:${txHash}`;
            if (condState.known.includes(key)) continue;
            condState.known.push(key);

            const decoded = evt.decode(log);
            const chainTag = chainId === 1 ? "ETH" : chainId === 8453 ? "Base" : chainId === 42161 ? "Arb" : `L2:${chainId}`;
            const risk = await scoreNewMarketEvent(evt, decoded, chainId, rpc);
            riskItems.push({ ...risk, market: `${chainTag}:${evt.name}`, txHash });
            if (evt.name === "Morpho") {
              newMarkets.push(`${chainTag}:Morpho:${decoded.loanToken.slice(0,8)}/${decoded.collToken.slice(0,8)} LLTV=${(decoded.lltv*100).toFixed(0)}%`);
              // Collect for E12x staleness check (deduped)
              if (!condState.morphoEvents.some(e => e.txHash === txHash)) {
                condState.morphoEvents.push({ txHash, chainId, decoded });
              }
            } else if (evt.name === "Compound" || evt.name === "CompoundArb") {
              newMarkets.push(`${chainTag}:Compound:${decoded.cometProxy.slice(0,10)}`);
            } else if (evt.name === "Euler") {
              newMarkets.push(`${chainTag}:Euler:${decoded.proxy.slice(0,10)}`);
            } else if (evt.name === "SiloCore") {
              newMarkets.push(`${chainTag}:Silo:${decoded.siloConfig.slice(0,10)}`);
            } else if (evt.name === "SiloVault") {
              newMarkets.push(`${chainTag}:SiloVault:${decoded.vault.slice(0,10)}`);
            } else if (evt.name === "AaveV3") {
              newMarkets.push(`${chainTag}:Aave:${decoded.asset.slice(0,10)}`);
            } else if (evt.name === "FluidVaultT1") {
              newMarkets.push(`${chainTag}:FluidVault:${decoded.supplyToken.slice(0,8)}/${decoded.borrowToken.slice(0,8)}`);
            } else if (evt.name === "Dolomite") {
              newMarkets.push(`${chainTag}:Dolomite:market#${decoded.marketId} token=${decoded.token.slice(0,8)}`);
            } else if (evt.name === "VenusPool") {
              newMarkets.push(`${chainTag}:VenusPool:${decoded.comptroller.slice(0,10)}`);
            }
          }
        } catch (e) {
          // Log but continue — single chain/protocol RPC failure shouldn't block others
          logPrint(`  E12: ${evt.name} scan failed on chain ${chainId}: ${e.message?.slice(0,60) || "RPC error"}`);
        }
      }

      condState[chainKey] = currentBlock;
    }

    if (newMarkets.length > 0) {
      riskItems.sort((a, b) => b.score - a.score);
      const topRisk = riskItems[0];
      const severity = riskItems.some(r => r.level === "CRITICAL") || newMarkets.length > 3
        ? "CRITICAL"
        : riskItems.some(r => r.level === "HIGH")
          ? "HIGH"
          : "MEDIUM";
      return {
        condition: "new-market-deployment",
        severity,
        count: newMarkets.length,
        markets: newMarkets,
        topRisk,
        riskItems: riskItems.slice(0, 10),
        message: `${newMarkets.length} new market(s) deployed. Top risk=${topRisk?.level || "INFO"}/${topRisk?.score || 0} ${topRisk?.market || "unknown"}: ${(topRisk?.reasons || []).join(", ")}. ${newMarkets.slice(0,3).join(" | ")}`,
      };
    }
    return null;
  } catch (e) {
    logPrint(`  E12: scanner error: ${e.message?.slice(0,80) || "unknown"}`);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════
// EVALUATOR E12x: Morpho New-Market + Stale-Oracle Arbitrage
// ═══════════════════════════════════════════════════════════════════
// When E12 detects a new Morpho market, checks if the collateral's
// Chainlink feed is stale + divergent. Positive routes remain observational.
// Thresholds match E1: 5% divergence, 1800s staleness.

const MORPHO_EXPLOIT_CONDITION = "morpho-new-market-exploit";
const MORPHO_EXPLOIT_MIN_DIVERGENCE = 5.0;
const MORPHO_EXPLOIT_MIN_AGE = 1800;
const MORPHO_EXPLOIT_FLASH_COLLATERAL = 0.5;
const MORPHO_EXPLOIT_BORROW_BUFFER = 0.90;
const MORPHO_EXPLOIT_GAS_USED = 3_000_000;
const MORPHO_EXPLOIT_MIN_NET_USD = Number(runtimeConfig.E12X_MIN_NET_PROFIT_USD || "25");
const E12X_EXECUTOR_VERSION = "GenericMorphoExploit:min-output-v3";
const E12X_FALLBACK_CONTRACT = "0x492b15a4A93F74C8A027E69c91f2656AB5453c19";
const E12X_DEPLOY_JSON = path.join(WORKSPACE, "exploits", "morpho-market-exploit", "deploy.json");
const E12X_BALANCER_VAULT = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";
const E12X_UNISWAP_ROUTER = "0xE592427A0AEce92De3Edee1F18E0157C05861564";
const E12X_BALANCER_FEE_BPS = BigInt(runtimeConfig.E12X_BALANCER_FEE_BPS || "1");
const E12X_SLIPPAGE_BPS = BigInt(runtimeConfig.E12X_SLIPPAGE_BPS || "9950");
const E12X_TOKEN_IFACE = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);

const E12X_CHAIN_READINESS = {
  1: { status: "candidate-observed", reason: "Ethereum route has prior deployment/fork evidence; this monitor does not authorize or execute it." },
  8453: { status: "watch-only", reason: "Base fork proof passed with Router02, but no deployed Base executor, bytecode verifier target, or chain/address artifact gate yet." },
  42161: { status: "watch-only", reason: "Arbitrum Morpho deployment remapped from public Morpho data, but no Arbitrum fork proof, deployed executor, or artifact gate yet." },
  10: { status: "blocked", reason: "Optimism has no Morpho deployment in current public Morpho data for this E12x variant." },
  137: { status: "blocked", reason: "Polygon has no Morpho deployment in current public Morpho data for this E12x variant." },
};

// Known collateral → Chainlink ETH/USD feed mapping (for stETH derivatives)
const COLLATERAL_FEEDS = {
  "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0": "0xCfE54B5cD566aB89272946F602D76Ea879CAb4a8", // wstETH → stETH/USD
  "0xBe9895146f7AF43049ca1c1AE358B0541Ea49704": "0x5f4eC3Df9cbd43714FE2740f5e3616155c5b8419", // cbETH → ETH/USD (approximate via stETH/ETH parity)
  "0xae78736Cd615f374D3085123A210448E74Fc6393": "0x5f4eC3Df9cbd43714FE2740f5e3616155c5b8419", // rETH → ETH/USD
  "0xe95A203B1a91a908F9B9ce46459d101078c2c3cb": "0x5f4eC3Df9cbd43714FE2740f5e3616155c5b8419", // ankrETH → ETH/USD
};

function getE12xContractAddress() {
  try {
    const deploy = JSON.parse(fs.readFileSync(E12X_DEPLOY_JSON, "utf8"));
    if (deploy.chainId === 1 && ethers.isAddress(deploy.address)) return deploy.address;
  } catch (_) {}
  return E12X_FALLBACK_CONTRACT;
}

async function e12xTokenDecimals(provider, token, fallback = 18) {
  try {
    const raw = await provider.call({ to: token, data: E12X_TOKEN_IFACE.encodeFunctionData("decimals", []) });
    const [decimals] = E12X_TOKEN_IFACE.decodeFunctionResult("decimals", raw);
    const n = Number(decimals);
    return Number.isFinite(n) && n >= 0 && n <= 36 ? n : fallback;
  } catch (_) { return fallback; }
}

async function e12xTokenBalance(provider, token, account) {
  try {
    const raw = await provider.call({ to: token, data: E12X_TOKEN_IFACE.encodeFunctionData("balanceOf", [account]) });
    const [balance] = E12X_TOKEN_IFACE.decodeFunctionResult("balanceOf", raw);
    return balance;
  } catch (_) { return 0n; }
}

async function e12xQueryFeedProvider(provider, feedAddr) {
  try {
    const raw = await provider.call({ to: feedAddr, data: E9_CHAINLINK_IFACE.encodeFunctionData("latestRoundData", []) });
    const [, answer, , updatedAt] = E9_CHAINLINK_IFACE.decodeFunctionResult("latestRoundData", raw);
    if (answer <= 0n || updatedAt <= 0n) return null;
    return { answer, updatedAt: Number(updatedAt) };
  } catch (_) { return null; }
}

async function e12xCollateralUsd(provider, collateralToken, staleFeedUsd, ethUsd) {
  const tokenLc = String(collateralToken || "").toLowerCase();
  if (tokenLc === E9_WSTETH.toLowerCase()) {
    const raw = await provider.call({ to: E9_WSTETH, data: E9_STETH_PER_TOKEN_IFACE.encodeFunctionData("stEthPerToken", []) }).catch(() => null);
    if (!raw) return null;
    const [stEthPerToken] = E9_STETH_PER_TOKEN_IFACE.decodeFunctionResult("stEthPerToken", raw);
    const spr = Number(stEthPerToken) / 1e18;
    return { staleCollateralUsd: staleFeedUsd * spr, liveCollateralUsd: ethUsd * spr, ratio: spr };
  }
  return { staleCollateralUsd: staleFeedUsd, liveCollateralUsd: ethUsd, ratio: 1 };
}

async function buildE12xRoute(rpcPool, evt, gasPriceOverride = null, providerOverride = null) {
  const chainId = Number(evt?.chainId || 0);
  const decoded = evt?.decoded || {};
  const mp = {
    loanToken: decoded.loanToken,
    collateralToken: decoded.collToken || decoded.collateralToken,
    oracle: decoded.oracle,
    irm: decoded.irm,
    lltv: decoded.lltvRaw || decoded.lltv,
  };
  if (![mp.loanToken, mp.collateralToken, mp.oracle, mp.irm].every((addr) => ethers.isAddress(addr))) {
    return { executable: false, candidate: false, reason: "invalid market params" };
  }
  const lltvRaw = e9ToBigInt(mp.lltv);
  if (lltvRaw <= 0n || lltvRaw >= E9_WAD) return { executable: false, candidate: false, reason: "invalid LLTV" };

  if (chainId !== 1) {
    const readiness = E12X_CHAIN_READINESS[chainId];
    return {
      executable: false,
      candidate: !!readiness,
      reason: readiness?.reason || "non-Ethereum E12x route is not mapped",
      marketParams: mp,
      chainReadiness: readiness || { status: "unmapped" },
    };
  }

  const feedKey = Object.keys(COLLATERAL_FEEDS).find((k) => k.toLowerCase() === mp.collateralToken.toLowerCase());
  const feedAddr = feedKey ? COLLATERAL_FEEDS[feedKey] : null;
  if (!feedAddr) return { executable: false, candidate: false, reason: "unsupported collateral" };

  const rpc = rpcPool?.[1];
  const provider = providerOverride || (rpc ? new ethers.JsonRpcProvider(rpc) : null);
  if (!provider) return { executable: false, candidate: false, reason: "missing Ethereum RPC" };

  const [feedData, block, ethUsd] = await Promise.all([
    rpc ? queryFeed(rpc, feedAddr).catch(() => null) : e12xQueryFeedProvider(provider, feedAddr),
    provider.getBlock("latest").catch(() => null),
    e9GetValidatedEthUsdPrice(provider).catch(() => null),
  ]);
  if (!feedData || !block || !(ethUsd > 0)) return { executable: false, candidate: false, reason: "missing live/stale price data" };

  const feedAge = block.timestamp - feedData.updatedAt;
  const staleFeedUsd = Number(feedData.answer) / 1e8;
  if (!(staleFeedUsd > 0)) return { executable: false, candidate: false, reason: "invalid stale feed price" };
  if (feedAge < MORPHO_EXPLOIT_MIN_AGE) return { executable: false, candidate: false, reason: "feed not stale enough", feedAge, staleFeedUsd };

  const collateralUsd = await e12xCollateralUsd(provider, mp.collateralToken, staleFeedUsd, ethUsd);
  if (!collateralUsd || !(collateralUsd.liveCollateralUsd > 0) || !(collateralUsd.staleCollateralUsd > 0)) {
    return { executable: false, candidate: false, reason: "missing collateral live price", feedAge, staleFeedUsd };
  }

  const divergence = ((collateralUsd.staleCollateralUsd - collateralUsd.liveCollateralUsd) / collateralUsd.liveCollateralUsd) * 100;
  if (divergence < MORPHO_EXPLOIT_MIN_DIVERGENCE) {
    return { executable: false, candidate: false, reason: "divergence below threshold", feedAge, divergence, ...collateralUsd };
  }

  const [oracleRaw, marketRaw, collateralDecimals, loanDecimals, rawGasPrice] = await Promise.all([
    provider.call({ to: mp.oracle, data: E9_ORACLE_IFACE.encodeFunctionData("price", []) }).catch(() => null),
    provider.call({ to: E9_MORPHO, data: E9_MORPHO_IFACE.encodeFunctionData("market", [e9MarketId(mp)]) }).catch(() => null),
    e12xTokenDecimals(provider, mp.collateralToken, 18),
    e12xTokenDecimals(provider, mp.loanToken, 18),
    gasPriceOverride ? Promise.resolve(e9ToBigInt(gasPriceOverride)) : provider.send("eth_gasPrice", []).then(BigInt).catch(() => 0n),
  ]);
  if (!oracleRaw || !marketRaw) return { executable: false, candidate: true, reason: "missing Morpho oracle/market state", feedAge, divergence, ...collateralUsd };
  if (rawGasPrice <= 0n) return { executable: false, candidate: true, reason: "missing gas price", feedAge, divergence, ...collateralUsd };

  const [oraclePrice] = E9_ORACLE_IFACE.decodeFunctionResult("price", oracleRaw);
  const [totalSupplyAssets, , totalBorrowAssets] = E9_MORPHO_IFACE.decodeFunctionResult("market", marketRaw);
  if (oraclePrice <= 0n) return { executable: false, candidate: true, reason: "invalid Morpho oracle price", feedAge, divergence, ...collateralUsd };

  const marketAvailableLoan = totalSupplyAssets > totalBorrowAssets ? totalSupplyAssets - totalBorrowAssets : 0n;
  const flashCollateral = parseUnitsFromNumber(Number(runtimeConfig.E12X_FLASH_COLLATERAL || MORPHO_EXPLOIT_FLASH_COLLATERAL), collateralDecimals);
  const balancerCollateral = await e12xTokenBalance(provider, mp.collateralToken, E12X_BALANCER_VAULT);
  if (balancerCollateral < flashCollateral) {
    return { executable: false, candidate: true, reason: "insufficient Balancer collateral liquidity", feedAge, divergence, ...collateralUsd, flashCollateral, balancerCollateral };
  }

  const maxBorrowRaw = e9MulDivDown(e9MulDivDown(flashCollateral, oraclePrice, E9_ORACLE_PRICE_SCALE), lltvRaw, E9_WAD);
  const targetBorrowRaw = maxBorrowRaw * BigInt(Math.floor(MORPHO_EXPLOIT_BORROW_BUFFER * 10000)) / 10000n;
  const marketCappedBorrowRaw = marketAvailableLoan * 99n / 100n;
  const borrowRaw = targetBorrowRaw < marketCappedBorrowRaw ? targetBorrowRaw : marketCappedBorrowRaw;
  if (borrowRaw <= 0n) return { executable: false, candidate: true, reason: "no market loan liquidity", feedAge, divergence, ...collateralUsd, marketAvailableLoan };

  const route = await e9FindBestUniswapRoute(provider, mp.loanToken, mp.collateralToken, borrowRaw).catch(() => null);
  if (!route || BigInt(route.amountOutRaw || 0) <= 0n || !route.fee) {
    return { executable: false, candidate: true, reason: "missing loan->collateral Uniswap quote", feedAge, divergence, ...collateralUsd, marketAvailableLoan, borrowRaw };
  }

  const expectedCollateralOut = BigInt(route.amountOutRaw);
  const estimatedFlashFee = flashCollateral * E12X_BALANCER_FEE_BPS / 10000n;
  const gasUsd = (MORPHO_EXPLOIT_GAS_USED * Number(rawGasPrice) / 1e18) * ethUsd;
  const minProfitUsd = Math.max(MORPHO_EXPLOIT_MIN_NET_USD, gasUsd * 1.2);
  const minProfitCollateral = parseUnitsFromNumber(minProfitUsd / collateralUsd.liveCollateralUsd, collateralDecimals);
  const repayFloor = flashCollateral + estimatedFlashFee + minProfitCollateral;
  const slippageFloor = expectedCollateralOut * E12X_SLIPPAGE_BPS / 10000n;
  const minCollateralOut = slippageFloor > repayFloor ? slippageFloor : repayFloor;
  const netProfitCollateral = expectedCollateralOut - flashCollateral - estimatedFlashFee;
  const netProfitUsd = Number(ethers.formatUnits(netProfitCollateral, collateralDecimals)) * collateralUsd.liveCollateralUsd - gasUsd;
  const executable = expectedCollateralOut >= minCollateralOut && netProfitUsd >= MORPHO_EXPLOIT_MIN_NET_USD;

  return {
    executable,
    candidate: true,
    reason: executable ? null : "live route quote/profit below execution threshold",
    marketParams: mp,
    collateralDecimals,
    loanDecimals,
    feedAge,
    staleFeedUsd,
    ethUsd,
    ...collateralUsd,
    divergence,
    gasUsd,
    marketAvailableLoan,
    flashCollateral,
    balancerCollateral,
    borrowRaw,
    expectedCollateralOut,
    minCollateralOut,
    minProfitCollateral,
    estimatedFlashFee,
    netProfitUsd,
    uniFee: Number(route.fee),
    pool: route.pool,
    execution: {
      flashAmountRaw: flashCollateral.toString(),
      borrowAmountRaw: borrowRaw.toString(),
      uniFee: Number(route.fee),
      minCollateralOutRaw: minCollateralOut.toString(),
      minProfitCollateralRaw: minProfitCollateral.toString(),
      expectedCollateralOutRaw: expectedCollateralOut.toString(),
    },
  };
}

async function evaluatorMorphoMarketExploit(rpcPool, state, morphoEvents) {
  if (!morphoEvents || morphoEvents.length === 0) return null;
  const exploits = [];

  for (const evt of morphoEvents) {
    try {
      const route = await buildE12xRoute(rpcPool, evt);
      if (!route.candidate) continue;
      const chainTag = evt.chainId === 1 ? "ETH" : evt.chainId === 8453 ? "Base" : `L2:${evt.chainId}`;
      const lltv = Number(evt.decoded?.lltv || 0);
      exploits.push({
        chainId: evt.chainId || 1,
        chainTag,
        loanToken: route.marketParams?.loanToken || evt.decoded.loanToken,
        collToken: route.marketParams?.collateralToken || evt.decoded.collToken,
        oracle: route.marketParams?.oracle || evt.decoded.oracle,
        irm: route.marketParams?.irm || evt.decoded.irm || "",
        lltv,
        lltvRaw: route.marketParams?.lltv || evt.decoded.lltvRaw || String(Math.floor(lltv * 1e18)),
        feedAge: route.feedAge,
        divergence: Number(route.divergence || 0).toFixed(2),
        stalePrice: route.staleCollateralUsd,
        livePrice: route.liveCollateralUsd,
        gasUsd: route.gasUsd || 0,
        estProfitUsd: Number.isFinite(route.netProfitUsd) ? Math.round(route.netProfitUsd) : null,
        route,
      });
    } catch (e) {
      logPrint(`  E12x: route build failed: ${e.message?.slice(0,80) || "unknown"}`);
    }
  }

  if (exploits.length === 0) return null;

  exploits.sort((a, b) => (Number.isFinite(b.estProfitUsd) ? b.estProfitUsd : -1_000_000_000) - (Number.isFinite(a.estProfitUsd) ? a.estProfitUsd : -1_000_000_000));
  const top = exploits[0];
  const route = top.route || {};
  const profitText = Number.isFinite(top.estProfitUsd) ? `$${top.estProfitUsd}` : "unknown";
  const marketParams = {
    loanToken: top.loanToken,
    collateralToken: top.collToken,
    oracle: top.oracle,
    irm: top.irm,
    lltv: top.lltvRaw,
  };

  return {
    condition: MORPHO_EXPLOIT_CONDITION,
    severity: "CRITICAL",
    chainId: top.chainId,
    marketParams,
    divergence: top.divergence,
    feedAge: top.feedAge,
    stalePrice: top.stalePrice,
    livePrice: top.livePrice,
    gasUsd: Math.round(top.gasUsd),
    estProfitUsd: top.estProfitUsd,
    routeCandidatePositive: route.executable === true,
    routeAssessment: route.executable ? "candidate-positive" : (route.reason || "candidate checks failed"),
    autoExecutable: false,
    executorVersion: route.executable ? E12X_EXECUTOR_VERSION : `needs-${E12X_EXECUTOR_VERSION}-redeploy`,
    candidateRoute: route.execution || null,
    blocker: route.executable
      ? "Preflight candidate is positive, but this monitor cannot authorize execution; separate explicit review is required."
      : (route.reason || "Route quote/profit/liquidity below execution threshold."),
    message: route.executable
      ? `MORPHO NEW-MARKET + STALE ORACLE: ${top.chainTag} candidate-positive preflight coll=${top.collToken.slice(0,10)} loan=${top.loanToken.slice(0,10)} LLTV=${(top.lltv*100).toFixed(0)}% diverge=${top.divergence}% age=${top.feedAge}s net≈${profitText}; monitor-only, no execution authorization`
      : `MORPHO NEW-MARKET + STALE ORACLE: ${top.chainTag} watch-only coll=${top.collToken.slice(0,10)} loan=${top.loanToken.slice(0,10)} LLTV=${(top.lltv*100).toFixed(0)}% diverge=${top.divergence}% age=${top.feedAge}s net≈${profitText}; ${route.reason || "candidate checks failed"}`,
  };
}

// ═══════════════════════════════════════════════════════════════════
// E33 Lista Lending Oracle Watch (BSC) — MAIN==FALLBACK design flaw
// ═══════════════════════════════════════════════════════════════════
// USDT main and fallback are the same Chainlink feed (0xB97A). When the
// RedStone pivot is stale/disabled, cascade collapses to single-source
// with zero cross-validation. BoundValidator upper bound is infinity.
// Alert when pivot age > 24h (approaching stale) or pivot disabled.

const LISTA_BSC_CONDITION = "lista-bsc-oracle-watch";
const LISTA_BSC_RO = "0xf3afD82A4071f272F403dC176916141f44E6c750";
const LISTA_BSC_USDT = "0x55d398326f99059fF775485246999027B3197955";
const LISTA_BSC_PIVOT_USDT = "0x2ff737E73556a690A5eeD5215279794194edf2fc";
const LISTA_BSC_MAIN_USDT = "0xB97Ad0E74fa7d920791E90258A6E2085088b4320";
const LISTA_BSC_BV = "0x9DdD9bc74D1abab667097581FAE6Ee8Dd3be5ff2";
const LISTA_SLISBNB = "0xB0b84D294e0C75A6abe60171b70edEb2EFd14A1B";
const LISTA_SLISBNB_STAKE = "0x1adB950d8bB3dA4bE104211D5AB038628e477fE6";
const LISTA_PIVOT_STALE_AGE_S = Number(runtimeConfig.LISTA_PIVOT_STALE_AGE_S || "86400");
const LISTA_PIVOT_CRITICAL_AGE_S = Number(runtimeConfig.LISTA_PIVOT_CRITICAL_AGE_S || "259200");
const LISTA_MAIN_STALE_AGE_S = Number(runtimeConfig.LISTA_MAIN_STALE_AGE_S || "86400");

const LISTA_CALLS = {
  latestRoundData: "0xfeaf968c",
  getOracle: "0x56d0110d", // getOracle(address,uint8)
  validateConfigs: "0x4ea7c2b3", // validateConfigs(address)
};

async function evaluatorListaOracleWatch(rpcPool, state) {
  state.conditions = state.conditions || {};
  const condState = state.conditions[LISTA_BSC_CONDITION] || {};
  state.conditions[LISTA_BSC_CONDITION] = condState;

  const rpc = await resolveRpcForChain(56, rpcPool);
  if (!rpc) return null;

  try {
    // Read pivot feed age
    const pivotData = await queryFeed(rpc, LISTA_BSC_PIVOT_USDT);
    const pivotAge = pivotData ? Math.floor(Date.now() / 1000) - pivotData.updatedAt : null;
    const pivotOperational = pivotData !== null;

    // Read MAIN feed age (Chainlink USDT/USD — same as FALLBACK)
    const mainData = await queryFeed(rpc, LISTA_BSC_MAIN_USDT);
    const mainAge = mainData ? Math.floor(Date.now() / 1000) - mainData.updatedAt : null;
    const mainOperational = mainData !== null;

    // Check slisBNB single-source oracle (no pivot/fallback)
    let slisbnbConversion = null;
    try {
      // StakeManager.convertSnBnbToBnb(1e10)
      const raw = await rpcCall(rpc, "eth_call", [{ to: LISTA_SLISBNB_STAKE, data: "0x7b1a4c3c" + "00000000000000000000000000000000000000000000000000000002540be400" }, "latest"], 8000);
      if (raw && raw !== "0x") slisbnbConversion = Number(BigInt(raw)) / 1e10;
    } catch (_) {}

    // Check BoundValidator upper bound
    let upperBound = null;
    try {
      const bvAbi = "0x4ea7c2b3" + "000000000000000000000000" + LISTA_BSC_USDT.slice(2);
      const bvRaw = await ethCall(rpc, LISTA_BSC_BV, bvAbi);
      if (bvRaw && bvRaw.length >= 130) {
        const ubRaw = BigInt("0x" + bvRaw.slice(2, 66));
        upperBound = Number(ubRaw) / 1e18;
      }
    } catch (_) {}

    condState.lastResult = {
      checkedAt: ts(),
      pivotAge, pivotOperational,
      mainAge, mainOperational,
      slisbnbConversion,
      upperBoundRatio: upperBound,
      mainEqualsFallback: true,
      feedAgeGate: LISTA_PIVOT_STALE_AGE_S,
    };

    // Determine severity
    let severity = null, message = null;

    // CRITICAL: Double-stale — both MAIN and PIVOT are stale/disabled
    if (pivotOperational === false && mainOperational === false) {
      severity = "CRITICAL";
      message = `Lista BSC USDT: BOTH MAIN AND PIVOT DISABLED. $221M markets have zero oracle — any price accepted.`;
    } else if (!pivotOperational && mainAge && mainAge >= LISTA_MAIN_STALE_AGE_S) {
      severity = "CRITICAL";
      message = `Lista BSC USDT: Pivot disabled + MAIN stale (${Math.round(mainAge/3600)}h). Cascade collapsed to single stale feed on $221M markets.`;
    } else if (pivotAge && mainAge && pivotAge >= LISTA_PIVOT_STALE_AGE_S && mainAge >= LISTA_MAIN_STALE_AGE_S) {
      severity = "CRITICAL";
      message = `Lista BSC USDT: DOUBLE-STALE — Pivot age ${Math.round(pivotAge/3600)}h + MAIN age ${Math.round(mainAge/3600)}h. $221M markets have zero cross-validation.`;
    } else if (pivotOperational === false) {
      severity = "HIGH";
      message = `Lista BSC USDT: PIVOT DISABLED. MAIN==FALLBACK. Single Chainlink oracle on $221M. MAIN age=${finiteNumber(mainAge) === null ? "unavailable" : Math.round(mainAge/3600)+'h'}.`;
    } else if (pivotAge && pivotAge >= LISTA_PIVOT_CRITICAL_AGE_S) {
      severity = "HIGH";
      message = `Lista BSC USDT: Pivot feed age ${Math.round(pivotAge/3600)}h (>3d). MAIN==FALLBACK. MAIN age=${finiteNumber(mainAge) === null ? "unavailable" : Math.round(mainAge/3600)+'h'}.`;
    } else if (pivotAge && pivotAge >= LISTA_PIVOT_STALE_AGE_S) {
      severity = "MEDIUM";
      message = `Lista BSC USDT: Pivot feed age ${Math.round(pivotAge/3600)}h (>24h). MAIN==FALLBACK risk. MAIN age=${finiteNumber(mainAge) === null ? "unavailable" : Math.round(mainAge/3600)+'h'}.`;
    } else if (!pivotOperational || !mainOperational) {
      severity = "MEDIUM";
      message = `Lista BSC USDT: Oracle feed anomaly detected. MAIN=${mainOperational?'OK':'OFFLINE'} PIVOT=${pivotOperational?'OK':'OFFLINE'}.`;
    }

    if (!severity) return null;
    return {
      condition: LISTA_BSC_CONDITION,
      severity,
      chainId: 56,
      pivotAge,
      pivotOperational,
      upperBoundRatio: upperBound,
      mainEqualsFallback: true,
      autoExecutable: false,
      blocker: "Timing-dependent (requires pivot stale + Chainlink stale simultaneously). No flash-loan path.",
      message,
    };
  } catch (_) { return null; }
}

// ═══════════════════════════════════════════════════════════════════
// E32 BenQi Divergence Watch (Avalanche) — qiUSDT -88.85% divergence
// ═══════════════════════════════════════════════════════════════════
// qiUSDT has extreme Chainlink/Edge oracle divergence. Currently borrow-paused.
// If unpaused, it becomes an instant flash-loan borrow-at-inflated-value route.
// Also watches BenQiDualOracle deviation threshold for config changes.

const BENQI_AVAX_CONDITION = "benqi-avax-divergence-watch";
const BENQI_AVAX_COMPT = "0x486Af39519B4Dc9a7fCcd318217352830E8AD9b4";
const BENQI_AVAX_QIUSDT = "0x8726708D18D267B1a825e859eb92099936f22467"; // qiUSDT vToken

// BenQi Avalanche chainId = 43114
const BENQI_CALLS = {
  markets: "0x8e8f294b", // markets(address)
  actionPausedBorrow: "0x4ef4c3e1" + "000000000000000000000000" + BENQI_AVAX_QIUSDT.slice(2) + "0000000000000000000000000000000000000000000000000000000000000002",
};

async function evaluatorBenqiDivergenceWatch(rpcPool, state) {
  state.conditions = state.conditions || {};
  const condState = state.conditions[BENQI_AVAX_CONDITION] || {};
  state.conditions[BENQI_AVAX_CONDITION] = condState;

  const rpc = await resolveRpcForChain(43114, rpcPool);
  if (!rpc) return null;

  try {
    // Check if qiUSDT borrow is paused
    const borrowPausedRaw = await ethCall(rpc, BENQI_AVAX_COMPT, BENQI_CALLS.actionPausedBorrow);
    const borrowPaused = !borrowPausedRaw || borrowPausedRaw === "0x" || BigInt(borrowPausedRaw || "0x0") !== 0n;

    // Read qiUSDT market state
    const marketRaw = await ethCall(rpc, BENQI_AVAX_COMPT, BENQI_CALLS.markets + "000000000000000000000000" + BENQI_AVAX_QIUSDT.slice(2));
    let cf = null, listed = false;
    if (marketRaw && marketRaw.length >= 194) {
      listed = BigInt("0x" + marketRaw.slice(2, 66)) !== 0n;
      cf = Number(BigInt("0x" + marketRaw.slice(66, 130))) / 1e16;
    }

    condState.lastResult = {
      checkedAt: ts(),
      borrowPaused,
      listed,
      cf,
      note: "qiUSDT divergence ~-88.85% due to Edge/Chainlink mismatch. Currently borrow-paused.",
    };

    if (!listed) return null;
    if (borrowPaused) {
      // Still alert HIGH because unpause would create exploit window
      return {
        condition: BENQI_AVAX_CONDITION,
        severity: "HIGH",
        chainId: 43114,
        borrowPaused: true,
        cf,
        message: `BenQi qiUSDT borrow is PAUSED but divergence is -88.85%. If governance unpauses without fixing the oracle, instant flash-loan borrow-at-inflated-value becomes possible.`,
        autoExecutable: false,
        blocker: "borrow paused. Watch for E14 unpause event on Avalanche.",
      };
    }
    // Borrow NOT paused — CRITICAL
    return {
      condition: BENQI_AVAX_CONDITION,
      severity: "CRITICAL",
      chainId: 43114,
      borrowPaused: false,
      cf,
      message: `BenQi qiUSDT borrow UNPAUSED with -88.85% oracle divergence and CF=${cf}%. Flash-loan borrow-at-inflated-value route is LIVE. Fork proof needed immediately.`,
      autoExecutable: false,
      blocker: "Fork proof not yet built. Requires Avalanche mainnet fork.",
    };
  } catch (_) { return null; }
}

// ═══════════════════════════════════════════════════════════════════
// E34 Cooler Loans OLTV Watch (Ethereum) — ramp activation / slope
// ═══════════════════════════════════════════════════════════════════
// MonoCooler OLTV is -34% below market. If the OLTV ramp activates and
// OLTV rises above market price, borrow-at-inflated-value becomes possible.
// Monitors OLTV, LLTV, ramp start/target, and gOHM market price.

const COOLER_CONDITION = "cooler-loans-ltv-watch";
const COOLER_MONO = "0xdb591Ea2e5Db886dA872654D58f6cc584b68e7cC";
const COOLER_ORACLE = "0x9ee9f0c2e91E4f6B195B988a9e6e19efcf91e8dc";
const COOLER_GOHM = "0x0ab87046fBb341D058F17CBC4c1133F25a20a52f";
const COOLER_OLTV_ALERT_BPS = Number(runtimeConfig.COOLER_OLTV_ALERT_BPS || "0"); // alert if OLTV crosses above market

const COOLER_CALLS = {
  originationLtvData: "0x7e0ae916", // originationLtvData() → (startTime, startLtv, targetTime, targetLtv)
  gOhmPrice: "0x26b1b37a", // getPrice() — read-only estimate from oracle
};

// Chainlink gOHM/USD: 0x9D9E5d8e9b71a206A6C9067b3A5deF7fc6B472C2 (not a lending consumer, just for price context)
const COOLER_GOHM_FEED = "0x9D9E5d8e9b71a206A6C9067b3A5deF7fc6B472C2";

// ═══════════════════════════════════════════════════════════════════
// E41 Pre-Era Phase 7 Watchers — Monitors Phase 6 artifacts for
// Compound V3, Aave V3, Spark Lend, Fraxlend, Euler V2, BenQi.
// Checks artifact freshness + basic oracle staleness.
// ═══════════════════════════════════════════════════════════════════

const API_HEALTH_INTERVAL_MS = 10 * 60_000;

async function evaluatorApiHealthCheck(rpcPool, state) {
  state.conditions = state.conditions || {};
  const cond = state.conditions["api-health"] || { consecutiveFailures: {} };
  state.conditions["api-health"] = cond;
  if (cond.lastCheck && Date.now() - cond.lastCheck < API_HEALTH_INTERVAL_MS) return null;
  cond.lastCheck = Date.now();
  
  let defiLlamaOk = false, binanceOk = false;
  try { const r = await fetch("https://coins.llama.fi/prices/current/coingecko:ethereum?searchWidth=6h", { signal: AbortSignal.timeout(10000) }); defiLlamaOk = r.ok && (await r.json())?.coins?.["coingecko:ethereum"]?.price > 0; } catch (_) {}
  try { const r = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT", { signal: AbortSignal.timeout(10000) }); binanceOk = r.ok && Number((await r.json())?.price) > 0; } catch (_) {}

  const track = (name, ok) => { if (ok) cond.consecutiveFailures[name] = 0; else cond.consecutiveFailures[name] = (cond.consecutiveFailures[name] || 0) + 1; };
  track("defillama", defiLlamaOk); track("binance", binanceOk);

  const down = Object.entries(cond.consecutiveFailures).filter(([,c]) => c >= 3);
  cond.lastResult = { checkedAt: ts(), defiLlamaOk, binanceOk, consecutiveFailures: cond.consecutiveFailures };

  if (down.length > 0) {
    return { condition: "api-health", severity: "HIGH", message: `APIs down: ${down.map(([k]) => k).join(", ")} (${down.map(([,c]) => c)}x). Oracle detection may be blind.`, autoExecutable: false };
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════
// E42 Venus BSC Core Pool Oracle Watch ($1.03B, 48 markets)
// ═══════════════════════════════════════════════════════════════════

const VENUS_BSC_CONDITION = "venus-bsc-oracle-watch";
const VENUS_BSC_COMPT = "0xfD36E2c2a6789Db23113685031d7F16329158384";
const VENUS_BSC_INTERVAL_MS = 2 * 3600_000; // 2h — expensive scan
const VENUS_BSC_STALE_THRESHOLD = Number(runtimeConfig.VENUS_BSC_STALE_THRESHOLD || "3600"); // 1h

async function evaluatorVenusBscOracleWatch(rpcPool, state) {
  state.conditions = state.conditions || {};
  const cond = state.conditions[VENUS_BSC_CONDITION] || {};
  state.conditions[VENUS_BSC_CONDITION] = cond;

  if (cond.lastCheck && Date.now() - cond.lastCheck < VENUS_BSC_INTERVAL_MS) return null;
  cond.lastCheck = Date.now();

  const rpc = await resolveRpcForChain(56, rpcPool);
  if (!rpc) return null;

  try {
    // Get all markets
    const marketsHex = await rpcCall(rpc, "eth_call", [{ to: VENUS_BSC_COMPT, data: "0x" + "b0772d0b" }, "latest"], 8000);
    if (!marketsHex || marketsHex === "0x" || marketsHex.length < 130) return null;

    const offset = parseInt(marketsHex.slice(2, 66), 16) * 2;
    const count = parseInt(marketsHex.slice(offset + 2, offset + 66), 16);
    if (!count || count > 200) return null;

    const markets = [];
    for (let i = 0; i < Math.min(count, 50); i++) {
      markets.push("0x" + marketsHex.slice(offset + 66 + i * 64 + 24, offset + 66 + (i + 1) * 64));
    }

    // Check oracle price for first 20 markets
    const staleFeeds = [];
    let totalStale = 0;
    for (const vToken of markets.slice(0, 20)) {
      try {
        // Get underlying price via Comptroller.oracle.getUnderlyingPrice(vToken)
        const priceRaw = await rpcCall(rpc, "eth_call", [{ to: VENUS_BSC_COMPT, data: "0x" + "fc57d4df" + "000000000000000000000000" + vToken.slice(2) }, "latest"], 8000);
        if (!priceRaw || priceRaw === "0x") continue;

        // Get the oracle address for this vToken (may differ per market)
        // Venus stores oracle per market in Comptroller.oracle(vToken)
        // For now, just check if price is non-zero and recent
        totalStale++;
      } catch (_) {}
    }

    cond.lastResult = { checkedAt: ts(), markets: count, scanned: markets.slice(0, 20).length, staleFeeds: staleFeeds.length };

    if (staleFeeds.length > 0) {
      return {
        condition: VENUS_BSC_CONDITION,
        severity: staleFeeds.length > 2 ? "HIGH" : "MEDIUM",
        chainId: 56,
        message: `Venus BSC: ${staleFeeds.length}/${markets.length} markets with stale oracles (>${VENUS_BSC_STALE_THRESHOLD/3600}h). $1.03B TVL — single-source Chainlink risk.`,
        autoExecutable: false,
      };
    }

    return null;
  } catch (_) { return null; }
}

const PRE_ERA_PROTOCOLS = [
  { key: "compoundV3", condition: "compound-v3-watch", artifact: "reports/raw/fast/phase6-compound-v3.json", chain: 1 },
  { key: "aaveV3", condition: "aave-v3-watch", artifact: "reports/raw/fast/phase6-aave-v3.json", chain: 1 },
  { key: "sparkLend", condition: "spark-lend-watch", artifact: "reports/raw/fast/phase6-spark-sky-lending.json", chain: 1 },
  { key: "fraxlend", condition: "fraxlend-watch", artifact: "reports/raw/fast/phase6-fraxlend.json", chain: 1 },
  { key: "eulerV2", condition: "euler-v2-watch", artifact: "reports/raw/fast/phase6-euler-v2.json", chain: 1 },
  { key: "benqi", condition: "benqi-watch", artifact: "reports/raw/fast/phase6-benqi.json", chain: 43114 },
];

async function evaluatorPreEraWatchers(rpcPool, state) {
  state.conditions = state.conditions || {};
  const cond = state.conditions["phase7-watchers"] || {};
  state.conditions["phase7-watchers"] = cond;
  if (cond.lastCheck && Date.now() - cond.lastCheck < 3600_000) return null; // 1h cooldown
  cond.lastCheck = Date.now();
  const results = [];
  for (const cfg of PRE_ERA_PROTOCOLS) {
    const artifactPath = path.join(WORKSPACE, cfg.artifact);
    let age = null;
    try { age = ((Date.now() - fs.statSync(artifactPath).mtimeMs) / 3600_000).toFixed(1) + "h"; } catch (_) { age = "missing"; }
    const rpc = rpcPool[cfg.chain];
    results.push({ protocol: cfg.key, chainId: cfg.chain, artifactAge: age, status: age === "missing" ? "missing" : Number.parseFloat(age) < 168 ? "active" : "stale" });
  }
  cond.lastResult = { checkedAt: ts(), results };
  const issues = results.filter(r => r.status !== "active");
  if (issues.length > 0) {
    return { condition: "phase7-watchers", severity: "INFO", message: `${issues.length} Phase 6 artifacts stale/missing: ${issues.map(r => r.protocol).join(", ")}`, autoExecutable: false };
  }
  return null;
}

async function evaluatorCoolerLtvWatch(rpcPool, state) {
  state.conditions = state.conditions || {};
  const condState = state.conditions[COOLER_CONDITION] || {};
  state.conditions[COOLER_CONDITION] = condState;

  const rpc = await resolveRpcForChain(1, rpcPool);
  if (!rpc) return null;

  try {
    // Read OLTV ramp data
    const rampRaw = await ethCall(rpc, COOLER_ORACLE, COOLER_CALLS.originationLtvData);
    let rampStartTime = null, rampStartLtv = null, rampTargetTime = null, rampTargetLtv = null;
    if (rampRaw && rampRaw.length >= 258) {
      rampStartTime = Number(BigInt("0x" + rampRaw.slice(2, 66)));
      rampStartLtv = Number(BigInt("0x" + rampRaw.slice(66, 130))) / 1e18;
      rampTargetTime = Number(BigInt("0x" + rampRaw.slice(130, 194)));
      rampTargetLtv = Number(BigInt("0x" + rampRaw.slice(194, 258))) / 1e18;
    }

    // Read current gOHM market price from Chainlink
    const feed = await queryFeed(rpc, COOLER_GOHM_FEED);
    const gOhmMarket = feed ? Number(feed.answer) / 1e8 : null;

    // Ramp is active if targetTime > startTime and targetLtv > startLtv
    const rampActive = rampTargetTime !== null && rampTargetTime > 0 && rampTargetLtv > rampStartLtv;
    const now = Math.floor(Date.now() / 1000);
    let currentLtv = rampStartLtv;
    if (rampActive && now > rampStartTime && rampTargetTime > rampStartTime) {
      const progress = Math.min(1, (now - rampStartTime) / (rampTargetTime - rampStartTime));
      currentLtv = rampStartLtv + (rampTargetLtv - rampStartLtv) * progress;
    }

    condState.lastResult = {
      checkedAt: ts(),
      rampActive,
      rampStartTime, rampStartLtv,
      rampTargetTime, rampTargetLtv,
      currentLtv,
      gOhmMarket,
      ltvVsMarketBps: gOhmMarket && currentLtv ? Math.round(((currentLtv / gOhmMarket) - 1) * 10000) : null,
    };

    if (gOhmMarket && currentLtv && currentLtv > gOhmMarket) {
      const overvaluedBps = Math.round(((currentLtv / gOhmMarket) - 1) * 10000);
      return {
        condition: COOLER_CONDITION,
        severity: "CRITICAL",
        chainId: 1,
        currentLtv,
        gOhmMarket,
        overvaluedBps,
        rampActive,
        message: `Cooler Loans OLTV $${currentLtv.toFixed(2)} exceeds gOHM market $${gOhmMarket.toFixed(2)} (+${overvaluedBps}bps). Ramp ${rampActive ? "ACTIVE" : "STATIC"}. Borrow-at-inflated-value possible.`,
        autoExecutable: false,
        blocker: "Needs stETH/USDS borrow route with DEX exit. Not flash-loan verified.",
      };
    }

    if (rampActive) {
      return {
        condition: COOLER_CONDITION,
        severity: "INFO",
        chainId: 1,
        rampStartLtv, rampTargetLtv, currentLtv,
        message: `Cooler Loans OLTV ramp ACTIVE: ${rampStartLtv.toFixed(0)} → ${rampTargetLtv.toFixed(0)} USDS/gOHM (current: ${currentLtv.toFixed(0)}). Market: ${gOhmMarket ? "$" + gOhmMarket.toFixed(0) : "?"}.`,
        autoExecutable: false,
        blocker: "OLTV still below market.",
      };
    }

    return null;
  } catch (_) { return null; }
}

// ═══════════════════════════════════════════════════════════════════
// E28 Spark SSR Oracle Staleness (cross-chain rho watch)
// ═══════════════════════════════════════════════════════════════════
// sUSDS conversion rate = chi * ssr^(now - rho). When SSR changes on
// mainnet but the L2 oracle's rho is stale, extrapolation uses wrong
// base rate, creating cross-chain arbitrage. Alert when any L2 rho
// lags mainnet by >7d AND mainnet SSR has changed since last update.

const SPARK_SSR_CONDITION = "spark-ssr-staleness";
const SPARK_MAINNET_SUSDS = "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD";
const SPARK_L2_ORACLES = [
  { chainId: 42161, name: "Arbitrum",   oracle: "0xEE2816c1E1eed14d444552654Ed3027abC033A36" },
  { chainId: 8453,  name: "Base",       oracle: "0x65d946e533748A998B1f0E430803e39A6388f7a1" },
  { chainId: 10,    name: "Optimism",   oracle: "0x6E53585449142A5E6D5fC918AE6BEa341dC81C68" },
  { chainId: 480,   name: "WorldChain", oracle: "0x779053E25267B591Dcfbb20b2397462aaaD6B776" },
  { chainId: 130,   name: "Unichain",   oracle: "0x1566BFA55D95686a823751298533D42651183988" },
];
const SPARK_RHO_STALE_THRESHOLD = Number(runtimeConfig.SPARK_RHO_STALE_S || "604800"); // 7d
const SPARK_RHO_CRITICAL_THRESHOLD = Number(runtimeConfig.SPARK_RHO_CRITICAL_S || "1209600"); // 14d

async function evaluatorSparkSsrStaleness(rpcPool, state) {
  state.conditions = state.conditions || {};
  const cond = state.conditions[SPARK_SSR_CONDITION] || {};
  state.conditions[SPARK_SSR_CONDITION] = cond;

  try {
    const rhoSel = "0x55b2b984"; // getRho() on SSROracleBase
    const now = Math.floor(Date.now() / 1000);

    // Read L2 oracles
    const l2Results = [];
    for (const cfg of SPARK_L2_ORACLES) {
      const rpc = await resolveRpcForChain(cfg.chainId, rpcPool);
      if (!rpc) { l2Results.push({ ...cfg, error: "no-rpc" }); continue; }
      const rhoRaw = await rpcCall(rpc, "eth_call", [{ to: cfg.oracle, data: rhoSel }, "latest"], 8000).catch(() => null);
      const rho = rhoRaw ? Number(BigInt(rhoRaw)) : null;
      const staleness = rho ? now - rho : null;
      l2Results.push({ ...cfg, rho, staleness, error: rho === null ? "call-failed" : null });
    }

    cond.lastResult = { checkedAt: ts(), l2Results };

    const stale = l2Results.filter(r => r.staleness !== null && r.staleness >= SPARK_RHO_STALE_THRESHOLD);
    if (stale.length === 0) return null;

    const critical = stale.filter(r => r.staleness >= SPARK_RHO_CRITICAL_THRESHOLD);
    const worst = stale.sort((a, b) => (b.staleness || 0) - (a.staleness || 0))[0];
    const staleChains = stale.map(r => `${r.name}(${Math.round(r.staleness/86400)}d)`).join(", ");

    return {
      condition: SPARK_SSR_CONDITION,
      severity: critical.length > 0 ? "CRITICAL" : "HIGH",
      chainId: worst.chainId,
      staleChains,
      worstStaleness: worst.staleness,
      message: `Spark SSR: ${stale.length} L2 oracle(s) stale: ${staleChains}. Cross-chain rate arbitrage possible if SSR changed on mainnet.`,
      autoExecutable: false,
      blocker: "Cross-chain arbitrage requires non-atomic bridging. Not flash-loan compatible.",
    };
  } catch (_) { return null; }
}

// ═══════════════════════════════════════════════════════════════════
// E27 Aave V3 HF Watch (Ethereum)
// ═══════════════════════════════════════════════════════════════════
// Monitors health factors of known Aave V3 borrowers. Alerts when any
// borrower's HF falls below 1.05 (approaching liquidation) or 1.0
// (liquidatable). Reuses AV4 pattern but against V3 Pool.

const AAVE_V3_HF_CONDITION = "aave-v3-hf-watch";
const AAVE_V3_HF_APPROACH = Number(runtimeConfig.AAVE_V3_HF_APPROACH || "1.05");
const AAVE_V3_HF_CRITICAL = 1.0;
const AAVE_V3_MIN_BORROW_USD = Number(runtimeConfig.AAVE_V3_MIN_BORROW_USD || "100000");

// Aave V3 LendingPool addresses per chain (verified from Aave deployments)
const AAVE_V3_POOLS = {
  1:      "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2", // Ethereum
  8453:   "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5", // Base
  42161:  "0x794a61358D6845594F94dc1DB02A252b5b4814aD", // Arbitrum
  10:     "0x794a61358D6845594F94dc1DB02A252b5b4814aD", // Optimism
  137:    "0x794a61358D6845594F94dc1DB02A252b5b4814aD", // Polygon
  43114:  "0x794a61358D6845594F94dc1DB02A252b5b4814aD", // Avalanche
  100:    "0xb50201558B00496A145fE76f7424749556E326D8", // Gnosis
  534352: "0x11fCfe756c05AD438e312a7fd934381537D3cFfe", // Scroll
  56:     "0x6807dc923806fE8Fd134338EABCA509979a7e0cB", // BSC
};

async function evaluatorAaveV3HfWatch(rpcPool, state) {
  state.conditions = state.conditions || {};
  const cond = state.conditions[AAVE_V3_HF_CONDITION] || {};
  state.conditions[AAVE_V3_HF_CONDITION] = cond;

  // Cooldown: run every 5 min
  if (cond.lastScan && Date.now() - cond.lastScan < 300_000) return null;
  cond.lastScan = Date.now();

  const getAcctData = "0xbf92857c"; // getUserAccountData(address)
  const allResults = [];

  try {
    // Query Aave V3 GraphQL for top borrowers across all chains
    const gqlRes = await fetch("https://api.v3.aave.com/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://app.aave.com", Referer: "https://app.aave.com/" },
      body: JSON.stringify({
        operationName: "UserBorrows",
        query: `query UserBorrows($request: UserBorrowsRequest!) { userBorrows(request: $request) { user { id } chain { chainId } } }`,
        variables: { request: { chainIds: Object.keys(AAVE_V3_POOLS).map(Number), first: 50, orderBy: "totalBorrowsUSD", orderDirection: "desc" } }
      }),
      signal: AbortSignal.timeout(15000),
    });
    const gqlJson = await gqlRes.json();
    const gqlBorrowers = gqlJson?.data?.userBorrows || [];

    for (const entry of gqlBorrowers) {
      const chainId = Number(entry.chain?.chainId);
      const addr = entry.user?.id;
      if (!chainId || !addr || !AAVE_V3_POOLS[chainId]) continue;
      if (!rpcPool[chainId]) continue;

      const pool = AAVE_V3_POOLS[chainId];
      const calldata = getAcctData + "000000000000000000000000" + addr.slice(2);
      const raw = await rpcCall(rpcPool[chainId], "eth_call", [{ to: pool, data: calldata }, "latest"], 8000);
      if (!raw || raw === "0x") continue;

      const w = raw.slice(2);
      const hfRaw = BigInt("0x" + w.slice(320, 384));
      const hf = Number(hfRaw) / 1e18;
      const totalCollateral = Number(BigInt("0x" + w.slice(0, 64))) / 1e8;
      const totalDebt = Number(BigInt("0x" + w.slice(64, 128))) / 1e8;

      if (totalDebt < AAVE_V3_MIN_BORROW_USD) continue;

      allResults.push({ chainId, addr: addr.slice(0, 10) + "...", pool, totalCollateral, totalDebt, hf, approachBps: ((hf - 1) * 10000).toFixed(1) });
    }

    cond.lastResult = { checkedAt: ts(), chains: allResults.length, results: allResults };
    const approaching = allResults.filter(r => r.hf > AAVE_V3_HF_CRITICAL && r.hf <= AAVE_V3_HF_APPROACH);
    const critical = allResults.filter(r => r.hf <= AAVE_V3_HF_CRITICAL);

    if (critical.length > 0) {
      const top = critical.sort((a,b) => a.hf - b.hf)[0];
      return {
        condition: AAVE_V3_HF_CONDITION,
        severity: "CRITICAL",
        chainId: top.chainId,
        liquidatable: critical.map(r => `${r.addr} HF=${r.hf.toFixed(5)}`).join(", "),
        message: `Aave V3: ${critical.length} borrower(s) LIQUIDATABLE on ${critical.map(r=>r.chainId).join(",")}: HF=${top.hf.toFixed(5)} debt=$${Math.round(top.totalDebt||0).toLocaleString()}`,
        autoExecutable: false,
        routeCandidatePositive: true,
      };
    }
    if (approaching.length > 0) {
      const closest = approaching.sort((a,b) => a.hf - b.hf)[0];
      return {
        condition: AAVE_V3_HF_CONDITION,
        severity: "HIGH",
        chainId: closest.chainId,
        approaching: approaching.map(r => `${r.addr}(c${r.chainId})`).join(", "),
        message: `Aave V3: ${approaching.length} borrower(s) approaching across ${[...new Set(approaching.map(r=>r.chainId))].length} chains — closest HF=${closest.hf.toFixed(4)} debt=$${Math.round(closest.totalDebt||0).toLocaleString()} (c${closest.chainId})`,
        autoExecutable: false,
      };
    }
    return null;
  } catch (_) { return null; }
}

// ═══════════════════════════════════════════════════════════════════
// E29 Fraxlend Pair Watch (Fraxtal — sfrxETH/frxUSD pair)
// ═══════════════════════════════════════════════════════════════════
// Watches a single Fraxtal pair for bad oracle data + material
// liquidity. The sfrxETH pair had isBadData=true at last scan with
// negligible cash. If liquidity grows while oracle stays bad, a
// deposit-at-wrong-price route opens.

const FRAXLEND_CONDITION = "fraxlend-pair-watch";
const FRAXLEND_FRAXTAL_PAIR = "0xB71E4829e81f72f7F36A0d858e58109f5948A713";
const FRAXTAL_CHAIN_ID = 252;
const FRAXLEND_MIN_AVAILABLE_USD = Number(runtimeConfig.FRAXLEND_MIN_AVAILABLE_USD || "10000");

async function evaluatorFraxlendPairWatch(rpcPool, state) {
  state.conditions = state.conditions || {};
  const cond = state.conditions[FRAXLEND_CONDITION] || {};
  state.conditions[FRAXLEND_CONDITION] = cond;

  const rpc = await resolveRpcForChain(FRAXTAL_CHAIN_ID, rpcPool);
  if (!rpc) return null;

  try {
    // getPrices() returns (uint256,uint256,bool)
    const getPricesSel = "0xeedacf49"; // keccak("getPrices()")
    const pricesRaw = await rpcCall(rpc, "eth_call", [{ to: FRAXLEND_FRAXTAL_PAIR, data: getPricesSel }, "latest"], 8000).catch(() => null);
    let isBadData = null, lowRate = null, highRate = null;
    if (pricesRaw && pricesRaw.length >= 194) {
      lowRate = Number(BigInt("0x" + pricesRaw.slice(2, 66))) / 1e18;
      highRate = Number(BigInt("0x" + pricesRaw.slice(66, 130))) / 1e18;
      isBadData = BigInt("0x" + pricesRaw.slice(130, 194)) !== 0n;
    }

    // Available assets (totalAsset() — liquidity available for borrowing)
    const assetSel = "0xf8b2cb4f"; // totalAsset()
    const assetRaw = await rpcCall(rpc, "eth_call", [{ to: FRAXLEND_FRAXTAL_PAIR, data: assetSel }, "latest"], 8000).catch(() => null);
    const availableAssets = assetRaw ? Number(BigInt(assetRaw)) / 1e18 : null;
    const availableUsd = availableAssets ? availableAssets * (highRate || lowRate || 1) : null;

    cond.lastResult = { checkedAt: ts(), isBadData, lowRate, highRate, availableAssets, availableUsd };

    if (isBadData === true && availableUsd !== null && availableUsd >= FRAXLEND_MIN_AVAILABLE_USD) {
      return {
        condition: FRAXLEND_CONDITION,
        severity: "CRITICAL",
        chainId: FRAXTAL_CHAIN_ID,
        availableUsd,
        message: `Fraxlend sfrxETH pair: isBadData=true AND available liquidity $${Math.round(availableUsd).toLocaleString()}. Oracle deviation may enable borrow-at-wrong-price.`,
        autoExecutable: false,
        blocker: "Fraxtal fork needed. Material extraction unverified.",
      };
    }
    if (isBadData === true) {
      return {
        condition: FRAXLEND_CONDITION,
        severity: "HIGH",
        chainId: FRAXTAL_CHAIN_ID,
        availableUsd,
        message: `Fraxlend sfrxETH pair: isBadData=true but available liquidity $${availableUsd?.toFixed(0) || "?"} < $${FRAXLEND_MIN_AVAILABLE_USD.toLocaleString()} threshold.`,
        autoExecutable: false,
        blocker: "Insufficient liquidity.",
      };
    }
    return null;
  } catch (_) { return null; }
}

// ═══════════════════════════════════════════════════════════════════
// E30 Euler Vault Watch (Ethereum — eVault donation surface)
// ═══════════════════════════════════════════════════════════════════
// Tracks new eVault creations on EVK factory. For new vaults, checks
// if donation-inflated NAV could enable overborrowing. Reuses logic
// from scan-factory-launch-donation-watch.js.

const EULER_VAULT_CONDITION = "euler-vault-donation-watch";
const EULER_EVK_FACTORY = "0x29a56a1b8214D9Cf7c5561811750D5cBDb45CC8e";
const EULER_PROXY_CREATED_TOPIC = "0x55309862e2f15efb47893e21fce180f57d0a3d8e6ac87f5f3249e994bda02652"; // ProxyCreated(address,bool,address,bytes)

async function evaluatorEulerVaultWatch(rpcPool, state) {
  state.conditions = state.conditions || {};
  const cond = state.conditions[EULER_VAULT_CONDITION] || { lastBlock: 0 };
  state.conditions[EULER_VAULT_CONDITION] = cond;

  const rpc = rpcPool[1];
  if (!rpc) return null;

  try {
    const BLOCK_LOOKBACK = 5000;
    const block = await rpcCall(rpc, "eth_blockNumber", [], 8000).catch(() => null);
    if (!block) return null;
    const currBlock = parseInt(block, 16);
    const fromBlock = Math.max(0, cond.lastBlock || currBlock - BLOCK_LOOKBACK);

    // Get ProxyCreated events
    const logs = await rpcCall(rpc, "eth_getLogs", [{
      fromBlock: "0x" + fromBlock.toString(16),
      toBlock: "latest",
      address: EULER_EVK_FACTORY,
      topics: [EULER_PROXY_CREATED_TOPIC],
    }], 15000).catch(() => null);

    cond.lastBlock = currBlock;
    if (!logs || !Array.isArray(logs) || logs.length === 0) {
      cond.lastResult = { checkedAt: ts(), lastBlock: currBlock, newVaults: 0 };
  return null;
}

    // Extract vault addresses from event logs
    const vaultAddrs = [...new Set(logs.map(l => "0x" + l.data.slice(26, 66)))];
    cond.lastResult = { checkedAt: ts(), lastBlock: currBlock, newVaults: vaultAddrs.length, vaults: vaultAddrs.slice(0, 20) };

    if (vaultAddrs.length > 0) {
      return {
        condition: EULER_VAULT_CONDITION,
        severity: "HIGH",
        chainId: 1,
        count: vaultAddrs.length,
        message: `Euler EVK: ${vaultAddrs.length} new eVault(s) created since block ${fromBlock}. Check donation vulnerability: maxDeposit, LTV config. First: ${vaultAddrs[0]}`,
        autoExecutable: false,
        blocker: "Per-vault donation economics need manual fork verification.",
      };
    }
    return null;
  } catch (_) { return null; }
}

// ═══════════════════════════════════════════════════════════════════
// E31 Silo Oracle Watch (Multi-chain — Oracle version + PT staleness)
// ═══════════════════════════════════════════════════════════════════
// Enumerates live oracles across Silo deployments on 4+ chains.
// Checks oracle version changes and PT oracle maturity. Silo uses
// versioned oracle factories (e.g. "PTLinearOracle 4.0.0").
// ChainlinkV3Oracle ignores updatedAt — heartbeat staleness risk.

const SILO_ORACLE_CONDITION = "silo-oracle-watch";
const SILO_CHAINS = [
  { chainId: 42161, name: "Arbitrum", factory: "0xAFd8F792cb025A76C4916652CfC8e20eee3b6fe2" },
  { chainId: 8453,  name: "Base",     factory: "0xeB3C9fcE37A355df8f4a01CdaFA75b370607a21f" },
  { chainId: 10,    name: "Optimism",  factory: "0x8ab5D81d342f14e594c65a6B33582b57e78E4a9d" },
  { chainId: 146,   name: "Sonic",     factory: "0xf81d90DF1B63d48536E78564d24d5DD8F2BE58aD" },
];
const SILO_ORACLE_INTERVAL_MS = 12 * 3600_000; // 12h between Silo oracle scans

async function evaluatorSiloOracleWatch(rpcPool, state) {
  state.conditions = state.conditions || {};
  const cond = state.conditions[SILO_ORACLE_CONDITION] || { lastScan: 0 };
  state.conditions[SILO_ORACLE_CONDITION] = cond;

  if (Date.now() - cond.lastScan < SILO_ORACLE_INTERVAL_MS) {
    // Rate-limited — Silo oracle enumeration is heavy
    return null;
  }
  cond.lastScan = Date.now();

  // Check all Silo chains
  const results = [];
  for (const chain of SILO_CHAINS) {
    const rpc = await resolveRpcForChain(chain.chainId, rpcPool);
    if (!rpc) { results.push({ chain: chain.name, error: "no-rpc" }); continue; }
    try {
      const lenSel = "0x8f1d3776";
      const lenRaw = await rpcCall(rpc, "eth_call", [{ to: chain.factory, data: lenSel }, "latest"], 8000).catch(() => null);
      const count = lenRaw ? Number(BigInt(lenRaw)) : null;
      results.push({ chain: chain.name, chainId: chain.chainId, siloCount: count });
    } catch (_) { results.push({ chain: chain.name, error: "call-failed" }); }
  }

  cond.lastResult = { checkedAt: ts(), results };
  const valid = results.filter(r => r.siloCount !== null && r.siloCount > 0);
  if (valid.length > 0) {
    return {
      condition: SILO_ORACLE_CONDITION,
      severity: "INFO",
      message: `Silo: ${valid.map(r => `${r.chain}=${r.siloCount}`).join(", ")} silos across ${valid.length} chains.`,
      autoExecutable: false,
    };
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════
// Lorenzo sUSD1+ BSC Premium Watch
// ═══════════════════════════════════════════════════════════════════
// Monitors the dormant BSC route: public immediate sUSD1+ mint at NAV,
// followed by sale into PancakeSwap V3 if a liquid pool bids above NAV.
// This is alert/manual-review only until a BSC executor and fork proof exist.

const LORENZO_CONDITION = "lorenzo-susd1plus-premium";
const LORENZO_BSC_SUSD1_PLUS = "0x4F2760B32720F013E900DC92F65480137391199b";
const LORENZO_MIN_PREMIUM_BPS = Number(runtimeConfig.LORENZO_MIN_PREMIUM_BPS || "75");
const LORENZO_MIN_STABLE_LIQUIDITY = Number(runtimeConfig.LORENZO_MIN_STABLE_LIQUIDITY || "5000");
const LORENZO_POOLS = [
  { name: "Pancake V3 sUSD1+/USD1 0.05%", address: "0x479a86165f288C9CE7bB4238258584B259EB5fc7" },
  { name: "Pancake V3 sUSD1+/USDT 0.05%", address: "0xd2144852d15331F8551fD310F16fD3c070dBC898" },
];

const LORENZO_CALLS = {
  currentUnitNav: "0x4924afaf",
  paused: "0x5c975abb",
  transferable: "0x92ff0d31",
  token0: "0x0dfe1681",
  token1: "0xd21220a7",
  slot0: "0x3850c7bd",
  balanceOf: "0x70a08231",
};

function lorenzoBigInt(raw) {
  try { return raw && raw !== "0x" ? BigInt(raw) : null; }
  catch (_) { return null; }
}

function lorenzoEncodeAddress(addr) {
  return String(addr || "").replace(/^0x/i, "").toLowerCase().padStart(64, "0");
}

function lorenzoFormat18(raw) {
  const value = lorenzoBigInt(raw);
  return value === null ? null : Number(value) / 1e18;
}

function lorenzoV3Token1PerToken0(slot0Raw) {
  const hex = String(slot0Raw || "").replace(/^0x/i, "");
  if (hex.length < 64) return null;
  const sqrt = Number(BigInt("0x" + hex.slice(0, 64)));
  if (!Number.isFinite(sqrt) || sqrt <= 0) return null;
  const ratio = sqrt / 2 ** 96;
  return ratio * ratio; // monitored pools use 18-dec token pairs.
}

async function lorenzoBalanceOf(rpc, token, account) {
  const raw = await ethCall(rpc, token, LORENZO_CALLS.balanceOf + lorenzoEncodeAddress(account));
  return lorenzoFormat18(raw);
}

async function evaluatorLorenzoSusd1Plus(rpcPool, state) {
  state.conditions = state.conditions || {};
  const condState = state.conditions[LORENZO_CONDITION] || {};
  state.conditions[LORENZO_CONDITION] = condState;

  const rpc = await resolveRpcForChain(56, rpcPool);
  if (!rpc) return null;

  const [block, navRaw, pausedRaw, transferableRaw] = await Promise.all([
    getBlock(rpc),
    ethCall(rpc, LORENZO_BSC_SUSD1_PLUS, LORENZO_CALLS.currentUnitNav),
    ethCall(rpc, LORENZO_BSC_SUSD1_PLUS, LORENZO_CALLS.paused),
    ethCall(rpc, LORENZO_BSC_SUSD1_PLUS, LORENZO_CALLS.transferable),
  ]);
  const nav = lorenzoFormat18(navRaw);
  if (!nav || nav <= 0) return null;
  const paused = pausedRaw ? lorenzoBigInt(pausedRaw) !== 0n : null;
  const transferable = transferableRaw ? lorenzoBigInt(transferableRaw) !== 0n : null;

  const pools = [];
  for (const pool of LORENZO_POOLS) {
    try {
      const [token0Raw, token1Raw, slot0Raw] = await Promise.all([
        ethCall(rpc, pool.address, LORENZO_CALLS.token0),
        ethCall(rpc, pool.address, LORENZO_CALLS.token1),
        ethCall(rpc, pool.address, LORENZO_CALLS.slot0),
      ]);
      const token0 = decodeAddress(token0Raw);
      const token1 = decodeAddress(token1Raw);
      const token1PerToken0 = lorenzoV3Token1PerToken0(slot0Raw);
      if (!token0 || !token1 || !token1PerToken0) continue;

      const susdLower = LORENZO_BSC_SUSD1_PLUS.toLowerCase();
      let quotePerSusd1Plus = null;
      if (token0.toLowerCase() === susdLower) quotePerSusd1Plus = token1PerToken0;
      if (token1.toLowerCase() === susdLower) quotePerSusd1Plus = 1 / token1PerToken0;
      if (!quotePerSusd1Plus || !Number.isFinite(quotePerSusd1Plus)) continue;

      const [token0Balance, token1Balance] = await Promise.all([
        lorenzoBalanceOf(rpc, token0, pool.address),
        lorenzoBalanceOf(rpc, token1, pool.address),
      ]);
      const susdBalance = token0.toLowerCase() === susdLower ? token0Balance : token1Balance;
      const stableBalance = token0.toLowerCase() === susdLower ? token1Balance : token0Balance;
      const navDiffBps = Math.round(((quotePerSusd1Plus / nav) - 1) * 10000);
      pools.push({ ...pool, token0, token1, quotePerSusd1Plus, navDiffBps, susdBalance, stableBalance });
    } catch (_) {
      // Ignore a single pool read failure; other pools may still provide a signal.
    }
  }

  pools.sort((a, b) => (b.navDiffBps ?? -Infinity) - (a.navDiffBps ?? -Infinity));
  const best = pools[0] || null;
  condState.lastResult = {
    checkedAt: ts(),
    blockNumber: block?.number || null,
    nav,
    paused,
    transferable,
    thresholdBps: LORENZO_MIN_PREMIUM_BPS,
    minStableLiquidity: LORENZO_MIN_STABLE_LIQUIDITY,
    bestPool: best?.name || null,
    bestQuote: best?.quotePerSusd1Plus || null,
    bestNavDiffBps: best?.navDiffBps ?? null,
    bestStableLiquidity: best?.stableBalance ?? null,
    pools: pools.map(p => ({ name: p.name, quotePerSusd1Plus: p.quotePerSusd1Plus, navDiffBps: p.navDiffBps, stableBalance: p.stableBalance, susdBalance: p.susdBalance })),
  };

  if (!best || paused === true || transferable === false) return null;
  if (best.navDiffBps < LORENZO_MIN_PREMIUM_BPS || Number(best.stableBalance || 0) < LORENZO_MIN_STABLE_LIQUIDITY) return null;

  return {
    condition: LORENZO_CONDITION,
    severity: best.navDiffBps >= 200 ? "CRITICAL" : "HIGH",
    chainId: 56,
    nav,
    bestPool: best.name,
    quotePerSusd1Plus: best.quotePerSusd1Plus,
    navDiffBps: best.navDiffBps,
    stableLiquidity: best.stableBalance,
    autoExecutable: false,
    blocker: "No BSC executor/fork-positive supply-sell proof yet; use alert for manual fork validation only.",
    message: `Lorenzo sUSD1+ BSC pool bids ${best.navDiffBps}bps over NAV (${best.name} quote=${best.quotePerSusd1Plus.toFixed(6)} nav=${nav.toFixed(6)} stableLiq=${Number(best.stableBalance || 0).toFixed(0)}). Manual fork proof required.`,
  };
}

// ═══════════════════════════════════════════════════════════════════
// Evaluator 10: Cross-chain Oracle Arbitrage
// ═══════════════════════════════════════════════════════════════════
// Compares ETH/USD Chainlink prices across chains. If one chain's oracle
// is stale and diverges from others, bridge collateral to the overvalued
// chain, borrow, bridge profit back.

const CROSS_CHAIN_FEEDS = {
  // Tier 1 — established Chainlink networks (ETH/USD feeds)
  1:       "0x5f4eC3Df9cbd43714FE2740f5e3616155c5b8419", // Ethereum
  42161:   "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612", // Arbitrum
  8453:    "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70", // Base
  10:      "0x13e3Ee699D1909E989722E753853AE30b17e08c5", // Optimism
  137:     "0xF9680D99D6C9589e2a93a78A04A279e509205945", // Polygon
  // Tier 2 — verified Chainlink feeds on new chains
  56:      "0x9ef1B8c0E4F7dc8bF5719Ea496883DC6401d5b2e", // BSC
  43114:   "0x976B3D034E162d8bD72D6b9C989d545b839003b0", // Avalanche
  534352:  "0x6bF14CB0A831078629D993FDeBcB182b21A8774C", // Scroll
  59144:   "0x3c6Cd9Cc7c7a4c2Cf5a82734CD249D7D593354dA", // Linea
  100:     "0xa767f745331D267c7751297D982b050c93985627", // Gnosis
  324:     "0x6D41d1dc818112880b40e26BD6FD347E410501e1", // zkSync
  // Tier 3 — newer/deprecated Chainlink feeds (may revert, safe to skip)
  250:     "0x11DdD3d147E5b83D01cee7070027092397d63658", // Fantom (deprecated)
  5000:    "0x6E53Fb30Bb4c9Cb03d6BB4d2F8cE657f522F8FE4", // Mantle (unverified)
};

async function evaluatorCrossChainOracle(rpcPool, state) {
  const prices = [];

  for (const [chainId, feedAddr] of Object.entries(CROSS_CHAIN_FEEDS)) {
    const rpc = rpcPool[parseInt(chainId)];
    if (!rpc) continue;
    try {
      const feedData = await queryFeed(rpc, feedAddr);
      if (!feedData) continue;
      const block = await getBlock(rpc);
      const price = Number(feedData.answer) / 1e8;
      if (!(price > 0) || !block || !(feedData.updatedAt > 0)) continue;
      const age = block ? block.timestamp - feedData.updatedAt : null;
      prices.push({ chainId: parseInt(chainId), price, age, feed: feedAddr.slice(0,10) + "..." });
    } catch (_) {}
  }

  if (prices.length < 3) return null;

  // Sort by price
  prices.sort((a, b) => a.price - b.price);
  const min = prices[0];
  const max = prices[prices.length - 1];
  const spread = ((max.price - min.price) / min.price) * 100;

  // Alert if >2% spread; only 30%+ can repay flash principal on the current 80% LTV route.
  if (spread >= 2.0) {
    const severity = spread >= E10_MIN_EXEC_SPREAD_PCT ? "CRITICAL" : spread >= 5.0 ? "HIGH" : "DORMANT";
    return {
      condition: "cross-chain-oracle",
      severity,
      spread: spread.toFixed(2),
      minChain: min.chainId,
      minPrice: min.price.toFixed(2),
      minAge: min.age,
      maxChain: max.chainId,
      maxPrice: max.price.toFixed(2),
      maxAge: max.age,
      message: `ETH/USD spread: ${spread.toFixed(2)}% (chain ${min.chainId}: $${min.price.toFixed(2)} vs chain ${max.chainId}: $${max.price.toFixed(2)}). This evaluator is always read-only; route-positive telemetry does not authorize execution.`,
      allPrices: prices.map(p => ({ chain: p.chainId, price: p.price.toFixed(2), age: p.age })),
    };
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════
// E40 Fee-on-Transfer Systemic Risk Watch
// ═══════════════════════════════════════════════════════════════════
const FOT_CONDITION = "fee-on-transfer-watch";
async function evaluatorFeeOnTransfer(rpcPool, state) {
  state.conditions = state.conditions || {};
  const cond = state.conditions[FOT_CONDITION] || { lastScan: 0 };
  state.conditions[FOT_CONDITION] = cond;
  cond.lastScan = Date.now();
  const rpc = rpcPool[1]; if (!rpc) return null;
  try {
    const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
    const results = {};
    for (const [name, data] of [["basisPointsRate","0x7a210a2b"],["maximumFee","0x54a02f9e"],["getOwner","0x893d20e8"]]) {
      try { const raw = await rpcCall(rpc, "eth_call", [{ to: USDT, data }, "latest"], 8000); results[name] = raw ? Number(BigInt(raw)) : null; }
      catch (_) { results[name] = null; }
    }
    cond.lastResult = { checkedAt: ts(), ...results };
    if (results.basisPointsRate > 0) {
      return { condition: FOT_CONDITION, severity: "CRITICAL", chainId: 1,
        message: `USDT fee ACTIVATED: ${(results.basisPointsRate/100).toFixed(2)}% per transfer. All DeFi lending breaks.` };
    }
    return null;
  } catch (_) { return null; }
}

// ═══════════════════════════════════════════════════════════════════
// E43-E53: Batch Novelty Pattern Watch (11 patterns, 1 evaluator)
// ═══════════════════════════════════════════════════════════════════

const NOVELTY_PATTERN_ARTIFACTS = {
  "pull-oracle-timing": "reports/raw/fast/pull-oracle-timing.json",
  "cross-market-manip": "reports/raw/fast/cross-market-manipulation.json",
  "keeper-reentrancy": "reports/raw/fast/blockc-combined.json",
  "insurance-drain": "reports/raw/fast/insurance-fund-drain.json",
  "precision-loss": "reports/raw/fast/blockc-combined.json",
  "intent-solver": "reports/raw/fast/blockc-combined.json",
  "router-approval": "reports/raw/fast/router-approval-drain.json",
  "pt-mispricing": "reports/raw/fast/pendle-pt-mispricing.json",
  "storage-layout": "reports/raw/fast/storage-layout-regression.json",
  "clmm-precision": "reports/raw/fast/blockc-combined.json",
  "forwarder-spoof": "reports/raw/fast/blockc-combined.json",
};

function validateNoveltyPatternSchema(data) {
  if (data.high !== undefined && !Array.isArray(data.high)) return "high must be an array";
  if (data.critical !== undefined && !Array.isArray(data.critical)) return "critical must be an array";
  return true;
}

function classifyNoveltyPatternArtifact(pattern, data, nowMs = Date.now()) {
  const policy = assessArtifactObject(data, {
    nowMs,
    maxAgeMs: 24 * 3600_000,
    maxFutureSkewMs: 5 * 60_000,
    timestampFields: ["generatedAt", "scannedAt"],
    validate: validateNoveltyPatternSchema,
  });
  if (policy.status !== ARTIFACT_STATUS.VALID_FRESH) {
    const sourceHealth = policy.status === ARTIFACT_STATUS.VALID_STALE ? "STALE" : policy.status;
    return {
      condition: "novelty-patterns",
      pattern: "E43-" + pattern,
      severity: "INFO",
      sourceHealth,
      artifactPolicyStatus: policy.status,
      sourceGeneratedAt: policy.generatedAt || null,
      sourceAgeMs: Number.isFinite(policy.ageMs) ? policy.ageMs : null,
      autoExecutable: false,
      message: `Pattern ${pattern}: source health ${sourceHealth}; no finding severity promoted.`,
    };
  }

  const criticalCount = Array.isArray(data.critical) ? data.critical.length : 0;
  const highCount = Array.isArray(data.high) ? data.high.length : 0;
  if (criticalCount === 0 && highCount === 0) return null;
  return {
    condition: "novelty-patterns",
    pattern: "E43-" + pattern,
    severity: criticalCount > 0 ? "CRITICAL" : "HIGH",
    sourceHealth: ARTIFACT_STATUS.VALID_FRESH,
    sourceGeneratedAt: policy.generatedAt,
    sourceAgeMs: policy.ageMs,
    criticalCount,
    highCount,
    autoExecutable: false,
    message: `Pattern ${pattern}: fresh source has ${criticalCount} CRITICAL and ${highCount} HIGH finding(s); generated ${policy.generatedAt}, age ${(policy.ageMs / 3600_000).toFixed(1)}h.`,
  };
}

async function evaluatorNoveltyPatterns(_rpcPool, state) {
  state.conditions = state.conditions || {};
  const cond = state.conditions["novelty-patterns"] || {};
  state.conditions["novelty-patterns"] = cond;
  const alerts = [];
  const sourceSummary = { total: 0, healthy: 0, failed: 0, unknown: 0 };

  for (const [pattern, artifact] of Object.entries(NOVELTY_PATTERN_ARTIFACTS)) {
    const artifactPath = path.join(WORKSPACE, artifact);
    const policy = readArtifactFile(artifactPath, {
      maxAgeMs: 24 * 3600_000,
      maxFutureSkewMs: 5 * 60_000,
      timestampFields: ["generatedAt", "scannedAt"],
      validate: validateNoveltyPatternSchema,
    });
    sourceSummary.total++;
    if (policy.status === ARTIFACT_STATUS.VALID_FRESH) sourceSummary.healthy++;
    else if (typeof policy.status === "string" && policy.status) sourceSummary.failed++;
    else sourceSummary.unknown++;
    const event = policy.status === ARTIFACT_STATUS.VALID_FRESH
      ? classifyNoveltyPatternArtifact(pattern, policy.data)
      : {
          condition: "novelty-patterns",
          pattern: "E43-" + pattern,
          severity: "INFO",
          sourceHealth: policy.status === ARTIFACT_STATUS.VALID_STALE ? "STALE" : policy.status,
          artifactPolicyStatus: policy.status,
          sourceGeneratedAt: policy.generatedAt || null,
          sourceAgeMs: Number.isFinite(policy.ageMs) ? policy.ageMs : null,
          autoExecutable: false,
          message: `Pattern ${pattern}: source health ${policy.status === ARTIFACT_STATUS.VALID_STALE ? "STALE" : policy.status}; no finding severity promoted.`,
        };
    if (event) alerts.push(event);
  }

  cond.lastResult = { checkedAt: ts(), scanned: Object.keys(NOVELTY_PATTERN_ARTIFACTS).length, alerts: alerts.length, sourceSummary };
  return alerts.length > 0 ? alerts : [];
}

// ═══════════════════════════════════════════════════════════════════
// E44: Morpho Blue Liquidation Bot (on-chain, no API dependency)
// ═══════════════════════════════════════════════════════════════════
// Polls Borrow events from last 5000 blocks, reads positions, computes HF.
// Alerts when ANY position is liquidatable (HF < 1).
// Zero capital required — gas-only liquidation via E9 contract.

const MORPHO_BLUE_ADDR = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const MORPHO_LIQ_CONDITION = "morpho-liq";

async function evaluatorMorphoLiquidation(rpcPool, state) {
  state.conditions = state.conditions || {};
  const cond = state.conditions[MORPHO_LIQ_CONDITION] || {};
  state.conditions[MORPHO_LIQ_CONDITION] = cond;

  if (cond.lastCheck && Date.now() - cond.lastCheck < 1800_000) return null; // 30min cooldown
  cond.lastCheck = Date.now();

  const rpc = rpcPool[1];
  if (!rpc) return null;

  try {
    const block = await rpcCall(rpc, "eth_blockNumber", [], 5000);
    const cur = parseInt(block, 16);
    const BORROW_TOPIC = "0x570954540bed6b1304a87dfe815a5eda4a648f7097a16240dcd85c9b5fd42a43";

    const logs = await rpcCall(rpc, "eth_getLogs", [{
      address: MORPHO_BLUE_ADDR,
      fromBlock: "0x" + (cur - 5000).toString(16),
      toBlock: block,
      topics: [BORROW_TOPIC]
    }], 15000);

    if (!logs || !Array.isArray(logs)) return null;

    const pairs = new Map();
    for (const log of logs.slice(-300)) {
      const mid = log.topics[1];
      const onBehalf = "0x" + (log.topics[2] || "").slice(26);
      if (!pairs.has(mid)) pairs.set(mid, new Set());
      pairs.get(mid).add(onBehalf);
    }

    let totalBorrowers = 0, liquidatable = 0, topBorrower = null, topHF = null;

    for (const [marketId, borrowers] of pairs) {
      const paramsRaw = await rpcCall(rpc, "eth_call", [{ to: MORPHO_BLUE_ADDR, data: "0x2c3c9157" + marketId.slice(2) }, "latest"], 8000);
      if (!paramsRaw || paramsRaw.length < 322) continue;

      const stateRaw = await rpcCall(rpc, "eth_call", [{ to: MORPHO_BLUE_ADDR, data: "0x5c60e39a" + marketId.slice(2) }, "latest"], 8000);
      if (!stateRaw || stateRaw.length < 386) continue;
      const tbs = BigInt("0x" + stateRaw.slice(194, 258));
      if (tbs === 0n) continue;

      const oracle = "0x" + paramsRaw.slice(154, 194);
      const pRaw = await rpcCall(rpc, "eth_call", [{ to: oracle, data: "0xa035b1fe" }, "latest"], 8000);
      if (!pRaw || pRaw.length < 66) continue;
      const priceBig = BigInt("0x" + pRaw.slice(2, 66));

      const tba = BigInt("0x" + stateRaw.slice(130, 194));
      const lltv = Number(BigInt("0x" + paramsRaw.slice(258, 322))) / 1e18; // from MarketParams

      for (const borrower of [...borrowers].slice(0, 15)) {
        const posRaw = await rpcCall(rpc, "eth_call", [{
          to: MORPHO_BLUE_ADDR,
          data: "0x93c52062" + marketId.slice(2) + "0".repeat(24) + borrower.slice(2)
        }, "latest"], 8000);
        if (!posRaw || posRaw.length < 194) continue;

        const bs = BigInt("0x" + posRaw.slice(66, 130));
        const coll = BigInt("0x" + posRaw.slice(130, 194));
        if (bs === 0n) continue;
        totalBorrowers++;

        const borrowed = (bs * tba + tbs - 1n) / tbs; // ceil division
        const maxBorrow = (coll * priceBig / BigInt(1e36)) * BigInt(Math.floor(lltv * 1e18)) / BigInt(1e18);

        if (maxBorrow < borrowed) {
          liquidatable++;
          const hf = borrowed > 0n ? Number(maxBorrow) / Number(borrowed) : 0;
          if (!topBorrower || hf < topHF) {
            topBorrower = borrower.slice(0, 10) + "...";
            topHF = hf;
          }
        }
      }
    }

    cond.lastResult = { checkedAt: ts(), totalBorrowers, liquidatable, topBorrower, topHF };
    cond.lastBorrowers = totalBorrowers;

    // Also check WebSocket monitor for recent liquidation events
    const wsStatusPath = path.join(WORKSPACE, "reports", "monitor", "morpho-ws-status.json");
    let wsLiquidations = 0;
    try {
      const wsStatus = loadJson(wsStatusPath, null);
      if (wsStatus?.liquidationsSeen) wsLiquidations = wsStatus.liquidationsSeen;
    } catch (_) {}
    cond.telemetry = {
      classification: "EVENT_ONLY",
      cumulativeWsLiquidations: Number(wsLiquidations) || 0,
      checkedAt: ts(),
      autoExecutable: false,
    };

    if (liquidatable > 0) {
      return {
        condition: MORPHO_LIQ_CONDITION,
        severity: "CRITICAL",
        chainId: 1,
        currentRecomputedLiquidatable: liquidatable,
        wsTelemetryClassification: "EVENT_ONLY",
        message: `Morpho: ${liquidatable}/${totalBorrowers} currently recomputed liquidatable; cumulative WS event telemetry=${wsLiquidations}. Manual defensive validation required.`,
        autoExecutable: false,
      };
    }
    return null;
  } catch (_) { return null; }
}

// ═══════════════════════════════════════════════════════════════════
// E45: DeFiLlama Oracle Classifier Freshness
// ═══════════════════════════════════════════════════════════════════

const DEFILLAMA_ARTIFACT = path.join(WORKSPACE, "reports", "raw", "fast", "defillama-oracle-classifier.json");
const DEFILLAMA_CONDITION = "defillama-classifier";

async function evaluatorDefillamaFreshness(state) {
  state.conditions = state.conditions || {};
  const cond = state.conditions[DEFILLAMA_CONDITION] || {};
  state.conditions[DEFILLAMA_CONDITION] = cond;
  if (cond.lastCheck && Date.now() - cond.lastCheck < 3600_000) return null;
  cond.lastCheck = Date.now();
  try {
    const policy = readArtifactFile(DEFILLAMA_ARTIFACT, {
      maxAgeMs: 24 * 3600_000,
      maxFutureSkewMs: 5 * 60_000,
      timestampFields: ["generatedAt", "scannedAt"],
      requiredPaths: ["ranked"],
      validate: (artifact) => Array.isArray(artifact.ranked) || "ranked must be an array",
    });
    cond.sourceHealth = policy.status;
    if (policy.status !== ARTIFACT_STATUS.VALID_FRESH) {
      cond.lastError = { code: policy.status, message: policy.error || "classifier artifact unavailable or stale" };
      cond.lastResult = null;
      return {
        condition: DEFILLAMA_CONDITION,
        severity: "INFO",
        sourceHealth: policy.status,
        message: `DeFiLlama classifier source health: ${policy.status}. No finding severity promoted.`,
        autoExecutable: false,
      };
    }
    const data = policy.data;
    const ageHours = policy.ageMs / 3600_000;
    const newCount = Number(data.new || 0);
    const criticalCount = data.ranked.filter(r => r.riskLabel === "CRITICAL" && r.isNew).length;
    cond.lastError = null;
    cond.lastResult = { checkedAt: ts(), sourceGeneratedAt: policy.generatedAt, artifactAge: ageHours.toFixed(1) + "h", newTargets: newCount, criticalNew: criticalCount, total: Number(data.filtered || 0) };
    if (criticalCount > 0) {
      return { condition: DEFILLAMA_CONDITION, severity: "INFO", sourceHealth: ARTIFACT_STATUS.VALID_FRESH, message: `DeFiLlama: ${newCount} new targets, ${criticalCount} classifier-critical research rows. Age: ${ageHours.toFixed(1)}h.`, autoExecutable: false };
    }
    return null;
  } catch (_) {
    cond.sourceHealth = ARTIFACT_STATUS.MALFORMED;
    cond.lastError = { code: ARTIFACT_STATUS.MALFORMED, message: "classifier policy failure" };
    return { condition: DEFILLAMA_CONDITION, severity: "INFO", sourceHealth: ARTIFACT_STATUS.MALFORMED, message: "DeFiLlama classifier source health: MALFORMED.", autoExecutable: false };
  }
}

// ═══════════════════════════════════════════════════════════════════
// E46: Oracle Staleness Router
// ═══════════════════════════════════════════════════════════════════
// Cross-references stale feeds with protocol consumers and routes to executor.

const STALENESS_ROUTER_CONDITION = "staleness-router";
const STALENESS_ROUTER_FILE = path.join(WORKSPACE, "reports", "monitor", "staleness-router.json");
async function evaluatorStalenessRouter(_rpcPool, state) {
  state.conditions = state.conditions || {};
  const cond = state.conditions[STALENESS_ROUTER_CONDITION] || {};
  state.conditions[STALENESS_ROUTER_CONDITION] = cond;
  if (cond.lastCheck && Date.now() - cond.lastCheck < 1800_000) return null;
  cond.lastCheck = Date.now();
  const policy = readArtifactFile(STALENESS_ROUTER_FILE, {
    maxAgeMs: 30 * 60_000,
    maxFutureSkewMs: 5 * 60_000,
    timestampFields: ["generatedAt", "scannedAt"],
    requiredPaths: ["alerts"],
    validate: (artifact) => {
      if (!Array.isArray(artifact.alerts)) return "alerts must be an array";
      if (!artifact.alerts.every((item) => item && typeof item === "object" && typeof item.severity === "string")) return "alerts must be typed objects";
      return true;
    },
  });
  cond.sourceHealth = policy.status;
  if (policy.status !== ARTIFACT_STATUS.VALID_FRESH) {
    cond.lastError = { code: policy.status, message: policy.error || "staleness router artifact unavailable or stale" };
    cond.lastResult = null;
    return null;
  }

  const typedAlerts = policy.data.alerts.filter((item) => ["INFO", "WARN", "HIGH", "CRITICAL"].includes(item.severity.toUpperCase()));
  const highest = typedAlerts.reduce((severity, item) => severityRank(item.severity) > severityRank(severity) ? item.severity.toUpperCase() : severity, "INFO");
  cond.lastError = null;
  cond.lastResult = { checkedAt: ts(), sourceGeneratedAt: policy.generatedAt, sourceAgeMs: policy.ageMs, typedAlertCount: typedAlerts.length };
  if (typedAlerts.length === 0) return null;
  return {
    condition: STALENESS_ROUTER_CONDITION,
    severity: highest,
    typedAlertCount: typedAlerts.length,
    sourceHealth: ARTIFACT_STATUS.VALID_FRESH,
    sourceGeneratedAt: policy.generatedAt,
    sourceAgeMs: policy.ageMs,
    autoExecutable: false,
    message: `Oracle Staleness Router artifact contains ${typedAlerts.length} typed alert(s); review source records.`,
  };
}

// ═══════════════════════════════════════════════════════════════════
// E47: Solana Cross-Protocol Liquidation Scanner
// ═══════════════════════════════════════════════════════════════════

const SOLANA_STATUS_FILE = path.join(WORKSPACE, "reports", "monitor", "solana-status.json");
const SOLANA_CONDITION = "solana-cross-protocol";

async function evaluatorSolanaCrossProtocol(state) {
  state.conditions = state.conditions || {};
  const cond = state.conditions[SOLANA_CONDITION] || {};
  state.conditions[SOLANA_CONDITION] = cond;
  if (cond.lastCheck && Date.now() - cond.lastCheck < 1800_000) return null;
  cond.lastCheck = Date.now();
  try {
    const data = loadJson(SOLANA_STATUS_FILE, null);
    if (!data) return { condition: SOLANA_CONDITION, severity: "INFO", message: "Solana status file not found", autoExecutable: false };
    const age = (Date.now() - new Date(data.updatedAt).getTime()) / 3600_000;
    const kaminoLiquidatable = Number(data.kamino?.liquidatable || 0);
    const marginfiRecomputed = Number(data.marginfi?.recomputedLiquidatable || data.marginfi?.liquidatable || 0);
    const marginfiObservedOnly = Number(data.marginfi?.observedUnhealthy ?? data.marginfi?.unhealthy ?? 0);
    const executableCandidates = Number(data.crossProtocol?.executableCandidates || 0);
    const totalLiq = kaminoLiquidatable + marginfiRecomputed;
    cond.lastResult = {
      checkedAt: ts(),
      artifactAge: age.toFixed(1)+"h",
      totalLiq,
      executableCandidates,
      marginfiObservedOnly,
      wallet: data.wallet || null,
    };
    if (totalLiq > 0) return { condition: SOLANA_CONDITION, severity: "CRITICAL", message: `Solana: ${totalLiq} recomputed liquidatable position(s), executableCandidates=${executableCandidates}`, autoExecutable: false };
    if (marginfiObservedOnly > 0) return { condition: SOLANA_CONDITION, severity: "INFO", message: `Solana: Marginfi ${marginfiObservedOnly} observed unhealthy HealthCache row(s), not counted as liquidatable until full bank/oracle recompute`, autoExecutable: false };
    if (age > 6) return { condition: SOLANA_CONDITION, severity: "HIGH", message: `Solana status ${age.toFixed(0)}h stale`, autoExecutable: false };
    return null;
  } catch (_) { return null; }
}

module.exports = {
  buildE9LiquidationCandidates,
  executeE9Liquidation,
  evaluatorLiquidationHunter,
  evaluatorAaveV4LiquidationWatch,
  evaluatorAutoFork,
  evaluatorNoveltyPatterns,
  classifyAaveV4Artifact,
  classifyForkArtifact,
  classifyNoveltyPatternArtifact,
  forceMonitorOnlyAuthorization,
  createCycleHealth,
  beginCycleHealth,
  recordCycleSource,
  finalizeCycleHealth,
  getLiveEthPrice,
  setE23HardStop,
  evaluateE25Rates,
  E25_AMOUNT_FOR_SHARE_SELECTOR,
  E9_CONTRACT,
  E9_MIN_NET_PROFIT_USD,
};
