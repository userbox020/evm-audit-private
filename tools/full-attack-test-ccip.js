#!/usr/bin/env node
// full-attack-test-ccip.js - 8-point test on CCIP TokenPools and TokenAdminRegistry
const fs=require("fs");const path=require("path");
const{ethers}=require("ethers");const{resolveRpcPool,rpcCall}=require("./shared-rpc");
const WORKSPACE=path.resolve(__dirname,"..");const OUT=path.join(WORKSPACE,"reports","raw","fast","full-attack-test-ccip.json");
const PROBE_FROM="0x000000000000000000000000000000000000dEaD";

function ensureDir(f){fs.mkdirSync(path.dirname(f),{recursive:true})}
function jsonReplacer(_k,v){return typeof v==="bigint"?v.toString():v}
function normalizeAddress(v){try{return ethers.getAddress(String(v||""))}catch(_){return null}}
function round(v,d=2){const n=Number(v);return Number.isFinite(n)?Math.round(n*(10**d))/(10**d):null}

const PROBE_SIGS=["mint(address,uint256)","burn(uint256)","burnFrom(address,uint256)","withdraw(uint256)","sweep(address)","rescueTokens(address,address,uint256)","claim()","pause()","unpause()","lockOrBurn(address,uint256,uint64,bytes32,bytes)","releaseOrMint(bytes)"];

async function probe(rpc,addr,sig,args=[]){
  const a=normalizeAddress(addr);if(!rpc||!a)return{success:false};
  const fn=sig.slice(0,sig.indexOf("("));const iface=new ethers.Interface(["function "+sig]);
  try{await rpcCall(rpc,"eth_call",[{from:PROBE_FROM,to:a,data:iface.encodeFunctionData(fn,args)},"latest"],8000);return{success:true}}catch(_){return{success:false}}
}

async function main(){
  const ccip=JSON.parse(fs.readFileSync(path.join(WORKSPACE,"reports/raw/fast/ccip-phase0.json"),"utf8"));
  const pools=(ccip.poolRows||[]).filter(p=>p.typeCategory==="LockRelease"&&p.poolCodePresent).slice(0,10);
  const registries=(ccip.chainRows||[]).filter(r=>r.codePresent).slice(0,5);
  
  const chainIds=[...new Set([...pools.map(p=>p.chainId),...registries.map(r=>r.chainId)])];
  const rpcPool=await resolveRpcPool(chainIds);
  
  const findings=[];
  console.error(`Probing ${pools.length} LockRelease pools + ${registries.length} registries`);
  
  for(const pool of pools){
    const rpc=rpcPool[pool.chainId];if(!rpc)continue;
    for(const sig of PROBE_SIGS){
    const res=await probe(rpc,pool.pool,sig);
    if(res.success)findings.push({contract:"LockReleasePool",token:pool.tokenSymbol,address:pool.pool?.slice(0,10),chain:pool.chainId,sig});
    }
  }
  
  for(const reg of registries){
    const rpc=rpcPool[reg.chainId];if(!rpc)continue;
    for(const sig of["pause()","unpause()","owner()","acceptOwnership()","setPool(address,address)"]){
    const res=await probe(rpc,reg.registry,sig);
    if(res.success)findings.push({contract:"Registry",chainId:reg.chainId,address:reg.registry?.slice(0,10),sig});
    }
  }
  
  console.error(`Found ${findings.length} callable functions`);
  
  // Check if any callable functions are actually dangerous
  // Key: lockOrBurn and releaseOrMint are bridge-specific
  const dangerous=findings.filter(f=>["lockOrBurn","releaseOrMint","mint","burn","pause","sweep"].some(s=>f.sig.includes(s)));
  
  const output={generatedAt:new Date().toISOString(),scanner:"tools/full-attack-test-ccip.js",summary:{poolsProbed:pools.length,registriesProbed:registries.length,totalFindings:findings.length,dangerousFindings:dangerous.length},findings,dangerous,verdict:dangerous.length>0?"POTENTIAL_DRAIN":"ROUTE_NEGATIVE"};
  
  ensureDir(OUT);fs.writeFileSync(OUT,JSON.stringify(output,jsonReplacer,2));
  
  console.log(JSON.stringify({pools:pools.length,registries:registries.length,findings:findings.length,dangerous:dangerous.length,dangerousList:dangerous.slice(0,10).map(d=>d.contract+":"+d.token+" "+d.sig),verdict:output.verdict},null,2));
}

main().catch(e=>{console.error(e.message);process.exit(1)});
