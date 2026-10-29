#!/usr/bin/env node
// scan-new-chains-lending.js — Lending protocol discovery on 13 newly accessible chains
const fs = require("fs"); const path = require("path");
const { rpcCall, resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "new-chains-lending.json");

// New chains with RPC access
const NEW_CHAINS = [
  { name:"Soneium", id:1868, aaveGql:true, morphoGql:false },
  { name:"Mode", id:34443, aaveGql:false, morphoGql:false },
  { name:"Lisk", id:1135, aaveGql:false, morphoGql:false },
  { name:"Ink", id:57073, aaveGql:true, morphoGql:false },
  { name:"Sonic", id:146, aaveGql:true, morphoGql:false },
  { name:"opBNB", id:204, aaveGql:false, morphoGql:false },
  { name:"Unichain", id:130, aaveGql:false, morphoGql:true },
  { name:"Celo", id:42220, aaveGql:true, morphoGql:false },
  { name:"WorldChain", id:480, aaveGql:false, morphoGql:true },
  { name:"BSC", id:56, aaveGql:true, morphoGql:false },
  { name:"Gnosis", id:100, aaveGql:true, morphoGql:false },
  { name:"Scroll", id:534352, aaveGql:true, morphoGql:false },
  { name:"Linea", id:59144, aaveGql:true, morphoGql:false },
];

// Aave V3 pool addresses (CREATE2 — same on most chains)
const AAVE_V3_CREATE2 = "0x794a61358D6845594F94dc1DB02A252b5b4814aD";
// Morpho Blue CREATE2
const MORPHO_CREATE2 = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";

// Chain-specific Aave pools
const AAVE_V3_POOLS = {
  1:"0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2", 8453:"0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
  42161:AAVE_V3_CREATE2, 10:AAVE_V3_CREATE2, 137:AAVE_V3_CREATE2, 43114:AAVE_V3_CREATE2,
  100:"0xb50201558B00496A145fE76f7424749556E326D8", 534352:"0x11fCfe756c05AD438e312a7fd934381537D3cFfe",
  56:"0x6807dc923806fE8Fd134338EABCA509979a7e0cB", 42220:"0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402",
};

async function main() {
  console.log("=== New Chain Lending Protocol Discovery ===\n");

  const allResults = [];

  for (const chain of NEW_CHAINS) {
    console.log(chain.name + " (c" + chain.id + ")...");
    const rpc = await resolveRpc(chain.id);
    if (!rpc) { console.log("  No RPC"); allResults.push({ ...chain, status:"no-rpc" }); continue; }

    const result = { ...chain, status:"scanned", protocols:[] };

    // 1. Check Aave V3 deployment
    const poolAddr = AAVE_V3_POOLS[chain.id] || AAVE_V3_CREATE2;
    if (poolAddr) {
      const code = await rpcCall(rpc, "eth_getCode", [poolAddr, "latest"], 5000);
      if (code && code !== "0x" && code.length > 10) {
        // Try getReservesList
        const reserves = await rpcCall(rpc, "eth_call", [{ to: poolAddr, data: "0xd1946dbc" }, "latest"], 5000);
        const count = reserves ? parseInt(reserves.slice(66, 130), 16) : 0;
        console.log("  Aave V3: DEPLOYED " + ((code.length-2)/2) + "b, " + count + " reserves");
        result.protocols.push({ name:"Aave V3", address:poolAddr, reserves:count });
      }
    }

    // 2. Check Morpho Blue deployment
    const morphoCode = await rpcCall(rpc, "eth_getCode", [MORPHO_CREATE2, "latest"], 5000);
    if (morphoCode && morphoCode !== "0x" && morphoCode.length > 10) {
      // Query GraphQL for market count
      let morphoCount = 0;
      try {
        const r = await fetch("https://api.morpho.org/graphql", {method:"POST",headers:{"Content-Type":"application/json"},
          body:JSON.stringify({query:`{markets(first:1,where:{listed:true,borrowAssets_gte:"1",chainId_in:[${chain.id}]}){items{id}}}`}),
          signal:AbortSignal.timeout(8000)});
        const j = await r.json();
        morphoCount = j.data?.markets?.items?.length || 0;
      } catch (_) {}
      console.log("  Morpho: DEPLOYED " + ((morphoCode.length-2)/2) + "b, " + morphoCount + " active markets");
      if (morphoCount > 0) result.protocols.push({ name:"Morpho Blue", address:MORPHO_CREATE2, markets:morphoCount });
    }

    // 3. Check Uniswap V3 WETH/USDC pool liquidity
    const uniFactories = {1:"0x1F98431c8aD98523631AE4a59f267346ea31F984",8453:"0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
      42161:"0x1F98431c8aD98523631AE4a59f267346ea31F984",10:"0x1F98431c8aD98523631AE4a59f267346ea31F984"};
    const factory = uniFactories[chain.id];
    if (factory) {
      // Simple: just check if factory has code
      const fCode = await rpcCall(rpc, "eth_getCode", [factory, "latest"], 5000);
      if (fCode && fCode !== "0x" && fCode.length > 10) {
        result.hasUniswapV3 = true;
      }
    }

    const lendingCount = result.protocols.length;
    console.log("  Protocols: " + lendingCount + " lending" + (result.hasUniswapV3 ? " + UniV3" : ""));
    allResults.push(result);
  }

  // Summary
  console.log("\n=== Chains With Lending Protocols ===");
  const withLending = allResults.filter(c => c.protocols?.length > 0);
  console.log("Chains with Aave V3 or Morpho: " + withLending.length);
  for (const c of withLending) {
    console.log("  " + c.name + ": " + c.protocols.map(p => p.name + "(" + (p.reserves||p.markets) + ")").join(", "));
  }

  const noLending = allResults.filter(c => !c.protocols?.length && c.status !== "no-rpc");
  console.log("\nNo lending found: " + noLending.map(c => c.name).join(", "));

  fs.writeFileSync(OUT, JSON.stringify({ scannedAt: new Date().toISOString(), total: NEW_CHAINS.length, withLending: withLending.length, results: allResults }, null, 2));
  console.log("\nArtifact: " + OUT);
}
main().catch(e=>{console.error(e);process.exit(1);});
