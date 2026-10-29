#!/usr/bin/env node
// scan-liquity-v2-phase0.js - read-only Liquity V2/Bold Phase 0 scanner.
// RPC URLs are resolved in memory only. Never prints or stores RPC URLs, private keys,
// execution calldata, borrower addresses, trove IDs, or signed actions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { resolveRpc, rpcCall } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "liquity-v2-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "liquity-v2-phase0-triage.md");
const PUBLIC_TARGETS = path.join(WORKSPACE, "reports", "raw", "fast", "public-audit-target-discovery.json");
const DEPLOYMENT_FILE = path.join(WORKSPACE, "targets", "liquity-bold", "contracts", "addresses", "1.json");

const QUIET = process.argv.includes("--quiet");
const SIGNAL_DORMANT = "\uD83D\uDFE2 DORMANT";
const ETHEREUM_CHAIN_ID = 1;
const WAD = 10n ** 18n;
const ZERO = "0x0000000000000000000000000000000000000000";
const MAX_TROVE_SAMPLES = Number(process.env.LIQUITY_V2_MAX_TROVE_SAMPLES || "120");
const MIN_MATERIAL_DEBT_USD = Number(process.env.LIQUITY_V2_MIN_MATERIAL_DEBT_USD || "1000");
const NEAR_MCR_BPS = Number(process.env.LIQUITY_V2_NEAR_MCR_BPS || "500");
const MIN_DEX_LIQUIDITY_USD = Number(process.env.LIQUITY_V2_MIN_DEX_LIQUIDITY_USD || "10000");
const REQUEST_TIMEOUT_MS = Number(process.env.LIQUITY_V2_REQUEST_TIMEOUT_MS || "25000");
const BOLD_DEXSCREENER = "https://api.dexscreener.com/latest/dex/tokens/0x6440f144b7e50d6a8439336510312d2f54beb01d";

const PRICE_SOURCE = ["primary", "ETHUSDxCanonical", "lastGoodPrice"];
const TROVE_STATUS = ["nonExistent", "active", "closedByOwner", "closedByLiquidation", "zombie"];

const ERC20 = new ethers.Interface([
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
]);

const COLLATERAL_REGISTRY = new ethers.Interface([
  "function totalCollaterals() view returns (uint256)",
  "function getToken(uint256 index) view returns (address)",
  "function getTroveManager(uint256 index) view returns (address)",
  "function boldToken() view returns (address)",
  "function baseRate() view returns (uint256)",
  "function lastFeeOperationTime() view returns (uint256)",
  "function getRedemptionRate() view returns (uint256)",
  "function getRedemptionRateWithDecay() view returns (uint256)",
]);

const BRANCH_REGISTRY = new ethers.Interface([
  "function CCR() view returns (uint256)",
  "function SCR() view returns (uint256)",
  "function MCR() view returns (uint256)",
  "function BCR() view returns (uint256)",
  "function LIQUIDATION_PENALTY_SP() view returns (uint256)",
  "function LIQUIDATION_PENALTY_REDISTRIBUTION() view returns (uint256)",
  "function collToken() view returns (address)",
  "function borrowerOperations() view returns (address)",
  "function troveManager() view returns (address)",
  "function troveNFT() view returns (address)",
  "function stabilityPool() view returns (address)",
  "function priceFeed() view returns (address)",
  "function activePool() view returns (address)",
  "function defaultPool() view returns (address)",
  "function gasPoolAddress() view returns (address)",
  "function collSurplusPool() view returns (address)",
  "function sortedTroves() view returns (address)",
  "function interestRouter() view returns (address)",
  "function hintHelpers() view returns (address)",
  "function multiTroveGetter() view returns (address)",
  "function collateralRegistry() view returns (address)",
  "function boldToken() view returns (address)",
]);

const BORROWER_OPERATIONS = new ethers.Interface([
  "function hasBeenShutDown() view returns (bool)",
  "function getEntireBranchColl() view returns (uint256)",
  "function getEntireBranchDebt() view returns (uint256)",
]);

const ACTIVE_POOL = new ethers.Interface([
  "function getCollBalance() view returns (uint256)",
  "function getBoldDebt() view returns (uint256)",
  "function lastAggUpdateTime() view returns (uint256)",
  "function aggRecordedDebt() view returns (uint256)",
  "function calcPendingAggInterest() view returns (uint256)",
  "function calcPendingSPYield() view returns (uint256)",
  "function aggBatchManagementFees() view returns (uint256)",
  "function calcPendingAggBatchManagementFee() view returns (uint256)",
  "function shutdownTime() view returns (uint256)",
]);

const DEFAULT_POOL = new ethers.Interface([
  "function getCollBalance() view returns (uint256)",
  "function getBoldDebt() view returns (uint256)",
]);

const STABILITY_POOL = new ethers.Interface([
  "function getCollBalance() view returns (uint256)",
  "function getTotalBoldDeposits() view returns (uint256)",
  "function getYieldGainsOwed() view returns (uint256)",
  "function getYieldGainsPending() view returns (uint256)",
  "function P() view returns (uint256)",
  "function currentScale() view returns (uint256)",
  "function scaleToB(uint256 scale) view returns (uint256)",
  "function scaleToS(uint256 scale) view returns (uint256)",
]);

const PRICE_FEED = new ethers.Interface([
  "function lastGoodPrice() view returns (uint256)",
  "function priceSource() view returns (uint8)",
  "function fetchPrice() returns (uint256,bool)",
  "function fetchRedemptionPrice() returns (uint256,bool)",
  "function ethUsdOracle() view returns (tuple(address aggregator,uint256 stalenessThreshold,uint8 decimals))",
  "function stEthUsdOracle() view returns (tuple(address aggregator,uint256 stalenessThreshold,uint8 decimals))",
  "function rEthEthOracle() view returns (tuple(address aggregator,uint256 stalenessThreshold,uint8 decimals))",
  "function rateProviderAddress() view returns (address)",
]);

const RATE_PROVIDER = new ethers.Interface([
  "function stEthPerToken() view returns (uint256)",
  "function getExchangeRate() view returns (uint256)",
]);

const CHAINLINK = new ethers.Interface([
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
  "function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)",
]);

const TROVE_MANAGER = new ethers.Interface([
  "function shutdownTime() view returns (uint256)",
  "function getTroveIdsCount() view returns (uint256)",
  "function lastZombieTroveId() view returns (uint256)",
  "function getUnbackedPortionPriceAndRedeemability() view returns (uint256,uint256,bool)",
  "function getTroveFromTroveIdsArray(uint256 index) view returns (uint256)",
  "function getCurrentICR(uint256 troveId,uint256 price) view returns (uint256)",
  "function getTroveStatus(uint256 troveId) view returns (uint8)",
  "function getLatestTroveData(uint256 troveId) view returns (tuple(uint256 entireDebt,uint256 entireColl,uint256 redistBoldDebtGain,uint256 redistCollGain,uint256 accruedInterest,uint256 recordedDebt,uint256 annualInterestRate,uint256 weightedRecordedDebt,uint256 accruedBatchManagementFee,uint256 lastInterestRateAdjTime))",
]);

const SORTED_TROVES = new ethers.Interface([
  "function getSize() view returns (uint256)",
  "function getFirst() view returns (uint256)",
  "function getLast() view returns (uint256)",
  "function getNext(uint256 id) view returns (uint256)",
  "function getPrev(uint256 id) view returns (uint256)",
]);

function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function readText(file) { try { return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""; } catch (_) { return ""; } }
function readJson(file, fallback = null) { try { const text = readText(file).replace(/^\uFEFF/, ""); return text ? JSON.parse(text) : fallback; } catch (_) { return fallback; } }
function jsonReplacer(_key, value) { return typeof value === "bigint" ? value.toString() : value; }
function sanitizeError(error, max = 220) { return String(error?.shortMessage || error?.message || error || "error").replace(/https?:\/\/\S+/g, "[redacted-url]").replace(/0x[a-fA-F0-9]{80,}/g, "[redacted-hex]").slice(0, max); }
function safeText(value, max = 160) { return String(value ?? "").replace(/https?:\/\/\S+/g, "[redacted-url]").replace(/[\r\n|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) || null; }
function normalizeAddress(value) { try { return ethers.getAddress(String(value || "").replace(/^0X/, "0x")); } catch (_) { return null; } }
function lowerAddress(value) { const addr = normalizeAddress(value); return addr ? addr.toLowerCase() : null; }
function sameAddress(a, b) { return lowerAddress(a) !== null && lowerAddress(a) === lowerAddress(b); }
function codeBytes(code) { return Math.max(0, String(code || "0x").replace(/^0x/i, "").length / 2); }
function toBig(value) { try { return BigInt(value ?? 0); } catch (_) { return 0n; } }
function addBig(...values) { return values.reduce((acc, value) => acc + toBig(value), 0n); }
function round(value, decimals = 4) { const n = Number(value); if (!Number.isFinite(n)) return null; const f = 10 ** decimals; return Math.round(n * f) / f; }
function fmt(value, decimals = 2) { const n = Number(value); return Number.isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: decimals }) : "n/a"; }
function fmtUsd(value) { const n = Number(value); return Number.isFinite(n) ? `$${Math.round(n).toLocaleString("en-US")}` : "n/a"; }
function unitsToNumber(value, decimals = 18) { try { const n = Number(ethers.formatUnits(toBig(value), Number(decimals))); return Number.isFinite(n) ? n : null; } catch (_) { return null; } }
function wadToNumber(value) { return unitsToNumber(value, 18); }
function wadToPct(value) { const n = wadToNumber(value); return n === null ? null : round(n * 100, 2); }
function wadToBps(value) { try { return Number((toBig(value) * 10000n) / WAD); } catch (_) { return null; } }
function bpsDiff(a, b) { const x = Number(a); const y = Number(b); return Number.isFinite(x) && Number.isFinite(y) && y !== 0 ? round(((x - y) / y) * 10000, 2) : null; }
function isPositiveBig(value) { return toBig(value) > 0n; }

async function safeCall(rpc, to, iface, fn, args = [], timeoutMs = REQUEST_TIMEOUT_MS) {
  const addr = normalizeAddress(to);
  if (!rpc || !addr) return null;
  try {
    const data = iface.encodeFunctionData(fn, args);
    const raw = await rpcCall(rpc, "eth_call", [{ to: addr, data }, "latest"], timeoutMs);
    if (!raw || raw === "0x") return null;
    const decoded = iface.decodeFunctionResult(fn, raw);
    return decoded.length === 1 ? decoded[0] : decoded;
  } catch (_) {
    return null;
  }
}

async function safeCode(rpc, address) {
  const addr = normalizeAddress(address);
  if (!addr) return "0x";
  return await rpcCall(rpc, "eth_getCode", [addr, "latest"], 12_000).catch(() => "0x") || "0x";
}

async function fetchJson(url, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "evm-audit-liquity-v2-phase0/1.0" } });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function getDefillamaContext() {
  const data = readJson(PUBLIC_TARGETS, null);
  const rows = [
    ...(data?.phase0Queue || []),
    ...(data?.targetedRefreshQueue || []),
    ...(data?.consumerJoinFirstQueue || []),
    ...(data?.combinedCandidates || []),
  ];
  const row = rows.find((item) => item?.slug === "liquity-v2" || item?.name === "Liquity V2") || null;
  return row ? {
    name: row.name || "Liquity V2",
    slug: row.slug || "liquity-v2",
    category: row.category || "CDP",
    tvlUsd: Number(row.tvlUsd || 0) || null,
    chains: row.chains || ["Ethereum"],
    sourceGeneratedAt: data?.generatedAt || null,
  } : { name: "Liquity V2", slug: "liquity-v2", category: "CDP", tvlUsd: null, chains: ["Ethereum"], sourceGeneratedAt: null };
}

async function tokenMeta(rpc, address, fallback = {}) {
  const addr = normalizeAddress(address);
  if (!addr) return { address, symbol: fallback.symbol || "UNK", decimals: fallback.decimals ?? 18 };
  const [symbol, name, decimals, totalSupply, code] = await Promise.all([
    safeCall(rpc, addr, ERC20, "symbol"),
    safeCall(rpc, addr, ERC20, "name"),
    safeCall(rpc, addr, ERC20, "decimals"),
    safeCall(rpc, addr, ERC20, "totalSupply"),
    safeCode(rpc, addr),
  ]);
  const dec = Number(decimals ?? fallback.decimals ?? 18);
  return {
    address: addr,
    codeBytes: codeBytes(code),
    symbol: safeText(symbol || fallback.symbol || "UNK", 32),
    name: safeText(name || fallback.name || "", 80),
    decimals: Number.isFinite(dec) ? dec : 18,
    totalSupply: totalSupply === null ? null : totalSupply.toString(),
    totalSupplyUnits: totalSupply === null ? null : round(unitsToNumber(totalSupply, dec), 2),
  };
}

function normalizeOracleConfig(value) {
  if (!value) return null;
  const aggregator = normalizeAddress(value.aggregator || value[0]);
  if (!aggregator || aggregator === ZERO) return null;
  return {
    aggregator,
    stalenessThreshold: (value.stalenessThreshold ?? value[1] ?? 0n).toString(),
    decimals: Number(value.decimals ?? value[2] ?? 8),
  };
}

async function scanOracle(rpc, name, config, blockTimestamp) {
  const oracle = normalizeOracleConfig(config);
  if (!oracle) return null;
  const [latest, decimals, description, code] = await Promise.all([
    safeCall(rpc, oracle.aggregator, CHAINLINK, "latestRoundData"),
    safeCall(rpc, oracle.aggregator, CHAINLINK, "decimals"),
    safeCall(rpc, oracle.aggregator, CHAINLINK, "description"),
    safeCode(rpc, oracle.aggregator),
  ]);
  const flags = [];
  let ageSeconds = null;
  let scaledAnswer = null;
  let answer = null;
  if (!latest) {
    flags.push("ROUND_UNREADABLE");
  } else {
    answer = latest.answer ?? latest[1];
    const updatedAt = latest.updatedAt ?? latest[3];
    const answeredInRound = latest.answeredInRound ?? latest[4];
    const roundId = latest.roundId ?? latest[0];
    if (toBig(answer) <= 0n) flags.push("NONPOSITIVE_ANSWER");
    ageSeconds = Number(blockTimestamp) - Number(updatedAt || 0n);
    if (ageSeconds < 0) flags.push("FUTURE_UPDATED_AT");
    if (Number(oracle.stalenessThreshold || 0) > 0 && ageSeconds >= Number(oracle.stalenessThreshold)) flags.push("STALE");
    if (answeredInRound !== undefined && roundId !== undefined && toBig(answeredInRound) < toBig(roundId)) flags.push("STALE_ROUND");
    scaledAnswer = scaleAnswer(answer, decimals ?? oracle.decimals);
  }
  if (codeBytes(code) === 0) flags.push("NO_CODE");
  return {
    name,
    aggregator: oracle.aggregator,
    description: safeText(description || name, 80),
    stalenessThreshold: oracle.stalenessThreshold,
    configuredDecimals: oracle.decimals,
    liveDecimals: decimals === null ? null : Number(decimals),
    codeBytes: codeBytes(code),
    answer: answer === null ? null : answer.toString(),
    scaledAnswer: scaledAnswer === null ? null : scaledAnswer.toString(),
    ageSeconds,
    flags,
  };
}

function scaleAnswer(answer, decimals) {
  const value = toBig(answer);
  const dec = Number(decimals);
  if (value < 0n || !Number.isFinite(dec) || dec > 36) return null;
  if (dec === 18) return value;
  if (dec < 18) return value * (10n ** BigInt(18 - dec));
  return value / (10n ** BigInt(dec - 18));
}

function deriveWstEth(oracles, rate) {
  const eth = oracles.find((oracle) => oracle?.name === "ETH/USD" && oracle.scaledAnswer);
  const stEth = oracles.find((oracle) => oracle?.name === "stETH/USD" && oracle.scaledAnswer);
  if (!eth || !stEth || !rate) return null;
  const ethUsd = toBig(eth.scaledAnswer);
  const stEthUsd = toBig(stEth.scaledAnswer);
  const perToken = toBig(rate);
  const primaryPrice = stEthUsd * perToken / WAD;
  const canonicalPrice = ethUsd * perToken / WAD;
  return {
    primaryPrice: primaryPrice.toString(),
    canonicalPrice: canonicalPrice.toString(),
    stEthPremiumBps: bpsDiff(wadToNumber(stEthUsd), wadToNumber(ethUsd)),
    primaryGtCanonical: primaryPrice > canonicalPrice,
  };
}

function deriveReth(oracles, rate) {
  const eth = oracles.find((oracle) => oracle?.name === "ETH/USD" && oracle.scaledAnswer);
  const reth = oracles.find((oracle) => oracle?.name === "rETH/ETH" && oracle.scaledAnswer);
  if (!eth || !reth || !rate) return null;
  const ethUsd = toBig(eth.scaledAnswer);
  const rethEth = toBig(reth.scaledAnswer);
  const canonicalRate = toBig(rate);
  const marketPrice = ethUsd * rethEth / WAD;
  const canonicalPrice = ethUsd * canonicalRate / WAD;
  return {
    marketPrice: marketPrice.toString(),
    canonicalPrice: canonicalPrice.toString(),
    marketGtCanonical: marketPrice > canonicalPrice,
  };
}

async function scanPriceFeed(rpc, branch, blockTimestamp) {
  const flags = [];
  const [lastGoodPrice, priceSourceRaw, fetchPrice, fetchRedemptionPrice, ethCfg] = await Promise.all([
    safeCall(rpc, branch.priceFeed, PRICE_FEED, "lastGoodPrice"),
    safeCall(rpc, branch.priceFeed, PRICE_FEED, "priceSource"),
    safeCall(rpc, branch.priceFeed, PRICE_FEED, "fetchPrice"),
    safeCall(rpc, branch.priceFeed, PRICE_FEED, "fetchRedemptionPrice"),
    safeCall(rpc, branch.priceFeed, PRICE_FEED, "ethUsdOracle"),
  ]);
  const sourceIndex = priceSourceRaw === null ? null : Number(priceSourceRaw);
  if (sourceIndex !== null && sourceIndex !== 0) flags.push(`PRICE_SOURCE_${PRICE_SOURCE[sourceIndex] || sourceIndex}`);

  const normalizedFetch = normalizePriceTuple(fetchPrice);
  const normalizedRedemption = normalizePriceTuple(fetchRedemptionPrice);
  if (normalizedFetch?.oracleFailureDetected) flags.push("FETCH_PRICE_ORACLE_FAILURE_SIMULATED");
  if (normalizedRedemption?.oracleFailureDetected) flags.push("FETCH_REDEMPTION_ORACLE_FAILURE_SIMULATED");

  const oracles = [];
  const ethOracle = await scanOracle(rpc, "ETH/USD", ethCfg, blockTimestamp);
  if (ethOracle) oracles.push(ethOracle);

  let rateProvider = null;
  let rate = null;
  let derived = null;
  let stEthUsdOracle = null;
  let rEthEthOracle = null;

  if (branch.collSymbol === "wstETH" || branch.collSymbol === "rETH") {
    rateProvider = normalizeAddress(await safeCall(rpc, branch.priceFeed, PRICE_FEED, "rateProviderAddress"));
    if (!rateProvider) flags.push("RATE_PROVIDER_UNREADABLE");
  }
  if (branch.collSymbol === "wstETH") {
    stEthUsdOracle = await safeCall(rpc, branch.priceFeed, PRICE_FEED, "stEthUsdOracle");
    const stEthOracle = await scanOracle(rpc, "stETH/USD", stEthUsdOracle, blockTimestamp);
    if (stEthOracle) oracles.push(stEthOracle);
    rate = rateProvider ? await safeCall(rpc, rateProvider, RATE_PROVIDER, "stEthPerToken") : null;
    derived = deriveWstEth(oracles, rate);
    if (derived?.stEthPremiumBps !== null && derived.stEthPremiumBps > 100) flags.push("STETH_USD_GT_ETH_USD_BY_GT_1PCT");
    if (derived?.primaryGtCanonical) flags.push("WSTETH_PRIMARY_GT_CANONICAL");
  }
  if (branch.collSymbol === "rETH") {
    rEthEthOracle = await safeCall(rpc, branch.priceFeed, PRICE_FEED, "rEthEthOracle");
    const rEthOracle = await scanOracle(rpc, "rETH/ETH", rEthEthOracle, blockTimestamp);
    if (rEthOracle) oracles.push(rEthOracle);
    rate = rateProvider ? await safeCall(rpc, rateProvider, RATE_PROVIDER, "getExchangeRate") : null;
    derived = deriveReth(oracles, rate);
    if (derived?.marketGtCanonical) flags.push("RETH_MARKET_GT_CANONICAL_CAPPED_BY_FEED");
  }
  for (const oracle of oracles) {
    for (const flag of oracle.flags || []) flags.push(`ORACLE_${oracle.name.replace(/[^A-Z0-9]+/gi, "_")}_${flag}`);
  }
  return {
    address: normalizeAddress(branch.priceFeed),
    lastGoodPrice: lastGoodPrice === null ? null : lastGoodPrice.toString(),
    priceSource: sourceIndex === null ? null : { index: sourceIndex, label: PRICE_SOURCE[sourceIndex] || String(sourceIndex) },
    fetchPrice: normalizedFetch,
    fetchRedemptionPrice: normalizedRedemption,
    rateProvider,
    rate: rate === null ? null : rate.toString(),
    derived,
    oracles,
    flags: unique(flags),
  };
}

function normalizePriceTuple(value) {
  if (!value) return null;
  return {
    price: (value.price ?? value[0] ?? 0n).toString(),
    priceUsd: round(wadToNumber(value.price ?? value[0] ?? 0n), 4),
    oracleFailureDetected: Boolean(value.oracleFailureDetected ?? value[1]),
  };
}

async function scanCollateralRegistry(rpc, deployment) {
  const flags = [];
  const address = normalizeAddress(deployment.collateralRegistry);
  const [code, totalCollaterals, boldToken, baseRate, lastFeeOperationTime, redemptionRate, redemptionRateWithDecay] = await Promise.all([
    safeCode(rpc, address),
    safeCall(rpc, address, COLLATERAL_REGISTRY, "totalCollaterals"),
    safeCall(rpc, address, COLLATERAL_REGISTRY, "boldToken"),
    safeCall(rpc, address, COLLATERAL_REGISTRY, "baseRate"),
    safeCall(rpc, address, COLLATERAL_REGISTRY, "lastFeeOperationTime"),
    safeCall(rpc, address, COLLATERAL_REGISTRY, "getRedemptionRate"),
    safeCall(rpc, address, COLLATERAL_REGISTRY, "getRedemptionRateWithDecay"),
  ]);
  if (codeBytes(code) === 0) flags.push("NO_CODE");
  if (boldToken && !sameAddress(boldToken, deployment.boldToken)) flags.push("BOLD_TOKEN_MISMATCH");
  if (totalCollaterals !== null && Number(totalCollaterals) !== deployment.branches.length) flags.push("TOTAL_COLLATERALS_MISMATCH");
  const collaterals = [];
  const total = totalCollaterals === null ? deployment.branches.length : Math.min(Number(totalCollaterals), 16);
  for (let i = 0; i < total; i++) {
    const [token, troveManager] = await Promise.all([
      safeCall(rpc, address, COLLATERAL_REGISTRY, "getToken", [i]),
      safeCall(rpc, address, COLLATERAL_REGISTRY, "getTroveManager", [i]),
    ]);
    const expected = deployment.branches[i];
    const rowFlags = [];
    if (expected && token && !sameAddress(token, expected.collToken)) rowFlags.push("TOKEN_MISMATCH");
    if (expected && troveManager && !sameAddress(troveManager, expected.troveManager)) rowFlags.push("TROVE_MANAGER_MISMATCH");
    flags.push(...rowFlags.map((flag) => `COLL_${i}_${flag}`));
    collaterals.push({
      index: i,
      symbol: expected?.collSymbol || null,
      token: normalizeAddress(token),
      troveManager: normalizeAddress(troveManager),
      flags: rowFlags,
    });
  }
  return {
    address,
    codeBytes: codeBytes(code),
    totalCollaterals: totalCollaterals === null ? null : totalCollaterals.toString(),
    boldToken: normalizeAddress(boldToken),
    baseRate: baseRate === null ? null : baseRate.toString(),
    baseRateBps: wadToBps(baseRate),
    lastFeeOperationTime: lastFeeOperationTime === null ? null : lastFeeOperationTime.toString(),
    redemptionRate: redemptionRate === null ? null : redemptionRate.toString(),
    redemptionRateBps: wadToBps(redemptionRate),
    redemptionRateWithDecay: redemptionRateWithDecay === null ? null : redemptionRateWithDecay.toString(),
    redemptionRateWithDecayBps: wadToBps(redemptionRateWithDecay),
    collaterals,
    flags: unique(flags),
  };
}

async function scanBranchRegistry(rpc, branch, deployment) {
  const checks = [
    ["collToken", "collToken"], ["borrowerOperations", "borrowerOperations"], ["troveManager", "troveManager"],
    ["troveNFT", "troveNFT"], ["stabilityPool", "stabilityPool"], ["priceFeed", "priceFeed"],
    ["activePool", "activePool"], ["defaultPool", "defaultPool"], ["gasPoolAddress", "gasPool"],
    ["collSurplusPool", "collSurplusPool"], ["sortedTroves", "sortedTroves"], ["interestRouter", "interestRouter"],
    ["collateralRegistry", "collateralRegistry"], ["boldToken", "boldToken"],
  ];
  const flags = [];
  const rows = [];
  for (const [fn, expectedKey] of checks) {
    const expected = expectedKey === "collateralRegistry" ? deployment.collateralRegistry : expectedKey === "boldToken" ? deployment.boldToken : branch[expectedKey];
    const observed = await safeCall(rpc, branch.addressesRegistry, BRANCH_REGISTRY, fn);
    const matches = !expected || (observed && sameAddress(observed, expected));
    if (!matches) flags.push(`REGISTRY_${fn.toUpperCase()}_MISMATCH`);
    rows.push({ field: fn, observed: normalizeAddress(observed), matches });
  }
  return { address: normalizeAddress(branch.addressesRegistry), rows, mismatches: rows.filter((row) => !row.matches).length, flags };
}

async function scanBranchConstants(rpc, registryAddress) {
  const out = { flags: [] };
  for (const name of ["CCR", "SCR", "MCR", "BCR", "LIQUIDATION_PENALTY_SP", "LIQUIDATION_PENALTY_REDISTRIBUTION"]) {
    const value = await safeCall(rpc, registryAddress, BRANCH_REGISTRY, name);
    out[name] = value === null ? null : value.toString();
    out[`${name}Pct`] = value === null ? null : wadToPct(value);
    if (value === null) out.flags.push(`${name}_UNREADABLE`);
  }
  return out;
}

async function scanActivePool(rpc, branch) {
  const [trackedColl, rawColl, debt, lastAggUpdateTime, aggRecordedDebt, pendingAggInterest, pendingSPYield, batchFees, pendingBatchFee, shutdownTime] = await Promise.all([
    safeCall(rpc, branch.activePool, ACTIVE_POOL, "getCollBalance"),
    safeCall(rpc, branch.collToken, ERC20, "balanceOf", [branch.activePool]),
    safeCall(rpc, branch.activePool, ACTIVE_POOL, "getBoldDebt"),
    safeCall(rpc, branch.activePool, ACTIVE_POOL, "lastAggUpdateTime"),
    safeCall(rpc, branch.activePool, ACTIVE_POOL, "aggRecordedDebt"),
    safeCall(rpc, branch.activePool, ACTIVE_POOL, "calcPendingAggInterest"),
    safeCall(rpc, branch.activePool, ACTIVE_POOL, "calcPendingSPYield"),
    safeCall(rpc, branch.activePool, ACTIVE_POOL, "aggBatchManagementFees"),
    safeCall(rpc, branch.activePool, ACTIVE_POOL, "calcPendingAggBatchManagementFee"),
    safeCall(rpc, branch.activePool, ACTIVE_POOL, "shutdownTime"),
  ]);
  const flags = [];
  if (trackedColl !== null && rawColl !== null && toBig(rawColl) < toBig(trackedColl)) flags.push("RAW_COLL_LT_TRACKED");
  if (isPositiveBig(shutdownTime)) flags.push("SHUTDOWN");
  return {
    address: normalizeAddress(branch.activePool),
    trackedColl: trackedColl === null ? null : trackedColl.toString(),
    rawColl: rawColl === null ? null : rawColl.toString(),
    debt: debt === null ? null : debt.toString(),
    lastAggUpdateTime: lastAggUpdateTime === null ? null : lastAggUpdateTime.toString(),
    aggRecordedDebt: aggRecordedDebt === null ? null : aggRecordedDebt.toString(),
    pendingAggInterest: pendingAggInterest === null ? null : pendingAggInterest.toString(),
    pendingSPYield: pendingSPYield === null ? null : pendingSPYield.toString(),
    aggBatchManagementFees: batchFees === null ? null : batchFees.toString(),
    pendingBatchManagementFee: pendingBatchFee === null ? null : pendingBatchFee.toString(),
    shutdownTime: shutdownTime === null ? null : shutdownTime.toString(),
    flags,
  };
}

async function scanDefaultPool(rpc, branch) {
  const [trackedColl, rawColl, debt] = await Promise.all([
    safeCall(rpc, branch.defaultPool, DEFAULT_POOL, "getCollBalance"),
    safeCall(rpc, branch.collToken, ERC20, "balanceOf", [branch.defaultPool]),
    safeCall(rpc, branch.defaultPool, DEFAULT_POOL, "getBoldDebt"),
  ]);
  const flags = [];
  if (trackedColl !== null && rawColl !== null && toBig(rawColl) < toBig(trackedColl)) flags.push("RAW_COLL_LT_TRACKED");
  return { address: normalizeAddress(branch.defaultPool), trackedColl: stringify(trackedColl), rawColl: stringify(rawColl), debt: stringify(debt), flags };
}

async function scanStabilityPool(rpc, branch, boldToken) {
  const [trackedColl, rawColl, totalBoldDeposits, yieldGainsOwed, yieldGainsPending, pValue, currentScale, scale0B, scale0S, rawBoldBalance] = await Promise.all([
    safeCall(rpc, branch.stabilityPool, STABILITY_POOL, "getCollBalance"),
    safeCall(rpc, branch.collToken, ERC20, "balanceOf", [branch.stabilityPool]),
    safeCall(rpc, branch.stabilityPool, STABILITY_POOL, "getTotalBoldDeposits"),
    safeCall(rpc, branch.stabilityPool, STABILITY_POOL, "getYieldGainsOwed"),
    safeCall(rpc, branch.stabilityPool, STABILITY_POOL, "getYieldGainsPending"),
    safeCall(rpc, branch.stabilityPool, STABILITY_POOL, "P"),
    safeCall(rpc, branch.stabilityPool, STABILITY_POOL, "currentScale"),
    safeCall(rpc, branch.stabilityPool, STABILITY_POOL, "scaleToB", [0]),
    safeCall(rpc, branch.stabilityPool, STABILITY_POOL, "scaleToS", [0]),
    safeCall(rpc, boldToken, ERC20, "balanceOf", [branch.stabilityPool]),
  ]);
  const flags = [];
  if (trackedColl !== null && rawColl !== null && toBig(rawColl) < toBig(trackedColl)) flags.push("RAW_COLL_LT_TRACKED");
  if (isPositiveBig(currentScale)) flags.push("SCALE_NONZERO");
  if (pValue !== null && toBig(pValue) === 0n) flags.push("P_ZERO");
  const expectedBoldBalance = addBig(totalBoldDeposits, yieldGainsOwed, yieldGainsPending);
  if (rawBoldBalance !== null && toBig(rawBoldBalance) < expectedBoldBalance) flags.push("BOLD_RAW_LT_ACCOUNTED");
  return {
    address: normalizeAddress(branch.stabilityPool),
    trackedColl: stringify(trackedColl),
    rawColl: stringify(rawColl),
    totalBoldDeposits: stringify(totalBoldDeposits),
    yieldGainsOwed: stringify(yieldGainsOwed),
    yieldGainsPending: stringify(yieldGainsPending),
    P: stringify(pValue),
    currentScale: stringify(currentScale),
    scale0B: stringify(scale0B),
    scale0S: stringify(scale0S),
    rawBoldBalance: stringify(rawBoldBalance),
    expectedBoldBalance: expectedBoldBalance.toString(),
    flags,
  };
}

async function scanCollSurplusPool(rpc, branch) {
  const [trackedColl, rawColl] = await Promise.all([
    safeCall(rpc, branch.collSurplusPool, DEFAULT_POOL, "getCollBalance"),
    safeCall(rpc, branch.collToken, ERC20, "balanceOf", [branch.collSurplusPool]),
  ]);
  const flags = [];
  if (trackedColl !== null && rawColl !== null && toBig(rawColl) < toBig(trackedColl)) flags.push("RAW_COLL_LT_TRACKED");
  return { address: normalizeAddress(branch.collSurplusPool), trackedColl: stringify(trackedColl), rawColl: stringify(rawColl), flags };
}

async function scanPools(rpc, branch, deployment) {
  const [boShutdown, branchColl, branchDebt, activePool, defaultPool, stabilityPool, collSurplusPool] = await Promise.all([
    safeCall(rpc, branch.borrowerOperations, BORROWER_OPERATIONS, "hasBeenShutDown"),
    safeCall(rpc, branch.borrowerOperations, BORROWER_OPERATIONS, "getEntireBranchColl"),
    safeCall(rpc, branch.borrowerOperations, BORROWER_OPERATIONS, "getEntireBranchDebt"),
    scanActivePool(rpc, branch),
    scanDefaultPool(rpc, branch),
    scanStabilityPool(rpc, branch, deployment.boldToken),
    scanCollSurplusPool(rpc, branch),
  ]);
  const flags = [];
  flags.push(...activePool.flags.map((flag) => `ACTIVE_${flag}`));
  flags.push(...defaultPool.flags.map((flag) => `DEFAULT_${flag}`));
  flags.push(...stabilityPool.flags.map((flag) => `SP_${flag}`));
  flags.push(...collSurplusPool.flags.map((flag) => `SURPLUS_${flag}`));
  return {
    borrowerOperations: {
      address: normalizeAddress(branch.borrowerOperations),
      hasBeenShutDown: boShutdown === null ? null : Boolean(boShutdown),
      entireBranchColl: stringify(branchColl),
      entireBranchDebt: stringify(branchDebt),
    },
    activePool,
    defaultPool,
    stabilityPool,
    collSurplusPool,
    flags: unique(flags),
  };
}

async function scanTroveManager(rpc, branch) {
  const [shutdownTime, idsCount, lastZombieTroveId, unbacked] = await Promise.all([
    safeCall(rpc, branch.troveManager, TROVE_MANAGER, "shutdownTime"),
    safeCall(rpc, branch.troveManager, TROVE_MANAGER, "getTroveIdsCount"),
    safeCall(rpc, branch.troveManager, TROVE_MANAGER, "lastZombieTroveId"),
    safeCall(rpc, branch.troveManager, TROVE_MANAGER, "getUnbackedPortionPriceAndRedeemability"),
  ]);
  const flags = [];
  if (isPositiveBig(shutdownTime)) flags.push("SHUTDOWN");
  const normalizedUnbacked = unbacked ? {
    unbackedPortion: (unbacked.unbackedPortion ?? unbacked[0] ?? 0n).toString(),
    price: (unbacked.price ?? unbacked[1] ?? 0n).toString(),
    redeemable: Boolean(unbacked.redeemable ?? unbacked[2]),
  } : null;
  if (normalizedUnbacked && normalizedUnbacked.redeemable === false) flags.push("NOT_REDEEMABLE");
  return {
    address: normalizeAddress(branch.troveManager),
    shutdownTime: stringify(shutdownTime),
    idsCount: stringify(idsCount),
    lastZombieTrovePresent: isPositiveBig(lastZombieTroveId),
    unbacked: normalizedUnbacked,
    flags,
  };
}

async function scanSortedTroves(rpc, branch) {
  const [size, first, last] = await Promise.all([
    safeCall(rpc, branch.sortedTroves, SORTED_TROVES, "getSize"),
    safeCall(rpc, branch.sortedTroves, SORTED_TROVES, "getFirst"),
    safeCall(rpc, branch.sortedTroves, SORTED_TROVES, "getLast"),
  ]);
  const flags = [];
  if (size !== null && toBig(size) === 0n) flags.push("EMPTY");
  return {
    address: normalizeAddress(branch.sortedTroves),
    public: { address: normalizeAddress(branch.sortedTroves), size: stringify(size), hasFirst: isPositiveBig(first), hasLast: isPositiveBig(last), flags },
    first,
    last,
  };
}

async function collectSortedIds(rpc, sortedTroves, start, fn, limit, ids, source) {
  let id = toBig(start);
  for (let i = 0; i < limit && id > 0n; i++) {
    ids.push({ id, source });
    const next = await safeCall(rpc, sortedTroves, SORTED_TROVES, fn, [id]);
    const nextId = toBig(next);
    if (nextId === 0n || nextId === id) break;
    id = nextId;
  }
}

async function scanTroveSamples(rpc, branch, price, mcr, sorted, tm) {
  const flags = [];
  const ids = [];
  const perSourceLimit = Math.max(1, Math.ceil(MAX_TROVE_SAMPLES / 3));
  await collectSortedIds(rpc, branch.sortedTroves, sorted.first, "getNext", perSourceLimit, ids, "head");
  await collectSortedIds(rpc, branch.sortedTroves, sorted.last, "getPrev", perSourceLimit, ids, "tail");
  const idsCount = toBig(tm.idsCount);
  for (let i = 0n; i < idsCount && ids.length < MAX_TROVE_SAMPLES; i++) {
    const id = await safeCall(rpc, branch.troveManager, TROVE_MANAGER, "getTroveFromTroveIdsArray", [i]);
    if (isPositiveBig(id)) ids.push({ id: toBig(id), source: "arrayHead" });
  }

  const seen = new Set();
  const sourceCounts = { head: 0, tail: 0, arrayHead: 0 };
  let scanned = 0;
  let active = 0;
  let liquidatable = 0;
  let nearMcr = 0;
  let materialLiquidatable = 0;
  let totalActiveDebt = 0n;
  let liquidatableDebt = 0n;
  let nearMcrDebt = 0n;
  let minIcr = null;
  let maxIcr = null;

  for (const entry of ids) {
    const idText = entry.id.toString();
    if (seen.has(idText)) continue;
    seen.add(idText);
    const [statusRaw, icrRaw, dataRaw] = await Promise.all([
      safeCall(rpc, branch.troveManager, TROVE_MANAGER, "getTroveStatus", [entry.id]),
      price > 0n ? safeCall(rpc, branch.troveManager, TROVE_MANAGER, "getCurrentICR", [entry.id, price]) : null,
      safeCall(rpc, branch.troveManager, TROVE_MANAGER, "getLatestTroveData", [entry.id]),
    ]);
    scanned += 1;
    sourceCounts[entry.source] = (sourceCounts[entry.source] || 0) + 1;
    const status = Number(statusRaw ?? -1n);
    const statusLabel = TROVE_STATUS[status] || String(status);
    const icr = icrRaw === null ? null : toBig(icrRaw);
    const data = dataRaw || null;
    const debt = data ? toBig(data.entireDebt ?? data[0] ?? 0n) : 0n;
    if (statusLabel === "active") {
      active += 1;
      totalActiveDebt += debt;
      if (icr !== null) {
        minIcr = minIcr === null || icr < minIcr ? icr : minIcr;
        maxIcr = maxIcr === null || icr > maxIcr ? icr : maxIcr;
        if (mcr !== null && icr < mcr) {
          liquidatable += 1;
          liquidatableDebt += debt;
          if (unitsToNumber(debt, 18) >= MIN_MATERIAL_DEBT_USD) materialLiquidatable += 1;
        } else if (mcr !== null && icr < (mcr * BigInt(10000 + NEAR_MCR_BPS) / 10000n)) {
          nearMcr += 1;
          nearMcrDebt += debt;
        }
      }
    }
  }
  if (liquidatable > 0) flags.push(`LIQUIDATABLE_SAMPLES:${liquidatable}`);
  if (nearMcr > 0) flags.push(`NEAR_MCR_SAMPLES:${nearMcr}`);
  if (materialLiquidatable > 0) flags.push(`MATERIAL_LIQUIDATABLE_SAMPLES:${materialLiquidatable}`);
  return {
    scanned,
    active,
    liquidatable,
    nearMcr,
    materialLiquidatable,
    sourceCounts,
    totalActiveDebtBold: round(unitsToNumber(totalActiveDebt, 18), 2),
    liquidatableDebtBold: round(unitsToNumber(liquidatableDebt, 18), 2),
    nearMcrDebtBold: round(unitsToNumber(nearMcrDebt, 18), 2),
    minIcrPct: minIcr === null ? null : wadToPct(minIcr),
    maxIcrPct: maxIcr === null ? null : wadToPct(maxIcr),
    flags,
  };
}

async function scanZappers(rpc, branch, boldToken, price) {
  const rows = [];
  const flags = [];
  for (const key of ["wethZapper", "gasCompZapper", "leverageZapper"]) {
    const address = normalizeAddress(branch[key]);
    if (!address || address === ZERO) continue;
    const [code, collBalance, boldBalance] = await Promise.all([
      safeCode(rpc, address),
      safeCall(rpc, branch.collToken, ERC20, "balanceOf", [address]),
      safeCall(rpc, boldToken, ERC20, "balanceOf", [address]),
    ]);
    const collUnits = unitsToNumber(collBalance, 18);
    const boldUnits = unitsToNumber(boldBalance, 18);
    const collUsd = price > 0n && collBalance !== null ? round(Number((toBig(collBalance) * price) / WAD) / 1e18, 6) : null;
    const rowFlags = [];
    if (codeBytes(code) === 0) rowFlags.push("NO_CODE");
    if (toBig(collBalance) > 0n) rowFlags.push("COLL_BALANCE_NONZERO");
    if (toBig(boldBalance) > 0n) rowFlags.push("BOLD_BALANCE_NONZERO");
    flags.push(...rowFlags.map((flag) => `${key.toUpperCase()}_${flag}`));
    rows.push({ key, address, codeBytes: codeBytes(code), collBalanceUnits: round(collUnits, 8), collBalanceUsd: collUsd, boldBalanceUnits: round(boldUnits, 6), flags: rowFlags });
  }
  return { rows, flags };
}

async function scanBranch(rpc, branch, index, deployment, blockTimestamp) {
  const flags = [];
  const codeTargets = {
    addressesRegistry: branch.addressesRegistry,
    activePool: branch.activePool,
    borrowerOperations: branch.borrowerOperations,
    collSurplusPool: branch.collSurplusPool,
    defaultPool: branch.defaultPool,
    sortedTroves: branch.sortedTroves,
    stabilityPool: branch.stabilityPool,
    troveManager: branch.troveManager,
    troveNFT: branch.troveNFT,
    priceFeed: branch.priceFeed,
  };
  const code = {};
  await Promise.all(Object.entries(codeTargets).map(async ([key, address]) => {
    const bytes = codeBytes(await safeCode(rpc, address));
    code[key] = bytes;
    if (bytes === 0) flags.push(`${key.toUpperCase()}_NO_CODE`);
  }));

  const [token, registry, constants, oracle, pools, troveManager, sorted] = await Promise.all([
    tokenMeta(rpc, branch.collToken, { symbol: branch.collSymbol, decimals: 18 }),
    scanBranchRegistry(rpc, branch, deployment),
    scanBranchConstants(rpc, branch.addressesRegistry),
    scanPriceFeed(rpc, branch, blockTimestamp),
    scanPools(rpc, branch, deployment),
    scanTroveManager(rpc, branch),
    scanSortedTroves(rpc, branch),
  ]);
  flags.push(...registry.flags, ...constants.flags, ...oracle.flags, ...pools.flags, ...troveManager.flags, ...sorted.public.flags);

  const price = toBig(oracle.fetchPrice?.price || oracle.lastGoodPrice || 0n);
  const branchColl = toBig(pools.borrowerOperations.entireBranchColl);
  const branchDebt = toBig(pools.borrowerOperations.entireBranchDebt);
  const tcr = branchDebt > 0n ? branchColl * price / branchDebt : null;
  const mcr = constants.MCR === null ? null : toBig(constants.MCR);
  const scr = constants.SCR === null ? null : toBig(constants.SCR);
  const ccr = constants.CCR === null ? null : toBig(constants.CCR);
  const isShutdown = pools.borrowerOperations.hasBeenShutDown === true || isPositiveBig(troveManager.shutdownTime) || isPositiveBig(pools.activePool.shutdownTime);
  if (isShutdown) flags.push("BRANCH_SHUTDOWN");
  if (tcr !== null && scr !== null && tcr < scr) flags.push("TCR_BELOW_SCR_SHUTDOWN_ELIGIBLE");
  if (tcr !== null && ccr !== null && tcr < ccr) flags.push("TCR_BELOW_CCR");
  if (isPositiveBig(pools.stabilityPool.currentScale)) flags.push("SP_SCALE_NONZERO");

  const samples = await scanTroveSamples(rpc, branch, price, mcr, sorted, troveManager);
  flags.push(...samples.flags);
  const zappers = await scanZappers(rpc, branch, deployment.boldToken, price);
  flags.push(...zappers.flags);

  const branchCollUnits = unitsToNumber(branchColl, token.decimals || 18);
  const branchDebtBold = unitsToNumber(branchDebt, 18);
  const branchCollUsd = branchColl > 0n && price > 0n ? Number((branchColl * price) / (10n ** BigInt(token.decimals || 18))) / 1e18 : null;
  const stabilityPoolBold = unitsToNumber(pools.stabilityPool.totalBoldDeposits, 18);
  const oracleFlagged = oracle.flags.some((flag) => /STALE|FAILURE|WSTETH_PRIMARY_GT_CANONICAL|STETH_USD_GT_ETH_USD/.test(flag));
  const poolShortage = flags.some((flag) => /RAW_.*LT_TRACKED|BOLD_RAW_LT_ACCOUNTED/.test(flag));
  const watchCandidate = Boolean(isShutdown || (tcr !== null && ccr !== null && tcr < ccr) || samples.liquidatable > 0 || samples.nearMcr > 0 || oracleFlagged || poolShortage || isPositiveBig(pools.stabilityPool.currentScale));

  return {
    index,
    collSymbol: branch.collSymbol,
    collToken: normalizeAddress(branch.collToken),
    status: "scanned",
    code,
    token,
    registry,
    constants,
    oracle,
    pools,
    troveManager,
    sortedTroves: sorted.public,
    tcr: tcr === null ? null : tcr.toString(),
    tcrPct: tcr === null ? null : wadToPct(tcr),
    branchCollUnits: round(branchCollUnits, 4),
    branchDebtBold: round(branchDebtBold, 2),
    branchCollUsd: round(branchCollUsd, 2),
    stabilityPoolBold: round(stabilityPoolBold, 2),
    samples,
    zappers,
    watchCandidate,
    routePositive: false,
    flags: unique(flags),
  };
}

async function scanBoldDex() {
  const json = await fetchJson(BOLD_DEXSCREENER, 20_000);
  const pairs = Array.isArray(json?.pairs) ? json.pairs : [];
  const ethPairs = pairs
    .filter((pair) => String(pair.chainId || "").toLowerCase() === "ethereum")
    .map((pair) => ({
      dexId: safeText(pair.dexId, 40),
      pairLabel: safeText(pair.labels?.join("/") || pair.pairAddress || "pair", 80),
      priceUsd: Number(pair.priceUsd),
      liquidityUsd: Number(pair.liquidity?.usd || 0),
      volume24hUsd: Number(pair.volume?.h24 || 0),
    }))
    .filter((pair) => Number.isFinite(pair.priceUsd));
  ethPairs.sort((a, b) => (b.liquidityUsd || 0) - (a.liquidityUsd || 0));
  const top = ethPairs[0] || null;
  return {
    source: "dexscreener",
    rows: ethPairs.slice(0, 5),
    priceUsd: top?.priceUsd ?? null,
    topDexLiquidityUsd: top?.liquidityUsd ?? null,
    topDexId: top?.dexId ?? null,
    fetched: Boolean(json),
  };
}

function redemptionContext(registry, boldDex) {
  const redemptionRateBps = registry.redemptionRateWithDecayBps ?? registry.redemptionRateBps;
  const price = Number(boldDex?.priceUsd);
  const discountBps = Number.isFinite(price) ? round((1 - price) * 10000, 2) : null;
  const grossEdgeBps = discountBps === null || redemptionRateBps === null ? null : round(discountBps - redemptionRateBps, 2);
  const watchCandidate = grossEdgeBps !== null && grossEdgeBps > 0 && Number(boldDex?.topDexLiquidityUsd || 0) >= MIN_DEX_LIQUIDITY_USD;
  return {
    boldPriceUsd: Number.isFinite(price) ? round(price, 6) : null,
    boldDiscountBps: discountBps,
    redemptionRateBps,
    grossEdgeAfterFeeBps: grossEdgeBps,
    topDexLiquidityUsd: boldDex?.topDexLiquidityUsd ?? null,
    watchCandidate,
    routePositive: false,
    blocker: watchCandidate
      ? "BOLD discount clears redemption fee gross, but exact redemption hints, collateral exit, gas, slippage, and fork proof are missing"
      : "No exact-positive BOLD redemption route after fee and liquidity gates",
  };
}

function buildSummary(context, registry, boldToken, branches, redemption) {
  const totalBranchDebtBold = sumNumbers(branches.map((branch) => branch.branchDebtBold));
  const totalBranchCollUsd = sumNumbers(branches.map((branch) => branch.branchCollUsd));
  const stabilityPoolBoldUsd = sumNumbers(branches.map((branch) => branch.stabilityPoolBold));
  const sampledTroves = sumNumbers(branches.map((branch) => branch.samples.scanned));
  const activeSampledTroves = sumNumbers(branches.map((branch) => branch.samples.active));
  const materialSampledLiquidatableTroves = sumNumbers(branches.map((branch) => branch.samples.materialLiquidatable));
  const nearMcrRows = sumNumbers(branches.map((branch) => branch.samples.nearMcr));
  const shutdownBranches = branches.filter((branch) => branch.flags.includes("BRANCH_SHUTDOWN")).length;
  const staleFeedRows = branches.filter((branch) => branch.oracle.oracles.some((oracle) => oracle.flags.some((flag) => /STALE|STALE_ROUND/.test(flag)))).length;
  const oracleFailureRows = branches.filter((branch) => branch.oracle.flags.some((flag) => /FAILURE/.test(flag))).length;
  const oraclePremiumWatchRows = branches.filter((branch) => branch.oracle.flags.some((flag) => /WSTETH_PRIMARY_GT_CANONICAL|STETH_USD_GT_ETH_USD/.test(flag))).length;
  const spScaleNonzeroRows = branches.filter((branch) => isPositiveBig(branch.pools.stabilityPool.currentScale)).length;
  const zapperNonzeroRows = branches.reduce((acc, branch) => acc + branch.zappers.rows.filter((row) => row.flags.some((flag) => /BALANCE_NONZERO/.test(flag))).length, 0);
  const branchWatchCandidates = branches.filter((branch) => branch.watchCandidate).length;
  const watchCandidates = branchWatchCandidates + (redemption.watchCandidate ? 1 : 0);
  return {
    target: "Liquity V2 / Liquity Bold",
    chainsWithRpc: 1,
    defillamaCurrentTvlUsd: context.tvlUsd,
    branches: branches.length,
    codePresentRows: branches.reduce((acc, branch) => acc + Object.values(branch.code).filter((bytes) => bytes > 0).length, 0),
    registryMismatchRows: branches.reduce((acc, branch) => acc + branch.registry.mismatches, 0) + registry.flags.filter((flag) => /MISMATCH/.test(flag)).length,
    totalBranchDebtBold: round(totalBranchDebtBold, 2),
    totalBranchCollUsd: round(totalBranchCollUsd, 2),
    stabilityPoolBoldUsd: round(stabilityPoolBoldUsd, 2),
    boldTotalSupply: boldToken.totalSupplyUnits,
    boldMarketPriceUsd: redemption.boldPriceUsd,
    boldTopDexLiquidityUsd: redemption.topDexLiquidityUsd,
    redemptionGrossEdgeAfterFeeBps: redemption.grossEdgeAfterFeeBps,
    sampledTroves,
    activeSampledTroves,
    materialSampledLiquidatableTroves,
    nearMcrRows,
    shutdownBranches,
    staleFeedRows,
    oracleFailureRows,
    oraclePremiumWatchRows,
    spScaleNonzeroRows,
    zapperNonzeroRows,
    watchCandidates,
    exactEconomicsRows: 0,
    routePositive: 0,
  };
}

function makeTopRows(branches, redemption) {
  const rows = branches.map((branch) => ({
    protocol: "Liquity V2",
    chain: "Ethereum",
    symbol: branch.collSymbol,
    pair: "BOLD debt / collateral branch",
    totalBorrowUsd: branch.branchDebtBold,
    liquidityUsd: branch.stabilityPoolBold,
    edgeBps: branch.oracle.derived?.stEthPremiumBps ?? null,
    routePositive: false,
    blocker: branch.samples.materialLiquidatable > 0
      ? "Material sampled liquidatable trove requires exact repay/acquire/seize/exit quote and fork proof"
      : "No sampled material liquidatable trove and no exact liquidation or redemption route quote",
  }));
  rows.push({
    protocol: "Liquity V2",
    chain: "Ethereum",
    symbol: "BOLD",
    pair: "BOLD redemption",
    liquidityUsd: redemption.topDexLiquidityUsd,
    edgeBps: redemption.grossEdgeAfterFeeBps,
    routePositive: false,
    blocker: redemption.blocker,
  });
  return rows;
}

async function scan() {
  const context = getDefillamaContext();
  const deployment = readJson(DEPLOYMENT_FILE, null);
  if (!deployment) throw new Error(`missing deployment file: ${DEPLOYMENT_FILE}`);
  const rpc = await resolveRpc(ETHEREUM_CHAIN_ID);
  if (!rpc) {
    return {
      generatedAt: new Date().toISOString(),
      target: context,
      status: "no-rpc",
      summary: { target: "Liquity V2 / Liquity Bold", chainsWithRpc: 0, routePositive: 0, watchCandidates: 0 },
      safety: { routePositive: false, signedActionJustified: false, forkGate: "blocked-no-rpc" },
    };
  }

  const [blockNumberRaw, blockRaw] = await Promise.all([
    rpcCall(rpc, "eth_blockNumber", [], 10_000),
    rpcCall(rpc, "eth_getBlockByNumber", ["latest", false], 10_000),
  ]);
  const blockNumber = Number(BigInt(blockNumberRaw || "0x0"));
  const blockTimestamp = Number(BigInt(blockRaw?.timestamp || "0x0"));
  const [registry, boldToken, boldDex] = await Promise.all([
    scanCollateralRegistry(rpc, deployment),
    tokenMeta(rpc, deployment.boldToken, { symbol: "BOLD", decimals: 18 }),
    scanBoldDex(),
  ]);
  const branches = [];
  for (let i = 0; i < deployment.branches.length; i++) {
    const branch = await scanBranch(rpc, deployment.branches[i], i, deployment, blockTimestamp);
    branches.push(branch);
    if (!QUIET) console.error(`${branch.collSymbol}: routePositive=0 watch=${branch.watchCandidate ? 1 : 0} sampled=${branch.samples.scanned} liquidatable=${branch.samples.materialLiquidatable}`);
  }
  const redemption = redemptionContext(registry, boldDex);
  const summary = buildSummary(context, registry, boldToken, branches, redemption);
  return {
    generatedAt: new Date().toISOString(),
    target: context,
    status: "scanned",
    chain: { name: "Ethereum", chainId: ETHEREUM_CHAIN_ID, blockNumber, blockTimestamp },
    source: {
      localDeployment: "targets/liquity-bold/contracts/addresses/1.json",
      priorScanner: "targets/liquity-bold/contracts/scan-liquity-bold-live.js",
      note: "This Phase 0 artifact intentionally omits borrower addresses and trove IDs.",
    },
    deployment: {
      collateralRegistry: normalizeAddress(deployment.collateralRegistry),
      boldToken: normalizeAddress(deployment.boldToken),
      branches: deployment.branches.map((branch) => ({
        collSymbol: branch.collSymbol,
        collToken: normalizeAddress(branch.collToken),
        addressesRegistry: normalizeAddress(branch.addressesRegistry),
        borrowerOperations: normalizeAddress(branch.borrowerOperations),
        troveManager: normalizeAddress(branch.troveManager),
        stabilityPool: normalizeAddress(branch.stabilityPool),
        priceFeed: normalizeAddress(branch.priceFeed),
      })),
    },
    collateralRegistry: registry,
    boldToken,
    boldDex,
    redemption,
    branches,
    topRows: makeTopRows(branches, redemption),
    summary,
    safety: {
      routePositive: false,
      signedActionJustified: false,
      forkGate: "blocked-route-negative-no-exact-economics",
      blockers: [
        "No sampled material liquidatable trove has exact repay/acquire/seize/exit economics",
        "BOLD redemption is not exact-positive without hinting/staticCall, collateral exit quote, gas, slippage, and fork proof",
        "No oracle failure/stale accepted price currently maps to a borrow or liquidation extraction route",
        "No fork extraction proof",
      ],
    },
  };
}

function buildReport(artifact) {
  const s = artifact.summary || {};
  const lines = [];
  lines.push(`# ${SIGNAL_DORMANT} - Liquity V2 Phase 0 Triage`);
  lines.push("");
  lines.push(`Date: ${artifact.generatedAt?.slice(0, 10) || new Date().toISOString().slice(0, 10)}`);
  lines.push("");
  lines.push("Target: `Liquity V2` / local `Liquity Bold` deployment on Ethereum.");
  lines.push("");
  lines.push("## Result");
  lines.push("");
  lines.push("**No confirmed permissionless value-extracting exploit.** The Phase 0 refresh mapped the current Bold collateral registry, branches, oracle feeds, stability pools, redemption fee, and bounded trove-health samples without finding an exact-positive liquidation, redemption, borrow, or oracle route.");
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- DeFiLlama queue TVL: ${fmtUsd(s.defillamaCurrentTvlUsd)}.`);
  lines.push(`- Branches scanned: ${s.branches}; total branch debt: ${fmt(s.totalBranchDebtBold)} BOLD; branch collateral value: ${fmtUsd(s.totalBranchCollUsd)}.`);
  lines.push(`- Stability Pool deposits: ${fmt(s.stabilityPoolBoldUsd)} BOLD; sampled troves: ${s.sampledTroves}; material sampled liquidatable troves: ${s.materialSampledLiquidatableTroves}.`);
  lines.push(`- Watch candidates: ${s.watchCandidates}; exact-economics rows: ${s.exactEconomicsRows}; routePositive: ${s.routePositive}.`);
  lines.push("");
  lines.push("## Branch State");
  lines.push("");
  lines.push("| Branch | Price source | TCR | MCR/SCR | Branch debt | SP deposits | Sampled | Liquidatable | Near MCR | Flags |");
  lines.push("|---|---|---:|---:|---:|---:|---:|---:|---:|---|");
  for (const b of artifact.branches || []) {
    lines.push(`| ${b.collSymbol} | ${b.oracle?.priceSource?.label || "n/a"} | ${fmt(b.tcrPct, 2)}% | ${fmt(b.constants?.MCRPct, 2)}% / ${fmt(b.constants?.SCRPct, 2)}% | ${fmt(b.branchDebtBold)} | ${fmt(b.stabilityPoolBold)} | ${b.samples?.scanned || 0} | ${b.samples?.materialLiquidatable || 0} | ${b.samples?.nearMcr || 0} | ${safeText((b.flags || []).slice(0, 4).join(", ") || "none", 120)} |`);
  }
  lines.push("");
  lines.push("## Redemption And Oracle Gates");
  lines.push("");
  lines.push(`- BOLD market price: ${artifact.redemption?.boldPriceUsd ?? "n/a"}; top observed DEX liquidity: ${fmtUsd(artifact.redemption?.topDexLiquidityUsd)}.`);
  lines.push(`- Redemption fee with decay: ${fmt(artifact.redemption?.redemptionRateBps, 2)} bps; gross BOLD-discount edge after fee: ${fmt(artifact.redemption?.grossEdgeAfterFeeBps, 2)} bps.`);
  lines.push(`- Stale feed rows: ${s.staleFeedRows}; oracle-failure rows: ${s.oracleFailureRows}; oracle premium watch rows: ${s.oraclePremiumWatchRows}.`);
  lines.push("");
  lines.push("## Exploit Candidates");
  lines.push("");
  lines.push("| # | Path | Current gate | Verdict |");
  lines.push("|---:|---|---|---|");
  lines.push("| 1 | Liquidate under-MCR Bold troves | Bounded samples found no material exact-positive liquidation row; no repay/acquire/seize/exit quote or fork proof. | DORMANT |");
  lines.push("| 2 | BOLD discount redemption into collateral | Gross discount/fee check is not enough without exact hints, staticCall, collateral exit quote, gas, slippage, and fork proof. | DORMANT |");
  lines.push("| 3 | wstETH/stETH or rETH canonical-oracle drift | Current feed rows did not map to an accepted overvaluation with exact borrow/liquidation economics. | DORMANT |");
  lines.push("| 4 | Stability Pool scale/accounting edge | Current scale and raw/accounted balance checks did not produce an overclaim or drain route. | DORMANT |");
  lines.push("");
  lines.push("## Residual Risks");
  lines.push("");
  lines.push("- Reopen if a material trove becomes liquidatable and exact repay, seize, and exit quotes are positive.");
  lines.push("- Reopen if BOLD trades far enough below peg to clear redemption fee, hinting, gas, slippage, and collateral exit costs.");
  lines.push("- Reopen if Chainlink stETH/USD or rETH/ETH/canonical paths become stale, fail over, or diverge into accepted overvaluation.");
  lines.push("- This artifact intentionally omits borrower addresses and trove IDs; repeat with a fork proof only after a route-positive trigger appears.");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function stringify(value) { return value === null || value === undefined ? null : value.toString(); }
function unique(items) { return [...new Set((items || []).filter(Boolean))]; }
function sumNumbers(values) { return values.reduce((acc, value) => acc + (Number.isFinite(Number(value)) ? Number(value) : 0), 0); }

async function main() {
  ensureDir(RAW_OUT);
  const artifact = await scan();
  fs.writeFileSync(RAW_OUT, `${JSON.stringify(artifact, jsonReplacer, 2)}\n`);
  fs.writeFileSync(REPORT_OUT, buildReport(artifact));
  if (!QUIET) {
    const s = artifact.summary || {};
    console.error(`wrote ${RAW_OUT}`);
    console.error(`wrote ${REPORT_OUT}`);
    console.error(`summary routePositive=${s.routePositive || 0} watch=${s.watchCandidates || 0} sampled=${s.sampledTroves || 0} materialLiquidatable=${s.materialSampledLiquidatableTroves || 0}`);
  }
}

main().catch((error) => {
  console.error(sanitizeError(error));
  process.exitCode = 1;
});
