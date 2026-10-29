#!/usr/bin/env node
// scan-solvbtc-phase0.js - read-only SolvBTC bridge/wrapped-BTC Phase 0.
// Resolves RPC URLs in memory only. Never prints or stores RPC URLs, keys, calldata, or signed actions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { resolveRpcPool, rpcCall } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "solvbtc-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "solvbtc-phase0-triage.md");
const QUIET = process.argv.includes("--quiet");

const CONFIG_URL = "https://raw.githubusercontent.com/solv-finance/solv-protocol-defillama/refs/heads/main/solvbtc.json";
const PROTOCOL_URL = "https://api.llama.fi/protocol/solvbtc";
const MIN_MATERIAL_USD = Number(process.env.SOLVBTC_PHASE0_MIN_MATERIAL_USD || "10000");
const PROBE_FROM = "0x000000000000000000000000000000000000dEaD";
const ZERO = "0x0000000000000000000000000000000000000000";
const SIGNAL_DORMANT = "🟢 DORMANT";

const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const EIP1967_BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

const CHAINS = {
  ethereum: { key: "ethereum", name: "Ethereum", chainId: 1, priceChain: "ethereum", llamaKey: "Ethereum" },
  bsc: { key: "bsc", name: "BNB Chain", chainId: 56, priceChain: "bsc", llamaKey: "Binance" },
  polygon: { key: "polygon", name: "Polygon", chainId: 137, priceChain: "polygon", llamaKey: "Polygon" },
  arbitrum: { key: "arbitrum", name: "Arbitrum", chainId: 42161, priceChain: "arbitrum", llamaKey: "Arbitrum" },
  mantle: { key: "mantle", name: "Mantle", chainId: 5000, priceChain: "mantle", llamaKey: "Mantle" },
  avax: { key: "avax", name: "Avalanche", chainId: 43114, priceChain: "avax", llamaKey: "Avalanche" },
  base: { key: "base", name: "Base", chainId: 8453, priceChain: "base", llamaKey: "Base" },
  bob: { key: "bob", name: "BOB", chainId: 60808, priceChain: "bob", llamaKey: "BOB" },
  xlayer: { key: "xlayer", name: "X Layer", chainId: 196, priceChain: "xlayer", llamaKey: "X Layer" },
  zksync: { key: "zksync", name: "ZKsync", chainId: 324, priceChain: "zksync", llamaKey: "ZKsync" },
  linea: { key: "linea", name: "Linea", chainId: 59144, priceChain: "linea", llamaKey: "Linea" },
  ink: { key: "ink", name: "Ink", chainId: 57073, priceChain: "ink", llamaKey: "Ink" },
};

const SOLVBTC_CCTP_TOKENS = [
  { key: "ethereum", token: "0x7A56E1C57C7475CCf742a1832B028F0456652F97", pool: "0x3300f27EDEeEB59CC4C4203785406cBEAfEC8dF3", source: "chainlink-ccip-directory" },
  { key: "bsc", token: "0x4aae823a6a0b376De6A78e74eCC5b079d38cBCf7", pool: "0x99D94f528CeA3eE1791ab7B476A1FACb4297CA17", source: "chainlink-ccip-directory" },
  { key: "arbitrum", token: "0x3647c54c4c2C65bC7a2D63c0Da2809B399DBBDC0", pool: "0x4f628aF99578da6A481851779Fa297A35500C173", source: "chainlink-ccip-directory" },
  { key: "avax", token: "0xbc78D84Ba0c46dFe32cf2895a19939c86b81a777", pool: "0xc929ad75B72593967DE83E7F7Cda0493458261D9", source: "chainlink-ccip-directory" },
  { key: "base", token: "0x3B86Ad95859b6AB773f55f8d94B4b9d443EE931f", pool: "0x2315f2A36af9dd75B7a4E1c6c53B11767eBfb750", source: "chainlink-ccip-directory" },
  { key: "bob", token: "0x541FD749419CA806a8bc7da8ac23D346f2dF8B77", pool: "0x6c2310D68F21C024FF66Cc52e65220112F35DC32", source: "chainlink-ccip-directory" },
  { key: "polygon", token: "0xaE4EFbc7736f963982aACb17EFA37fCBAb924cB3", pool: "0x0809FC59B735e0aa90448514bBbEe0C75A080475", source: "chainlink-ccip-directory" },
  { key: "xlayer", token: "0xaE4EFbc7736f963982aACb17EFA37fCBAb924cB3", pool: "0x5Ad69372a0DFA94188191aB13dF0034cb4454ee1", source: "chainlink-ccip-directory" },
  { key: "zksync", token: "0x74eD17608cc2B5f30a59d6aF07C9aD1B1aB3A5b1", pool: "0xCd627aA160A6fA45Eb793D19Ef54f5062F20f33f", source: "chainlink-ccip-directory" },
  { key: "linea", token: "0x541FD749419CA806a8bc7da8ac23D346f2dF8B77", pool: "0x99D94f528CeA3eE1791ab7B476A1FACb4297CA17", source: "chainlink-ccip-directory" },
  { key: "ink", token: "0xaE4EFbc7736f963982aACb17EFA37fCBAb924cB3", pool: "0xf49f81b3d2F2a79b706621FA2D5934136352140c", source: "chainlink-ccip-directory" },
];

const ERC20 = new ethers.Interface([
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
const BYTES32_TOKEN = new ethers.Interface(["function symbol() view returns (bytes32)", "function name() view returns (bytes32)"]);
const COMMON = new ethers.Interface([
  "function owner() view returns (address)",
  "function admin() view returns (address)",
  "function paused() view returns (bool)",
  "function minter() view returns (address)",
  "function pendingOwner() view returns (address)",
]);
const ERC4626 = new ethers.Interface([
  "function asset() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function convertToShares(uint256) view returns (uint256)",
  "function maxDeposit(address) view returns (uint256)",
  "function maxWithdraw(address) view returns (uint256)",
]);

const PROBES = [
  { label: "mint(address,uint256)", signature: "mint(address,uint256)", args: () => [PROBE_FROM, 1n] },
  { label: "burn(uint256)", signature: "burn(uint256)", args: () => [1n] },
  { label: "burnFrom(address,uint256)", signature: "burnFrom(address,uint256)", args: () => [PROBE_FROM, 1n] },
  { label: "withdraw(uint256)", signature: "withdraw(uint256)", args: () => [1n] },
  { label: "withdraw(address,uint256)", signature: "withdraw(address,uint256)", args: (token) => [token || ZERO, 1n] },
  { label: "redeem(uint256)", signature: "redeem(uint256)", args: () => [1n] },
  { label: "redeem(uint256,address,address)", signature: "redeem(uint256,address,address)", args: () => [1n, PROBE_FROM, PROBE_FROM] },
  { label: "claim()", signature: "claim()", args: () => [] },
  { label: "claim(address)", signature: "claim(address)", args: () => [PROBE_FROM] },
  { label: "sweep(address)", signature: "sweep(address)", args: (token) => [token || ZERO] },
  { label: "recoverERC20(address,uint256)", signature: "recoverERC20(address,uint256)", args: (token) => [token || ZERO, 1n] },
  { label: "rescueTokens(address,address,uint256)", signature: "rescueTokens(address,address,uint256)", args: (token) => [token || ZERO, PROBE_FROM, 1n] },
  { label: "execute(address,uint256,bytes)", signature: "execute(address,uint256,bytes)", args: (token) => [token || ZERO, 0n, "0x"] },
  { label: "migrate()", signature: "migrate()", args: () => [] },
];

const CONSUMER_HINT_FILES = [
  "reports/raw/fast/aave-euler-silo-consumer-graph.json",
  "reports/raw/fast/consumer-first-high-ltv-collateral.json",
  "reports/raw/fast/public-lead-consumer-joins.json",
  "reports/raw/fast/erc4626-consumer-joiner.json",
  "reports/raw/fast/bridge-lending-collateral-join.json",
  "reports/raw/fast/bridge-proof-binding.json",
  "reports/raw/fast/bridge-domain-separation.json",
  "reports/raw/fast/bridge-synthetic-consumer-exposure.json",
  "reports/raw/fast/dex-consumer-routes.json",
  "reports/raw/fast/curve-dex-phase0.json",
  "reports/raw/fast/curve-llamalend-phase0.json",
  "reports/raw/fast/fluid-lending-phase0.json",
  "reports/raw/fast/euler-v2-phase0.json",
  "reports/raw/fast/morpho-public-allocator-force-feed.json",
  "reports/raw/fast/morpho-pyth-unsafe-consumers.json",
  "reports/raw/fast/morpho-exit-liquidity-stress.json",
  "reports/raw/fast/morpho-flashloan-token-overlap.json",
  "reports/raw/fast/market-launch-choreography-routes.json",
  "reports/raw/fast/small-cap-oracle-manipulation-routes.json",
  "reports/raw/fast/seven-chain-lending-coverage.json",
  "reports/raw/fast/benqi-lending-phase0.json",
  "reports/raw/fast/lista-cdp-phase0.json",
  "reports/raw/fast/lista-dex-phase0.json",
  "reports/raw/fast/joe-v22-phase0.json",
  "reports/raw/fast/governance-listing-watch.json",
  "reports/raw/fast/recent-contracts-old-money.json",
  "reports/raw/fast/recent-contracts-old-money-probes.json",
];

function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function readText(file) { try { return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""; } catch (_) { return ""; } }
function readJson(file, fallback = null) { try { const text = readText(file).replace(/^\uFEFF/, ""); return text ? JSON.parse(text) : fallback; } catch (_) { return fallback; } }
function writeJson(file, value) { ensureDir(file); fs.writeFileSync(file, `${JSON.stringify(value, jsonReplacer, 2)}\n`); }
function jsonReplacer(_key, value) { return typeof value === "bigint" ? value.toString() : value; }
function strip0x(value) { return String(value || "").replace(/^0x/i, ""); }
function normalizeAddress(value) { try { return ethers.getAddress(String(value || "")); } catch (_) { return null; } }
function lowerAddress(value) { const a = normalizeAddress(value); return a ? a.toLowerCase() : null; }
function unique(items) { return [...new Set((items || []).filter(Boolean))]; }
function compactAddress(value) { const a = normalizeAddress(value); return a ? `${a.slice(0, 6)}...${a.slice(-4)}` : "n/a"; }
function addressFromStorageSlot(raw) { if (!raw || raw === "0x") return null; const hex = strip0x(raw).padStart(64, "0"); if (/^0+$/.test(hex)) return null; return normalizeAddress(`0x${hex.slice(-40)}`); }
function decodeBytes32String(value) { try { return ethers.decodeBytes32String(value); } catch (_) { return null; } }
function asNumber(value) { if (value === null || value === undefined || value === "") return null; if (typeof value === "number") return Number.isFinite(value) ? value : null; if (typeof value === "bigint") return Number(value); const n = Number(String(value).replace(/[$,%`,\s,]/g, "")); return Number.isFinite(n) ? n : null; }
function round(value, decimals = 2) { const n = asNumber(value); if (n === null) return null; const p = 10 ** decimals; return Math.round(n * p) / p; }
function decimalsToNumber(value, decimals) { try { if (value === null || value === undefined || decimals === null || decimals === undefined) return null; const n = Number(ethers.formatUnits(BigInt(value), Number(decimals))); return Number.isFinite(n) ? n : null; } catch (_) { return null; } }
function formatUsd(value) { const n = asNumber(value); return n === null ? "n/a" : `$${Math.round(n).toLocaleString()}`; }
function formatNumber(value, decimals = 6) { const n = asNumber(value); return n === null ? "n/a" : n.toLocaleString(undefined, { maximumFractionDigits: decimals }); }
function safeText(value, max = 220) { return String(value ?? "").replace(/https?:\/\/\S+/g, "[redacted-url]").replace(/\s+/g, " ").trim().slice(0, max) || null; }

async function fetchJson(url, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "evm-audit-solvbtc-phase0/1.0" } });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
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
  } catch (_) { return null; }
}

async function stateProbe(rpc, to, probe, token) {
  const addr = normalizeAddress(to);
  if (!rpc || !addr) return { success: false, rawBytes: 0 };
  const fn = probe.signature.slice(0, probe.signature.indexOf("("));
  const iface = new ethers.Interface([`function ${probe.signature}`]);
  try {
    const raw = await rpcCall(rpc, "eth_call", [{ from: PROBE_FROM, to: addr, data: iface.encodeFunctionData(fn, probe.args(token)) }, "latest"], 8_000);
    return { success: Boolean(raw), rawBytes: raw ? Math.max(0, (raw.length - 2) / 2) : 0 };
  } catch (_) {
    return { success: false, rawBytes: 0 };
  }
}

async function getCode(rpc, address) {
  const addr = normalizeAddress(address);
  if (!rpc || !addr) return "0x";
  return await rpcCall(rpc, "eth_getCode", [addr, "latest"], 10_000).catch(() => "0x") || "0x";
}

async function getStorage(rpc, address, slot) {
  const addr = normalizeAddress(address);
  if (!rpc || !addr) return null;
  return await rpcCall(rpc, "eth_getStorageAt", [addr, slot, "latest"], 10_000).catch(() => null);
}

async function latestBlock(rpc) {
  const raw = await rpcCall(rpc, "eth_blockNumber", [], 10_000).catch(() => null);
  return raw ? parseInt(raw, 16) : null;
}

async function tokenMeta(rpc, address, chain, extra = {}) {
  const addr = normalizeAddress(address);
  const code = await getCode(rpc, addr);
  const [sym, name, dec, supply, implRaw, adminRaw, beaconRaw, owner, admin, paused, minter, pendingOwner, asset, totalAssets, oneShareAssets, oneAssetShares, maxDeposit, maxWithdraw] = await Promise.all([
    safeCall(rpc, addr, ERC20, "symbol"),
    safeCall(rpc, addr, ERC20, "name"),
    safeCall(rpc, addr, ERC20, "decimals"),
    safeCall(rpc, addr, ERC20, "totalSupply"),
    getStorage(rpc, addr, EIP1967_IMPLEMENTATION_SLOT),
    getStorage(rpc, addr, EIP1967_ADMIN_SLOT),
    getStorage(rpc, addr, EIP1967_BEACON_SLOT),
    safeCall(rpc, addr, COMMON, "owner"),
    safeCall(rpc, addr, COMMON, "admin"),
    safeCall(rpc, addr, COMMON, "paused"),
    safeCall(rpc, addr, COMMON, "minter"),
    safeCall(rpc, addr, COMMON, "pendingOwner"),
    safeCall(rpc, addr, ERC4626, "asset"),
    safeCall(rpc, addr, ERC4626, "totalAssets"),
    safeCall(rpc, addr, ERC4626, "convertToAssets", [10n ** 18n]),
    safeCall(rpc, addr, ERC4626, "convertToShares", [10n ** 18n]),
    safeCall(rpc, addr, ERC4626, "maxDeposit", [PROBE_FROM]),
    safeCall(rpc, addr, ERC4626, "maxWithdraw", [PROBE_FROM]),
  ]);
  const symbolBytes = sym ? null : await safeCall(rpc, addr, BYTES32_TOKEN, "symbol");
  const nameBytes = name ? null : await safeCall(rpc, addr, BYTES32_TOKEN, "name");
  const decimals = dec ? Number(dec[0]) : 18;
  const priceKey = `${chain.priceChain}:${addr.toLowerCase()}`;
  return {
    chain: chain.name,
    chainId: chain.chainId,
    configKey: chain.key,
    tokenRole: extra.tokenRole || "custodyDepositToken",
    source: extra.source || "solvbtc-defillama-config",
    tokenPool: extra.tokenPool || null,
    address: addr,
    codePresent: code !== "0x",
    codeBytes: Math.max(0, (code.length - 2) / 2),
    implementation: addressFromStorageSlot(implRaw),
    adminSlot: addressFromStorageSlot(adminRaw),
    beaconSlot: addressFromStorageSlot(beaconRaw),
    owner: owner?.[0] ? normalizeAddress(owner[0]) : null,
    admin: admin?.[0] ? normalizeAddress(admin[0]) : null,
    pendingOwner: pendingOwner?.[0] ? normalizeAddress(pendingOwner[0]) : null,
    minter: minter?.[0] ? normalizeAddress(minter[0]) : null,
    paused: paused ? Boolean(paused[0]) : null,
    symbol: sym?.[0] || decodeBytes32String(symbolBytes?.[0]) || null,
    name: name?.[0] || decodeBytes32String(nameBytes?.[0]) || null,
    decimals,
    totalSupplyRaw: supply?.[0]?.toString() || null,
    totalSupply: supply ? round(decimalsToNumber(supply[0], decimals), 8) : null,
    priceKey,
    priceUsd: null,
    totalSupplyUsd: null,
    erc4626Like: Boolean(asset?.[0] || totalAssets?.[0] || oneShareAssets?.[0]),
    erc4626: {
      asset: asset?.[0] ? normalizeAddress(asset[0]) : null,
      totalAssetsRaw: totalAssets?.[0]?.toString() || null,
      totalAssets: totalAssets ? round(decimalsToNumber(totalAssets[0], decimals), 8) : null,
      convertToAssets1e18Raw: oneShareAssets?.[0]?.toString() || null,
      convertToShares1e18Raw: oneAssetShares?.[0]?.toString() || null,
      maxDepositProbeRaw: maxDeposit?.[0]?.toString() || null,
      maxWithdrawProbeRaw: maxWithdraw?.[0]?.toString() || null,
    },
    routePositive: false,
  };
}

async function depositMeta(rpc, address, chain, tokenMetas) {
  const addr = normalizeAddress(address);
  const code = await getCode(rpc, addr);
  const [nativeRaw, implRaw, adminRaw, beaconRaw, owner, admin, paused] = await Promise.all([
    rpcCall(rpc, "eth_getBalance", [addr, "latest"], 10_000).catch(() => null),
    getStorage(rpc, addr, EIP1967_IMPLEMENTATION_SLOT),
    getStorage(rpc, addr, EIP1967_ADMIN_SLOT),
    getStorage(rpc, addr, EIP1967_BEACON_SLOT),
    safeCall(rpc, addr, COMMON, "owner"),
    safeCall(rpc, addr, COMMON, "admin"),
    safeCall(rpc, addr, COMMON, "paused"),
  ]);
  const balances = [];
  for (const token of tokenMetas) {
    const bal = await safeCall(rpc, token.address, ERC20, "balanceOf", [addr]);
    const amount = bal ? decimalsToNumber(bal[0], token.decimals) : null;
    balances.push({
      token: token.address,
      symbol: token.symbol,
      balanceRaw: bal?.[0]?.toString() || null,
      amount: round(amount, 8),
      priceUsd: token.priceUsd,
      amountUsd: round((amount || 0) * (token.priceUsd || 0), 2),
      routePositive: false,
    });
  }
  const nativeEth = nativeRaw ? Number(ethers.formatEther(BigInt(nativeRaw))) : null;
  return {
    chain: chain.name,
    chainId: chain.chainId,
    configKey: chain.key,
    address: addr,
    codePresent: code !== "0x",
    codeBytes: Math.max(0, (code.length - 2) / 2),
    implementation: addressFromStorageSlot(implRaw),
    adminSlot: addressFromStorageSlot(adminRaw),
    beaconSlot: addressFromStorageSlot(beaconRaw),
    owner: owner?.[0] ? normalizeAddress(owner[0]) : null,
    admin: admin?.[0] ? normalizeAddress(admin[0]) : null,
    paused: paused ? Boolean(paused[0]) : null,
    nativeBalanceRaw: nativeRaw,
    nativeEth: round(nativeEth, 8),
    tokenBalances: balances,
    totalTokenBalanceUsd: round(balances.reduce((sum, row) => sum + (asNumber(row.amountUsd) || 0), 0), 2),
    materialBalance: balances.some((row) => (asNumber(row.amountUsd) || 0) >= MIN_MATERIAL_USD),
    routePositive: false,
  };
}

async function contractMeta(rpc, address, chain, role, symbol = null, source = null) {
  const addr = normalizeAddress(address);
  const code = await getCode(rpc, addr);
  const [nativeRaw, implRaw, adminRaw, beaconRaw, owner, admin, paused] = await Promise.all([
    rpcCall(rpc, "eth_getBalance", [addr, "latest"], 10_000).catch(() => null),
    getStorage(rpc, addr, EIP1967_IMPLEMENTATION_SLOT),
    getStorage(rpc, addr, EIP1967_ADMIN_SLOT),
    getStorage(rpc, addr, EIP1967_BEACON_SLOT),
    safeCall(rpc, addr, COMMON, "owner"),
    safeCall(rpc, addr, COMMON, "admin"),
    safeCall(rpc, addr, COMMON, "paused"),
  ]);
  const nativeEth = nativeRaw ? Number(ethers.formatEther(BigInt(nativeRaw))) : null;
  return {
    chain: chain.name,
    chainId: chain.chainId,
    configKey: chain.key,
    role,
    symbol,
    source,
    address: addr,
    codePresent: code !== "0x",
    codeBytes: Math.max(0, (code.length - 2) / 2),
    implementation: addressFromStorageSlot(implRaw),
    adminSlot: addressFromStorageSlot(adminRaw),
    beaconSlot: addressFromStorageSlot(beaconRaw),
    owner: owner?.[0] ? normalizeAddress(owner[0]) : null,
    admin: admin?.[0] ? normalizeAddress(admin[0]) : null,
    paused: paused ? Boolean(paused[0]) : null,
    nativeBalanceRaw: nativeRaw,
    nativeEth: round(nativeEth, 8),
    routePositive: false,
  };
}

async function fetchPrices(tokens) {
  const ids = unique(tokens.map((row) => row.priceKey).filter(Boolean));
  ids.push("coingecko:bitcoin");
  const prices = {};
  for (let i = 0; i < ids.length; i += 80) {
    const json = await fetchJson(`https://coins.llama.fi/prices/current/${ids.slice(i, i + 80).join(",")}?searchWidth=6h`, 30_000) || { coins: {} };
    for (const [key, value] of Object.entries(json.coins || {})) prices[key.toLowerCase()] = asNumber(value?.price);
  }
  return prices;
}

function configRows(config) {
  const byKey = new Map();
  for (const [key, value] of Object.entries(config || {})) {
    if (!value || !value.otherDeposit) continue;
    const chain = CHAINS[key];
    const depositAddresses = (value.otherDeposit.depositAddress || []).map(normalizeAddress).filter(Boolean);
    const tokens = (value.otherDeposit.tokens || []).map(normalizeAddress).filter(Boolean);
    byKey.set(key, { key, chain, depositAddresses: unique(depositAddresses), tokens: unique(tokens), solvbtcTokens: [] });
  }
  for (const seed of SOLVBTC_CCTP_TOKENS) {
    const chain = CHAINS[seed.key];
    if (!chain) continue;
    if (!byKey.has(seed.key)) byKey.set(seed.key, { key: seed.key, chain, depositAddresses: [], tokens: [], solvbtcTokens: [] });
    const row = byKey.get(seed.key);
    row.solvbtcTokens.push({ token: normalizeAddress(seed.token), pool: normalizeAddress(seed.pool), source: seed.source });
  }
  for (const row of byKey.values()) row.solvbtcTokens = row.solvbtcTokens.filter((seed) => seed.token);
  return [...byKey.values()];
}

function scanConsumerJoins(addressRows) {
  const targets = [];
  for (const row of addressRows) {
    const address = lowerAddress(row.address);
    if (address) targets.push({ ...row, lower: address });
  }
  const joins = [];
  const files = unique(CONSUMER_HINT_FILES.map((f) => path.join(WORKSPACE, f)).filter((file) => fs.existsSync(file)));
  for (const file of files) {
    const rel = path.relative(WORKSPACE, file).replace(/\\/g, "/");
    const text = readText(file);
    if (!text) continue;
    const lower = text.toLowerCase();
    const routePositiveInFile = /"routePositive"\s*:\s*(true|[1-9])/.test(text);
    const watchCandidateInFile = /"watchCandidates?"\s*:\s*([1-9]|true)/.test(text) || /"watchCandidate"\s*:\s*true/.test(text);
    for (const target of targets) {
      if (!lower.includes(target.lower)) continue;
      joins.push({
        source: rel,
        chain: target.chain,
        chainId: target.chainId,
        role: target.role,
        symbol: target.symbol || null,
        address: target.address,
        routePositiveInFile,
        watchCandidateInFile,
        consumerGrade: /aave|euler|silo|morpho|venus|compound|fluid|llamalend|consumer|bridge|dex|pendle|lista|resupply|curve/i.test(rel),
        routePositive: false,
        blocker: "Exact address appears in a local artifact, but this is not route-positive without accepted-value impact and exact positive economics.",
      });
    }
  }
  joins.sort((a, b) => Number(b.consumerGrade) - Number(a.consumerGrade) || Number(b.watchCandidateInFile) - Number(a.watchCandidateInFile) || a.source.localeCompare(b.source));
  return joins;
}

async function probeEconomicSelectors(rpc, chain, targets, tokens) {
  const rows = [];
  const primaryToken = tokens[0]?.address || ZERO;
  for (const target of targets) {
    if (!target.codePresent) continue;
    for (const probe of PROBES) {
      const result = await stateProbe(rpc, target.address, probe, primaryToken);
      rows.push({
        chain: chain.name,
        chainId: chain.chainId,
        targetRole: target.role,
        target: target.address,
        symbol: target.symbol || null,
        probe: probe.label,
        staticCallOk: result.success,
        rawResultBytes: result.rawBytes,
        routePositive: false,
        blocker: result.success ? "Staticcall success only; no token balance-delta proof or exact economics." : "Selector path reverted or is not callable by arbitrary probe sender.",
      });
    }
  }
  return rows;
}

function metadataSummary(protocol) {
  const currentChainTvls = {};
  for (const [key, value] of Object.entries(protocol?.currentChainTvls || {})) currentChainTvls[key] = round(value, 2);
  const latestTvl = Array.isArray(protocol?.tvl) ? protocol.tvl.slice(-1)[0]?.totalLiquidityUSD : protocol?.tvl;
  const currentTvl = Object.values(currentChainTvls).reduce((sum, value) => sum + (asNumber(value) || 0), 0);
  return {
    name: protocol?.name || "SolvBTC",
    slug: protocol?.slug || "solvbtc",
    category: protocol?.category || "Bridge",
    tvlUsd: round(asNumber(latestTvl) || currentTvl, 2),
    chains: protocol?.chains || [],
    currentChainTvls,
    audits: protocol?.audits || null,
    module: protocol?.module || "solvbtc/index.js",
    description: safeText(protocol?.description || protocol?.methodology, 300),
  };
}

function buildReport(artifact) {
  const s = artifact.summary;
  const lines = [];
  lines.push(`# ${SIGNAL_DORMANT} - SolvBTC Phase 0`);
  lines.push("");
  lines.push(`Generated: \`${artifact.generatedAt}\``);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|---|---:|");
  lines.push(`| DeFiLlama TVL | ${formatUsd(s.defillamaTvlUsd)} |`);
  lines.push(`| Chain configs scanned | \`${s.chainConfigs}\` |`);
  lines.push(`| RPC available chains | \`${s.rpcAvailableChains}\` |`);
  lines.push(`| RPC blocked chains | \`${s.rpcBlockedChains}\` |`);
  lines.push(`| Token rows | \`${s.tokenRows}\` |`);
  lines.push(`| SolvBTC wrapper rows | \`${s.solvbtcWrapperRows}\` |`);
  lines.push(`| CCIP/token-pool contract rows | \`${s.contractRows}\` |`);
  lines.push(`| Deposit rows | \`${s.depositRows}\` |`);
  lines.push(`| Deposit material balance rows | \`${s.materialDepositRows}\` |`);
  lines.push(`| Tracked deposit balance | ${formatUsd(s.trackedDepositBalanceUsd)} |`);
  lines.push(`| Consumer join rows | \`${s.consumerJoinRows}\` |`);
  lines.push(`| Public economic static successes | \`${s.publicEconomicStaticSuccessRows}\` |`);
  lines.push(`| Watch candidates | \`${s.watchCandidates}\` |`);
  lines.push(`| Route-positive | \`${s.routePositive}\` |`);
  lines.push("");
  lines.push("## Top Deposit Balances");
  lines.push("");
  lines.push("| Chain | Deposit | Token | Amount | USD | Code | Owner/Admin | Verdict |");
  lines.push("|---|---|---|---:|---:|---:|---|---|");
  for (const row of artifact.topDepositBalances.slice(0, 12)) {
    lines.push(`| ${row.chain} | \`${compactAddress(row.deposit)}\` | ${row.symbol || "?"} | ${formatNumber(row.amount, 8)} | ${formatUsd(row.amountUsd)} | ${row.depositCodePresent ? "yes" : "no"} | ${row.ownerOrAdmin ? `\`${compactAddress(row.ownerOrAdmin)}\`` : "n/a"} | ${row.routePositive ? "route-positive" : "blocked"} |`);
  }
  if (!artifact.topDepositBalances.length) lines.push("| n/a | n/a | n/a | n/a | n/a | n/a | n/a | no material tracked balance | ");
  lines.push("");
  lines.push("## Consumer Joins");
  lines.push("");
  lines.push("| Source | Chain | Role | Address | Symbol | Consumer-grade | Blocker |");
  lines.push("|---|---|---|---|---|---:|---|");
  for (const row of artifact.consumerJoinRows.slice(0, 20)) lines.push(`| \`${row.source}\` | ${row.chain || "?"} | ${row.role} | \`${compactAddress(row.address)}\` | ${row.symbol || ""} | ${row.consumerGrade ? "yes" : "no"} | ${row.blocker} |`);
  if (!artifact.consumerJoinRows.length) lines.push("| n/a | n/a | n/a | n/a | n/a | n/a | no exact local consumer join found | ");
  lines.push("");
  lines.push("## Public Static Probes");
  lines.push("");
  lines.push("| Chain | Role | Target | Probe | Result | Blocker |");
  lines.push("|---|---|---|---|---:|---|");
  for (const row of artifact.publicEconomicProbeRows.filter((r) => r.staticCallOk).slice(0, 20)) lines.push(`| ${row.chain} | ${row.targetRole} | \`${compactAddress(row.target)}\` | ${row.probe} | ok | ${row.blocker} |`);
  if (!artifact.publicEconomicProbeRows.some((r) => r.staticCallOk)) lines.push("| n/a | n/a | n/a | n/a | none | all arbitrary-sender public economic selector probes reverted or were absent | ");
  lines.push("");
  lines.push("## Gate");
  lines.push("");
  lines.push("No fork/executor work is justified. Required promotion edge: exact deployed proof/custody/accounting bypass or accepted-value anomaly, joined live extractive consumer liquidity, and positive economics after fees, slippage, caps, queues, finality, and gas.");
  return `${lines.join("\n")}\n`;
}

async function main() {
  const [config, protocol] = await Promise.all([
    fetchJson(CONFIG_URL, 45_000),
    fetchJson(PROTOCOL_URL, 45_000),
  ]);
  const meta = metadataSummary(protocol || {});
  const rows = configRows(config || {});
  const chainIds = unique(rows.map((row) => row.chain?.chainId).filter(Boolean));
  const skipRpcInventory = process.env.SOLVBTC_SKIP_RPC_INVENTORY === "1";
  const rpcPool = await resolveRpcPool(chainIds, skipRpcInventory ? [] : null);

  const chainRows = [];
  const tokenRows = [];
  const depositRows = [];
  const contractRows = [];
  const publicEconomicProbeRows = [];
  const rpcBlockedRows = [];

  for (const row of rows) {
    const chain = row.chain;
    if (!chain) {
      rpcBlockedRows.push({ configKey: row.key, chain: row.key, chainId: null, reason: "unsupported chain config key", routePositive: false });
      continue;
    }
    const rpc = rpcPool[chain.chainId] || null;
    const chainResult = { configKey: row.key, chain: chain.name, chainId: chain.chainId, rpcAvailable: Boolean(rpc), latestBlock: null, tokenCount: row.tokens.length, solvbtcTokenCount: row.solvbtcTokens.length, depositCount: row.depositAddresses.length, routePositive: false };
    if (!rpc) {
      rpcBlockedRows.push({ configKey: row.key, chain: chain.name, chainId: chain.chainId, reason: "missing sanitized RPC endpoint", routePositive: false });
      chainRows.push(chainResult);
      continue;
    }
    chainResult.latestBlock = await latestBlock(rpc);
    const metas = [];
    const tokenInfo = new Map();
    for (const token of row.tokens) tokenInfo.set(lowerAddress(token), { tokenRole: "custodyDepositToken", source: "solvbtc-defillama-config" });
    for (const seed of row.solvbtcTokens) tokenInfo.set(lowerAddress(seed.token), { tokenRole: "solvbtcWrapper", source: seed.source, tokenPool: seed.pool });
    const tokenSeeds = unique([...row.tokens, ...row.solvbtcTokens.map((seed) => seed.token)].map(normalizeAddress).filter(Boolean));
    for (const token of tokenSeeds) metas.push(await tokenMeta(rpc, token, chain, tokenInfo.get(lowerAddress(token)) || {}));
    const prices = await fetchPrices(metas);
    const btcPrice = prices["coingecko:bitcoin"] || null;
    for (const token of metas) {
      token.priceUsd = prices[String(token.priceKey || "").toLowerCase()] || (/BTC/i.test(token.symbol || token.name || "") ? btcPrice : null);
      token.totalSupplyUsd = round((asNumber(token.totalSupply) || 0) * (asNumber(token.priceUsd) || 0), 2);
      tokenRows.push(token);
    }
    const depositsForChain = [];
    for (const deposit of row.depositAddresses) {
      const metaRow = await depositMeta(rpc, deposit, chain, metas);
      depositsForChain.push(metaRow);
      depositRows.push(metaRow);
    }
    const contractsForChain = [];
    for (const seed of row.solvbtcTokens) {
      if (!seed.pool) continue;
      const poolRow = await contractMeta(rpc, seed.pool, chain, "ccip-token-pool", "SolvBTC", seed.source);
      contractsForChain.push(poolRow);
      contractRows.push(poolRow);
    }
    chainResult.trackedDepositBalanceUsd = round(depositsForChain.reduce((sum, d) => sum + (asNumber(d.totalTokenBalanceUsd) || 0), 0), 2);
    chainResult.materialDepositRows = depositsForChain.filter((d) => d.materialBalance).length;
    chainResult.contractRows = contractsForChain.length;
    chainRows.push(chainResult);

    const probeTargets = [
      ...metas.map((t) => ({ role: t.tokenRole || "token", address: t.address, symbol: t.symbol, chain: chain.name, chainId: chain.chainId, codePresent: t.codePresent })),
      ...depositsForChain.map((d) => ({ role: "deposit", address: d.address, symbol: null, chain: chain.name, chainId: chain.chainId, codePresent: d.codePresent })),
      ...contractsForChain.map((d) => ({ role: d.role, address: d.address, symbol: d.symbol, chain: chain.name, chainId: chain.chainId, codePresent: d.codePresent })),
    ];
    publicEconomicProbeRows.push(...await probeEconomicSelectors(rpc, chain, probeTargets, metas));
  }

  const addressRows = [
    ...tokenRows.map((t) => ({ role: t.tokenRole || "token", address: t.address, chain: t.chain, chainId: t.chainId, symbol: t.symbol })),
    ...depositRows.map((d) => ({ role: "deposit", address: d.address, chain: d.chain, chainId: d.chainId, symbol: null })),
    ...contractRows.map((d) => ({ role: d.role, address: d.address, chain: d.chain, chainId: d.chainId, symbol: d.symbol })),
  ];
  const consumerJoinRows = scanConsumerJoins(addressRows);

  const topDepositBalances = depositRows.flatMap((d) => d.tokenBalances.map((b) => ({
    chain: d.chain,
    chainId: d.chainId,
    deposit: d.address,
    depositCodePresent: d.codePresent,
    ownerOrAdmin: d.owner || d.admin || d.adminSlot,
    token: b.token,
    symbol: b.symbol,
    amount: b.amount,
    amountUsd: b.amountUsd,
    routePositive: false,
  }))).sort((a, b) => (asNumber(b.amountUsd) || 0) - (asNumber(a.amountUsd) || 0));

  const materialDepositRows = depositRows.filter((row) => row.materialBalance).length;
  const publicEconomicStaticSuccessRows = publicEconomicProbeRows.filter((row) => row.staticCallOk).length;
  const consumerGradeJoinRows = consumerJoinRows.filter((row) => row.consumerGrade).length;
  const watchCandidates = consumerGradeJoinRows + publicEconomicStaticSuccessRows;
  const summary = {
    defillamaTvlUsd: meta.tvlUsd,
    chainConfigs: rows.length,
    rpcAvailableChains: chainRows.filter((row) => row.rpcAvailable).length,
    rpcBlockedChains: rpcBlockedRows.length,
    tokenRows: tokenRows.length,
    tokenRowsWithCode: tokenRows.filter((row) => row.codePresent).length,
    solvbtcWrapperRows: tokenRows.filter((row) => row.tokenRole === "solvbtcWrapper").length,
    erc4626LikeRows: tokenRows.filter((row) => row.erc4626Like).length,
    contractRows: contractRows.length,
    contractRowsWithCode: contractRows.filter((row) => row.codePresent).length,
    depositRows: depositRows.length,
    depositRowsWithCode: depositRows.filter((row) => row.codePresent).length,
    materialDepositRows,
    trackedDepositBalanceUsd: round(depositRows.reduce((sum, row) => sum + (asNumber(row.totalTokenBalanceUsd) || 0), 0), 2),
    consumerJoinRows: consumerJoinRows.length,
    consumerGradeJoinRows,
    publicEconomicProbeRows: publicEconomicProbeRows.length,
    publicEconomicStaticSuccessRows,
    watchCandidates,
    exactEconomicsRows: 0,
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    forkJustified: false,
    blocker: "No SolvBTC row currently proves forged proof/mint/unlock, arbitrary public value movement, accepted-value divergence joined to live extractive consumer liquidity, or exact positive economics.",
  };

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-solvbtc-phase0.js",
    scope: "Read-only SolvBTC bridge/wrapped-BTC custody, proof/accounting, consumer-join, and no-borrow route Phase 0",
    target: { name: "SolvBTC", slug: "solvbtc", category: "Bridge", surface: "bridge-proof-custody-consumer", metadata: meta },
    safety: { publicApisOnlyForMetadata: true, rpcInventorySkipped: skipRpcInventory, rpcInventoryRead: !skipRpcInventory, rpcUrlsStored: false, privateKeysRead: false, signedActions: false, exploitExecuteCalls: false, forkTransactions: false, routePositive: false, executableNow: false, signedActionJustified: false },
    sources: { defillamaProtocol: PROTOCOL_URL, solvConfig: CONFIG_URL, adapter: "https://raw.githubusercontent.com/DefiLlama/DefiLlama-Adapters/main/projects/solvbtc/index.js" },
    thresholds: { minMaterialUsd: MIN_MATERIAL_USD },
    chainRows,
    rpcBlockedRows,
    tokenRows,
    depositRows,
    contractRows,
    topDepositBalances,
    consumerJoinRows,
    publicEconomicProbeRows,
    routePositiveRows: [],
    summary,
    requiredForRoutePositive: [
      "deployed proof/domain/nonce/token/recipient/finality bypass or mint/unlock/accounting edge",
      "wrapped SolvBTC asset accepted by a live lending/bridge/redeem/liquidation consumer with material liquidity",
      "exact acquisition/unlock/borrow/redeem/DEX exit economics positive after fees, caps, queues, finality, slippage, and gas",
      "fork/local extraction proof before any live action",
    ],
    nextReadOnlyStep: consumerGradeJoinRows ? "Review the joined consumer artifacts for exact accepted-value impact and quote only if an extractive path exists." : "Expand SolvBTC-specific consumer joins across lending markets, DEX LPs, and bridge wrappers before fork work.",
  };

  writeJson(RAW_OUT, artifact);
  ensureDir(REPORT_OUT);
  fs.writeFileSync(REPORT_OUT, buildReport(artifact));
  if (!QUIET) console.log(`SolvBTC Phase0: chains=${summary.rpcAvailableChains}/${summary.chainConfigs} deposits=${summary.depositRows} tracked=${formatUsd(summary.trackedDepositBalanceUsd)} joins=${summary.consumerJoinRows} probeOk=${summary.publicEconomicStaticSuccessRows} routePositive=${summary.routePositive}`);
}

main().catch((err) => {
  console.error(`scan-solvbtc-phase0 failed: ${err?.message || err}`);
  process.exit(1);
});
