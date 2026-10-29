#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const path = require("path");
const { Interface, getAddress, id, keccak256 } = require("./node_modules/ethers");

const ROOT = path.resolve(__dirname, "..");
const TARGET = path.join(ROOT, "targets", "beefy-contracts-4621d2dd");
const SOURCE = path.join(TARGET, "contracts", "BIFI", "infra", "BeefySwapper.sol");
const ARTIFACT = path.join(TARGET, "artifacts", "contracts", "BIFI", "infra", "BeefySwapper.sol", "BeefySwapper.json");
const SIMPLE_SOURCE = path.join(TARGET, "contracts", "BIFI", "infra", "SimpleSwapper.sol");
const SIMPLE_ARTIFACT = path.join(TARGET, "artifacts", "contracts", "BIFI", "infra", "SimpleSwapper.sol", "SimpleSwapper.json");
const INVENTORY = path.join(ROOT, "rpc_endpoints.txt");
const OUT_DIR = path.join(ROOT, "reports", "raw", "fast", "beefy-swapper-residual-gate");
const CAPTURE = path.join(OUT_DIR, "capture-r2.json");
const CHECKPOINT = path.join(OUT_DIR, "checkpoint-r2.json");
const MANIFEST = path.join(OUT_DIR, "manifest-r2.json");

const CHAIN_ID = 1n;
const COMMIT = "4621d2dd07fad1e63f060451f32af5e1a43c88a9";
const SWAPPER = "0x8d6ce71ab8c98299c1956247ca9aaec080dd2df3";
const DEPLOYMENT_HINT = 19138668n;
const TOKENS = Object.freeze({ YB: "0x01791f726b4103694969820be083196cc7c045ff", WETH: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
  WBTC: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", wantGauge: "0xaa0b1d265f23972eafb7d088e963bd31403a58f5",
  ybWBTC: "0x651d4b8168488fa163d85304662e8278d4c55baa" });
const ZERO = `0x${"0".repeat(40)}`, ZERO32 = `0x${"0".repeat(64)}`;
const IMPLEMENTATION_SLOT = `0x${(BigInt(id("eip1967.proxy.implementation")) - 1n).toString(16).padStart(64, "0")}`;
const BEACON_SLOT = `0x${(BigInt(id("eip1967.proxy.beacon")) - 1n).toString(16).padStart(64, "0")}`;
const ADMIN_SLOT = `0x${(BigInt(id("eip1967.proxy.admin")) - 1n).toString(16).padStart(64, "0")}`;
const TRANSFER_TOPIC = id("Transfer(address,address,uint256)");
const METHODS = new Set(["eth_chainId", "eth_getBlockByNumber", "eth_call", "eth_getCode", "eth_getStorageAt", "eth_getLogs"]);
const LIMITS = Object.freeze({ inventoryBytes: 1048576, candidates: 64, calls: 3000, responseBytes: 4194304,
  totalResponseBytes: 134217728, wallMs: 900000, requestMs: 12000, setChunk: 10000n, transferChunk: 10000n,
  pairs: 512, tokens: 512, transferTokens: 512, checkpointEvery: 20 });

const artifact = JSON.parse(fs.readFileSync(ARTIFACT, "utf8"));
const simpleArtifact = JSON.parse(fs.readFileSync(SIMPLE_ARTIFACT, "utf8"));
const swapperAbi = new Interface(artifact.abi);
const simpleAbi = new Interface(simpleArtifact.abi);
const helperAbi = new Interface([
  "function owner() view returns(address)", "function oracle() view returns(address)", "function slippage() view returns(uint256)",
  "function implementation() view returns(address)", "function decimals() view returns(uint8)", "function symbol() view returns(string)",
  "function balanceOf(address) view returns(uint256)",
  "function swapInfo(address,address) view returns(address router,bytes data,uint256 amountIndex,uint256 minIndex,int8 minAmountSign)",
  "function getAmountOut(address,address,uint256) view returns(uint256)"
]);
const events = new Interface([
  "event SetSwapInfo(address indexed fromToken,address indexed toToken,(address router,bytes data,uint256 amountIndex,uint256 minIndex,int8 minAmountSign) swapInfo)"
]);
const simpleEvents = new Interface(["event SetSwapInfo(address indexed fromToken,address indexed toToken,(address router,bytes data,uint256 amountIndex) swapInfo)"]);
const simpleHelperAbi = new Interface(["function native() view returns(address)","function keeper() view returns(address)","function deployer() view returns(address)",
  "function swapInfo(address,address) view returns(address router,bytes data,uint256 amountIndex)"]);

function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function addr(value) { try { return getAddress(value).toLowerCase(); } catch (_) { return null; } }
function value(row) { return row?.reason === null ? row.value : null; }
function serial(x) { if (typeof x === "bigint") return x.toString(); if (typeof x === "string") return /^0x[0-9a-fA-F]{40}$/u.test(x) ? x.toLowerCase() : x;
  if (Array.isArray(x)) return x.map(serial); if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).filter(([k]) => !/^\d+$/u.test(k)).map(([k,v]) => [k,serial(v)])); return x; }
function rawBytes(hex) { return typeof hex === "string" && /^0x(?:[0-9a-fA-F]{2})*$/u.test(hex) ? Buffer.from(hex.slice(2), "hex") : null; }
function codeSummary(code) { const b = rawBytes(code); return b ? { present: b.length > 0, bytes: b.length,
  keccak256: b.length ? keccak256(code) : null, sha256: b.length ? sha256(b) : null } : null; }
function slotAddress(word) { return /^0x[0-9a-fA-F]{64}$/u.test(word || "") ? addr(`0x${word.slice(-40)}`) : null; }
function pinArg(pin) { return { blockHash: pin.hash, requireCanonical: true }; }
function stripMetadata(code) { const b = rawBytes(code); if (!b || b.length < 2) return null; const n = b.readUInt16BE(b.length - 2), start = b.length - n - 2;
  if (start < 0) return null; const m = b.subarray(start, b.length - 2); if (!m.length || (m[0] & 0xe0) !== 0xa0 || !m.includes(Buffer.from("solc")) ||
    !(m.includes(Buffer.from("ipfs")) || m.includes(Buffer.from("bzzr")))) return null; return b.subarray(0, start); }
function compareRuntime(onchain, local) { const a = rawBytes(onchain), b = rawBytes(local); if (!a || !b) return { exact: null, metadataNormalized: null, conclusion: "UNRESOLVED" };
  const exact = a.equals(b), an = stripMetadata(onchain), bn = stripMetadata(local), normalized = Boolean(an && bn && an.equals(bn));
  return { exact, metadataNormalized: normalized, onchainBytes: a.length, artifactBytes: b.length, onchainKeccak256: keccak256(onchain),
    artifactKeccak256: keccak256(local), conclusion: exact ? "EXACT_RUNTIME_MATCH" : normalized ? "EXECUTABLE_PREFIX_MATCH_METADATA_DIFFERS" : "NO_MATCH" }; }
function routeSummary(decoded) { if (!Array.isArray(decoded) || decoded.length !== 5) return null; const data = decoded[1], b = rawBytes(data);
  return { router: addr(decoded[0]), dataBytes: b?.length ?? null, dataKeccak256: b ? keccak256(data) : null,
    calldataSelector: typeof data === "string" && data.length >= 10 ? data.slice(0,10).toLowerCase() : null,
    amountIndex: String(decoded[2]), minIndex: String(decoded[3]), minAmountSign: String(decoded[4]) }; }
function simpleRouteSummary(decoded) { if (!Array.isArray(decoded) || decoded.length !== 3) return null; const data=decoded[1],b=rawBytes(data);return{router:addr(decoded[0]),
  dataBytes:b?.length??null,dataKeccak256:b?keccak256(data):null,calldataSelector:typeof data==="string"&&data.length>=10?data.slice(0,10).toLowerCase():null,amountIndex:String(decoded[2])}; }

function parseInventory(text) { if (Buffer.byteLength(text) > LIMITS.inventoryBytes) throw Error("inventory cap"); const rows=[], seen=new Set(), lines=text.split(/\r?\n/u);
  for (let i=0;i<lines.length;i++) for (const found of lines[i].matchAll(/https:\/\/[^\s<'"`\])}]+/giu)) { let url; try { url=new URL(found[0].replace(/[>,.;]+$/u,"")); } catch (_) { continue; }
    if (url.protocol!=="https:"||url.username||url.password||url.hash) continue; const headers={}; for(const h of lines[i].matchAll(/\[header:\s*([^=\]\s]+)=([^\]]+)\]/giu)) headers[h[1].trim()]=h[2].trim();
    const key=`${url.href}\0${JSON.stringify(headers)}`; if(seen.has(key))continue; seen.add(key); const context=lines.slice(Math.max(0,i-3),i+4).join(" ");
    rows.push({url,headers,family:url.hostname.toLowerCase(),hint:/(?:ethereum|eth-mainnet|chain(?:id)?[^a-z0-9]{0,8}(?:1|0x1))(?!\d)/iu.test(context)}); }
  return rows.sort((a,b)=>Number(b.hint)-Number(a.hint)).slice(0,LIMITS.candidates); }
function secretCorpus(rows) { const out=new Set(); for(const row of rows) for(const x of [row.url.href,...row.url.pathname.split("/"),...row.url.searchParams.values(),...Object.values(row.headers)])
  if(String(x).length>=16){out.add(String(x));out.add(String(x).toLowerCase());} return [...out]; }
function guard(obj,secrets) { const text=JSON.stringify(obj), low=text.toLowerCase(); if(/(?:https?|wss?):\/\//iu.test(text)||/"(?:endpoint|provider|hostname|domain|headers?)"\s*:/iu.test(text))throw Error("secret shape");
  for(const s of secrets)if(text.includes(s)||low.includes(s.toLowerCase()))throw Error("inventory material"); }

class Budget { constructor(){this.start=Date.now();this.calls=0;this.bytes=0;} use(){if(++this.calls>LIMITS.calls||Date.now()-this.start>LIMITS.wallMs)throw Error("budget");}
  add(n){this.bytes+=n;if(n>LIMITS.responseBytes||this.bytes>LIMITS.totalResponseBytes)throw Error("response budget");}
  summary(){return{calls:this.calls,responseBytes:this.bytes,retries:0,limits:{calls:LIMITS.calls,totalResponseBytes:LIMITS.totalResponseBytes,wallMs:LIMITS.wallMs},withinLimits:true};}}
async function rpc(ep,method,params,budget){if(!METHODS.has(method))throw Error("method");budget.use();const body=Buffer.from(JSON.stringify({jsonrpc:"2.0",id:budget.calls,method,params}));
  return new Promise(resolve=>{let done=false,req;const finish=x=>{if(done)return;done=true;clearTimeout(timer);try{req?.destroy();}catch(_){}resolve(x);};const timer=setTimeout(()=>finish({ok:false,reason:"TIMEOUT"}),LIMITS.requestMs);
    const opts={protocol:"https:",hostname:ep.url.hostname,port:ep.url.port||443,path:`${ep.url.pathname}${ep.url.search}`,method:"POST",agent:false,
      headers:{...ep.headers,"content-type":"application/json",accept:"application/json","accept-encoding":"identity","content-length":body.length}};
    try{req=https.request(opts,res=>{const chunks=[];let size=0;res.on("data",c=>{size+=c.length;if(size>LIMITS.responseBytes)finish({ok:false,reason:"RESPONSE_CAP"});else chunks.push(Buffer.from(c));});
      res.on("end",()=>{if(done)return;try{budget.add(size);}catch(e){return finish({ok:false,reason:e.message});}if(res.statusCode!==200)return finish({ok:false,reason:"HTTP_STATUS"});
        try{const x=JSON.parse(Buffer.concat(chunks).toString("utf8"));if(x.error)return finish({ok:false,reason:"RPC_ERROR"});finish({ok:true,result:x.result});}catch(_){finish({ok:false,reason:"INVALID_JSON"});}});});
      req.on("error",()=>finish({ok:false,reason:"TRANSPORT_ERROR"}));req.end(body);}catch(_){finish({ok:false,reason:"TRANSPORT_ERROR"});}});}
async function call(ep,pin,to,iface,fragment,args,budget){let data;try{data=iface.encodeFunctionData(fragment,args||[]);}catch(_){return{value:null,reason:"ABI_ENCODE_FAILED"};}
  const r=await rpc(ep,"eth_call",[{to,data},pinArg(pin)],budget);if(!r.ok)return{value:null,reason:r.reason};try{const d=iface.decodeFunctionResult(fragment,r.result);return{value:serial(d.length===1?d[0]:[...d]),reason:null};}catch(_){return{value:null,reason:"ABI_DECODE_FAILED"};}}
async function code(ep,address,tag,budget){const r=await rpc(ep,"eth_getCode",[address,tag],budget);return r.ok?{raw:r.result,summary:codeSummary(r.result),reason:null}:{raw:null,summary:null,reason:r.reason};}
async function slot(ep,pin,address,which,budget){const r=await rpc(ep,"eth_getStorageAt",[address,which,pinArg(pin)],budget);return r.ok?{value:slotAddress(r.result),wordZero:r.result===ZERO32,reason:null}:{value:null,wordZero:null,reason:r.reason};}
async function qualify(rows,budget,excludeFamily=null,exactPin=null){const seen=new Set();let tested=0;for(const ep of rows){if(seen.has(ep.family)||ep.family===excludeFamily)continue;seen.add(ep.family);tested++;
    const c=await rpc(ep,"eth_chainId",[],budget);if(!c.ok||BigInt(c.result)!==CHAIN_ID)continue;let pin;
    if(exactPin){const b=await rpc(ep,"eth_getBlockByNumber",[`0x${BigInt(exactPin.number).toString(16)}`,false],budget);if(!b.ok||b.result?.hash?.toLowerCase()!==exactPin.hash)continue;pin=exactPin;}
    else{const b=await rpc(ep,"eth_getBlockByNumber",["finalized",false],budget);if(!b.ok||!b.result?.hash)continue;pin={number:BigInt(b.result.number).toString(),hash:b.result.hash.toLowerCase(),timestamp:BigInt(b.result.timestamp).toString()};}
    const co=await code(ep,SWAPPER,pinArg(pin),budget),ca=await call(ep,pin,TOKENS.WETH,helperAbi,"balanceOf",[SWAPPER],budget);
    const lg=await rpc(ep,"eth_getLogs",[{address:SWAPPER,blockHash:pin.hash,topics:[simpleEvents.getEvent("SetSwapInfo").topicHash]}],budget);
    let archiveCapable=true;const probes=[DEPLOYMENT_HINT,20000000n,23000000n,25000000n,BigInt(pin.number)-10000n];
    for(const start of probes){if(start<0n||start>BigInt(pin.number))continue;const stop=start+9999n>BigInt(pin.number)?BigInt(pin.number):start+9999n;
      const a=await rpc(ep,"eth_getLogs",[{address:SWAPPER,fromBlock:`0x${start.toString(16)}`,toBlock:`0x${stop.toString(16)}`,topics:[simpleEvents.getEvent("SetSwapInfo").topicHash]}],budget);
      const t=await rpc(ep,"eth_getLogs",[{fromBlock:`0x${start.toString(16)}`,toBlock:`0x${stop.toString(16)}`,topics:[TRANSFER_TOPIC,null,`0x${"0".repeat(24)}${SWAPPER.slice(2)}`]}],budget);
      if(!a.ok||!t.ok){archiveCapable=false;break;}}
    if(co.summary?.present&&ca.reason===null&&lg.ok&&archiveCapable)return{ep,pin,tested};}return null;}
async function creationBlock(ep,pin,budget){let lo=0n,hi=BigInt(pin.number);while(lo<hi){const mid=(lo+hi)>>1n,r=await code(ep,SWAPPER,`0x${mid.toString(16)}`,budget);if(r.reason)throw Error("archive code lookup failed");if(r.summary?.present)hi=mid;else lo=mid+1n;}
  const before=lo?await code(ep,SWAPPER,`0x${(lo-1n).toString(16)}`,budget):{summary:{present:false}},at=await code(ep,SWAPPER,`0x${lo.toString(16)}`,budget);
  return{blockNumber:lo.toString(),beforeCodePresent:before.summary?.present===true,atCodePresent:at.summary?.present===true};}
function checkpointBase(pin,creation){return{schema:"beefy-swapper-residual-checkpoint/v1",pin,creationBlock:creation,setNext:creation,transferNext:creation,setEventCount:0,
  setRoutes:{},transferEventCount:0,transferTokens:{},setComplete:false,transferComplete:false,eventVariant:"SimpleSwapper-v1",lastStop:null};}
function writeCheckpoint(cp,secrets){guard(cp,secrets);fs.mkdirSync(OUT_DIR,{recursive:true});fs.writeFileSync(CHECKPOINT,`${JSON.stringify(cp,null,2)}\n`);}
async function scanSetInfo(ep,pin,cp,budget,secrets){const end=BigInt(pin.number),topic=simpleEvents.getEvent("SetSwapInfo").topicHash;let chunks=0;
  for(let start=BigInt(cp.setNext);start<=end;start+=LIMITS.setChunk){const stop=start+LIMITS.setChunk-1n>end?end:start+LIMITS.setChunk-1n;
    const r=await rpc(ep,"eth_getLogs",[{address:SWAPPER,fromBlock:`0x${start.toString(16)}`,toBlock:`0x${stop.toString(16)}`,topics:[topic]}],budget);
    if(!r.ok){cp.lastStop={stage:"SetSwapInfo",reason:r.reason,block:start.toString()};writeCheckpoint(cp,secrets);return;}
    for(const log of r.result||[]){cp.setEventCount++;try{const d=simpleEvents.decodeEventLog("SetSwapInfo",log.data,log.topics),from=addr(d.fromToken),to=addr(d.toToken),summary=simpleRouteSummary(serial([...d.swapInfo]));
      if(from&&to&&summary)cp.setRoutes[`${from}>${to}`]={fromToken:from,toToken:to,...summary,lastSetBlock:BigInt(log.blockNumber).toString(),lastSetTransaction:log.transactionHash.toLowerCase()};}catch(_){} }
    cp.setNext=(stop+1n).toString();if(++chunks%LIMITS.checkpointEvery===0)writeCheckpoint(cp,secrets);
    await new Promise(resolve=>setTimeout(resolve,75));
  }cp.setComplete=true;cp.lastStop=null;writeCheckpoint(cp,secrets);}
async function scanTransfers(ep,pin,cp,budget,secrets){const end=BigInt(pin.number),recipient=`0x${"0".repeat(24)}${SWAPPER.slice(2)}`;let chunks=0;
  for(let start=BigInt(cp.transferNext);start<=end;start+=LIMITS.transferChunk){const stop=start+LIMITS.transferChunk-1n>end?end:start+LIMITS.transferChunk-1n;
    const r=await rpc(ep,"eth_getLogs",[{fromBlock:`0x${start.toString(16)}`,toBlock:`0x${stop.toString(16)}`,topics:[TRANSFER_TOPIC,null,recipient]}],budget);
    if(!r.ok){cp.lastStop={stage:"Transfer",reason:r.reason,block:start.toString()};writeCheckpoint(cp,secrets);return;}
    for(const log of r.result||[]){cp.transferEventCount++;const token=addr(log.address);if(token&&Object.keys(cp.transferTokens).length<LIMITS.transferTokens){const prior=cp.transferTokens[token]||{events:0,firstBlock:BigInt(log.blockNumber).toString()};prior.events++;
      prior.lastBlock=BigInt(log.blockNumber).toString();cp.transferTokens[token]=prior;}}
    cp.transferNext=(stop+1n).toString();if(++chunks%LIMITS.checkpointEvery===0)writeCheckpoint(cp,secrets);
    await new Promise(resolve=>setTimeout(resolve,75));
  }cp.transferComplete=true;cp.lastStop=null;writeCheckpoint(cp,secrets);}
async function routeAt(ep,pin,from,to,budget){const row=await call(ep,pin,SWAPPER,simpleHelperAbi,"swapInfo",[from,to],budget);return{call:row,summary:simpleRouteSummary(value(row))};}
async function tokenAt(ep,pin,token,budget){return{address:token,symbol:await call(ep,pin,token,helperAbi,"symbol",[],budget),decimals:await call(ep,pin,token,helperAbi,"decimals",[],budget),
  balance:await call(ep,pin,token,helperAbi,"balanceOf",[SWAPPER],budget)};}

async function main(){const text=fs.readFileSync(INVENTORY,"utf8"),rows=parseInventory(text),secrets=secretCorpus(rows),budget=new Budget();let resume=null;
  if(fs.existsSync(CHECKPOINT)){try{resume=JSON.parse(fs.readFileSync(CHECKPOINT,"utf8"));}catch(_){resume=null;}}
  const q=await qualify(rows,budget,null,resume?.pin||null);if(!q)throw Error("no qualified Ethereum archive/log family");
  const {ep,pin}=q,created=resume?{blockNumber:resume.creationBlock,beforeCodePresent:false,atCodePresent:true,resumedVerifiedBoundary:true}:await creationBlock(ep,pin,budget);let cp;
  if(fs.existsSync(CHECKPOINT)){try{const old=JSON.parse(fs.readFileSync(CHECKPOINT,"utf8"));cp=old.pin?.hash===pin.hash&&old.creationBlock===created.blockNumber?old:null;}catch(_){cp=null;}}
  if(!cp)cp=checkpointBase(pin,created.blockNumber);if(cp.eventVariant!=="SimpleSwapper-v1"){cp.eventVariant="SimpleSwapper-v1";cp.setNext=created.blockNumber;cp.setEventCount=0;cp.setRoutes={};cp.setComplete=false;}
  await scanSetInfo(ep,pin,cp,budget,secrets);if(cp.setComplete&&!cp.transferComplete)await scanTransfers(ep,pin,cp,budget,secrets);

  const runtime=await code(ep,SWAPPER,pinArg(pin),budget),implementation=await slot(ep,pin,SWAPPER,IMPLEMENTATION_SLOT,budget),beacon=await slot(ep,pin,SWAPPER,BEACON_SLOT,budget),admin=await slot(ep,pin,SWAPPER,ADMIN_SLOT,budget);
  const impl=implementation.value&&implementation.value!==ZERO?implementation.value:null,implRuntime=impl?await code(ep,impl,pinArg(pin),budget):runtime;
  const comparison=compareRuntime(implRuntime.raw,artifact.deployedBytecode),simpleComparison=compareRuntime(implRuntime.raw,simpleArtifact.deployedBytecode),state={
    owner:await call(ep,pin,SWAPPER,helperAbi,"owner",[],budget),oracle:await call(ep,pin,SWAPPER,helperAbi,"oracle",[],budget),slippage:await call(ep,pin,SWAPPER,helperAbi,"slippage",[],budget),
    native:await call(ep,pin,SWAPPER,simpleHelperAbi,"native",[],budget),keeper:await call(ep,pin,SWAPPER,simpleHelperAbi,"keeper",[],budget),deployer:await call(ep,pin,SWAPPER,simpleHelperAbi,"deployer",[],budget)};
  const known=Object.values(TOKENS),pairMap=new Map();for(const from of known)for(const to of known)if(from!==to)pairMap.set(`${from}>${to}`,{fromToken:from,toToken:to,provenance:"known-adjacent"});
  for(const route of Object.values(cp.setRoutes))if(pairMap.size<LIMITS.pairs)pairMap.set(`${route.fromToken}>${route.toToken}`,{fromToken:route.fromToken,toToken:route.toToken,provenance:"SetSwapInfo"});
  const routes={};for(const [key,pair] of pairMap){const live=await routeAt(ep,pin,pair.fromToken,pair.toToken,budget);routes[key]={...pair,...live.summary,reason:live.call.reason};}
  const tokenSet=new Set([...known,...Object.keys(cp.transferTokens)]);for(const r of Object.values(routes)){tokenSet.add(r.fromToken);tokenSet.add(r.toToken);}const tokenRows={};
  for(const token of [...tokenSet].slice(0,LIMITS.tokens))tokenRows[token]=await tokenAt(ep,pin,token,budget);
  const residuals=[];for(const [token,row] of Object.entries(tokenRows)){const bal=value(row.balance);if(bal===null||BigInt(bal)===0n)continue;const incoming=Object.entries(routes).filter(([,r])=>r.toToken===token&&r.router&&r.router!==ZERO);
    const tested=[];for(const [key,r] of incoming.slice(0,8)){const dec=value(tokenRows[r.fromToken]?.decimals);let tiny=1n;if(dec!==null){const d=Number(dec);tiny=10n**BigInt(Math.max(0,Math.min(d,18)-6));}
      tested.push({route:key,tinyInput:tiny.toString(),quote:{value:null,reason:"DEPLOYED_SIMPLE_SWAPPER_HAS_NO_GET_AMOUNT_OUT"}});}
    residuals.push({token,balance:bal,symbol:row.symbol,decimals:row.decimals,incomingConfiguredRoutes:incoming.map(([k])=>k),tinyQuotes:tested,
      economicallyPlausible:incoming.length>0});}
  const plausible=residuals.some(x=>x.economicallyPlausible);let secondFamily=null;
  if(plausible){const q2=await qualify(rows,budget,ep.family,pin);if(q2){const confirmations={};for(const r of residuals.filter(x=>x.economicallyPlausible))confirmations[r.token]=await tokenAt(q2.ep,pin,r.token,budget);
    secondFamily={qualified:true,samePin:true,confirmations};}else secondFamily={qualified:false,samePin:false,confirmations:{}};}
  const selectors=simpleAbi.fragments.filter(x=>x.type==="function"&&x.name==="swap").map(x=>({signature:x.format("sighash"),selector:x.selector,stateMutability:x.stateMutability,
    presentInRuntime:implRuntime.raw?.toLowerCase().includes(x.selector.slice(2).toLowerCase())===true}));
  const history={creation:created,setSwapInfo:{complete:cp.setComplete,nextBlock:cp.setNext,eventCount:cp.setEventCount,configuredPairCount:Object.keys(cp.setRoutes).length},
    transfersToSwapper:{complete:cp.transferComplete,nextBlock:cp.transferNext,eventCount:cp.transferEventCount,uniqueTokenCount:Object.keys(cp.transferTokens).length},lastStop:cp.lastStop};
  const blockers=[];if(!cp.setComplete)blockers.push("SetSwapInfo history incomplete at checkpoint");if(!cp.transferComplete)blockers.push("Transfer-to-swapper history incomplete at checkpoint");
  if(Object.keys(cp.setRoutes).length>LIMITS.pairs)blockers.push("Configured pair cap exceeded");if(tokenSet.size>LIMITS.tokens)blockers.push("Token balance cap exceeded");
  if(!(comparison.exact||comparison.metadataNormalized))blockers.push("Deployed runtime does not match the requested local BeefySwapper artifact");
  if(!(simpleComparison.exact||simpleComparison.metadataNormalized))blockers.push("Deployed runtime has SimpleSwapper ABI/state shape but does not byte-match the commit-local SimpleSwapper artifact");
  blockers.push("Deployed SimpleSwapper surface has no getAmountOut view; tiny-input quote checks are unavailable");
  if(residuals.length&&!plausible)blockers.push("Positive token balances exist, but none is a destination of a currently configured route");
  if(plausible)blockers.push("Positive residual with incoming route is a read-only plausibility signal only; no local reproduction, acquisition/unwind, competition, gas, or conservative net economics");
  const capture={schema:"beefy-swapper-residual-gate/r2",capturedAt:new Date().toISOString(),chainId:"1",pin,
    rpcPolicy:{inventory:"rpc_endpoints.txt",processOnly:true,selectedFamilies:1+(secondFamily?.qualified?1:0),candidateFamiliesTested:q.tested,secondFamilyTriggered:plausible,
      secondIndependentSamePinUsed:secondFamily?.qualified===true,retries:0,permittedMethods:[...METHODS]},source:{repository:"beefyfinance/beefy-contracts",commit:COMMIT,
      source:path.relative(ROOT,SOURCE).replace(/\\/gu,"/"),artifact:path.relative(ROOT,ARTIFACT).replace(/\\/gu,"/"),sourceSha256:sha256(fs.readFileSync(SOURCE)),artifactSha256:sha256(fs.readFileSync(ARTIFACT)),
      deployedAlternativeSource:path.relative(ROOT,SIMPLE_SOURCE).replace(/\\/gu,"/"),deployedAlternativeArtifact:path.relative(ROOT,SIMPLE_ARTIFACT).replace(/\\/gu,"/"),
      deployedAlternativeSourceSha256:sha256(fs.readFileSync(SIMPLE_SOURCE)),deployedAlternativeArtifactSha256:sha256(fs.readFileSync(SIMPLE_ARTIFACT))},
    address:SWAPPER,identity:{runtime:runtime.summary,slots:{implementation,beacon,admin},resolvedImplementation:impl,implementationRuntime:implRuntime.summary,
      requestedBeefySwapperRuntimeComparison:comparison,deployedSimpleSwapperRuntimeComparison:simpleComparison},state,publicSelectors:selectors,
    sourceHypothesis:{requestedBeefySwapperSourceMatch:comparison.exact===true||comparison.metadataNormalized===true,deployedSimpleSwapperSourceMatch:simpleComparison.exact===true||simpleComparison.metadataNormalized===true,
      deploymentApplicabilityEstablished:false,
      pullsCallerInput:true,amountOutUsesFullDestinationBalance:true,transfersFullDestinationBalanceToCaller:true,publicSwap:true,getAmountOutAvailable:false,liveSwapInvoked:false},
    knownTokens:TOKENS,history,configuredRoutes:routes,routeHistoryLatest:cp.setRoutes,tokenBalances:tokenRows,residuals,secondFamily,
    gates:{requestedBeefySwapperSource:false,deployedSimpleSwapperSource:simpleComparison.exact===true||simpleComparison.metadataNormalized===true,
      runtime:runtime.summary?.present===true&&(impl?implRuntime.summary?.present===true:true),publicAccess:selectors.length===1&&selectors[0].presentInRuntime,
      historyComplete:cp.setComplete&&cp.transferComplete,
      residualPresent:residuals.length>0,plausibleResidual:plausible,routePositive:null,executableNow:null},blockers,budget:budget.summary()};
  guard(capture,secrets);fs.mkdirSync(OUT_DIR,{recursive:true});fs.writeFileSync(CAPTURE,`${JSON.stringify(capture,null,2)}\n`);const manifest={schema:"beefy-swapper-residual-gate-manifest/r2",capture:"capture-r2.json",checkpoint:"checkpoint-r2.json",
    bytes:fs.statSync(CAPTURE).size,sha256:sha256(fs.readFileSync(CAPTURE)),pin,gates:capture.gates,secretGuardPassed:true,jsonValidated:true};guard(manifest,secrets);fs.writeFileSync(MANIFEST,`${JSON.stringify(manifest,null,2)}\n`);
  JSON.parse(fs.readFileSync(CAPTURE,"utf8"));JSON.parse(fs.readFileSync(CHECKPOINT,"utf8"));JSON.parse(fs.readFileSync(MANIFEST,"utf8"));
  process.stdout.write(`R2 complete: setHistory=${cp.setComplete} transferHistory=${cp.transferComplete} residuals=${residuals.length} plausible=${plausible} routePositive=unknown\n`);}
main().catch(e=>{process.stderr.write(`swapper gate failed: ${String(e.message||e).replace(/https?:\/\/\S+/giu,"[redacted]")}\n`);process.exitCode=1;});
