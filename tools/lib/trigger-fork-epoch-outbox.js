"use strict";
// Pure SYNTHETIC fixture contracts. Never chain/economics/delivery authority.
const {createHash}=require("node:crypto");
const {parseStrictJson,canonicalize}=require("./evm-call-inventory-v2/canonical.js");
const core=require("./trigger-fork-epoch.js"),context=require("./trigger-fork-epoch-context.js"),execution=require("./trigger-fork-epoch-execution.js");
const LABEL="SYNTHETIC_INERT_FIXTURE/MODEL_ONLY",SCHEMA="trigger-fork-model-promotion/v1",BUNDLE="trigger-fork-model-completion/v1";
const COSTS=Object.freeze(["obligations","acquisition","unwind","fees","slippage","gas","financing","latencyCompetition","uncertaintyHaircut"]);
const CRITERIA=Object.freeze(["sourceQualified","runtimeQualified","reachable","funded","exit","exactPins"]);
const BACKOFF_MS=30000,DELIVERY_BUDGET_MS=10000;
function fail(){throw new Error("MODEL_PROMOTION_INVALID");}
function exact(o,keys){if(!o||![Object.prototype,null].includes(Object.getPrototypeOf(o))||Reflect.ownKeys(o).length!==keys.length)fail();for(const k of Reflect.ownKeys(o)){const d=Object.getOwnPropertyDescriptor(o,k);if(!keys.includes(k)||!d.enumerable||!("value"in d))fail();}}
function freeze(o){if(o&&typeof o==="object"){Object.values(o).forEach(freeze);Object.freeze(o);}return o;}
function dataOnly(v,depth=0){
  if(depth>10)fail();if(v===null||typeof v==="boolean")return;
  if(typeof v==="string"){if(v.length>16384)fail();return;}
  if(typeof v==="number"){if(!Number.isSafeInteger(v))fail();return;}
  if(!v||typeof v!=="object"||(!Array.isArray(v)&&![Object.prototype,null].includes(Object.getPrototypeOf(v))))fail();
  const keys=Reflect.ownKeys(v).filter(k=>!(Array.isArray(v)&&k==="length"));if(keys.length>128)fail();
  for(const k of keys){const d=Object.getOwnPropertyDescriptor(v,k);if(typeof k!=="string"||!d.enumerable||!("value"in d))fail();dataOnly(d.value,depth+1);}
}
function parse(text,max=65536){if(typeof text!=="string"||Buffer.byteLength(text)>max)fail();let d=0,q=false,e=false;for(const c of text){if(q){if(e)e=false;else if(c==="\\")e=true;else if(c==='"')q=false;}else if(c==='"')q=true;else if(c==="{"||c==="["){if(++d>10)fail();}else if(c==="}"||c==="]")--d;}return parseStrictJson(text);}
function hash(domain,o){return "0x"+createHash("sha256").update(domain+"\n"+canonicalize(o)).digest("hex");}
function decimal(v){if(typeof v!=="string"||! /^(0|[1-9][0-9]{0,11})\.[0-9]{6}$/.test(v))fail();return BigInt(v.replace(".",""));}
function amount(n){return (n/1000000n).toString()+"."+(n%1000000n).toString().padStart(6,"0");}
function pair(p){exact(p,["usd","native"]);return {usd:decimal(p.usd),native:decimal(p.native)};}
function fresh(t,now,limit=120000){if(!Number.isSafeInteger(t)||t>now||now-t>limit)fail();}
function economics(e,c,now,limit=120000){
  exact(e,["schema","evidenceClass","candidateId","chainId","nativeAsset","observedAtUtcMs","revenue","capital","costs","capacityUsd","capacityNative","exitCapacityUsd","exitCapacityNative","fundingAvailableUsd","fundingAvailableNative","capitalZeroRationale"]);
  if(e.schema!=="trigger-fork-model-economics/v1"||e.evidenceClass!==LABEL||e.candidateId!==c.semanticEventId||e.chainId!==c.primaryPin.chainId||e.nativeAsset!=="ETH"||![1,10,8453,42161].includes(e.chainId))fail();fresh(e.observedAtUtcMs,now,limit);
  exact(e.costs,COSTS);const net=pair(e.revenue),capital=pair(e.capital),need={usd:0n,native:0n};
  for(const k of COSTS){const cost=pair(e.costs[k]);net.usd-=cost.usd;net.native-=cost.native;if(k==="acquisition"||k==="obligations"){need.usd+=cost.usd;need.native+=cost.native;}}
  if(net.usd<=0n||net.native<=0n)fail();
  for(const [unit,suffix]of [["usd","Usd"],["native","Native"]]){
    const capacity=decimal(e["capacity"+suffix]),exit=decimal(e["exitCapacity"+suffix]),funding=decimal(e["fundingAvailable"+suffix]);
    if(capacity<=0n||exit<=0n||funding<=0n||capacity<need[unit]||exit<need[unit]||funding<need[unit]||funding<capital[unit])fail();
  }
  const zero=capital.usd===0n&&capital.native===0n;
  if(zero?e.capitalZeroRationale!=="NO_CAPITAL_REQUIRED":capital.usd<=0n||capital.native<=0n||e.capitalZeroRationale!==null)fail();
  return {usd:amount(net.usd),native:amount(net.native),usdBps:zero?null:(net.usd*10000n/capital.usd).toString(),nativeBps:zero?null:(net.native*10000n/capital.native).toString(),capitalZeroRationale:e.capitalZeroRationale};
}
function qualify(q,c,now,limit){exact(q,["schema","evidenceClass","candidateId","chainId","nativeAsset","observedAtUtcMs",...CRITERIA]);if(q.schema!=="trigger-fork-model-qualification/v1"||q.evidenceClass!==LABEL||q.candidateId!==c.semanticEventId||q.chainId!==c.primaryPin.chainId||q.nativeAsset!=="ETH")fail();fresh(q.observedAtUtcMs,now,limit);for(const k of CRITERIA)if(q[k]!==true)fail();}
function policyHandle(p){
  exact(p,["manifest","manifestDigest"]);
  const h=core.parseEpochManifest(JSON.stringify(p.manifest));
  if(!h.manifest||h.digest!==p.manifestDigest||canonicalize(h.manifest)!==canonicalize(p.manifest))fail();
  return h;
}
function summary(v){return {callerClass:v.callerClass,status:v.status,blocker:v.blocker,teardownVerified:v.teardownVerified,modelEvidence:v.modelEvidence};}
function checkEnvelope(v,env){if(!execution.validResult(v,env)||v.status!=="MODEL_PASS"||!v.teardownVerified)fail();}
function identities(record){const resultDigest=hash("trigger-fork-model-result/v1",record);const promotionId=hash("trigger-fork-promotion-id/v1",{schema:"trigger-fork-promotion-id/v1",epochId:record.context.epochId,semanticEventId:record.context.semanticEventId,resultDigest});return {resultDigest,promotionId};}
function validateRecord(r,now,history){
  dataOnly(r);
  exact(r,["schema","evidenceClass","eventText","context","deadlines","envelopes","qualification","economics","completedAtUtcMs","derivedNet","policy"]);
  const h=policyHandle(r.policy),limit=Math.min(120000,h.manifest.bounds.promotionMaxAgeMs);
  if(r.schema!==SCHEMA||r.evidenceClass!==LABEL)fail();fresh(r.completedAtUtcMs,now,limit);
  const env=execution.envelope({contextText:JSON.stringify(r.context),deadlinesText:JSON.stringify(r.deadlines)});if(!env.ok||env.callerClass!=="EPOCH_OWNER")fail();
  const c=r.context,rebuilt=context.buildEventContext({callerClass:"EPOCH_OWNER",eventText:r.eventText,reservationSeq:c.reservationSeq,passId:c.passId,ownerInstanceId:c.ownerInstanceId,epochId:c.epochId});
  if(rebuilt.status!=="VALID"||canonicalize(rebuilt.context)!==canonicalize(c))fail();
  const e=core.parseSourceEvent(r.eventText);if(!e.event)fail();
  dataOnly(history);exact(history,["inheritedRecords","priorConsumed"]);if(!Array.isArray(history.inheritedRecords)||!Array.isArray(history.priorConsumed))fail();
  if(core.admitEvent({manifest:h,event:r.eventText,consumed:JSON.stringify(history.priorConsumed),inherited:JSON.stringify(history.inheritedRecords),expectedSourceDigest:c.sourceDigest,nowMs:now}).status!=="OFFLINE_VALID")fail();
  exact(r.envelopes,["bridge","child","status"]);
  for(const v of Object.values(r.envelopes)){exact(v,["callerClass","status","blocker","teardownVerified","modelEvidence"]);checkEnvelope({schema:execution.RESULT_SCHEMA,...v,eventContext:c,deadlines:r.deadlines},env);}
  qualify(r.qualification,c,now,limit);const net=economics(r.economics,c,now,limit);if(canonicalize(net)!==canonicalize(r.derivedNet))fail();
  if(now>=r.deadlines.workUtcMs)fail();
  // Bound the complete persisted wrapper, including escaping, before append.
  if(Buffer.byteLength(JSON.stringify({modelCompletion:{record:r,...identities(r)},contextText:JSON.stringify(c)}))>14000)fail();
  return freeze({record:r,...identities(r)});
}
function validateBundle(text,reservation,now){try{
  const b=parse(text);exact(b,["schema","evidenceClass","eventText","reservationContext","reservationDeadlines","bridge","child","status","qualification","economics","completedAtUtcMs"]);
  if(b.schema!==BUNDLE||b.evidenceClass!==LABEL||b.eventText!==reservation.eventText||canonicalize(b.reservationContext)!==canonicalize(reservation.context)||canonicalize(b.reservationDeadlines)!==canonicalize(reservation.deadlines))fail();
  const env=execution.envelope({contextText:JSON.stringify(reservation.context),deadlinesText:JSON.stringify(reservation.deadlines)});
  for(const k of ["bridge","child","status"])checkEnvelope(b[k],env);
  // Policy is supplied by the private reservation/owner, never bundle JSON.
  const r={schema:SCHEMA,evidenceClass:LABEL,eventText:b.eventText,context:b.reservationContext,deadlines:b.reservationDeadlines,envelopes:{bridge:summary(b.bridge),child:summary(b.child),status:summary(b.status)},qualification:b.qualification,economics:b.economics,completedAtUtcMs:b.completedAtUtcMs,derivedNet:economics(b.economics,b.reservationContext,now),policy:reservation.policy};
  return {ok:true,completion:validateRecord(r,now,reservation.validationHistory)};
}catch{return {ok:false,code:"MODEL_PROMOTION_INVALID"};}}
function recheckCompletion(c,now,history){try{exact(c,["record","resultDigest","promotionId"]);const v=validateRecord(c.record,now,history);if(v.resultDigest!==c.resultDigest||v.promotionId!==c.promotionId)fail();return {ok:true,completion:v};}catch{return {ok:false,code:"MODEL_PROMOTION_INVALID"};}}
function lifecycleFits(eventText,c,d,policy){
  try{dataOnly(policy);policyHandle(policy);
    // <=10KiB includes shared policy plus duplicate RESULT context escaping;
    // 4KiB reserved for all bounded envelope/criterion/cost/net/ID fields.
    return Buffer.byteLength(JSON.stringify({eventText,context:c,deadlines:d,policy,contextText:JSON.stringify(c)}))<=10000;
  }catch{return false;}
}
// Called by the strict journal reader after chain/lifecycle validation. This
// DATA preview is never import authority, including a persisted model ACK.
function forensicCandidates(records){return freeze(records.filter(r=>r.kind==="PROMOTION_QUEUED").map(q=>{
  const result=records.find(r=>r.kind==="RESULT"&&r.payload.reservationSeq===q.payload.reservationSeq),attempts=records.filter(r=>r.kind==="DELIVERY_ATTEMPT"&&r.payload.promotionId===q.payload.promotionId),acked=records.some(r=>r.kind==="DELIVERY_ACK"&&r.payload.promotionId===q.payload.promotionId);
  return {promotionId:q.payload.promotionId,resultDigest:q.payload.resultDigest,reservationSeq:q.payload.reservationSeq,epochId:q.epochId,ownerInstanceId:q.ownerInstanceId,evidenceClass:LABEL,completion:result.payload.modelCompletion,deliveryState:acked?"MODEL_ACKED":"MODEL_UNACKNOWLEDGED",attemptCount:attempts.length,provenance:{source:"FORENSIC_MODEL_JOURNAL",queuedRecordDigest:q.digest,resultRecordDigest:result.digest},authority:"FORENSIC_MODEL_ONLY_RECOVERY_BLOCKED"};
}));}
module.exports=Object.freeze({EVIDENCE_CLASS:LABEL,COMPLETION_SCHEMA:BUNDLE,PROMOTION_SCHEMA:SCHEMA,COSTS,CRITERIA,BACKOFF_MS,DELIVERY_BUDGET_MS,validateBundle,recheckCompletion,lifecycleFits,forensicCandidates});
