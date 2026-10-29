#!/usr/bin/env node
const{ethers}=require("ethers");const{rpcCall,resolveRpc}=require("./shared-rpc");
(async()=>{
  const rpc=await resolveRpc(1);const O="0x1b4A3F92e5Fffd1d35A98751c9FE4472483579bB";
  
  // Try alternative Chainlink v3 interface
  const CL=new ethers.Interface(["function getRoundData(uint80) view returns (uint80,int256,uint256,uint256,uint80)","function latestAnswer() view returns (int256)","function latestTimestamp() view returns (uint256)","function phaseId() view returns (uint16)","function aggregator() view returns (address)"]);
  console.error("=== Alternative Chainlink probes ===");
  for(const fn of["latestAnswer","latestTimestamp","aggregator","phaseId"]){
    try{const raw=await rpcCall(rpc,"eth_call",[{to:O,data:CL.encodeFunctionData(fn,[])},"latest"],8000);
    if(raw&&raw!=="0x"){const d=CL.decodeFunctionResult(fn,raw);console.error("  "+fn+"(): "+d[0])}else console.error("  "+fn+"(): empty")}catch(e){console.error("  "+fn+"(): N/A")}
  }
  
  // Check if oracle IS a proxy (has implementation slot)
  const IMPL="0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
  const impl=await rpcCall(rpc,"eth_getStorageAt",[O,IMPL,"latest"],8000);
  if(impl&&impl!=="0x"+"0".repeat(64)){const addr="0x"+impl.slice(-40);console.error("\nOracle is a PROXY! Implementation:",addr);
    const icode=await rpcCall(rpc,"eth_getCode",[addr,"latest"],8000);console.error("  Impl bytes:",icode&&icode!=="0x"?(icode.length-2)/2:0)}else console.error("\nNot a proxy");
  
  // Get BONDUSD token address from oracle via bytes32 embedded constants
  // Check the 2301 bytes for any 20-byte addresses that might be the token or feed
  const code=await rpcCall(rpc,"eth_getCode",[O,"latest"],10000);
  const lower=(code||"").toLowerCase();
  // Check for common token addresses in bytecode
  const candidates=["a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48","dac17f958d2ee523a2206206994597c13d831ec7"];
  for(const c of candidates){if(lower.includes(c))console.error("Contains known addr: 0x"+c)}
  
  console.error("\nDone.");
})().catch(e=>console.error(e.message));
