#!/usr/bin/env node
// hunt-uninitialized-proxies.js - Check top protocols for uninitialized UUPS/transparent proxies.
const{ethers}=require("ethers");const{rpcCall,resolveRpcPool}=require("./shared-rpc");
(async()=>{
  const IMPL="0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
  const ADMIN="0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
  const ZERO="0x0000000000000000000000000000000000000000000000000000000000000000";
  
  // Top protocols with proxy patterns
  const targets=[
    {name:"AaveV3_Pool",chain:1,addr:"0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2"},
    {name:"Morpho_Blue",chain:1,addr:"0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb"},
    {name:"Compound_cUSDC",chain:1,addr:"0xc3d688B66703497DAA19211EEdff47f25384cdc3"},
    {name:"UniswapV3_Factory",chain:1,addr:"0x1F98431c8aD98523631AE4a59f267346ea31F984"},
    {name:"Wormhole_TokenBridge",chain:1,addr:"0x3ee18B2214AFF97000D974cf647E7C347E8fa585"},
    {name:"Lido_stETH",chain:1,addr:"0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84"},
    {name:"Pendle_Router",chain:1,addr:"0x00000000005bbb0ef59571E58418F9a4357b68A0"},
    {name:"Euler_EVK_Factory",chain:1,addr:"0x29a56a1b8214D9Cf7c5561811750D5cBDb45CC8e"},
    {name:"Across_SpokePool",chain:1,addr:"0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5"},
    {name:"EigenLayer_Strategy",chain:1,addr:"0x858646372CC42E1A627fcE94aa7A7033e7CF075A"},
    {name:"MakerDAO_VAT",chain:1,addr:"0x35D1b3F3D7966A1DFe207aa4514C12a259A0492B"},
    {name:"RocketPool_rETH",chain:1,addr:"0xae78736Cd615f374D3085123A210448E74Fc6393"},
    {name:"Curve_AddrProvider",chain:1,addr:"0x0000000022D53366457F9d5E68Ec105046FC4383"},
    {name:"Balancer_V3_Vault",chain:1,addr:"0xbA1333333333a1BA1108E8412f11850A5C319bA9"},
    {name:"1inch_RouterV5",chain:1,addr:"0x1111111254EEB25477B68fb85Ed929f73A596582"},
  ];
  
  const rpc=await resolveRpcPool([1]);const eth=rpc[1];if(!eth){console.log("No RPC");return}
  
  const findings=[];
  for(const t of targets){
    const[implRaw,adminRaw]=await Promise.all([rpcCall(eth,"eth_getStorageAt",[t.addr,IMPL,"latest"],10000),rpcCall(eth,"eth_getStorageAt",[t.addr,ADMIN,"latest"],10000)]);
    const impl=implRaw&&implRaw!==ZERO?("0x"+implRaw.slice(-40)):null;
    const admin=adminRaw&&adminRaw!==ZERO?("0x"+adminRaw.slice(-40)):null;
    const isProxy=!!impl||!!admin;
    
    // Check if implementation is zero (uninitialized!)
    const implZero=impl==="0x0000000000000000000000000000000000000000";
    
    if(isProxy){
      let implCode=0;if(impl&&!implZero){try{const c=await rpcCall(eth,"eth_getCode",[impl,"latest"],8000);implCode=c&&c!=="0x"?(c.length-2)/2:0}catch(e){}}
      const risk=implZero?"UNINITIALIZED! ⚠️":implCode===0?"IMPL_DESTROYED! ⚠️":"ok";
      if(risk!=="ok")findings.push({...t,impl,admin,implCode,risk});
      console.error(t.name+": proxy impl="+(impl?.slice(0,12)||"?")+" admin="+(admin?.slice(0,12)||"?")+" implCode="+implCode+" => "+risk);
    }else{
      const code=await rpcCall(eth,"eth_getCode",[t.addr,"latest"],8000);
      const bytes=code&&code!=="0x"?(code.length-2)/2:0;
      console.error(t.name+": standalone "+bytes+"B (not proxy)");
    }
  }
  
  console.log("\n"+(findings.length>0?"⚠️ UNINITIALIZED PROXIES FOUND: "+findings.length:"✅ All proxies initialized"));
  findings.forEach(f=>console.log("  "+f.name+": "+f.risk+" impl="+f.impl+" admin="+f.admin));
})().catch(e=>console.error(e.message));
