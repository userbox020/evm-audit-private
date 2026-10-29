#!/usr/bin/env node
// frontiers-deep-probe.js - Deep probe of EigenLayer (#2) and CoW Swap (#3)
const{ethers}=require("ethers");const{rpcCall,resolveRpc}=require("./shared-rpc");
(async()=>{
  const rpc=await resolveRpc(1);if(!rpc)throw new Error("No RPC");
  
  // ===== EIGENLAYER (#2) =====
  console.error("=== EIGENLAYER StrategyManager ===");
  const SM="0x858646372CC42E1A627fcE94aa7A7033e7CF075A";
  // Check for withdrawal queue
  const SM_IF=new ethers.Interface(["function getWithdrawalDelay() view returns (uint256)","function withdrawalDelayBlocks() view returns (uint256)","function numWithdrawalsQueued() view returns (uint256)","function owner() view returns (address)","function paused() view returns (uint256)"]);
  for(const fn of["getWithdrawalDelay","withdrawalDelayBlocks","owner","paused"]){
    try{const raw=await rpcCall(rpc,"eth_call",[{to:SM,data:SM_IF.encodeFunctionData(fn,[])},"latest"],12000);
    if(raw&&raw!=="0x"){const d=SM_IF.decodeFunctionResult(fn,raw);console.error("  "+fn+"(): "+d[0]?.toString())}}catch(e){console.error("  "+fn+"(): N/A")}
  }
  
  // Check DelegationManager
  const DEL="0x39053D51B77DC0d36036Fc1fCc8Cb819df8Ef37A";
  const delCode=await rpcCall(rpc,"eth_getCode",[DEL,"latest"],10000);
  console.error("\n  DelegationManager: "+(delCode&&delCode!=="0x"?(delCode.length-2)/2:0)+"B");
  
  // ===== COW SWAP (#3) =====
  console.error("\n=== COW SWAP GPv2Settlement ===");
  const S="0x9008D19f58AAbD9eD0D60971565AA8510560ab41";
  // Check recent settlement transactions on-chain
  const blk=await rpcCall(rpc,"eth_blockNumber",[],8000);const bn=parseInt(blk,16);
  const from=Math.max(0,bn-1000);
  const TRADE_SIG="0xa07a543ab8a018198e99ca0184c93fe9050a79400a0a723441f84de1d972cc17"; // Trade event
  const SETTLE_SIG="0x40338ce1a4a492de72e7d28b1e65be7d2a2cb62d51e6a3d94e32c2c6483b4a5a"; // Settlement event
  
  // Check for any recent events
  const logs=await rpcCall(rpc,"eth_getLogs",[{address:S,fromBlock:"0x"+from.toString(16),toBlock:"0x"+bn.toString(16)},],20000).catch(()=>[]);
  console.error("  Recent events (1K blocks): "+(logs?.length||0));
  if(logs&&logs.length>0){
    // Show unique event signatures
    const sigs=[...new Set(logs.map(l=>l.topics[0]))];
    console.error("  Unique event sigs: "+sigs.length);
    sigs.forEach(s=>console.error("    "+s?.slice(0,20)+"..."));
  }
  
  // Check domain separator + if settlement is active
  const COW_IF=new ethers.Interface(["function domainSeparator() view returns (bytes32)","function vaultRelayer() view returns (address)"]);
  const ds=await rpcCall(rpc,"eth_call",[{to:S,data:COW_IF.encodeFunctionData("domainSeparator",[])},"latest"],12000);
  console.error("  domainSeparator: "+(ds&&ds!=="0x"?COW_IF.decodeFunctionResult("domainSeparator",ds)[0]?.slice(0,20)+"...":"empty"));
  
  // Check if the order book is active by looking at Balancer Vault which CoW uses
  const VAULT="0xBA12222222228d8Ba445958a75a0704d566BF2C8"; // Balancer V2 Vault
  const vCode=await rpcCall(rpc,"eth_getCode",[VAULT,"latest"],8000);
  console.error("\n  Balancer Vault (CoW dependency): "+(vCode&&vCode!=="0x"?(vCode.length-2)/2:0)+"B");
  
  console.error("\nDone.");
})().catch(e=>console.error(e.message));
