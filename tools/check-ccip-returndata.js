const{ethers}=require("ethers");const{resolveRpcPool,rpcCall}=require("./shared-rpc");
(async()=>{
  const ccip=JSON.parse(require("fs").readFileSync("C:/_Work/__EVM_AUDIT/reports/raw/fast/ccip-phase0.json","utf8"));
  const pools=(ccip.poolRows||[]).filter(p=>p.typeCategory==="LockRelease"&&p.poolCodePresent).slice(0,5);
  const chainIds=[...new Set(pools.map(p=>p.chainId))];const rpcPool=await resolveRpcPool(chainIds);
  const DEAD="0x000000000000000000000000000000000000dEaD";
  
  for(const pool of pools){
    const rpc=rpcPool[pool.chainId];if(!rpc)continue;
    const addr=pool.pool;
    console.log(`\n${pool.tokenSymbol} (${pool.chainId}):`);
    
    // Check pause() returndata
    const PAUSE=new ethers.Interface(["function pause()"]);
    let pauseRet=0,randomRet=0;
    try{const raw=await rpcCall(rpc,"eth_call",[{from:DEAD,to:addr,data:PAUSE.encodeFunctionData("pause",[])},"latest"],12000);pauseRet=raw&&raw!=="0x"?(raw.length-2)/2:0}catch(e){pauseRet=-1}
    try{const raw=await rpcCall(rpc,"eth_call",[{from:DEAD,to:addr,data:"0xdeadbeef"},"latest"],12000);randomRet=raw&&raw!=="0x"?(raw.length-2)/2:0}catch(e){randomRet=-1}
    
    // Check paused() getter
    const PAUSED=new ethers.Interface(["function paused() view returns (bool)"]);
    let isPaused="?";
    try{const raw=await rpcCall(rpc,"eth_call",[{to:addr,data:PAUSED.encodeFunctionData("paused",[])},"latest"],12000);
    if(raw&&raw!=="0x")isPaused=PAUSED.decodeFunctionResult("paused",raw)[0]?"PAUSED":"ACTIVE"}catch(e){isPaused="NO_GETTER"}
    
    const verdict=pauseRet>0&&randomRet<=0?"REAL_FUNCTION":pauseRet===0&&randomRet===0?"FALLBACK_NOOP":pauseRet===-1?"REVERTED":"UNCLEAR";
    console.log(`  pause returndata:${pauseRet}B random:${randomRet}B paused():${isPaused} => ${verdict}`);
  }
})().catch(e=>console.error(e.message));
