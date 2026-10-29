#!/usr/bin/env node
// scan-liquity-v1-phase0.js - read-only Liquity V1 Phase 0 scanner.
// RPC URLs are resolved in memory only. Never prints/stores RPC URLs, private keys, calldata, or trove IDs.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { resolveRpcPool } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "liquity-v1-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "liquity-v1-phase0-triage.md");
const PUBLIC_TARGETS = path.join(WORKSPACE, "reports", "raw", "fast", "public-audit-target-discovery.json");
const QUIET = process.argv.includes("--quiet");

const SIGNAL_BANNER = "\uD83D\uDFE2 DORMANT";
const ETHEREUM_CHAIN_ID = 1;
const ZERO = "0x0000000000000000000000000000000000000000";
const WAD = 10n ** 18n;
const ETH_GAS_COMPENSATION_RAW = ethers.parseUnits("0.5", 18);
const COLL_GAS_COMPENSATION_DIVISOR = 200n;
const MIN_MATERIAL_DEBT_USD = Number(process.env.LIQUITY_V1_MIN_MATERIAL_DEBT_USD || "1000");
const NEAR_MCR_BPS = Number(process.env.LIQUITY_V1_NEAR_MCR_BPS || "500");
const MAX_TROVE_SAMPLES = Number(process.env.LIQUITY_V1_MAX_TROVE_SAMPLES || "240");
const REQUEST_TIMEOUT_MS = Number(process.env.LIQUITY_V1_REQUEST_TIMEOUT_MS || "20000");
const DEXSCREENER_PAIR = "https://api.dexscreener.com/latest/dex/tokens/0x5f98805A4E8be255a32880FDeC7F6728C6568bA0";

// Source: https://raw.githubusercontent.com/liquity/dev/main/packages/lib-ethers/deployments/default/mainnet.json
const DEPLOYMENT = {
  chainId: 1,
  version: "5174ecd0da4842157aba989499200d690b7e374f",
  deploymentDate: 1617611590000,
  startBlock: 12178551,
  source: "liquity/dev packages/lib-ethers/deployments/default/mainnet.json",
  addresses: {
    activePool: "0xDf9Eb223bAFBE5c5271415C75aeCD68C21fE3D7F",
    borrowerOperations: "0x24179CD81c9e782A4096035f7eC97fB8B783e007",
    troveManager: "0xA39739EF8b0231DbFA0DcdA07d7e29faAbCf4bb2",
    collSurplusPool: "0x3D32e8b97Ed5881324241Cf03b2DA5E2EBcE5521",
    defaultPool: "0x896a3F03176f05CFbb4f006BfCd8723F2B0D741C",
    hintHelpers: "0xE84251b93D9524E0d2e621Ba7dc7cb3579F997C0",
    lqtyStaking: "0x4f9Fbb3f1E99B56e0Fe2892e623Ed36A76Fc605d",
    priceFeed: "0x4c517D4e2C851CA76d7eC94B805269Df0f2201De",
    sortedTroves: "0x8FdD3fbFEb32b28fb73555518f8b361bCeA741A6",
    stabilityPool: "0x66017D22b0f8556afDd19FC67041899Eb65a21bb",
    gasPool: "0x9555b042F969E561855e5F28cB1230819149A8d9",
    lusdToken: "0x5f98805A4E8be255a32880FDeC7F6728C6568bA0",
    lqtyToken: "0x6DEA81C8171D0bA574754EF6F8b412F2Ed88c54D",
    multiTroveGetter: "0xFc92d0E9Fa35df17E3A6d9F40716ca2cE749922B",
    uniToken: "0xF20EF17b889b437C151eB5bA15A47bFc62bfF469",
  },
};

const CORE_KEYS = [
  "troveManager", "borrowerOperations", "stabilityPool", "priceFeed", "sortedTroves",
  "activePool", "defaultPool", "lusdToken", "lqtyToken", "multiTroveGetter",
];

const TROVE_MANAGER_ABI = [
  "function MCR() view returns (uint256)",
  "function CCR() view returns (uint256)",
  "function LUSD_GAS_COMPENSATION() view returns (uint256)",
  "function MIN_NET_DEBT() view returns (uint256)",
  "function getEntireSystemColl() view returns (uint256)",
  "function getEntireSystemDebt() view returns (uint256)",
  "function getTCR(uint256 price) view returns (uint256)",
  "function checkRecoveryMode(uint256 price) view returns (bool)",
  "function getTroveOwnersCount() view returns (uint256)",
  "function getCurrentICR(address borrower,uint256 price) view returns (uint256)",
  "function getEntireDebtAndColl(address borrower) view returns (uint256 debt,uint256 coll,uint256 pendingLUSDDebtReward,uint256 pendingETHReward)",
  "function getTroveStatus(address borrower) view returns (uint256)",
  "function getRedemptionRateWithDecay() view returns (uint256)",
  "function getRedemptionFeeWithDecay(uint256 ETHDrawn) view returns (uint256)",
  "function baseRate() view returns (uint256)",
  "function lastFeeOperationTime() view returns (uint256)",
  "function owner() view returns (address)",
  "function priceFeed() view returns (address)",
  "function sortedTroves() view returns (address)",
  "function stabilityPool() view returns (address)",
  "function activePool() view returns (address)",
  "function defaultPool() view returns (address)",
  "function lusdToken() view returns (address)",
];

const SORTED_TROVES_ABI = [
  "function getFirst() view returns (address)",
  "function getLast() view returns (address)",
  "function getPrev(address id) view returns (address)",
  "function getNext(address id) view returns (address)",
  "function getSize() view returns (uint256)",
  "function contains(address id) view returns (bool)",
  "function owner() view returns (address)",
];

const PRICE_FEED_ABI = [
  "function fetchPrice() returns (uint256)",
  "function lastGoodPrice() view returns (uint256)",
  "function status() view returns (uint8)",
  "function TIMEOUT() view returns (uint256)",
  "function MAX_PRICE_DIFFERENCE_BETWEEN_ORACLES() view returns (uint256)",
  "function MAX_PRICE_DEVIATION_FROM_PREVIOUS_ROUND() view returns (uint256)",
  "function priceAggregator() view returns (address)",
  "function tellorCaller() view returns (address)",
  "function owner() view returns (address)",
];

const STABILITY_POOL_ABI = [
  "function getTotalLUSDDeposits() view returns (uint256)",
  "function getETH() view returns (uint256)",
  "function P() view returns (uint256)",
  "function currentEpoch() view returns (uint128)",
  "function currentScale() view returns (uint128)",
  "function owner() view returns (address)",
  "function troveManager() view returns (address)",
  "function priceFeed() view returns (address)",
  "function lusdToken() view returns (address)",
];

const POOL_ABI = [
  "function getETH() view returns (uint256)",
  "function getLUSDDebt() view returns (uint256)",
  "function owner() view returns (address)",
];

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
];

const CHAINLINK_ABI = [
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
  "function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)",
];

function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function readText(file) { try { return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""; } catch (_) { return ""; } }
function readJson(file, fallback = null) { try { const text = readText(file).replace(/^\uFEFF/, ""); return text ? JSON.parse(text) : fallback; } catch (_) { return fallback; } }
function jsonReplacer(_key, value) { return typeof value === "bigint" ? value.toString() : value; }
function sanitizeError(error, max = 220) { return String(error?.shortMessage || error?.message || error || "error").replace(/https?:\/\/\S+/g, "[redacted-url]").replace(/0x[a-fA-F0-9]{80,}/g, "[redacted-hex]").slice(0, max); }
function safeText(value, max = 160) { return String(value ?? "").replace(/https?:\/\/\S+/g, "[redacted-url]").replace(/[\r\n|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) || null; }
function normalizeAddress(value) { try { return ethers.getAddress(String(value || "").replace(/^0X/, "0x")); } catch (_) { return null; } }
function lowerAddress(value) { const addr = normalizeAddress(value); return addr ? addr.toLowerCase() : null; }
function round(value, decimals = 4) { const n = Number(value); if (!Number.isFinite(n)) return null; const f = 10 ** decimals; return Math.round(n * f) / f; }
function fmt(value, decimals = 2) { const n = Number(value); return Number.isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: decimals }) : "n/a"; }
function fmtUsd(value) { const n = Number(value); return Number.isFinite(n) ? `$${Math.round(n).toLocaleString("en-US")}` : "n/a"; }
function toBig(value) { try { return BigInt(value ?? 0); } catch (_) { return 0n; } }
function unitsToNumber(value, decimals = 18) { try { const n = Number(ethers.formatUnits(toBig(value), Number(decimals))); return Number.isFinite(n) ? n : null; } catch (_) { return null; } }
function wadToNumber(value) { return unitsToNumber(value, 18); }
function wadToBps(value) { try { return Number((toBig(value) * 10000n) / WAD); } catch (_) { return null; } }
function bpsDiff(a, b) { const x = Number(a); const y = Number(b); return Number.isFinite(x) && Number.isFinite(y) && y !== 0 ? round(((x - y) / y) * 10000, 2) : null; }
function pctFromBps(value) { const n = Number(value); return Number.isFinite(n) ? round(n / 100, 2) : null; }
function hexStrip(value) { return String(value || "").replace(/^0x/i, ""); }
function isZeroAddress(value) { const addr = normalizeAddress(value); return !addr || addr === ZERO; }

async function tryCall(fn, fallback = null) {
  try { return await fn(); } catch (_) { return fallback; }
}

async function fetchJson(url, options = {}) {
  try {
    const res = await fetch(url, { ...options, signal: AbortSignal.timeout(options.timeoutMs || REQUEST_TIMEOUT_MS) });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  }
}

async function safeCode(provider, address) {
  const addr = normalizeAddress(address);
  if (!addr) return "0x";
  return await tryCall(() => provider.getCode(addr), "0x");
}

async function addressKind(provider, address) {
  const addr = normalizeAddress(address);
  if (!addr || addr === ZERO) return null;
  const code = await safeCode(provider, addr);
  return code && code !== "0x" ? "contract" : "eoa";
}

async function tokenMeta(provider, token, fallback = {}) {
  const addr = normalizeAddress(token);
  if (!addr) return { address: token, symbol: fallback.symbol || "UNK", name: fallback.name || null, decimals: fallback.decimals ?? 18 };
  const c = new ethers.Contract(addr, ERC20_ABI, provider);
  const [symbol, name, decimals, totalSupply] = await Promise.all([
    tryCall(() => c.symbol(), fallback.symbol || null),
    tryCall(() => c.name(), fallback.name || null),
    tryCall(() => c.decimals(), fallback.decimals ?? 18),
    tryCall(() => c.totalSupply(), null),
  ]);
  return {
    address: addr,
    symbol: safeText(symbol || fallback.symbol || "UNK", 32),
    name: safeText(name || fallback.name || "", 80),
    decimals: Number(decimals ?? fallback.decimals ?? 18),
    totalSupply: totalSupply?.toString?.() ?? null,
    totalSupplyUnits: totalSupply === null ? null : round(unitsToNumber(totalSupply, Number(decimals ?? 18)), 2),
  };
}

async function readOnlyCall(provider, to, iface, functionName, args = []) {
  const data = iface.encodeFunctionData(functionName, args);
  const raw = await provider.call({ to, data });
  const decoded = iface.decodeFunctionResult(functionName, raw);
  return decoded.length === 1 ? decoded[0] : decoded;
}

function getDefillamaContext() {
  const data = readJson(PUBLIC_TARGETS, null);
  const rows = [
    ...(data?.phase0Queue || []),
    ...(data?.targetedRefreshQueue || []),
    ...(data?.consumerJoinFirstQueue || []),
    ...(data?.combinedCandidates || []),
  ];
  const row = rows.find((r) => String(r.slug || "").toLowerCase() === "liquity-v1") || null;
  return row ? {
    name: row.name || "Liquity V1",
    slug: row.slug || "liquity-v1",
    category: row.category || null,
    surface: row.surface || null,
    chains: row.chains || row.chain || null,
    tvlUsd: row.tvlUsd ?? row.tvl ?? null,
    source: "reports/raw/fast/public-audit-target-discovery.json",
  } : { name: "Liquity V1", slug: "liquity-v1", source: "fallback" };
}

async function fetchLusdMarket() {
  const data = await fetchJson(DEXSCREENER_PAIR, { timeoutMs: 12_000 });
  const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
  const ethPairs = pairs.filter((p) => String(p.chainId || "").toLowerCase() === "ethereum");
  const ranked = ethPairs
    .map((p) => ({
      dexId: safeText(p.dexId, 32),
      pairLabel: safeText([p.baseToken?.symbol, p.quoteToken?.symbol].filter(Boolean).join("/"), 32),
      priceUsd: Number(p.priceUsd),
      liquidityUsd: Number(p.liquidity?.usd || 0),
      volume24hUsd: Number(p.volume?.h24 || 0),
    }))
    .filter((p) => Number.isFinite(p.priceUsd))
    .sort((a, b) => (b.liquidityUsd || 0) - (a.liquidityUsd || 0));
  const best = ranked[0] || null;
  const weighted = ranked.reduce((acc, p) => {
    if (!Number.isFinite(p.priceUsd) || !Number.isFinite(p.liquidityUsd) || p.liquidityUsd <= 0) return acc;
    acc.num += p.priceUsd * p.liquidityUsd;
    acc.den += p.liquidityUsd;
    return acc;
  }, { num: 0, den: 0 });
  return {
    source: "DexScreener token endpoint",
    ethereumPairRows: ranked.length,
    bestPair: best,
    weightedPriceUsd: weighted.den > 0 ? round(weighted.num / weighted.den, 6) : null,
    totalLiquidityUsd: round(ranked.reduce((s, p) => s + (p.liquidityUsd || 0), 0), 2),
    totalVolume24hUsd: round(ranked.reduce((s, p) => s + (p.volume24hUsd || 0), 0), 2),
    topPairs: ranked.slice(0, 5),
  };
}

async function contractInventory(provider) {
  const rows = [];
  for (const key of CORE_KEYS) {
    const address = DEPLOYMENT.addresses[key];
    const code = await safeCode(provider, address);
    rows.push({ key, address, codePresent: Boolean(code && code !== "0x"), codeBytes: code && code !== "0x" ? (hexStrip(code).length / 2) : 0 });
  }
  return rows;
}

async function oracleState(provider, blockTs) {
  const priceFeed = new ethers.Contract(DEPLOYMENT.addresses.priceFeed, PRICE_FEED_ABI, provider);
  const iface = new ethers.Interface(PRICE_FEED_ABI);
  const [fetchPriceRaw, lastGoodPriceRaw, status, timeout, maxOracleDiffRaw, maxPreviousDeviationRaw, aggregator, tellorCaller, owner] = await Promise.all([
    tryCall(() => readOnlyCall(provider, DEPLOYMENT.addresses.priceFeed, iface, "fetchPrice"), null),
    tryCall(() => priceFeed.lastGoodPrice(), null),
    tryCall(() => priceFeed.status(), null),
    tryCall(() => priceFeed.TIMEOUT(), null),
    tryCall(() => priceFeed.MAX_PRICE_DIFFERENCE_BETWEEN_ORACLES(), null),
    tryCall(() => priceFeed.MAX_PRICE_DEVIATION_FROM_PREVIOUS_ROUND(), null),
    tryCall(() => priceFeed.priceAggregator(), null),
    tryCall(() => priceFeed.tellorCaller(), null),
    tryCall(() => priceFeed.owner(), null),
  ]);
  const aggregatorAddr = normalizeAddress(aggregator);
  let chainlink = null;
  if (aggregatorAddr) {
    const feed = new ethers.Contract(aggregatorAddr, CHAINLINK_ABI, provider);
    const [decimals, description, latest] = await Promise.all([
      tryCall(() => feed.decimals(), null),
      tryCall(() => feed.description(), null),
      tryCall(() => feed.latestRoundData(), null),
    ]);
    const answer = latest ? toBig(latest.answer ?? latest[1]) : null;
    const updatedAt = latest ? Number(latest.updatedAt ?? latest[3]) : null;
    const dec = decimals === null ? 8 : Number(decimals);
    const priceUsd = answer === null ? null : unitsToNumber(answer, dec);
    chainlink = {
      priceFeed: aggregatorAddr,
      description: safeText(description, 80),
      decimals: dec,
      priceUsd: round(priceUsd, 4),
      updatedAt,
      ageSeconds: updatedAt && blockTs ? Math.max(0, blockTs - updatedAt) : null,
      answeredInRoundLag: latest ? String((latest.roundId ?? latest[0]) - (latest.answeredInRound ?? latest[4])) : null,
    };
  }
  const fetchPriceUsd = wadToNumber(fetchPriceRaw);
  const lastGoodPriceUsd = wadToNumber(lastGoodPriceRaw);
  const timeoutSeconds = timeout === null ? null : Number(timeout);
  const statusLabels = ["chainlinkWorking", "usingTellorChainlinkUntrusted", "bothOraclesUntrusted", "usingTellorChainlinkFrozen", "usingChainlinkTellorUntrusted"];
  return {
    priceFeed: DEPLOYMENT.addresses.priceFeed,
    status: status === null ? null : Number(status),
    statusLabel: status === null ? null : statusLabels[Number(status)] || `unknown-${Number(status)}`,
    fetchPriceUsd: round(fetchPriceUsd, 4),
    lastGoodPriceUsd: round(lastGoodPriceUsd, 4),
    fetchVsLastGoodBps: bpsDiff(fetchPriceUsd, lastGoodPriceUsd),
    timeoutSeconds,
    maxOracleDiffBps: wadToBps(maxOracleDiffRaw),
    maxPreviousRoundDeviationBps: wadToBps(maxPreviousDeviationRaw),
    chainlink,
    tellorCaller: normalizeAddress(tellorCaller),
    owner: normalizeAddress(owner),
    ownerKind: await addressKind(provider, owner),
    staleButAccepted: Boolean(chainlink?.ageSeconds !== null && timeoutSeconds !== null && chainlink.ageSeconds > timeoutSeconds && fetchPriceRaw !== null),
  };
}

async function systemState(provider, priceRaw) {
  const tm = new ethers.Contract(DEPLOYMENT.addresses.troveManager, TROVE_MANAGER_ABI, provider);
  const sp = new ethers.Contract(DEPLOYMENT.addresses.stabilityPool, STABILITY_POOL_ABI, provider);
  const sorted = new ethers.Contract(DEPLOYMENT.addresses.sortedTroves, SORTED_TROVES_ABI, provider);
  const activePool = new ethers.Contract(DEPLOYMENT.addresses.activePool, POOL_ABI, provider);
  const defaultPool = new ethers.Contract(DEPLOYMENT.addresses.defaultPool, POOL_ABI, provider);
  const [mcr, ccr, lusdGasComp, minNetDebt, systemColl, systemDebt, tcr, recoveryMode, troveOwnersCount, sortedSize, spLusd, spEth, spP, spEpoch, spScale, activeEth, activeDebt, defaultEth, defaultDebt, redemptionRate, baseRate, lastFeeOperationTime] = await Promise.all([
    tryCall(() => tm.MCR(), null),
    tryCall(() => tm.CCR(), null),
    tryCall(() => tm.LUSD_GAS_COMPENSATION(), null),
    tryCall(() => tm.MIN_NET_DEBT(), null),
    tryCall(() => tm.getEntireSystemColl(), null),
    tryCall(() => tm.getEntireSystemDebt(), null),
    priceRaw === null ? null : tryCall(() => tm.getTCR(priceRaw), null),
    priceRaw === null ? null : tryCall(() => tm.checkRecoveryMode(priceRaw), null),
    tryCall(() => tm.getTroveOwnersCount(), null),
    tryCall(() => sorted.getSize(), null),
    tryCall(() => sp.getTotalLUSDDeposits(), null),
    tryCall(() => sp.getETH(), null),
    tryCall(() => sp.P(), null),
    tryCall(() => sp.currentEpoch(), null),
    tryCall(() => sp.currentScale(), null),
    tryCall(() => activePool.getETH(), null),
    tryCall(() => activePool.getLUSDDebt(), null),
    tryCall(() => defaultPool.getETH(), null),
    tryCall(() => defaultPool.getLUSDDebt(), null),
    tryCall(() => tm.getRedemptionRateWithDecay(), null),
    tryCall(() => tm.baseRate(), null),
    tryCall(() => tm.lastFeeOperationTime(), null),
  ]);
  const priceUsd = wadToNumber(priceRaw);
  const systemCollEth = unitsToNumber(systemColl, 18);
  const systemDebtLusd = unitsToNumber(systemDebt, 18);
  return {
    mcrBps: wadToBps(mcr),
    ccrBps: wadToBps(ccr),
    lusdGasCompensation: lusdGasComp?.toString?.() ?? null,
    lusdGasCompensationUnits: unitsToNumber(lusdGasComp, 18),
    minNetDebt: minNetDebt?.toString?.() ?? null,
    minNetDebtUnits: unitsToNumber(minNetDebt, 18),
    totalSystemCollEth: round(systemCollEth, 4),
    totalSystemDebtLusd: round(systemDebtLusd, 2),
    totalSystemCollUsd: round((systemCollEth || 0) * (priceUsd || 0), 2),
    tcrBps: wadToBps(tcr),
    recoveryMode: Boolean(recoveryMode),
    troveOwnersCount: troveOwnersCount === null ? null : Number(troveOwnersCount),
    sortedTrovesSize: sortedSize === null ? null : Number(sortedSize),
    stabilityPool: {
      totalLusdDeposits: spLusd?.toString?.() ?? null,
      totalLusdDepositsUnits: round(unitsToNumber(spLusd, 18), 2),
      totalLusdDepositsUsd: round(unitsToNumber(spLusd, 18), 2),
      ethBalance: spEth?.toString?.() ?? null,
      ethBalanceUnits: round(unitsToNumber(spEth, 18), 4),
      ethBalanceUsd: round((unitsToNumber(spEth, 18) || 0) * (priceUsd || 0), 2),
      P: spP?.toString?.() ?? null,
      currentEpoch: spEpoch === null ? null : Number(spEpoch),
      currentScale: spScale === null ? null : Number(spScale),
    },
    pools: {
      activePoolEth: round(unitsToNumber(activeEth, 18), 4),
      activePoolDebtLusd: round(unitsToNumber(activeDebt, 18), 2),
      defaultPoolEth: round(unitsToNumber(defaultEth, 18), 4),
      defaultPoolDebtLusd: round(unitsToNumber(defaultDebt, 18), 2),
    },
    redemption: {
      rateBps: wadToBps(redemptionRate),
      baseRateBps: wadToBps(baseRate),
      lastFeeOperationTime: lastFeeOperationTime === null ? null : Number(lastFeeOperationTime),
    },
  };
}

async function sampleTroves(provider, priceRaw, system) {
  const tm = new ethers.Contract(DEPLOYMENT.addresses.troveManager, TROVE_MANAGER_ABI, provider);
  const sorted = new ethers.Contract(DEPLOYMENT.addresses.sortedTroves, SORTED_TROVES_ABI, provider);
  const rows = [];
  let cursor = await tryCall(() => sorted.getLast(), null);
  const seen = new Set();
  const sampleLimit = Math.max(0, Math.min(MAX_TROVE_SAMPLES, Number(system.sortedTrovesSize || 0)));
  for (let i = 0; cursor && !isZeroAddress(cursor) && i < sampleLimit; i++) {
    const key = lowerAddress(cursor);
    if (!key || seen.has(key)) break;
    seen.add(key);
    const [status, data, icr] = await Promise.all([
      tryCall(() => tm.getTroveStatus(cursor), null),
      tryCall(() => tm.getEntireDebtAndColl(cursor), null),
      priceRaw === null ? null : tryCall(() => tm.getCurrentICR(cursor, priceRaw), null),
    ]);
    const debtRaw = data ? toBig(data.debt ?? data[0]) : 0n;
    const collRaw = data ? toBig(data.coll ?? data[1]) : 0n;
    const debt = unitsToNumber(debtRaw, 18) || 0;
    const coll = unitsToNumber(collRaw, 18) || 0;
    const priceUsd = wadToNumber(priceRaw) || 0;
    const icrBps = wadToBps(icr);
    const mcrBps = system.mcrBps;
    const ccrBps = system.ccrBps;
    const active = Number(status ?? 0) === 1;
    const liquidatableNormal = active && icrBps !== null && mcrBps !== null && icrBps < mcrBps;
    const liquidatableRecovery = active && Boolean(system.recoveryMode) && icrBps !== null && ccrBps !== null && icrBps < ccrBps;
    const collGasCompEth = Number(coll) > 0 ? Math.min(coll * 0.005, 0.5) : 0;
    const collGasCompUsd = collGasCompEth * priceUsd;
    rows.push({
      sampleIndex: rows.length + 1,
      direction: "tail-lowest-nicr",
      status: status === null ? null : Number(status),
      active,
      debtLusd: round(debt, 2),
      collEth: round(coll, 6),
      collUsd: round(coll * priceUsd, 2),
      icrBps,
      distanceToMcrBps: icrBps === null || mcrBps === null ? null : round(icrBps - mcrBps, 2),
      liquidatableNormal,
      liquidatableRecovery,
      materialDebt: debt >= MIN_MATERIAL_DEBT_USD,
      callerCompEstimateUsd: round((system.lusdGasCompensationUnits || 0) + collGasCompUsd, 2),
    });
    cursor = await tryCall(() => sorted.getPrev(cursor), null);
  }
  const activeRows = rows.filter((r) => r.active);
  const liquidatableRows = rows.filter((r) => r.liquidatableNormal || r.liquidatableRecovery);
  const materialLiquidatableRows = liquidatableRows.filter((r) => r.materialDebt);
  const nearMcrRows = activeRows.filter((r) => r.distanceToMcrBps !== null && r.distanceToMcrBps >= 0 && r.distanceToMcrBps <= NEAR_MCR_BPS);
  const bestDirectGasCompNetUsd = materialLiquidatableRows.length ? Math.max(...materialLiquidatableRows.map((r) => r.callerCompEstimateUsd || 0)) : null;
  return {
    sampleLimit,
    sampledRows: rows.length,
    activeSampledRows: activeRows.length,
    liquidatableRows: liquidatableRows.length,
    materialLiquidatableRows: materialLiquidatableRows.length,
    nearMcrRows: nearMcrRows.length,
    bestDirectGasCompNetUsd,
    rows,
  };
}

function routeAssessment(system, oracle, troves, lusdMarket, gas) {
  const redemptionRateBps = system.redemption?.rateBps ?? null;
  const lusdPrice = lusdMarket?.weightedPriceUsd || lusdMarket?.bestPair?.priceUsd || null;
  const redemptionGrossEdgeBps = lusdPrice ? round((1 - lusdPrice) * 10000, 2) : null;
  const redemptionNetEdgeBps = redemptionGrossEdgeBps === null || redemptionRateBps === null ? null : round(redemptionGrossEdgeBps - redemptionRateBps, 2);
  const materialLiquidatable = troves.materialLiquidatableRows || 0;
  const routePositiveLiquidation = materialLiquidatable > 0 && Number(troves.bestDirectGasCompNetUsd || 0) > 0;
  const routePositiveRedemption = redemptionNetEdgeBps !== null && redemptionNetEdgeBps > 50 && Number(lusdMarket?.totalLiquidityUsd || 0) >= 10000;
  const staleAccepted = Boolean(oracle.staleButAccepted);
  const oracleDivergenceWatch = Math.abs(Number(oracle.fetchVsLastGoodBps || 0)) >= 100;
  const routePositive = routePositiveLiquidation || false;
  const watchCandidates = [
    materialLiquidatable > 0 ? "material-liquidatable-trove-sample" : null,
    routePositiveRedemption ? "lusd-redemption-discount-needs-exact-route" : null,
    staleAccepted ? "stale-chainlink-feed-accepted" : null,
    oracleDivergenceWatch ? "fetch-vs-lastGood-divergence" : null,
    (troves.nearMcrRows || 0) > 0 ? "near-mcr-tail-troves" : null,
  ].filter(Boolean);
  return {
    watchCandidates: watchCandidates.length,
    watchCandidateLabels: watchCandidates,
    routePositive: routePositive ? 1 : 0,
    executableNow: false,
    signedActionJustified: false,
    forkGate: routePositive ? "open-route-positive-readonly" : "closed-route-positive-zero",
    liquidation: {
      routePositive: routePositiveLiquidation,
      materialLiquidatableRows: materialLiquidatable,
      bestDirectGasCompNetUsd: troves.bestDirectGasCompNetUsd,
      blocker: routePositiveLiquidation ? null : "No material sampled trove below execution-path liquidation threshold.",
    },
    redemption: {
      lusdMarketPriceUsd: lusdPrice ? round(lusdPrice, 6) : null,
      redemptionRateBps,
      grossEdgeBps: redemptionGrossEdgeBps,
      netEdgeBeforeGasBps: redemptionNetEdgeBps,
      indicativeOnly: true,
      routePositive: false,
      blocker: routePositiveRedemption ? "Indicative LUSD discount requires exact acquisition, hints, redemption static call, slippage, and ETH exit proof before route-positive." : "No positive LUSD redemption edge after current redemption fee.",
    },
    gas,
  };
}

function buildReport(result) {
  const s = result.summary;
  const oracle = result.oracle;
  const sys = result.system;
  const troves = result.troveSample;
  const route = result.routeAssessment;
  const lines = [];
  lines.push(`# ${SIGNAL_BANNER} — Liquity V1 Phase 0`);
  lines.push("");
  lines.push(`Generated: ${result.generatedAt}`);
  lines.push("");
  lines.push("## Verdict");
  lines.push(`Liquity V1 is DORMANT for the current read-only sample: routePositive=${route.routePositive}, executableNow=${route.executableNow}, signedActionJustified=${route.signedActionJustified}.`);
  lines.push(`Fork gate: ${route.forkGate}.`);
  lines.push("");
  lines.push("## Summary");
  lines.push(`| Metric | Value |`);
  lines.push(`|---|---:|`);
  lines.push(`| DefiLlama current TVL | ${fmtUsd(s.defillamaCurrentTvlUsd)} |`);
  lines.push(`| Core contracts with bytecode | ${s.coreContractsWithCode}/${s.coreContractsChecked} |`);
  lines.push(`| ETH price via Liquity fetchPrice | ${fmtUsd(oracle.fetchPriceUsd)} |`);
  lines.push(`| PriceFeed status | ${oracle.statusLabel || "n/a"} |`);
  lines.push(`| Chainlink age | ${oracle.chainlink?.ageSeconds ?? "n/a"} sec |`);
  lines.push(`| TCR | ${sys.tcrBps === null ? "n/a" : `${pctFromBps(sys.tcrBps)}%`} |`);
  lines.push(`| Recovery mode | ${sys.recoveryMode} |`);
  lines.push(`| SortedTroves size | ${sys.sortedTrovesSize ?? "n/a"} |`);
  lines.push(`| Stability Pool LUSD | ${fmtUsd(sys.stabilityPool.totalLusdDepositsUsd)} |`);
  lines.push(`| Sampled tail troves | ${troves.sampledRows}/${troves.sampleLimit} |`);
  lines.push(`| Material sampled liquidatable | ${troves.materialLiquidatableRows} |`);
  lines.push(`| Near-MCR sampled rows | ${troves.nearMcrRows} |`);
  lines.push(`| LUSD market weighted price | ${result.lusdMarket.weightedPriceUsd ?? "n/a"} |`);
  lines.push(`| Redemption fee | ${route.redemption.redemptionRateBps === null ? "n/a" : `${pctFromBps(route.redemption.redemptionRateBps)}%`} |`);
  lines.push(`| Route positive | ${route.routePositive} |`);
  lines.push("");
  lines.push("## Contract Map");
  lines.push(`| Key | Address | Bytecode |`);
  lines.push(`|---|---|---:|`);
  for (const row of result.contractRows) lines.push(`| ${row.key} | ${row.address} | ${row.codePresent ? "yes" : "no"} |`);
  lines.push("");
  lines.push("## Oracle Surface");
  lines.push(`| Check | Value |`);
  lines.push(`|---|---:|`);
  lines.push(`| PriceFeed status | ${oracle.statusLabel || "n/a"} |`);
  lines.push(`| fetchPrice | ${fmtUsd(oracle.fetchPriceUsd)} |`);
  lines.push(`| lastGoodPrice | ${fmtUsd(oracle.lastGoodPriceUsd)} |`);
  lines.push(`| fetch vs lastGood | ${oracle.fetchVsLastGoodBps ?? "n/a"} bps |`);
  lines.push(`| Chainlink description | ${oracle.chainlink?.description || "n/a"} |`);
  lines.push(`| Chainlink price | ${fmtUsd(oracle.chainlink?.priceUsd)} |`);
  lines.push(`| Chainlink age / timeout | ${oracle.chainlink?.ageSeconds ?? "n/a"} / ${oracle.timeoutSeconds ?? "n/a"} sec |`);
  lines.push(`| Stale but accepted | ${oracle.staleButAccepted} |`);
  lines.push(`| Tellor caller kind | ${oracle.tellorCaller ? "contract" : "n/a"} |`);
  lines.push("");
  lines.push("## Trove Tail Sample");
  lines.push("No trove IDs or borrower addresses are persisted; rows are ordinal samples from the lowest-NICR tail.");
  lines.push(`| Sample | Debt LUSD | Coll ETH | ICR | Distance To MCR | Liquidatable | Caller Comp Est. |`);
  lines.push(`|---:|---:|---:|---:|---:|---|---:|`);
  for (const row of troves.rows.slice(0, 20)) {
    const liq = row.liquidatableNormal || row.liquidatableRecovery;
    lines.push(`| ${row.sampleIndex} | ${fmt(row.debtLusd)} | ${fmt(row.collEth, 6)} | ${row.icrBps === null ? "n/a" : `${pctFromBps(row.icrBps)}%`} | ${row.distanceToMcrBps ?? "n/a"} bps | ${liq} | ${fmtUsd(row.callerCompEstimateUsd)} |`);
  }
  lines.push("");
  lines.push("## Route Gates");
  lines.push(`| Route | Status | Blocker |`);
  lines.push(`|---|---|---|`);
  lines.push(`| Liquidation | ${route.liquidation.routePositive ? "route-positive" : "closed"} | ${safeText(route.liquidation.blocker || "none")} |`);
  lines.push(`| Redemption | ${route.redemption.routePositive ? "route-positive" : "indicative-only/closed"} | ${safeText(route.redemption.blocker || "none")} |`);
  lines.push(`| Oracle stale/divergence | ${oracle.staleButAccepted ? "watch" : "closed"} | staleButAccepted=${oracle.staleButAccepted}, fetchVsLastGoodBps=${oracle.fetchVsLastGoodBps ?? "n/a"} |`);
  lines.push("");
  lines.push("## Scope Caveats");
  lines.push("This is bounded Phase 0 live-state reconnaissance using official V1 deployment metadata, Ethereum read-only calls, DexScreener market context, and a capped SortedTroves tail sample. It does not run a fork, estimate signed transaction gas, submit calldata, or persist trove identifiers.");
  lines.push("");
  lines.push("## Next Read-Only Step");
  lines.push("Keep Liquity V1 on liquidation/redemption watch. Open fork work only if a material trove is currently below the execution threshold or LUSD trades below peg enough to justify exact acquisition, hinting, redemption static call, slippage, gas, and ETH exit proof.");
  lines.push("");
  return lines.join("\n");
}

async function main() {
  const generatedAt = new Date().toISOString();
  const rpcPool = await resolveRpcPool([ETHEREUM_CHAIN_ID]);
  const rpcUrl = rpcPool[ETHEREUM_CHAIN_ID];
  if (!rpcUrl) throw new Error("No Ethereum RPC available");
  const provider = new ethers.JsonRpcProvider(rpcUrl, ETHEREUM_CHAIN_ID, { staticNetwork: true });
  const [blockNumber, network, feeData, defillama, lusdMarket] = await Promise.all([
    provider.getBlockNumber(),
    provider.getNetwork(),
    tryCall(() => provider.getFeeData(), null),
    Promise.resolve(getDefillamaContext()),
    fetchLusdMarket(),
  ]);
  const block = await provider.getBlock(blockNumber);
  const blockTs = Number(block?.timestamp || 0);
  const [contractRows, tokenRows, oracle] = await Promise.all([
    contractInventory(provider),
    Promise.all([
      tokenMeta(provider, DEPLOYMENT.addresses.lusdToken, { symbol: "LUSD", name: "LUSD Stablecoin", decimals: 18 }),
      tokenMeta(provider, DEPLOYMENT.addresses.lqtyToken, { symbol: "LQTY", name: "Liquity", decimals: 18 }),
    ]),
    oracleState(provider, blockTs),
  ]);
  const fetchPriceRaw = oracle.fetchPriceUsd === null ? null : ethers.parseUnits(String(oracle.fetchPriceUsd), 18);
  const system = await systemState(provider, fetchPriceRaw);
  const troveSample = await sampleTroves(provider, fetchPriceRaw, system);
  const gas = {
    gasPriceGwei: feeData?.gasPrice ? round(Number(ethers.formatUnits(feeData.gasPrice, "gwei")), 4) : null,
    maxFeePerGasGwei: feeData?.maxFeePerGas ? round(Number(ethers.formatUnits(feeData.maxFeePerGas, "gwei")), 4) : null,
  };
  const route = routeAssessment(system, oracle, troveSample, lusdMarket, gas);
  const summary = {
    protocol: "Liquity V1",
    slug: "liquity-v1",
    chain: "Ethereum",
    chainId: Number(network.chainId),
    blockNumber,
    blockTimestamp: blockTs,
    defillamaCurrentTvlUsd: defillama.tvlUsd ?? null,
    coreContractsChecked: contractRows.length,
    coreContractsWithCode: contractRows.filter((r) => r.codePresent).length,
    totalSystemDebtLusd: system.totalSystemDebtLusd,
    totalSystemCollUsd: system.totalSystemCollUsd,
    stabilityPoolLusdUsd: system.stabilityPool.totalLusdDepositsUsd,
    sampledTroves: troveSample.sampledRows,
    materialSampledLiquidatableTroves: troveSample.materialLiquidatableRows,
    nearMcrRows: troveSample.nearMcrRows,
    watchCandidates: route.watchCandidates,
    routePositive: route.routePositive,
    executableNow: route.executableNow,
    signedActionJustified: route.signedActionJustified,
    coverageClassification: "bounded-with-caveats",
    signal: "DORMANT",
  };
  const result = {
    generatedAt,
    scanner: "scan-liquity-v1-phase0.js",
    sourceNotes: [
      "Official deployment addresses from liquity/dev packages/lib-ethers/deployments/default/mainnet.json.",
      "Read-only Ethereum RPC calls only; fetchPrice is invoked via eth_call, not a transaction.",
      "No trove IDs or borrower addresses are written to artifact/report.",
    ],
    defillama,
    deployment: DEPLOYMENT,
    summary,
    contractRows,
    tokenRows,
    oracle,
    system,
    troveSample,
    lusdMarket,
    routeAssessment: route,
  };
  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, JSON.stringify(result, jsonReplacer, 2));
  fs.writeFileSync(REPORT_OUT, buildReport(result));
  if (!QUIET) {
    console.log(JSON.stringify({
      ok: true,
      output: path.relative(WORKSPACE, RAW_OUT),
      report: path.relative(WORKSPACE, REPORT_OUT),
      blockNumber,
      sampledTroves: troveSample.sampledRows,
      materialLiquidatable: troveSample.materialLiquidatableRows,
      watchCandidates: route.watchCandidates,
      routePositive: route.routePositive,
      executableNow: route.executableNow,
      signedActionJustified: route.signedActionJustified,
    }, null, 2));
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: sanitizeError(error) }));
  process.exit(1);
});
