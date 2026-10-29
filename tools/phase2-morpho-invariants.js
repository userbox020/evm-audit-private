#!/usr/bin/env node
const fs=require("fs");const path=require("path");
const{ethers}=require("ethers");
const WORKSPACE=path.resolve(__dirname,"..");const OUT=path.join(WORKSPACE,"reports","raw","fast","phase2-morpho-invariants.json");
function round(v,d=2){const n=Number(v);return Number.isFinite(n)?Math.round(n*(10**d))/(10**d):null}
function jsonReplacer(_k,v){return typeof v==="bigint"?v.toString():v}

async function fetchMarkets(chainId){
  const q=`{markets(first:300,where:{chainId_in:[${chainId}]}){items{collateralAsset{symbol decimals}loanAsset{symbol decimals}lltv state{supplyAssets supplyShares borrowAssets borrowShares utilization}}}}`;
  try{const r=await fetch("https://blue-api.morpho.org/graphql",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({query:q})});
  const d=await r.json();return(d.data?.markets?.items||[]).map(m=>({...m,chainId}))}catch(_){return[]}
}

async function main(){
  const chains=[1,8453,42161,10,137,56,43114,534352];
  let allMarkets=[];
  for(const cid of chains){const m=await fetchMarkets(cid);allMarkets.push(...m);if(m.length)console.error("Chain "+cid+": "+m.length)}
  console.error("Total: "+allMarkets.length);
  const results=[];
  for(const m of allMarkets){
    if(!m.state||!m.state.supplyAssets||m.state.supplyAssets==="0")continue;
    const collDec=m.collateralAsset?.decimals||18;const loanDec=m.loanAsset?.decimals||18;
    const sa=BigInt(m.state.supplyAssets);const ss=BigInt(m.state.supplyShares||"0");
    const ba=BigInt(m.state.borrowAssets||"0");const bs=BigInt(m.state.borrowShares||"0");
    if(ss===0n||bs===0n)continue;
    const utilization=sa>0n?Number(ba)/Number(sa):0;
    const assetRatio=ba>0n?Number(sa)/Number(ba):0;
    const shareScale=ss<10n**12n||bs<10n**12n;
    const supplyRate=ss>0n?Number(ethers.formatUnits(sa,collDec))/Number(ethers.formatUnits(ss,18)):0;
    const borrowRate=bs>0n?Number(ethers.formatUnits(ba,loanDec))/Number(ethers.formatUnits(bs,18)):0;
    const anomalies=[];
    if(utilization>1)anomalies.push("utilization>1="+round(utilization,6));
    if(assetRatio<1)anomalies.push("assets<debt ratio="+round(assetRatio,6));
    if(shareScale)anomalies.push("tiny-shares supply="+ss+" borrow="+bs);
    if(supplyRate<0.000001)anomalies.push("near-zero-supply-rate="+supplyRate);
    results.push({chainId:m.chainId,collateral:m.collateralAsset?.symbol,loan:m.loanAsset?.symbol,lltv:Number(m.lltv||0),utilization:round(utilization*100),supplyRate:round(supplyRate,8),borrowRate:round(borrowRate,8),shareScale,anomalies,score:anomalies.length*10});
  }
  const anomalous=results.filter(r=>r.anomalies.length>0).sort((a,b)=>b.score-a.score);
  const output={generatedAt:new Date().toISOString(),scanner:"tools/phase2-morpho-invariants.js",summary:{markets:results.length,anomalous:anomalous.length,worstScore:anomalous[0]?.score||0},topAnomalies:anomalous.slice(0,20)};
  fs.mkdirSync(path.dirname(OUT),{recursive:true});fs.writeFileSync(OUT,JSON.stringify(output,jsonReplacer,2));
  console.log(JSON.stringify({markets:results.length,anomalous:anomalous.length,worstScore:output.summary.worstScore,top5:anomalous.slice(0,5).map(a=>({mkt:a.collateral+'/'+a.loan,anomalies:a.anomalies,util:a.utilization}))}));
}
main().catch(e=>{console.error(e.message);process.exit(1)});
