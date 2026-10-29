#!/usr/bin/env node
// Read-only factory launch/donation watch for Morpho VaultV2, Euler EVK, and Silo V3.
// Searches for low-TVL/new vault-like deployments that map to lending consumers.
// RPC URLs are resolved in memory only and never printed or stored.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "factory-launch-donation-watch.json");
const ERC4626_JOINER = path.join(WORKSPACE, "reports", "raw", "fast", "erc4626-consumer-joiner.json");
const HIGH_LTV = path.join(WORKSPACE, "reports", "raw", "fast", "consumer-first-high-ltv-collateral.json");
const SILO_CORE_DEPLOYMENTS = path.join(WORKSPACE, "targets", "silo-contracts-v2", "silo-core", "deployments");

const DEFAULT_CHAIN_IDS = [1, 56, 8453, 42161];
const CHAIN_IDS = String(process.env.FACTORY_WATCH_CHAIN_IDS || DEFAULT_CHAIN_IDS.join(","))
  .split(/[,\s]+/)
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value > 0);
const LOOKBACK_BLOCKS = Number(process.env.FACTORY_WATCH_LOOKBACK_BLOCKS || "100000");
const MAX_EULER_RECENT = Number(process.env.FACTORY_WATCH_MAX_EULER_RECENT || "80");
const MAX_SILO_RECENT = Number(process.env.FACTORY_WATCH_MAX_SILO_RECENT || "80");
const LOW_TVL_USD = Number(process.env.FACTORY_WATCH_LOW_TVL_USD || "10000");
const TINY_TVL_USD = Number(process.env.FACTORY_WATCH_TINY_TVL_USD || "1000");
const MIN_LIQUIDITY_USD = Number(process.env.FACTORY_WATCH_MIN_LIQUIDITY_USD || "1000");
const GAS_USD = Number(process.env.FACTORY_WATCH_GAS_USD || "3");
const MIN_PROFIT_USD = Number(process.env.FACTORY_WATCH_MIN_PROFIT_USD || "25");

const CHAINS = {
  1: { name: "Ethereum", coinSlug: "ethereum", siloFolder: "mainnet", eulerFactory: "0x29a56a1b8214D9Cf7c5561811750D5cBDb45CC8e" },
  56: { name: "BNB Chain", coinSlug: "bsc", siloFolder: "bnb" },
  8453: { name: "Base", coinSlug: "base", siloFolder: "base" },
  42161: { name: "Arbitrum", coinSlug: "arbitrum", siloFolder: "arbitrum_one" },
  10: { name: "Optimism", coinSlug: "optimism", siloFolder: "optimism" },
  43114: { name: "Avalanche", coinSlug: "avalanche", siloFolder: "avalanche" },
  146: { name: "Sonic", coinSlug: "sonic", siloFolder: "sonic" },
};

const MORPHO_VAULT_FACTORIES = {
  1: { name: "Morpho VaultV2Factory", address: "0xA1D94F746dEfa1928926b84fB2596c06926C0405", deployTopic: "0x341ce009267aa0d78cc12b34155e223904a51ed49d144beb6eb8be87813edb4e", vaultTopicIndex: 3 },
  8453: { name: "Morpho VaultV2Factory", address: "0x4501125508079A99ebBebCE205DeC9593C2b5857", deployTopic: "0x341ce009267aa0d78cc12b34155e223904a51ed49d144beb6eb8be87813edb4e", vaultTopicIndex: 3 },
};

const ERC20 = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
]);
const ERC4626 = new ethers.Interface([
  "function asset() view returns (address)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function maxDeposit(address receiver) view returns (uint256)",
  "function maxMint(address receiver) view returns (uint256)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
]);
const EULER_FACTORY = new ethers.Interface([
  "function getProxyListLength() view returns (uint256)",
  "function getProxyListSlice(uint256 start,uint256 end) view returns (address[])",
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

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return fallback; }
}

function normalizeAddress(value) {
  try { return ethers.getAddress(value); } catch (_) { return null; }
}

function lowerAddress(value) {
  const address = normalizeAddress(value);
  return address ? address.toLowerCase() : null;
}

function strip0x(value) {
  return String(value || "").replace(/^0x/i, "");
}

function round(value, decimals = 6) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function asNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const n = Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function loadRpcUrls() {
  if (!fs.existsSync(RPC_FILE)) return [];
  return [...fs.readFileSync(RPC_FILE, "utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map((m) => m[0]);
}

async function rpcCall(url, method, params = [], timeoutMs = 12_000) {
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
  const wanted = new Set(chainIds.map(Number));
  const pool = {};
  for (const url of loadRpcUrls()) {
    try {
      const chainId = Number(BigInt(await rpcCall(url, "eth_chainId", [], 6000)));
      if (wanted.has(chainId) && !pool[chainId]) pool[chainId] = url;
    } catch (_) {
      // Never print or persist RPC URLs.
    }
  }
  return pool;
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 20_000);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function safeCall(provider, to, data) {
  try {
    const target = normalizeAddress(to);
    if (!target || !provider) return null;
    return await provider.call({ to: target, data });
  } catch (_) {
    return null;
  }
}

function decode(raw, iface, fn) {
  if (!raw || raw === "0x") return null;
  try { return iface.decodeFunctionResult(fn, raw); } catch (_) { return null; }
}

function decodeString(raw, fn) {
  return decode(raw, ERC20, fn)?.[0]?.toString() || null;
}

function wordAt(raw, index) {
  const hex = strip0x(raw);
  const start = index * 64;
  if (!hex || hex.length < start + 64) return null;
  return `0x${hex.slice(start, start + 64)}`;
}

function addressFromWord(raw) {
  if (!raw || raw === "0x") return null;
  const hex = strip0x(raw).padStart(64, "0");
  if (/^0+$/.test(hex)) return null;
  return normalizeAddress(`0x${hex.slice(-40)}`);
}

function decodeAddressTopic(word) {
  return addressFromWord(word);
}

function formatUnitsNumber(raw, decimals) {
  try { return Number(ethers.formatUnits(raw || 0n, Number(decimals || 18))); } catch (_) { return null; }
}

function siloLtvToRatio(value) {
  try { return Number(BigInt(value || 0n)) / 1e18; } catch (_) { return 0; }
}

function priceMapKey(chainId, address) {
  const lower = lowerAddress(address);
  return lower ? `${Number(chainId)}:${lower}` : null;
}

function priceFromMap(prices, chainId, address) {
  const key = priceMapKey(chainId, address);
  return key ? prices.get(key) || null : null;
}

async function fetchPrices(refs) {
  const keyToRefs = new Map();
  for (const ref of refs || []) {
    const cfg = CHAINS[Number(ref?.chainId)];
    const lower = lowerAddress(ref?.address);
    if (!cfg?.coinSlug || !lower) continue;
    const coinKey = `${cfg.coinSlug}:${lower}`.toLowerCase();
    const list = keyToRefs.get(coinKey) || [];
    list.push({ chainId: Number(ref.chainId), address: lower });
    keyToRefs.set(coinKey, list);
  }
  const keys = [...keyToRefs.keys()];
  const out = new Map();
  for (let i = 0; i < keys.length; i += 50) {
    const json = await fetchJson(`https://coins.llama.fi/prices/current/${keys.slice(i, i + 50).join(",")}?searchWidth=6h`, { timeoutMs: 30_000 }).catch(() => ({ coins: {} }));
    for (const [key, row] of Object.entries(json.coins || {})) {
      const price = Number(row?.price || 0);
      if (price <= 0) continue;
      for (const ref of keyToRefs.get(key.toLowerCase()) || []) out.set(`${ref.chainId}:${ref.address}`, price);
    }
  }
  return out;
}

async function tokenMeta(provider, token, fallback = {}) {
  const address = normalizeAddress(token);
  if (!address) return null;
  const [symbolRaw, nameRaw, decimalsRaw] = await Promise.all([
    safeCall(provider, address, ERC20.encodeFunctionData("symbol", [])),
    safeCall(provider, address, ERC20.encodeFunctionData("name", [])),
    safeCall(provider, address, ERC20.encodeFunctionData("decimals", [])),
  ]);
  return {
    address,
    addressLower: address.toLowerCase(),
    symbol: decodeString(symbolRaw, "symbol") || fallback.symbol || null,
    name: decodeString(nameRaw, "name") || fallback.name || null,
    decimals: Number(decode(decimalsRaw, ERC20, "decimals")?.[0] ?? fallback.decimals ?? 18),
  };
}

function loadSiloDeployment(chainId, name) {
  const folder = CHAINS[chainId]?.siloFolder;
  if (!folder) return null;
  const file = path.join(SILO_CORE_DEPLOYMENTS, folder, `${name}.sol.json`);
  const json = readJson(file, null);
  return normalizeAddress(json?.address);
}

function addCandidate(map, row) {
  const chainId = Number(row.chainId);
  const address = normalizeAddress(row.address);
  if (!chainId || !address) return;
  const key = `${chainId}:${address.toLowerCase()}`;
  const prev = map.get(key) || { chainId, address, sources: [], deployBlock: null, sourceDetails: [] };
  prev.sources.push(row.source);
  if (row.deployBlock && (!prev.deployBlock || Number(row.deployBlock) > prev.deployBlock)) prev.deployBlock = Number(row.deployBlock);
  if (row.detail) prev.sourceDetails.push(row.detail);
  map.set(key, prev);
}

async function collectMorphoVaultFactory(provider, chainId, candidates) {
  const cfg = MORPHO_VAULT_FACTORIES[chainId];
  if (!provider || !cfg) return [];
  const latest = await provider.getBlockNumber();
  const fromStart = Math.max(1, latest - LOOKBACK_BLOCKS);
  const rows = [];
  for (let fromBlock = fromStart; fromBlock <= latest; fromBlock += 10000) {
    const toBlock = Math.min(latest, fromBlock + 9999);
    const logs = await provider.getLogs({ address: cfg.address, topics: [cfg.deployTopic], fromBlock, toBlock }).catch(() => []);
    for (const log of logs) {
      const vault = decodeAddressTopic(log.topics?.[cfg.vaultTopicIndex]);
      if (!vault) continue;
      const row = { chainId, address: vault, deployBlock: Number(log.blockNumber), source: "morpho-vault-v2-recent-deploy", detail: { factory: cfg.name, txHash: log.transactionHash } };
      rows.push(row);
      addCandidate(candidates, row);
    }
  }
  return rows;
}

async function collectEulerLatest(provider, chainId, candidates) {
  const factory = normalizeAddress(CHAINS[chainId]?.eulerFactory);
  if (!provider || !factory) return { rows: [], stats: { factoryListLength: 0 } };
  const lengthRaw = await safeCall(provider, factory, EULER_FACTORY.encodeFunctionData("getProxyListLength", []));
  const length = Number(decode(lengthRaw, EULER_FACTORY, "getProxyListLength")?.[0] || 0n);
  const start = Math.max(0, length - MAX_EULER_RECENT);
  const rows = [];
  for (let cursor = start; cursor < length; cursor += 100) {
    const end = Math.min(length, cursor + 100);
    const raw = await safeCall(provider, factory, EULER_FACTORY.encodeFunctionData("getProxyListSlice", [cursor, end]));
    const list = (decode(raw, EULER_FACTORY, "getProxyListSlice")?.[0] || []).map(normalizeAddress).filter(Boolean);
    for (let i = 0; i < list.length; i++) {
      const index = cursor + i;
      const row = { chainId, address: list[i], source: "euler-evk-latest-proxy", detail: { factory, index, factoryListLength: length } };
      rows.push(row);
      addCandidate(candidates, row);
    }
  }
  return { rows, stats: { factory, factoryListLength: length, factoryListStart: start, latestProxies: rows.length } };
}

function parseSiloConfig(decoded) {
  const row = decoded?.[0];
  if (!row) return null;
  const silo = normalizeAddress(row[2]);
  const token = normalizeAddress(row[3]);
  if (!silo || !token) return null;
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

async function collectSiloLatest(provider, chainId) {
  const factory = loadSiloDeployment(chainId, "SiloFactory");
  if (!provider || !factory) return { rows: [], stats: { factory: null, idsScanned: 0 } };
  const nextRaw = await safeCall(provider, factory, SILO_FACTORY.encodeFunctionData("getNextSiloId", []));
  const nextId = decode(nextRaw, SILO_FACTORY, "getNextSiloId")?.[0];
  if (!nextId) return { rows: [], stats: { factory, idsScanned: 0 } };
  const start = nextId > BigInt(MAX_SILO_RECENT) ? nextId - BigInt(MAX_SILO_RECENT) : 1n;
  const rows = [];
  const tokenRefs = [];
  for (let id = start; id < nextId; id++) {
    const cfgRaw = await safeCall(provider, factory, SILO_FACTORY.encodeFunctionData("idToSiloConfig", [id]));
    const config = normalizeAddress(decode(cfgRaw, SILO_FACTORY, "idToSiloConfig")?.[0]);
    if (!config || config === ethers.ZeroAddress) continue;
    const silosRaw = await safeCall(provider, config, SILO_CONFIG.encodeFunctionData("getSilos", []));
    const silosDecoded = decode(silosRaw, SILO_CONFIG, "getSilos");
    const silos = [normalizeAddress(silosDecoded?.[0]), normalizeAddress(silosDecoded?.[1])].filter(Boolean);
    if (silos.length < 2) continue;
    const sides = [];
    for (const silo of silos) {
      const [configRaw, liquidityRaw, storageRaw] = await Promise.all([
        safeCall(provider, config, SILO_CONFIG.encodeFunctionData("getConfig", [silo])),
        safeCall(provider, silo, SILO.encodeFunctionData("getLiquidity", [])),
        safeCall(provider, silo, SILO.encodeFunctionData("getSiloStorage", [])),
      ]);
      const cfg = parseSiloConfig(decode(configRaw, SILO_CONFIG, "getConfig"));
      if (!cfg) continue;
      const liquidity = decode(liquidityRaw, SILO, "getLiquidity")?.[0] || 0n;
      const storage = decode(storageRaw, SILO, "getSiloStorage");
      tokenRefs.push({ chainId, address: cfg.token });
      sides.push({ ...cfg, liquidityRaw: liquidity.toString(), collateralAssetsRaw: (storage?.[3] || 0n).toString(), debtAssetsRaw: (storage?.[4] || 0n).toString() });
    }
    rows.push({ chainId, chain: CHAINS[chainId]?.name || String(chainId), id: id.toString(), config, sides });
  }
  const prices = await fetchPrices(tokenRefs);
  for (const row of rows) {
    for (const side of row.sides) {
      const meta = await tokenMeta(provider, side.token, {}).catch(() => ({ address: side.token, decimals: 18 }));
      const liquidity = formatUnitsNumber(BigInt(side.liquidityRaw || 0), meta?.decimals || 18);
      side.tokenMeta = meta;
      side.liquidity = round(liquidity, 12);
      side.liquidityUsd = round((liquidity || 0) * Number(priceFromMap(prices, chainId, side.token) || 0), 6);
    }
  }
  return { rows, stats: { factory, idsScanned: Number(nextId - start), marketsScanned: rows.length } };
}

async function readVaultLike(provider, candidate, prices) {
  const address = normalizeAddress(candidate.address);
  const [assetRaw, totalAssetsRaw, totalSupplyRaw, shareDecRaw, symRaw, nameRaw, maxDepositRaw, maxMintRaw] = await Promise.all([
    safeCall(provider, address, ERC4626.encodeFunctionData("asset", [])),
    safeCall(provider, address, ERC4626.encodeFunctionData("totalAssets", [])),
    safeCall(provider, address, ERC4626.encodeFunctionData("totalSupply", [])),
    safeCall(provider, address, ERC4626.encodeFunctionData("decimals", [])),
    safeCall(provider, address, ERC4626.encodeFunctionData("symbol", [])),
    safeCall(provider, address, ERC4626.encodeFunctionData("name", [])),
    safeCall(provider, address, ERC4626.encodeFunctionData("maxDeposit", [ethers.ZeroAddress])),
    safeCall(provider, address, ERC4626.encodeFunctionData("maxMint", [ethers.ZeroAddress])),
  ]);
  const asset = normalizeAddress(decode(assetRaw, ERC4626, "asset")?.[0]);
  if (!asset) return null;
  const assetMeta = await tokenMeta(provider, asset, {}).catch(() => null);
  const shareDecimals = Number(decode(shareDecRaw, ERC4626, "decimals")?.[0] ?? 18);
  const totalAssetsValue = decode(totalAssetsRaw, ERC4626, "totalAssets")?.[0] ?? null;
  const totalSupplyValue = decode(totalSupplyRaw, ERC4626, "totalSupply")?.[0] ?? null;
  const maxDepositValue = decode(maxDepositRaw, ERC4626, "maxDeposit")?.[0] ?? null;
  const maxMintValue = decode(maxMintRaw, ERC4626, "maxMint")?.[0] ?? null;
  const oneShare = 10n ** BigInt(Math.min(shareDecimals, 36));
  const oneShareRaw = await safeCall(provider, address, ERC4626.encodeFunctionData("convertToAssets", [oneShare]));
  const oneShareValue = decode(oneShareRaw, ERC4626, "convertToAssets")?.[0] ?? null;
  const totalAssets = assetMeta && totalAssetsValue !== null ? formatUnitsNumber(totalAssetsValue, assetMeta.decimals) : null;
  const totalSupply = totalSupplyValue !== null ? formatUnitsNumber(totalSupplyValue, shareDecimals) : null;
  const maxDeposit = assetMeta && maxDepositValue !== null ? formatUnitsNumber(maxDepositValue, assetMeta.decimals) : null;
  const oneShareAssets = assetMeta && oneShareValue !== null ? formatUnitsNumber(oneShareValue, assetMeta.decimals) : null;
  const assetPriceUsd = priceFromMap(prices, candidate.chainId, asset);
  return {
    chainId: candidate.chainId,
    chain: CHAINS[candidate.chainId]?.name || String(candidate.chainId),
    address,
    addressLower: address.toLowerCase(),
    deployBlock: candidate.deployBlock || null,
    sources: [...new Set(candidate.sources || [])],
    sourceDetails: candidate.sourceDetails || [],
    symbol: decodeString(symRaw, "symbol"),
    name: decodeString(nameRaw, "name"),
    asset: assetMeta,
    shareDecimals,
    totalAssetsRaw: totalAssetsValue !== null ? totalAssetsValue.toString() : null,
    totalSupplyRaw: totalSupplyValue !== null ? totalSupplyValue.toString() : null,
    totalAssets: round(totalAssets, 12),
    totalSupply: round(totalSupply, 12),
    oneShareAssets: round(oneShareAssets, 12),
    assetPriceUsd: round(assetPriceUsd, 8),
    totalAssetsUsd: totalAssets !== null && assetPriceUsd !== null ? round(totalAssets * assetPriceUsd, 6) : null,
    maxDeposit: round(maxDeposit, 6),
    maxMintRaw: maxMintValue !== null ? maxMintValue.toString() : null,
    depositOpen: maxDepositValue === null && maxMintValue === null ? null : (BigInt(maxDepositValue || 0n) > 0n || BigInt(maxMintValue || 0n) > 0n),
  };
}

function consumerMapFromArtifacts() {
  const map = new Map();
  const add = (chainId, address, consumer) => {
    const lower = lowerAddress(address);
    if (!chainId || !lower) return;
    const key = `${Number(chainId)}:${lower}`;
    const rows = map.get(key) || [];
    rows.push(consumer);
    map.set(key, rows);
  };
  const joiner = readJson(ERC4626_JOINER, { results: [] });
  for (const result of joiner.results || []) {
    for (const candidate of result.topCandidates || []) {
      add(candidate.chainId || result.chainId, candidate.vault?.address, {
        type: candidate.type || "erc4626-consumer-joiner",
        side: candidate.side || (String(candidate.reason || "").includes("loan") ? "loanAsset" : "collateralAsset"),
        reason: candidate.reason || null,
        market: candidate.market || null,
        liquidityUsd: asNumber(candidate.market?.liquidityAssetsUsd),
        ltvPct: asNumber(candidate.market?.lltvPct),
        blockers: candidate.blockers || [],
      });
    }
  }
  const high = readJson(HIGH_LTV, { results: [] });
  for (const result of high.results || []) {
    const chainId = Number(result.chainId);
    for (const row of result.highLtvRowsDetail || result.topRows || []) {
      const collateral = row.collateral?.address || row.consumer?.collateralAsset?.address;
      add(chainId, collateral, {
        type: row.protocol || "consumer-first-high-ltv",
        side: "collateralAsset",
        reason: "candidate appears as high-LTV collateral in consumer-first artifact",
        market: row.consumer || null,
        liquidityUsd: asNumber(row.routeLiquidityUsd),
        ltvPct: asNumber(row.ltv) !== null ? asNumber(row.ltv) * 100 : null,
        blockers: row.blockers || [],
      });
    }
  }
  return map;
}

function donationScenarios(vault, consumers) {
  const totalAssetsUsd = asNumber(vault.totalAssetsUsd);
  if (totalAssetsUsd === null) return [];
  const relevant = consumers.filter((c) => c.side === "collateralAsset");
  const scenarios = [];
  for (const consumer of relevant.length ? relevant : [{ ltvPct: null, liquidityUsd: 0 }]) {
    const ltv = (asNumber(consumer.ltvPct) || 0) / 100;
    const liquidityUsd = asNumber(consumer.liquidityUsd ?? consumer.market?.liquidityUsd ?? consumer.market?.liquidityAssetsUsd) || 0;
    for (const seedUsd of [1, 10, 25, 100]) {
      for (const donationUsd of [10, 25, 100, 1000]) {
        const ownership = totalAssetsUsd <= 0 ? 1 : seedUsd / (totalAssetsUsd + seedUsd);
        const collateralValueUsd = seedUsd + donationUsd * ownership;
        const borrowableUsd = ltv > 0 ? Math.min(collateralValueUsd * ltv, liquidityUsd || Infinity) : 0;
        const costUsd = seedUsd + donationUsd;
        const netUsd = borrowableUsd - costUsd - GAS_USD;
        scenarios.push({
          consumerType: consumer.type || null,
          seedUsd,
          donationUsd,
          ownershipPct: round(ownership * 100, 6),
          rateInflationBps: round(totalAssetsUsd <= 0 ? null : donationUsd / (totalAssetsUsd + seedUsd) * 10000, 4),
          ltvPct: round(ltv * 100, 4),
          liquidityUsd: round(liquidityUsd, 6),
          borrowableUsd: round(borrowableUsd, 6),
          costUsd: round(costUsd, 6),
          gasUsd: GAS_USD,
          netUsd: round(netUsd, 6),
        });
      }
    }
  }
  return scenarios.sort((a, b) => (b.netUsd || -Infinity) - (a.netUsd || -Infinity)).slice(0, 8);
}

function classifyVault(vault, consumers, scenarios) {
  const totalAssetsUsd = asNumber(vault.totalAssetsUsd);
  const lowTvl = totalAssetsUsd !== null && totalAssetsUsd <= LOW_TVL_USD;
  const tinyTvl = totalAssetsUsd !== null && totalAssetsUsd <= TINY_TVL_USD;
  const consumerLinked = consumers.length > 0;
  const collateralConsumer = consumers.some((c) => c.side === "collateralAsset");
  const liquidityUsd = Math.max(0, ...consumers.map((c) => asNumber(c.liquidityUsd ?? c.market?.liquidityUsd ?? c.market?.liquidityAssetsUsd) || 0));
  const bestNetUsd = scenarios[0]?.netUsd ?? null;
  const preforkDonationPositive = bestNetUsd !== null && bestNetUsd > MIN_PROFIT_USD && collateralConsumer && liquidityUsd >= MIN_LIQUIDITY_USD;
  const watchCandidate = Boolean(consumerLinked && collateralConsumer && lowTvl && vault.depositOpen !== false && liquidityUsd >= MIN_LIQUIDITY_USD);
  const blockers = [];
  if (!consumerLinked) blockers.push("No lending consumer linked in current artifacts");
  if (consumerLinked && !collateralConsumer) blockers.push("Vault-like token is not collateral-side in current artifacts");
  if (totalAssetsUsd === null) blockers.push("Vault TVL cannot be priced in USD");
  if (!lowTvl) blockers.push("Vault is not low-TVL enough for cheap donation ownership");
  if (vault.depositOpen === false) blockers.push("Public deposit/mint appears closed");
  if (liquidityUsd < MIN_LIQUIDITY_USD) blockers.push("Borrow-side liquidity below threshold");
  if (bestNetUsd !== null && bestNetUsd <= MIN_PROFIT_USD) blockers.push("Modeled donation route is not positive before fork");
  blockers.push("No fork proof or exact consumer-specific oracle validation");
  return { lowTvl, tinyTvl, consumerLinked, collateralConsumer, liquidityUsd: round(liquidityUsd, 6), bestNetUsd, preforkDonationPositive, watchCandidate, routePositive: false, blockers };
}

function classifySilo(row) {
  const maxLtv = Math.max(0, ...row.sides.map((s) => asNumber(s.maxLtv) || 0));
  const maxLiquidityUsd = Math.max(0, ...row.sides.map((s) => asNumber(s.liquidityUsd) || 0));
  const lowLiquiditySide = row.sides.some((s) => (asNumber(s.liquidityUsd) || 0) <= LOW_TVL_USD);
  const watchCandidate = Boolean(maxLtv >= 0.85 && maxLiquidityUsd >= MIN_LIQUIDITY_USD && lowLiquiditySide);
  return {
    kind: "silo-v3-latest-config",
    chainId: row.chainId,
    chain: row.chain,
    config: row.config,
    id: row.id,
    sides: row.sides,
    maxLtv,
    maxLiquidityUsd: round(maxLiquidityUsd, 6),
    lowLiquiditySide,
    watchCandidate,
    routePositive: false,
    blockers: [
      watchCandidate ? "Silo launch/config row needs protocol-specific oracle/deposit/borrow simulation" : "No high-LTV low-liquidity launch shape",
      "No ERC4626 donation model for Silo row",
      "No fork proof or exact acquisition/borrow/exit economics",
    ],
  };
}

async function main() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const rpcs = await resolveRpcPool(CHAIN_IDS);
  const providers = new Map(Object.entries(rpcs).map(([chainId, rpc]) => [Number(chainId), new ethers.JsonRpcProvider(rpc, Number(chainId), { staticNetwork: true })]));
  const candidateMap = new Map();
  const sourceStats = {};
  const siloRows = [];

  for (const chainId of CHAIN_IDS) {
    const provider = providers.get(chainId) || null;
    const morphoRows = await collectMorphoVaultFactory(provider, chainId, candidateMap).catch(() => []);
    const euler = await collectEulerLatest(provider, chainId, candidateMap).catch(() => ({ rows: [], stats: { factoryListLength: 0 } }));
    const silo = await collectSiloLatest(provider, chainId).catch(() => ({ rows: [], stats: { idsScanned: 0, marketsScanned: 0 } }));
    siloRows.push(...silo.rows.map(classifySilo));
    sourceStats[chainId] = {
      chain: CHAINS[chainId]?.name || String(chainId),
      rpcResolved: Boolean(provider),
      morphoRecentVaults: morphoRows.length,
      eulerLatestProxies: euler.rows.length,
      eulerStats: euler.stats,
      siloLatestConfigs: silo.rows.length,
      siloStats: silo.stats,
    };
  }

  const candidates = [...candidateMap.values()];
  const priceRefs = [];
  for (const candidate of candidates) priceRefs.push({ chainId: candidate.chainId, address: candidate.address });
  const prelimVaults = [];
  for (const candidate of candidates) {
    const provider = providers.get(candidate.chainId);
    if (!provider) continue;
    const assetRaw = await safeCall(provider, candidate.address, ERC4626.encodeFunctionData("asset", []));
    const asset = normalizeAddress(decode(assetRaw, ERC4626, "asset")?.[0]);
    if (asset) priceRefs.push({ chainId: candidate.chainId, address: asset });
    prelimVaults.push({ candidate, asset });
  }
  const prices = await fetchPrices(priceRefs);
  const consumersByVault = consumerMapFromArtifacts();
  const vaultRows = [];
  for (const { candidate } of prelimVaults) {
    const provider = providers.get(candidate.chainId);
    if (!provider) continue;
    const vault = await readVaultLike(provider, candidate, prices).catch(() => null);
    if (!vault) continue;
    const consumers = consumersByVault.get(`${candidate.chainId}:${vault.addressLower}`) || [];
    const scenarios = donationScenarios(vault, consumers);
    const classification = classifyVault(vault, consumers, scenarios);
    vaultRows.push({ kind: "erc4626-or-evault-latest-factory-row", chainId: candidate.chainId, chain: vault.chain, vault, consumers, scenarios, ...classification });
  }

  vaultRows.sort((a, b) => Number(b.watchCandidate) - Number(a.watchCandidate)
    || Number(b.consumerLinked) - Number(a.consumerLinked)
    || Number(a.vault.totalAssetsUsd ?? Infinity) - Number(b.vault.totalAssetsUsd ?? Infinity));
  siloRows.sort((a, b) => Number(b.watchCandidate) - Number(a.watchCandidate) || Number(b.maxLtv) - Number(a.maxLtv));

  const summary = {
    chainsScanned: CHAIN_IDS.length,
    chainsWithRpc: providers.size,
    factoryCandidates: candidates.length,
    vaultRows: vaultRows.length,
    siloRows: siloRows.length,
    consumerLinkedVaultRows: vaultRows.filter((r) => r.consumerLinked).length,
    collateralConsumerVaultRows: vaultRows.filter((r) => r.collateralConsumer).length,
    lowTvlVaultRows: vaultRows.filter((r) => r.lowTvl).length,
    tinyTvlVaultRows: vaultRows.filter((r) => r.tinyTvl).length,
    depositOpenVaultRows: vaultRows.filter((r) => r.vault.depositOpen === true).length,
    watchCandidates: vaultRows.filter((r) => r.watchCandidate).length + siloRows.filter((r) => r.watchCandidate).length,
    preforkDonationPositive: vaultRows.filter((r) => r.preforkDonationPositive).length,
    routePositive: 0,
    signedActionJustified: false,
    bestModeledNetUsd: round(Math.max(-Infinity, ...vaultRows.map((r) => asNumber(r.bestNetUsd) ?? -Infinity)), 6),
  };

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-factory-launch-donation-watch.js",
    scope: "Read-only Morpho/Euler/Silo factory launch watch for low-TVL donation/config-choreography variants",
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
    thresholds: { chainIds: CHAIN_IDS, lookbackBlocks: LOOKBACK_BLOCKS, maxEulerRecent: MAX_EULER_RECENT, maxSiloRecent: MAX_SILO_RECENT, lowTvlUsd: LOW_TVL_USD, tinyTvlUsd: TINY_TVL_USD, minLiquidityUsd: MIN_LIQUIDITY_USD, gasUsd: GAS_USD, minProfitUsd: MIN_PROFIT_USD },
    sourceArtifacts: {
      erc4626ConsumerJoiner: "reports/raw/fast/erc4626-consumer-joiner.json",
      consumerFirstHighLtv: "reports/raw/fast/consumer-first-high-ltv-collateral.json",
    },
    chains: sourceStats,
    summary,
    topRows: [...vaultRows, ...siloRows].sort((a, b) => Number(b.watchCandidate) - Number(a.watchCandidate)).slice(0, 30),
    vaultRows,
    siloRows,
    requiredForRoutePositive: [
      "new/low-TVL factory row has public share acquisition or unsafe launch ordering",
      "vault or market token is accepted as collateral by a liquid lending consumer",
      "LLTV-adjusted borrow value exceeds seed + donation + gas + slippage",
      "local fork proof demonstrates extractable net profit",
    ],
    nextReadOnlyStep: summary.watchCandidates > 0
      ? "Resolve top watch row with protocol-specific oracle/cap checks and fork-test only if exact economics are positive."
      : "Keep monitoring factories; reopen when a low-TVL factory row gains collateral-side consumer liquidity or Silo latest config shows unsafe launch ordering.",
  };
  fs.writeFileSync(OUT, JSON.stringify(artifact, jsonReplacer, 2) + "\n");
  console.log(`Factory launch donation watch: vaultRows=${summary.vaultRows} siloRows=${summary.siloRows} watch=${summary.watchCandidates} routePositive=0`);
  console.log(`Artifact: ${path.relative(WORKSPACE, OUT).replace(/\\/g, "/")}`);
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
