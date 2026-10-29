const{ethers}=require("ethers");const{resolveRpc,rpcCall}=require("./shared-rpc");
(async()=>{const r=await resolveRpc(1);const F="0x29a56a1b8214D9Cf7c5561811750D5cBDb45CC8e";
const results=[];
for(const spec of[
  {label:"random 0xdeadbeef",data:"0xdeadbeef"},
  {label:"pause()",data:(new ethers.Interface(["function pause()"])).encodeFunctionData("pause",[])},
  {label:"empty 0x",data:"0x"},
]){
  try{await rpcCall(r,"eth_call",[{from:"0x000000000000000000000000000000000000dEaD",to:F,data:spec.data},"latest"],8000);
  results.push(spec.label+": NO REVERT")}catch(e){results.push(spec.label+": REVERTED")}
}
console.log(JSON.stringify({results,conclusion:results.every(r=>r.includes("NO REVERT"))?"ALL SUCCEED — confirms no-op fallback proxy":"SOME REVERT — pause() may be real"},null,2))})().catch(e=>console.error(e.message));