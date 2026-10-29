#!/usr/bin/env node
// scan-blend-nft-lending.js — Blend NFT Lending Floor-Price Oracle Audit
// Blend (Blur) is the #1 NFT lending protocol at ~$200M TVL.
// Uses Chainlink NFT floor price feeds. Attack: stale floor price → borrow at inflated value.
const fs = require("fs");
const path = require("path");
const { rpcCall, resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "blend-nft-lending-audit.json");
const CHAIN_ID = 1;

// Blend contracts on Ethereum
const BLEND = {
  pool: "0x29469395eAf6f95920E59F858042f0e28D98a20B", // Blend Pool
  poolImpl: "0x60f1c0f0440aef836c40f6265b0dac8e1c951e17", // Pool implementation
  lendOfferFixture: "0xB39E1d35862d2d6D5dE08c92D8445C31dD655c6e",
  borrowOfferFixture: "0x355b33ce67228b85977028f14bd4876c96a09267",
};

// Chainlink NFT floor price feeds used by Blend
const NFT_FEEDS = {
  "BAYC":       "0x352f2Bc3039429fC2fe62004a1575aE74001CfcE", // Bored Ape Yacht Club
  "MAYC":       "0x1823a897A61C00e0C36eA8Ec0e0f8deA0F144f63", // Mutant Ape Yacht Club
  "PUNKS":      "0xdB0a1747B2C31d1D1c5997F3353dB7aC40668C27", // CryptoPunks
  "Azuki":      "0xA8B9A447C73191744D5B79BcE864F343455420f5", // Azuki
  "CloneX":     "0x021264d59DAbD26E7506Ee7278407891Bb8CDCCc", // CloneX
  "Milady":     "0xbA69DBe290c258931Fe16b49ba719E86E6729B0a", // Milady
  "Pudgy":      "0xbB2DEd7D19691a40411Cd068e28e1B69e7936B9A", // Pudgy Penguins
  "DeGods":     "0xFDc472b5D019A1CeD5Aa55ae5eDad67C4Ae8eDdE", // DeGods
};

async function ethCall(rpc, to, sel, args = "", ms = 8000) {
  const raw = await rpcCall(rpc, "eth_call", [{ to, data: "0x" + sel + args }, "latest"], ms);
  if (!raw || raw === "0x") return null;
  return raw;
}

async function readFeed(rpc, feedAddr) {
  // BAYC feed (0x352f2Bc3...) is a proxy aggregator — aggregator() returns 0x0
  // This feed is DEPRECATED. Chainlink moved BAYC floor price to a new contract.
  // Try the child aggregator first, then fall back to direct call
  const aggRaw = await ethCall(rpc, feedAddr, "245a7bfc"); // aggregator()
  if (aggRaw && aggRaw !== "0x" + "0".repeat(64)) {
    const child = "0x" + aggRaw.slice(26);
    const raw = await ethCall(rpc, child, "feaf968c"); // latestRoundData on child
    if (raw && raw.length >= 258) {
      const answer = BigInt("0x" + raw.slice(2 + 64, 2 + 128));
      const updatedAt = Number(BigInt("0x" + raw.slice(2 + 192, 2 + 256)));
      return { price: Number(answer) / 1e18, updatedAt };
    }
  }
  // Deprecated feed — no active aggregator
  return null;
}

async function main() {
  console.log("=== Blend NFT Floor-Price Oracle Audit ===\n");

  const rpc = await resolveRpc(CHAIN_ID);
  if (!rpc) { console.error("No ETH RPC"); process.exit(1); }

  const results = { feeds: [], riskSummary: { critical: 0, high: 0, medium: 0, low: 0 } };
  const block = await rpcCall(rpc, "eth_blockNumber", []);
  const blockTs = block ? (await rpcCall(rpc, "eth_getBlockByNumber", [block, false]))?.timestamp : null;
  const now = blockTs ? parseInt(blockTs, 16) : Math.floor(Date.now() / 1000);

  console.log(`Block: ${parseInt(block, 16)}, timestamp: ${now}\n`);

  // 1. Read all NFT floor price feeds
  for (const [name, feed] of Object.entries(NFT_FEEDS)) {
    const data = await readFeed(rpc, feed);
    const age = data ? now - data.updatedAt : null;
    const ageStr = age ? `${Math.round(age / 3600)}h${Math.round(age % 3600 / 60)}m` : "FAIL";

    let risk = "LOW";
    if (!data) risk = "UNKNOWN";
    else if (age && age > 86400) risk = "CRITICAL"; // >24h stale
    else if (age && age > 3600) risk = "HIGH";       // >1h stale
    else if (age && age > 600) risk = "MEDIUM";       // >10m stale

    console.log(`  ${name.padEnd(10)}: $${data?.price?.toFixed(0) || "?"} age=${ageStr} risk=${risk}`);
    results.feeds.push({ collection: name, feed, price: data?.price, updatedAt: data?.updatedAt, age, risk });
    if (risk === "CRITICAL") results.riskSummary.critical++;
    else if (risk === "HIGH") results.riskSummary.high++;
    else if (risk === "MEDIUM") results.riskSummary.medium++;
    else results.riskSummary.low++;
  }

  // 2. Check Blend Pool for active loans
  // Blend Pool has: getLoan(uint256) and getLoanCount()
  const poolCode = await rpcCall(rpc, "eth_getCode", [BLEND.pool, "latest"]);
  console.log(`\nBlend Pool: ${poolCode ? (poolCode.length-2)/2 : 0} bytes deployed`);

  // 3. Attack model summary
  console.log("\n=== Attack Model ===");
  console.log("1. Wait for NFT floor price feed to go stale (>1h no update)");
  console.log("2. Feed still returns last-known price (doesn't revert on staleness)");
  console.log("3. Deposit NFT as collateral → Blend values it at stale floor price");
  console.log("4. Borrow ETH against inflated collateral value");
  console.log("5. If feed updates → position becomes undercollateralized → Blend liquidates");
  console.log("6. Attacker keeps borrowed ETH, Blend seizes now-correctly-priced NFT");

  const critical = results.feeds.filter(f => f.risk === "CRITICAL");
  const high = results.feeds.filter(f => f.risk === "HIGH");
  console.log(`\nFeeds ready for attack: CRITICAL=${critical.length} HIGH=${high.length}`);

  fs.writeFileSync(OUT, JSON.stringify({
    scannedAt: new Date().toISOString(),
    block: parseInt(block, 16),
    blockTimestamp: now,
    feeds: results.feeds,
    riskSummary: results.riskSummary,
    attackModel: "Stale NFT floor price → deposit NFT at stale value → borrow ETH → exit with borrowed ETH, leaving undercollateralized NFT for Blend to liquidate",
    note: "Chainlink NFT floor price feeds do NOT revert on staleness — they return the last good value. If a feed hasn't updated in hours, the price is stale but still accepted by Blend as collateral valuation.",
  }, null, 2));
  console.log(`\nArtifact: ${OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
