#!/usr/bin/env node
// scan-native-gateway.js — Phase 2.6 Native Token Gateway Scanner
// Checks: wrapAndSupply/borrowAndUnwrap/redeemAndUnwrap/wrapAndRepay flows for reentrancy gaps
const fs = require("fs");
const path = require("path");
const { rpcCall, resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "native-gateway-scan.json");
const CHAIN_ID = 1;

// Known native gateways on Ethereum
const GATEWAYS = [
  { name: "Compound Bulker", addr: "0xa397a8C2086C554B531c02E29f3291c9704B00c7", selector: "0xb9d1db9c" },
  { name: "Aave V3 WETH Gateway", addr: "0x893411580e590D62dDBca8a703d61Cc4A8c7b2b9", selector: "0xd0ce30ae" },
  { name: "Morpho WETH Wrapper", addr: "0x78D8b7a0B0DEF08ec1FDe011BD9244d8dFa573d9", selector: null },
];

// Critical gateway functions to check
const GATEWAY_SELECTORS = {
  "wrapAndSupply":   null, // varies per protocol
  "borrowAndUnwrap": null,
  "redeemAndUnwrap": null,
  "wrapAndRepay":    null,
  "sweep":           null,
};

// Standard selectors that indicate native ETH handling
const ETH_HANDLERS = [
  "0xd0e30db0", // deposit() — WETH
  "0x2e1a7d4d", // withdraw(uint256) — WETH
  "0x1249c58b", // mint() — common
  "0xd0ce30ae", // depositETH(address) — Aave WETH Gateway
  "0x474cf53d", // borrowETH(address,uint256,uint16) — Aave WETH Gateway
  "0xab9c4b5d", // liquidateCall(address,address,address,uint256,bytes) — Aave
  "0xfec4f4c9", // repayETH(address,uint256,uint16,address) — Aave WETH Gateway
];

async function ethGetCode(rpc, addr) {
  const code = await rpcCall(rpc, "eth_getCode", [addr, "latest"]);
  if (!code || code === "0x" || typeof code !== "string") return null;
  return code.slice(2);
}

async function main() {
  console.log("=== Phase 2.6 Native Gateway Scanner ===\n");

  const rpc = await resolveRpc(CHAIN_ID);
  if (!rpc) { console.error("No ETH RPC"); process.exit(1); }

  const results = [];

  for (const gw of GATEWAYS) {
    console.log(`${gw.name} (${gw.addr.slice(0,10)}...)`);
    const bytecode = await ethGetCode(rpc, gw.addr);
    if (!bytecode) {
      console.log("  No bytecode — proxy or not deployed");
      results.push({ name: gw.name, address: gw.addr, status: "no-bytecode" });
      continue;
    }
    console.log(`  Bytecode: ${bytecode.length/2} bytes`);

    // Check for ETH-handling selectors
    const ethSelectors = ETH_HANDLERS.filter(s => bytecode.includes(s.slice(2)));
    console.log(`  ETH handlers found: ${ethSelectors.length}`);

    // Check for nonReentrant/lock modifier
    const hasReentrancyGuard = bytecode.includes("1cff79cd") || bytecode.includes("9f3ce55f");
    console.log(`  Reentrancy guard: ${hasReentrancyGuard ? "PRESENT" : "ABSENT"}`);

    // Check for sweep function
    const hasSweep = bytecode.includes("16f0115b") || bytecode.includes("d0e30db0"); // rough check
    console.log(`  Sweep capability: ${hasSweep ? "POSSIBLE" : "not found"}`);

    const risk = !hasReentrancyGuard ? "HIGH" : "LOW";
    results.push({ name: gw.name, address: gw.addr, bytecodeSize: bytecode.length/2, ethSelectors, hasReentrancyGuard, risk });
    if (risk === "HIGH") console.log(`  RISK: No reentrancy guard — native ETH gateway susceptible to reentrancy`);
  }

  console.log("\n=== Summary ===");
  const highRisk = results.filter(r => r.risk === "HIGH");
  console.log(`HIGH risk: ${highRisk.length}`);
  for (const r of highRisk) console.log(`  ${r.name} — no reentrancy guard, ${r.ethSelectors?.length || 0} ETH handlers in bytecode`);

  fs.writeFileSync(OUT, JSON.stringify({ scannedAt: new Date().toISOString(), results, highRiskCount: highRisk.length }, null, 2));
  console.log(`\nArtifact: ${OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
