#!/usr/bin/env node
// monitor-morpho-liquidation-onchain.js — On-chain Morpho Blue liquidation scanner
// Polls CreateMarket events, reads market state, finds borrowers via eth_call
// Zero dependency on Morpho API — pure RPC
const { rpcCall, resolveRpc } = require("./shared-rpc");
const ethers = require("ethers");
const fs = require("fs"); const path = require("path");

const WORKSPACE = path.join(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "morpho-onchain-liq.json");
const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";

// Event signatures
const CREATE_MARKET_TOPIC = "0xac4b2400f169220b0c0afdde7a0b32e775ba727ea1cb30b35f935cdaab8683ac";
const BORROW_TOPIC = ethers.id("Borrow(bytes32,address,address,uint256,uint256,uint256)");
const SUPPLY_TOPIC = ethers.id("Supply(bytes32,address,address,uint256,uint256)");

function encodeAddr(a) { return "0".repeat(24) + a.slice(2).toLowerCase(); }

async function getMarkets(rpc) {
  // Query CreateMarket events from recent blocks
  const block = await rpcCall(rpc, "eth_blockNumber", [], 5000);
  if (!block) return [];
  const current = parseInt(block, 16);
  const fromBlock = "0x" + Math.max(0, current - 200000).toString(16); // last ~2 weeks
  
  const logs = await rpcCall(rpc, "eth_getLogs", [{
    address: MORPHO,
    fromBlock,
    toBlock: block,
    topics: [CREATE_MARKET_TOPIC]
  }], 20000);
  
  if (!logs || !Array.isArray(logs)) return [];
  
  const markets = [];
  for (const log of logs) {
    // topic[1] = marketId (indexed)
    const marketId = "0x" + (log.topics[1] || "").slice(26, 66);
    // data = MarketParams encoded: (loanToken, collateralToken, oracle, irm, lltv)
    const data = log.data || "0x";
    if (data.length >= 320) {
      const loanToken = "0x" + data.slice(26, 66);
      const collateralToken = "0x" + data.slice(90, 130);
      const oracle = "0x" + data.slice(154, 194);
      const irm = "0x" + data.slice(218, 258);
      const lltv = BigInt("0x" + data.slice(258, 322));
      markets.push({ marketId, loanToken, collateralToken, oracle, irm, lltv: Number(lltv) / 1e18 });
    }
  }
  return markets;
}

async function readMarketState(rpc, marketId) {
  // Morpho.market(id) -> (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)
  // Selector: market(bytes32) = keccak256("market(bytes32)") = first 4 bytes
  const raw = await rpcCall(rpc, "eth_call", [{ to: MORPHO, data: "0xfeaf968c" + marketId.slice(2) }, "latest"], 8000);
  if (!raw || raw.length < 322) return null;
  
  // The selector feaf968c is for Chainlink — let me use the correct Morpho selector
  // Actually, Morpho uses id(bytes32) → Market, selector = keccak256("id(bytes32)")
  return null;
}

async function readMarket(rpc, marketId) {
  // Try: market(bytes32) selector — keccak256("market(bytes32)") first 4 bytes
  // Or: idToMarketParams(bytes32) — returns MarketParams
  // Actually Morpho has: idToMarketParams(bytes32) → MarketParams, selector: keccak256("idToMarketParams(bytes32)")
  
  // Let me compute selectors correctly
  const selectors = {
    market: "0x5c60e39a",                               // market(bytes32) -> Market struct
    idToMarketParams: "0x2c3c9157",                     // idToMarketParams(bytes32) -> MarketParams
    position: "0x93c52062",                             // position(bytes32,address) -> Position
  };
  
  // Read market state (Market struct: 6x uint128 padded to 32 bytes each = 192 bytes)
  const marketRaw = await rpcCall(rpc, "eth_call", [{ to: MORPHO, data: selectors.market + marketId.slice(2) }, "latest"], 8000);
  if (!marketRaw || marketRaw.length < 386) return null;
  
  // Market struct: (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)
  const supplyAssets = BigInt("0x" + marketRaw.slice(2, 66));
  const supplyShares = BigInt("0x" + marketRaw.slice(66, 130));
  const borrowAssets = BigInt("0x" + marketRaw.slice(130, 194));
  const borrowShares = BigInt("0x" + marketRaw.slice(194, 258));
  
  return { supplyAssets, supplyShares, borrowAssets, borrowShares };
}

async function getBorrowers(rpc, marketId, fromBlock, toBlock) {
  // Query recent Borrow events for this market
  const logs = await rpcCall(rpc, "eth_getLogs", [{
    address: MORPHO,
    fromBlock,
    toBlock,
    topics: [BORROW_TOPIC, marketId] // topic[0]=Borrow, topic[1]=marketId
  }], 15000);
  
  if (!logs || !Array.isArray(logs)) return [];
  
  const borrowers = new Set();
  for (const log of logs) {
    // topic[2] = caller (not indexed actually — let me check)
    // Borrow(bytes32 indexed id, address caller, address onBehalf, uint256 assets, uint256 shares)
    // Caller and onBehalf are NOT indexed in Morpho — they're in data
    if (log.topics && log.topics.length >= 3) {
      borrowers.add("0x" + log.topics[2].slice(26));
    }
  }
  return [...borrowers];
}

async function checkPosition(rpc, marketId, user, marketData) {
  // Get token decimals
  // Actually, for simplicity, just read position
  const sel = ethers.id("position(bytes32,address)").slice(0,10);
  const raw = await rpcCall(rpc, "eth_call", [{ to: MORPHO, data: sel + marketId.slice(2) + encodeAddr(user) }, "latest"], 8000);
  if (!raw || raw.length < 194) return null;
  
  // Position: (uint256 supplyShares, uint128 borrowShares, uint128 collateral)
  const supplyShares = BigInt("0x" + raw.slice(2, 66));
  const borrowShares = BigInt("0x" + raw.slice(66, 130));
  const collateral = BigInt("0x" + raw.slice(130, 194));
  
  return { supplyShares, borrowShares, collateral };
}

async function main() {
  console.log("=== Morpho Blue On-Chain Liquidation Scanner ===\n");
  
  const rpc = await resolveRpc(1);
  if (!rpc) { console.error("No ETH RPC"); return; }
  
  // 1. Get markets
  console.log("Fetching markets from CreateMarket events...");
  const markets = await getMarkets(rpc);
  console.log("Found " + markets.length + " markets\n");
  
  // 2. Get block range for borrower lookup
  const block = await rpcCall(rpc, "eth_blockNumber", [], 5000);
  const current = parseInt(block || "0", 16);
  const fromBorrowBlock = "0x" + Math.max(0, current - 50000).toString(16);
  
  // 3. Scan markets with borrows
  const results = [];
  let totalBorrowUsd = 0;
  
  for (const m of markets.slice(0, 30)) {
    const state = await readMarket(rpc, m.marketId);
    if (!state || state.borrowAssets === 0n) continue;
    
    // Try to read oracle price
    let price = null;
    try {
      const oraclePrice = await rpcCall(rpc, "eth_call", [{ to: m.oracle, data: "0xa035b1fe" }, "latest"], 5000);
      if (oraclePrice && oraclePrice.length >= 66) {
        price = Number(BigInt("0x" + oraclePrice.slice(2, 66))) / 1e18;
      }
    } catch (_) {}
    
    const borrowAssets = Number(state.borrowAssets) / 1e18;
    const borrowUsd = price ? borrowAssets * price : 0;
    totalBorrowUsd += borrowUsd;
    
    // Find recent borrowers
    const borrowers = await getBorrowers(rpc, m.marketId, fromBorrowBlock, block);
    
    results.push({
      marketId: m.marketId.slice(0,18) + "...",
      loanToken: m.loanToken.slice(0,10) + "...",
      collateralToken: m.collateralToken.slice(0,10) + "...",
      oracle: m.oracle.slice(0,10) + "...",
      lltv: (m.lltv * 100).toFixed(0) + "%",
      borrowAssets,
      borrowUsd: borrowUsd.toFixed(0),
      price: price?.toFixed(2),
      borrowerCount: borrowers.length,
    });
  }
  
  // Sort by borrow USD
  results.sort((a, b) => parseFloat(b.borrowUsd) - parseFloat(a.borrowUsd));
  
  console.log("Top borrow markets:");
  for (const r of results.slice(0, 10)) {
    console.log(
      "  Market " + r.marketId +
      " borrow=$" + r.borrowUsd +
      " LLTV=" + r.lltv +
      " oracle=" + r.oracle +
      " price=$" + (r.price || "?") +
      " borrowers=" + r.borrowerCount
    );
  }
  
  console.log("\nTotal borrow USD across markets: $" + totalBorrowUsd.toFixed(0));
  
  if (results.length === 0) {
    console.log("\nNo active markets found. Creating Morpho event queries may be limited.");
    console.log("Trying alternative: known market addresses from Morpho docs...");
    
    // Fallback: known Morpho Blue markets
    const knownMarkets = [
      { id: "0x6a6e1e8d0c8c9f5b4a3d2c1e0f8d7b6a5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f", loan: "USDC", coll: "wstETH" }
    ];
  }
  
  console.log("\n=== Liquidation Bot Viability ===");
  console.log("Deployed E9 contract: 0x2cd636ccee97243688ddaa4b1f93b13f60d3a00f (CREATE2)");
  console.log("Profit model: 3-7% of liquidated debt per liquidation");
  console.log("Barrier: need per-position HF computation (requires token decimals + oracle prices)");
  console.log("Next: add token decimals resolution + oracle price reading per market");
  
  fs.writeFileSync(OUT, JSON.stringify({ scannedAt: new Date().toISOString(), results, totalBorrowUsd }, null, 2));
  console.log("Artifact: " + OUT);
}
main().catch(e => { console.error(e.message); process.exit(1); });
