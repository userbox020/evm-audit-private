#!/usr/bin/env node
// Read-only eVault share-to-eVault collateral NAV manipulation scanner.
const fs = require("fs"); const path = require("path"); const { ethers } = require("ethers");
const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "evault-collateral-nav-manipulation.json");
const QUIET = process.argv.includes("--quiet");
const CHAIN_ID = 1; const EULER_FACTORY = "0x29a56a1b8214D9Cf7c5561811750D5cBDb45CC8e";
const TIMEOUT_MS = Number(process.env.EVAULT_COLLATERAL_TIMEOUT_MS || "12000");
const MIN_LTV = 0.80; const MIN_CASH_USD = 5000; const LOW_TVL_USD = 100000;
const ERC20 = new ethers.Interface(["function balanceOf(address) view returns (uint256)","function decimals() view returns (uint8)","function symbol() view returns (string)"]);
const EVAULT = new ethers.Interface(["function asset() view returns (address)","function cash() view returns (uint256)","function LTVBorrow(address) view returns (uint16)","function LTVList() view returns (address[])","function maxDeposit(address receiver) view returns (uint256)","function maxMint(address receiver) view returns (uint256)","function symbol() view returns (string)","function totalAssets() view returns (uint256)","function totalSupply() view returns (uint256)"]);
const FACTORY = new ethers.Interface(["function getProxyListLength() view returns (uint256)","function getProxyListSlice(uint256,uint256) view returns (address[])"]);
function jsonReplacer(k,v){return typeof v==="bigint"?v.toString():v}
function naddr(v){try{return ethers.getAddress(v)}catch(_){return null}}function laddr(v){const a=naddr(v);return a?a.toLowerCase():null}
function round(v,d=6){const n=typeof v==="number"?v:Number(String(v).replace(/[$,%\s,_]/g,""));if(!Number.isFinite(n))return null;const f=10**d;return Math.round(n*f)/f}
function loadRpcUrls(){if(!fs.existsSync(RPC_FILE))return[];return[...fs.readFileSync(RPC_FILE,"utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map(m=>m[0])}
async function rpcCall(url,method,params=[],ms=TIMEOUT_MS){const c=new AbortController();const t=setTimeout(()=>c.abort(),ms);try{const r=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method,params}),signal:c.signal});const j=await r.json();if(j.error)throw new Error(j.error.message);return j.result??null}finally{clearTimeout(t)}}
async function resolveRpc(chainId){for(const url of loadRpcUrls()){try{const id=Number(BigInt(await rpcCall(url,"eth_chainId",[],6000)));if(id===chainId)return url}catch(_){}}return null}
async function fetchJson(url,opts={}){const c=new AbortController();const t=setTimeout(()=>c.abort(),opts.timeoutMs||TIMEOUT_MS);try{const r=await fetch(url,{...opts,signal:c.signal});if(!r.ok)throw new Error(`HTTP ${r.status}`);return await r.json()}finally{clearTimeout(t)}}
async function sc(provider,to,data){try{return await provider.call({to,data})}catch(_){return null}}
function decode(raw,iface,fn){if(!raw||raw==="0x")return null;try{return iface.decodeFunctionResult(fn,raw)}catch(_){return null}}
function dString(raw,iface,fn){if(!raw||raw==="0x")return null;try{return String(iface.decodeFunctionResult(fn,raw)[0])}catch(_){return null}}
function dUint(raw,iface,fn){if(!raw||raw==="0x")return null;try{return BigInt(iface.decodeFunctionResult(fn,raw)[0])}catch(_){try{return BigInt(raw)}catch(_){return null}}}
function fmt(raw,dec){if(raw===null||raw===undefined||dec===null||dec===undefined)return null;try{return Number(ethers.formatUnits(raw,Number(dec)))}catch(_){return null}}
async function fetchPrices(addrs){const keys=[...new Set((addrs||[]).map(laddr).filter(Boolean).map(a=>`ethereum:${a}`))];const out={};for(let i=0;i<keys.length;i+=50){const j=await fetchJson(`https://coins.llama.fi/prices/current/${keys.slice(i,i+50).join(",")}?searchWidth=6h`,{timeoutMs:30000}).catch(()=>({coins:{}}));Object.assign(out,j.coins||{})}const m=new Map();for(const[k,v]of Object.entries(out)){const a=laddr(k.slice(k.indexOf(":")+1));const p=Number(v?.price||0);if(a&&Number.isFinite(p)&&p>0)m.set(a,p)}return m}
async function tokenMeta(provider,addr){const a=naddr(addr);if(!a)return{address:null,symbol:null,decimals:null};const[sr,dr]=await Promise.all([sc(provider,a,ERC20.encodeFunctionData("symbol",[])),sc(provider,a,ERC20.encodeFunctionData("decimals",[]))]);return{address:a,symbol:dString(sr,ERC20,"symbol"),decimals:Number(decode(dr,ERC20,"decimals")?.[0]??18)}}

async function main(){
  fs.mkdirSync(path.dirname(OUT),{recursive:true});
  const rpc=await resolveRpc(CHAIN_ID);if(!rpc)throw new Error("No RPC");
  const provider=new ethers.JsonRpcProvider(rpc,CHAIN_ID,{staticNetwork:true});
  const block=await provider.getBlockNumber().catch(()=>null);
  // 1: get vault list
  const lenRaw=await sc(provider,EULER_FACTORY,FACTORY.encodeFunctionData("getProxyListLength",[]));
  const len=Number(decode(lenRaw,FACTORY,"getProxyListLength")?.[0]||0n);
  const start=Math.max(0,len-250);
  const vaults=[];
  for(let c=start;c<len;c+=100){
    const r=await sc(provider,EULER_FACTORY,FACTORY.encodeFunctionData("getProxyListSlice",[c,Math.min(len,c+100)]));
    vaults.push(...(decode(r,FACTORY,"getProxyListSlice")?.[0]||[]).map(naddr).filter(Boolean));
  }
  // 2: batch read LTVList for all vaults
  const ltvMap={};
  for(let i=0;i<vaults.length;i+=30){
    const batch=vaults.slice(i,i+30);
    const results=await Promise.all(batch.map(async(v)=>{const r=await sc(provider,v,EVAULT.encodeFunctionData("LTVList",[]));return{key:laddr(v),ltvs:(decode(r,EVAULT,"LTVList")?.[0]||[]).map(naddr).filter(Boolean)}}));
    for(const r of results)ltvMap[r.key]=r.ltvs;
  }
  // 3: collect eVault-as-collateral pairs
  const evaultSet=new Set(vaults.map(laddr).filter(Boolean));
  const collPairs=[];const collAddrs=new Set();
  for(const[vLower,ltvs]of Object.entries(ltvMap)){
    for(const coll of ltvs){
      const cLower=laddr(coll);if(!cLower)continue;
      collAddrs.add(cLower);
      if(evaultSet.has(cLower))collPairs.push({b:vLower,c:cLower});
    }
  }
  // 4: batch read LTVBorrow
  const ltvResults={};
  for(let i=0;i<collPairs.length;i+=30){
    const batch=collPairs.slice(i,i+30);
    const results=await Promise.all(batch.map(async(p)=>{const r=await sc(provider,p.b,EVAULT.encodeFunctionData("LTVBorrow",[p.c]));return{key:`${p.b}:${p.c}`,ltv:Number(decode(r,EVAULT,"LTVBorrow")?.[0]||0)/10000}}));
    for(const r of results)ltvResults[r.key]=r.ltv;
  }
  // 5: batch read coll evault metadata
  const collMeta={};const priceAddrs=[];
  for(const cAddr of collAddrs){
    const[ar,ta,ts,sr,md,mn]=await Promise.all([sc(provider,cAddr,EVAULT.encodeFunctionData("asset",[])),sc(provider,cAddr,EVAULT.encodeFunctionData("totalAssets",[])),sc(provider,cAddr,EVAULT.encodeFunctionData("totalSupply",[])),sc(provider,cAddr,EVAULT.encodeFunctionData("symbol",[])),sc(provider,cAddr,EVAULT.encodeFunctionData("maxDeposit",[ethers.ZeroAddress])),sc(provider,cAddr,EVAULT.encodeFunctionData("maxMint",[ethers.ZeroAddress]))]);
    const asset=naddr(decode(ar,EVAULT,"asset")?.[0]);if(asset)priceAddrs.push(asset);
    const maxDeposit=decode(md,EVAULT,"maxDeposit")?.[0];const maxMint=decode(mn,EVAULT,"maxMint")?.[0];
    collMeta[cAddr]={asset,sym:dString(sr,EVAULT,"symbol"),ta:decode(ta,EVAULT,"totalAssets")?.[0]||0n,ts:decode(ts,EVAULT,"totalSupply")?.[0]||0n,maxDeposit,maxMint,publicMintOpen:maxDeposit!==undefined?maxDeposit>0n:maxMint!==undefined?maxMint>0n:null};
  }
  // 6: batch read borrow evault cash and its own asset. Cash is denominated in the borrow asset, not the collateral asset.
  const borrowMeta={};
  for(const[vLower]of Object.entries(ltvMap)){
    const[cr,ar]=await Promise.all([sc(provider,vLower,EVAULT.encodeFunctionData("cash",[])),sc(provider,vLower,EVAULT.encodeFunctionData("asset",[]))]);
    const asset=naddr(decode(ar,EVAULT,"asset")?.[0]);if(asset)priceAddrs.push(asset);
    borrowMeta[vLower]={cash:decode(cr,EVAULT,"cash")?.[0]||0n,asset};
  }
  const assetMeta={};
  for(const a of [...new Set(priceAddrs.map(laddr).filter(Boolean))])assetMeta[a]=await tokenMeta(provider,a);
  const prices=await fetchPrices([...priceAddrs,...vaults]);
  // 7: build rows
  const rows=[];const seen=new Set();
  for(const pair of collPairs){
    const pk=`${pair.b}:${pair.c}`;if(seen.has(pk))continue;seen.add(pk);
    const ltv=ltvResults[pk]||0;if(ltv<MIN_LTV)continue;
    const meta=collMeta[pair.c];if(!meta?.asset)continue;
    const collAssetMeta=assetMeta[laddr(meta.asset)]||{};
    const borrow=borrowMeta[pair.b]||{};
    const borrowAssetMeta=assetMeta[laddr(borrow.asset)]||{};
    const collPrice=prices.get(laddr(meta.asset))||0;
    const borrowPrice=prices.get(laddr(borrow.asset))||0;
    const cash=borrow.cash||0n;
    const ta=fmt(meta.ta,collAssetMeta.decimals??18)||0;const ts=fmt(meta.ts,18)||0;
    const borrowCashAmount=fmt(cash,borrowAssetMeta.decimals??18)||0;
    const tvlUsd=ta*collPrice;const legacyCashUsd=fmt(cash,18)*collPrice;const cashUsd=borrowCashAmount*borrowPrice;
    const isLowTvl=tvlUsd>0&&tvlUsd<LOW_TVL_USD;
    const matCash=cashUsd>=MIN_CASH_USD;
    const w=isLowTvl&&matCash&&ltv>=MIN_LTV&&meta.publicMintOpen===true;
    rows.push({protocol:"Euler EVK",collateral:pair.c,collateralSymbol:meta.sym||"unknown",collateralAsset:meta.asset,collateralAssetSymbol:collAssetMeta.symbol||null,collateralAssetDecimals:collAssetMeta.decimals??null,maxDepositRaw:meta.maxDeposit?.toString?.()||null,maxMintRaw:meta.maxMint?.toString?.()||null,publicMintOpen:meta.publicMintOpen,borrowEvault:pair.b,borrowAsset:borrow.asset||null,borrowAssetSymbol:borrowAssetMeta.symbol||null,borrowAssetDecimals:borrowAssetMeta.decimals??null,ltv:round(ltv,4),collateralTvlUsd:round(tvlUsd,2),borrowCash:round(borrowCashAmount,6),borrowCashUsd:round(cashUsd,2),legacyBorrowCashUsdIfPricedAsCollateral:round(legacyCashUsd,2),isLowTvl,matCash,watchCandidate:w,routePositive:false,blockers:[w?"Low-TVL publicly mintable eVault as collateral; needs donation/deposit/borrow simulation":null,!isLowTvl?"eVault TVL above threshold":null,!matCash?`Cash below $${MIN_CASH_USD}`:null,ltv<MIN_LTV?`LTV below ${MIN_LTV}`:null,meta.publicMintOpen!==true?"Public mint/deposit capacity not verified open":null,"No exact donation/borrow/exit fork proof"].filter(Boolean)});
  }
  const watch=rows.filter(r=>r.watchCandidate);
  const art={generatedAt:new Date().toISOString(),scanner:"tools/scan-evault-collateral-nav-manipulation.js",scope:"Read-only eVault share-to-eVault collateral NAV manip scan",safety:{rpcInventoryRead:true,rpcUrlsStored:false,envFilesRead:false,privateKeysRead:false,signedActions:false,exploitExecuteCalls:false,forkTransactions:false,routePositive:false,signedActionJustified:false},chain:{chainId:CHAIN_ID,name:"Ethereum",blockNumber:block},thresholds:{minLtv:MIN_LTV,minCashUsd:MIN_CASH_USD,lowTvlUsd:LOW_TVL_USD},summary:{vaultsScanned:vaults.length,evaultAsCollateralPairs:collPairs.length,rowsScanned:rows.length,lowTvlRows:rows.filter(r=>r.isLowTvl).length,watchCandidates:watch.length,routePositive:0},topRows:rows.sort((a,b)=>Number(b.watchCandidate)-Number(a.watchCandidate)||(b.collateralTvlUsd||0)-(a.collateralTvlUsd||0)).slice(0,50),rows,nextRoutePositiveCriteria:["low-TVL eVault publicly mintable","eVault shares accepted as collateral at high LTV","donation/deposit/borrow economics positive","fork proof positive"]};
  fs.writeFileSync(OUT,JSON.stringify(art,jsonReplacer,2)+"\n");
  console.log(`eVault collat NAV: vaults=${art.summary.vaultsScanned} pairs=${art.summary.evaultAsCollateralPairs} rows=${art.summary.rowsScanned} lowTvl=${art.summary.lowTvlRows} watch=${art.summary.watchCandidates}`);
}
main().catch(err=>{console.error(err.stack||err.message);process.exitCode=1});
