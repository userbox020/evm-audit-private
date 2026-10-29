"use strict";
const assert=require("node:assert/strict"), test=require("node:test"), fs=require("node:fs"), path=require("node:path");
const f=require("./fixtures/trigger-fork-epoch-fixtures.js"), j=f.journalModule, p=f.platformModule;
const root=path.join(process.env.LOCALAPPDATA,"Temp","opencode");
const dirs=[], adapters=[];
test.after(()=>{ for(const a of adapters) a.releaseTestHandles(); for(const d of dirs) fs.rmSync(d,{recursive:true,force:true}); });
function harness(quota={maxRecords:j.JOURNAL_MAX_RECORDS,maxBytes:j.JOURNAL_MAX_BYTES},manifestPatch) {
  const dir=fs.mkdtempSync(path.join(root,"gate-a-journal-"));dirs.push(dir);
  const platform=p.createTestPlatformAdapter();adapters.push(platform);
  const file=path.join(dir,"journal.jsonl"), bind={epochId:f.EPOCH_ID,ownerInstanceId:"OPI-journal"};
  const made=j.createBoundJournal({platform,path:file,...bind,capacityQuota:quota}); assert.equal(made.ok,true);
  const journal=made.journal, base=journal.reserveBase(0); assert.equal(base.ok,true);
  const manifestHandle=f.epochCore.parseEpochManifest(JSON.stringify(f.manifestFixture({patch:manifestPatch})));
  const open=journal.appendRecord("EPOCH_OPEN",JSON.stringify({manifestDigest:manifestHandle.digest,epochLifetimeMs:Date.parse(manifestHandle.manifest.expiresAt)-Date.parse(manifestHandle.manifest.createdAt)}),f.iso(0),base.token);assert.equal(open.ok,true);
  return {journal,platform,file,base,bind,manifestHandle};
}
function event(h, amount="100000000",patch) {
  const lease=h.journal.reserveLifecycle(); assert.equal(lease.ok,true);
  const eventText=JSON.stringify(f.quoteEventFixture(e=>{e.target.candidate.amountInRaw=amount;if(patch)patch(e);}));
  const c=f.contextModule.buildEventContext({callerClass:"EPOCH_OWNER",eventText,epochId:f.EPOCH_ID,ownerInstanceId:h.bind.ownerInstanceId,reservationSeq:String(h.journal.snapshot().seq+1),passId:"PASS-journal"});assert.equal(c.status,"VALID");
  const payload=JSON.stringify({context:JSON.stringify(c.context)});
  return {lease,context:c.context,payload,eventText};
}
function reserve(h,e) {const r=h.journal.appendRecord("RESERVED",e.payload,f.iso(1000),e.lease.token);assert.equal(r.ok,true);return r;}
function result(h,e) {return h.journal.appendRecord("RESULT",JSON.stringify({contextText:JSON.stringify(e.context),reservationSeq:e.context.reservationSeq,outcome:"SUCCESS"}),f.iso(2000),e.lease.token);}
function forensic(h) {return j.openForensicJournal({platform:h.platform,path:h.file,...h.bind});}
for(const outcome of ["SUCCESS","FAILED","REJECTED","UNCERTAIN_HELD"])test("GateC final actual recorded plain "+outcome+" proposal cannot be substituted by later policy",()=>{
  // Structural TEST journal only, not permission for a held owner to resume.
  const h=harness(),a=event(h);reserve(h,a);
  assert.equal(h.journal.appendRecord("RESULT",JSON.stringify({contextText:JSON.stringify(a.context),reservationSeq:a.context.reservationSeq,outcome}),f.iso(2000),a.lease.token).ok,true);
  const b=event(h,"200000000");reserve(h,b);const p=modelResult(h,b);
  assert.equal(h.journal.appendRecord("PROMOTION_QUEUED",JSON.stringify(p),f.iso(3000),b.lease.token).ok,true);
  const matching=forensic(h);assert.equal(matching.ok,true);assert.equal(matching.importCandidates.length,1);
  const original=fs.readFileSync(h.file);
  rewrite(h,rows=>{
    for(const row of rows){if(row.kind==="RESERVED"&&row.seq===a.context.reservationSeq){const c=JSON.parse(row.payload.context);c.ownerProposalDigest=f.hex64("9");row.payload.context=JSON.stringify(c);}
      if(row.kind==="RESULT"&&row.payload.reservationSeq===a.context.reservationSeq){const c=JSON.parse(row.payload.contextText);c.ownerProposalDigest=f.hex64("9");row.payload.contextText=JSON.stringify(c);}}
  });
  const conflicting=forensic(h);assert.equal(conflicting.ok,false);assert.equal(Object.hasOwn(conflicting,"importCandidates"),false);
  fs.writeFileSync(h.file,original);assert.equal(forensic(h).ok,true);
});
test("GateC final plain-only history remains explicitly structural without sealed policy",()=>{
  const h=harness(),a=event(h);reserve(h,a);assert.equal(result(h,a).ok,true);
  rewrite(h,rows=>{for(const r of rows){if(r.kind==="RESERVED"){const c=JSON.parse(r.payload.context);c.ownerProposalDigest=f.hex64("9");r.payload.context=JSON.stringify(c);}if(r.kind==="RESULT"){const c=JSON.parse(r.payload.contextText);c.ownerProposalDigest=f.hex64("9");r.payload.contextText=JSON.stringify(c);}}});
  const read=forensic(h);assert.equal(read.ok,true);assert.equal(read.policyEvidence,"PLAIN_STRUCTURAL_ONLY_NO_SEALED_POLICY");assert.equal(read.authority,"FORENSIC_CONSISTENCY_ONLY");assert.equal(read.recoveryBlocker,"PLATFORM_RUNTIME_UNIMPLEMENTED");assert.deepEqual(read.importCandidates,[]);
});
test("GateC final known sealed policy rejects subsequent conflicting reservation without mutation",()=>{
  const h=harness(),a=event(h);reserve(h,a);const p=modelResult(h,a);assert.equal(h.journal.appendRecord("PROMOTION_QUEUED",JSON.stringify(p),f.iso(3000),a.lease.token).ok,true);
  assert.equal(forensic(h).policyEvidence,"SEALED_MODEL_POLICY_BINDINGS_CHECKED");const before=fs.readFileSync(h.file),b=event(h,"200000000",e=>{e.ownerProposalDigest=f.hex64("9");});
  assert.equal(h.journal.appendRecord("RESERVED",b.payload,f.iso(4000),b.lease.token).code,"JOURNAL_RECORDED_POLICY_CONFLICT");assert.deepEqual(fs.readFileSync(h.file),before);assert.equal(forensic(h).importCandidates.length,1);
});
function modelResult(h,e){
  const b=require("../lib/trigger-fork-epoch-outbox.js"),x=require("../lib/trigger-fork-epoch-execution.js"),now=f.NOW_BASE+2000;
  const deadlines={workUtcMs:f.NOW_BASE+210000,workMonotonicMs:f.MONO_BASE+210000,cleanupUtcMs:f.NOW_BASE+220000,cleanupMonotonicMs:f.MONO_BASE+220000,epochUtcMs:f.NOW_BASE+600000,epochMonotonicMs:f.MONO_BASE+600000};
  const env=x.envelope({contextText:JSON.stringify(e.context),deadlinesText:JSON.stringify(deadlines)}),pass=x.result(env,"MODEL_PASS",null,true),pair=(usd="1.000000",native="0.001000")=>({usd,native});
  const bundle={schema:b.COMPLETION_SCHEMA,evidenceClass:b.EVIDENCE_CLASS,eventText:e.eventText,reservationContext:e.context,reservationDeadlines:deadlines,bridge:pass,child:pass,status:pass,completedAtUtcMs:now,
    qualification:{schema:"trigger-fork-model-qualification/v1",evidenceClass:b.EVIDENCE_CLASS,candidateId:e.context.semanticEventId,chainId:8453,nativeAsset:"ETH",observedAtUtcMs:now,...Object.fromEntries(b.CRITERIA.map(k=>[k,true]))},
    economics:{schema:"trigger-fork-model-economics/v1",evidenceClass:b.EVIDENCE_CLASS,candidateId:e.context.semanticEventId,chainId:8453,nativeAsset:"ETH",observedAtUtcMs:now,revenue:pair("30.000000","0.030000"),capital:pair("10.000000","0.010000"),costs:Object.fromEntries(b.COSTS.map(k=>[k,pair()])),capacityUsd:"100.000000",capacityNative:"1.000000",exitCapacityUsd:"100.000000",exitCapacityNative:"1.000000",fundingAvailableUsd:"100.000000",fundingAvailableNative:"1.000000",capitalZeroRationale:null}};
  const policy={manifest:h.manifestHandle.manifest,manifestDigest:h.manifestHandle.digest},validationHistory={inheritedRecords:[],priorConsumed:h.journal.forensicRecords().filter(r=>r.kind==="RESULT").map(r=>{const c=JSON.parse(r.payload.contextText);return {schema:f.epochCore.CONSUMED_SCHEMA,identitySchemaVersion:c.identitySchemaVersion,semanticEventId:c.semanticEventId,outcome:["HELD","UNCERTAIN_HELD"].includes(r.payload.outcome)?"UNCERTAIN":r.payload.outcome,provenance:{source:"CURRENT_EPOCH",epochId:r.epochId,ownerProposalDigest:c.ownerProposalDigest}};})};
  const v=b.validateBundle(JSON.stringify(bundle),{eventText:e.eventText,context:e.context,deadlines,policy,validationHistory},now);assert.equal(v.ok,true);
  const saved=h.journal.appendRecord("RESULT",JSON.stringify({contextText:JSON.stringify(e.context),reservationSeq:e.context.reservationSeq,outcome:"SUCCESS",modelCompletion:v.completion}),f.iso(2000),e.lease.token);assert.equal(saved.ok,true);return {reservationSeq:e.context.reservationSeq,promotionId:v.completion.promotionId,resultDigest:v.completion.resultDigest};
}
test("C event-bound retained five slots reject swaps before I/O and permit legitimate lifecycle",()=>{
  const h=harness(),a=event(h);reserve(h,a);const pa=modelResult(h,a),b=event(h,"200000000");reserve(h,b);const pb=modelResult(h,b),before=fs.readFileSync(h.file);
  assert.equal(h.journal.appendRecord("PROMOTION_QUEUED",JSON.stringify(pa),f.iso(3000),b.lease.token).code,"JOURNAL_LEASE_EVENT_MISMATCH");assert.deepEqual(fs.readFileSync(h.file),before);
  assert.equal(h.journal.appendRecord("PROMOTION_QUEUED",JSON.stringify(pa),f.iso(3000),a.lease.token).ok,true);
  for(const kind of ["DELIVERY_ATTEMPT","DELIVERY_ACK"]){const p={...pa,attempt:1,...(kind==="DELIVERY_ACK"?{ack:{schema:"trigger-fork-model-delivery-ack/v1",evidenceClass:require("../lib/trigger-fork-epoch-outbox.js").EVIDENCE_CLASS,promotionId:pa.promotionId,resultDigest:pa.resultDigest,delivered:true}}:{})};assert.equal(h.journal.appendRecord(kind,JSON.stringify(p),f.iso(4000),b.lease.token).code,"JOURNAL_LEASE_EVENT_MISMATCH");assert.equal(h.journal.appendRecord(kind,JSON.stringify(p),f.iso(4000),a.lease.token).ok,true);}
  assert.equal(h.journal.appendRecord("PROMOTION_QUEUED",JSON.stringify(pb),f.iso(5000),b.lease.token).ok,true);assert.equal(forensic(h).importCandidates.length,2);
  assert.equal(h.journal.appendRecord("DELIVERY_ATTEMPT",JSON.stringify({...pa,attempt:2}),f.iso(34000),a.lease.token).ok,false);
});
test("C strict outbox reader/append refuses ACK without attempt, nonsequential/replayed IDs and changed evidence",()=>{
  const h=harness(),e=event(h);reserve(h,e);const p=modelResult(h,e);assert.equal(h.journal.appendRecord("PROMOTION_QUEUED",JSON.stringify(p),f.iso(3000),e.lease.token).ok,true);
  const ack={schema:"trigger-fork-model-delivery-ack/v1",evidenceClass:require("../lib/trigger-fork-epoch-outbox.js").EVIDENCE_CLASS,promotionId:p.promotionId,resultDigest:p.resultDigest,delivered:true};
  assert.equal(h.journal.appendRecord("DELIVERY_ACK",JSON.stringify({...p,attempt:1,ack}),f.iso(4000),e.lease.token).ok,false);
  assert.equal(h.journal.appendRecord("DELIVERY_ATTEMPT",JSON.stringify({...p,attempt:2}),f.iso(4000),e.lease.token).ok,false);
  assert.equal(h.journal.appendRecord("DELIVERY_ATTEMPT",JSON.stringify({...p,attempt:1,resultDigest:f.hex64("9")}),f.iso(4000),e.lease.token).code,"JOURNAL_LEASE_EVENT_MISMATCH");
  assert.equal(h.journal.appendRecord("DELIVERY_ATTEMPT",JSON.stringify({...p,attempt:1}),f.iso(4000),e.lease.token).ok,true);
  assert.equal(h.journal.appendRecord("DELIVERY_ATTEMPT",JSON.stringify({...p,attempt:2}),f.iso(5000),e.lease.token).ok,false);
  assert.equal(h.journal.appendRecord("DELIVERY_ATTEMPT",JSON.stringify({...p,attempt:2}),f.iso(34000),e.lease.token).ok,true);
  assert.equal(h.journal.appendRecord("DELIVERY_ATTEMPT",JSON.stringify({...p,attempt:3}),f.iso(64000),e.lease.token).ok,true);
  assert.equal(h.journal.appendRecord("DELIVERY_ATTEMPT",JSON.stringify({...p,attempt:4}),f.iso(94000),e.lease.token).ok,false);
  assert.equal(h.journal.appendRecord("DELIVERY_ACK",JSON.stringify({...p,attempt:2,ack}),f.iso(65000),e.lease.token).ok,false);
  assert.equal(h.journal.appendRecord("DELIVERY_ACK",JSON.stringify({...p,attempt:3,ack}),f.iso(65000),e.lease.token).ok,true);
  const records=forensic(h).records;assert.throws(()=>{records[2].payload.modelCompletion.record.economics.costs.gas.usd="0.000000";});
  // Detached forensic data are immutable; mutation above cannot alter bytes.
  assert.equal(h.journal.verifyBinding().ok,true);
});
test("C worst-case seven-slot lifecycle remains reserved after ACK, terminal budget preserved",()=>{
  const h=harness({maxRecords:10,maxBytes:10*j.JOURNAL_MAX_RECORD_BYTES}),e=event(h);reserve(h,e);const p=modelResult(h,e),label=require("../lib/trigger-fork-epoch-outbox.js").EVIDENCE_CLASS;
  assert.equal(h.journal.appendRecord("PROMOTION_QUEUED",JSON.stringify(p),f.iso(3000),e.lease.token).ok,true);
  assert.equal(h.journal.appendRecord("DELIVERY_ATTEMPT",JSON.stringify({...p,attempt:1}),f.iso(4000),e.lease.token).ok,true);
  assert.equal(h.journal.appendRecord("DELIVERY_ACK",JSON.stringify({...p,attempt:1,ack:{schema:"trigger-fork-model-delivery-ack/v1",evidenceClass:label,promotionId:p.promotionId,resultDigest:p.resultDigest,delivered:true}}),f.iso(4001),e.lease.token).ok,true);
  assert.equal(h.journal.snapshot().reservedSlots,10);assert.equal(h.journal.reserveLifecycle().code,"JOURNAL_CAPACITY_EXCEEDED");
  assert.equal(h.journal.appendRecord("EPOCH_CLOSED",JSON.stringify({reason:"OPERATOR_CLOSE"}),f.iso(5000),h.base.token).ok,true);assert.equal(forensic(h).importCandidates.length,1);
});
for(const stage of ["ATTEMPT","ACK"])test("GateC historical "+stage+" rechecks 120s evidence age at record time",()=>{
  const h=harness(),e=event(h);reserve(h,e);const p=modelResult(h,e);assert.equal(h.journal.appendRecord("PROMOTION_QUEUED",JSON.stringify(p),f.iso(3000),e.lease.token).ok,true);
  if(stage==="ATTEMPT")assert.equal(h.journal.appendRecord("DELIVERY_ATTEMPT",JSON.stringify({...p,attempt:1}),f.iso(125000),e.lease.token).ok,false);
  else{assert.equal(h.journal.appendRecord("DELIVERY_ATTEMPT",JSON.stringify({...p,attempt:1}),f.iso(120000),e.lease.token).ok,true);const ack={schema:"trigger-fork-model-delivery-ack/v1",evidenceClass:require("../lib/trigger-fork-epoch-outbox.js").EVIDENCE_CLASS,promotionId:p.promotionId,resultDigest:p.resultDigest,delivered:true};assert.equal(h.journal.appendRecord("DELIVERY_ACK",JSON.stringify({...p,attempt:1,ack}),f.iso(125001),e.lease.token).ok,false);}
});
for(const policy of ["source","promotion"])for(const stage of ["RESULT","QUEUED","ATTEMPT","ACK"])test("GateC historical sealed "+policy+" limit applies to "+stage,()=>{
  const h=harness(undefined,m=>{if(policy==="source")m.bounds.sourceMaxAgeMs=6000;else m.bounds.promotionMaxAgeMs=1000;}),e=event(h,"100000000",e=>{e.source.observedAt=f.iso(-3000);});reserve(h,e);const p=modelResult(h,e);
  if(stage==="RESULT"){
    rewrite(h,rows=>{rows[2].timestampUtc=f.iso(3001);});assert.equal(forensic(h).ok,false);return;
  }
  if(stage==="QUEUED"){assert.equal(h.journal.appendRecord("PROMOTION_QUEUED",JSON.stringify(p),f.iso(3001),e.lease.token).ok,false);return;}
  assert.equal(h.journal.appendRecord("PROMOTION_QUEUED",JSON.stringify(p),f.iso(3000),e.lease.token).ok,true);
  if(stage==="ATTEMPT"){assert.equal(h.journal.appendRecord("DELIVERY_ATTEMPT",JSON.stringify({...p,attempt:1}),f.iso(3001),e.lease.token).ok,false);return;}
  assert.equal(h.journal.appendRecord("DELIVERY_ATTEMPT",JSON.stringify({...p,attempt:1}),f.iso(3000),e.lease.token).ok,true);
  const ack={schema:"trigger-fork-model-delivery-ack/v1",evidenceClass:require("../lib/trigger-fork-epoch-outbox.js").EVIDENCE_CLASS,promotionId:p.promotionId,resultDigest:p.resultDigest,delivered:true};
  assert.equal(h.journal.appendRecord("DELIVERY_ACK",JSON.stringify({...p,attempt:1,ack}),f.iso(3001),e.lease.token).ok,false);
});
test("GateC normalized policy binds opening digest, historical reader ignores current age",()=>{
  const h=harness(),e=event(h);reserve(h,e);const p=modelResult(h,e);h.journal.appendRecord("PROMOTION_QUEUED",JSON.stringify(p),f.iso(3000),e.lease.token);
  assert.equal(forensic(h).ok,true);const before=fs.readFileSync(h.file);rewrite(h,rows=>{rows[0].payload.manifestDigest=f.hex64("9");});assert.equal(forensic(h).ok,false);fs.writeFileSync(h.file,before);assert.equal(forensic(h).ok,true);
});
test("C forensic evidence mutation with recomputed chain still fails qualification correspondence",()=>{
  const h=harness(),e=event(h);reserve(h,e);const p=modelResult(h,e);assert.equal(h.journal.appendRecord("PROMOTION_QUEUED",JSON.stringify(p),f.iso(3000),e.lease.token).ok,true);
  const original=fs.readFileSync(h.file);for(const mutation of ["criterion","digest","candidate","net","outcome"]){
    const records=JSON.parse(JSON.stringify(forensic(h).records));
    if(mutation==="criterion")records[2].payload.modelCompletion.record.qualification.exactPins=false;
    if(mutation==="digest")records[3].payload.resultDigest=f.hex64("9");
    if(mutation==="candidate")records[2].payload.modelCompletion.record.economics.candidateId=f.hex64("9");
    if(mutation==="net")records[2].payload.modelCompletion.record.derivedNet.usd="100.000000";
    if(mutation==="outcome")records[2].payload.outcome="UNCERTAIN_HELD";
    let prev=j.ZERO_DIGEST;for(const r of records){r.prevDigest=prev;const {digest,...base}=r;r.digest=f.canonicalHex(base);prev=r.digest;}
    fs.writeFileSync(h.file,records.map(r=>JSON.stringify(r)).join("\n")+"\n");assert.equal(forensic(h).ok,false);fs.writeFileSync(h.file,original);
  }
});
test("journal: complete byte chain, detached snapshots and terminal lease",()=>{
  const h=harness(),e=event(h);reserve(h,e);assert.equal(result(h,e).ok,true);
  const inspected=h.journal.forensicRecords();assert.ok(Object.isFrozen(inspected[1].payload));
  assert.equal(h.journal.verifyBinding().ok,true);
  assert.equal(h.journal.appendRecord("EPOCH_CLOSED",JSON.stringify({reason:"OPERATOR_CLOSE"}),f.iso(3000),h.base.token).ok,true);
  assert.equal(h.journal.verifyBinding().ok,true);assert.equal(h.journal.releaseLeaseIfSafe().ok,true);
  assert.deepEqual(forensic(h).records.map(r=>r.kind),["EPOCH_OPEN","RESERVED","RESULT","EPOCH_CLOSED"]);
  assert.equal(h.journal.appendRecord("EPOCH_OPEN","{}",f.iso(4000),h.base.token).ok,false);
});
test("journal: private pin authority and no resume",()=>{
  const h=harness();assert.equal(h.journal._pinInitialIdentity,undefined);assert.equal(h.journal._s,undefined);
  assert.equal(j.createBoundJournal({platform:h.platform,path:h.file,...h.bind,capacityQuota:{maxRecords:512,maxBytes:j.JOURNAL_MAX_BYTES}}).code,"JOURNAL_EXISTS");
});
for(const mutation of ["rollback","same-length","replacement","extra","partial"]) test("journal integrity latch: "+mutation,()=>{
  const h=harness(),old=fs.readFileSync(h.file),e=event(h);reserve(h,e);const committed=fs.readFileSync(h.file);
  if(mutation==="rollback") fs.writeFileSync(h.file,old);
  if(mutation==="same-length") {const b=Buffer.from(committed);b[40]^=1;fs.writeFileSync(h.file,b);}
  if(mutation==="replacement") {fs.renameSync(h.file,h.file+".old");fs.writeFileSync(h.file,committed);}
  if(mutation==="extra") fs.appendFileSync(h.file,committed.subarray(0,old.length));
  if(mutation==="partial") fs.appendFileSync(h.file,'{"schema":');
  assert.equal(h.journal.verifyBinding().ok,false);fs.writeFileSync(h.file,committed);
  assert.equal(h.journal.verifyBinding().ok,false);assert.equal(result(h,e).ok,false);
});
test("Gate A post-write altered prefix serialization is not adopted",()=>{
  const h=harness(),e=event(h);let checkpoint=false;
  h.platform.injectCheckpoint("postWrite",()=>{
    checkpoint=true;const lines=fs.readFileSync(h.file,"utf8").split("\n");
    const obj=JSON.parse(lines[0]);const changed=Object.fromEntries(Object.entries(obj).reverse());
    assert.equal(JSON.stringify(changed).length,lines[0].length);lines[0]=JSON.stringify(changed);fs.writeFileSync(h.file,lines.join("\n"));
  });
  const appended=h.journal.appendRecord("RESERVED",e.payload,f.iso(1000),e.lease.token);
  assert.equal(checkpoint,true);assert.equal(appended.ok,false);assert.equal(h.journal.snapshot().seq,1);
  assert.equal(h.journal.snapshot().held,true);
});
for(const stage of ["postWrite","postFlush"]) test("Gate A thrown uncertainty after "+stage,()=>{
  const h=harness(),e=event(h);let reached=false;
  h.platform.injectCheckpoint(stage,()=>{reached=true;throw new Error("private callback text");});
  const r=h.journal.appendRecord("RESERVED",e.payload,f.iso(1000),e.lease.token);
  assert.equal(reached,true);assert.equal(r.ok,false);assert.equal(h.journal.snapshot().held,true);
  assert.equal(h.journal.snapshot().seq,1);assert.equal(result(h,e).ok,false);
});
for(const op of ["readback","stat","statPath","fsync"]) test("Gate A fault precisely after write: "+op,()=>{
  const h=harness(),e=event(h);let reached=false;
  h.platform.injectCheckpoint("postWrite",()=>{reached=true;h.platform.injectFault(op,{fail:"TEST_IO_FAILED"});});
  assert.equal(h.journal.appendRecord("RESERVED",e.payload,f.iso(1000),e.lease.token).ok,false);
  assert.equal(reached,true);assert.equal(h.journal.snapshot().seq,1);assert.equal(h.journal.snapshot().held,true);
});
test("Gate A short write never advances and cannot retry",()=>{
  const h=harness(),e=event(h);h.platform.injectFault("write",{shortWritten:5});
  assert.equal(h.journal.appendRecord("RESERVED",e.payload,f.iso(1000),e.lease.token).ok,false);
  assert.equal(h.journal.snapshot().seq,1);assert.equal(h.journal.snapshot().held,true);
});
test("Gate A lifecycle slots and bytes reserved before RESERVED, future five retained",()=>{
  const h=harness({maxRecords:20,maxBytes:9*j.JOURNAL_MAX_RECORD_BYTES});
  // Three base records already reserved; only six worst-case slots remain.
  assert.equal(h.journal.reserveLifecycle().ok,false);
  assert.equal(h.journal.snapshot().seq,1);
  const good=harness({maxRecords:10,maxBytes:10*j.JOURNAL_MAX_RECORD_BYTES}),e=event(good);
  reserve(good,e);assert.equal(good.journal.snapshot().reservedSlots,10);
  assert.equal(good.journal.reserveLifecycle().ok,false);assert.equal(result(good,e).ok,true);
  assert.equal(good.journal.snapshot().reservedSlots,10); // no refund/eviction
  assert.equal(good.journal.snapshot().reservedBytes,10*j.JOURNAL_MAX_RECORD_BYTES);
});
test("Gate A unbudgeted append, lease reuse, and base overflow refuse",()=>{
  const h=harness(),e=event(h);assert.equal(h.journal.appendRecord("RESERVED",e.payload,f.iso(1),{}).ok,false);
  reserve(h,e);assert.equal(h.journal.appendRecord("RESERVED",e.payload,f.iso(1),e.lease.token).ok,false);
  assert.equal(j.resolveCapacityQuota({inheritedCount:128,maxConsumedIdentities:128}).ok,false);
});
test("Gate A full-context mismatch and duplicate/missing results refused",()=>{
  const h=harness(),e=event(h);reserve(h,e);
  const altered={...e.context,sourceDigest:f.hex64("9")};
  assert.equal(h.journal.appendRecord("RESULT",JSON.stringify({contextText:JSON.stringify(altered),outcome:"SUCCESS",reservationSeq:e.context.reservationSeq}),f.iso(2),e.lease.token).ok,false);
  assert.equal(result(h,e).ok,true);assert.equal(result(h,e).ok,false);
  const h2=harness(),e2=event(h2);
  assert.equal(result(h2,e2).ok,false); // no RESERVED correspondence
});
function rewrite(h,edit) {
  const lines=fs.readFileSync(h.file,"utf8").trimEnd().split("\n").map(JSON.parse);edit(lines);
  let prev=j.ZERO_DIGEST;for(let n=0;n<lines.length;n++){const r=lines[n];r.seq=String(n+1);r.prevDigest=prev;delete r.digest;r.digest=f.canonicalHex(r);prev=r.digest;}
  fs.writeFileSync(h.file,lines.map(JSON.stringify).join("\n")+"\n");
}
for(const bad of ["outer-owner","reserved-seq","manual","result-seq","missing-reservation","duplicate-open","after-close","current-inherited","unsafe-number","duplicate-key"]) test("strict forensic consistency: "+bad,()=>{
  const h=harness(),e=event(h);reserve(h,e);assert.equal(result(h,e).ok,true);
  rewrite(h,lines=>{
    if(bad==="outer-owner") lines[1].ownerInstanceId="OPI-other";
    if(bad==="reserved-seq") {const c=JSON.parse(lines[1].payload.context);c.reservationSeq="1";lines[1].payload.context=JSON.stringify(c);}
    if(bad==="manual") {const c=JSON.parse(lines[1].payload.context);c.callerClass="MANUAL";lines[1].payload.context=JSON.stringify(c);}
    if(bad==="result-seq") lines[2].payload.reservationSeq="1";
    if(bad==="missing-reservation") lines.splice(1,1);
    if(bad==="duplicate-open") lines.push(JSON.parse(JSON.stringify(lines[0])));
    if(bad==="after-close") {lines.push({...lines[0],kind:"EPOCH_CLOSED",payload:{reason:"OPERATOR_CLOSE"}});lines.push({...lines[0]});}
    if(bad==="current-inherited") lines.splice(1,0,{...lines[0],kind:"INHERITED_CONSUMED",payload:{record:{schema:f.epochCore.CONSUMED_SCHEMA,identitySchemaVersion:1,semanticEventId:f.hex64("3"),outcome:"SUCCESS",provenance:{source:"CURRENT_EPOCH",epochId:f.EPOCH_ID,ownerProposalDigest:f.hex64("a")}}}});
  });
  if(bad==="unsafe-number") fs.writeFileSync(h.file,fs.readFileSync(h.file,"utf8").replace(/"epochLifetimeMs":\d+/,'"epochLifetimeMs":9007199254740993'));
  if(bad==="duplicate-key") fs.writeFileSync(h.file,fs.readFileSync(h.file,"utf8").replace(/("epochLifetimeMs":\d+)/,'$1,$1'));
  assert.equal(forensic(h).ok,false);
});
test("Gate A release failure retains descriptor for retry; initial pin closes ownership",()=>{
  const h=harness();assert.equal(h.journal.appendRecord("EPOCH_CLOSED",JSON.stringify({reason:"OPERATOR_CLOSE"}),f.iso(2),h.base.token).ok,true);
  h.platform.injectFault("close",{fail:"TEST_CLOSE_FAILED"});assert.equal(h.journal.releaseLeaseIfSafe().ok,false);
  assert.equal(h.journal.snapshot().released,false);assert.equal(h.journal.releaseLeaseIfSafe().ok,true);
  const dir=fs.mkdtempSync(path.join(root,"gate-a-pin-"));dirs.push(dir);
  const platform=p.createTestPlatformAdapter();adapters.push(platform);platform.injectFault("stat",{fail:"TEST_PIN_FAILED"});
  const r=j.createBoundJournal({platform,path:path.join(dir,"j"),epochId:f.EPOCH_ID,ownerInstanceId:"OPI-pin",capacityQuota:{maxRecords:512,maxBytes:j.JOURNAL_MAX_BYTES}});
  assert.equal(r.ok,false);assert.equal(platform.ownedHandleCount(),0);
});

test("multiple pending lifecycles retain independent RESULT and five-slot outbox budgets",()=>{
  const h=harness({maxRecords:17,maxBytes:17*j.JOURNAL_MAX_RECORD_BYTES}),a=event(h);reserve(h,a);
  const b=event(h,"100000001");reserve(h,b);
  assert.equal(h.journal.snapshot().reservedSlots,17);
  assert.equal(h.journal.reserveLifecycle().ok,false);
  assert.equal(result(h,a).ok,true);assert.equal(result(h,b).ok,true);
  assert.equal(h.journal.snapshot().reservedSlots,17);
  assert.equal(h.journal.appendRecord("EPOCH_CLOSED",JSON.stringify({reason:"DRAINED"}),f.iso(3),h.base.token).ok,true);
});
test("serialized caller payload and returned records cannot mutate retained authority",()=>{
  const h=harness(),e=event(h),data={context:JSON.stringify(e.context)};
  const text=JSON.stringify(data);const r=h.journal.appendRecord("RESERVED",text,f.iso(1),e.lease.token);assert.equal(r.ok,true);
  data.context="changed";assert.throws(()=>{r.record.payload.context="changed";},TypeError);
  assert.equal(h.journal.verifyBinding().ok,true);assert.equal(h.journal.forensicRecords()[1].payload.context,JSON.parse(text).context);
});
test("initial pin failure with failed close retains accessible cleanup ownership",()=>{
  const dir=fs.mkdtempSync(path.join(root,"gate-a-pin-retain-"));dirs.push(dir);
  const platform=p.createTestPlatformAdapter();adapters.push(platform);
  platform.injectFault("stat",{fail:"TEST_PIN_FAILED"});platform.injectFault("close",{fail:"TEST_CLOSE_FAILED"});
  const r=j.createBoundJournal({platform,path:path.join(dir,"j"),epochId:f.EPOCH_ID,ownerInstanceId:"OPI-retain",capacityQuota:{maxRecords:512,maxBytes:j.JOURNAL_MAX_BYTES}});
  assert.equal(r.ok,false);assert.ok(r.cleanup);assert.equal(platform.ownedHandleCount(),1);
  assert.equal(r.cleanup.releaseLeaseIfSafe().ok,true);assert.equal(platform.ownedHandleCount(),0);
});
test("base reservation itself refuses insufficient worst-case bytes",()=>{
  const dir=fs.mkdtempSync(path.join(root,"gate-a-tiny-"));dirs.push(dir);
  const platform=p.createTestPlatformAdapter();adapters.push(platform);
  const r=j.createBoundJournal({platform,path:path.join(dir,"j"),epochId:f.EPOCH_ID,ownerInstanceId:"OPI-tiny",capacityQuota:{maxRecords:10,maxBytes:2*j.JOURNAL_MAX_RECORD_BYTES}});
  assert.equal(r.ok,true);assert.equal(r.journal.reserveBase(0).ok,false);assert.equal(r.journal.snapshot().seq,0);
});
test("caller quota mutation cannot increase privately retained capacity",()=>{
  const quota={maxRecords:10,maxBytes:10*j.JOURNAL_MAX_RECORD_BYTES},h=harness(quota);
  quota.maxRecords=512;quota.maxBytes=j.JOURNAL_MAX_BYTES;
  const e=event(h);reserve(h,e);assert.equal(h.journal.reserveLifecycle().ok,false);
});
test("path replaced after readback cannot advance high-water",()=>{
  const h=harness(),e=event(h);let reached=false;
  h.platform.injectCheckpoint("postWrite",()=>h.platform.injectCheckpoint("postRead",()=>{
    reached=true;const bytes=fs.readFileSync(h.file);fs.renameSync(h.file,h.file+".old");fs.writeFileSync(h.file,bytes);
  }));
  assert.equal(h.journal.appendRecord("RESERVED",e.payload,f.iso(1),e.lease.token).ok,false);
  assert.equal(reached,true);assert.equal(h.journal.snapshot().seq,1);assert.equal(h.journal.snapshot().held,true);
});
test("attempt2: A RESULT cannot spend B event lease or steal its RESULT slot",()=>{
  const h=harness(),a=event(h);reserve(h,a);const b=event(h,"100000001");reserve(h,b);
  const before=h.journal.snapshot(),bytes=fs.readFileSync(h.file);
  const swapped=h.journal.appendRecord("RESULT",JSON.stringify({contextText:JSON.stringify(a.context),reservationSeq:a.context.reservationSeq,outcome:"SUCCESS"}),f.iso(2000),b.lease.token);
  assert.equal(swapped.ok,false);assert.equal(h.journal.snapshot().held,false);
  assert.equal(h.journal.snapshot().seq,before.seq);assert.deepEqual(fs.readFileSync(h.file),bytes);
  assert.equal(result(h,a).ok,true);assert.equal(result(h,b).ok,true);
});
test("attempt2: a globally valid A RESULT cannot spend an unbound event token",()=>{
  const h=harness(),a=event(h);reserve(h,a);const pending=h.journal.reserveLifecycle();assert.equal(pending.ok,true);
  const r=h.journal.appendRecord("RESULT",JSON.stringify({contextText:JSON.stringify(a.context),reservationSeq:a.context.reservationSeq,outcome:"SUCCESS"}),f.iso(2000),pending.token);
  assert.equal(r.ok,false);assert.equal(r.code,"JOURNAL_LEASE_EVENT_MISMATCH");
  assert.equal(h.journal.snapshot().held,false);assert.equal(result(h,a).ok,true);
});
