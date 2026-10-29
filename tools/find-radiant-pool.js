const{ethers}=require("ethers");const{rpcCall,resolveRpc}=require("./shared-rpc");
(async()=>{
  const rpc=await resolveRpc(42161);if(!rpc){console.log("No RPC");return}
  const ORACLE="0xFf785dE8a851048a65CbE92C84d4167eF3Ce9BAC";
  const POOL="0x2032b9A8e9F7e76768CA9271003d3e43E1616B1F";
  
  // Check oracle code and interface
  const code=await rpcCall(rpc,"eth_getCode",[ORACLE,"latest"],10000);console.log("Oracle bytes:",code&&code!=="0x"?(code.length-2)/2:0);
  
  // Get asset prices via getAssetPrice()
  const ORACLE_IF=new ethers.Interface(["function getAssetPrice(address) view returns (uint256)","function getSourceOfAsset(address) view returns (address)"]);
  const ASSETS={WBTC:"0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f",USDT:"0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",USDC:"0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8",DAI:"0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",WETH:"0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",DAOT:"0xA130A97c841ffA12CFb5E3AEA503fD5825a39bA6"};
  
  console.log("\nAsset prices and oracle sources:");
  for(const[sym,addr]of Object.entries(ASSETS)){
    try{
      const[priceRaw,srcRaw]=await Promise.all([rpcCall(rpc,"eth_call",[{to:ORACLE,data:ORACLE_IF.encodeFunctionData("getAssetPrice",[addr])},"latest"],12000),rpcCall(rpc,"eth_call",[{to:ORACLE,data:ORACLE_IF.encodeFunctionData("getSourceOfAsset",[addr])},"latest"],12000)]);
      const price=priceRaw&&priceRaw!=="0x"?Number(ethers.formatUnits(ORACLE_IF.decodeFunctionResult("getAssetPrice",priceRaw)[0],8)):null;
      const src=srcRaw&&srcRaw!=="0x"?ORACLE_IF.decodeFunctionResult("getSourceOfAsset",srcRaw)[0]:null;
      console.log(`  ${sym}: $${price} source=${src?.slice(0,14)}...`);
      // Check if source is a Chainlink feed — probe latestRoundData
      if(src){
        const CL_IF=new ethers.Interface(["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)","function decimals() view returns (uint8)"]);
        try{const rd=await rpcCall(rpc,"eth_call",[{to:src,data:CL_IF.encodeFunctionData("latestRoundData",[])},"latest"],12000);
        if(rd&&rd!=="0x"){const d=CL_IF.decodeFunctionResult("latestRoundData",rd);const age=Math.floor(Date.now()/1000)-Number(d[3]);console.log(`    Chainlink: age=${age}s (${(age/60).toFixed(0)}min)`)}else{console.log(`    Not Chainlink (no latestRoundData)`)}
        }catch(e){console.log(`    Not Chainlink`)}
      }
    }catch(e){console.log(`  ${sym}: ERROR`)}
  }
  
  // Get LTV configuration from LendingPoolConfigurator via provider
  console.log("\nReserve configurations:");
  const PROV="0xe21B295ED46528eFD5F3EF66E18BC6ad1c87f003";
  const CONFIG_IF=new ethers.Interface(["function getPoolConfigurator() view returns (address)"]);
  try{
    const raw=await rpcCall(rpc,"eth_call",[{to:PROV,data:CONFIG_IF.encodeFunctionData("getPoolConfigurator",[])},"latest"],12000);
    const configurator=CONFIG_IF.decodeFunctionResult("getPoolConfigurator",raw)[0];
    console.log(`Configurator: ${configurator}`);
  }catch(e){console.log("No configurator")}
  
  // Direct reserve config from pool
  const POOL_IF=new ethers.Interface(["function getConfiguration(address) view returns (tuple(uint256))"]);
  for(const[sym,addr]of Object.entries(ASSETS)){
    try{
      const raw=await rpcCall(rpc,"eth_call",[{to:POOL,data:POOL_IF.encodeFunctionData("getConfiguration",[addr])},"latest"],12000);
      if(raw&&raw!=="0x"){
        const config=BigInt(POOL_IF.decodeFunctionResult("getConfiguration",raw)[0][0]);
        const ltv=Number((config>>0n)&0xffffn)/10000;
        const lt=Number((config>>16n)&0xffffn)/10000;
        const active=Boolean((config>>56n)&1n);
        const frozen=Boolean((config>>57n)&1n);
        const borrowEnabled=Boolean((config>>58n)&1n);
        console.log(`  ${sym}: LTV=${ltv}% LT=${lt}% active=${active} borrow=${borrowEnabled}`);
      }
    }catch(e){console.log(`  ${sym}: config ERROR`)}
  }
})().catch(e=>console.error(e.message));
