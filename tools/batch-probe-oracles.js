#!/usr/bin/env node
// batch-probe-oracles.js — Probe oracle type for all new targets simultaneously
const { rpcCall, resolveRpc } = require("./shared-rpc");
const fs = require("fs"); const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");

// Known addresses from DeFiLlama adapters + our research
const TARGETS = [
  // Avalon USDa (probed, DEAD)
  { name:"Avalon USDa", chain:1, addr:"0x6d425B3D302DD82cC611866eC8176d435307b616", note:"Manager" },
  // Curve LlamaLend
  { name:"LlamaLend", chain:1, addr:"0xeA6876DDE9e3467564acBeE1Ed5bac88783205E0", note:"View" },
  // Homora V2 (probed, BLOCKED)  
  { name:"HomoraV2", chain:1, addr:"0xa1faa113cbe53436df28ff0aee54275c13b40975", note:"Bank" },
  // Native Credit Pool
  { name:"Native Credit", chain:1, addr:"0xe3D41d19564922C9952f692C5Dd0563030f5f2EF", note:"Vault" },
  { name:"Native Credit", chain:8453, addr:"0x74a4Cd023e5AfB88369E3f22b02440F2614a1367", note:"Vault Base" },
  // Templar Protocol — need to find address
  { name:"Templar", chain:1, addr:"0x000000000000000000000000000000000000dEaD", note:"UNKNOWN — need GitHub" },
  // EtherFi Borrowing
  { name:"EtherFi Borrow", chain:1, addr:"0x1b7b8f6b258f95cf9596eabB9aa18B62940Eb0a8", note:"Known from triage" },
  // Seamless V2
  { name:"Seamless V2", chain:8453, addr:"0x000000000000000000000000000000000000dEaD", note:"UNKNOWN" },
  // Lazy Summer (Summer.fi)
  { name:"Summer.fi", chain:1, addr:"0x000000000000000000000000000000000000dEaD", note:"UNKNOWN" },
  // Origami Finance
  { name:"Origami", chain:1, addr:"0x000000000000000000000000000000000000dEaD", note:"UNKNOWN" },
];

// Oracle selectors to scan for
const ORACLE_SELECTORS = {
  "Chainlink latestRoundData": "0xfeaf968c",
  "Chainlink decimals": "0x313ce567",
  "Pyth getPriceUnsafe": "0x96834ad3",
  "Pyth getPriceNoOlder": "0x41da4bb7",
  "Pyth updatePriceFeeds": "0xef9e5e28",
  "RedStone getOracle": "0x0c1c8e3e",
  "RedStone Primary": "PrimaryProdDataService",
  "API3 read": "0x57de26a4",
  "Chronicle read": "0x57de26a4",
  "TWAP observe": "observe",
  "TWAP consult": "consult",
  "Keep3r": "Keep3r",
  "Uni price0Cumulative": "price0CumulativeLast",
  "Morpho IOracle.price": "0xa035b1fe",
};

async function main() {
  console.log("=== Batch Oracle Probe — " + TARGETS.length + " targets ===\n");
  console.log("Scanning for oracle selector patterns in bytecode...\n");
  
  const rpcs = {};
  const results = [];
  
  for (const t of TARGETS) {
    if (t.addr === "0x000000000000000000000000000000000000dEaD") {
      results.push({ ...t, status:"NO ADDRESS", oracle:"?" });
      continue;
    }
    
    if (!rpcs[t.chain]) rpcs[t.chain] = await resolveRpc(t.chain);
    if (!rpcs[t.chain]) { results.push({ ...t, status:"NO RPC", oracle:"?" }); continue; }
    
    const rpc = rpcs[t.chain];
    const code = await rpcCall(rpc, "eth_getCode", [t.addr, "latest"], 5000);
    if (!code || code.length < 10) {
      results.push({ ...t, status:"NOT DEPLOYED", oracle:"?" });
      console.log(`${t.name.padEnd(20)} ${t.addr.slice(0,10)}... NOT deployed`);
      continue;
    }
    
    // Scan for oracle selectors
    const found = [];
    for (const [name, pattern] of Object.entries(ORACLE_SELECTORS)) {
      if (pattern.startsWith("0x")) {
        if (code.toLowerCase().includes(pattern.slice(2).toLowerCase())) found.push(name);
      } else {
        if (code.includes(pattern)) found.push(name);
      }
    }
    
    const kb = ((code.length - 2) / 2 / 1000).toFixed(1);
    const oracleType = found.length > 0 ? found.join(", ") : "CUSTOM/UNKNOWN";
    
    results.push({ ...t, status:"LIVE " + kb + "KB", oracle:oracleType, selectors:found });
    console.log(`${t.name.padEnd(20)} ${t.addr.slice(0,10)}... ${kb}KB | ${oracleType}`);
  }
  
  // Summary
  const liveTargets = results.filter(r => r.status?.startsWith("LIVE"));
  const chainlinkTargets = results.filter(r => r.oracle?.includes("Chainlink"));
  const pythTargets = results.filter(r => r.oracle?.includes("Pyth"));
  const redstoneTargets = results.filter(r => r.oracle?.includes("RedStone"));
  const customTargets = results.filter(r => r.oracle === "CUSTOM/UNKNOWN");
  
  console.log(`\n=== Summary ===`);
  console.log(`Live targets: ${liveTargets.length}/${TARGETS.length}`);
  console.log(`Chainlink: ${chainlinkTargets.length}`);
  console.log(`Pyth pull: ${pythTargets.length}`);
  console.log(`RedStone pull: ${redstoneTargets.length}`);
  console.log(`Custom/Unknown (highest risk): ${customTargets.length}`);
  
  if (customTargets.length > 0) {
    console.log(`\nCustom/Unknown oracle targets (needs source review):`);
    for (const t of customTargets) console.log(`  ${t.name} (${t.note}) — ${t.status}`);
  }
  
  fs.mkdirSync(path.join(WORKSPACE, "reports", "raw", "fast"), { recursive: true });
  fs.writeFileSync(path.join(WORKSPACE, "reports", "raw", "fast", "batch-oracle-probe.json"),
    JSON.stringify({ scannedAt: new Date().toISOString(), results }, null, 2));
}
main().catch(e => { console.error(e.message); process.exit(1); });
