#!/usr/bin/env node
const{ethers}=require("ethers");const{rpcCall,resolveRpcPool}=require("./shared-rpc");
(async()=>{
  const chains=[{id:1,n:'ETH',p:'0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2'},{id:42161,n:'ARB',p:'0x794a61358D6845594F94dc1DB02A252b5b4814aD'},{id:10,n:'OPT',p:'0x794a61358D6845594F94dc1DB02A252b5b4814aD'},{id:8453,n:'BASE',p:'0xA238Dd80C259a72e81d7e4664a9801593F98d1c5'}];
  const rpcPool=await resolveRpcPool(chains.map(c=>c.id));
  const POOL=new ethers.Interface(["function getReservesList() view returns (address[])","function getEModeCategoryData(uint8) view returns (tuple(uint16,uint16,uint16,address,string))"]);
  const ERC20=new ethers.Interface(["function symbol() view returns (string)"]);
  const DATA=new ethers.Interface(["function getReserveData(address) view returns (tuple(uint256),uint128,uint128,uint128,uint128,uint128,uint40,uint16,address,address,address,address,uint128,uint128,uint128)"]);
  for(const c of chains){
    const rpc=rpcPool[c.id];if(!rpc){console.log(c.n+": no RPC");continue}
    let eCount=0;
    try{
      const res=await rpcCall(rpc,"eth_call",[{to:c.p,data:POOL.encodeFunctionData("getReservesList",[])},"latest"],12000);
      const list=POOL.decodeFunctionResult("getReservesList",res)[0];
      for(const r of list.slice(0,20)){
        try{
          const rd=await rpcCall(rpc,"eth_call",[{to:c.p,data:DATA.encodeFunctionData("getReserveData",[r])},"latest"],12000);
          const config=BigInt(DATA.decodeFunctionResult("getReserveData",rd)[0][0]);
          const eId=Number((config>>176n)&0xffn);
          if(eId>0){eCount++;
            const em=await rpcCall(rpc,"eth_call",[{to:c.p,data:POOL.encodeFunctionData("getEModeCategoryData",[eId])},"latest"],12000);
            const ed=POOL.decodeFunctionResult("getEModeCategoryData",em);
            const ltv=Number(ed[0][0])/100;
            const sym=await rpcCall(rpc,"eth_call",[{to:r,data:ERC20.encodeFunctionData("symbol",[])},"latest"],8000);
            console.log("  "+c.n+" "+ERC20.decodeFunctionResult("symbol",sym)[0]+" eMode="+eId+" LTV="+ltv+"% "+ed[0][4]);
          }
        }catch(e){}
      }
    }catch(e){}
    console.log(c.n+": "+eCount+" eMode reserves");
  }
})().catch(e=>console.error(e.message));
