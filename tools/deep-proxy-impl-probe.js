const{ethers}=require("ethers");const{resolveRpc,rpcCall}=require("./shared-rpc");
(async()=>{
  const r=await resolveRpc(1);
  const E1967_IMPL="0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
  
  // Resolve implementation addresses
  const targets=[
    {name:"Euler EVK Factory", proxy:"0x29a56a1b8214D9Cf7c5561811750D5cBDb45CC8e"},
    {name:"Portal TokenBridge", proxy:"0x3ee18B2214AFF97000D974cf647E7C347E8fa585"},
    {name:"Portal NFTBridge", proxy:"0x6FFd7EdE62328b3Af38FCD61461Bbfc52F5651fE"},
  ];
  
  for(const t of targets){
    const raw=await rpcCall(r,"eth_getStorageAt",[t.proxy,E1967_IMPL,"latest"],10000).catch(()=>null);
    t.impl=raw&&raw!=="0x"?"0x"+raw.replace(/^0x/i,"").padStart(64,"0").slice(-40):null;
    if(t.impl){
      const code=await rpcCall(r,"eth_getCode",[t.impl,"latest"],10000).catch(()=>"0x");
      t.implBytes=code&&code!=="0x"?(code.length-2)/2:0;
    }
    console.log(t.name+": impl="+(t.impl||"NONE")+" bytes="+(t.implBytes||"?")); 
    const proxyCode=await rpcCall(r,"eth_getCode",[t.proxy,"latest"],10000).catch(()=>"0x");
    t.proxyBytes=proxyCode&&proxyCode!=="0x"?(proxyCode.length-2)/2:0;
  }
  
  // Test sensitive functions on IMPLEMENTATION (not proxy)
  const DEAD="0x000000000000000000000000000000000000dEaD";
  const SIGS=["pause()","unpause()","claim()","harvest()","migrate()","owner()","admin()"];
  
  console.log("\n=== IMPLEMENTATION-LEVEL PROBES ===");
  for(const sig of SIGS){
    const fn=sig.slice(0,sig.indexOf("("));
    const iface=new ethers.Interface(["function "+sig]);
    for(const t of targets.filter(x=>x.impl)){
      try{
        await rpcCall(r,"eth_call",[{from:DEAD,to:t.impl,data:iface.encodeFunctionData(fn,[])},"latest"],8000);
        console.log("  "+t.name+" IMPL "+fn+"(): NO REVERT");
      }catch(e){
        console.log("  "+t.name+" IMPL "+fn+"(): REVERTED — "+e.message.slice(0,60));
      }
    }
  }
  
  // Also probe random selector and empty call on implementation
  console.log("\n=== FALLBACK PROBES ===");
  for(const t of targets.filter(x=>x.impl)){
    for(const data of[{label:"random(0xdeadbeef)",data:"0xdeadbeef"},{label:"empty(0x)",data:"0x"}]){
      try{await rpcCall(r,"eth_call",[{from:DEAD,to:t.impl,data:data.data},"latest"],8000);console.log("  "+t.name+" IMPL "+data.label+": NO REVERT")}
      catch(e){console.log("  "+t.name+" IMPL "+data.label+": REVERTED")}
    }
  }
  
  console.log("\n=== PROXY BYTECODE ANALYSIS ===");
  for(const t of targets){
    console.log(t.name+": proxy="+t.proxyBytes+"B impl="+(t.implBytes||"?")+"B");
  }
})().catch(e=>console.error(e.message));
