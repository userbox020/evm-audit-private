#!/usr/bin/env node
// Marginfi full oracle/LTV decoder — uses config@360 + I80F48
const fs=require("fs");const path=require("path");
const WORKSPACE=path.resolve(__dirname,"..");
const RPC_FILE=path.join(WORKSPACE,"rpc_endpoints.txt");
const META=path.join(WORKSPACE,"targets","p0","marginfi-v2","clients","rust","marginfi-cli","assets","mainnet_metadata_dump.json");
const OUT=path.join(WORKSPACE,"reports","raw","fast","marginfi-oracle-config.json");
const PROGRAM="MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA";
const CONFIG_OFF=360;

const OSET={"0":"None","1":"PythPush","2":"PythPull","3":"SwitchboardPush","4":"SwitchboardPull","5":"Scope","6":"KaminoReserve","7":"DriftSpot","8":"JupLend","9":"Fixed","10":"DriftOracle","11":"PythPushLA","12":"SwitchboardPullLA","13":"Staked","14":"SolendReserve"};
const OPS={"0":"Paused","1":"Operational","2":"ReduceOnly","3":"Killed"};
const RT={"0":"Collateral","1":"Isolated"};
function u8(b,o){return b.readUInt8(o)}
function u16(b,o){return b.readUInt16LE(o)}
function u64(b,o){return Number(b.readBigUInt64LE(o))}
function i80f48(b,o){let v=0n;for(let i=o+15;i>=o;i--)v=(v<<8n)|BigInt(b[i]);const n=(v>>127n)&1n;const m=n?((~v+1n)&((1n<<128n)-1n)):v;return Number(m)/2**48*(n?-1:1)}

function loadUrls(){
 if(!fs.existsSync(RPC_FILE))return[];
 return[...fs.readFileSync(RPC_FILE,"utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map(m=>m[0]).filter(u=>u.toLowerCase().includes("solana"));
}
async function tryRpc(urls,method,params,ms=15000){
 for(const u of urls){const c=new AbortController();const t=setTimeout(()=>c.abort(),ms);try{const r=await fetch(u,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method,params}),signal:c.signal});const j=await r.json();clearTimeout(t);if(!j.error&&j.result)return j.result}catch(_){clearTimeout(t)}}return null;
}

async function main(){
 const urls=loadUrls();
 // Get all banks
 const banks=await tryRpc(urls,"getProgramAccounts",[PROGRAM,{encoding:"base64",filters:[{dataSize:1864}]}],30000);
 if(!banks?.length){console.error("No banks");return}
 console.log(`Banks: ${banks.length}`);
 
 let meta=[];try{meta=JSON.parse(fs.readFileSync(META,"utf8"))}catch(_){}
 const metaMap={};for(const m of meta)metaMap[m.bankAddress]=m;

 const results=[];
 for(const entry of banks){
  const raw=entry.account?.data;
  if(!raw)continue;
  const b=Array.isArray(raw)?Buffer.from(raw[0],"base64"):Buffer.from(typeof raw==="string"?raw:raw[0]||"","base64");
  if(b.length<CONFIG_OFF+400)continue;
  
  const pubkey=entry.pubkey;
  const c=CONFIG_OFF;
  const st=u8(b,c+248),su=u8(b,c+249),rt=u8(b,c+360);
  const awi=i80f48(b,c),awm=i80f48(b,c+16);
  const lwi=i80f48(b,c+32),lwm=i80f48(b,c+48);
  const dep=u64(b,c+64),bor=u64(b,c+352);
  const ma=u16(b,c+376);
  const keysOk=su>=1&&su<=14&&awi>=0&&awi<=1;
  
  const mi=metaMap[pubkey];
  const name=mi?.bankName||mi?.ticker?.split("|")[0]?.trim()||"";
  const ticker=mi?.ticker?.split("|")[0]?.trim()||"";
  
  results.push({
   name,ticker,pubkey:pubkey.slice(0,20)+"...",
   opState:st,opLabel:OPS[st]||String(st),
   oracleSetup:su,oracleLabel:OSET[su]||String(su),
   riskTier:rt,riskLabel:RT[rt]||String(rt),
   assetWeightInit:round(awi,4),assetWeightMaint:round(awm,4),
   liabilityWeightInit:round(lwi,4),liabilityWeightMaint:round(lwm,4),
   depositLimit:dep,borrowLimit:bor,oracleMaxAge:ma,
   operational:st===1,
   highLTV:awi>=0.70&&st===1,
   decryptOK:keysOk,
   watchCandidate:awi>=0.70&&st===1&&(su===0||ma===0||ma>3600),
   routePositive:false
  });
 }
 
 function round(v,d=6){const n=typeof v==="number"?v:Number(String(v).replace(/[$,%_\s]/g,""));return Number.isFinite(n)?Number((Math.round(n*10**d)/10**d).toFixed(d)):null}
 
 const ok=results.filter(r=>r.decryptOK);
 const operational=ok.filter(r=>r.operational);
 const highLtv=ok.filter(r=>r.highLTV);
 const watch=ok.filter(r=>r.watchCandidate);
 
 const byOracle={};for(const r of ok)byOracle[r.oracleLabel]=(byOracle[r.oracleLabel]||0)+1;
 
 const art={generatedAt:new Date().toISOString(),scanner:"tools/scan-marginfi-oracle-config.js",
  scope:"Marginfi full oracle/LTV decode (config@360, I80F48)",safety:{rpcInventoryRead:true,rpcUrlsStored:false,signedActions:false,routePositive:false},
  summary:{banksDecoded:ok.length,oracleTypes:byOracle,operationalBanks:operational.length,highLTVBanks:highLtv.length,watchCandidates:watch.length,routePositive:0},
  topRows:highLtv.sort((a,b)=>(b.assetWeightInit||0)-(a.assetWeightInit||0)).slice(0,30),
  watchCandidates:watch.slice(0,30),
  oracleKeyNote:"Oracle pubkeys at config+250..config+346 (3x32 bytes). Not decoded here due to b58 issues.",
 };
 fs.mkdirSync(path.dirname(OUT),{recursive:true});fs.writeFileSync(OUT,JSON.stringify(art,null,2)+"\n");
 console.log(`\nDone: ${ok.length} banks, ${operational.length} operational, ${highLtv.length} high-LTV, ${watch.length} watch`);
 for(const[k,v]of Object.entries(byOracle))console.log(`  ${k}: ${v}`);
}
main().catch(e=>{console.error(e.stack||e.message);process.exitCode=1});
