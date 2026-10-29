#!/usr/bin/env node
// full-attack-test-fraxusd.js - 17-point test on Frax USD ecosystem
const{ethers}=require("ethers");const{resolveRpc,rpcCall}=require("./shared-rpc");
const fs=require("fs");const path=require("path");
const WORKSPACE=path.resolve(__dirname,"..");const OUT=path.join(WORKSPACE,"reports","raw","fast","full-attack-test-fraxusd.json");
const PROBE_FROM="0x000000000000000000000000000000000000dEaD";

function ensureDir(f){fs.mkdirSync(path.dirname(f),{recursive:true})}
function jsonReplacer(_k,v){return typeof v==="bigint"?v.toString():v}
function round(v,d=2){const n=Number(v);return Number.isFinite(n)?Math.round(n*(10**d))/(10**d):null}

const FRXUSD="0xCAcd6fd266aF91b8AeD52aCCc382b4e165586E29";
const SFRXUSD="0xcf62F905562626CfcDD2261162a51fd02Fc9c5b6";
const ORACLE1="0x25DEd2f9aE6ae9416693AB63Abe3aB25493861FD";
const ORACLE2="0x9B4a96210bc8D9D55b1908B465D8B0de68B7fF83";

async function callRpc(rpc,to,iface,fn,args=[],ms=12000){
  try{const raw=await rpcCall(rpc,"eth_call",[{to,data:iface.encodeFunctionData(fn,args)},"latest"],ms);return raw&&raw!=="0x"?raw:null}catch(_){return null}
}

async function main(){
  const rpc=await resolveRpc(1);if(!rpc)throw new Error("No RPC");
  const checks={};
  
  // CHECK 1: Permissionless surface on frxUSD token
  console.error("=== CHECK 1: Permissionless Surface ===");
  const PERM_SIGS=["mint(address,uint256)","burn(uint256)","burnFrom(address,uint256)","pause()","unpause()","sweep(address)"];
  const ERC20_IF=new ethers.Interface(["function symbol() view returns (string)","function owner() view returns (address)","function paused() view returns (bool)"]);
  const ERC4626_IF=new ethers.Interface(["function totalAssets() view returns (uint256)","function totalSupply() view returns (uint256)","function convertToAssets(uint256) view returns (uint256)","function maxDeposit(address) view returns (uint256)","function asset() view returns (address)"]);
  
  const permResults=[];
  for(const target of[{label:"frxUSD",addr:FRXUSD},{label:"sfrxUSD",addr:SFRXUSD}]){
    // Random selector control
    let randOk=false;try{await rpcCall(rpc,"eth_call",[{from:PROBE_FROM,to:target.addr,data:"0xdeadbeef"},"latest"],8000);randOk=true}catch(_){}
    for(const sig of PERM_SIGS){
      const fn=sig.slice(0,sig.indexOf("("));const iface=new ethers.Interface(["function "+sig]);
      try{const raw=await rpcCall(rpc,"eth_call",[{from:PROBE_FROM,to:target.addr,data:iface.encodeFunctionData(fn,[])},"latest"],8000);
      const retLen=raw&&raw!=="0x"?(raw.length-2)/2:0;
      if(retLen>0&&!randOk)permResults.push({token:target.label,sig,returndata:retLen})}catch(_){}
    }
    // ERC20 info
    const[sym,ow,paused]=await Promise.all([callRpc(rpc,target.addr,ERC20_IF,"symbol"),callRpc(rpc,target.addr,ERC20_IF,"owner"),callRpc(rpc,target.addr,ERC20_IF,"paused")]);
    console.error(`  ${target.label}: sym=${sym?ERC20_IF.decodeFunctionResult("symbol",sym)[0]:'?'} owner=${ow?ERC20_IF.decodeFunctionResult("owner",ow)[0]?.slice(0,12):'?'} paused=${paused?ERC20_IF.decodeFunctionResult("paused",paused)[0]:'?'}`);
  }
  checks.permissionless={probes:PERM_SIGS.length*2,realCallable:permResults.length,findings:permResults};

  // CHECK 2: sfrxUSD vault — donation vulnerability
  console.error("=== CHECK 2: sfrxUSD Vault ===");
  const[ta,ts,ca,md,asset]=await Promise.all([
    callRpc(rpc,SFRXUSD,ERC4626_IF,"totalAssets"),callRpc(rpc,SFRXUSD,ERC4626_IF,"totalSupply"),
    callRpc(rpc,SFRXUSD,ERC4626_IF,"convertToAssets",[10n**18n]),callRpc(rpc,SFRXUSD,ERC4626_IF,"maxDeposit",[PROBE_FROM]),
    callRpc(rpc,SFRXUSD,ERC4626_IF,"asset")]);
  const totalAssets=ta?Number(ethers.formatUnits(ERC4626_IF.decodeFunctionResult("totalAssets",ta)[0],18)):0;
  const exchangeRate=ca?Number(ethers.formatUnits(ERC4626_IF.decodeFunctionResult("convertToAssets",ca)[0],18)):0;
  const maxDep=md?ERC4626_IF.decodeFunctionResult("maxDeposit",md)[0].toString():null;
  const assetAddr=asset?ERC4626_IF.decodeFunctionResult("asset",asset)[0]:null;
  checks.vault={totalAssets:round(totalAssets),exchangeRate:round(exchangeRate,8),maxDeposit:maxDep,asset:assetAddr?.slice(0,12),depositsOpen:maxDep!=="0",verdict:maxDep==="0"?"DEPOSITS_CLOSED":"DEPOSITS_OPEN"};
  console.error(`  TotalAssets: $${round(totalAssets)}, Rate: ${round(exchangeRate,8)}, MaxDep: ${maxDep==="0"?"CLOSED":"OPEN"}`);

  // CHECK 3: Oracle audit
  console.error("=== CHECK 3: Oracle ===");
  const ORC_IF=new ethers.Interface(["function price() view returns (uint256)","function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)"]);
  const oracleResults=[];
  for(const[name,addr]of[["Oracle1",ORACLE1],["Oracle2",ORACLE2]]){
    const code=await rpcCall(rpc,"eth_getCode",[addr,"latest"],10000).catch(()=>"0x");const bytes=(code||"0x")!=="0x"?((code||"0x").length-2)/2:0;
    const price=await callRpc(rpc,addr,ORC_IF,"price");const priceVal=price?Number(ethers.formatUnits(ORC_IF.decodeFunctionResult("price",price)[0],8)):null;
    const roundData=await callRpc(rpc,addr,ORC_IF,"latestRoundData");
    let age=null;if(roundData){const d=ORC_IF.decodeFunctionResult("latestRoundData",roundData);age=Math.floor(Date.now()/1000)-Number(d[3])}
    oracleResults.push({name,bytes,price:priceVal,age,type:bytes>1000?"chainlink-aggregator":bytes>100?"custom":"minimal"});
    console.error(`  ${name}: ${bytes}B price=$${priceVal} age=${age}s`);
  }
  checks.oracle=oracleResults;

  // CHECK 4: Aave V3 consumer state — frxUSD on Aave V3 Ethereum
  console.error("=== CHECK 4: Aave Consumer ===");
  const AAVE_POOL="0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
  const AAVE_IF=new ethers.Interface(["function getReserveData(address) view returns (tuple(uint256) configuration,uint128 liquidityIndex,uint128 currentLiquidityRate,uint128 variableBorrowIndex,uint128 currentVariableBorrowRate,uint128 currentStableBorrowRate,uint40 lastUpdateTimestamp,uint16 id,address aTokenAddress,address stableDebtTokenAddress,address variableDebtTokenAddress,address interestRateStrategyAddress,uint128 accruedToTreasury,uint128 unbacked,uint128 isolationModeTotalDebt)"]);
  const reserve=await callRpc(rpc,AAVE_POOL,AAVE_IF,"getReserveData",[FRXUSD]);
  let aaveConfig=null;
  if(reserve){const d=AAVE_IF.decodeFunctionResult("getReserveData",reserve);const config=BigInt(d[0][0]);aaveConfig={ltv:Number((config>>0n)&0xffffn)/10000,liqThreshold:Number((config>>16n)&0xffffn)/10000,active:Boolean((config>>56n)&1n),frozen:Boolean((config>>57n)&1n),borrowingEnabled:Boolean((config>>58n)&1n)}};
  checks.aaveConsumer=aaveConfig;
  console.error(`  frxUSD on Aave: LTV=${aaveConfig?.ltv}% LT=${aaveConfig?.liqThreshold}% active=${aaveConfig?.active} borrow=${aaveConfig?.borrowingEnabled}`);
  
  const verdict=aaveConfig?.borrowingEnabled?"BORROW_ENABLED":aaveConfig?.active?"LISTED_NO_BORROW":"NOT_LISTED";
  const overall=aaveConfig?.borrowingEnabled?"HAS_BORROW_SURFACE":"ROUTE_NEGATIVE";
  
  const output={generatedAt:new Date().toISOString(),checks,overallVerdict:overall};
  ensureDir(OUT);fs.writeFileSync(OUT,JSON.stringify(output,jsonReplacer,2));
  console.log(JSON.stringify({permissionless:permResults.length,aaveConsumer:verdict,vault:checks.vault.verdict,overall}));
}

main().catch(e=>{console.error(e.message);process.exit(1)});
