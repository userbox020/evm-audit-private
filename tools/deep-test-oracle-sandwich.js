#!/usr/bin/env node
// deep-test-oracle-sandwich.js - Find DEX-dependent oracles and model manipulation economics.
const fs=require("fs");const path=require("path");
const{ethers}=require("ethers");const{resolveRpc,rpcCall}=require("./shared-rpc");
const WORKSPACE=path.resolve(__dirname,"..");const OUT=path.join(WORKSPACE,"reports","raw","fast","deep-test-oracle-sandwich.json");

function ensureDir(f){fs.mkdirSync(path.dirname(f),{recursive:true})}
function jsonReplacer(_k,v){return typeof v==="bigint"?v.toString():v}
function round(v,d=2){const n=Number(v);return Number.isFinite(n)?Math.round(n*(10**d))/(10**d):null}
function normalizeAddress(v){try{return ethers.getAddress(String(v||""))}catch(_){return null}}

// Known Chainlink aggregator bytecode fingerprints (partial 4-byte selectors)
const CHAINLINK_SELECTORS=["0x50d25bcd","0xfeaf968c","0x7284e416","0x668a0f02","0x9a6fc8f5"];
const ERC4626_SELECTORS=["0x38d52e6f","0x07a2d13a","0xef8b30f7","0x6e553f65","0x94bf804d","0xba087652"];

async function fetchMorphoOracles(){
  const chains=[1,10,8453,42161,137,43114,56,534352];
  const allOracles=new Map();
  for(const cid of chains){
    const q=`{markets(first:100,where:{chainId_in:[${cid}]},orderBy:BorrowAssetsUsd,orderDirection:Desc){items{oracle{address}collateralAsset{symbol}loanAsset{symbol}lltv state{borrowAssetsUsd}}}}`;
    try{const r=await fetch("https://blue-api.morpho.org/graphql",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({query:q})});
    const d=await r.json();const items=d.data?.markets?.items||[];
    for(const m of items){if(!m.oracle?.address)continue;const a=m.oracle.address.toLowerCase();
    const existing=allOracles.get(a);if(existing){existing.markets.push({chain:cid,collateral:m.collateralAsset?.symbol,loan:m.loanAsset?.symbol,lltv:m.lltv,borrowUsd:round(Number(m.state?.borrowAssetsUsd)||0)});existing.totalBorrowUsd+=Number(m.state?.borrowAssetsUsd)||0}else{allOracles.set(a,{address:m.oracle.address,markets:[{chain:cid,collateral:m.collateralAsset?.symbol,loan:m.loanAsset?.symbol,lltv:m.lltv,borrowUsd:round(Number(m.state?.borrowAssetsUsd)||0)}],totalBorrowUsd:Number(m.state?.borrowAssetsUsd)||0})}}
    }catch(e){console.error("Chain "+cid+": "+e.message.slice(0,60))}
  }
  return [...allOracles.values()].sort((a,b)=>b.totalBorrowUsd-a.totalBorrowUsd);
}

async function main(){
  console.error("Fetching Morpho oracles...");
  const oracles=await fetchMorphoOracles();
  console.error(`Found ${oracles.length} unique oracle addresses, top has $${round(oracles[0]?.totalBorrowUsd)} borrow`);
  
  // Classify top oracles via bytecode on Ethereum
  const rpc=await resolveRpc(1);if(!rpc)throw new Error("No RPC");
  const classified=[];
  
  for(const o of oracles.slice(0,50)){
    const code=await rpcCall(rpc,"eth_getCode",[o.address,"latest"],10000).catch(()=>"0x")||"0x";
    const bytes=code!=="0x"?(code.length-2)/2:0;
    const lower=(code||"").toLowerCase();
    
    // Classify
    let type="unknown";
    if(bytes===0)type="no-code";
    else if(bytes<=100)type="minimal/constant";
    else if(bytes>100&&bytes<=500)type="small";
    else if(CHAINLINK_SELECTORS.some(s=>lower.includes(s.slice(2))))type="chainlink-aggregator";
    else if(ERC4626_SELECTORS.some(s=>lower.includes(s.slice(2))))type="erc4626-like";
    else if(bytes>500&&bytes<=3000)type="custom-adapter";
    else type="large-complex";
    
    // DEX-dependent check: search for "swap","pool","uniswap","curve","balancer" in bytecode
    const isDexDep=lower.includes("756e6973776170")||lower.includes("6375727665")||lower.includes("73776170");
    
    classified.push({
      oracle:o.address.slice(0,12),bytes,type,dexDependent:isDexDep,
      markets:o.markets.length,totalBorrowUsd:round(o.totalBorrowUsd),
      topMarket:o.markets.sort((a,b)=>b.borrowUsd-a.borrowUsd)[0],
      manipulable:type==="custom-adapter"||type==="large-complex"||isDexDep,
    });
    console.error(`  ${o.address.slice(0,10)}: ${type} ${bytes}B dex=${isDexDep} borrow=$${round(o.totalBorrowUsd)}`);
  }
  
  const dexDependent=classified.filter(c=>c.dexDependent);
  const customAdapters=classified.filter(c=>c.manipulable);
  
  // Model manipulation for dex-dependent oracles
  const models=[];
  for(const o of dexDependent.slice(0,5)){
    const topMarket=o.topMarket;
    if(!topMarket||topMarket.borrowUsd<1000)continue;
    // Model: if DEX spot price can be moved by 5%, borrow gain = borrow * LLTV * 0.05
    const manipulationPct=0.05;
    const borrowGain=topMarket.borrowUsd*topMarket.lltv*manipulationPct;
    const flashLoanCost=topMarket.borrowUsd*0.0009; // 9bps Aave V3 flash fee
    const gasCost=50; // ~$50 gas
    const net=borrowGain-flashLoanCost-gasCost;
    models.push({oracle:o.oracle,collateral:topMarket.collateral,borrow:topMarket.borrowUsd,lltv:Number(topMarket.lltv||0),borrowGain:round(borrowGain),flashFee:round(flashLoanCost),net:round(net),routePositive:net>0});
  }
  
  const output={generatedAt:new Date().toISOString(),scanner:"tools/deep-test-oracle-sandwich.js",summary:{oraclesScanned:oracles.length,dexDependent:dexDependent.length,customAdapters:customAdapters.length,modelsWithNet:models.filter(m=>m.routePositive).length,routePositive:models.some(m=>m.routePositive)?1:0},classified:classified.slice(0,30),dexDependent,models};
  
  ensureDir(OUT);fs.writeFileSync(OUT,JSON.stringify(output,jsonReplacer,2));
  
  console.log(JSON.stringify({oracles:oracles.length,dexDependent:dexDependent.length,custom:customAdapters.length,models:models.length,routePositive:output.summary.routePositive,allDex:dexDependent.map(d=>d.oracle+" "+d.topMarket?.collateral+"/"+d.topMarket?.loan)}));
}

main().catch(e=>{console.error(e.message);process.exit(1)});
