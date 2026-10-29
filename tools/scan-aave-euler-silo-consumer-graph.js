#!/usr/bin/env node
// Read-only Aave/Euler/Silo consumer graph joiner for already-mapped producer tokens.
// Resolves RPC inventory in memory only and never prints or stores endpoint URLs.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "aave-euler-silo-consumer-graph.json");
const SILO_CORE_DEPLOYMENTS = path.join(WORKSPACE, "targets", "silo-contracts-v2", "silo-core", "deployments");

const TIMEOUT_MS = 15_000;
const RPC_BATCH_SIZE = 20;
const MAX_EULER_VAULTS = Number(process.env.AES_MAX_EULER_VAULTS || "700");
const MAX_SILO_IDS = Number(process.env.AES_MAX_SILO_IDS || "700");
const ROUTE_LIQUIDITY_USD = Number(process.env.AES_ROUTE_LIQUIDITY_USD || "10000");
const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

const CHAINS = {
  1: {
    name: "Ethereum",
    coinSlug: "ethereum",
    aavePool: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
    eulerFactory: "0x29a56a1b8214D9Cf7c5561811750D5cBDb45CC8e",
    siloFolder: "mainnet",
  },
  8453: {
    name: "Base",
    coinSlug: "base",
    aavePool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
    siloFolder: "base",
  },
  42161: {
    name: "Arbitrum",
    coinSlug: "arbitrum",
    aavePool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    siloFolder: "arbitrum_one",
  },
  10: {
    name: "Optimism",
    coinSlug: "optimism",
    aavePool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    siloFolder: "optimism",
  },
  56: {
    name: "BNB Chain",
    coinSlug: "bsc",
    siloFolder: "bnb",
  },
  146: {
    name: "Sonic",
    coinSlug: "sonic",
    siloFolder: "sonic",
  },
  57073: {
    name: "Ink",
    coinSlug: "ink",
    aavePool: "0x2816cf15F6d2A220E789aA011D5EE4eB6c47FEbA",
    siloFolder: "ink",
  },
};

const CHAIN_NAME_TO_ID = {
  ethereum: 1,
  mainnet: 1,
  base: 8453,
  arbitrum: 42161,
  arbitrumone: 42161,
  arbitrum_one: 42161,
  optimism: 10,
  bsc: 56,
  bnb: 56,
  binance: 56,
  binancesmartchain: 56,
  sonic: 146,
  ink: 57073,
};

const FILES = {
  usdt0: path.join(WORKSPACE, "reports", "raw", "fast", "usdt0-oft-routes.json"),
  ethena: path.join(WORKSPACE, "reports", "raw", "fast", "ethena-usde-live.json"),
  lorenzo: path.join(WORKSPACE, "reports", "raw", "fast", "lorenzo-susd1plus-live.json"),
  hyperlane: path.join(WORKSPACE, "reports", "raw", "fast", "hyperlane-warp-routes.json"),
  erc4626Joiner: path.join(WORKSPACE, "reports", "raw", "fast", "erc4626-consumer-joiner.json"),
};

const ERC20 = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
]);
const AAVE_POOL = new ethers.Interface([
  "function ADDRESSES_PROVIDER() view returns (address)",
  "function getReservesList() view returns (address[])",
  "function getReserveData(address asset) view returns (tuple(uint256 data) configuration,uint128 liquidityIndex,uint128 currentLiquidityRate,uint128 variableBorrowIndex,uint128 currentVariableBorrowRate,uint128 currentStableBorrowRate,uint40 lastUpdateTimestamp,uint16 id,address aTokenAddress,address stableDebtTokenAddress,address variableDebtTokenAddress,address interestRateStrategyAddress,uint128 accruedToTreasury,uint128 unbacked,uint128 isolationModeTotalDebt)",
]);
const AAVE_ADDRESSES_PROVIDER = new ethers.Interface([
  "function getPriceOracle() view returns (address)",
]);
const AAVE_ORACLE = new ethers.Interface([
  "function getSourceOfAsset(address asset) view returns (address)",
]);
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
const BEACON = new ethers.Interface([
  "function implementation() view returns (address)",
]);

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
  const addr = normalizeAddress(value);
  return addr ? addr.toLowerCase() : null;
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
  const urls = loadRpcUrls();
  const pool = {};
  for (const url of urls) {
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

function decodeUintResult(raw, fn) {
  if (!raw || raw === "0x") return null;
  try {
    return BigInt(ERC20.decodeFunctionResult(fn, raw)[0]);
  } catch (_) {
    try { return BigInt(raw); } catch (_) { return null; }
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

function pricesToAddressMap(chain, prices) {
  const out = new Map();
  for (const [key, row] of Object.entries(prices || {})) {
    const prefix = `${chain.coinSlug}:`;
    if (!key.toLowerCase().startsWith(prefix)) continue;
    out.set(key.slice(prefix.length).toLowerCase(), Number(row.price || 0));
  }
  return out;
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
    const url = `https://coins.llama.fi/prices/current/${uniq.slice(i, i + 50).join(",")}?searchWidth=6h`;
    const json = await fetchJson(url, { timeoutMs: 30_000 }).catch(() => ({ coins: {} }));
    Object.assign(out, json.coins || {});
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

function addProducer(map, row) {
  const chainId = Number(row.chainId);
  const address = normalizeAddress(row.address);
  if (!CHAINS[chainId] || !address) return;
  const key = `${chainId}:${address.toLowerCase()}`;
  const existing = map.get(key);
  const tags = new Set([...(existing?.tags || []), ...(row.tags || [])].filter(Boolean));
  const sources = new Set([...(existing?.sources || []), row.source].filter(Boolean));
  map.set(key, {
    id: existing?.id || row.id || key,
    chainId,
    chain: CHAINS[chainId].name,
    address,
    addressLower: address.toLowerCase(),
    symbol: existing?.symbol || row.symbol || null,
    name: existing?.name || row.name || null,
    category: existing?.category || row.category || "producer-token",
    tags: [...tags],
    sources: [...sources],
    currentAnomaly: Boolean(existing?.currentAnomaly || row.currentAnomaly),
    blocker: existing?.blocker || row.blocker || null,
  });
}

function collectUsdt0Producers(map) {
  const artifact = readJson(FILES.usdt0, null);
  for (const scan of artifact?.scans || []) {
    const chainId = Number(scan.docs?.chainId);
    const token = scan.token || scan.escrowToken;
    if (token?.address) {
      addProducer(map, {
        source: "usdt0-oft-routes",
        id: `usdt0:${chainId}:${token.address}`,
        chainId,
        address: token.address,
        symbol: token.symbol || "USDT0",
        name: token.name || "USDT0",
        category: scan.docs?.isSource ? "oft-source-token" : "oft-remote-token",
        tags: ["oft", scan.docs?.isSource ? "source-escrow-backed" : "remote-minted"],
        currentAnomaly: false,
        blocker: "USDT0 OFT scan found no peer/DVN/escrow anomaly",
      });
    }
  }
}

function collectEthenaProducers(map) {
  const artifact = readJson(FILES.ethena, null);
  const addresses = artifact?.addresses || {};
  for (const key of ["USDE", "SUSDE", "USDtb", "sUSDS"]) {
    if (!addresses[key]) continue;
    addProducer(map, {
      source: "ethena-usde-live",
      id: `ethena:${key}`,
      chainId: 1,
      address: addresses[key],
      symbol: key,
      name: key,
      category: key === "SUSDE" ? "yield-bearing-stable" : "stable-receipt",
      tags: ["ethena", key === "SUSDE" ? "share-price" : "stable"],
      currentAnomaly: false,
      blocker: "Ethena scan found role-gated mint/redeem and no donation-positive route",
    });
  }
}

function collectLorenzoProducers(map) {
  const artifact = readJson(FILES.lorenzo, null);
  for (const row of artifact?.result || []) {
    addProducer(map, {
      source: "lorenzo-susd1plus-live",
      id: `lorenzo:${row.chainId}:${row.token?.address}`,
      chainId: row.chainId,
      address: row.token?.address,
      symbol: row.token?.symbol || "sUSD1+",
      name: row.token?.name || "sUSD1+",
      category: "nav-stable-receipt",
      tags: ["lorenzo", row.flags?.includes("public-supply-immediate-mint") ? "public-mint" : null].filter(Boolean),
      currentAnomaly: false,
      blocker: "Lorenzo DEX route is below NAV threshold",
    });
  }
}

function collectHyperlaneProducers(map) {
  const artifact = readJson(FILES.hyperlane, null);
  for (const route of artifact?.topRoutes || []) {
    for (const token of route.topTokens || []) {
      const chainId = CHAIN_NAME_TO_ID[String(token.chainName || "").toLowerCase()];
      const address = normalizeAddress(token.collateralAddressOrDenom || token.addressOrDenom);
      if (!chainId || !address) continue;
      addProducer(map, {
        source: "hyperlane-warp-routes",
        id: `hyperlane:${route.routeId}:${chainId}:${address}`,
        chainId,
        address,
        symbol: token.symbol || route.symbol,
        name: token.name || token.symbol || route.symbol,
        category: "bridge-wrapper-or-collateral",
        tags: ["hyperlane", token.standard, token.riskClass].filter(Boolean),
        currentAnomaly: false,
        blocker: route.blocker || "Hyperlane scan found no locked-vs-remote route-positive mismatch",
      });
    }
  }
}

function collectProducers() {
  const map = new Map();
  collectUsdt0Producers(map);
  collectEthenaProducers(map);
  collectLorenzoProducers(map);
  collectHyperlaneProducers(map);
  return [...map.values()].sort((a, b) => a.chainId - b.chainId || String(a.symbol || "").localeCompare(String(b.symbol || "")));
}

function classifyMatch(producer, protocol, side, market) {
  const ltv = Number(market.ltv || market.borrowLtv || market.maxLtv || 0);
  const liquidityUsd = Number(market.otherReserveCashUsd ?? market.cashUsd ?? market.oppositeLiquidityUsd ?? 0);
  const hasProducerRiskShape = Boolean(
    producer.currentAnomaly
    || producer.category === "yield-bearing-stable"
    || producer.category === "nav-stable-receipt"
    || producer.category === "oft-remote-token"
    || (producer.category === "bridge-wrapper-or-collateral" && !producer.tags.includes("canonical-or-lossless"))
  );
  const reviewCandidate = hasProducerRiskShape && ltv > 0 && liquidityUsd >= ROUTE_LIQUIDITY_USD;
  const watchCandidate = false;
  return {
    protocol,
    side,
    producer,
    market,
    reviewCandidate,
    watchCandidate,
    routePositive: false,
    blockers: [
      "No current producer-side anomaly in source artifact",
      producer.blocker,
      reviewCandidate ? "Needs route-specific economics before fork" : null,
      !hasProducerRiskShape ? "Producer is canonical/lossless or source-side only in current artifacts" : null,
      ltv <= 0 ? "Collateral LTV disabled or unconfirmed" : null,
      liquidityUsd < ROUTE_LIQUIDITY_USD ? "Route-side liquidity below threshold or unpriced" : null,
      side.includes("BytecodeReference") ? "Bytecode reference needs source-level oracle confirmation" : null,
    ].filter(Boolean),
  };
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
  let priceOracle = null;
  if (addressesProvider) {
    const oracleRaw = await safeProviderCall(provider, addressesProvider, AAVE_ADDRESSES_PROVIDER.encodeFunctionData("getPriceOracle", []));
    priceOracle = normalizeAddress(decodeResult(oracleRaw, AAVE_ADDRESSES_PROVIDER, "getPriceOracle")?.[0]);
  }

  const metas = [];
  for (const reserve of reserves) {
    const [dataRaw, symbolRaw] = await Promise.all([
      safeProviderCall(provider, pool, AAVE_POOL.encodeFunctionData("getReserveData", [reserve])),
      safeProviderCall(provider, reserve, ERC20.encodeFunctionData("symbol", [])),
    ]);
    if (!dataRaw || dataRaw === "0x") continue;
    const cfg = decodeAaveConfig(BigInt(wordAt(dataRaw, 0) || 0n));
    const aToken = normalizeAddress(addressWordAt(dataRaw, 8) || addressWordAt(dataRaw, 9));
    const variableDebtToken = normalizeAddress(addressWordAt(dataRaw, 10) || addressWordAt(dataRaw, 11));
    const priceSource = priceOracle
      ? normalizeAddress(decodeResult(
        await safeProviderCall(provider, priceOracle, AAVE_ORACLE.encodeFunctionData("getSourceOfAsset", [reserve])),
        AAVE_ORACLE,
        "getSourceOfAsset",
      )?.[0])
      : null;
    const decimals = cfg.decimals || await erc20Decimals(provider, reserve).catch(() => 18);
    const cashRaw = aToken ? await erc20Balance(provider, reserve, aToken).catch(() => 0n) : 0n;
    metas.push({
      protocol: "Aave V3",
      pool,
      reserve,
      symbol: decodeStringResult(symbolRaw, "symbol"),
      aToken,
      variableDebtToken,
      priceOracle,
      priceSource,
      cashRaw: cashRaw.toString(),
      cash: formatUnitsNumber(cashRaw, decimals),
      ...cfg,
    });
  }

  const prices = pricesToAddressMap(chain, await fetchAddressPrices(chain, metas.map((m) => m.reserve)));
  for (const meta of metas) meta.cashUsd = (prices.get(meta.reserve.toLowerCase()) || 0) * (Number(meta.cash) || 0);
  const borrowableCashUsd = metas.filter((m) => m.active && !m.paused && m.borrowingEnabled).reduce((sum, m) => sum + Number(m.cashUsd || 0), 0);

  const rows = [];
  for (const meta of metas) {
    const producer = producersByAddress.get(meta.reserve.toLowerCase());
    if (!producer) continue;
    rows.push(classifyMatch(producer, "Aave V3", "reserveAsset", { ...meta, otherReserveCashUsd: Math.max(0, borrowableCashUsd - Number(meta.cashUsd || 0)) }));
  }

  const uniqueSources = [...new Set(metas.map((m) => m.priceSource?.toLowerCase()).filter(Boolean))];
  for (let i = 0; i < uniqueSources.length; i += RPC_BATCH_SIZE) {
    const batch = uniqueSources.slice(i, i + RPC_BATCH_SIZE);
    const refs = await Promise.all(batch.map(async (source) => ({ source, refs: await findProducerReferencesInAddress(provider, source, producers).catch(() => []) })));
    for (const { source, refs: matchedRefs } of refs) {
      for (const ref of matchedRefs) {
        for (const meta of metas.filter((m) => m.priceSource?.toLowerCase() === source)) {
          rows.push(classifyMatch(ref.producer, "Aave V3", "priceSourceBytecodeReference", { ...meta, priceSourceReference: ref.reference, otherReserveCashUsd: Math.max(0, borrowableCashUsd - Number(meta.cashUsd || 0)) }));
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
    meta.cashUsd = (prices.get(meta.asset.toLowerCase()) || 0) * (Number(meta.cash) || 0);
  }

  const rows = [];
  for (const meta of metas) {
    const borrowProducer = producersByAddress.get(meta.asset.toLowerCase());
    if (borrowProducer) rows.push(classifyMatch(borrowProducer, "Euler EVK", "borrowAsset", meta));
    for (const ltv of meta.ltvEntries) {
      const collateralProducer = producersByAddress.get(ltv.collateral.toLowerCase());
      if (!collateralProducer) continue;
      rows.push(classifyMatch(collateralProducer, "Euler EVK", "collateralVault", { ...meta, collateral: ltv.collateral, borrowLtv: ltv.borrowLtv }));
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
        for (const meta of oracleMarkets.get(oracle) || []) rows.push(classifyMatch(ref.producer, "Euler EVK", "oracleBytecodeReference", { ...meta, oracleReference: ref.reference }));
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
        for (const row of oracleRows.filter((r) => r.oracle === oracle)) rows.push(classifyMatch(ref.producer, "Silo V3", "oracleBytecodeReference", { ...row.consumer, oracle, oracleReference: ref.reference }));
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
      row.producer.addressLower,
      row.market.reserve || row.market.evault || row.market.config || row.market.silo || "",
      row.market.priceSourceReference?.address || row.market.oracleReference?.address || "",
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
    acc.byProducerCategory[row.producer.category] = (acc.byProducerCategory[row.producer.category] || 0) + 1;
    return acc;
  }, { byProtocol: {}, bySide: {}, byProducerCategory: {} });
}

function mergeBreakdowns(rows) {
  const out = { byProtocol: {}, bySide: {}, byProducerCategory: {} };
  for (const row of rows) {
    for (const key of Object.keys(out)) {
      for (const [name, value] of Object.entries(row.matchBreakdown?.[key] || {})) {
        out[key][name] = (out[key][name] || 0) + Number(value || 0);
      }
    }
  }
  return out;
}

async function scanChain(chainId, rpc, allProducers) {
  const chain = CHAINS[chainId];
  const provider = new ethers.JsonRpcProvider(rpc);
  const producers = allProducers.filter((p) => p.chainId === chainId);
  const blockNumber = await provider.getBlockNumber();
  console.log(`Scanning ${chain.name}: producers=${producers.length}`);

  const [aave, euler, silo] = await Promise.all([
    scanAave(provider, chain, producers),
    scanEuler(provider, chain, producers),
    scanSilo(provider, chainId, chain, producers),
  ]);
  const matches = dedupeRows([...aave.rows, ...euler.rows, ...silo.rows]);
  matches.sort((a, b) => Number(b.reviewCandidate) - Number(a.reviewCandidate) || Number(b.market.otherReserveCashUsd || b.market.cashUsd || b.market.oppositeLiquidityUsd || 0) - Number(a.market.otherReserveCashUsd || a.market.cashUsd || a.market.oppositeLiquidityUsd || 0));

  return {
    chainId,
    chain: chain.name,
    rpcResolved: true,
    blockNumber,
    producersInput: producers.length,
    aaveReservesScanned: aave.stats.reservesScanned,
    aavePriceSourcesScanned: aave.stats.priceSourcesScanned,
    eulerFactoryListLength: euler.stats.factoryListLength,
    eulerVaultsScanned: euler.stats.evaultsScanned,
    eulerOracleContractsScanned: euler.stats.oracleContractsScanned,
    siloIdsScanned: silo.stats.idsScanned,
    siloMarketsScanned: silo.stats.marketsScanned,
    siloOracleContractsScanned: silo.stats.oracleContractsScanned,
    matches: matches.length,
    matchBreakdown: breakdownRows(matches),
    reviewCandidates: matches.filter((row) => row.reviewCandidate).length,
    watchCandidates: matches.filter((row) => row.watchCandidate).length,
    routePositive: 0,
    topMatches: matches.slice(0, 50),
  };
}

async function main() {
  const producers = collectProducers();
  const chainIds = [...new Set(producers.map((p) => p.chainId))].filter((id) => CHAINS[id]);
  const rpcPool = await resolveRpcPool(chainIds);
  const priorErc4626 = readJson(FILES.erc4626Joiner, null);
  const results = [];
  for (const chainId of chainIds) {
    if (!rpcPool[chainId]) {
      results.push({ chainId, chain: CHAINS[chainId].name, rpcResolved: false, error: "missing-rpc", producersInput: producers.filter((p) => p.chainId === chainId).length });
      continue;
    }
    results.push(await scanChain(chainId, rpcPool[chainId], producers));
  }

  const reviewCandidates = results.reduce((sum, r) => sum + Number(r.reviewCandidates || 0), 0);
  const watchCandidates = results.reduce((sum, r) => sum + Number(r.watchCandidates || 0), 0);
  const routePositive = results.reduce((sum, r) => sum + Number(r.routePositive || 0), 0);
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-aave-euler-silo-consumer-graph.js",
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      signedActions: false,
      exploitExecuteCalls: false,
      routePositive: routePositive > 0,
      signedActionJustified: false,
    },
    thresholds: {
      routeLiquidityUsd: ROUTE_LIQUIDITY_USD,
      maxEulerVaults: MAX_EULER_VAULTS,
      maxSiloIds: MAX_SILO_IDS,
    },
    inputs: FILES,
    producerSummary: {
      producers: producers.length,
      byChain: Object.fromEntries(Object.entries(CHAINS).map(([id, chain]) => [chain.name, producers.filter((p) => p.chainId === Number(id)).length])),
      byCategory: producers.reduce((acc, p) => { acc[p.category] = (acc[p.category] || 0) + 1; return acc; }, {}),
    },
    priorErc4626Joiner: priorErc4626 ? {
      generatedAt: priorErc4626.generatedAt,
      watchCandidates: priorErc4626.summary?.watchCandidates ?? null,
      routePositive: priorErc4626.summary?.routePositive ?? null,
      note: "Existing ERC4626 low-TVL joiner already covers Morpho/Compound/Venus/Aave/Euler/Silo direct and bytecode-reference checks.",
    } : null,
    summary: {
      chainsScanned: results.filter((r) => r.rpcResolved).length,
      chainsMissingRpc: results.filter((r) => !r.rpcResolved).map((r) => r.chain),
      producersInput: producers.length,
      matches: results.reduce((sum, r) => sum + Number(r.matches || 0), 0),
      matchBreakdown: mergeBreakdowns(results),
      reviewCandidates,
      watchCandidates,
      routePositive,
      signedActionJustified: false,
    },
    producers: producers.slice(0, 200),
    results,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(artifact, jsonReplacer, 2) + "\n");
  console.log(`Aave/Euler/Silo consumer graph wrote ${path.relative(WORKSPACE, OUT)}; matches=${artifact.summary.matches}; watchCandidates=${watchCandidates}; routePositive=${routePositive}`);
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
