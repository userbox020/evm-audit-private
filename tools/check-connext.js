const{ethers}=require("ethers");const{resolveRpc,rpcCall}=require("./shared-rpc");
(async()=>{const r=await resolveRpc(1);const C="0x8898B472C54c31894e3B9bb83cEA802a5d0e63C6";
const blk=await rpcCall(r,"eth_blockNumber",[],8000);const bn=parseInt(blk,16);
const IF=new ethers.Interface(["function isPaused() view returns (bool)","function paused() view returns (bool)","function owner() view returns (address)"]);
const[isP,pa,ow]=await Promise.all(["isPaused","paused","owner"].map(fn=>rpcCall(r,"eth_call",[{to:C,data:IF.encodeFunctionData(fn,[])},Math.floor(Date.now()/1000).toString(16)],12000).then(raw=>{try{return IF.decodeFunctionResult(fn,raw)}catch(_){return null}}).catch(()=>null)));
const paused=isP?Boolean(isP[0]):pa?Boolean(pa[0]):null;
const owner=ow?ow[0]:null;
// Check recent activity
const from=Math.max(0,bn-2000);
const logs=await rpcCall(r,"eth_getLogs",[{address:C,fromBlock:"0x"+from.toString(16),toBlock:"0x"+bn.toString(16)}],20000).catch(()=>[]);
console.log(JSON.stringify({connext:C,paused,owner,recentBlockActivity:logs&&logs.length>0,logCount:logs?logs.length:0,blocksScanned:2000,assessment:paused&&(!logs||logs.length===0)?"PAUSED - NO RECENT ACTIVITY":"PARTIALLY PAUSED - HAS RECENT ACTIVITY"},null,2))})().catch(e=>console.error(e.message));