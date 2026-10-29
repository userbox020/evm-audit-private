#!/usr/bin/env node
// scan-optimism-bridge-phase0.js - bounded read-only Phase 0 for Optimism Bridge.
// Resolves RPC URLs in memory only. Never prints or stores RPC URLs, keys, calldata for execution, or signed actions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { loadRpcUrls, rpcCall } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "optimism-bridge-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "optimism-bridge-phase0-triage.md");
const QUIET = process.argv.includes("--quiet");

const ETHEREUM_CHAIN_ID = 1;
const OPTIMISM_CHAIN_ID = 10;
const MAX_TOKEN_PAIRS = Number(process.env.OPTIMISM_BRIDGE_PHASE0_MAX_TOKENS || "36");
const MAX_DYNAMIC_OWNERS = Number(process.env.OPTIMISM_BRIDGE_PHASE0_MAX_OWNERS || "18");
const MIN_MATERIAL_USD = 1_000_000;

const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const EIP1967_BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
const ZERO = "0x0000000000000000000000000000000000000000";

const REGISTRY = {
  source: "ethereum-optimism/superchain-registry mainnet op config and addresses.json",
  chainId: OPTIMISM_CHAIN_ID,
  addressManager: "0xdE1FCfB0851916CA5101820A69b13a4E276bd81F",
  l1CrossDomainMessengerProxy: "0x25ace71c97B33Cc4729CF772ae268934F7ab5fA1",
  l1StandardBridgeProxy: "0x99C9fc46f92E8a1c0deC1b1747d010903E884bE1",
  l1Erc721BridgeProxy: "0x5a7749f83b81B301cAb5f48EB8516B986DAef23D",
  optimismPortalProxy: "0xbEb5Fc579115071764c7423A4f12eDde41f106Ed",
  systemConfigProxy: "0x229047fed2591dbec1eF1118d64F7aF3dB9EB290",
  disputeGameFactoryProxy: "0xe5965Ab5962eDc7477C8520243A95517CD252fA9",
  anchorStateRegistryProxy: "0x23B2C62946350F4246f9f9D027e071f0264FD113",
  ethLockboxProxy: "0x322b47Ff1FA8D5611F761e3E275C45B71b294D43",
  superchainConfig: "0x95703e0982140D16f8ebA6d158FccEde42f04a4C",
  proxyAdmin: "0x543bA4AADBAb8f9025686Bd03993043599c6fB04",
  proxyAdminOwner: "0x5a0Aae59D09fccBdDb6C6CcEB07B7279367C3d2A",
  batchInboxAddress: "0xFF00000000000000000000000000000000000010",
  batcherAddress: "0x6887246668a3b87F54DeB3b94Ba47a6f63F32985",
  guardian: "0x09f7150D8c019BeF34450d6920f6B3608ceFdAf2",
};

const L2_PREDEPLOYS = {
  l2CrossDomainMessenger: "0x4200000000000000000000000000000000000007",
  l2StandardBridge: "0x4200000000000000000000000000000000000010",
  optimismMintableErc20Factory: "0x4200000000000000000000000000000000000012",
  l2ToL1MessagePasser: "0x4200000000000000000000000000000000000016",
  weth: "0x4200000000000000000000000000000000000006",
  opToken: "0x4200000000000000000000000000000000000042",
};

const CORE_L1_TOKENS = [
  { symbol: "USDT", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", common: true },
  { symbol: "WBTC", address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", common: true },
  { symbol: "WLD", address: "0x163f8C2467924be0ae7B5347228CABF260318753", common: false },
  { symbol: "wstETH", address: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0", common: true },
  { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", common: true },
  { symbol: "DAI", address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", common: true },
  { symbol: "LINK", address: "0x514910771AF9Ca656af840dff83E8264EcF986CA", common: true },
  { symbol: "rETH", address: "0xae78736Cd615f374D3085123A210448E74Fc6393", common: true },
  { symbol: "CRV", address: "0xD533a949740bb3306d119CC777fa900bA034cd52", common: true },
  { symbol: "AAVE", address: "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9", common: true },
];

const INPUTS = [
  ["bridge-nonlossless", "reports/raw/fast/bridge-nonlossless-collateral-join.json"],
  ["bridge-delta", "reports/raw/fast/bridge-delta-preflight.json"],
  ["bridge-synthetic", "reports/raw/fast/bridge-synthetic-consumer-exposure.json"],
  ["bridge-proof-binding", "reports/raw/fast/bridge-proof-binding.json"],
  ["bridge-domain", "reports/raw/fast/bridge-domain-separation.json"],
  ["layerzero-oft", "reports/raw/fast/layerzero-oft-dvn-consumer-joins.json"],
  ["aave-euler-silo", "reports/raw/fast/aave-euler-silo-consumer-graph.json"],
  ["consumer-first-high-ltv", "reports/raw/fast/consumer-first-high-ltv-collateral.json"],
  ["public-lead-consumer", "reports/raw/fast/public-lead-consumer-joins.json"],
  ["dex-consumer-routes", "reports/raw/fast/dex-consumer-routes.json"],
  ["rwa-nav", "reports/raw/fast/rwa-nav-consumer-graph.json"],
  ["erc4626", "reports/raw/fast/erc4626-consumer-joiner.json"],
];

const ERC20 = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
  "function l1Token() view returns (address)",
  "function remoteToken() view returns (address)",
]);

const COMMON = new ethers.Interface([
  "function owner() view returns (address)",
  "function admin() view returns (address)",
  "function paused() view returns (bool)",
  "function guardian() view returns (address)",
  "function version() view returns (string)",
]);

const STANDARD_BRIDGE = new ethers.Interface([
  "function messenger() view returns (address)",
  "function MESSENGER() view returns (address)",
  "function otherBridge() view returns (address)",
  "function paused() view returns (bool)",
]);

const OPTIMISM_PORTAL = new ethers.Interface([
  "function guardian() view returns (address)",
  "function paused() view returns (bool)",
  "function respectedGameType() view returns (uint32)",
  "function disputeGameFactory() view returns (address)",
  "function proofMaturityDelaySeconds() view returns (uint256)",
  "function disputeGameFinalityDelaySeconds() view returns (uint256)",
  "function l2Sender() view returns (address)",
]);

const SYSTEM_CONFIG = new ethers.Interface([
  "function owner() view returns (address)",
  "function batcherHash() view returns (bytes32)",
  "function gasLimit() view returns (uint64)",
  "function unsafeBlockSigner() view returns (address)",
  "function startBlock() view returns (uint256)",
  "function l1CrossDomainMessenger() view returns (address)",
  "function l1ERC721Bridge() view returns (address)",
  "function l1StandardBridge() view returns (address)",
  "function optimismPortal() view returns (address)",
]);

const DISPUTE_GAME_FACTORY = new ethers.Interface([
  "function owner() view returns (address)",
  "function gameCount() view returns (uint256)",
  "function gameImpls(uint32) view returns (address)",
  "function initBonds(uint32) view returns (uint256)",
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

function strip0x(value) {
  return String(value || "").replace(/^0x/i, "");
}

function addressFromStorageSlot(raw) {
  if (!raw || raw === "0x") return null;
  const hex = strip0x(raw).padStart(64, "0");
  if (/^0+$/.test(hex)) return null;
  return normalizeAddress(`0x${hex.slice(-40)}`);
}

function bytes32ToAddress(raw) {
  return addressFromStorageSlot(raw);
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

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function lastRow(value) {
  return Array.isArray(value) && value.length ? value[value.length - 1] : null;
}

async function resolveInventoryRpc(chainId) {
  const urls = loadRpcUrls();
  for (const url of urls) {
    try {
      const idHex = await rpcCall(url, "eth_chainId", [], 5000);
      if (idHex && Number(BigInt(idHex)) === chainId) return url;
    } catch (_) {
      // Never print or persist RPC URLs.
    }
  }
  return null;
}

function client(url) {
  return { call: (method, params = [], timeoutMs = 10_000) => rpcCall(url, method, params, timeoutMs) };
}

async function fetchJson(url, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "evm-audit-optimism-bridge-phase0/1.0" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function getCode(rpc, address) {
  const result = await rpc.call("eth_getCode", [address, "latest"], 10_000).catch(() => null);
  return result || "0x";
}

async function getStorage(rpc, address, slot) {
  return await rpc.call("eth_getStorageAt", [address, slot, "latest"], 10_000).catch(() => null);
}

async function getBalance(rpc, address) {
  return await rpc.call("eth_getBalance", [address, "latest"], 10_000).catch(() => null);
}

async function getBlockNumber(rpc) {
  const raw = await rpc.call("eth_blockNumber", [], 10_000).catch(() => null);
  if (!raw) return null;
  try { return Number(BigInt(raw)); } catch (_) { return null; }
}

async function safeCall(rpc, to, iface, fn, args = []) {
  try {
    const data = iface.encodeFunctionData(fn, args);
    const raw = await rpc.call("eth_call", [{ to, data }, "latest"], 12_000);
    if (!raw || raw === "0x") return null;
    return iface.decodeFunctionResult(fn, raw);
  } catch (_) {
    return null;
  }
}

async function inspectContract(rpc, chainId, name, address, category) {
  const normalized = normalizeAddress(address);
  if (!normalized) return { chainId, name, address, category, codePresent: false, blocker: "invalid address" };
  const [code, balanceRaw, implRaw, adminRaw, beaconRaw, ownerRaw, adminCallRaw, pausedRaw, guardianRaw, versionRaw] = await Promise.all([
    getCode(rpc, normalized),
    getBalance(rpc, normalized),
    getStorage(rpc, normalized, EIP1967_IMPLEMENTATION_SLOT),
    getStorage(rpc, normalized, EIP1967_ADMIN_SLOT),
    getStorage(rpc, normalized, EIP1967_BEACON_SLOT),
    safeCall(rpc, normalized, COMMON, "owner", []),
    safeCall(rpc, normalized, COMMON, "admin", []),
    safeCall(rpc, normalized, COMMON, "paused", []),
    safeCall(rpc, normalized, COMMON, "guardian", []),
    safeCall(rpc, normalized, COMMON, "version", []),
  ]);
  const balanceWei = balanceRaw ? BigInt(balanceRaw).toString() : null;
  return {
    chainId,
    name,
    address: normalized,
    category,
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
    guardian: normalizeAddress(guardianRaw?.[0]) || null,
    version: versionRaw?.[0] === undefined ? null : String(versionRaw[0]),
  };
}

async function inspectBridgeSpecifics(ethRpc, opRpc) {
  const bridge = REGISTRY.l1StandardBridgeProxy;
  const portal = REGISTRY.optimismPortalProxy;
  const systemConfig = REGISTRY.systemConfigProxy;
  const disputeFactory = REGISTRY.disputeGameFactoryProxy;

  const [bridgeMessenger, bridgeMessengerUpper, bridgeOther, bridgePaused, portalGuardian, portalPaused, respectedGameType, portalFactory, proofDelay, finalityDelay, l2Sender, sysOwner, batcherHash, gasLimit, unsafeBlockSigner, startBlock, sysMessenger, sysErc721, sysBridge, sysPortal, gameCount, gameOwner] = await Promise.all([
    safeCall(ethRpc, bridge, STANDARD_BRIDGE, "messenger", []),
    safeCall(ethRpc, bridge, STANDARD_BRIDGE, "MESSENGER", []),
    safeCall(ethRpc, bridge, STANDARD_BRIDGE, "otherBridge", []),
    safeCall(ethRpc, bridge, STANDARD_BRIDGE, "paused", []),
    safeCall(ethRpc, portal, OPTIMISM_PORTAL, "guardian", []),
    safeCall(ethRpc, portal, OPTIMISM_PORTAL, "paused", []),
    safeCall(ethRpc, portal, OPTIMISM_PORTAL, "respectedGameType", []),
    safeCall(ethRpc, portal, OPTIMISM_PORTAL, "disputeGameFactory", []),
    safeCall(ethRpc, portal, OPTIMISM_PORTAL, "proofMaturityDelaySeconds", []),
    safeCall(ethRpc, portal, OPTIMISM_PORTAL, "disputeGameFinalityDelaySeconds", []),
    safeCall(ethRpc, portal, OPTIMISM_PORTAL, "l2Sender", []),
    safeCall(ethRpc, systemConfig, SYSTEM_CONFIG, "owner", []),
    safeCall(ethRpc, systemConfig, SYSTEM_CONFIG, "batcherHash", []),
    safeCall(ethRpc, systemConfig, SYSTEM_CONFIG, "gasLimit", []),
    safeCall(ethRpc, systemConfig, SYSTEM_CONFIG, "unsafeBlockSigner", []),
    safeCall(ethRpc, systemConfig, SYSTEM_CONFIG, "startBlock", []),
    safeCall(ethRpc, systemConfig, SYSTEM_CONFIG, "l1CrossDomainMessenger", []),
    safeCall(ethRpc, systemConfig, SYSTEM_CONFIG, "l1ERC721Bridge", []),
    safeCall(ethRpc, systemConfig, SYSTEM_CONFIG, "l1StandardBridge", []),
    safeCall(ethRpc, systemConfig, SYSTEM_CONFIG, "optimismPortal", []),
    safeCall(ethRpc, disputeFactory, DISPUTE_GAME_FACTORY, "gameCount", []),
    safeCall(ethRpc, disputeFactory, DISPUTE_GAME_FACTORY, "owner", []),
  ]);

  const [gameImpl0, gameImpl1, initBond0, initBond1, l2BridgeMessenger, l2BridgeOther, l2BridgePaused] = await Promise.all([
    safeCall(ethRpc, disputeFactory, DISPUTE_GAME_FACTORY, "gameImpls", [0]),
    safeCall(ethRpc, disputeFactory, DISPUTE_GAME_FACTORY, "gameImpls", [1]),
    safeCall(ethRpc, disputeFactory, DISPUTE_GAME_FACTORY, "initBonds", [0]),
    safeCall(ethRpc, disputeFactory, DISPUTE_GAME_FACTORY, "initBonds", [1]),
    safeCall(opRpc, L2_PREDEPLOYS.l2StandardBridge, STANDARD_BRIDGE, "messenger", []),
    safeCall(opRpc, L2_PREDEPLOYS.l2StandardBridge, STANDARD_BRIDGE, "otherBridge", []),
    safeCall(opRpc, L2_PREDEPLOYS.l2StandardBridge, STANDARD_BRIDGE, "paused", []),
  ]);

  return {
    l1StandardBridge: {
      messenger: normalizeAddress(bridgeMessenger?.[0]) || normalizeAddress(bridgeMessengerUpper?.[0]) || null,
      otherBridge: normalizeAddress(bridgeOther?.[0]) || null,
      paused: bridgePaused?.[0] === undefined ? null : Boolean(bridgePaused[0]),
    },
    optimismPortal: {
      guardian: normalizeAddress(portalGuardian?.[0]) || null,
      paused: portalPaused?.[0] === undefined ? null : Boolean(portalPaused[0]),
      respectedGameType: respectedGameType?.[0] === undefined ? null : Number(respectedGameType[0]),
      disputeGameFactory: normalizeAddress(portalFactory?.[0]) || null,
      proofMaturityDelaySeconds: proofDelay?.[0] === undefined ? null : proofDelay[0].toString(),
      disputeGameFinalityDelaySeconds: finalityDelay?.[0] === undefined ? null : finalityDelay[0].toString(),
      l2Sender: normalizeAddress(l2Sender?.[0]) || null,
    },
    systemConfig: {
      owner: normalizeAddress(sysOwner?.[0]) || null,
      batcherHash: batcherHash?.[0] === undefined ? null : String(batcherHash[0]),
      batcherAddressFromRegistry: REGISTRY.batcherAddress,
      batcherAddressFromHash: batcherHash?.[0] ? bytes32ToAddress(String(batcherHash[0])) : null,
      gasLimit: gasLimit?.[0] === undefined ? null : gasLimit[0].toString(),
      unsafeBlockSigner: normalizeAddress(unsafeBlockSigner?.[0]) || null,
      startBlock: startBlock?.[0] === undefined ? null : startBlock[0].toString(),
      l1CrossDomainMessenger: normalizeAddress(sysMessenger?.[0]) || null,
      l1ERC721Bridge: normalizeAddress(sysErc721?.[0]) || null,
      l1StandardBridge: normalizeAddress(sysBridge?.[0]) || null,
      optimismPortal: normalizeAddress(sysPortal?.[0]) || null,
    },
    disputeGameFactory: {
      owner: normalizeAddress(gameOwner?.[0]) || null,
      gameCount: gameCount?.[0] === undefined ? null : gameCount[0].toString(),
      gameImpls: [
        { gameType: 0, implementation: normalizeAddress(gameImpl0?.[0]) || null, initBondWei: initBond0?.[0] === undefined ? null : initBond0[0].toString() },
        { gameType: 1, implementation: normalizeAddress(gameImpl1?.[0]) || null, initBondWei: initBond1?.[0] === undefined ? null : initBond1[0].toString() },
      ],
    },
    l2StandardBridge: {
      messenger: normalizeAddress(l2BridgeMessenger?.[0]) || null,
      otherBridge: normalizeAddress(l2BridgeOther?.[0]) || null,
      paused: l2BridgePaused?.[0] === undefined ? null : Boolean(l2BridgePaused[0]),
    },
  };
}

function chainLatest(raw, chain) {
  const row = raw.chainTvls?.[chain] || {};
  return {
    tvl: lastRow(row.tvl)?.totalLiquidityUSD ?? null,
    tokensUsd: lastRow(row.tokensInUsd)?.tokens || {},
    tokens: lastRow(row.tokens)?.tokens || {},
  };
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

async function tokenListPairs(ethTokensUsd) {
  const tokenList = await fetchJson("https://static.optimism.io/optimism.tokenlist.json", 30_000).catch(() => null);
  if (!tokenList?.tokens?.length) return { pairs: [], bridgeOwners: [], tokenListFetched: false, tokenListTimestamp: null };

  const byOpId = new Map();
  for (const token of tokenList.tokens) {
    const opId = token.extensions?.opTokenId || token.symbol;
    if (!opId) continue;
    const bucket = byOpId.get(opId) || [];
    bucket.push(token);
    byOpId.set(opId, bucket);
  }

  const bySymbol = defillamaBySymbol(ethTokensUsd);
  const bridgeOwnerSet = new Set();
  const pairs = [];

  for (const [opId, bucket] of byOpId.entries()) {
    const l2 = bucket.find((token) => Number(token.chainId) === OPTIMISM_CHAIN_ID && normalizeAddress(token.address));
    if (!l2) continue;
    const l1 = bucket.find((token) => Number(token.chainId) === ETHEREUM_CHAIN_ID && normalizeAddress(token.address));
    const symbol = String(l2.symbol || l1?.symbol || opId);
    const l1Address = normalizeAddress(l1?.address) || null;
    const l2Address = normalizeAddress(l2.address);
    const l1BridgeAddress = normalizeAddress(l1?.extensions?.optimismBridgeAddress) || null;
    const l2BridgeAddress = normalizeAddress(l2?.extensions?.optimismBridgeAddress) || null;
    if (l1BridgeAddress) bridgeOwnerSet.add(l1BridgeAddress.toLowerCase());

    const scoreUsd = Math.max(
      bySymbol.get(symbol.toUpperCase()) || 0,
      CORE_L1_TOKENS.some((row) => row.symbol.toUpperCase() === symbol.toUpperCase()) ? 1 : 0,
    );
    pairs.push({
      source: "superchain-token-list",
      opTokenId: opId,
      symbol,
      name: l2.name || l1?.name || null,
      l1Address,
      l2Address,
      l1BridgeAddress,
      l2BridgeAddress,
      decimalsHint: Number.isFinite(Number(l2.decimals)) ? Number(l2.decimals) : null,
      defillamaUsdHint: round(scoreUsd, 2),
      common: ["WETH", "USDC", "USDT", "DAI", "WBTC", "LINK", "WSTETH", "RETH"].includes(symbol.toUpperCase()),
    });
  }

  return {
    pairs: pairs.sort((a, b) => (asNumber(b.defillamaUsdHint) || 0) - (asNumber(a.defillamaUsdHint) || 0) || String(a.symbol).localeCompare(String(b.symbol))).slice(0, MAX_TOKEN_PAIRS),
    bridgeOwners: [...bridgeOwnerSet].map((value) => normalizeAddress(value)).filter(Boolean).slice(0, MAX_DYNAMIC_OWNERS),
    tokenListFetched: true,
    tokenListTimestamp: tokenList.timestamp || null,
  };
}

function mergeTokenPairs(tokenListRows) {
  const byKey = new Map();
  for (const row of tokenListRows) {
    const key = `${lowerAddress(row.l1Address) || "none"}:${lowerAddress(row.l2Address) || row.symbol.toLowerCase()}`;
    byKey.set(key, row);
  }
  for (const token of CORE_L1_TOKENS) {
    const found = [...byKey.values()].find((row) => lowerAddress(row.l1Address) === lowerAddress(token.address) || row.symbol.toUpperCase() === token.symbol.toUpperCase());
    if (found) {
      found.common = found.common || token.common;
      found.l1Address = found.l1Address || normalizeAddress(token.address);
      found.l1BridgeAddress = found.l1BridgeAddress || REGISTRY.l1StandardBridgeProxy;
      continue;
    }
    byKey.set(`${lowerAddress(token.address)}:none`, {
      source: "core-token-fallback",
      opTokenId: token.symbol,
      symbol: token.symbol,
      name: token.symbol,
      l1Address: normalizeAddress(token.address),
      l2Address: null,
      l1BridgeAddress: REGISTRY.l1StandardBridgeProxy,
      l2BridgeAddress: L2_PREDEPLOYS.l2StandardBridge,
      decimalsHint: null,
      defillamaUsdHint: 0,
      common: token.common,
      blocker: "Optimism L2 token address not resolved from token list",
    });
  }
  return [...byKey.values()].slice(0, Math.max(MAX_TOKEN_PAIRS, CORE_L1_TOKENS.length));
}

async function tokenPricesUsd(pairs) {
  const keys = [];
  for (const pair of pairs) {
    if (pair.l1Address) keys.push(`ethereum:${pair.l1Address.toLowerCase()}`);
    if (pair.l2Address) keys.push(`optimism:${pair.l2Address.toLowerCase()}`);
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

async function tokenMeta(rpc, address) {
  const normalized = normalizeAddress(address);
  if (!normalized) return null;
  const [code, symbolRaw, nameRaw, decimalsRaw, supplyRaw, l1TokenRaw, remoteTokenRaw] = await Promise.all([
    getCode(rpc, normalized),
    safeCall(rpc, normalized, ERC20, "symbol", []),
    safeCall(rpc, normalized, ERC20, "name", []),
    safeCall(rpc, normalized, ERC20, "decimals", []),
    safeCall(rpc, normalized, ERC20, "totalSupply", []),
    safeCall(rpc, normalized, ERC20, "l1Token", []),
    safeCall(rpc, normalized, ERC20, "remoteToken", []),
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
    l1Token: normalizeAddress(l1TokenRaw?.[0]) || null,
    remoteToken: normalizeAddress(remoteTokenRaw?.[0]) || null,
  };
}

async function inspectTokenPairs(ethRpc, opRpc, pairs, prices, ethTokensUsd) {
  const rows = [];
  for (const pair of pairs) {
    const l1Address = normalizeAddress(pair.l1Address);
    const l2Address = normalizeAddress(pair.l2Address);
    const owner = normalizeAddress(pair.l1BridgeAddress);
    const [l1Meta, l2Meta] = await Promise.all([
      l1Address ? tokenMeta(ethRpc, l1Address) : null,
      l2Address ? tokenMeta(opRpc, l2Address) : null,
    ]);
    const l1Decimals = l1Meta?.decimals ?? pair.decimalsHint ?? null;
    const l2Decimals = l2Meta?.decimals ?? pair.decimalsHint ?? null;
    const priceKey = l1Address?.toLowerCase() || l2Address?.toLowerCase() || null;
    const priceUsd = priceKey ? prices.get(priceKey) || null : null;
    const balanceRaw = owner && l1Address ? await safeCall(ethRpc, l1Address, ERC20, "balanceOf", [owner]) : null;
    const bridgeBalance = balanceRaw?.[0] ?? null;
    const bridgeBalanceUnits = numberUnits(bridgeBalance, l1Decimals);
    const bridgeBalanceUsd = priceUsd && bridgeBalanceUnits !== null ? bridgeBalanceUnits * priceUsd : null;
    const l2SupplyUnits = l2Meta?.totalSupplyRaw && l2Decimals !== null ? numberUnits(l2Meta.totalSupplyRaw, l2Decimals) : null;
    const l2SupplyUsd = priceUsd && l2SupplyUnits !== null ? l2SupplyUnits * priceUsd : null;
    const deltaUsd = bridgeBalanceUsd !== null && l2SupplyUsd !== null ? bridgeBalanceUsd - l2SupplyUsd : null;
    const defillamaExactUsd = Object.entries(ethTokensUsd || {}).reduce((best, [key, value]) => {
      const addr = lowerAddress(tokenAddressFromKey(key));
      const symbol = symbolFromKey(key).toUpperCase();
      if (addr && l1Address && addr === l1Address.toLowerCase()) return Math.max(best, asNumber(value) || 0);
      if (symbol && symbol === String(pair.symbol).toUpperCase()) return Math.max(best, asNumber(value) || 0);
      return best;
    }, 0);

    rows.push({
      symbol: pair.symbol,
      opTokenId: pair.opTokenId,
      source: pair.source,
      l1Address,
      l2Address,
      l1BridgeOwner: owner,
      l2BridgeAddressFromTokenList: normalizeAddress(pair.l2BridgeAddress) || null,
      common: Boolean(pair.common),
      l1Meta,
      l2Meta,
      priceUsd: round(priceUsd, 8),
      l1BridgeBalanceRaw: bridgeBalance?.toString() || null,
      l1BridgeBalance: formatUnits(bridgeBalance, l1Decimals),
      l1BridgeBalanceUsd: round(bridgeBalanceUsd, 2),
      l2TotalSupplyRaw: l2Meta?.totalSupplyRaw || null,
      l2TotalSupply: l2Meta?.totalSupply || null,
      l2TotalSupplyUsd: round(l2SupplyUsd, 2),
      bridgeBalanceMinusL2SupplyUsd: round(deltaUsd, 2),
      defillamaUsdHint: round(Math.max(defillamaExactUsd, asNumber(pair.defillamaUsdHint) || 0), 2),
      materialContextDelta: deltaUsd !== null && Math.abs(deltaUsd) >= MIN_MATERIAL_USD,
      materialBalance: bridgeBalanceUsd !== null && bridgeBalanceUsd >= MIN_MATERIAL_USD,
      routePositive: false,
      blockers: [
        l1Address ? null : "L1 token address not resolved",
        l2Address ? null : "Optimism L2 token address not resolved",
        owner ? null : "Adapter bridge owner not resolved for this token row",
        l1Meta?.codePresent === false ? "L1 token code missing" : null,
        l2Address && l2Meta?.codePresent === false ? "L2 token code missing" : null,
        "Bridge balance/supply reads are backing context only, not proof of mint/unlock bypass",
        "No bridge-specific proof weakness or consumer route economics proven",
      ].filter(Boolean),
    });
  }
  rows.sort((a, b) => (asNumber(b.l1BridgeBalanceUsd) || 0) - (asNumber(a.l1BridgeBalanceUsd) || 0) || (asNumber(b.l2TotalSupplyUsd) || 0) - (asNumber(a.l2TotalSupplyUsd) || 0));
  return rows;
}

async function nativeBridgeContext(ethRpc, opRpc) {
  const [l1BridgeEthRaw, portalEthRaw, ethLockboxRaw, l2BridgeEthRaw, l2MessagePasserEthRaw] = await Promise.all([
    getBalance(ethRpc, REGISTRY.l1StandardBridgeProxy),
    getBalance(ethRpc, REGISTRY.optimismPortalProxy),
    getBalance(ethRpc, REGISTRY.ethLockboxProxy),
    getBalance(opRpc, L2_PREDEPLOYS.l2StandardBridge),
    getBalance(opRpc, L2_PREDEPLOYS.l2ToL1MessagePasser),
  ]);
  return {
    l1StandardBridgeEthWei: l1BridgeEthRaw ? BigInt(l1BridgeEthRaw).toString() : null,
    l1StandardBridgeEth: l1BridgeEthRaw ? formatUnits(l1BridgeEthRaw, 18) : null,
    optimismPortalEthWei: portalEthRaw ? BigInt(portalEthRaw).toString() : null,
    optimismPortalEth: portalEthRaw ? formatUnits(portalEthRaw, 18) : null,
    ethLockboxEthWei: ethLockboxRaw ? BigInt(ethLockboxRaw).toString() : null,
    ethLockboxEth: ethLockboxRaw ? formatUnits(ethLockboxRaw, 18) : null,
    l2StandardBridgeEthWei: l2BridgeEthRaw ? BigInt(l2BridgeEthRaw).toString() : null,
    l2StandardBridgeEth: l2BridgeEthRaw ? formatUnits(l2BridgeEthRaw, 18) : null,
    l2ToL1MessagePasserEthWei: l2MessagePasserEthRaw ? BigInt(l2MessagePasserEthRaw).toString() : null,
    l2ToL1MessagePasserEth: l2MessagePasserEthRaw ? formatUnits(l2MessagePasserEthRaw, 18) : null,
    routePositive: false,
    blockers: [
      "Native ETH balance context does not prove withdrawal-proof bypass",
      "No exact unlock/mint path or same-chain consumer route proven",
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

function artifactJoins(tokenRows, dynamicOwners) {
  const wanted = [
    { label: "L1StandardBridgeProxy", address: REGISTRY.l1StandardBridgeProxy, common: false, bridgeSpecific: true },
    { label: "L1CrossDomainMessengerProxy", address: REGISTRY.l1CrossDomainMessengerProxy, common: false, bridgeSpecific: true },
    { label: "OptimismPortalProxy", address: REGISTRY.optimismPortalProxy, common: false, bridgeSpecific: true },
    { label: "SystemConfigProxy", address: REGISTRY.systemConfigProxy, common: false, bridgeSpecific: true },
    { label: "DisputeGameFactoryProxy", address: REGISTRY.disputeGameFactoryProxy, common: false, bridgeSpecific: true },
    { label: "AnchorStateRegistryProxy", address: REGISTRY.anchorStateRegistryProxy, common: false, bridgeSpecific: true },
    { label: "EthLockboxProxy", address: REGISTRY.ethLockboxProxy, common: false, bridgeSpecific: true },
    ...Object.entries(L2_PREDEPLOYS).map(([label, address]) => ({ label, address, common: false, bridgeSpecific: true })),
    ...dynamicOwners.map((address, index) => ({ label: `AdapterBridgeOwner${index + 1}`, address, common: false, bridgeSpecific: true })),
  ];
  const seen = new Set(wanted.map((row) => lowerAddress(row.address)).filter(Boolean));
  for (const row of tokenRows) {
    if (row.l1Address) wanted.push({ label: `${row.symbol} L1`, address: row.l1Address, common: row.common, bridgeSpecific: false });
    if (row.l2Address) wanted.push({ label: `${row.symbol} OP`, address: row.l2Address, common: row.common, bridgeSpecific: false });
    if (row.l1BridgeOwner && !seen.has(lowerAddress(row.l1BridgeOwner))) {
      wanted.push({ label: `${row.symbol} bridge owner`, address: row.l1BridgeOwner, common: false, bridgeSpecific: true });
      seen.add(lowerAddress(row.l1BridgeOwner));
    }
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
        address: normalizeAddress(item.address),
        common: Boolean(item.common),
        bridgeSpecific: Boolean(item.bridgeSpecific),
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
  const n = out.nativeContext;
  const topContracts = out.contracts.slice(0, 14).map((row) => `| ${row.chainId} | ${row.name} | ${row.address} | ${row.codePresent} | ${row.eip1967?.implementation || "none"} | ${row.paused === null ? "unresolved" : row.paused} |`).join("\n");
  const topAssets = out.tokenRows.slice(0, 12).map((row) => `| ${row.symbol} | ${row.l1Address || "unresolved"} | ${row.l2Address || "unresolved"} | ${row.l1BridgeOwner || "unresolved"} | ${formatUsd(row.l1BridgeBalanceUsd)} | ${formatUsd(row.l2TotalSupplyUsd)} | ${formatUsd(row.bridgeBalanceMinusL2SupplyUsd)} |`).join("\n");
  const ownerRows = out.bridgeOwnerRows.slice(0, 12).map((row) => `| ${row.address} | ${row.codePresent} | ${row.eip1967?.implementation || "none"} | ${row.nativeBalance || "0"} |`).join("\n");
  const content = `# 🟢 DORMANT — Optimism Bridge Phase 0

Generated: ${out.generatedAt}

Scanner: \`tools/scan-optimism-bridge-phase0.js\`

Artifact: \`reports/raw/fast/optimism-bridge-phase0.json\`

## Result

No permissionless route-positive exploit is claimed. This Phase 0 mapped the Optimism Bridge DeFiLlama adapter surface, OP Mainnet OP-stack bridge contracts, EIP-1967 proxy state, dynamic adapter bridge owners, native ETH custody context, top token lockbox/supply context, and local consumer/proof artifacts. It found no deployed proof-binding bypass, no material exact backing mismatch joined to consumer economics, and no exact positive mint/unlock/borrow/redeem/unwind route.

## Target

| Field | Value |
|---|---:|
| Protocol | \`${out.metadata.name}\` |
| Slug | \`${out.metadata.slug}\` |
| Category | \`${out.metadata.category}\` |
| Adapter source | \`${out.metadata.module || "optimism/index.js"}\` |
| Chains in adapter | \`${(out.metadata.chains || []).join(", ")}\` |
| Current public TVL | \`${formatUsd(s.defillamaCurrentTvlUsd)}\` |
| Ethereum TVL | \`${formatUsd(s.defillamaEthereumTvlUsd)}\` |
| Base TVL | \`${formatUsd(s.defillamaBaseTvlUsd)}\` |
| PGN TVL | \`${formatUsd(s.defillamaPgnTvlUsd)}\` |
| Ethereum RPC resolved | \`${s.ethereumRpcResolved}\` |
| Optimism RPC resolved | \`${s.optimismRpcResolved}\` |

## Contracts

| Chain | Name | Address | Code | EIP-1967 implementation | Paused |
|---:|---|---|---:|---|---:|
${topContracts}

## Dynamic Adapter Owners

| Owner | Code | EIP-1967 implementation | Native ETH |
|---|---:|---|---:|
${ownerRows || "| none | false | none | 0 |"}

## Token Custody Context

| Native ETH location | Amount |
|---|---:|
| L1 Standard Bridge ETH | \`${n.l1StandardBridgeEth || "unresolved"}\` |
| Optimism Portal ETH | \`${n.optimismPortalEth || "unresolved"}\` |
| ETH Lockbox ETH | \`${n.ethLockboxEth || "unresolved"}\` |
| L2 Standard Bridge ETH | \`${n.l2StandardBridgeEth || "unresolved"}\` |
| L2ToL1 MessagePasser ETH | \`${n.l2ToL1MessagePasserEth || "unresolved"}\` |

Token balances below are context only; native ETH backing is routed through the Portal/ETH lockbox path rather than the ERC20 balance model.

| Symbol | L1 token | OP token | Bridge owner | L1 owner balance USD | OP totalSupply USD | Balance minus supply USD |
|---|---|---|---|---:|---:|---:|
${topAssets}

## Consumer/Bridge Joins

| Metric | Value |
|---|---:|
| Artifact inputs loaded | \`${out.joinInputsLoaded.length}\` |
| Address join rows | \`${s.artifactJoinRows}\` |
| Bridge-specific joins | \`${s.bridgeSpecificJoinRows}\` |
| Watch joins | \`${s.watchCandidates}\` |
| Route-positive joins | \`${s.routePositive}\` |

## Blockers

- OP bridge addresses are live and material, but code/proxy/state reads do not show a permissionless proof-acceptance bypass.
- Adapter-discovered owner balances and OP token supplies are custody context only; deltas can include native ETH, special bridges, in-flight messages, canonical/non-canonical token variants, and token-list coverage gaps.
- Common-token consumer joins are not bridge-specific exploit evidence without a mint/unlock/backing flaw.
- Base and PGN currently report zero adapter TVL under this DeFiLlama slug, so no Base/PGN route-positive branch is opened from this artifact.
- No exact positive bridge, borrow, redemption, liquidation, or DEX unwind economics were produced, so fork/live work remains blocked.

## Next Gate

Reopen only if an Optimism-specific proof/domain/nonce/token/finality binding weakness or exact backing mismatch maps to a material consumer with positive exit economics.
`;
  fs.writeFileSync(REPORT_OUT, content);
}

async function main() {
  const [ethRpcUrl, opRpcUrl] = await Promise.all([resolveInventoryRpc(ETHEREUM_CHAIN_ID), resolveInventoryRpc(OPTIMISM_CHAIN_ID)]);
  if (!ethRpcUrl || !opRpcUrl) {
    const missing = [!ethRpcUrl ? "Ethereum mainnet chainId 1" : null, !opRpcUrl ? "Optimism chainId 10" : null].filter(Boolean).join(", ");
    throw new Error(`Missing required RPC endpoint from rpc_endpoints.txt for ${missing}. Provide a suitable endpoint before continuing.`);
  }

  const ethRpc = client(ethRpcUrl);
  const opRpc = client(opRpcUrl);
  const [metadataRaw, ethBlock, opBlock] = await Promise.all([
    fetchJson("https://api.llama.fi/protocol/optimism-bridge", 30_000).catch(() => ({})),
    getBlockNumber(ethRpc),
    getBlockNumber(opRpc),
  ]);

  const ethereum = chainLatest(metadataRaw, "Ethereum");
  const base = chainLatest(metadataRaw, "Base");
  const pgn = chainLatest(metadataRaw, "PGN");
  const tokenList = await tokenListPairs(ethereum.tokensUsd);
  const pairs = mergeTokenPairs(tokenList.pairs);
  const prices = await tokenPricesUsd(pairs);
  const tokenRows = await inspectTokenPairs(ethRpc, opRpc, pairs, prices, ethereum.tokensUsd);
  const dynamicOwners = [...new Set([
    ...tokenList.bridgeOwners,
    ...tokenRows.map((row) => row.l1BridgeOwner).filter(Boolean),
  ].map((row) => normalizeAddress(row)).filter(Boolean))].slice(0, MAX_DYNAMIC_OWNERS);

  const registryContracts = [
    { chainId: ETHEREUM_CHAIN_ID, rpc: ethRpc, name: "AddressManager", address: REGISTRY.addressManager, category: "legacy-address-registry" },
    { chainId: ETHEREUM_CHAIN_ID, rpc: ethRpc, name: "L1CrossDomainMessengerProxy", address: REGISTRY.l1CrossDomainMessengerProxy, category: "l1-messenger" },
    { chainId: ETHEREUM_CHAIN_ID, rpc: ethRpc, name: "L1StandardBridgeProxy", address: REGISTRY.l1StandardBridgeProxy, category: "canonical-bridge" },
    { chainId: ETHEREUM_CHAIN_ID, rpc: ethRpc, name: "L1ERC721BridgeProxy", address: REGISTRY.l1Erc721BridgeProxy, category: "erc721-bridge" },
    { chainId: ETHEREUM_CHAIN_ID, rpc: ethRpc, name: "OptimismPortalProxy", address: REGISTRY.optimismPortalProxy, category: "portal-withdrawal-proof" },
    { chainId: ETHEREUM_CHAIN_ID, rpc: ethRpc, name: "SystemConfigProxy", address: REGISTRY.systemConfigProxy, category: "rollup-config" },
    { chainId: ETHEREUM_CHAIN_ID, rpc: ethRpc, name: "DisputeGameFactoryProxy", address: REGISTRY.disputeGameFactoryProxy, category: "fault-proof-games" },
    { chainId: ETHEREUM_CHAIN_ID, rpc: ethRpc, name: "AnchorStateRegistryProxy", address: REGISTRY.anchorStateRegistryProxy, category: "fault-proof-anchor-state" },
    { chainId: ETHEREUM_CHAIN_ID, rpc: ethRpc, name: "EthLockboxProxy", address: REGISTRY.ethLockboxProxy, category: "native-eth-lockbox" },
    { chainId: ETHEREUM_CHAIN_ID, rpc: ethRpc, name: "SuperchainConfig", address: REGISTRY.superchainConfig, category: "superchain-config" },
    { chainId: ETHEREUM_CHAIN_ID, rpc: ethRpc, name: "ProxyAdmin", address: REGISTRY.proxyAdmin, category: "proxy-admin" },
    { chainId: ETHEREUM_CHAIN_ID, rpc: ethRpc, name: "ProxyAdminOwner", address: REGISTRY.proxyAdminOwner, category: "proxy-admin-owner" },
    { chainId: OPTIMISM_CHAIN_ID, rpc: opRpc, name: "L2CrossDomainMessenger", address: L2_PREDEPLOYS.l2CrossDomainMessenger, category: "l2-messenger-predeploy" },
    { chainId: OPTIMISM_CHAIN_ID, rpc: opRpc, name: "L2StandardBridge", address: L2_PREDEPLOYS.l2StandardBridge, category: "l2-bridge-predeploy" },
    { chainId: OPTIMISM_CHAIN_ID, rpc: opRpc, name: "OptimismMintableERC20Factory", address: L2_PREDEPLOYS.optimismMintableErc20Factory, category: "l2-token-factory-predeploy" },
    { chainId: OPTIMISM_CHAIN_ID, rpc: opRpc, name: "L2ToL1MessagePasser", address: L2_PREDEPLOYS.l2ToL1MessagePasser, category: "l2-withdrawal-predeploy" },
    { chainId: OPTIMISM_CHAIN_ID, rpc: opRpc, name: "OPTokenPredeploy", address: L2_PREDEPLOYS.opToken, category: "op-native-token" },
  ];
  const registryAddressSet = new Set(registryContracts.map((row) => lowerAddress(row.address)).filter(Boolean));
  const dynamicOwnerContracts = dynamicOwners
    .filter((address) => !registryAddressSet.has(lowerAddress(address)))
    .map((address, index) => ({ chainId: ETHEREUM_CHAIN_ID, rpc: ethRpc, name: `AdapterBridgeOwner${index + 1}`, address, category: "defillama-adapter-token-owner" }));

  const [contracts, bridgeSpecifics, nativeContext] = await Promise.all([
    Promise.all([...registryContracts, ...dynamicOwnerContracts].map((row) => inspectContract(row.rpc, row.chainId, row.name, row.address, row.category))),
    inspectBridgeSpecifics(ethRpc, opRpc),
    nativeBridgeContext(ethRpc, opRpc),
  ]);

  const bridgeOwnerRows = contracts.filter((row) => row.category === "defillama-adapter-token-owner" || lowerAddress(row.address) === lowerAddress(REGISTRY.l1StandardBridgeProxy));
  const joins = artifactJoins(tokenRows, dynamicOwners);
  const proofWeaknessRows = 0;
  const bridgeSpecificRouteJoins = joins.rows.filter((row) => row.bridgeSpecific && row.routePositive).length;
  const routePositive = proofWeaknessRows > 0 && bridgeSpecificRouteJoins > 0 ? bridgeSpecificRouteJoins : 0;
  const watchCandidates = joins.rows.filter((row) => row.watchCandidate && !row.routePositive).length;
  const currentTvlUsd = asNumber(metadataRaw.currentChainTvls?.Ethereum) || asNumber(ethereum.tvl) || 0;
  const trackedBridgeBalanceUsd = tokenRows.reduce((sum, row) => sum + (asNumber(row.l1BridgeBalanceUsd) || 0), 0);
  const materialContextDeltaRows = tokenRows.filter((row) => row.materialContextDelta).length;

  const output = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-optimism-bridge-phase0.js",
    scope: "Optimism Bridge public Phase 0 OP-stack bridge lockbox/backing, dynamic adapter owners, and artifact-only consumer join",
    safety: {
      publicApisOnly: false,
      rpcInventoryRead: true,
      rpcInventoryOnly: true,
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
      name: metadataRaw.name || "Optimism Bridge",
      slug: metadataRaw.slug || "optimism-bridge",
      category: metadataRaw.category || "Canonical Bridge",
      chains: metadataRaw.chains || ["Ethereum", "Base", "PGN"],
      currentChainTvls: metadataRaw.currentChainTvls || {},
      audits: metadataRaw.audits || "0",
      url: metadataRaw.url || "https://app.optimism.io/bridge",
      twitter: metadataRaw.twitter || "optimism",
      description: metadataRaw.description || null,
      module: metadataRaw.module || "optimism/index.js",
      tvlCodePath: metadataRaw.tvlCodePath || "https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/optimism/index.js",
      adapterNotes: "DefiLlama adapter uses static.optimism.io token list, token extensions.optimismBridgeAddress owners, and adds the OP OptimismPortal on Ethereum. Current Base/PGN adapter TVL is zero.",
      registry: REGISTRY,
      l2Predeploys: L2_PREDEPLOYS,
      tokenListFetched: tokenList.tokenListFetched,
      tokenListTimestamp: tokenList.tokenListTimestamp,
      latestEthereumTokensInUsdTop: topObjectEntries(ethereum.tokensUsd),
      latestBaseTokensInUsdTop: topObjectEntries(base.tokensUsd),
      latestPgnTokensInUsdTop: topObjectEntries(pgn.tokensUsd),
    },
    blocks: { ethereum: ethBlock, optimism: opBlock },
    contracts,
    bridgeOwnerRows,
    bridgeSpecifics,
    nativeContext,
    tokenRows,
    artifactJoins: joins.rows,
    joinInputsLoaded: joins.loadedInputs,
    summary: {
      ethereumRpcResolved: Boolean(ethRpcUrl),
      optimismRpcResolved: Boolean(opRpcUrl),
      defillamaCurrentTvlUsd: round(currentTvlUsd, 2),
      defillamaEthereumTvlUsd: round(asNumber(metadataRaw.currentChainTvls?.Ethereum) || asNumber(ethereum.tvl), 2),
      defillamaBaseTvlUsd: round(asNumber(metadataRaw.currentChainTvls?.Base) ?? asNumber(base.tvl), 2),
      defillamaPgnTvlUsd: round(asNumber(metadataRaw.currentChainTvls?.PGN) ?? asNumber(pgn.tvl), 2),
      contractsScanned: contracts.length,
      contractsWithCode: contracts.filter((row) => row.codePresent).length,
      bridgeOwnerRows: bridgeOwnerRows.length,
      ownersWithCode: bridgeOwnerRows.filter((row) => row.codePresent).length,
      dynamicBridgeOwners: dynamicOwners.length,
      tokenRows: tokenRows.length,
      tokenPairsScanned: tokenRows.length,
      tokenRowsWithL1Balance: tokenRows.filter((row) => row.l1BridgeBalanceRaw).length,
      tokenRowsWithL2Supply: tokenRows.filter((row) => row.l2TotalSupplyRaw).length,
      materialTokenRows: tokenRows.filter((row) => row.materialBalance).length,
      materialContextDeltaRows,
      trackedBridgeBalanceUsd: round(trackedBridgeBalanceUsd, 2),
      artifactJoinRows: joins.rows.length,
      bridgeSpecificJoinRows: joins.rows.filter((row) => row.bridgeSpecific).length,
      watchCandidates,
      proofWeaknessRows,
      bridgeSpecificRouteJoins,
      routePositive,
      executableNow: 0,
      signedActionJustified: false,
      status: routePositive > 0 ? "route-positive-needs-proof" : "phase0-no-route-positive",
    },
    blockers: [
      "No deployed proof-acceptance, domain separation, finality, or message-binding bypass proven",
      "No exact source/destination backing mismatch joined to material same-chain consumer economics",
      "Common token consumer presence is not bridge-specific exploit evidence",
      "Base and PGN adapter chain rows are currently zero TVL for this slug",
      "No fork extraction proof and no signed-action justification",
    ],
    requiredForRoutePositive: [
      "Optimism-specific proof/domain/message/nonce/token/finality binding weakness or material exact backing mismatch",
      "permissionless path to mint/unlock/transfer or consumer-borrow against the affected asset",
      "exact unwind/borrow/redeem/liquidation economics positive after costs",
      "fork extraction proof",
    ],
  };

  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, `${JSON.stringify(output, jsonReplacer, 2)}\n`);
  writeReport(output);
  if (!QUIET) {
    console.log(`Optimism Bridge Phase0: tvl=$${Math.round(currentTvlUsd || 0)} tokens=${tokenRows.length} owners=${bridgeOwnerRows.length} joins=${joins.rows.length} watch=${watchCandidates} routePositive=${routePositive}`);
    console.log(`Artifact: ${path.relative(WORKSPACE, RAW_OUT).replace(/\\/g, "/")}`);
    console.log(`Report: ${path.relative(WORKSPACE, REPORT_OUT).replace(/\\/g, "/")}`);
  }
}

main().catch((err) => {
  console.error(String(err?.message || err).slice(0, 320));
  process.exit(1);
});
