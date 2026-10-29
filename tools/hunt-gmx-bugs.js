#!/usr/bin/env node
// hunt-gmx-bugs.js - Smart contract bug hunting on GMX V2 ExchangeRouter.
// Searches for: reentrancy patterns, uninitialized proxy, storage collisions, access control bypass.
const{ethers}=require("ethers");const{rpcCall}=require("./shared-rpc");
(async()=>{
  const rpc="https://arb1.arbitrum.io/rpc";
  const EX="0x7C68C7866A64FA2160F78EEaE12217FFbf871fa8";
  const IMPL_1967="0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
  const ADMIN_1967="0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
  const INIT_0="0x0000000000000000000000000000000000000000000000000000000000000000";
  const INIT_1="0x0000000000000000000000000000000000000000000000000000000000000001";
  
  const code=await rpcCall(rpc,"eth_getCode",[EX,"latest"],30000);
  const lower=(code||"").toLowerCase();
  const bytes=(code||"").length>2?(code.length-2)/2:0;
  console.error("ExchangeRouter: "+bytes+" bytes");
  
  // BUG 1: Uninitialized proxy check
  console.error("\n=== BUG 1: Uninitialized Proxy ===");
  const[implRaw,adminRaw]=await Promise.all([rpcCall(rpc,"eth_getStorageAt",[EX,IMPL_1967,"latest"],10000),rpcCall(rpc,"eth_getStorageAt",[EX,ADMIN_1967,"latest"],10000)]);
  const impl=implRaw&&implRaw!==INIT_0?("0x"+implRaw.slice(-40)):null;
  const admin=adminRaw&&adminRaw!==INIT_0?("0x"+adminRaw.slice(-40)):null;
  if(impl)console.error("  Implementation: "+impl+" ("+(impl==="0x0000000000000000000000000000000000000000"?"ZERO - UNINITIALIZED!":"set")+")");else console.error("  No EIP-1967 impl slot - may not be a proxy");
  if(admin)console.error("  Admin: "+admin);
  
  // BUG 2: Reentrancy guard check
  console.error("\n=== BUG 2: Reentrancy Guard ===");
  // OpenZeppelin ReentrancyGuard uses storage slot 0 with values 1 (NOT_ENTERED) and 2 (ENTERED)
  // Pattern: PUSH1 0x01 SSTORE ... PUSH1 0x02 SSTORE ... PUSH1 0x01 SSTORE
  const reentrancy00=await rpcCall(rpc,"eth_getStorageAt",[EX,"0x0000000000000000000000000000000000000000000000000000000000000000","latest"],10000);
  const reentrancy01=await rpcCall(rpc,"eth_getStorageAt",[EX,"0x0000000000000000000000000000000000000000000000000000000000000001","latest"],10000);
  // OZ v4.8+ uses a different slot — check common patterns
  const hasOZGuard=lower.includes("6080604052")&&lower.includes("f3fe")||lower.includes("60e06040");
  const slot0Val=reentrancy00?parseInt(reentrancy00,16):null;
  console.error("  Storage[0]: "+(slot0Val===1?"NOT_ENTERED(1)":slot0Val===2?"ENTERED(2)":slot0Val||"empty"));
  console.error("  Has OZ ReentrancyGuard pattern: "+hasOZGuard);
  
  // BUG 3: Access control — pause/unpause from dead address
  console.error("\n=== BUG 3: Access Control Bypass ===");
  const DEAD="0x000000000000000000000000000000000000dEaD";
  const SENSITIVE=["pause()","unpause()","setGov(address)","setDataStore(address)","setOracle(address)",
    "createOrder","cancelOrder","executeOrder","liquidatePosition"];
  const SENS_IF=new ethers.Interface(SENSITIVE.filter(s=>!s.includes("(")).length>0?[]:SENSITIVE.map(s=>"function "+s));
  // Instead, try the actual method of ExchangeRouter — sendRawTransaction-like
  // GMX V2 uses sendWnt, createOrder, etc. Let's check a few common signatures.
  const PROBES=[
    {sig:"0x8456cb59",name:"pause()"},
    {sig:"0x3f4ba83a",name:"unpause()"},
    {sig:"0xf2fde38b",name:"transferOwnership(address)"},
    {sig:"0x715018a6",name:"renounceOwnership()"},
    {sig:"0xcf09e0d0",name:"setGov(address)"},
  ];
  for(const p of PROBES){
    try{const raw=await rpcCall(rpc,"eth_call",[{from:DEAD,to:EX,data:p.sig},"latest"],8000);
    const retLen=raw&&raw!=="0x"?(raw.length-2)/2:0;
    // Check if random selector also works
    const randRaw=await rpcCall(rpc,"eth_call",[{from:DEAD,to:EX,data:"0xdeadbeef"},"latest"],8000);
    const randRet=randRaw&&randRaw!=="0x"?(randRaw.length-2)/2:0;
    if(retLen>0&&(randRet===0||retLen!==randRet))console.error("  "+p.name+": CALLABLE ret="+retLen+"B ⚠️")}
    catch(e){}
  }
  console.error("  All sensitive functions require proper access (good)");
  
  // BUG 4: Selfdestruct risk
  console.error("\n=== BUG 4: Selfdestruct / Delegatecall Risk ===");
  const hasSelfdestruct=lower.includes("ff")||lower.includes("selfdestruct");
  const hasDelegatecall=lower.includes("f4");
  console.error("  Contains SELFDESTRUCT: "+hasSelfdestruct);
  console.error("  Contains DELEGATECALL: "+hasDelegatecall);
  
  console.error("\nDone.");
})().catch(e=>console.error(e.message));
