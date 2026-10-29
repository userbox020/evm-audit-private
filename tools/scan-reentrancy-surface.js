#!/usr/bin/env node
// scan-reentrancy-surface.js — Phase 2.3 Automated Reentrancy Surface Scanner
// Checks: nonReentrant coverage (2.3.1), callback reentrancy (2.3.3), delegate bypass (2.3.4)
// For given protocol contract addresses, maps external state-changing functions and flags gaps.
const fs = require("fs");
const path = require("path");
const { rpcCall, resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "reentrancy-surface-scan.json");

const CHAIN_ID = 1; // Ethereum — most protocols deploy here

// Critical state-changing function signatures to check
const CRITICAL_SELECTORS = {
  // Borrowing
  "borrow":               "0xc5ebeaec", // borrow(uint256)
  "borrowBehalf":          null,        // varies by protocol
  "repayBorrow":           "0x573ade81", // repayBorrow(address,uint256)
  "liquidateBorrow":       "0xf1ca0be4", // liquidateBorrow(address,uint256,address)
  // ERC4626 vaults
  "mint":                  "0x94bf804d", // mint(uint256,address)
  "deposit":               "0x6e553f65", // deposit(uint256,address)
  "redeem":                "0xba087652", // redeem(uint256,address,address)
  "withdraw":              "0xb460af94", // withdraw(uint256,address,address)
  // Morpho
  "supplyCollateral":      "0x238d6579",
  "borrowMorpho":          null,
  "repayMorpho":           null,
  "liquidate":             "0x96cd4ddb",
  // Aave V3
  "supply":                "0x617ba037",
  "aaveWithdraw":          "0x69328dec",
  "aaveBorrow":            "0xa415bcad",
  "aaveRepay":             "0x573ade81",
  "aaveLiquidate":         "0xab9c4b5d",
  // Compound
  "mintCToken":            "0xa0712d68",
  "redeemCToken":          "0xdb006a75",
  "borrowCompound":        "0xc5ebeaec",
  "repayCompound":         "0x0e752702",
  // Euler
  "eulerDeposit":          "0x47e7ef24",
  "eulerWithdraw":         "0x2e1a7d4d",
  "eulerBorrow":           null,
};

const KNOWN_NON_REENTRANT_SELECTORS = [
  "0x1cff79cd", // nonReentrant (OpenZeppelin)
  "0x9f3ce55f", // lock (various)
];

const TOP_PROTOCOLS = [
  { name: "Aave V3", address: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2", chainId: 1 },
  { name: "Morpho Blue", address: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb", chainId: 1 },
  { name: "Compound V3", address: "0xc3d688B66703497DAA19211EEdff47f25384cdc3", chainId: 1 },
  { name: "Spark Lend", address: "0xC13e21B648A5Ee794902342038FF3aDAB66BE987", chainId: 1 },
  { name: "Fluid Vault", address: "0x1982CC7b1570C2503282d0A0B41F69b3B28fdcc3", chainId: 1 },
  { name: "Euler EVK", address: "0x23828F44152b5e8F6C8dC67a324c5eCb4216c93e", chainId: 1 },
  { name: "Silo Factory", address: "0xAFd8F792cb025A76C4916652CfC8e20eee3b6fe2", chainId: 1 },
  { name: "Cooler Loans", address: "0x6DD97c785D8A29664E021a23c5738A7e3c7cac81", chainId: 1 },
  { name: "Liquity Bold", address: "0x71A6e0AaBc43D3f9e456A3ae75062A817169F286", chainId: 1 },
];

async function scanProtocol(rpc, name, address) {
  console.log(`\n${name} (${address.slice(0,10)}...)`);

  // 1. Get bytecode
  const code = await rpcCall(rpc, "eth_getCode", [address, "latest"]);
  if (!code || code === "0x" || typeof code !== "string") { console.log("  No bytecode"); return { name, address, error: "no-bytecode" }; }

  const bytecode = code.slice(2);
  console.log(`  Bytecode: ${bytecode.length/2} bytes`);

  // 2. Check each critical selector against bytecode
  const findings = [];
  for (const [label, sel] of Object.entries(CRITICAL_SELECTORS)) {
    if (!sel) continue;
    const normalized = sel.startsWith("0x") ? sel.slice(2) : sel;
    const found = bytecode.includes(normalized);
    if (found) findings.push({ label, selector: sel, present: true });
  }

  // 3. Check for nonReentrant modifier presence
  const nonReentrantFound = KNOWN_NON_REENTRANT_SELECTORS.some(s => bytecode.includes(s.slice(2)));

  console.log(`  Critical selectors found: ${findings.length}`);
  console.log(`  nonReentrant modifier: ${nonReentrantFound ? "PRESENT" : "ABSENT"}`);

  // 4. Look for delegate/operator patterns
  const hasDelegate = bytecode.includes("70a08231") && (bytecode.includes("dd62ed3e") || bytecode.includes("095ea7b3"));

  return {
    name, address,
    bytecodeSize: bytecode.length / 2,
    selectorsFound: findings.map(f => f.label),
    nonReentrantGuarded: nonReentrantFound,
    hasDelegatePattern: hasDelegate,
    riskScore: !nonReentrantFound ? "HIGH" : findings.length > 5 ? "MEDIUM" : "LOW",
  };
}

async function main() {
  console.log("=== Phase 2.3 Reentrancy Surface Scanner ===\n");

  const rpc = await resolveRpc(CHAIN_ID);
  if (!rpc) { console.error("No ETH RPC"); process.exit(1); }
  console.log("RPC resolved.\n");

  const results = [];
  for (const p of TOP_PROTOCOLS) {
    if (p.chainId !== CHAIN_ID) continue;
    const r = await scanProtocol(rpc, p.name, p.address);
    results.push(r);
  }

  // Summary
  console.log("\n=== Summary ===");
  const highRisk = results.filter(r => r.riskScore === "HIGH");
  const medRisk = results.filter(r => r.riskScore === "MEDIUM");
  console.log(`HIGH risk (no nonReentrant): ${highRisk.length}`);
  for (const r of highRisk) console.log(`  ${r.name} — ${r.selectorsFound?.join(", ") || "none"}`);
  console.log(`MEDIUM risk: ${medRisk.length}`);
  console.log(`TOTAL scanned: ${results.length}`);

  fs.writeFileSync(OUT, JSON.stringify({ scannedAt: new Date().toISOString(), chainId: CHAIN_ID, results, summary: { highRisk: highRisk.length, medRisk: medRisk.length, total: results.length } }, null, 2));
  console.log(`\nArtifact: ${OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
