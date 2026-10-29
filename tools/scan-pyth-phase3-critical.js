#!/usr/bin/env node
// scan-pyth-phase3-criticals.js — Phase 3: Classify real Pyth consumers for getPriceUnsafe usage
const { rpcCall, resolveRpc } = require("./shared-rpc");
const ethers = require("ethers");
const fs = require("fs"); const path = require("path");

const OUT = path.join(__dirname, "..", "reports", "raw", "fast", "pyth-phase3-critical.json");
const ETH_USD = "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace";

// REAL Pyth consumer contracts (verified)
const CONSUMERS = [
  // Perennial on Arbitrum
  { chain:42161, addr:"0x9F35B78c6502e2B19D45Dc275f24462B0fa577B4", label:"Perennial PythFactory", note:"Factory for Pyth oracles" },
  { chain:42161, addr:"0x63DD4059971a9e24810A2Aea222460acA6687Bb6", label:"Perennial PythFactoryImpl", note:"Factory implementation" },
  { chain:42161, addr:"0x7A18A52EF9Ab4E2EDE9113ef13483eD18b395ca7", label:"Perennial PythOracleImpl", note:"Individual oracle impl" },
  // Morpho Pyth Oracle Factories
  { chain:1, addr:"0x1ed187354d6bfb983932d9983917b199a7253ab9", label:"Morpho PythOracle Factory ETH", note:"Deploys MorphoPythOracle" },
  { chain:8453, addr:"0x0A250c472cb43fb4F476cc6f47da9CA85E071Bbb", label:"Morpho PythOracle Factory Base", note:"Morpho Pyth on Base" },
  { chain:42161, addr:"0x3e2D5966bF67Ed2F66edfbc325f6bCf3d64EaA0A", label:"Morpho PythOracle Factory Arb", note:"Morpho Pyth on Arb" },
  // GMX V2 Oracle
  { chain:42161, addr:"0x7F01614cA5198Ec979B1aAd1DAF0DE7e0a215BDF", label:"GMX V2 Oracle", note:"Signer-based, may not directly call Pyth" },
  // Pyth upgraded contracts (post-July 2026)
  { chain:1, addr:"0x14b9932cc9AC8Ee03301665a8644A753f46D8552", label:"Pyth Upgraded (ETH)", note:"New Pyth core with different ABI" },
  { chain:42161, addr:"0xe15357fB7ab31E091583b9c4b4135BB2f176f38e", label:"Pyth Upgraded (Arb)", note:"New core" },
  { chain:10, addr:"0xa78951b6bADC9F4740f6f456E9144705D5C5E4B2", label:"Pyth Upgraded (OP)", note:"New core" },
  { chain:8453, addr:"0xbC16aee60f64864882BC6C4E428e148Fc0E272F5", label:"Pyth Upgraded (Base)", note:"New core" },
];

const PYTH_SELECTORS = {
  "getPriceUnsafe": "0x96834ad3",
  "getPriceNoOlderThan": "0x41da4bb7",
  "getEmaPriceNoOlderThan": "0xb3993119",
  "updatePriceFeeds": "0xef9e5e28",
  "parsePriceFeedUpdates": "0x471bb2e3",
  "getPrice": "0x31d98b3f", // might be in upgraded contract
};

async function scanConsumer(rpc, c) {
  const r = { ...c, deployed:false, pythMethods:[], usesUnsafe:false, risk:"NONE" };

  const code = await rpcCall(rpc, "eth_getCode", [c.addr, "latest"], 5000);
  if (!code || code.length < 10) return r;
  r.deployed = true;
  r.codeSize = (code.length - 2) / 2;

  for (const [name, sel] of Object.entries(PYTH_SELECTORS)) {
    if (code.includes(sel.slice(2))) {
      r.pythMethods.push(name);
    }
  }

  // Also check ERC1967 implementation for proxies
  const implSlot = await rpcCall(rpc, "eth_getStorageAt", [c.addr, "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc", "latest"], 5000);
  if (implSlot && implSlot.length >= 66) {
    const impl = "0x" + implSlot.slice(26, 66);
    if (impl !== "0x" + "0".repeat(40)) {
      r.implAddr = impl;
      const implCode = await rpcCall(rpc, "eth_getCode", [impl, "latest"], 5000);
      if (implCode) {
        r.implCodeSize = (implCode.length - 2) / 2;
        for (const [name, sel] of Object.entries(PYTH_SELECTORS)) {
          if (implCode.includes(sel.slice(2)) && !r.pythMethods.includes(name)) {
            r.pythMethods.push(name);
            r.foundInImpl = true;
          }
        }
      }
    }
  }

  // Risk classification
  r.usesUnsafe = r.pythMethods.includes("getPriceUnsafe");
  const hasSafe = r.pythMethods.includes("getPriceNoOlderThan") || r.pythMethods.includes("getEmaPriceNoOlderThan");
  const hasPullUpdate = r.pythMethods.includes("updatePriceFeeds") || r.pythMethods.includes("parsePriceFeedUpdates");

  if (r.usesUnsafe && !hasSafe && !hasPullUpdate) {
    r.risk = "CRITICAL — only getPriceUnsafe, no staleness enforcement";
  } else if (r.usesUnsafe && hasSafe) {
    r.risk = "HIGH — has getPriceUnsafe + safe methods (check call sites)";
  } else if (r.usesUnsafe && hasPullUpdate) {
    r.risk = "HIGH — uses unsafe read alongside pull updates";
  } else if (hasPullUpdate) {
    r.risk = "MEDIUM — pull update model (user provides signed data, protocol enforces staleness)";
  } else if (hasSafe) {
    r.risk = "LOW — uses age-restricted reads exclusively";
  } else if (r.pythMethods.length > 0) {
    r.risk = "LOW — uses Pyth methods, check parameters";
  } else {
    r.risk = "NONE — no Pyth selectors in bytecode";
  }

  // If no Pyth selectors found, try direct call: can this contract resolve getPriceUnsafe?
  if (r.pythMethods.length === 0 && r.deployed) {
    const raw = await rpcCall(rpc, "eth_call", [{ to:c.addr, data:PYTH_SELECTORS.getPriceUnsafe + ETH_USD.slice(2)}, "latest"], 8000);
    if (raw && raw.length >= 130) {
      const price = BigInt("0x" + raw.slice(2, 66));
      if (price !== 0n) {
        r.hasDirectPyth = true;
        r.pythMethods.push("getPriceUnsafe(direct)");
        r.risk = "CRITICAL — contract accepts getPriceUnsafe call, no staleness check";
      }
    }
  }

  return r;
}

async function scanPythDeployment(rpc, chainId) {
  // Check which Pyth oracle address is actually deployed
  const addrs = [
    { label:"Pyth (current)", addr:chainId === 1 ? "0x4305FB66699C3B2702D4d05CF36551390A4c69C6" : 
      chainId === 42161 ? "0xff1a0f4744e8582DF1aE09D5611b887B6a12925C" :
      chainId === 10 ? "0xff1a0f4744e8582DF1aE09D5611b887B6a12925C" :
      chainId === 8453 ? "0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a" : "" },
  ];
  if (!addrs[0].addr) return null;
  
  const code = await rpcCall(rpc, "eth_getCode", [addrs[0].addr, "latest"], 5000);
  if (!code || code.length < 10) return null;

  // Check which methods the Pyth contract itself exposes
  const methods = [];
  for (const [name, sel] of Object.entries(PYTH_SELECTORS)) {
    if (code.includes(sel.slice(2))) methods.push(name);
  }

  return { addr:addrs[0].addr, codeSize:(code.length-2)/2, methods };
}

const CHAIN_NAMES = {1:"ETH",42161:"Arb",8453:"Base",10:"OP",137:"Poly",56:"BSC",43114:"Avax"};

async function main() {
  console.log("=== Pyth Consumer Risk Analysis — Phase 3 ===\n");

  const rpcs = {};
  const results = [];
  const chainPyth = {};

  // Check Pyth deployment + methods on each chain
  for (const cid of [1, 42161, 10, 8453]) {
    if (!rpcs[cid]) rpcs[cid] = await resolveRpc(cid);
    if (rpcs[cid]) {
      const p = await scanPythDeployment(rpcs[cid], cid);
      if (p) {
        chainPyth[cid] = p;
        console.log(`Pyth on ${CHAIN_NAMES[cid]}: ${p.codeSize/1000}KB, methods: ${p.methods.map(m=>m.replace('getPrice','').replace('NoOlderThan','(age)')).join(', ')}`);
        // Test getPriceUnsafe staleness
        const raw = await rpcCall(rpcs[cid], "eth_call", [{ to:p.addr, data:PYTH_SELECTORS.getPriceUnsafe + ETH_USD.slice(2)}, "latest"], 5000);
        if (raw && raw.length >= 194) {
          const price = BigInt("0x" + raw.slice(2, 66));
          const MAX = BigInt("0x7FFFFFFFFFFFFFFF");
          const pv = price > MAX ? price - BigInt("0x10000000000000000") : price;
          const expRaw = parseInt(raw.slice(186,194), 16);
          const exp = expRaw > 0x7FFFFFFF ? expRaw - 0x100000000 : expRaw;
          const ts = Number(BigInt("0x" + raw.slice(194, 258)));
          const age = Math.floor(Date.now()/1000) - ts;
          console.log(`  ETH/USD = $${(Number(pv)*Math.pow(10,exp)).toFixed(2)} (${age}s stale)`);
        }
      }
    }
  }
  console.log("");

  // Scan each consumer
  console.log("--- Consumer Analysis ---");
  for (const c of CONSUMERS) {
    if (!rpcs[c.chain]) rpcs[c.chain] = await resolveRpc(c.chain);
    if (!rpcs[c.chain]) { results.push({...c, error:"no-rpc"}); continue; }

    const r = await scanConsumer(rpcs[c.chain], c);
    results.push(r);

    const deployed = r.deployed ? (r.codeSize/1000).toFixed(1)+"KB" : "GONE";
    const methods = r.pythMethods.length ? " [" + r.pythMethods.map(m=>m.includes("(")?m.replace("(direct)",""):m).join(",") + "]" : "";
    const impl = r.implAddr ? " impl=" + r.implAddr.slice(0,8)+"..." : "";
    console.log(r.label.padEnd(36) + deployed.padEnd(8) + r.risk.slice(0,55));
    if (methods || impl) console.log("  " + methods + impl);
  }

  const critical = results.filter(r => r.risk?.startsWith("CRITICAL"));
  const high = results.filter(r => r.risk?.startsWith("HIGH"));
  const med = results.filter(r => r.risk?.startsWith("MEDIUM"));

  console.log("\n=== Phase 3 Summary ===");
  console.log(`CRITICAL (getPriceUnsafe only): ${critical.length}`);
  console.log(`HIGH (unsafe + safe mixed): ${high.length}`);
  console.log(`MEDIUM (pull update model): ${med.length}`);

  if (critical.length) {
    console.log("\n=== CRITICAL TARGETS FOR PHASE 4 FORK TEST ===");
    for (const c of critical) {
      console.log(`\n  ${c.label}`);
      console.log(`  Address: ${c.addr}`);
      console.log(`  Chain: ${CHAIN_NAMES[c.chain] || c.chain}`);
      console.log(`  Reason: Contract accepts getPriceUnsafe without staleness enforcement`);
      console.log(`  Exploit:`);
      console.log(`    1. Read stale Pyth ETH/USD price via this consumer`);
      console.log(`    2. flash-loan ETH → deposit as collateral at stale price`);
      console.log(`    3. Borrow max against inflated collateral value`);
      console.log(`    4. Repay flash loan, keep profit`);
      console.log(`  Fork test command:`);
      console.log(`    anvil --fork-url <RPC_${CHAIN_NAMES[c.chain]}> --block-time 2`);
      console.log(`    cast call ${c.addr} "getPriceUnsafe(bytes32)(int64,uint64,int32,uint)" ${ETH_USD} --rpc-url http://localhost:8545`);
    }
  } else {
    console.log("\nNo CRITICAL targets — all consumers use safe Pyth methods");
  }

  fs.writeFileSync(OUT, JSON.stringify({ scannedAt:new Date().toISOString(), chainPyth, results, critical, high }, null, 2));
  console.log("\nArtifact: " + OUT);
}
main().catch(e => { console.error(e.message); process.exit(1); });
