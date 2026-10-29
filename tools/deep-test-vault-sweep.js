#!/usr/bin/env node
// deep-test-vault-sweep.js - Probe non-proxy vaults for permissionless sweep/migrate.
// Key improvement: filter OUT proxy contracts, validate with returndata.
const{ethers}=require("ethers");const{resolveRpc,rpcCall}=require("./shared-rpc");
const fs=require("fs");const path=require("path");
const WORKSPACE=path.resolve(__dirname,"..");const OUT=path.join(WORKSPACE,"reports","raw","fast","deep-test-vault-sweep.json");
const PROBE_FROM="0x000000000000000000000000000000000000dEaD";
const EIP1967_IMPL="0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

function ensureDir(f){fs.mkdirSync(path.dirname(f),{recursive:true})}
function jsonReplacer(_k,v){return typeof v==="bigint"?v.toString():v}
function normalizeAddress(v){try{return ethers.getAddress(String(v||""))}catch(_){return null}}
function round(v,d=2){const n=Number(v);return Number.isFinite(n)?Math.round(n*(10**d))/(10**d):null}

const DRAIN_SIGS=["sweep(address)","sweep(address,uint256)","rescueTokens(address,address,uint256)","withdraw(uint256)","withdraw(address,uint256)","migrate()","harvest()","emergencyWithdraw(uint256)","emergencyWithdraw()","claim()","claim(address)","recoverERC20(address,uint256)","execute(address,uint256,bytes)"];

// Collect addresses from the 3 artifacts that have rich contract data
async function collectAddresses(){
  const sources=[
    {file:"reports/raw/fast/deprecated-orphaned-reachability.json",max:50},
    {file:"reports/raw/fast/recent-contracts-old-money.json",max:50},
    {file:"reports/raw/fast/post-audit-deployed-map.json",max:50},
  ];
  const seen=new Set();
  for(const src of sources){
    try{const j=JSON.parse(fs.readFileSync(path.join(WORKSPACE,src.file),"utf8"));
    const text=JSON.stringify(j);const matches=text.match(/0x[0-9a-fA-F]{40}/g)||[];
    for(const m of matches)seen.add(m.toLowerCase())}catch(_){}
  }
  return [...seen].slice(0,100); // top 100 unique addresses
}

async function main(){
  const rpc=await resolveRpc(1);if(!rpc)throw new Error("No RPC");
  
  console.error("Collecting addresses...");
  const addresses=await collectAddresses();
  console.error(`Collected ${addresses.length} unique addresses`);
  
  // Phase 1: Filter for contracts with code AND NOT proxies
  const nonProxyAddrs=[];
  for(const addr of addresses.slice(0,80)){
    const code=await rpcCall(rpc,"eth_getCode",[addr,"latest"],10000).catch(()=>"0x");
    const bytes=(code||"0x")!=="0x"?((code||"0x").length-2)/2:0;
    if(bytes===0||bytes<100)continue; // no-code or too small
    // Check if proxy: read EIP-1967 impl slot
    const impl=await rpcCall(rpc,"eth_getStorageAt",[addr,EIP1967_IMPL,"latest"],8000).catch(()=>null);
    const isProxy=impl&&impl!=="0x"&&impl!=="0x"+"0".repeat(64);
    if(isProxy)continue; // skip proxies
    const bal=await rpcCall(rpc,"eth_getBalance",[addr,"latest"],8000).catch(()=>"0x");
    const ethBal=bal?Number(ethers.formatEther(BigInt(bal))):0;
    if(ethBal<0.1)continue; // only contracts with >$300 ETH
    nonProxyAddrs.push({addr,bytes,ethBal:round(ethBal,4)});
  }
  console.error(`Non-proxy contracts with >0.1 ETH: ${nonProxyAddrs.length}`);
  
  // Phase 2: Probe drain functions on non-proxy contracts with returndata validation
  const findings=[];
  for(const c of nonProxyAddrs.slice(0,20)){
    // Random-selector control
    let randomRet=0;
    try{const raw=await rpcCall(rpc,"eth_call",[{from:PROBE_FROM,to:c.addr,data:"0xdeadbeef"},"latest"],8000);randomRet=raw&&raw!=="0x"?(raw.length-2)/2:0}catch(_){}
    if(randomRet>0){console.error(`  ${c.addr.slice(0,10)}: fallback accepts random (skip)`);continue} // has fallback
    
    for(const sig of DRAIN_SIGS){
      const fn=sig.slice(0,sig.indexOf("("));
      const iface=new ethers.Interface(["function "+sig]);
      try{
        const raw=await rpcCall(rpc,"eth_call",[{from:PROBE_FROM,to:c.addr,data:iface.encodeFunctionData(fn,[])},Math.floor(Date.now()/1000).toString(16)],8000);
        const retLen=raw&&raw!=="0x"?(raw.length-2)/2:0;
        if(retLen>0&&randomRet===0){ // real function, not fallback
          findings.push({addr:c.addr.slice(0,12),ethBal:c.ethBal,sig,returndata:retLen,bytes:c.bytes});
        }
      }catch(_){} // function reverted — that's good (access control works)
    }
  }
  
  console.error(`Real callable drain functions: ${findings.length}`);
  findings.forEach(f=>console.error(`  ${f.addr} ${f.sig} ret=${f.returndata}B ETH=${f.ethBal}`));
  
  const output={generatedAt:new Date().toISOString(),scanner:"tools/deep-test-vault-sweep.js",summary:{addressesCollected:addresses.length,nonProxy:nonProxyAddrs.length,findings:findings.length,routePositive:findings.length>0?1:0},findings};
  ensureDir(OUT);fs.writeFileSync(OUT,JSON.stringify(output,jsonReplacer,2));
  console.log(JSON.stringify({nonProxy:nonProxyAddrs.length,realCallable:findings.length,routePositive:findings.length>0}));
}

main().catch(e=>{console.error(e.message);process.exit(1)});
