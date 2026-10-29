#!/usr/bin/env node
// Read-only oracle staleness cross-reference scanner.
// Queries live Chainlink feed ages and compares against protocol staleness thresholds.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "oracle-staleness-cross-ref.json");
const QUIET = process.argv.includes("--quiet");

const TIMEOUT_MS = 15_000;

const CHAINLINK_FEED = new ethers.Interface([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
]);

const AAVE_V3_ORACLE = new ethers.Interface([
  "function getSourceOfAsset(address asset) view returns (address)",
]);
const AAVE_V3_ADDRESSES_PROVIDER = new ethers.Interface([
  "function getPriceOracle() view returns (address)",
]);

const KNOWN_FEEDS = {
  "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419": { label: "ETH/USD", symbol: "ETH", chain: "Ethereum" },
  "0xCfE54B5cD566aB89272946F602D76Ea879CAb4a8": { label: "stETH/USD", symbol: "stETH", chain: "Ethereum" },
  "0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6": { label: "USDC/USD", symbol: "USDC", chain: "Ethereum" },
  "0x3E7d1eAB13ad0104d2750B8863b489D65364e32D": { label: "USDT/USD", symbol: "USDT", chain: "Ethereum" },
  "0xAed0c38402a5d19df6E4c03F4E2DceD6e29c1ee9": { label: "DAI/USD", symbol: "DAI", chain: "Ethereum" },
  "0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c": { label: "WBTC/USD", symbol: "WBTC", chain: "Ethereum" },
  "0xE62B71cf983019BFf55bC83B48601ce8419650CC": { label: "wstETH/stETH", symbol: "wstETH/stETH", chain: "Ethereum" },
};

const FILES = {
  aaveV4Hubs: path.join(WORKSPACE, "reports", "raw", "fast", "aave-v4-hubs.json"),
  aaveV4Borrowers: path.join(WORKSPACE, "reports", "raw", "fast", "aave-v4-spoke-borrowers.json"),
  consumerFirstHighLtv: path.join(WORKSPACE, "reports", "raw", "fast", "consumer-first-high-ltv-collateral.json"),
};

const CHAINLINK_HEARTBEAT = 86400; // 24h

function readJson(file, fallback = null) {
  try { if (!fs.existsSync(file)) return fallback; return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return fallback; }
}
function asNumber(v) { if (v === null || v === undefined) return null; if (typeof v === "number") return Number.isFinite(v) ? v : null; const n = Number(String(v).replace(/[$,%\s,]/g, "")); return Number.isFinite(n) ? n : null; }
function round(v, d = 2) { const n = asNumber(v); if (n === null) return null; return Math.round(n * 10 ** d) / 10 ** d; }
function lowerAddress(v) { const t = String(v || "").trim(); return /^0x[0-9a-fA-F]{40}$/.test(t) ? t.toLowerCase() : null; }

function loadRpcUrls() { if (!fs.existsSync(RPC_FILE)) return []; return [...fs.readFileSync(RPC_FILE, "utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map(m => m[0]); }
async function rpcCall(url, method, params = [], timeoutMs = TIMEOUT_MS) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try { const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: ctrl.signal }); const j = await r.json(); if (j.error) throw new Error(j.error.message || JSON.stringify(j.error)); return j.result ?? null; } finally { clearTimeout(t); }
}
async function resolveRpcPool(chainIds) { const p = {}; for (const u of loadRpcUrls()) { try { const h = await rpcCall(u, "eth_chainId", [], 6000); const c = Number(BigInt(h)); if (chainIds.includes(c) && !p[c]) p[c] = u; } catch (_) {} } return p; }

function extractFeedAddresses(aaveV4Hubs) {
  const feeds = new Map();
  const spokes = Array.isArray(aaveV4Hubs?.hubs) ? aaveV4Hubs.hubs.flatMap(h => h?.spokes || []) : [];
  for (const spoke of spokes) {
    const reserves = spoke?.reserves || spoke?.assets || [];
    for (const r of reserves) {
      const source = r?.oracleData?.source;
      const symbol = r?.symbol;
      const address = r?.address || r?.assetAddress;
      if (source && source !== "0x0000000000000000000000000000000000000000") {
        const key = source.toLowerCase();
        if (!feeds.has(key)) feeds.set(key, { feed: source, symbols: new Set(), assets: new Set(), protocols: new Set(["Aave V4"]) });
        const entry = feeds.get(key);
        if (symbol) entry.symbols.add(symbol);
        if (address) entry.assets.add(address);
      }
    }
  }
  return feeds;
}

async function queryFeed(provider, feedAddr) {
  try {
    const [rawRound, rawDec, rawDesc] = await Promise.all([
      provider.call({ to: feedAddr, data: CHAINLINK_FEED.encodeFunctionData("latestRoundData", []) }),
      provider.call({ to: feedAddr, data: CHAINLINK_FEED.encodeFunctionData("decimals", []) }).catch(() => null),
      provider.call({ to: feedAddr, data: CHAINLINK_FEED.encodeFunctionData("description", []) }).catch(() => null),
    ]);
    if (!rawRound || rawRound === "0x") return null;
    const decoded = CHAINLINK_FEED.decodeFunctionResult("latestRoundData", rawRound);
    const decimals = rawDec ? Number(BigInt(rawDec)) : 8;
    const description = rawDesc ? String(CHAINLINK_FEED.decodeFunctionResult("description", rawDesc)[0]) : null;
    return {
      roundId: decoded[0].toString(),
      answer: Number(ethers.formatUnits(decoded[1], decimals)),
      startedAt: Number(decoded[2]),
      updatedAt: Number(decoded[3]),
      answeredInRound: decoded[4].toString(),
      decimals,
      description,
    };
  } catch (_) { return null; }
}

async function main() {
  const aaveV4 = readJson(FILES.aaveV4Hubs, {});
  const rpcs = await resolveRpcPool([1]);
  const rpcUrl = rpcs[1];
  if (!rpcUrl) { console.log("No Ethereum RPC"); return; }
  const provider = new ethers.JsonRpcProvider(rpcUrl, 1, { staticNetwork: true });

  const block = await provider.getBlock("latest");
  const blockTimestamp = block.timestamp;
  const blockNumber = block.number;

  const aaveFeeds = extractFeedAddresses(aaveV4);
  const uniqueFeeds = new Map();

  for (const [addr, info] of aaveFeeds) uniqueFeeds.set(addr, info);
  for (const [addr, info] of Object.entries(KNOWN_FEEDS)) {
    const key = addr.toLowerCase();
    if (!uniqueFeeds.has(key)) uniqueFeeds.set(key, { feed: addr, symbols: new Set([info.symbol]), assets: new Set(), protocols: new Set(["known-feed-list"]) });
    else {
      uniqueFeeds.get(key).symbols.add(info.symbol);
      uniqueFeeds.get(key).protocols.add("known-feed-list");
    }
  }

  const results = [];
  for (const [addr, info] of uniqueFeeds) {
    const feed = await queryFeed(provider, addr);
    if (!feed) {
      results.push({ feed: addr, protocols: [...info.protocols], symbols: [...info.symbols], assets: [...info.assets], error: "no-result", age: null });
      continue;
    }
    const age = blockTimestamp - feed.updatedAt;
    const agePct = CHAINLINK_HEARTBEAT > 0 ? (age / CHAINLINK_HEARTBEAT) * 100 : null;
    const exceeded = age > CHAINLINK_HEARTBEAT;

    results.push({
      feed: addr,
      description: feed.description || info.label || null,
      protocols: [...info.protocols],
      symbols: [...info.symbols],
      assets: [...info.assets],
      price: round(feed.answer, 4),
      decimals: feed.decimals,
      updatedAt: feed.updatedAt,
      age,
      ageHours: round(age / 3600, 2),
      heartbeatSeconds: CHAINLINK_HEARTBEAT,
      heartbeatExceeded: exceeded,
      agePctOfHeartbeat: round(agePct, 2),
      answeredInRound: feed.answeredInRound,
      roundId: feed.roundId,
    });
  }

  results.sort((a, b) => (b.age || 0) - (a.age || 0));

  const nearHeartbeat = results.filter(r => r.age && r.age > CHAINLINK_HEARTBEAT * 0.75 && !r.heartbeatExceeded);
  const exceededHeartbeat = results.filter(r => r.heartbeatExceeded);

  const realProtocolExceeded = exceededHeartbeat.filter(r => r.protocols && r.protocols.some(p => p !== "known-feed-list"));
  const hasRealProtocolStaleness = realProtocolExceeded.length > 0;

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-oracle-staleness-cross-ref.js",
    scope: "Read-only Chainlink feed staleness cross-reference for protocol oracle sources",
    safety: { rpcInventoryRead: true, rpcUrlsStored: false, signedActions: false, exploitExecuteCalls: false, routePositive: false, signedActionJustified: false },
    chain: { id: 1, name: "Ethereum", blockNumber, blockTimestamp },
    chainlinkHeartbeat: CHAINLINK_HEARTBEAT,
    summary: {
      feedsQueried: results.length,
      feedsWithResult: results.filter(r => r.price !== null).length,
      feedsWithError: results.filter(r => r.error).length,
      highestAgeSeconds: results[0]?.age || 0,
      highestAgeFeed: results[0]?.description || null,
      nearHeartbeat: nearHeartbeat.length,
      exceededHeartbeat: exceededHeartbeat.length,
      realProtocolExceeded: realProtocolExceeded.length,
      exceededFeedSymbols: exceededHeartbeat.flatMap(r => r.symbols),
      routePositive: 0,
      signedActionJustified: false,
      closedReason: hasRealProtocolStaleness ? "Feed(s) exceeded Chainlink heartbeat on protocol-mapped reserves; needs fork-proof economics" : exceededHeartbeat.length ? "Feed(s) exceeded heartbeat but not mapped to any real protocol market (known-feed-list only)" : nearHeartbeat.length ? "Feed(s) approaching heartbeat but not exceeded; protocol thresholds still satisfied" : "All feeds within Chainlink heartbeat",
    },
    results: results.slice(0, 100),
    nearHeartbeat: nearHeartbeat.slice(0, 20),
    exceededHeartbeat,
    requiredForRoutePositive: ["Feed age exceeds both Chainlink heartbeat AND protocol-specific staleness threshold", "market has material borrow liquidity at the stale price", "borrow capacity exceeds gas/slippage", "fork extraction proof"],
    nextReadOnlyStep: exceededHeartbeat.length ? "Cross-reference exceeded feeds against protocol-specific maxStalePeriod configs; fork-proof only if age exceeds the protocol's own threshold." : "Refresh when feeds approach/exceed heartbeat.",
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2) + "\n");
  if (!QUIET) {
    console.log(`Oracle staleness: feeds=${results.length} highest=${results[0]?.description}@${results[0]?.ageHours}h nearHeartbeat=${nearHeartbeat.length} exceeded=${exceededHeartbeat.length}`);
    for (const r of results.slice(0, 6)) console.log(`  ${r.description || r.feed} age=${r.ageHours}h heartbeatExceeded=${r.heartbeatExceeded}`);
  }
}

main().catch(e => { console.error(e?.message || String(e)); process.exit(1); });
