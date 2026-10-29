#!/usr/bin/env node
const{ethers}=require("ethers");const{rpcCall,resolveRpc}=require("./shared-rpc");
(async()=>{
  const rpc=await resolveRpc(1);if(!rpc)throw new Error("No RPC");
  // BONDUSD/USR oracle from dependency graph
  const O="0x1b4A3F92e54cFb3b4B72a1D3E1bAa1D3E1bAa1D3E";
  
  // Check what interface this oracle implements
  console.error("Probing oracle 0x1b4A3F92...");
  
  // Chainlink: latestRoundData()
  const CL=new ethers.Interface(["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)","function decimals() view returns (uint8)","function description() view returns (string)"]);
  try{const raw=await rpcCall(rpc,"eth_call",[{to:O,data:CL.encodeFunctionData("latestRoundData",[])},"latest"],12000);
  if(raw&&raw!=="0x"){const d=CL.decodeFunctionResult("latestRoundData",raw);const price=Number(ethers.formatUnits(d[1],8));const age=Math.floor(Date.now()/1000)-Number(d[3]);
  console.error("  Chainlink: price=$"+price+" age="+age+"s ("+(age/60).toFixed(0)+"min)")}
  else console.error("  Chainlink: no data")}catch(e){console.error("  Chainlink: N/A")}
  
  // ERC4626: convertToAssets
  const VLT=new ethers.Interface(["function convertToAssets(uint256) view returns (uint256)","function asset() view returns (address)","function totalAssets() view returns (uint256)"]);
  try{const raw=await rpcCall(rpc,"eth_call",[{to:O,data:VLT.encodeFunctionData("convertToAssets",[10n**18n])},"latest"],12000);
  if(raw&&raw!=="0x"){const rate=Number(ethers.formatUnits(VLT.decodeFunctionResult("convertToAssets",raw)[0],18));console.error("  ERC4626: rate="+rate)}
  else console.error("  ERC4626: no data")}catch(e){console.error("  ERC4626: N/A")}
  
  // Morpho oracle: price()
  const MP=new ethers.Interface(["function price() view returns (uint256)"]);
  try{const raw=await rpcCall(rpc,"eth_call",[{to:O,data:MP.encodeFunctionData("price",[])},"latest"],12000);
  if(raw&&raw!=="0x"){const p=MP.decodeFunctionResult("price",raw)[0];console.error("  Morpho price(): "+ethers.formatUnits(p,36)+" USD")}
  else console.error("  price(): no data")}catch(e){console.error("  price(): N/A")}
  
  console.error("Done.");
})().catch(e=>console.error(e.message));
