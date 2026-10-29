#!/usr/bin/env node
// Phases 2+3: Spot-perps divergence + funding-rate arbitrage
const fs=require("fs");const path=require("path");
const WORKSPACE=path.resolve(__dirname,"..");
const PERPS=path.join(WORKSPACE,"reports","raw","fast","hyperliquid-perps-meta.json");
const OUT2=path.join(WORKSPACE,"reports","raw","fast","hyperliquid-perps-spot-divergence.json");
const OUT3=path.join(WORKSPACE,"reports","raw","fast","hyperliquid-funding-arb-routes.json");
const API=["https://","api.","hyperliquid.","xyz/info"].join("");const MS=30000;
const MIN_DIV_BPS=10,MIN_APR=5,DEX_BPS=30,GAS=25,BUF_BPS=50;
function round(v,d=6){const n=typeof v==="number"?v:Number(String(v).replace(/[$,%_\\s]/g,""));if(!Number.isFinite(n))return null;const f=10**d;return Math.round(n*f)/f}
async function ip(body){const c=new AbortController();const t=setTimeout(()=>c.abort(),MS);try{const r=await fetch(API,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),signal:c.signal});if(!r.ok)throw new Error(`${r.status}`);return await r.json()}finally{clearTimeout(t)}}

async function main(){
  const pm=JSON.parse(fs.readFileSync(PERPS,"utf8"));const rows=pm.allRows||[];
  const [spotMeta]=await ip({type:"spotMetaAndAssetCtxs"});
  const spotByName={};for(const t of(spotMeta?.tokens||[]))spotByName[(t.name||"").toLowerCase()]=t;
  
  // Phase 2: spot-perps divergence
  const divRows=[];
  for(const row of rows){
    if(!row.markPx||row.markPx<=0)continue;
    const st=spotByName[(row.name||"").toLowerCase()];if(!st)continue;
    let sm=null;try{const bk=await ip({type:"l2Book",coin:st.name});if(bk?.levels){const b=bk.levels[0]||[],a=bk.levels[1]||[];if(b[0]?.px&&a[0]?.px)sm=(parseFloat(b[0].px)+parseFloat(a[0].px))/2;else if(b[0]?.px)sm=parseFloat(b[0].px)}}catch(_){}
    if(!sm||sm<=0)continue;
    const md=(row.markPx/sm-1)*10000,od=row.oraclePx>0?(row.oraclePx/sm-1)*10000:null;
    const be=st.evmContract?(typeof st.evmContract==="string"?st.evmContract.toLowerCase():(st.evmContract?.address||"").toLowerCase()):null;
    divRows.push({name:row.name,spotCoin:st.name,baseEVM:be,markPx:row.markPx,oraclePx:row.oraclePx,spotMid:round(sm,6),fundingAPR:row.fundingAPR,openInterest:row.openInterest,markDivBps:round(md,2),oracleDivBps:round(od,2),significant:Math.abs(md)>=MIN_DIV_BPS||(od!==null&&Math.abs(od)>=MIN_DIV_BPS),routePositive:false,watchCandidate:false,blockers:["Cross-layer not atomic","No flash-loan across HyperCore↔HyperEVM"].filter(Boolean)});
  }
  divRows.sort((a,b)=>Math.abs(b.markDivBps)-Math.abs(a.markDivBps));
  
  // Phase 3: funding-rate arb
  const arbRows=[];
  for(const row of rows){
    if(Math.abs(row.fundingAPR||0)<MIN_APR||!row.openInterest||row.openInterest<=0)continue;
    const abs=Math.abs(row.fundingAPR||0),dir=row.fundingRate>0?"short-perps-long-spot":"long-perps-short-spot";
    const costBps=(DEX_BPS*2)+BUF_BPS,netAPR=abs-(costBps/100);
    arbRows.push({name:row.name,fundingAPR:row.fundingAPR,absAPR:round(abs,2),direction:dir,openInterest:row.openInterest,executionCostBps:costBps,netEstimatedAPR:round(netAPR,2),watchCandidate:netAPR>MIN_APR,routePositive:false,blockers:[netAPR<MIN_APR?"Net APR below threshold":null,"Cross-layer requires separate positions on HyperCore+HyperEVM","Monthly rebalancing needed"].filter(Boolean)});
  }
  arbRows.sort((a,b)=>b.absAPR-a.absAPR);
  
  const a2={generatedAt:new Date().toISOString(),scanner:"tools/scan-hyperliquid-perps-spot-divergence.js",scope:"Phase 2: spot-perps price divergence",safety:{routePositive:false},summary:{scanned:divRows.length,withEVM:divRows.filter(r=>r.baseEVM).length,significantDiv:divRows.filter(r=>r.significant).length,bestDivBps:divRows.length?Math.max(...divRows.map(r=>Math.abs(r.markDivBps))):null,routePositive:0},topRows:divRows.slice(0,25),allRows:divRows};
  fs.writeFileSync(OUT2,JSON.stringify(a2,null,2)+"\n");
  
  const a3={generatedAt:new Date().toISOString(),scanner:"tools/scan-hyperliquid-funding-arb-routes.js",scope:"Phase 3: funding-rate arbitrage",safety:{routePositive:false},methodology:"Conservative: DEX 60bps+50bps buffer. Positions held 7-90 days. Not atomic across layers.",summary:{scanned:arbRows.length,watchCandidates:arbRows.filter(r=>r.watchCandidate).length,bestAPR:arbRows.length?Math.max(...arbRows.map(r=>r.absAPR)):null,routePositive:0},topRows:arbRows.slice(0,25),allRows:arbRows};
  fs.writeFileSync(OUT3,JSON.stringify(a3,null,2)+"\n");
  
  console.log(`Div: ${divRows.length} pairs, ${a2.summary.significantDiv} sig, best=${a2.summary.bestDivBps?.toFixed(1)}bps`);
  console.log(`Arb: ${arbRows.length} candidates, ${a3.summary.watchCandidates} watch, bestAPR=${a3.summary.bestAPR?.toFixed(1)}%`);
}
main().catch(e=>{console.error(e.stack||e.message);process.exitCode=1});
