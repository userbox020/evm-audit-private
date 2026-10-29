#!/usr/bin/env node
// scan-hyperlend-live.js — HyperEVM HyperLend live scanner ($487M TVL)
// Queries core pool reserves, isolated pairs, and oracle health.
// Usage: node tools/scan-hyperlend-live.js

const https = require("https");
const fs = require("fs");
const path = require("path");

const WORKSPACE = path.join(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const FALLBACK_RPC = ["https://", "rpc.", "hyperliquid.", "xyz/evm"].join("");
const OUTPUT = path.join(__dirname, "..", "reports", "raw", "fast", "hyperlend-live.json");
let RPC = null;

const POOL = "0x00A89d7a5A02160f20150EbEA7a2b5E4879A1A8b";
const ORACLE = "0xC9Fb4fbE842d57EAc1dF3e641a281827493A630e";
const PAIR_REGISTRY = "0xf55AF86c9EC3a7d5fa6367c00a120E6B262f718d";
const PAIR_DEPLOYER = "0xD5B33d3c6e750A51fd4E90dbf4AFa2586E33d02c";

// Aave V3 Pool ABI fragments (minimal for live query)
const POOL_ABI = [
  "function getReservesList() view returns (address[])",
  "function getReserveData(address) view returns (tuple(uint256 data) configuration, uint128 liquidityIndex, uint128 variableBorrowIndex, uint128 currentLiquidityRate, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint8 id)",
  "function getReserveConfigurationData(address) view returns (uint256)",
];

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];

const ORACLE_ABI = [
  "function getAssetPrice(address) view returns (uint256)",
  "function getSourceOfAsset(address) view returns (address)",
  "function BASE_CURRENCY_UNIT() view returns (uint256)",
];

const REGISTRY_ABI = [
  "function getPairs() view returns (address[])",
  "function MAX_DEVIATION(address) view returns (uint256)",
];

const PAIR_ABI = [
  "function asset() view returns (address)",
  "function collateral() view returns (address)",
  "function getBorrowLimit() view returns (uint256)",
  "function getDepositLimit() view returns (uint256)",
  "function isBorrowPaused() view returns (bool)",
  "function isLiquidatePaused() view returns (bool)",
  "function oracle() view returns (address)",
  "function interestRate() view returns (address)",
  "function MAX_LTV() view returns (uint256)",
];

// Aave v3.1 ReserveConfigurationMap bit layout
const LT_MASK = 0xFFFF;
const LT_START = 0;
const LIQ_BONUS_MASK = 0xFFFF;
const LIQ_BONUS_START = 32;
const DECIMALS_MASK = 0xFF;
const DECIMALS_START = 48;
const RESERVE_ACTIVE_MASK = 0x1;
const RESERVE_ACTIVE_START = 56;
const RESERVE_FROZEN_MASK = 0x1;
const RESERVE_FROZEN_START = 57;
const BORROWING_ENABLED_MASK = 0x1;
const BORROWING_ENABLED_START = 58;
const RESERVE_PAUSED_MASK = 0x1;
const RESERVE_PAUSED_START = 60;
const LIQ_THRESHOLD_MASK = 0xFFFF;
const LIQ_THRESHOLD_START = 16;

function parseConfigWord(cfg) {
  const val = typeof cfg === "object" ? BigInt(cfg.data) : BigInt(cfg);
  return {
    ltv: Number((val >> BigInt(LT_START)) & BigInt(LT_MASK)) / 100,
    liquidationThreshold: Number((val >> BigInt(LIQ_THRESHOLD_START)) & BigInt(LIQ_THRESHOLD_MASK)) / 100,
    liquidationBonus: Number((val >> BigInt(LIQ_BONUS_START)) & BigInt(LIQ_BONUS_MASK)) / 100,
    decimals: Number((val >> BigInt(DECIMALS_START)) & BigInt(DECIMALS_MASK)),
    active: ((val >> BigInt(RESERVE_ACTIVE_START)) & BigInt(RESERVE_ACTIVE_MASK)) === 1n,
    frozen: ((val >> BigInt(RESERVE_FROZEN_START)) & BigInt(RESERVE_FROZEN_MASK)) === 1n,
    borrowingEnabled: ((val >> BigInt(BORROWING_ENABLED_START)) & BigInt(BORROWING_ENABLED_MASK)) === 1n,
    paused: ((val >> BigInt(RESERVE_PAUSED_START)) & BigInt(RESERVE_PAUSED_MASK)) === 1n,
  };
}

async function rpcCall(method, params) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 });
    let u;
    try {
      u = new URL(RPC);
    } catch (_) {
      resolve(null);
      return;
    }
    const req = https.request({
      hostname: u.hostname, port: 443, path: u.pathname, method: "POST",
      headers: { "Content-Type": "application/json" }, timeout: 15000,
    }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => { try { resolve(JSON.parse(body).result); } catch (e) { resolve(null); } });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.write(data);
    req.end();
  });
}

function extractRpcUrls() {
  if (process.env.HYPERLEND_SKIP_RPC_INVENTORY === "1") return [];
  if (!fs.existsSync(RPC_FILE)) return [];
  return [...fs.readFileSync(RPC_FILE, "utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map((m) => m[0]);
}

async function resolveRpc() {
  const candidates = [...extractRpcUrls(), FALLBACK_RPC];
  for (const url of candidates) {
    RPC = url;
    const chainId = await rpcCall("eth_chainId", []);
    if (!chainId || parseInt(chainId, 16) !== 999) continue;
    const block = await rpcCall("eth_blockNumber", []);
    if (block) return url;
  }
  throw new Error("No HyperEVM RPC endpoint found");
}

async function ethCall(to, data, block) {
  return rpcCall("eth_call", [{ to, data: data.startsWith("0x") ? data : "0x" + data }, block || "latest"]);
}

// Pre-computed selectors
const SELECTORS = {
  "getReservesList()": "0xd1946dbc",
  "getReserveData(address)": "0x35ea6a75",
  "getReserveConfigurationData(address)": "0xea28c7d2",
  "getAssetPrice(address)": "0xb3596f07",
  "getSourceOfAsset(address)": "0x92bf2be0",
  "getPairs()": "0xb2be0bcc",
  "asset()": "0x38d52e0f",
  "collateral()": "0xd8dfeb45",
  "getBorrowLimit()": "0x38e2e396",
  "getDepositLimit()": "0x9b23f1be",
  "isBorrowPaused()": "0xcb7d5b3c",
  "isLiquidatePaused()": "0xb06e93a8",
  "oracle()": "0x7dc0d1d0",
  "interestRate()": "0xa591a6f4",
  "MAX_LTV()": "0x6b56ce74",
  "symbol()": "0x95d89b41",
  "decimals()": "0x313ce567",
  "balanceOf(address)": "0x70a08231",
  "description()": "0x7284e416",
  "latestRoundData()": "0xfeaf968c",
  "PRIMARY_SOURCE()": "0x505b6837",
  "FALLBACK_SOURCE()": "0x79caa7b9",
  "EMERGENCY_SOURCE()": "0xa41772ae",
  "MAX_HEARTBEAT_INTERVAL_PRIMARY()": "0x55b1ccea",
  "MAX_HEARTBEAT_INTERVAL_FALLBACK()": "0xdffadd10",
  "isEmergencyOracleEnabled()": "0xb5139bd2",
  "aggregator()": "0x245a7bfc",
  "getUpdateTimestamp(address)": "0x1d44c654",
  "assetDetails(address)": "0xd21415a3",
  "MAX_EMA_STALE_SECONDS()": "0x72242bf9",
  "MAX_DEVIATION(address)": "0x49e47c28",
};

function encodeCall(sig, ...args) {
  const selector = SELECTORS[sig];
  if (!selector) throw new Error("Unknown selector: " + sig);
  let encoded = selector.slice(2);
  for (const arg of args) {
    if (typeof arg === "string" && arg.startsWith("0x")) {
      encoded += arg.slice(2).padStart(64, "0");
    } else if (typeof arg === "bigint") {
      encoded += arg.toString(16).padStart(64, "0");
    } else if (typeof arg === "number") {
      encoded += BigInt(arg).toString(16).padStart(64, "0");
    } else {
      encoded += String(arg).padStart(64, "0");
    }
  }
  return "0x" + encoded;
}

function decodeAddress(hex) {
  if (!hex || hex === "0x" || hex.length < 66) return null;
  return "0x" + hex.slice(26);
}

function decodeWord(hex, index) {
  const clean = String(hex || "").replace(/^0x/i, "");
  const start = index * 64;
  if (clean.length < start + 64) return null;
  return "0x" + clean.slice(start, start + 64);
}

function decodeAddressWord(hex, index) {
  return decodeAddress(decodeWord(hex, index));
}

function decodeUint256(hex) {
  if (!hex || hex === "0x") return 0n;
  return BigInt(hex);
}

function decodeBool(hex) {
  return decodeUint256(hex) === 1n;
}

function decodeString(hex) {
  if (!hex || hex === "0x") return null;
  try {
    const offset = Number(BigInt(`0x${hex.slice(2, 66)}`));
    const lenStart = 2 + offset * 2;
    const len = Number(BigInt(`0x${hex.slice(lenStart, lenStart + 64)}`));
    return Buffer.from(hex.slice(lenStart + 64, lenStart + 64 + len * 2), "hex").toString("utf8").replace(/\0/g, "");
  } catch (_) { return null; }
}

function decodeLatestRoundData(hex) {
  if (!hex || hex === "0x" || hex.length < 322) return null;
  const w = hex.slice(2);
  const answer = BigInt(`0x${w.slice(64, 128)}`);
  const updatedAt = Number(BigInt(`0x${w.slice(192, 256)}`));
  return { answer: answer.toString(), updatedAt };
}

function decodeAssetDetails(hex) {
  if (!hex || hex === "0x" || hex.length < 386) return null;
  const w = hex.slice(2);
  const word = (i) => `0x${w.slice(i * 64, i * 64 + 64)}`;
  return {
    exists: decodeBool(word(0)),
    isPerpOracle: decodeBool(word(1)),
    metaIndex: Number(decodeUint256(word(2))),
    metaDecimals: Number(decodeUint256(word(3))),
    ema: Number(decodeUint256(word(4))) / 1e8,
    lastTimestamp: Number(decodeUint256(word(5))),
  };
}

async function getBlock() {
  const block = await rpcCall("eth_getBlockByNumber", ["latest", false]);
  if (!block) return { number: 0, timestamp: 0 };
  return { number: parseInt(block.number, 16), timestamp: parseInt(block.timestamp, 16) };
}

async function getSymbol(token) {
  const r = await ethCall(token, encodeCall("symbol()"));
  if (!r || r === "0x") return "UNKNOWN";
  try {
    // Simple string decode
    const len = parseInt(r.slice(66, 130), 16) * 2;
    return Buffer.from(r.slice(130, 130 + len), "hex").toString("utf8").replace(/\0/g, "");
  } catch (_) { return "UNKNOWN"; }
}

async function getDecimals(token) {
  const r = await ethCall(token, encodeCall("decimals()"));
  return r && r !== "0x" ? Number(decodeUint256(r)) : 18;
}

function formatUnitsNumber(raw, decimals) {
  try {
    const value = typeof raw === "bigint" ? raw : BigInt(raw || 0);
    const scale = 10n ** BigInt(decimals);
    const whole = value / scale;
    const frac = value % scale;
    const fracText = frac.toString().padStart(Number(decimals), "0").slice(0, 8).replace(/0+$/, "");
    return Number(`${whole.toString()}${fracText ? "." + fracText : ""}`);
  } catch (_) { return null; }
}

async function readChainlinkLike(source, blockTimestamp) {
  if (!source) return null;
  const [decimalsHex, descriptionHex, roundHex] = await Promise.all([
    ethCall(source, encodeCall("decimals()")),
    ethCall(source, encodeCall("description()")),
    ethCall(source, encodeCall("latestRoundData()")),
  ]);
  const round = decodeLatestRoundData(roundHex);
  return {
    address: source,
    decimals: decimalsHex && decimalsHex !== "0x" ? Number(decodeUint256(decimalsHex)) : null,
    description: decodeString(descriptionHex),
    latestAnswer: round?.answer ?? null,
    updatedAt: round?.updatedAt ?? null,
    ageSeconds: round?.updatedAt && blockTimestamp ? blockTimestamp - round.updatedAt : null,
  };
}

async function readOracleSource(source, asset, blockTimestamp) {
  if (!source) return null;
  const [primaryHex, fallbackHex, emergencyHex, maxPrimaryHex, maxFallbackHex, emergencyEnabledHex, aggregatorHex] = await Promise.all([
    ethCall(source, encodeCall("PRIMARY_SOURCE()")),
    ethCall(source, encodeCall("FALLBACK_SOURCE()")),
    ethCall(source, encodeCall("EMERGENCY_SOURCE()")),
    ethCall(source, encodeCall("MAX_HEARTBEAT_INTERVAL_PRIMARY()")),
    ethCall(source, encodeCall("MAX_HEARTBEAT_INTERVAL_FALLBACK()")),
    ethCall(source, encodeCall("isEmergencyOracleEnabled()")),
    ethCall(source, encodeCall("aggregator()")),
  ]);

  const primary = decodeAddress(primaryHex);
  const fallback = decodeAddress(fallbackHex);
  if (primary && fallback) {
    const maxPrimary = Number(decodeUint256(maxPrimaryHex));
    const maxFallback = Number(decodeUint256(maxFallbackHex));
    const [sourceInfo, primaryInfo, fallbackInfo] = await Promise.all([
      readChainlinkLike(source, blockTimestamp),
      readChainlinkLike(primary, blockTimestamp),
      readChainlinkLike(fallback, blockTimestamp),
    ]);
    return {
      type: "DualFallbackOracle",
      address: source,
      maxHeartbeatPrimary: maxPrimary,
      maxHeartbeatFallback: maxFallback,
      emergencySource: decodeAddress(emergencyHex),
      emergencyEnabled: decodeBool(emergencyEnabledHex),
      source: sourceInfo,
      primary: primaryInfo,
      fallback: fallbackInfo,
      primaryStale: primaryInfo?.ageSeconds !== null && primaryInfo?.ageSeconds > maxPrimary,
      fallbackStale: fallbackInfo?.ageSeconds !== null && fallbackInfo?.ageSeconds > maxFallback,
    };
  }

  const aggregator = decodeAddress(aggregatorHex);
  if (aggregator) {
    const [adapterInfo, maxEmaHex, detailsHex, updateHex] = await Promise.all([
      readChainlinkLike(source, blockTimestamp),
      ethCall(aggregator, encodeCall("MAX_EMA_STALE_SECONDS()")),
      ethCall(aggregator, encodeCall("assetDetails(address)", asset)),
      ethCall(aggregator, encodeCall("getUpdateTimestamp(address)", asset)),
    ]);
    const maxEma = maxEmaHex && maxEmaHex !== "0x" ? Number(decodeUint256(maxEmaHex)) : null;
    const details = decodeAssetDetails(detailsHex);
    const updateTimestamp = updateHex && updateHex !== "0x" ? Number(decodeUint256(updateHex)) : null;
    const age = updateTimestamp && blockTimestamp ? blockTimestamp - updateTimestamp : null;
    return {
      type: "AssetOracleAdapter",
      address: source,
      aggregator,
      adapter: adapterInfo,
      maxEmaStaleSeconds: maxEma,
      assetDetails: details,
      updateTimestamp,
      ageSeconds: age,
      stale: maxEma !== null && age !== null && age > maxEma,
    };
  }

  const feed = await readChainlinkLike(source, blockTimestamp);
  return { type: "ChainlinkLike", address: source, feed };
}

const LIVE_REF_PAIRS = {
  UBTC: "BTCUSDT",
  UETH: "ETHUSDT",
  USOL: "SOLUSDT",
  USDC: "USDCUSDT",
  "USD₮0": "USDCUSDT",
};

async function getLiveRefPrice(symbol) {
  if (["USDe", "USDHL", "USDH"].includes(symbol)) return 1;
  const pair = LIVE_REF_PAIRS[symbol];
  if (!pair) return null;
  try {
    const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${pair}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const price = Number(json.price);
    if (!Number.isFinite(price) || price <= 0) return null;
    if (symbol === "USD₮0") return 1 / price;
    return price;
  } catch (_) {
    return null;
  }
}

function feedAge(sourceInfo) {
  if (!sourceInfo) return null;
  if (sourceInfo.type === "DualFallbackOracle") return sourceInfo.source?.ageSeconds ?? null;
  if (sourceInfo.type === "AssetOracleAdapter") return sourceInfo.ageSeconds ?? sourceInfo.adapter?.ageSeconds ?? null;
  return sourceInfo.feed?.ageSeconds ?? null;
}

async function main() {
  RPC = await resolveRpc();
  console.log("HyperLend Live Scanner (HyperEVM)\n");

  const block = await getBlock();
  console.log(`Block: ${block.number}\n`);

  // 1. Core Pool Reserves
  console.log("═══ Core Pool Reserves ═══");
  const reserves = await ethCall(POOL, encodeCall("getReservesList()"));
  if (!reserves || reserves === "0x") {
    console.log("  Failed to fetch reserves list\n");
    return;
  }

  const reserveCount = parseInt(reserves.slice(66, 130), 16);
  const reserveAddrs = [];
  for (let i = 0; i < reserveCount; i++) {
    const offset = 130 + i * 64;
    const addr = "0x" + reserves.slice(offset + 24, offset + 64);
    reserveAddrs.push(addr);
  }

  const coreResults = [];
  for (const token of reserveAddrs) {
    const symbol = await getSymbol(token);
    const decimals = await getDecimals(token);
    const reserveData = await ethCall(POOL, encodeCall("getReserveData(address)", token));
    const price = await ethCall(ORACLE, encodeCall("getAssetPrice(address)", token));
    const sourceHex = await ethCall(ORACLE, encodeCall("getSourceOfAsset(address)", token));
    const source = decodeAddress(sourceHex);
    const sourceInfo = await readOracleSource(source, token, block.timestamp);
    const priceUsd = price ? Number(decodeUint256(price)) / 1e8 : null;
    const liveRefPrice = await getLiveRefPrice(symbol);
    const oracleVsRefPct = priceUsd && liveRefPrice ? ((priceUsd - liveRefPrice) / liveRefPrice) * 100 : null;

    // ReserveData is a large tuple; pick config word (first field) and addresses
    let config = null;
    let aTokenAddress = null;
    let variableDebtTokenAddress = null;
    if (reserveData) {
      // The first 32 bytes after selector are the configuration uint256
      const configRaw = reserveData.slice(2, 66);
      config = parseConfigWord("0x" + configRaw);
      aTokenAddress = decodeAddressWord(reserveData, 8);
      variableDebtTokenAddress = decodeAddressWord(reserveData, 10);
    }
    // Also try direct config query
    const configHex = await ethCall(POOL, encodeCall("getReserveConfigurationData(address)", token));
    if (configHex && configHex !== "0x") {
      config = parseConfigWord(configHex);
    }

    const cashHex = aTokenAddress ? await ethCall(token, encodeCall("balanceOf(address)", aTokenAddress)) : null;
    const cashRaw = cashHex && cashHex !== "0x" ? decodeUint256(cashHex) : null;
    const cash = cashRaw === null ? null : formatUnitsNumber(cashRaw, decimals);
    const cashUsd = cash !== null && priceUsd !== null ? cash * priceUsd : null;

    const entry = {
      token,
      symbol,
      decimals,
      priceUsd,
      ltv: config?.ltv ?? null,
      liquidationThreshold: config?.liquidationThreshold ?? null,
      active: config?.active ?? null,
      frozen: config?.frozen ?? null,
      borrowingEnabled: config?.borrowingEnabled ?? null,
      paused: config?.paused ?? null,
      aTokenAddress,
      variableDebtTokenAddress,
      cashRaw: cashRaw === null ? null : cashRaw.toString(),
      cash,
      cashUsd,
      oracleSource: source,
      oracleSourceInfo: sourceInfo,
      oracleFeedAgeSeconds: feedAge(sourceInfo),
      liveRefPrice,
      oracleVsRefPct,
    };
    coreResults.push(entry);
    console.log(`  ${symbol.padEnd(8)} LTV=${(entry.ltv ?? "?").toString().padEnd(6)} price=$${(priceUsd ?? "?").toString().padEnd(10)} active=${entry.active ?? "?"} borrow=${entry.borrowingEnabled ?? "?"}`);
  }

  // 2. Isolated Pairs
  console.log("\n═══ Isolated Pairs ═══");
  let pairResults = [];
  try {
    const pairsHex = await ethCall(PAIR_REGISTRY, encodeCall("getPairs()"));
    if (pairsHex && pairsHex !== "0x") {
      const pairCount = parseInt(pairsHex.slice(66, 130), 16);
      const pairs = [];
      for (let i = 0; i < Math.min(pairCount, 100); i++) {
        const offset = 130 + i * 64;
        pairs.push("0x" + pairsHex.slice(offset + 24, offset + 64));
      }
      console.log(`  ${pairs.length} pairs registered`);

      for (const pairAddr of pairs) {
        const asset = await ethCall(pairAddr, encodeCall("asset()"));
        const collateral = await ethCall(pairAddr, encodeCall("collateral()"));
        const assetSym = asset ? await getSymbol(decodeAddress(asset)) : "?";
        const collatSym = collateral ? await getSymbol(decodeAddress(collateral)) : "?";
        const maxLtv = await ethCall(pairAddr, encodeCall("MAX_LTV()"));
        const borrowPaused = await ethCall(pairAddr, encodeCall("isBorrowPaused()"));
        const pairOracle = await ethCall(pairAddr, encodeCall("oracle()"));
        const maxDev = pairOracle ? await ethCall(PAIR_REGISTRY, encodeCall("MAX_DEVIATION(address)", decodeAddress(pairOracle))) : null;

        const entry = {
          pair: pairAddr,
          asset: decodeAddress(asset),
          assetSymbol: assetSym,
          collateral: decodeAddress(collateral),
          collateralSymbol: collatSym,
          maxLtv: maxLtv ? Number(decodeUint256(maxLtv)) / 100 : null,
          borrowPaused: borrowPaused === "0x0000000000000000000000000000000000000000000000000000000000000001",
          oracle: pairOracle ? decodeAddress(pairOracle) : null,
          maxDeviation: maxDev ? Number(decodeUint256(maxDev)) / 100 : null,
        };
        pairResults.push(entry);
        console.log(`  ${collatSym.padEnd(8)}->${assetSym.padEnd(8)} LTV=${(entry.maxLtv ?? "?").toString().padEnd(6)} dev=${(entry.maxDeviation ?? "?").toString().padEnd(5)} paused=${entry.borrowPaused}`);
      }
    } else {
      console.log("  No pairs registered");
    }
  } catch (_) {
    console.log("  Pair scan failed");
  }

  // 3. Summary
  const activeCore = coreResults.filter(r => r.active && r.ltv > 0);
  const borrowableCore = coreResults.filter(r => r.borrowingEnabled && r.ltv > 0);
  const staleBorrowableCore = borrowableCore.filter(r => r.oracleFeedAgeSeconds !== null && r.oracleFeedAgeSeconds > 3600);
  const divergentCore = borrowableCore.filter(r => r.oracleVsRefPct !== null && Math.abs(r.oracleVsRefPct) >= 1);
  const activePairs = pairResults.filter(p => p.maxLtv > 0 && !p.borrowPaused);
  const highRiskPairs = pairResults.filter(p => p.maxLtv >= 80 && !p.borrowPaused);
  const staleCheckNeeded = pairResults.filter(p => p.maxLtv > 0 && !p.borrowPaused && p.oracle !== null).map(p => p.oracle);

  console.log(`\n═══ SUMMARY ═══`);
  console.log(`  Core reserves: ${coreResults.length} (active: ${activeCore.length}, borrowable: ${borrowableCore.length})`);
  console.log(`  Borrowable stale-feed reserves >1h: ${staleBorrowableCore.length}; live-ref divergences >=1%: ${divergentCore.length}`);
  console.log(`  Isolated pairs: ${pairResults.length} (active: ${activePairs.length}, high-LTV: ${highRiskPairs.length})`);
  if (staleCheckNeeded.length > 0) {
    console.log(`  Oracle freshness check needed for: ${staleCheckNeeded.length} pair oracle(s)`);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    safety: {
      rpcInventoryRead: process.env.HYPERLEND_SKIP_RPC_INVENTORY !== "1" && fs.existsSync(RPC_FILE),
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      liveTransactions: false,
      broadcasts: false,
      sanitizedOutputOnly: true,
    },
    chain: { id: 999, block: block.number, timestamp: block.timestamp },
    corePool: POOL,
    oracle: ORACLE,
    coreReserves: coreResults,
    isolatedPairs: pairResults,
    summary: {
      totalCoreReserves: coreResults.length,
      activeCoreReserves: activeCore.length,
      borrowableCoreReserves: borrowableCore.length,
      staleBorrowableCoreReserves: staleBorrowableCore.map(r => ({ symbol: r.symbol, ageSeconds: r.oracleFeedAgeSeconds, oracleVsRefPct: r.oracleVsRefPct })),
      divergentCoreReserves: divergentCore.map(r => ({ symbol: r.symbol, ageSeconds: r.oracleFeedAgeSeconds, oracleVsRefPct: r.oracleVsRefPct })),
      totalPairs: pairResults.length,
      activePairs: activePairs.length,
      highRiskPairs: highRiskPairs.length,
      staleCheckOracles: staleCheckNeeded,
    },
  };

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(report, null, 2));
  console.log(`\nReport: ${OUTPUT}`);
}

main().catch((e) => {
  const message = String(e?.message || e).replace(/https?:\/\/[^\s"'<>]+/g, "[redacted-rpc]");
  console.error(`HyperLend scan failed: ${message}`);
  process.exit(1);
});
