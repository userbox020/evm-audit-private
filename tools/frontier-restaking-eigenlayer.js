#!/usr/bin/env node
// frontier-restaking-eigenlayer.js - Withdrawal queue & delegation accounting probe
const{ethers}=require("ethers");const{rpcCall,resolveRpc}=require("./shared-rpc");
(async()=>{
  const rpc=await resolveRpc(1);if(!rpc)throw new Error("No RPC");
  
  const DEL="0x39053D51B77DC0d36036Fc1fCc8Cb819df8Ef37A"; // DelegationManager
  const SM="0x858646372CC42E1A627fcE94aa7A7033e7CF075A"; // StrategyManager
  
  // Try standard EigenLayer interfaces
  const DEL_IF=new ethers.Interface([
    "function owner() view returns (address)",
    "function paused() view returns (uint256)",
    "function minWithdrawalDelayBlocks() view returns (uint256)",
    "function getWithdrawalDelay() view returns (uint256)",
    "function calculateWithdrawalRoot(address) view returns (bytes32)",
    "function delegatedTo(address) view returns (address)",
    "function operatorShares(address,address) view returns (uint256)",
  ]);
  const SM_IF=new ethers.Interface([
    "function owner() view returns (address)",
    "function paused() view returns (uint256)",
    "function numStrategies() view returns (uint256)",
  ]);
  
  console.error("=== EigenLayer DelegationManager ===");
  for(const fn of ["owner","paused","minWithdrawalDelayBlocks","getWithdrawalDelay","calculateWithdrawalRoot"]){
    try{const raw=await rpcCall(rpc,"eth_call",[{to:DEL,data:DEL_IF.encodeFunctionData(fn,fn==="calculateWithdrawalRoot"?[DEL]:[])},"latest"],12000);
    if(raw&&raw!=="0x"){const d=DEL_IF.decodeFunctionResult(fn,raw);console.error("  "+fn+"(): "+d[0]?.toString()?.slice(0,60))}else console.error("  "+fn+"(): empty")}catch(e){console.error("  "+fn+"(): N/A")}
  }
  
  console.error("\n=== EigenLayer StrategyManager ===");
  for(const fn of ["owner","paused","numStrategies"]){
    try{const raw=await rpcCall(rpc,"eth_call",[{to:SM,data:SM_IF.encodeFunctionData(fn,[])},"latest"],12000);
    if(raw&&raw!=="0x"){const d=SM_IF.decodeFunctionResult(fn,raw);console.error("  "+fn+"(): "+d[0]?.toString()?.slice(0,60))}else console.error("  "+fn+"(): empty")}catch(e){console.error("  "+fn+"(): N/A")}
  }
  
  // Check for recent withdrawal events
  const blk=await rpcCall(rpc,"eth_blockNumber",[],8000);const bn=parseInt(blk,16);
  const from=Math.max(0,bn-1000);
  for(const[addr,name]of[[DEL,"DelegationManager"],[SM,"StrategyManager"]]){
    const logs=await rpcCall(rpc,"eth_getLogs",[{address:addr,fromBlock:"0x"+from.toString(16),toBlock:"0x"+bn.toString(16)},],20000).catch(()=>[]);
    console.error("  "+name+" events (1K blocks): "+(logs?.length||0));
  }
  
  console.error("\nDone.");
})().catch(e=>console.error(e.message));
