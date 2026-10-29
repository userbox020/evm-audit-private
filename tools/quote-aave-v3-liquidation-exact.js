#!/usr/bin/env node
"use strict";

// quote-aave-v3-liquidation-exact.js
// Read-only, fail-closed exact-quote scaffold for the Aave V3 Ethereum whale
// candidate recorded in reports/raw/fast/aave-v3-trigger-readiness.json.
//
// Properties:
//   * keyless RPC only; rpc_endpoints.txt is read in-process.
//   * Endpoint values are NEVER printed or persisted (no URL, host, or path leaks).
//   * No signing, no broadcast, no state change, no fetchPrice(), no key files,
//     no executor calls. Every quote is an eth_call static view / reverting quoter.
//   * Bounded request budget (<= 96 total, <= 24 for provider qualification) and a
//     wall-clock budget. Bound sub-quotes and fail closed on any error code.
//
// The artifact is a quote scaffold only: it does NOT authorize or justify a
// signed action. routePositive stays "unknown"; executableNow/autoExecutable/
// signedActionJustified/forkJustified stay false.

const fs = require("node:fs");
const path = require("node:path");
const { ethers } = require(path.join(__dirname, "node_modules", "ethers"));
// Reuse the Liquity watcher's in-process inventory parser and bounded transport
// (same qualification/transport pattern the Aave V4 watch lane imports).
const watcher = require("./watch-liquity-liquidation-triggers.js");

const ROOT = path.resolve(__dirname, "..");
const INVENTORY = path.join(ROOT, "rpc_endpoints.txt");
const ROUTE_FILE = path.join(ROOT, "reports", "raw", "fast", "aave-v3-route-distance.json");
const READINESS_FILE = path.join(ROOT, "reports", "raw", "fast", "aave-v3-trigger-readiness.json");
const LINDEX_FILE = path.join(ROOT, "reports", "raw", "fast", "aave-v3-l-index.json");
const ADDRESS_BOOK_FILE = path.join(ROOT, "targets", "aave-address-book-6a0ac5a", "src", "AaveV3Ethereum.sol");
const BALANCER_POOLS_FILE = path.join(ROOT, "reports", "raw", "fast", "aave-v3-balancer-weeth-pools.json");
const WATCH_FALLBACK_FILE = path.join(ROOT, "reports", "raw", "fast", "aave-v3-liquidation-watch.json");
const WATCH_STATUS_FALLBACK_FILE = path.join(ROOT, "reports", "raw", "fast", "aave-v3-liquidation-watch-status.json");
const OUT = path.join(ROOT, "reports", "raw", "fast", "aave-v3-liquidation-exact-quotes.json");
const OUT_TRIGGER = path.join(ROOT, "reports", "raw", "fast", "aave-v3-liquidation-trigger-quotes.json");

const SCHEMA = "aave-v3-liquidation-exact-quotes/v1";
const TRIGGER_SCHEMA = "aave-v3-liquidation-trigger-quotes/v1";
const BALANCER_POOLS_SCHEMA = "aave-v3-balancer-weeth-pools/v1";
const CHAIN_ID = 1;
const MAX_REQUESTS = 96;
const QUALIFICATION_BUDGET = 24;
const WALL_BUDGET_MS = 180_000;
const GAS_UNITS = 500_000n;
const SLIPPAGE_ROWS = [50, 20];
// A ComposableStablePool whose total tracked WETH+weETH balance is below this
// threshold was effectively drained at the observation; the exit route must
// prefer the Uniswap legs in that case.
const DRAIN_THRESHOLD_WEI = 10n ** 16n;
const DEFAULT_WATCH_SECONDS = 60;
const DEFAULT_MAX_RUNS = 60;
const POLL_GAP_MS = 4_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// LiquidationLogic.sol (v3.7 cff15de) :43-72, :258-282
// DEFAULT_LIQUIDATION_CLOSE_FACTOR = 0.5e4; CLOSE_FACTOR_HF_THRESHOLD = 0.95e18;
// MIN_BASE_MAX_CLOSE_FACTOR_THRESHOLD = 2000e8.
const CLOSE_FACTOR_HF_THRESHOLD = 950_000_000_000_000_000n; // 0.95e18
const MIN_BASE_MAX_CLOSE_FACTOR_THRESHOLD = 2000n * 10n ** 8n; // base currency (8 dec)

// Address book / protocol pins. Every one is re-verified with eth_getCode; the
// DataProvider, Pool and Oracle are additionally DERIVED from the address book
// checkout below (not trusted from any prompt text).
const BALANCER_VAULT = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";
const QUOTER_V2 = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const WEETH = "0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee";
const BORROWER = "0x1A557354C5b8d7Df38ea914209e416Dc7065b158";
const UNISWAP_V3_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";

const IFACE = Object.freeze({
  pool: new ethers.Interface([
    "function getUserAccountData(address user) view returns (uint256 totalCollateralBase,uint256 totalDebtBase,uint256 availableBorrowsBase,uint256 currentLiquidationThreshold,uint256 ltv,uint256 healthFactor)",
    "function getReserveData(address asset) view returns ((uint256 configuration) data,uint128 liquidityIndex,uint128 currentLiquidityRate,uint128 variableBorrowIndex,uint128 currentVariableBorrowRate,uint128 currentStableBorrowRate,uint40 lastUpdateTimestamp,uint16 id,address aTokenAddress,address stableDebtTokenAddress,address variableDebtTokenAddress,address interestRateStrategyAddress,uint128 accruedToTreasury,uint128 unbacked,uint128 isolationModeTotalDebt)",
    "function FLASHLOAN_PREMIUM_TOTAL() view returns (uint128)",
    "function FLASHLOAN_PREMIUM_TO_PROTOCOL() view returns (uint128)",
  ]),
  dataProvider: new ethers.Interface([
    "function getReserveConfigurationData(address asset) view returns (uint256 decimals,uint256 ltv,uint256 liquidationThreshold,uint256 liquidationBonus,uint256 reserveFactor,bool usageAsCollateralEnabled,bool borrowingEnabled,bool stableBorrowRateEnabled,bool isActive,bool isFrozen)",
    "function getPaused(address asset) view returns (bool)",
    "function getUserReserveData(address asset,address user) view returns (uint256 currentATokenBalance,uint256 currentStableDebt,uint256 currentVariableDebt,uint256 principalStableDebt,uint256 scaledVariableDebt,uint256 stableBorrowRate,uint256 liquidityRate,uint40 stableRateLastUpdated,bool usageAsCollateralEnabled)",
  ]),
  oracle: new ethers.Interface(["function getAssetPrice(address asset) view returns (uint256)"]),
  erc20: new ethers.Interface(["function balanceOf(address account) view returns (uint256)"]),
  factory: new ethers.Interface(["function getPool(address tokenA,address tokenB,uint24 fee) view returns (address)"]),
  balancer: new ethers.Interface([
    "function getPoolTokens(bytes32 poolId) view returns (address[] tokens,uint256[] balances,uint256 lastChangeBlock)",
    "function queryBatchSwap(uint8 kind,(bytes32 poolId,uint256 assetInIndex,uint256 assetOutIndex,uint256 amount,bytes userData)[] swaps,address[] assets,(address sender,bool fromInternalBalance,address recipient,bool toInternalBalance) funds) returns (int256[] assetDeltas)",
  ]),
  quoter: new ethers.Interface([
    "function quoteExactInput(bytes path,uint256 amountIn) returns (uint256 amountOut,uint160[] sqrtPriceX96AfterList,uint32[] initializedTicksCrossedList,uint256 gasEstimate)",
  ]),
});

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------
const HEXQ = (value) => typeof value === "string" && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value);
const HASH = (value) => typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value);
const MIN = (a, b) => (a < b ? a : b);
let requestCount = 0;

const jsonReplacer = (_key, value) => (typeof value === "bigint" ? value.toString() : value);

function loadJson(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    if (fs.statSync(file).size > 4 * 1024 * 1024) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function norm(value) {
  try { return ethers.getAddress(value); } catch (_) { return null; }
}

function toBig(value, fallback = 0n) {
  try {
    if (value === null || value === undefined || value === "") return fallback;
    return BigInt(value);
  } catch (_) {
    return fallback;
  }
}

function toNum(value) {
  if (value === null || value === undefined || value === "") return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function firstNum(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function safeCode(error) {
  return error && error.message && /^[a-z0-9-]+$/.test(error.message) ? error.message : "unhandled-failure";
}

// ---------------------------------------------------------------------------
// address book derivation
// ---------------------------------------------------------------------------
function parseAddressBook(text) {
  const grab = (re) => {
    const match = text.match(re);
    if (!match) return null;
    const address = norm(match[1]);
    return address;
  };
  return {
    pool: grab(/POOL\s*=\s*IPool\(\s*(0x[0-9a-fA-F]{40})\s*\)/),
    dataProvider: grab(/AAVE_PROTOCOL_DATA_PROVIDER\s*=\s*\s*IPoolDataProvider\(\s*(0x[0-9a-fA-F]{40})\s*\)/),
    oracle: grab(/ORACLE\s*=\s*IAaveOracle\(\s*(0x[0-9a-fA-F]{40})\s*\)/),
    addressesProvider: grab(/POOL_ADDRESSES_PROVIDER\s*=\s*\s*IPoolAddressesProvider\(\s*(0x[0-9a-fA-F]{40})\s*\)/),
  };
}

function deriveAddressBook() {
  if (!fs.existsSync(ADDRESS_BOOK_FILE)) return null;
  let text;
  try { text = fs.readFileSync(ADDRESS_BOOK_FILE, "utf8"); } catch (_) { return null; }
  const parsed = parseAddressBook(text);
  if (!parsed.pool || !parsed.dataProvider || !parsed.oracle) return null;
  return parsed;
}

// ---------------------------------------------------------------------------
// transport + qualification
// ---------------------------------------------------------------------------
function buildTransport() {
  const net = watcher.transport(globalThis.fetch);
  const rpc = async (provider, method, params) => {
    if (requestCount >= MAX_REQUESTS) throw new Error("request-budget-exhausted");
    requestCount += 1;
    return net.rpc(provider, method, params);
  };
  return { rpc, used: () => requestCount };
}

async function qualify(provider, rpc, addresses) {
  // Chain 1 + finalized pin recheck + runtime-code presence on the three
  // authoritative protocol addresses. <= 6 requests per candidate.
  try {
    if (await rpc(provider, "eth_chainId", []) !== "0x1") return null;
    const finalized = await rpc(provider, "eth_getBlockByNumber", ["finalized", false]);
    if (!finalized || !HASH(finalized.hash) || !HEXQ(finalized.number)) return null;
    const recheck = await rpc(provider, "eth_getBlockByNumber", [finalized.number, false]);
    if (!recheck || recheck.hash !== finalized.hash) return null;
    for (const address of [addresses.pool, addresses.dataProvider, addresses.oracle]) {
      const code = await rpc(provider, "eth_getCode", [address, finalized.number]);
      if (typeof code !== "string" || !/^0x[0-9a-fA-F]+$/.test(code) || code.length <= 2) return null;
    }
    return finalized;
  } catch (_) {
    return null;
  }
}

// Extract a recorded Balancer pool id (64-hex) from prior artifacts. The current
// aave-v3-route-distance.json does NOT record a WETH/weETH Balancer pool id, so
// this normally returns null and the Balancer leg fails closed honestly.
function findRecordedBalancerPoolId(node, seen = new Set()) {
  if (!node || typeof node !== "object" || seen.has(node)) return null;
  seen.add(node);
  for (const [key, value] of Object.entries(node)) {
    if (typeof value === "string" && /balancer|pool/i.test(key) && /^(0x)?[0-9a-fA-F]{64}$/.test(value.trim())) {
      const hex = value.trim().replace(/^0x/i, "").toLowerCase();
      return "0x" + hex;
    }
    if (value && typeof value === "object") {
      const found = findRecordedBalancerPoolId(value, seen);
      if (found) return found;
    }
  }
  return null;
}

// Canonical source of the WETH/weETH Balancer pool id: the fixer-produced
// aave-v3-balancer-weeth-pools.json artifact (schema v1). Returns the first pool
// holding BOTH WETH and weETH, with the honest drain caveat from its observation.
function selectBalancerWeethPool(artifact) {
  if (!artifact || artifact.schema !== BALANCER_POOLS_SCHEMA) return null;
  const list = Array.isArray(artifact.poolsFound) ? artifact.poolsFound : [];
  for (const pool of list) {
    const rawId = typeof pool.poolId === "string" ? pool.poolId.trim() : "";
    if (!/^0x[0-9a-fA-F]{64}$/.test(rawId)) continue;
    const tokens = (Array.isArray(pool.tokens) ? pool.tokens : []).map((a) => String(a).toLowerCase());
    if (!tokens.includes(WETH.toLowerCase()) || !tokens.includes(WEETH.toLowerCase())) continue;
    const wethRaw = toBig(pool.wethRaw, 0n);
    const weethRaw = toBig(pool.weethRaw, 0n);
    const totalTrackedRaw = wethRaw + weethRaw;
    return {
      poolId: "0x" + rawId.replace(/^0x/i, "").toLowerCase(),
      poolAddress: norm(pool.poolAddress),
      source: "balancer-pools-artifact",
      wethRaw: wethRaw.toString(),
      weethRaw: weethRaw.toString(),
      totalTrackedRaw: totalTrackedRaw.toString(),
      balancerPoolDrainedAtObservation: totalTrackedRaw < DRAIN_THRESHOLD_WEI,
      observationBlock: Number.isSafeInteger(artifact.blockNumber) ? artifact.blockNumber : null,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// read helpers
// ---------------------------------------------------------------------------
async function call(provider, rpc, to, iface, fn, args, blockTag) {
  const target = norm(to);
  if (!target) throw new Error("call-invalid");
  const data = iface.encodeFunctionData(fn, args);
  const raw = await rpc(provider, "eth_call", [{ to: target, data }, blockTag]);
  return iface.decodeFunctionResult(fn, raw);
}

async function safeCall(provider, rpc, to, iface, fn, args, blockTag) {
  try { return await call(provider, rpc, to, iface, fn, args, blockTag); }
  catch (_) { return null; }
}

async function verifyCode(provider, rpc, role, address, blockTag, verified) {
  let ok = false;
  try {
    const code = await rpc(provider, "eth_getCode", [address, blockTag]);
    ok = typeof code === "string" && /^0x[0-9a-fA-F]+$/.test(code) && code.length > 2;
  } catch (_) {
    ok = false;
  }
  verified.push({ role, address, codeVerified: ok });
  return ok;
}

function encodePath(tokens, fees) {
  let out = tokens[0].toLowerCase();
  for (let i = 0; i < fees.length; i += 1) {
    out += fees[i].toString(16).padStart(6, "0") + tokens[i + 1].toLowerCase().replace(/^0x/, "");
  }
  return out;
}

function minOut(exactOutWei, bps) {
  return (exactOutWei * BigInt(10_000 - bps)) / 10_000n;
}

function impactBps(fairOutWei, exactOutWei) {
  if (fairOutWei <= 0n) return null;
  const diff = fairOutWei - exactOutWei;
  // basis points: (fair - executed) / fair * 10_000
  return Number((diff * 10_000n) / fairOutWei);
}

function minOutMap(exactOutWei) {
  if (exactOutWei <= 0n) return { "50": null, "20": null };
  return {
    "50": minOut(exactOutWei, 50).toString(),
    "20": minOut(exactOutWei, 20).toString(),
  };
}

// ---------------------------------------------------------------------------
// quote legs
// ---------------------------------------------------------------------------
async function quoteUniswapPools(provider, rpc, pools, amountIn, fairOutWei, blockTag) {
  const rows = [];
  for (const pool of pools) {
    if (!pool || !pool.codeVerified || !pool.pool || amountIn <= 0n) {
      rows.push({ fee: pool ? pool.fee : null, pool: pool ? pool.pool : null, codeVerified: false, exactOutWei: null, priceImpactBps: null, minOutNeededWei: null, status: "pool-unavailable" });
      continue;
    }
    try {
      const path = encodePath([WEETH, WETH], [pool.fee]);
      const decoded = await call(provider, rpc, QUOTER_V2, IFACE.quoter, "quoteExactInput", [path, amountIn], blockTag);
      const exactOutWei = toBig(decoded[0]);
      rows.push({
        venue: "uniswap-v3-quoterV2",
        fee: pool.fee,
        pool: pool.pool,
        codeVerified: true,
        pathFees: [pool.fee],
        exactOutWei: exactOutWei > 0n ? exactOutWei.toString() : null,
        priceImpactBps: impactBps(fairOutWei, exactOutWei),
        minOutNeededWei: minOutMap(exactOutWei),
        gasEstimate: toBig(decoded[3]).toString(),
        status: exactOutWei > 0n ? "quoted" : "zero-out",
      });
    } catch (_) {
      rows.push({ venue: "uniswap-v3-quoterV2", fee: pool.fee, pool: pool.pool, codeVerified: true, exactOutWei: null, priceImpactBps: null, minOutNeededWei: null, status: "quote-failed" });
    }
  }
  return rows;
}

async function quoteBalancerExit(provider, rpc, poolId, amountInWeeth, repayWeth, blockTag) {
  // Given-In exit (kind 0) selling the whole seized weETH; Given-Out probe (kind 1)
  // for the WETH repay target. Both are static eth_calls (no state change).
  const result = { venue: "balancer-v2-queryBatchSwap", poolId, kindGivenIn: null, kindGivenOut: null, reserves: null, status: "pool-id-unavailable" };
  if (!poolId) return result;
  result.status = "unavailable";
  const assets = [norm(WEETH), norm(WETH)];
  const funds = { sender: ethers.ZeroAddress, fromInternalBalance: false, recipient: ethers.ZeroAddress, toInternalBalance: false };
  // Reserves math fallback from getPoolTokens.
  try {
    const tokens = await call(provider, rpc, BALANCER_VAULT, IFACE.balancer, "getPoolTokens", [poolId], blockTag);
    const list = (tokens[0] || []).map((a) => a.toLowerCase());
    const balances = tokens[1] || [];
    const inIdx = list.indexOf(WEETH.toLowerCase());
    const outIdx = list.indexOf(WETH.toLowerCase());
    if (inIdx >= 0 && outIdx >= 0) {
      result.reserves = {
        weethRaw: toBig(balances[inIdx]).toString(),
        wethRaw: toBig(balances[outIdx]).toString(),
      };
    }
  } catch (_) {
    result.reserves = null;
  }
  // Given-In: sell the whole seized weETH.
  try {
    const swaps = [{ poolId, assetInIndex: 0, assetOutIndex: 1, amount: amountInWeeth, userData: "0x" }];
    const decoded = await call(provider, rpc, BALANCER_VAULT, IFACE.balancer, "queryBatchSwap", [0, swaps, assets, funds], blockTag);
    const deltas = decoded[0] || [];
    const outDelta = toBig(deltas[1]);
    const outWei = outDelta < 0n ? -outDelta : 0n;
    result.kindGivenIn = { amountInWeeth: amountInWeeth.toString(), exactOutWeth: outWei.toString(), minOutNeededWei: minOutMap(outWei), status: outWei > 0n ? "quoted" : "zero-out" };
    result.status = "quoted";
  } catch (_) {
    result.kindGivenIn = { amountInWeeth: amountInWeeth.toString(), exactOutWeth: null, minOutNeededWei: null, status: "quote-failed" };
  }
  // Given-Out: how much weETH to supply for the exact WETH repay target.
  try {
    const swaps = [{ poolId, assetInIndex: 0, assetOutIndex: 1, amount: repayWeth, userData: "0x" }];
    const decoded = await call(provider, rpc, BALANCER_VAULT, IFACE.balancer, "queryBatchSwap", [1, swaps, assets, funds], blockTag);
    const deltas = decoded[0] || [];
    const weethDelta = toBig(deltas[0]);
    const weethIn = weethDelta > 0n ? weethDelta : (weethDelta < 0n ? -weethDelta : 0n);
    result.kindGivenOut = { targetWeth: repayWeth.toString(), requiredWeethIn: weethIn.toString(), status: weethIn > 0n ? "quoted" : "zero-in" };
  } catch (_) {
    result.kindGivenOut = { targetWeth: repayWeth.toString(), requiredWeethIn: null, status: "quote-failed" };
  }
  return result;
}

// ---------------------------------------------------------------------------
// main run
// ---------------------------------------------------------------------------
function emptyArtifact(blockers, extra = {}) {
  return {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    scanner: "tools/quote-aave-v3-liquidation-exact.js",
    scope: "Read-only Aave V3 Ethereum exact-quote scaffold for the recorded WETH/weETH whale candidate",
    state: null,
    chainId: CHAIN_ID,
    blockNumber: null,
    borrower: BORROWER,
    pool: null,
    readonly: true,
    rpcUrlsStored: false,
    pricing: "LIVE_QUOTES_REPORTED",
    routePositive: "unknown",
    executableNow: false,
    autoExecutable: false,
    signedActionJustified: false,
    forkJustified: false,
    exactQuoteComplete: false,
    liveAccountData: null,
    oraclePrices: null,
    balances: null,
    flash: null,
    reserveConfig: [],
    closeFactorRule: null,
    venues: null,
    verifiedAddresses: [],
    scenarios: [],
    netRaw: [],
    blockers,
    ...extra,
  };
}

async function run(options = {}) {
  const startedMs = Date.now();
  requestCount = 0;
  const blockers = [];
  const router = loadJson(ROUTE_FILE, null);
  const readiness = loadJson(READINESS_FILE, null);
  const lindex = loadJson(LINDEX_FILE, null);
  const topRow = readiness?.topRow || null;
  // The borrower is never hard-coded for a live trigger: it is taken from the
  // readiness topRow (or an explicit override) so the trigger artifact tracks
  // the live row, not the original watch seed.
  const borrower = norm(options.borrower) || norm(topRow?.user) || norm(topRow?.borrower) || BORROWER;
  const triggerMode = options.trigger === true;

  const addressBook = deriveAddressBook();
  if (!addressBook) {
    return emptyArtifact(["address-book-unavailable"], {
      sourceArtifacts: { route: path.basename(ROUTE_FILE), readiness: path.basename(READINESS_FILE), lIndex: lindex ? path.basename(LINDEX_FILE) : null },
    });
  }

  if (!fs.existsSync(INVENTORY)) return emptyArtifact(["inventory-unavailable"], { pool: addressBook.pool });
  let providers;
  try {
    providers = watcher.parseInventory(fs.readFileSync(INVENTORY, "utf8"))
      .filter((row) => row.ethereumHint !== false).slice(0, 24);
  } catch (_) {
    return emptyArtifact(["inventory-unavailable"], { pool: addressBook.pool });
  }
  if (!providers.length) return emptyArtifact(["no-eligible-candidates"], { pool: addressBook.pool });

  const { rpc } = buildTransport();
  let provider = null;
  let finalized = null;
  for (const candidate of providers) {
    if (requestCount >= QUALIFICATION_BUDGET) break;
    if (Date.now() - startedMs > WALL_BUDGET_MS) {
      blockers.push("wall-budget-exceeded");
      break;
    }
    finalized = await qualify(candidate, rpc, addressBook);
    if (finalized) { provider = candidate; break; }
  }
  if (!provider) return emptyArtifact(["no-qualified-provider"], { pool: addressBook.pool, requestsUsed: requestCount });

  const blockTag = finalized.number;
  const verified = [];

  // Verify every listed pool/token/venue address (never trust prompt values).
  await verifyCode(provider, rpc, "aave-pool", addressBook.pool, blockTag, verified);
  await verifyCode(provider, rpc, "aave-protocol-data-provider", addressBook.dataProvider, blockTag, verified);
  await verifyCode(provider, rpc, "aave-price-oracle", addressBook.oracle, blockTag, verified);
  await verifyCode(provider, rpc, "weth", WETH, blockTag, verified);
  await verifyCode(provider, rpc, "weeth", WEETH, blockTag, verified);
  await verifyCode(provider, rpc, "balancer-vault", BALANCER_VAULT, blockTag, verified);
  await verifyCode(provider, rpc, "uniswap-quoterV2", QUOTER_V2, blockTag, verified);

  // ---- live account + reserve reads -----------------------------------------
  const account = await safeCall(provider, rpc, addressBook.pool, IFACE.pool, "getUserAccountData", [borrower], blockTag);
  if (!account) {
    return emptyArtifact(["account-read-failed", ...blockers], { blockNumber: Number(BigInt(blockTag)), pool: addressBook.pool, borrower, verifiedAddresses: verified, requestsUsed: requestCount });
  }
  const totalCollateralBase = toBig(account[0]);
  const totalDebtBase = toBig(account[1]);
  const availableBorrowsBase = toBig(account[2]);
  const liquidationThresholdBps = Number(toBig(account[3]));
  const ltvBps = Number(toBig(account[4]));
  const hfRaw = toBig(account[5]);

  const [wethCfg, weethCfg, wethReserve, weethReserve, wethPriceRaw, weethPriceRaw] = await Promise.all([
    safeCall(provider, rpc, addressBook.dataProvider, IFACE.dataProvider, "getReserveConfigurationData", [WETH], blockTag),
    safeCall(provider, rpc, addressBook.dataProvider, IFACE.dataProvider, "getReserveConfigurationData", [WEETH], blockTag),
    safeCall(provider, rpc, addressBook.pool, IFACE.pool, "getReserveData", [WETH], blockTag),
    safeCall(provider, rpc, addressBook.pool, IFACE.pool, "getReserveData", [WEETH], blockTag),
    safeCall(provider, rpc, addressBook.oracle, IFACE.oracle, "getAssetPrice", [WETH], blockTag),
    safeCall(provider, rpc, addressBook.oracle, IFACE.oracle, "getAssetPrice", [WEETH], blockTag),
  ]);

  const wethPrice = toBig(wethPriceRaw ? wethPriceRaw[0] : 0n);
  const weethPrice = toBig(weethPriceRaw ? weethPriceRaw[0] : 0n);
  if (wethPrice <= 0n || weethPrice <= 0n) blockers.push("oracle-price-unavailable");

  function reserveRow(symbol, asset, cfg, reserve, codeVerified) {
    if (!cfg && !reserve) {
      blockers.push(`reserve-config-unavailable:${symbol}`);
      return { symbol, asset, decimals: null, ltvBps: null, liquidationThresholdBps: null, liquidationBonusBps: null, active: null, frozen: null, paused: null, flashLoanEnabled: null, codeVerified, source: null };
    }
    const config = reserve ? toBig(reserve[0] && reserve[0][0] !== undefined ? reserve[0][0] : reserve[0]) : null;
    const bit = (n) => (config === null ? null : Number((config >> BigInt(n)) & 1n) === 1);
    const cfgDecimals = cfg ? Number(toBig(cfg[0])) : null;
    return {
      symbol,
      asset,
      decimals: cfgDecimals,
      ltvBps: cfg ? Number(toBig(cfg[1])) : (config !== null ? Number(config & 0xffffn) : null),
      liquidationThresholdBps: cfg ? Number(toBig(cfg[2])) : (config !== null ? Number((config >> 16n) & 0xffffn) : null),
      liquidationBonusBps: cfg ? Number(toBig(cfg[3])) : (config !== null ? Number((config >> 32n) & 0xffffn) : null),
      usageAsCollateralEnabled: cfg ? cfg[5] === true : null,
      borrowingEnabled: cfg ? cfg[6] === true : null,
      active: cfg ? cfg[8] === true : bit(56),
      frozen: cfg ? cfg[9] === true : bit(57),
      paused: bit(60),
      flashLoanEnabled: bit(63),
      codeVerified,
      source: "AaveProtocolDataProvider.getReserveConfigurationData + Pool.getReserveData(config) bitflags",
    };
  }

  const wethVerified = verified.find((row) => row.role === "weth")?.codeVerified === true;
  const weethVerified = verified.find((row) => row.role === "weeth")?.codeVerified === true;
  const reserveConfig = [
    reserveRow("WETH", WETH, wethCfg, wethReserve, wethVerified),
    reserveRow("weETH", WEETH, weethCfg, weethReserve, weethVerified),
  ];
  const weethBonusBps = reserveConfig[1].liquidationBonusBps || (topRow?.topCollateral?.liquidationBonusBps ?? 10_000);

  // ---- exact debt / collateral balances -------------------------------------
  const [wethUserReserve, weethUserReserve] = await Promise.all([
    safeCall(provider, rpc, addressBook.dataProvider, IFACE.dataProvider, "getUserReserveData", [WETH, borrower], blockTag),
    safeCall(provider, rpc, addressBook.dataProvider, IFACE.dataProvider, "getUserReserveData", [WEETH, borrower], blockTag),
  ]);
  const debtWeth = wethUserReserve ? toBig(wethUserReserve[2]) + toBig(wethUserReserve[1]) : 0n; // variable + stable
  const collateralWeeth = weethUserReserve ? toBig(weethUserReserve[0]) : 0n;
  if (!wethUserReserve) blockers.push("debt-token-balance-unavailable");
  if (!weethUserReserve) blockers.push("collateral-token-balance-unavailable");

  // ---- flash premium + gas --------------------------------------------------
  const [premiumTotalRaw, premiumToProtocolRaw, gasPriceHex] = await Promise.all([
    safeCall(provider, rpc, addressBook.pool, IFACE.pool, "FLASHLOAN_PREMIUM_TOTAL", [], blockTag),
    safeCall(provider, rpc, addressBook.pool, IFACE.pool, "FLASHLOAN_PREMIUM_TO_PROTOCOL", [], blockTag),
    rpc(provider, "eth_gasPrice", []).catch(() => null),
  ]);
  const flashPremiumBps = premiumTotalRaw ? Number(toBig(premiumTotalRaw[0])) : null;
  const flashPremiumToProtocolBps = premiumToProtocolRaw ? Number(toBig(premiumToProtocolRaw[0])) : null;
  if (flashPremiumBps === null) blockers.push("flash-premium-unavailable");
  const gasPriceWei = gasPriceHex ? toBig(gasPriceHex) : null;
  if (gasPriceWei === null || gasPriceWei <= 0n) blockers.push("gas-price-unavailable");

  // ---- balances / flash coverage --------------------------------------------
  const vaultWethBalance = toBig((await safeCall(provider, rpc, WETH, IFACE.erc20, "balanceOf", [BALANCER_VAULT], blockTag))?.[0]);
  // Balancer pool id: prefer the canonical aave-v3-balancer-weeth-pools.json
  // artifact (frees the balancer-pool-id-unavailable blocker); fall back to any
  // pool id recorded in prior route/readiness artifacts.
  const balancerPoolsArtifact = loadJson(BALANCER_POOLS_FILE, null);
  const balancerPoolFromArtifact = selectBalancerWeethPool(balancerPoolsArtifact);
  const priorBalancerPoolId = findRecordedBalancerPoolId(router) || findRecordedBalancerPoolId(readiness);
  const balancerPoolId = balancerPoolFromArtifact ? balancerPoolFromArtifact.poolId : priorBalancerPoolId;
  const balancerPoolSource = balancerPoolFromArtifact ? "balancer-pools-artifact" : (priorBalancerPoolId ? "prior-artifacts" : null);
  const balancerPoolDrainedAtObservation = balancerPoolFromArtifact ? balancerPoolFromArtifact.balancerPoolDrainedAtObservation : null;
  if (!balancerPoolId) blockers.push("balancer-pool-id-unavailable");

  // ---- uniswap pools (from prior readiness pool-list, re-verified live) ------
  const recordedPools = Array.isArray(readiness?.live?.uniswapPools) ? readiness.live.uniswapPools : [];
  const uniswapPools = [];
  for (const fee of [3000, 500, 100]) {
    let pool = norm(recordedPools.find((row) => Number(row.fee) === fee)?.pool);
    if (!pool) {
      const derived = await safeCall(provider, rpc, UNISWAP_V3_FACTORY, IFACE.factory, "getPool", [WEETH, WETH, fee], blockTag);
      pool = norm(derived ? derived[0] : null);
    }
    let codeVerified = false;
    if (pool) {
      try {
        const code = await rpc(provider, "eth_getCode", [pool, blockTag]);
        codeVerified = typeof code === "string" && /^0x[0-9a-fA-F]+$/.test(code) && code.length > 2;
      } catch (_) {
        codeVerified = false;
      }
    }
    verified.push({ role: `uniswap-v3-pool-${fee}`, address: pool, codeVerified });
    uniswapPools.push({ fee, pool, codeVerified });
    if (!pool || !codeVerified) blockers.push(`uniswap-pool-code-missing:${fee}`);
  }

  // ---- close-factor rule (LiquidationLogic.sol) ------------------------------
  const hfAboveThreshold = hfRaw > CLOSE_FACTOR_HF_THRESHOLD;
  const bothBaseAtLeastMin = totalCollateralBase >= MIN_BASE_MAX_CLOSE_FACTOR_THRESHOLD && totalDebtBase >= MIN_BASE_MAX_CLOSE_FACTOR_THRESHOLD;
  const close0_5Applicable = bothBaseAtLeastMin && hfAboveThreshold;
  const close1_0Applicable = !close0_5Applicable; // contract: whole reserve debt is liquidatable otherwise
  const hf = hfRaw; // 1e18
  const closeFactorRule = {
    source: "targets/aave-v3-origin-v3.7-cff15de/src/contracts/protocol/libraries/logic/LiquidationLogic.sol:43-72,258-282",
    defaultCloseFactor: 0.5,
    maxCloseFactor: 1.0,
    hfThreshold: "0.95",
    minBaseMaxCloseFactorThreshold: MIN_BASE_MAX_CLOSE_FACTOR_THRESHOLD.toString(),
    bothBaseAtLeastMin,
    hfAboveThreshold,
    close0_5Applicable,
    close1_0Applicable,
    rule: "close=1.0 by default; capped to close=0.5 only when both collateral and debt base values >= 2000e8 AND HF > 0.95.",
  };

  // ---- scenario sizing + quotes ---------------------------------------------
  const flashPremiumWeiFor = (repayWeth) => (flashPremiumBps === null ? null : (repayWeth * BigInt(flashPremiumBps)) / 10_000n);
  const gasCostWei = gasPriceWei !== null ? GAS_UNITS * gasPriceWei : null;

  const applicableCloses = [];
  if (close0_5Applicable) applicableCloses.push({ closeFactor: 0.5, numerator: 1n, denominator: 2n });
  if (close1_0Applicable) applicableCloses.push({ closeFactor: 1.0, numerator: 1n, denominator: 1n });
  const scenarios = [];
  const netRaw = [];

  for (const cf of applicableCloses) {
    const scenarioBlockers = [];
    const repayWeth = (debtWeth * cf.numerator) / cf.denominator;
    // grossCollateralSeized (weETH) = repayWeth * (bonusBps/10000) * priceWeth / priceWeeth
    const seizeWeeth = weethPrice > 0n ? (repayWeth * BigInt(weethBonusBps) * wethPrice) / (10_000n * weethPrice) : 0n;
    const collSeizedWeeth = MIN(seizeWeeth, collateralWeeth > 0n ? collateralWeeth : seizeWeeth);
    const fairOutWei = weethPrice > 0n ? (collSeizedWeeth * weethPrice) / wethPrice : 0n;

    const scenarioName = triggerMode
      ? "TRIGGER_ROW"
      : cf.closeFactor === 0.5
        ? (hf >= 10n ** 18n ? "READY_SIZING_CLOSE_0.5" : "TRIGGERED_CLOSE_0.5")
        : "TRIGGERED_CLOSE_1.0";

    const uniQuotes = await quoteUniswapPools(provider, rpc, uniswapPools, collSeizedWeeth, fairOutWei, blockTag);
    const uniBest = uniQuotes.map((row) => toBig(row.exactOutWei)).reduce((a, b) => (b > a ? b : a), 0n);
    const balancerQuote = await quoteBalancerExit(provider, rpc, balancerPoolId, collSeizedWeeth, repayWeth, blockTag);
    balancerQuote.source = balancerPoolSource;
    balancerQuote.balancerPoolDrainedAtObservation = balancerPoolDrainedAtObservation;
    const balancerBest = balancerQuote.kindGivenIn ? toBig(balancerQuote.kindGivenIn.exactOutWeth) : 0n;
    // A drained Balancer pool must never win the exit route: prefer Uniswap legs.
    const preferUniswap = balancerPoolDrainedAtObservation === true && uniBest > 0n;
    const exactOutWeth = preferUniswap ? uniBest : (uniBest > balancerBest ? uniBest : balancerBest);
    const bestVenue = exactOutWeth > 0n
      ? ((preferUniswap || uniBest >= balancerBest) ? "uniswap-v3-quoterV2" : "balancer-v2-queryBatchSwap")
      : null;

    if (collSeizedWeeth <= 0n) scenarioBlockers.push("sizing-unavailable");
    if (!uniQuotes.some((row) => row.exactOutWei)) scenarioBlockers.push("uniswap-exit-quote-missing");
    if (!balancerQuote.kindGivenIn || balancerQuote.kindGivenIn.exactOutWeth === null) {
      scenarioBlockers.push(balancerPoolDrainedAtObservation === true ? "balancer-pool-drained-at-observation" : "balancer-exit-quote-missing");
    }

    const flashPremiumWei = flashPremiumWeiFor(repayWeth);
    const flashCoverRatio = repayWeth > 0n ? Number((vaultWethBalance * 10_000n) / repayWeth) / 10_000 : null;
    const flashCovered = vaultWethBalance >= repayWeth;

    let netWei = null;
    if (exactOutWeth > 0n && flashPremiumWei !== null && gasCostWei !== null) {
      netWei = exactOutWeth - repayWeth - flashPremiumWei - gasCostWei;
    } else {
      scenarioBlockers.push("net-math-incomplete");
    }

    const minOutRows = SLIPPAGE_ROWS.map((bps) => ({
      slippageBps: bps,
      minOutNeededWei: exactOutWeth > 0n ? minOut(exactOutWeth, bps).toString() : null,
      venue: bestVenue,
    }));

    scenarios.push({
      scenario: scenarioName,
      closeFactor: cf.closeFactor,
      applicable: true,
      executable: false,
      pricing: "LIVE_QUOTES_REPORTED",
      sizing: {
        repayWeth: repayWeth.toString(),
        grossCollateralSeizedWeeth: seizeWeeth.toString(),
        collSeizedWeeth: collSeizedWeeth.toString(),
        liquidationBonusBps: weethBonusBps,
        bonusMultiplier: weethBonusBps / 10_000,
        priceWethUsd8: wethPrice.toString(),
        priceWeethUsd8: weethPrice.toString(),
        fairOutWeth: fairOutWei.toString(),
      },
      flashLeg: {
        assumedWethFlash: repayWeth.toString(),
        flashPremiumBps,
        flashPremiumWei: flashPremiumWei === null ? null : flashPremiumWei.toString(),
        flashCovered,
        coverRatio: flashCoverRatio,
        flashCoverMethod: "balancer-vault-weth-balance",
        balancerVault: BALANCER_VAULT,
      },
      quotes: { uniswap: uniQuotes, balancer: balancerQuote },
      exit: {
        bestVenue,
        exactOutWei: exactOutWeth > 0n ? exactOutWeth.toString() : null,
        minOut: minOutRows,
        balancerPoolDrainedAtObservation,
      },
      gasCostWei: gasCostWei === null ? null : gasCostWei.toString(),
      netWei: netWei === null ? null : netWei.toString(),
      routePositive: "unknown",
      executableNow: false,
      autoExecutable: false,
      signedActionJustified: false,
      forkJustified: triggerMode,
      blockers: scenarioBlockers,
    });
    netRaw.push({
      scenario: scenarioName,
      closeFactor: cf.closeFactor,
      repayWeth: repayWeth.toString(),
      collSeizedWeeth: collSeizedWeeth.toString(),
      exactOutWeth: exactOutWeth > 0n ? exactOutWeth.toString() : null,
      flashPremiumWei: flashPremiumWei === null ? null : flashPremiumWei.toString(),
      gasCostWei: gasCostWei === null ? null : gasCostWei.toString(),
      netWei: netWei === null ? null : netWei.toString(),
    });
  }

  const flashRowPresent = flashPremiumBps !== null && gasPriceWei !== null;
  const balancerRowPresent = Boolean(balancerQuotePresent(scenarios));
  const uniswapRowsPresent = uniswapPools.length === 3 && uniswapPools.every((row) => row.codeVerified) && scenarios.every((s) => s.quotes.uniswap.every((q) => q.exactOutWei));
  const exactQuoteComplete = flashRowPresent && balancerRowPresent && uniswapRowsPresent && scenarios.length > 0;
  if (!balancerRowPresent) blockers.push(balancerPoolDrainedAtObservation === true ? "balancer-pool-drained-at-observation" : "balancer-exit-quote-missing");
  if (!uniswapRowsPresent) blockers.push("uniswap-exit-quote-incomplete");
  if (!flashRowPresent) blockers.push("flash-leg-incomplete");
  blockers.push("route-positive-requires-fork-proof", "signed-action-requires-explicit-authorization");

  const finalBlockers = [...new Set(blockers)];
  return {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    scanner: "tools/quote-aave-v3-liquidation-exact.js",
    scope: "Read-only Aave V3 Ethereum exact-quote scaffold for the recorded WETH/weETH whale candidate",
    state: triggerMode ? "TRIGGER_ROW" : "READY_SIZING_CLOSE_0.5",
    chainId: CHAIN_ID,
    blockNumber: Number(BigInt(blockTag)),
    borrower,
    pool: addressBook.pool,
    readonly: true,
    rpcUrlsStored: false,
    pricing: "LIVE_QUOTES_REPORTED",
    routePositive: "unknown",
    executableNow: false,
    autoExecutable: false,
    signedActionJustified: false,
    forkJustified: triggerMode,
    exactQuoteComplete,
    liveAccountData: {
      totalCollateralBase: totalCollateralBase.toString(),
      totalDebtBase: totalDebtBase.toString(),
      availableBorrowsBase: availableBorrowsBase.toString(),
      currentLiquidationThresholdBps: liquidationThresholdBps,
      ltvBps,
      healthFactor: hfRaw.toString(),
      healthFactorDecimal: Number(hfRaw) / 1e18,
    },
    oraclePrices: {
      wethUsd8: wethPrice.toString(),
      weethUsd8: weethPrice.toString(),
      source: "Aave price oracle getAssetPrice (live)",
    },
    balances: { debtWeth: debtWeth.toString(), collateralWeeth: collateralWeeth.toString() },
    flash: {
      flashPremiumBpsTotal: flashPremiumBps,
      flashPremiumBpsToProtocol: flashPremiumToProtocolBps,
      balancerVaultWethDepth: vaultWethBalance.toString(),
      balancerPoolId,
      balancerPoolSource,
      balancerPoolDrainedAtObservation,
    },
    reserveConfig,
    closeFactorRule,
    venues: {
      balancerVault: BALANCER_VAULT,
      balancerPoolId,
      balancerPoolSource,
      balancerPoolDrainedAtObservation,
      balancerPool: balancerPoolFromArtifact ? {
        poolId: balancerPoolFromArtifact.poolId,
        poolAddress: balancerPoolFromArtifact.poolAddress,
        wethRaw: balancerPoolFromArtifact.wethRaw,
        weethRaw: balancerPoolFromArtifact.weethRaw,
        totalTrackedRaw: balancerPoolFromArtifact.totalTrackedRaw,
        observationBlock: balancerPoolFromArtifact.observationBlock,
        drainThresholdWei: DRAIN_THRESHOLD_WEI.toString(),
      } : null,
      uniswapQuoterV2: QUOTER_V2,
      uniswapPools,
      addressesProvider: addressBook.addressesProvider,
      dataProvider: addressBook.dataProvider,
      oracle: addressBook.oracle,
    },
    verifiedAddresses: verified,
    scenarios,
    netRaw,
    blockers: finalBlockers,
    sourceArtifacts: {
      route: path.basename(ROUTE_FILE),
      readiness: path.basename(READINESS_FILE),
      lIndex: lindex ? path.basename(LINDEX_FILE) : null,
      balancerPools: balancerPoolsArtifact ? path.basename(BALANCER_POOLS_FILE) : null,
      addressBook: path.relative(ROOT, ADDRESS_BOOK_FILE).replace(/\\/g, "/"),
    },
    timing: { wallMs: Date.now() - startedMs },
    requestsUsed: requestCount,
  };
}

function balancerQuotePresent(scenarios) {
  return scenarios.some((s) => s.quotes.balancer && s.quotes.balancer.kindGivenIn && s.quotes.balancer.kindGivenIn.exactOutWeth);
}

function persist(artifact, file = OUT) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(temp, JSON.stringify(artifact, jsonReplacer, 2) + "\n", { mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    try { fs.unlinkSync(temp); } catch (_) { /* already renamed */ }
  }
}

// Pure (no-RPC) trigger decision so both the READY_SIZING and TRIGGER_ROW watch
// states are locally testable. A trigger is any of: readiness/watch
// currentLiquidatable > 0, a summary/topRow/fallback HF below 1, or the live
// on-chain HF read below 1.
function decideTriggerState(readiness, fallback, liveHfDecimal) {
  const r = readiness || {};
  const s = r.summary || {};
  const topRow = r.topRow || {};
  const f = fallback || {};
  const fSummary = f.summary || {};
  const fLatest = f.latest || {};
  const currentLiquidatable = Math.max(
    toNum(s.currentLiquidatable), toNum(fSummary.currentLiquidatable), toNum(fLatest.currentLiquidatable),
  );
  const summaryHf = firstNum(s.currentHealthFactor, s.healthFactor);
  const topRowHf = firstNum(topRow.healthFactor);
  const fallbackHf = firstNum(fSummary.currentHealthFactor, fSummary.healthFactor, fLatest.healthFactor);
  const liveHf = firstNum(liveHfDecimal);
  const borrower = norm(topRow.user) || norm(topRow.borrower) || norm(fLatest.user) || BORROWER;
  const triggered = currentLiquidatable > 0
    || (summaryHf !== null && summaryHf < 1)
    || (topRowHf !== null && topRowHf < 1)
    || (fallbackHf !== null && fallbackHf < 1)
    || (liveHf !== null && liveHf < 1);
  const source = Object.keys(r).length ? "readiness" : (Object.keys(f).length ? "watch-fallback" : "none");
  return { triggered, borrower, source, currentLiquidatable, summaryHf, topRowHf, fallbackHf, liveHf };
}

// Relabel an already-computed exact-quote artifact as the live trigger artifact.
// Same math; forkJustified flips true because the fork-proof precondition is
// satisfied at the trigger point (the fail-closed gate chain still requires the
// fresh fork/staticCall/estimateGas proof before any signed action).
function buildTriggerArtifact(baseArtifact, triggerContext = {}) {
  const out = JSON.parse(JSON.stringify(baseArtifact, jsonReplacer));
  out.schema = TRIGGER_SCHEMA;
  out.generatedAt = new Date().toISOString();
  out.state = "TRIGGER_ROW";
  out.forkJustified = true;
  out.borrower = norm(triggerContext.borrower) || baseArtifact.borrower;
  out.triggerContext = {
    source: triggerContext.source || null,
    currentLiquidatable: triggerContext.currentLiquidatable ?? null,
    summaryHf: triggerContext.summaryHf ?? null,
    topRowHf: triggerContext.topRowHf ?? null,
    fallbackHf: triggerContext.fallbackHf ?? null,
    liveHf: triggerContext.liveHf ?? null,
  };
  out.scenarios = (out.scenarios || []).map((s) => ({ ...s, scenario: "TRIGGER_ROW", forkJustified: true }));
  out.netRaw = (out.netRaw || []).map((r) => ({ ...r, scenario: "TRIGGER_ROW" }));
  out.sourceArtifacts = { ...(out.sourceArtifacts || {}), triggerBase: path.basename(OUT) };
  out.routePositive = "unknown";
  out.executableNow = false;
  out.autoExecutable = false;
  out.signedActionJustified = false;
  return out;
}

function args(argv) {
  const out = { once: false, watch: false, seconds: DEFAULT_WATCH_SECONDS, maxRuns: DEFAULT_MAX_RUNS };
  if (!argv.length) { out.once = true; return out; }
  let sawOnce = false;
  let sawWatch = false;
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--once") { sawOnce = true; i += 1; continue; }
    if (arg === "--watch") {
      sawWatch = true;
      const next = argv[i + 1];
      if (next !== undefined && /^[0-9]+$/.test(next)) { out.seconds = Math.max(1, Number(next)); i += 2; }
      else i += 1;
      continue;
    }
    if (arg.startsWith("--watch=")) {
      sawWatch = true;
      const value = arg.slice("--watch=".length);
      if (!/^[0-9]+$/.test(value)) throw new Error("invalid-arguments");
      out.seconds = Math.max(1, Number(value));
      i += 1;
      continue;
    }
    if (arg === "--max-runs") {
      const next = argv[i + 1];
      if (next === undefined || !/^[0-9]+$/.test(next)) throw new Error("invalid-arguments");
      out.maxRuns = Math.max(1, Math.min(Number(next), 100000));
      i += 2;
      continue;
    }
    if (arg.startsWith("--max-runs=")) {
      const value = arg.slice("--max-runs=".length);
      if (!/^[0-9]+$/.test(value)) throw new Error("invalid-arguments");
      out.maxRuns = Math.max(1, Math.min(Number(value), 100000));
      i += 1;
      continue;
    }
    throw new Error("invalid-arguments");
  }
  if (sawOnce && sawWatch) throw new Error("invalid-arguments");
  out.watch = sawWatch;
  out.once = sawOnce || !sawWatch;
  return out;
}

function printSummary(artifact, extra = {}) {
  process.stdout.write(JSON.stringify({
    ok: true,
    state: artifact.state || null,
    blockNumber: artifact.blockNumber,
    borrower: artifact.borrower || null,
    healthFactor: artifact.liveAccountData ? artifact.liveAccountData.healthFactorDecimal : null,
    closeFactorRule: artifact.closeFactorRule ? {
      close0_5Applicable: artifact.closeFactorRule.close0_5Applicable,
      close1_0Applicable: artifact.closeFactorRule.close1_0Applicable,
    } : null,
    scenarios: (artifact.scenarios || []).map((s) => ({ scenario: s.scenario, closeFactor: s.closeFactor, executable: s.executable })),
    exactQuoteComplete: artifact.exactQuoteComplete === true,
    forkJustified: artifact.forkJustified === true,
    routePositive: artifact.routePositive,
    executableNow: artifact.executableNow,
    autoExecutable: artifact.autoExecutable,
    signedActionJustified: artifact.signedActionJustified,
    blockers: artifact.blockers,
    requestsUsed: artifact.requestsUsed || requestCount,
    artifact: path.relative(ROOT, OUT).replace(/\\/g, "/"),
    ...extra,
  }) + "\n");
}

async function runOnce() {
  let artifact;
  try { artifact = await run(); }
  catch (error) { artifact = emptyArtifact([safeCode(error)]); }
  try { persist(artifact, OUT); }
  catch (_) {
    process.stdout.write(JSON.stringify({ ok: false, reason: "artifact-write-failure" }) + "\n");
    process.exitCode = 1;
    return;
  }
  printSummary(artifact);
}

async function runWatch(opts) {
  for (let tick = 0; tick < opts.maxRuns; tick += 1) {
    let artifact;
    try { artifact = await run(); }
    catch (error) { artifact = emptyArtifact([safeCode(error)]); }
    try { persist(artifact, OUT); }
    catch (_) {
      process.stdout.write(JSON.stringify({ ok: false, reason: "artifact-write-failure" }) + "\n");
      process.exitCode = 1;
      return;
    }
    const readiness = loadJson(READINESS_FILE, null);
    const fallback = loadJson(WATCH_FALLBACK_FILE, null) || loadJson(WATCH_STATUS_FALLBACK_FILE, null);
    const liveHf = artifact.liveAccountData ? artifact.liveAccountData.healthFactorDecimal : null;
    const trigger = decideTriggerState(readiness, fallback, liveHf);
    let wroteTrigger = false;
    if (trigger.triggered) {
      const triggerArtifact = buildTriggerArtifact(artifact, trigger);
      try { persist(triggerArtifact, OUT_TRIGGER); wroteTrigger = true; } catch (_) { /* keep primary artifact */ }
    }
    printSummary(artifact, { tick: tick + 1, maxRuns: opts.maxRuns, trigger: trigger.triggered, wroteTrigger, triggerBorrower: trigger.borrower });
    if (tick < opts.maxRuns - 1) await sleep(Math.max(POLL_GAP_MS, opts.seconds * 1000));
  }
}

async function main(argv = process.argv.slice(2)) {
  let opts;
  try { opts = args(argv); }
  catch (_) {
    process.stdout.write(JSON.stringify({ ok: false, reason: "invalid-arguments" }) + "\n");
    process.exitCode = 1;
    return;
  }
  if (opts.once) { await runOnce(); return; }
  await runWatch(opts);
}

module.exports = {
  SCHEMA,
  TRIGGER_SCHEMA,
  MAX_REQUESTS,
  QUALIFICATION_BUDGET,
  DRAIN_THRESHOLD_WEI,
  OUT,
  OUT_TRIGGER,
  parseAddressBook,
  deriveAddressBook,
  findRecordedBalancerPoolId,
  selectBalancerWeethPool,
  encodePath,
  minOut,
  impactBps,
  decideTriggerState,
  buildTriggerArtifact,
  args,
  persist,
  run,
  main,
};

if (require.main === module) {
  main().catch(() => {
    process.stdout.write(JSON.stringify({ ok: false, reason: "artifact-write-failure" }) + "\n");
    process.exitCode = 1;
  });
}
