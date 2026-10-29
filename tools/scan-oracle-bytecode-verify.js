#!/usr/bin/env node
// Verify Morpho Blue oracle bytecode for convertToAssets/totalAssets usage.
// Read-only: fetches bytecode and searches for ERC4626 function selectors.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { resolveRpc } = require("./shared-rpc");

const OUT = path.join(__dirname, "..", "reports", "raw", "fast", "oracle-bytecode-verify-2026-06-28.json");

const ORACLES = [
  { label: "syrupUSDC->PYUSD", address: "0xc8043d248551Ed19B33cbc89dCCd69148c827039" },
  { label: "sUSDe->USDtb", address: "0x67BcC03438D7d71c39343d7AD21cb73Dc19aDB89" },
  { label: "wsrUSD->USDC", address: "0x938D2eDb20425cF80F008E7ec314Eb456940Da15" },
];

const SELECTORS = {
  "convertToAssets(uint256)": "07a2d13a",
  "totalAssets()": "23452b30",
  "price()": "c688d24e",
  "totalSupply()": "18160ddd",
  "balanceOf(address)": "70a08231",
  "convertToShares(uint256)": "aa5727fa",
  "latestRoundData()": "feaf968c",
  "decimals()": "313ce567",
  "version()": "54fd4d72",
  "description()": "f2c5c3a4",
};

async function main() {
  const rpc = await resolveRpc(1);
  if (!rpc) { console.log("RPC unavailable"); process.exit(1); }
  const provider = new ethers.JsonRpcProvider(rpc, 1, { staticNetwork: true });

  const results = [];
  for (const oracle of ORACLES) {
    const code = await provider.getCode(oracle.address).catch(() => "0x");
    const codeHex = code.slice(2).toLowerCase();
    const codeBytes = codeHex.length / 2;
    const found = [];
    for (const [name, selector] of Object.entries(SELECTORS)) {
      const count = (codeHex.match(new RegExp(selector, "g")) || []).length;
      if (count > 0) found.push({ selector, name, count });
    }
    // Check if it's a proxy
    const implSlot = "360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
    const implRaw = await provider.getStorage(oracle.address, "0x" + implSlot).catch(() => null);
    let implementation = null;
    if (implRaw && implRaw !== "0x" && !/^0x0+$/.test(implRaw)) {
      try { implementation = ethers.getAddress("0x" + implRaw.slice(-40)); } catch (_) {}
    }

    let implFound = [];
    if (implementation) {
      const implCode = await provider.getCode(implementation).catch(() => "0x");
      const implHex = implCode.slice(2).toLowerCase();
      for (const [name, selector] of Object.entries(SELECTORS)) {
        const count = (implHex.match(new RegExp(selector, "g")) || []).length;
        if (count > 0) implFound.push({ selector, name, count });
      }
      results.push({ ...oracle, codeBytes, isProxy: true, implementation, proxySelectorHits: found, implSelectorHits: implFound, implCodeBytes: implHex.length / 2 });
    } else {
      results.push({ ...oracle, codeBytes, isProxy: false, implementation: null, selectorHits: found });
    }
  }

  fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2) + "\n");

  console.log("\nOracle bytecode analysis:");
  for (const r of results) {
    const hits = r.isProxy ? r.implSelectorHits : r.selectorHits;
    const convertToAssets = hits.find(h => h.name === "convertToAssets(uint256)");
    const totalAssets = hits.find(h => h.name === "totalAssets()");
    const price = hits.find(h => h.name === "price()");
    console.log(`\n${r.label} (${r.address})`);
    console.log(`  proxy=${r.isProxy} impl=${r.implementation || "n/a"} codeBytes=${r.codeBytes}`);
    console.log(`  convertToAssets: ${convertToAssets ? convertToAssets.count + " hits" : "NOT FOUND"}`);
    console.log(`  totalAssets: ${totalAssets ? totalAssets.count + " hits" : "NOT FOUND"}`);
    console.log(`  price(): ${price ? price.count + " hits" : "NOT FOUND"}`);
    console.log(`  all hits: ${hits.map(h => h.name + "(" + h.count + ")").join(", ")}`);
  }
  console.log(`\nArtifact: ${OUT}`);
}

main().then(() => process.exit(0)).catch(err => { console.error(err.stack || err.message); process.exit(1); });