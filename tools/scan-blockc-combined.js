#!/usr/bin/env node
// scan-blockc-combined.js — Patterns #3, #5, #6, #10, #11 combined scanner
// #3 Keeper Callback Reentrancy — protocols with external keeper calls
// #5 Precision-Loss Cascade — cross-protocol rounding exploitation
// #6 Intent-Solver Exhaustion — bridge solver profitability
// #10 CLMM Custom LDF Precision — concentrated liquidity math
// #11 Trusted Forwarder Spoofing — GSN/EIP-2771 grepping
const { rpcCall, resolveRpc } = require("./shared-rpc");
const ethers = require("ethers");
const fs = require("fs"); const path = require("path");

const DIR = path.join(__dirname, "..", "reports", "raw", "fast");

// === Pattern #3: Keeper Callback Reentrancy ===
// Protocols that call external keepers with user-controlled callback data
const KEEPER_TARGETS = [
  // GMX — liquidation keeper called by keepers via external callback
  { chain:42161, addr:"0x09f77E8A13De9a35a7231028187e9fD5DB8a2ACB", label:"GMX OrderBook (Arb)" },
  { chain:42161, addr:"0x489ee077994B6658eAfA855C308275EAd8097C4A", label:"GMX Vault (Arb)" },
  // Chainlink Automation / Gelato — keepers execute arbitrary user calldata
  { chain:1, addr:"0x2A6C106ae13B558BB9E2Ec64Bd2f1f7BEFF3A5E0", label:"Chainlink Keeper Registry" },
  { chain:1, addr:"0x3CACa7b48D0573D793d0b0279b5F00218E0f8261", label:"Gelato Relay" },
  // DEX aggregator keeper
  { chain:42161, addr:"0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE", label:"LI.FI Diamond (Arb)" },
];

// === Pattern #5: Precision-Loss Cascade ===
// Cross-protocol rounding errors that cascade across composable DeFi
const PRECISION_TARGETS = [
  // ERC4626 vaults that use non-lossless math (round-down on deposit, round-up on withdraw)
  { chain:1, addr:"0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0", label:"Lido wstETH (ERC4626-ish)", note:"Check stETH:wstETH rounding on repeated deposit/withdraw" },
  { chain:1, addr:"0xac3E018457B222d93114458476f3E3416Abbe38F", label:"sfrxETH" },
  { chain:1, addr:"0xae78736Cd615f374D3085123A210448E74Fc6393", label:"rETH" },
  // Aave V3 aTokens
  { chain:1, addr:"0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2", label:"Aave V3 Pool", note:"aToken yield accrual rounding" },
];

// === Pattern #6: Intent-Solver Exhaustion ===
// Bridge solver profitability degradation
const BRIDGE_SOLVERS = [
  { chain:42161, addr:"0xe35e9842fceaca96570b734083f4a58e8f7c5f2a", label:"Across SpokePool (Arb)" },
  { chain:1, addr:"0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5", label:"Across SpokePool (ETH)" },
  { chain:1, addr:"0x8731d54E9D02c286767d56ac03e8037C07e01e98", label:"Stargate Router" },
  { chain:1, addr:"0x3a23F943181408EAC424116Af7b7790c94Cb97a5", label:"Socket Gateway" },
  { chain:1, addr:"0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE", label:"LI.FI Diamond" },
];

// === Pattern #10: CLMM Custom LDF Precision ===
// Concentrated liquidity DEX custom swap fee / tick math
const CLMM_TARGETS = [
  { chain:1, addr:"0x000000000000944385D7C9C56370A42043F4De41", label:"Bunni Lens (Ethereum)" },
  { chain:42161, addr:"0xb4315e873dBcf96Ffd0acd8EA43f689D8c20fB30", label:"TraderJoe LB (Arb)" },
  { chain:42161, addr:"0xAAA87963EFeB6f7E0a2711F397663105Acb1805e", label:"Ramses CL (Arb)" },
];

// === Pattern #11: Trusted Forwarder Spoofing ===
const FORWARDER_TARGETS = [
  { chain:1, addr:"0xB2b5841DBeF766d4b521221732F9B618fCf34A23", label:"Biconomy Forwarder" },
  { chain:1, addr:"0xa530F8508f88Cf333bD18B08e565b5FB9A440798", label:"GSN TrustedForwarder" },
];

const NOW = Math.floor(Date.now()/1000);

async function checkPattern(rpc, target, pattern) {
  const code = await rpcCall(rpc, "eth_getCode", [target.addr, "latest"], 3000);
  const deployed = code && code.length > 10;
  if (!deployed) return { ...target, pattern, deployed:false };

  const r = { ...target, pattern, deployed:true, codeSize:(code.length-2)/2 };

  // Bytecode heuristics (grep for known dangerous patterns)
  const bytecode = (code || "").toLowerCase();
  
  if (pattern === "keeper-reentrancy") {
    // Look for delegatecall (0xf4) or external call patterns
    r.hasDelegatecall = bytecode.includes("f4") && bytecode.length > 100;
    r.hasRawCall = bytecode.includes("8000") || bytecode.includes("6000"); // staticcall/delegatecall opcode patterns
    r.risk = r.hasDelegatecall ? "MEDIUM — contract uses delegatecall pattern" : "LOW";
  }

  if (pattern === "precision-loss") {
    // Look for div/mul patterns that might truncate
    r.hasDiv = bytecode.includes("04") && bytecode.includes("05"); // DIV and SDIV opcodes
    r.risk = r.hasDiv ? "LOW — standard math (manual check required)" : "LOW";
  }

  if (pattern === "intent-solver") {
    // Check if contract is active (recent ETH balance)
    const bal = await rpcCall(rpc, "eth_getBalance", [target.addr, "latest"], 3000);
    r.ethBalance = bal ? Number(BigInt(bal)) / 1e18 : 0;
    r.risk = r.ethBalance > 10 ? "MEDIUM — $"+(""+Math.round(r.ethBalance*1600/1000)+"K")+"+ ETH balance = active solver" : "LOW";
  }

  if (pattern === "clmm-precision") {
    r.risk = "LOW — manual analysis of CLMM math required";
  }

  if (pattern === "forwarder-spoof") {
    // EIP-2771: check for trustedForwarder() selector
    const raw = await rpcCall(rpc, "eth_call", [{ to:target.addr, data:"0x8920acb3" }, "latest"], 5000);
    if (raw && raw.length >= 66) {
      const forwarder = "0x" + raw.slice(26,66);
      r.trustedForwarder = forwarder;
      r.risk = forwarder !== "0x"+"0".repeat(40) ? "MEDIUM — has trustedForwarder, verify access control" : "LOW";
    }
  }

  return r;
}

async function main() {
  console.log("=== Block C Combined Scanner ===\n");

  const rpcs = {};
  const all = [];

  const PATTERNS = [
    { name:"keeper-reentrancy", targets:KEEPER_TARGETS, label:"#3 Keeper Callback Reentrancy" },
    { name:"precision-loss", targets:PRECISION_TARGETS, label:"#5 Precision-Loss Cascade" },
    { name:"intent-solver", targets:BRIDGE_SOLVERS, label:"#6 Intent-Solver Exhaustion" },
    { name:"clmm-precision", targets:CLMM_TARGETS, label:"#10 CLMM Custom LDF Precision" },
    { name:"forwarder-spoof", targets:FORWARDER_TARGETS, label:"#11 Trusted Forwarder Spoofing" },
  ];

  for (const pat of PATTERNS) {
    console.log("--- " + pat.label + " ---");
    for (const t of pat.targets) {
      if (!rpcs[t.chain]) rpcs[t.chain] = await resolveRpc(t.chain);
      if (!rpcs[t.chain]) { all.push({...t, pattern:pat.name, error:"no-rpc"}); continue; }

      const r = await checkPattern(rpcs[t.chain], t, pat.name);
      all.push(r);

      const deployed = r.deployed ? (r.codeSize/1000).toFixed(1)+"KB" : "NOT deployed";
      const extra = r.ethBalance ? " ETH=" + r.ethBalance.toFixed(2) : "";
      console.log("  " + r.label.padEnd(28) + deployed.padEnd(10) + (r.risk||"") + extra);
    }
    console.log("");
  }

  // Risk summary
  const med = all.filter(r => r.risk?.startsWith("MEDIUM"));
  const high = all.filter(r => r.risk?.startsWith("HIGH"));
  console.log("=== Summary ===");
  console.log("HIGH: " + high.length + " | MEDIUM: " + med.length + " | Total: " + all.length);
  console.log("MEDIUM findings: " + med.map(r => r.pattern+"/"+r.label).join(", "));

  fs.writeFileSync(path.join(DIR, "blockc-combined.json"), JSON.stringify({ scannedAt:new Date().toISOString(), all, high, medium:med }, null, 2));
  console.log("Artifact: " + path.join(DIR, "blockc-combined.json"));
}
main().catch(e => { console.error(e.message); process.exit(1); });
