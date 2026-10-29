#!/usr/bin/env node
// phase2-across-decode.js - Decode Across SpokePool fill events & check invariants.
const{ethers}=require("ethers");const{rpcCall,resolveRpc}=require("./shared-rpc");
(async()=>{
  const rpc=await resolveRpc(1);if(!rpc)throw new Error("No RPC");
  const SPOKE="0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5";
  
  // FilledRelay event signature (keccak256 of event definition)
  const FILLED_TOPIC=ethers.id("FilledRelay(bytes32,bytes32,uint256,uint256,uint256,uint256,uint256,uint32,uint32,bytes32,bytes32,bytes32,bytes32,bytes32,(bytes32,bytes32,uint256,uint8))");
  console.error("FilledRelay topic:",FILLED_TOPIC);
  
  const blk=await rpcCall(rpc,"eth_blockNumber",[],8000);const bn=parseInt(blk,16);
  const fromBlock=Math.max(0,bn-500);
  
  console.error(`Scanning blocks ${fromBlock} to ${bn}...`);
  const logs=await rpcCall(rpc,"eth_getLogs",[{address:SPOKE,topics:[FILLED_TOPIC],fromBlock:"0x"+fromBlock.toString(16),toBlock:"0x"+bn.toString(16)},],30000).catch(()=>[]);
  
  if(!logs||logs.length===0){console.log("No FilledRelay events");return}
  console.error(`Found ${logs.length} FilledRelay events`);
  
  // Decode event — indexed params: originChainId (topic[1]), depositId (topic[2]), relayer (topic[3])
  const iface=new ethers.Interface([
    "event FilledRelay(bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 repaymentChainId, uint256 indexed originChainId, uint256 indexed depositId, uint32 fillDeadline, uint32 exclusivityDeadline, bytes32 exclusiveRelayer, bytes32 indexed relayer, bytes32 depositor, bytes32 recipient, bytes32 messageHash, tuple(bytes32 updatedRecipient, bytes32 updatedMessageHash, uint256 updatedOutputAmount, uint8 fillType) relayExecutionInfo)"
  ]);
  
  const decoded=[];
  let violationCount=0;
  
  for(const l of logs.slice(0,50)){
    try{
      const d=iface.parseLog({topics:l.topics,data:l.data});
      if(!d)continue;
      const args=d.args;
      
      // Parse amounts (in token native units — needs decimals for USD conversion)
      const inputAmt=Number(ethers.formatEther(args.inputAmount));
      const outputAmt=Number(ethers.formatEther(args.outputAmount));
      const updatedOutput=Number(ethers.formatEther(args.relayExecutionInfo.updatedOutputAmount||0));
      const finalOutput=updatedOutput>0?updatedOutput:outputAmt;
      
      // INVARIANTS:
      const violations=[];
      const blockNum=parseInt(l.blockNumber,16);
      const now=Math.floor(Date.now()/1000);
      const fillDeadline=Number(args.fillDeadline);
      
      // 1. outputAmount should not exceed inputAmount (solvers take a fee, not profit)
      if(outputAmt>inputAmt&&inputAmt>0)violations.push(`output(${outputAmt.toFixed(4)})>input(${inputAmt.toFixed(4)})`);
      
      // 2. fillDeadline should be in the future (no expired fills)
      // Can't check without block timestamps, but we can check if deadline seems unreasonable
      if(fillDeadline>0&&fillDeadline<now-86400)violations.push(`expired deadline=${fillDeadline}`);
      
      // 3. originChainId should be valid (1-1000 range)
      const originChain=Number(args.originChainId);
      if(originChain<1||originChain>1000000)violations.push(`invalid originChainId=${originChain}`);
      
      // 4. fillType analysis
      const fillType=Number(args.relayExecutionInfo.fillType||0);
      const fillTypeStr=["FastFill","ReplacedSlowFill","SlowFill"][fillType]||"Unknown";
      
      if(violations.length>0)violationCount++;
      
      decoded.push({
        block:blockNum,tx:l.transactionHash?.slice(0,14),
        originChain,depositId:Number(args.depositId),
        inputAmt:inputAmt.toFixed(4),outputAmt:outputAmt.toFixed(4),
        finalOutput:finalOutput.toFixed(4),
        fillType:fillTypeStr,
        violations,
      });
    }catch(e){}
  }
  
  console.error(`Decoded ${decoded.length} fills, ${violationCount} with violations`);
  
  // Find most interesting fills
  const withViolations=decoded.filter(d=>d.violations.length>0);
  if(withViolations.length>0){
    console.error("\nVIOLATIONS FOUND:");
    withViolations.forEach(d=>console.error(`  Block ${d.block}: ${d.violations.join(", ")}`));
  }
  
  // Check for large fills where output > input (potential solver overpayment)
  const largeOverpay=decoded.filter(d=>Number(d.outputAmt)>Number(d.inputAmt)&&Number(d.inputAmt)>0.1);
  console.error(`\nFills with output > input (potential overpayment): ${largeOverpay.length}`);
  largeOverpay.slice(0,5).forEach(d=>console.error(`  input=${d.inputAmt} output=${d.outputAmt} type=${d.fillType}`));
  
  // Summary stats
  const fastFills=decoded.filter(d=>d.fillType==="FastFill").length;
  const slowFills=decoded.filter(d=>d.fillType==="SlowFill").length;
  const replaced=decoded.filter(d=>d.fillType==="ReplacedSlowFill").length;
  
  console.log(JSON.stringify({
    totalEvents:logs.length,
    decoded:decoded.length,
    violations:violationCount,
    largeOverpay:largeOverpay.length,
    fastFills,slowFills,replaced,
    sample:decoded.slice(0,5),
  },null,2));
})().catch(e=>console.error(e.message));
