#!/usr/bin/env node
// phase2-across-replay.js - Historical replay analysis for Across Protocol SpokePool.
// Fetches recent fill events to understand solver settlement patterns.
const{ethers}=require("ethers");const{rpcCall,resolveRpc}=require("./shared-rpc");
(async()=>{
  const rpc=await resolveRpc(1);if(!rpc)throw new Error("No RPC");
  const SPOKE="0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5"; // Ethereum SpokePool
  
  console.error("Fetching Across SpokePool events...");
  const blk=await rpcCall(rpc,"eth_blockNumber",[],8000);const bn=parseInt(blk,16);
  
  // FilledRelay event signature
  const FILLED="0x571749edf1d5c9599318cdbc4e28a6475d65e87fd3b2ddbe1e9a8d5e7a0f";
  const fromBlock=Math.max(0,bn-1000);
  const logs=await rpcCall(rpc,"eth_getLogs",[{address:SPOKE,fromBlock:"0x"+fromBlock.toString(16),toBlock:"0x"+bn.toString(16)},],30000).catch(()=>[]);
  
  if(!logs||logs.length===0){console.log("No events in last 1000 blocks");return}
  console.error(`Found ${logs.length} events in last 1000 blocks`);
  
  // Parse some events
  for(const l of logs.slice(0,3)){
    console.log("Block "+parseInt(l.blockNumber,16)+" tx="+l.transactionHash?.slice(0,14)+
      " topics="+l.topics.length+" dataLen="+(l.data.length-2)/2);
  }
  
  // Check contract state: get current root bundles, pending relays
  const SPOKE_IF=new ethers.Interface([
    "function numberOfRelays() view returns (uint256)",
    "function rootBundles(uint256) view returns (bytes32)",
    "function pausedFills() view returns (bool)",
    "function pausedDeposits() view returns (bool)",
  ]);
  try{
    const[nr,pf,pd]=await Promise.all([
      rpcCall(rpc,"eth_call",[{to:SPOKE,data:SPOKE_IF.encodeFunctionData("numberOfRelays",[])},"latest"],12000),
      rpcCall(rpc,"eth_call",[{to:SPOKE,data:SPOKE_IF.encodeFunctionData("pausedFills",[])},"latest"],8000),
      rpcCall(rpc,"eth_call",[{to:SPOKE,data:SPOKE_IF.encodeFunctionData("pausedDeposits",[])},"latest"],8000),
    ]);
    if(nr&&nr!=="0x")console.log("Total relays:",SPOKE_IF.decodeFunctionResult("numberOfRelays",nr)[0].toString());
    if(pf&&pf!=="0x")console.log("Fills paused:",SPOKE_IF.decodeFunctionResult("pausedFills",pf)[0]);
    if(pd&&pd!=="0x")console.log("Deposits paused:",SPOKE_IF.decodeFunctionResult("pausedDeposits",pd)[0]);
  }catch(e){}
  
  console.log("Done.");
})().catch(e=>console.error(e.message));
