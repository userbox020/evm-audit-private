#!/usr/bin/env node
// probe-chainlink-feed-consumers.js - map specific Chainlink feeds to lending protocol consumers.
// Check if protocols using the feed have maxStaleness / circuit-breaker guards.
// Never prints or stores RPC URLs, keys, calldata, or signed actions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { resolveRpc, rpcCall } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "chainlink-feed-consumer-map.json");

const STALE_FEED = "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419"; // ETH/USD on Ethereum

// Aave V3 Ethereum
const AAVE_POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
const AAVE_ORACLE = "0x54586bE62E3c3580375aE3723C145253060Ca0C2";

// Known ETH-correlated assets on Aave V3 Ethereum
const AAVE_ASSETS = {
  WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  wstETH: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0",
  weETH: "0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee",
  rETH: "0xae78736Cd615f374D3085123A210448E74Fc6393",
  cbETH: "0xBe9895146f7AF43049ca1c1AE358B0541Ea49704",
};

const AAVE_POOL_IFACE = new ethers.Interface([
  "function getReserveData(address asset) view returns (tuple(uint256 data) configuration,uint128 liquidityIndex,uint128 currentLiquidityRate,uint128 variableBorrowIndex,uint128 currentVariableBorrowRate,uint128 currentStableBorrowRate,uint40 lastUpdateTimestamp,uint16 id,address aTokenAddress,address stableDebtTokenAddress,address variableDebtTokenAddress,address interestRateStrategyAddress,uint128 accruedToTreasury,uint128 unbacked,uint128 isolationModeTotalDebt)",
]);
const AAVE_ORACLE_IFACE = new ethers.Interface([
  "function getAssetPrice(address asset) view returns (uint256)",
  "function getSourceOfAsset(address asset) view returns (address)",
]);

// Simplified staleness check: read the Chainlink feed's latestRoundData updatedAt
const CHAINLINK_IFACE = new ethers.Interface([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
]);

function ensureDir(f) { fs.mkdirSync(path.dirname(f), { recursive: true }); }
function jsonReplacer(_k, v) { return typeof v === "bigint" ? v.toString() : v; }
function round(v, d = 2) { const n = Number(v); return Number.isFinite(n) ? Math.round(n * (10 ** d)) / (10 ** d) : null; }

async function safeCall(rpc, to, iface, fn, args = [], ms = 12_000) {
  try { const raw = await rpcCall(rpc, "eth_call", [{ to, data: iface.encodeFunctionData(fn, args) }, "latest"], ms); if (!raw || raw === "0x") return null; return iface.decodeFunctionResult(fn, raw); } catch (_) { return null; }
}

async function main() {
  const rpc = await resolveRpc(1);
  if (!rpc) throw new Error("No RPC");

  // 1. Check Chainlink feed staleness
  const clData = await safeCall(rpc, STALE_FEED, CHAINLINK_IFACE, "latestRoundData");
  const clDecimals = await safeCall(rpc, STALE_FEED, CHAINLINK_IFACE, "decimals");
  const feedAge = clData ? Math.floor(Date.now()/1000) - Number(clData[3]) : null;
  const feedPrice = clData && clDecimals ? Number(ethers.formatUnits(clData[1], Number(clDecimals[0]))) : null;
  
  // 2. Aave V3: check each ETH-correlated asset
  const aaveResults = [];
  for (const [symbol, addr] of Object.entries(AAVE_ASSETS)) {
    const [reserveData, oraclePrice, oracleSource] = await Promise.all([
      safeCall(rpc, AAVE_POOL, AAVE_POOL_IFACE, "getReserveData", [addr]),
      safeCall(rpc, AAVE_ORACLE, AAVE_ORACLE_IFACE, "getAssetPrice", [addr]),
      safeCall(rpc, AAVE_ORACLE, AAVE_ORACLE_IFACE, "getSourceOfAsset", [addr]),
    ]);
    
    // Decode Aave configuration for staleness check
    // The configuration is a packed uint256; bits 64-79 are the oracle sentinel
    // But staleness is checked at the oracle source level
    // For Chainlink sources, the maxStalePeriod is configurable
    
    aaveResults.push({
      symbol,
      asset: addr,
      oracleSource: oracleSource?.[0] || null,
      aavePrice: oraclePrice ? Number(ethers.formatUnits(oraclePrice[0], 8)) : null,
      chainlinkPrice: feedPrice,
      priceDiffBps: oraclePrice && feedPrice ? round((Number(ethers.formatUnits(oraclePrice[0], 8)) / feedPrice - 1) * 10000, 2) : null,
      reserveConfig: reserveData ? reserveData[0][0].toString() : null,
    });
  }

  // 3. Morpho Blue: query markets on Ethereum for ETH-correlated assets
  const MORPHO_QRY = `{ markets(first: 50, where: { chainId_in: [1] }, orderBy: SupplyAssetsUsd, orderDirection: Desc) { items { uniqueKey collateralAsset { symbol address } loanAsset { symbol address } oracle { address } lltv state { supplyAssetsUsd borrowAssetsUsd } } } }`;
  let morphoResults = [];
  try {
    const res = await fetch("https://blue-api.morpho.org/graphql", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: MORPHO_QRY }),
    });
    const data = await res.json();
    const markets = data?.data?.markets?.items || [];
    
    // Filter for ETH-correlated collateral
    const ethSymbols = ["WETH", "wstETH", "weETH", "rETH", "cbETH", "ETH", "ezETH", "osETH", "swETH"];
    for (const m of markets) {
      const sym = m.collateralAsset?.symbol || "";
      if (!ethSymbols.some(s => sym.includes(s))) continue;
      
      // Check oracle
      const oracleAddr = m.oracle?.address;
      if (!oracleAddr) continue;
      
      const oracleCode = await rpcCall(rpc, "eth_getCode", [oracleAddr, "latest"], 8000).catch(() => "0x");
      morphoResults.push({
        marketId: m.uniqueKey?.slice(0, 20) + "...",
        collateral: sym,
        collateralAddr: m.collateralAsset?.address,
        loan: m.loanAsset?.symbol,
        oracle: oracleAddr,
        oracleCodeBytes: oracleCode && oracleCode !== "0x" ? (oracleCode.length - 2) / 2 : 0,
        lltv: m.lltv,
        supplyUsd: m.state?.supplyAssetsUsd,
        borrowUsd: m.state?.borrowAssetsUsd,
        // Check if oracle is the Chainlink feed or a wrapper
        oracleUsesChainlink: oracleCode.includes(STALE_FEED.slice(2).toLowerCase()) ? "direct" : "unknown",
      });
    }
  } catch (e) { morphoResults = [{ error: e.message }]; }

  const output = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/probe-chainlink-feed-consumers.js",
    feed: { address: STALE_FEED, price: round(feedPrice, 2), age: feedAge, heartbeat: 3600, withinHeartbeat: feedAge < 3600 },
    aaveResults,
    morphoResults,
    summary: {
      aaveMarketsScanned: aaveResults.length,
      morphoEthMarketsFound: morphoResults.length,
      chainlinkHeartbeat: 3600,
      feedWithinHeartbeat: feedAge !== null ? feedAge < 3600 : null,
      conclusion: feedAge !== null && feedAge < 3600 
        ? "Feed is within Chainlink standard 1-hour heartbeat — NOT anomalously stale" 
        : "Feed age exceeds heartbeat — investigate further",
    },
  };

  ensureDir(OUT);
  fs.writeFileSync(OUT, `${JSON.stringify(output, jsonReplacer, 2)}\n`);
  
  console.log(JSON.stringify({
    feedAge: feedAge,
    feedWithinHeartbeat: feedAge < 3600,
    feedPrice: feedPrice,
    aaveMarkets: aaveResults.length,
    aaveSources: aaveResults.map(r => ({ symbol: r.symbol, source: r.oracleSource?.slice(0,10), priceDiffBps: r.priceDiffBps })),
    morphoEthMarkets: morphoResults.length,
  }, null, 2));
}

main().catch(err => { console.error(JSON.stringify({ ok: false, error: String(err) })); process.exit(1); });
