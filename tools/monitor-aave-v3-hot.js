#!/usr/bin/env node
// monitor-aave-v3-hot.js - Continuous HF monitoring for the Aave V3 hot borrower.
// Alerts when HF < 1 (borrower becomes liquidatable).
// Press Ctrl+C to stop. Use --once for single check.
const{ethers}=require("ethers");const{rpcCall,resolveRpc}=require("./shared-rpc");
const USER="0x1a557354c5b8d7df38ea914209e416dc7065b158";
const POOL="0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
const INTERVAL_MS=parseInt(process.env.AAVE_MONITOR_INTERVAL||"300000"); // 5min default

const AAVE=new ethers.Interface(["function getUserAccountData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256)"]);

async function check(){
  const r=await resolveRpc(1);if(!r)throw new Error("No RPC");
  const raw=await rpcCall(r,"eth_call",[{to:POOL,data:AAVE.encodeFunctionData("getUserAccountData",[USER])},"latest"],12000);
  if(!raw||raw==="0x"){console.error("RPC FAIL");return null}
  const d=AAVE.decodeFunctionResult("getUserAccountData",raw);
  const hf=Number(ethers.formatUnits(d[5],18));
  const debt=Number(ethers.formatUnits(d[1],8));
  const coll=Number(ethers.formatUnits(d[0],8));
  const bpsToLiq=hf>1?((hf-1)*10000):0;
  return{time:new Date().toISOString(),hf,debt:Math.round(debt),coll:Math.round(coll),bpsToLiq:bpsToLiq.toFixed(2),liquidatable:hf<1};
}

(async()=>{
  if(process.argv.includes("--once")){const s=await check();console.log(JSON.stringify(s,null,2));return}
  console.error(`Aave V3 Hot Monitor — ${USER}\nPolling every ${INTERVAL_MS/1000}s. Ctrl+C to stop.\n`);
  let lastBps=null;
  while(true){
    const s=await check();if(!s){await new Promise(r=>setTimeout(r,10000));continue}
    const trend=lastBps!==null?(s.bpsToLiq>lastBps?"↑":"↓"):"—";
    const alert=s.liquidatable?"🚨 LIQUIDATABLE! 🚨":s.hf<1.01?"⚠️ CLOSE":"✅";
    console.error(`${s.time.slice(11,19)} ${alert} HF=${s.hf.toFixed(6)} debt=$${s.debt.toLocaleString()} ${s.bpsToLiq}bps ${trend}`);
    if(s.liquidatable){
      const fs=require("fs");const path=require("path");
      const alertFile=path.join(path.resolve(__dirname,".."),"reports","monitor","aave-v3-trigger-alert.json");
      fs.writeFileSync(alertFile,JSON.stringify({...s,alert:"BORROWER LIQUIDATABLE",action:"Run fork test: tools/auto-fork-aave-v4-liquidation.js"},null,2));
      console.error("ALERT SAVED to reports/monitor/aave-v3-trigger-alert.json");
    }
    lastBps=s.bpsToLiq;
    await new Promise(r=>setTimeout(r,INTERVAL_MS));
  }
})().catch(e=>{console.error(e.message);process.exit(1)});
