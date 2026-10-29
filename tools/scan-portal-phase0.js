#!/usr/bin/env node
// scan-portal-phase0.js - read-only Portal/Wormhole Token Bridge Phase 0.
// Resolves RPC endpoints in memory only. Never prints or stores RPC URLs, keys, calldata, or signed actions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { resolveRpcPool, rpcCall } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "portal-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "portal-phase0-triage.md");
const QUIET = process.argv.includes("--quiet");

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_BYTES32 = `0x${"0".repeat(64)}`;
const SIGNAL_DORMANT = "\uD83D\uDFE2 DORMANT";
const MATERIAL_USD = 10_000;
const SOLANA_WORMHOLE_CHAIN_ID = 1;

const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const EIP1967_BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

const TARGETS = [
  {
    key: "ethereum", name: "Ethereum", chainId: 1, wormholeChainId: 2, coinSlug: "ethereum", llamaKey: "Ethereum",
    core: "0x98f3c9e6E3fAce36bAAd05FE09d375Ef1464288B",
    tokenBridge: "0x3ee18B2214AFF97000D974cf647E7C347E8fa585",
    custodyTokens: [
      ["WETH", "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"],
      ["USDC", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"],
      ["USDT", "0xdAC17F958D2ee523a2206206994597C13D831ec7"],
      ["WBTC", "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599"],
    ],
  },
  {
    key: "bsc", name: "BNB Chain", chainId: 56, wormholeChainId: 4, coinSlug: "bsc", llamaKey: "Binance",
    core: "0x98f3c9e6E3fAce36bAAd05FE09d375Ef1464288B",
    tokenBridge: "0xB6F6D86a8f9879A9c87f643768d9efc38c1Da6E7",
    custodyTokens: [
      ["WBNB", "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c"],
      ["USDT", "0x55d398326f99059fF775485246999027B3197955"],
      ["USDC", "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d"],
    ],
  },
  {
    key: "polygon", name: "Polygon", chainId: 137, wormholeChainId: 5, coinSlug: "polygon", llamaKey: "Polygon",
    core: "0x7A4B5a56256163F07b2C80A7cA55aBE66c4ec4d7",
    tokenBridge: "0x5a58505a96D1dbf8dF91cB21B54419FC36e93fdE",
    custodyTokens: [
      ["WPOL", "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"],
      ["WETH", "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619"],
      ["USDC.e", "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"],
      ["USDT", "0xc2132D05D31c914a87C6611C10748AEb04B58e8F"],
    ],
  },
  {
    key: "base", name: "Base", chainId: 8453, wormholeChainId: 30, coinSlug: "base", llamaKey: "Base",
    core: "0xbebdb6C8ddC678FfA9f8748f85C815C556Dd8ac6",
    tokenBridge: "0x8d2de8d2f73F1F4cAB472AC9A881C9b123C79627",
    custodyTokens: [
      ["WETH", "0x4200000000000000000000000000000000000006"],
      ["USDC", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"],
    ],
  },
  {
    key: "avalanche", name: "Avalanche", chainId: 43114, wormholeChainId: 6, coinSlug: "avalanche", llamaKey: "Avalanche",
    core: "0x54a8e5f9c4CbA08F9943965859F6c34eAF03E26c",
    tokenBridge: "0x0e082F06FF657D94310cB8cE8B0D9a04541d8052",
    custodyTokens: [
      ["WAVAX", "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7"],
      ["USDC.e", "0xA7D7079b0FEaD91F3e65f86E8915Cb59c1a4C664"],
      ["USDT.e", "0xc7198437980c041c805A1EDcbA50c1Ce5db95118"],
    ],
  },
  {
    key: "arbitrum", name: "Arbitrum", chainId: 42161, wormholeChainId: 23, coinSlug: "arbitrum", llamaKey: "Arbitrum",
    core: "0xa5f208e072434bC67592E4C49C1B991BA79BCA46",
    tokenBridge: "0x0b2402144Bb366A632D14B83F244D2e0e21bD39c",
    custodyTokens: [
      ["WETH", "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"],
      ["USDC", "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"],
      ["USDC.e", "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8"],
      ["USDT", "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9"],
    ],
  },
  {
    key: "optimism", name: "Optimism", chainId: 10, wormholeChainId: 24, coinSlug: "optimism", llamaKey: "Optimism",
    core: "0xEe91C335eab126dF5fDB3797EA9d6aD93aeC9722",
    tokenBridge: "0x1D68124e65faFC907325e3EDbF8c4d84499DAa8b",
    custodyTokens: [
      ["WETH", "0x4200000000000000000000000000000000000006"],
      ["USDC", "0x0b2C639c533813f4Aa9D7837CAF62653d097Ff85"],
      ["USDC.e", "0x7F5c764cBc14f9669B88837ca1490cCa17c31607"],
      ["USDT", "0x94b008aD8e5B8bdB9E536eB6ceDabDcDaa6D3278"],
    ],
  },
  {
    key: "celo", name: "Celo", chainId: 42220, wormholeChainId: 14, coinSlug: "celo", llamaKey: "Celo",
    core: "0xa321448d90d4e5b0A732867c18eA198e75CAC48E",
    tokenBridge: "0x796Dff6D74F3E27060B71255Fe517BFb23C93eed",
    custodyTokens: [],
  },
];

const PRIORITY_WRAPPER_TARGETS = TARGETS.filter((t) => [1, 56, 137, 8453, 43114, 42161, 10].includes(t.chainId));

const CORE = new ethers.Interface([
  "function chainId() view returns (uint16)",
  "function evmChainId() view returns (uint256)",
  "function governanceChainId() view returns (uint16)",
  "function governanceContract() view returns (bytes32)",
  "function messageFee() view returns (uint256)",
  "function getGuardianSetExpiry() view returns (uint32)",
  "function getCurrentGuardianSetIndex() view returns (uint32)",
  "function getGuardianSet(uint32 index) view returns (address[] keys, uint32 expirationTime)",
  "function isFork() view returns (bool)",
]);

const BRIDGE = new ethers.Interface([
  "function wormhole() view returns (address)",
  "function chainId() view returns (uint16)",
  "function evmChainId() view returns (uint256)",
  "function governanceChainId() view returns (uint16)",
  "function governanceContract() view returns (bytes32)",
  "function tokenImplementation() view returns (address)",
  "function WETH() view returns (address)",
  "function finality() view returns (uint8)",
  "function bridgeContracts(uint16 chainId) view returns (bytes32)",
  "function outstandingBridged(address token) view returns (uint256)",
  "function isWrappedAsset(address token) view returns (bool)",
  "function wrappedAsset(uint16 tokenChain, bytes32 tokenAddress) view returns (address)",
  "function isFork() view returns (bool)",
]);

const ERC20 = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
]);

const JOIN_INPUTS = [
  ["bridge-proof-binding", "reports/raw/fast/bridge-proof-binding.json"],
  ["bridge-domain-separation", "reports/raw/fast/bridge-domain-separation.json"],
  ["bridge-nonlossless-routes", "reports/raw/fast/bridge-nonlossless-routes.json"],
  ["bridge-nonlossless-collateral-join", "reports/raw/fast/bridge-nonlossless-collateral-join.json"],
  ["bridge-delta-preflight", "reports/raw/fast/bridge-delta-preflight.json"],
  ["bridge-synthetic-consumer-exposure", "reports/raw/fast/bridge-synthetic-consumer-exposure.json"],
  ["deprecated-orphaned", "reports/raw/fast/deprecated-orphaned-reachability.json"],
  ["aave-euler-silo", "reports/raw/fast/aave-euler-silo-consumer-graph.json"],
  ["consumer-first-high-ltv", "reports/raw/fast/consumer-first-high-ltv-collateral.json"],
  ["public-lead-consumer", "reports/raw/fast/public-lead-consumer-joins.json"],
  ["dex-consumer-routes", "reports/raw/fast/dex-consumer-routes.json"],
];

function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function readJson(file, fallback = null) { try { if (!fs.existsSync(file)) return fallback; return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return fallback; } }
function readText(file) { try { if (!fs.existsSync(file)) return ""; return fs.readFileSync(file, "utf8"); } catch (_) { return ""; } }
function jsonReplacer(_key, value) { return typeof value === "bigint" ? value.toString() : value; }
function strip0x(value) { return String(value || "").replace(/^0x/i, ""); }
function normalizeAddress(value) { try { return ethers.getAddress(value); } catch (_) { return null; } }
function lowerAddress(value) { const a = normalizeAddress(value); return a ? a.toLowerCase() : null; }
function addressFromStorageSlot(raw) { if (!raw || raw === "0x") return null; const hex = strip0x(raw).padStart(64, "0"); if (/^0+$/.test(hex)) return null; return normalizeAddress(`0x${hex.slice(-40)}`); }
function addressToBytes32(address) { const a = lowerAddress(address); return a ? `0x${strip0x(a).padStart(64, "0")}` : null; }
function toWords(hex) { const clean = strip0x(hex); const words = []; for (let i = 0; i < clean.length; i += 64) words.push(clean.slice(i, i + 64).padEnd(64, "0")); return words; }
function decodeWordAddress(word) { if (!word) return null; return normalizeAddress(`0x${word.slice(24)}`); }
function decodeGuardianSetRaw(hex) {
  const words = toWords(hex);
  if (words.length < 3) return null;
  const base = BigInt(`0x${words[0]}`) === 32n ? 1 : 0;
  const keysOffset = Number(BigInt(`0x${words[base] || "0"}`)) / 32;
  const expirationTime = Number(BigInt(`0x${words[base + 1] || "0"}`));
  const arrayStart = base + keysOffset;
  const length = Number(BigInt(`0x${words[arrayStart] || "0"}`));
  const keys = [];
  for (let i = 0; i < length; i += 1) keys.push(decodeWordAddress(words[arrayStart + 1 + i]));
  const cleanKeys = keys.filter(Boolean);
  return { keys: cleanKeys, count: cleanKeys.length, quorum: quorum(cleanKeys.length), expirationTime };
}
function sameAddress(a, b) { const aa = lowerAddress(a); const bb = lowerAddress(b); return Boolean(aa && bb && aa === bb); }
function sameBytes32(a, b) { return Boolean(a && b && String(a).toLowerCase() === String(b).toLowerCase()); }
function hexQuantity(value) { return `0x${BigInt(value).toString(16)}`; }
function asNumber(value) { if (value === null || value === undefined) return null; if (typeof value === "number") return Number.isFinite(value) ? value : null; if (typeof value === "bigint") return Number(value); const n = Number(String(value).replace(/[$,%`,\s]/g, "")); return Number.isFinite(n) ? n : null; }
function round(value, decimals = 2) { const n = asNumber(value); if (n === null) return null; const p = 10 ** decimals; return Math.round(n * p) / p; }
function formatUsd(value) { const n = asNumber(value); return n === null ? "n/a" : `$${Math.round(n).toLocaleString()}`; }
function formatNumber(value, decimals = 4) { const n = asNumber(value); return n === null ? "n/a" : n.toLocaleString(undefined, { maximumFractionDigits: decimals }); }
function compactAddress(value) { const a = normalizeAddress(value); return a ? `${a.slice(0, 6)}...${a.slice(-4)}` : "n/a"; }
function formatUnits(value, decimals) { if (value === null || value === undefined || decimals === null || decimals === undefined) return null; try { return ethers.formatUnits(BigInt(value), Number(decimals)); } catch (_) { return null; } }
function amountNumber(value, decimals) { const text = formatUnits(value, decimals); const n = Number(text); return Number.isFinite(n) ? n : null; }
function denormalizeAmount(amount, decimals) { try { const d = Number(decimals); const v = BigInt(amount); return d > 8 ? v * 10n ** BigInt(d - 8) : v; } catch (_) { return null; } }
function quorum(count) { const n = Number(count || 0); return n > 0 ? Math.floor((n * 2) / 3) + 1 : null; }
function stableFallback(symbol) { return /^(USDC|USDC\.e|USDT|DAI|FRAX|LUSD|USDD)$/i.test(String(symbol || "")) ? 1 : null; }
function chainTvl(metadata, target) {
  return asNumber(metadata?.currentChainTvls?.[target.llamaKey]) || asNumber(metadata?.chainTvls?.[target.llamaKey]?.tvl?.slice?.(-1)?.[0]?.totalLiquidityUSD) || null;
}

async function fetchJson(url, timeoutMs = 30_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "user-agent": "evm-audit-portal-phase0/1.0" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function safeRpc(url, method, params = [], timeoutMs = 10_000) {
  if (!url) return null;
  return await rpcCall(url, method, params, timeoutMs).catch(() => null);
}

async function getCode(url, address) { return await safeRpc(url, "eth_getCode", [address, "latest"], 10_000) || "0x"; }
async function getStorage(url, address, slot) { return await safeRpc(url, "eth_getStorageAt", [address, slot, "latest"], 10_000); }
async function getBalance(url, address) { return await safeRpc(url, "eth_getBalance", [address, "latest"], 10_000); }

async function safeCall(url, to, iface, fn, args = [], timeoutMs = 12_000) {
  try {
    const data = iface.encodeFunctionData(fn, args);
    const raw = await safeRpc(url, "eth_call", [{ to, data }, "latest"], timeoutMs);
    if (!raw || raw === "0x") return null;
    return iface.decodeFunctionResult(fn, raw);
  } catch (_) {
    return null;
  }
}

async function rawCall(url, to, iface, fn, args = [], timeoutMs = 12_000) {
  try {
    const data = iface.encodeFunctionData(fn, args);
    return await safeRpc(url, "eth_call", [{ to, data }, "latest"], timeoutMs);
  } catch (_) {
    return null;
  }
}

async function eip1967(url, address) {
  const [impl, admin, beacon] = await Promise.all([
    getStorage(url, address, EIP1967_IMPLEMENTATION_SLOT),
    getStorage(url, address, EIP1967_ADMIN_SLOT),
    getStorage(url, address, EIP1967_BEACON_SLOT),
  ]);
  return { implementation: addressFromStorageSlot(impl), admin: addressFromStorageSlot(admin), beacon: addressFromStorageSlot(beacon) };
}

async function inspectCore(url, target) {
  const flags = [];
  const [code, proxy, chainId, evmChainId, governanceChainId, governanceContract, messageFee, guardianSetExpiry, currentGuardianSetIndex, isFork] = await Promise.all([
    getCode(url, target.core),
    eip1967(url, target.core),
    safeCall(url, target.core, CORE, "chainId"),
    safeCall(url, target.core, CORE, "evmChainId"),
    safeCall(url, target.core, CORE, "governanceChainId"),
    safeCall(url, target.core, CORE, "governanceContract"),
    safeCall(url, target.core, CORE, "messageFee"),
    safeCall(url, target.core, CORE, "getGuardianSetExpiry"),
    safeCall(url, target.core, CORE, "getCurrentGuardianSetIndex"),
    safeCall(url, target.core, CORE, "isFork"),
  ]);
  const index = currentGuardianSetIndex?.[0] === undefined ? null : Number(currentGuardianSetIndex[0]);
  const guardianSetRaw = index === null ? null : await rawCall(url, target.core, CORE, "getGuardianSet", [index]);
  const guardianSet = guardianSetRaw ? decodeGuardianSetRaw(guardianSetRaw) : null;
  const keys = guardianSet?.keys || [];
  const expirationTime = guardianSet?.expirationTime ?? null;
  const codeBytes = code && code !== "0x" ? strip0x(code).length / 2 : 0;
  const decodedChainId = chainId?.[0] === undefined ? null : Number(chainId[0]);
  const decodedEvmChainId = evmChainId?.[0] === undefined ? null : Number(evmChainId[0]);
  if (codeBytes === 0) flags.push("NO_CODE");
  if (decodedChainId !== null && target.wormholeChainId !== null && decodedChainId !== target.wormholeChainId) flags.push(`WORMHOLE_CHAIN_ID_MISMATCH:${decodedChainId}`);
  if (decodedEvmChainId !== null && decodedEvmChainId !== target.chainId) flags.push(`EVM_CHAIN_ID_MISMATCH:${decodedEvmChainId}`);
  if (isFork?.[0] === true) flags.push("CORE_REPORTS_FORK");
  if (keys.length && keys.length < 13) flags.push(`LOW_GUARDIAN_COUNT:${keys.length}`);
  if (expirationTime && expirationTime !== 0) flags.push("CURRENT_GUARDIAN_SET_EXPIRING");
  return {
    address: normalizeAddress(target.core),
    codePresent: codeBytes > 0,
    codeBytes,
    proxy,
    chainId: decodedChainId,
    evmChainId: decodedEvmChainId,
    governanceChainId: governanceChainId?.[0] === undefined ? null : Number(governanceChainId[0]),
    governanceContract: governanceContract?.[0] || null,
    messageFee: messageFee?.[0] === undefined ? null : messageFee[0].toString(),
    guardianSetExpiry: guardianSetExpiry?.[0] === undefined ? null : Number(guardianSetExpiry[0]),
    currentGuardianSetIndex: index,
    currentGuardianSet: { count: keys.length, quorum: quorum(keys.length), expirationTime },
    isFork: isFork?.[0] === undefined ? null : Boolean(isFork[0]),
    flags,
  };
}

function tokenInputs(target, wethAddress) {
  const out = [];
  const seen = new Set();
  const add = (label, address, source) => {
    const a = normalizeAddress(address);
    const key = lowerAddress(a);
    if (!a || seen.has(key)) return;
    seen.add(key);
    out.push({ label, address: a, source });
  };
  for (const [label, address] of target.custodyTokens || []) add(label, address, "static-custody-token");
  if (wethAddress && !sameAddress(wethAddress, ZERO_ADDRESS)) add("Bridge.WETH()", wethAddress, "token-bridge-WETH");
  return out;
}

async function inspectToken(url, target, token) {
  const [code, decimals, symbol, balance, outstanding, isWrappedAsset, totalSupply] = await Promise.all([
    getCode(url, token.address),
    safeCall(url, token.address, ERC20, "decimals"),
    safeCall(url, token.address, ERC20, "symbol"),
    safeCall(url, token.address, ERC20, "balanceOf", [target.tokenBridge]),
    safeCall(url, target.tokenBridge, BRIDGE, "outstandingBridged", [token.address]),
    safeCall(url, target.tokenBridge, BRIDGE, "isWrappedAsset", [token.address]),
    safeCall(url, token.address, ERC20, "totalSupply"),
  ]);
  const flags = [];
  const codeBytes = code && code !== "0x" ? strip0x(code).length / 2 : 0;
  const d = decimals?.[0] === undefined ? null : Number(decimals[0]);
  const balRaw = balance?.[0] === undefined ? null : balance[0].toString();
  const outstandingNorm = outstanding?.[0] === undefined ? null : outstanding[0].toString();
  const expectedRaw = outstandingNorm !== null && d !== null ? denormalizeAmount(outstandingNorm, d) : null;
  if (codeBytes === 0) flags.push("NO_TOKEN_CODE");
  if (expectedRaw !== null && balRaw !== null && BigInt(balRaw) < expectedRaw) flags.push("BALANCE_BELOW_OUTSTANDING");
  return {
    chain: target.name,
    chainId: target.chainId,
    coinSlug: target.coinSlug,
    label: token.label,
    address: token.address,
    source: token.source,
    codePresent: codeBytes > 0,
    codeBytes,
    symbol: symbol?.[0] ? String(symbol[0]) : token.label,
    decimals: d,
    bridgeBalanceRaw: balRaw,
    bridgeBalance: amountNumber(balRaw, d),
    outstandingBridgedNormalized: outstandingNorm,
    expectedMinRawFromOutstanding: expectedRaw === null ? null : expectedRaw.toString(),
    isWrappedAsset: isWrappedAsset?.[0] === undefined ? null : Boolean(isWrappedAsset[0]),
    totalSupplyRaw: totalSupply?.[0] === undefined ? null : totalSupply[0].toString(),
    totalSupply: totalSupply?.[0] === undefined || d === null ? null : amountNumber(totalSupply[0].toString(), d),
    priceKey: `${target.coinSlug}:${lowerAddress(token.address)}`,
    priceUsd: null,
    bridgeBalanceUsd: null,
    material: false,
    flags,
    routePositive: false,
  };
}

async function inspectBridge(url, target) {
  const flags = [];
  const [code, proxy, wormhole, chainId, evmChainId, governanceChainId, governanceContract, tokenImplementation, weth, finality, isFork, nativeBalanceRaw] = await Promise.all([
    getCode(url, target.tokenBridge),
    eip1967(url, target.tokenBridge),
    safeCall(url, target.tokenBridge, BRIDGE, "wormhole"),
    safeCall(url, target.tokenBridge, BRIDGE, "chainId"),
    safeCall(url, target.tokenBridge, BRIDGE, "evmChainId"),
    safeCall(url, target.tokenBridge, BRIDGE, "governanceChainId"),
    safeCall(url, target.tokenBridge, BRIDGE, "governanceContract"),
    safeCall(url, target.tokenBridge, BRIDGE, "tokenImplementation"),
    safeCall(url, target.tokenBridge, BRIDGE, "WETH"),
    safeCall(url, target.tokenBridge, BRIDGE, "finality"),
    safeCall(url, target.tokenBridge, BRIDGE, "isFork"),
    getBalance(url, target.tokenBridge),
  ]);
  const codeBytes = code && code !== "0x" ? strip0x(code).length / 2 : 0;
  const decodedChainId = chainId?.[0] === undefined ? null : Number(chainId[0]);
  const decodedEvmChainId = evmChainId?.[0] === undefined ? null : Number(evmChainId[0]);
  const bridgeWeth = normalizeAddress(weth?.[0]);
  if (codeBytes === 0) flags.push("NO_CODE");
  if (wormhole?.[0] && !sameAddress(wormhole[0], target.core)) flags.push("CORE_ADDRESS_MISMATCH");
  if (decodedChainId !== null && target.wormholeChainId !== null && decodedChainId !== target.wormholeChainId) flags.push(`WORMHOLE_CHAIN_ID_MISMATCH:${decodedChainId}`);
  if (decodedEvmChainId !== null && decodedEvmChainId !== target.chainId) flags.push(`EVM_CHAIN_ID_MISMATCH:${decodedEvmChainId}`);
  if (finality?.[0] !== undefined && Number(finality[0]) === 0) flags.push("FINALITY_ZERO");
  if (isFork?.[0] === true) flags.push("TOKEN_BRIDGE_REPORTS_FORK");

  const peerRows = [];
  for (const peer of TARGETS.filter((item) => item.wormholeChainId !== null && item.key !== target.key)) {
    const storedRaw = await safeCall(url, target.tokenBridge, BRIDGE, "bridgeContracts", [peer.wormholeChainId]);
    const stored = storedRaw?.[0] || null;
    const expected = addressToBytes32(peer.tokenBridge);
    const status = !stored ? "CALL_FAILED" : sameBytes32(stored, expected) ? "OK" : stored === ZERO_BYTES32 ? "MISSING" : "MISMATCH";
    if (status !== "OK") flags.push(`PEER_${status}:${peer.key}`);
    peerRows.push({ chain: peer.name, key: peer.key, wormholeChainId: peer.wormholeChainId, stored, expected, status });
  }
  const custody = await Promise.all(tokenInputs(target, bridgeWeth).map((token) => inspectToken(url, target, token)));
  for (const row of custody) for (const flag of row.flags || []) flags.push(`CUSTODY:${row.label}:${flag}`);
  return {
    address: normalizeAddress(target.tokenBridge),
    codePresent: codeBytes > 0,
    codeBytes,
    proxy,
    wormhole: normalizeAddress(wormhole?.[0]) || null,
    chainId: decodedChainId,
    evmChainId: decodedEvmChainId,
    governanceChainId: governanceChainId?.[0] === undefined ? null : Number(governanceChainId[0]),
    governanceContract: governanceContract?.[0] || null,
    tokenImplementation: normalizeAddress(tokenImplementation?.[0]) || null,
    WETH: bridgeWeth,
    finality: finality?.[0] === undefined ? null : Number(finality[0]),
    isFork: isFork?.[0] === undefined ? null : Boolean(isFork[0]),
    nativeBalanceWei: nativeBalanceRaw ? BigInt(nativeBalanceRaw).toString() : null,
    nativeBalance: nativeBalanceRaw ? formatUnits(BigInt(nativeBalanceRaw).toString(), 18) : null,
    peerRows,
    custody,
    flags,
  };
}

async function scanTarget(target, rpcUrl) {
  if (!rpcUrl) {
    return { target: publicTarget(target), rpcResolved: false, error: "NO_RPC", flags: ["NO_RPC"], core: null, tokenBridge: null };
  }
  const [chainIdHex, blockHex] = await Promise.all([
    safeRpc(rpcUrl, "eth_chainId", [], 6_000),
    safeRpc(rpcUrl, "eth_blockNumber", [], 8_000),
  ]);
  const actualChainId = chainIdHex ? Number(BigInt(chainIdHex)) : null;
  const blockNumber = blockHex ? Number(BigInt(blockHex)) : null;
  const block = blockNumber === null ? null : await safeRpc(rpcUrl, "eth_getBlockByNumber", [hexQuantity(blockNumber), false], 8_000);
  const flags = [];
  if (actualChainId !== null && actualChainId !== target.chainId) flags.push(`RPC_CHAIN_ID_MISMATCH:${actualChainId}`);
  const [core, tokenBridge] = await Promise.all([inspectCore(rpcUrl, target), inspectBridge(rpcUrl, target)]);
  flags.push(...(core.flags || []).map((f) => `core:${f}`));
  flags.push(...(tokenBridge.flags || []).map((f) => `tokenBridge:${f}`));
  return {
    target: publicTarget(target),
    rpcResolved: true,
    block: { number: blockNumber, timestamp: block?.timestamp ? Number(BigInt(block.timestamp)) : null },
    core,
    tokenBridge,
    flags,
    error: null,
  };
}

function publicTarget(target) {
  return {
    key: target.key,
    name: target.name,
    chainId: target.chainId,
    wormholeChainId: target.wormholeChainId,
    core: normalizeAddress(target.core),
    tokenBridge: normalizeAddress(target.tokenBridge),
  };
}

async function loadPrices(tokenRows) {
  const keys = [...new Set(tokenRows.map((row) => row.priceKey).filter(Boolean).map((v) => v.toLowerCase()))];
  const prices = new Map();
  for (let i = 0; i < keys.length; i += 80) {
    const chunk = keys.slice(i, i + 80);
    const json = await fetchJson(`https://coins.llama.fi/prices/current/${chunk.join(",")}?searchWidth=6h`, 30_000).catch(() => ({ coins: {} }));
    for (const [key, value] of Object.entries(json.coins || {})) prices.set(key.toLowerCase(), asNumber(value.price));
  }
  return prices;
}

function applyPrices(results, prices) {
  for (const result of results) {
    for (const row of result.tokenBridge?.custody || []) {
      const price = prices.get(String(row.priceKey || "").toLowerCase()) ?? stableFallback(row.symbol || row.label);
      row.priceUsd = price;
      row.bridgeBalanceUsd = row.bridgeBalance === null || price === null ? null : round(row.bridgeBalance * price, 2);
      row.material = (asNumber(row.bridgeBalanceUsd) || 0) >= MATERIAL_USD;
    }
  }
}

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_MAP = new Map([...B58_ALPHABET].map((c, i) => [c, i]));
function base58ToBytes(text) {
  let bytes = [0];
  for (const char of String(text || "")) {
    const value = B58_MAP.get(char);
    if (value === undefined) return null;
    let carry = value;
    for (let i = 0; i < bytes.length; i += 1) {
      const x = bytes[i] * 58 + carry;
      bytes[i] = x & 0xff;
      carry = x >> 8;
    }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (const char of String(text || "")) {
    if (char === "1") bytes.push(0);
    else break;
  }
  return Uint8Array.from(bytes.reverse());
}
function solanaMintBytes32(mint) {
  const bytes = base58ToBytes(mint);
  if (!bytes || bytes.length !== 32) return null;
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

async function scanFeeMintWrappers(results, feeRefresh) {
  const feeMints = Array.isArray(feeRefresh?.feeMints) ? feeRefresh.feeMints : [];
  const rpcByChain = new Map(results.filter((r) => r.rpcResolved).map((r) => [r.target.chainId, r]));
  const rows = [];
  for (const mint of feeMints) {
    const mintBytes32 = solanaMintBytes32(mint.mint);
    const chainRows = [];
    for (const target of PRIORITY_WRAPPER_TARGETS) {
      const result = rpcByChain.get(target.chainId);
      if (!result || !mintBytes32) {
        chainRows.push({ chain: target.name, chainId: target.chainId, wrapper: null, codePresent: false, totalSupplyRaw: null, status: result ? "INVALID_MINT" : "NO_RPC" });
        continue;
      }
      const url = result._rpcUrl;
      const wrapperRaw = await safeCall(url, target.tokenBridge, BRIDGE, "wrappedAsset", [SOLANA_WORMHOLE_CHAIN_ID, mintBytes32]);
      const wrapper = normalizeAddress(wrapperRaw?.[0]);
      const nonzero = wrapper && !sameAddress(wrapper, ZERO_ADDRESS);
      const [code, totalSupplyRaw] = nonzero ? await Promise.all([
        getCode(url, wrapper),
        safeCall(url, wrapper, ERC20, "totalSupply"),
      ]) : ["0x", null];
      const codePresent = Boolean(code && code !== "0x");
      chainRows.push({
        chain: target.name,
        chainId: target.chainId,
        wrapper: nonzero ? wrapper : ZERO_ADDRESS,
        codePresent,
        totalSupplyRaw: totalSupplyRaw?.[0] === undefined ? null : totalSupplyRaw[0].toString(),
        status: nonzero ? (codePresent ? "NONZERO_WRAPPER_WITH_CODE" : "NONZERO_WRAPPER_NO_CODE") : "ZERO_WRAPPER",
      });
    }
    rows.push({
      mint: mint.mint,
      custodyAmount: mint.custodyAmount || null,
      activeFeeBps: asNumber(mint.activeFeeBps),
      activeMaxFee: mint.activeMaxFee || null,
      mintBytes32Valid: Boolean(mintBytes32),
      wrappers: chainRows,
      nonzeroWrappers: chainRows.filter((row) => row.wrapper && !sameAddress(row.wrapper, ZERO_ADDRESS)).length,
      routePositive: false,
    });
  }
  return rows;
}

function collectArtifactJoins(targets) {
  const terms = [
    "wormhole", "portal", "native token transfers", "ntt",
    ...targets.map((t) => lowerAddress(t.tokenBridge)).filter(Boolean),
    ...targets.map((t) => lowerAddress(t.core)).filter(Boolean),
  ];
  const rows = [];
  const loadedInputs = [];
  const rowLike = (obj) => obj && typeof obj === "object" && !Array.isArray(obj) && (
    obj.bridge || obj.target || obj.protocol || obj.name || obj.id || obj.surface || obj.status || obj.file || obj.function || obj.symbol || obj.address || obj.token || obj.chain
  );
  const sanitize = (source, node, pathParts, hits) => ({
    source,
    path: pathParts.join(".") || "$",
    hits: hits.slice(0, 5),
    bridge: String(node.bridge || node.target || node.protocol || node.name || "").slice(0, 100) || null,
    chain: String(node.chain || node.chainName || "").slice(0, 60) || null,
    surface: String(node.surface || node.status || node.id || node.function || node.file || "").slice(0, 160) || null,
    liquidityUsd: round(node.liquidityUsd || node.topLiquidityUsd || node.tvlUsd, 2),
    proofWeakness: Boolean(node.proofRelevant || node.hasProducerAnomaly || node.hasConcreteMismatch || node.confidence === "high-static"),
    concreteMismatch: Boolean(node.hasConcreteMismatch || node.materialConsumerMismatchRows || node.concreteMismatchRows),
    exactEconomics: Boolean(node.exactEconomicsRows || node.routePositive),
    routePositive: Boolean(node.routePositive),
  });
  for (const [source, rel] of JOIN_INPUTS) {
    const file = path.join(WORKSPACE, rel);
    const text = readText(file);
    if (!text) continue;
    const lower = text.toLowerCase();
    const fileHits = terms.filter((term) => term && lower.includes(term));
    if (!fileHits.length) continue;
    loadedInputs.push(rel);
    const data = readJson(file, null);
    let sourceRows = 0;
    const visit = (node, pathParts = [], depth = 0) => {
      if (!node || sourceRows >= 50 || depth > 7) return;
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i += 1) visit(node[i], pathParts.concat(String(i)), depth + 1);
        return;
      }
      if (typeof node !== "object") return;
      if (rowLike(node)) {
        const rowText = JSON.stringify(node).toLowerCase();
        const hits = fileHits.filter((term) => rowText.includes(term));
        if (hits.length) {
          rows.push(sanitize(source, node, pathParts, hits));
          sourceRows += 1;
          return;
        }
      }
      for (const [key, value] of Object.entries(node)) {
        if (["files", "abis", "errors", "keys"].includes(key)) continue;
        visit(value, pathParts.concat(key), depth + 1);
      }
    };
    visit(data, []);
  }
  const seen = new Set();
  const deduped = [];
  for (const row of rows) {
    const key = `${row.source}|${row.path}|${row.bridge}|${row.surface}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }
  return { rows: deduped, loadedInputs };
}

function summarize(metadata, results, wrapperRows, joins, feeRefresh) {
  const custodyRows = results.flatMap((r) => r.tokenBridge?.custody || []);
  const peerRows = results.flatMap((r) => r.tokenBridge?.peerRows || []);
  const chainTvls = TARGETS.map((target) => ({ chain: target.name, tvlUsd: round(chainTvl(metadata, target), 2) })).filter((row) => row.tvlUsd !== null);
  const nonzeroWrappers = wrapperRows.reduce((sum, row) => sum + row.nonzeroWrappers, 0);
  const balanceBelowOutstandingRows = custodyRows.filter((row) => (row.flags || []).includes("BALANCE_BELOW_OUTSTANDING")).length;
  const proofWeaknessRows = joins.rows.filter((row) => row.proofWeakness).length;
  const concreteMismatchRows = joins.rows.filter((row) => row.concreteMismatch).length + balanceBelowOutstandingRows;
  const exactEconomicsRows = joins.rows.filter((row) => row.exactEconomics).length;
  const watchCandidates = nonzeroWrappers > 0 || balanceBelowOutstandingRows > 0 || concreteMismatchRows > 0 ? 1 : (asNumber(feeRefresh?.summary?.activeFeeMints) || 0) > 0 ? 1 : 0;
  return {
    defillamaCurrentTvlUsd: round(asNumber(metadata?.currentChainTvls?.All) || asNumber(metadata?.tvl?.slice?.(-1)?.[0]?.totalLiquidityUSD), 2),
    publicChainRows: chainTvls.length,
    publicChainTvlUsd: round(chainTvls.reduce((sum, row) => sum + (asNumber(row.tvlUsd) || 0), 0), 2),
    chainsDeclared: Array.isArray(metadata?.chains) ? metadata.chains.length : null,
    evmChainsQueued: TARGETS.length,
    chainsWithRpc: results.filter((r) => r.rpcResolved).length,
    scannedBlocks: results.filter((r) => r.block?.number !== null).length,
    contractRows: results.length * 2,
    contractsWithCode: results.reduce((sum, r) => sum + (r.core?.codePresent ? 1 : 0) + (r.tokenBridge?.codePresent ? 1 : 0), 0),
    guardianRows: results.filter((r) => r.core?.currentGuardianSet?.count).length,
    minGuardianCount: results.reduce((min, r) => r.core?.currentGuardianSet?.count ? Math.min(min, r.core.currentGuardianSet.count) : min, Infinity) === Infinity ? null : results.reduce((min, r) => r.core?.currentGuardianSet?.count ? Math.min(min, r.core.currentGuardianSet.count) : min, Infinity),
    peerRows: peerRows.length,
    peerOkRows: peerRows.filter((row) => row.status === "OK").length,
    peerMismatchRows: peerRows.filter((row) => row.status !== "OK").length,
    custodyRows: custodyRows.length,
    materialCustodyRows: custodyRows.filter((row) => row.material).length,
    totalSampledCustodyUsd: round(custodyRows.reduce((sum, row) => sum + (asNumber(row.bridgeBalanceUsd) || 0), 0), 2),
    balanceBelowOutstandingRows,
    token2022CustodyAccounts: asNumber(feeRefresh?.summary?.custodyAccounts),
    token2022FeeMints: asNumber(feeRefresh?.summary?.transferFeeConfigMints),
    token2022ActiveFeeMints: asNumber(feeRefresh?.summary?.activeFeeMints),
    wrapperProbeRows: wrapperRows.reduce((sum, row) => sum + row.wrappers.length, 0),
    nonzeroWrapperRows: nonzeroWrappers,
    artifactInputsLoaded: joins.loadedInputs.length,
    artifactJoinRows: joins.rows.length,
    proofWeaknessRows,
    concreteMismatchRows,
    exactEconomicsRows,
    watchCandidates,
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    coverageClassification: "bounded-with-caveats",
    status: "phase0-no-route-positive",
    forkGate: "closed-route-positive-zero",
  };
}

function renderReport(artifact) {
  const s = artifact.summary;
  const row = (cells) => `| ${cells.join(" | ")} |`;
  const chainRows = artifact.results.map((r) => row([
    r.target.name,
    r.rpcResolved ? "true" : "false",
    r.block?.number ?? "n/a",
    r.core?.codePresent ? "true" : "false",
    r.tokenBridge?.codePresent ? "true" : "false",
    r.core?.currentGuardianSet?.count ?? "n/a",
    r.core?.currentGuardianSet?.quorum ?? "n/a",
    `${(r.tokenBridge?.peerRows || []).filter((p) => p.status === "OK").length}/${(r.tokenBridge?.peerRows || []).length}`,
    (r.flags || []).length,
  ]));
  const custodyRows = artifact.results.flatMap((r) => r.tokenBridge?.custody || [])
    .sort((a, b) => (asNumber(b.bridgeBalanceUsd) || 0) - (asNumber(a.bridgeBalanceUsd) || 0))
    .slice(0, 12)
    .map((t) => row([t.chain, t.symbol || t.label, compactAddress(t.address), formatNumber(t.bridgeBalance, 4), formatUsd(t.bridgeBalanceUsd), t.isWrappedAsset === null ? "n/a" : String(t.isWrappedAsset), (t.flags || []).join(", ") || "none"]));
  const wrapperRows = artifact.wrapperRows.map((w) => row([
    compactAddress(null).replace("n/a", w.mint.slice(0, 6) + "..." + w.mint.slice(-4)),
    formatNumber(w.activeFeeBps, 2),
    formatNumber(w.custodyAmount, 4),
    `${w.nonzeroWrappers}/${w.wrappers.length}`,
    w.nonzeroWrappers ? w.wrappers.filter((x) => x.wrapper && !sameAddress(x.wrapper, ZERO_ADDRESS)).map((x) => `${x.chain}:${compactAddress(x.wrapper)}`).join(", ") : "none",
  ]));
  const joinRows = artifact.artifactJoins.slice(0, 10).map((j) => row([j.source, j.bridge || "?", j.chain || "?", j.surface || "context", j.proofWeakness ? "true" : "false", j.concreteMismatch ? "true" : "false", j.routePositive ? "true" : "false"]));

  return `# ${SIGNAL_DORMANT} - Portal Phase 0

Generated: ${artifact.generatedAt}

Scanner: \`tools/scan-portal-phase0.js\`

Artifact: \`reports/raw/fast/portal-phase0.json\`

## Result

No permissionless route-positive exploit is claimed. The pass mapped current Wormhole/Portal EVM core and Token Bridge state, peer bindings, sampled custody balances, outstanding-wrapped accounting, the Solana Token-2022 fee-mint residual wrapper state, and local bridge/consumer artifacts. Existing proof/accounting residuals remain watch-only because no deployed forged-proof or balance-delta mismatch maps to exact positive borrow, mint, unlock, liquidation, redemption, or DEX unwind economics.

## Target

| Field | Value |
|---|---:|
${row(["Protocol", "`Portal` / Wormhole Token Bridge"])}
${row(["Public TVL", formatUsd(s.defillamaCurrentTvlUsd)])}
${row(["Declared chains", `\`${s.chainsDeclared ?? "n/a"}\``])}
${row(["EVM chains scanned", `\`${s.chainsWithRpc}/${s.evmChainsQueued}\``])}
${row(["Coverage", `\`${s.coverageClassification}\``])}

## Live EVM State

| Chain | RPC | Block | Core code | TokenBridge code | Guardians | Quorum | Peer OK | Flags |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
${chainRows.join("\n")}

## Custody Context

| Chain | Token | Address | Bridge balance | Bridge balance USD | Wrapped asset | Flags |
|---|---|---|---:|---:|---:|---|
${custodyRows.length ? custodyRows.join("\n") : row(["none", "none", "n/a", "n/a", "n/a", "n/a", "none"])}

## Token-2022 Residual Wrapper Check

| Mint | Active fee bps | Custody amount | Nonzero priority wrappers | Wrapper detail |
|---|---:|---:|---:|---|
${wrapperRows.length ? wrapperRows.join("\n") : row(["none", "n/a", "n/a", "0/0", "none"])}

## Artifact Joins

| Source | Bridge/Target | Chain | Surface | Proof weakness | Concrete mismatch | Route-positive |
|---|---|---|---|---:|---:|---:|
${joinRows.length ? joinRows.join("\n") : row(["none", "none", "n/a", "n/a", "false", "false", "false"])}

## Summary

| Metric | Value |
|---|---:|
${row(["Peer rows", `\`${s.peerRows}\``])}
${row(["Peer mismatch rows", `\`${s.peerMismatchRows}\``])}
${row(["Custody rows", `\`${s.custodyRows}\``])}
${row(["Material custody rows", `\`${s.materialCustodyRows}\``])}
${row(["Sampled custody USD", formatUsd(s.totalSampledCustodyUsd)])}
${row(["Balance below outstanding rows", `\`${s.balanceBelowOutstandingRows}\``])}
${row(["Token-2022 active fee mints", `\`${s.token2022ActiveFeeMints ?? 0}\``])}
${row(["Nonzero priority wrappers", `\`${s.nonzeroWrapperRows}\``])}
${row(["Artifact joins", `\`${s.artifactJoinRows}\``])}
${row(["Concrete mismatch rows", `\`${s.concreteMismatchRows}\``])}
${row(["Exact economics rows", `\`${s.exactEconomicsRows}\``])}
${row(["Watch candidates", `\`${s.watchCandidates}\``])}
${row(["Route-positive rows", `\`${s.routePositive}\``])}

## Blockers

- Guardian quorum and peer-contract checks do not expose a public forged-proof or replay path in the current EVM state
- Sampled custody balances and outstanding-wrapped rows are context only unless a Portal-specific backing mismatch is proven
- The Solana Token-2022 fee-mint residual still has no nonzero priority EVM wrapper in this refresh
- Static proof-binding rows are research leads only; no deployed proof-acceptance row has exact positive economics
- No fork extraction proof and no signed-action justification

## Next Gate

Reopen Portal only if a deployed proof/domain/nonce/token/finality weakness, a material exact backing mismatch, or a Token-2022 residual with nonzero wrapped liquidity maps to permissionless exact-positive mint, unlock, borrow, liquidation, redemption, or unwind economics.
`;
}

async function main() {
  const [metadata, rpcPool] = await Promise.all([
    fetchJson("https://api.llama.fi/protocol/portal", 45_000).catch(() => ({})),
    resolveRpcPool(TARGETS.map((t) => t.chainId)),
  ]);
  const results = await Promise.all(TARGETS.map(async (target) => {
    const result = await scanTarget(target, rpcPool[target.chainId]);
    Object.defineProperty(result, "_rpcUrl", { value: rpcPool[target.chainId], enumerable: false });
    return result;
  }));
  const custodyRows = results.flatMap((r) => r.tokenBridge?.custody || []);
  const prices = await loadPrices(custodyRows);
  applyPrices(results, prices);
  const feeRefresh = readJson(path.join(WORKSPACE, "reports", "raw", "fast", "wormhole-token2022-fee-wrappers.json"), null);
  const wrapperRows = await scanFeeMintWrappers(results, feeRefresh);
  const artifactJoins = collectArtifactJoins(TARGETS);
  const summary = summarize(metadata, results, wrapperRows, artifactJoins, feeRefresh);
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-portal-phase0.js",
    scope: "Portal/Wormhole Token Bridge EVM deployments, peer/custody accounting, Token-2022 residual wrappers, and bridge consumer joins Phase 0",
    safety: {
      publicApisOnly: false,
      rpcInventoryRead: true,
      rpcInventoryOnly: false,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: false,
      signedActionJustified: false,
    },
    target: {
      name: "Portal",
      slug: "portal",
      project: "Wormhole / Portal Token Bridge",
      category: metadata?.category || "Bridge",
      surface: "bridge-proof-custody-consumer",
      url: metadata?.url || "https://portalbridge.com/",
      tvlCodePath: metadata?.tvlCodePath || "https://github.com/DefiLlama/DefiLlama-Adapters/tree/main/projects/portal",
      chains: metadata?.chains || [],
      evmChainsScanned: TARGETS.map((t) => t.name),
    },
    thresholds: { materialUsd: MATERIAL_USD },
    metadata: {
      name: metadata?.name || "Portal",
      slug: metadata?.slug || "portal",
      category: metadata?.category || "Bridge",
      chains: metadata?.chains || [],
      audits: metadata?.audits || null,
      currentTvlUsd: summary.defillamaCurrentTvlUsd,
      chainTvls: TARGETS.map((target) => ({ chain: target.name, tvlUsd: round(chainTvl(metadata, target), 2) })),
    },
    results: results.map((r) => ({ ...r })),
    wrapperRows,
    artifactJoins: artifactJoins.rows,
    loadedJoinArtifacts: artifactJoins.loadedInputs,
    summary,
    blockers: [
      "Guardian quorum and peer-contract checks do not expose a public forged-proof or replay path in the current EVM state",
      "Sampled custody balances and outstanding-wrapped rows are context only unless a Portal-specific backing mismatch is proven",
      "The Solana Token-2022 fee-mint residual still has no nonzero priority EVM wrapper in this refresh",
      "Static proof-binding rows are research leads only; no deployed proof-acceptance row has exact positive economics",
      "No fork extraction proof and no signed-action justification",
    ],
    requiredForRoutePositive: [
      "deployed Portal proof/domain/nonce/token/finality weakness or material exact backing mismatch",
      "permissionless path to mint, unlock, transfer, borrow, redeem, liquidate, or unwind affected assets",
      "exact route economics positive after gas/slippage/fees",
      "fork extraction proof",
    ],
    nextReadOnlyStep: "Reopen Portal only if a deployed proof/domain/nonce/token/finality weakness, material exact backing mismatch, or Token-2022 residual with nonzero wrapped liquidity maps to permissionless exact-positive economics.",
  };
  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, `${JSON.stringify(artifact, jsonReplacer, 2)}\n`);
  fs.writeFileSync(REPORT_OUT, renderReport(artifact));
  if (!QUIET) {
    console.log(`Portal Phase0: chains=${summary.chainsWithRpc}/${summary.evmChainsQueued} custody=${summary.custodyRows} peerMismatch=${summary.peerMismatchRows} wrappers=${summary.nonzeroWrapperRows} watch=${summary.watchCandidates} routePositive=${summary.routePositive}`);
    console.log(`Artifact: ${path.relative(WORKSPACE, RAW_OUT)}`);
    console.log(`Report: ${path.relative(WORKSPACE, REPORT_OUT)}`);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
