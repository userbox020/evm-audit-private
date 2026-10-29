#!/usr/bin/env node
// aave-v3-autopilot.js - Read-only Aave V3 HF watcher + auto fork trigger pipeline.
// Monitors HF, alerts on trigger, optionally auto-runs fork test when HF < 1.
// Never reads private keys, never signs, never deploys, never calls exploit execute().

const fs=require("fs");const path=require("path");
const{ethers}=require("ethers");const{rpcCall,resolveRpc}=require("./shared-rpc");
const{spawnSync}=require("child_process");

const WORKSPACE=path.resolve(__dirname,"..");
const USER="0x1a557354c5b8d7df38ea914209e416dc7065b158";
const POOL="0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
const STATUS_FILE=path.join(WORKSPACE,"reports","monitor","aave-v3-autopilot-status.json");
const ALERT_FILE=path.join(WORKSPACE,"reports","monitor","aave-v3-trigger-alert.json");
const FORK_SCRIPT=path.join(__dirname,"auto-fork-aave-v3-liquidation.js");

const args=process.argv.slice(2);
const ONCE=args.includes("--once");
const AUTO_FORK=args.includes("--auto-fork");
const QUIET=args.includes("--quiet");
const INTERVAL_MS=Math.max(10000,Number(args.find(a=>a.startsWith("--interval="))?.split("=")[1]||"300000"));
const MAX_CYCLES=Math.max(1,Number(args.find(a=>a.startsWith("--max-cycles="))?.split("=")[1]||(ONCE?"1":"999999")));

const AAVE=new ethers.Interface(["function getUserAccountData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256)"]);

function writeStatus(s){
  fs.mkdirSync(path.dirname(STATUS_FILE),{recursive:true});
  fs.writeFileSync(STATUS_FILE,JSON.stringify({...s,updatedAt:new Date().toISOString()},null,2));
}

async function checkHF(){
  const r=await resolveRpc(1);if(!r)throw new Error("No RPC");
  const raw=await rpcCall(r,"eth_call",[{to:POOL,data:AAVE.encodeFunctionData("getUserAccountData",[USER])},"latest"],12000);
  if(!raw||raw==="0x")return null;
  const d=AAVE.decodeFunctionResult("getUserAccountData",raw);
  const hf=Number(ethers.formatUnits(d[5],18));
  const debt=Number(ethers.formatUnits(d[1],8));
  const coll=Number(ethers.formatUnits(d[0],8));
  const bps=(hf>1?((hf-1)*10000):0);
  return{time:new Date().toISOString(),hf,debt:Math.round(debt),coll:Math.round(coll),bpsToLiq:bps.toFixed(2),liquidatable:hf<1};
}

function runForkTest(){
  if(!fs.existsSync(FORK_SCRIPT)){console.error("Fork script not found:",FORK_SCRIPT);return null}
  console.error("\n🚨 TRIGGER! Running fork test: "+FORK_SCRIPT);
  const r=spawnSync(process.execPath,[FORK_SCRIPT],{cwd:__dirname,encoding:"utf8",maxBuffer:10*1024*1024,timeout:300000});
  if(r.status!==0){console.error("Fork test FAILED:",r.stderr?.slice(0,200));return{success:false,error:r.stderr?.slice(0,200)}}
  console.error("Fork test completed.");
  try{return JSON.parse(r.stdout||"{}")}catch(_){return{success:true,raw:r.stdout?.slice(0,500)}}
}

(async()=>{
  console.error(`Aave V3 Autopilot — ${USER}\nAuto-fork: ${AUTO_FORK}, Interval: ${INTERVAL_MS/1000}s, Max cycles: ${MAX_CYCLES}\n`);
  
  let cycle=0;let lastBps=null;let forkRun=false;
  while(cycle<MAX_CYCLES){
    cycle++;const s=await checkHF();
    if(!s){console.error("RPC FAIL — retrying in 10s");await new Promise(r=>setTimeout(r,10000));continue}
    
    const trend=lastBps!==null?(Number(s.bpsToLiq)>lastBps?"↑":"↓"):"—";
    const alert=s.liquidatable?"🚨 LIQUIDATABLE":"✅";
    const status=`[${cycle}/${MAX_CYCLES}] ${s.time.slice(11,19)} ${alert} HF=${s.hf.toFixed(6)} $${s.debt.toLocaleString()} ${s.bpsToLiq}bps ${trend}`;
    if(!QUIET)console.error(status);
    
    // Save status
    writeStatus({...s,cycle,autoFork:AUTO_FORK,forkRun,status:s.liquidatable?"LIQUIDATABLE":"WATCHING"});
    
    // Trigger fork test on liquidation
    if(s.liquidatable&&AUTO_FORK&&!forkRun){
      fs.mkdirSync(path.dirname(ALERT_FILE),{recursive:true});
      fs.writeFileSync(ALERT_FILE,JSON.stringify({...s,triggeredAt:new Date().toISOString()},null,2));
      
      const forkResult=runForkTest();
      forkRun=true;
      writeStatus({...s,cycle,autoFork:AUTO_FORK,forkRun:true,forkResult});
      
      if(!QUIET)console.log(JSON.stringify({trigger:true,forkResult},null,2));
    }
    
    if(ONCE)break;
    lastBps=Number(s.bpsToLiq);
    await new Promise(r=>setTimeout(r,INTERVAL_MS));
  }
  
  console.error(`\nAutopilot stopped after ${cycle} cycles. Fork test ran: ${forkRun}`);
})().catch(e=>{console.error(e.message);process.exit(1)});
