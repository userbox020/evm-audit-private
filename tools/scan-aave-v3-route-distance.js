#!/usr/bin/env node
// scan-aave-v3-route-distance.js - read-only Aave V3 multichain liquidation route-distance scanner.
// Resolves RPCs in memory only. Does not store RPC URLs, private keys, or send signed transactions.

const fs = require("fs");
const path = require("path");
const { rpcCall, resolveRpcPool, sanitizeError } = require("./shared-rpc");
const { buildAaveSourceCoverage } = require("./aave-source-coverage");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "aave-v3-route-distance.json");
const QUIET = process.argv.includes("--quiet");

const AAVE_POOLS = {
  1: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
  8453: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
  42161: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  10: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  137: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  43114: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  100: "0xb50201558B00496A145fE76f7424749556E326D8",
  534352: "0x11fCfe756c05AD438e312a7fd934381537D3cFfe",
  56: "0x6807dc923806fE8Fd134338EABCA509979a7e0cB",
};

const CHAIN_NAMES = {
  1: "Ethereum",
  8453: "Base",
  42161: "Arbitrum",
  10: "Optimism",
  137: "Polygon",
  43114: "Avalanche",
  100: "Gnosis",
  534352: "Scroll",
  56: "BSC",
};

const GAS_USD = {
  1: 45,
  8453: 1,
  42161: 2,
  10: 1,
  137: 0.5,
  43114: 1,
  100: 0.2,
  534352: 1.5,
  56: 0.8,
};

const SEED_BORROWERS = {
  // Existing HF-watch route from prior Phase 6 artifact / live monitor.
  1: ["0x1A557354C5b8d7Df38ea914209e416Dc7065b158"],
};

const SEL = {
  getUserAccountData: "0xbf92857c",
  getUserConfiguration: "0x4417a583",
  getReservesList: "0xd1946dbc",
  getReserveData: "0x35ea6a75",
  ADDRESSES_PROVIDER: "0x0542975c",
  getPriceOracle: "0xfca513a8",
  getAssetPrice: "0xb3596f07",
  balanceOf: "0x70a08231",
  symbol: "0x95d89b41",
};

const BORROW_TOPICS = [
  "0xb3d084820fb1a9decffb176436bd02558d15fac9b0ddfed8c465bc7359d7dce0", // enum encoded as uint8
  "0xc6a898309e823ee50bac64e45ca8adba6690e99e7841c45d754e2a38e9019d9b", // defensive uint256 variant
];

const LOOKBACK_BLOCKS = Number(process.env.AAVE_V3_ROUTE_LOOKBACK_BLOCKS || "80000");
const LOG_CHUNK_BLOCKS = Number(process.env.AAVE_V3_ROUTE_LOG_CHUNK_BLOCKS || "5000");
const MAX_USERS_PER_CHAIN = Number(process.env.AAVE_V3_ROUTE_MAX_USERS || "160");
const TOP_ENRICH_PER_CHAIN = Number(process.env.AAVE_V3_ROUTE_TOP_ENRICH || "6");
const HF_WATCH = Number(process.env.AAVE_V3_ROUTE_HF_WATCH || "1.05");
const HF_ENRICH = Number(process.env.AAVE_V3_ROUTE_HF_ENRICH || "1.05");
const MIN_DEBT_USD = Number(process.env.AAVE_V3_ROUTE_MIN_DEBT_USD || "5000");
const MATERIAL_DEBT_USD = Number(process.env.AAVE_V3_ROUTE_MATERIAL_DEBT_USD || "25000");
const FLASH_PREMIUM_BPS = Number(process.env.AAVE_V3_ROUTE_FLASH_PREMIUM_BPS || "5");
const CONSERVATIVE_SLIPPAGE_BPS = Number(process.env.AAVE_V3_ROUTE_SLIPPAGE_BPS || "50");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeAddress(value) {
  if (!value) return null;
  const text = String(value).toLowerCase();
  const m = text.match(/^0x[0-9a-f]{40}$/);
  return m ? text : null;
}

function addressArg(address) {
  return "000000000000000000000000" + String(address).replace(/^0x/, "").toLowerCase();
}

function addressFromWord(word) {
  if (!word || word.length < 40) return null;
  return normalizeAddress("0x" + word.slice(-40));
}

function addressFromTopic(topic) {
  if (!topic || topic.length !== 66) return null;
  return addressFromWord(topic.slice(2));
}

function words(raw) {
  if (!raw || raw === "0x") return [];
  const hex = raw.slice(2);
  const out = [];
  for (let i = 0; i + 64 <= hex.length; i += 64) out.push(hex.slice(i, i + 64));
  return out;
}

function wordBigInt(raw, index) {
  const ws = words(raw);
  if (!ws[index]) return 0n;
  return BigInt("0x" + ws[index]);
}

function wordAddress(raw, index) {
  const ws = words(raw);
  return addressFromWord(ws[index]);
}

function round(value, decimals = 2) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  const f = 10 ** decimals;
  return Math.round(Number(value) * f) / f;
}

function formatUnits(value, decimals) {
  const raw = BigInt(value || 0);
  const d = Math.max(0, Number(decimals || 0));
  if (raw === 0n) return 0;
  if (d === 0) return Number(raw);
  const s = raw.toString().padStart(d + 1, "0");
  const whole = s.slice(0, -d) || "0";
  const frac = s.slice(-d).replace(/0+$/, "").slice(0, 12);
  return Number(whole + (frac ? "." + frac : ""));
}

function decodeAccountData(raw) {
  const ws = words(raw);
  if (ws.length < 6) return null;
  const hfRaw = BigInt("0x" + ws[5]);
  return {
    totalCollateralUsd: Number(BigInt("0x" + ws[0])) / 1e8,
    totalDebtUsd: Number(BigInt("0x" + ws[1])) / 1e8,
    availableBorrowsUsd: Number(BigInt("0x" + ws[2])) / 1e8,
    currentLiquidationThresholdBps: Number(BigInt("0x" + ws[3])),
    ltvBps: Number(BigInt("0x" + ws[4])),
    healthFactor: hfRaw > 10n ** 36n ? 999 : Number(hfRaw) / 1e18,
  };
}

function decodeStringResult(raw) {
  if (!raw || raw === "0x") return null;
  const ws = words(raw);
  try {
    if (ws.length >= 3 && BigInt("0x" + ws[0]) === 32n) {
      const len = Number(BigInt("0x" + ws[1]));
      if (len > 0 && len <= 128) {
        const data = raw.slice(2 + 64 * 2, 2 + 64 * 2 + len * 2);
        const text = Buffer.from(data, "hex").toString("utf8").replace(/[^\x20-\x7e]/g, "").trim();
        return text || null;
      }
    }
    if (ws.length >= 1) {
      const data = ws[0].replace(/(00)+$/g, "");
      if (data) {
        const text = Buffer.from(data, "hex").toString("utf8").replace(/[^\x20-\x7e]/g, "").trim();
        return text || null;
      }
    }
  } catch (_) {}
  return null;
}

function decodeReservesList(raw) {
  const ws = words(raw);
  if (ws.length < 2) return [];
  const offset = Number(BigInt("0x" + ws[0]) / 32n);
  const length = Number(BigInt("0x" + (ws[offset] || "0")));
  const reserves = [];
  for (let i = 0; i < length; i++) {
    const addr = addressFromWord(ws[offset + 1 + i]);
    if (addr) reserves.push(addr);
  }
  return reserves;
}

function decodeReserveData(asset, raw, priceUsd, symbol) {
  const ws = words(raw);
  if (ws.length < 11) return null;
  const config = BigInt("0x" + ws[0]);
  const mask16 = 0xffffn;
  const mask36 = (1n << 36n) - 1n;
  const liquidationBonusBps = Number((config >> 32n) & mask16);
  return {
    asset,
    symbol: symbol || asset.slice(0, 10),
    configRaw: "0x" + ws[0],
    ltvBps: Number(config & mask16),
    liquidationThresholdBps: Number((config >> 16n) & mask16),
    liquidationBonusBps,
    bonusBps: Math.max(0, liquidationBonusBps - 10000),
    decimals: Number((config >> 48n) & 0xffn),
    active: ((config >> 56n) & 1n) === 1n,
    frozen: ((config >> 57n) & 1n) === 1n,
    borrowingEnabled: ((config >> 58n) & 1n) === 1n,
    paused: ((config >> 60n) & 1n) === 1n,
    flashLoanEnabled: ((config >> 63n) & 1n) === 1n,
    borrowCapTokens: Number((config >> 80n) & mask36),
    supplyCapTokens: Number((config >> 116n) & mask36),
    id: Number(BigInt("0x" + ws[7])),
    aToken: addressFromWord(ws[8]),
    stableDebtToken: addressFromWord(ws[9]),
    variableDebtToken: addressFromWord(ws[10]),
    priceUsd,
  };
}

async function ethCall(rpc, to, selector, args = "", timeout = 10000) {
  return rpcCall(rpc, "eth_call", [{ to, data: selector + args }, "latest"], timeout);
}

async function discoverBorrowers(rpc, pool, options = {}) {
  const call = options.rpcCall || rpcCall;
  const pause = options.sleep || sleep;
  let blockHex = null;
  try { blockHex = await call(rpc, "eth_blockNumber", [], 10000); } catch (_) {}
  if (!blockHex) return { latestBlock: null, fromBlock: null, observedRange: { fromBlock: null, toBlock: null }, historyScope: "RECENT_BLOCK_SUFFIX", historyStartBound: null, fullHistoryProven: false, borrowers: [], logRows: 0, chunks: 0, chunksSucceeded: 0, chunksFailed: 0, truncationLimit: MAX_USERS_PER_CHAIN, wasTruncated: false, errors: ["block-read-failed"] };
  const latestBlock = Number(BigInt(blockHex));
  const configuredBound = options.historyStartBound;
  const explicitBoundProven = configuredBound
    && Number.isSafeInteger(configuredBound.block)
    && configuredBound.block >= 0
    && configuredBound.block <= latestBlock
    && configuredBound.proven === true
    && typeof configuredBound.proof === "string"
    && configuredBound.proof.trim().length > 0;
  const fromBlock = explicitBoundProven ? configuredBound.block : Math.max(0, latestBlock - LOOKBACK_BLOCKS);
  const historyStartBound = fromBlock === 0
    ? { block: 0, kind: "genesis", proven: true, proof: "genesis" }
    : explicitBoundProven ? { ...configuredBound } : null;
  const fullHistoryProven = fromBlock === 0 || Boolean(explicitBoundProven);
  const historyScope = fromBlock === 0 ? "GENESIS_TO_TIP" : explicitBoundProven ? "PROVEN_START_TO_TIP" : "RECENT_BLOCK_SUFFIX";
  const seen = new Set();
  let logRows = 0;
  let chunks = 0;
  let chunksSucceeded = 0;
  let chunksFailed = 0;

  for (let to = latestBlock; to >= fromBlock; to -= LOG_CHUNK_BLOCKS) {
    const from = Math.max(fromBlock, to - LOG_CHUNK_BLOCKS + 1);
    let logs = null;
    try {
      logs = await call(rpc, "eth_getLogs", [{
        fromBlock: "0x" + from.toString(16),
        toBlock: "0x" + to.toString(16),
        address: pool,
        topics: [BORROW_TOPICS],
      }], 20000);
    } catch (_) {}
    chunks += 1;
    if (!Array.isArray(logs)) {
      chunksFailed += 1;
      continue;
    }
    chunksSucceeded += 1;
    logRows += logs.length;
    for (const log of logs.slice().reverse()) {
      const borrower = addressFromTopic(log.topics?.[2]);
      if (borrower) seen.add(borrower);
    }
    await pause(25);
  }

  return { latestBlock, fromBlock, observedRange: { fromBlock, toBlock: latestBlock }, historyScope, historyStartBound, fullHistoryProven, borrowers: [...seen], logRows, chunks, chunksSucceeded, chunksFailed, truncationLimit: MAX_USERS_PER_CHAIN, wasTruncated: seen.size > MAX_USERS_PER_CHAIN, errors: chunksFailed ? ["log-query-failed"] : [] };
}

async function getPriceOracle(rpc, pool) {
  const providerRaw = await ethCall(rpc, pool, SEL.ADDRESSES_PROVIDER, "", 10000);
  const provider = wordAddress(providerRaw, 0);
  if (!provider) return null;
  const oracleRaw = await ethCall(rpc, provider, SEL.getPriceOracle, "", 10000);
  return wordAddress(oracleRaw, 0);
}

async function loadReserves(rpc, pool) {
  const listRaw = await ethCall(rpc, pool, SEL.getReservesList, "", 15000);
  const reserveAddresses = decodeReservesList(listRaw);
  const oracle = await getPriceOracle(rpc, pool);
  if (!listRaw || reserveAddresses.length === 0 || !oracle) throw new Error("reserve-state-unavailable");
  const reserves = [];

  for (const asset of reserveAddresses) {
    const [reserveRaw, symbolRaw, priceRaw] = await Promise.all([
      ethCall(rpc, pool, SEL.getReserveData, addressArg(asset), 15000),
      ethCall(rpc, asset, SEL.symbol, "", 8000),
      oracle ? ethCall(rpc, oracle, SEL.getAssetPrice, addressArg(asset), 8000) : Promise.resolve(null),
    ]);
    const priceUsd = priceRaw && priceRaw !== "0x" ? Number(wordBigInt(priceRaw, 0)) / 1e8 : null;
    const reserve = decodeReserveData(asset, reserveRaw, priceUsd, decodeStringResult(symbolRaw));
    if (!reserve || !symbolRaw || !priceRaw) throw new Error("reserve-read-failed");
    reserves.push(reserve);
  }

  return { oracle, reserves };
}

function collateralEnabled(userConfig, reserveId) {
  return ((userConfig >> BigInt(reserveId * 2 + 1)) & 1n) === 1n;
}

function borrowEnabledForUser(userConfig, reserveId) {
  return ((userConfig >> BigInt(reserveId * 2)) & 1n) === 1n;
}

async function tokenBalance(rpc, token, user) {
  if (!token || /^0x0{40}$/.test(token)) return 0n;
  const raw = await ethCall(rpc, token, SEL.balanceOf, addressArg(user), 8000);
  if (!raw || raw === "0x") throw new Error("balance-read-failed");
  return wordBigInt(raw, 0);
}

async function enrichBorrower(rpc, pool, user, account, reserveState) {
  const userConfigRaw = await ethCall(rpc, pool, SEL.getUserConfiguration, addressArg(user), 10000);
  if (!userConfigRaw || userConfigRaw === "0x") throw new Error("user-config-read-failed");
  const userConfig = userConfigRaw ? wordBigInt(userConfigRaw, 0) : 0n;
  const supplied = [];
  const debts = [];

  for (const reserve of reserveState.reserves) {
    const [aBal, stableDebt, variableDebt] = await Promise.all([
      tokenBalance(rpc, reserve.aToken, user),
      tokenBalance(rpc, reserve.stableDebtToken, user),
      tokenBalance(rpc, reserve.variableDebtToken, user),
    ]);
    const supplyAmount = formatUnits(aBal, reserve.decimals);
    const stableDebtAmount = formatUnits(stableDebt, reserve.decimals);
    const variableDebtAmount = formatUnits(variableDebt, reserve.decimals);
    const debtAmount = stableDebtAmount + variableDebtAmount;
    const priceUsd = Number(reserve.priceUsd || 0);
    const supplyUsd = priceUsd > 0 ? supplyAmount * priceUsd : 0;
    const debtUsd = priceUsd > 0 ? debtAmount * priceUsd : 0;
    const asCollateral = collateralEnabled(userConfig, reserve.id);
    const userBorrowing = borrowEnabledForUser(userConfig, reserve.id);

    if (supplyUsd > 1 || (supplyAmount > 0 && asCollateral)) {
      supplied.push({
        asset: reserve.asset,
        symbol: reserve.symbol,
        amount: round(supplyAmount, 8),
        usd: round(supplyUsd, 2),
        asCollateral,
        liquidationBonusBps: reserve.liquidationBonusBps,
        bonusBps: reserve.bonusBps,
        ltvBps: reserve.ltvBps,
        liquidationThresholdBps: reserve.liquidationThresholdBps,
        paused: reserve.paused,
        frozen: reserve.frozen,
      });
    }
    if (debtUsd > 1 || debtAmount > 0) {
      debts.push({
        asset: reserve.asset,
        symbol: reserve.symbol,
        amount: round(debtAmount, 8),
        stableDebtAmount: round(stableDebtAmount, 8),
        variableDebtAmount: round(variableDebtAmount, 8),
        usd: round(debtUsd, 2),
        borrowingEnabled: reserve.borrowingEnabled,
        userBorrowing,
        paused: reserve.paused,
        flashLoanEnabled: reserve.flashLoanEnabled,
      });
    }
  }

  supplied.sort((a, b) => (b.usd || 0) - (a.usd || 0));
  debts.sort((a, b) => (b.usd || 0) - (a.usd || 0));
  const topCollateral = supplied.find((row) => row.asCollateral && (row.usd || 0) > 0) || supplied[0] || null;
  const topDebt = debts[0] || null;
  const economics = estimateLiquidationEconomics(account, topCollateral, topDebt);
  return { topCollateral, topDebt, supplied: supplied.slice(0, 5), debts: debts.slice(0, 5), economics };
}

function estimateLiquidationEconomics(account, topCollateral, topDebt) {
  if (!account || !topCollateral || !topDebt) {
    return {
      grossBonusUsd: null,
      conservativeCostUsd: null,
      shadowNetUsd: null,
      blocker: "Missing decoded top collateral or debt asset; exact quote required",
    };
  }
  const debtUsd = Number(account.totalDebtUsd || 0);
  const collateralUsd = Number(topCollateral.usd || 0);
  const topDebtUsd = Number(topDebt.usd || 0);
  const bonusBps = Math.max(0, Number(topCollateral.bonusBps || 0));
  const closeFactor = Number(account.healthFactor || 2) < 0.95 ? 1 : 0.5;
  const maxRepayByCollateral = bonusBps >= 0 ? collateralUsd / (1 + bonusBps / 10000) : collateralUsd;
  const repayUsd = Math.max(0, Math.min(debtUsd * closeFactor, topDebtUsd, maxRepayByCollateral));
  const grossBonusUsd = repayUsd * bonusBps / 10000;
  const chainGasUsd = GAS_USD[account.chainId] ?? 5;
  const conservativeCostUsd = chainGasUsd + repayUsd * (FLASH_PREMIUM_BPS + CONSERVATIVE_SLIPPAGE_BPS) / 10000;
  const shadowNetUsd = grossBonusUsd - conservativeCostUsd;
  return {
    closeFactor,
    repayUsd: round(repayUsd, 2),
    grossBonusUsd: round(grossBonusUsd, 2),
    conservativeCostUsd: round(conservativeCostUsd, 2),
    shadowNetUsd: round(shadowNetUsd, 2),
    chainGasUsd,
    flashPremiumBps: FLASH_PREMIUM_BPS,
    conservativeSlippageBps: CONSERVATIVE_SLIPPAGE_BPS,
    exactQuoteMissing: true,
    blocker: "Shadow liquidation bonus is not an executable route; exact repay acquisition, collateral exit, staticCall, gas, and fork proof are still missing",
  };
}

function summarizeRow(row) {
  const hf = Number(row.healthFactor || 999);
  const debtUsd = Number(row.totalDebtUsd || 0);
  const econ = row.economics || {};
  const shadowNetUsd = Number(econ.shadowNetUsd || 0);
  const liquidatable = hf < 1;
  let status = "borrower-distance-only";
  if (liquidatable && shadowNetUsd > 0) status = "liquidatable-shadow-positive-needs-exact-quotes-and-fork";
  else if (liquidatable) status = "liquidatable-needs-exact-quotes";
  else if (hf <= 1.01) status = "critical-near-liquidation-watch";
  else if (hf <= HF_WATCH) status = "near-liquidation-watch";

  return {
    chainId: row.chainId,
    chain: CHAIN_NAMES[row.chainId] || `c${row.chainId}`,
    pool: row.pool,
    user: row.user,
    status,
    healthFactor: round(hf, 6),
    bpsToLiquidation: round((hf - 1) * 10000, 2),
    totalDebtUsd: round(debtUsd, 2),
    totalCollateralUsd: round(row.totalCollateralUsd, 2),
    availableBorrowsUsd: round(row.availableBorrowsUsd, 2),
    currentLiquidationThresholdBps: row.currentLiquidationThresholdBps,
    ltvBps: row.ltvBps,
    materialDebt: debtUsd >= MATERIAL_DEBT_USD,
    liquidatable,
    topDebt: row.topDebt ? {
      symbol: row.topDebt.symbol,
      asset: row.topDebt.asset,
      usd: round(row.topDebt.usd, 2),
      amount: row.topDebt.amount,
      flashLoanEnabled: row.topDebt.flashLoanEnabled,
      paused: row.topDebt.paused,
    } : null,
    topCollateral: row.topCollateral ? {
      symbol: row.topCollateral.symbol,
      asset: row.topCollateral.asset,
      usd: round(row.topCollateral.usd, 2),
      amount: row.topCollateral.amount,
      bonusBps: row.topCollateral.bonusBps,
      liquidationBonusBps: row.topCollateral.liquidationBonusBps,
      paused: row.topCollateral.paused,
      frozen: row.topCollateral.frozen,
    } : null,
    economics: econ,
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
  };
}

async function scanChain(chainId, pool, rpc, options = {}) {
  const chain = CHAIN_NAMES[chainId] || `c${chainId}`;
  if (!QUIET) console.log(`${chain} (c${chainId}) borrow-event discovery...`);
  const discovery = await (options.discoverBorrowers || discoverBorrowers)(rpc, pool, options);
  const borrowers = [];
  const seen = new Set();
  for (const addr of [...(SEED_BORROWERS[chainId] || []).map((a) => a.toLowerCase()), ...discovery.borrowers]) {
    const normalized = normalizeAddress(addr);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      borrowers.push(normalized);
    }
  }

  const rows = [];
  let checked = 0;
  let accountReadsSucceeded = 0;
  let accountReadsFailed = 0;
  const selectedBorrowers = borrowers.slice(0, MAX_USERS_PER_CHAIN);
  const wasTruncated = borrowers.length > MAX_USERS_PER_CHAIN || discovery.wasTruncated;
  const callAccount = options.ethCall || ethCall;
  for (const user of selectedBorrowers) {
    let raw = null;
    try { raw = await callAccount(rpc, pool, SEL.getUserAccountData, addressArg(user), 10000); } catch (_) {}
    checked += 1;
    const data = decodeAccountData(raw);
    if (data) accountReadsSucceeded += 1;
    else accountReadsFailed += 1;
    if (!data || data.totalDebtUsd < MIN_DEBT_USD) continue;
    rows.push({ chainId, chain, pool, user, ...data });
    await (options.sleep || sleep)(10);
  }
  rows.sort((a, b) => (a.healthFactor - b.healthFactor) || (b.totalDebtUsd - a.totalDebtUsd));

  const enrichRows = rows
    .filter((row) => row.healthFactor <= HF_ENRICH)
    .slice(0, TOP_ENRICH_PER_CHAIN);

  let reserveState = { oracle: null, reserves: [] };
  let reserveReadsAttempted = 0;
  let reserveReadsSucceeded = 0;
  let reserveReadsFailed = 0;
  if (enrichRows.length) {
    try { reserveState = await (options.loadReserves || loadReserves)(rpc, pool); } catch (_) { reserveState = { oracle: null, reserves: [] }; }
    for (const row of enrichRows) {
      reserveReadsAttempted += 1;
      try {
        if (!reserveState.reserves.length) throw new Error("reserve-state-unavailable");
        const enriched = await (options.enrichBorrower || enrichBorrower)(rpc, pool, row.user, row, reserveState);
        Object.assign(row, enriched);
        reserveReadsSucceeded += 1;
      } catch (_) {
        reserveReadsFailed += 1;
        row.enrichmentError = "reserve-read-failed";
      }
    }
  }

  const summarized = rows.map(summarizeRow);
  const currentLiquidatable = summarized.filter((row) => row.liquidatable).length;
  const materialLiquidatable = summarized.filter((row) => row.liquidatable && row.materialDebt).length;
  const watchCandidates = summarized.filter((row) => row.healthFactor <= HF_WATCH && row.totalDebtUsd >= MIN_DEBT_USD).length;
  const shadowPositiveRows = summarized.filter((row) => Number(row.economics?.shadowNetUsd || 0) > 0 && row.liquidatable).length;
  const closest = summarized[0] || null;
  const bestShadow = summarized.slice().sort((a, b) => (Number(b.economics?.shadowNetUsd || -Infinity) - Number(a.economics?.shadowNetUsd || -Infinity)))[0] || null;

  if (!QUIET) {
    const bestHf = closest ? closest.healthFactor.toFixed(5) : "n/a";
    console.log(`  borrowers=${borrowers.length} checked=${checked} rows=${rows.length} watch=${watchCandidates} liquidatable=${currentLiquidatable} bestHF=${bestHf}`);
  }

  return {
    chainId,
    chain,
    pool,
    latestBlock: discovery.latestBlock,
    fromBlock: discovery.fromBlock,
    observedRange: discovery.observedRange || { fromBlock: discovery.fromBlock ?? null, toBlock: discovery.latestBlock ?? null },
    historyScope: discovery.historyScope || "RECENT_BLOCK_SUFFIX",
    historyStartBound: discovery.historyStartBound || null,
    fullHistoryProven: discovery.fullHistoryProven === true,
    lookbackBlocks: LOOKBACK_BLOCKS,
    borrowLogRows: discovery.logRows,
    logChunks: discovery.chunks,
    logChunksSucceeded: discovery.chunksSucceeded,
    logChunksFailed: discovery.chunksFailed,
    borrowersDiscovered: borrowers.length,
    borrowersWithSeeds: borrowers.length,
    accountDataChecked: checked,
    accountReadsAttempted: checked,
    accountReadsSucceeded,
    accountReadsFailed,
    reserveReadsAttempted,
    reserveReadsSucceeded,
    reserveReadsFailed,
    truncationLimit: MAX_USERS_PER_CHAIN,
    wasTruncated,
    coverageErrors: discovery.errors || [],
    rowsPassingDebtGate: rows.length,
    reservesDecoded: reserveState.reserves.length,
    oracle: reserveState.oracle,
    summary: {
      watchCandidates,
      currentLiquidatable,
      materialLiquidatable,
      shadowPositiveRows,
      bestHealthFactor: closest?.healthFactor ?? null,
      bestBpsToLiquidation: closest?.bpsToLiquidation ?? null,
      bestDebtUsd: closest?.totalDebtUsd ?? null,
      bestShadowNetUsd: bestShadow?.economics?.shadowNetUsd ?? null,
    },
    topRows: summarized.slice(0, 10),
  };
}

function buildRouteSourceCoverage(chains, requiredChainIds = Object.keys(AAVE_POOLS).map(Number)) {
  const successful = chains.filter((chain) => !chain.error);
  const sum = (key) => successful.reduce((total, chain) => total + (Number.isInteger(chain[key]) ? chain[key] : 0), 0);
  const logChunksAttempted = sum("logChunks");
  const logChunksSucceeded = sum("logChunksSucceeded");
  const logChunksFailed = sum("logChunksFailed");
  const discoveredBorrowers = sum("borrowersDiscovered");
  const checkedBorrowers = sum("accountDataChecked");
  const accountReadsAttempted = sum("accountReadsAttempted");
  const accountReadsSucceeded = sum("accountReadsSucceeded");
  const accountReadsFailed = sum("accountReadsFailed");
  const reserveReadsAttempted = sum("reserveReadsAttempted");
  const reserveReadsSucceeded = sum("reserveReadsSucceeded");
  const reserveReadsFailed = sum("reserveReadsFailed");
  const errors = [];
  const observedChainIds = successful.map((chain) => chain.chainId);
  const observedRanges = successful.map((chain) => ({
    chainId: chain.chainId,
    fromBlock: chain.observedRange?.fromBlock ?? chain.fromBlock ?? null,
    toBlock: chain.observedRange?.toBlock ?? chain.latestBlock ?? null,
  }));
  const chainHasFullHistory = (chain) => {
    const fromBlock = chain.observedRange?.fromBlock ?? chain.fromBlock;
    const toBlock = chain.observedRange?.toBlock ?? chain.latestBlock;
    if (!Number.isSafeInteger(fromBlock) || !Number.isSafeInteger(toBlock) || fromBlock < 0 || toBlock < fromBlock) return false;
    if (fromBlock === 0) return true;
    const bound = chain.historyStartBound;
    return chain.fullHistoryProven === true
      && bound?.proven === true
      && bound.block === fromBlock
      && typeof bound.proof === "string"
      && bound.proof.trim().length > 0;
  };
  const fullHistoryProven = successful.length === requiredChainIds.length && successful.every(chainHasFullHistory);
  const requiredSet = new Set(requiredChainIds.map(Number));
  if (successful.length !== requiredChainIds.length || observedChainIds.some((id) => !requiredSet.has(Number(id)))) errors.push("required-chain-coverage-incomplete");
  if (logChunksAttempted === 0) errors.push("log-chunk-coverage-empty");
  if (logChunksFailed > 0 || logChunksSucceeded !== logChunksAttempted) errors.push("log-chunk-failed");
  if (successful.some((chain) => chain.wasTruncated)) errors.push("borrower-truncated");
  if (discoveredBorrowers !== checkedBorrowers || checkedBorrowers !== accountReadsAttempted) errors.push("borrower-check-incomplete");
  if (accountReadsFailed > 0 || accountReadsSucceeded !== accountReadsAttempted) errors.push("account-read-failed");
  if (reserveReadsFailed > 0 || reserveReadsSucceeded !== reserveReadsAttempted) errors.push("reserve-read-failed");
  for (const chain of chains) {
    if (chain.error) errors.push("required-chain-failed");
    for (const code of chain.coverageErrors || []) errors.push(["block-read-failed", "log-query-failed"].includes(code) ? code : "source-error");
  }
  const uniqueErrors = [...new Set(errors)];
  const sampleComplete = uniqueErrors.length === 0;
  const exhaustiveProof = fullHistoryProven ? {
    type: "EXACT_FULL_HISTORY_OR_DEPLOYMENT_BOUNDS",
    exact: true,
    evidence: successful.map(chain => `${chain.chainId}:${chain.observedRange?.fromBlock ?? chain.fromBlock}`).join(","),
  } : null;
  return buildAaveSourceCoverage("V3", "route-scan", {
    complete: sampleComplete && fullHistoryProven,
    sampleComplete,
    historyScope: fullHistoryProven ? "FULL_HISTORY" : "RECENT_BLOCK_SUFFIX",
    fullHistoryProven,
    exhaustiveProof,
    observedRanges,
    blocker: sampleComplete && fullHistoryProven ? null : !fullHistoryProven
      ? "Borrower discovery covers only recent block suffixes; full active-position history is not proven."
      : "One or more required discovery or state-read sources are incomplete.",
    chainsExpected: requiredChainIds.length,
    chainsObserved: successful.length,
    requiredChainIds: requiredChainIds.slice(),
    observedChainIds,
    logChunksAttempted,
    logChunksSucceeded,
    logChunksFailed,
    discoveredBorrowers,
    checkedBorrowers,
    accountReadsAttempted,
    accountReadsSucceeded,
    accountReadsFailed,
    reserveReadsAttempted,
    reserveReadsSucceeded,
    reserveReadsFailed,
    stateReadsAttempted: accountReadsAttempted + reserveReadsAttempted,
    stateReadsSucceeded: accountReadsSucceeded + reserveReadsSucceeded,
    stateReadsFailed: accountReadsFailed + reserveReadsFailed,
    truncationLimit: MAX_USERS_PER_CHAIN,
    wasTruncated: successful.some((chain) => chain.wasTruncated),
    errors: uniqueErrors,
  });
}

async function main() {
  const chainIds = Object.keys(AAVE_POOLS).map(Number);
  const rpcPool = await resolveRpcPool(chainIds);
  const chains = [];

  for (const chainId of chainIds) {
    const rpc = rpcPool[chainId];
    const pool = AAVE_POOLS[chainId];
    if (!rpc) {
      chains.push({ chainId, chain: CHAIN_NAMES[chainId] || `c${chainId}`, pool, error: "no-rpc" });
      continue;
    }
    try {
      chains.push(await scanChain(chainId, pool, rpc));
    } catch (e) {
      chains.push({ chainId, chain: CHAIN_NAMES[chainId] || `c${chainId}`, pool, error: sanitizeError(e, "scan-error") });
      if (!QUIET) console.log("  error: scan-error");
    }
  }

  const allRows = chains.flatMap((chain) => chain.topRows || []);
  allRows.sort((a, b) => (a.healthFactor - b.healthFactor) || (b.totalDebtUsd - a.totalDebtUsd));
  const shadowRanked = allRows.slice().sort((a, b) => Number(b.economics?.shadowNetUsd || -Infinity) - Number(a.economics?.shadowNetUsd || -Infinity));
  const summary = {
    chainsRequested: chainIds.length,
    chainsResolved: Object.keys(rpcPool).filter((cid) => rpcPool[cid]).length,
    chainsScanned: chains.filter((chain) => !chain.error).length,
    borrowersDiscovered: chains.reduce((acc, chain) => acc + (chain.borrowersDiscovered || 0), 0),
    accountDataChecked: chains.reduce((acc, chain) => acc + (chain.accountDataChecked || 0), 0),
    rowsPassingDebtGate: chains.reduce((acc, chain) => acc + (chain.rowsPassingDebtGate || 0), 0),
    watchCandidates: chains.reduce((acc, chain) => acc + (chain.summary?.watchCandidates || 0), 0),
    currentLiquidatable: chains.reduce((acc, chain) => acc + (chain.summary?.currentLiquidatable || 0), 0),
    materialLiquidatable: chains.reduce((acc, chain) => acc + (chain.summary?.materialLiquidatable || 0), 0),
    shadowPositiveRows: chains.reduce((acc, chain) => acc + (chain.summary?.shadowPositiveRows || 0), 0),
    exactEconomicsRows: 0,
    rowsWithAnyQuote: 0,
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    bestHealthFactor: allRows[0]?.healthFactor ?? null,
    bestBpsToLiquidation: allRows[0]?.bpsToLiquidation ?? null,
    bestDebtUsd: allRows[0]?.totalDebtUsd ?? null,
    bestShadowNetUsd: shadowRanked[0]?.economics?.shadowNetUsd ?? null,
    blocker: "No Aave V3 row has exact repay-token acquisition quote, collateral-exit quote, fork proof, or signed-action authorization",
  };
  const sourceCoverage = buildRouteSourceCoverage(chains, chainIds);

  const out = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-aave-v3-route-distance.js",
    scope: "Read-only Aave V3 multichain near-liquidation route-distance scan",
    classification: sourceCoverage.classification,
    complete: sourceCoverage.complete,
    blocker: sourceCoverage.blocker,
    sourceCoverage,
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      routePositive: false,
      executableNow: false,
      signedActionJustified: false,
    },
    thresholds: {
      lookbackBlocks: LOOKBACK_BLOCKS,
      maxUsersPerChain: MAX_USERS_PER_CHAIN,
      minDebtUsd: MIN_DEBT_USD,
      materialDebtUsd: MATERIAL_DEBT_USD,
      hfWatch: HF_WATCH,
      hfEnrich: HF_ENRICH,
      flashPremiumBps: FLASH_PREMIUM_BPS,
      conservativeSlippageBps: CONSERVATIVE_SLIPPAGE_BPS,
    },
    gates: {
      routePositiveRequires: [
        "current HF < 1.0 for a material borrower",
        "decoded debt and collateral assets with liquidation bonus",
        "exact repay-token acquisition quote at debtToCover size",
        "exact seized-collateral exit quote at expected seize size",
        "gas/slippage/flash-premium adjusted net profit > 0",
        "fork extraction proof or staticCall/estimateGas proof before signed action",
      ],
      signedActionRequires: [
        "explicit operator authorization",
        "verified deployed executor or direct transaction calldata",
        "fresh HF, minOut, minProfit, staticCall, and estimateGas gates",
      ],
    },
    summary,
    globalTopRows: allRows.slice(0, 20),
    globalShadowRows: shadowRanked.slice(0, 10),
    chains,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
  if (!QUIET) {
    console.log(`\nWrote ${path.relative(WORKSPACE, OUT)}`);
    console.log(`Aave V3 routeDistance watch=${summary.watchCandidates} liquidatable=${summary.currentLiquidatable} routePositive=0 executableNow=0 signedActionJustified=false`);
  }
}

if (require.main === module) {
  main().catch(() => {
    console.error("scan-aave-v3-route-distance failed: scanner-failed");
    process.exit(1);
  });
}

module.exports = { AAVE_POOLS, MAX_USERS_PER_CHAIN, buildRouteSourceCoverage, discoverBorrowers, scanChain };
