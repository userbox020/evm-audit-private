#!/usr/bin/env node
"use strict";

// Read-only event-count ranking. Endpoint material remains in memory.
const fs = require("fs");
const path = require("path");
const { resolveRpc, loadRpcUrls, rpcCall, PUBLIC_FALLBACKS } = require("./shared-rpc");
const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "reports", "raw", "fast", "synapse-cctp-step8.activity-ranking.json");
const ADDRESS = "0x12715a66773bd9c54534a01abf01d05f6b4bd35e";
const TOPIC = "0x7864397c00beabf21ab17a04795e450354505d879a634dd2632f4fdc4b5ba04e";
const START_TS = 1688169600n;
const CHAINS = [{name:"mainnet",chainId:1},{name:"arbitrum",chainId:42161},{name:"base",chainId:8453},{name:"optimism",chainId:10},{name:"polygon",chainId:137},{name:"avalanche",chainId:43114}];
const hx = x => "0x" + BigInt(x).toString(16);

async function block(url, n) { return rpcCall(url, "eth_getBlockByNumber", [typeof n === "string" ? n : hx(n), false], 20000); }
async function atTime(url, head) {
  let lo=0n,hi=head;
  while(lo<hi){const m=(lo+hi)>>1n,b=await block(url,m);if(!b)throw new Error("block unavailable");if(BigInt(b.timestamp)<START_TS)lo=m+1n;else hi=m;}
  return lo;
}
async function logEndpoint(chainId, from, head) {
  const candidates=[...new Set([...loadRpcUrls(),PUBLIC_FALLBACKS[chainId]].filter(Boolean))];
  let fallback=null;
  for(const url of candidates){
    const id=await rpcCall(url,"eth_chainId",[],3000);if(!id||parseInt(id,16)!==chainId)continue;
    const old=await rpcCall(url,"eth_getLogs",[{address:ADDRESS,fromBlock:hx(from),toBlock:hx(from+9n),topics:[TOPIC]}],10000);if(old==null)continue;
    for(const span of [5000000n,1000000n,100000n,50000n]){
      const a=head>span?head-span+1n:0n;
      const test=await rpcCall(url,"eth_getLogs",[{address:ADDRESS,fromBlock:hx(a),toBlock:hx(head),topics:[TOPIC]}],20000);
      if(test!=null){if(span===5000000n)return {url,span};if(!fallback||span>fallback.span)fallback={url,span};break;}
    }
  }
  if(!fallback)throw new Error("no historical log endpoint");return fallback;
}
async function count(url,span,from,to){
  let n=0,cursor=from;
  while(cursor<=to){const end=cursor+span-1n>to?to:cursor+span-1n;const r=await rpcCall(url,"eth_getLogs",[{address:ADDRESS,fromBlock:hx(cursor),toBlock:hx(end),topics:[TOPIC]}],30000);if(r==null){if(span<=1000n)throw new Error("log range unavailable");span/=2n;continue;}n+=r.length;cursor=end+1n;}return n;
}
async function main(){
  const rows=[];
  for(const chain of CHAINS){process.stderr.write(`Ranking ${chain.name} (endpoint redacted)...\n`);try{const state=await resolveRpc(chain.chainId);const hn=BigInt(await rpcCall(state,"eth_blockNumber",[],10000));const h=await block(state,hn);const from=await atTime(state,hn);const le=await logEndpoint(chain.chainId,from,hn);rows.push({chain,fixedHead:{number:hn.toString(),hash:h.hash,timestamp:BigInt(h.timestamp).toString()},fromBlock:from.toString(),count:await count(le.url,le.span,from,hn),complete:true});}catch(e){rows.push({chain,complete:false,blocker:e.message});}}
  rows.sort((a,b)=>(b.count||-1)-(a.count||-1));
  const out={schemaVersion:1,runId:`synapse-cctp-step8-ranking-${Date.now()}`,generatedAt:new Date().toISOString(),window:{startTimestamp:START_TS.toString(),startIso:"2023-07-01T00:00:00.000Z"},safety:{readOnly:true,endpointMaterialPersisted:false},complete:rows.every(x=>x.complete),ranking:rows};
  fs.writeFileSync(OUT,JSON.stringify(out,null,2)+"\n");console.log(JSON.stringify(out,null,2));
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
