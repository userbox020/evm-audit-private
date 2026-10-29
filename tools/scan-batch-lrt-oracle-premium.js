#!/usr/bin/env node
// Batch probe Morpho LRT market oracles from the LRT inventory artifact.
// Read-only: compares oracle price to public market ratio and models LLTV break-even.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const ARTIFACT = path.join(WORKSPACE, "reports", "raw", "fast", "lrt-oracle-drift-routes.json");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "lrt-oracle-premium-probe.json");
const CHAIN_ID = 1; const QUIET = process.argv.includes("--quiet");
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2".toLowerCase();
const SLIPPAGE_BPS = Number(process.env.LRT_ORACLE_SLIPPAGE_BPS || "100");
const FLASH_FEE_BPS = Number(process.env.LRT_ORACLE_FLASH_FEE_BPS || "5");
const GAS_UNITS = Number(process.env.LRT_ORACLE_GAS_UNITS || "2500000");
const MIN_PROFIT_USD = Number(process.env.LRT_ORACLE_MIN_PROFIT_USD || "25");

function loadUrls(){if(!fs.existsSync(RPC_FILE))return[];return[...fs.readFileSync(RPC_FILE,"utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map(m=>m[0])}
async function rc(url,method,params=[],ms=15000){const c=new AbortController();const t=setTimeout(()=>c.abort(),ms);try{const r=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method,params}),signal:c.signal});const j=await r.json();if(j.error)throw new Error(j.error.message);return j.result??null}finally{clearTimeout(t)}}
async function resolve(chainId){for(const url of loadUrls()){try{const id=Number(BigInt(await rc(url,"eth_chainId",[],6000)));if(id===chainId)return url}catch(_){}}return null}

function laddr(v){try{return ethers.getAddress(v).toLowerCase()}catch(_){return null}}
function round(v,d=6){const n=typeof v==="number"?v:Number(String(v).replace(/[$,%\s,_]/g,""));if(!Number.isFinite(n))return null;const f=10**d;return Math.round(n*f)/f}
function log(...args){ if(!QUIET) console.log(...args); }
function formatOraclePrice(raw, collateralDecimals, loanDecimals){
  const scale = 36 + Number(loanDecimals) - Number(collateralDecimals);
  if(!Number.isFinite(scale) || scale < 0) return null;
  try {
    const value = Number(ethers.formatUnits(BigInt(raw), scale));
    return Number.isFinite(value) && value > 0 ? { value, scale } : null;
  } catch (_) {
    return null;
  }
}
function breakEvenPremiumBps(lltv){
  const x = Number(lltv || 0);
  if(!Number.isFinite(x) || x <= 0 || x >= 1) return null;
  return (1 / x - 1) * 10000;
}
function modelEconomics(row, premiumBps, ethPriceUsd, gasPriceWei){
  const lltv = Number(row.lltv || row.ltv || 0);
  const borrowCashUsd = Number(row.routeLiquidityUsd || 0);
  const baseBreakEven = breakEvenPremiumBps(lltv);
  const premiumFactor = 1 + Number(premiumBps || 0) / 10000;
  const gasUsd = ethPriceUsd && gasPriceWei ? Number(ethers.formatEther(BigInt(Math.round(gasPriceWei)) * BigInt(GAS_UNITS))) * ethPriceUsd : null;
  const acquisitionCostUsd = lltv > 0 && premiumFactor > 0 ? borrowCashUsd / (lltv * premiumFactor) : null;
  const slippageUsd = acquisitionCostUsd === null ? null : acquisitionCostUsd * SLIPPAGE_BPS / 10000;
  const flashFeeUsd = acquisitionCostUsd === null ? null : acquisitionCostUsd * FLASH_FEE_BPS / 10000;
  const netEdgeUsd = acquisitionCostUsd === null ? null : borrowCashUsd - acquisitionCostUsd - (slippageUsd || 0) - (flashFeeUsd || 0) - (gasUsd || 0);
  const gasBps = acquisitionCostUsd && gasUsd !== null ? gasUsd / acquisitionCostUsd * 10000 : 0;
  const requiredPremiumBps = baseBreakEven === null ? null : baseBreakEven + SLIPPAGE_BPS + FLASH_FEE_BPS + gasBps;
  return {
    lltv,
    borrowCashUsd: round(borrowCashUsd, 2),
    baseBreakEvenPremiumBps: round(baseBreakEven, 4),
    slippageBps: SLIPPAGE_BPS,
    flashFeeBps: FLASH_FEE_BPS,
    gasUsd: round(gasUsd, 6),
    gasBps: round(gasBps, 4),
    requiredPremiumBps: round(requiredPremiumBps, 4),
    premiumGapBps: requiredPremiumBps === null ? null : round(requiredPremiumBps - Number(premiumBps || 0), 4),
    acquisitionCostForBorrowCashUsd: round(acquisitionCostUsd, 6),
    slippageUsd: round(slippageUsd, 6),
    flashFeeUsd: round(flashFeeUsd, 6),
    estimatedNetUsd: round(netEdgeUsd, 6),
    minProfitUsd: MIN_PROFIT_USD,
    preforkPremiumPositive: Boolean(requiredPremiumBps !== null && Number(premiumBps || 0) > requiredPremiumBps && (netEdgeUsd || -Infinity) > MIN_PROFIT_USD),
  };
}

async function main(){
  const rurl = await resolve(CHAIN_ID);
  if(!rurl){console.error("No RPC");return}
  const provider = new ethers.JsonRpcProvider(rurl, CHAIN_ID);
  const block = await provider.getBlockNumber();
  const gasPrice = (await provider.getFeeData().catch(()=>({})))?.gasPrice || 0n;
  
  // Read artifact
  const art = JSON.parse(fs.readFileSync(ARTIFACT,"utf8"));
  const rows = (art.rows || []).filter(r=>r.protocol==="Morpho Blue"&&r.oracle&&r.watchCandidate);
  log(`Found ${rows.length} watch rows with oracles`);
  
  // Unique oracles
  const oracles = [...new Set(rows.map(r=>r.oracle.toLowerCase()))].filter(Boolean);
  log(`${oracles.length} unique oracles to probe\n`);
  
  // Fetch all prices once
  const collAddrs = [...new Set(rows.map(r=>laddr(r.collateral?.address)).filter(Boolean))];
  const loanAddrs = [...new Set(rows.map(r=>laddr(r.borrowAsset?.address)).filter(Boolean))];
  const allAddrs = [...new Set([...collAddrs,...loanAddrs,WETH])];
  
  const chunks = []; for(let i=0;i<allAddrs.length;i+=50) chunks.push(allAddrs.slice(i,i+50));
  const prices = {};
  for(const chunk of chunks){
    const keys = chunk.map(a=>`ethereum:${a}`).join(",");
    const j = await fetch(`https://coins.llama.fi/prices/current/${keys}?searchWidth=6h`).then(r=>r.json()).catch(()=>({coins:{}}));
    for(const[k,v]of Object.entries(j.coins||{})){
      const a = k.slice(k.indexOf(":")+1).toLowerCase();
      const p = Number(v?.price||0);
      if(Number.isFinite(p)&&p>0) prices[a]=p;
    }
  }
  log(`Prices resolved for ${Object.keys(prices).length} tokens`);

  // Probe each oracle once; row-specific decimal normalization happens below.
  const oracleRaw = new Map();
  for(const oAddr of oracles){
    const sel = ethers.id("price()");
    let raw = null;
    try { raw = await provider.call({to:oAddr, data:sel}, block); } catch(e) { raw = null; }
    if(!raw || raw==="0x"){ log(`${oAddr.slice(0,10)}... REVERT/empty`); continue; }
    oracleRaw.set(oAddr.toLowerCase(), BigInt(raw));
    log(`${oAddr.slice(0,10)}... raw=${BigInt(raw).toString().slice(0,18)}...`);
  }
  
  // Now compute premium for each market row
  for(const row of rows){
    const collL = laddr(row.collateral?.address);
    const loanL = laddr(row.borrowAsset?.address);
    const collP = prices[collL]||0;
    const loanP = prices[loanL]||0;
    if(!collP||!loanP){ row.probeStatus="missing-price"; continue; }
    
    const mktRatio = collP/loanP;
    const raw = oracleRaw.get(row.oracle.toLowerCase());
    if(!raw){ row.probeStatus="oracle-failed"; continue; }

    const normalized = formatOraclePrice(raw, row.collateral?.decimals || 18, row.borrowAsset?.decimals || 18);
    if(!normalized){ row.probeStatus="normalization-failed"; continue; }

    const oracleVal = normalized.value;
    const premiumBps = round((oracleVal/mktRatio - 1) * 10000, 2);
    const economics = modelEconomics(row, premiumBps, prices[WETH] || null, gasPrice?.toString?.() || "0");
    row.oraclePrice = oracleVal;
    row.marketRatio = round(mktRatio, 6);
    row.oracleScaleDecimals = normalized.scale;
    row.premiumBps = premiumBps;
    row.premiumPositive = premiumBps > 5;
    row.economics = economics;
    row.preforkPremiumPositive = economics.preforkPremiumPositive;
    row.routePositive = false;
    row.signedActionJustified = false;
    row.blockers = [
      economics.preforkPremiumPositive ? null : "Oracle premium does not clear LLTV break-even, slippage, flash-fee, gas, and min-profit gates",
      "No exact collateral acquisition/unwind quote in this probe",
      "No fork extraction proof",
    ].filter(Boolean);
    row.probeStatus = "ok";
  }
  
  // Sort and display
  const okRows = rows.filter(r=>r.probeStatus==="ok").sort((a,b)=>(b.premiumBps||0)-(a.premiumBps||0));
  log(`\n=== RESULTS ===`);
  log(`Oracles probed: ${oracleRaw.size}, rows with premium: ${okRows.length}`);
   
  const positiveRows = okRows.filter(r=>(r.premiumBps||0)>5);
  const preforkPositiveRows = okRows.filter(r=>r.preforkPremiumPositive);
  log(`Positive premium (>5bps): ${positiveRows.length}`);
  log(`Prefork premium-positive after LLTV/gas/slippage gates: ${preforkPositiveRows.length}`);
   
  for(const r of okRows.slice(0,15)){
    const sym = r.collateral?.symbol||"?";
    const loanSym = r.borrowAsset?.symbol||"?";
    const ltv = ((r.ltv||r.lltv||0)*100).toFixed(0);
    const liq = r.routeLiquidityUsd;
    const prem = r.premiumBps;
    const gap = r.economics?.premiumGapBps;
    const flag = r.preforkPremiumPositive?"*** PREFORK POSITIVE ***":prem>5?"premium-only":prem>0?"weak":"";
    log(`${sym}/${loanSym} LLTV=${ltv}% liq=$${Math.round(liq).toLocaleString()} prem=${prem.toFixed(1)}bps gap=${gap}bps ${flag}`);
  }
  
  // Write artifact
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-batch-lrt-oracle-premium.js",
    scope: "Read-only Morpho LRT oracle premium probe with LLTV break-even economics",
    safety: {rpcInventoryRead:true,rpcUrlsStored:false,signedActions:false,exploitExecuteCalls:false,forkTransactions:false,routePositive:false,signedActionJustified:false},
    config:{slippageBps:SLIPPAGE_BPS,flashFeeBps:FLASH_FEE_BPS,gasUnits:GAS_UNITS,minProfitUsd:MIN_PROFIT_USD},
    chain:{chainId:CHAIN_ID,block,gasPriceWei:gasPrice?.toString?.() || "0",ethPriceUsd:prices[WETH] || null},
    summary:{oraclesProbed:oracleRaw.size,rowsProbed:okRows.length,positivePremiumRows:positiveRows.length,preforkPremiumPositiveRows:preforkPositiveRows.length,routePositive:0,signedActionJustified:false,blocker:preforkPositiveRows.length?"Premium economics crossed pre-fork gate but exact acquisition/unwind quotes and fork proof are still missing":"No row clears LLTV break-even, slippage, flash-fee, gas, and min-profit gates"},
    topRows: okRows.slice(0,50),
    rows:rows.map(r=>({...r})),
    oracleResults: [...oracleRaw.entries()].map(([oracle, raw])=>({oracle, rawWad: raw.toString()})),
    requiredForRoutePositive:["oracle premium clears LLTV break-even plus gas/slippage/flash fee", "exact collateral acquisition and borrow/unwind route is positive", "fork extraction proof demonstrates net profit"],
  };
  fs.mkdirSync(path.dirname(OUT),{recursive:true});
  fs.writeFileSync(OUT, JSON.stringify(artifact,null,2)+"\n");
  log(`\nArtifact: ${OUT.replace(/\\/g,"/")}`);
  if(preforkPositiveRows.length) log(`\n*** PREFORK ECONOMICS CANDIDATES FOUND: ${preforkPositiveRows.length} ***`);
}
main().catch(e=>{console.error(e.stack);process.exitCode=1});
