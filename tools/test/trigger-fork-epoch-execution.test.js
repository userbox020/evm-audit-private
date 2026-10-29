"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const core=require("../lib/trigger-fork-epoch.js"),ctx=require("../lib/trigger-fork-epoch-context.js"),owner=require("../lib/trigger-fork-epoch-owner.js");
const platform=require("../lib/trigger-fork-epoch-platform.js"),journal=require("../lib/trigger-fork-epoch-journal.js"),exec=require("../lib/trigger-fork-epoch-execution.js");
const bridge=require("../run-trigger-fork-poc.js"),harness=require("../run-fork-poc.js"),auto=require("../trigger-fork-autopilot.js");
const f=require("./fixtures/trigger-fork-epoch-fixtures.js");
const vm=require("node:vm");
const dirs=[],adapters=[];test.after(()=>{for(const a of adapters)a.releaseTestHandles();for(const d of dirs)fs.rmSync(d,{recursive:true,force:true});});
function fixture(){
  let u=f.NOW_BASE,m=3e9;const clock={sample:()=>({nowUtcMs:u,monotonicNowMs:m})};
  const eventText=f.quoteEventText(),manifestText=JSON.stringify(f.manifestFixture());
  const c=ctx.buildEventContext({callerClass:"EPOCH_OWNER",eventText,reservationSeq:"2",passId:"PASS-execution",ownerInstanceId:"OPI-execution",epochId:f.EPOCH_ID});assert.equal(c.status,"VALID");
  const deadlines={workUtcMs:u+210000,workMonotonicMs:m+210000,cleanupUtcMs:u+220000,cleanupMonotonicMs:m+220000,epochUtcMs:u+600000,epochMonotonicMs:m+600000};
  const request={contextText:JSON.stringify(c.context),deadlinesText:JSON.stringify(deadlines),eventText,manifestText,inheritedText:"[]",consumedText:"[]",expectedSourceDigest:f.hex64("f"),adapterDigest:f.hex64("b"),scenarioDigest:f.hex64("c")};
  return {request,clock,advance:n=>{u+=n;m+=n;},env:exec.envelope(request)};
}
const proof=(schema,key)=>({schema,[key]:true});
const write=()=>proof("trigger-fork-inert-write/v1","written");
function loaded(e){return {schema:"trigger-fork-inert-scenario/v1",valid:true,adapterDigest:e.eventContext.adapterDigest,scenarioDigest:e.eventContext.scenarioDigest,scenarioId:core.parseSourceEvent(e.eventText).event.scenarioId,semanticEventId:e.eventContext.semanticEventId};}
function asserted(e){return {schema:"trigger-fork-inert-assertion/v1",passed:true,semanticEventId:e.eventContext.semanticEventId,scenarioDigest:e.eventContext.scenarioDigest};}
function deps(h,changes={}) {return {clock:h.clock,loadScenario:loaded,qualify:()=>proof("trigger-fork-inert-qualification/v1","pinsVerified"),start:()=>proof("trigger-fork-inert-start/v1","contained"),runScenario:asserted,cleanup:()=>proof("trigger-fork-inert-teardown/v1","teardownVerified"),writeResult:write,...changes};}
function same(result,h){assert.equal(result.callerClass,"EPOCH_OWNER");assert.deepEqual(result.eventContext,h.env.eventContext);assert.deepEqual(result.deadlines,h.env.deadlines);}
for(const callerClass of ["MANUAL","UNVALIDATED",42,"UNKNOWN",null])test("GateB child outer caller equality: "+callerClass,()=>{
  const h=fixture(),child={...exec.result(h.env,"MODEL_PASS",null,true),callerClass};
  assert.equal(exec.validResult(child,h.env),false);
  const r=bridge.runEpochBridgeModel(h.request,{clock:h.clock,runHarness:()=>child,writeResult:write});same(r,h);assert.equal(r.blocker,"MODEL_CHILD_RESULT_INVALID");
});
for(const fault of ["expiry","clock","start-throw"])test("GateB shutdown attempted once despite post-start "+fault,()=>{
  const h=fixture();let active=false,cleanups=0,broken=false;const clock={sample:()=>broken?{nowUtcMs:f.NOW_BASE-1,monotonicNowMs:3e9-1}:h.clock.sample()};
  const r=harness.runEpochHarnessModel(h.request,deps(h,{clock,start:()=>{active=true;if(fault==="start-throw"){broken=true;throw new Error("private");}return proof("trigger-fork-inert-start/v1","contained");},runScenario:e=>{if(fault==="expiry")h.advance(220000);else broken=true;return asserted(e);},cleanup:()=>{++cleanups;active=false;return proof("trigger-fork-inert-teardown/v1","teardownVerified");}}));
  same(r,h);assert.equal(active,false);assert.equal(cleanups,1);assert.equal(r.status,"MODEL_UNCERTAIN");assert.equal(r.teardownVerified,false);
});
for(const stage of ["loadScenario","qualify","start","runScenario","cleanup","writeResult","bridgechild","bridgewriter"])test("GateB rejecting native Promise observed synchronously: "+stage,async()=>{
  const h=fixture();const reject=()=>Promise.reject(new Error("synthetic-private-rejection"));
  const r=stage==="bridgechild"?bridge.runEpochBridgeModel(h.request,{clock:h.clock,runHarness:reject,writeResult:write}):stage==="bridgewriter"?bridge.runEpochBridgeModel(h.request,{clock:h.clock,runHarness:()=>exec.result(h.env,"MODEL_PASS",null,true),writeResult:reject}):harness.runEpochHarnessModel(h.request,deps(h,{[stage]:reject}));
  same(r,h);assert.notEqual(r.status,"MODEL_PASS");assert.equal(r instanceof Promise,false);const saved=JSON.stringify(r);assert.ok(!saved.includes("synthetic-private"));
  await new Promise(resolve=>setImmediate(resolve));assert.equal(JSON.stringify(r),saved);
});
test("GateB arbitrary thenable getter is never executed",()=>{
  const h=fixture();let gets=0;const thenable={};Object.defineProperty(thenable,"then",{get(){++gets;throw new Error("private");}});
  const r=harness.runEpochHarnessModel(h.request,deps(h,{runScenario:()=>thenable}));same(r,h);assert.notEqual(r.status,"MODEL_PASS");assert.equal(gets,0);
});
test("GateB native Promise own then getter is not executed by rejection sink",async()=>{
  const h=fixture();let gets=0;const p=Promise.reject(new Error("synthetic-private-rejection"));Object.defineProperty(p,"then",{get(){++gets;throw new Error("private getter");}});
  const r=harness.runEpochHarnessModel(h.request,deps(h,{cleanup:()=>p}));same(r,h);assert.equal(r.teardownVerified,false);assert.equal(gets,0);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(gets,0);
});
// Final GateB contract: trusted callback authors pre-handle unsafe receivers.
// These cases do NOT orphan unsafe rejections or claim universal observation.
function authorOwnedRejection(){const p=Promise.reject(new Error("synthetic-private-rejection"));p.then(()=>undefined,()=>undefined);return p;}
for(const kind of ["getter","null","species"])test("final GateB controlled constructor normalized/restored hook-free: "+kind,async()=>{
  const p=Promise.reject(new Error("synthetic-private-rejection"));let hooks=0;
  if(kind==="getter")Object.defineProperty(p,"constructor",{get(){++hooks;throw new Error("private constructor");},enumerable:true,configurable:true});
  if(kind==="null")Object.defineProperty(p,"constructor",{value:null,writable:false,enumerable:true,configurable:true});
  if(kind==="species"){
    const c={};Object.defineProperty(c,Symbol.species,{get(){++hooks;return function(){++hooks;throw new Error("private species");};}});
    Object.defineProperty(p,"constructor",{value:c,writable:true,enumerable:true,configurable:true});
  }
  const original=Object.getOwnPropertyDescriptor(p,"constructor");
  const s=exec.observePromise(p);assert.deepEqual(s,{observation:"OBSERVED",restoration:"RESTORED"});assert.ok(Object.isFrozen(s));
  assert.deepEqual(Object.getOwnPropertyDescriptor(p,"constructor"),original);assert.equal(hooks,0);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(hooks,0);
});
test("final GateB ordinary Promise restores absence of own constructor",async()=>{
  const p=Promise.reject(new Error("synthetic-private-rejection"));assert.equal(Object.hasOwn(p,"constructor"),false);
  assert.deepEqual(exec.observePromise(p),{observation:"OBSERVED",restoration:"RESTORED"});assert.equal(Object.hasOwn(p,"constructor"),false);
  await new Promise(resolve=>setImmediate(resolve));
});
for(const kind of ["nonconfig-getter","nonconfig-data","frozen-getter","frozen-data","nonextensible"])test("final GateB unsafe immutable Promise explicitly UNOBSERVED: "+kind,async()=>{
  const p=authorOwnedRejection();let hooks=0;
  if(kind.endsWith("getter"))Object.defineProperty(p,"constructor",{get(){++hooks;throw new Error("private constructor");},configurable:false});
  if(kind.endsWith("data"))Object.defineProperty(p,"constructor",{value:null,configurable:false});
  if(kind.startsWith("frozen"))Object.freeze(p);
  if(kind==="nonextensible")Object.preventExtensions(p);
  const original=Object.getOwnPropertyDescriptor(p,"constructor");
  assert.deepEqual(exec.observePromise(p),{observation:"UNOBSERVED_UNSAFE",restoration:"NOT_NEEDED"});
  assert.throws(()=>exec.rejectPromise(p),{message:"MODEL_PROMISE_UNOBSERVED"});
  assert.equal(exec.synchronousProof(p,"trigger-fork-inert-teardown/v1","teardownVerified"),false);
  const h=fixture();assert.equal(exec.validResult(p,h.env),false);
  assert.deepEqual(Object.getOwnPropertyDescriptor(p,"constructor"),original);assert.equal(hooks,0);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(hooks,0);
});
test("final GateB frozen own data constructor undefined remains safely observable",async()=>{
  const p=Promise.reject(new Error("synthetic-private-rejection"));Object.defineProperty(p,"constructor",{value:undefined});Object.freeze(p);
  const original=Object.getOwnPropertyDescriptor(p,"constructor");assert.deepEqual(exec.observePromise(p),{observation:"OBSERVED",restoration:"NOT_NEEDED"});
  assert.deepEqual(Object.getOwnPropertyDescriptor(p,"constructor"),original);assert.equal(Object.isFrozen(p),true);
  await new Promise(resolve=>setImmediate(resolve));
});
test("final GateB cross-realm Node-branded Promise uses controlled intrinsic path",async()=>{
  const p=vm.runInNewContext("Promise.reject(new Error('synthetic-private-rejection'))");assert.equal(p instanceof Promise,false);
  assert.deepEqual(exec.observePromise(p),{observation:"OBSERVED",restoration:"RESTORED"});assert.equal(Object.hasOwn(p,"constructor"),false);
  await new Promise(resolve=>setImmediate(resolve));
});
for(const stage of ["loadScenario","qualify","start","runScenario","cleanup","writeResult","bridgechild","bridgewriter"])test("final GateB constructor getter safely bypassed on actual return route: "+stage,async()=>{
  const h=fixture();let hooks=0,created;
  const callback=()=>{created=Promise.reject(new Error("synthetic-private-rejection"));Object.defineProperty(created,"constructor",{configurable:true,get(){++hooks;throw new Error("private constructor");}});return created;};
  const r=stage==="bridgechild"?bridge.runEpochBridgeModel(h.request,{clock:h.clock,runHarness:callback,writeResult:write}):stage==="bridgewriter"?bridge.runEpochBridgeModel(h.request,{clock:h.clock,runHarness:()=>exec.result(h.env,"MODEL_PASS",null,true),writeResult:callback}):harness.runEpochHarnessModel(h.request,deps(h,{[stage]:callback}));
  same(r,h);assert.notEqual(r.status,"MODEL_PASS");if(stage==="cleanup")assert.equal(r.teardownVerified,false);
  assert.equal(r instanceof Promise,false);assert.equal(hooks,0);assert.equal(typeof Object.getOwnPropertyDescriptor(created,"constructor").get,"function");
  const saved=JSON.stringify(r);assert.ok(!saved.includes("private"));await new Promise(resolve=>setImmediate(resolve));assert.equal(JSON.stringify(r),saved);assert.equal(hooks,0);
});
for(const stage of ["loadScenario","qualify","start","runScenario","cleanup","writeResult","bridgechild","bridgewriter"])test("final GateB author-owned unsafe receiver never qualifies on return route: "+stage,async()=>{
  const h=fixture();let hooks=0;
  const callback=()=>{const p=authorOwnedRejection();Object.defineProperty(p,"constructor",{get(){++hooks;throw new Error("private constructor");}});Object.freeze(p);return p;};
  const r=stage==="bridgechild"?bridge.runEpochBridgeModel(h.request,{clock:h.clock,runHarness:callback,writeResult:write}):stage==="bridgewriter"?bridge.runEpochBridgeModel(h.request,{clock:h.clock,runHarness:()=>exec.result(h.env,"MODEL_PASS",null,true),writeResult:callback}):harness.runEpochHarnessModel(h.request,deps(h,{[stage]:callback}));
  same(r,h);assert.notEqual(r.status,"MODEL_PASS");if(stage==="cleanup")assert.equal(r.teardownVerified,false);
  if(["loadScenario","qualify","start","runScenario"].includes(stage))assert.equal(r.blocker,"MODEL_PROMISE_UNOBSERVED");
  assert.equal(hooks,0);await new Promise(resolve=>setImmediate(resolve));assert.equal(hooks,0);
});
test("synchronous existing bridge/harness propagate full immutable context and absolute deadlines",()=>{
  const h=fixture(),seen=[];
  const d=deps(h,{qualify:e=>{seen.push(e);return proof("trigger-fork-inert-qualification/v1","pinsVerified");},runScenario:e=>{seen.push(e);return asserted(e);}});
  const result=auto.runEpochAutopilotModel(h.request,{clock:h.clock,runHarness:r=>harness.runEpochHarnessModel(r,d),writeResult:write});
  same(result,h);assert.equal(result.status,"MODEL_PASS");assert.equal(result.teardownVerified,true);assert.equal(exec.validResult(result,h.env),true);
  for(const e of seen){same(e,h);assert.ok(Object.isFrozen(e.eventContext.companionPins));}
  assert.deepEqual(result.eventContext.companionPins.map(p=>p.chainId),[1,10]);
});
for(const field of ctx.CONTEXT_KEYS) test("every context component bound before scenario: "+field,()=>{
  const h=fixture(),v=JSON.parse(h.request.contextText);let calls=0;
  if(field==="primaryPin")v.primaryPin.blockHash=f.hex64("9");
  else if(field==="companionPins")v.companionPins[0].blockHash=f.hex64("9");
  else if(field==="identitySchemaVersion")v[field]=2;
  else if(field==="reservationSeq")v[field]="3";
  else if(field==="routeKey")v[field]=null;
  else if(field.endsWith("Digest")||field==="semanticEventId")v[field]=f.hex64("9");
  else if(field==="passId")v[field]="PASS-other";
  else if(field==="ownerInstanceId")v[field]="OPI-other";
  else if(field==="epochId")v[field]="EP-other";
  else v[field]="UNSUPPORTED";
  h.request.contextText=JSON.stringify(v);
  // Pass/seq/instance are compared at the bridge-child boundary against the
  // owner envelope; at source binding these wrapper fields are legitimate DATA.
  if(["passId","reservationSeq","ownerInstanceId"].includes(field)){
    const forged=exec.result(exec.envelope(h.request),"MODEL_PASS",null,true);
    assert.equal(exec.validResult(forged,h.env),false);return;
  }
  const r=harness.runEpochHarnessModel(h.request,deps(h,{runScenario:()=>{++calls;return proof("trigger-fork-inert-assertion/v1","passed");}}));
  assert.notEqual(r.status,"MODEL_PASS");assert.equal(calls,0);
  if(r.callerClass==="UNVALIDATED")assert.equal(r.eventContext,null);
});
for(const field of ["expectedSourceDigest","adapterDigest","scenarioDigest"]) test("independent source/code binding mismatch: "+field,()=>{
  const h=fixture();h.request[field]=f.hex64("9");let calls=0;
  const r=harness.runEpochHarnessModel(h.request,deps(h,{loadScenario:()=>{++calls;return proof("trigger-fork-inert-scenario/v1","valid");}}));
  same(r,h);assert.notEqual(r.status,"MODEL_PASS");assert.equal(calls,0);
});
for(const source of ["{",JSON.stringify({schema:"profit-trigger-watch/v1",producers:[]})]) test("unprovable/invalid normalized source keeps validated envelope",()=>{
  const h=fixture();h.request.eventText=source;const r=harness.runEpochHarnessModel(h.request,deps(h));same(r,h);assert.equal(r.blocker,"MODEL_SOURCE_INVALID");
});
for(const stage of ["loadScenario","qualify","start","runScenario","cleanup","writeResult"]) test("early/scenario/cleanup/write thrown failure retains context: "+stage,()=>{
  const h=fixture();const r=harness.runEpochHarnessModel(h.request,deps(h,{[stage]:()=>{throw new Error("private endpoint-like text not to echo");}}));
  same(r,h);assert.notEqual(r.status,"MODEL_PASS");assert.ok(!JSON.stringify(r).includes("endpoint-like"));
});
for(const stage of ["loadScenario","qualify","start","runScenario","cleanup","writeResult"]) test("Promise is not synchronous model evidence: "+stage,()=>{
  const h=fixture();const r=harness.runEpochHarnessModel(h.request,deps(h,{[stage]:()=>Promise.resolve({ok:true})}));same(r,h);assert.notEqual(r.status,"MODEL_PASS");
});
for(const cleanup of [undefined,false,{},Promise.resolve({teardownVerified:true})]) test("cleanup requires explicit synchronous disposition",()=>{
  const h=fixture();const r=harness.runEpochHarnessModel(h.request,deps(h,{cleanup:()=>cleanup}));same(r,h);assert.equal(r.status,"MODEL_UNCERTAIN");assert.equal(r.teardownVerified,false);
});
test("fresh sampler prevents work after qualification exhausts work budget",()=>{
  const h=fixture();let starts=0;
  const r=harness.runEpochHarnessModel(h.request,deps(h,{qualify:()=>{h.advance(210000);return proof("trigger-fork-inert-qualification/v1","pinsVerified");},start:()=>{++starts;return proof("trigger-fork-inert-start/v1","contained");}}));
  same(r,h);assert.equal(starts,0);assert.notEqual(r.status,"MODEL_PASS");
});
test("freshness/canonical qualification assertions stale before scenario",()=>{
  const h=fixture();h.advance(610000);let calls=0;
  const r=harness.runEpochHarnessModel(h.request,deps(h,{runScenario:()=>{++calls;return proof("trigger-fork-inert-assertion/v1","passed");}}));same(r,h);assert.equal(calls,0);
});
test("malformed/substituted child full context refused by bridge",()=>{
  const h=fixture(),other=fixture();const v=JSON.parse(other.request.contextText);v.passId="PASS-other";other.request.contextText=JSON.stringify(v);
  const fake=exec.result(exec.envelope(other.request),"MODEL_PASS",null,true);
  for(const child of [{status:"MODEL_PASS"},fake,Promise.resolve(fake)]){
    const r=bridge.runEpochBridgeModel(h.request,{clock:h.clock,runHarness:()=>child,writeResult:write});same(r,h);assert.equal(r.blocker,"MODEL_CHILD_RESULT_INVALID");
  }
});
test("bridge write failure retains exact child context and cleanup",()=>{
  const h=fixture(),r=bridge.runEpochBridgeModel(h.request,{clock:h.clock,runHarness:req=>harness.runEpochHarnessModel(req,deps(h)),writeResult:()=>{throw new Error("private");}});
  same(r,h);assert.equal(r.blocker,"MODEL_WRITE_FAILED");assert.equal(r.teardownVerified,true);assert.notEqual(r.status,"MODEL_PASS");
});
test("all real async EPOCH_OWNER paths refuse before source/scenario/endpoint work",async()=>{
  const h=fixture();let calls=0;const unsafe=new Proxy({}, {ownKeys(){++calls;throw new Error("deps touched");}});
  const a=await bridge.runBridge({...h.request,run:true},unsafe);const b=await harness.runForkPoc({...h.request,callerClass:"EPOCH_OWNER",run:true},unsafe);
  same(a,h);same(b,h);assert.equal(a.blocker,"PLATFORM_RUNTIME_UNIMPLEMENTED");assert.equal(b.blocker,"PLATFORM_RUNTIME_UNIMPLEMENTED");assert.equal(calls,0);
});
test("invalid context is UNVALIDATED/null; no raw echo or model work",()=>{
  const h=fixture();h.request.contextText=JSON.stringify({schema:"secret-bearing",credential:"private-value"});let calls=0;
  const r=harness.runEpochHarnessModel(h.request,deps(h,{loadScenario:()=>{++calls;}}));assert.equal(r.callerClass,"UNVALIDATED");assert.equal(r.eventContext,null);assert.equal(calls,0);assert.ok(!JSON.stringify(r).includes("private-value"));
});
test("MANUAL without normalized event uses null context, never fakes reservation",async()=>{
  const r=await bridge.runBridge({}, {readArtifact:()=>{throw new Error("read");},now:()=>f.NOW_BASE});
  assert.equal(r.callerClass,"MANUAL");assert.equal(r.eventContext,null);assert.equal(r.deadlines,null);
  const h=fixture();const manual=ctx.buildEventContext({callerClass:"MANUAL",eventText:h.request.eventText,epochId:null,ownerInstanceId:null,reservationSeq:null,passId:"PASS-manual"});
  h.request.contextText=JSON.stringify(manual.context);const m=harness.runEpochHarnessModel(h.request,deps(h));assert.notEqual(m.status,"MODEL_PASS");assert.equal(m.callerClass,"MANUAL");
});
test("old APPLY is held before dependency read, clocks, lock or mutation",async()=>{
  const traps=new Proxy({}, {ownKeys(){throw new Error("dependency touched");}});
  const r=await auto.runAutopilot({apply:true},traps);assert.equal(r.executed,0);assert.equal(r.status.blocker,"EPOCH_OWNER_REQUIRED");assert.equal(r.status.platformBlocker,"PLATFORM_RUNTIME_UNIMPLEMENTED");
});
test("manual async setup throw/write failure survives as structured MANUAL diagnostic",async()=>{
  const r=await harness.runForkPoc({chain:"1",block:"123",scenario:"synthetic",outPath:"unused"},{loadScenario:()=>{throw new Error("private");},now:()=>f.NOW_BASE,writeEvidence:()=>{throw new Error("writer");}});
  assert.equal(r.status,"FAIL_CLOSED");assert.equal(r.callerClass,"MANUAL");assert.equal(r.eventContext,null);assert.equal(r.output.callerClass,"MANUAL");assert.ok(!JSON.stringify(r).includes("private"));
});
test("explicit EPOCH_OWNER cannot be downgraded by a MANUAL context",async()=>{
  const h=fixture(),manual=ctx.buildEventContext({callerClass:"MANUAL",eventText:h.request.eventText,epochId:null,ownerInstanceId:null,reservationSeq:null,passId:"PASS-manual"});
  let calls=0;const r=await harness.runForkPoc({callerClass:"EPOCH_OWNER",contextText:JSON.stringify(manual.context),deadlinesText:h.request.deadlinesText},{loadScenario:()=>{++calls;},now:()=>{++calls;return f.NOW_BASE;}});
  assert.equal(r.status,"FAIL_CLOSED");assert.equal(r.eventContext,null);assert.equal(r.callerClass,"UNVALIDATED");assert.equal(calls,0);
});
test("bridge response/persistence time cannot turn late result into MODEL_PASS",()=>{
  for(const stage of ["child","writer"]){const h=fixture();const child=exec.result(h.env,"MODEL_PASS",null,true);
    const r=bridge.runEpochBridgeModel(h.request,{clock:h.clock,runHarness:()=>{if(stage==="child")h.advance(210000);return child;},writeResult:()=>{if(stage==="writer")h.advance(210000);return write();}});
    same(r,h);assert.notEqual(r.status,"MODEL_PASS");assert.equal(r.teardownVerified,true);
  }
});
test("immutable normalized request is detached from caller mutation during setup",()=>{
  const h=fixture();const r=harness.runEpochHarnessModel(h.request,deps(h,{loadScenario:e=>{h.request.eventText="{bad";return loaded(e);}}));same(r,h);assert.equal(r.status,"MODEL_PASS");
});
test("getter-bearing child context is rejected before getter invocation/persistence",()=>{
  const h=fixture();let reads=0,writes=0;const contextObject=JSON.parse(h.request.contextText);Object.defineProperty(contextObject,"sourceDigest",{enumerable:true,get(){++reads;return f.hex64("f");}});
  const child={...exec.result(h.env,"MODEL_PASS",null,true),eventContext:contextObject};
  const r=bridge.runEpochBridgeModel(h.request,{clock:h.clock,runHarness:()=>child,writeResult:()=>{++writes;return write();}});same(r,h);assert.equal(r.blocker,"MODEL_CHILD_RESULT_INVALID");assert.equal(reads,0);assert.equal(writes,0);
});
for(const field of ["adapterDigest","scenarioDigest","scenarioId","semanticEventId"]) test("loaded model scenario is bound before work: "+field,()=>{
  const h=fixture();let scenarios=0;
  const r=harness.runEpochHarnessModel(h.request,deps(h,{loadScenario:e=>({...loaded(e),[field]:field==="scenarioId"?"SC-other":f.hex64("9")}),runScenario:e=>{++scenarios;return asserted(e);}}));
  same(r,h);assert.equal(r.blocker,"MODEL_SCENARIO_INVALID");assert.equal(scenarios,0);
});
test("scenario result must restate executed semantic event and scenario binding",()=>{
  const h=fixture();const r=harness.runEpochHarnessModel(h.request,deps(h,{runScenario:e=>({...asserted(e),semanticEventId:f.hex64("9")})}));
  same(r,h);assert.equal(r.blocker,"MODEL_ASSERTION_FAILED");assert.notEqual(r.status,"MODEL_PASS");
});
for(const field of exec.DEADLINE_KEYS)test("absolute deadline propagated and enforced: "+field,()=>{
  const h=fixture(),d=JSON.parse(h.request.deadlinesText);d[field]=-1;h.request.deadlinesText=JSON.stringify(d);let calls=0;
  const r=harness.runEpochHarnessModel(h.request,deps(h,{loadScenario:e=>{++calls;return loaded(e);}}));
  assert.equal(r.status,"FAIL_CLOSED");assert.equal(r.blocker,"EXECUTION_ENVELOPE_INVALID");assert.equal(calls,0);
  assert.deepEqual(r.eventContext,h.env.eventContext);
});
test("missing injected dependencies never fall back to real scenario/child/network operations",()=>{
  const h=fixture(),r=harness.runEpochHarnessModel(h.request,{});same(r,h);assert.notEqual(r.status,"MODEL_PASS");assert.equal(r.teardownVerified,false);
});
test("cleanup can exhaust absolute deadline; result preserves full envelope as uncertain",()=>{
  const h=fixture(),r=harness.runEpochHarnessModel(h.request,deps(h,{cleanup:()=>{h.advance(220000);return proof("trigger-fork-inert-teardown/v1","teardownVerified");}}));same(r,h);assert.equal(r.teardownVerified,false);assert.equal(r.status,"MODEL_UNCERTAIN");
});
for(const failure of [false,true,"cleanup","promise","result-write","source","expired-shutdown","clock-shutdown"]) test("real temp owner RESERVED -> existing model bridge/harness -> one consumed RESULT, failure="+failure,()=>{
  const dir=fs.mkdtempSync(path.join(process.env.LOCALAPPDATA,"Temp","opencode","phase-b-owner-"));dirs.push(dir);
  const p=platform.createTestPlatformAdapter();adapters.push(p);const file=path.join(dir,"journal.jsonl");let u=f.NOW_BASE,m=3e9;
  const clock={sample:()=>({nowUtcMs:u,monotonicNowMs:m})};
  const made=owner.createEpochOwner({platformAdapter:p,journalPath:file,processIdentity:f.PROCESS_IDENTITY,inheritedRecordsText:"[]",clockSampler:owner.createTestClockSampler(clock.sample)});assert.equal(made.ok,true);
  const o=made.owner,manifestText=JSON.stringify(f.manifestFixture({ownerProposalDigest:made.proposalDigest})),eventText=f.quoteEventText({proposalDigest:made.proposalDigest});
  assert.equal(o.sealEpochManifest(manifestText).ok,true);assert.equal(o.prepareEpoch().ok,true);const ch=o.newChallenge();assert.equal(o.presentApproval({approvalRecord:f.approvalForChallenge(ch.challenge,u),interaction:"TEST_LOCAL_ATTENDED"}).ok,true);
  let model;
  o.registerInertRunner(owner.createInertTestRunner({dispatch:work=>{
    const records=journal.openForensicJournal({platform:p,path:file,epochId:f.EPOCH_ID,ownerInstanceId:made.ownerInstanceId});assert.equal(records.ok,true);assert.equal(records.records.at(-1).kind,"RESERVED");
    const request={contextText:JSON.stringify(work.context),deadlinesText:JSON.stringify(work.deadlines),eventText,manifestText,consumedText:"[]",inheritedText:"[]",expectedSourceDigest:f.hex64("f"),adapterDigest:f.hex64("b"),scenarioDigest:f.hex64("c")};
    const h={clock,advance:n=>{u+=n;m+=n;}};
    const overrides=failure===true?{runScenario:()=>{throw new Error("synthetic failure");}}:failure==="cleanup"?{cleanup:()=>undefined}:failure==="promise"?{runScenario:()=>Promise.resolve({passed:true})}:{};
    let active=false,shutdowns=0,broken=false;
    if(["expired-shutdown","clock-shutdown"].includes(failure)){
      overrides.clock={sample:()=>broken?{nowUtcMs:f.NOW_BASE-1,monotonicNowMs:3e9-1}:clock.sample()};
      overrides.start=()=>{active=true;return proof("trigger-fork-inert-start/v1","contained");};
      overrides.runScenario=e=>{if(failure==="expired-shutdown")h.advance(220000);else broken=true;return asserted(e);};
      overrides.cleanup=()=>{++shutdowns;active=false;return proof("trigger-fork-inert-teardown/v1","teardownVerified");};
    }
    if(failure==="source")request.eventText="{bad";
    model=auto.runEpochAutopilotModel(request,{clock,runHarness:req=>harness.runEpochHarnessModel(req,deps(h,overrides)),writeResult:write});
    if(["expired-shutdown","clock-shutdown"].includes(failure)){assert.equal(active,false);assert.equal(shutdowns,1);assert.equal(model.teardownVerified,false);assert.equal(model.status,"MODEL_UNCERTAIN");}
    assert.equal(exec.validResult(model,exec.envelope(request)),true);assert.deepEqual(model.eventContext,work.context);assert.deepEqual(model.deadlines,work.deadlines);
    if(failure==="result-write")p.injectFault("fsync",{fail:"TEST_RESULT_FLUSH_FAILED"});
    return {schema:owner.DISPOSITION_SCHEMA,teardownVerified:model.teardownVerified};
  },cancel:()=>({schema:owner.DISPOSITION_SCHEMA,teardownVerified:true})}));
  const a=o.admitEvent({eventText,expectedSourceDigest:f.hex64("f")});
  if(model.teardownVerified){assert.equal(a.ok,true);const recorded=o.recordResult({reservationSeq:a.reservationSeq,outcome:model.status==="MODEL_PASS"?"SUCCESS":model.status==="MODEL_UNCERTAIN"?"UNCERTAIN_HELD":"FAILED"});assert.equal(recorded.ok,failure!=="result-write"&&model.status!=="MODEL_UNCERTAIN");}
  else{assert.equal(a.ok,false);assert.equal(a.held,true);assert.equal(o.snapshot().state,"HELD");}
  if(failure==="result-write")assert.equal(o.snapshot().state,"HELD");
  u+=240000;m+=240000;assert.equal(o.admitEvent({eventText,expectedSourceDigest:f.hex64("f")}).ok,false);
  const records=journal.openForensicJournal({platform:p,path:file,epochId:f.EPOCH_ID,ownerInstanceId:made.ownerInstanceId});assert.equal(records.records.filter(r=>r.kind==="RESULT").length,1);
  assert.deepEqual(JSON.parse(records.records.at(-1).payload.contextText),model.eventContext);assert.equal(o.snapshot().deniedCount,1);
});
