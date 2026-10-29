#!/usr/bin/env node
// Resolve the wsrUSD oracle 45-byte minimal proxy and check its implementation.

const { ethers } = require("ethers");
const { resolveRpc } = require("./shared-rpc");

const SELECTORS = {
  "convertToAssets(uint256)": "07a2d13a",
  "totalAssets()": "23452b30",
  "price()": "c688d24e",
  "totalSupply()": "18160ddd",
  "balanceOf(address)": "70a08231",
  "latestRoundData()": "feaf968c",
  "decimals()": "313ce567",
  "getPrice()": "5ac0a728",
  "getRate()": "3a4b45e0",
  "consult(uint256)": "bef392d4",
};

async function main() {
  const rpc = await resolveRpc(1);
  if (!rpc) { console.log("RPC unavailable"); process.exit(1); }
  const provider = new ethers.JsonRpcProvider(rpc, 1, { staticNetwork: true });

  const oracleAddr = "0x938D2eDb20425cF80F008E7ec314Eb456940Da15";
  const code = await provider.getCode(oracleAddr);
  
  console.log("wsrUSD oracle code:", code);
  console.log("code length:", (code.length - 2) / 2, "bytes");
  
  // Minimal proxy pattern (EIP-1167): 0x363d3d373d3d3d363d73<addr>5af43d82803e903d91602b57fd5bf3
  // Let's extract the implementation address
  const hex = code.slice(2);
  if (hex.length >= 80) {
    // Common minimal proxy patterns extract address bytes 10-30 (20 bytes after offset 10)
    const addrHex = hex.slice(20, 60); // bytes 10-30
    if (addrHex.length === 40) {
      try {
        const implAddr = ethers.getAddress("0x" + addrHex);
        console.log("\nExtracted implementation address:", implAddr);
        
        const implCode = await provider.getCode(implAddr);
        const implHex = implCode.slice(2).toLowerCase();
        console.log("Implementation code size:", implHex.length / 2, "bytes");
        
        const found = [];
        for (const [name, selector] of Object.entries(SELECTORS)) {
          const count = (implHex.match(new RegExp(selector, "g")) || []).length;
          if (count > 0) found.push({ selector, name, count });
        }
        console.log("\nImplementation selector hits:");
        for (const f of found) console.log(`  ${f.name}: ${f.count} hits`);
        
        // Also try calling the oracle to see what it returns
        console.log("\nTrying direct calls on oracle:");
        // Try price()
        try {
          const priceSel = "0xc688d24e"; // price()
          const raw = await provider.call({ to: oracleAddr, data: priceSel });
          console.log("  price() raw:", raw);
          if (raw && raw !== "0x") console.log("  price() value:", BigInt(raw).toString());
        } catch (e) { console.log("  price() failed:", e.message?.slice(0, 100)); }
        
        // Try calling implementation address functions
        console.log("\nTrying calls on implementation:");
        // Try convertToAssets with 1e18
        try {
          const ctas = "0x07a2d13a";
          const raw = await provider.call({ to: implAddr, data: ctas + "0000000000000000000000000000000000000000000000000de0b6b3a7640000" });
          console.log("  convertToAssets(1e18) raw:", raw);
        } catch (e) { console.log("  convertToAssets failed:", e.message?.slice(0, 100)); }
        
      } catch (e) {
        console.log("Could not extract address:", e.message);
      }
    }
  }
}

main().then(() => process.exit(0)).catch(err => { console.error(err.stack || err.message); process.exit(1); });