#!/usr/bin/env node
const { ethers } = require("ethers");
const { resolveRpc } = require("./shared-rpc");
const fs = require("fs");
const j = JSON.parse(fs.readFileSync("reports/raw/fast/consumer-first-high-ltv-collateral.json", "utf8"));
let all = [];
j.results.forEach(r => { if (r.topRows) all = all.concat(r.topRows); });
const vaults = [...new Set(all.filter(r => r.chainId === 1 && r.collateral?.address).map(r => r.collateral.address))];
console.log("Scanning", vaults.length, "Ethereum ERC4626 vaults");

const r = resolveRpc(1).then(async (rpc) => {
  const p = new ethers.JsonRpcProvider(rpc, 1, { staticNetwork: true });
  const iface = new ethers.Interface([
    "function totalAssets() view returns (uint256)",
    "function symbol() view returns (string)",
  ]);
  const small = [];
  for (const addr of vaults) {
    try {
      const raw = await p.call({ to: addr, data: iface.encodeFunctionData("totalAssets") });
      const ta = iface.decodeFunctionResult("totalAssets", raw)[0];
      const taNum = Number(ethers.formatUnits(ta, 18));
      if (taNum < 10000) {
        try {
          const sRaw = await p.call({ to: addr, data: iface.encodeFunctionData("symbol") });
          const sym = iface.decodeFunctionResult("symbol", sRaw)[0];
          small.push({ sym, taNum });
        } catch (_) { small.push({ sym: "?", taNum }); }
      }
    } catch (e) { /* skip */ }
  }
  small.sort((a, b) => a.taNum - b.taNum);
  console.log("\nVery small vaults (<$10K totalAssets):", small.length);
  small.forEach(s => console.log("  " + s.sym + " $" + s.taNum.toFixed(2)));
  process.exit(0);
});