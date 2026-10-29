#!/usr/bin/env node
// Read-only Tectonic Cronos market/oracle mapper. Never prints RPC URLs.
const fs = require("fs");
const path = require("path");
const { ethers } = require("./node_modules/ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "tectonic-cronos-live.json");

const CHAIN_ID = 25;
const ZERO = "0x0000000000000000000000000000000000000000";
const PUBLIC_CRONOS_RPCS = [
  ["https://", "cronos-evm-rpc.", "publicnode.", "com"].join(""),
  ["https://", "cronos.", "drpc.", "org"].join(""),
  ["https://", "evm.", "cronos.", "org"].join(""),
];
const TECTONIC_SITE = "https://tectonic.finance/markets/";
const WCRO = "0x5C7F8A570d578ED84E63fdFA7b1eE72dEae1AE23";
const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const SOCKET_NAMES = {
  "0xb3831584acb95ed9ccb0c11f677b5ad01deaeec0": "MAIN",
  "0x7e0067cef1e7558dafbab3b1f8f6fa75ff64725f": "VENO",
  "0x8312a8d5d1dec499d00eb28e1a2723b13aa53c1e": "DEFI",
};

const CORE_ABI = [
  "function oracle() view returns (address)",
  "function getAllMarkets() view returns (address[])",
  "function markets(address) view returns (bool isListed,uint256 collateralFactorMantissa,bool isTonic)",
  "function closeFactorMantissa() view returns (uint256)",
  "function liquidationIncentiveMantissa() view returns (uint256)",
  "function mintGuardianPaused(address) view returns (bool)",
  "function borrowGuardianPaused(address) view returns (bool)",
  "function supplyCaps(address) view returns (uint256)",
  "function borrowCaps(address) view returns (uint256)",
];

const TTOKEN_ABI = [
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function underlying() view returns (address)",
  "function getCash() view returns (uint256)",
  "function totalBorrows() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function exchangeRateStored() view returns (uint256)",
];

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
];

const ORACLE_ABI = [
  "function getUnderlyingPrice(address tToken) view returns (uint256)",
  "function tTokenToOracle(address tToken) view returns (address)",
  "function isPriceOracle() view returns (bool)",
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
  const candidates = [...extractRpcUrls(), ...PUBLIC_CRONOS_RPCS];
  for (const url of candidates) {
    const id = await rpcCall(url, "eth_chainId", [], 8000);
    if (!id || parseInt(id, 16) !== CHAIN_ID) continue;
    const block = await rpcCall(url, "eth_blockNumber", [], 8000);
    if (block) return url;
  }
  throw new Error("No Cronos RPC endpoint found");
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

function compoundOracleUsd(raw, underlyingDecimals) {
  if (raw === null || raw === undefined) return null;
  const decimals = 36 - Number(underlyingDecimals);
  const n = Number(ethers.formatUnits(BigInt(raw), decimals));
  return Number.isFinite(n) ? n : null;
}

function appUrl(src) {
  if (src.startsWith("http")) return src;
  return new URL(src, TECTONIC_SITE).toString();
}

async function fetchDeployments() {
  const html = await (await fetch(TECTONIC_SITE, { signal: AbortSignal.timeout(10000) })).text();
  const appSrc = html.match(/src="([^"]*\/pages\/_app-[^"]+\.js)"/)?.[1];
  if (!appSrc) return [];
  const js = await (await fetch(appUrl(appSrc), { signal: AbortSignal.timeout(20000) })).text();
  const deployments = [];
  let parseCandidates = 0;
  let firstParseError = null;
  let searchFrom = 0;
  while (true) {
    const start = js.indexOf("JSON.parse('", searchFrom);
    if (start === -1) break;
    const bodyStart = start + "JSON.parse('".length;
    let end = -1;
    for (let i = bodyStart; i < js.length - 1; i += 1) {
      if (js[i] !== "'" || js[i + 1] !== ")") continue;
      let slashCount = 0;
      for (let j = i - 1; j >= bodyStart && js[j] === "\\"; j -= 1) slashCount += 1;
      if (slashCount % 2 === 0) {
        end = i;
        break;
      }
    }
    searchFrom = bodyStart;
    if (end === -1) break;
    const raw = js.slice(bodyStart, end);
    parseCandidates += 1;
    try {
      const jsonText = Function(`"use strict"; return '${raw}';`)();
      const parsed = JSON.parse(jsonText);
      if (parsed?.metadata?.env && Array.isArray(parsed.contracts)) deployments.push(parsed);
    } catch (err) {
      if (!firstParseError) firstParseError = `${err.message}; rawPrefix=${raw.slice(0, 80)}; rawAt=${raw.slice(230, 320)}`;
    }
    searchFrom = end + 2;
  }
  if (!deployments.length) {
    console.error(`frontend app chunk parsed but no deployments: candidates=${parseCandidates} firstError=${firstParseError || "none"}`);
  }
  return deployments;
}

function socketDeployments(deployments) {
  const bySocket = new Map();
  for (const deployment of deployments) {
    const socket = deployment.contracts.find((c) => c.contractType === "TectonicSocket");
    if (!socket?.address) continue;
    const key = socket.address.toLowerCase();
    if (!SOCKET_NAMES[key]) continue;
    const item = {
      pool: SOCKET_NAMES[key],
      socket: ethers.getAddress(socket.address),
      env: deployment.metadata.env,
      contractCount: deployment.contracts.length,
    };
    const prev = bySocket.get(key);
    if (!prev || (!prev.env.startsWith("mainnet") && item.env.startsWith("mainnet"))) bySocket.set(key, item);
  }
  const out = [...bySocket.values()];
  out.sort((a, b) => a.pool.localeCompare(b.pool));
  return out;
}

async function readFeedInfo(provider, feedAddr, block) {
  if (!feedAddr || feedAddr === ZERO) return null;
  const feed = new ethers.Contract(feedAddr, FEED_ABI, provider);
  const [decimals, description, latestAnswer, roundData] = await Promise.all([
    tryCall(() => feed.decimals(), null),
    tryCall(() => feed.description(), null),
    tryCall(() => feed.latestAnswer(), null),
    tryCall(() => feed.latestRoundData(), null),
  ]);
  const updatedAt = roundData ? Number(roundData[3]) : null;
  return {
    address: feedAddr,
    description,
    decimals: decimals === null ? null : Number(decimals),
    latestAnswer: latestAnswer === null ? null : latestAnswer.toString(),
    updatedAt,
    ageSeconds: updatedAt ? Number(block.timestamp) - updatedAt : null,
  };
}

async function dexScreenerPrice(token) {
  if (!token) return null;
  const queryToken = token === NATIVE ? WCRO : token;
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${queryToken}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const pairs = (json.pairs || []).filter((p) => String(p.chainId).toLowerCase() === "cronos");
    pairs.sort((a, b) => Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0));
    const best = pairs[0];
    if (!best?.priceUsd) return null;
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
  if (m.mintPaused) reasons.push("mint-paused");
  if (m.borrowPaused) reasons.push("borrow-paused");
  if (m.collateralFactor === 0) reasons.push("cf-zero");
  if (m.cashUsd !== null && m.cashUsd < 1000) reasons.push("low-cash");
  if (m.feed?.ageSeconds !== null && m.feed?.ageSeconds !== undefined && m.feed.ageSeconds > 1800) {
    reasons.push("feed-age-gt-30m");
  }
  if (m.oraclePriceUsd !== null && m.dex?.priceUsd) {
    const div = ((m.oraclePriceUsd - m.dex.priceUsd) / m.dex.priceUsd) * 100;
    m.oracleVsDexPct = div;
    if (Math.abs(div) > 1) reasons.push(`oracle-dex-divergence-${div.toFixed(2)}pct`);
  }
  m.flags = reasons;
  m.actionable =
    m.isListed &&
    !m.borrowPaused &&
    m.cashUsd !== null &&
    m.cashUsd >= 10000 &&
    m.collateralFactor > 0 &&
    m.oracleVsDexPct !== null &&
    Math.abs(m.oracleVsDexPct) >= 1 &&
    m.feed?.ageSeconds !== null &&
    m.feed?.ageSeconds >= 1800;
  return m;
}

async function main() {
  const [rpc, deployments] = await Promise.all([resolveRpc(), fetchDeployments()]);
  const pools = socketDeployments(deployments);
  if (!pools.length) {
    console.error(`Parsed deployment blobs: ${deployments.length}`);
    throw new Error("No live Tectonic socket deployments found in frontend metadata");
  }

  const provider = new ethers.JsonRpcProvider(rpc, undefined, { batchMaxCount: 1 });
  const block = await provider.getBlock("latest");
  const outPools = [];
  const outMarkets = [];

  for (const poolInfo of pools) {
    const core = new ethers.Contract(poolInfo.socket, CORE_ABI, provider);
    const [oracleAddr, markets, closeFactor, liquidationIncentive] = await Promise.all([
      core.oracle(),
      core.getAllMarkets(),
      tryCall(() => core.closeFactorMantissa(), null),
      tryCall(() => core.liquidationIncentiveMantissa(), null),
    ]);
    const oracle = new ethers.Contract(oracleAddr, ORACLE_ABI, provider);
    outPools.push({
      ...poolInfo,
      oracle: oracleAddr,
      marketCount: markets.length,
      closeFactor: closeFactor === null ? null : ethers.formatUnits(closeFactor, 18),
      liquidationIncentive: liquidationIncentive === null ? null : ethers.formatUnits(liquidationIncentive, 18),
    });

    for (const t of markets) {
      const marketToken = new ethers.Contract(t, TTOKEN_ABI, provider);
      const [tSymbol, tName, tDecimals, market, mintPaused, borrowPaused, supplyCap, borrowCap, cash, borrows, totalSupply, exchangeRate, oraclePriceRaw] = await Promise.all([
        tryCall(() => marketToken.symbol(), "UNKNOWN"),
        tryCall(() => marketToken.name(), null),
        tryCall(() => marketToken.decimals(), 8),
        core.markets(t),
        tryCall(() => core.mintGuardianPaused(t), null),
        tryCall(() => core.borrowGuardianPaused(t), null),
        tryCall(() => core.supplyCaps(t), null),
        tryCall(() => core.borrowCaps(t), null),
        tryCall(() => marketToken.getCash(), null),
        tryCall(() => marketToken.totalBorrows(), null),
        tryCall(() => marketToken.totalSupply(), null),
        tryCall(() => marketToken.exchangeRateStored(), null),
        tryCall(() => oracle.getUnderlyingPrice(t), null),
      ]);

      let underlyingAddr = await tryCall(() => marketToken.underlying(), null);
      const nativeMarket = !underlyingAddr;
      if (!underlyingAddr) underlyingAddr = NATIVE;
      const underlying = nativeMarket ? null : new ethers.Contract(underlyingAddr, ERC20_ABI, provider);
      const [uSymbol, uName, uDecimals, feedAddr] = await Promise.all([
        nativeMarket ? "CRO" : tryCall(() => underlying.symbol(), tSymbol.replace(/^t/i, "")),
        nativeMarket ? "Cronos" : tryCall(() => underlying.name(), null),
        nativeMarket ? 18 : tryCall(() => underlying.decimals(), 18),
        tryCall(() => oracle.tTokenToOracle(t), null),
      ]);
      const oraclePriceUsd = oraclePriceRaw === null ? null : compoundOracleUsd(oraclePriceRaw, uDecimals);
      const [feed, dex] = await Promise.all([
        readFeedInfo(provider, feedAddr, block),
        dexScreenerPrice(underlyingAddr),
      ]);
      const cashTok = cash === null ? null : numUnits(cash, uDecimals);
      const borrowsTok = borrows === null ? null : numUnits(borrows, uDecimals);
      const refPrice = dex?.priceUsd || oraclePriceUsd;
      const marketOut = classifyMarket({
        pool: poolInfo.pool,
        socket: poolInfo.socket,
        oracle: oracleAddr,
        tToken: t,
        tSymbol,
        tName,
        tDecimals: Number(tDecimals),
        underlying: underlyingAddr,
        underlyingSymbol: uSymbol,
        underlyingName: uName,
        underlyingDecimals: Number(uDecimals),
        isListed: Boolean(market[0]),
        collateralFactor: Number(ethers.formatUnits(market[1], 18)),
        mintPaused,
        borrowPaused,
        supplyCapRaw: supplyCap === null ? null : supplyCap.toString(),
        borrowCapRaw: borrowCap === null ? null : borrowCap.toString(),
        cashRaw: cash === null ? null : cash.toString(),
        cash: cash === null ? null : fmtUnits(cash, uDecimals),
        cashUsd: cashTok !== null && refPrice !== null ? cashTok * refPrice : null,
        totalBorrowsRaw: borrows === null ? null : borrows.toString(),
        totalBorrows: borrows === null ? null : fmtUnits(borrows, uDecimals),
        totalBorrowsUsd: borrowsTok !== null && refPrice !== null ? borrowsTok * refPrice : null,
        totalSupplyRaw: totalSupply === null ? null : totalSupply.toString(),
        exchangeRateRaw: exchangeRate === null ? null : exchangeRate.toString(),
        oraclePriceRaw: oraclePriceRaw === null ? null : oraclePriceRaw.toString(),
        oraclePriceUsd,
        feed,
        dex,
        oracleVsDexPct: null,
        flags: [],
        actionable: false,
      });
      outMarkets.push(marketOut);
    }
  }

  outMarkets.sort((a, b) => Number(b.cashUsd || 0) - Number(a.cashUsd || 0));
  const actionable = outMarkets.filter((m) => m.actionable);
  const stale = outMarkets.filter((m) => m.feed?.ageSeconds !== null && m.feed?.ageSeconds > 1800);
  const divergent = outMarkets.filter((m) => Math.abs(m.oracleVsDexPct || 0) >= 1);
  const out = {
    generatedAt: new Date().toISOString(),
    chainId: CHAIN_ID,
    block: { number: Number(block.number), timestamp: Number(block.timestamp) },
    pools: outPools,
    marketCount: outMarkets.length,
    actionableCount: actionable.length,
    staleFeedCount: stale.length,
    divergentCount: divergent.length,
    markets: outMarkets,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));

  console.log(`Tectonic Cronos scan: pools=${out.pools.length} markets=${out.marketCount} actionable=${out.actionableCount} staleFeeds=${out.staleFeedCount} divergent=${out.divergentCount}`);
  for (const m of outMarkets.slice(0, 12)) {
    const div = m.oracleVsDexPct === null ? "n/a" : `${m.oracleVsDexPct.toFixed(2)}%`;
    const age = m.feed?.ageSeconds === null || m.feed?.ageSeconds === undefined ? "n/a" : `${m.feed.ageSeconds}s`;
    console.log(`${m.pool}:${m.tSymbol}/${m.underlyingSymbol}: cash=$${(m.cashUsd || 0).toFixed(0)} borrows=$${(m.totalBorrowsUsd || 0).toFixed(0)} cf=${(m.collateralFactor * 100).toFixed(1)}% feedAge=${age} oracleVsDex=${div} flags=${m.flags.join(",") || "none"}`);
  }
  console.log(`Report: ${path.relative(WORKSPACE, OUT)}`);
}

main().catch((err) => {
  const message = String(err.message || err).replace(/https?:\/\/[^\s"'<>]+/g, "[redacted-rpc]");
  console.error(`Tectonic Cronos scan failed: ${message}`);
  process.exitCode = 1;
});
