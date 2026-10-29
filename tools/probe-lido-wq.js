const{ethers}=require("ethers");const{resolveRpc,rpcCall}=require("./shared-rpc");
(async()=>{const r=await resolveRpc(1);const WQ="0x889edC2eDab5f40e902b864aD4d7AdE8E412F9B1";
const call=async(fn,args=[])=>{try{const raw=await rpcCall(r,"eth_call",[{to:WQ,data:(new ethers.Interface([fn])).encodeFunctionData(fn.slice(0,fn.indexOf("(")),args)},"latest"],12000);if(!raw||raw==="0x")return null;return (new ethers.Interface([fn])).decodeFunctionResult(fn.slice(0,fn.indexOf("(")),raw)}catch(e){return null}};
const getter=async(name,type)=>{try{const raw=await rpcCall(r,"eth_call",[{to:WQ,data:(new ethers.Interface(["function "+name+"() view returns ("+type+")"])).encodeFunctionData(name,[])},"latest"],12000);if(!raw||raw==="0x")return null;return (new ethers.Interface(["function "+name+"() view returns ("+type+")"])).decodeFunctionResult(name,raw)}catch(e){return null}};
const[lastId,lastFin,paused,unfin]=await Promise.all([
  getter("getLastRequestId","uint256"),getter("getLastFinalizedRequestId","uint256"),
  getter("isPaused","bool"),getter("unfinalizedStETH","uint256")]);
const qs=lastId?Number(lastId[0]):null;const lf=lastFin?Number(lastFin[0]):null;
console.log(JSON.stringify({queueSize:qs,finalized:lf,pending:qs&&lf!=null?qs-lf:null,unfinalizedStETH:unfin?Number(ethers.formatEther(unfin[0])):0,paused:paused?Boolean(paused[0]):null},null,2))})().catch(e=>console.error(e.message));