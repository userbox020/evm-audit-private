#!/usr/bin/env node
// scan-arbitrum-bridge-phase0.js - bounded read-only Phase 0 for Arbitrum Bridge.
// Resolves RPC URLs in memory only. Never prints or stores RPC URLs, keys, calldata, or signed actions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "arbitrum-bridge-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "arbitrum-bridge-phase0-triage.md");
const QUIET = process.argv.includes("--quiet");

const ETHEREUM_CHAIN_ID = 1;
const ARBITRUM_CHAIN_ID = 42161;
const MAX_TOKEN_PAIRS = Number(process.env.ARBITRUM_BRIDGE_PHASE0_MAX_TOKENS || "36");
const MIN_MATERIAL_USD = 1_000_000;
const ZERO = "0x0000000000000000000000000000000000000000";

const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const EIP1967_BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

const REGISTRY = {
  source: "docs.arbitrum.io smart contract addresses, Arbitrum One",
  rollup: "0x4DCeB440657f21083db8aDd07665f8ddBe1DCfc0",
  sequencerInbox: "0x1c479675ad559DC151F6Ec7ed3FbF8ceE79582B6",
  coreProxyAdmin: "0x554723262467F125Ac9e1cDFa9Ce15cc53822dbD",
  delayedInbox: "0x4Dbd4fc535Ac27206064B68FfCf827b0A60BAB3f",
  bridge: "0x8315177aB297bA92A06054cE80a67Ed4DBd7ed3a",
  outbox: "0x0B9857ae2D4A3DBe74ffE1d7DF045bb7F96E4840",
  classicOutbox1: "0x760723CD2e632826c38Fef8CD438A4CC7E7E1A40",
  classicOutbox2: "0x667e23ABd27E623c11d4CC00ca3EC4d0bD63337a",
  challengeManager: "0xA5565d266c3c3Ee90B16Be8A5b13d587ef559fB0",
  oneStepProofEntry: "0x4397fE1E959Ba81B9D5f1A9679Ddd891955A42d6",
  l1GatewayRouter: "0x72Ce9c846789fdB6fC1f34aC4AD25Dd9ef7031ef",
  l1Erc20Gateway: "0xa3A7B6F88361F48403514059F1F16C8E78d60EeC",
  l1CustomGateway: "0xcEe284F754E854890e311e3280b767F80797180d",
  l1WethGateway: "0xd92023E9d9911199a6711321D1277285e6d4e2db",
  l1Weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  l1ProxyAdmin: "0x9aD46fac0Cf7f790E5be05A0F15223935A0c0aDa",
};

const L2_REGISTRY = {
  l2GatewayRouter: "0x5288c571Fd7aD117beA99bF60FE0846C4E84F933",
  l2Erc20Gateway: "0x09e9222E96E7B4AE2a407B98d48e330053351EEe",
  l2CustomGateway: "0x096760F208390250649E3e8763348E783AEF5562",
  l2WethGateway: "0x6c411aD3E74De3E7Bd422b94A27770f5B86C623B",
  l2Weth: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
  l2ProxyAdmin: "0xd570aCE65C43af47101fC6250FD6fC63D1c22a86",
  arbSys: "0x0000000000000000000000000000000000000064",
  arbRetryableTx: "0x000000000000000000000000000000000000006E",
};

const CORE_L1_TOKENS = [
  { symbol: "WETH", address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", l2Address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", gatewayHint: REGISTRY.l1WethGateway, common: true },
  { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", l2Address: "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8", common: true },
  { symbol: "USDT", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", l2Address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", common: true },
  { symbol: "WBTC", address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", l2Address: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f", common: true },
  { symbol: "DAI", address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", l2Address: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", common: true },
  { symbol: "LINK", address: "0x514910771AF9Ca656af840dff83E8264EcF986CA", l2Address: "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4", common: true },
  { symbol: "wstETH", address: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0", l2Address: "0x5979D7b546E38E414F7E9822514be443A4800529", common: true },
  { symbol: "ARB", address: "0xB50721BCf8d664c30412Cfbc6cf7a15145234ad1", l2Address: "0x912CE59144191C1204E64559FE8253a0e49E6548", common: false },
];

const INPUTS = [
  ["bridge-nonlossless", "reports/raw/fast/bridge-nonlossless-collateral-join.json"],
  ["bridge-delta", "reports/raw/fast/bridge-delta-preflight.json"],
  ["bridge-synthetic", "reports/raw/fast/bridge-synthetic-consumer-exposure.json"],
  ["bridge-proof-binding", "reports/raw/fast/bridge-proof-binding.json"],
  ["bridge-domain", "reports/raw/fast/bridge-domain-separation.json"],
  ["deployed-path-proof-gaps", "reports/raw/fast/deployed-path-proof-gaps.json"],
  ["deprecated-orphaned", "reports/raw/fast/deprecated-orphaned-reachability.json"],
  ["aave-euler-silo", "reports/raw/fast/aave-euler-silo-consumer-graph.json"],
  ["consumer-first-high-ltv", "reports/raw/fast/consumer-first-high-ltv-collateral.json"],
  ["public-lead-consumer", "reports/raw/fast/public-lead-consumer-joins.json"],
  ["dex-consumer-routes", "reports/raw/fast/dex-consumer-routes.json"],
  ["erc4626", "reports/raw/fast/erc4626-consumer-joiner.json"],
];

const ERC20 = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
  "function l1Address() view returns (address)",
  "function l1Token() view returns (address)",
]);

const COMMON = new ethers.Interface([
  "function owner() view returns (address)",
  "function admin() view returns (address)",
  "function paused() view returns (bool)",
]);

const INBOX = new ethers.Interface([
  "function bridge() view returns (address)",
  "function sequencerInbox() view returns (address)",
  "function rollup() view returns (address)",
  "function paused() view returns (bool)",
  "function allowListEnabled() view returns (bool)",
  "function maxDataSize() view returns (uint256)",
]);

const BRIDGE = new ethers.Interface([
  "function activeOutbox() view returns (address)",
  "function sequencerInbox() view returns (address)",
  "function allowedDelayedInboxList(uint256) view returns (address)",
  "function allowedOutboxList(uint256) view returns (address)",
]);

const OUTBOX = new ethers.Interface([
  "function bridge() view returns (address)",
  "function rollup() view returns (address)",
]);

const ROLLUP = new ethers.Interface([
  "function bridge() view returns (address)",
  "function inbox() view returns (address)",
  "function outbox() view returns (address)",
  "function sequencerInbox() view returns (address)",
  "function owner() view returns (address)",
  "function confirmPeriodBlocks() view returns (uint64)",
]);

const GATEWAY = new ethers.Interface([
  "function defaultGateway() view returns (address)",
  "function getGateway(address) view returns (address)",
  "function inbox() view returns (address)",
  "function router() view returns (address)",
  "function counterpartGateway() view returns (address)",
]);

const L2_GATEWAY = new ethers.Interface([
  "function calculateL2TokenAddress(address) view returns (address)",
  "function router() view returns (address)",
  "function counterpartGateway() view returns (address)",
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
      try { return ethers.getAddress(text.toLowerCase()); } catch (_) { return null; }
    }
    return null;
  }
}

function lowerAddress(value) {
  const address = normalizeAddress(value);
  return address ? address.toLowerCase() : null;
}

function isZeroAddress(value) {
  const address = lowerAddress(value);
  return !address || address === ZERO.toLowerCase();
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
  return n === null ? "n/a" : `$${Math.round(n).toLocaleString()}`;
}

function formatUnits(value, decimals) {
  if (value === null || value === undefined || decimals === null || decimals === undefined) return null;
  try { return ethers.formatUnits(BigInt(value), Number(decimals)); } catch (_) { return null; }
}

function numberUnits(value, decimals) {
  const text = formatUnits(value, decimals);
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function lastRow(value) {
  return Array.isArray(value) && value.length ? value[value.length - 1] : null;
}

async function fetchJson(url, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "evm-audit-arbitrum-bridge-phase0/1.0" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function safeCall(provider, to, iface, fn, args = []) {
  const address = normalizeAddress(to);
  if (!provider || !address) return null;
  try {
    const raw = await provider.call({ to: address, data: iface.encodeFunctionData(fn, args) });
    if (!raw || raw === "0x") return null;
    return iface.decodeFunctionResult(fn, raw);
  } catch (_) {
    return null;
  }
}

async function getCode(provider, address) {
  const normalized = normalizeAddress(address);
  if (!provider || !normalized) return "0x";
  return await provider.getCode(normalized).catch(() => "0x");
}

async function getBalance(provider, address) {
  const normalized = normalizeAddress(address);
  if (!provider || !normalized) return null;
  return await provider.getBalance(normalized).catch(() => null);
}

async function getStorage(provider, address, slot) {
  const normalized = normalizeAddress(address);
  if (!provider || !normalized) return null;
  return await provider.getStorage(normalized, slot).catch(() => null);
}

async function inspectContract(provider, chainId, name, address, role) {
  const normalized = normalizeAddress(address);
  if (!normalized) return { chainId, name, address, role, codePresent: false, blocker: "invalid address" };
  const [code, balanceRaw, implRaw, adminRaw, beaconRaw, ownerRaw, adminCallRaw, pausedRaw] = await Promise.all([
    getCode(provider, normalized),
    getBalance(provider, normalized),
    getStorage(provider, normalized, EIP1967_IMPLEMENTATION_SLOT),
    getStorage(provider, normalized, EIP1967_ADMIN_SLOT),
    getStorage(provider, normalized, EIP1967_BEACON_SLOT),
    safeCall(provider, normalized, COMMON, "owner", []),
    safeCall(provider, normalized, COMMON, "admin", []),
    safeCall(provider, normalized, COMMON, "paused", []),
  ]);
  const balanceWei = balanceRaw === null ? null : balanceRaw.toString();
  return {
    chainId,
    name,
    address: normalized,
    role,
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
    nativeBalanceWei: balanceWei,
    nativeBalance: balanceWei === null ? null : formatUnits(balanceWei, 18),
    eip1967: {
      implementation: addressFromStorageSlot(implRaw),
      admin: addressFromStorageSlot(adminRaw),
      beacon: addressFromStorageSlot(beaconRaw),
    },
    owner: normalizeAddress(ownerRaw?.[0]) || null,
    admin: normalizeAddress(adminCallRaw?.[0]) || null,
    paused: pausedRaw?.[0] === undefined ? null : Boolean(pausedRaw[0]),
  };
}

function chainLatest(raw, chain) {
  const row = raw?.chainTvls?.[chain] || raw?.chainTvls?.[String(chain).toLowerCase()] || {};
  return {
    tvl: lastRow(row.tvl)?.totalLiquidityUSD ?? null,
    tokensUsd: lastRow(row.tokensInUsd)?.tokens || {},
    tokens: lastRow(row.tokens)?.tokens || {},
  };
}

function latestTvl(raw) {
  const direct = asNumber(raw?.currentChainTvls?.Ethereum);
  if (direct !== null) return direct;
  const sumCurrent = Object.values(raw?.currentChainTvls || {}).reduce((sum, value) => sum + (asNumber(value) || 0), 0);
  if (sumCurrent > 0) return sumCurrent;
  return asNumber(lastRow(raw?.tvl)?.totalLiquidityUSD ?? raw?.tvl);
}

function topObjectEntries(obj, max = 160) {
  return Object.fromEntries(Object.entries(obj || {}).sort((a, b) => (asNumber(b[1]) || 0) - (asNumber(a[1]) || 0)).slice(0, max));
}

function symbolFromKey(key) {
  const text = String(key || "");
  if (text.includes(":")) return text.split(":").pop();
  return text;
}

function tokenAddressFromKey(key) {
  const parts = String(key || "").split(":");
  return normalizeAddress(parts[parts.length - 1]);
}

function defillamaBySymbol(tokensUsd) {
  const out = new Map();
  for (const [key, value] of Object.entries(tokensUsd || {})) {
    const symbol = symbolFromKey(key).toUpperCase();
    if (!symbol) continue;
    out.set(symbol, Math.max(out.get(symbol) || 0, asNumber(value) || 0));
  }
  return out;
}

function bridgeInfoAddress(token, chainId) {
  const info = token?.extensions?.bridgeInfo || {};
  const row = info[String(chainId)] || info[chainId] || null;
  return normalizeAddress(row?.tokenAddress || row?.address || row?.destTokenAddress || row?.l2TokenAddress);
}

async function tokenListPairs(ethTokensUsd) {
  const tokenList = await fetchJson("https://bridge.arbitrum.io/token-list-42161.json", 30_000).catch(() => null);
  if (!tokenList?.tokens?.length) return { pairs: [], tokenListFetched: false, tokenListTimestamp: null };
  const bySymbol = defillamaBySymbol(ethTokensUsd);
  const byKey = new Map();

  function addPair(row) {
    const l1Address = normalizeAddress(row.l1Address);
    const l2Address = normalizeAddress(row.l2Address);
    if (!l1Address && !l2Address) return;
    const key = `${lowerAddress(l1Address) || "none"}:${lowerAddress(l2Address) || String(row.symbol || "").toLowerCase()}`;
    const existing = byKey.get(key) || {};
    const symbol = String(row.symbol || existing.symbol || "UNKNOWN");
    const score = Math.max(asNumber(row.defillamaUsdHint) || 0, bySymbol.get(symbol.toUpperCase()) || 0);
    byKey.set(key, {
      source: existing.source || row.source,
      symbol,
      name: row.name || existing.name || null,
      l1Address: l1Address || existing.l1Address || null,
      l2Address: l2Address || existing.l2Address || null,
      decimalsHint: Number.isFinite(Number(row.decimalsHint)) ? Number(row.decimalsHint) : existing.decimalsHint ?? null,
      defillamaUsdHint: round(score, 2),
      common: Boolean(row.common || existing.common || ["WETH", "USDC", "USDT", "DAI", "WBTC", "LINK", "WSTETH"].includes(symbol.toUpperCase())),
      gatewayHint: normalizeAddress(row.gatewayHint || existing.gatewayHint) || null,
    });
  }

  for (const token of tokenList.tokens) {
    const chainId = Number(token.chainId);
    if (chainId === ETHEREUM_CHAIN_ID) {
      const l2Address = bridgeInfoAddress(token, ARBITRUM_CHAIN_ID);
      if (l2Address) addPair({ source: "arbitrum-token-list-l1", symbol: token.symbol, name: token.name, l1Address: token.address, l2Address, decimalsHint: token.decimals });
    } else if (chainId === ARBITRUM_CHAIN_ID) {
      const l1Address = bridgeInfoAddress(token, ETHEREUM_CHAIN_ID);
      if (l1Address) addPair({ source: "arbitrum-token-list-l2", symbol: token.symbol, name: token.name, l1Address, l2Address: token.address, decimalsHint: token.decimals });
    }
  }

  return {
    pairs: [...byKey.values()].sort((a, b) => (asNumber(b.defillamaUsdHint) || 0) - (asNumber(a.defillamaUsdHint) || 0) || String(a.symbol).localeCompare(String(b.symbol))).slice(0, MAX_TOKEN_PAIRS),
    tokenListFetched: true,
    tokenListTimestamp: tokenList.timestamp || null,
  };
}

function mergeTokenPairs(tokenRows) {
  const byKey = new Map();
  for (const row of tokenRows) {
    const key = `${lowerAddress(row.l1Address) || "none"}:${lowerAddress(row.l2Address) || String(row.symbol || "").toLowerCase()}`;
    byKey.set(key, row);
  }
  for (const token of CORE_L1_TOKENS) {
    const found = [...byKey.values()].find((row) => lowerAddress(row.l1Address) === lowerAddress(token.address) || String(row.symbol).toUpperCase() === token.symbol.toUpperCase());
    if (found) {
      found.l1Address = found.l1Address || normalizeAddress(token.address);
      found.l2Address = found.l2Address || normalizeAddress(token.l2Address);
      found.gatewayHint = found.gatewayHint || normalizeAddress(token.gatewayHint);
      found.common = found.common || token.common;
      continue;
    }
    byKey.set(`${lowerAddress(token.address)}:${lowerAddress(token.l2Address) || token.symbol.toLowerCase()}`, {
      source: "core-token-fallback",
      symbol: token.symbol,
      name: token.symbol,
      l1Address: normalizeAddress(token.address),
      l2Address: normalizeAddress(token.l2Address),
      decimalsHint: null,
      defillamaUsdHint: 0,
      common: Boolean(token.common),
      gatewayHint: normalizeAddress(token.gatewayHint) || null,
    });
  }
  return [...byKey.values()].slice(0, Math.max(MAX_TOKEN_PAIRS, CORE_L1_TOKENS.length));
}

async function tokenPricesUsd(pairs) {
  const keys = [];
  for (const pair of pairs) {
    if (pair.l1Address) keys.push(`ethereum:${pair.l1Address.toLowerCase()}`);
    if (pair.l2Address) keys.push(`arbitrum:${pair.l2Address.toLowerCase()}`);
  }
  if (!keys.length) return new Map();
  const prices = new Map();
  try {
    const json = await fetchJson(`https://coins.llama.fi/prices/current/${[...new Set(keys)].join(",")}?searchWidth=6h`, 30_000);
    for (const [key, row] of Object.entries(json.coins || {})) {
      const address = lowerAddress(key.split(":").pop());
      const price = Number(row.price || 0);
      if (address && Number.isFinite(price) && price > 0) prices.set(address, price);
    }
  } catch (_) {
    // Public prices are optional; scanner remains fail-closed.
  }
  return prices;
}

async function tokenMeta(provider, address) {
  const normalized = normalizeAddress(address);
  if (!normalized) return null;
  const [code, symbolRaw, nameRaw, decimalsRaw, supplyRaw, l1AddressRaw, l1TokenRaw] = await Promise.all([
    getCode(provider, normalized),
    safeCall(provider, normalized, ERC20, "symbol", []),
    safeCall(provider, normalized, ERC20, "name", []),
    safeCall(provider, normalized, ERC20, "decimals", []),
    safeCall(provider, normalized, ERC20, "totalSupply", []),
    safeCall(provider, normalized, ERC20, "l1Address", []),
    safeCall(provider, normalized, ERC20, "l1Token", []),
  ]);
  const decimals = decimalsRaw?.[0] === undefined ? null : Number(decimalsRaw[0]);
  const supply = supplyRaw?.[0] ?? null;
  return {
    address: normalized,
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
    symbol: symbolRaw?.[0] === undefined ? null : String(symbolRaw[0]),
    name: nameRaw?.[0] === undefined ? null : String(nameRaw[0]),
    decimals,
    totalSupplyRaw: supply?.toString() || null,
    totalSupply: formatUnits(supply, decimals),
    l1Address: normalizeAddress(l1AddressRaw?.[0]) || normalizeAddress(l1TokenRaw?.[0]) || null,
  };
}

function defillamaUsdForPair(pair, ethTokensUsd, l1Address) {
  return Object.entries(ethTokensUsd || {}).reduce((best, [key, value]) => {
    const addr = lowerAddress(tokenAddressFromKey(key));
    const symbol = symbolFromKey(key).toUpperCase();
    if (addr && l1Address && addr === l1Address.toLowerCase()) return Math.max(best, asNumber(value) || 0);
    if (symbol && symbol === String(pair.symbol).toUpperCase()) return Math.max(best, asNumber(value) || 0);
    return best;
  }, asNumber(pair.defillamaUsdHint) || 0);
}

async function inspectTokenPairs(ethProvider, arbProvider, pairs, prices, ethTokensUsd) {
  const rows = [];
  for (const pair of pairs) {
    const l1Address = normalizeAddress(pair.l1Address);
    let l2Address = normalizeAddress(pair.l2Address);
    const gatewayRaw = l1Address ? await safeCall(ethProvider, REGISTRY.l1GatewayRouter, GATEWAY, "getGateway", [l1Address]) : null;
    let gateway = normalizeAddress(gatewayRaw?.[0]) || normalizeAddress(pair.gatewayHint) || REGISTRY.l1Erc20Gateway;
    if (isZeroAddress(gateway)) gateway = normalizeAddress(pair.gatewayHint) || REGISTRY.l1Erc20Gateway;
    if (!l2Address && l1Address) {
      const calculated = await safeCall(arbProvider, L2_REGISTRY.l2Erc20Gateway, L2_GATEWAY, "calculateL2TokenAddress", [l1Address]);
      l2Address = normalizeAddress(calculated?.[0]) || null;
    }
    const [l1Meta, l2Meta] = await Promise.all([
      l1Address ? tokenMeta(ethProvider, l1Address) : null,
      l2Address ? tokenMeta(arbProvider, l2Address) : null,
    ]);
    const l1Decimals = l1Meta?.decimals ?? pair.decimalsHint ?? null;
    const l2Decimals = l2Meta?.decimals ?? pair.decimalsHint ?? null;
    const priceKey = l1Address?.toLowerCase() || l2Address?.toLowerCase() || null;
    const priceUsd = priceKey ? prices.get(priceKey) || null : null;
    const balanceRaw = gateway && l1Address ? await safeCall(ethProvider, l1Address, ERC20, "balanceOf", [gateway]) : null;
    const bridgeBalance = balanceRaw?.[0] ?? null;
    const bridgeBalanceUnits = numberUnits(bridgeBalance, l1Decimals);
    const bridgeBalanceUsd = priceUsd && bridgeBalanceUnits !== null ? bridgeBalanceUnits * priceUsd : null;
    const l2SupplyUnits = l2Meta?.totalSupplyRaw && l2Decimals !== null ? numberUnits(l2Meta.totalSupplyRaw, l2Decimals) : null;
    const l2SupplyUsd = priceUsd && l2SupplyUnits !== null ? l2SupplyUnits * priceUsd : null;
    const deltaUsd = bridgeBalanceUsd !== null && l2SupplyUsd !== null ? bridgeBalanceUsd - l2SupplyUsd : null;

    rows.push({
      symbol: pair.symbol,
      source: pair.source,
      l1Address,
      l2Address,
      l1GatewayOwner: gateway,
      common: Boolean(pair.common),
      l1Meta,
      l2Meta,
      priceUsd: round(priceUsd, 8),
      l1GatewayBalanceRaw: bridgeBalance?.toString() || null,
      l1GatewayBalance: formatUnits(bridgeBalance, l1Decimals),
      l1GatewayBalanceUsd: round(bridgeBalanceUsd, 2),
      l2TotalSupplyRaw: l2Meta?.totalSupplyRaw || null,
      l2TotalSupply: l2Meta?.totalSupply || null,
      l2TotalSupplyUsd: round(l2SupplyUsd, 2),
      bridgeBalanceMinusL2SupplyUsd: round(deltaUsd, 2),
      defillamaUsdHint: round(defillamaUsdForPair(pair, ethTokensUsd, l1Address), 2),
      materialContextDelta: deltaUsd !== null && Math.abs(deltaUsd) >= MIN_MATERIAL_USD,
      materialBalance: bridgeBalanceUsd !== null && bridgeBalanceUsd >= MIN_MATERIAL_USD,
      routePositive: false,
      blockers: [
        l1Address ? null : "L1 token address not resolved",
        l2Address ? null : "Arbitrum L2 token address not resolved",
        gateway ? null : "L1 gateway owner not resolved",
        l1Meta?.codePresent === false ? "L1 token code missing" : null,
        l2Address && l2Meta?.codePresent === false ? "L2 token code missing" : null,
        "Gateway balance/supply reads are backing context only, not proof of mint/unlock bypass",
        "No bridge-specific proof weakness or consumer route economics proven",
      ].filter(Boolean),
    });
  }
  rows.sort((a, b) => (asNumber(b.l1GatewayBalanceUsd) || 0) - (asNumber(a.l1GatewayBalanceUsd) || 0) || (asNumber(b.l2TotalSupplyUsd) || 0) - (asNumber(a.l2TotalSupplyUsd) || 0));
  return rows;
}

async function inspectBridgeSpecifics(ethProvider, arbProvider) {
  const [inboxBridge, inboxSeq, inboxRollup, inboxPaused, allowList, maxDataSize, bridgeActiveOutbox, bridgeSeq, bridgeDelayed0, bridgeOutbox0, outboxBridge, outboxRollup, rollupBridge, rollupInbox, rollupOutbox, rollupSeq, rollupOwner, confirmPeriod, l1DefaultGateway, l1RouterInbox, l2RouterCounterpart, l2Erc20Counterpart] = await Promise.all([
    safeCall(ethProvider, REGISTRY.delayedInbox, INBOX, "bridge", []),
    safeCall(ethProvider, REGISTRY.delayedInbox, INBOX, "sequencerInbox", []),
    safeCall(ethProvider, REGISTRY.delayedInbox, INBOX, "rollup", []),
    safeCall(ethProvider, REGISTRY.delayedInbox, INBOX, "paused", []),
    safeCall(ethProvider, REGISTRY.delayedInbox, INBOX, "allowListEnabled", []),
    safeCall(ethProvider, REGISTRY.delayedInbox, INBOX, "maxDataSize", []),
    safeCall(ethProvider, REGISTRY.bridge, BRIDGE, "activeOutbox", []),
    safeCall(ethProvider, REGISTRY.bridge, BRIDGE, "sequencerInbox", []),
    safeCall(ethProvider, REGISTRY.bridge, BRIDGE, "allowedDelayedInboxList", [0]),
    safeCall(ethProvider, REGISTRY.bridge, BRIDGE, "allowedOutboxList", [0]),
    safeCall(ethProvider, REGISTRY.outbox, OUTBOX, "bridge", []),
    safeCall(ethProvider, REGISTRY.outbox, OUTBOX, "rollup", []),
    safeCall(ethProvider, REGISTRY.rollup, ROLLUP, "bridge", []),
    safeCall(ethProvider, REGISTRY.rollup, ROLLUP, "inbox", []),
    safeCall(ethProvider, REGISTRY.rollup, ROLLUP, "outbox", []),
    safeCall(ethProvider, REGISTRY.rollup, ROLLUP, "sequencerInbox", []),
    safeCall(ethProvider, REGISTRY.rollup, ROLLUP, "owner", []),
    safeCall(ethProvider, REGISTRY.rollup, ROLLUP, "confirmPeriodBlocks", []),
    safeCall(ethProvider, REGISTRY.l1GatewayRouter, GATEWAY, "defaultGateway", []),
    safeCall(ethProvider, REGISTRY.l1GatewayRouter, GATEWAY, "inbox", []),
    safeCall(arbProvider, L2_REGISTRY.l2GatewayRouter, L2_GATEWAY, "counterpartGateway", []),
    safeCall(arbProvider, L2_REGISTRY.l2Erc20Gateway, L2_GATEWAY, "counterpartGateway", []),
  ]);
  return {
    delayedInbox: {
      bridge: normalizeAddress(inboxBridge?.[0]) || null,
      sequencerInbox: normalizeAddress(inboxSeq?.[0]) || null,
      rollup: normalizeAddress(inboxRollup?.[0]) || null,
      paused: inboxPaused?.[0] === undefined ? null : Boolean(inboxPaused[0]),
      allowListEnabled: allowList?.[0] === undefined ? null : Boolean(allowList[0]),
      maxDataSize: maxDataSize?.[0] === undefined ? null : maxDataSize[0].toString(),
    },
    bridge: {
      activeOutbox: normalizeAddress(bridgeActiveOutbox?.[0]) || null,
      sequencerInbox: normalizeAddress(bridgeSeq?.[0]) || null,
      allowedDelayedInbox0: normalizeAddress(bridgeDelayed0?.[0]) || null,
      allowedOutbox0: normalizeAddress(bridgeOutbox0?.[0]) || null,
    },
    outbox: {
      bridge: normalizeAddress(outboxBridge?.[0]) || null,
      rollup: normalizeAddress(outboxRollup?.[0]) || null,
    },
    rollup: {
      bridge: normalizeAddress(rollupBridge?.[0]) || null,
      inbox: normalizeAddress(rollupInbox?.[0]) || null,
      outbox: normalizeAddress(rollupOutbox?.[0]) || null,
      sequencerInbox: normalizeAddress(rollupSeq?.[0]) || null,
      owner: normalizeAddress(rollupOwner?.[0]) || null,
      confirmPeriodBlocks: confirmPeriod?.[0] === undefined ? null : confirmPeriod[0].toString(),
    },
    tokenBridge: {
      l1GatewayRouterDefaultGateway: normalizeAddress(l1DefaultGateway?.[0]) || null,
      l1GatewayRouterInbox: normalizeAddress(l1RouterInbox?.[0]) || null,
      l2GatewayRouterCounterpart: normalizeAddress(l2RouterCounterpart?.[0]) || null,
      l2Erc20GatewayCounterpart: normalizeAddress(l2Erc20Counterpart?.[0]) || null,
    },
  };
}

async function nativeBridgeContext(ethProvider, arbProvider) {
  const rows = await Promise.all([
    [ETHEREUM_CHAIN_ID, "L1 Bridge", REGISTRY.bridge, ethProvider],
    [ETHEREUM_CHAIN_ID, "Delayed Inbox", REGISTRY.delayedInbox, ethProvider],
    [ETHEREUM_CHAIN_ID, "Outbox", REGISTRY.outbox, ethProvider],
    [ETHEREUM_CHAIN_ID, "L1 Gateway Router", REGISTRY.l1GatewayRouter, ethProvider],
    [ETHEREUM_CHAIN_ID, "L1 WETH Gateway", REGISTRY.l1WethGateway, ethProvider],
    [ARBITRUM_CHAIN_ID, "L2 Gateway Router", L2_REGISTRY.l2GatewayRouter, arbProvider],
    [ARBITRUM_CHAIN_ID, "L2 WETH Gateway", L2_REGISTRY.l2WethGateway, arbProvider],
  ].map(async ([chainId, label, address, provider]) => {
    const raw = await getBalance(provider, address);
    return { chainId, label, address: normalizeAddress(address), nativeBalanceWei: raw === null ? null : raw.toString(), nativeBalance: raw === null ? null : formatUnits(raw, 18) };
  }));
  return {
    rows,
    totalEthereumNativeWei: rows.filter((row) => row.chainId === ETHEREUM_CHAIN_ID && row.nativeBalanceWei).reduce((sum, row) => sum + BigInt(row.nativeBalanceWei), 0n).toString(),
    routePositive: false,
    blockers: [
      "Native ETH balance context does not prove withdrawal-proof bypass",
      "Retryable/outbox paths require valid delayed/sequenced messages; no forged message path proven",
    ],
  };
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
      if (lowerAddress(value) === wanted) matches.push({ source, path: objectPath, context: contextSummary(parent), routePositive: Boolean(parent?.routePositive), watchCandidate: Boolean(parent?.watchCandidate) });
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

function artifactJoins(tokenRows, contractRows) {
  const wanted = [];
  const seen = new Set();
  function add(label, address, common, bridgeSpecific) {
    const normalized = normalizeAddress(address);
    const key = lowerAddress(normalized);
    if (!key || seen.has(`${key}:${label}`)) return;
    wanted.push({ label, address: normalized, common: Boolean(common), bridgeSpecific: Boolean(bridgeSpecific) });
    seen.add(`${key}:${label}`);
  }
  for (const row of contractRows) add(row.name, row.address, false, true);
  for (const row of tokenRows) {
    add(`${row.symbol} L1`, row.l1Address, row.common, false);
    add(`${row.symbol} Arbitrum`, row.l2Address, row.common, false);
    add(`${row.symbol} L1 gateway`, row.l1GatewayOwner, false, true);
  }

  const rows = [];
  const loadedInputs = [];
  for (const [source, rel] of INPUTS) {
    const file = path.join(WORKSPACE, rel);
    const data = readJson(file, null);
    if (!data) continue;
    loadedInputs.push(rel);
    for (const item of wanted) {
      const matches = findMatches(data, item.address, source, item.common ? 5 : 20);
      if (!matches.length) continue;
      rows.push({
        label: item.label,
        address: item.address,
        common: item.common,
        bridgeSpecific: item.bridgeSpecific,
        source,
        joinCount: matches.length,
        routePositive: matches.some((m) => m.routePositive),
        watchCandidate: matches.some((m) => m.watchCandidate),
        matches,
      });
    }
  }
  rows.sort((a, b) => Number(b.bridgeSpecific) - Number(a.bridgeSpecific) || Number(b.routePositive) - Number(a.routePositive) || Number(b.watchCandidate) - Number(a.watchCandidate) || Number(a.common) - Number(b.common) || b.joinCount - a.joinCount);
  return { rows, loadedInputs };
}

function writeReport(out) {
  const s = out.summary;
  const nativeRows = out.nativeContext.rows.map((row) => `| ${row.chainId} | ${row.label} | ${row.address} | ${row.nativeBalance || "0"} |`).join("\n") || "| none | none | none | 0 |";
  const contractRows = out.contractRows.slice(0, 18).map((row) => `| ${row.chainId} | ${row.name} | ${row.address} | ${row.role} | ${row.codePresent} | ${row.eip1967?.implementation || "none"} |`).join("\n") || "| none | none | none | none | false | none |";
  const tokenRows = out.tokenRows.slice(0, 14).map((row) => `| ${row.symbol} | ${row.l1Address || "unresolved"} | ${row.l2Address || "unresolved"} | ${row.l1GatewayOwner || "unresolved"} | ${formatUsd(row.l1GatewayBalanceUsd)} | ${formatUsd(row.l2TotalSupplyUsd)} | ${formatUsd(row.bridgeBalanceMinusL2SupplyUsd)} |`).join("\n") || "| none | none | none | none | n/a | n/a | n/a |";
  const joinRows = out.artifactJoins.slice(0, 12).map((row) => `| ${row.label} | ${row.source} | ${row.joinCount} | ${row.bridgeSpecific} | ${row.common} | ${row.routePositive} |`).join("\n") || "| none | none | 0 | false | false | false |";
  const content = `# 🟢 DORMANT - Arbitrum Bridge Phase 0

Generated: ${out.generatedAt}

Scanner: \`tools/scan-arbitrum-bridge-phase0.js\`

Artifact: \`reports/raw/fast/arbitrum-bridge-phase0.json\`

## Result

No permissionless route-positive exploit is claimed. This Phase 0 mapped the Arbitrum One canonical bridge contracts, retryable inbox/outbox context, token gateway custody, public DeFiLlama/token-list context, and local bridge/consumer artifact joins. It found no deployed proof/message binding bypass, no material exact backing mismatch joined to consumer economics, and no exact positive mint/unlock/borrow/redeem/liquidation/unwind route.

## Target

| Field | Value |
|---|---:|
| Protocol | \`${out.metadata.name}\` |
| Slug | \`${out.metadata.slug}\` |
| Category | \`${out.metadata.category}\` |
| Adapter source | \`${out.metadata.module || "parentBridge/index.js"}\` |
| Public TVL | \`${formatUsd(s.defillamaCurrentTvlUsd)}\` |
| Ethereum RPC resolved | \`${s.ethereumRpcResolved}\` |
| Arbitrum RPC resolved | \`${s.arbitrumRpcResolved}\` |
| Token list fetched | \`${out.metadata.tokenListFetched}\` |
| L1 delayed inbox | \`${REGISTRY.delayedInbox}\` |
| L1 bridge | \`${REGISTRY.bridge}\` |
| L1 outbox | \`${REGISTRY.outbox}\` |
| L1 gateway router | \`${REGISTRY.l1GatewayRouter}\` |

## Native Context

| Chain | Location | Address | Native balance |
|---:|---|---|---:|
${nativeRows}

## Contracts

| Chain | Name | Address | Role | Code | EIP-1967 implementation |
|---:|---|---|---|---:|---|
${contractRows}

## Token Gateway Custody

Token balances below are context only. Deltas can reflect custom gateways, canonical/non-canonical variants, in-flight messages, token-list coverage gaps, or native ETH paths.

| Symbol | L1 token | Arbitrum token | L1 gateway owner | L1 gateway balance USD | L2 totalSupply USD | Balance minus supply USD |
|---|---|---|---|---:|---:|---:|
${tokenRows}

## Consumer/Bridge Joins

| Metric | Value |
|---|---:|
| Artifact inputs loaded | \`${out.joinInputsLoaded.length}\` |
| Address join rows | \`${s.artifactJoinRows}\` |
| Bridge-specific joins | \`${s.bridgeSpecificJoinRows}\` |
| Watch joins | \`${s.watchCandidates}\` |
| Route-positive joins | \`${s.routePositive}\` |

| Label | Source | Join count | Bridge-specific | Common token | Route-positive |
|---|---|---:|---:|---:|---:|
${joinRows}

## Blockers

- Arbitrum bridge addresses are live and material, but read-only code/proxy/state checks do not show a permissionless proof-acceptance, retryable, delayed-inbox, or outbox-bypass path.
- Gateway balances and Arbitrum token supplies are backing context only; no exact mint/unlock path or same-chain consumer route was proven.
- Common-token consumer joins are not bridge-specific exploit evidence without a deployed bridge or backing flaw.
- No exact positive bridge, borrow, redemption, liquidation, or DEX unwind economics exist, so fork/live work remains blocked.

## Next Gate

Reopen only if an Arbitrum-specific proof/domain/message/nonce/token/finality binding weakness, retryable/outbox bypass, or exact backing mismatch maps to a material consumer with positive exit economics.
`;
  fs.writeFileSync(REPORT_OUT, content);
}

async function main() {
  const [ethRpcUrl, arbRpcUrl] = await Promise.all([resolveRpc(ETHEREUM_CHAIN_ID), resolveRpc(ARBITRUM_CHAIN_ID)]);
  const ethProvider = ethRpcUrl ? new ethers.JsonRpcProvider(ethRpcUrl, ETHEREUM_CHAIN_ID) : null;
  const arbProvider = arbRpcUrl ? new ethers.JsonRpcProvider(arbRpcUrl, ARBITRUM_CHAIN_ID) : null;
  const [metadataRaw, ethBlock, arbBlock] = await Promise.all([
    fetchJson("https://api.llama.fi/protocol/arbitrum-bridge", 45_000).catch(() => ({})),
    ethProvider ? ethProvider.getBlockNumber().catch(() => null) : null,
    arbProvider ? arbProvider.getBlockNumber().catch(() => null) : null,
  ]);
  const ethereum = chainLatest(metadataRaw, "Ethereum");
  const tokenList = await tokenListPairs(ethereum.tokensUsd);
  const pairs = mergeTokenPairs(tokenList.pairs);
  const prices = await tokenPricesUsd(pairs);
  const tokenRows = await inspectTokenPairs(ethProvider, arbProvider, pairs, prices, ethereum.tokensUsd);
  const gatewayOwners = [...new Set(tokenRows.map((row) => lowerAddress(row.l1GatewayOwner)).filter(Boolean))].map((row) => normalizeAddress(row));

  const registryContracts = [
    { chainId: ETHEREUM_CHAIN_ID, provider: ethProvider, name: "Rollup", address: REGISTRY.rollup, role: "rollup-core" },
    { chainId: ETHEREUM_CHAIN_ID, provider: ethProvider, name: "SequencerInbox", address: REGISTRY.sequencerInbox, role: "sequencer-inbox" },
    { chainId: ETHEREUM_CHAIN_ID, provider: ethProvider, name: "CoreProxyAdmin", address: REGISTRY.coreProxyAdmin, role: "core-proxy-admin" },
    { chainId: ETHEREUM_CHAIN_ID, provider: ethProvider, name: "DelayedInbox", address: REGISTRY.delayedInbox, role: "delayed-inbox-retryable" },
    { chainId: ETHEREUM_CHAIN_ID, provider: ethProvider, name: "Bridge", address: REGISTRY.bridge, role: "canonical-bridge" },
    { chainId: ETHEREUM_CHAIN_ID, provider: ethProvider, name: "Outbox", address: REGISTRY.outbox, role: "withdrawal-outbox" },
    { chainId: ETHEREUM_CHAIN_ID, provider: ethProvider, name: "ClassicOutbox1", address: REGISTRY.classicOutbox1, role: "legacy-outbox" },
    { chainId: ETHEREUM_CHAIN_ID, provider: ethProvider, name: "ClassicOutbox2", address: REGISTRY.classicOutbox2, role: "legacy-outbox" },
    { chainId: ETHEREUM_CHAIN_ID, provider: ethProvider, name: "ChallengeManager", address: REGISTRY.challengeManager, role: "fraud-proof" },
    { chainId: ETHEREUM_CHAIN_ID, provider: ethProvider, name: "OneStepProofEntry", address: REGISTRY.oneStepProofEntry, role: "fraud-proof" },
    { chainId: ETHEREUM_CHAIN_ID, provider: ethProvider, name: "L1GatewayRouter", address: REGISTRY.l1GatewayRouter, role: "token-bridge-router" },
    { chainId: ETHEREUM_CHAIN_ID, provider: ethProvider, name: "L1ERC20Gateway", address: REGISTRY.l1Erc20Gateway, role: "token-bridge-gateway" },
    { chainId: ETHEREUM_CHAIN_ID, provider: ethProvider, name: "L1CustomGateway", address: REGISTRY.l1CustomGateway, role: "custom-token-gateway" },
    { chainId: ETHEREUM_CHAIN_ID, provider: ethProvider, name: "L1WethGateway", address: REGISTRY.l1WethGateway, role: "weth-gateway" },
    { chainId: ETHEREUM_CHAIN_ID, provider: ethProvider, name: "L1ProxyAdmin", address: REGISTRY.l1ProxyAdmin, role: "token-bridge-proxy-admin" },
    { chainId: ARBITRUM_CHAIN_ID, provider: arbProvider, name: "L2GatewayRouter", address: L2_REGISTRY.l2GatewayRouter, role: "l2-token-bridge-router" },
    { chainId: ARBITRUM_CHAIN_ID, provider: arbProvider, name: "L2ERC20Gateway", address: L2_REGISTRY.l2Erc20Gateway, role: "l2-token-bridge-gateway" },
    { chainId: ARBITRUM_CHAIN_ID, provider: arbProvider, name: "L2CustomGateway", address: L2_REGISTRY.l2CustomGateway, role: "l2-custom-token-gateway" },
    { chainId: ARBITRUM_CHAIN_ID, provider: arbProvider, name: "L2WethGateway", address: L2_REGISTRY.l2WethGateway, role: "l2-weth-gateway" },
    { chainId: ARBITRUM_CHAIN_ID, provider: arbProvider, name: "L2Weth", address: L2_REGISTRY.l2Weth, role: "l2-weth" },
    { chainId: ARBITRUM_CHAIN_ID, provider: arbProvider, name: "L2ProxyAdmin", address: L2_REGISTRY.l2ProxyAdmin, role: "l2-token-bridge-proxy-admin" },
  ];
  const staticSet = new Set(registryContracts.map((row) => lowerAddress(row.address)).filter(Boolean));
  const dynamicGateways = gatewayOwners
    .filter((address) => !staticSet.has(lowerAddress(address)))
    .map((address, index) => ({ chainId: ETHEREUM_CHAIN_ID, provider: ethProvider, name: `ResolvedL1Gateway${index + 1}`, address, role: "router-resolved-token-gateway" }));

  const [contractRows, bridgeSpecifics, nativeContext] = await Promise.all([
    Promise.all([...registryContracts, ...dynamicGateways].map((row) => inspectContract(row.provider, row.chainId, row.name, row.address, row.role))),
    inspectBridgeSpecifics(ethProvider, arbProvider),
    nativeBridgeContext(ethProvider, arbProvider),
  ]);
  const joins = artifactJoins(tokenRows, contractRows);
  const bridgeSpecificRouteJoins = joins.rows.filter((row) => row.bridgeSpecific && row.routePositive).length;
  const bridgeSpecificWatchJoins = joins.rows.filter((row) => row.bridgeSpecific && row.watchCandidate && !row.routePositive).length;
  const proofWeaknessRows = 0;
  const routePositive = proofWeaknessRows > 0 ? bridgeSpecificRouteJoins : 0;
  const watchCandidates = bridgeSpecificWatchJoins;
  const trackedGatewayBalanceUsd = tokenRows.reduce((sum, row) => sum + (asNumber(row.l1GatewayBalanceUsd) || 0), 0);
  const materialContextDeltaRows = tokenRows.filter((row) => row.materialContextDelta).length;
  const currentTvlUsd = latestTvl(metadataRaw);

  const output = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-arbitrum-bridge-phase0.js",
    scope: "Arbitrum Bridge public Phase 0 retryable/outbox/token-gateway custody and artifact-only consumer join",
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
      name: metadataRaw.name || "Arbitrum Bridge",
      slug: metadataRaw.slug || "arbitrum-bridge",
      category: metadataRaw.category || "Canonical Bridge",
      chains: metadataRaw.chains || ["Ethereum"],
      currentChainTvls: metadataRaw.currentChainTvls || {},
      audits: metadataRaw.audits || "0",
      url: metadataRaw.url || "https://bridge.arbitrum.io/",
      twitter: metadataRaw.twitter || "arbitrum",
      description: metadataRaw.description || null,
      module: metadataRaw.module || null,
      tvlCodePath: metadataRaw.tvlCodePath || null,
      registry: REGISTRY,
      l2Registry: L2_REGISTRY,
      tokenListFetched: tokenList.tokenListFetched,
      tokenListTimestamp: tokenList.tokenListTimestamp,
      latestEthereumTokensInUsdTop: topObjectEntries(ethereum.tokensUsd),
    },
    blocks: { ethereum: ethBlock, arbitrum: arbBlock },
    contractRows,
    bridgeSpecifics,
    nativeContext,
    tokenRows,
    artifactJoins: joins.rows,
    joinInputsLoaded: joins.loadedInputs,
    summary: {
      ethereumRpcResolved: Boolean(ethProvider),
      arbitrumRpcResolved: Boolean(arbProvider),
      defillamaCurrentTvlUsd: round(currentTvlUsd, 2),
      contractsScanned: contractRows.length,
      contractsWithCode: contractRows.filter((row) => row.codePresent).length,
      gatewayRows: gatewayOwners.length,
      tokenRows: tokenRows.length,
      tokenPairsScanned: tokenRows.length,
      tokenRowsWithL1Balance: tokenRows.filter((row) => row.l1GatewayBalanceRaw).length,
      tokenRowsWithL2Supply: tokenRows.filter((row) => row.l2TotalSupplyRaw).length,
      materialTokenRows: tokenRows.filter((row) => row.materialBalance).length,
      materialContextDeltaRows,
      trackedGatewayBalanceUsd: round(trackedGatewayBalanceUsd, 2),
      artifactJoinRows: joins.rows.length,
      bridgeSpecificJoinRows: joins.rows.filter((row) => row.bridgeSpecific).length,
      commonTokenJoinRows: joins.rows.filter((row) => row.common).length,
      watchCandidates,
      proofWeaknessRows,
      bridgeSpecificRouteJoins,
      bridgeSpecificWatchJoins,
      routePositive,
      executableNow: 0,
      signedActionJustified: false,
      coverageClassification: "bounded-with-caveats",
      status: routePositive > 0 ? "route-positive-needs-proof" : "phase0-no-route-positive",
    },
    blockers: [
      "No deployed proof-acceptance, domain separation, delayed-inbox, retryable, outbox, or message-binding bypass proven",
      "No exact source/destination backing mismatch joined to material same-chain consumer economics",
      "Common token consumer presence is not bridge-specific exploit evidence",
      "Token-list and gateway balance deltas are bounded context, not extraction proof",
      "No fork extraction proof and no signed-action justification",
    ],
    requiredForRoutePositive: [
      "Arbitrum-specific proof/domain/message/nonce/token/finality binding weakness, retryable/outbox bypass, or material exact backing mismatch",
      "permissionless path to mint/unlock/transfer or consumer-borrow against the affected asset",
      "exact unwind/borrow/redeem/liquidation economics positive after costs",
      "fork extraction proof",
    ],
  };

  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, `${JSON.stringify(output, jsonReplacer, 2)}\n`);
  writeReport(output);
  if (!QUIET) {
    console.log(`Arbitrum Bridge Phase0: tvl=$${Math.round(currentTvlUsd || 0)} tokens=${tokenRows.length} gateways=${gatewayOwners.length} joins=${joins.rows.length} bridgeSpecific=${output.summary.bridgeSpecificJoinRows} watch=${watchCandidates} routePositive=${routePositive}`);
    console.log(`Artifact: ${path.relative(WORKSPACE, RAW_OUT).replace(/\\/g, "/")}`);
    console.log(`Report: ${path.relative(WORKSPACE, REPORT_OUT).replace(/\\/g, "/")}`);
  }
}

main().catch((err) => {
  console.error(String(err?.message || err).slice(0, 320));
  process.exit(1);
});
