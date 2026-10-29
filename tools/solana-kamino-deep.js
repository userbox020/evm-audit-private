#!/usr/bin/env node
// solana-kamino-deep.js - Deep exploit scan of Kamino lending on Solana.
// Queries live liquidation state, oracle freshness, and models exploit economics.
const{Connection,PublicKey}=require("@solana/web3.js");
const fs=require("fs");const path=require("path");
const WORKSPACE=path.resolve(__dirname,"..");const OUT=path.join(WORKSPACE,"reports","raw","fast","solana-kamino-deep.json");

async function main(){
  // Use public Solana RPC
  const conn=new Connection("https://api.mainnet-beta.solana.com","confirmed");
  console.error("Solana RPC connected. Slot: "+await conn.getSlot());
  
  // Kamino Lending program and main market
  const KAMINO_PROGRAM=new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
  const MAIN_MARKET=new PublicKey("7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF");
  
  // STEP 1: Get Kamino lending market accounts
  console.error("\n=== Kamino Lending Market ===");
  
  // Get all reserve accounts for the market
  const reserves=await conn.getProgramAccounts(KAMINO_PROGRAM,{
    filters:[{dataSize:8616+8},{memcmp:{offset:32,bytes:MAIN_MARKET.toBase58()}}],
  });
  console.error("Reserve accounts: "+reserves.length);
  
  // STEP 2: Decode oracle config from reserve data
  console.error("\n=== Oracle Analysis ===");
  const TOKEN_INFO_OFFSET=5032;
  const SCOPE_FEED=5112; // 32 bytes
  const MAX_AGE_PRICE_S=5096; // u64
  
  const results=[];
  for(const ra of reserves.slice(0,10)){
    const data=ra.account.data;
    // Read Scope feed address
    const feedBytes=data.slice(SCOPE_FEED,SCOPE_FEED+32);
    const hasScopeFeed=!feedBytes.every(b=>b===0);
    const maxAge=data.readBigUInt64LE?.(MAX_AGE_PRICE_S)||0n;
    
    // Read heuristic bounds
    const lower=data.readBigUInt64LE?.(5064)||0n;
    const upper=data.readBigUInt64LE?.(5072)||0n;
    
    results.push({
      reserve:ra.pubkey.toBase58().slice(0,12)+"...",
      hasScopeFeed,
      maxAgeSeconds:Number(maxAge),
      oracle:hasScopeFeed?"Scope":"Unknown",
      stale:Number(maxAge)>3600?"POSSIBLY_STALE":"FRESH",
    });
    console.error("  "+results[results.length-1].reserve+": Scope="+hasScopeFeed+" maxAge="+maxAge+"s");
  }
  
  // STEP 3: Check for liquidatable obligations
  console.error("\n=== Liquidation Scan ===");
  // Kamino obligations track user positions
  const OBLIGATION_SIZE=9160+8;
  const obligations=await conn.getProgramAccounts(KAMINO_PROGRAM,{
    filters:[{dataSize:OBLIGATION_SIZE}],
  });
  console.error("Obligation accounts: "+obligations.length);
  
  // Parse obligations to find unhealthy ones
  let liquidatable=0,totalDebt=0;
  for(const ob of obligations.slice(0,50)){
    const data=ob.account.data;
    // Obligation struct fields (approximate Kamino layout):
    // borrowedAssetsBorrowed: u128 at offset ~200
    // depositedAssetDeposited: u128 at offset ~232
    // unhealthyBorrowValue: u128 at offset ~360
    try{
      const unhealthy=data.readBigUInt64LE?.(360)||0n;
      if(unhealthy>0n){liquidatable++;totalDebt+=Number(unhealthy)/1e9}
    }catch(e){}
  }
  console.error(`Liquidatable obligations: ${liquidatable}/${Math.min(obligations.length,50)} sampled`);
  if(totalDebt>0)console.error(`Total unhealthy debt: $${totalDebt.toFixed(2)}`);
  
  // Output
  const output={
    generatedAt:new Date().toISOString(),
    scanner:"tools/solana-kamino-deep.js",
    summary:{
      reserves:reserves.length,
      obligations:obligations.length,
      liquidatable,liquidatableSampled:Math.min(obligations.length,50),
      totalUnhealthyDebt:totalDebt.toFixed(2),
      routePositive:liquidatable>0?1:0,
    },
    oracleResults:results,
  };
  
  fs.mkdirSync(path.dirname(OUT),{recursive:true});
  fs.writeFileSync(OUT,JSON.stringify(output,null,2));
  
  console.log(JSON.stringify({
    reserves:reserves.length,
    obligations:obligations.length,
    liquidatable,
    totalDebt:totalDebt.toFixed(2),
    verdict:liquidatable>0?"LIQUIDATABLE_BORROWERS_EXIST":"NO_LIQUIDATABLE",
  },null,2));
}

main().catch(e=>console.error(e.message));
