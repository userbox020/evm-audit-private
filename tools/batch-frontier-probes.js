#!/usr/bin/env node
// batch-frontier-probes.js - Quick triage of all 5 remaining audit frontiers.
const{ethers}=require("ethers");const{rpcCall,resolveRpc}=require("./shared-rpc");
(async()=>{
  const rpc=await resolveRpc(1);if(!rpc)throw new Error("No RPC");
  
  // FRONTIER 2: Restaking — EigenLayer StrategyManager
  console.error("=== FRONTIER 2: Restaking — EigenLayer ===");
  const S="0x858646372CC42E1A627fcE94aa7A7033e7CF075A";
  const code=await rpcCall(rpc,"eth_getCode",[S,"latest"],10000);
  console.error("  StrategyManager: "+(code&&code!=="0x"?(code.length-2)/2:0)+"B");
  // Check EIP-1967 proxy
  const IMPL="0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
  const impl=await rpcCall(rpc,"eth_getStorageAt",[S,IMPL,"latest"],8000);
  const isProxy=impl&&impl!=="0x"+"0".repeat(64);
  console.error("  Is proxy: "+isProxy);
  if(isProxy){const ia="0x"+impl.slice(-40);const icode=await rpcCall(rpc,"eth_getCode",[ia,"latest"],8000);console.error("  Impl: "+ia.slice(0,12)+" ("+(icode&&icode!=="0x"?(icode.length-2)/2:0)+"B)")}
  
  // FRONTIER 3: Intent/Solver — CoW Swap Settlement
  console.error("\n=== FRONTIER 3: Intent/Solver — CoW Swap ===");
  const COW="0x9008D19f58AAbD9eD0D60971565AA8510560ab41"; // GPv2Settlement
  const cc=await rpcCall(rpc,"eth_getCode",[COW,"latest"],8000);
  console.error("  GPv2Settlement: "+(cc&&cc!=="0x"?(cc.length-2)/2:0)+"B");
  // Check recent trades via API
  try{const r=await fetch("https://api.cow.fi/mainnet/api/v1/trades?limit=3");const d=await r.json();
  if(Array.isArray(d))console.error("  Recent trades: "+d.length)}catch(e){console.error("  API: N/A")}
  
  // FRONTIER 4: Prediction Markets — Polymarket
  console.error("\n=== FRONTIER 4: Prediction Markets — Polymarket ===");
  try{const r=await fetch("https://gamma-api.polymarket.com/markets?limit=3&active=true");const d=await r.json();
  if(Array.isArray(d)){console.error("  Active markets: "+d.length);d.slice(0,2).forEach(m=>console.error("    "+m.question?.slice(0,60)+" volume=$"+m.volume))}}catch(e){console.error("  API: N/A")}
  
  // FRONTIER 5: RWA — Ondo Finance
  console.error("\n=== FRONTIER 5: RWA — Ondo ===");
  const ONDO="0xfAbA6f8e4a5E195A82eb6AB6219Efe719b5FeD1B"; // USDY token
  const oc=await rpcCall(rpc,"eth_getCode",[ONDO,"latest"],8000);
  console.error("  USDY token: "+(oc&&oc!=="0x"?(oc.length-2)/2:0)+"B");
  
  console.error("\nDone.");
})().catch(e=>console.error(e.message));
