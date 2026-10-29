#!/usr/bin/env node
// Read-only Centrifuge NAV receipt-token consumer graph scanner.
// RPC URLs are resolved from local inventory in memory only and never printed or stored.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "centrifuge-nav-consumer-graph.json");
const SILO_CORE_DEPLOYMENTS = path.join(WORKSPACE, "targets", "silo-contracts-v2", "silo-core", "deployments");

const TIMEOUT_MS = 15_000;
const RPC_BATCH_SIZE = 18;
const LOG_CHUNK = Number(process.env.CENTRIFUGE_LOG_CHUNK || "2000000");
const MAX_EULER_VAULTS = Number(process.env.CENTRIFUGE_MAX_EULER_VAULTS || "700");
const MAX_SILO_IDS = Number(process.env.CENTRIFUGE_MAX_SILO_IDS || "700");
const MORPHO_TOP_N = Number(process.env.CENTRIFUGE_MORPHO_TOP_N || "350");
const ROUTE_LIQUIDITY_USD = Number(process.env.CENTRIFUGE_ROUTE_LIQUIDITY_USD || "10000");
const NAV_DIVERGENCE_BPS = Number(process.env.CENTRIFUGE_NAV_DIVERGENCE_BPS || "100");
const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

const CHAINS = {
  1: {
    name: "Ethereum",
    coinSlug: "ethereum",
    aavePool: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
    eulerFactory: "0x29a56a1b8214D9Cf7c5561811750D5cBDb45CC8e",
    siloFolder: "mainnet",
    factories: [
      { startBlock: 20432393, kind: "v2", address: "0x91808B5E2F6d7483D41A681034D7c9DbB64B9E29" },
      { startBlock: 22924277, kind: "v3", address: "0xd30Da1d7F964E5f6C2D9fE2AAA97517F6B23FA2B" },
      { startBlock: 24369775, kind: "v3.1", address: "0xEC3582fcDc34078a4B7a8c75a5a3AE46f48525aB" },
    ],
    assets: ["0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"],
  },
  8453: {
    name: "Base",
    coinSlug: "base",
    blockscoutApi: "https://base.blockscout.com",
    aavePool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
    siloFolder: "base",
    factories: [
      { startBlock: 17854404, kind: "v2", address: "0x7f192F34499DdB2bE06c4754CFf2a21c4B056994" },
      { startBlock: 32901390, kind: "v3", address: "0xd30Da1d7F964E5f6C2D9fE2AAA97517F6B23FA2B" },
      { startBlock: 41626601, kind: "v3.1", address: "0xEC3582fcDc34078a4B7a8c75a5a3AE46f48525aB" },
    ],
    assets: ["0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"],
  },
  42161: {
    name: "Arbitrum",
    coinSlug: "arbitrum",
    blockscoutApi: "https://arbitrum.blockscout.com",
    aavePool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    siloFolder: "arbitrum_one",
    factories: [
      { startBlock: 238245701, kind: "v2", address: "0x91808B5E2F6d7483D41A681034D7c9DbB64B9E29" },
      { startBlock: 357984300, kind: "v3", address: "0xd30Da1d7F964E5f6C2D9fE2AAA97517F6B23FA2B" },
      { startBlock: 427871358, kind: "v3.1", address: "0xEC3582fcDc34078a4B7a8c75a5a3AE46f48525aB" },
    ],
    assets: ["0xaf88d065e77c8cC2239327C5EDb3A432268e5831"],
  },
  43114: {
    name: "Avalanche",
    coinSlug: "avax",
    aavePool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    factories: [
      { startBlock: 65493376, kind: "v3", address: "0xd30Da1d7F964E5f6C2D9fE2AAA97517F6B23FA2B" },
      { startBlock: 77109103, kind: "v3.1", address: "0xEC3582fcDc34078a4B7a8c75a5a3AE46f48525aB" },
    ],
    assets: ["0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E"],
  },
  56: {
    name: "BNB Chain",
    coinSlug: "bsc",
    siloFolder: "bnb",
    factories: [
      { startBlock: 54801665, kind: "v3", address: "0xd30Da1d7F964E5f6C2D9fE2AAA97517F6B23FA2B" },
      { startBlock: 75504469, kind: "v3.1", address: "0xEC3582fcDc34078a4B7a8c75a5a3AE46f48525aB" },
    ],
    assets: ["0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", "0x55d398326f99059fF775485246999027B3197955"],
  },
  10: {
    name: "Optimism",
    coinSlug: "optimism",
    aavePool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    siloFolder: "optimism",
    factories: [
      { startBlock: 147221955, kind: "v3.1", address: "0xEC3582fcDc34078a4B7a8c75a5a3AE46f48525aB" },
    ],
    assets: ["0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85"],
  },
};
const DEFAULT_CHAIN_IDS = [1, 8453, 42161];

const EVENTS = new ethers.Interface([
  "event DeployTranche(uint64 indexed poolId, bytes16 indexed trancheId, address indexed tranche)",
  "event AddShareClass(uint64 indexed poolId, bytes16 indexed scId, address token)",
]);
const ERC20 = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
  "function vault(address asset) view returns (address)",
  "function asset() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
]);
const AAVE_POOL = new ethers.Interface([
  "function ADDRESSES_PROVIDER() view returns (address)",
  "function getReservesList() view returns (address[])",
  "function getReserveData(address asset) view returns (tuple(uint256 data) configuration,uint128 liquidityIndex,uint128 currentLiquidityRate,uint128 variableBorrowIndex,uint128 currentVariableBorrowRate,uint128 currentStableBorrowRate,uint40 lastUpdateTimestamp,uint16 id,address aTokenAddress,address stableDebtTokenAddress,address variableDebtTokenAddress,address interestRateStrategyAddress,uint128 accruedToTreasury,uint128 unbacked,uint128 isolationModeTotalDebt)",
]);
const AAVE_ADDRESSES_PROVIDER = new ethers.Interface(["function getPriceOracle() view returns (address)"]);
const AAVE_ORACLE = new ethers.Interface(["function getSourceOfAsset(address asset) view returns (address)"]);
const GENERIC_FACTORY = new ethers.Interface([
  "function getProxyListLength() view returns (uint256)",
  "function getProxyListSlice(uint256 start,uint256 end) view returns (address[])",
]);
const EVAULT = new ethers.Interface([
  "function asset() view returns (address)",
  "function cash() view returns (uint256)",
  "function LTVBorrow(address collateral) view returns (uint16)",
  "function LTVList() view returns (address[])",
  "function oracle() view returns (address)",
  "function symbol() view returns (string)",
  "function totalBorrows() view returns (uint256)",
]);
const SILO_FACTORY = new ethers.Interface([
  "function getNextSiloId() view returns (uint256)",
  "function idToSiloConfig(uint256 id) view returns (address)",
]);
const SILO_CONFIG = new ethers.Interface([
  "function getSilos() view returns (address,address)",
  "function getConfig(address silo) view returns ((uint256,uint256,address,address,address,address,address,address,address,address,uint256,uint256,uint256,uint256,uint256,address,bool))",
]);
const SILO = new ethers.Interface([
  "function getLiquidity() view returns (uint256)",
  "function getSiloStorage() view returns (uint192,uint64,uint256,uint256,uint256)",
]);
const BEACON = new ethers.Interface(["function implementation() view returns (address)"]);

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function strip0x(value) {
  return String(value || "").replace(/^0x/i, "");
}

function normalizeAddress(value) {
  try {
    return ethers.getAddress(value);
  } catch (_) {
    return null;
  }
}

function lowerAddress(value) {
  const address = normalizeAddress(value);
  return address ? address.toLowerCase() : null;
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
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

async function resolveRpcPool(chainIds) {
  const pool = {};
  for (const url of loadRpcUrls()) {
    try {
      const idHex = await rpcCall(url, "eth_chainId", [], 6000);
      const chainId = Number(BigInt(idHex));
      if (chainIds.includes(chainId) && !pool[chainId]) pool[chainId] = url;
    } catch (_) {
      // Never print or persist RPC URLs.
    }
  }
  return pool;
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
  try {
    return await provider.call({ to, data });
  } catch (_) {
    return null;
  }
}

function decodeResult(raw, iface, fn) {
  if (!raw || raw === "0x") return null;
  try {
    return iface.decodeFunctionResult(fn, raw);
  } catch (_) {
    return null;
  }
}

function decodeUintResult(raw, fn) {
  if (!raw || raw === "0x") return null;
  try {
    return BigInt(ERC20.decodeFunctionResult(fn, raw)[0]);
  } catch (_) {
    try {
      return BigInt(raw);
    } catch (_) {
      return null;
    }
  }
}

function decodeStringResult(raw, fn) {
  if (!raw || raw === "0x") return null;
  try {
    return String(ERC20.decodeFunctionResult(fn, raw)[0]);
  } catch (_) {
    const hex = strip0x(raw);
    if (hex.length === 64) return Buffer.from(hex, "hex").toString("utf8").replace(/\u0000+$/g, "") || null;
    return null;
  }
}

function wordAt(raw, index) {
  const hex = strip0x(raw);
  const start = index * 64;
  if (!hex || hex.length < start + 64) return null;
  return `0x${hex.slice(start, start + 64)}`;
}

function addressFromStorageSlot(raw) {
  if (!raw || raw === "0x") return null;
  const hex = strip0x(raw).padStart(64, "0");
  if (/^0+$/.test(hex)) return null;
  return normalizeAddress(`0x${hex.slice(-40)}`);
}

function addressWordAt(raw, index) {
  const word = wordAt(raw, index);
  return word ? addressFromStorageSlot(word) : null;
}

function formatUnitsNumber(raw, decimals) {
  if (raw === null || raw === undefined || decimals === null || decimals === undefined) return null;
  try {
    return Number(ethers.formatUnits(raw, Number(decimals)));
  } catch (_) {
    return null;
  }
}

function bpsDiff(reference, observed) {
  const ref = Number(reference || 0);
  const obs = Number(observed || 0);
  if (!Number.isFinite(ref) || !Number.isFinite(obs) || ref <= 0 || obs <= 0) return null;
  return ((obs / ref) - 1) * 10_000;
}

async function erc20Decimals(provider, token) {
  const raw = await safeProviderCall(provider, token, ERC20.encodeFunctionData("decimals", []));
  const decoded = decodeUintResult(raw, "decimals");
  return decoded === null ? 18 : Number(decoded);
}

async function erc20Balance(provider, token, account) {
  const raw = await safeProviderCall(provider, token, ERC20.encodeFunctionData("balanceOf", [account]));
  return decodeUintResult(raw, "balanceOf") || 0n;
}

async function safeGetStorage(provider, address, slot) {
  try {
    return await provider.getStorage(address, slot);
  } catch (_) {
    return null;
  }
}

async function getReferenceCodes(provider, address) {
  const target = normalizeAddress(address);
  if (!target) return [];
  const out = [];
  const targetCode = await provider.getCode(target).catch(() => "0x");
  if (targetCode && targetCode !== "0x") out.push({ kind: "target", address: target, code: targetCode });

  const impl = addressFromStorageSlot(await safeGetStorage(provider, target, EIP1967_IMPLEMENTATION_SLOT));
  if (impl) {
    const code = await provider.getCode(impl).catch(() => "0x");
    if (code && code !== "0x") out.push({ kind: "eip1967Implementation", address: impl, code });
  }

  const beacon = addressFromStorageSlot(await safeGetStorage(provider, target, EIP1967_BEACON_SLOT));
  if (beacon) {
    const implRaw = await safeProviderCall(provider, beacon, BEACON.encodeFunctionData("implementation", []));
    const beaconImpl = normalizeAddress(decodeResult(implRaw, BEACON, "implementation")?.[0]);
    if (beaconImpl) {
      const code = await provider.getCode(beaconImpl).catch(() => "0x");
      if (code && code !== "0x") out.push({ kind: "eip1967BeaconImplementation", beacon, address: beaconImpl, code });
    }
  }

  const seen = new Set();
  return out.filter((row) => {
    const key = `${row.kind}:${row.beacon || ""}:${row.address}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function codeReferencesProducers(code, producers) {
  const lowerCode = strip0x(code).toLowerCase();
  if (!lowerCode) return [];
  return producers.filter((producer) => lowerCode.includes(strip0x(producer.addressLower)));
}

async function findProducerReferencesInAddress(provider, address, producers) {
  const rows = [];
  for (const codeRef of await getReferenceCodes(provider, address)) {
    for (const producer of codeReferencesProducers(codeRef.code, producers)) {
      rows.push({
        producer,
        reference: {
          address: codeRef.address,
          kind: codeRef.kind,
          beacon: codeRef.beacon || null,
          codeBytes: strip0x(codeRef.code).length / 2,
        },
      });
    }
  }
  return rows;
}

function decodeAaveConfig(data) {
  const raw = BigInt(data || 0n);
  const mask16 = 0xffffn;
  const mask36 = (1n << 36n) - 1n;
  return {
    data: raw.toString(),
    ltv: Number(raw & mask16) / 10_000,
    liquidationThreshold: Number((raw >> 16n) & mask16) / 10_000,
    liquidationBonus: Number((raw >> 32n) & mask16) / 10_000,
    decimals: Number((raw >> 48n) & 0xffn),
    active: Boolean((raw >> 56n) & 1n),
    frozen: Boolean((raw >> 57n) & 1n),
    borrowingEnabled: Boolean((raw >> 58n) & 1n),
    paused: Boolean((raw >> 60n) & 1n),
    borrowCapWholeTokens: ((raw >> 80n) & mask36).toString(),
    supplyCapWholeTokens: ((raw >> 116n) & mask36).toString(),
  };
}

function ltvBpsToRatio(value) {
  return Number(value || 0) / 10_000;
}

function siloLtvToRatio(value) {
  return Number(value || 0n) / 1e18;
}

async function fetchAddressPrices(chain, addresses) {
  const keys = [];
  for (const address of addresses || []) {
    const normalized = lowerAddress(address);
    if (normalized) keys.push(`${chain.coinSlug}:${normalized}`);
  }
  const uniq = [...new Set(keys.filter(Boolean).map((x) => x.toLowerCase()))];
  const out = {};
  for (let i = 0; i < uniq.length; i += 50) {
    const json = await fetchJson(`https://coins.llama.fi/prices/current/${uniq.slice(i, i + 50).join(",")}?searchWidth=6h`, { timeoutMs: 30_000 }).catch(() => ({ coins: {} }));
    Object.assign(out, json.coins || {});
  }
  return out;
}

function pricesToAddressMap(chain, prices) {
  const out = new Map();
  for (const [key, row] of Object.entries(prices || {})) {
    const prefix = `${chain.coinSlug}:`;
    if (!key.toLowerCase().startsWith(prefix)) continue;
    const address = lowerAddress(key.slice(prefix.length));
    const price = Number(row?.price || 0);
    if (address && Number.isFinite(price) && price > 0) out.set(address, price);
  }
  return out;
}

function loadSiloDeployment(chainId, name) {
  const folder = CHAINS[chainId]?.siloFolder;
  if (!folder) return null;
  const file = path.join(SILO_CORE_DEPLOYMENTS, folder, `${name}.sol.json`);
  const json = readJson(file, null);
  return normalizeAddress(json?.address || json?.deployedTo || json?.contractAddress);
}

async function getLogsChunked(provider, filter, fromBlock, toBlock) {
  const rows = [];
  let start = Number(fromBlock);
  if (start > Number(toBlock)) return rows;
  let step = Math.max(1000, LOG_CHUNK);
  while (start <= toBlock) {
    const end = Math.min(toBlock, start + step - 1);
    try {
      rows.push(...await provider.getLogs({ ...filter, fromBlock: start, toBlock: end }));
      start = end + 1;
      if (step < LOG_CHUNK) step = Math.min(LOG_CHUNK, step * 2);
    } catch (_) {
      if (step <= 1000) {
        start = end + 1;
      } else {
        step = Math.max(1000, Math.floor(step / 2));
      }
    }
  }
  return rows;
}

async function getBlockscoutLogs(chain, address, topic, fromBlock) {
  if (!chain.blockscoutApi) return null;
  const logs = [];
  let nextParams = null;
  for (let page = 0; page < 50; page++) {
    const url = new URL(`/api/v2/addresses/${address}/logs`, chain.blockscoutApi);
    url.searchParams.set("topic", topic);
    if (nextParams) {
      for (const [key, value] of Object.entries(nextParams)) {
        if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
      }
    }
    const json = await fetchJson(url.toString(), { timeoutMs: 30_000 });
    for (const item of json.items || []) {
      if (Number(item.block_number || 0) < Number(fromBlock || 0)) continue;
      logs.push({
        blockNumber: Number(item.block_number || 0),
        index: Number(item.index || 0),
        transactionHash: item.transaction_hash || null,
        data: item.data || "0x",
        topics: (item.topics || []).filter(Boolean),
      });
    }
    nextParams = json.next_page_params || null;
    if (!nextParams) break;
  }
  return logs;
}

async function getFactoryEventLogs(provider, chain, factory, event, latest) {
  const address = normalizeAddress(factory.address);
  if (!address) return { logs: [], source: "invalid-address" };
  if (chain.blockscoutApi) {
    try {
      const logs = await getBlockscoutLogs(chain, address, event.topicHash, factory.startBlock);
      return { logs: logs || [], source: "blockscout" };
    } catch (err) {
      if (process.env.CENTRIFUGE_ALLOW_RPC_LOG_FALLBACK !== "1") {
        return { logs: [], source: "blockscout-error", error: err.message || String(err) };
      }
    }
  }
  const logs = await getLogsChunked(provider, { address, topics: [event.topicHash] }, factory.startBlock, latest);
  return { logs, source: "rpc-getLogs" };
}

function selectedChainIds() {
  const raw = String(process.env.CENTRIFUGE_CHAIN_IDS || "").trim();
  if (!raw) return DEFAULT_CHAIN_IDS;
  if (/^all$/i.test(raw)) return Object.keys(CHAINS).map(Number);
  const ids = raw.split(",").map((item) => Number(item.trim())).filter((id) => CHAINS[id]);
  return ids.length ? [...new Set(ids)] : DEFAULT_CHAIN_IDS;
}

async function discoverShareClassTokens(provider, chain, chainId) {
  const latest = await provider.getBlockNumber();
  const tokenMap = new Map();
  const factoryStats = [];
  for (const factory of chain.factories || []) {
    const address = normalizeAddress(factory.address);
    if (!address) continue;
    const eventName = factory.kind === "v2" ? "DeployTranche" : "AddShareClass";
    const event = EVENTS.getEvent(eventName);
    const { logs, source, error } = await getFactoryEventLogs(provider, chain, factory, event, latest);
    factoryStats.push({ kind: factory.kind, address, startBlock: factory.startBlock, logs: logs.length, source, error: error || null });
    for (const log of logs) {
      try {
        const parsed = EVENTS.parseLog(log);
        const token = normalizeAddress(factory.kind === "v2" ? parsed.args.tranche : parsed.args.token);
        if (!token) continue;
        const key = token.toLowerCase();
        const existing = tokenMap.get(key);
        tokenMap.set(key, {
          id: existing?.id || `centrifuge:${chainId}:${key}`,
          protocol: "Centrifuge",
          category: factory.kind === "v2" ? "rwa-tranche-token" : "rwa-share-class-token",
          chainId,
          chain: chain.name,
          address: token,
          addressLower: key,
          poolId: String(parsed.args.poolId),
          shareClassId: String(factory.kind === "v2" ? parsed.args.trancheId : parsed.args.scId),
          factory: address,
          factoryKind: factory.kind,
          deployBlock: Number(log.blockNumber),
          logIndex: Number(log.index ?? log.logIndex ?? 0),
          sources: [...new Set([...(existing?.sources || []), `${factory.kind}:${address}`])],
        });
      } catch (_) {
        // Skip malformed logs.
      }
    }
  }
  return { tokens: [...tokenMap.values()].sort((a, b) => a.deployBlock - b.deployBlock || a.logIndex - b.logIndex), factoryStats, latest };
}

async function enrichProducer(provider, chain, row, priceMap) {
  const [code, symbolRaw, nameRaw, decimalsRaw, supplyRaw] = await Promise.all([
    provider.getCode(row.address).catch(() => "0x"),
    safeProviderCall(provider, row.address, ERC20.encodeFunctionData("symbol", [])),
    safeProviderCall(provider, row.address, ERC20.encodeFunctionData("name", [])),
    safeProviderCall(provider, row.address, ERC20.encodeFunctionData("decimals", [])),
    safeProviderCall(provider, row.address, ERC20.encodeFunctionData("totalSupply", [])),
  ]);
  const decimals = Number(decodeUintResult(decimalsRaw, "decimals") ?? 18n);
  const totalSupplyRaw = decodeUintResult(supplyRaw, "totalSupply");
  const tokenPriceUsd = priceMap.get(row.addressLower) || null;
  const vaults = [];
  for (const assetCandidate of chain.assets || []) {
    const asset = normalizeAddress(assetCandidate);
    if (!asset) continue;
    const vaultRaw = await safeProviderCall(provider, row.address, ERC20.encodeFunctionData("vault", [asset]));
    const vault = normalizeAddress(decodeResult(vaultRaw, ERC20, "vault")?.[0]);
    if (!vault || vault === ethers.ZeroAddress) continue;
    const [vaultCode, vaultAssetRaw, totalAssetsRaw, vaultSupplyRaw, convertRaw, assetDecimalsRaw, assetSymbolRaw] = await Promise.all([
      provider.getCode(vault).catch(() => "0x"),
      safeProviderCall(provider, vault, ERC20.encodeFunctionData("asset", [])),
      safeProviderCall(provider, vault, ERC20.encodeFunctionData("totalAssets", [])),
      safeProviderCall(provider, vault, ERC20.encodeFunctionData("totalSupply", [])),
      safeProviderCall(provider, vault, ERC20.encodeFunctionData("convertToAssets", [10n ** BigInt(Math.min(decimals, 36))])),
      safeProviderCall(provider, asset, ERC20.encodeFunctionData("decimals", [])),
      safeProviderCall(provider, asset, ERC20.encodeFunctionData("symbol", [])),
    ]);
    const assetDecimals = Number(decodeUintResult(assetDecimalsRaw, "decimals") ?? 18n);
    const totalAssets = decodeUintResult(totalAssetsRaw, "totalAssets");
    const vaultSupply = decodeUintResult(vaultSupplyRaw, "totalSupply");
    const convertOne = decodeUintResult(convertRaw, "convertToAssets");
    const totalAssetsNumber = formatUnitsNumber(totalAssets, assetDecimals);
    const assetPriceUsd = priceMap.get(asset.toLowerCase()) || null;
    const sharePriceAssets = convertOne !== null
      ? formatUnitsNumber(convertOne, assetDecimals)
      : (totalSupplyRaw && totalSupplyRaw > 0n && totalAssets !== null ? Number(ethers.formatUnits((totalAssets * (10n ** BigInt(decimals))) / totalSupplyRaw, assetDecimals)) : null);
    const navUsdPerShare = sharePriceAssets !== null && assetPriceUsd ? sharePriceAssets * assetPriceUsd : null;
    vaults.push({
      vault,
      codePresent: Boolean(vaultCode && vaultCode !== "0x"),
      requestedAsset: asset,
      asset: normalizeAddress(decodeResult(vaultAssetRaw, ERC20, "asset")?.[0]) || asset,
      assetSymbol: decodeStringResult(assetSymbolRaw, "symbol"),
      assetDecimals,
      assetPriceUsd,
      totalAssetsRaw: totalAssets?.toString() || null,
      totalAssets: totalAssetsNumber,
      totalAssetsUsd: assetPriceUsd && totalAssetsNumber !== null ? assetPriceUsd * totalAssetsNumber : null,
      vaultTotalSupplyRaw: vaultSupply?.toString() || null,
      convertOneShareToAssetsRaw: convertOne?.toString() || null,
      sharePriceAssets,
      navUsdPerShare,
      navVsTokenPriceBps: bpsDiff(tokenPriceUsd, navUsdPerShare),
    });
  }
  const bestVault = vaults.slice().sort((a, b) => Number(b.totalAssetsUsd || 0) - Number(a.totalAssetsUsd || 0))[0] || null;
  const navVsTokenPriceBps = bestVault?.navVsTokenPriceBps ?? null;
  const hasLiveSupply = totalSupplyRaw !== null && totalSupplyRaw > 0n;
  const hasPaymentVaultAssets = Number(bestVault?.totalAssetsUsd || 0) > 0;
  const currentAnomaly = hasLiveSupply && hasPaymentVaultAssets && navVsTokenPriceBps !== null && Math.abs(navVsTokenPriceBps) >= NAV_DIVERGENCE_BPS;
  return {
    ...row,
    codePresent: Boolean(code && code !== "0x"),
    symbol: decodeStringResult(symbolRaw, "symbol"),
    name: decodeStringResult(nameRaw, "name"),
    decimals,
    totalSupplyRaw: totalSupplyRaw?.toString() || null,
    totalSupply: totalSupplyRaw === null ? null : ethers.formatUnits(totalSupplyRaw, decimals),
    tokenPriceUsd,
    vaults,
    bestVault,
    currentAnomaly,
    anomaly: {
      navVsTokenPriceBps,
      thresholdBps: NAV_DIVERGENCE_BPS,
      publicTokenPriceAvailable: Boolean(tokenPriceUsd),
      liveSupplyRequired: hasLiveSupply,
      paymentVaultAssetsRequired: hasPaymentVaultAssets,
      reference: bestVault ? "best vault NAV in payment asset versus DeFiLlama token price" : "no Centrifuge payment vault resolved",
    },
    blocker: currentAnomaly
      ? "NAV/reference divergence needs exact consumer and permissionless exit proof before fork"
      : "No current NAV/reference divergence above threshold or token price unavailable",
  };
}

async function enrichProducers(provider, chain, rows) {
  const assetAddresses = [...new Set([...(chain.assets || []), ...rows.map((r) => r.address)].map(lowerAddress).filter(Boolean))];
  const prices = pricesToAddressMap(chain, await fetchAddressPrices(chain, assetAddresses));
  const out = [];
  for (let i = 0; i < rows.length; i += RPC_BATCH_SIZE) {
    const batch = rows.slice(i, i + RPC_BATCH_SIZE);
    out.push(...await Promise.all(batch.map((row) => enrichProducer(provider, chain, row, prices).catch((err) => ({ ...row, error: err.message || String(err), currentAnomaly: false })))));
  }
  return out;
}

async function morphoQuery(query, variables) {
  const json = await fetchJson("https://api.morpho.org/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
    timeoutMs: 30_000,
  });
  if (json.errors) throw new Error(json.errors[0]?.message || "Morpho GraphQL error");
  return json.data?.markets?.items || [];
}

function morphoFields() {
  return `
    marketId
    loanAsset { symbol address decimals }
    collateralAsset { symbol address decimals }
    oracle { address }
    irmAddress
    lltv
    state { supplyAssetsUsd borrowAssetsUsd liquidityAssetsUsd utilization }
  `;
}

async function fetchMorphoAssetConsumers(chainId, producers, fieldName) {
  const query = `query($chainIds:[Int!]!, $assets:[String!]!) {
    markets(first:100, orderBy:SupplyAssetsUsd, orderDirection:Desc,
      where:{chainId_in:$chainIds, ${fieldName}:$assets}) { items { ${morphoFields()} } }
  }`;
  const assets = producers.map((p) => p.addressLower);
  const rows = [];
  for (let i = 0; i < assets.length; i += 50) {
    rows.push(...await morphoQuery(query, { chainIds: [chainId], assets: assets.slice(i, i + 50) }).catch(() => []));
  }
  return rows;
}

async function fetchTopMorphoMarkets(chainId) {
  const query = `query($chainIds:[Int!]!, $minSupply:Float!) {
    markets(first:${MORPHO_TOP_N}, orderBy:SupplyAssetsUsd, orderDirection:Desc,
      where:{chainId_in:$chainIds, supplyAssetsUsd_gte:$minSupply}) { items { ${morphoFields()} } }
  }`;
  return morphoQuery(query, { chainIds: [chainId], minSupply: 1 }).catch(() => []);
}

function morphoLltvRatio(value) {
  try {
    return Number(BigInt(String(value || 0))) / 1e18;
  } catch (_) {
    return Number(value || 0);
  }
}

function classifyMatch(producer, protocol, side, market, extraBlockers = []) {
  const ltv = Number(market.ltv ?? market.borrowLtv ?? market.maxLtv ?? market.lltv ?? 0);
  const liquidityUsd = Number(market.otherReserveCashUsd ?? market.liquidityAssetsUsd ?? market.cashUsd ?? market.oppositeLiquidityUsd ?? 0);
  const collateralLike = !/loanAsset|borrowAsset/i.test(side);
  const reviewCandidate = collateralLike && ltv > 0 && liquidityUsd >= ROUTE_LIQUIDITY_USD;
  const watchCandidate = reviewCandidate && Boolean(producer.currentAnomaly);
  return {
    protocol,
    side,
    producer: {
      id: producer.id,
      chainId: producer.chainId,
      chain: producer.chain,
      address: producer.address,
      symbol: producer.symbol,
      name: producer.name,
      category: producer.category,
      currentAnomaly: producer.currentAnomaly,
      anomaly: producer.anomaly,
      bestVault: producer.bestVault,
    },
    market,
    reviewCandidate,
    watchCandidate,
    routePositive: false,
    blockers: [
      producer.currentAnomaly ? "Producer NAV/reference divergence is present but not route-proven" : "No current producer NAV/reference anomaly above threshold",
      reviewCandidate ? "Needs route-specific NAV oracle/source review before fork" : null,
      watchCandidate ? "Needs permissionless redemption or executable DEX exit quote before route-positive" : null,
      !collateralLike ? "Producer is debt/loan-side, not collateral overvaluation route" : null,
      ltv <= 0 ? "Collateral LTV disabled or unconfirmed" : null,
      liquidityUsd < ROUTE_LIQUIDITY_USD ? "Route-side liquidity below threshold or unpriced" : null,
      "No fork proof or signed-action justification",
      ...extraBlockers,
    ].filter(Boolean),
  };
}

async function scanMorpho(provider, chainId, producers) {
  const byAddress = new Map(producers.map((p) => [p.addressLower, p]));
  const [collateral, loan, topMarkets] = await Promise.all([
    fetchMorphoAssetConsumers(chainId, producers, "collateralAssetAddress_in"),
    fetchMorphoAssetConsumers(chainId, producers, "loanAssetAddress_in"),
    fetchTopMorphoMarkets(chainId),
  ]);
  const rows = [];
  for (const market of collateral) {
    const producer = byAddress.get(lowerAddress(market.collateralAsset?.address));
    if (!producer) continue;
    rows.push(classifyMatch(producer, "Morpho Blue", "collateralAsset", {
      marketId: market.marketId,
      loanAsset: market.loanAsset,
      collateralAsset: market.collateralAsset,
      oracle: market.oracle,
      irmAddress: market.irmAddress,
      lltv: morphoLltvRatio(market.lltv),
      liquidityAssetsUsd: Number(market.state?.liquidityAssetsUsd || 0),
      borrowAssetsUsd: Number(market.state?.borrowAssetsUsd || 0),
      supplyAssetsUsd: Number(market.state?.supplyAssetsUsd || 0),
      utilization: market.state?.utilization ?? null,
    }));
  }
  for (const market of loan) {
    const producer = byAddress.get(lowerAddress(market.loanAsset?.address));
    if (!producer) continue;
    rows.push(classifyMatch(producer, "Morpho Blue", "loanAsset", {
      marketId: market.marketId,
      loanAsset: market.loanAsset,
      collateralAsset: market.collateralAsset,
      oracle: market.oracle,
      lltv: morphoLltvRatio(market.lltv),
      liquidityAssetsUsd: Number(market.state?.liquidityAssetsUsd || 0),
      borrowAssetsUsd: Number(market.state?.borrowAssetsUsd || 0),
      supplyAssetsUsd: Number(market.state?.supplyAssetsUsd || 0),
      utilization: market.state?.utilization ?? null,
    }));
  }

  const oracleMarkets = new Map();
  for (const market of topMarkets) {
    const oracle = lowerAddress(market.oracle?.address);
    if (!oracle || oracle === ethers.ZeroAddress.toLowerCase()) continue;
    if (!oracleMarkets.has(oracle)) oracleMarkets.set(oracle, []);
    oracleMarkets.get(oracle).push(market);
  }
  const oracleEntries = [...oracleMarkets.entries()];
  for (let i = 0; i < oracleEntries.length; i += RPC_BATCH_SIZE) {
    const batch = oracleEntries.slice(i, i + RPC_BATCH_SIZE);
    const refs = await Promise.all(batch.map(async ([oracle]) => ({ oracle, refs: await findProducerReferencesInAddress(provider, oracle, producers).catch(() => []) })));
    for (const { oracle, refs: matchedRefs } of refs) {
      for (const ref of matchedRefs) {
        for (const market of oracleMarkets.get(oracle) || []) {
          rows.push(classifyMatch(ref.producer, "Morpho Blue", "oracleBytecodeReference", {
            marketId: market.marketId,
            loanAsset: market.loanAsset,
            collateralAsset: market.collateralAsset,
            oracle: market.oracle,
            oracleReference: ref.reference,
            irmAddress: market.irmAddress,
            lltv: morphoLltvRatio(market.lltv),
            liquidityAssetsUsd: Number(market.state?.liquidityAssetsUsd || 0),
            borrowAssetsUsd: Number(market.state?.borrowAssetsUsd || 0),
            supplyAssetsUsd: Number(market.state?.supplyAssetsUsd || 0),
          }, ["Bytecode reference needs source-level oracle confirmation"]));
        }
      }
    }
  }
  return { rows, stats: { collateralMatches: collateral.length, loanMatches: loan.length, topMarketsScanned: topMarkets.length, oracleContractsScanned: oracleEntries.length } };
}

async function scanAave(provider, chain, producers) {
  const pool = normalizeAddress(chain.aavePool);
  if (!pool) return { rows: [], stats: { reservesScanned: 0, priceSourcesScanned: 0 } };
  const producersByAddress = new Map(producers.map((p) => [p.addressLower, p]));
  const reservesRaw = await safeProviderCall(provider, pool, AAVE_POOL.encodeFunctionData("getReservesList", []));
  const reserves = (decodeResult(reservesRaw, AAVE_POOL, "getReservesList")?.[0] || []).map(normalizeAddress).filter(Boolean);
  if (!reserves.length) return { rows: [], stats: { reservesScanned: 0, priceSourcesScanned: 0 } };

  const providerRaw = await safeProviderCall(provider, pool, AAVE_POOL.encodeFunctionData("ADDRESSES_PROVIDER", []));
  const addressesProvider = normalizeAddress(decodeResult(providerRaw, AAVE_POOL, "ADDRESSES_PROVIDER")?.[0]);
  const oracleRaw = addressesProvider ? await safeProviderCall(provider, addressesProvider, AAVE_ADDRESSES_PROVIDER.encodeFunctionData("getPriceOracle", [])) : null;
  const priceOracle = normalizeAddress(decodeResult(oracleRaw, AAVE_ADDRESSES_PROVIDER, "getPriceOracle")?.[0]);
  const metas = [];
  for (const reserve of reserves) {
    const [dataRaw, symbolRaw] = await Promise.all([
      safeProviderCall(provider, pool, AAVE_POOL.encodeFunctionData("getReserveData", [reserve])),
      safeProviderCall(provider, reserve, ERC20.encodeFunctionData("symbol", [])),
    ]);
    if (!dataRaw || dataRaw === "0x") continue;
    const cfg = decodeAaveConfig(BigInt(wordAt(dataRaw, 0) || 0n));
    const aToken = normalizeAddress(addressWordAt(dataRaw, 8) || addressWordAt(dataRaw, 9));
    const priceSource = priceOracle
      ? normalizeAddress(decodeResult(await safeProviderCall(provider, priceOracle, AAVE_ORACLE.encodeFunctionData("getSourceOfAsset", [reserve])), AAVE_ORACLE, "getSourceOfAsset")?.[0])
      : null;
    const decimals = cfg.decimals || await erc20Decimals(provider, reserve).catch(() => 18);
    const cashRaw = aToken ? await erc20Balance(provider, reserve, aToken).catch(() => 0n) : 0n;
    metas.push({
      protocol: "Aave V3",
      pool,
      addressesProvider,
      priceOracle,
      reserve,
      symbol: decodeStringResult(symbolRaw, "symbol"),
      aToken,
      priceSource,
      cashRaw: cashRaw.toString(),
      cash: formatUnitsNumber(cashRaw, decimals),
      ...cfg,
    });
  }
  const prices = pricesToAddressMap(chain, await fetchAddressPrices(chain, metas.map((m) => m.reserve)));
  for (const meta of metas) meta.cashUsd = (prices.get(meta.reserve.toLowerCase()) || 0) * Number(meta.cash || 0);
  const borrowableCashUsd = metas.filter((m) => m.active && !m.paused && m.borrowingEnabled).reduce((sum, m) => sum + Number(m.cashUsd || 0), 0);
  const rows = [];
  for (const meta of metas) {
    const producer = producersByAddress.get(meta.reserve.toLowerCase());
    if (producer) rows.push(classifyMatch(producer, "Aave V3", "reserveAsset", { ...meta, otherReserveCashUsd: Math.max(0, borrowableCashUsd - Number(meta.cashUsd || 0)) }));
  }
  const uniqueSources = [...new Set(metas.map((m) => m.priceSource?.toLowerCase()).filter(Boolean))];
  for (let i = 0; i < uniqueSources.length; i += RPC_BATCH_SIZE) {
    const batch = uniqueSources.slice(i, i + RPC_BATCH_SIZE);
    const refs = await Promise.all(batch.map(async (source) => ({ source, refs: await findProducerReferencesInAddress(provider, source, producers).catch(() => []) })));
    for (const { source, refs: matchedRefs } of refs) {
      for (const ref of matchedRefs) {
        for (const meta of metas.filter((m) => m.priceSource?.toLowerCase() === source)) {
          rows.push(classifyMatch(ref.producer, "Aave V3", "priceSourceBytecodeReference", { ...meta, priceSourceReference: ref.reference, otherReserveCashUsd: Math.max(0, borrowableCashUsd - Number(meta.cashUsd || 0)) }, ["Bytecode reference needs source-level oracle confirmation"]));
        }
      }
    }
  }
  return { rows, stats: { reservesScanned: metas.length, priceSourcesScanned: uniqueSources.length } };
}

async function scanEuler(provider, chain, producers) {
  const factory = normalizeAddress(chain.eulerFactory);
  if (!factory) return { rows: [], stats: { factoryListLength: 0, evaultsScanned: 0, oracleContractsScanned: 0 } };
  const producersByAddress = new Map(producers.map((p) => [p.addressLower, p]));
  const lengthRaw = await safeProviderCall(provider, factory, GENERIC_FACTORY.encodeFunctionData("getProxyListLength", []));
  const length = Number(decodeResult(lengthRaw, GENERIC_FACTORY, "getProxyListLength")?.[0] || 0n);
  if (!length) return { rows: [], stats: { factoryListLength: 0, evaultsScanned: 0, oracleContractsScanned: 0 } };
  const start = Math.max(0, length - MAX_EULER_VAULTS);
  const evaults = [];
  for (let cursor = start; cursor < length; cursor += 100) {
    const end = Math.min(length, cursor + 100);
    const raw = await safeProviderCall(provider, factory, GENERIC_FACTORY.encodeFunctionData("getProxyListSlice", [cursor, end]));
    evaults.push(...(decodeResult(raw, GENERIC_FACTORY, "getProxyListSlice")?.[0] || []).map(normalizeAddress).filter(Boolean));
  }
  const metas = [];
  for (let i = 0; i < evaults.length; i += RPC_BATCH_SIZE) {
    const batch = evaults.slice(i, i + RPC_BATCH_SIZE);
    const rows = await Promise.all(batch.map(async (evault) => {
      const [assetRaw, oracleRaw, cashRaw, borrowsRaw, symbolRaw, ltvListRaw] = await Promise.all([
        safeProviderCall(provider, evault, EVAULT.encodeFunctionData("asset", [])),
        safeProviderCall(provider, evault, EVAULT.encodeFunctionData("oracle", [])),
        safeProviderCall(provider, evault, EVAULT.encodeFunctionData("cash", [])),
        safeProviderCall(provider, evault, EVAULT.encodeFunctionData("totalBorrows", [])),
        safeProviderCall(provider, evault, EVAULT.encodeFunctionData("symbol", [])),
        safeProviderCall(provider, evault, EVAULT.encodeFunctionData("LTVList", [])),
      ]);
      const asset = normalizeAddress(decodeResult(assetRaw, EVAULT, "asset")?.[0]);
      if (!asset) return null;
      const ltvList = (decodeResult(ltvListRaw, EVAULT, "LTVList")?.[0] || []).map(normalizeAddress).filter(Boolean);
      const ltvEntries = [];
      for (const collateral of ltvList.slice(0, 40)) {
        const raw = await safeProviderCall(provider, evault, EVAULT.encodeFunctionData("LTVBorrow", [collateral]));
        ltvEntries.push({ collateral, borrowLtv: ltvBpsToRatio(decodeResult(raw, EVAULT, "LTVBorrow")?.[0] || 0) });
      }
      return {
        protocol: "Euler EVK",
        factory,
        evault,
        asset,
        symbol: decodeStringResult(symbolRaw, "symbol"),
        oracle: normalizeAddress(decodeResult(oracleRaw, EVAULT, "oracle")?.[0]),
        cashRaw: String(decodeResult(cashRaw, EVAULT, "cash")?.[0] || 0n),
        totalBorrowsRaw: String(decodeResult(borrowsRaw, EVAULT, "totalBorrows")?.[0] || 0n),
        ltvEntries,
        maxBorrowLtv: ltvEntries.reduce((max, row) => Math.max(max, Number(row.borrowLtv || 0)), 0),
      };
    }));
    metas.push(...rows.filter(Boolean));
  }
  const prices = pricesToAddressMap(chain, await fetchAddressPrices(chain, metas.map((m) => m.asset)));
  for (const meta of metas) {
    const decimals = await erc20Decimals(provider, meta.asset).catch(() => 18);
    meta.assetDecimals = decimals;
    meta.cash = formatUnitsNumber(BigInt(meta.cashRaw), decimals);
    meta.totalBorrows = formatUnitsNumber(BigInt(meta.totalBorrowsRaw), decimals);
    meta.cashUsd = (prices.get(meta.asset.toLowerCase()) || 0) * Number(meta.cash || 0);
  }
  const rows = [];
  for (const meta of metas) {
    const borrowProducer = producersByAddress.get(meta.asset.toLowerCase());
    if (borrowProducer) rows.push(classifyMatch(borrowProducer, "Euler EVK", "borrowAsset", meta));
    for (const ltv of meta.ltvEntries) {
      const collateralProducer = producersByAddress.get(ltv.collateral.toLowerCase());
      if (collateralProducer) rows.push(classifyMatch(collateralProducer, "Euler EVK", "collateralVault", { ...meta, collateral: ltv.collateral, borrowLtv: ltv.borrowLtv }));
    }
  }
  const oracleMarkets = new Map();
  for (const meta of metas) {
    const oracle = lowerAddress(meta.oracle);
    if (!oracle || oracle === ethers.ZeroAddress.toLowerCase()) continue;
    if (!oracleMarkets.has(oracle)) oracleMarkets.set(oracle, []);
    oracleMarkets.get(oracle).push(meta);
  }
  const oracleEntries = [...oracleMarkets.entries()];
  for (let i = 0; i < oracleEntries.length; i += RPC_BATCH_SIZE) {
    const batch = oracleEntries.slice(i, i + RPC_BATCH_SIZE);
    const refs = await Promise.all(batch.map(async ([oracle]) => ({ oracle, refs: await findProducerReferencesInAddress(provider, oracle, producers).catch(() => []) })));
    for (const { oracle, refs: matchedRefs } of refs) {
      for (const ref of matchedRefs) {
        for (const meta of oracleMarkets.get(oracle) || []) rows.push(classifyMatch(ref.producer, "Euler EVK", "oracleBytecodeReference", { ...meta, oracleReference: ref.reference }, ["Bytecode reference needs source-level oracle confirmation"]));
      }
    }
  }
  return { rows, stats: { factoryListLength: length, factoryListStart: start, evaultsScanned: metas.length, oracleContractsScanned: oracleEntries.length } };
}

function parseSiloConfig(decoded) {
  const row = decoded?.[0];
  if (!row) return null;
  const token = normalizeAddress(row[3]);
  const silo = normalizeAddress(row[2]);
  if (!token || !silo) return null;
  return {
    silo,
    token,
    protectedShareToken: normalizeAddress(row[4]),
    collateralShareToken: normalizeAddress(row[5]),
    debtShareToken: normalizeAddress(row[6]),
    solvencyOracle: normalizeAddress(row[7]),
    maxLtvOracle: normalizeAddress(row[8]),
    maxLtv: siloLtvToRatio(row[10] || 0n),
    lt: siloLtvToRatio(row[11] || 0n),
  };
}

async function scanSilo(provider, chainId, chain, producers) {
  const factory = loadSiloDeployment(chainId, "SiloFactory");
  if (!factory) return { rows: [], stats: { idsScanned: 0, marketsScanned: 0, oracleContractsScanned: 0 } };
  const producersByAddress = new Map(producers.map((p) => [p.addressLower, p]));
  const nextRaw = await safeProviderCall(provider, factory, SILO_FACTORY.encodeFunctionData("getNextSiloId", []));
  const nextId = decodeResult(nextRaw, SILO_FACTORY, "getNextSiloId")?.[0];
  if (!nextId) return { rows: [], stats: { idsScanned: 0, marketsScanned: 0, oracleContractsScanned: 0 } };
  const start = nextId > BigInt(MAX_SILO_IDS) ? nextId - BigInt(MAX_SILO_IDS) : 1n;
  const pairs = [];
  const tokenSet = new Set();
  for (let id = start; id < nextId; id++) {
    const cfgRaw = await safeProviderCall(provider, factory, SILO_FACTORY.encodeFunctionData("idToSiloConfig", [id]));
    const config = normalizeAddress(decodeResult(cfgRaw, SILO_FACTORY, "idToSiloConfig")?.[0]);
    if (!config || config === ethers.ZeroAddress) continue;
    const silosRaw = await safeProviderCall(provider, config, SILO_CONFIG.encodeFunctionData("getSilos", []));
    const silosDecoded = decodeResult(silosRaw, SILO_CONFIG, "getSilos");
    const silos = [normalizeAddress(silosDecoded?.[0]), normalizeAddress(silosDecoded?.[1])].filter(Boolean);
    if (silos.length < 2) continue;
    const sides = [];
    for (const silo of silos) {
      const [configRaw, liquidityRaw, storageRaw] = await Promise.all([
        safeProviderCall(provider, config, SILO_CONFIG.encodeFunctionData("getConfig", [silo])),
        safeProviderCall(provider, silo, SILO.encodeFunctionData("getLiquidity", [])),
        safeProviderCall(provider, silo, SILO.encodeFunctionData("getSiloStorage", [])),
      ]);
      const cfg = parseSiloConfig(decodeResult(configRaw, SILO_CONFIG, "getConfig"));
      if (!cfg) continue;
      const storage = decodeResult(storageRaw, SILO, "getSiloStorage");
      const liquidity = decodeResult(liquidityRaw, SILO, "getLiquidity")?.[0] || 0n;
      tokenSet.add(cfg.token.toLowerCase());
      sides.push({
        ...cfg,
        id: id.toString(),
        config,
        liquidityRaw: liquidity.toString(),
        collateralAssetsRaw: (storage?.[3] || 0n).toString(),
        debtAssetsRaw: (storage?.[4] || 0n).toString(),
      });
    }
    if (sides.length === 2) pairs.push({ id: id.toString(), config, sides });
  }
  const prices = pricesToAddressMap(chain, await fetchAddressPrices(chain, [...tokenSet]));
  const tokenMeta = new Map();
  for (const token of tokenSet) {
    const address = normalizeAddress(token);
    if (!address) continue;
    const [decimals, symbolRaw] = await Promise.all([
      erc20Decimals(provider, address).catch(() => 18),
      safeProviderCall(provider, address, ERC20.encodeFunctionData("symbol", [])),
    ]);
    tokenMeta.set(address.toLowerCase(), { decimals, symbol: decodeStringResult(symbolRaw, "symbol"), priceUsd: prices.get(address.toLowerCase()) || 0 });
  }
  for (const pair of pairs) {
    for (const side of pair.sides) {
      const meta = tokenMeta.get(side.token.toLowerCase()) || { decimals: 18, priceUsd: 0 };
      side.tokenSymbol = meta.symbol;
      side.tokenDecimals = meta.decimals;
      side.liquidity = formatUnitsNumber(BigInt(side.liquidityRaw), meta.decimals);
      side.liquidityUsd = Number(side.liquidity || 0) * Number(meta.priceUsd || 0);
    }
  }
  const rows = [];
  const oracleRows = [];
  for (const pair of pairs) {
    for (let idx = 0; idx < pair.sides.length; idx++) {
      const side = pair.sides[idx];
      const opposite = pair.sides[idx === 0 ? 1 : 0];
      const consumer = {
        protocol: "Silo V3",
        factory,
        id: pair.id,
        config: pair.config,
        silo: side.silo,
        token: side.token,
        tokenSymbol: side.tokenSymbol,
        solvencyOracle: side.solvencyOracle,
        maxLtvOracle: side.maxLtvOracle,
        maxLtv: side.maxLtv,
        lt: side.lt,
        liquidityUsd: side.liquidityUsd,
        oppositeSilo: opposite.silo,
        oppositeToken: opposite.token,
        oppositeTokenSymbol: opposite.tokenSymbol,
        oppositeLiquidityUsd: opposite.liquidityUsd,
      };
      const producer = producersByAddress.get(side.token.toLowerCase());
      if (producer) rows.push(classifyMatch(producer, "Silo V3", "collateralToken", consumer));
      for (const oracle of [side.solvencyOracle, side.maxLtvOracle]) {
        const normalizedOracle = lowerAddress(oracle);
        if (!normalizedOracle || normalizedOracle === ethers.ZeroAddress.toLowerCase()) continue;
        oracleRows.push({ oracle: normalizedOracle, consumer });
      }
    }
  }
  const uniqueOracles = [...new Set(oracleRows.map((row) => row.oracle))];
  for (let i = 0; i < uniqueOracles.length; i += RPC_BATCH_SIZE) {
    const batch = uniqueOracles.slice(i, i + RPC_BATCH_SIZE);
    const refs = await Promise.all(batch.map(async (oracle) => ({ oracle, refs: await findProducerReferencesInAddress(provider, oracle, producers).catch(() => []) })));
    for (const { oracle, refs: matchedRefs } of refs) {
      for (const ref of matchedRefs) {
        for (const row of oracleRows.filter((r) => r.oracle === oracle)) rows.push(classifyMatch(ref.producer, "Silo V3", "oracleBytecodeReference", { ...row.consumer, oracle, oracleReference: ref.reference }, ["Bytecode reference needs source-level oracle confirmation"]));
      }
    }
  }
  return { rows, stats: { idsScanned: Number(nextId - start), marketsScanned: pairs.length, oracleContractsScanned: uniqueOracles.length } };
}

function dedupeRows(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = [
      row.protocol,
      row.side,
      row.producer.chainId,
      row.producer.address?.toLowerCase(),
      row.market.marketId || row.market.reserve || row.market.evault || row.market.config || row.market.silo || "",
      row.market.oracleReference?.address || row.market.priceSourceReference?.address || "",
    ].join(":").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function breakdownRows(rows) {
  return rows.reduce((acc, row) => {
    acc.byProtocol[row.protocol] = (acc.byProtocol[row.protocol] || 0) + 1;
    acc.bySide[row.side] = (acc.bySide[row.side] || 0) + 1;
    return acc;
  }, { byProtocol: {}, bySide: {} });
}

function mergeBreakdowns(results) {
  const out = { byProtocol: {}, bySide: {} };
  for (const result of results) {
    for (const key of Object.keys(out)) {
      for (const [name, value] of Object.entries(result.matchBreakdown?.[key] || {})) {
        out[key][name] = (out[key][name] || 0) + Number(value || 0);
      }
    }
  }
  return out;
}

async function scanChain(chainId, rpc) {
  const chain = CHAINS[chainId];
  const provider = new ethers.JsonRpcProvider(rpc);
  const blockNumber = await provider.getBlockNumber();
  console.log(`Scanning ${chain.name}: factory events`);
  const discovery = await discoverShareClassTokens(provider, chain, chainId);
  const producers = await enrichProducers(provider, chain, discovery.tokens);
  const producersWithVaults = producers.filter((p) => p.vaults?.length);
  console.log(`Scanning ${chain.name}: producers=${producers.length} vaultResolved=${producersWithVaults.length}`);

  const [morpho, aave, euler, silo] = await Promise.all([
    scanMorpho(provider, chainId, producers),
    scanAave(provider, chain, producers),
    scanEuler(provider, chain, producers),
    scanSilo(provider, chainId, chain, producers),
  ]);
  const matches = dedupeRows([...morpho.rows, ...aave.rows, ...euler.rows, ...silo.rows]);
  matches.sort((a, b) => Number(b.routePositive) - Number(a.routePositive) || Number(b.watchCandidate) - Number(a.watchCandidate) || Number(b.reviewCandidate) - Number(a.reviewCandidate) || Number(b.market.otherReserveCashUsd || b.market.cashUsd || b.market.liquidityAssetsUsd || b.market.oppositeLiquidityUsd || 0) - Number(a.market.otherReserveCashUsd || a.market.cashUsd || a.market.liquidityAssetsUsd || a.market.oppositeLiquidityUsd || 0));
  return {
    chainId,
    chain: chain.name,
    rpcResolved: true,
    blockNumber,
    factoryStats: discovery.factoryStats,
    producersDiscovered: producers.length,
    producersWithVaults: producersWithVaults.length,
    producersWithPublicTokenPrice: producers.filter((p) => p.tokenPriceUsd).length,
    producerAnomalies: producers.filter((p) => p.currentAnomaly).length,
    totalNavUsd: producers.reduce((sum, p) => sum + Number(p.bestVault?.totalAssetsUsd || 0), 0),
    aaveReservesScanned: aave.stats.reservesScanned,
    aavePriceSourcesScanned: aave.stats.priceSourcesScanned,
    eulerFactoryListLength: euler.stats.factoryListLength,
    eulerFactoryListStart: euler.stats.factoryListStart,
    eulerVaultsScanned: euler.stats.evaultsScanned,
    eulerOracleContractsScanned: euler.stats.oracleContractsScanned,
    siloIdsScanned: silo.stats.idsScanned,
    siloMarketsScanned: silo.stats.marketsScanned,
    siloOracleContractsScanned: silo.stats.oracleContractsScanned,
    morphoCollateralMatches: morpho.stats.collateralMatches,
    morphoLoanMatches: morpho.stats.loanMatches,
    morphoTopMarketsScanned: morpho.stats.topMarketsScanned,
    morphoOracleContractsScanned: morpho.stats.oracleContractsScanned,
    matches: matches.length,
    matchBreakdown: breakdownRows(matches),
    reviewCandidates: matches.filter((row) => row.reviewCandidate).length,
    watchCandidates: matches.filter((row) => row.watchCandidate).length,
    routePositive: matches.filter((row) => row.routePositive).length,
    topProducers: producers
      .slice()
      .sort((a, b) => Number(b.bestVault?.totalAssetsUsd || 0) - Number(a.bestVault?.totalAssetsUsd || 0))
      .slice(0, 30),
    topMatches: matches.slice(0, 50),
  };
}

async function main() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const chainIds = selectedChainIds();
  const rpcPool = await resolveRpcPool(chainIds);
  const results = [];
  for (const chainId of chainIds) {
    if (!rpcPool[chainId]) {
      results.push({ chainId, chain: CHAINS[chainId].name, rpcResolved: false, error: "missing-rpc" });
      continue;
    }
    results.push(await scanChain(chainId, rpcPool[chainId]));
  }
  const routePositive = results.reduce((sum, r) => sum + Number(r.routePositive || 0), 0);
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-centrifuge-nav-consumer-graph.js",
    scope: "Read-only Centrifuge RWA NAV receipt-token producer inventory and lending/oracle consumer graph",
    safety: {
      rpcInventoryRead: Object.keys(rpcPool).length > 0,
      rpcUrlsStored: false,
      signedActions: false,
      exploitExecuteCalls: false,
      routePositive: routePositive > 0,
      signedActionJustified: false,
    },
    thresholds: {
      routeLiquidityUsd: ROUTE_LIQUIDITY_USD,
      navDivergenceBps: NAV_DIVERGENCE_BPS,
      maxEulerVaults: MAX_EULER_VAULTS,
      maxSiloIds: MAX_SILO_IDS,
      morphoTopN: MORPHO_TOP_N,
      logChunk: LOG_CHUNK,
    },
    producerSource: {
      chainSelection: {
        defaultChainIds: DEFAULT_CHAIN_IDS,
        selectedChainIds: chainIds,
        skippedChainIds: Object.keys(CHAINS).map(Number).filter((id) => !chainIds.includes(id)),
        override: "Set CENTRIFUGE_CHAIN_IDS=all or a comma-separated chain id list for broader slower scans",
      },
      factories: Object.fromEntries(Object.entries(CHAINS).map(([chainId, chain]) => [chain.name, (chain.factories || []).map((f) => ({ kind: f.kind, address: f.address, startBlock: f.startBlock }))])),
      eventSources: ["DeployTranche(uint64,bytes16,address)", "AddShareClass(uint64,bytes16,address)"],
      paymentAssets: Object.fromEntries(Object.entries(CHAINS).map(([, chain]) => [chain.name, chain.assets || []])),
    },
    summary: {
      chainsScanned: results.filter((r) => r.rpcResolved).length,
      chainsMissingRpc: results.filter((r) => !r.rpcResolved).map((r) => r.chain),
      producersDiscovered: results.reduce((sum, r) => sum + Number(r.producersDiscovered || 0), 0),
      producersWithVaults: results.reduce((sum, r) => sum + Number(r.producersWithVaults || 0), 0),
      producerAnomalies: results.reduce((sum, r) => sum + Number(r.producerAnomalies || 0), 0),
      totalNavUsd: results.reduce((sum, r) => sum + Number(r.totalNavUsd || 0), 0),
      matches: results.reduce((sum, r) => sum + Number(r.matches || 0), 0),
      matchBreakdown: mergeBreakdowns(results),
      reviewCandidates: results.reduce((sum, r) => sum + Number(r.reviewCandidates || 0), 0),
      watchCandidates: results.reduce((sum, r) => sum + Number(r.watchCandidates || 0), 0),
      routePositive,
      signedActionJustified: false,
    },
    results,
    nextRoutePositiveCriteria: [
      "Exact Centrifuge share-class token is collateral or oracle input in a consumer with positive LTV/LLTV",
      "Borrow-side liquidity is live and above gas/slippage threshold",
      "Producer NAV/reference or consumer oracle value is currently favorable versus executable acquisition cost",
      "Permissionless redemption, transfer, or executable DEX exit exists for the exact token and size",
      "Fork simulation extracts positive value from the exact joined route",
    ],
  };
  fs.writeFileSync(OUT, JSON.stringify(artifact, jsonReplacer, 2) + "\n");
  console.log(`Centrifuge NAV consumer graph: producers=${artifact.summary.producersDiscovered} matches=${artifact.summary.matches} review=${artifact.summary.reviewCandidates} watch=${artifact.summary.watchCandidates} routePositive=${artifact.summary.routePositive}`);
  console.log(`Artifact: ${path.relative(WORKSPACE, OUT).replace(/\\/g, "/")}`);
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
