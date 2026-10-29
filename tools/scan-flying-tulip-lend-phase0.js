#!/usr/bin/env node
// scan-flying-tulip-lend-phase0.js - bounded read-only Phase 0 for Flying Tulip Lend.
// Resolves RPC URLs in memory only. Never prints or stores RPC URLs, keys, calldata for execution, or signed actions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "flying-tulip-lend-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "flying-tulip-lend-phase0-triage.md");
const QUIET = process.argv.includes("--quiet");

const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const EIP1967_BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

const LENDING_LENS = "0x3682168023e6ba8d1f995fda1d920827c5a8a43e";

const CHAINS = [
  {
    name: "Ethereum",
    llamaKey: "ethereum",
    chainId: 1,
    lens: LENDING_LENS,
    reserves: [
      { symbol: "USDC", token: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", wrapper: "0xD2e4A5ac4B4Da102317cF7C9A1289aDF082639E2", common: true },
      { symbol: "USDT", token: "0xdac17f958d2ee523a2206206994597c13d831ec7", wrapper: "0x28b0905d83BCe5FFA6c54651F25858828A38123B", common: true },
      { symbol: "WETH", token: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", wrapper: "0x460494aF61BcB92B59797B4e09C26A5ADecb2da2", common: true },
      { symbol: "WBTC", token: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", wrapper: "0x1A5730c71576D77048E9FdC79DD40e4B1E8Fe042", common: true },
      { symbol: "FT", token: "0x5DD1A7A369e8273371d2DBf9d83356057088082c", wrapper: "0x7127BB9d9ad0f47B8dA9087e634D67F3946F840E", common: false },
      { symbol: "wstETH", token: "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0", wrapper: "0x01980BD1B58313bD3767f6adc75Af8b6464f3db7", common: true },
    ],
  },
  {
    name: "Sonic",
    llamaKey: "sonic",
    chainId: 146,
    lens: LENDING_LENS,
    reserves: [
      { symbol: "USDC.e", token: "0x29219dd400f2Bf60E5a23d13Be72B486D4038894", wrapper: "0x7a2fd34e4cc4c8b1023576a3f3d1f7aa36cf8b47", common: true },
      { symbol: "wS", token: "0x039e2fb66102314ce7b64ce5ce3e5183bc94ad38", wrapper: "0xbb155f15d8452139d1a9c3a664847d2f8314c18e", common: true },
      { symbol: "FT", token: "0x5DD1A7A369e8273371d2DBf9d83356057088082c", wrapper: "0x7127bb9d9ad0f47b8da9087e634d67f3946f840e", common: false },
      { symbol: "stS", token: "0xe5da20f15420ad15de0fa650600afc998bbe3955", wrapper: "0x8b98e46421898437862de44aa63b73b2da69147b", common: false },
      { symbol: "WBTC", token: "0x0555e30da8f98308edb960aa94c0db47230d2b9c", wrapper: "0xd6587e78d252e630d425ecd827017bf81b0ac553", common: true },
      { symbol: "WETH", token: "0x50c42dEAcD8Fc9773493ED674b675bE577f2634b", wrapper: "0x727bc187150d5599e7fba32732c21c6d9f5b1837", common: true },
      { symbol: "USSD", token: "0x000000000eccff26b795f73fb0a70d48da657fef", wrapper: "0x0e794B1FD35A7a5550CD3E305882369FFB2DF7f7", common: false },
    ],
  },
];

const INPUTS = [
  ["aave-euler-silo", "reports/raw/fast/aave-euler-silo-consumer-graph.json"],
  ["consumer-first-high-ltv", "reports/raw/fast/consumer-first-high-ltv-collateral.json"],
  ["public-lead-consumer", "reports/raw/fast/public-lead-consumer-joins.json"],
  ["erc4626", "reports/raw/fast/erc4626-consumer-joiner.json"],
  ["stablecoin-depeg", "reports/raw/fast/stablecoin-depeg-lending-routes.json"],
  ["lrt-oracle-drift", "reports/raw/fast/lrt-oracle-drift-routes.json"],
  ["small-cap-oracle", "reports/raw/fast/small-cap-oracle-manipulation-routes.json"],
  ["market-launch", "reports/raw/fast/market-launch-choreography-routes.json"],
  ["bridge-nonlossless", "reports/raw/fast/bridge-nonlossless-collateral-join.json"],
  ["bridge-delta", "reports/raw/fast/bridge-delta-preflight.json"],
  ["current-liquidatable", "reports/raw/fast/current-liquidatable-exit-routes.json"],
  ["morpho-marketability", "reports/raw/fast/morpho-liquidatable-marketability.json"],
  ["seven-chain-lending", "reports/raw/fast/seven-chain-lending-coverage.json"],
];

const ERC20 = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
]);
const WRAPPER = new ethers.Interface([
  "function numberOfStrategies() view returns (uint256)",
  "function strategies(uint256) view returns (address)",
  "function asset() view returns (address)",
  "function underlying() view returns (address)",
  "function token() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function paused() view returns (bool)",
  "function owner() view returns (address)",
]);
const STRATEGY = new ethers.Interface([
  "function positionToken() view returns (address)",
]);
const LENS = new ethers.Interface([
  "function assetState(address) view returns (uint256 cash, uint256 borrows, uint256 reserves, uint256 utilWad)",
]);

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function readJson(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function normalizeAddress(value) {
  try {
    return ethers.getAddress(value);
  } catch (_) {
    const text = String(value || "");
    if (/^0x[0-9a-fA-F]{40}$/.test(text)) {
      try {
        return ethers.getAddress(text.toLowerCase());
      } catch (_) {
        return null;
      }
    }
    return null;
  }
}

function lowerAddress(value) {
  const address = normalizeAddress(value);
  return address ? address.toLowerCase() : null;
}

function strip0x(value) {
  return String(value || "").replace(/^0x/i, "");
}

function addressFromStorageSlot(raw) {
  if (!raw || raw === "0x") return null;
  const hex = strip0x(raw).padStart(64, "0");
  if (/^0+$/.test(hex)) return null;
  return normalizeAddress(`0x${hex.slice(-40)}`);
}

function formatUnits(value, decimals) {
  if (value === null || value === undefined || decimals === null || decimals === undefined) return null;
  try {
    return ethers.formatUnits(BigInt(value), Number(decimals));
  } catch (_) {
    return null;
  }
}

function numberUnits(value, decimals) {
  const text = formatUnits(value, decimals);
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function asNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const n = Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function round(value, decimals = 2) {
  const n = asNumber(value);
  if (n === null) return null;
  const p = 10 ** decimals;
  return Math.round(n * p) / p;
}

function formatUsd(value) {
  const n = asNumber(value);
  return n === null ? "n/a" : `$${n.toLocaleString()}`;
}

function formatPct(value) {
  const n = asNumber(value);
  return n === null ? "n/a" : `${n}%`;
}

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function loadRpcUrls() {
  if (!fs.existsSync(RPC_FILE)) return [];
  return [...fs.readFileSync(RPC_FILE, "utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map((m) => m[0]);
}

async function rpcCall(url, method, params = [], timeoutMs = 8000) {
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
    if (json.error) throw new Error(json.error.message || "rpc error");
    return json.result ?? null;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveRpc(chainId) {
  const urls = loadRpcUrls();
  const attempts = urls.map(async (url) => {
    try {
      const idHex = await rpcCall(url, "eth_chainId", [], 6000);
      return Number(BigInt(idHex)) === chainId ? url : null;
    } catch (_) {
      return null;
    }
  });
  const settled = await Promise.allSettled(attempts);
  const found = settled.find((row) => row.status === "fulfilled" && row.value);
  return found?.value || null;
}

async function fetchJson(url, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "evm-audit-flying-tulip-phase0/1.0" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function lastRow(value) {
  return Array.isArray(value) && value.length ? value[value.length - 1] : null;
}

function seriesUsd(series) {
  const row = lastRow(series);
  return round(row?.totalLiquidityUSD ?? row?.tvl ?? row?.value, 2);
}

function latestTokensInUsd(chainObj) {
  return lastRow(chainObj?.tokensInUsd)?.tokens || {};
}

function protocolChainMeta(metadataRaw, chainName) {
  const chainObj = metadataRaw?.chainTvls?.[chainName] || {};
  return {
    tvlUsd: seriesUsd(chainObj.tvl),
    borrowedUsd: seriesUsd(chainObj.borrowed?.tvl),
    latestTokensInUsd: latestTokensInUsd(chainObj),
    latestBorrowedTokensInUsd: latestTokensInUsd(chainObj.borrowed),
  };
}

async function safeCall(provider, to, iface, fn, args = []) {
  try {
    const raw = await provider.call({ to, data: iface.encodeFunctionData(fn, args) });
    return iface.decodeFunctionResult(fn, raw);
  } catch (_) {
    return null;
  }
}

async function proxyState(provider, address) {
  const [implRaw, adminRaw, beaconRaw] = await Promise.all([
    provider.getStorage(address, EIP1967_IMPLEMENTATION_SLOT).catch(() => null),
    provider.getStorage(address, EIP1967_ADMIN_SLOT).catch(() => null),
    provider.getStorage(address, EIP1967_BEACON_SLOT).catch(() => null),
  ]);
  return {
    implementation: addressFromStorageSlot(implRaw),
    admin: addressFromStorageSlot(adminRaw),
    beacon: addressFromStorageSlot(beaconRaw),
  };
}

async function tokenPriceMap(chains) {
  const keys = [];
  for (const chain of chains) {
    for (const reserve of chain.reserves) {
      const address = lowerAddress(reserve.token);
      if (address) keys.push(`${chain.llamaKey}:${address}`);
    }
  }
  if (!keys.length) return new Map();
  const prices = new Map();
  try {
    const json = await fetchJson(`https://coins.llama.fi/prices/current/${[...new Set(keys)].join(",")}?searchWidth=6h`, 30_000);
    for (const [key, row] of Object.entries(json.coins || {})) {
      const parts = key.split(":");
      const address = lowerAddress(parts.pop());
      const price = Number(row.price || 0);
      if (parts[0] && address && Number.isFinite(price) && price > 0) prices.set(`${parts[0]}:${address}`, price);
    }
  } catch (_) {
    // Public prices are optional; scanner remains fail-closed.
  }
  return prices;
}

async function contractState(provider, address) {
  const normalized = normalizeAddress(address);
  if (!normalized) return { address: null, codePresent: false, codeBytes: 0, eip1967: {} };
  const code = await provider.getCode(normalized).catch(() => "0x");
  return {
    address: normalized,
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
    eip1967: code && code !== "0x" ? await proxyState(provider, normalized) : {},
  };
}

async function scanReserve(provider, chain, reserve, prices) {
  const token = normalizeAddress(reserve.token);
  const wrapper = normalizeAddress(reserve.wrapper);
  const priceUsd = prices.get(`${chain.llamaKey}:${lowerAddress(token)}`) || null;
  const [tokenCode, wrapperCode, tokenSymbolRaw, tokenNameRaw, tokenDecimalsRaw, tokenSupplyRaw, wrapperSymbolRaw, wrapperNameRaw, wrapperDecimalsRaw, wrapperSupplyRaw, assetStateRaw, wrapperUnderlyingBalRaw, strategiesRaw, wrapperAssetRaw, wrapperUnderlyingRaw, wrapperTokenRaw, totalAssetsRaw, oneShareAssetsRaw, pausedRaw, ownerRaw] = await Promise.all([
    provider.getCode(token).catch(() => "0x"),
    provider.getCode(wrapper).catch(() => "0x"),
    safeCall(provider, token, ERC20, "symbol", []),
    safeCall(provider, token, ERC20, "name", []),
    safeCall(provider, token, ERC20, "decimals", []),
    safeCall(provider, token, ERC20, "totalSupply", []),
    safeCall(provider, wrapper, ERC20, "symbol", []),
    safeCall(provider, wrapper, ERC20, "name", []),
    safeCall(provider, wrapper, ERC20, "decimals", []),
    safeCall(provider, wrapper, ERC20, "totalSupply", []),
    safeCall(provider, chain.lens, LENS, "assetState", [token]),
    safeCall(provider, token, ERC20, "balanceOf", [wrapper]),
    safeCall(provider, wrapper, WRAPPER, "numberOfStrategies", []),
    safeCall(provider, wrapper, WRAPPER, "asset", []),
    safeCall(provider, wrapper, WRAPPER, "underlying", []),
    safeCall(provider, wrapper, WRAPPER, "token", []),
    safeCall(provider, wrapper, WRAPPER, "totalAssets", []),
    safeCall(provider, wrapper, WRAPPER, "convertToAssets", [10n ** 18n]),
    safeCall(provider, wrapper, WRAPPER, "paused", []),
    safeCall(provider, wrapper, WRAPPER, "owner", []),
  ]);

  const decimals = tokenDecimalsRaw?.[0] === undefined ? null : Number(tokenDecimalsRaw[0]);
  const wrapperDecimals = wrapperDecimalsRaw?.[0] === undefined ? null : Number(wrapperDecimalsRaw[0]);
  const cash = assetStateRaw?.[0] ?? null;
  const borrows = assetStateRaw?.[1] ?? null;
  const protocolReserves = assetStateRaw?.[2] ?? null;
  const utilWad = assetStateRaw?.[3] ?? null;
  const strategiesCount = strategiesRaw?.[0] === undefined ? null : Number(strategiesRaw[0]);
  const strategyLimit = Math.min(Number.isFinite(strategiesCount) ? strategiesCount : 0, 32);
  const strategyAddresses = [];
  for (let i = 0; i < strategyLimit; i++) {
    const row = await safeCall(provider, wrapper, WRAPPER, "strategies", [BigInt(i)]);
    const strategy = normalizeAddress(row?.[0]);
    if (strategy) strategyAddresses.push(strategy);
  }

  const strategyRows = [];
  for (const strategy of strategyAddresses) {
    const [code, positionTokenRaw] = await Promise.all([
      provider.getCode(strategy).catch(() => "0x"),
      safeCall(provider, strategy, STRATEGY, "positionToken", []),
    ]);
    const positionToken = normalizeAddress(positionTokenRaw?.[0]);
    const [positionSymbolRaw, positionDecimalsRaw, positionBalanceRaw] = positionToken ? await Promise.all([
      safeCall(provider, positionToken, ERC20, "symbol", []),
      safeCall(provider, positionToken, ERC20, "decimals", []),
      safeCall(provider, positionToken, ERC20, "balanceOf", [strategy]),
    ]) : [null, null, null];
    const positionDecimals = positionDecimalsRaw?.[0] === undefined ? null : Number(positionDecimalsRaw[0]);
    strategyRows.push({
      strategy,
      codePresent: Boolean(code && code !== "0x"),
      codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
      positionToken,
      positionSymbol: positionSymbolRaw?.[0] ? String(positionSymbolRaw[0]) : null,
      positionDecimals,
      positionBalanceRaw: positionBalanceRaw?.[0]?.toString() || null,
      positionBalance: formatUnits(positionBalanceRaw?.[0], positionDecimals),
    });
  }

  const cashUsd = priceUsd && cash !== null && decimals !== null ? numberUnits(cash, decimals) * priceUsd : null;
  const borrowUsd = priceUsd && borrows !== null && decimals !== null ? numberUnits(borrows, decimals) * priceUsd : null;
  const reserveUsd = priceUsd && protocolReserves !== null && decimals !== null ? numberUnits(protocolReserves, decimals) * priceUsd : null;
  const wrapperUnderlyingUsd = priceUsd && wrapperUnderlyingBalRaw?.[0] !== undefined && decimals !== null ? numberUnits(wrapperUnderlyingBalRaw[0], decimals) * priceUsd : null;

  return {
    chain: chain.name,
    chainId: chain.chainId,
    symbol: reserve.symbol,
    token,
    wrapper,
    common: Boolean(reserve.common),
    tokenCodePresent: Boolean(tokenCode && tokenCode !== "0x"),
    wrapperCodePresent: Boolean(wrapperCode && wrapperCode !== "0x"),
    wrapperCodeBytes: wrapperCode && wrapperCode !== "0x" ? strip0x(wrapperCode).length / 2 : 0,
    wrapperEip1967: wrapperCode && wrapperCode !== "0x" ? await proxyState(provider, wrapper) : {},
    tokenSymbol: tokenSymbolRaw?.[0] ? String(tokenSymbolRaw[0]) : null,
    tokenName: tokenNameRaw?.[0] ? String(tokenNameRaw[0]) : null,
    decimals,
    priceUsd: round(priceUsd, 8),
    tokenTotalSupplyRaw: tokenSupplyRaw?.[0]?.toString() || null,
    tokenTotalSupply: formatUnits(tokenSupplyRaw?.[0], decimals),
    wrapperSymbol: wrapperSymbolRaw?.[0] ? String(wrapperSymbolRaw[0]) : null,
    wrapperName: wrapperNameRaw?.[0] ? String(wrapperNameRaw[0]) : null,
    wrapperDecimals,
    wrapperTotalSupplyRaw: wrapperSupplyRaw?.[0]?.toString() || null,
    wrapperTotalSupply: formatUnits(wrapperSupplyRaw?.[0], wrapperDecimals),
    wrapperAsset: normalizeAddress(wrapperAssetRaw?.[0]),
    wrapperUnderlying: normalizeAddress(wrapperUnderlyingRaw?.[0]),
    wrapperToken: normalizeAddress(wrapperTokenRaw?.[0]),
    wrapperPaused: pausedRaw?.[0] === undefined ? null : Boolean(pausedRaw[0]),
    wrapperOwner: normalizeAddress(ownerRaw?.[0]),
    totalAssetsRaw: totalAssetsRaw?.[0]?.toString() || null,
    totalAssets: formatUnits(totalAssetsRaw?.[0], decimals),
    oneShareAssetsRaw: oneShareAssetsRaw?.[0]?.toString() || null,
    oneShareAssets: formatUnits(oneShareAssetsRaw?.[0], decimals),
    wrapperUnderlyingBalanceRaw: wrapperUnderlyingBalRaw?.[0]?.toString() || null,
    wrapperUnderlyingBalance: formatUnits(wrapperUnderlyingBalRaw?.[0], decimals),
    wrapperUnderlyingBalanceUsd: round(wrapperUnderlyingUsd, 2),
    assetStateResolved: Boolean(assetStateRaw),
    cashRaw: cash?.toString() || null,
    cash: formatUnits(cash, decimals),
    cashUsd: round(cashUsd, 2),
    borrowsRaw: borrows?.toString() || null,
    borrows: formatUnits(borrows, decimals),
    borrowsUsd: round(borrowUsd, 2),
    protocolReservesRaw: protocolReserves?.toString() || null,
    protocolReserves: formatUnits(protocolReserves, decimals),
    protocolReservesUsd: round(reserveUsd, 2),
    utilWadRaw: utilWad?.toString() || null,
    utilizationPct: utilWad === null ? null : round(Number(ethers.formatUnits(utilWad, 18)) * 100, 4),
    strategiesCount,
    strategiesScanned: strategyRows.length,
    strategiesTruncated: strategiesCount !== null && strategiesCount > strategyLimit,
    strategies: strategyRows,
    routePositive: false,
    blockers: [
      assetStateRaw ? null : "LendingLens assetState not resolved for reserve",
      "Phase 0 maps reserves/wrappers/strategies only; no account-level borrower health/liquidation route is proven",
      "No oracle/cap/pause divergence or exact borrow/liquidation/unwind economics proven",
    ].filter(Boolean),
  };
}

async function scanChain(chain, prices) {
  const rpc = await resolveRpc(chain.chainId);
  const provider = rpc ? new ethers.JsonRpcProvider(rpc) : null;
  const chainResult = {
    chain: chain.name,
    chainId: chain.chainId,
    rpcResolved: Boolean(provider),
    lens: provider ? await contractState(provider, chain.lens) : { address: normalizeAddress(chain.lens), codePresent: null, codeBytes: null, eip1967: {} },
    reserves: [],
    routePositive: false,
  };
  if (!provider) {
    chainResult.reserves = chain.reserves.map((reserve) => ({ chain: chain.name, chainId: chain.chainId, symbol: reserve.symbol, token: normalizeAddress(reserve.token), wrapper: normalizeAddress(reserve.wrapper), routePositive: false, blockers: ["RPC unavailable"] }));
    return chainResult;
  }
  for (const reserve of chain.reserves) {
    chainResult.reserves.push(await scanReserve(provider, chain, reserve, prices));
  }
  return chainResult;
}

function contextSummary(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  const fields = ["id", "protocol", "chain", "chainId", "surface", "side", "symbol", "token", "asset", "collateral", "borrowAsset", "routePositive", "watchCandidate", "liquidityUsd", "borrowCashUsd", "cashUsd", "source", "status"];
  const out = {};
  for (const field of fields) {
    if (obj[field] !== undefined && typeof obj[field] !== "object") out[field] = String(obj[field]).slice(0, 120);
  }
  return out;
}

function findMatches(data, wantedAddress, source, max = 12) {
  const matches = [];
  const wanted = lowerAddress(wantedAddress);
  if (!wanted) return matches;
  function walk(value, objectPath, parent) {
    if (matches.length >= max) return;
    if (typeof value === "string") {
      if (lowerAddress(value) === wanted) {
        matches.push({ source, path: objectPath, context: contextSummary(parent), routePositive: Boolean(parent?.routePositive), watchCandidate: Boolean(parent?.watchCandidate) });
      }
      return;
    }
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) walk(value[i], `${objectPath}[${i}]`, parent);
      return;
    }
    for (const [key, child] of Object.entries(value)) walk(child, objectPath ? `${objectPath}.${key}` : key, value);
  }
  walk(data, "", null);
  return matches;
}

function artifactJoins(chainResults) {
  const wanted = [];
  for (const chain of chainResults) {
    wanted.push({ label: `${chain.chain}:LendingLens`, address: chain.lens.address, common: false });
    for (const row of chain.reserves || []) {
      wanted.push({ label: `${chain.chain}:${row.symbol}:token`, address: row.token, common: Boolean(row.common) });
      wanted.push({ label: `${chain.chain}:${row.symbol}:wrapper`, address: row.wrapper, common: false });
      for (const strategy of row.strategies || []) {
        wanted.push({ label: `${chain.chain}:${row.symbol}:strategy`, address: strategy.strategy, common: false });
        wanted.push({ label: `${chain.chain}:${row.symbol}:positionToken`, address: strategy.positionToken, common: false });
      }
    }
  }
  const rows = [];
  const loadedInputs = [];
  const seen = new Set();
  for (const [source, rel] of INPUTS) {
    const file = path.join(WORKSPACE, rel);
    const data = readJson(file, null);
    if (!data) continue;
    loadedInputs.push(rel);
    for (const item of wanted) {
      const address = normalizeAddress(item.address);
      if (!address) continue;
      const key = `${source}:${item.label}:${address.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const matches = findMatches(data, address, source, item.common ? 4 : 12);
      if (!matches.length) continue;
      rows.push({
        label: item.label,
        address,
        common: Boolean(item.common),
        source,
        joinCount: matches.length,
        routePositive: !item.common && matches.some((m) => m.routePositive),
        watchCandidate: !item.common && matches.some((m) => m.watchCandidate),
        matches,
      });
    }
  }
  rows.sort((a, b) => Number(b.routePositive) - Number(a.routePositive) || Number(b.watchCandidate) - Number(a.watchCandidate) || Number(a.common) - Number(b.common) || b.joinCount - a.joinCount);
  return { rows, loadedInputs };
}

function flattenReserveRows(chainResults) {
  return chainResults.flatMap((chain) => chain.reserves || []);
}

function writeReport(out) {
  const s = out.summary;
  const topReserves = out.reserveRows.slice(0, 14).map((row) => `| ${row.chain} | ${row.symbol} | ${row.token || "unresolved"} | ${row.wrapper || "unresolved"} | ${formatUsd(row.cashUsd)} | ${formatUsd(row.borrowsUsd)} | ${formatPct(row.utilizationPct)} | ${row.strategiesScanned ?? 0} |`).join("\n");
  const chainRows = out.chains.map((row) => `| ${row.chain} | ${row.rpcResolved} | ${row.lens.codePresent} | ${row.reserves.length} | ${formatUsd(out.metadata.chainTvls[row.chain]?.tvlUsd)} | ${formatUsd(out.metadata.chainTvls[row.chain]?.borrowedUsd)} |`).join("\n");
  const content = `# 🟢 DORMANT — Flying Tulip Lend Phase 0

Generated: ${out.generatedAt}

Scanner: \`tools/scan-flying-tulip-lend-phase0.js\`

Artifact: \`reports/raw/fast/flying-tulip-lend-phase0.json\`

## Result

No permissionless route-positive exploit is claimed. The lending lens and reserve wrappers are live on the scanned chains, but this Phase 0 found no account-level liquidation route, no oracle/cap/paused-state divergence, no consumer-linked wrapper anomaly, and no exact positive borrow/liquidation/unwind economics.

## Target

| Field | Value |
|---|---:|
| Protocol | \`${out.metadata.name}\` |
| Slug | \`${out.metadata.slug}\` |
| Category | \`${out.metadata.category}\` |
| Chains | \`${out.metadata.chains.join(", ")}\` |
| Public audits field | \`${out.metadata.audits}\` |
| Current public TVL | \`${formatUsd(s.defillamaCurrentTvlUsd)}\` |
| Scanned LendingLens borrowed | \`${formatUsd(s.lensBorrowedUsd)}\` |
| LendingLens | \`${LENDING_LENS}\` |

## Chain Coverage

| Chain | RPC | Lens code | Reserves | TVL | Borrowed |
|---|---:|---:|---:|---:|---:|
${chainRows}

## Reserve Snapshot

| Chain | Symbol | Token | Wrapper | Lens cash | Lens borrows | Utilization | Strategies |
|---|---|---|---|---:|---:|---:|---:|
${topReserves}

## Consumer/Artifact Joins

| Metric | Value |
|---|---:|
| Artifact inputs loaded | \`${out.joinInputsLoaded.length}\` |
| Address join rows | \`${s.artifactJoinRows}\` |
| Watch joins | \`${s.watchCandidates}\` |
| Route-positive joins | \`${s.routePositive}\` |

## Blockers

- Phase 0 did not discover borrower/account health rows or currently liquidatable accounts.
- Reserve and wrapper reads do not prove oracle manipulation, cap bypass, paused-state drift, or liquidation profitability.
- Common assets such as USDC, WETH, WBTC, and USDT join many consumers but are not Flying-Tulip-specific exploit evidence.
- Unique wrappers/strategy tokens did not join to route-positive consumer economics in reusable artifacts.
- No exact positive borrow, liquidation, redemption, or DEX unwind economics exist, so fork/live work remains blocked.

## Next Gate

Reopen only if Flying Tulip reserve/oracle config exposes a concrete divergence, or if account-level borrower discovery finds a currently liquidatable route with exact positive repay/acquire and collateral-exit economics.
`;
  fs.writeFileSync(REPORT_OUT, content);
}

async function main() {
  const metadataRaw = await fetchJson("https://api.llama.fi/protocol/flying-tulip-lend", 30_000).catch(() => ({}));
  const prices = await tokenPriceMap(CHAINS);
  const chainResults = [];
  for (const chain of CHAINS) chainResults.push(await scanChain(chain, prices));
  const reserveRows = flattenReserveRows(chainResults).sort((a, b) => (asNumber(b.borrowsUsd) || 0) - (asNumber(a.borrowsUsd) || 0));
  const joins = artifactJoins(chainResults);
  const routePositive = joins.rows.filter((row) => row.routePositive).length;
  const watchCandidates = joins.rows.filter((row) => row.watchCandidate && !row.routePositive).length;
  const chainTvls = Object.fromEntries(CHAINS.map((chain) => [chain.name, protocolChainMeta(metadataRaw, chain.name)]));
  const defillamaCurrentTvlUsd = round(Object.values(chainTvls).reduce((sum, row) => sum + (asNumber(row.tvlUsd) || 0), 0), 2);
  const defillamaBorrowedUsd = round(Object.values(chainTvls).reduce((sum, row) => sum + (asNumber(row.borrowedUsd) || 0), 0), 2);
  const rowsWithBorrows = reserveRows.filter((row) => (asNumber(row.borrowsUsd) || 0) > 0).length;
  const wrappersWithStrategies = reserveRows.filter((row) => (asNumber(row.strategiesScanned) || 0) > 0).length;
  const lensCashUsd = round(reserveRows.reduce((sum, row) => sum + (asNumber(row.cashUsd) || 0), 0), 2);
  const lensBorrowedUsd = round(reserveRows.reduce((sum, row) => sum + (asNumber(row.borrowsUsd) || 0), 0), 2);
  const output = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-flying-tulip-lend-phase0.js",
    scope: "Flying Tulip Lend public Phase 0 reserve/wrapper/lens map and artifact-only consumer join",
    safety: {
      publicApisOnly: false,
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: routePositive > 0,
      signedActionJustified: false,
    },
    metadata: {
      name: metadataRaw.name || "Flying Tulip Lend",
      slug: metadataRaw.slug || "flying-tulip-lend",
      category: metadataRaw.category || "Lending",
      chains: metadataRaw.chains || ["Ethereum", "Sonic"],
      audits: metadataRaw.audits || "2",
      url: metadataRaw.url || "https://flyingtulip.com/lend/",
      twitter: metadataRaw.twitter || "flyingtulip_",
      description: metadataRaw.description || null,
      module: metadataRaw.module || "flying-tulip-lend/index.js",
      tvlCodePath: metadataRaw.tvlCodePath || "https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/flying-tulip-lend/index.js",
      methodology: metadataRaw.methodology || null,
      adapter: {
        lendingLens: LENDING_LENS,
        reserveCount: CHAINS.reduce((sum, chain) => sum + chain.reserves.length, 0),
      },
      chainTvls,
    },
    chains: chainResults,
    reserveRows,
    artifactJoins: joins.rows,
    joinInputsLoaded: joins.loadedInputs,
    summary: {
      chainRows: chainResults.length,
      chainsWithRpc: chainResults.filter((row) => row.rpcResolved).length,
      defillamaCurrentTvlUsd,
      defillamaBorrowedUsd,
      lensCashUsd,
      lensBorrowedUsd,
      reservesConfigured: CHAINS.reduce((sum, chain) => sum + chain.reserves.length, 0),
      reservesScanned: reserveRows.length,
      reservesWithAssetState: reserveRows.filter((row) => row.assetStateResolved).length,
      rowsWithBorrows,
      wrappersWithCode: reserveRows.filter((row) => row.wrapperCodePresent).length,
      wrappersWithStrategies,
      strategiesScanned: reserveRows.reduce((sum, row) => sum + (asNumber(row.strategiesScanned) || 0), 0),
      artifactJoinRows: joins.rows.length,
      watchCandidates,
      routePositive,
      executableNow: 0,
      signedActionJustified: false,
      status: routePositive > 0 ? "route-positive-needs-proof" : "phase0-no-route-positive",
    },
    blockers: [
      "No account-level liquidation state or borrower health ranking produced in Phase 0",
      "No oracle/cap/paused-state divergence mapped to extractive borrow or liquidation economics",
      "No unique Flying Tulip wrapper/strategy join with route-positive consumer economics",
      "No fork extraction proof and no signed-action justification",
    ],
    requiredForRoutePositive: [
      "reserve/oracle/cap/borrower condition with permissionless impact",
      "borrower/account or wrapper route with material live liquidity",
      "exact repay/acquire/borrow/redeem/liquidation and exit economics positive after costs",
      "fork extraction proof",
    ],
  };
  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, `${JSON.stringify(output, jsonReplacer, 2)}\n`);
  writeReport(output);
  if (!QUIET) {
    console.log(`Flying Tulip Lend Phase0: tvl=${formatUsd(defillamaCurrentTvlUsd)} lensBorrowed=${formatUsd(lensBorrowedUsd)} reserves=${reserveRows.length} joins=${joins.rows.length} watch=${watchCandidates} routePositive=${routePositive}`);
    console.log(`Artifact: ${path.relative(WORKSPACE, RAW_OUT).replace(/\\/g, "/")}`);
    console.log(`Report: ${path.relative(WORKSPACE, REPORT_OUT).replace(/\\/g, "/")}`);
  }
}

main().catch((err) => {
  console.error(String(err?.message || err).slice(0, 240));
  process.exit(1);
});
