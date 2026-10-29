#!/usr/bin/env node
// Read-only BenQi Avalanche market/oracle mapper. Never prints RPC URLs.
const fs = require("fs");
const path = require("path");
const { ethers } = require("./node_modules/ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "benqi-avalanche-live.json");

const CHAIN_ID = 43114;
const COMPTROLLER = "0x486Af39519B4Dc9a7fCcd318217352830E8AD9b4";
const ZERO = "0x0000000000000000000000000000000000000000";
const QI_AVAX_UNDERLYING = "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7"; // WAVAX
const PUBLIC_AVAX_RPC = "https://api.avax.network/ext/bc/C/rpc";
const ORACLE_SELECTOR = "0x7dc0d1d0";
const FEED_STORAGE_SLOTS = [2, 1, 3, 0, 4, 5, 6, 7, 8];
const storageFeedCache = new Map();

const COMPTROLLER_ABI = [
  "function oracle() view returns (address)",
  "function getAllMarkets() view returns (address[])",
  "function markets(address) view returns (bool isListed,uint256 collateralFactorMantissa,bool isQi)",
  "function closeFactorMantissa() view returns (uint256)",
  "function liquidationIncentiveMantissa() view returns (uint256)",
  "function mintGuardianPaused(address) view returns (bool)",
  "function borrowGuardianPaused(address) view returns (bool)",
];

const ORACLE_ABI = [
  "function getUnderlyingPrice(address qiToken) view returns (uint256)",
  "function getFeeds(address qiToken) view returns (address edgeFeed,address chainlinkFeed)",
  "function assetConfigs(address qiToken) view returns (uint256 stalenessThreshold,bool isConfigured,uint256 deviationThreshold)",
  "function oracleMode() view returns (uint8)",
  "function deviationThreshold() view returns (uint256)",
  "function maxDeviationThreshold() view returns (uint256)",
  "function edgeOracle() view returns (address)",
  "function chainlinkOracle() view returns (address)",
  "function getFeed(string symbol) view returns (address)",
  "function assetPrices(address asset) view returns (uint256)",
  "function admin() view returns (address)",
];

const QTOKEN_ABI = [
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function underlying() view returns (address)",
  "function getCash() view returns (uint256)",
  "function totalBorrows() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function exchangeRateStored() view returns (uint256)",
  "function borrowRatePerTimestamp() view returns (uint256)",
];

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
];

const FEED_ABI = [
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
  "function latestAnswer() view returns (int256)",
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
];

async function rpcCall(url, method, params, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ctrl.signal,
    });
    const json = await res.json();
    return json.result ?? null;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function extractRpcUrls() {
  if (!fs.existsSync(RPC_FILE)) return [];
  return [...fs.readFileSync(RPC_FILE, "utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map((m) => m[0]);
}

async function resolveRpc() {
  const candidates = [...extractRpcUrls(), PUBLIC_AVAX_RPC];
  for (const url of candidates) {
    const id = await rpcCall(url, "eth_chainId", [], 8000);
    if (!id || parseInt(id, 16) !== CHAIN_ID) continue;
    const call = await rpcCall(url, "eth_call", [{ to: COMPTROLLER, data: ORACLE_SELECTOR }, "latest"], 8000);
    if (call && /^0x[0-9a-fA-F]+$/.test(call)) return url;
  }
  throw new Error("No Avalanche RPC endpoint found");
}

async function tryCall(fn, fallback = null) {
  try {
    return await fn();
  } catch (_) {
    return fallback;
  }
}

function fmtUnits(x, decimals, max = 6) {
  if (x === null || x === undefined) return null;
  const s = ethers.formatUnits(BigInt(x), decimals);
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  return n.toLocaleString("en-US", { maximumFractionDigits: max });
}

function numUnits(x, decimals) {
  if (x === null || x === undefined) return null;
  const n = Number(ethers.formatUnits(BigInt(x), decimals));
  return Number.isFinite(n) ? n : null;
}

function benqiOracleUsd(raw, underlyingDecimals) {
  if (raw === null || raw === undefined) return null;
  const decimals = 36 - Number(underlyingDecimals);
  const n = Number(ethers.formatUnits(BigInt(raw), decimals));
  return Number.isFinite(n) ? n : null;
}

function feedAliases(qSymbol, uSymbol) {
  const out = new Set();
  const add = (s) => {
    if (!s) return;
    out.add(s);
    out.add(s.toUpperCase());
    out.add(s.toLowerCase());
  };
  add(qSymbol);
  add(uSymbol);
  if (qSymbol && qSymbol.startsWith("qi")) add(qSymbol.slice(2));
  if (uSymbol) {
    add(uSymbol.replace(/\.e$/i, ""));
    add(uSymbol.replace(/\.b$/i, ""));
  }
  if (/^WAVAX$/i.test(uSymbol)) add("AVAX");
  if (/^WETH/i.test(uSymbol)) add("ETH");
  if (/^(WBTC|BTC)/i.test(uSymbol)) add("BTC");
  if (/^USDt$/i.test(uSymbol)) add("USDT");
  return [...out].filter(Boolean);
}

async function resolveFeed(oracle, aliases) {
  for (const alias of aliases) {
    const feed = await tryCall(() => oracle.getFeed(alias), ZERO);
    if (feed && feed !== ZERO) return { feed, alias };
  }
  return { feed: ZERO, alias: null };
}

async function callAddressGetter(provider, target, signature, arg) {
  const iface = new ethers.Interface([`function ${signature}(address) view returns (address)`]);
  const data = iface.encodeFunctionData(signature, [arg]);
  try {
    const ret = await provider.call({ to: target, data });
    if (!ret || ret === "0x") return null;
    const [addr] = iface.decodeFunctionResult(signature, ret);
    return addr && addr !== ZERO ? addr : null;
  } catch (_) {
    return null;
  }
}

async function resolveAddressFeed(provider, oracleAddr, qToken, underlying) {
  const getters = [
    "priceFeeds",
    "underlyingPriceFeeds",
    "assetFeeds",
    "tokenFeeds",
    "chainlinkFeeds",
    "aggregators",
    "feeds",
    "getFeed",
  ];
  for (const getter of getters) {
    for (const arg of [qToken, underlying].filter(Boolean)) {
      const feed = await callAddressGetter(provider, oracleAddr, getter, arg);
      if (feed) return { feed, getter, arg };
    }
  }
  return { feed: ZERO, getter: null, arg: null };
}

function addressFromStorageWord(word) {
  if (!word || word === "0x") return null;
  const addr = `0x${word.slice(-40)}`;
  return addr === ZERO ? null : ethers.getAddress(addr);
}

function mappingSlot(key, slot) {
  const encoded = ethers.concat([
    ethers.zeroPadValue(key, 32),
    ethers.zeroPadValue(ethers.toBeHex(slot), 32),
  ]);
  return ethers.keccak256(encoded);
}

async function resolveStorageFeed(provider, oracleAddr, aliases) {
  for (const alias of aliases) {
    const key = ethers.keccak256(ethers.toUtf8Bytes(alias));
    for (const slot of FEED_STORAGE_SLOTS) {
      const cacheKey = `${oracleAddr}:${alias}:${slot}`;
      let feed = storageFeedCache.get(cacheKey);
      if (feed === undefined) {
        const raw = await tryCall(() => provider.getStorage(oracleAddr, mappingSlot(key, slot)), null);
        feed = addressFromStorageWord(raw);
        storageFeedCache.set(cacheKey, feed || null);
      }
      if (!feed) continue;
      const code = await tryCall(() => provider.getCode(feed), "0x");
      if (code && code !== "0x") return { feed, alias, getter: `storage:feeds-slot-${slot}`, arg: alias };
    }
  }
  return { feed: ZERO, alias: null, getter: null, arg: null };
}

async function readFeedInfo(provider, feedAddr, block, meta = {}) {
  if (!feedAddr || feedAddr === ZERO) return null;
  const f = new ethers.Contract(feedAddr, FEED_ABI, provider);
  const [decimals, description, latestAnswer, roundData] = await Promise.all([
    tryCall(() => f.decimals(), null),
    tryCall(() => f.description(), null),
    tryCall(() => f.latestAnswer(), null),
    tryCall(() => f.latestRoundData(), null),
  ]);
  const updatedAt = roundData ? Number(roundData[3]) : null;
  return {
    address: feedAddr,
    ...meta,
    description,
    decimals: decimals === null ? null : Number(decimals),
    latestAnswer: latestAnswer === null ? null : latestAnswer.toString(),
    updatedAt,
    ageSeconds: updatedAt ? Number(block.timestamp) - updatedAt : null,
  };
}

async function dexScreenerPrice(token) {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${token}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const pairs = (json.pairs || []).filter((p) => String(p.chainId).toLowerCase() === "avalanche");
    pairs.sort((a, b) => Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0));
    const best = pairs[0];
    if (!best || !best.priceUsd) return null;
    return {
      priceUsd: Number(best.priceUsd),
      liquidityUsd: Number(best.liquidity?.usd || 0),
      pairAddress: best.pairAddress,
      dexId: best.dexId,
    };
  } catch (_) {
    return null;
  }
}

function classifyMarket(m) {
  const reasons = [];
  if (!m.isListed) reasons.push("not-listed");
  if (m.borrowPaused) reasons.push("borrow-paused");
  if (m.collateralFactor === 0) reasons.push("cf-zero");
  const stalenessThreshold = m.oracleConfig?.stalenessThreshold ?? 3600;
  const feedList = m.feeds ? Object.values(m.feeds).filter(Boolean) : m.feed ? [m.feed] : [];
  const staleFeeds = feedList.filter((feed) => feed.ageSeconds !== null && feed.ageSeconds > stalenessThreshold);
  for (const feed of staleFeeds) reasons.push(`${feed.role || "feed"}-stale`);
  if (staleFeeds.length >= 2) reasons.push("both-oracles-stale");
  if (m.oraclePriceUsd !== null && m.dex?.priceUsd) {
    const div = ((m.oraclePriceUsd - m.dex.priceUsd) / m.dex.priceUsd) * 100;
    m.oracleVsDexPct = div;
    if (Math.abs(div) > 5) reasons.push(`oracle-dex-divergence-${div.toFixed(2)}pct`);
  }
  if (m.cashUsd !== null && m.cashUsd < 1000) reasons.push("low-cash");
  m.flags = reasons;
  m.actionable =
    m.isListed &&
    !m.borrowPaused &&
    m.cashUsd !== null &&
    m.cashUsd >= 10000 &&
    m.collateralFactor > 0 &&
    m.oracleVsDexPct !== null &&
    Math.abs(m.oracleVsDexPct) >= 5;
  return m;
}

async function main() {
  const rpc = await resolveRpc();
  const provider = new ethers.JsonRpcProvider(rpc, undefined, { batchMaxCount: 1 });
  const block = await provider.getBlock("latest");
  const comptroller = new ethers.Contract(COMPTROLLER, COMPTROLLER_ABI, provider);
  const oracleAddr = await comptroller.oracle();
  const oracle = new ethers.Contract(oracleAddr, ORACLE_ABI, provider);
  const [
    markets,
    closeFactor,
    liquidationIncentive,
    oracleAdmin,
    oracleMode,
    defaultDeviationThreshold,
    maxDeviationThreshold,
    edgeOracle,
    chainlinkOracle,
  ] = await Promise.all([
    comptroller.getAllMarkets(),
    comptroller.closeFactorMantissa(),
    comptroller.liquidationIncentiveMantissa(),
    tryCall(() => oracle.admin(), null),
    tryCall(() => oracle.oracleMode(), null),
    tryCall(() => oracle.deviationThreshold(), null),
    tryCall(() => oracle.maxDeviationThreshold(), null),
    tryCall(() => oracle.edgeOracle(), null),
    tryCall(() => oracle.chainlinkOracle(), null),
  ]);

  const outMarkets = [];
  for (const q of markets) {
    const qi = new ethers.Contract(q, QTOKEN_ABI, provider);
    const [qSymbol, qName, qDecimals, market, mintPaused, borrowPaused, cash, borrows, totalSupply, exchangeRate] =
      await Promise.all([
        tryCall(() => qi.symbol(), "UNKNOWN"),
        tryCall(() => qi.name(), null),
        tryCall(() => qi.decimals(), 8),
        comptroller.markets(q),
        tryCall(() => comptroller.mintGuardianPaused(q), null),
        tryCall(() => comptroller.borrowGuardianPaused(q), null),
        tryCall(() => qi.getCash(), null),
        tryCall(() => qi.totalBorrows(), null),
        tryCall(() => qi.totalSupply(), null),
        tryCall(() => qi.exchangeRateStored(), null),
      ]);

    let underlyingAddr = await tryCall(() => qi.underlying(), null);
    if (!underlyingAddr && qSymbol === "qiAVAX") underlyingAddr = QI_AVAX_UNDERLYING;
    const underlying = underlyingAddr ? new ethers.Contract(underlyingAddr, ERC20_ABI, provider) : null;
    const [uSymbol, uName, uDecimals, directPrice, oraclePriceRaw] = await Promise.all([
      underlying ? tryCall(() => underlying.symbol(), qSymbol.replace(/^qi/, "")) : qSymbol,
      underlying ? tryCall(() => underlying.name(), null) : null,
      underlying ? tryCall(() => underlying.decimals(), 18) : 18,
      underlyingAddr ? tryCall(() => oracle.assetPrices(underlyingAddr), 0n) : 0n,
      tryCall(() => oracle.getUnderlyingPrice(q), null),
    ]);

    const [oracleConfigRaw, dualFeeds] = await Promise.all([
      tryCall(() => oracle.assetConfigs(q), null),
      tryCall(() => oracle.getFeeds(q), null),
    ]);
    const oracleConfig = oracleConfigRaw
      ? {
          stalenessThreshold: Number(oracleConfigRaw[0]),
          isConfigured: Boolean(oracleConfigRaw[1]),
          deviationThreshold: Number(ethers.formatUnits(oracleConfigRaw[2], 18)),
        }
      : null;

    const aliases = feedAliases(qSymbol, uSymbol);
    let resolvedFeed = { feed: ZERO, alias: null, getter: null, arg: null };
    let feeds = null;
    if (dualFeeds) {
      feeds = {
        edge: await readFeedInfo(provider, dualFeeds[0], block, { role: "edge", getter: "getFeeds" }),
        chainlink: await readFeedInfo(provider, dualFeeds[1], block, { role: "chainlink", getter: "getFeeds" }),
      };
      resolvedFeed = { feed: dualFeeds[0] || dualFeeds[1] || ZERO, alias: null, getter: "getFeeds", arg: q };
    } else {
      const resolvedAddressFeed = await resolveAddressFeed(provider, oracleAddr, q, underlyingAddr);
      resolvedFeed =
        resolvedAddressFeed.feed !== ZERO
          ? resolvedAddressFeed
          : await resolveFeed(oracle, aliases).then((feed) =>
              feed.feed !== ZERO ? feed : resolveStorageFeed(provider, oracleAddr, aliases),
            );
    }
    const feedAddr = resolvedFeed.feed;
    let feed = null;
    if (feeds) {
      feed = feeds.edge || feeds.chainlink;
    } else if (feedAddr && feedAddr !== ZERO) {
      feed = await readFeedInfo(provider, feedAddr, block, {
        symbol: resolvedFeed.alias || null,
        getter: resolvedFeed.getter || null,
        getterArg: resolvedFeed.arg || null,
        aliasesTried: aliases,
      });
    }

    const oraclePriceUsd = oraclePriceRaw === null ? null : benqiOracleUsd(oraclePriceRaw, uDecimals);
    const dex = underlyingAddr ? await dexScreenerPrice(underlyingAddr) : null;
    const cashTok = cash === null ? null : numUnits(cash, uDecimals);
    const borrowsTok = borrows === null ? null : numUnits(borrows, uDecimals);
    const refPrice = dex?.priceUsd || oraclePriceUsd;
    const marketOut = classifyMarket({
      qToken: q,
      qSymbol,
      qName,
      qDecimals: Number(qDecimals),
      underlying: underlyingAddr,
      underlyingSymbol: uSymbol,
      underlyingName: uName,
      underlyingDecimals: Number(uDecimals),
      isListed: Boolean(market[0]),
      collateralFactor: Number(ethers.formatUnits(market[1], 18)),
      isQi: Boolean(market[2]),
      mintPaused,
      borrowPaused,
      cashRaw: cash === null ? null : cash.toString(),
      cash: cash === null ? null : fmtUnits(cash, uDecimals),
      cashUsd: cashTok !== null && refPrice !== null ? cashTok * refPrice : null,
      totalBorrowsRaw: borrows === null ? null : borrows.toString(),
      totalBorrows: borrows === null ? null : fmtUnits(borrows, uDecimals),
      totalBorrowsUsd: borrowsTok !== null && refPrice !== null ? borrowsTok * refPrice : null,
      totalSupplyRaw: totalSupply === null ? null : totalSupply.toString(),
      exchangeRateRaw: exchangeRate === null ? null : exchangeRate.toString(),
      directPriceRaw: directPrice === null ? null : directPrice.toString(),
      oraclePriceRaw: oraclePriceRaw === null ? null : oraclePriceRaw.toString(),
      oraclePriceUsd,
      oracleConfig,
      feed,
      feeds,
      dex,
      oracleVsDexPct: null,
      flags: [],
      actionable: false,
    });
    outMarkets.push(marketOut);
  }

  outMarkets.sort((a, b) => Number(b.cashUsd || 0) - Number(a.cashUsd || 0));
  const actionable = outMarkets.filter((m) => m.actionable);
  const stale = outMarkets.filter((m) => {
    const stalenessThreshold = m.oracleConfig?.stalenessThreshold ?? 3600;
    const feedList = m.feeds ? Object.values(m.feeds).filter(Boolean) : m.feed ? [m.feed] : [];
    return feedList.some((feed) => feed.ageSeconds !== null && feed.ageSeconds > stalenessThreshold);
  });
  const divergent = outMarkets.filter((m) => Math.abs(m.oracleVsDexPct || 0) >= 5);

  const out = {
    generatedAt: new Date().toISOString(),
    chainId: CHAIN_ID,
    block: { number: Number(block.number), timestamp: Number(block.timestamp) },
    comptroller: COMPTROLLER,
    oracle: oracleAddr,
    oracleAdmin,
    oracleMode: oracleMode === null ? null : Number(oracleMode),
    edgeOracle,
    chainlinkOracle,
    defaultDeviationThreshold: defaultDeviationThreshold === null ? null : ethers.formatUnits(defaultDeviationThreshold, 18),
    maxDeviationThreshold: maxDeviationThreshold === null ? null : ethers.formatUnits(maxDeviationThreshold, 18),
    closeFactor: ethers.formatUnits(closeFactor, 18),
    liquidationIncentive: ethers.formatUnits(liquidationIncentive, 18),
    marketCount: outMarkets.length,
    actionableCount: actionable.length,
    staleFeedCount: stale.length,
    divergentCount: divergent.length,
    markets: outMarkets,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));

  console.log(`BenQi Avalanche scan: markets=${out.marketCount} actionable=${out.actionableCount} staleFeeds=${out.staleFeedCount} divergent=${out.divergentCount}`);
  for (const m of outMarkets.slice(0, 10)) {
    const div = m.oracleVsDexPct === null ? "n/a" : `${m.oracleVsDexPct.toFixed(2)}%`;
    const age = m.feed?.ageSeconds === null || m.feed?.ageSeconds === undefined ? "n/a" : `${m.feed.ageSeconds}s`;
    console.log(`${m.qSymbol}/${m.underlyingSymbol}: cash=$${(m.cashUsd || 0).toFixed(0)} borrows=$${(m.totalBorrowsUsd || 0).toFixed(0)} cf=${(m.collateralFactor * 100).toFixed(1)}% feedAge=${age} oracleVsDex=${div} flags=${m.flags.join(",") || "none"}`);
  }
  console.log(`Report: ${path.relative(WORKSPACE, OUT)}`);
}

main().catch((err) => {
  console.error(`BenQi Avalanche scan failed: ${err.message}`);
  process.exitCode = 1;
});
