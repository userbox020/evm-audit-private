#!/usr/bin/env node
// scan-lista-dex-phase0.js - bounded read-only Phase 0 for Lista DEX smart-lending pools.
// Resolves RPC URLs in memory only. Never prints or stores RPC URLs, keys, calldata for execution, or signed actions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { rpcCall, resolveRpcPool } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "lista-dex-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "lista-dex-phase0-triage.md");
const PUBLIC_DISCOVERY = path.join(WORKSPACE, "reports", "raw", "fast", "public-audit-target-discovery.json");
const QUIET = process.argv.includes("--quiet");

const MIN_WATCH_POOL_TVL_USD = Number(process.env.LISTA_DEX_MIN_WATCH_POOL_TVL_USD || "100000");
const MIN_WATCH_BORROW_LIQUIDITY_USD = Number(process.env.LISTA_DEX_MIN_WATCH_BORROW_LIQUIDITY_USD || "10000");
const HIGH_LLTV = Number(process.env.LISTA_DEX_HIGH_LLTV || "0.9");
const FETCH_CONCURRENCY = Number(process.env.LISTA_DEX_FETCH_CONCURRENCY || "8");
const RPC_CONCURRENCY = Number(process.env.LISTA_DEX_RPC_CONCURRENCY || "6");

const CHAINS = {
  bsc: {
    name: "BNB Chain",
    apiChain: "bsc",
    chainId: 56,
    llamaChain: "bsc",
    vault: "0x8F73b65B4caAf64FBA2aF91cC5D4a2A1318E5D8C",
    marketListUrl: "https://api.lista.org/api/moolah/borrow/marketList?page=1&pageSize=1000&chain=bsc",
  },
  ethereum: {
    name: "Ethereum",
    apiChain: "ethereum",
    chainId: 1,
    llamaChain: "ethereum",
    vault: "0xf820fB4680712CD7263a0D3D024D5b5aEA82Fd70",
    marketListUrl: "https://api.lista.org/api/moolah/borrow/marketList?page=1&pageSize=1000&chain=ethereum",
  },
};

const MOOLOAH = new ethers.Interface([
  "function idToMarketParams(bytes32) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)",
  "function market(bytes32) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
]);

const ERC20 = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
]);

const BYTES32_TOKEN = new ethers.Interface([
  "function name() view returns (bytes32)",
  "function symbol() view returns (bytes32)",
]);

const STABLE_FALLBACKS = new Map([
  ["usdt", 1],
  ["usdc", 1],
  ["usd1", 1],
  ["lisusd", 1],
  ["dai", 1],
  ["usde", 1],
  ["usdf", 1],
  ["usdx", 1],
  ["u", 1],
]);

function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function readJson(file, fallback = null) { try { if (!fs.existsSync(file)) return fallback; return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return fallback; } }
function jsonReplacer(_key, value) { return typeof value === "bigint" ? value.toString() : value; }
function normalizeAddress(value) { try { return ethers.getAddress(value); } catch (_) { return null; } }
function lowerAddress(value) { const addr = normalizeAddress(value); return addr ? addr.toLowerCase() : null; }
function isZeroAddress(value) { const addr = lowerAddress(value); return !addr || addr === ethers.ZeroAddress.toLowerCase(); }
function unique(items) { return [...new Set((items || []).filter(Boolean))]; }
function compactAddress(value) { const addr = normalizeAddress(value); return addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : "n/a"; }

function asNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number(value);
  const n = Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function round(value, decimals = 2) {
  const n = asNumber(value);
  if (n === null) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function formatUsd(value) {
  const n = asNumber(value);
  if (n === null) return "n/a";
  return `$${Math.round(n).toLocaleString()}`;
}

function formatPct(value) {
  const n = asNumber(value);
  if (n === null) return "n/a";
  return `${round(n * 100, 2)}%`;
}

function safeSymbol(value) {
  return String(value || "").replace(/[^A-Za-z0-9_.$+-]/g, "").slice(0, 32) || null;
}

function fallbackPrice(symbol) {
  const clean = String(symbol || "").toLowerCase();
  return STABLE_FALLBACKS.has(clean) ? STABLE_FALLBACKS.get(clean) : null;
}

function decimalsToNumber(value, decimals) {
  if (value === null || value === undefined || decimals === null || decimals === undefined) return null;
  try {
    const formatted = ethers.formatUnits(BigInt(value), Number(decimals));
    const n = Number(formatted);
    return Number.isFinite(n) ? n : null;
  } catch (_) {
    return null;
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      out[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}

async function fetchJson(url, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "evm-audit-lista-dex-phase0/1.0" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    return { error: err?.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

async function safeCall(rpc, to, iface, fn, args = [], timeoutMs = 12_000) {
  const addr = normalizeAddress(to);
  if (!rpc || !addr) return null;
  try {
    const raw = await rpcCall(rpc, "eth_call", [{ to: addr, data: iface.encodeFunctionData(fn, args) }, "latest"], timeoutMs);
    if (!raw || raw === "0x") return null;
    return iface.decodeFunctionResult(fn, raw);
  } catch (_) {
    return null;
  }
}

async function getCode(rpc, address) {
  const addr = normalizeAddress(address);
  if (!rpc || !addr) return "0x";
  return await rpcCall(rpc, "eth_getCode", [addr, "latest"], 10_000).catch(() => "0x") || "0x";
}

function decodeBytes32String(value) {
  try { return safeSymbol(ethers.decodeBytes32String(value)); } catch (_) { return null; }
}

async function tokenMeta(rpc, chain, address, fallback = {}) {
  const addr = normalizeAddress(address);
  if (!addr) return { chain, address: null, symbol: safeSymbol(fallback.symbol), decimals: null, codePresent: false, priceUsd: fallback.priceUsd ?? null };
  const [code, decimalsRaw, symbolRaw, symbolBytesRaw, nameRaw, nameBytesRaw, supplyRaw] = await Promise.all([
    getCode(rpc, addr),
    safeCall(rpc, addr, ERC20, "decimals"),
    safeCall(rpc, addr, ERC20, "symbol"),
    safeCall(rpc, addr, BYTES32_TOKEN, "symbol"),
    safeCall(rpc, addr, ERC20, "name"),
    safeCall(rpc, addr, BYTES32_TOKEN, "name"),
    safeCall(rpc, addr, ERC20, "totalSupply"),
  ]);
  const symbol = safeSymbol(symbolRaw?.[0]) || decodeBytes32String(symbolBytesRaw?.[0]) || safeSymbol(fallback.symbol);
  const name = String(nameRaw?.[0] || decodeBytes32String(nameBytesRaw?.[0]) || fallback.name || "").slice(0, 80) || null;
  const decimals = decimalsRaw?.[0] === undefined ? fallback.decimals ?? null : Number(decimalsRaw[0]);
  return {
    chain,
    address: addr,
    symbol,
    name,
    decimals,
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? String(code).replace(/^0x/, "").length / 2 : 0,
    totalSupplyRaw: supplyRaw?.[0] === undefined ? null : supplyRaw[0].toString(),
    priceUsd: fallback.priceUsd ?? fallbackPrice(symbol),
  };
}

async function balanceOf(rpc, token, owner) {
  const raw = await safeCall(rpc, token, ERC20, "balanceOf", [owner]);
  return raw?.[0] === undefined ? null : raw[0];
}

function sourceTvlUsd() {
  const discovery = readJson(PUBLIC_DISCOVERY, {});
  const rows = [
    ...(discovery?.consumerJoinFirst || []),
    ...(discovery?.phase0Queue || []),
    ...(discovery?.targetedRefreshQueue || []),
  ];
  const row = rows.find((r) => r?.slug === "lista-dex");
  return asNumber(row?.tvlUsd);
}

async function loadMarketList() {
  const lists = await Promise.all(Object.values(CHAINS).map(async (cfg) => ({ cfg, json: await fetchJson(cfg.marketListUrl, 45_000) })));
  const byId = new Map();
  const errors = [];

  for (const { cfg, json } of lists) {
    if (json?.error) {
      errors.push({ chain: cfg.apiChain, error: json.error });
      continue;
    }
    for (const row of json?.data?.list || []) {
      if (!CHAINS[row?.chain]) continue;
      const key = `${row.chain}:${row.marketId}`;
      if (byId.has(key)) continue;
      byId.set(key, {
        chain: row.chain,
        chainId: CHAINS[row.chain].chainId,
        chainName: CHAINS[row.chain].name,
        marketId: row.marketId,
        name: row.name || null,
        isSmartLending: Boolean(row.isSmartLending),
        isFixedTerm: Boolean(row.isFixedTerm),
        status: Number(row.status),
      });
    }
  }

  return { marketRows: [...byId.values()], errors };
}

async function loadMarketDetails(smartRows) {
  return await mapLimit(smartRows, FETCH_CONCURRENCY, async (row) => {
    const url = `https://api.lista.org/api/moolah/market/${row.marketId}?chain=${row.chain}`;
    const json = await fetchJson(url, 35_000);
    if (json?.error || json?.code !== "000000000" || !json?.data) {
      return { ...row, detailError: json?.error || json?.msg || "market detail unavailable" };
    }
    const d = json.data;
    const c = d.smartCollateralConfig || {};
    return {
      ...row,
      detailError: null,
      loanToken: normalizeAddress(d.loanToken),
      loanTokenName: d.loanTokenName || null,
      loanTokenPriceUsd: asNumber(d.loanTokenPrice),
      collateralToken: normalizeAddress(d.collateralToken),
      collateralTokenName: d.collateralTokenName || null,
      oracle: normalizeAddress(d.oracle),
      borrowRate: asNumber(d.borrowRate),
      supplyApy: asNumber(d.supplyApy),
      borrowEmissionApy: asNumber(d.borrowEmissionApy),
      collateralOracles: (d.collateralOracles || []).map((o) => normalizeAddress(o?.address)).filter(Boolean),
      loanOracles: (d.loanOracles || []).map((o) => normalizeAddress(o?.address)).filter(Boolean),
      smartCollateralConfig: {
        provider: normalizeAddress(c.provider),
        dexInfo: normalizeAddress(c.dexInfo),
        swapPool: normalizeAddress(c.swapPool),
        protocolDyType: c.protocolDyType || null,
        token0: normalizeAddress(c.token0),
        token1: normalizeAddress(c.token1),
        token0Symbol: safeSymbol(c.token0Symbol),
        token1Symbol: safeSymbol(c.token1Symbol),
      },
    };
  });
}

async function loadPrices(details) {
  const ids = [];
  for (const row of details) {
    const cfg = CHAINS[row.chain];
    if (!cfg) continue;
    for (const token of [row.loanToken, row.collateralToken, row.smartCollateralConfig?.token0, row.smartCollateralConfig?.token1]) {
      const addr = lowerAddress(token);
      if (addr) ids.push(`${cfg.llamaChain}:${addr}`);
    }
  }

  const uniqueIds = unique(ids);
  const prices = {};
  const chunks = [];
  for (let i = 0; i < uniqueIds.length; i += 100) chunks.push(uniqueIds.slice(i, i + 100));
  await Promise.all(chunks.map(async (chunk) => {
    const url = `https://coins.llama.fi/prices/current/${chunk.join(",")}`;
    const json = await fetchJson(url, 35_000);
    for (const [id, info] of Object.entries(json?.coins || {})) {
      prices[id.toLowerCase()] = asNumber(info?.price);
    }
  }));
  return prices;
}

function priceFor(prices, chain, token, symbol, fallback = null) {
  const cfg = CHAINS[chain];
  const addr = lowerAddress(token);
  const key = cfg && addr ? `${cfg.llamaChain}:${addr}`.toLowerCase() : null;
  return (key && prices[key] !== undefined ? prices[key] : null) ?? fallback ?? fallbackPrice(symbol);
}

function distinctNonZero(addresses) {
  return unique((addresses || []).map(lowerAddress).filter((a) => a && a !== ethers.ZeroAddress.toLowerCase()));
}

async function inspectPoolRows(rpcs, details, prices) {
  const poolMap = new Map();
  for (const row of details) {
    const pool = lowerAddress(row.smartCollateralConfig?.swapPool);
    if (!pool) continue;
    const key = `${row.chain}:${pool}`;
    if (!poolMap.has(key)) {
      poolMap.set(key, {
        chain: row.chain,
        chainId: row.chainId,
        chainName: row.chainName,
        swapPool: normalizeAddress(pool),
        dexInfo: row.smartCollateralConfig?.dexInfo || null,
        provider: row.smartCollateralConfig?.provider || null,
        token0: row.smartCollateralConfig?.token0 || null,
        token1: row.smartCollateralConfig?.token1 || null,
        token0SymbolApi: row.smartCollateralConfig?.token0Symbol || null,
        token1SymbolApi: row.smartCollateralConfig?.token1Symbol || null,
        marketIds: [],
        marketNames: [],
      });
    }
    const p = poolMap.get(key);
    p.marketIds.push(row.marketId);
    p.marketNames.push(row.name);
  }

  const rows = await mapLimit([...poolMap.values()], RPC_CONCURRENCY, async (pool) => {
    const rpc = rpcs[pool.chainId];
    const token0FallbackPrice = priceFor(prices, pool.chain, pool.token0, pool.token0SymbolApi);
    const token1FallbackPrice = priceFor(prices, pool.chain, pool.token1, pool.token1SymbolApi);
    const [poolCode, dexInfoCode, providerCode, token0Meta, token1Meta, token0BalanceRaw, token1BalanceRaw] = await Promise.all([
      getCode(rpc, pool.swapPool),
      getCode(rpc, pool.dexInfo),
      getCode(rpc, pool.provider),
      tokenMeta(rpc, pool.chain, pool.token0, { symbol: pool.token0SymbolApi, priceUsd: token0FallbackPrice }),
      tokenMeta(rpc, pool.chain, pool.token1, { symbol: pool.token1SymbolApi, priceUsd: token1FallbackPrice }),
      balanceOf(rpc, pool.token0, pool.swapPool),
      balanceOf(rpc, pool.token1, pool.swapPool),
    ]);
    const token0Balance = decimalsToNumber(token0BalanceRaw, token0Meta.decimals);
    const token1Balance = decimalsToNumber(token1BalanceRaw, token1Meta.decimals);
    const token0Usd = token0Balance !== null && token0Meta.priceUsd !== null ? token0Balance * token0Meta.priceUsd : null;
    const token1Usd = token1Balance !== null && token1Meta.priceUsd !== null ? token1Balance * token1Meta.priceUsd : null;
    const poolTvlUsd = [token0Usd, token1Usd].every((x) => x === null) ? null : (token0Usd || 0) + (token1Usd || 0);

    return {
      ...pool,
      marketIds: unique(pool.marketIds),
      marketNames: unique(pool.marketNames).slice(0, 8),
      poolCodePresent: Boolean(poolCode && poolCode !== "0x"),
      poolCodeBytes: poolCode && poolCode !== "0x" ? String(poolCode).replace(/^0x/, "").length / 2 : 0,
      dexInfoCodePresent: Boolean(dexInfoCode && dexInfoCode !== "0x"),
      providerCodePresent: Boolean(providerCode && providerCode !== "0x"),
      token0Meta,
      token1Meta,
      token0BalanceRaw: token0BalanceRaw === null ? null : token0BalanceRaw.toString(),
      token1BalanceRaw: token1BalanceRaw === null ? null : token1BalanceRaw.toString(),
      token0Balance: round(token0Balance, 6),
      token1Balance: round(token1Balance, 6),
      token0Usd: round(token0Usd, 2),
      token1Usd: round(token1Usd, 2),
      poolTvlUsd: round(poolTvlUsd, 2),
    };
  });

  return rows.sort((a, b) => (asNumber(b.poolTvlUsd) || 0) - (asNumber(a.poolTvlUsd) || 0));
}

async function inspectMarketRows(rpcs, details, prices, poolRows) {
  const poolByKey = new Map(poolRows.map((row) => [`${row.chain}:${lowerAddress(row.swapPool)}`, row]));
  return await mapLimit(details, RPC_CONCURRENCY, async (row) => {
    const rpc = rpcs[row.chainId];
    const vault = CHAINS[row.chain]?.vault;
    const loanPrice = priceFor(prices, row.chain, row.loanToken, row.loanTokenName, row.loanTokenPriceUsd);
    const loanMeta = await tokenMeta(rpc, row.chain, row.loanToken, { symbol: row.loanTokenName, priceUsd: loanPrice });
    const [paramsRaw, stateRaw, vaultCode, oracleCode, collateralCode] = await Promise.all([
      safeCall(rpc, vault, MOOLOAH, "idToMarketParams", [row.marketId]),
      safeCall(rpc, vault, MOOLOAH, "market", [row.marketId]),
      getCode(rpc, vault),
      getCode(rpc, row.oracle),
      getCode(rpc, row.collateralToken),
    ]);

    const params = paramsRaw ? {
      loanToken: normalizeAddress(paramsRaw.loanToken ?? paramsRaw[0]),
      collateralToken: normalizeAddress(paramsRaw.collateralToken ?? paramsRaw[1]),
      oracle: normalizeAddress(paramsRaw.oracle ?? paramsRaw[2]),
      irm: normalizeAddress(paramsRaw.irm ?? paramsRaw[3]),
      lltvRaw: (paramsRaw.lltv ?? paramsRaw[4])?.toString() || null,
      lltv: decimalsToNumber(paramsRaw.lltv ?? paramsRaw[4], 18),
    } : null;

    const state = stateRaw ? {
      totalSupplyAssetsRaw: stateRaw.totalSupplyAssets?.toString?.() ?? stateRaw[0]?.toString?.() ?? null,
      totalSupplySharesRaw: stateRaw.totalSupplyShares?.toString?.() ?? stateRaw[1]?.toString?.() ?? null,
      totalBorrowAssetsRaw: stateRaw.totalBorrowAssets?.toString?.() ?? stateRaw[2]?.toString?.() ?? null,
      totalBorrowSharesRaw: stateRaw.totalBorrowShares?.toString?.() ?? stateRaw[3]?.toString?.() ?? null,
      lastUpdate: stateRaw.lastUpdate === undefined ? (stateRaw[4] === undefined ? null : Number(stateRaw[4])) : Number(stateRaw.lastUpdate),
      feeRaw: stateRaw.fee?.toString?.() ?? stateRaw[5]?.toString?.() ?? null,
    } : null;

    const supplyAssets = decimalsToNumber(state?.totalSupplyAssetsRaw, loanMeta.decimals);
    const borrowAssets = decimalsToNumber(state?.totalBorrowAssetsRaw, loanMeta.decimals);
    const liquidityAssets = supplyAssets === null || borrowAssets === null ? null : Math.max(0, supplyAssets - borrowAssets);
    const supplyUsd = supplyAssets !== null && loanMeta.priceUsd !== null ? supplyAssets * loanMeta.priceUsd : null;
    const borrowUsd = borrowAssets !== null && loanMeta.priceUsd !== null ? borrowAssets * loanMeta.priceUsd : null;
    const borrowLiquidityUsd = liquidityAssets !== null && loanMeta.priceUsd !== null ? liquidityAssets * loanMeta.priceUsd : null;
    const pool = poolByKey.get(`${row.chain}:${lowerAddress(row.smartCollateralConfig?.swapPool)}`) || null;
    const collateralOracleDistinct = distinctNonZero(row.collateralOracles);
    const loanOracleDistinct = distinctNonZero(row.loanOracles);
    const singleCollateralOracle = collateralOracleDistinct.length <= 1;
    const providerEqualsOracle = lowerAddress(row.smartCollateralConfig?.provider) === lowerAddress(row.oracle);
    const lltv = params?.lltv ?? null;

    return {
      chain: row.chain,
      chainId: row.chainId,
      chainName: row.chainName,
      marketId: row.marketId,
      name: row.name,
      status: row.status,
      isFixedTerm: row.isFixedTerm,
      vault,
      vaultCodePresent: Boolean(vaultCode && vaultCode !== "0x"),
      loanToken: row.loanToken,
      loanTokenName: row.loanTokenName,
      loanTokenMeta: loanMeta,
      collateralToken: row.collateralToken,
      collateralTokenName: row.collateralTokenName,
      collateralTokenCodePresent: Boolean(collateralCode && collateralCode !== "0x"),
      oracle: row.oracle,
      oracleCodePresent: Boolean(oracleCode && oracleCode !== "0x"),
      borrowRate: round(row.borrowRate, 8),
      supplyApy: round(row.supplyApy, 8),
      borrowEmissionApy: round(row.borrowEmissionApy, 8),
      smartCollateralConfig: row.smartCollateralConfig,
      onchainParams: params,
      marketState: state,
      paramsMatchApi: params ? {
        loanToken: lowerAddress(params.loanToken) === lowerAddress(row.loanToken),
        collateralToken: lowerAddress(params.collateralToken) === lowerAddress(row.collateralToken),
        oracle: lowerAddress(params.oracle) === lowerAddress(row.oracle),
      } : null,
      totalSupplyAssets: round(supplyAssets, 6),
      totalBorrowAssets: round(borrowAssets, 6),
      borrowLiquidityAssets: round(liquidityAssets, 6),
      supplyUsd: round(supplyUsd, 2),
      borrowUsd: round(borrowUsd, 2),
      borrowLiquidityUsd: round(borrowLiquidityUsd, 2),
      lltv,
      collateralOracleDistinct,
      loanOracleDistinct,
      singleCollateralOracle,
      providerEqualsOracle,
      poolTvlUsd: pool?.poolTvlUsd ?? null,
      poolCodePresent: pool?.poolCodePresent ?? null,
      poolToken0: pool?.token0Meta?.symbol || row.smartCollateralConfig?.token0Symbol || null,
      poolToken1: pool?.token1Meta?.symbol || row.smartCollateralConfig?.token1Symbol || null,
      routePositive: false,
      blocker: "Lista smart-lending pool is a consumer join only; no current exact pool-oracle manipulation, borrow, and exit economics are proven",
    };
  });
}

function summarize(allMarketRows, details, poolRows, marketRows, errors, rpcs) {
  const activeSmart = details.filter((row) => !row.detailError);
  const singleCollateralOracleRows = marketRows.filter((row) => row.singleCollateralOracle).length;
  const highLltvRows = marketRows.filter((row) => (asNumber(row.lltv) || 0) >= HIGH_LLTV).length;
  const materialBorrowLiquidityRows = marketRows.filter((row) => (asNumber(row.borrowLiquidityUsd) || 0) >= MIN_WATCH_BORROW_LIQUIDITY_USD).length;
  const poolRowsWithTvlUsd = poolRows.filter((row) => asNumber(row.poolTvlUsd) !== null).length;
  const watchCandidates = marketRows.filter((row) => {
    const lltv = asNumber(row.lltv) || 0;
    const borrowLiquidityUsd = asNumber(row.borrowLiquidityUsd) || 0;
    const poolTvlUsd = asNumber(row.poolTvlUsd) || 0;
    return lltv >= HIGH_LLTV
      && borrowLiquidityUsd >= MIN_WATCH_BORROW_LIQUIDITY_USD
      && poolTvlUsd >= MIN_WATCH_POOL_TVL_USD
      && (row.singleCollateralOracle || row.providerEqualsOracle);
  });

  const maxPoolTvlUsd = poolRows.reduce((m, row) => Math.max(m, asNumber(row.poolTvlUsd) || 0), 0);
  const maxBorrowLiquidityUsd = marketRows.reduce((m, row) => Math.max(m, asNumber(row.borrowLiquidityUsd) || 0), 0);

  return {
    chainsScanned: Object.values(CHAINS).map((c) => c.chainId),
    chainsWithRpc: Object.values(CHAINS).filter((c) => rpcs[c.chainId]).map((c) => c.chainId),
    chainsMissingRpc: Object.values(CHAINS).filter((c) => !rpcs[c.chainId]).map((c) => c.chainId),
    marketListRows: allMarketRows.length,
    marketInfoErrors: details.filter((row) => row.detailError).length + errors.length,
    smartMarketRows: details.length,
    activeSmartMarketRows: activeSmart.length,
    uniquePools: poolRows.length,
    poolRowsWithCode: poolRows.filter((row) => row.poolCodePresent).length,
    poolRowsWithTvlUsd,
    directConsumerRows: marketRows.length,
    paramsMatchedRows: marketRows.filter((row) => row.paramsMatchApi && Object.values(row.paramsMatchApi).every(Boolean)).length,
    singleCollateralOracleRows,
    highLltvRows,
    materialBorrowLiquidityRows,
    watchCandidates: watchCandidates.length,
    maxPoolTvlUsd: round(maxPoolTvlUsd, 2),
    maxBorrowLiquidityUsd: round(maxBorrowLiquidityUsd, 2),
    defillamaCurrentTvlUsd: sourceTvlUsd(),
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    closedReason: watchCandidates.length
      ? "Lista DEX pools are consumed by high-LLTV Moolah markets, but no exact-positive pool/oracle manipulation, borrow, and exit proof exists"
      : "No Lista smart-lending pool currently meets the material pool/liquidity/oracle-risk watch thresholds",
  };
}

function buildReport(artifact) {
  const s = artifact.summary;
  const topPools = artifact.poolRows.slice(0, 8);
  const topWatch = artifact.watchCandidates.slice(0, 8);
  const topMarkets = artifact.directConsumerRows
    .slice()
    .sort((a, b) => (asNumber(b.borrowLiquidityUsd) || 0) - (asNumber(a.borrowLiquidityUsd) || 0))
    .slice(0, 8);

  const poolTable = topPools.length ? topPools.map((row) => `| ${row.chainName} | ${compactAddress(row.swapPool)} | ${row.token0Meta?.symbol || row.token0SymbolApi || "?"}/${row.token1Meta?.symbol || row.token1SymbolApi || "?"} | ${formatUsd(row.poolTvlUsd)} | ${row.marketIds.length} |`).join("\n") : "| n/a | n/a | n/a | n/a | n/a |";
  const marketTable = topMarkets.length ? topMarkets.map((row) => `| ${row.chainName} | ${String(row.name || "").replace(/\|/g, "/")} | ${formatPct(row.lltv)} | ${formatUsd(row.borrowLiquidityUsd)} | ${formatUsd(row.poolTvlUsd)} | ${row.singleCollateralOracle ? "yes" : "no"} |`).join("\n") : "| n/a | n/a | n/a | n/a | n/a | n/a |";
  const watchTable = topWatch.length ? topWatch.map((row) => `| ${row.chainName} | ${String(row.name || "").replace(/\|/g, "/")} | ${formatPct(row.lltv)} | ${formatUsd(row.borrowLiquidityUsd)} | ${formatUsd(row.poolTvlUsd)} | ${row.reason} |`).join("\n") : "| none | none | n/a | n/a | n/a | no row cleared watch thresholds |";

  return `# 🟢 DORMANT — Lista DEX Phase 0 Triage

Date: ${artifact.generatedAt}

## Result

No confirmed permissionless exploit. Lista DEX TVL is not a standalone AMM factory surface; it is the set of Moolah smart-lending swap pools used as LP-style collateral in Lista/Moolah markets. The scan mapped the pool-to-lending consumer graph and found route-positive count remains \`0\` because no current exact pool-oracle manipulation, borrow, and exit economics are proven.

## Scope

| Item | Value |
|---|---:|
| DeFiLlama TVL context | ${formatUsd(s.defillamaCurrentTvlUsd)} |
| Active smart-lending markets | ${s.activeSmartMarketRows} |
| Unique swap pools | ${s.uniquePools} |
| Direct Moolah consumer rows | ${s.directConsumerRows} |
| High-LLTV rows | ${s.highLltvRows} |
| Single-collateral-oracle rows | ${s.singleCollateralOracleRows} |
| Material borrow-liquidity rows | ${s.materialBorrowLiquidityRows} |
| Watch candidates | ${s.watchCandidates} |
| Route-positive | ${s.routePositive} |

## Top Pools

| Chain | Pool | Pair | Pool TVL | Markets |
|---|---|---|---:|---:|
${poolTable}

## Top Lending Consumers

| Chain | Market | LLTV | Borrow liquidity | Pool TVL | Single collateral oracle |
|---|---|---:|---:|---:|---|
${marketTable}

## Watch Rows

| Chain | Market | LLTV | Borrow liquidity | Pool TVL | Reason |
|---|---|---:|---:|---:|---|
${watchTable}

## Blockers

- Smart-lending pool balances are consumer context only; no pool/oracle path was proven manipulable with current exact economics.
- Single collateral-provider rows need static/fork proof that provider valuation moves in the attacker-favorable direction under a permissionless pool action.
- Borrow liquidity alone is insufficient without exact collateral acquisition, accepted-value delta, borrow, and exit quotes.
- Existing Lista Lending oracle finding remains dormant: pivot/stale feed conditions are not currently met.

## Required For Route-Positive

- A specific Lista pool/provider valuation path must be permissionlessly movable in one transaction or in a currently exploitable stale window.
- Moolah must accept the moved LP/smart collateral at a value above exact acquisition and manipulation cost after LLTV haircut.
- Borrow-side liquidity and borrowed-asset exit must remain material and unpaused.
- Fork extraction proof must show positive net value after gas, slippage, and fees.

Artifacts: \`reports/raw/fast/lista-dex-phase0.json\`.
`;
}

async function main() {
  const { marketRows, errors } = await loadMarketList();
  const smartRows = marketRows
    .filter((row) => row.isSmartLending && row.status === 1)
    .sort((a, b) => `${a.chain}:${a.name}`.localeCompare(`${b.chain}:${b.name}`));
  const details = await loadMarketDetails(smartRows);
  const prices = await loadPrices(details);
  const rpcs = await resolveRpcPool(Object.values(CHAINS).map((c) => c.chainId));
  const poolRows = await inspectPoolRows(rpcs, details.filter((row) => !row.detailError), prices);
  const directConsumerRows = await inspectMarketRows(rpcs, details.filter((row) => !row.detailError), prices, poolRows);
  const summary = summarize(marketRows, details, poolRows, directConsumerRows, errors, rpcs);

  const watchCandidates = directConsumerRows
    .filter((row) => {
      const lltv = asNumber(row.lltv) || 0;
      const borrowLiquidityUsd = asNumber(row.borrowLiquidityUsd) || 0;
      const poolTvlUsd = asNumber(row.poolTvlUsd) || 0;
      return lltv >= HIGH_LLTV
        && borrowLiquidityUsd >= MIN_WATCH_BORROW_LIQUIDITY_USD
        && poolTvlUsd >= MIN_WATCH_POOL_TVL_USD
        && (row.singleCollateralOracle || row.providerEqualsOracle);
    })
    .map((row) => ({
      ...row,
      reason: "high LLTV + material borrow liquidity + material pool TVL + single/provider collateral oracle",
      routePositive: false,
    }))
    .sort((a, b) => (asNumber(b.borrowLiquidityUsd) || 0) - (asNumber(a.borrowLiquidityUsd) || 0));

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-lista-dex-phase0.js",
    scope: "Read-only Lista DEX Phase 0 consumer-graph scan of Moolah smart-lending swap pools on BNB Chain and Ethereum",
    target: {
      name: "Lista DEX",
      slug: "lista-dex",
      category: "Dexs",
      surface: "dex-oracle-consumer-only",
      chains: Object.values(CHAINS).map((c) => c.name),
    },
    safety: {
      publicApisOnlyForDiscovery: true,
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: false,
      executableNow: false,
      signedActionJustified: false,
    },
    thresholds: {
      minWatchPoolTvlUsd: MIN_WATCH_POOL_TVL_USD,
      minWatchBorrowLiquidityUsd: MIN_WATCH_BORROW_LIQUIDITY_USD,
      highLltv: HIGH_LLTV,
    },
    inputs: {
      listaLendingAdapter: "https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/lista-lending/index.js",
      listaDexAdapter: "https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/lista-dex/index.js",
      publicDiscovery: "reports/raw/fast/public-audit-target-discovery.json",
      marketListUrls: Object.fromEntries(Object.values(CHAINS).map((c) => [c.apiChain, c.marketListUrl])),
    },
    vaults: Object.fromEntries(Object.values(CHAINS).map((c) => [c.apiChain, { chainId: c.chainId, vault: c.vault }])),
    summary,
    marketListErrors: errors,
    detailErrors: details.filter((row) => row.detailError).map((row) => ({ chain: row.chain, marketId: row.marketId, name: row.name, error: row.detailError })),
    poolRows,
    directConsumerRows,
    watchCandidates,
    routePositiveRows: [],
    blockers: [
      "No exact pool-oracle manipulation route was proven for any smart-lending pool",
      "Watch rows are consumer joins only until static/fork proof shows accepted collateral value can be moved profitably",
      "Borrow liquidity must be exact-quoted against collateral acquisition/manipulation and borrowed-asset exit before fork escalation",
      "Existing Lista oracle issue remains timing-dependent and current stale/divergence conditions are not met",
    ],
    requiredForRoutePositive: [
      "permissionless pool/provider valuation movement or currently exploitable stale oracle state",
      "accepted Moolah collateral value exceeds exact acquisition/manipulation cost after LLTV haircut",
      "borrow-side liquidity and exit route are material and exact-quoted",
      "fork extraction proof with positive net value",
    ],
    nextReadOnlyStep: watchCandidates.length
      ? "Review the top watch rows' provider/dexInfo bytecode and run static/fork-neutral valuation sensitivity before any fork extraction."
      : "Reopen only if a new smart-lending pool gains material borrow liquidity or a Lista oracle/pool valuation trigger appears.",
  };

  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, `${JSON.stringify(artifact, jsonReplacer, 2)}\n`);
  fs.writeFileSync(REPORT_OUT, buildReport(artifact));

  if (!QUIET) {
    console.log(`Lista DEX Phase 0: smart=${summary.activeSmartMarketRows} pools=${summary.uniquePools} consumers=${summary.directConsumerRows} watch=${summary.watchCandidates} routePositive=${summary.routePositive}`);
  }
}

main().catch((err) => {
  console.error(err?.message || String(err));
  process.exit(1);
});
