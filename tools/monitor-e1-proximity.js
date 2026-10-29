#!/usr/bin/env node
// monitor-e1-proximity.js — Read-only E1 Compound stale-oracle proximity checker.
// Queries Chainlink ETH/USD feed age and market price every 60s.
// Writes reports/monitor/e1-proximity.json with live status.
// Integrates with autopilot launcher for continuous monitoring.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "monitor", "e1-proximity.json");
const LOG = path.join(WORKSPACE, "reports", "monitor", "e1-proximity-log.jsonl");

const WATCH = process.argv.includes("--watch");
const ONCE = process.argv.includes("--once") || !WATCH;
const INTERVAL_MS = Number(process.env.E1_PROXIMITY_INTERVAL_MS || "60000");
const QUIET = process.argv.includes("--quiet");

// E1 thresholds
const E1_MIN_FEED_AGE_SECONDS = 1800;
const E1_MIN_DIVERGENCE_PERCENT = 5.0;
const E1_CONTRACT = "0xe1797A807A5dBf774dBD149e844B18C922E695Eb";
const E1_ROUTE = "cwethv3-wsteth-capo";

// Chainlink ETH/USD feed on Ethereum mainnet
const FEED = "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419";

const CHAINLINK = new ethers.Interface([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
]);

async function fetchJson(url, timeoutMs = 15_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { "user-agent": "evm-audit-e1-proximity/1.0" }, signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) { return null; } finally { clearTimeout(t); }
}

function logPrint(msg) {
  if (!QUIET) console.log(`[E1-proximity] ${msg}`);
}

function proximity(feedAge, targetAge) {
  if (feedAge >= targetAge) return 100;
  return Math.min(100, Math.max(0, (feedAge / targetAge) * 100));
}

async function checkProximity() {
  const rpc = await resolveRpc(1);
  if (!rpc) throw new Error("Ethereum RPC unavailable");

  const provider = new ethers.JsonRpcProvider(rpc, 1, { staticNetwork: true });

  // 1. Query Chainlink feed + market price
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  
  let feedRaw = null, marketPrices = null, blockTimestamp = Math.floor(Date.now() / 1000);
  
  try {
    feedRaw = await provider.call({ to: FEED, data: CHAINLINK.encodeFunctionData("latestRoundData") });
  } catch (e) {
    logPrint(`Chainlink feed RPC error: ${e.message?.slice(0, 80)}`);
  }
  
  try {
    marketPrices = await fetchJson("https://coins.llama.fi/prices/current/coingecko:ethereum?searchWidth=4h");
  } catch (e) {
    logPrint(`Market price API error: ${e.message?.slice(0, 80)}`);
  }
  
  try {
    const block = await provider.getBlock("latest");
    blockTimestamp = block.timestamp;
  } catch (e) {
    logPrint(`Block fetch error: ${e.message?.slice(0, 80)}`);
  }
  
  clearTimeout(timeout);

  if (!feedRaw || feedRaw === "0x" || feedRaw.length < 130) {
    return { error: "Chainlink feed unavailable", feedAgeSeconds: null, chainlinkPrice: null, marketPrice: null, feedAgeProximity: 0, divergenceProximity: 0, overallProximity: 0, triggered: false, executableNow: false };
  }

  const decoded = CHAINLINK.decodeFunctionResult("latestRoundData", feedRaw);
  const chainlinkPrice = Number(decoded[1]) / 1e8; // 8 decimals
  const updatedAt = Number(decoded[3]);
  const feedAge = Math.max(0, blockTimestamp - updatedAt);

  // 2. Market price from DeFiLlama
  const marketPrice = marketPrices?.coins?.["coingecko:ethereum"]?.price;
  const marketTimestamp = marketPrices?.coins?.["coingecko:ethereum"]?.timestamp;

  // 3. Compute divergence
  const divergence = marketPrice ? Math.abs(chainlinkPrice - marketPrice) / marketPrice * 100 : 0;
  const chainlinkHigher = marketPrice ? chainlinkPrice > marketPrice : false;

  // 4. Compute proximity scores
  const feedAgeProximity = proximity(feedAge, E1_MIN_FEED_AGE_SECONDS);
  const divergenceProximity = proximity(divergence, E1_MIN_DIVERGENCE_PERCENT);
  const overallProximity = (feedAgeProximity + divergenceProximity * 2) / 3; // divergence weighted 2x (harder condition)
  const triggered = feedAge >= E1_MIN_FEED_AGE_SECONDS && divergence >= E1_MIN_DIVERGENCE_PERCENT;

  const result = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/monitor-e1-proximity.js",
    scope: "E1 Compound stale-oracle proximity check (read-only)",
    contract: E1_CONTRACT,
    route: E1_ROUTE,
    chainlinkFeed: FEED,
    chainlink: {
      price: parseFloat(chainlinkPrice.toFixed(2)),
      updatedAt: new Date(updatedAt * 1000).toISOString(),
      decimals: 8,
    },
    market: {
      price: marketPrice ? parseFloat(marketPrice.toFixed(2)) : null,
      source: "coingecko:ethereum (via DeFiLlama)",
      timestamp: marketTimestamp ? new Date(marketTimestamp * 1000).toISOString() : null,
    },
    block: {
      timestamp: blockTimestamp,
    },
    metrics: {
      feedAgeSeconds: feedAge,
      feedAgeMinutes: (feedAge / 60).toFixed(1),
      divergencePercent: parseFloat(divergence.toFixed(4)),
      chainlinkHigher,
      feedAgeProximity: parseFloat(feedAgeProximity.toFixed(1)),
      divergenceProximity: parseFloat(divergenceProximity.toFixed(1)),
      overallProximity: parseFloat(overallProximity.toFixed(1)),
    },
    gates: {
      feedAgeThreshold: E1_MIN_FEED_AGE_SECONDS,
      feedAgeExceeded: feedAge >= E1_MIN_FEED_AGE_SECONDS,
      divergenceThreshold: E1_MIN_DIVERGENCE_PERCENT,
      divergenceExceeded: divergence >= E1_MIN_DIVERGENCE_PERCENT,
      triggered,
      executableNow: false, // E1 requires specific CAPO route spread, not just generic staleness
    },
    statusLevel: triggered ? "TRIGGERED" : (overallProximity > 75 ? "WARNING" : (overallProximity > 50 ? "ELEVATED" : "NOMINAL")),
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2) + "\n");

  // Append log entry
  const logEntry = {
    ts: result.generatedAt,
    feedAge: feedAge,
    divergence: parseFloat(divergence.toFixed(4)),
    proximity: parseFloat(overallProximity.toFixed(1)),
    triggered,
  };
  fs.appendFileSync(LOG, JSON.stringify(logEntry) + "\n");

  return result;
}

async function main() {
  logPrint(`Starting E1 Compound stale-oracle proximity monitor`);
  logPrint(`  Chainlink feed: ${FEED}`);
  logPrint(`  E1 contract: ${E1_CONTRACT}`);
  logPrint(`  Thresholds: feedAge>=${E1_MIN_FEED_AGE_SECONDS}s, divergence>=${E1_MIN_DIVERGENCE_PERCENT}%`);
  logPrint(`  Mode: ${WATCH ? 'watch (interval='+INTERVAL_MS+'ms)' : 'once'}`);
  logPrint(`  Output: ${path.relative(WORKSPACE, OUT)}`);

  let cycle = 0;
  async function runCycle() {
    cycle++;
    try {
      const result = await checkProximity();
      const status = result.statusLevel || 'ERROR';
      const emoji = status === 'TRIGGERED' ? '🔴' : status === 'WARNING' ? '🟡' : status === 'ELEVATED' ? '🟠' : '🟢';

      if (result.metrics) {
        logPrint(`${emoji} Cycle ${cycle} | status=${status} | feedAge=${result.metrics.feedAgeSeconds}s(${result.metrics.feedAgeMinutes}min) | divergence=${result.metrics.divergencePercent}% | proximity=${result.metrics.overallProximity}%`);

        if (result.gates.feedAgeExceeded && !result.gates.divergenceExceeded) {
          logPrint(`  ⚠ FEED STALE (${result.metrics.feedAgeSeconds}s > ${E1_MIN_FEED_AGE_SECONDS}s) but no divergence (${result.metrics.divergencePercent}% < ${E1_MIN_DIVERGENCE_PERCENT}%)`);
        }
        if (result.gates.triggered) {
          logPrint(`  🔴 TRIGGERED! E1 Compound stale-oracle conditions MET`);
          logPrint(`  Contract: ${E1_CONTRACT}`);
        }
      }
    } catch (err) {
      logPrint(`❌ Cycle ${cycle} error: ${err.message?.slice(0, 120)}`);
    }
  }

  await runCycle();

  if (WATCH) {
    setInterval(runCycle, INTERVAL_MS);
    logPrint(`Watching every ${INTERVAL_MS}ms. Press Ctrl+C to stop.`);
  }
}

main().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});