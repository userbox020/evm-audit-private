const{ethers}=require("ethers");const{rpcCall,resolveRpcPool}=require("./shared-rpc");
(async()=>{
  const rpc=await resolveRpcPool([80094]);const beraRpc=rpc[80094];
  if(!beraRpc){console.log("No Berachain RPC");return}
  const DOLO="0x0f81001ef0a83ecce5ccebf63eb302c70a39a654";
  
  // GET CODE
  const code=await rpcCall(beraRpc,"eth_getCode",[DOLO,"latest"],10000);
  const bytes=code&&code!=="0x"?(code.length-2)/2:0;
  console.log("Dolomite code:",bytes,"bytes");
  
  // Try common interfaces
  const POOL=new ethers.Interface(["function getReservesList() view returns (address[])","function owner() view returns (address)"]);
  for(const fn of["getReservesList","owner"]){
    try{const raw=await rpcCall(beraRpc,"eth_call",[{to:DOLO,data:POOL.encodeFunctionData(fn,[])},"latest"],12000);
    if(raw&&raw!=="0x"){const d=POOL.decodeFunctionResult(fn,raw);console.log(fn+"():",d[0]?.toString()?.slice(0,60))}
    else console.log(fn+"(): empty")}catch(e){console.log(fn+"(): REVERTED")}
  }
  
  // Check EIP-1967 slots
  const IMPL="0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
  const ADMIN="0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
  for(const[slot,name]of[[IMPL,"impl"],[ADMIN,"admin"]]){
    try{const raw=await rpcCall(beraRpc,"eth_getStorageAt",[DOLO,slot,"latest"],8000);
    if(raw&&raw!=="0x"){const addr="0x"+raw.slice(-40);console.log(name+":",addr);const c=await rpcCall(beraRpc,"eth_getCode",[addr,"latest"],8000);console.log("  code:",c&&c!=="0x"?(c.length-2)/2:0,"bytes")}}catch(e){console.log(name+": FAILED")}
  }
  
  // Balance
  const bal=await rpcCall(beraRpc,"eth_getBalance",[DOLO,"latest"],8000);
  if(bal)console.log("ETH balance:",Number(ethers.formatEther(BigInt(bal))).toFixed(4));
  
  console.log("Done.");
})().catch(e=>console.error(e.message));
