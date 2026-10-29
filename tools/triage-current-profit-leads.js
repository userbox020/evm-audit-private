#!/usr/bin/env node
// triage-current-profit-leads.js - read-only on-chain mapper for public profit leads.
// Reads DeFiLlama-derived leads, resolves token/vault semantics, and writes a sanitized artifact.

const fs = require("fs");
const path = require("path");
const { AbiCoder, getAddress, id } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const IN = path.join(WORKSPACE, "reports", "raw", "fast", "current-profit-leads.json");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "current-profit-lead-triage.json");
const RPC_TIMEOUT_MS = 15_000;
const FETCH_TIMEOUT_MS = 20_000;
const PROBE_FROM = "0x000000000000000000000000000000000000dEaD";
const ZERO = "0x0000000000000000000000000000000000000000";
const ABI = AbiCoder.defaultAbiCoder();

const ERC1967_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ERC1967_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const ERC1967_BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

const CHAINS = {
  Ethereum: { chainId: 1, llama: "ethereum", dex: "ethereum", probeToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", fallbacks: ["https://ethereum.publicnode.com", "https://rpc.ankr.com/eth"] },
  Base: { chainId: 8453, llama: "base", dex: "base", probeToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", fallbacks: ["https://mainnet.base.org", "https://base.publicnode.com"] },
  Arbitrum: { chainId: 42161, llama: "arbitrum", dex: "arbitrum", probeToken: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", fallbacks: ["https://arb1.arbitrum.io/rpc", "https://arbitrum.publicnode.com"] },
  Optimism: { chainId: 10, llama: "optimism", dex: "optimism", probeToken: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", fallbacks: ["https://mainnet.optimism.io", "https://optimism.publicnode.com"] },
  Polygon: { chainId: 137, llama: "polygon", dex: "polygon", probeToken: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", fallbacks: ["https://polygon-rpc.com", "https://polygon-bor-rpc.publicnode.com"] },
  Avalanche: { chainId: 43114, llama: "avax", dex: "avalanche", probeToken: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", fallbacks: ["https://api.avax.network/ext/bc/C/rpc", "https://avalanche.public-rpc.com"] },
  Binance: { chainId: 56, llama: "bsc", dex: "bsc", probeToken: "0x55d398326f99059fF775485246999027B3197955", fallbacks: ["https://bsc-dataseed.binance.org", "https://bsc.publicnode.com"] },
  BSC: { chainId: 56, llama: "bsc", dex: "bsc", probeToken: "0x55d398326f99059fF775485246999027B3197955", fallbacks: ["https://bsc-dataseed.binance.org", "https://bsc.publicnode.com"] },
  Mantle: { chainId: 5000, llama: "mantle", dex: "mantle", fallbacks: ["https://rpc.mantle.xyz"] },
  Sonic: { chainId: 146, llama: "sonic", dex: "sonic", fallbacks: ["https://rpc.soniclabs.com"] },
  Berachain: { chainId: 80094, llama: "berachain", dex: "berachain", fallbacks: ["https://rpc.berachain.com"] },
};

function sanitize(text) {
  return String(text || "").replace(/https?:\/\/\S+/g, "[redacted-url]").slice(0, 240);
}

function selector(signature) {
  return id(signature).slice(0, 10);
}

function encodeCall(signature, types = [], values = []) {
  return selector(signature) + (types.length ? ABI.encode(types, values).slice(2) : "");
}

function decodeTuple(data, types) {
  if (!data || data === "0x") return null;
  try {
    return [...ABI.decode(types, data)];
  } catch (_) {
    return null;
  }
}

function decodeOne(data, type) {
  const decoded = decodeTuple(data, [type]);
  return decoded ? decoded[0] : null;
}

function strip0x(value) {
  return String(value || "").replace(/^0x/i, "");
}

function isAddress(value) {
  return /^0x[0-9a-fA-F]{40}$/.test(String(value || ""));
}

function normalizeAddress(value) {
  if (!isAddress(value)) return null;
  try {
    return getAddress(value);
  } catch (_) {
    return String(value).toLowerCase();
  }
}

function addressFromWord(word) {
  if (!word || word === "0x") return null;
  const hex = strip0x(word).padStart(64, "0");
  if (/^0+$/.test(hex)) return null;
  return normalizeAddress("0x" + hex.slice(-40));
}

function decodeString(data) {
  if (!data || data === "0x") return null;
  try {
    const value = ABI.decode(["string"], data)[0];
    return String(value) || null;
  } catch (_) {
    const hex = strip0x(data);
    if (hex.length === 64) {
      return Buffer.from(hex, "hex").toString("utf8").replace(/\u0000+$/g, "") || null;
    }
    return null;
  }
}

function bigintJson(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function formatUnits(raw, decimals, maxFrac = 10) {
  if (raw === null || raw === undefined || decimals === null || decimals === undefined) return null;
  const value = BigInt(raw);
  const dec = Number(decimals);
  if (!Number.isFinite(dec) || dec < 0 || dec > 255) return null;
  const scale = 10n ** BigInt(dec);
  const whole = value / scale;
  const frac = value % scale;
  const fracText = frac.toString().padStart(dec, "0").replace(/0+$/g, "").slice(0, maxFrac);
  return fracText ? `${whole}.${fracText}` : whole.toString();
}

function decimalNumber(raw, decimals) {
  const text = formatUnits(raw, decimals, 18);
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

function round(value, decimals = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function extractRpcUrls() {
  if (!fs.existsSync(RPC_FILE)) return [];
  return [...fs.readFileSync(RPC_FILE, "utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map((m) => m[0]);
}

async function rpcCall(url, method, params, timeoutMs = RPC_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    const json = await response.json();
    if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
    return json.result;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers: { "user-agent": "evm-audit-current-profit-triage/1.0" }, signal: controller.signal });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.json();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveRpc(chainCfg) {
  const candidates = [...extractRpcUrls(), ...(chainCfg.fallbacks || [])];
  const seen = new Set();
  for (const url of candidates) {
    if (seen.has(url)) continue;
    seen.add(url);
    try {
      const chainId = Number(BigInt(await rpcCall(url, "eth_chainId", [], 5000)));
      if (chainId !== chainCfg.chainId) continue;
      if (chainCfg.probeToken) {
        const probe = await rpcCall(url, "eth_call", [{ to: chainCfg.probeToken, data: selector("decimals()") }, "latest"], 5000);
        if (!probe || probe === "0x") continue;
      }
      return url;
    } catch (_) {
      // Never print or store RPC URLs.
    }
  }
  return null;
}

async function callOptional(rpc, to, signature, types = [], values = [], retTypes = null, block = "latest", from = undefined) {
  if (!isAddress(to)) return { ok: false, value: null, raw: null, error: "BAD_ADDRESS" };
  try {
    const tx = { to, data: encodeCall(signature, types, values) };
    if (from) tx.from = from;
    const raw = await rpcCall(rpc, "eth_call", [tx, block], 10_000);
    if (!raw || raw === "0x") return { ok: false, value: null, raw, error: "EMPTY" };
    const value = retTypes ? decodeTuple(raw, retTypes) : raw;
    if (retTypes && value === null) return { ok: false, value: null, raw, error: "DECODE" };
    return { ok: true, value, raw, error: null };
  } catch (err) {
    return { ok: false, value: null, raw: null, error: sanitize(err.message || err) };
  }
}

async function contractMeta(rpc, address) {
  const [code, implSlot, adminSlot, beaconSlot] = await Promise.all([
    rpcCall(rpc, "eth_getCode", [address, "latest"]).catch((err) => ({ error: sanitize(err.message || err) })),
    rpcCall(rpc, "eth_getStorageAt", [address, ERC1967_IMPL_SLOT, "latest"]).catch(() => null),
    rpcCall(rpc, "eth_getStorageAt", [address, ERC1967_ADMIN_SLOT, "latest"]).catch(() => null),
    rpcCall(rpc, "eth_getStorageAt", [address, ERC1967_BEACON_SLOT, "latest"]).catch(() => null),
  ]);
  const codeText = typeof code === "string" ? code : "0x";
  return {
    address,
    codePresent: Boolean(codeText && codeText !== "0x"),
    codeBytes: codeText && codeText !== "0x" ? strip0x(codeText).length / 2 : 0,
    eip1967Implementation: addressFromWord(implSlot),
    eip1967Admin: addressFromWord(adminSlot),
    eip1967Beacon: addressFromWord(beaconSlot),
    codeError: typeof code === "object" ? code.error : null,
  };
}

async function tokenMeta(rpc, address) {
  const [symbolRaw, nameRaw, decimalsRaw, supplyRaw] = await Promise.all([
    callOptional(rpc, address, "symbol()"),
    callOptional(rpc, address, "name()"),
    callOptional(rpc, address, "decimals()", [], [], ["uint8"]),
    callOptional(rpc, address, "totalSupply()", [], [], ["uint256"]),
  ]);
  const decimals = decimalsRaw.ok ? Number(decimalsRaw.value[0]) : null;
  const totalSupplyRaw = supplyRaw.ok ? supplyRaw.value[0] : null;
  return {
    address,
    symbol: decodeString(symbolRaw.raw),
    name: decodeString(nameRaw.raw),
    decimals,
    totalSupplyRaw: totalSupplyRaw?.toString() || null,
    totalSupply: formatUnits(totalSupplyRaw, decimals),
  };
}

async function getLlamaPrice(chainCfg, address, cache) {
  const normalized = normalizeAddress(address);
  if (!normalized || !chainCfg.llama) return null;
  const coinId = `${chainCfg.llama}:${normalized}`;
  if (cache.has(coinId)) return cache.get(coinId);
  const json = await fetchJson(`https://coins.llama.fi/prices/current/${coinId}`);
  const row = json?.coins?.[coinId] || null;
  const price = row?.price && Number(row.price) > 0 ? {
    source: "defillama-coins",
    coinId,
    priceUsd: Number(row.price),
    symbol: row.symbol || null,
    timestamp: row.timestamp || null,
  } : null;
  cache.set(coinId, price);
  return price;
}

async function getDexPairs(chainCfg, address, cache) {
  const normalized = normalizeAddress(address);
  if (!normalized) return [];
  const cacheKey = `${chainCfg.dex}:${normalized}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  const json = await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${normalized}`, 15_000);
  const pairs = (json?.pairs || [])
    .filter((p) => String(p.chainId || "").toLowerCase() === String(chainCfg.dex || "").toLowerCase())
    .map((p) => ({
      chainId: p.chainId || null,
      dexId: p.dexId || null,
      pairAddress: p.pairAddress || null,
      priceUsd: p.priceUsd ? Number(p.priceUsd) : null,
      liquidityUsd: p.liquidity?.usd ? Number(p.liquidity.usd) : 0,
      fdv: p.fdv || null,
      baseToken: p.baseToken ? { address: p.baseToken.address || null, symbol: p.baseToken.symbol || null } : null,
      quoteToken: p.quoteToken ? { address: p.quoteToken.address || null, symbol: p.quoteToken.symbol || null } : null,
      url: p.url || null,
    }))
    .sort((a, b) => (b.liquidityUsd || 0) - (a.liquidityUsd || 0))
    .slice(0, 5);
  cache.set(cacheKey, pairs);
  return pairs;
}

function marketPrice(price, dexPairs) {
  if (price?.priceUsd) return { source: price.source, priceUsd: price.priceUsd };
  const pair = (dexPairs || []).find((p) => p.priceUsd && p.priceUsd > 0);
  return pair ? { source: `dexscreener:${pair.dexId}`, priceUsd: pair.priceUsd } : null;
}

async function erc4626Probe(rpc, chainCfg, address, shareDecimals, priceCache, dexCache) {
  const assetRaw = await callOptional(rpc, address, "asset()", [], [], ["address"]);
  const totalAssetsRaw = await callOptional(rpc, address, "totalAssets()", [], [], ["uint256"]);
  const out = {
    isErc4626Like: false,
    asset: null,
    assetMeta: null,
    totalAssetsRaw: totalAssetsRaw.ok ? totalAssetsRaw.value[0].toString() : null,
    totalAssets: null,
    oneShareToAssetsRaw: null,
    oneShareToAssets: null,
    oneAssetToSharesRaw: null,
    maxDepositProbeRaw: null,
    maxMintProbeRaw: null,
    shareNavUsd: null,
    marketPriceUsd: null,
    navMarketDivergencePct: null,
    routeHint: null,
    errors: {},
  };
  if (!assetRaw.ok) out.errors.asset = assetRaw.error;
  if (!totalAssetsRaw.ok) out.errors.totalAssets = totalAssetsRaw.error;
  if (!assetRaw.ok || !totalAssetsRaw.ok || shareDecimals === null || shareDecimals === undefined) return out;

  const asset = normalizeAddress(assetRaw.value[0]);
  if (!asset || asset === ZERO) return out;
  const assetMeta = await tokenMeta(rpc, asset);
  const oneShare = 10n ** BigInt(shareDecimals);
  const oneAsset = assetMeta.decimals !== null ? 10n ** BigInt(assetMeta.decimals) : null;
  const [toAssetsRaw, toSharesRaw, maxDepositRaw, maxMintRaw] = await Promise.all([
    callOptional(rpc, address, "convertToAssets(uint256)", ["uint256"], [oneShare], ["uint256"]),
    oneAsset ? callOptional(rpc, address, "convertToShares(uint256)", ["uint256"], [oneAsset], ["uint256"]) : Promise.resolve({ ok: false, error: "NO_ASSET_DECIMALS" }),
    callOptional(rpc, address, "maxDeposit(address)", ["address"], [PROBE_FROM], ["uint256"]),
    callOptional(rpc, address, "maxMint(address)", ["address"], [PROBE_FROM], ["uint256"]),
  ]);

  const assetPrice = await getLlamaPrice(chainCfg, asset, priceCache);
  const sharePrice = await getLlamaPrice(chainCfg, address, priceCache);
  const shareDexPairs = await getDexPairs(chainCfg, address, dexCache);
  const shareMarket = marketPrice(sharePrice, shareDexPairs);
  const assetUnits = toAssetsRaw.ok ? decimalNumber(toAssetsRaw.value[0], assetMeta.decimals) : null;
  const shareNavUsd = assetUnits !== null && assetPrice?.priceUsd ? assetUnits * assetPrice.priceUsd : null;
  const divergence = shareNavUsd && shareMarket?.priceUsd ? ((shareMarket.priceUsd - shareNavUsd) / shareNavUsd) * 100 : null;
  const maxLiquidityUsd = shareDexPairs[0]?.liquidityUsd || 0;
  const routeHint = divergence !== null && Math.abs(divergence) >= 2 && maxLiquidityUsd >= 10_000
    ? {
        type: divergence > 0 ? "mint-share-sell-market" : "buy-market-redeem-share",
        reason: "ERC4626 NAV/market divergence needs route quote and fork proof",
        needsForkProof: true,
        routePositive: false,
      }
    : null;

  return {
    ...out,
    isErc4626Like: true,
    asset,
    assetMeta,
    totalAssets: formatUnits(totalAssetsRaw.value[0], assetMeta.decimals),
    oneShareToAssetsRaw: toAssetsRaw.ok ? toAssetsRaw.value[0].toString() : null,
    oneShareToAssets: toAssetsRaw.ok ? formatUnits(toAssetsRaw.value[0], assetMeta.decimals) : null,
    oneAssetToSharesRaw: toSharesRaw.ok ? toSharesRaw.value[0].toString() : null,
    maxDepositProbeRaw: maxDepositRaw.ok ? maxDepositRaw.value[0].toString() : null,
    maxMintProbeRaw: maxMintRaw.ok ? maxMintRaw.value[0].toString() : null,
    assetPriceUsd: assetPrice?.priceUsd || null,
    shareNavUsd: round(shareNavUsd, 8),
    marketPriceUsd: shareMarket?.priceUsd || null,
    marketPriceSource: shareMarket?.source || null,
    navMarketDivergencePct: round(divergence, 4),
    routeHint,
    errors: {
      convertToAssets: toAssetsRaw.ok ? null : toAssetsRaw.error,
      convertToShares: toSharesRaw.ok ? null : toSharesRaw.error,
      maxDeposit: maxDepositRaw.ok ? null : maxDepositRaw.error,
      maxMint: maxMintRaw.ok ? null : maxMintRaw.error,
    },
  };
}

async function compoundProbe(rpc, chainCfg, address, tokenDecimals, priceCache, dexCache) {
  const underlyingRaw = await callOptional(rpc, address, "underlying()", [], [], ["address"]);
  const exchangeRateRaw = await callOptional(rpc, address, "exchangeRateStored()", [], [], ["uint256"]);
  const out = {
    isCompoundLike: false,
    underlying: null,
    underlyingMeta: null,
    exchangeRateStoredRaw: exchangeRateRaw.ok ? exchangeRateRaw.value[0].toString() : null,
    oneTokenUnderlying: null,
    navUsd: null,
    marketPriceUsd: null,
    navMarketDivergencePct: null,
    cash: null,
    borrows: null,
    reserves: null,
    routeHint: null,
    errors: {},
  };
  if (!underlyingRaw.ok || !exchangeRateRaw.ok || tokenDecimals === null || tokenDecimals === undefined) return out;
  const underlying = normalizeAddress(underlyingRaw.value[0]);
  if (!underlying || underlying === ZERO) return out;
  const underlyingMeta = await tokenMeta(rpc, underlying);
  if (underlyingMeta.decimals === null) return out;

  const [cashRaw, borrowsRaw, reservesRaw] = await Promise.all([
    callOptional(rpc, address, "getCash()", [], [], ["uint256"]),
    callOptional(rpc, address, "totalBorrows()", [], [], ["uint256"]),
    callOptional(rpc, address, "totalReserves()", [], [], ["uint256"]),
  ]);
  const exchangeScaleDecimals = 18 + Number(underlyingMeta.decimals) - Number(tokenDecimals);
  const oneTokenUnderlying = decimalNumber(exchangeRateRaw.value[0], exchangeScaleDecimals);
  const underlyingPrice = await getLlamaPrice(chainCfg, underlying, priceCache);
  const tokenPrice = await getLlamaPrice(chainCfg, address, priceCache);
  const tokenDexPairs = await getDexPairs(chainCfg, address, dexCache);
  const tokenMarket = marketPrice(tokenPrice, tokenDexPairs);
  const navUsd = oneTokenUnderlying !== null && underlyingPrice?.priceUsd ? oneTokenUnderlying * underlyingPrice.priceUsd : null;
  const divergence = navUsd && tokenMarket?.priceUsd ? ((tokenMarket.priceUsd - navUsd) / navUsd) * 100 : null;
  const maxLiquidityUsd = tokenDexPairs[0]?.liquidityUsd || 0;
  const routeHint = divergence !== null && Math.abs(divergence) >= 2 && maxLiquidityUsd >= 10_000
    ? {
        type: divergence > 0 ? "mint-ctoken-sell-market" : "buy-market-redeem-ctoken",
        reason: "Compound-style exchange-rate/market divergence needs route quote and fork proof",
        needsForkProof: true,
        routePositive: false,
      }
    : null;

  return {
    ...out,
    isCompoundLike: true,
    underlying,
    underlyingMeta,
    oneTokenUnderlying: round(oneTokenUnderlying, 10),
    navUsd: round(navUsd, 8),
    marketPriceUsd: tokenMarket?.priceUsd || null,
    marketPriceSource: tokenMarket?.source || null,
    navMarketDivergencePct: round(divergence, 4),
    cash: cashRaw.ok ? formatUnits(cashRaw.value[0], underlyingMeta.decimals) : null,
    borrows: borrowsRaw.ok ? formatUnits(borrowsRaw.value[0], underlyingMeta.decimals) : null,
    reserves: reservesRaw.ok ? formatUnits(reservesRaw.value[0], underlyingMeta.decimals) : null,
    routeHint,
    errors: {
      getCash: cashRaw.ok ? null : cashRaw.error,
      totalBorrows: borrowsRaw.ok ? null : borrowsRaw.error,
      totalReserves: reservesRaw.ok ? null : reservesRaw.error,
    },
  };
}

async function tokenAssessment(rpc, chainCfg, token, priceCache, dexCache) {
  const address = normalizeAddress(token);
  if (!address) return { address: token, status: "bad-address", routePositive: false };
  const [contract, meta, price, dexPairs] = await Promise.all([
    contractMeta(rpc, address),
    tokenMeta(rpc, address),
    getLlamaPrice(chainCfg, address, priceCache),
    getDexPairs(chainCfg, address, dexCache),
  ]);
  const erc4626 = await erc4626Probe(rpc, chainCfg, address, meta.decimals, priceCache, dexCache);
  const compound = await compoundProbe(rpc, chainCfg, address, meta.decimals, priceCache, dexCache);
  const bestMarket = marketPrice(price, dexPairs);
  const routeHints = [erc4626.routeHint, compound.routeHint].filter(Boolean);
  const maxDexLiquidityUsd = dexPairs[0]?.liquidityUsd || 0;
  const tags = [];
  if (erc4626.isErc4626Like) tags.push("erc4626-like");
  if (compound.isCompoundLike) tags.push("compound-like");
  if (contract.eip1967Implementation || contract.eip1967Beacon) tags.push("proxy");
  if (maxDexLiquidityUsd >= 10_000) tags.push("dex-liquid");
  if (!bestMarket?.priceUsd) tags.push("missing-market-price");

  return {
    address,
    status: "mapped-read-only",
    tags,
    contract,
    token: meta,
    priceUsd: bestMarket?.priceUsd || null,
    priceSource: bestMarket?.source || null,
    topDexLiquidityUsd: round(maxDexLiquidityUsd, 0),
    topDexPairs: dexPairs.slice(0, 3),
    erc4626,
    compound,
    routeHints,
    routePositive: routeHints.some((h) => h.routePositive === true),
  };
}

function chainCfgForLead(lead) {
  const chain = lead.chain || (Array.isArray(lead.chains) ? lead.chains.find((c) => CHAINS[c]) : null);
  return chain && CHAINS[chain] ? { chain, cfg: CHAINS[chain] } : { chain: chain || null, cfg: null };
}

function topLimit() {
  const arg = process.argv.find((a) => /^--limit=\d+$/.test(a));
  if (arg) return Math.max(1, Number(arg.split("=")[1]));
  const i = process.argv.indexOf("--limit");
  if (i >= 0 && process.argv[i + 1]) return Math.max(1, Number(process.argv[i + 1]));
  return 15;
}

async function main() {
  if (!fs.existsSync(IN)) throw new Error(`Missing input ${path.relative(WORKSPACE, IN)}`);
  const input = JSON.parse(fs.readFileSync(IN, "utf8"));
  const leads = (input.combined || []).slice(0, topLimit());
  const rpcCache = new Map();
  const priceCache = new Map();
  const dexCache = new Map();
  const leadResults = [];

  for (const lead of leads) {
    const { chain, cfg } = chainCfgForLead(lead);
    const label = lead.project || lead.name || lead.symbol || lead.slug || "unknown";
    if (!cfg) {
      leadResults.push({ lead, label, chain, status: "unsupported-chain", tokenAssessments: [], routePositive: false });
      continue;
    }
    if (!rpcCache.has(cfg.chainId)) rpcCache.set(cfg.chainId, await resolveRpc(cfg));
    const rpc = rpcCache.get(cfg.chainId);
    if (!rpc) {
      leadResults.push({ lead, label, chain, chainId: cfg.chainId, rpcResolved: false, status: "missing-rpc", tokenAssessments: [], routePositive: false });
      continue;
    }
    const tokenAddresses = [...new Set((lead.underlying || []).map(normalizeAddress).filter(Boolean))];
    if (!tokenAddresses.length) {
      leadResults.push({ lead, label, chain, chainId: cfg.chainId, rpcResolved: true, status: "no-token-addresses", tokenAssessments: [], routePositive: false });
      continue;
    }

    const blockNumberHex = await rpcCall(rpc, "eth_blockNumber", []).catch(() => null);
    const tokenAssessments = [];
    for (const token of tokenAddresses) {
      tokenAssessments.push(await tokenAssessment(rpc, cfg, token, priceCache, dexCache));
    }
    const watchHints = tokenAssessments.flatMap((t) => (t.routeHints || []).map((h) => ({ token: t.address, ...h })));
    const routePositive = watchHints.some((h) => h.routePositive === true);
    leadResults.push({
      lead,
      label,
      chain,
      chainId: cfg.chainId,
      rpcResolved: true,
      blockNumber: blockNumberHex ? Number(BigInt(blockNumberHex)) : null,
      status: watchHints.length ? "watch-candidate-needs-fork-proof" : "mapped-no-positive-route",
      tokenAssessments,
      watchHints,
      routePositive,
    });
  }

  const tokenRows = leadResults.flatMap((l) => l.tokenAssessments || []);
  const watchHints = leadResults.flatMap((l) => (l.watchHints || []).map((h) => ({ lead: l.label, chain: l.chain, ...h })));
  const out = {
    generatedAt: new Date().toISOString(),
    scope: "Read-only on-chain triage for current-profit public leads",
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      signedActions: false,
      exploitExecuteCalls: false,
      routePositive: false,
      signedActionJustified: false,
    },
    input: path.relative(WORKSPACE, IN),
    summary: {
      leadsScanned: leadResults.length,
      tokensMapped: tokenRows.length,
      erc4626Like: tokenRows.filter((t) => t.erc4626?.isErc4626Like).length,
      compoundLike: tokenRows.filter((t) => t.compound?.isCompoundLike).length,
      watchCandidates: watchHints.length,
      routePositive: tokenRows.filter((t) => t.routePositive).length,
      signedActionJustified: false,
    },
    watchHints,
    leads: leadResults,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(out, bigintJson, 2)}\n`);

  console.log(`Wrote ${path.relative(WORKSPACE, OUT)}`);
  console.log(`Scanned leads=${out.summary.leadsScanned}; tokens=${out.summary.tokensMapped}; erc4626=${out.summary.erc4626Like}; compoundLike=${out.summary.compoundLike}; watchCandidates=${out.summary.watchCandidates}; routePositive=0`);
  for (const [i, hint] of watchHints.slice(0, 5).entries()) {
    console.log(`#${i + 1} ${hint.chain} ${hint.lead} ${hint.type}: ${hint.reason}`);
  }
}

main().catch((err) => {
  console.error(sanitize(err.message || err));
  process.exit(1);
});
