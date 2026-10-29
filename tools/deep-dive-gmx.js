#!/usr/bin/env node
// deep-dive-gmx.js - GMX V2 deep dive: contract interface, oracle prices, order history
const{ethers}=require("ethers");const{rpcCall}=require("./shared-rpc");
(async()=>{
  const rpc="https://arb1.arbitrum.io/rpc";
  const EX="0x7C68C7866A64FA2160F78EEaE12217FFbf871fa8";
  const DS="0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8";
  const OV="0x31eF83a530Fde1B38EE9A18093A333D8Bbbc40D5";
  
  const RTR=new ethers.Interface(["function owner() view returns (address)","function gov() view returns (address)","function dataStore() view returns (address)","function orderVault() view returns (address)","function oracle() view returns (address)","function roleStore() view returns (address)"]);
  const DS_IF=new ethers.Interface(["function getAddressCount() view returns (uint256)","function getBytes32Count() view returns (uint256)","function getUint(bytes32) view returns (uint256)"]);
  
  console.error("=== GMX V2 ExchangeRouter ===");
  for(const fn of["owner","gov","dataStore","orderVault","oracle","roleStore"]){
    try{const raw=await rpcCall(rpc,"eth_call",[{to:EX,data:RTR.encodeFunctionData(fn,[])},"latest"],12000);
    const d=RTR.decodeFunctionResult(fn,raw);const v=d[0];console.error("  "+fn+"(): "+(v||"?")?.slice(0,42))}catch(e){console.error("  "+fn+"(): N/A")}
  }
  
  console.error("\n=== GMX V2 OrderVault ===");
  const OV_IF=new ethers.Interface(["function maxOrders() view returns (uint256)","function getOrderCount() view returns (uint256)","function getOrderKeys(uint256,uint256) view returns (bytes32[])"]);
  try{const max=await rpcCall(rpc,"eth_call",[{to:OV,data:OV_IF.encodeFunctionData("maxOrders",[])},"latest"],12000);
  console.error("  maxOrders: "+OV_IF.decodeFunctionResult("maxOrders",max)[0].toString())}catch(e){}
  try{const cnt=await rpcCall(rpc,"eth_call",[{to:OV,data:OV_IF.encodeFunctionData("getOrderCount",[])},"latest"],12000);
  console.error("  orderCount: "+OV_IF.decodeFunctionResult("getOrderCount",cnt)[0].toString())}catch(e){}
  
  console.error("\n=== GMX V2 DataStore ===");
  for(const fn of["getAddressCount","getBytes32Count"]){
    try{const raw=await rpcCall(rpc,"eth_call",[{to:DS,data:DS_IF.encodeFunctionData(fn,[])},"latest"],12000);
    console.error("  "+fn+": "+DS_IF.decodeFunctionResult(fn,raw)[0].toString())}catch(e){}
  }
  
  console.error("\nDone.");
})().catch(e=>console.error(e.message));
