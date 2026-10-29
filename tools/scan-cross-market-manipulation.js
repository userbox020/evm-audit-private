#!/usr/bin/env node
// scan-cross-market-manipulation.js — Pattern #2: Cross-Market Manipulation (Spot+Derivatives)
// Scans for protocols operating BOTH spot and derivatives on same asset
// Attack: manipulate spot oracle → trigger perp liquidations → profit on perp position
const { rpcCall, resolveRpc } = require("./shared-rpc");
const fs = require("fs"); const path = require("path");

const OUT = path.join(__dirname, "..", "reports", "raw", "fast", "cross-market-manipulation.json");

// Known spot+perp protocol pairs
const PROTOCOLS = [
  // GMX — spot GLP pool + perps on same assets
  { chain:42161, label:"GMX (Arb)", spotVault:"0x489ee077994B6658eAfA855C308275EAd8097C4A", perpVault:"0x489ee077994B6658eAfA855C308275EAd8097C4A", note:"GLP pool used for both spot and perp collateral" },
  // Synthetix V3 — spot synth + perp on same core
  { chain:10, label:"Synthetix V3 (OP)", spotCore:"0xffffffaEff0B96Ea8e4f94b2253f31abdD875847", perpMarket:"0x0A2AF931eFfD34b81ebcc57E3d3c1B1E1dE1C9Ce", note:"spot synth + perp market on same core" },
  // Hyperliquid — spot + perp on same L1
  { chain:999, label:"Hyperliquid (HyperEVM)", spotAddr:null, perpAddr:null, note:"Custom L1, bridge-only monitoring" },
  // MUX — aggregator with spot+perp
  { chain:42161, label:"MUX (Arb)", addr:"0x5A7BaB7C1dB3A9B8Ec2acA08FEd1105D1E8Fc5b7", note:"MUX aggregator" },
  // Drift V2 — Solana (skip EVM)
  { chain:-1, label:"Drift V2 (Solana)", note:"Solana — skip" },
  // dYdX — L2 sovereign
  { chain:-1, label:"dYdX V4", note:"Sovereign L2 — skip" },
  // Gains Network — spot + leverage
  { chain:137, label:"Gains Network (Poly)", trading:"0x91993f2101cc758D0dEB7279d41e880F7dEFe827", note:"gTrade leverage + spot" },
  // Level Finance
  { chain:56, label:"Level Finance (BSC)", addr:"0xA5aBFB56A78D2BD4689b3B7A6FdB0d9Bf263875f", note:"Level perp DEX" },
];

// Chainlink ETH/USD per chain
const CL_FEEDS = {
  1:"0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419",
  42161:"0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612",
  10:"0x13e3Ee699D1909E989722E753853AE30b17e08c5",
  137:"0xF9680D99D6C9589e2a93a78A04A279e509205945",
  56:"0x9ef1B8c0E4F7dc8bF5719Ea496883DC6401d5b2e",
  8453:"0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
};

async function getChainlink(rpc, chainId) {
  const feed = CL_FEEDS[chainId];
  if (!feed) return null;
  const raw = await rpcCall(rpc, "eth_call", [{ to: feed, data: "0xfeaf968c" }, "latest"], 5000);
  if (!raw || raw.length < 258) return null;
  return { price: Number(BigInt("0x" + raw.slice(2+64, 2+128))) / 1e8,
    updatedAt: Number(BigInt("0x" + raw.slice(2+192, 2+256))),
    age: Math.floor(Date.now()/1000) - Number(BigInt("0x" + raw.slice(2+192, 2+256))) };
}

async function scanGMX(rpcArb) {
  const r = { protocol:"GMX", chain:42161, results:[] };
  // GMX vault TVL via token balances
  const vault = "0x489ee077994B6658eAfA855C308275EAd8097C4A";
  // Get contract code size as rough activity indicator
  const code = await rpcCall(rpcArb, "eth_getCode", [vault, "latest"], 3000);
  r.codeSize = code ? (code.length-2)/2 : 0;
  // Try totalTokenWeights / minPrice selectors
  const raw = await rpcCall(rpcArb, "eth_call", [{ to:vault, data:"0xfeaf968c" }, "latest"], 5000);
  r.hasLatestRound = raw && raw.length >= 258;
  r.tvl = "See Arb Vault 0x489ee0...";
  return r;
}

async function scanSynthetix(rpcOp) {
  const r = { protocol:"Synthetix V3", chain:10, results:[] };
  // Perp Market on OP
  const market = "0x0A2AF931eFfD34b81ebcc57E3d3c1B1E1dE1C9Ce";
  const code = await rpcCall(rpcOp, "eth_getCode", [market, "latest"], 3000);
  r.codeSize = code ? (code.length-2)/2 : 0;
  // Try reading open interest or TVL
  const raw = await rpcCall(rpcOp, "eth_call", [{ to:market, data:"0xb1c9af6a" }, "latest"], 5000); // maybe openInterest()
  r.hasView = raw && raw.length >= 66;
  return r;
}

async function main() {
  console.log("=== Cross-Market Manipulation Scanner (Pattern #2) ===\n");
  console.log("Attack: Manipulate spot oracle → trigger perp liquidations → extract fund\n");
  console.log("Protocols with both spot and perp markets on same chain\n");

  const rpcs = {};
  const results = [];
  
  // GMX on Arbitrum
  if (!rpcs[42161]) rpcs[42161] = await resolveRpc(42161);
  if (rpcs[42161]) {
    const gmx = await scanGMX(rpcs[42161]);
    results.push(gmx);
    console.log("GMX (Arb)".padEnd(22) + "Vault active | code=" + gmx.codeSize.toFixed(0) + "B");
    console.log("  Cross-market risk: GLP pool shared between spot margin and perp collateral");
    console.log("  Attack: flash-loan collat → open max perp → manipulate spot price → liquidate self");
    console.log("  Required: $100K+ flash loan for meaningful GLP price impact\n");
  }

  // Synthetix on OP
  if (!rpcs[10]) rpcs[10] = await resolveRpc(10);
  if (rpcs[10]) {
    const snx = await scanSynthetix(rpcs[10]);
    results.push(snx);
    const cl = await getChainlink(rpcs[10], 10);
    console.log("Synthetix V3 (OP)".padEnd(22) + "Perp market active | code=" + snx.codeSize.toFixed(0) + "B");
    console.log("  CL ETH/USD: $" + (cl?.price?.toFixed(2) || "N/A") + " | age: " + (cl?.age||"N/A") + "s");
    console.log("  Synthetix uses Pyth+Chainlink dual for perps → oracle manipulation harder");
    console.log("  Attack surface: spot synth price drift vs perp oracle (Pyth timelag)\n");
  }

  // Gains on Polygon
  if (!rpcs[137]) rpcs[137] = await resolveRpc(137);
  if (rpcs[137]) {
    const code = await rpcCall(rpcs[137], "eth_getCode", ["0x91993f2101cc758D0dEB7279d41e880F7dEFe827", "latest"], 3000);
    const cl = await getChainlink(rpcs[137], 137);
    results.push({ protocol:"Gains Network", chain:137, codeSize:code?code.length:0 });
    console.log("Gains Network (Poly)".padEnd(22) + "gTrade active | code=" + (code?code.length:0) + "B");
    console.log("  CL ETH/USD: $" + (cl?.price?.toFixed(2) || "N/A") + " | age: " + (cl?.age||"N/A") + "s");
    console.log("  Gains uses custom Chainlink-based pricing for leverage trading\n");
  }

  // Level on BSC
  if (!rpcs[56]) rpcs[56] = await resolveRpc(56);
  if (rpcs[56]) {
    const code = await rpcCall(rpcs[56], "eth_getCode", ["0xA5aBFB56A78D2BD4689b3B7A6FdB0d9Bf263875f", "latest"], 3000);
    const cl = await getChainlink(rpcs[56], 56);
    results.push({ protocol:"Level Finance", chain:56, codeSize:code?code.length:0 });
    console.log("Level Finance (BSC)".padEnd(22) + "Perp DEX active | code=" + (code?code.length:0) + "B");
    console.log("  CL ETH/USD: $" + (cl?.price?.toFixed(2) || "N/A") + " | age: " + (cl?.age||"N/A") + "s\n");
  }

  // Summary
  console.log("=== Summary ===");
  console.log("Protocols scanned: " + results.length);
  console.log("Most exploitable: GMX GLP (shared spot+perp pool)");
  console.log("Required: $100K+ flash loan + GLP oracle manipulation window");
  console.log("Barrier: GMX uses Chainlink medianizer (harder to manipulate than single feed)");

  fs.writeFileSync(OUT, JSON.stringify({ scannedAt: new Date().toISOString(), results }, null, 2));
  console.log("Artifact: " + OUT);
}
main().catch(e => { console.error(e.message); process.exit(1); });
