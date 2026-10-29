#!/usr/bin/env node
// deep-dive-dolomite.js - Comprehensive Dolomite Margin protocol probe on Berachain.
// RedStone + Chainsight oracle analysis, permissionless surface, liquidation mechanics.
const{ethers}=require("ethers");const{rpcCall,resolveRpcPool}=require("./shared-rpc");
const fs=require("fs");const path=require("path");
const WORKSPACE=path.resolve(__dirname,"..");const OUT=path.join(WORKSPACE,"reports","raw","fast","deep-dive-dolomite.json");

function round(v,d=2){const n=Number(v);return Number.isFinite(n)?Math.round(n*(10**d))/(10**d):null}
function jsonReplacer(_k,v){return typeof v==="bigint"?v.toString():v}
function normalizeAddress(v){try{return ethers.getAddress(String(v||""))}catch(_){return null}}

async function callRpc(rpc,to,iface,fn,args=[],ms=12000){
  try{const raw=await rpcCall(rpc,"eth_call",[{to,data:iface.encodeFunctionData(fn,args)},"latest"],ms);return raw&&raw!=="0x"?raw:null}catch(e){return null}
}

async function main(){
  const rpcPool=await resolveRpcPool([80094,1]);const bera=rpcPool[80094];const eth=rpcPool[1];
  if(!bera){console.log("No Berachain RPC");return}
  if(!eth)console.log("No Ethereum RPC (cross-chain comparison limited)");
  
  const MARGIN="0x003Ca23Fd5F0ca87D01F6eC6CD14A8AE60c2b97D"; // Berachain Margin
  
  const checks={};
  
  // ===== CHECK 1: Contract Identity =====
  console.error("=== CHECK 1: Contract Identity ===");
  const code=await rpcCall(bera,"eth_getCode",[MARGIN,"latest"],10000);
  checks.codeBytes=code&&code!=="0x"?(code.length-2)/2:0;
  console.error("  Code: "+checks.codeBytes+" bytes");
  
  // Check if same address on Ethereum
  if(eth){const ethCode=await rpcCall(eth,"eth_getCode",[MARGIN,"latest"],10000);
  checks.ethereumSameAddress=(ethCode&&ethCode!=="0x"?(ethCode.length-2)/2:0)>0;
  console.error("  Same address on ETH: "+checks.ethereumSameAddress)}
  
  // ===== CHECK 2: Access Control =====
  console.error("=== CHECK 2: Access Control ===");
  const ADMIN_IF=new ethers.Interface(["function owner() view returns (address)","function getAdmin() view returns (address)","function paused() view returns (bool)"]);
  const[ownerRaw,adminRaw,pausedRaw]=await Promise.all(["owner","getAdmin","paused"].map(fn=>callRpc(bera,MARGIN,ADMIN_IF,fn)));
  const owner=ownerRaw?ADMIN_IF.decodeFunctionResult("owner",ownerRaw)[0]:null;
  const admin=adminRaw?ADMIN_IF.decodeFunctionResult("getAdmin",adminRaw)[0]:null;
  checks.paused=pausedRaw?ADMIN_IF.decodeFunctionResult("paused",pausedRaw)[0]:null;
  if(owner){const c=await rpcCall(bera,"eth_getCode",[owner,"latest"],8000);checks.ownerType=(c&&c!=="0x"?"contract":"EOA")}
  console.error("  Owner: "+(owner||"?")+" ("+(checks.ownerType||"?")+") Paused: "+checks.paused);
  
  // ===== CHECK 3: Market Enumeration =====
  console.error("=== CHECK 3: Markets ===");
  const MARKET_IF=new ethers.Interface(["function getNumMarkets() view returns (uint256)","function getMarketIdFromTokenAddress(address) view returns (uint256)","function getMarketTokenAddress(uint256) view returns (address)","function getMarketPrice(uint256) view returns (uint256)"]);
  const numRaw=await callRpc(bera,MARGIN,MARKET_IF,"getNumMarkets");
  const numMarkets=numRaw?Number(MARKET_IF.decodeFunctionResult("getNumMarkets",numRaw)[0]):0;
  console.error("  Markets: "+numMarkets);
  checks.numMarkets=numMarkets;
  
  // Enumerate first 5 markets
  const markets=[];
  const ERC20=new ethers.Interface(["function symbol() view returns (string)","function decimals() view returns (uint8)"]);
  for(let i=0;i<Math.min(numMarkets,10);i++){
    const tokenRaw=await callRpc(bera,MARGIN,MARKET_IF,"getMarketTokenAddress",[i]);
    const token=tokenRaw?MARKET_IF.decodeFunctionResult("getMarketTokenAddress",tokenRaw)[0]:null;
    if(!token)continue;
    const[symRaw,priceRaw]=await Promise.all([callRpc(bera,token,ERC20,"symbol"),callRpc(bera,MARGIN,MARKET_IF,"getMarketPrice",[i])]);
    const sym=symRaw?ERC20.decodeFunctionResult("symbol",symRaw)[0]:null;
    let price=null;if(priceRaw){price=round(Number(ethers.formatUnits(MARKET_IF.decodeFunctionResult("getMarketPrice",priceRaw)[0],18)),4)}
    markets.push({id:i,token:token?.slice(0,12),symbol:sym,price});
  }
  checks.markets=markets;
  
  // ===== CHECK 4: Oracle Investigation =====
  console.error("=== CHECK 4: Oracle ===");
  // Try common oracle getters
  const ORACLE_IF=new ethers.Interface(["function getOracle() view returns (address)","function oracle() view returns (address)","function getPriceOracle() view returns (address)"]);
  let oracleAddr=null;
  for(const fn of["getOracle","oracle","getPriceOracle"]){
    const raw=await callRpc(bera,MARGIN,ORACLE_IF,fn);
    if(raw){oracleAddr=ORACLE_IF.decodeFunctionResult(fn,raw)[0];break}
  }
  checks.oracleAddress=oracleAddr;
  if(oracleAddr){
    const oCode=await rpcCall(bera,"eth_getCode",[oracleAddr,"latest"],10000);
    checks.oracleBytes=oCode&&oCode!=="0x"?(oCode.length-2)/2:0;
    // Check if it's RedStone or Chainsight
    const lower=(oCode||"").toLowerCase();
    checks.oracleIsRedStone=lower.includes("72656473746f6e65")||lower.includes("72645f"); // "redstone" hex
    checks.oracleIsChainlink=lower.includes("6c6174657374526f756e")||lower.includes("f599b40");
    console.error("  Oracle: "+(oracleAddr?.slice(0,12))+" bytes="+checks.oracleBytes+" redstone="+checks.oracleIsRedStone+" chainlink="+checks.oracleIsChainlink);
  }
  
  // ===== CHECK 5: Permissionless Surface =====
  console.error("=== CHECK 5: Permissionless Probes ===");
  const DEAD="0x000000000000000000000000000000000000dEaD";
  const PROBES=["mint(address,uint256)","burn(uint256)","withdraw(uint256)","liquidate(address,uint256)","sweep(address)","claim()","harvest()","pause()","unpause()"];
  const permResults=[];
  for(const sig of PROBES){
    const fn=sig.slice(0,sig.indexOf("("));const iface=new ethers.Interface(["function "+sig]);
    try{const raw=await rpcCall(bera,"eth_call",[{from:DEAD,to:MARGIN,data:iface.encodeFunctionData(fn,[])},"latest"],12000);
    const retLen=raw&&raw!=="0x"?(raw.length-2)/2:0;
    // Check if random selector also returns data (proxy fallback)
    if(retLen>0){const randRaw=await rpcCall(bera,"eth_call",[{from:DEAD,to:MARGIN,data:"0xdeadbeef"},"latest"],8000);const randRet=randRaw&&randRaw!=="0x"?(randRaw.length-2)/2:0;
    if(retLen>randRet)permResults.push({sig,returndata:retLen,likelyReal:true})}
    }catch(e){}}
  checks.permissionless={probes:PROBES.length,realCallable:permResults.length,findings:permResults};
  console.error("  Real callable: "+permResults.length);
  permResults.forEach(p=>console.error("    "+p.sig+" ret="+p.returndata+"B"));

  // ===== CHECK 6: Liquidation / Margin Call =====
  console.error("=== CHECK 6: Margin Economics ===");
  if(markets.length>0){
    // Check if getMarketPrice returns sensible values
    const m0=markets[0];
    if(m0.price&&m0.symbol)console.error("  "+m0.symbol+" price: $"+m0.price);
  }

  // ===== CHECK 7: Cross-chain comparison (Ethereum) =====
  console.error("=== CHECK 7: Ethereum Comparison ===");
  if(eth&&checks.ethereumSameAddress){
    const ethNumRaw=await callRpc(eth,MARGIN,MARKET_IF,"getNumMarkets");
    const ethNum=ethNumRaw?Number(MARKET_IF.decodeFunctionResult("getNumMarkets",ethNumRaw)[0]):0;
    checks.ethereumNumMarkets=ethNum;
    console.error("  ETH markets: "+ethNum+" (Berachain: "+numMarkets+")");
  }

  // ===== Final =====
  const output={generatedAt:new Date().toISOString(),scanner:"tools/deep-dive-dolomite.js",checks,
    overallVerdict:checks.permissionless.realCallable>0?"PERMISSIONLESS_SURFACE":
    checks.numMarkets>0?"MARKETS_FOUND_NEEDS_DEEPER_ANALYSIS":"NO_EXPLOITABLE_SURFACE"};
  
  fs.mkdirSync(path.dirname(OUT),{recursive:true});
  fs.writeFileSync(OUT,JSON.stringify(output,jsonReplacer,2));
  
  console.log(JSON.stringify({codeBytes:checks.codeBytes,markets:checks.numMarkets,oracle:checks.oracleAddress?.slice(0,12),oracleBytes:checks.oracleBytes,permissionless:permResults.length,verdict:output.overallVerdict},null,2));
}

main().catch(e=>{console.error(e.message);process.exit(1)});
