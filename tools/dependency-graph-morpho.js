#!/usr/bin/env node
// dependency-graph-morpho.js - Map every Morpho oracle to borrow volume, find thin-oracle/thick-protocol gaps.
const{ethers}=require("ethers");const{rpcCall,resolveRpcPool}=require("./shared-rpc");
const fs=require("fs");const path=require("path");
const WORKSPACE=path.resolve(__dirname,"..");const OUT=path.join(WORKSPACE,"reports","raw","fast","dependency-graph-morpho.json");

function round(v,d=2){const n=Number(v);return Number.isFinite(n)?Math.round(n*(10**d))/(10**d):null}
function jsonReplacer(_k,v){return typeof v==="bigint"?v.toString():v}

async function main(){
  // Query ALL Morpho markets across all chains via GraphQL
  const chains=[1,8453,42161,10,137,56,43114,534352];
  const allOracles={};
  
  for(const cid of chains){
    const q=`{markets(first:300,where:{chainId_in:[${cid}]},orderBy:BorrowAssetsUsd,orderDirection:Desc){items{collateralAsset{symbol}loanAsset{symbol}oracle{address}lltv state{supplyAssetsUsd borrowAssetsUsd}}}}`;
    try{const r=await fetch("https://blue-api.morpho.org/graphql",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({query:q})});
    const d=await r.json();const items=d.data?.markets?.items||[];
    for(const m of items){
      if(!m.oracle?.address)continue;
      const oa=m.oracle.address.toLowerCase();
      const bu=Number(m.state?.borrowAssetsUsd||0);
      if(!allOracles[oa])allOracles[oa]={address:m.oracle.address,markets:[],totalBorrowUsd:0,chainId:cid};
      allOracles[oa].markets.push({collateral:m.collateralAsset?.symbol,loan:m.loanAsset?.symbol,lltv:Number(m.lltv||0),borrowUsd:round(bu),supplyUsd:round(Number(m.state?.supplyAssetsUsd||0))});
      allOracles[oa].totalBorrowUsd+=bu;
    }
    if(items.length>0)console.error("Chain "+cid+": "+items.length+" markets")}catch(e){}
  }
  
  const oracles=Object.values(allOracles).sort((a,b)=>b.totalBorrowUsd-a.totalBorrowUsd);
  console.error("\nTotal unique oracles: "+oracles.length);
  
  // Classify top oracles via Ethereum RPC bytecode
  const rpc=await resolveRpcPool([1]);const eth=rpc[1];
  const classified=[];
  
  for(const o of oracles.slice(0,60)){
    let bytes=0,type="unknown",oracleTVL=0;
    if(eth){try{const code=await rpcCall(eth,"eth_getCode",[o.address,"latest"],10000);bytes=code&&code!=="0x"?(code.length-2)/2:0;const lower=(code||"").toLowerCase();
      // Classify
      if(bytes===0)type="no-code-on-ETH";
      else if(bytes<=100)type="minimal/constant";
      else if(lower.includes("f599b40")||lower.includes("5891a3c"))type="chainlink-aggregator";
      else if(lower.includes("38d52e6f")&&lower.includes("ba087652"))type="erc4626-oracle"; // convertToAssets + previewRedeem
      else if(lower.includes("756e6973776170")||lower.includes("6375727665"))type="dex-dependent";
      else if(bytes>500&&bytes<=3000)type="custom-adapter";
      else type="large-complex";
      // Check if oracle IS an ERC4626 vault (has asset(), totalAssets(), convertToAssets)
      if(type!=="erc4626-oracle"&&lower.includes("38d52e6f"))type="possible-erc4626";
    }catch(e){}}
    
    // Oracle TVL risk: if oracle is reading from a low-TVL source but protecting high borrow volume
    const riskScore = o.totalBorrowUsd > 10000000 ? (type.includes("custom")||type.includes("dex")||type.includes("4626")? 80 : type==="minimal/constant"? 60 : 10) : 20;
    
    classified.push({oracle:o.address.slice(0,12),bytes,type,markets:o.markets.length,totalBorrowUsd:round(o.totalBorrowUsd),topMarket:o.markets.sort((a,b)=>b.borrowUsd-a.borrowUsd)[0],riskScore,dependencyRisk:type.includes("custom")||type.includes("dex")||type.includes("4626")?"NEEDS_DEEP_REVIEW":type==="minimal/constant"?"SUSPICIOUS":"STANDARD"});
    console.error("  "+o.address.slice(0,10)+": "+type+" "+bytes+"B borrow=$"+round(o.totalBorrowUsd/1e6,1)+"M markets="+o.markets.length);
  }
  
  const highRisk=classified.filter(c=>c.riskScore>=60).sort((a,b)=>b.riskScore-a.riskScore);
  const output={generatedAt:new Date().toISOString(),scanner:"tools/dependency-graph-morpho.js",summary:{totalOracles:oracles.length,classified:classified.length,highRisk:highRisk.length},highRiskDependencies:highRisk};
  fs.mkdirSync(path.dirname(OUT),{recursive:true});fs.writeFileSync(OUT,JSON.stringify(output,jsonReplacer,2));
  
  console.log(JSON.stringify({totalOracles:oracles.length,highRisk:highRisk.length,topRisks:highRisk.slice(0,8).map(r=>({oracle:r.oracle,type:r.type,borrowUsd:r.totalBorrowUsd,risk:r.dependencyRisk,topMarket:r.topMarket?.collateral+"/"+r.topMarket?.loan}))},null,2));
}

main().catch(e=>{console.error(e.message);process.exit(1)});
