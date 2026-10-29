const{ethers}=require("ethers");const{resolveRpc,rpcCall}=require("./shared-rpc");
(async()=>{
  const r=await resolveRpc(1);const F="0x29a56a1b8214D9Cf7c5561811750D5cBDb45CC8e";
  const code=await rpcCall(r,"eth_getCode",[F,"latest"],30000);
  if(!code||code==="0x"){console.log("NO CODE");return}
  const bytes=(code.length-2)/2;
  console.log("Code bytes:",bytes);
  
  // Extract function selectors from the bytecode using PUSH4 patterns
  // In EVM, function dispatchers use PUSH4 <selector> then EQ
  const lower=code.toLowerCase().replace("0x","");
  const selectors=[];
  for(let i=0;i<lower.length-12;i+=2){
    if(lower.slice(i,i+2)==="63"&&parseInt(lower.slice(i+2,i+4),16)>=0x60&&parseInt(lower.slice(i+2,i+4),16)<=0x7f){
      // PUSH4 pattern: 63 <4bytes>
      const pushLen=parseInt(lower.slice(i+2,i+4),16)-0x5f;
      if(pushLen===4){
        const sel=lower.slice(i+4,i+12);
        if(/^[0-9a-f]{8}$/.test(sel)&&sel!=="ffffffff")selectors.push("0x"+sel);
      }
      i+=pushLen*2;
    }
  }
  const unique=[...new Set(selectors)];
  console.log("Unique selectors found:",unique.length);
  
  // Known function signatures to match against
  const knownSigs={
    "0x8456cb59":"pause()",
    "0x3f4ba83a":"unpause()",
    "0x4e71d92d":"claim()",
    "0x379607f5":"harvest()",
    "0x8da5cb5b":"owner()",
    "0xf851a440":"admin()",
    "0x893d20e8":"migrate()",
    "0x893d20e8":"migrate()",
    "0x3659cfe6":"upgradeTo(address)",
    "0x4f1ef286":"upgradeToAndCall(address,bytes)",
    "0x5c60da1b":"implementation()",
    "0xf2fde38b":"transferOwnership(address)",
    "0x715018a6":"renounceOwnership()",
    "0x8f283970":"pendingOwner()",
    "0x79ba5097":"acceptOwnership()",
    "0x18160ddd":"totalSupply()",
    "0x70a08231":"balanceOf(address)",
    "0xa9059cbb":"transfer(address,uint256)",
    "0x095ea7b3":"approve(address,uint256)",
    "0xdd62ed3e":"allowance(address,address)",
    "0x06fdde03":"name()",
    "0x95d89b41":"symbol()",
    "0x313ce567":"decimals()",
    "0x3ccfd60b":"claim(address)",
    "0x2e1a7d4d":"withdraw(uint256)",
    "0xa694fc3a":"stake(uint256)",
    "0x8d80ff0a":"multicall(bytes[])",
  };
  
  const matched=[],unmatched=[];
  for(const sel of unique){
    const name=knownSigs[sel];
    if(name)matched.push(name);
    else unmatched.push(sel);
  }
  
  console.log("\nMatched selectors:",matched.length);
  matched.forEach(s=>console.log("  "+s));
  console.log("\nUnmatched selectors:",unmatched.length);
  unmatched.slice(0,20).forEach(s=>console.log("  "+s));
  
  // Now try to call pause() and check the reversion reason via eth_call with gas limit
  console.log("\n-- Probing pause() authorization --");
  const PAUSE_IFACE=new ethers.Interface(["function pause()"]);
  const pauseData=PAUSE_IFACE.encodeFunctionData("pause",[]);
  
  // Try from dead address
  try{await rpcCall(r,"eth_call",[{from:"0x000000000000000000000000000000000000dEaD",to:F,data:pauseData},"latest"],12000);console.log("DEAD: SUCCESS (no revert)")}catch(e){console.log("DEAD: REVERTED — "+e.message.slice(0,80))}
  
  // Try from owner (if we can find it)
  const OWNER_IFACE=new ethers.Interface(["function owner() view returns (address)"]);
  try{
    const oraw=await rpcCall(r,"eth_call",[{to:F,data:OWNER_IFACE.encodeFunctionData("owner",[])},"latest"],12000);
    if(oraw&&oraw!=="0x"){
      const owner=OWNER_IFACE.decodeFunctionResult("owner",oraw)[0];
      console.log("Owner:",owner);
      try{await rpcCall(r,"eth_call",[{from:owner,to:F,data:pauseData},"latest"],12000);console.log("OWNER: SUCCESS")}catch(e){console.log("OWNER: REVERTED — "+e.message.slice(0,80))}
    }else{console.log("No owner() function")}
  }catch(e){console.log("owner() call failed:",e.message.slice(0,60))}
})().catch(e=>console.error(e.message));
