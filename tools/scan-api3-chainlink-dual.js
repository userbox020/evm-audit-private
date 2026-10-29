#!/usr/bin/env node
// scan-api3-chainlink-dual.js — General API3 + Chainlink Dual Oracle Freshness Scanner
// Works for ANY protocol using API3 as oracle (Gravita, etc.)
// API3 Api3ServerV1 at 0x709944a48caf83535e43471680fda4905fb3920a on all EVM chains
const fs = require("fs"); const path = require("path");
const { rpcCall, resolveRpc } = require("./shared-rpc");
const ethers = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "api3-chainlink-dual.json");

// API3 Api3ServerV1 — deployed at same address on ALL EVM chains via CREATE2
const API3_SERVER = "0x709944a48caf83535e43471680fda4905fb3920a";

// Chainlink ETH/USD feeds per chain (from our cross-chain oracle scanner)
const CHAINLINK_FEEDS = {
  1: "0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419",
  8453: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
  42161: "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612",
  10: "0x13e3Ee699D1909E989722E753853AE30b17e08c5",
  137: "0xF9680D99D6C9589e2a93a78A04A279e509205945",
  56: "0x9ef1B8c0E4F7dc8bF5719Ea496883DC6401d5b2e",
  43114: "0x976B3D034E162d8bD72D6b9C989d545b839003b0",
  534352: "0x6bF14CB0A831078629D993FDeBcB182b21A8774C",
  59144: "0x3c6Cd9Cc7c7a4c2Cf5a82734CD249D7D593354dA",
  100: "0xa767f745331D267c7751297D982b050c93985627",
  324: "0x6D41d1dc818112880b40e26BD6FD347E410501e1",
};

// Target chains where API3 is known to be deployed
const TARGET_CHAINS = [1, 8453, 42161, 10, 137, 56, 43114, 534352, 59144, 100, 324];

async function probeChain(chainId) {
  const rpc = await resolveRpc(chainId);
  if (!rpc) return { chainId, error: "no-rpc" };

  const result = { chainId, api3: null, chainlink: null };

  // 1. Check API3 server deployment
  const api3Code = await rpcCall(rpc, "eth_getCode", [API3_SERVER, "latest"], 5000);
  if (!api3Code || api3Code === "0x" || api3Code.length < 100) {
    result.api3 = { deployed: false };
  } else {
    result.api3 = { deployed: true, bytecodeSize: (api3Code.length - 2) / 2 };
    // Try to read a data feed — the exact dAPI name for ETH/USD varies by chain
    // API3 uses dAPI names like "ETH/USD" encoded as bytes32
    // readDataFeedWithDapiName(bytes32) → (int224 value, uint32 timestamp)
    const dapiName = ethers.keccak256(ethers.encodeBytes32String("ETH/USD"));
    // readDataFeedWithDapiName selector: 0xa3b50e4e (computed from ABI)
    const raw = await rpcCall(rpc, "eth_call", [{ to: API3_SERVER, data: "0xa3b50e4e" + dapiName.slice(2) }, "latest"], 8000);
    if (raw && raw !== "0x" && raw.length >= 130) {
      const value = BigInt("0x" + raw.slice(2, 66));
      const timestamp = Number(BigInt("0x" + raw.slice(66, 130)));
      const price = Number(value) / 1e18;
      const age = Math.floor(Date.now() / 1000) - timestamp;
      result.api3.price = price;
      result.api3.timestamp = timestamp;
      result.api3.age = age;
    }
  }

  // 2. Check Chainlink ETH/USD
  const clFeed = CHAINLINK_FEEDS[chainId];
  if (clFeed) {
    const clRaw = await rpcCall(rpc, "eth_call", [{ to: clFeed, data: "0xfeaf968c" }, "latest"], 8000);
    if (clRaw && clRaw.length >= 258) {
      const answer = BigInt("0x" + clRaw.slice(2 + 64, 2 + 128));
      const updatedAt = Number(BigInt("0x" + clRaw.slice(2 + 192, 2 + 256)));
      result.chainlink = { price: Number(answer) / 1e8, updatedAt, age: Math.floor(Date.now() / 1000) - updatedAt };
    }
  }

  // 3. Score dual-oracle drift
  const api3Age = result.api3?.age;
  const clAge = result.chainlink?.age;
  if (result.api3?.price && result.chainlink?.price) {
    const divergence = Math.abs(result.api3.price - result.chainlink.price) / result.chainlink.price * 100;
    result.divergence = divergence;
    result.risk = (api3Age > 86400 && clAge < 3600) ? "CRITICAL — API3 stale >24h, Chainlink fresh" :
                  (api3Age > 3600) ? "HIGH — API3 stale >1h" : 
                  (clAge > 86400) ? "MEDIUM — Chainlink stale >24h" : "LOW";
  }

  return result;
}

async function main() {
  console.log("=== API3 + Chainlink Dual Oracle Scanner ===\n");
  console.log("API3 Server: " + API3_SERVER.slice(0, 10) + "...\n");

  const results = [];
  const names = {1:"ETH",8453:"Base",42161:"Arb",10:"OP",137:"Poly",56:"BSC",43114:"Avax",534352:"Scroll",59144:"Linea",100:"Gno",324:"zkSync"};

  for (const cid of TARGET_CHAINS) {
    const r = await probeChain(cid);
    results.push(r);
    const a3 = r.api3?.price ? "$"+r.api3.price.toFixed(2)+" ("+r.api3.age+"s)" : (r.api3?.deployed?"deployed":"NOT deployed");
    const cl = r.chainlink?.price ? "$"+r.chainlink.price.toFixed(2)+" ("+r.chainlink.age+"s)" : "N/A";
    const div = r.divergence ? r.divergence.toFixed(2)+"%" : "";
    console.log((names[cid]||"c"+cid).padEnd(8) + ": API3=" + a3.padEnd(20) + " CL=" + cl.padEnd(20) + " " + div.padEnd(8) + " " + (r.risk||""));
  }

  const critical = results.filter(r => r.risk?.startsWith("CRITICAL"));
  const high = results.filter(r => r.risk?.startsWith("HIGH"));
  console.log("\n=== Summary ===");
  console.log("API3 deployed: " + results.filter(r => r.api3?.deployed).length + "/" + TARGET_CHAINS.length);
  console.log("CRITICAL: " + critical.length + " | HIGH: " + high.length);
  console.log("Protocols affected: Gravita ($40M), any API3+Chainlink dual-oracle protocol");
  console.log("Attack: API3 goes stale → Chainlink becomes sole source → borrow at stale Chainlink price");

  fs.writeFileSync(OUT, JSON.stringify({ scannedAt: new Date().toISOString(), results, critical, high }, null, 2));
  console.log("\nArtifact: " + OUT);
}
main().catch(e => { console.error(e.message); process.exit(1); });
