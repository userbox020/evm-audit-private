#!/usr/bin/env node
'use strict';
// Defensive observational capture only (--capture); default is an offline rebuild.
// No dotenv, wallet, signing, transaction, fork, source or shared-rpc writes.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm'),assert=require('node:assert/strict');
const {ethers}=require('ethers');
const ROOT=path.resolve(__dirname,'..'),DIR='reports/raw/fast/novelty-rerank-20261017/',SNAP='reports/raw/fast/pendle-l.json';
const OUT=DIR+'A04-cycle9-stage5-economics.json',OBS=DIR+'A04-cycle9-observations.json';
const read=p=>fs.readFileSync(path.join(ROOT,p)),load=p=>JSON.parse(read(p)),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const clean=x=>JSON.parse(JSON.stringify(x,(_,v)=>typeof v==='bigint'?v.toString():v));
const write=(p,x)=>fs.writeFileSync(path.join(ROOT,p),typeof x==='string'?x:JSON.stringify(clean(x),null,2)+'\n');
const prior=load(DIR+'pendle-v7-cycle7-per-market-results.json'),cost=load(DIR+'A04-cycle8-cost-modeling.json');
assert.equal(sha(read(DIR+'pendle-v7-cycle7-per-market-results.json')),'79da9e00d63d0df21e3ddb6d219ef22dbd99c21bad353cbc3a3557ccb842ea77');
const W=10n**18n,Y=31536000n,USD='0x0000000000000000000000000000000000000348',REG='0x47fb2585d2c56fe188d0e6ec628a38b74fceeedf';
const WETH='0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',ETHFEED='0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419';
const abi=new ethers.Interface([
 'function readTokens() view returns(address,address,address)',
 'function readState(address) view returns(int256,int256,int256,address,int256,uint256,uint256,uint256,uint256)',
 'function totalSupply() view returns(uint256)','function balanceOf(address) view returns(uint256)','function decimals() view returns(uint8)',
 'function symbol() view returns(string)','function assetInfo() view returns(uint8,address,uint8)','function exchangeRate() view returns(uint256)',
 'function pyIndexStored() view returns(uint256)','function pyIndexLastUpdatedBlock() view returns(uint128)','function doCacheIndexSameBlock() view returns(bool)',
 'function asset() view returns(address)','function convertToAssets(uint256) view returns(uint256)','function previewRedeem(uint256) view returns(uint256)',
 'function getTokensOut() view returns(address[])','function getTokensIn() view returns(address[])',
 'function hook() view returns(address)','function accountant() view returns(address)','function vault() view returns(address)','function base() view returns(address)',
 'function getRateInQuoteSafe(address) view returns(uint256)','function accountantState() view returns(uint256[])',
 'function getCDOAddress() view returns(address)','function strategy() view returns(address)','function accounting() view returns(address)',
 'function lrtConfig() view returns(address)','function rsETH() view returns(address)','function getContract(bytes32) view returns(address)',
 'function rsETHPrice() view returns(uint256)','function paused() view returns(bool)',
 'function getFeed(address,address) view returns(address)','function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)',
 'function description() view returns(string)']);
const addr=x=>typeof x==='string'&&/^0x[0-9a-f]{40}$/i.test(x)&&x!==ethers.ZeroAddress;
function math(){
 const s=read('tools/sim-pendle-v7-cycle6-stage5.js').toString();
 assert.equal(sha(Buffer.from(s)),'7f8cf3bac3ab267454877bd2fd49d63634dc42c70d3728b6d804b06417bacff8');
 const box={require,__dirname,module:{exports:{}}};
 vm.runInNewContext(s.slice(0,-8)+'\nmodule.exports={model,exp18,tvlEstimate,freshAt};',box);
 return box.module.exports;
}
async function capture(){
 const snap=load(SNAP),started=Date.now();
 assert.equal(sha(read('tools/shared-rpc.js')),'02711a294ac5815f825a2fbc8e882c3b75063c93456c135082230e0094f1ee10');
 assert.equal(sha(read('tools/scan-pendle-l.js')),'5748f898249b726822d1d467de32915002ef382d926df0141eba3ec2c978012b');
 const {resolveRpc,rpcCall}=require('./shared-rpc');let requests=0;
 const o={schema:'A04-cycle9-observations/v1',signal:'DEFENSIVE_OBSERVATIONAL_ONLY',startedAt:new Date(started).toISOString(),snapshotSha256:sha(read(SNAP)),
  snapshotBeforeSha256:prior.afterSha256,scannerStatus:snap.scannedAt!==prior.observedAt?'SEE_REFRESHED_SNAPSHOT_AND_COMMAND_EXIT':'UNKNOWN',
  bounds:{payloadCap:240,wallMs:300000,timeoutMs:8000,retries:0,methods:['eth_call','eth_getBlockByNumber'],qualification:'standing shared-rpc defaults, excluded from payload count',providerStrength:'single-provider'},chains:[],observations:[],assets:[],supplemental:[]};
 async function call(rpc,method,params){assert(++requests<=240,'PAYLOAD_CAP');assert(Date.now()-started<300000,'WALL_CAP');return rpcCall(rpc,method,params,8000);}
 async function get(rpc,pin,to,fn,args=[]){
  const raw=await call(rpc,'eth_call',[{to,data:abi.encodeFunctionData(fn,args)},{blockHash:pin.hash,requireCanonical:true}]);
  let v=null;try{v=clean(abi.decodeFunctionResult(fn,raw));}catch(_){}
  o.observations.push({chainId:1,pinNumber:pin.number,to:to.toLowerCase(),fn,args:clean(args),status:v?'REACHABLE':'UNAVAILABLE_OR_REVERT',values:v});return v;
 }
 const feeds=new Map();
 async function feed(rpc,pin,asset,maxAge=3600){
  const key=asset.toLowerCase();if(feeds.has(key))return feeds.get(key);
  const f={asset:key,feed:null,reachability:'INCOMPLETE',status:'INCOMPLETE_DATA',maxAgeSeconds:maxAge,usdWad:null,reason:'NO_EXACT_REGISTRY_USD_LEAF'};feeds.set(key,f);
  const a=asset===WETH?ETHFEED:(await get(rpc,pin,REG,'getFeed',[asset,USD]))?.[0];
  if(!addr(a))return f;f.feed=a.toLowerCase();f.reachability='PARTIAL';
  const r=await get(rpc,pin,a,'latestRoundData'),d=await get(rpc,pin,a,'decimals'),s=await get(rpc,pin,a,'description');
  Object.assign(f,{round:r,decimals:d?Number(d[0]):null,description:s?.[0]??null});
  const t=BigInt(Date.parse(pin.timestamp)/1000);f.ageSeconds=r?(t-BigInt(r[3])).toString():null;
  if(!r||!d||!s||Number(d[0])>36||BigInt(r[1])<=0n||BigInt(r[3])<=0n||BigInt(r[3])>t||BigInt(r[2])>BigInt(r[3])||BigInt(r[4])<BigInt(r[0])||t-BigInt(r[3])>BigInt(maxAge)){
   f.reason='ROUND_INVALID_STALE_FUTURE_OR_UNBOUND';return f;
  }
  Object.assign(f,{reachability:'FULL',status:'FRESH_AT_PIN',reason:null,usdWad:(BigInt(r[1])*W/10n**BigInt(d[0])).toString()});return f;
 }
 const rpcs=new Map();
 for(const chainId of [1,8453]){
  const rpc=await resolveRpc(chainId);assert(rpc,'RPC_UNAVAILABLE');rpcs.set(chainId,rpc);
  const c=snap.chains.find(x=>x.chainId===chainId);let h=null;
  if(c?.pin?.hash)h=await call(rpc,'eth_getBlockByNumber',['0x'+c.pin.number.toString(16),false]);
  const scannerPinBound=Boolean(h&&h.hash===c.pin.hash&&Date.now()-Date.parse(c.pin.timestamp)<3600000);
  if(!scannerPinBound)h=await call(rpc,'eth_getBlockByNumber',['finalized',false]);assert(h,'FINALIZED_UNAVAILABLE');
  const pin={number:Number(BigInt(h.number)),hash:h.hash,timestamp:new Date(Number(BigInt(h.timestamp))*1000).toISOString(),stateRoot:h.stateRoot,finality:chainId===1?'finalized':'provider-finalized-L2'};
  o.chains.push({chainId,pin,scannerPinBound,markets:[],rebound:false});
 }
 const c=o.chains[0],rpc=rpcs.get(1),pin=c.pin,router=snap.chains.find(x=>x.chainId===1)?.resolution.addresses.router;
 assert(addr(router),'ROUTER_UNAVAILABLE');c.routerContext=router;
 for(const old of prior.stage5){
  const market=old.marketAddress,m={marketAddress:market};c.markets.push(m);
  const tokens=await get(rpc,pin,market,'readTokens'),s=await get(rpc,pin,market,'readState',[router]);
  m.totalSupplyRaw=(await get(rpc,pin,market,'totalSupply'))?.[0]??null;
  m.lpDecimals=Number((await get(rpc,pin,market,'decimals'))?.[0]??-1);
  m.zeroAddressLpBalanceRaw=(await get(rpc,pin,market,'balanceOf',[ethers.ZeroAddress]))?.[0]??null;
  if(!tokens||!s){m.blocker='CORE_VIEWS_UNAVAILABLE';continue;}
  Object.assign(m,{sy:tokens[0].toLowerCase(),pt:tokens[1].toLowerCase(),yt:tokens[2].toLowerCase(),totalPtRaw:s[0],totalSyRaw:s[1],totalLpRaw:s[2],treasury:s[3],scalarRootRaw:s[4],expiry:s[5],lnFeeRateRootRaw:s[6],reserveFeePercentRaw:s[7],lastLnImpliedRateRaw:s[8]});
  const info=await get(rpc,pin,m.sy,'assetInfo');m.syExchangeRateRaw=(await get(rpc,pin,m.sy,'exchangeRate'))?.[0]??null;
  m.syDecimals=(await get(rpc,pin,m.sy,'decimals'))?.[0]??null;m.ptDecimals=(await get(rpc,pin,m.pt,'decimals'))?.[0]??null;
  m.pyIndexStoredRaw=(await get(rpc,pin,m.yt,'pyIndexStored'))?.[0]??null;
  m.pyIndexLastUpdatedBlock=(await get(rpc,pin,m.yt,'pyIndexLastUpdatedBlock'))?.[0]??null;
  m.doCacheIndexSameBlock=(await get(rpc,pin,m.yt,'doCacheIndexSameBlock'))?.[0]??null;
  if(info)Object.assign(m,{assetType:Number(info[0]),asset:info[1].toLowerCase(),assetDecimals:Number(info[2])});
  m.tokensOut=(await get(rpc,pin,m.sy,'getTokensOut'))?.[0]??null;
 }
 for(const asset of [...new Set(c.markets.map(m=>m.asset).filter(Boolean))]){
  const a={asset,symbol:(await get(rpc,pin,asset,'symbol'))?.[0]??null,decimals:(await get(rpc,pin,asset,'decimals'))?.[0]??null,path:[asset],direct:await feed(rpc,pin,asset)};o.assets.push(a);
  if(a.direct.status==='FRESH_AT_PIN')continue;
  const u=(await get(rpc,pin,asset,'asset'))?.[0];
  if(addr(u)&&u.toLowerCase()!==asset){
   a.underlying=u.toLowerCase();a.path.push(a.underlying);
   a.convertToAssets=(await get(rpc,pin,asset,'convertToAssets',[10n**BigInt(a.decimals)]))?.[0]??null;
   a.previewRedeem=(await get(rpc,pin,asset,'previewRedeem',[10n**BigInt(a.decimals)]))?.[0]??null;
   a.underlyingFeed=await feed(rpc,pin,a.underlying);
   a.compositeBlocker='SHARE_IMPLEMENTATION_ACCOUNTING_FRESHNESS_REDEMPTION_AND_UNDERLYING_DECIMALS_UNBOUND';
  }
 }
 o.ethUSD=await feed(rpc,pin,WETH,7200);
 // Explicitly supplementary A05 identities: never substitute these into A04.
 const previous=load(DIR+'cycle8-cost-usd-path-observations.json');
 for(const old of previous.assets){
  const a={symbol:old.symbol,asset:old.asset.toLowerCase(),scope:'A05_SUPPLEMENT_ONLY_NO_A04_IDENTITY_MATCH',path:[old.asset.toLowerCase()],reachability:'INCOMPLETE',usdWad:null};o.supplemental.push(a);
  if(old.symbol==='liquidETH'){
   a.hook=(await get(rpc,pin,a.asset,'hook'))?.[0]??null;
   if(addr(a.hook)){a.accountant=(await get(rpc,pin,a.hook,'accountant'))?.[0]??null;a.hookVault=(await get(rpc,pin,a.hook,'vault'))?.[0]??null;}
   if(addr(a.accountant)){
    a.base=(await get(rpc,pin,a.accountant,'base'))?.[0]??null;a.accountantVault=(await get(rpc,pin,a.accountant,'vault'))?.[0]??null;
    a.rateWeth=(await get(rpc,pin,a.accountant,'getRateInQuoteSafe',[WETH]))?.[0]??null;
    const raw=await call(rpc,'eth_call',[{to:a.accountant,data:abi.encodeFunctionData('accountantState')},{blockHash:pin.hash,requireCanonical:true}]);
    a.stateWords=typeof raw==='string'&&/^0x(?:[0-9a-f]{64})+$/i.test(raw)?raw.slice(2).match(/.{64}/g).map(x=>BigInt('0x'+x).toString()):null;
    a.path.push(a.hook,a.accountant,a.base);a.ethUSD=o.ethUSD;
    a.reachability=a.rateWeth&&a.base?.toLowerCase()===WETH?'PARTIAL':'INCOMPLETE';
    a.blocker='LEGACY_ACCOUNTANT_LAYOUT_RUNTIME_AND_NAV_TIMESTAMP_UNBOUND; getRateSafe pause guard is not a stale guard';
   }
  }else{
   a.underlying=(await get(rpc,pin,a.asset,'asset'))?.[0]?.toLowerCase()??null;
   a.convertToAssets=(await get(rpc,pin,a.asset,'convertToAssets',[W]))?.[0]??null;
   a.previewRedeem=(await get(rpc,pin,a.asset,'previewRedeem',[W]))?.[0]??null;
   if(addr(a.underlying))a.path.push(a.underlying);
   if(old.symbol==='agETH'&&addr(a.underlying)){
    a.config=(await get(rpc,pin,a.underlying,'lrtConfig'))?.[0]??null;
    if(addr(a.config)){a.configToken=(await get(rpc,pin,a.config,'rsETH'))?.[0]??null;a.oracle=(await get(rpc,pin,a.config,'getContract',[ethers.id('LRT_ORACLE')]))?.[0]??null;}
    if(addr(a.oracle)){a.oracleConfig=(await get(rpc,pin,a.oracle,'lrtConfig'))?.[0]??null;a.rsEthPrice=(await get(rpc,pin,a.oracle,'rsETHPrice'))?.[0]??null;a.paused=(await get(rpc,pin,a.oracle,'paused'))?.[0]??null;a.path.push(a.config,a.oracle,WETH);}
    a.ethUSD=o.ethUSD;a.reachability=a.rsEthPrice?'PARTIAL':'INCOMPLETE';a.blocker='SHARE_AND_CACHED_LRT_NAV_UPDATE_AGE_RUNTIME_AND_REALIZABLE_EXIT_UNBOUND';
   }else if(old.symbol==='srUSDe'&&addr(a.underlying)){
    a.leaf=await feed(rpc,pin,a.underlying);a.reachability=a.leaf.feed?'PARTIAL':'INCOMPLETE';
    a.cdo=(await get(rpc,pin,a.asset,'getCDOAddress'))?.[0]??null;
    a.blocker='CDO_STRATEGY_SHARE_FRESHNESS_UNBOUND; 3600s A04 leaf admission unchanged';
   }
  }
 }
 for(const chain of o.chains){const h=await call(rpcs.get(chain.chainId),'eth_getBlockByNumber',['0x'+chain.pin.number.toString(16),false]);assert(h?.hash===chain.pin.hash,'REBOUND_MISMATCH');chain.rebound=true;}
 o.completedAt=new Date().toISOString();o.payloadRequests=requests;o.wallMs=Date.now()-started;
 o.safety={envReads:0,walletKeyReads:0,signedAction:false,broadcast:false,fork:false,targetWrites:0,sharedRpcWrites:0};write(OBS,o);
 console.log(JSON.stringify({capture:OBS,requests,wallMs:o.wallMs,pins:o.chains.map(c=>({chainId:c.chainId,pin:c.pin})),assets:o.assets.map(a=>({asset:a.asset,symbol:a.symbol,underlying:a.underlying,feed:a.direct.status}))}));
}
function decimal(n){n=BigInt(n);return (n<0n?'-':'')+(n<0n?-n:n)/W+'.'+((n<0n?-n:n)%W).toString().padStart(18,'0');}
function build(){
 const o=load(OBS),M=math();assert.equal(o.snapshotSha256,sha(read(SNAP)),'SNAPSHOT_DRIFT');
 for(const m of prior.sourceManifest)assert.equal(sha(read(m.file)),m.sha256);
 const c=o.chains.find(c=>c.chainId===1);assert(o.chains.every(c=>c.rebound));
 const gasWei=250000n*30000000000n,gasUSD=o.ethUSD.usdWad?gasWei*BigInt(o.ethUSD.usdWad)/W:null;
 const markets=prior.stage5.map(old=>{
  const s=c.markets.find(m=>m.marketAddress===old.marketAddress),a=o.assets.find(a=>a.asset===s.asset);
  assert(s.asset===old.asset,'ASSET_IDENTITY_DRIFT');assert.equal(s.totalSupplyRaw,s.totalLpRaw);assert.equal(s.lpDecimals,18);
  const d=M.model(c,s),t=BigInt(s.expiry)-BigInt(Date.parse(c.pin.timestamp)/1000),F=M.exp18(BigInt(s.lnFeeRateRootRaw)*(t>0n?t:0n)/Y),buy=F-W,sell=W-W*W/F;
  const maxDiff=[d.storedOracle.absDiff,...d.rows.filter(x=>x.kind==='SAVED_RESERVES'&&x.status==='MEASURED').map(x=>x.absDiff)].reduce((a,b)=>a>b?a:b);
  const numerator=maxDiff*BigInt(s.totalPtRaw)*W,denominator=BigInt(s.totalLpRaw)*10n**BigInt(s.assetDecimals),C=d.lpAdjustedWeiResidual;
  assert(C*denominator>=numerator&&(C===0n?numerator===0n:(C-1n)*denominator<numerator),'RESIDUAL_CEILING_INTERVAL');
  const price=a.direct.status==='FRESH_AT_PIN'?a.direct.usdWad:null;
  const reachability=price?'FULL':a.direct.feed||a.underlyingFeed?.feed?'PARTIAL':'INCOMPLETE';
  let tvl=null;if(price)tvl=M.tvlEstimate(BigInt(s.totalSyRaw),BigInt(s.totalPtRaw),BigInt(s.syExchangeRateRaw),d.storedOracle.sourceRate,BigInt(s.assetDecimals),BigInt(price));
  const reasons=['NO_COMPLETE_PUBLIC_CONSUMER_TO_EXTRACTION_PATH','NO_ACTUAL_FULL_ROUNDTRIP_QUOTE_FUNDING_SLIPPAGE_OR_PATH_GAS','RESIDUAL_IS_ABSOLUTE_PER_LP_CEILING_NOT_REALIZED_PROCEEDS','CALLER_SPECIFIC_FEE_OVERRIDE_AND_DEPLOYED_RUNTIME_UNBOUND'];
  if(!price)reasons.push(a.compositeBlocker??a.direct.reason);
  return {chainId:1,marketAddress:s.marketAddress,pin:c.pin,asset:s.asset,symbol:a.symbol,assetDecimals:s.assetDecimals,observedState:s,
   usdPath:{addresses:[s.marketAddress,s.pt,s.yt,s.sy,...a.path],reachability,status:price?'FRESH_USD_LEAF_ONLY':'INCOMPLETE_DATA',underlyerPriceUSD:price?decimal(price):null,priceUSDWad:price,pathObservation:a,
    sequenceMeaning:'Pinned identity graph traversal via market.readTokens and SY.assetInfo; NOT a PT→YT→SY economic redemption route.',
    protocol:'Exact-asset Chainlink registry mapping, latestRoundData, decimals, description; positive/nonfuture/answeredInRound guards; inherited 3600s A04 age bound. No peg or unrelated A05 substitution.'},
   tvlEstimateUSD:tvl?decimal(tvl.tvlUSD):null,tvlStatus:tvl?'DIAGNOSTIC_ONLY':'INCOMPLETE_DATA',valuationCaveat:'SY index + spot PT reciprocal mark, not solvency/redemption or exit value. PARTIAL paths with no admitted composite deliberately retain null TVL.',
   lpAdjustedResidualNormalizedWei:d.lpAdjustedWeiResidual,aboveThreshold:d.aboveThreshold,lockedOnly:d.lockedOnly,diagnostic:d,
   fees:{routerContext:c.routerContext,lnFeeRateRootRaw:s.lnFeeRateRootRaw,timeToExpirySeconds:t,feeMultiplierWad:F,buyPtSurchargeWad:buy,sellPtHaircutWad:sell,reserveFeePercent:s.reserveFeePercentRaw,fundingFlashPremiumUSD:null},
   sizes:[1000n,10000n,50000n].map(N=>({inputUSD:N.toString(),quoteOutUSD:null,feeTotalUSD:null,fundingPremiumUSD:null,actualGasUnits:null,actualGasUSD:null,
    conditionalOneLegFeeProxyUSD:decimal(N*buy),conditionalTwoEqualNotionalLegFeeProxyUSD:decimal(N*(buy+sell)),assumedGasUnits:250000,assumedGasPriceGwei:30,assumedGasUSD:gasUSD===null?null:decimal(gasUSD),
    netUSD:null,status:'INCOMPLETE_DATA',routePositive:'unknown',routeDisposition:'UNKNOWN',executableNow:'pending-owner-batch-envelope',signedActionJustified:false,reasons})),
   usdEconomics:'INCOMPLETE_DATA',reasons,routePositive:'unknown',routeDisposition:'UNKNOWN',executableNow:'pending-owner-batch-envelope',signedActionJustified:false};
 });
 assert.equal(markets.length,10);assert.equal(markets.flatMap(m=>m.sizes).length,30);assert(markets.every(m=>m.sizes.every(s=>s.netUSD===null&&s.routePositive==='unknown')));
 assert.equal(M.exp18(0n),W);assert.equal(M.exp18(W),2718281828459045235n);assert.equal(gasWei,7500000000000000n);
 assert(!M.freshAt('invalid',Date.now(),1));assert(!M.freshAt(new Date(Date.now()+10000).toISOString(),Date.now(),1000));
 assert.equal(M.tvlEstimate(2n*W,3n*10n**6n,10n**6n,W,6n,2n*W).tvlUSD,10n*W);
 const result={schema:'A04-cycle9-stage5-economics/v1',signal:'DEFENSIVE_DEPTH_TIGHTEN_INCOMPLETE_DATA_NO_PROMOTION',assessor:'a04-cycle9-20261017',generatedAt:new Date().toISOString(),observedAt:o.completedAt,
  framing:'This work continues the cycle-7 cycle-8 chainstate-and-economics evidence layer. This work does NOT establish profitability on any market; the cost architecture is recorded for defensive characterization only.',
  freshnessExpiresAt:new Date(Math.min(Date.parse(o.completedAt)+1800000,...o.chains.map(c=>Date.parse(c.pin.timestamp)+3600000))).toISOString(),
  scanner:{beforeSha256:o.snapshotBeforeSha256,afterSha256:o.snapshotSha256,changed:o.snapshotBeforeSha256!==o.snapshotSha256,requests:load(SNAP).totals.requests,apiRequests:load(SNAP).totals.apiRequests,scannedAt:load(SNAP).scannedAt,commandExitEvidence:'Attended scanner invocation exited 0; recorded in handoff, not re-executed by this offline build.'},
  chains:o.chains.map(({chainId,pin,rebound,scannerPinBound})=>({chainId,pin,rebound,scannerPinBound})),capture:{file:OBS,sha256:sha(read(OBS)),payloadRequests:o.payloadRequests,wallMs:o.wallMs,bounds:o.bounds,
   attendedCaptureHarnessSha256:'591cdc56da35fa72406ae2b99d7e004d2bcf02527b3b258ef2c38031b8e759f1',provenance:'Capture runner hash recorded independently after launch; subsequent edits add offline assertions/report clarity only. No capture logic change or second capture.'},
  scopeCorrection:'The requested srUSDe/liquidETH/agETH identities are A05 EulerSwap assets, not any exact A04 watch-list SY.assetInfo asset. Supplemental paths refreshed separately; no price identity substitution. srUSDe→USDe observed, not asserted stUSDe→Falcon USD.',
  ethUSD:o.ethUSD,assumedGasUSD:gasUSD===null?null:decimal(gasUSD),markets,supplemental:o.supplemental,
  counts:{markets:10,positive:0,negative:0,unknown:10,sizeRows:30,incompleteEconomicsRows:30,fullPaths:markets.filter(m=>m.usdPath.reachability==='FULL').length,partialPaths:markets.filter(m=>m.usdPath.reachability==='PARTIAL').length,incompletePaths:markets.filter(m=>m.usdPath.reachability==='INCOMPLETE').length,aboveThreshold:markets.filter(m=>m.aboveThreshold===true).length},
  evidence:{localSemantic:{status:'PASS',result:'supports',scope:'hash-bound source-math diagnostic and fee sensitivity only'},reachability:{status:'UNKNOWN',result:'inconclusive',scope:'full actor-to-extraction path'},economics:{status:'BLOCKED',result:'inconclusive'},reproducibility:{status:'PASS',scope:'offline arithmetic replay, not route validation'},providerStrength:'single-provider',deploymentDisposition:'UNBOUND'},
  invariants:[{scope:'Ten pinned A04 markets; original saved reserves only, synthetic downscales segregated',actors:'public actor unbound; observational calls only',prerequisites:'source hashes, exact asset binding, readState/supply equality, positive reserves and 18-decimal LP',equation:'C=ceil(maxAbsDiff*rawPT*1e18/(rawLP*10^assetDecimals)); (C-1)*denominator < numerator <= C*denominator, with C=0 iff numerator=0',adversarialControls:'none synthesized into captured state',observationPoints:'EIP-1898 views and hash-rebound headers',rollback:'no chain state change; pure offline arithmetic',tests:'ten exact ceiling intervals; source exp known answers; six-decimal TVL known answer; stale/future metadata rejection; thirty null-net no-promotion checks',assumptions:'source math is not a deployed-runtime or realizable profit binding'}],
  safety:o.safety,routePositive:'unknown',routeDisposition:'UNKNOWN',executableNow:'pending-owner-batch-envelope',signedActionJustified:false,
  verdict:'WATCH_LIST_PERSISTS_NO_ECONOMIC_VERDICT',cycle10:'Bind actual A04 receipt underlyer feed identities/age policy and implementation freshness first; then concrete consumer, caller, accessible LP inventory, exact runtime, funding and both finite swap legs. No further blind scanner refresh or A05 price substitution.',
  manifest:[SNAP,OBS,DIR+'pendle-v7-cycle7-per-market-results.json',DIR+'A04-cycle8-cost-modeling.json',DIR+'A05-cycle8-usd-path-resolution.md',DIR+'cycle8-cost-usd-path-probe.js','tools/sim-pendle-v7-cycle7-stage5.js','tools/sim-pendle-v7-cycle6-stage5.js','tools/sim-pendle-v7-cycle9-stage5.js','tools/shared-rpc.js','tools/scan-pendle-l.js',...prior.sourceManifest.map(x=>x.file)].map(file=>({file,sha256:sha(read(file))}))};
 write(OUT,result);write(DIR+'A04-cycle9-stage5-economics-summary.md',summary(result));write(DIR+'A04-cycle9-usd-path-resolution.md',paths(result));
 console.log(JSON.stringify(clean({verdict:result.verdict,counts:result.counts,gasUSD:result.assumedGasUSD,markets:markets.map(m=>({market:m.marketAddress,symbol:m.symbol,path:m.usdPath.reachability,tvl:m.tvlEstimateUSD,C:m.lpAdjustedResidualNormalizedWei,fees:m.sizes.map(s=>s.conditionalTwoEqualNotionalLegFeeProxyUSD)}))})));
}
function summary(r){return ['# A04 cycle-9 — depth-tighten at refreshed finalized pins','','Signal: **'+r.signal+'**','',r.framing,'',
 `Observed ${r.observedAt}; expiry ${r.freshnessExpiresAt}. Single-provider, not state-root proof.`,
 `Scanner SHA-256 before \`${r.scanner.beforeSha256}\`; after \`${r.scanner.afterSha256}\`; changed ${r.scanner.changed}. Counted scanner payloads ${r.scanner.requests}, API ${r.scanner.apiRequests}.`,
 ...r.chains.map(c=>`- Chain ${c.chainId}: **${c.pin.number}** / \`${c.pin.hash}\`, ${c.pin.timestamp}; header rebound ${c.rebound}.`),'',
 '**'+r.verdict+'**. '+JSON.stringify(r.counts)+'. No all-market falsification: only the ten original watch-list markets are remodeled here.','',
 '## Per-market economics','',
 'All $1k/$10k/$50k rows: quoteOut, actual fees/gas, funding premium and net remain null; routePositive=unknown. Fee columns are two-equal-pre-fee-notional Pendle fee sensitivities, NOT a completed round trip or flash premium. Gas assumption 250k × 30 gwei = 0.0075 ETH; same-pin ETH/USD mark '+(r.assumedGasUSD??'unknown')+' USD, NOT actual path gas.','',
 '| Market | Exact asset symbol | USD path | TVL USD | Conditional two-leg fees $1k / $10k / $50k | Net / route |','|---|---|---|---:|---|---|',
 ...r.markets.map(m=>`| ${m.marketAddress} | ${m.symbol??'unknown'} | ${m.usdPath.reachability} | ${m.tvlEstimateUSD??'unknown'} | ${m.sizes.map(s=>Number(s.conditionalTwoEqualNotionalLegFeeProxyUSD).toFixed(6)).join(' / ')} | unknown / unknown |`),'',
 'PARTIAL means components reachable, NOT an admitted fresh composite. Null TVL is required when absolute price is unproven. No USDC $1 peg or relaxed age rule. Residual is an absolute normalized per-whole-LP PT-only ceiling, not payout; locked-only markets remain segregated. Captured router fees are not proven actor-specific fees.','',
 '## Scope correction','',r.scopeCorrection,'See A04-cycle9-usd-path-resolution.md and decoded pinned observations. The suggested Falcon backing inference is not established and must not be inherited from A08 merely by symbol association.','',
 '## Evidence / tests / limitations','',
 `Capture: ${r.capture.payloadRequests} payload requests / ${r.capture.wallMs}ms; max 240 / 300s, zero direct retries; standing resolver qualification additional and excluded. Scanner uses its own inherited bounded retries and method envelope.`,
 'Offline hash/source guards, exp(0)/exp(1), supply/readState equality, 18-decimal LP, ten residual ceiling intervals, stale/future metadata rejection, 6-decimal TVL known answer and 30 null-net/no-promotion checks PASS. Invariant/actors/prerequisites/observation/rollback assumptions are recorded in JSON. No Forge, swap execution, fork, source/runtime equivalence or consumer binding claimed.',
 'Source: PendleMarketV7.sol:142-158 (burn), :172-245 (swap/callback), :300-315 (caller-dependent state); MarketMathCore.sol:205-252,314-353 (fee/rate); PendlePYOracleLib.sol:65-75 (PT reciprocal). No arithmetic remediation follows solely from an absolute residual.','',
 '## Cycle-10','',r.cycle10,'Fresh positive economics, if ever supported, still cannot clear pending-owner-batch-envelope. No .env/key reads, signing, broadcast, live fork, target/shared-rpc edits, automation or aggregate gate change.',''].join('\n');}
function paths(r){return ['# A04 cycle-9 — identity-bound USD paths','','Signal: **DEFENSIVE_USD_PATH_IDENTITY_CORRECTION_NO_PROMOTION**','',r.framing,'',
 '## Authority and separation','',r.scopeCorrection,'The A05 file is a cross-protocol pointer reference, not proof that its assets are Pendle underlyers. All sequences are bound to the Ethereum block number/hash in the economics JSON. Market→PT/YT/SY is an identity graph traversal (readTokens, assetInfo), not a claimed economic PT→YT→SY redemption route.','',
 '| A04 market | Asset | Symbol | Address path after market → PT → YT → SY | Reachability | Fresh price | Blocker |','|---|---|---|---|---|---|---|',
 ...r.markets.map(m=>`| ${m.marketAddress} | ${m.asset} | ${m.symbol??'?'} | ${m.usdPath.pathObservation.path.join(' → ')} | ${m.usdPath.reachability} | ${m.usdPath.underlyerPriceUSD??'not admitted'} | ${m.usdPath.pathObservation.compositeBlocker??m.usdPath.pathObservation.direct.reason??'full leaf only; exits unbound'} |`),'',
 'Protocol: exact SY.assetInfo binding → Chainlink Feed Registry exact-asset USD mapping. Each candidate records latestRoundData/decimals/description at the finalized hash with canonicality required. A04 retains 3600s age admission; ETH gas anchor uses inherited 7200s. Positive answer, nonfuture update, answeredInRound and decimals are checked. Redstone/PendlePearl identities were not discovered or invented; absence from this bounded path walk is not proof of absence.','',
 '### Recorded leaves at Ethereum '+r.chains.find(c=>c.chainId===1).pin.number,'',
 '| Leaf | USD answer / whole asset | UpdatedAt | Age at pin | Admission |','|---|---:|---:|---:|---|',
 ...[r.ethUSD,r.markets.find(m=>m.symbol==='USDC')?.usdPath.pathObservation.direct,r.supplemental.find(a=>a.symbol==='srUSDe')?.leaf].filter(Boolean).map(f=>`| ${f.description??f.asset} / ${f.feed} | ${f.round?Number(f.round[1])/10**f.decimals:'unknown'} | ${f.round?.[3]??'unknown'} | ${f.ageSeconds??'unknown'}s | ${f.status} (bound ${f.maxAgeSeconds}s) |`),'',
 'A05 cycle-7 used a separate 93600s discovered-feed bound: the USDe leaf age is within that diagnostic bound, but this neither changes the inherited A04 3600s rule nor repairs missing share/CDO freshness. No issuer heartbeat was independently verified. Raw stale answers are recorded observations, not admitted current prices.','',
 '## Supplementary cycle-8 A05 path refresh (not A04 pricing)','',
 ...r.supplemental.flatMap(a=>['### '+a.symbol,'',`Path: ${a.path.join(' → ')}. Reachability **${a.reachability}**, fresh composite USD **not admitted**.`,
  `Recorded views: ${JSON.stringify(a)}`,'']),
 'srUSDe is observed as an ERC4626 USDe asset; the supplied cycle-8 evidence does not support an srUSDe→stUSDe edge or USDe→Falcon USD backing assertion. stUSDe (if intended) is a distinct identity and needs its own binding. A08 authority cannot manufacture that edge. liquidETH reaches WETH-accountant NAV and the Chainlink ETH/USD pair above, not a proven Redstone or PendlePearl pair. agETH reaches config-bound LRTOracle.rsETHPrice then ETH/USD, but cached NAV age remains unknown.','',
 'Defensive regression requirements: reject mismatched asset identities, stale/missing timestamps, ABI 10-vs-12-word drift, convertToAssets/previewRedeem differences, absent NAV update age, six-vs-18-decimal unit errors and endogenous pool-mid self-valuation. Never label PARTIAL as fresh executable pricing.',''].join('\n');}
(async()=>{if(process.argv.includes('--capture'))await capture();else build();})().catch(e=>{console.error('cycle9 failed (sanitized)'+(e?.code==='ERR_ASSERTION'?': '+e.message:''));process.exitCode=1;});
