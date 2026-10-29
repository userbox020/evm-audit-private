const{ethers}=require("ethers");const{rpcCall}=require("./shared-rpc");
(async()=>{
  const SONIC="https://sonic-rpc.publicnode.com";
  const j=JSON.parse(require("fs").readFileSync("C:/_Work/__EVM_AUDIT/reports/raw/fast/silo-v2-phase0.json","utf8"));
  const sonicRows=(j.pairRows||[]).filter(r=>r.chainId===146&&r.collateralSilo&&r.borrowSymbol);
  console.error(`Sonic Silo pairs: ${sonicRows.length}`);
  const candidates=sonicRows.filter(r=>["wS","stS","wanS"].includes(r.collateralSymbol)&&(r.maxLtv||0)>0.9);
  console.error(`High-LTV: ${candidates.length}`);
  for(const c of candidates.slice(0,6)){
    const oracle=c.maxLtvOracle||c.solvencyOracle;
    if(!oracle){console.error(`  ${c.collateralSymbol}/${c.borrowSymbol}: no oracle`);continue}
    console.error(`  ${c.collateralSymbol}/${c.borrowSymbol}: LTV=${c.maxLtv} oracle=${oracle.slice(0,12)}`);
    const CL=new ethers.Interface(["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"]);
    try{const raw=await rpcCall(SONIC,"eth_call",[{to:oracle,data:CL.encodeFunctionData("latestRoundData",[])},"latest"],12000);
    if(raw&&raw!=="0x"){const d=CL.decodeFunctionResult("latestRoundData",raw);const age=Math.floor(Date.now()/1000)-Number(d[3]);console.error(`    Chainlink age=${age}s`)}else console.error(`    No Chainlink`)}catch(e){console.error(`    Not Chainlink`)}
  }
  console.log("Done.");
})().catch(e=>console.error(e.message));
