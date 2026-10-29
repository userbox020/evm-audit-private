#!/usr/bin/env node
// Read-only Blast native-yield lending scanner.
// Checks INIT rebase-wrapper pools and Compound-fork comptrollers for yield-bearing WETH/USDB accounting drift.
// RPC URLs are resolved in memory only and never printed or stored.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "blast-native-yield-lending.json");
const QUIET = process.argv.includes("--quiet");

const CHAIN_ID = 81457;
const CHAIN_NAME = "Blast";
const INIT_POOLS_URL = "https://app.init.capital/static/json/pools.json";
const TIMEOUT_MS = Number(process.env.BLAST_NATIVE_YIELD_TIMEOUT_MS || "15000");
const MIN_NATIVE_LTV = Number(process.env.BLAST_NATIVE_YIELD_MIN_LTV || "0.70");
const MIN_LIQUIDITY_USD = Number(process.env.BLAST_NATIVE_YIELD_MIN_LIQUIDITY_USD || "10000");
const DRIFT_WATCH_BPS = Number(process.env.BLAST_NATIVE_YIELD_DRIFT_WATCH_BPS || "25");

const BLAST_WETH = "0x4300000000000000000000000000000000000004";
const BLAST_USDB = "0x4300000000000000000000000000000000000003";
const BLAST_YIELD_TOKENS = new Set([BLAST_WETH.toLowerCase(), BLAST_USDB.toLowerCase()]);

const COMPOUND_FORKS = [
  { protocol: "Blume FM", comptroller: "0x4EdF556c5664b4f86Ec50dB0F58B58B26210DC31" },
  { protocol: "ASO Finance", comptroller: "0xD5e60A396842D6C1D5470E16DA0BfDbb7Ba47101", cether: "0x001FF326A2836bdD77B28E992344983681071f87", cetherEquivalent: BLAST_WETH },
  { protocol: "0xLend", comptroller: "0x1DD821C9E27fB2399DAb75AedB113c80C755DCa6", cether: "0xd9fcbd7b60966d013a28ff87925f75bb49e9b5ee", cetherEquivalent: BLAST_WETH },
  { protocol: "Novation", comptroller: "0x3090Cd174218BB451C7865bDC621d47E1Bd6831C", allMarketsFn: "allMarkets", totalBorrowsFn: "totalBorrow" },
  { protocol: "Orbit Protocol", comptroller: "0x1E18C3cb491D908241D0db14b081B51be7B6e652", cether: ["0xf9b3b455f5d900f62bc1792a6ca6e1d47b989389", "0x0872b71efc37cb8dde22b2118de3d800427fdba0"], cetherEquivalent: BLAST_WETH, insolvent: true },
  { protocol: "Orbit Protocol", comptroller: "0x273683CA19D9CF827628EE216E4a9604EfB077A3", cether: ["0x795dcd51eac6eb3123b7a4a1f906992eaa54cb0e"], cetherEquivalent: BLAST_WETH, insolvent: true },
  { protocol: "Orbit Protocol", comptroller: "0xe9266ae95bB637A7Ad598CB0390d44262130F433", cether: ["0xafabd582e82042f4a8574f75c36409abea916ac5"], cetherEquivalent: BLAST_WETH, insolvent: true },
  { protocol: "Orbit Protocol", comptroller: "0xfFF8Fc176697D04607cF4e23E91c65aeD1c3d3F5", cether: ["0x530a8d3fdf61112f8a879d753fe02e9e37ec36aa"], cetherEquivalent: BLAST_WETH, insolvent: true },
];

const ERC20 = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
]);

const INIT_POOL = new ethers.Interface([
  "function totalDebt() view returns (uint256)",
]);

const INIT_WRAPPER = new ethers.Interface([
  "function toAmt(uint256 shares) view returns (uint256)",
  "function toShares(uint256 amt) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
]);

const COMPTROLLER = new ethers.Interface([
  "function getAllMarkets() view returns (address[])",
  "function allMarkets() view returns (address[])",
  "function markets(address cToken) view returns (bool,uint256,bool)",
  "function oracle() view returns (address)",
]);

const CTOKEN = new ethers.Interface([
  "function underlying() view returns (address)",
  "function getCash() view returns (uint256)",
  "function totalBorrows() view returns (uint256)",
  "function totalBorrow() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function exchangeRateStored() view returns (uint256)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
]);

const PRICE_ORACLE = new ethers.Interface([
  "function getUnderlyingPrice(address cToken) view returns (uint256)",
]);

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function normalizeAddress(value) {
  try { return ethers.getAddress(value); } catch (_) { return null; }
}

function lowerAddress(value) {
  const address = normalizeAddress(value);
  return address ? address.toLowerCase() : null;
}

function asNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value).replace(/[$,%\s,_]/g, "");
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function round(value, decimals = 6) {
  const n = asNumber(value);
  if (n === null) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function loadRpcUrls() {
  if (!fs.existsSync(RPC_FILE)) return [];
  return [...fs.readFileSync(RPC_FILE, "utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map((m) => m[0]);
}

async function rpcCall(url, method, params = [], timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    const json = await res.json();
    if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
    return json.result ?? null;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveRpcUrl(chainId) {
  for (const url of loadRpcUrls()) {
    try {
      const id = Number(BigInt(await rpcCall(url, "eth_chainId", [], 6000)));
      if (id === chainId) return url;
    } catch (_) {
      // Never print or persist RPC URLs.
    }
  }
  return null;
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function safeProviderCall(provider, to, data) {
  try { return await provider.call({ to, data }); } catch (_) { return null; }
}

function decodeResult(raw, iface, fn) {
  if (!raw || raw === "0x") return null;
  try { return iface.decodeFunctionResult(fn, raw); } catch (_) { return null; }
}

function decodeStringResult(raw, iface, fn) {
  if (!raw || raw === "0x") return null;
  try { return String(iface.decodeFunctionResult(fn, raw)[0]); } catch (_) { return null; }
}

function decodeUintResult(raw, iface, fn) {
  if (!raw || raw === "0x") return null;
  try { return BigInt(iface.decodeFunctionResult(fn, raw)[0]); } catch (_) {
    try { return BigInt(raw); } catch (_) { return null; }
  }
}

function formatUnitsNumber(raw, decimals) {
  if (raw === null || raw === undefined || decimals === null || decimals === undefined) return null;
  try { return Number(ethers.formatUnits(raw, Number(decimals))); } catch (_) { return null; }
}

async function tokenMeta(provider, address, fallback = {}) {
  const token = normalizeAddress(address);
  if (!token) return { address: null, symbol: fallback.symbol || null, name: fallback.name || null, decimals: fallback.decimals ?? 18 };
  const [symbolRaw, nameRaw, decimalsRaw] = await Promise.all([
    safeProviderCall(provider, token, ERC20.encodeFunctionData("symbol", [])),
    safeProviderCall(provider, token, ERC20.encodeFunctionData("name", [])),
    safeProviderCall(provider, token, ERC20.encodeFunctionData("decimals", [])),
  ]);
  return {
    address: token,
    symbol: decodeStringResult(symbolRaw, ERC20, "symbol") || fallback.symbol || null,
    name: decodeStringResult(nameRaw, ERC20, "name") || fallback.name || null,
    decimals: Number(decodeUintResult(decimalsRaw, ERC20, "decimals") ?? BigInt(fallback.decimals ?? 18)),
  };
}

async function erc20Balance(provider, token, account) {
  const raw = await safeProviderCall(provider, token, ERC20.encodeFunctionData("balanceOf", [account]));
  return decodeUintResult(raw, ERC20, "balanceOf") || 0n;
}

async function fetchAddressPrices(addresses) {
  const keys = [...new Set((addresses || []).map(lowerAddress).filter(Boolean).map((address) => `blast:${address}`))];
  const out = {};
  for (let i = 0; i < keys.length; i += 50) {
    const json = await fetchJson(`https://coins.llama.fi/prices/current/${keys.slice(i, i + 50).join(",")}?searchWidth=6h`, { timeoutMs: 30_000 }).catch(() => ({ coins: {} }));
    Object.assign(out, json.coins || {});
  }
  const map = new Map();
  for (const [key, row] of Object.entries(out)) {
    const address = lowerAddress(key.slice(key.indexOf(":") + 1));
    const price = Number(row?.price || 0);
    if (address && Number.isFinite(price) && price > 0) map.set(address, price);
  }
  return map;
}

function isBlastNativeYieldToken(address, symbol) {
  const lower = lowerAddress(address);
  return Boolean(lower && BLAST_YIELD_TOKENS.has(lower)) || /^(ETH|WETH|USDB)$/i.test(String(symbol || ""));
}

function riskTagsForToken(address, symbol, name) {
  const upper = `${symbol || ""} ${name || ""}`.toUpperCase();
  const tags = [];
  if (isBlastNativeYieldToken(address, symbol)) tags.push("blast-native-yield-token");
  if (/VAULT|SHARE|ERC4626|STAKED|STAKING|YIELD|RECEIPT|SAVING/.test(upper) || /^S[A-Z0-9]{2,}/.test(String(symbol || ""))) tags.push("receipt-or-yield-bearing");
  if (/EZETH|WEETH|RSETH|WSTETH|METH|ULTRAETH|LRT|RESTAK/.test(upper)) tags.push("lst-lrt-restaking");
  return [...new Set(tags)];
}

async function scanInit(provider) {
  const json = await fetchJson(INIT_POOLS_URL, { timeoutMs: 30_000 }).catch(() => ({}));
  const pools = Object.values(json?.[String(CHAIN_ID)] || {});
  const tokens = pools.map((p) => p.underlyingToken).filter(Boolean);
  const prices = await fetchAddressPrices(tokens);
  const rows = [];
  for (const pool of pools) {
    const poolAddress = normalizeAddress(pool.poolAddress);
    const underlying = normalizeAddress(pool.underlyingToken);
    const wrapper = normalizeAddress(pool.rebaseWrapperAddress);
    if (!poolAddress || !underlying) continue;
    const owner = wrapper || poolAddress;
    const meta = await tokenMeta(provider, underlying, { symbol: pool.name || null });
    const [cashRaw, debtSharesRaw, wrapperSupplyRaw] = await Promise.all([
      erc20Balance(provider, underlying, owner).catch(() => 0n),
      safeProviderCall(provider, poolAddress, INIT_POOL.encodeFunctionData("totalDebt", [])).then((raw) => decodeUintResult(raw, INIT_POOL, "totalDebt") || 0n).catch(() => 0n),
      wrapper ? safeProviderCall(provider, wrapper, INIT_WRAPPER.encodeFunctionData("totalSupply", [])).then((raw) => decodeUintResult(raw, INIT_WRAPPER, "totalSupply") || 0n).catch(() => 0n) : 0n,
    ]);
    const debtAmtRaw = wrapper && debtSharesRaw > 0n
      ? await safeProviderCall(provider, wrapper, INIT_WRAPPER.encodeFunctionData("toAmt", [debtSharesRaw])).then((raw) => decodeUintResult(raw, INIT_WRAPPER, "toAmt") || 0n).catch(() => 0n)
      : debtSharesRaw;
    const price = Number(prices.get(underlying.toLowerCase()) || 0);
    const cash = formatUnitsNumber(cashRaw, meta.decimals) || 0;
    const debt = formatUnitsNumber(debtAmtRaw, meta.decimals) || 0;
    const riskTags = riskTagsForToken(underlying, meta.symbol, meta.name);
    if (wrapper) riskTags.push("init-rebase-wrapper");
    const materialLiquidity = cash * price >= MIN_LIQUIDITY_USD;
    rows.push({
      protocol: "INIT Capital",
      chainId: CHAIN_ID,
      chain: CHAIN_NAME,
      pool: poolAddress,
      rebaseWrapper: wrapper,
      underlying: meta,
      isBorrowable: Boolean(pool.isBorrowable),
      isHidden: Boolean(pool.isHide),
      points: pool.points || {},
      cashRaw: cashRaw.toString(),
      debtRaw: debtAmtRaw.toString(),
      debtSharesRaw: debtSharesRaw.toString(),
      wrapperTotalSupplyRaw: wrapperSupplyRaw.toString(),
      cash,
      cashUsd: round(cash * price, 2),
      debt,
      debtUsd: round(debt * price, 2),
      priceUsd: price || null,
      wrapperRateBps: null,
      riskTags,
      materialLiquidity,
      watchCandidate: false,
      routePositive: false,
      blockers: [
        "INIT pool scan lacks collateral-factor/account-mode route simulation",
        "INIT rebase wrapper conversion is not a normalized exchange-rate oracle; exact account-mode config is required before economics",
        !materialLiquidity ? `Pool liquidity below $${MIN_LIQUIDITY_USD}` : null,
        "No exact deposit/borrow/exit economics or fork proof",
      ].filter(Boolean),
    });
  }
  return rows;
}

function cetherSet(config) {
  return new Set((Array.isArray(config.cether) ? config.cether : [config.cether]).map(lowerAddress).filter(Boolean));
}

async function getMarkets(provider, comptroller, allMarketsFn = "getAllMarkets") {
  const raw = await safeProviderCall(provider, comptroller, COMPTROLLER.encodeFunctionData(allMarketsFn, []));
  const decoded = decodeResult(raw, COMPTROLLER, allMarketsFn);
  if (decoded?.[0]?.length) return decoded[0].map(normalizeAddress).filter(Boolean);
  if (allMarketsFn !== "allMarkets") return getMarkets(provider, comptroller, "allMarkets");
  return [];
}

async function scanCompoundFork(provider, config, prices) {
  const comptroller = normalizeAddress(config.comptroller);
  if (!comptroller) return { rows: [], stats: { valid: false, reason: "invalid-comptroller" } };
  const code = await provider.getCode(comptroller).catch(() => "0x");
  if (!code || code === "0x") return { rows: [], stats: { valid: false, comptroller, reason: "no-code" } };
  const markets = await getMarkets(provider, comptroller, config.allMarketsFn || "getAllMarkets").catch(() => []);
  const oracleRaw = await safeProviderCall(provider, comptroller, COMPTROLLER.encodeFunctionData("oracle", [])).catch(() => null);
  const oracle = normalizeAddress(decodeResult(oracleRaw, COMPTROLLER, "oracle")?.[0]);
  const cethers = cetherSet(config);
  const rows = [];
  for (const cToken of markets) {
    const cTokenLower = cToken.toLowerCase();
    const isCether = cethers.has(cTokenLower);
    const [symbolRaw, nameRaw, decimalsRaw, underlyingRaw, cashRawCall, borrowsRawCall, supplyRawCall, exchangeRateRawCall, marketRaw, oraclePriceRaw] = await Promise.all([
      safeProviderCall(provider, cToken, CTOKEN.encodeFunctionData("symbol", [])),
      safeProviderCall(provider, cToken, CTOKEN.encodeFunctionData("name", [])),
      safeProviderCall(provider, cToken, CTOKEN.encodeFunctionData("decimals", [])),
      isCether ? null : safeProviderCall(provider, cToken, CTOKEN.encodeFunctionData("underlying", [])),
      safeProviderCall(provider, cToken, CTOKEN.encodeFunctionData("getCash", [])),
      safeProviderCall(provider, cToken, CTOKEN.encodeFunctionData(config.totalBorrowsFn || "totalBorrows", [])),
      safeProviderCall(provider, cToken, CTOKEN.encodeFunctionData("totalSupply", [])),
      safeProviderCall(provider, cToken, CTOKEN.encodeFunctionData("exchangeRateStored", [])),
      safeProviderCall(provider, comptroller, COMPTROLLER.encodeFunctionData("markets", [cToken])),
      oracle ? safeProviderCall(provider, oracle, PRICE_ORACLE.encodeFunctionData("getUnderlyingPrice", [cToken])) : null,
    ]);
    const underlying = isCether ? normalizeAddress(config.cetherEquivalent || BLAST_WETH) : normalizeAddress(decodeResult(underlyingRaw, CTOKEN, "underlying")?.[0]);
    const meta = underlying ? await tokenMeta(provider, underlying, {}) : { address: null, symbol: null, name: null, decimals: 18 };
    const cSymbol = decodeStringResult(symbolRaw, CTOKEN, "symbol");
    const cName = decodeStringResult(nameRaw, CTOKEN, "name");
    const cDecimals = Number(decodeUintResult(decimalsRaw, CTOKEN, "decimals") || 8n);
    const cashRaw = decodeUintResult(cashRawCall, CTOKEN, "getCash") || 0n;
    const borrowFn = config.totalBorrowsFn || "totalBorrows";
    const borrowsRaw = decodeUintResult(borrowsRawCall, CTOKEN, borrowFn) || 0n;
    const supplyRaw = decodeUintResult(supplyRawCall, CTOKEN, "totalSupply") || 0n;
    const exchangeRateRaw = decodeUintResult(exchangeRateRawCall, CTOKEN, "exchangeRateStored") || 0n;
    const market = decodeResult(marketRaw, COMPTROLLER, "markets");
    const listed = Boolean(market?.[0]);
    const collateralFactor = market?.[1] !== undefined ? Number(market[1]) / 1e18 : null;
    const price = Number(prices.get(underlying?.toLowerCase()) || 0);
    const riskTags = riskTagsForToken(underlying, meta.symbol, meta.name);
    const cash = formatUnitsNumber(cashRaw, meta.decimals) || 0;
    const borrows = formatUnitsNumber(borrowsRaw, meta.decimals) || 0;
    const cashUsd = cash * price;
    const borrowsUsd = borrows * price;
    const oraclePriceRawBig = decodeUintResult(oraclePriceRaw, PRICE_ORACLE, "getUnderlyingPrice") || 0n;
    const highNativeLtv = riskTags.includes("blast-native-yield-token") && Number(collateralFactor || 0) >= MIN_NATIVE_LTV;
    const materialLiquidity = cashUsd >= MIN_LIQUIDITY_USD;
    rows.push({
      protocol: config.protocol,
      chainId: CHAIN_ID,
      chain: CHAIN_NAME,
      comptroller,
      cToken,
      cTokenMeta: { symbol: cSymbol, name: cName, decimals: cDecimals },
      underlying: meta,
      listed,
      insolvent: Boolean(config.insolvent),
      collateralFactor,
      cashRaw: cashRaw.toString(),
      borrowsRaw: borrowsRaw.toString(),
      totalSupplyRaw: supplyRaw.toString(),
      exchangeRateRaw: exchangeRateRaw.toString(),
      cash,
      cashUsd: round(cashUsd, 2),
      borrows,
      borrowsUsd: round(borrowsUsd, 2),
      priceUsd: price || null,
      oracle,
      oraclePriceRaw: oraclePriceRawBig.toString(),
      riskTags,
      highNativeLtv,
      materialLiquidity,
      watchCandidate: highNativeLtv && materialLiquidity && !config.insolvent,
      routePositive: false,
      blockers: [
        config.insolvent ? "Comptroller is marked insolvent/dead in public adapter metadata" : null,
        !highNativeLtv ? `Native-yield collateral factor below ${MIN_NATIVE_LTV} or not native-yield token` : null,
        !materialLiquidity ? `Market cash below $${MIN_LIQUIDITY_USD}` : null,
        "No exact native-yield accounting exploit, acquisition/borrow/exit economics, or fork proof",
      ].filter(Boolean),
    });
  }
  return { rows, stats: { valid: true, comptroller, marketsScanned: markets.length, oracle } };
}

async function scanCompoundForks(provider) {
  const underlyingAddresses = [BLAST_WETH, BLAST_USDB];
  for (const cfg of COMPOUND_FORKS) {
    for (const addr of Array.isArray(cfg.cetherEquivalent) ? cfg.cetherEquivalent : [cfg.cetherEquivalent]) if (addr) underlyingAddresses.push(addr);
  }
  const prices = await fetchAddressPrices(underlyingAddresses);
  const rows = [];
  const stats = [];
  for (const cfg of COMPOUND_FORKS) {
    const result = await scanCompoundFork(provider, cfg, prices).catch((err) => ({ rows: [], stats: { valid: false, comptroller: cfg.comptroller, protocol: cfg.protocol, reason: err.message || String(err) } }));
    stats.push({ protocol: cfg.protocol, ...result.stats });
    rows.push(...result.rows);
  }
  return { rows, stats };
}

function summarizeRows(rows) {
  const summary = { byProtocol: {}, byRiskTag: {} };
  for (const row of rows || []) {
    summary.byProtocol[row.protocol] = (summary.byProtocol[row.protocol] || 0) + 1;
    for (const tag of row.riskTags || []) summary.byRiskTag[tag] = (summary.byRiskTag[tag] || 0) + 1;
  }
  return summary;
}

async function main() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const rpc = await resolveRpcUrl(CHAIN_ID);
  if (!rpc) throw new Error("No Blast RPC endpoint resolved from local inventory");
  const provider = new ethers.JsonRpcProvider(rpc, CHAIN_ID, { staticNetwork: true });
  const blockNumber = await provider.getBlockNumber().catch(() => null);
  const [initRows, compound] = await Promise.all([
    scanInit(provider),
    scanCompoundForks(provider),
  ]);
  const rows = [...initRows, ...compound.rows];
  const watchRows = rows.filter((row) => row.watchCandidate);
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-blast-native-yield-lending.js",
    scope: "Read-only Blast native-yield lending accounting scan over INIT pools and Compound-fork comptrollers",
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: false,
      signedActionJustified: false,
    },
    chain: { chainId: CHAIN_ID, name: CHAIN_NAME, blockNumber },
    thresholds: {
      minNativeLtv: MIN_NATIVE_LTV,
      minLiquidityUsd: MIN_LIQUIDITY_USD,
      driftWatchBps: DRIFT_WATCH_BPS,
    },
    summary: {
      initPoolsScanned: initRows.length,
      initRebaseWrapperPools: initRows.filter((row) => row.rebaseWrapper).length,
      compoundForksChecked: COMPOUND_FORKS.length,
      compoundForksValid: compound.stats.filter((row) => row.valid).length,
      compoundMarketsScanned: compound.rows.length,
      rowsScanned: rows.length,
      nativeYieldRows: rows.filter((row) => row.riskTags?.includes("blast-native-yield-token")).length,
      highNativeLtvRows: rows.filter((row) => row.highNativeLtv).length,
      watchCandidates: watchRows.length,
      routePositive: 0,
      signedActionJustified: false,
      breakdown: summarizeRows(rows),
    },
    compoundForkStats: compound.stats,
    topRows: rows.slice().sort((a, b) => Number(b.watchCandidate) - Number(a.watchCandidate) || Number(b.cashUsd || 0) - Number(a.cashUsd || 0)).slice(0, 120),
    rows,
    nextRoutePositiveCriteria: [
      "native-yield token is accepted as collateral with material borrow liquidity",
      "protocol accounting/oracle value diverges from exact redeem/swap/acquisition value",
      "borrowed asset has exact exit route and gas/slippage/flash-fee adjusted net is positive",
      "local fork extraction proof measures positive net value",
    ],
  };
  fs.writeFileSync(OUT, JSON.stringify(artifact, jsonReplacer, 2) + "\n");
  const line = `Blast native-yield lending: rows=${artifact.summary.rowsScanned} nativeYield=${artifact.summary.nativeYieldRows} highNativeLtv=${artifact.summary.highNativeLtvRows} watch=${artifact.summary.watchCandidates} routePositive=0`;
  console.log(line);
  if (!QUIET) console.log(`Artifact: ${path.relative(WORKSPACE, OUT).replace(/\\/g, "/")}`);
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
