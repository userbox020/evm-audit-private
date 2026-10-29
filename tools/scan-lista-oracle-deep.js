#!/usr/bin/env node
// scan-lista-oracle-deep.js — Lista Lending P0 Live Oracle Recon (BSC)
// Read-only. Checks the 8 critical oracle surfaces from the attack plan.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { rpcCall, resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "lista-oracle-deep.json");
const BSC_CHAIN_ID = 56;
const TIMEOUT = 15_000;

async function mc(contract, method, ...args) {
  try { return await contract[method](...args, { blockTag: "latest" }); } catch (_) { return null; }
}

// ---- ABIs ----
const RESILIENT_ORACLE_ABI = [
  "function getOracle(address asset, uint8 role) view returns (address oracle, bool enabled)",
  "function getTokenConfig(address asset) view returns (tuple(address asset, address[3] oracles, bool[3] enableFlagsForOracles))",
  "function getPrice(address asset) view returns (uint256)",
  "function accessControlManager() view returns (address)",
  "function boundValidator() view returns (address)",
];

const CHAINLINK_ORACLE_ABI = [
  "function tokenConfigs(address asset) view returns (address feed, uint24 maxStalePeriod)",
  "function getPrice(address asset) view returns (uint256)",
];

const BINANCE_ORACLE_ABI = [
  "function maxStalePeriod(string symbol) view returns (uint256)",
  "function getPrice(string symbol) view returns (uint256)",
];

const CHAINLINK_FEED_ABI = [
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function aggregator() view returns (address)",
  "function description() view returns (string)",
  "function decimals() view returns (uint8)",
];

const BOUND_VALIDATOR_ABI = [
  "function validateConfigs(address asset) view returns (uint256 upperBoundRatio, uint256 lowerBoundRatio)",
];

const MOOLAH_ABI = [
  "function owner() view returns (address)",
  "function markets(address) view returns (bool isListed, bool isSupplyDisabled, bool isBorrowDisabled, uint256 llth, uint256 supplyCap, uint256 borrowCap, uint256 supply, uint256 cash, uint256 totalBorrows)",
  "function getAllMarkets() view returns (address[] memory)",
];

// ---- Assets (BSC) ----
const ASSETS = {
  USDT: "0x55d398326f99059fF775485246999027B3197955",
  WBNB: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
  USDC: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
  slisBNB: "0xB0b84D294e0C75A6abe60171b70edEb2EFd14A1B",
  BTCB: "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c",
};

const ROLE_LABELS = { 0: "MAIN", 1: "PIVOT", 2: "FALLBACK" };

function bps(num, denom) {
  if (!num || !denom || Number(denom) === 0) return null;
  return (((Number(num) - Number(denom)) / Number(denom)) * 10000).toFixed(2);
}

async function main() {
  console.log("Lista P0 Live Oracle Recon — BSC");

  const bscUrl = await resolveRpc(BSC_CHAIN_ID);
  if (!bscUrl) { console.error("No BSC RPC available"); process.exit(1); }
  const provider = new ethers.JsonRpcProvider(bscUrl, BSC_CHAIN_ID, { staticNetwork: true });
  console.log(`BSC RPC: ${bscUrl.slice(0, 45)}...`);

  // ---- Contracts ----
  const resilientOracle = "0xf3afD82A4071f272F403dC176916141f44E6c750";
  const moolah = "0x8F73b65B4caAf64FBA2aF91cC5D4a2A1318E5D8C";
  const ro = new ethers.Contract(resilientOracle, RESILIENT_ORACLE_ABI, provider);
  const mo = new ethers.Contract(moolah, MOOLAH_ABI, provider);

  // ---- P0-0: Permissioned surfaces ----
  console.log("\n=== P0-0: Permissioned ===");
  const owner = await mc(mo, "owner");
  const acm = await mc(ro, "accessControlManager");
  const bvAddr = await mc(ro, "boundValidator");
  console.log(`  Moolah owner:    ${owner}`);
  console.log(`  RO ACM:          ${acm}`);
  console.log(`  BoundValidator:  ${bvAddr}`);

  // Check if Moolah owner is EOA or contract
  if (owner) {
    const code = await provider.getCode(owner);
    console.log(`  Moolah owner type: ${code === "0x" ? "EOA" : `CONTRACT (${code.length} bytes)`}`);
  }

  const boundValidator = bvAddr && bvAddr !== ethers.ZeroAddress
    ? new ethers.Contract(bvAddr, BOUND_VALIDATOR_ABI, provider) : null;

  // ---- P0-1 through P0-6: Per-asset oracle deep dive ----
  const results = {};

  for (const [symbol, asset] of Object.entries(ASSETS)) {
    console.log(`\n=== ${symbol} (${asset}) ===`);
    const r = { symbol, asset };

    // P0-1: Get all 3 oracle roles
    const roles = {};
    for (let role = 0; role <= 2; role++) {
      const oracle = await mc(ro, "getOracle", asset, role);
      if (oracle) {
        roles[ROLE_LABELS[role]] = { address: oracle[0], enabled: oracle[1] };
        console.log(`  ${ROLE_LABELS[role]}: ${oracle[0]} enabled=${oracle[1]}`);
      } else {
        roles[ROLE_LABELS[role]] = { address: null, enabled: false };
        console.log(`  ${ROLE_LABELS[role]}: FAILED`);
      }
    }
    r.roles = roles;

    // P0-1 CHECK: Main == Fallback?
    const mainAddr = roles.MAIN ? roles.MAIN.address : null;
    const fallbackAddr = roles.FALLBACK ? roles.FALLBACK.address : null;
    r.mainEqualsFallback = mainAddr && fallbackAddr && mainAddr.toLowerCase() === fallbackAddr.toLowerCase();
    if (r.mainEqualsFallback) {
      console.log(`  ⚠️ MAIN==FALLBACK: ${mainAddr} — single-oracle collapse when pivot stale/disabled!`);
    }

    // P0-2: Pivot enabled?
    r.pivotEnabled = roles.PIVOT && roles.PIVOT.enabled;
    console.log(`  Pivot enabled: ${r.pivotEnabled}`);

    // P0-3: Pivot freshness (if RedStone, probe feed)
    if (r.pivotEnabled && roles.PIVOT.address) {
      // Try as Chainlink feed
      const pivotFeed = new ethers.Contract(roles.PIVOT.address, CHAINLINK_FEED_ABI, provider);
      const rd = await mc(pivotFeed, "latestRoundData");
      if (rd) {
        const answer = Number(rd[1]) / 1e8;
        const updatedAt = Number(rd[3]);
        const age = Math.floor(Date.now() / 1000) - updatedAt;
        const desc = await mc(pivotFeed, "description");
        r.pivotFeed = { address: roles.PIVOT.address, description: desc || "?", price: answer, updatedAt, age };
        console.log(`  Pivot feed: ${desc || "?"} price=$${answer.toFixed(4)} age=${age}s`);
      } else {
        r.pivotFeed = { error: "Not a Chainlink feed or call failed" };
        console.log(`  Pivot feed: NOT a direct Chainlink feed (may be RedStone adapter or other)`);
      }
    }

    // P0-4: BoundValidator configs
    if (boundValidator) {
      const bvConfig = await mc(boundValidator, "validateConfigs", asset);
      if (bvConfig) {
        r.boundValidator = {
          upperBoundRatio: Number(ethers.formatUnits(bvConfig[0], 18)),
          lowerBoundRatio: Number(ethers.formatUnits(bvConfig[1], 18)),
        };
        console.log(`  BoundValidator: upper=${r.boundValidator.upperBoundRatio}x lower=${r.boundValidator.lowerBoundRatio}x`);
      }
    }

    // P0-5: Per-oracle max stale periods (Chainlink)
    if (mainAddr && mainAddr !== ethers.ZeroAddress) {
      const clo = new ethers.Contract(mainAddr, CHAINLINK_ORACLE_ABI, provider);
      const tc = await mc(clo, "tokenConfigs", asset);
      if (tc) {
        const feedAddr = tc[0];
        const maxStale = Number(tc[1]);
        r.mainMaxStale = { feed: feedAddr, maxStalePeriod: maxStale };
        console.log(`  Main maxStale: ${maxStale}s feed=${feedAddr}`);

        // Also probe the feed directly
        if (feedAddr && feedAddr !== ethers.ZeroAddress) {
          const feed = new ethers.Contract(feedAddr, CHAINLINK_FEED_ABI, provider);
          const frd = await mc(feed, "latestRoundData");
          if (frd) {
            const answer = Number(frd[1]) / 1e8;
            const updatedAt = Number(frd[3]);
            const age = Math.floor(Date.now() / 1000) - updatedAt;
            r.mainFeed = { address: feedAddr, price: answer, updatedAt, age, maxStale };
            console.log(`  Main feed: price=$${answer.toFixed(4)} age=${age}s (maxStale=${maxStale}s) ${age >= maxStale ? "⚠️ STALE" : "FRESH"}`);
          }
        }
      } else {
        // Try BinanceOracle ABI (BSC native)
        const bo = new ethers.Contract(mainAddr, BINANCE_ORACLE_ABI, provider);
        const binanceSymbol = symbol === "WBNB" ? "BNB" : symbol;
        const boStale = await mc(bo, "maxStalePeriod", binanceSymbol);
        if (boStale !== null) {
          const boPrice = await mc(bo, "getPrice", binanceSymbol);
          r.mainBinanceOracle = { symbol: binanceSymbol, maxStalePeriod: Number(boStale), price: boPrice ? Number(ethers.formatUnits(boPrice, 18)) : null };
          console.log(`  Main BinanceOracle: ${binanceSymbol} maxStale=${Number(boStale)}s price=$${r.mainBinanceOracle.price}`);
        } else {
          r.mainOracleNote = "Not ChainlinkOracle or BinanceOracle — custom adapter";
          console.log(`  Main oracle: custom adapter (not Chainlink/Binance)`);
        }
      }
    }

    // P0-6: Caching enabled?
    try {
      // ResilientOracle.getTokenConfig returns different struct format
      // Let's try getting it raw
      const tcfg = await mc(ro, "getTokenConfig", asset);
      if (tcfg && tcfg.length >= 4) {
        // The struct is (asset, oracles[3], enableFlagsForOracles[3]) — no caching field in this version
        r.cachingEnabled = "Unknown (no caching field in this ResillientOracle version)";
      } else {
        r.cachingEnabled = "No token config";
      }
    } catch (_) {
      r.cachingEnabled = "getTokenConfig failed";
    }
    console.log(`  Caching: ${r.cachingEnabled}`);

    // P0-7: Live price
    const price = await mc(ro, "getPrice", asset);
    if (price) {
      r.livePrice = Number(ethers.formatUnits(price, 18));
      console.log(`  Live oracle price: $${r.livePrice.toFixed(4)}`);
    }

    // Oracle cascade assessment
    const cascadeIssues = [];
    if (r.mainEqualsFallback) cascadeIssues.push("MAIN==FALLBACK: collapses to single-oracle when pivot disabled/stale");
    if (!r.pivotEnabled) cascadeIssues.push("PIVOT_DISABLED: no cross-validation of main price");
    if (r.mainFeed && r.mainFeed.age >= r.mainFeed.maxStale) cascadeIssues.push("MAIN_FEED_STALE");
    if (r.pivotFeed && r.pivotFeed.age && r.pivotFeed.age >= 86400) cascadeIssues.push("PIVOT_FEED_OLD (>24h)");
    if (r.boundValidator && r.boundValidator.upperBoundRatio >= 1.5) cascadeIssues.push("WIDE_BOUNDS: 50%+ deviation tolerated");
    if (roles.MAIN && roles.MAIN.address && !roles.MAIN.enabled) cascadeIssues.push("MAIN_DISABLED");
    r.cascadeIssues = cascadeIssues;
    if (cascadeIssues.length > 0) {
      console.log(`  ⚠️ CASCADE ISSUES: ${cascadeIssues.join("; ")}`);
    } else {
      console.log(`  ✅ Cascade healthy`);
    }

    results[symbol] = r;
  }

  // ---- P0-8: Ethereum deployment probe ----
  console.log("\n=== P0-8: Ethereum Deployment ===");
  // We don't have Eth addresses from the triage — try to find them
  // The ETH LIsta deployment should be at different addresses
  const ethUrl = await resolveRpc(1);
  const ethResult = { error: null };
  if (ethUrl) {
    console.log(`  ETH RPC: ${ethUrl.slice(0, 45)}...`);
    // Try known Lista Ethereum addresses or search
    // For now, note this needs deployment mapping
    ethResult.note = "Ethereum deployment addresses not known — needs Lista docs/DEFiLlama/Etherscan research";
    console.log(`  ⚠️ ${ethResult.note}`);
  } else {
    ethResult.note = "No ETH RPC available";
    console.log(`  ⚠️ ${ethResult.note}`);
  }
  results._ethereum = ethResult;

  // ---- Assessment ----
  console.log("\n=== OVERALL ASSESSMENT ===");
  let criticalFindings = 0;
  for (const [sym, r] of Object.entries(results)) {
    if (sym.startsWith("_")) continue;
    if (r.mainEqualsFallback) {
      criticalFindings++;
      console.log(`  🔴 ${sym}: MAIN==FALLBACK (${r.roles.MAIN.address}) — ${r.pivotEnabled ? "pivot=enabled but feeds may stale" : "pivot=DISABLED"} — ${r.mainFeed ? `feed age=${r.mainFeed.age}s maxStale=${r.mainFeed.maxStale}s` : "no feed data"}`);
    } else if (r.pivotEnabled && r.mainFeed && r.mainFeed.age >= r.mainFeed.maxStale) {
      criticalFindings++;
      console.log(`  🔴 ${sym}: MAIN FEED STALE (age=${r.mainFeed.age}s > maxStale=${r.mainFeed.maxStale}s)`);
    } else if (!r.pivotEnabled) {
      console.log(`  🟡 ${sym}: Pivot disabled — no cross-validation. Main feed: ${r.mainFeed ? `age=${r.mainFeed.age}s/${r.mainFeed.maxStale}s` : "?"}`);
    } else {
      console.log(`  🟢 ${sym}: Triple-source OK. Main feed: ${r.mainFeed ? `age=${r.mainFeed.age}s/${r.mainFeed.maxStale}s` : "?"}`);
    }
  }

  if (criticalFindings > 0) {
    console.log(`\n⚠️ ${criticalFindings} CRITICAL finding(s) — potential fork-proof exploit surface!`);
  } else {
    console.log(`\n✅ No critical findings — oracle cascade appears healthy. Close out or move to Phase 2.`);
  }

  // Write artifact
  const artifact = {
    scannedAt: new Date().toISOString(),
    chainId: BSC_CHAIN_ID,
    resilientOracle,
    moolah,
    boundValidator: bvAddr,
    moolahOwner: owner,
    roAcm: acm,
    results,
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(artifact, (_, v) => typeof v === "bigint" ? v.toString() : v, 2));
  console.log(`\nArtifact: ${OUT_FILE}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
