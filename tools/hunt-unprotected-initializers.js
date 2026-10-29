#!/usr/bin/env node
// hunt-unprotected-initializers.js - Check if initialize() is callable from dead address on proxies.
const{ethers}=require("ethers");const{rpcCall,resolveRpcPool}=require("./shared-rpc");
(async()=>{
  const targets=[
    {name:"AaveV3_Pool",chain:1,addr:"0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2"},
    {name:"AaveV3_Pool_ARB",chain:42161,addr:"0x794a61358D6845594F94dc1DB02A252b5b4814aD"},
    {name:"Compound_cUSDC",chain:1,addr:"0xc3d688B66703497DAA19211EEdff47f25384cdc3"},
    {name:"Wormhole_TB",chain:1,addr:"0x3ee18B2214AFF97000D974cf647E7C347E8fa585"},
    {name:"Across_SpokePool",chain:1,addr:"0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5"},
    {name:"EigenLayer_Strategy",chain:1,addr:"0x858646372CC42E1A627fcE94aa7A7033e7CF075A"},
    {name:"Dolomite_Berachain",chain:80094,addr:"0x003Ca23Fd5F0ca87D01F6eC6CD14A8AE60c2b97D"},
  ];
  
  const rpc=await resolveRpcPool([1,42161,80094]);
  const INIT_IF=new ethers.Interface(["function initialize()","function initialize(address)","function initialize(address,address)"]);
  const DEAD="0x000000000000000000000000000000000000dEaD";
  const findings=[];
  
  for(const t of targets){
    const r=rpc[t.chain];if(!r)continue;
    for(const sig of["initialize()","initialize(address)"]){
      const fn=sig.slice(0,sig.indexOf("("));
      try{const raw=await rpcCall(r,"eth_call",[{from:DEAD,to:t.addr,data:INIT_IF.encodeFunctionData(fn,[])},"latest"],12000);
      const retLen=raw&&raw!=="0x"?(raw.length-2)/2:0;
      // Also check random selector
      const rand=await rpcCall(r,"eth_call",[{from:DEAD,to:t.addr,data:"0xdeadbeef"},"latest"],8000);
      const randRet=rand&&rand!=="0x"?(rand.length-2)/2:0;
      if(retLen>0&&(randRet===0||retLen!==randRet)){findings.push({name:t.name,sig,retLen,chain:t.chain});
      console.error("⚠️ "+t.name+" "+sig+": CALLABLE ret="+retLen+"B")}
      }catch(e){/* REVERTED — good, initializer is protected */}
    }
  }
  
  console.log(findings.length>0?"\n⚠️ UNPROTECTED INITIALIZERS: "+findings.length:"\n✅ All initializers protected");
  findings.forEach(f=>console.log("  "+f.name+" chain="+f.chain+" "+f.sig+" ret="+f.retLen+"B"));
})().catch(e=>console.error(e.message));
