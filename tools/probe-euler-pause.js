const{ethers}=require("ethers");const{resolveRpc,rpcCall}=require("./shared-rpc");
(async()=>{
  const r=await resolveRpc(1);const F="0x29a56a1b8214D9Cf7c5561811750D5cBDb45CC8e";
  
  // Check if actually paused
  const PAUSED=new ethers.Interface(["function paused() view returns (bool)","function isPaused() view returns (bool)"]);
  for(const fn of["paused","isPaused"]){
    try{const raw=await rpcCall(r,"eth_call",[{to:F,data:PAUSED.encodeFunctionData(fn,[])},Math.floor(Date.now()/1000).toString(16)],12000);
    if(raw&&raw!=="0x"){const d=PAUSED.decodeFunctionResult(fn,raw);console.log(fn+"():",d[0])}}catch(e){console.log(fn+"(): REVERTED")}
  }
  
  // Check owner and roles
  const OZ_ACCESS=new ethers.Interface([
    "function owner() view returns (address)",
    "function hasRole(bytes32 role, address account) view returns (bool)",
    "function getRoleAdmin(bytes32 role) view returns (bytes32)",
    "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
  ]);
  const PAUSER_ROLE=ethers.keccak256(ethers.toUtf8Bytes("PAUSER_ROLE"));
  const dead="0x000000000000000000000000000000000000dEaD";
  try{
    const[ow,hasPauser,defAdmin]=await Promise.all([
      rpcCall(r,"eth_call",[{to:F,data:OZ_ACCESS.encodeFunctionData("owner",[])},Math.floor(Date.now()/1000).toString(16)],12000).then(r=>{try{return OZ_ACCESS.decodeFunctionResult("owner",r)[0]}catch(_){return null}}),
      rpcCall(r,"eth_call",[{to:F,data:OZ_ACCESS.encodeFunctionData("hasRole",[PAUSER_ROLE,dead])},Math.floor(Date.now()/1000).toString(16)],12000).then(r=>{try{return OZ_ACCESS.decodeFunctionResult("hasRole",r)[0]}catch(_){return null}}),
      rpcCall(r,"eth_call",[{to:F,data:OZ_ACCESS.encodeFunctionData("DEFAULT_ADMIN_ROLE",[])},Math.floor(Date.now()/1000).toString(16)],12000).then(r=>{try{return OZ_ACCESS.decodeFunctionResult("DEFAULT_ADMIN_ROLE",r)[0]}catch(_){return null}}),
    ]);
    console.log("owner:",ow);
    console.log("dead address has PAUSER_ROLE:",hasPauser);
    console.log("DEFAULT_ADMIN_ROLE:",defAdmin);
  }catch(e){console.log("Access check failed:",e.message.slice(0,100))}
  
  // Check the PAUSER_ROLE holder
  try{
    const PAUSER=new ethers.Interface(["function PAUSER_ROLE() view returns (bytes32)"]);
    const pr=await rpcCall(r,"eth_call",[{to:F,data:PAUSER.encodeFunctionData("PAUSER_ROLE",[])},Math.floor(Date.now()/1000).toString(16)],12000);
    if(pr&&pr!=="0x"){const d=PAUSER.decodeFunctionResult("PAUSER_ROLE",pr);console.log("PAUSER_ROLE:",d[0])}
  }catch(e){}
})().catch(e=>console.error(e.message));
