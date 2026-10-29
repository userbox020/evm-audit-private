const{ethers}=require("ethers");const{resolveRpc,rpcCall}=require("./shared-rpc");
(async()=>{const r=await resolveRpc(1);const DEAD="0x000000000000000000000000000000000000dEaD";
const targets=[{name:"Euler",addr:"0x29a56a1b8214D9Cf7c5561811750D5cBDb45CC8e"},{name:"PortalTB",addr:"0x3ee18B2214AFF97000D974cf647E7C347E8fa585"}];
const SIGS=["pause()","claim()","harvest()","migrate()"];
const PAUSED_SIGS=["paused()","isPaused()","paused()(bool)"];
for(const t of targets){
  console.log("--- "+t.name+" ---");
  // Check current pause state
  for(const ps of PAUSED_SIGS){
    const fn=ps.slice(0,ps.indexOf("("));const iface=new ethers.Interface(["function "+ps]);
    try{const raw=await rpcCall(r,"eth_call",[{to:t.addr,data:iface.encodeFunctionData(fn,[])},Math.floor(Date.now()/1000).toString(16)],12000);
    if(raw&&raw!=="0x"){const d=iface.decodeFunctionResult(fn,raw);console.log("  "+fn+"(): "+d[0]);break}}catch(e){}}
  // Check return data length for each function call
  console.log("  Function probes (from dead address):");
  for(const sig of SIGS){
    const fn=sig.slice(0,sig.indexOf("("));const iface=new ethers.Interface(["function "+sig]);
    try{const raw=await rpcCall(r,"eth_call",[{from:DEAD,to:t.addr,data:iface.encodeFunctionData(fn,[])},Math.floor(Date.now()/1000).toString(16)],12000);
    const retLen=raw&&raw!=="0x"?((raw.length-2)/2):0;console.log("    "+fn+"(): returndata="+retLen+" bytes")}
    catch(e){console.log("    "+fn+"(): REVERTED")}}
  // Random selector
  try{const raw=await rpcCall(r,"eth_call",[{from:DEAD,to:t.addr,data:"0xdeadbeef"},Math.floor(Date.now()/1000).toString(16)],12000);
  console.log("    random 0xdeadbeef: returndata="+(raw&&raw!=="0x"?((raw.length-2)/2):0)+" bytes")}
  catch(e){console.log("    random 0xdeadbeef: REVERTED")}}
})().catch(e=>console.error(e.message));
