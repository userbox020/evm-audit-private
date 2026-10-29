#!/usr/bin/env node
// Phase 1: Hyperliquid Perps Metadata Collector
const fs=require("fs");const path=require("path");
const WORKSPACE=path.resolve(__dirname,"..");
const OUT=path.join(WORKSPACE,"reports","raw","fast","hyperliquid-perps-meta.json");
const QUIET=process.argv.includes("--quiet");
const API=["https://","api.","hyperliquid.","xyz/info"].join("");
const MS=30000;
function round(v,d=6){const n=typeof v==="number"?v:Number(String(v).replace(/[$,%_\\s]/g,""));if(!Number.isFinite(n))return null;const f=10**d;return Math.round(n*f)/f}
async function ip(body){const c=new AbortController();const t=setTimeout(()=>c.abort(),MS);try{const r=await fetch(API,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),signal:c.signal});if(!r.ok)throw new Error(`${r.status}`);return await r.json()}finally{clearTimeout(t)}}

async function main(){
  // Get combined perps meta + asset contexts (same pattern as spotMetaAndAssetCtxs)
  const [meta,ctxs]=await ip({type:"metaAndAssetCtxs"});
  const uni=meta.universe||[];
  console.log(`Perps: ${uni.length} markets, ${ctxs.length} contexts`);
  
  // Get allMids
  const mids=await ip({type:"allMids"}).catch(()=>[]);
  
  // Get predicted fundings
  const pFundings=await ip({type:"predictedFundings"}).catch(()=>[]);
  const predMap={}; for(const pf of(pFundings||[])){if(!Array.isArray(pf))continue;const name=pf[0];const venues=pf[1]||[];const hl=venues.find(v=>v[0]==="HlPerp");if(hl)predMap[name]=parseFloat(hl[1]?.fundingRate||"0")}
  
  // Get spot meta for EVM address mapping
  const [spotMeta]=await ip({type:"spotMetaAndAssetCtxs"});
  const tevm={}; for(const t of(spotMeta?.tokens||[])){if(t.evmContract)tevm[t.index]=(typeof t.evmContract==="string"?t.evmContract:t.evmContract?.address||"").toLowerCase()}
  
  const rows=[];
  for(let i=0;i<uni.length;i++){
    const m=uni[i];const ctx=ctxs[i]||{};const mid=mids?parseFloat(mids[i]||"0"):0;
    const fr=parseFloat(ctx.funding)||0;
    const apr=fr*100*365*24; // funding is per hour
    const oi=parseFloat(ctx.openInterest)||0;
    const mp=parseFloat(ctx.markPx)||0;
    const op=parseFloat(ctx.oraclePx)||0;
    const prem=parseFloat(ctx.premium)||0;
    const bi=Array.isArray(m.tokens)?m.tokens[0]:null;
    const be=bi!==null?tevm[bi]||null:null;
    const predRate=predMap[m.name]||null;
    rows.push({index:i,name:m.name||"",szDecimals:m.szDecimals,maxLeverage:m.maxLeverage,baseTokenIdx:bi,baseEVM:be||null,
      fundingRate:round(fr,12),fundingAPR:round(apr,4),predictedFunding:round(predRate,10),
      openInterest:round(oi,2),markPx:round(mp,6),oraclePx:round(op,6),midPx:round(mid,6),premium:round(prem,6),
      premiumBps:mp>0&&op>0?round((mp/op-1)*10000,2):null});
  }
  rows.sort((a,b)=>Math.abs(b.fundingAPR||0)-Math.abs(a.fundingAPR||0));
  
  const art={generatedAt:new Date().toISOString(),scanner:"tools/scan-hyperliquid-perps-meta.js",scope:"Read-only Hyperliquid perps metadata (Phase 1 of 3)",safety:{rpcInventoryRead:false,rpcUrlsStored:false,signedActions:false,routePositive:false},
  summary:{perpsMarkets:rows.length,withEVM:rows.filter(r=>r.baseEVM).length,withPredFunding:rows.filter(r=>r.predictedFunding!==null).length,
    highestFundingAPR:rows.length?Math.max(...rows.map(r=>Math.abs(r.fundingAPR||0))):null,
    topMarket:rows[0]?.name,topAPR:rows[0]?.fundingAPR,
    posCount:rows.filter(r=>r.fundingRate>0).length,negCount:rows.filter(r=>r.fundingRate<0).length,
    routePositive:0},
  topRows:rows.slice(0,40),allRows:rows};
  fs.mkdirSync(path.dirname(OUT),{recursive:true});fs.writeFileSync(OUT,JSON.stringify(art,null,2)+"\n");
  const s=art.summary;console.log(`HL perps: ${s.perpsMarkets} mkts, ${s.withEVM} EVM-linked, ${s.withPredFunding} pred, topAPR=${s.topAPR?.toFixed(2)}% pos/neg=${s.posCount}/${s.negCount}`);
}
main().catch(e=>{console.error(e.stack||e.message);process.exitCode=1});
