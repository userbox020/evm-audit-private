#!/usr/bin/env node
// monitor-morpho-liq-v2.js — V2: Find liquidatable Morpho positions via events
// Pure on-chain: monitors Borrow/Repay events, reads positions, checks HF
const { rpcCall, resolveRpc } = require("./shared-rpc");
const ethers = require("ethers");
const fs = require("fs"); const path = require("path");

const WORKSPACE = path.join(__dirname, "..");
const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "morpho-liq-borrowers.json");

// Verified event topics (corrected from Morpho EventsLib.sol)
const EV = {
  Borrow: "0x570954540bed6b1304a87dfe815a5eda4a648f7097a16240dcd85c9b5fd42a43",    // Borrow(bytes32,address,address,address,uint256,uint256)
  Repay: ethers.id("Repay(bytes32,address,address,uint256,uint256)"),
  Supply: ethers.id("Supply(bytes32,address,address,uint256,uint256)"),
  Liquidate: "0xc271de7a37024d1e851e5fc9284cc9f2ffd01a781d0a2e9899c4a7a01a81e95e", // Liquidate(bytes32,address,uint256,uint256,bytes)
  CreateMarket: ethers.id("CreateMarket(bytes32,(address,address,address,address,uint256))"),
};

function enc(a) { return "0".repeat(24) + a.slice(2).toLowerCase(); }

async function getMarketParams(rpc, marketId) {
  // idToMarketParams(bytes32) → MarketParams
  const raw = await rpcCall(rpc, "eth_call", [{ to: MORPHO, data: "0x2c3c9157" + marketId.slice(2) }, "latest"], 8000);
  if (!raw || raw.length < 322) return null;
  return {
    loanToken: "0x" + raw.slice(26, 66),
    collateralToken: "0x" + raw.slice(90, 130),
    oracle: "0x" + raw.slice(154, 194),
    irm: "0x" + raw.slice(218, 258),
    lltv: Number(BigInt("0x" + raw.slice(258, 322))) / 1e18,
  };
}

async function getMarketState(rpc, marketId) {
  const raw = await rpcCall(rpc, "eth_call", [{ to: MORPHO, data: "0x5c60e39a" + marketId.slice(2) }, "latest"], 8000);
  if (!raw || raw.length < 386) return null;
  return {
    supplyAssets: BigInt("0x" + raw.slice(2, 66)),
    borrowAssets: BigInt("0x" + raw.slice(130, 194)),
    borrowShares: BigInt("0x" + raw.slice(194, 258)),
  };
}

async function getChainlinkEth(rpc) {
  const raw = await rpcCall(rpc, "eth_call", [{ to: "0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419", data: "0xfeaf968c" }, "latest"], 5000);
  if (raw && raw.length >= 258) return Number(BigInt("0x" + raw.slice(2+64, 2+128))) / 1e8;
  return 1600;
}

async function getOraclePrice(rpc, oracle) {
  if (oracle === "0x" + "0".repeat(40)) return null;
  const raw = await rpcCall(rpc, "eth_call", [{ to: oracle, data: "0xa035b1fe" }, "latest"], 8000);
  if (raw && raw.length >= 66) {
    const v = Number(BigInt("0x" + raw.slice(2, 66)));
    if (v > 1e36) return v / 1e36; // Morpho oracle returns * 1e36
    if (v > 1000) return v / 1e18; // Some oracles return 18 decimal price
    return v;
  }
  return null;
}

async function getTokenSymbol(rpc, token) {
  try {
    const raw = await rpcCall(rpc, "eth_call", [{ to: token, data: "0x95d89b41" }, "latest"], 5000);
    if (raw && raw.length > 130) {
      // Dynamic string — skip offset (32 bytes) + length (32 bytes) + data
      const len = parseInt(raw.slice(130, 194), 16) * 2;
      return Buffer.from(raw.slice(194, 194 + len), 'hex').toString().replace(/\0/g, '');
    }
  } catch(_) {}
  return token.slice(0, 6) + "...";
}

async function getTokenDecimals(rpc, token) {
  const raw = await rpcCall(rpc, "eth_call", [{ to: token, data: "0x313ce567" }, "latest"], 5000);
  if (raw && raw.length >= 66) return parseInt(raw.slice(130, 132), 16) || 18;
  return 18;
}

async function scanBorrower(rpc, marketId, borrower, params, state, price) {
  const raw = await rpcCall(rpc, "eth_call", [{ to: MORPHO, data: "0x93c52062" + marketId.slice(2) + enc(borrower) }, "latest"], 8000);
  if (!raw || raw.length < 194) return null;

  const supplyShares = BigInt("0x" + raw.slice(2, 66));
  const borrowShares = BigInt("0x" + raw.slice(66, 130));
  const collateral = BigInt("0x" + raw.slice(130, 194));
  
  if (borrowShares === 0n) return null;

  const totalBorrowAssets = state.borrowAssets;
  const totalBorrowShares = state.borrowShares;
  if (totalBorrowShares === 0n) return null;

  // borrowAssets = borrowShares * totalBorrowAssets / totalBorrowShares
  const borrowAssets = borrowShares * totalBorrowAssets / totalBorrowShares;
  
  // Morpho oracle: price = collateralAssetValue / loanAssetValue (in 1e36)
  // borrowValueInLoan = borrowAssets (in loan decimals → need loanDec)
  // collateralValue = collateral * price (in loan asset value)
  
  const collDec = await getTokenDecimals(rpc, params.collateralToken);
  const loanDec = await getTokenDecimals(rpc, params.loanToken);

  // collateralValue in loan token units = collateral / 10^collDec * price
  // Price is already in loanAsset/collateralAsset ratio
  // borrowAmount in loan token units = borrowAssets / 10^loanDec
  
  const borrowAmount = Number(borrowAssets) / (10 ** loanDec);
  const collateralAmount = Number(collateral) / (10 ** collDec);
  
  // For USD approximation: if loan token is a stable (USDC/USDT/DAI), borrow ≈ USD
  // For non-stable loans, we need the loan's USD price
  const isStableLoan = [6, 18].includes(loanDec); // rough — need symbol check
  
  // Approximate USD: borrow * price (reversed) for non-stable loans
  let borrowUsdApprox = borrowAmount;
  if (price && price < 1e-6) {
    // Price is very small — likely WBTC/collateral as loan and USDC as loan
    borrowUsdApprox = borrowAmount; // stable loan = USD
  }
  
  const collateralValueInLoan = collateralAmount * (price || 0);
  const healthFactor = borrowAmount > 0 ? (collateralValueInLoan * params.lltv / borrowAmount) : 0;

  return {
    borrower: borrower.slice(0, 10) + "...",
    borrowAmount: borrowAmount.toFixed(4),
    borrowUsd: borrowUsdApprox.toFixed(0),
    collateralAmount: collateralAmount.toFixed(4),
    lltv: (params.lltv * 100).toFixed(0) + "%",
    hf: healthFactor.toFixed(4),
    atRisk: healthFactor > 0 && healthFactor < 0.95,
  };
}

async function main() {
  console.log("=== Morpho Blue On-Chain Liquidation Bot V2 ===\n");

  const rpc = await resolveRpc(1);
  if (!rpc) { console.error("No ETH RPC"); return; }

  const block = await rpcCall(rpc, "eth_blockNumber", [], 5000);
  if (!block) return;
  const cur = parseInt(block, 16);
  const fromBlock = "0x" + (cur - 5000).toString(16);

  // Step 1: Get recent Borrow events
  console.log("Scanning Borrow events (last 5000 blocks)...");
  const borrowLogs = await rpcCall(rpc, "eth_getLogs", [{
    address: MORPHO,
    fromBlock,
    toBlock: block,
    topics: [EV.Borrow]
  }], 15000);

  if (!borrowLogs || !Array.isArray(borrowLogs)) {
    console.log("No Borrow events or RPC error");
    // Fallback: try known Morpho market
    console.log("\nTrying known Morpho market...");
    return;
  }

  console.log("Found " + borrowLogs.length + " Borrow events\n");

  // Step 2: Extract unique (marketId, borrower) pairs
  // Borrow(bytes32 id, address caller, address indexed onBehalf, address indexed receiver, uint256 assets, uint256 shares)
  // topic[1] = id, topic[2] = onBehalf (indexed), topic[3] = receiver (indexed)
  const pairs = new Map();
  for (const log of borrowLogs.slice(-500)) {
    const marketId = log.topics[1];
    const onBehalf = "0x" + (log.topics[2] || "").slice(26);
    if (!pairs.has(marketId)) pairs.set(marketId, new Set());
    pairs.get(marketId).add(onBehalf);
  }

  console.log("Unique markets: " + pairs.size);
  let totalPairs = 0;
  for (const [_, bs] of pairs) totalPairs += bs.size;
  console.log("Unique (market, borrower) pairs: " + totalPairs + "\n");

  // Step 3: For each market, get params, state, and scan borrowers
  const results = [];
  let marketNum = 0;
  for (const [marketId, borrowers] of pairs) {
    marketNum++;
    const params = await getMarketParams(rpc, marketId);
    if (!params) continue;

    const state = await getMarketState(rpc, marketId);
    if (!state || state.borrowAssets === 0n) continue;

    // Get token info
    const loanDec = await getTokenDecimals(rpc, params.loanToken);
    const borrowRaw = Number(state.borrowAssets);
    const borrowInToken = borrowRaw / (10 ** loanDec);
    
    // Approximate USD: try oracle first, then fallback Chainlink ETH/USD
    const price = await getOraclePrice(rpc, params.oracle);
    let borrowUsd = 0;
    
    if (params.loanToken.toLowerCase() === "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2".toLowerCase()) {
      // WETH loan — get ETH/USD from Chainlink
      borrowUsd = borrowInToken * (await getChainlinkEth(rpc));
    } else if (["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48".toLowerCase(), 
                 "0xdac17f958d2ee523a2206206994597c13d831ec7".toLowerCase(),
                 "0x6b175474e89094c44da98b954eedeac495271d0f".toLowerCase()].includes(params.loanToken.toLowerCase())) {
      // Stablecoin loan
      borrowUsd = borrowInToken;
    } else {
      borrowUsd = borrowInToken * (price || await getChainlinkEth(rpc));
    }
    
    if (borrowUsd < 500) continue;

    console.log(`Market #${marketNum}: borrow=$${borrowUsd.toFixed(0)} price=${price?.toFixed(6)||'N/A'} LLTV=${(params.lltv*100).toFixed(0)}%`);

    // Scan borrowers
    let scanned = 0, atRisk = 0;
    for (const borrower of [...borrowers].slice(0, 20)) {
      const pos = await scanBorrower(rpc, marketId, borrower, params, state, price);
      if (pos) {
        scanned++;
        if (pos.atRisk) atRisk++;
        if (pos.borrowUsd && parseFloat(pos.borrowUsd) > 1000) {
          console.log(`  ${pos.borrower} borrow=$${pos.borrowUsd} lltv=${pos.lltv}`);
        }
      }
    }

    results.push({
      marketId: marketId.slice(0, 18) + "...",
      loanToken: params.loanToken.slice(0, 10) + "...",
      collateralToken: params.collateralToken.slice(0, 10) + "...",
      oracle: params.oracle.slice(0, 10) + "...",
      lltv: params.lltv,
      price,
      borrowUsd: borrowUsd.toFixed(0),
      borrowers: [...borrowers].length,
      scanned,
      atRisk,
    });
    
    if (marketNum >= 10) break;
  }

  results.sort((a, b) => parseFloat(b.borrowUsd) - parseFloat(a.borrowUsd));
  console.log("\n=== Top Borrow Markets ===");
  for (const r of results.slice(0, 10)) {
    console.log(`${r.collateralToken.padEnd(12)}/${r.loanToken.padEnd(8)} borrow=$${r.borrowUsd.padStart(8)} LLTV=${(r.lltv*100).toFixed(0)}% ${r.atRisk} risk`);
  }

  fs.writeFileSync(OUT, JSON.stringify({ scannedAt: new Date().toISOString(), results }, null, 2));
  console.log("\nArtifact: " + OUT);
}
main().catch(e => { console.error(e.message); process.exit(1); });
