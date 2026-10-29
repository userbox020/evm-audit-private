#!/usr/bin/env node
"use strict";
// Historical APPLY execution expectations deliberately replaced by the stronger
// no-read/no-lock/no-write hold. CHECK/legacy diagnostics and primitive tests
// remain exercised. Epoch execution/consumption now lives in the synchronous
// integration suite, not in a test escape hatch to legacy APPLY.
const test=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto"),fs=require("node:fs"),path=require("node:path");
const a=require("./trigger-fork-autopilot");
const NOW=Date.parse("2026-09-19T12:00:00.000Z"),iso=n=>new Date(NOW+n).toISOString();
const SUPPORTED=[["kelp-composite","TRIGGER_UNPAUSE"],["ostium-settlement-window","WINDOW_OPEN"],["clever-harvest","STRATEGY_SET_CHANGED"],["frax-usdc-cross-venue","ATOMIC_FORK_REQUIRED"],["base-usdc-usdt-cross-venue","ATOMIC_FORK_REQUIRED"]];
function producer(id="kelp-composite",status="TRIGGER_UNPAUSE",overrides={}){return {id,status,generatedAt:iso(-1000),evidence:{blockNumberRaw:"123",blockTimestampRaw:"1789819199"},...overrides};}
function source(rows=[producer()],at=iso(-2000)){return {schema:a.SOURCE_SCHEMA,generatedAt:at,running:true,producers:rows};}
function state(){return {schema:a.STATE_SCHEMA,eventJournal:{completeness:"EXPLICIT_ATTESTATION",provenance:"EXTERNAL_RECONCILIATION",attestedAt:iso(0)},updatedAt:null,events:{},history:[]};}
function deps(input=source(),prior=state()){
  return {now:()=>NOW,readSource:()=>JSON.stringify(input),readState:()=>prior,planBridge:s=>({rows:s.producers.map(p=>({producerId:p.id,status:SUPPORTED.some(([id,status])=>p.id===id&&p.status===status)?"WOULD_FORK":"NOT_FIRED"}))}),
    acquireLock:()=>{throw new Error("CHECK lock");},runBridge:()=>{throw new Error("CHECK fork");},writeArtifacts:()=>{throw new Error("CHECK write");},write:()=>{}};
}
function snapshot(){return [a.STATE_FILE,a.STATUS_FILE,a.LOCK_FILE].map(file=>{try{return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");}catch{return null;}});}
const before=snapshot();test.after(()=>assert.deepEqual(snapshot(),before));
test("GateB accessor apply never executes getter or dependencies",async()=>{
  let gets=0,calls=0;const options={};Object.defineProperty(options,"apply",{enumerable:true,get(){return ++gets>1;}});
  const d=new Proxy({}, {ownKeys(){++calls;return [];}});
  const r=await a.runAutopilot(options,d);assert.equal(gets,0);assert.equal(calls,0);assert.equal(r.executed,0);assert.equal(r.status.blocker,"AUTOPILOT_OPTIONS_INVALID");
});
test("GateB untrusted flags refuse; CHECK uses detached frozen options",async()=>{
  for(const apply of [1,"true",null,{},undefined]){const r=await a.runAutopilot({apply},new Proxy({}, {ownKeys(){throw new Error("deps accessed");}}));assert.equal(r.status.blocker,"AUTOPILOT_OPTIONS_INVALID");}
  const options={apply:false};const d=deps();d.readState=()=>{options.apply=true;return state();};const r=await a.runAutopilot(options,d);assert.equal(r.status.mode,"CHECK");assert.equal(r.executed,0);
});
test("GateB CHECK option accessor refused without invocation",async()=>{
  let gets=0;const options={apply:false};Object.defineProperty(options,"sourceMaxAgeMs",{enumerable:true,get(){++gets;return 1;}});
  const r=await a.runAutopilot(options,new Proxy({}, {ownKeys(){throw new Error("deps accessed");}}));assert.equal(gets,0);assert.equal(r.status.mode,"CHECK");assert.equal(r.status.blocker,"AUTOPILOT_OPTIONS_INVALID");
});
const historicalApplyCases=[
  ["fresh supported fire executes exactly once",source(),state()],
  ["stale source fails closed without a fork",source([producer()],iso(-a.SOURCE_MAX_AGE_MS-1)),state()],
  ["known non-fired status performs no fork",source([producer("kelp-composite","BLOCKED_PAUSED")]),state()],
  ["unknown status fails closed for the whole pass",source([producer("kelp-composite","SURPRISE")]),state()],
  ["unmapped fired producer fails closed",source([producer("unsupported","WINDOW_OPEN")]),state()],
  ["terminal event identity is permanently deduped",source(),state()],
  ["corrupt existing state fails closed without replacing it",source(),{schema:"wrong/v1"}],
  ["missing state blocks unattended apply for no-fire and fired source",source(),null],
  ["previously fired event cannot replay after state loss",source(),null],
  ["valid persisted same-event reservation remains deduped",source(),state()],
  ["overlap lock blocks before source read or fork",source(),state()],
  ["nonterminal prior reservation observes per-event backoff",source(),state()],
  ["pass cap filters bridge input to one fired event",source(SUPPORTED.slice(0,2).map(([id,s])=>producer(id,s))),state()],
  ["failed fork retained with net and never promoted",source(),state()],
  ["FRAX event identity/cooldown promotion",source([producer("frax-usdc-cross-venue","ATOMIC_FORK_REQUIRED")]),state()],
  ["FRAX promotion requires exact-pin observation",source([producer("frax-usdc-cross-venue","ATOMIC_FORK_REQUIRED")]),state()],
  ["new FRAX event inside route cooldown backs off",source([producer("frax-usdc-cross-venue","ATOMIC_FORK_REQUIRED")]),state()],
  ["Base mirrors FRAX identity/promotion/cooldown",source([producer("base-usdc-usdt-cross-venue","ATOMIC_FORK_REQUIRED")]),state()],
  ["endpoint material rejected and never persisted",source([producer("kelp-composite","TRIGGER_UNPAUSE",{evidence:{rpc:"https://invalid.test/private"}})]),state()],
  ["oversized journal never evicts identities",source(),state()],
  ["identity128/129 capacity without eviction",source(),state()],
  ["legacy v1 never gains completeness provenance",source(),{schema:a.LEGACY_STATE_SCHEMA,events:{},history:[]}],
  ["reservation write failure never invokes bridge",source(),state()],
  ["invalid source schema fails closed",{schema:"wrong/v1"},state()],
  ["reservation must precede bridge (no default legacy reservation)",source(),state()]
];
for(const [name,input,prior] of historicalApplyCases)test("held replacement for historical APPLY: "+name,async()=>{
  const calls=[];const d=deps(input,prior);
  for(const k of ["now","readSource","readState","planBridge","acquireLock","runBridge","writeArtifacts"])d[k]=()=>{calls.push(k);throw new Error("must not run");};
  const r=await a.runAutopilot({apply:true},d);assert.equal(r.status.blocker,"EPOCH_OWNER_REQUIRED");assert.equal(r.status.platformBlocker,"PLATFORM_RUNTIME_UNIMPLEMENTED");
  assert.equal(r.executed,0);assert.deepEqual(calls,[]);assert.equal(r.status.execution,null);
});
test("CHECK remains pure with all five legacy producer/status mappings",async()=>{
  for(const [id,status]of SUPPORTED){const r=await a.runAutopilot({},deps(source([producer(id,status)])));assert.equal(r.status.classification,"READY");assert.equal(r.status.summary.planned,1);assert.equal(r.executed,0);}
});
for(const [name,input,blocker]of[
  ["stale",source([producer()],iso(-a.SOURCE_MAX_AGE_MS-1)),"STALE_SOURCE"],
  ["unknown",source([producer("kelp-composite","SURPRISE")]),"UNKNOWN_STATUS"],
  ["invalid",{schema:"wrong/v1"},"SOURCE_SCHEMA_INVALID"],
  ["endpoint",source([producer("kelp-composite","TRIGGER_UNPAUSE",{evidence:{rpc:"https://invalid.test/private"}})]),"SOURCE_ENDPOINT_MATERIAL_REJECTED"]
])test("CHECK retains legacy diagnostic: "+name,async()=>{const r=await a.runAutopilot({},deps(input));assert.equal(r.status.blocker,blocker);assert.equal(r.executed,0);});
test("CHECK absent/corrupt/legacy journal diagnostics never mutate or arm",async()=>{
  for(const prior of [null,{schema:"wrong/v1"},{schema:a.LEGACY_STATE_SCHEMA,events:{},history:[]}]){const r=await a.runAutopilot({},deps(source(),prior));assert.equal(r.executed,0);assert.equal(r.status.classification,"FAIL_CLOSED");}
});
test("CHECK terminal and uncertain prior reservation retain dedupe/backoff",async()=>{
  const p=producer(),id=a.evidenceIdentity(p);
  for(const terminal of [true,false]){const s=state();s.events[id]={producerId:p.id,firedStatus:p.status,phase:terminal?"SUCCEEDED":"RESERVED",terminal,attempts:1,result:terminal?"PASS":"IN_PROGRESS_UNCERTAIN",success:terminal,nextEligibleAt:iso(60000)};
    const r=await a.runAutopilot({},deps(source([p]),s));assert.equal(r.status.plan[0].action,terminal?"DEDUPED":"BACKOFF");assert.equal(r.executed,0);}
});
test("CHECK pass cap and no-fire remain diagnostic only",async()=>{
  const r=await a.runAutopilot({},deps(source(SUPPORTED.slice(0,2).map(([id,s])=>producer(id,s)))));assert.equal(r.status.plan.filter(p=>p.action==="DEFERRED_CAP").length,1);assert.equal(r.executed,0);
  const quiet=await a.runAutopilot({},deps(source([producer("kelp-composite","BLOCKED_PAUSED")])));assert.equal(quiet.status.classification,"NO_FIRED_EVENT");
});
test("apply CLI remains nonzero even for quiet/stale/overlap/fork-failure inputs",async()=>{
  const previous=process.exitCode;try{for(const input of [source(),source([]),source([producer()],iso(-a.SOURCE_MAX_AGE_MS-1))]){process.exitCode=0;const writes=[];const r=await a.runCli(["node","tool","--apply"],{...deps(input),write:t=>writes.push(JSON.parse(t))});assert.equal(r.status.blocker,"EPOCH_OWNER_REQUIRED");assert.equal(writes[0].blocker,"EPOCH_OWNER_REQUIRED");assert.equal(process.exitCode,1);}}finally{process.exitCode=previous;}
});
test("atomic writer uses exclusive temporary creation/rename (fake fs only)",()=>{
  const calls=[],fake={mkdirSync:(...x)=>calls.push(["mkdir",...x]),writeFileSync:(...x)=>calls.push(["write",...x]),renameSync:(...x)=>calls.push(["rename",...x]),rmSync:(...x)=>calls.push(["remove",...x])};
  a.writeAtomic("C:\\temp\\status.json",{schema:"test/v1"},fake);assert.equal(calls.find(x=>x[0]==="write")[3].flag,"wx");assert.equal(calls.find(x=>x[0]==="rename")[2],"C:\\temp\\status.json");
});
for(const kind of ["corrupt old","corrupt young","valid expired"])test("legacy lock ownership remains untouched: "+kind,()=>{
  const dir=fs.mkdtempSync(path.join(process.env.LOCALAPPDATA,"Temp","opencode","phase-b-lock-")),file=path.join(dir,"lock");
  try{const bytes=kind==="valid expired"?Buffer.from(JSON.stringify({owner:"live-owner",expiresAt:iso(-60000)})):Buffer.alloc(122,0);fs.writeFileSync(file,bytes);if(kind!=="corrupt young")fs.utimesSync(file,new Date(iso(-600000)),new Date(iso(-600000)));const time=fs.statSync(file).mtimeMs;const l=a.acquireFileLock(file,NOW,fs);assert.equal(l.acquired,false);l.release();assert.deepEqual(fs.readFileSync(file),bytes);assert.equal(fs.statSync(file).mtimeMs,time);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test("suite has not touched live autopilot artifacts",()=>assert.deepEqual(snapshot(),before));
