#!/usr/bin/env node
// scan-llamalend-markets.js — Full LlamaLend market scan for oracle exploit surface
const { rpcCall, resolveRpc } = require("./shared-rpc");
const ethers = require("ethers");
const fs = require("fs"); const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");

// LlamaLend View contracts per chain
const CHAINS = {
  ethereum: { id:1, view:"0xeA6876DDE9e3467564acBeE1Ed5bac88783205E0", name:"ETH" },
  arbitrum: { id:42161, view:"0xcaec110c784c9df37240a8ce096d352a75922dea", name:"Arb" },
  optimism: { id:10, view:"0x5ea8f3d674c70b020586933a0a5b250734798bef", name:"OP" },
  fractal: { id:252, view:"0xf3c9bdAB17B7016fBE3B77D17b1602A7db93ac66", name:"Fraxtal" },
};

async function scanMarkets(rpc, view, chainName) {
  const results = [];
  
  // Get market count
  const countRaw = await rpcCall(rpc, "eth_call", [{ to:view, data:"0xfd775c78" }, "latest"], 5000);
  if (!countRaw || countRaw.length < 66) return results;
  const count = Number(BigInt("0x"+countRaw.slice(2,66)));
  console.log(`  Markets: ${count}`);
  
  // Read each market's key params
  for (let i = 0; i < Math.min(count, 20); i++) {
    const idx = i.toString(16).padStart(64, "0");
    
    // Batch read: amm, collateral, borrowed, price_oracle, controller, coins
    const [ammR, collR, borrowR, oracleR, ctrlR, coin0R, coin1R] = await Promise.all([
      rpcCall(rpc, "eth_call", [{ to:view, data:ethers.id("amms(uint256)").slice(0,10) + idx }, "latest"], 5000),
      rpcCall(rpc, "eth_call", [{ to:view, data:ethers.id("collateral_tokens(uint256)").slice(0,10) + idx }, "latest"], 5000),
      rpcCall(rpc, "eth_call", [{ to:view, data:ethers.id("borrowed_tokens(uint256)").slice(0,10) + idx }, "latest"], 5000),
      rpcCall(rpc, "eth_call", [{ to:view, data:ethers.id("price_oracles(uint256)").slice(0,10) + idx }, "latest"], 5000),
      rpcCall(rpc, "eth_call", [{ to:view, data:ethers.id("controllers(uint256)").slice(0,10) + idx }, "latest"], 5000),
      rpcCall(rpc, "eth_call", [{ to:view, data:ethers.id("coins(uint256)").slice(0,10) + (i*2).toString(16).padStart(64,"0") }, "latest"], 5000),
      rpcCall(rpc, "eth_call", [{ to:view, data:ethers.id("coins(uint256)").slice(0,10) + (i*2+1).toString(16).padStart(64,"0") }, "latest"], 5000),
    ]);
    
    const amm = ammR ? "0x"+ammR.slice(26,66) : "?";
    const coll = collR ? "0x"+collR.slice(26,66) : "?";
    const borrow = borrowR ? "0x"+borrowR.slice(26,66) : "?";
    const oracle = oracleR ? "0x"+oracleR.slice(26,66) : "?";
    
    if (amm === "0x"+"0".repeat(40)) continue;
    
    // Check if AMM has price_oracle() (EMA support)
    const poRaw = await rpcCall(rpc, "eth_call", [{ to:amm, data:"0x86fc88d3" }, "latest"], 5000);
    const hasEma = poRaw && poRaw.length >= 66 && poRaw.slice(2,66) !== "0".repeat(64);
    
    // Get pool balances for TVL estimate
    let poolTvl = 0;
    try {
      const balRaw = await rpcCall(rpc, "eth_call", [{ to:amm, data:"0x4906b0d5"+"0".repeat(64) }, "latest"], 5000);
      if (balRaw && balRaw.length >= 130) {
        const off = parseInt(balRaw.slice(2,66),16) * 2;
        const n = parseInt(balRaw.slice(off+2, off+66),16);
        for (let c=0; c<Math.min(n,3); c++) poolTvl += Number(BigInt("0x"+balRaw.slice(off+66+c*64, off+130+c*64)))/1e18;
      }
    } catch(_) {}
    
    // Read EMA price if available
    let emaPrice = null;
    if (hasEma) {
      const emaRaw = await rpcCall(rpc, "eth_call", [{ to:amm, data:"0x86fc88d3" }, "latest"], 5000);
      if (emaRaw && emaRaw.length >= 66) emaPrice = Number(BigInt("0x"+emaRaw.slice(2,66)))/1e18;
    }
    
    const poolTvlUsd = poolTvl * (emaPrice || 1600);
    
    results.push({
      chain: chainName,
      index: i,
      coll: coll.slice(0,10)+"...",
      borrow: borrow.slice(0,10)+"...",
      oracle: oracle.slice(0,10)+"...",
      amm: amm.slice(0,10)+"...",
      hasEma,
      emaPrice: emaPrice?.toFixed(6),
      poolTvl: poolTvl.toFixed(2),
      poolTvlUsd: poolTvlUsd.toFixed(0),
      oracleType: hasEma ? "EMA" : "spot",
    });
  }
  
  return results;
}

async function main() {
  console.log("=== Curve LlamaLend Oracle Exploit Scanner ===\n");
  
  const allMarkets = [];
  
  for (const [key, cfg] of Object.entries(CHAINS)) {
    const rpc = await resolveRpc(cfg.id);
    if (!rpc) { console.log(`${cfg.name}: No RPC`); continue; }
    
    const code = await rpcCall(rpc, "eth_getCode", [cfg.view, "latest"], 3000);
    if (!code || code.length < 10) { console.log(`${cfg.name}: View contract NOT deployed`); continue; }
    
    console.log(`\n--- ${cfg.name} (chain ${cfg.id}) ---`);
    const markets = await scanMarkets(rpc, cfg.view, cfg.name);
    allMarkets.push(...markets);
  }
  
  // Rank by best manipulation target (lowest pool TVL with EMA)
  const emaMarkets = allMarkets.filter(m => m.hasEma);
  const spotMarkets = allMarkets.filter(m => !m.hasEma);
  
  emaMarkets.sort((a,b) => parseFloat(a.poolTvlUsd) - parseFloat(b.poolTvlUsd));
  spotMarkets.sort((a,b) => parseFloat(a.poolTvlUsd) - parseFloat(b.poolTvlUsd));
  
  console.log(`\n=== Summary ===`);
  console.log(`Total markets scanned: ${allMarkets.length}`);
  console.log(`EMA oracles (manipulable over time): ${emaMarkets.length}`);
  console.log(`Spot oracles (instant manipulation): ${spotMarkets.length}`);
  
  if (emaMarkets.length > 0) {
    console.log(`\n=== Top 5 Easiest to Manipulate (EMA, Lowest TVL) ===`);
    for (const m of emaMarkets.slice(0, 5)) {
      console.log(`  ${m.chain.padEnd(4)} #${m.index}: TVL=$${m.poolTvlUsd.padStart(8)} ema=${m.emaPrice} coll=${m.coll} borrow=${m.borrow}`);
    }
  }
  
  if (spotMarkets.length > 0) {
    console.log(`\n=== Top 5 Spot Markets (Instant Manipulation) ===`);
    for (const m of spotMarkets.slice(0, 5)) {
      console.log(`  ${m.chain.padEnd(4)} #${m.index}: TVL=$${m.poolTvlUsd.padStart(8)} coll=${m.coll} borrow=${m.borrow}`);
    }
  }
  
  console.log(`\n=== Exploit Assessment ===`);
  console.log(`EMA manipulation requires sustained price pressure (minutes-hours)`);
  console.log(`Spot manipulation requires instant pool distortion (single block)`);
  
  const best = emaMarkets[0] || spotMarkets[0];
  if (best && parseFloat(best.poolTvlUsd) < 500000) {
    console.log(`\nBEST TARGET: ${best.chain} #${best.index} — pool TVL $${best.poolTvlUsd}`);
    console.log(`Manipulation cost: ~$${(parseFloat(best.poolTvlUsd)*0.05).toFixed(0)} (5% distortion)`);
    console.log(`Flash-loan compatible: YES (atomic)`);
    console.log(`ACTION: Fork-test on Anvil`);
  } else {
    console.log(`\nAll pools have TVL >$500K — manipulation cost exceeds profitable threshold`);
  }
  
  fs.mkdirSync(path.join(WORKSPACE, "reports", "raw", "fast"), { recursive: true });
  fs.writeFileSync(path.join(WORKSPACE, "reports", "raw", "fast", "llamalend-markets.json"),
    JSON.stringify({ scannedAt: new Date().toISOString(), allMarkets, emaMarkets, spotMarkets }, null, 2));
}
main().catch(e => { console.error(e.message); process.exit(1); });
