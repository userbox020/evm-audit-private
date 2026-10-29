#!/usr/bin/env node
// scan-fira-phase0.js - bounded read-only Fira Phase 0 scan.
// RPC URLs are resolved in memory only. Never prints/stores RPC URLs, private keys, calldata, borrower addresses, or signed actions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { resolveRpcPool, rpcCall } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "fira-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "fira-phase0-triage.md");
const PUBLIC_TARGETS = path.join(WORKSPACE, "reports", "raw", "fast", "public-audit-target-discovery.json");
const PREFILTER = path.join(WORKSPACE, "reports", "raw", "fast", "below-materiality-prefilter.json");
const QUIET = process.argv.includes("--quiet");

const REPORT_SIGNAL = "\uD83D\uDFE2 DORMANT";
const ZERO = "0x0000000000000000000000000000000000000000";
const MATERIAL_USD = Number(process.env.FIRA_PHASE0_MATERIAL_USD || "10000");
const MATERIAL_BORROW_USD = Number(process.env.FIRA_PHASE0_MATERIAL_BORROW_USD || "10000000");
const DIVERGENCE_WATCH_BPS = Number(process.env.FIRA_PHASE0_DIVERGENCE_WATCH_BPS || "300");
const BORROW_ROUTE_WATCH_BPS = Number(process.env.FIRA_PHASE0_BORROW_ROUTE_WATCH_BPS || "0");
const LIQUIDATION_MARGIN_WATCH_BPS = Number(process.env.FIRA_PHASE0_LIQUIDATION_MARGIN_WATCH_BPS || "500");
const FROM_BLOCK = Number(process.env.FIRA_PHASE0_FROM_BLOCK || "23000000");
const LOG_CHUNK_BLOCKS = Number(process.env.FIRA_PHASE0_LOG_CHUNK_BLOCKS || "50000");
const RECENT_POSITION_LOG_BLOCKS = Number(process.env.FIRA_PHASE0_RECENT_POSITION_LOG_BLOCKS || "250000");
const MAX_BORROWERS_PER_MARKET = Number(process.env.FIRA_PHASE0_MAX_BORROWERS_PER_MARKET || "80");
const MAX_LOCAL_ARTIFACT_BYTES = Number(process.env.FIRA_PHASE0_MAX_LOCAL_ARTIFACT_BYTES || "2500000");

const FIRA = {
  chain: "Ethereum",
  chainId: 1,
  fixed: "0x280ddD897F39C33fEf1CbF863B386Cb9a8e53a0e",
  variable: "0xc8Db629192a96D6840e88a8451F17655880A2e4D",
  legacyUzr: "0xa428723eE8ffD87088C36121d72100B43F11fb6A",
  uzrMarketId: "0xa597b5a36f6cc0ede718ba58b2e23f5c747da810bf8e299022d88123ab03340e",
  usd0: "0x73A15FeD60Bf67631dC6cd7Bc5B6e8da8190aCF5",
  bUsd0: "0x35D8949372D46B7a3D5A56006AE77B215fc69bC0",
  fwUsdc: "0x62F5366C9E21A95326C461a098a408e034e017b3",
  uzrOracle: "0x30Da78355FcEA04D1fa34AF3c318BE203C6F2145",
  uzrIrm: "0xdfCF197B0B65066183b04B88d50ACDC0C4b01385",
  uzrWhitelist: "0xFE7C47895eDb12a990b311Df33B90Cfea1D44c24",
};

const LEGACY_UZR_PARAMS = [
  FIRA.usd0,
  FIRA.bUsd0,
  FIRA.uzrOracle,
  FIRA.uzrIrm,
  "880000000000000000",
  "999900000000000000",
  FIRA.uzrWhitelist,
];

const CREATE_MARKET = new ethers.Interface([
  "event CreateMarket(bytes32 indexed id,(address loanToken,address collateralToken,address oracle,address irm,uint256 ltv,uint256 lltv,address whitelist) marketParams)",
]);

const POSITION_IFACE = new ethers.Interface([
  "event Borrow(bytes32 indexed id,address caller,address indexed onBehalf,address indexed receiver,uint256 assets,uint256 shares)",
  "event Repay(bytes32 indexed id,address indexed caller,address indexed onBehalf,uint256 assets,uint256 shares)",
  "event SupplyCollateral(bytes32 indexed id,address indexed caller,address indexed onBehalf,uint256 assets)",
  "event WithdrawCollateral(bytes32 indexed id,address caller,address indexed onBehalf,address indexed receiver,uint256 assets)",
  "event Liquidate(bytes32 indexed id,address indexed caller,address indexed borrower,uint256 repaidAssets,uint256 repaidShares,uint256 seizedAssets,uint256 badDebtAssets,uint256 badDebtShares)",
]);

const LENDING_ABI = [
  "function market((address loanToken,address collateralToken,address oracle,address irm,uint256 ltv,uint256 lltv,address whitelist) marketParams) view returns (uint128 totalSupplyAssets,uint128 totalSupplyShares,uint128 totalBorrowAssets,uint128 totalBorrowShares,uint128 lastUpdate,uint128 fee)",
  "function market(bytes32 id) view returns (uint128 totalSupplyAssets,uint128 totalSupplyShares,uint128 totalBorrowAssets,uint128 totalBorrowShares,uint128 lastUpdate,uint128 fee)",
  "function getUserPosition((address loanToken,address collateralToken,address oracle,address irm,uint256 ltv,uint256 lltv,address whitelist) marketParams,address user) view returns (uint256 supplyAssets,uint256 supplyShares,uint256 borrowAssets,uint256 borrowShares,uint256 collateralAssets)",
  "function owner() view returns (address)",
  "function admin() view returns (address)",
  "function feeRecipient() view returns (address)",
];

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
];
const BYTES32_TOKEN_ABI = ["function symbol() view returns (bytes32)", "function name() view returns (bytes32)"];
const ORACLE_ABI = [
  "function price() view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
  "function owner() view returns (address)",
  "function admin() view returns (address)",
];

const EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";

function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function readText(file) { try { return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""; } catch (_) { return ""; } }
function readJson(file, fallback = null) { try { const t = readText(file).replace(/^\uFEFF/, ""); return t ? JSON.parse(t) : fallback; } catch (_) { return fallback; } }
function jsonReplacer(_key, value) { return typeof value === "bigint" ? value.toString() : value; }
function normalizeAddress(value) { try { return ethers.getAddress(String(value || "").replace(/^0X/, "0x")); } catch (_) { return null; } }
function lowerAddress(value) { const addr = normalizeAddress(value); return addr ? addr.toLowerCase() : null; }
function normalizeBytes32(value) { try { return ethers.hexlify(ethers.getBytes(value)).toLowerCase(); } catch (_) { return null; } }
function compactAddress(value) { const addr = normalizeAddress(value); return addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : "n/a"; }
function strip0x(value) { return String(value || "").replace(/^0x/i, ""); }
function toBig(value) { try { return BigInt(value ?? 0); } catch (_) { return 0n; } }
function unique(items) { return [...new Set((items || []).filter(Boolean))]; }
function asNumber(value) { if (value === null || value === undefined) return null; if (typeof value === "number") return Number.isFinite(value) ? value : null; const n = Number(String(value).replace(/[$,%\s,]/g, "")); return Number.isFinite(n) ? n : null; }
function round(value, decimals = 2) { const n = asNumber(value); if (n === null) return null; const f = 10 ** decimals; return Math.round(n * f) / f; }
function unitsToNumber(value, decimals = 18) { try { const n = Number(ethers.formatUnits(toBig(value), Number(decimals ?? 18))); return Number.isFinite(n) ? n : null; } catch (_) { return null; } }
function wadBps(value) { try { return Number((toBig(value) * 10000n) / 10n ** 18n); } catch (_) { return null; } }
function hexBlock(n) { return `0x${Number(n).toString(16)}`; }
function formatUsd(value) { const n = asNumber(value); return n === null ? "n/a" : `$${Math.round(n).toLocaleString("en-US")}`; }
function formatBps(value) { const n = asNumber(value); return n === null ? "n/a" : `${round(n, 2)}bps`; }
function formatPctBps(value) { const n = asNumber(value); return n === null ? "n/a" : `${round(n / 100, 2)}%`; }
function safeText(value, max = 160) { return String(value ?? "").replace(/https?:\/\/\S+/g, "[redacted-url]").replace(/[\r\n|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) || null; }
function stableFallback(symbol) { return ["USDC", "USDT", "DAI", "USD0", "BUSD0", "CRVUSD", "FRXUSD"].includes(String(symbol || "").toUpperCase()) ? 1 : null; }

async function tryCall(fn, fallback = null) {
  try { return await fn(); } catch (_) { return fallback; }
}

async function fetchJson(url, timeoutMs = 20_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "evm-audit-fira-phase0/1.0" } });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function safeCode(provider, address) {
  const addr = normalizeAddress(address);
  if (!addr) return "0x";
  return await tryCall(() => provider.getCode(addr), "0x");
}

async function getCodeBytes(provider, address) {
  const code = await safeCode(provider, address);
  return code && code !== "0x" ? strip0x(code).length / 2 : 0;
}

async function storageAddress(provider, address, slot) {
  const raw = await tryCall(() => provider.getStorage(normalizeAddress(address), slot), null);
  if (!raw || raw === "0x" || /^0x0{64}$/i.test(raw)) return null;
  return normalizeAddress(`0x${raw.slice(-40)}`);
}

async function addressKind(provider, address) {
  const addr = normalizeAddress(address);
  if (!addr || addr === ZERO) return "zero";
  const code = await safeCode(provider, addr);
  return code && code !== "0x" ? "contract" : "eoa";
}

function decodeBytes32String(value) {
  try { return value && value !== "0x" ? safeText(ethers.decodeBytes32String(value), 80) : null; } catch (_) { return null; }
}

async function tokenMeta(provider, token, fallback = {}) {
  const addr = normalizeAddress(token);
  if (!addr) return { address: null, symbol: fallback.symbol || null, name: fallback.name || null, decimals: fallback.decimals ?? 18, codeBytes: 0 };
  const erc = new ethers.Contract(addr, ERC20_ABI, provider);
  const b32 = new ethers.Contract(addr, BYTES32_TOKEN_ABI, provider);
  const [codeBytes, symbol, symbolBytes, name, nameBytes, decimals, totalSupply] = await Promise.all([
    getCodeBytes(provider, addr),
    tryCall(() => erc.symbol(), null),
    tryCall(() => b32.symbol(), null),
    tryCall(() => erc.name(), null),
    tryCall(() => b32.name(), null),
    tryCall(() => erc.decimals(), fallback.decimals ?? 18),
    tryCall(() => erc.totalSupply(), null),
  ]);
  return {
    address: addr,
    symbol: safeText(symbol || decodeBytes32String(symbolBytes) || fallback.symbol || "UNK", 32),
    name: safeText(name || decodeBytes32String(nameBytes) || fallback.name || "", 100),
    decimals: Number(decimals ?? fallback.decimals ?? 18),
    totalSupplyRaw: totalSupply?.toString?.() || null,
    codeBytes,
  };
}

async function protocolMetadata() {
  const live = await fetchJson("https://api.llama.fi/protocol/fira", 35_000);
  const discovery = readJson(PUBLIC_TARGETS, {});
  const rows = [
    ...(discovery.phase0Queue || []),
    ...(discovery.protocolCandidates || []),
    ...(discovery.targetedRefreshQueue || []),
    ...(discovery.consumerJoinFirst || []),
    ...(discovery.yieldCandidates || []),
  ];
  const row = rows.find((p) => p?.slug === "fira" || p?.name === "Fira");
  const tvlSeries = Array.isArray(live?.tvl) ? live.tvl : [];
  const latestTvl = tvlSeries.length ? tvlSeries[tvlSeries.length - 1]?.totalLiquidityUSD : null;
  return {
    name: live?.name || row?.name || "Fira",
    slug: live?.slug || row?.slug || "fira",
    category: live?.category || row?.category || "Lending",
    chains: live?.chains || row?.chains || ["Ethereum"],
    tvlUsd: round(latestTvl ?? row?.tvlUsd, 2),
    ethereumTvlUsd: round(live?.currentChainTvls?.Ethereum ?? row?.tvlUsd, 2),
    borrowedUsd: round(live?.currentChainTvls?.borrowed ?? live?.currentChainTvls?.["Ethereum-borrowed"] ?? live?.borrowed ?? row?.borrowedUsd, 2),
    audits: live?.audit_links || live?.audits || row?.audits || [],
    url: live?.url || row?.url || null,
    twitter: live?.twitter || row?.twitter || null,
    tvlCodePath: live?.tvlCodePath || "https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/fira/index.js",
    source: live ? "defillama-protocol-api" : row ? "public-audit-target-discovery" : "fallback",
  };
}

async function llamaPrices(addresses) {
  const normalized = unique(addresses.map(normalizeAddress)).slice(0, 80);
  const out = {};
  if (!normalized.length) return out;
  const coins = normalized.map((addr) => `ethereum:${addr}`).join(",");
  const json = await fetchJson(`https://coins.llama.fi/prices/current/${coins}`, 20_000);
  for (const [key, row] of Object.entries(json?.coins || {})) {
    const addr = normalizeAddress(key.split(":").pop());
    if (addr) out[lowerAddress(addr)] = asNumber(row?.price);
  }
  return out;
}

async function dexScreenerToken(token) {
  const addr = normalizeAddress(token);
  if (!addr) return null;
  const json = await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${addr}`, 10_000);
  const pairs = (json?.pairs || [])
    .filter((p) => String(p?.chainId || "").toLowerCase() === "ethereum")
    .map((p) => ({
      dexId: safeText(p.dexId, 40),
      pairAddress: normalizeAddress(p.pairAddress),
      baseSymbol: safeText(p.baseToken?.symbol, 32),
      quoteSymbol: safeText(p.quoteToken?.symbol, 32),
      priceUsd: round(p.priceUsd, 10),
      liquidityUsd: round(p.liquidity?.usd, 2),
      volume24hUsd: round(p.volume?.h24, 2),
    }))
    .sort((a, b) => (b.liquidityUsd || 0) - (a.liquidityUsd || 0));
  return pairs[0] || null;
}

async function getLogsAdaptive(rpc, filter, fromBlock, toBlock, errors, depth = 0) {
  const normalizedFilter = { ...filter, fromBlock: hexBlock(fromBlock), toBlock: hexBlock(toBlock) };
  const result = await rpcCall(rpc, "eth_getLogs", [normalizedFilter], 25_000).catch(() => null);
  if (Array.isArray(result)) return result;
  if (fromBlock < toBlock && depth < 8) {
    const mid = Math.floor((fromBlock + toBlock) / 2);
    const left = await getLogsAdaptive(rpc, filter, fromBlock, mid, errors, depth + 1);
    const right = await getLogsAdaptive(rpc, filter, mid + 1, toBlock, errors, depth + 1);
    return left.concat(right);
  }
  errors.push(`eth_getLogs-unavailable-${fromBlock}-${toBlock}`);
  return [];
}

async function getLogsChunked(rpc, filter, fromBlock, toBlock) {
  const logs = [];
  const errors = [];
  let chunks = 0;
  for (let start = fromBlock; start <= toBlock; start += LOG_CHUNK_BLOCKS) {
    const end = Math.min(toBlock, start + LOG_CHUNK_BLOCKS - 1);
    chunks += 1;
    logs.push(...await getLogsAdaptive(rpc, filter, start, end, errors));
  }
  return { logs, errors, chunks };
}

function marketParamsFromLog(log) {
  const decoded = CREATE_MARKET.decodeEventLog("CreateMarket", log.data, log.topics);
  const p = decoded.marketParams || decoded[1];
  const params = [p.loanToken ?? p[0], p.collateralToken ?? p[1], p.oracle ?? p[2], p.irm ?? p[3], p.ltv ?? p[4], p.lltv ?? p[5], p.whitelist ?? p[6]];
  return {
    marketId: normalizeBytes32(decoded.id?.toString?.() || decoded[0]?.toString?.()),
    params: params.map((x, i) => i < 4 || i === 6 ? normalizeAddress(x) : toBig(x).toString()),
  };
}

function stateFromResult(data) {
  if (!data) return null;
  return {
    totalSupplyAssetsRaw: data.totalSupplyAssets?.toString?.() || data[0]?.toString?.() || null,
    totalSupplySharesRaw: data.totalSupplyShares?.toString?.() || data[1]?.toString?.() || null,
    totalBorrowAssetsRaw: data.totalBorrowAssets?.toString?.() || data[2]?.toString?.() || null,
    totalBorrowSharesRaw: data.totalBorrowShares?.toString?.() || data[3]?.toString?.() || null,
    lastUpdate: data.lastUpdate?.toString?.() || data[4]?.toString?.() || null,
    feeRaw: data.fee?.toString?.() || data[5]?.toString?.() || null,
  };
}

async function readMarketState(contract, row) {
  if (row.marketId) {
    const byId = await tryCall(() => contract["market(bytes32)"](row.marketId), null);
    if (byId) return { stateReadMode: "bytes32", stateRaw: byId };
  }
  const byTuple = await tryCall(() => contract["market((address,address,address,address,uint256,uint256,address))"](row.params), null);
  if (byTuple) return { stateReadMode: "tuple", stateRaw: byTuple };
  return { stateReadMode: null, stateRaw: null };
}

function positiveDiffRaw(a, b) {
  const diff = toBig(a) - toBig(b);
  return diff > 0n ? diff : 0n;
}

function positionFromResult(data) {
  if (!data) return null;
  return {
    supplyAssetsRaw: data.supplyAssets?.toString?.() || data[0]?.toString?.() || "0",
    supplySharesRaw: data.supplyShares?.toString?.() || data[1]?.toString?.() || "0",
    borrowAssetsRaw: data.borrowAssets?.toString?.() || data[2]?.toString?.() || "0",
    borrowSharesRaw: data.borrowShares?.toString?.() || data[3]?.toString?.() || "0",
    collateralAssetsRaw: data.collateralAssets?.toString?.() || data[4]?.toString?.() || "0",
  };
}

async function oracleState(provider, market, loanPriceUsd, collateralReferenceUsd) {
  const addr = normalizeAddress(market.params[2]);
  if (!addr || addr === ZERO) return null;
  const oracle = new ethers.Contract(addr, ORACLE_ABI, provider);
  const [codeBytes, priceRaw, decimalsRaw, description, ownerRaw, adminRaw] = await Promise.all([
    getCodeBytes(provider, addr),
    tryCall(() => oracle.price(), null),
    tryCall(() => oracle.decimals(), null),
    tryCall(() => oracle.description(), null),
    tryCall(() => oracle.owner(), null),
    tryCall(() => oracle.admin(), null),
  ]);
  const scale = 36 + Number(market.loan.decimals || 18) - Number(market.collateral.decimals || 18);
  const collateralInLoan = priceRaw === null ? null : unitsToNumber(priceRaw, scale);
  const collateralUsd = collateralInLoan !== null && loanPriceUsd !== null ? collateralInLoan * loanPriceUsd : null;
  const vsReferenceBps = collateralUsd !== null && collateralReferenceUsd ? ((collateralUsd - collateralReferenceUsd) / collateralReferenceUsd) * 10000 : null;
  return {
    address: addr,
    codeBytes,
    priceRaw: priceRaw?.toString?.() || null,
    morphoScaleDecimalsAssumed: scale,
    collateralInLoan: round(collateralInLoan, 12),
    collateralUsd: round(collateralUsd, 10),
    decimals: decimalsRaw === null ? null : Number(decimalsRaw),
    description: safeText(description, 80),
    owner: normalizeAddress(ownerRaw),
    ownerKind: await addressKind(provider, ownerRaw),
    admin: normalizeAddress(adminRaw),
    adminKind: await addressKind(provider, adminRaw),
    vsReferenceBps: round(vsReferenceBps, 4),
    divergentVsReference: Math.abs(asNumber(vsReferenceBps) || 0) >= DIVERGENCE_WATCH_BPS,
  };
}

async function scanMarket(provider, row, prices) {
  const target = normalizeAddress(row.target);
  const c = new ethers.Contract(target, LENDING_ABI, provider);
  const loan = await tokenMeta(provider, row.params[0], { decimals: 18 });
  const collateral = await tokenMeta(provider, row.params[1], { decimals: 18 });
  const loanErc = new ethers.Contract(loan.address || ZERO, ERC20_ABI, provider);
  const collatErc = new ethers.Contract(collateral.address || ZERO, ERC20_ABI, provider);
  const [targetCodeBytes, impl, adminSlot, irmCodeBytes, whitelistCodeBytes, contractLoanBalanceRaw, collateralBalanceRaw, ownerRaw, adminRaw, feeRecipientRaw] = await Promise.all([
    getCodeBytes(provider, target),
    storageAddress(provider, target, EIP1967_IMPL),
    storageAddress(provider, target, EIP1967_ADMIN),
    getCodeBytes(provider, row.params[3]),
    getCodeBytes(provider, row.params[6]),
    tryCall(() => loanErc.balanceOf(target), null),
    tryCall(() => collatErc.balanceOf(target), null),
    tryCall(() => c.owner(), null),
    tryCall(() => c.admin(), null),
    tryCall(() => c.feeRecipient(), null),
  ]);

  const stateProbe = await readMarketState(c, row);
  const state = stateFromResult(stateProbe.stateRaw);
  const loanPriceUsd = prices[lowerAddress(loan.address)] ?? stableFallback(loan.symbol);
  const collateralLlamaUsd = prices[lowerAddress(collateral.address)] ?? stableFallback(collateral.symbol);
  const [loanDex, collateralDex] = await Promise.all([dexScreenerToken(loan.address), dexScreenerToken(collateral.address)]);
  const collateralReferenceUsd = collateralDex?.priceUsd || collateralLlamaUsd;
  const oracle = await oracleState(provider, { ...row, loan, collateral }, loanPriceUsd, collateralReferenceUsd);

  const totalBorrow = unitsToNumber(state?.totalBorrowAssetsRaw, loan.decimals);
  const totalSupply = unitsToNumber(state?.totalSupplyAssetsRaw, loan.decimals);
  const marketAvailableRaw = state ? positiveDiffRaw(state.totalSupplyAssetsRaw, state.totalBorrowAssetsRaw) : contractLoanBalanceRaw;
  const cash = unitsToNumber(marketAvailableRaw, loan.decimals);
  const contractLoanBalance = unitsToNumber(contractLoanBalanceRaw, loan.decimals);
  const collateralBalance = unitsToNumber(collateralBalanceRaw, collateral.decimals);
  const borrowUsd = totalBorrow !== null && loanPriceUsd !== null ? totalBorrow * loanPriceUsd : null;
  const supplyUsd = totalSupply !== null && loanPriceUsd !== null ? totalSupply * loanPriceUsd : null;
  const cashUsd = cash !== null && loanPriceUsd !== null ? cash * loanPriceUsd : null;
  const collateralBalanceUsd = collateralBalance !== null && collateralReferenceUsd !== null ? collateralBalance * collateralReferenceUsd : null;
  const ltvBps = wadBps(row.params[4]);
  const lltvBps = wadBps(row.params[5]);
  const borrowRouteEdgeBps = oracle?.collateralUsd !== null && oracle?.collateralUsd !== undefined && collateralReferenceUsd
    ? (((oracle.collateralUsd * (ltvBps || 0)) / 10000) / collateralReferenceUsd - 1) * 10000
    : null;
  const borrowRouteGrossPositive = (borrowRouteEdgeBps || 0) > BORROW_ROUTE_WATCH_BPS && (cashUsd || 0) >= MATERIAL_USD;
  const acceptedValueDivergent = Boolean(oracle?.divergentVsReference);
  const materialBorrow = (borrowUsd || 0) >= MATERIAL_BORROW_USD;
  const watchCandidate = Boolean(materialBorrow || borrowRouteGrossPositive || (acceptedValueDivergent && (cashUsd || 0) >= MATERIAL_USD));

  return {
    chain: FIRA.chain,
    chainId: FIRA.chainId,
    target,
    label: row.label,
    marketId: row.marketId || null,
    stateMode: row.stateMode,
    stateReadMode: stateProbe.stateReadMode,
    params: row.params,
    blockNumber: row.blockNumber ?? null,
    code: { targetCodeBytes, eip1967Implementation: impl, eip1967Admin: adminSlot, oracleCodeBytes: oracle?.codeBytes ?? 0, irmCodeBytes, whitelistCodeBytes },
    roles: {
      owner: normalizeAddress(ownerRaw),
      ownerKind: await addressKind(provider, ownerRaw),
      admin: normalizeAddress(adminRaw),
      adminKind: await addressKind(provider, adminRaw),
      feeRecipient: normalizeAddress(feeRecipientRaw),
      feeRecipientKind: await addressKind(provider, feeRecipientRaw),
    },
    loan,
    collateral,
    oracle,
    irm: normalizeAddress(row.params[3]),
    whitelist: normalizeAddress(row.params[6]),
    state,
    ltvBps,
    lltvBps,
    loanPriceUsd: round(loanPriceUsd, 10),
    collateralLlamaUsd: round(collateralLlamaUsd, 10),
    collateralReferenceUsd: round(collateralReferenceUsd, 10),
    totalSupply: round(totalSupply, 6),
    totalBorrow: round(totalBorrow, 6),
    cash: round(cash, 6),
    contractLoanBalance: round(contractLoanBalance, 6),
    collateralBalance: round(collateralBalance, 6),
    supplyUsd: round(supplyUsd, 2),
    borrowUsd: round(borrowUsd, 2),
    cashUsd: round(cashUsd, 2),
    contractLoanBalanceUsd: round(contractLoanBalance !== null && loanPriceUsd !== null ? contractLoanBalance * loanPriceUsd : null, 2),
    collateralBalanceUsd: round(collateralBalanceUsd, 2),
    loanDex,
    collateralDex,
    acceptedValueDivergent,
    borrowRouteEdgeBps: round(borrowRouteEdgeBps, 4),
    borrowRouteGrossPositive,
    materialBorrow,
    watchCandidate,
    routePositive: false,
    blocker: borrowRouteGrossPositive
      ? "Watch-only gross borrow edge requires exact acquisition/borrow/exit quote, whitelist checks, gas/slippage, and fork proof"
      : "No exact positive borrow, liquidation, redemption, or unwind economics proven",
  };
}

async function discoverMarkets(provider, rpc, latestNumber) {
  const topic = CREATE_MARKET.getEvent("CreateMarket").topicHash;
  const seedTargets = [
    { label: "fixed", target: FIRA.fixed },
    { label: "variable", target: FIRA.variable },
  ];
  const discovered = [];
  const logErrors = [];
  let chunksScanned = 0;
  for (const seed of seedTargets) {
    const { logs, errors, chunks } = await getLogsChunked(rpc, { address: normalizeAddress(seed.target), topics: [topic] }, FROM_BLOCK, latestNumber);
    chunksScanned += chunks;
    logErrors.push(...errors.map((error) => `${seed.label}:${error}`));
    for (const log of logs) {
      const decoded = await tryCall(async () => marketParamsFromLog(log), null);
      if (!decoded || !decoded.params[0]) continue;
      discovered.push({ label: seed.label, target: seed.target, stateMode: "tuple", marketId: decoded.marketId, params: decoded.params, blockNumber: Number(log.blockNumber) || Number.parseInt(log.blockNumber, 16) || null });
    }
  }
  discovered.push({ label: "legacy-uzr", target: FIRA.legacyUzr, stateMode: "bytes32", marketId: FIRA.uzrMarketId, params: LEGACY_UZR_PARAMS.map((x) => normalizeAddress(x) || x), blockNumber: null });

  const seen = new Set();
  const markets = [];
  const priceAddresses = unique(discovered.flatMap((row) => [row.params[0], row.params[1]]));
  const prices = await llamaPrices(priceAddresses);
  for (const row of discovered) {
    const key = `${lowerAddress(row.target)}:${row.marketId || row.params.join(":").toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    markets.push(await scanMarket(provider, row, prices));
  }
  markets.sort((a, b) => (b.borrowUsd || 0) - (a.borrowUsd || 0));
  return { markets, logErrors, chunksScanned };
}

function eventTopics() {
  return ["Borrow", "Repay", "SupplyCollateral", "WithdrawCollateral", "Liquidate"].map((name) => POSITION_IFACE.getEvent(name).topicHash);
}

function parsePositionEvent(log) {
  try {
    const parsed = POSITION_IFACE.parseLog({ topics: log.topics, data: log.data });
    const id = normalizeBytes32(parsed.args.id?.toString?.() || parsed.args[0]?.toString?.());
    let user = null;
    if (parsed.name === "Liquidate") user = normalizeAddress(parsed.args.borrower || parsed.args[2]);
    else user = normalizeAddress(parsed.args.onBehalf || parsed.args[2]);
    return { id, user, eventName: parsed.name };
  } catch (_) {
    return null;
  }
}

async function collectBorrowers(rpc, marketRows, latestNumber) {
  const positionFromBlock = Math.max(FROM_BLOCK, latestNumber - RECENT_POSITION_LOG_BLOCKS);
  const addresses = unique(marketRows.map((row) => normalizeAddress(row.target)));
  const marketIds = new Set(marketRows.map((row) => normalizeBytes32(row.marketId)).filter(Boolean));
  const topics = eventTopics();
  const perMarket = new Map(marketRows.map((row) => [normalizeBytes32(row.marketId), new Map()]));
  const logErrors = [];
  let logsRead = 0;
  let chunksScanned = 0;
  for (const topic of topics) {
    const { logs, errors, chunks } = await getLogsChunked(rpc, { address: addresses, topics: [topic] }, positionFromBlock, latestNumber);
    chunksScanned += chunks;
    logErrors.push(...errors.map((error) => `position:${error}`));
    logsRead += logs.length;
    for (const log of logs) {
      const parsed = parsePositionEvent(log);
      if (!parsed?.user || !marketIds.has(parsed.id)) continue;
      const byUser = perMarket.get(parsed.id);
      if (!byUser) continue;
      const prev = byUser.get(parsed.user) || { eventCount: 0, borrowLikeEvents: 0, lastBlock: 0 };
      prev.eventCount += 1;
      if (parsed.eventName === "Borrow" || parsed.eventName === "Liquidate") prev.borrowLikeEvents += 1;
      prev.lastBlock = Math.max(prev.lastBlock, Number(log.blockNumber) || Number.parseInt(log.blockNumber, 16) || 0);
      byUser.set(parsed.user, prev);
    }
  }
  return { perMarket, logsRead, chunksScanned, logErrors, positionFromBlock };
}

async function borrowerRows(provider, rpc, marketRows, latestNumber) {
  const collected = await collectBorrowers(rpc, marketRows, latestNumber);
  const rows = [];
  let sampleCounter = 0;
  for (const market of marketRows) {
    const target = normalizeAddress(market.target);
    const c = new ethers.Contract(target, LENDING_ABI, provider);
    const candidates = [...(collected.perMarket.get(normalizeBytes32(market.marketId)) || new Map()).entries()]
      .sort((a, b) => (b[1].borrowLikeEvents - a[1].borrowLikeEvents) || (b[1].lastBlock - a[1].lastBlock))
      .slice(0, MAX_BORROWERS_PER_MARKET);
    for (const [borrower, meta] of candidates) {
      const positionRaw = await tryCall(() => c.getUserPosition(market.params, borrower), null);
      const position = positionFromResult(positionRaw);
      if (!position) continue;
      const borrow = unitsToNumber(position.borrowAssetsRaw, market.loan.decimals);
      const collateral = unitsToNumber(position.collateralAssetsRaw, market.collateral.decimals);
      const supply = unitsToNumber(position.supplyAssetsRaw, market.loan.decimals);
      if ((borrow || 0) <= 0 && (collateral || 0) <= 0 && (supply || 0) <= 0) continue;
      sampleCounter += 1;
      const borrowUsd = borrow !== null && market.loanPriceUsd !== null ? borrow * market.loanPriceUsd : null;
      const collateralAcceptedUsd = collateral !== null && market.oracle?.collateralUsd !== null && market.oracle?.collateralUsd !== undefined ? collateral * market.oracle.collateralUsd : null;
      const collateralReferenceUsd = collateral !== null && market.collateralReferenceUsd !== null ? collateral * market.collateralReferenceUsd : null;
      const borrowToAcceptedCollateralBps = borrowUsd !== null && collateralAcceptedUsd ? (borrowUsd / collateralAcceptedUsd) * 10000 : null;
      const marginToLltvBps = borrowToAcceptedCollateralBps !== null && market.lltvBps !== null ? market.lltvBps - borrowToAcceptedCollateralBps : null;
      const liquidationShortfallUsd = borrowUsd !== null && collateralAcceptedUsd !== null && market.lltvBps !== null ? Math.max(0, borrowUsd - (collateralAcceptedUsd * market.lltvBps / 10000)) : null;
      const liquidatableApprox = (liquidationShortfallUsd || 0) > 0;
      rows.push({
        sampleId: `sample-${String(sampleCounter).padStart(3, "0")}`,
        marketLabel: market.label,
        marketId: market.marketId,
        lastEventBlock: meta.lastBlock || null,
        eventCount: meta.eventCount,
        borrowLikeEvents: meta.borrowLikeEvents,
        supplyAssets: round(supply, 6),
        borrowAssets: round(borrow, 6),
        collateralAssets: round(collateral, 6),
        borrowUsd: round(borrowUsd, 2),
        collateralAcceptedUsd: round(collateralAcceptedUsd, 2),
        collateralReferenceUsd: round(collateralReferenceUsd, 2),
        borrowToAcceptedCollateralBps: round(borrowToAcceptedCollateralBps, 4),
        marginToLltvBps: round(marginToLltvBps, 4),
        liquidationShortfallUsd: round(liquidationShortfallUsd, 2),
        nearLiquidation: marginToLltvBps !== null && marginToLltvBps >= 0 && marginToLltvBps <= LIQUIDATION_MARGIN_WATCH_BPS,
        liquidatableApprox,
        materialLiquidatable: (liquidationShortfallUsd || 0) >= MATERIAL_USD,
        routePositive: false,
        blocker: "Anonymized position is not route-positive without exact liquidation call success, repay sizing, collateral exit, gas/slippage, and fork proof",
      });
    }
  }
  rows.sort((a, b) => (b.liquidationShortfallUsd || 0) - (a.liquidationShortfallUsd || 0) || (a.marginToLltvBps ?? 1e12) - (b.marginToLltvBps ?? 1e12));
  return { rows, logsRead: collected.logsRead, chunksScanned: collected.chunksScanned, logErrors: collected.logErrors, positionFromBlock: collected.positionFromBlock };
}

function scanLocalArtifactRows(marketRows) {
  const needles = unique([
    FIRA.fixed,
    FIRA.variable,
    FIRA.legacyUzr,
    FIRA.usd0,
    FIRA.bUsd0,
    FIRA.fwUsdc,
    "fira",
    "Fira",
    ...marketRows.flatMap((row) => [row.target, row.loan?.address, row.collateral?.address, row.oracle?.address, row.irm, row.whitelist]),
  ]).map((v) => String(v).toLowerCase());
  const roots = [path.join(WORKSPACE, "reports")];
  const rows = [];
  for (const root of roots) {
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop();
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
      for (const entry of entries) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (/node_modules|cache|artifacts|out|coverage/i.test(entry.name)) continue;
          stack.push(file);
          continue;
        }
        if (!/\.(json|md)$/i.test(entry.name)) continue;
        let stat = null;
        try { stat = fs.statSync(file); } catch (_) { continue; }
        if (stat.size > MAX_LOCAL_ARTIFACT_BYTES) continue;
        const rel = path.relative(WORKSPACE, file).replace(/\\/g, "/");
        if (/fira-phase0\.json|fira-phase0-triage\.md$/i.test(rel)) continue;
        const text = readText(file).toLowerCase();
        const hits = needles.filter((needle) => needle && text.includes(needle));
        if (!hits.length) continue;
        rows.push({ file: rel, hits: hits.length, exactAddressHits: hits.filter((hit) => hit.startsWith("0x")).length, routePositive: false, note: "Local source/artifact hit only; not route-positive without live exact economics" });
      }
    }
  }
  rows.sort((a, b) => b.exactAddressHits - a.exactAddressHits || b.hits - a.hits || a.file.localeCompare(b.file));
  return rows.slice(0, 80);
}

function collectPrefilterContext() {
  const json = readJson(PREFILTER, {});
  const row = (json.targetRows || []).find((r) => r?.name === "Fira" || r?.id === "fira-prefilter");
  return row ? {
    generatedAt: json.generatedAt || null,
    promotedFullPhase0: Boolean(row.fullPhase0Recommended),
    borrowedUsd: round(row.borrowedUsd, 2),
    totalBorrowUsd: round(row.summary?.totalBorrowUsd, 2),
    joinRows: row.summary?.joinRows ?? null,
    joinWatchCandidates: row.summary?.joinWatchCandidates ?? null,
    joinRoutePositive: row.summary?.joinRoutePositive ?? null,
    routePositive: Boolean(row.routePositive),
  } : null;
}

function renderReport(out) {
  const s = out.summary;
  const marketTable = out.marketRows.slice(0, 12).map((row) => `| ${row.label} | ${row.loan.symbol}/${row.collateral.symbol} | ${formatUsd(row.borrowUsd)} | ${formatUsd(row.cashUsd)} | ${formatPctBps(row.ltvBps)} | ${formatPctBps(row.lltvBps)} | ${formatUsd(row.oracle?.collateralUsd)} | ${formatUsd(row.collateralReferenceUsd)} | ${formatBps(row.oracle?.vsReferenceBps)} | ${formatBps(row.borrowRouteEdgeBps)} | ${row.watchCandidate ? "yes" : "no"} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | no |";
  const borrowerTable = out.borrowerRows.slice(0, 12).map((row) => `| ${row.sampleId} | ${row.marketLabel} | ${formatUsd(row.borrowUsd)} | ${formatUsd(row.collateralAcceptedUsd)} | ${formatUsd(row.collateralReferenceUsd)} | ${formatBps(row.marginToLltvBps)} | ${row.nearLiquidation ? "yes" : "no"} | ${row.liquidatableApprox ? "yes" : "no"} |`).join("\n") || "| none sampled | n/a | n/a | n/a | n/a | n/a | no | no |";
  const roleTable = out.roleRows.map((row) => `| ${row.contract} | ${row.role} | ${compactAddress(row.address)} | ${row.kind || "n/a"} |`).join("\n") || "| none | n/a | n/a | n/a |";
  const artifactTable = out.localArtifactRows.slice(0, 10).map((row) => `| ${row.file} | ${row.hits} | ${row.exactAddressHits} |`).join("\n") || "| none | 0 | 0 |";
  const blockers = out.blockers.map((b) => `- ${b}`).join("\n");
  const required = out.requiredForRoutePositive.map((b) => `- ${b}`).join("\n");
  return `# ${REPORT_SIGNAL} - Fira Phase 0 Triage

Generated: ${out.generatedAt}

Scanner: \`${out.scanner}\`

Artifact: \`reports/raw/fast/fira-phase0.json\`

## Result

No permissionless route-positive exploit is claimed. This pass corrected the legacy UZR market state read to \`market(bytes32)\`, mapped live Fira lending market state, oracle/reference values, LTV/LLTV, cash/borrow context, anonymized recent borrower positions, roles, and local consumer/source hits. Fira remains watch-only because material borrow exposure exists, but no row has exact-positive borrow, liquidation, redemption, or unwind economics and no fork proof exists.

## Summary

| Metric | Value |
|---|---:|
| Public TVL context | ${formatUsd(s.defillamaCurrentTvlUsd)} |
| Public borrowed context | ${formatUsd(s.defillamaBorrowedUsd)} |
| Markets scanned | \`${s.marketRows}\` |
| Material borrow rows | \`${s.materialBorrowRows}\` |
| Total borrow context | ${formatUsd(s.totalBorrowUsd)} |
| Total cash context | ${formatUsd(s.totalCashUsd)} |
| Accepted-value divergent rows | \`${s.acceptedValueDivergentRows}\` |
| Gross-positive borrow edge rows | \`${s.borrowRouteGrossPositiveRows}\` |
| Position logs read | \`${s.positionLogsRead}\` |
| Anonymized borrower rows | \`${s.sampledBorrowers}\` |
| Near-liquidation rows | \`${s.nearLiquidationRows}\` |
| Material liquidatable rows | \`${s.materialSampledLiquidatableBorrowers}\` |
| Watch candidates | \`${s.watchCandidates}\` |
| Route-positive | \`${s.routePositive}\` |
| Executable now | \`${s.executableNow}\` |
| Signed action justified | \`${s.signedActionJustified}\` |
| Coverage classification | \`${s.coverageClassification}\` |

## Markets

| Market | Pair | Borrow | Cash | LTV | LLTV | Oracle collateral value | Reference collateral value | Oracle vs reference | Gross borrow edge | Watch |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
${marketTable}

## Anonymized Borrower Sampling

  Borrower addresses are intentionally not persisted. Sampling uses bounded recent decoded market events from block ${out.summary.positionFromBlock} onward and records only anonymized position metrics.

| Sample | Market | Borrow | Collateral accepted value | Collateral reference value | Margin to LLTV | Near liq | Liquidatable approx |
|---|---|---:|---:|---:|---:|---|---|
${borrowerTable}

## Roles

| Contract | Role | Address | Kind |
|---|---|---|---|
${roleTable}

## Local Artifact / Consumer Context

| File | Hits | Exact address hits |
|---|---:|---:|
${artifactTable}

These rows are context only. They do not prove a trusted consumer route, exact liquidation state, or positive unwind economics.

## Blockers

${blockers}

## Required For Route-Positive

${required}

## Next Read-Only Step

${out.nextReadOnlyStep}
`;
}

async function main() {
  const generatedAt = new Date().toISOString();
  const metadataPromise = protocolMetadata();
  const rpcPool = await resolveRpcPool([1]);
  const rpc = rpcPool[1];
  if (!rpc) throw new Error("No Ethereum RPC endpoint resolved for Fira; ask the user for a suitable endpoint instead of skipping the chain");
  const provider = new ethers.JsonRpcProvider(rpc, undefined, { batchMaxCount: 1, staticNetwork: true });
  const latestBlock = await provider.getBlock("latest");
  const [metadata, discovery] = await Promise.all([metadataPromise, discoverMarkets(provider, rpc, Number(latestBlock.number))]);
  const borrower = await borrowerRows(provider, rpc, discovery.markets, Number(latestBlock.number));
  const localArtifactRows = scanLocalArtifactRows(discovery.markets);
  const prefilterContext = collectPrefilterContext();

  const roleRows = [];
  for (const market of discovery.markets) {
    for (const [role, address] of Object.entries(market.roles || {})) {
      if (!/owner|admin|feeRecipient/i.test(role) || /Kind$/.test(role)) continue;
      roleRows.push({ contract: `${market.label} lending market`, role, address: normalizeAddress(address), kind: market.roles[`${role}Kind`] || await addressKind(provider, address) });
    }
    if (market.oracle?.owner) roleRows.push({ contract: `${market.label} oracle`, role: "owner", address: market.oracle.owner, kind: market.oracle.ownerKind });
    if (market.oracle?.admin) roleRows.push({ contract: `${market.label} oracle`, role: "admin", address: market.oracle.admin, kind: market.oracle.adminKind });
  }
  const dedupedRoleRows = [];
  const seenRoles = new Set();
  for (const row of roleRows) {
    const key = `${row.contract}:${row.role}:${lowerAddress(row.address) || row.kind || "null"}`;
    if (seenRoles.has(key)) continue;
    seenRoles.add(key);
    dedupedRoleRows.push(row);
  }

  const materialLiquidatable = borrower.rows.filter((row) => row.materialLiquidatable);
  const watchRows = discovery.markets.filter((row) => row.watchCandidate).concat(borrower.rows.filter((row) => row.nearLiquidation || row.materialLiquidatable));
  const summary = {
    defillamaCurrentTvlUsd: metadata.tvlUsd,
    defillamaEthereumTvlUsd: metadata.ethereumTvlUsd,
    defillamaBorrowedUsd: metadata.borrowedUsd,
    ethereumRpcResolved: true,
    blockNumber: Number(latestBlock.number),
    marketsDiscoveredFromLogs: discovery.markets.filter((row) => row.stateMode === "tuple").length,
    legacyStaticMarkets: discovery.markets.filter((row) => row.stateMode === "bytes32").length,
    marketRows: discovery.markets.length,
    marketsWithCode: discovery.markets.filter((row) => row.code.targetCodeBytes > 0).length,
    materialBorrowRows: discovery.markets.filter((row) => row.materialBorrow).length,
    acceptedValueDivergentRows: discovery.markets.filter((row) => row.acceptedValueDivergent).length,
    borrowRouteGrossPositiveRows: discovery.markets.filter((row) => row.borrowRouteGrossPositive).length,
    totalBorrowUsd: round(discovery.markets.reduce((acc, row) => acc + (asNumber(row.borrowUsd) || 0), 0), 2),
    totalSupplyUsd: round(discovery.markets.reduce((acc, row) => acc + (asNumber(row.supplyUsd) || 0), 0), 2),
    totalCashUsd: round(discovery.markets.reduce((acc, row) => acc + (asNumber(row.cashUsd) || 0), 0), 2),
    totalCollateralBalanceUsd: round(discovery.markets.reduce((acc, row) => acc + (asNumber(row.collateralBalanceUsd) || 0), 0), 2),
    positionLogsRead: borrower.logsRead,
    positionFromBlock: borrower.positionFromBlock,
    positionLogErrorRows: borrower.logErrors.length,
    sampledBorrowers: borrower.rows.length,
    borrowerRowsWithBorrow: borrower.rows.filter((row) => (asNumber(row.borrowUsd) || 0) > 0).length,
    nearLiquidationRows: borrower.rows.filter((row) => row.nearLiquidation).length,
    liquidatableApproxRows: borrower.rows.filter((row) => row.liquidatableApprox).length,
    materialSampledLiquidatableBorrowers: materialLiquidatable.length,
    localArtifactRows: localArtifactRows.length,
    watchCandidates: watchRows.length,
    routePositive: 0,
    executableNow: false,
    signedActionJustified: false,
    coverageClassification: "bounded-with-caveats",
    forkGate: "closed-route-positive-zero",
  };

  const artifact = {
    generatedAt,
    scanner: "tools/scan-fira-phase0.js",
    scope: "Read-only Fira Ethereum lending/oracle/liquidation Phase 0 scan",
    target: { name: "Fira", slug: "fira", category: "Lending", chain: "Ethereum", metadata },
    safety: {
      publicApisOnlyForMetadata: true,
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      privateKeysRead: false,
      calldataStored: false,
      borrowerAddressesStored: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: false,
      executableNow: false,
      signedActionJustified: false,
    },
    deployments: {
      fixedLendingMarket: FIRA.fixed,
      variableLendingMarket: FIRA.variable,
      legacyUzrLendingMarket: FIRA.legacyUzr,
      legacyUzrMarketId: FIRA.uzrMarketId,
      usd0: FIRA.usd0,
      bUsd0: FIRA.bUsd0,
      fwUsdc: FIRA.fwUsdc,
    },
    thresholds: { materialUsd: MATERIAL_USD, materialBorrowUsd: MATERIAL_BORROW_USD, divergenceWatchBps: DIVERGENCE_WATCH_BPS, borrowRouteWatchBps: BORROW_ROUTE_WATCH_BPS, liquidationMarginWatchBps: LIQUIDATION_MARGIN_WATCH_BPS, fromBlock: FROM_BLOCK, recentPositionLogBlocks: RECENT_POSITION_LOG_BLOCKS, logChunkBlocks: LOG_CHUNK_BLOCKS, maxBorrowersPerMarket: MAX_BORROWERS_PER_MARKET },
    block: { number: Number(latestBlock.number), timestamp: Number(latestBlock.timestamp), iso: new Date(Number(latestBlock.timestamp) * 1000).toISOString() },
    source: {
      defillamaAdapter: "projects/fira/index.js",
      defillamaTreasuryHelper: "projects/fira/treasuryHelper.js",
      sourceAvailability: "bounded: public adapter exposes live addresses/ABIs; verified implementation source was not required for this read-only Phase 0 closeout",
    },
    sourceArtifacts: {
      publicTargets: "reports/raw/fast/public-audit-target-discovery.json",
      belowMaterialityPrefilter: "reports/raw/fast/below-materiality-prefilter.json",
    },
    prefilterContext,
    summary,
    marketRows: discovery.markets,
    borrowerRows: borrower.rows,
    roleRows: dedupedRoleRows,
    localArtifactRows,
    logErrors: [...discovery.logErrors, ...borrower.logErrors].map((error) => ({ chain: FIRA.chain, chainId: FIRA.chainId, error })),
    routePositiveRows: [],
    watchRows,
    blockers: [
      "The material legacy UZR borrow row is accepted-value/oracle context, but the gross borrow edge is negative after the 88% LTV haircut versus public bUSD0/USD0 reference pricing.",
      "The UZR oracle reports 1:1 bUSD0-to-USD0 at Morpho-style 1e36 scale; this divergence is watch-only unless it creates exact-positive borrow or liquidation economics after LTV, slippage, gas, and fees.",
      "The Royal Dog/DOG variable market has extreme accepted-value divergence against public DEX pricing, but market(bytes32) shows zero supplied/borrowable assets, so there is no current borrow-extraction liquidity.",
      "Bounded anonymized borrower sampling does not persist borrower addresses and is not exhaustive; no sampled row is route-positive without exact liquidation call success, repay sizing, collateral exit, and fork proof.",
      "Fira whitelist/role state and verified implementation source are bounded context until a route-positive trigger appears; no signed action or executor work is justified.",
      "No fork extraction proof.",
    ],
    requiredForRoutePositive: [
      "specific Fira market accepts attacker-favorable stale, divergent, or under-bound oracle/accounting value",
      "collateral acquisition or liquidation repay path is permissionless, unblocked by whitelist/caps, and exact-quoted",
      "borrowed or seized asset exit is positive after LTV/LLTV haircut, gas, slippage, and fees",
      "borrower/account state is current and material, not only aggregate borrowed context",
      "fork extraction proof demonstrates positive net value",
    ],
    nextReadOnlyStep: "Keep Fira on UZR accepted-value, DOG zero-liquidity market, and borrower-liquidation watch; exact-quote/fork only if DOG gains borrowable supply, bUSD0 acquisition cheapens enough to overcome the 88% LTV haircut, or a material borrower becomes liquidatable with positive collateral exit economics. Otherwise resume the public queue at Republic Note.",
  };

  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, `${JSON.stringify(artifact, jsonReplacer, 2)}\n`);
  fs.writeFileSync(REPORT_OUT, renderReport(artifact));
  if (!QUIET) console.log(`firaPhase0 markets=${summary.marketRows} materialBorrow=${summary.materialBorrowRows} sampledBorrowers=${summary.sampledBorrowers} nearLiq=${summary.nearLiquidationRows} watch=${summary.watchCandidates} routePositive=${summary.routePositive}`);
}

main().catch((err) => {
  console.error(`firaPhase0 error: ${err.message}`);
  process.exitCode = 1;
});
