#!/usr/bin/env node
// monitor-oracle-staleness-router.js — Block 2: Oracle Staleness Router
// Maps Chainlink feeds → protocol consumers → auto-routes to execute contracts
// Expands from 5 ETH/USD feeds to all lending-critical feeds across chains

const fs = require("fs"); const path = require("path");
const { rpcCall, resolveRpc } = require("./shared-rpc");
const ethers = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const NOW = () => Math.floor(Date.now() / 1000);

// ─── Feed Registry: Chainlink feed → protocol → chain configuration ───

const FEED_REGISTRY = {
  // ETH/USD — the most critical feed, consumed by virtually all lending
  "ETH/USD": {
    feeds: {
      1: "0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419",
      8453: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
      42161: "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612",
      10: "0x13e3Ee699D1909E989722E753853AE30b17e08c5",
      137: "0xF9680D99D6C9589e2a93a78A04A279e509205945",
    },
    consumers: {
      "Aave V3": { chains: [1, 8453, 42161, 10, 137], contract: "E10", pool: {1:"0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",8453:"0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",42161:"0x794a61358D6845594F94dc1DB02A252b5b4814aD",10:"0x794a61358D6845594F94dc1DB02A252b5b4814aD",137:"0x794a61358D6845594F94dc1DB02A252b5b4814aD"} },
      "Compound V3": { chains: [1], contract: "E1", comet: {1:"0xc3d688B66703497DAA19211EEdff47f25384cdc3"} },
      "Morpho Blue": { chains: [1, 8453, 42161, 10], contract: "E9", morpho: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb" },
      "Fluid": { chains: [1], contract: "E8", vault: {1:"0x1982CC7b1570C2503282d0A0B41F69b3B28fdcc3"} },
    }
  },
  // stETH/ETH — used for LST collateral pricing
  "stETH/ETH": {
    feeds: {
      1: "0x86392dC19c0b719886221c78AB11eb8Cf5c52812",
      8453: "0x4e3c2c2F2A8F6eE7b8b6f6A8f6E7b8b6f6A8f6E7", // placeholder - may differ
    },
    consumers: {
      "Aave V3": { chains: [1], contract: "E10" },
      "Morpho Blue": { chains: [1, 8453], contract: "E9" },
    }
  },
  // WBTC/USD — second most common collateral
  "WBTC/USD": {
    feeds: {
      1: "0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c",
      42161: "0x6ce185860a4963106506C203335A2910413708e9",
    },
    consumers: {
      "Aave V3": { chains: [1, 42161], contract: "E10" },
      "Morpho Blue": { chains: [1, 42161], contract: "E9" },
    }
  },
};

const ROUTE_TABLE = {
  E1: { chain: 1, addr: "0xe1797A807A5dBf774dBD149e844B18C922E695Eb", action: "Aave V3 liquidation" },
  E5: { chain: 1, addr: "0x81F2FCF80ADecd464d88AD01Aa3Afe3D7919E583", action: "Fluid depeg" },
  E8: { chain: 1, addr: "0xb795fEB4d24d4Da7C55D6343aaC988b940d948E8", action: "Fluid stale oracle" },
  E9: { chain: 1, addr: "0x2cd636ccee97243688ddaa4b1f93b13f60d3a00f", action: "Morpho liquidation" },
  E10: { chain: [8453, 42161, 10, 137],
    addrs: {8453:"0x4C8bDB2Bcdd7eAF55c2cd1dEb76c8b4174baC31F",42161:"0x08500266c4F40Ed80DEda53cD71204b8965541aE",10:"0x08500266c4F40Ed80DEda53cD71204b8965541aE",137:"0xF9EBbDd6715C7fb53aA7ADe99d20A898FC95E178"},
    action: "Cross-chain Aave stale oracle" },
};

function ts() { return new Date().toISOString(); }
function log(msg) { console.log(`[${ts()}] ${msg}`); }

// ─── Core: Check feed staleness → find consumers → route to executor ───

async function scanFeed(rpcPool, feedName, feedCfg) {
  const alerts = [];
  
  for (const [cid, feedAddr] of Object.entries(feedCfg.feeds)) {
    const chainId = parseInt(cid);
    const rpc = rpcPool[chainId] || await resolveRpc(chainId);
    if (!rpc) continue;
    
    // Read feed age
    const raw = await rpcCall(rpc, "eth_call", [{ to: feedAddr, data: "0xfeaf968c" }, "latest"], 8000);
    if (!raw || raw.length < 258) continue;
    const answer = Number(BigInt("0x"+raw.slice(2+64, 2+128))) / 1e8;
    const updatedAt = Number(BigInt("0x"+raw.slice(2+192, 2+256)));
    const age = NOW() - updatedAt;
    
    // Determine heartbeat thresholds
    const heartbeat = feedName.includes("ETH/USD") ? 3600 : // 1h for major FX/crypto
                       feedName.includes("WBTC") ? 3600 : 
                       86400; // 24h for stablecoin feeds
    
    const stalenessRatio = age / heartbeat;
    
    // Alert: feed is stale (>1.5x heartbeat)
    if (stalenessRatio > 1.5) {
      log(`${feedName} on chain ${chainId}: ${(age/3600).toFixed(1)}h stale (${stalenessRatio.toFixed(1)}x heartbeat) — routing to consumers...`);
      
      // Find consumers on this chain that use this feed
      for (const [protoName, protoCfg] of Object.entries(feedCfg.consumers)) {
        if (!protoCfg.chains.includes(chainId)) continue;
        
        const contractId = protoCfg.contract;
        const route = ROUTE_TABLE[contractId];
        if (!route) continue;
        
        const executorAddr = Array.isArray(route.addrs) ? route.addrs[chainId] : route.addr;
        
        alerts.push({
          feed: feedName,
          chain: chainId,
          age,
          stalenessRatio: stalenessRatio.toFixed(1),
          price: answer,
          protocol: protoName,
          contract: contractId,
          executorAddr,
          action: route.action,
          severity: stalenessRatio > 5 ? "CRITICAL" : "HIGH",
          message: `${feedName} ${stalenessRatio.toFixed(1)}x over heartbeat on chain ${chainId}. Protocol ${protoName} may accept stale price. Route to ${contractId} (${executorAddr.slice(0,10)}...)`,
        });
      }
    }
  }
  
  return alerts;
}

// ─── Main ───

async function main() {
  console.log("=== Oracle Staleness Router ===\n");
  console.log(`Feeds monitored: ${Object.keys(FEED_REGISTRY).join(", ")}`);
  console.log(`Consumers: ${[...new Set(Object.values(FEED_REGISTRY).flatMap(f => Object.keys(f.consumers)))].join(", ")}`);
  console.log(`Chains: ${[...new Set(Object.values(FEED_REGISTRY).flatMap(f => Object.keys(f.feeds)))].join(", ")}\n`);
  
  const rpcPool = {};
  let allAlerts = [];
  
  for (const [feedName, feedCfg] of Object.entries(FEED_REGISTRY)) {
    const alerts = await scanFeed(rpcPool, feedName, feedCfg);
    allAlerts.push(...alerts);
  }
  
  // Summary
  if (allAlerts.length === 0) {
    log("All feeds fresh across all chains. No stale oracle windows detected.");
  } else {
    console.log(`\n=== ${allAlerts.length} ALERTS ===`);
    for (const a of allAlerts) {
      console.log(`${a.severity.padEnd(10)} ${a.feed.padEnd(12)} chain=${a.chain} proto=${a.protocol} → ${a.contract} (${a.executorAddr.slice(0,10)}...)`);
      console.log(`  ${a.message}`);
    }
    
    log("\nActionable alerts would trigger auto-execution via the monitor pipeline.");
  }
  
  // Autopilot: wire into the existing E44-style evaluator
  const outPath = path.join(WORKSPACE, "reports", "monitor", "staleness-router.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ scannedAt: ts(), alerts: allAlerts, feeds: Object.keys(FEED_REGISTRY).length }, null, 2));
  log(`Artifact: ${outPath}`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
