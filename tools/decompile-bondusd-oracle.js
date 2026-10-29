#!/usr/bin/env node
// decompile-bondusd-oracle.js - Extract external calls and dependencies from BONDUSD oracle bytecode.
const{ethers}=require("ethers");const{rpcCall,resolveRpc}=require("./shared-rpc");
(async()=>{
  const rpc=await resolveRpc(1);if(!rpc)throw new Error("No RPC");
  const O="0x1b4A3F92e5Fffd1d35A98751c9FE4472483579bB";
  const code=await rpcCall(rpc,"eth_getCode",[O,"latest"],30000);
  if(!code||code==="0x"){console.log("NO CODE");return}
  const lower=code.toLowerCase().replace("0x","");
  console.error("Oracle: "+O);
  console.error("Bytecode: "+(lower.length/2)+" bytes");
  
  // 1. Find all PUSH4 patterns (function selectors used in CALL/DELEGATECALL)
  console.error("\n=== Function Selectors Used ===");
  const selectors=new Set();
  for(let i=0;i<lower.length-8;i+=2){
    // PUSH4 opcode is 0x63
    if(lower.slice(i,i+2)==="63"){
      const pushLen=parseInt(lower.slice(i+2,i+4),16)-0x5f;
      if(pushLen===4){
        const sel=lower.slice(i+4,i+12);
        if(/^[0-9a-f]{8}$/.test(sel)&&sel!=="ffffffff"&&sel!=="00000000"){
          selectors.add("0x"+sel);
          i+=8; // skip the 4 bytes
        }
      }
    }
  }
  const KNOWN={
    "0xfeaf968c":"latestRoundData()",
    "0x50d25bcd":"latestAnswer()",
    "0x313ce567":"decimals()",
    "0x7284e416":"description()",
    "0x38d52e6f":"asset()",
    "0xef8b30f7":"convertToAssets(uint256)",
    "0x01e1d114":"totalAssets()",
    "0x18160ddd":"totalSupply()",
    "0x70a08231":"balanceOf(address)",
    "0x18a6f7c2":"price() (Morpho)",
    "0x5c60da1b":"implementation()",
    "0x8da5cb5b":"owner()",
    "0xf851a440":"admin()",
    "0x3659cfe6":"upgradeTo(address)",
    "0xf2fde38b":"transferOwnership(address)",
    "0x8456cb59":"pause()",
    "0x3f4ba83a":"unpause()",
    "0x95d89b41":"symbol()",
    "0x06fdde03":"name()",
    "0xa9059cbb":"transfer(address,uint256)",
    "0x095ea7b3":"approve(address,uint256)",
    "0xdd62ed3e":"allowance(address,address)",
  };
  for(const sel of selectors){
    const known=KNOWN[sel];
    console.error("  "+sel+(known?" = "+known:" (unknown)"));
  }
  
  // 2. Find all PUSH20 patterns (potential contract addresses)
  console.error("\n=== Embedded Addresses (PUSH20) ===");
  const addresses=new Set();
  for(let i=0;i<lower.length-42;i+=2){
    if(lower.slice(i,i+2)==="73"){ // PUSH20 opcode
      const addr="0x"+lower.slice(i+2,i+42);
      if(/^0x[0-9a-f]{40}$/.test(addr)&&addr!=="0x0000000000000000000000000000000000000000"&&addr!=="0xffffffffffffffffffffffffffffffffffffffff"){
        addresses.add(addr);
        i+=40;
      }
    }
  }
  // Resolve each address
  console.error("  Found "+addresses.size+" unique addresses");
  const ERC20=new ethers.Interface(["function symbol() view returns (string)","function name() view returns (string)"]);
  for(const addr of [...addresses].slice(0,15)){
    let identity="?";
    try{const raw=await rpcCall(rpc,"eth_call",[{to:addr,data:ERC20.encodeFunctionData("symbol",[])},"latest"],8000);
    if(raw&&raw!=="0x")identity=ERC20.decodeFunctionResult("symbol",raw)[0]}catch(e){}
    try{const raw=await rpcCall(rpc,"eth_call",[{to:addr,data:ERC20.encodeFunctionData("name",[])},"latest"],8000);
    if(raw&&raw!=="0x"){const n=ERC20.decodeFunctionResult("name",raw)[0];if(!identity||identity==="?")identity=n}}catch(e){}
    const code2=await rpcCall(rpc,"eth_getCode",[addr,"latest"],8000);
    const bytes2=code2&&code2!=="0x"?(code2.length-2)/2:0;
    console.error("    "+addr.slice(0,14)+" => "+(identity!=="?"?identity:"unknown")+" ("+bytes2+"B)");
  }
  
  // 3. Try to trace price() by calling it and checking what external addresses it interacts with
  console.error("\n=== price() External Dependencies ===");
  // We can't do full trace_call without debug_traceCall support
  // But we know: the oracle uses latestRoundData() selector internally
  // So it likely reads from a Chainlink feed address embedded in bytecode
  
  // Check if any embedded address IS a Chainlink feed
  for(const addr of addresses){
    try{
      const CL=new ethers.Interface(["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"]);
      const raw=await rpcCall(rpc,"eth_call",[{to:addr,data:CL.encodeFunctionData("latestRoundData",[])},"latest"],8000);
      if(raw&&raw!=="0x"){
        const d=CL.decodeFunctionResult("latestRoundData",raw);
        const price=Number(ethers.formatUnits(d[1],8));
        const age=Math.floor(Date.now()/1000)-Number(d[3]);
        console.error("  Chainlink feed at "+addr.slice(0,14)+": price=$"+price+" age="+age+"s");
      }
    }catch(e){}
  }
  
  console.error("\nDone.");
})().catch(e=>console.error(e.message));
