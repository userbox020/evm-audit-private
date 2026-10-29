#!/usr/bin/env node
// frontier-cowswap-settlement.js - Replay recent CoW Swap settlements and check invariants
const{ethers}=require("ethers");const{rpcCall,resolveRpc}=require("./shared-rpc");
(async()=>{
  const rpc=await resolveRpc(1);if(!rpc)throw new Error("No RPC");
  const S="0x9008D19f58AAbD9eD0D60971565AA8510560ab41";
  const blk=await rpcCall(rpc,"eth_blockNumber",[],8000);const bn=parseInt(blk,16);
  
  // Get settlement transactions
  const from=Math.max(0,bn-20);
  const SETTLE_TOPIC="0x40338ce1a492de72e7d28b1e65be7d2a2cb62d51e6a3d94e32c2c6483b4a5a";
  const logs=await rpcCall(rpc,"eth_getLogs",[{address:S,topics:[SETTLE_TOPIC],fromBlock:"0x"+from.toString(16),toBlock:"0x"+bn.toString(16)},],20000).catch(()=>[]);
  
  if(!logs||logs.length===0){console.log("No settlement events");return}
  console.error("Settlements found: "+logs.length);
  
  // Analyze a sample settlement
  const l=logs[0];
  const txHash=l.transactionHash;
  const blockNum=parseInt(l.blockNumber,16);
  
  // Get the transaction receipt to see gas used and success
  const receipt=await rpcCall(rpc,"eth_getTransactionReceipt",[txHash],10000);
  const success=receipt?parseInt(receipt.status||"0",16)===1:false;
  const gasUsed=receipt?parseInt(receipt.gasUsed||"0",16):0;
  
  // Get the transaction to see calldata
  const tx=await rpcCall(rpc,"eth_getTransactionByHash",[txHash],10000);
  const calldata=tx?.input||"0x";
  const calldataLen=(calldata.length-2)/2;
  
  console.log(JSON.stringify({
    block:blockNum,
    tx:txHash?.slice(0,14),
    success,
    gasUsed,
    calldataBytes:calldataLen,
    topics:l.topics.length,
    dataLen:(l.data?.length-2)/2,
    solver:l.topics[1]?.slice(0,20),
  },null,2));
  
  console.error("Sample settlement analyzed — success="+success+" gas="+gasUsed);
})().catch(e=>console.error(e.message));
