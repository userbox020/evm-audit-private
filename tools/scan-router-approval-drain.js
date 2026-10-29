#!/usr/bin/env node
// scan-router-approval-drain.js — Pattern #7: Router calldata Approval Drain
// Checks aggregator/bridge routers for unchecked approve → arbitrary target patterns
// $3.3M Socket loss, LI.FI/Squid/Bungee/XY similar risk surface
const { rpcCall, resolveRpc } = require("./shared-rpc");
const fs = require("fs"); const path = require("path");

const OUT = path.join(__dirname, "..", "reports", "raw", "fast", "router-approval-drain.json");

// Known routers with approval drain historical risk
const ROUTERS = [
  // LI.FI
  { chain:1, addr:"0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE", label:"LI.FI Diamond" },
  { chain:42161, addr:"0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE", label:"LI.FI Diamond (Arb)" },
  // Socket (Bungee)
  { chain:1, addr:"0x3a23F943181408EAC424116Af7b7790c94Cb97a5", label:"Socket Gateway" },
  // Squid Router
  { chain:1, addr:"0xce16F69375520ab01377ce7B88f5BA8C48F8D666", label:"Squid Router" },
  // XY Finance
  { chain:1, addr:"0x4315f344a905db17D0b6Fd517E3125a6ea0dc48a", label:"XY Router" },
  // Across (intent solver)
  { chain:1, addr:"0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5", label:"Across SpokePool" },
  { chain:42161, addr:"0xe35e9842fceaca96570b734083f4a58e8f7c5f2a", label:"Across SpokePool (Arb)" },
  // Wormhole Token Bridge
  { chain:1, addr:"0x3ee18B2214AFF97000D974cf647E7C347E8fa585", label:"Wormhole Token Bridge" },
  // Stargate
  { chain:1, addr:"0x8731d54E9D02c286767d56ac03e8037C07e01e98", label:"Stargate Router" },
  // 1inch Aggregation Router v5
  { chain:1, addr:"0x1111111254EEB25477B68fb85Ed929f73A960582", label:"1inch Router v5" },
  // 0x Exchange Proxy
  { chain:1, addr:"0xDef1C0ded9bec7F1a1670819833240f027b25EfF", label:"0x Exchange Proxy" },
  // Odos Router v2
  { chain:1, addr:"0xCf5540fFFCdC3d510B18bFcA6d2b9987b0772559", label:"Odos Router v2" },
  // ParaSwap
  { chain:1, addr:"0xDEF171Fe48CF0115B1d80b88dc8eAB59176FEe57", label:"ParaSwap Augustus" },
  // OpenOcean
  { chain:1, addr:"0x6352a56caaDC4F1E25CD6c75970Fa768A3304e64", label:"OpenOcean Router" },
];

function encodeAddr(a) { return "0".repeat(24) + a.slice(2).toLowerCase(); }

async function checkRouter(rpc, router, chainId) {
  const r = { ...router, chain: chainId, deployed: false, methods: [] };

  // 1. Deployment check
  const code = await rpcCall(rpc, "eth_getCode", [router.addr, "latest"], 5000);
  if (!code || code === "0x" || code.length < 10) {
    r.deployed = false;
    return r;
  }
  r.deployed = true;
  r.bytecodeSize = (code.length - 2) / 2;

  // 2. Check storage: owner/admin (slot 0 typically)
  const ownerSlot = await rpcCall(rpc, "eth_getStorageAt", [router.addr, "0x" + "0".repeat(64), "latest"], 5000);
  if (ownerSlot && ownerSlot.length >= 66) {
    const ow = "0x" + ownerSlot.slice(26, 66);
    if (ow !== "0x" + "0".repeat(40)) r.owner = ow;
  }

  // 3. Probe for known approval-drain selectors
  // These patterns indicate risk: generic call forwarding, unchecked approve, delegatecall without validation
  const PROBES = [
    { sig:"0x82604779", name:"sweepTokens(address,address,address,uint256)" },  // sweeps user tokens
    { sig:"0xd0e30db0", name:"deposit()" },                                   // accepts raw ETH
    { sig:"0x095ea7b3", name:"approve(address,uint256)" },                    // internal approve
    { sig:"0x23b872dd", name:"transferFrom(address,address,uint256)" },       // move user tokens
    { sig:"0xf242432a", name:"safeTransferFrom()" },                          // ERC1155 transfer
  ];

  for (const p of PROBES) {
    // Check if selector exists in bytecode
    if (code && code.includes(p.sig.slice(2))) {
      r.methods.push(p.name);
    }
  }

  // 4. Risk scoring
  const hasSweep = r.methods.some(m => m.includes("sweep"));
  const hasDeposit = r.methods.some(m => m.includes("deposit"));
  const hasTransferFrom = r.methods.some(m => m.includes("transferFrom") || m.includes("safeTransferFrom"));
  const hasApprove = r.methods.some(m => m.includes("approve"));

  // Risk: router that can approve AND transfer from arbitrary addresses without proper access control
  const proxyUpgrade = code && code.includes("360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"); // ERC1967 impl slot
  r.isProxy = !!proxyUpgrade;

  r.risk = "LOW — no dangerous selectors found";
  if (hasSweep) r.risk = "HIGH — has sweepTokens() — could drain approved tokens";
  else if (hasTransferFrom && hasApprove && hasDeposit) r.risk = "MEDIUM — transferFrom + approve + deposit detected";
  else if (hasTransferFrom && hasDeposit) r.risk = "LOW-MED — transferFrom + deposit pattern";
  else if (r.isProxy) r.risk = "LOW — upgradeable proxy (owner upgrade risk)";
  if (r.methods.length === 0) r.risk = "LOW — no risky selectors in bytecode";

  return r;
}

async function main() {
  console.log("=== Router Approval Drain Scanner (Pattern #7) ===\n");
  console.log("Checking " + ROUTERS.length + " routers for dangerous selector patterns...\n");

  const results = [];
  const rpcs = {};

  for (const router of ROUTERS) {
    if (!rpcs[router.chain]) {
      rpcs[router.chain] = await resolveRpc(router.chain);
      if (!rpcs[router.chain]) { results.push({ ...router, error:"no-rpc" }); continue; }
    }
    const r = await checkRouter(rpcs[router.chain], router, router.chain);
    results.push(r);
    
    const deployed = r.deployed ? "DEPLOYED " + (r.bytecodeSize/1000).toFixed(1) + "KB" : "NOT deployed";
    const methods = r.methods.length ? " [" + r.methods.join(", ") + "]" : "";
    console.log(r.label.padEnd(22) + deployed + methods);
    if (r.owner) console.log("  Owner: " + r.owner);
    if (r.risk !== "LOW — no dangerous selectors found") console.log("  RISK: " + r.risk);
  }

  const high = results.filter(r => r.risk?.startsWith("HIGH"));
  const med = results.filter(r => r.risk?.startsWith("MEDIUM"));
  console.log("\n=== Summary ===");
  console.log("HIGH risk: " + high.length + " | MEDIUM: " + med.length);
  if (high.length) console.log("HIGH routers: " + high.map(r => r.label).join(", "));
  console.log("Deployed: " + results.filter(r => r.deployed).length + "/" + ROUTERS.length);
  console.log("\nAttack vector: router's sweepTokens/transferFrom can drain user-approved tokens via malicious calldata");

  fs.writeFileSync(OUT, JSON.stringify({ scannedAt: new Date().toISOString(), results, high, medium: med }, null, 2));
  console.log("Artifact: " + OUT);
}
main().catch(e => { console.error(e.message); process.exit(1); });
