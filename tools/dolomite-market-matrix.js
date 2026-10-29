#!/usr/bin/env node
// dolomite-market-matrix.js - Build complete market-oracle matrix for Dolomite Berachain.
const{ethers}=require("ethers");const{rpcCall,resolveRpcPool}=require("./shared-rpc");
const fs=require("fs");const path=require("path");
const WORKSPACE=path.resolve(__dirname,"..");const OUT=path.join(WORKSPACE,"reports","raw","fast","dolomite-market-matrix.json");

function round(v,d=2){const n=Number(v);return Number.isFinite(n)?Math.round(n*(10**d))/(10**d):null}

async function main(){
  const rpc=await resolveRpcPool([80094]);const B=rpc[80094];
  if(!B){console.log("No Berachain RPC");return}
  const M="0x003Ca23Fd5F0ca87D01F6eC6CD14A8AE60c2b97D";
  
  const MRKT=new ethers.Interface(["function getNumMarkets() view returns (uint256)","function getMarketTokenAddress(uint256) view returns (address)","function getMarketPrice(uint256) view returns (uint256)","function getMarketTotalPar(uint256) view returns (tuple(uint128,uint128))"]);
  const ERC20=new ethers.Interface(["function symbol() view returns (string)","function name() view returns (string)","function decimals() view returns (uint8)","function totalSupply() view returns (uint256)"]);
  
  const numRaw=await rpcCall(B,"eth_call",[{to:M,data:MRKT.encodeFunctionData("getNumMarkets",[])},"latest"],12000);
  const num=numRaw?Number(MRKT.decodeFunctionResult("getNumMarkets",numRaw)[0]):0;
  console.error("Markets:",num);
  
  const markets=[];
  for(let i=0;i<Math.min(num,48);i++){
    const tokRaw=await rpcCall(B,"eth_call",[{to:M,data:MRKT.encodeFunctionData("getMarketTokenAddress",[i])},"latest"],12000);
    const token=tokRaw?MRKT.decodeFunctionResult("getMarketTokenAddress",tokRaw)[0]:null;
    if(!token)continue;
    
    const[symRaw,nameRaw,decRaw,supplyRaw,priceRaw,parRaw]=await Promise.all([
      rpcCall(B,"eth_call",[{to:token,data:ERC20.encodeFunctionData("symbol",[])},"latest"],8000),
      rpcCall(B,"eth_call",[{to:token,data:ERC20.encodeFunctionData("name",[])},"latest"],8000),
      rpcCall(B,"eth_call",[{to:token,data:ERC20.encodeFunctionData("decimals",[])},"latest"],8000),
      rpcCall(B,"eth_call",[{to:token,data:ERC20.encodeFunctionData("totalSupply",[])},"latest"],8000),
      rpcCall(B,"eth_call",[{to:M,data:MRKT.encodeFunctionData("getMarketPrice",[i])},"latest"],12000),
      rpcCall(B,"eth_call",[{to:M,data:MRKT.encodeFunctionData("getMarketTotalPar",[i])},"latest"],12000),
    ].map(r=>r?.catch(()=>null)));
    
    const sym=symRaw?ERC20.decodeFunctionResult("symbol",symRaw)[0]:"?";
    const name=nameRaw?ERC20.decodeFunctionResult("name",nameRaw)[0]:"?";
    const dec=decRaw?Number(ERC20.decodeFunctionResult("decimals",decRaw)[0]):18;
    const supply=supplyRaw?Number(ethers.formatUnits(ERC20.decodeFunctionResult("totalSupply",supplyRaw)[0],dec)):0;
    let price=null;if(priceRaw)price=Number(ethers.formatUnits(MRKT.decodeFunctionResult("getMarketPrice",priceRaw)[0],18));
    let borrowPar=null,supplyPar=null;
    if(parRaw){const p=MRKT.decodeFunctionResult("getMarketTotalPar",parRaw);borrowPar=Number(ethers.formatUnits(p[0][0]||0,18));supplyPar=Number(ethers.formatUnits(p[0][1]||0,18))}
    
    const tokenType=sym.includes("LP")||sym.includes("BPT")?"LP":sym.includes("st")||sym.includes("rETH")||sym.includes("wst")?"LST":sym.includes("USDC")||sym.includes("USDT")||sym.includes("DAI")||sym.includes("HONEY")?"Stable":sym.includes("BTC")||sym.includes("WBTC")?"BTC":sym.includes("WETH")||sym.includes("ETH")?"ETH":"Other";
    
    markets.push({id:i,token,symbol:sym,name,decimals:dec,supply:round(supply),price:round(price,6),borrowPar:round(borrowPar),supplyPar:round(supplyPar),tokenType});
    console.error("  #"+i+": "+sym+" ("+tokenType+") price=$"+price+" borrowPar="+borrowPar+" supply="+round(supply));
  }
  
  // Score markets by exploitability
  const scored=markets.map(m=>{
    let score=0;const risks=[];
    if(m.tokenType==="LP"){score+=30;risks.push("LP-token")} else if(m.tokenType==="LST"){score+=25;risks.push("LST")} else if(m.tokenType==="Other"){score+=20;risks.push("exotic")} else score+=5;
    if(m.borrowPar>100000){score+=25;risks.push("material-borrows=$"+round(m.borrowPar))} else if(m.borrowPar>1000){score+=10;risks.push("some-borrows")}
    if(m.supply>1000000){score+=15;risks.push("material-supply")}
    if(!m.price||m.price===0){score-=20;risks.push("no-price")}
    return{...m,riskScore:score,risks};
  }).sort((a,b)=>b.riskScore-a.riskScore);
  
  const output={generatedAt:new Date().toISOString(),summary:{markets:num,scored:scored.length,highRisk:scored.filter(m=>m.riskScore>=40).length,routePositive:scored.some(m=>m.riskScore>=50)?1:0},markets:scored};
  fs.mkdirSync(path.dirname(OUT),{recursive:true});fs.writeFileSync(OUT,JSON.stringify(output));
  
  console.log(JSON.stringify({total:num,highRisk:output.summary.highRisk,top5:scored.slice(0,5).map(m=>({symbol:m.symbol,tokenType:m.tokenType,price:m.price,borrowPar:m.borrowPar,score:m.riskScore,risks:m.risks}))}));
}
main().catch(e=>{console.error(e.message);process.exit(1)});
