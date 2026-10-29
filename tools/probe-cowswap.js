#!/usr/bin/env node
const{ethers}=require("ethers");const{rpcCall,resolveRpc}=require("./shared-rpc");
(async()=>{
  const rpc=await resolveRpc(1);if(!rpc)throw new Error("No RPC");
  const S="0x9008D19f58AAbD9eD0D60971565AA8510560ab41";
  const IF=new ethers.Interface(["function domainSeparator() view returns (bytes32)","function vaultRelayer() view returns (address)","function vaultAuthorizer() view returns (address)","function numTokens() view returns (uint256)"]);
  console.error("=== CoW Swap GPv2Settlement ===");
  for(const fn of["domainSeparator","vaultRelayer","vaultAuthorizer","numTokens"]){
    try{const raw=await rpcCall(rpc,"eth_call",[{to:S,data:IF.encodeFunctionData(fn,[])},"latest"],12000);
    if(raw&&raw!=="0x"){const d=IF.decodeFunctionResult(fn,raw);console.error("  "+fn+"(): "+d[0]?.toString()?.slice(0,60))}}catch(e){console.error("  "+fn+"(): N/A")}
  }
  // Check storage for settlement state
  const slot0=await rpcCall(rpc,"eth_getStorageAt",[S,"0x0000000000000000000000000000000000000000000000000000000000000000","latest"],8000);
  console.error("  Storage[0]: "+slot0?.slice(0,42)+"...");
  console.error("Done.");
})().catch(e=>console.error(e.message));
