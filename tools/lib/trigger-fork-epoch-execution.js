"use strict";
// Pure phase-B binding DATA helpers. No runtime authority, I/O, identity
// duplication, generic hashing, containment or economics qualification.
const core=require("./trigger-fork-epoch.js");
const context=require("./trigger-fork-epoch-context.js");
const {parseStrictJson,canonicalize}=require("./evm-call-inventory-v2/canonical.js");
const {isPromise}=require("node:util").types;
const promiseThen=Promise.prototype.then;
const ownDescriptor=Object.getOwnPropertyDescriptor;
const defineOwn=Object.defineProperty;
const extensible=Object.isExtensible;
const applyIntrinsic=Reflect.apply;
const deleteOwn=Reflect.deleteProperty;
const freezeObservation=Object.freeze;
const discardPromiseSettlement=()=>undefined;
// TRUSTED synchronous model callbacks, not a boundary against arbitrary code
// in this process. Authors own their rejected Promises outside this controlled
// path. Local constructor normalization bypasses constructor/species hooks;
// it changes only the unsupported returned receiver, never global prototypes.
// UNOBSERVED means no handling guarantee. No await, reasons or late upgrades.
function observePromise(value){
  if(!isPromise(value))return null;
  const state=(observation,restoration)=>freezeObservation({observation,restoration});
  let original,normalized=false,attached=false,restoration="NOT_NEEDED";
  try{
    original=ownDescriptor(value,"constructor");
    const safe=original&&("value"in original)&&original.value===undefined;
    if(!safe){
      if(original?!original.configurable:!extensible(value))return state("UNOBSERVED_UNSAFE","NOT_NEEDED");
      defineOwn(value,"constructor",{value:undefined,writable:true,enumerable:false,configurable:true});
      normalized=true;
    }
  }catch(_){return state("UNOBSERVED_NORMALIZATION_FAILED","NOT_NEEDED");}
  try{
    applyIntrinsic(promiseThen,value,[discardPromiseSettlement,discardPromiseSettlement]);
    attached=true;
  }catch(_){/* a failed attach is not observation */}
  finally{
    if(normalized){
      try{
        if(original)defineOwn(value,"constructor",original);
        else if(!deleteOwn(value,"constructor"))throw new Error();
        restoration="RESTORED";
      }catch(_){restoration="FAILED";}
    }
  }
  return state(attached?"OBSERVED":"UNOBSERVED_ATTACH_FAILED",restoration);
}
const RESULT_SCHEMA="trigger-fork-epoch-execution-result/v1";
const DEADLINE_KEYS=["workUtcMs","workMonotonicMs","cleanupUtcMs","cleanupMonotonicMs","epochUtcMs","epochMonotonicMs"];
const RESULT_KEYS=["schema","callerClass","eventContext","deadlines","status","blocker","teardownVerified","modelEvidence"];
const STATUSES=["MODEL_PASS","MODEL_FAIL","MODEL_BLOCKED","MODEL_UNCERTAIN"];
const BLOCKERS=[null,"MODEL_SOURCE_INVALID","MODEL_BINDING_MISMATCH","MODEL_ADMISSION_REJECTED","MODEL_CLOCK_INVALID","MODEL_CLOCK_DISCONTINUITY","MODEL_WORK_DEADLINE","MODEL_CLEANUP_DEADLINE","MODEL_DEPENDENCY_INVALID","MODEL_SCENARIO_LOAD_FAILED","MODEL_SCENARIO_INVALID","MODEL_QUALIFICATION_FAILED","MODEL_START_FAILED","MODEL_SCENARIO_FAILED","MODEL_ASSERTION_FAILED","MODEL_TEARDOWN_UNCONFIRMED","MODEL_CHILD_RESULT_INVALID","MODEL_WRITE_FAILED","MODEL_ASYNC_UNSUPPORTED","MODEL_PROMISE_UNOBSERVED","MODEL_PROMISE_ATTACH_FAILED","MODEL_PROMISE_RESTORE_FAILED"];
function exact(o,keys) {
  if(!o || (Object.getPrototypeOf(o)!==Object.prototype && Object.getPrototypeOf(o)!==null) || Reflect.ownKeys(o).length!==keys.length) throw new Error("INVALID_DATA");
  for(const k of Reflect.ownKeys(o)){const d=Object.getOwnPropertyDescriptor(o,k);if(!keys.includes(k)||!d.enumerable||!("value"in d))throw new Error("INVALID_DATA");}
}
function detached(o){const clone=JSON.parse(JSON.stringify(o));const freeze=x=>{if(x&&typeof x==="object"){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};return freeze(clone);}
function parse(text,max){
  if(typeof text!=="string"||Buffer.byteLength(text)>max)throw new Error("INVALID_DATA");
  let depth=0,highest=0,quoted=false,escape=false;
  for(const ch of text){if(quoted){if(escape)escape=false;else if(ch==="\\")escape=true;else if(ch==='"')quoted=false;}else if(ch==='"')quoted=true;else if(ch==="{"||ch==="[")highest=Math.max(highest,++depth);else if(ch==="}"||ch==="]")--depth;}
  if(highest>8)throw new Error("INVALID_DATA");return parseStrictJson(text);
}
function encodeData(value){
  const walk=(v,depth)=>{
    if(depth>8)throw new Error("INVALID_DATA");
    if(v===null||typeof v==="boolean")return;
    if(typeof v==="number"){if(!Number.isSafeInteger(v))throw new Error("INVALID_DATA");return;}
    if(typeof v==="string"){if(v.length>256)throw new Error("INVALID_DATA");return;}
    if(!v||typeof v!=="object"||(!Array.isArray(v)&&Object.getPrototypeOf(v)!==Object.prototype&&Object.getPrototypeOf(v)!==null))throw new Error("INVALID_DATA");
    if(Array.isArray(v)&&v.length>128)throw new Error("INVALID_DATA");
    const keys=Reflect.ownKeys(v).filter(k=>!(Array.isArray(v)&&k==="length"));if(keys.length>128)throw new Error("INVALID_DATA");
    for(const k of keys){const d=Object.getOwnPropertyDescriptor(v,k);if(typeof k!=="string"||!("value"in d)||!d.enumerable)throw new Error("INVALID_DATA");walk(d.value,depth+1);}
  };walk(value,0);return JSON.stringify(value);
}
function diagnostic(options={}) {
  const invalid=()=>detached({ok:false,callerClass:"UNVALIDATED",eventContext:null,deadlines:null,blocker:"EXECUTION_ENVELOPE_INVALID"});
  try {
    const fields={};for(const key of ["contextText","deadlinesText","eventContext","deadlines","epochTicket","callerClass"]){const d=Object.getOwnPropertyDescriptor(options,key);if(d&&!("value"in d))return invalid();fields[key]=d?d.value:undefined;}
    if(fields.contextText!==undefined || fields.deadlinesText!==undefined){const e=envelope(options);if(fields.callerClass!==undefined&&fields.callerClass!==e.callerClass)return invalid();return e;}
    if(fields.eventContext!==undefined||fields.deadlines!==undefined||fields.epochTicket!==undefined||
        (fields.callerClass!==undefined&&fields.callerClass!=="MANUAL"&&fields.callerClass!=="EPOCH_OWNER"))return invalid();
    return detached({ok:true,callerClass:fields.callerClass==="EPOCH_OWNER"?"UNVALIDATED":"MANUAL",eventContext:null,deadlines:null});
  }catch{return invalid();}
}
function envelope(i){
  let c=null;
  try{
    const cd=Object.getOwnPropertyDescriptor(i,"contextText"),dd=Object.getOwnPropertyDescriptor(i,"deadlinesText");
    if(!cd||!dd||!("value"in cd)||!("value"in dd))throw new Error("INVALID_DATA");
    const v=context.validateSerializedContextStructure(cd.value);if(v.status!=="VALID")throw new Error("INVALID_DATA");c=v.context;
    const d=parse(dd.value,1024);exact(d,DEADLINE_KEYS);
    for(const k of DEADLINE_KEYS)if(!Number.isSafeInteger(d[k])||d[k]<0)throw new Error("INVALID_DATA");
    if(d.workUtcMs>d.cleanupUtcMs||d.cleanupUtcMs>d.epochUtcMs||d.workMonotonicMs>d.cleanupMonotonicMs||d.cleanupMonotonicMs>d.epochMonotonicMs)throw new Error("INVALID_DATA");
    return detached({ok:true,callerClass:c.callerClass,eventContext:c,deadlines:d});
  }catch{return detached({ok:false,callerClass:c?c.callerClass:"UNVALIDATED",eventContext:c,deadlines:null,blocker:"EXECUTION_ENVELOPE_INVALID"});}
}
function asyncBlock(options={}) {
  const d=diagnostic(options);
  if(!d.ok || d.callerClass!=="MANUAL")return detached({status:"FAIL_CLOSED",blocker:d.ok?"PLATFORM_RUNTIME_UNIMPLEMENTED":"EXECUTION_ENVELOPE_INVALID",callerClass:d.callerClass,eventContext:d.eventContext,deadlines:d.deadlines});
  return null;
}
function metadata(d){return detached({callerClass:d.callerClass,eventContext:d.eventContext,deadlines:d.deadlines});}
function snapshotRequest(i){
  exact(i,["contextText","deadlinesText","eventText","manifestText","inheritedText","consumedText","expectedSourceDigest","adapterDigest","scenarioDigest"]);
  const sizes={contextText:8192,deadlinesText:1024,eventText:16384,manifestText:65536,inheritedText:65536,consumedText:65536,expectedSourceDigest:66,adapterDigest:66,scenarioDigest:66};
  const copy={};for(const k of Object.keys(sizes)){if(typeof i[k]!=="string"||Buffer.byteLength(i[k])>sizes[k])throw new Error("MODEL_SOURCE_INVALID");copy[k]=i[k];}
  return Object.freeze(copy);
}
function result(env,status,blocker=null,teardownVerified=false){return detached({schema:RESULT_SCHEMA,...metadata(env),status,blocker,teardownVerified,modelEvidence:"SYNCHRONOUS_INERT_MODEL_ONLY"});}
function validResult(value,env){
  try{
    if(observePromise(value))return false;
    exact(value,RESULT_KEYS);
    if(value.schema!==RESULT_SCHEMA||!STATUSES.includes(value.status)||!BLOCKERS.includes(value.blocker)||typeof value.teardownVerified!=="boolean"||value.modelEvidence!=="SYNCHRONOUS_INERT_MODEL_ONLY")return false;
    const candidate=envelope({contextText:encodeData(value.eventContext),deadlinesText:encodeData(value.deadlines)});
    if(!candidate.ok||value.callerClass!==env.callerClass||value.callerClass!==candidate.callerClass||candidate.callerClass!==env.callerClass||canonicalize(candidate.eventContext)!==canonicalize(env.eventContext)||canonicalize(candidate.deadlines)!==canonicalize(env.deadlines))return false;
    if(value.status==="MODEL_PASS" && (!value.teardownVerified||value.blocker!==null))return false;
    return true;
  }catch{return false;}
}
function synchronousProof(value,schema,key){try{if(observePromise(value))return false;exact(value,["schema",key]);return value.schema===schema&&value[key]===true;}catch{return false;}}
function rejectPromise(value){
  const s=observePromise(value);if(!s)return value;
  const code=s.observation!=="OBSERVED"?(s.observation==="UNOBSERVED_ATTACH_FAILED"?"MODEL_PROMISE_ATTACH_FAILED":"MODEL_PROMISE_UNOBSERVED"):
    s.restoration==="FAILED"?"MODEL_PROMISE_RESTORE_FAILED":"MODEL_ASYNC_UNSUPPORTED";
  throw new Error(code);
}
function scenarioDescriptor(value,env,eventText){
  try{
    exact(value,["schema","valid","adapterDigest","scenarioDigest","scenarioId","semanticEventId"]);
    const event=core.parseSourceEvent(eventText);if(!event.event)return false;
    return value.schema==="trigger-fork-inert-scenario/v1"&&value.valid===true&&value.adapterDigest===env.eventContext.adapterDigest&&
      value.scenarioDigest===env.eventContext.scenarioDigest&&value.scenarioId===event.event.scenarioId&&value.semanticEventId===env.eventContext.semanticEventId;
  }catch{return false;}
}
function assertion(value,env){try{exact(value,["schema","passed","semanticEventId","scenarioDigest"]);return value.schema==="trigger-fork-inert-assertion/v1"&&value.passed===true&&value.semanticEventId===env.eventContext.semanticEventId&&value.scenarioDigest===env.eventContext.scenarioDigest;}catch{return false;}}
function guard(env,clock){
  let anchor=null,previous=null;
  return phase=>{
    let s;try{const raw=clock.sample();exact(raw,["nowUtcMs","monotonicNowMs"]);s={nowUtcMs:raw.nowUtcMs,monotonicNowMs:raw.monotonicNowMs};for(const x of Object.values(s))if(!Number.isSafeInteger(x)||x<0)throw new Error();}catch{throw new Error("MODEL_CLOCK_INVALID");}
    if(previous&&(s.nowUtcMs<previous.nowUtcMs||s.monotonicNowMs<previous.monotonicNowMs))throw new Error("MODEL_CLOCK_DISCONTINUITY");
    if(!anchor)anchor=s;
    if(Math.abs((s.nowUtcMs-anchor.nowUtcMs)-(s.monotonicNowMs-anchor.monotonicNowMs))>60000)throw new Error("MODEL_CLOCK_DISCONTINUITY");previous=s;
    const d=env.deadlines,u=phase==="cleanup"?d.cleanupUtcMs:d.workUtcMs,m=phase==="cleanup"?d.cleanupMonotonicMs:d.workMonotonicMs;
    if(s.nowUtcMs>=Math.min(u,d.epochUtcMs)||s.monotonicNowMs>=Math.min(m,d.epochMonotonicMs))throw new Error(phase==="cleanup"?"MODEL_CLEANUP_DEADLINE":"MODEL_WORK_DEADLINE");
    return s;
  };
}
function normalized(env,i,s){
  try{
    if(env.callerClass!=="EPOCH_OWNER")return "MODEL_BINDING_MISMATCH";
    const e=core.parseSourceEvent(i.eventText);if(!e.event)return "MODEL_SOURCE_INVALID";
    const c=env.eventContext;
    const rebuilt=context.buildEventContext({callerClass:"EPOCH_OWNER",eventText:i.eventText,epochId:c.epochId,ownerInstanceId:c.ownerInstanceId,reservationSeq:c.reservationSeq,passId:c.passId});
    if(rebuilt.status!=="VALID"||canonicalize(rebuilt.context)!==canonicalize(c)||i.expectedSourceDigest!==c.sourceDigest||i.adapterDigest!==c.adapterDigest||i.scenarioDigest!==c.scenarioDigest)return "MODEL_BINDING_MISMATCH";
    const m=core.parseEpochManifest(i.manifestText);if(!m.manifest)return "MODEL_ADMISSION_REJECTED";
    const a=core.admitEvent({manifest:m,event:i.eventText,consumed:i.consumedText,inherited:i.inheritedText,expectedSourceDigest:i.expectedSourceDigest,nowMs:s.nowUtcMs});
    return a.status==="OFFLINE_VALID"?null:"MODEL_ADMISSION_REJECTED";
  }catch{return "MODEL_SOURCE_INVALID";}
}
function failureCode(error,fallback){return error instanceof Error&&BLOCKERS.includes(error.message)?error.message:fallback;}
module.exports=Object.freeze({RESULT_SCHEMA,DEADLINE_KEYS:Object.freeze(DEADLINE_KEYS),diagnostic,envelope,asyncBlock,metadata,snapshotRequest,result,validResult,synchronousProof,observePromise,rejectPromise,scenarioDescriptor,assertion,guard,normalized,failureCode});
