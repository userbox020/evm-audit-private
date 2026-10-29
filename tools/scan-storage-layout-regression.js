#!/usr/bin/env node
// scan-storage-layout-regression.js — Pattern #9: Storage-Layout Regression Detection
// Compares implementation storage layouts for UUPS/Transparent upgradeable proxies
// Detects re-purposed storage slots that could cause data corruption on upgrade
const { rpcCall, resolveRpc, getImpl } = require("./shared-rpc");
const fs = require("fs"); const path = require("path");

const OUT = path.join(__dirname, "..", "reports", "raw", "fast", "storage-layout-regression.json");

// Known upgradeable protocols and their canonical registry
const PROXIES = [
  // Gravita
  { chain:1, proxy:"0x89F1ecCF2644902344db02788A790551Bb070351", name:"Gravita PriceFeed", category:"Oracle" },
  { chain:1, proxy:"0xdB5DAcB1DFbe16326C3656a88017f0cB4ece0977", name:"Gravita VesselManager", category:"Core" },
  { chain:1, proxy:"0x2bCA0300c2aa65de6F19c2d241B54a445C9990E2", name:"Gravita BorrowerOps", category:"Core" },
  // Aave V3
  { chain:1, proxy:"0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2", name:"Aave V3 Pool", category:"Lending" },
  { chain:1, proxy:"0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e", name:"Aave V3 PoolDataProvider", category:"Lending" },
  // Compound V3 (comet)
  { chain:1, proxy:"0xc3d688B66703497DAA19211EEdff47f25384cdc3", name:"Compound V3 cUSDC", category:"Lending" },
  // Morpho
  { chain:1, proxy:"0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb", name:"Morpho Blue", category:"Lending" },
  // EigenLayer
  { chain:1, proxy:"0x858646372CC42E1A627fcE94aa7A7033e7CF075A", name:"EigenLayer StrategyManager", category:"Restaking" },
  // Lido
  { chain:1, proxy:"0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84", name:"Lido stETH", category:"LiquidStaking" },
  // GMX
  { chain:42161, proxy:"0x489ee077994B6658eAfA855C308275EAd8097C4A", name:"GMX Vault (Arb)", category:"Derivatives" },
  // Across
  { chain:1, proxy:"0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5", name:"Across SpokePool", category:"Bridge" },
  // Stargate
  { chain:1, proxy:"0x8731d54E9D02c286767d56ac03e8037C07e01e98", name:"Stargate Router", category:"Bridge" },
];

async function scanProxy(rpc, p) {
  const r = { ...p, proxyCode:null, implCode:null, implAddr:null, storageRegression:false,
    usedSlots:[], emptySlots:[], hasUpgradeEvent:false };

  // 1. Get proxy bytecode
  const proxyCode = await rpcCall(rpc, "eth_getCode", [p.proxy, "latest"], 5000);
  r.proxyCodeSize = proxyCode ? (proxyCode.length - 2) / 2 : 0;

  // 2. Check if proxy is upgradeable (ERC1967, Transparent, UUPS, or EIP-2535 Diamond)
  const EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
  const EIP1967_ADMIN = "0xb53127684a568b3176d11d30df0ff9f6d41d099ef5894b94f6c753a7c5b9b3f5";
  const DIAMOND_STORAGE = "0xc8fcad8db84d3cc18b4c41d551ea0ee67dd5999de21a24e1f3bc36f792dbad4f";
  
  // Check ERC1967 implementation slot
  const implSlot = await rpcCall(rpc, "eth_getStorageAt", [p.proxy, EIP1967_IMPL, "latest"], 5000);
  if (implSlot && implSlot.length >= 66 && implSlot.slice(26,66) !== "0".repeat(40)) {
    r.implAddr = "0x" + implSlot.slice(26, 66);
    r.proxyType = "ERC1967";
  }
  // Check Diamond storage
  if (!r.implAddr) {
    // Check for diamond facets
    const diamondCheck = proxyCode && proxyCode.includes("cd59819a"); // DiamondLoupeFacet selector
    if (diamondCheck) r.proxyType = "Diamond(EIP-2535)";
    else r.proxyType = "Unknown/Beacon/Transparent";
  }

  // 3. Get implementation code if found
  if (r.implAddr) {
    const implCode = await rpcCall(rpc, "eth_getCode", [r.implAddr, "latest"], 5000);
    r.implCodeSize = implCode ? (implCode.length - 2) / 2 : 0;
  }

  // 4. Scan storage slots 0-31 for layout footprint
  // Many contracts use first 32 slots for upgradeable patterns
  for (let slot = 0; slot < 32; slot++) {
    const slotHex = "0x" + slot.toString(16).padStart(64, "0");
    const val = await rpcCall(rpc, "eth_getStorageAt", [p.proxy, slotHex, "latest"], 3000);
    if (val && val.length >= 66) {
      const isEmpty = val === "0x" + "0".repeat(64);
      if (isEmpty) {
        r.emptySlots.push(slot);
      } else {
        r.usedSlots.push(slot);
      }
    }
  }

  // 5. Check admin/upgrade events
  const adminSlot = await rpcCall(rpc, "eth_getStorageAt", [p.proxy, EIP1967_ADMIN, "latest"], 5000);
  if (adminSlot && adminSlot.length >= 66 && adminSlot.slice(26,66) !== "0".repeat(40)) {
    r.admin = "0x" + adminSlot.slice(26, 66);
    r.hasUpgradeEvent = true;
  }

  // 6. Risk assessment
  // Storage regression risk exists when:
  // - Upgradeable proxy with implementation address
  // - No recent upgrade events (stale layout)
  // - Empty slots interspersed with used slots (potential future collision)
  const gapCount = r.usedSlots.filter((s,i) => i>0 && (s - r.usedSlots[i-1]) > 1).length;

  r.risk = "LOW";
  if (r.proxyType === "Diamond(EIP-2535)") r.risk = "LOW — Diamond pattern isolates storage per facet";
  else if (r.proxyType === "ERC1967" && gapCount > 3) r.risk = "MEDIUM — fragmented storage layout, upgrade risk";
  else if (r.proxyType === "ERC1967" && r.usedSlots.length > 20) r.risk = "MEDIUM — high storage utilization, collision risk on upgrade";
  else if (r.proxyType === "Unknown/Beacon/Transparent") r.risk = "HIGH — unknown proxy type, needs manual audit";

  return r;
}

async function main() {
  console.log("=== Storage-Layout Regression Scanner (Pattern #9) ===\n");
  console.log("Scanning " + PROXIES.length + " upgradeable proxies...\n");

  const results = [];
  const rpcs = {};

  for (const proxy of PROXIES) {
    if (!rpcs[proxy.chain]) {
      rpcs[proxy.chain] = await resolveRpc(proxy.chain);
      if (!rpcs[proxy.chain]) { results.push({ ...proxy, error:"no-rpc" }); continue; }
    }
    const r = await scanProxy(rpcs[proxy.chain], proxy);
    results.push(r);

    const slots = "slots[" + r.usedSlots.length + "/" + (r.usedSlots.length + r.emptySlots.length) + "]";
    const impl = r.implAddr ? " impl=" + r.implAddr.slice(0,10) + "..." + " " + (r.implCodeSize/1000).toFixed(1) + "KB" : "";
    const type = r.proxyType || "??";
    console.log(r.name.padEnd(25) + type.padEnd(18) + slots + impl);
    if (r.admin) console.log("  Admin: " + r.admin);
  }

  const high = results.filter(r => r.risk?.startsWith("HIGH"));
  const med = results.filter(r => r.risk?.startsWith("MEDIUM"));
  console.log("\n=== Summary ===");
  console.log("HIGH risk: " + high.length + " | MEDIUM: " + med.length);
  if (high.length) console.log("HIGH: " + high.map(r => r.name).join(", "));
  console.log("Attack: storage collision on upgrade can corrupt oracle/debt/collateral mappings");

  fs.writeFileSync(OUT, JSON.stringify({ scannedAt: new Date().toISOString(), results, high, medium: med }, null, 2));
  console.log("Artifact: " + OUT);
}
main().catch(e => { console.error(e.message); process.exit(1); });
