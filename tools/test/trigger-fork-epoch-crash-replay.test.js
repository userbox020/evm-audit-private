"use strict";
// MODEL fault checkpoints only, not process/host/power-loss qualification.
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const f=require("./fixtures/trigger-fork-epoch-fixtures.js"),O=f.ownerModule,P=f.platformModule,J=f.journalModule,B=require("../lib/trigger-fork-epoch-outbox.js"),E=require("../lib/trigger-fork-epoch-execution.js"),consumer=require("../trigger-fork-epoch-promotion-consumer.js");
function setup(t){const dir=fs.mkdtempSync(path.join(process.env.LOCALAPPDATA,"Temp","opencode","phase-c-crash-")),p=P.createTestPlatformAdapter(),file=path.join(dir,"ledger.jsonl");let u=f.NOW_BASE,m=f.MONO_BASE,starts=0,work;
  t.after(()=>{p.releaseTestHandles();fs.rmSync(dir,{recursive:true,force:true});});
  const made=O.createEpochOwner({platformAdapter:p,journalPath:file,processIdentity:f.PROCESS_IDENTITY,inheritedRecordsText:"[]",clockSampler:O.createTestClockSampler(()=>({nowUtcMs:u,monotonicNowMs:m}))}),owner=made.owner;assert.equal(made.ok,true);
  const manifestText=JSON.stringify(f.manifestFixture({ownerProposalDigest:made.proposalDigest})),eventText=f.quoteEventText({proposalDigest:made.proposalDigest});
  assert.equal(owner.sealEpochManifest(manifestText).ok,true);assert.equal(owner.prepareEpoch().ok,true);const ch=owner.newChallenge();assert.equal(owner.presentApproval({approvalRecord:f.approvalForChallenge(ch.challenge,u),interaction:"TEST_LOCAL_ATTENDED"}).ok,true);
  assert.equal(owner.registerInertRunner(O.createInertTestRunner({dispatch:w=>{++starts;work=w;return {schema:O.DISPOSITION_SCHEMA,teardownVerified:true};},cancel:()=>({schema:O.DISPOSITION_SCHEMA,teardownVerified:true})})).ok,true);
  const reserve=()=>owner.admitEvent({eventText,expectedSourceDigest:f.hex64("f")});
  const complete=()=>{const env=E.envelope({contextText:JSON.stringify(work.context),deadlinesText:JSON.stringify(work.deadlines)}),pass=E.result(env,"MODEL_PASS",null,true),pair=(usd="1.000000",native="0.001000")=>({usd,native}),c=work.context;
    const bundle={schema:B.COMPLETION_SCHEMA,evidenceClass:B.EVIDENCE_CLASS,eventText,reservationContext:c,reservationDeadlines:work.deadlines,bridge:pass,child:pass,status:pass,completedAtUtcMs:u,
      qualification:{schema:"trigger-fork-model-qualification/v1",evidenceClass:B.EVIDENCE_CLASS,candidateId:c.semanticEventId,chainId:8453,nativeAsset:"ETH",observedAtUtcMs:u,...Object.fromEntries(B.CRITERIA.map(k=>[k,true]))},
      economics:{schema:"trigger-fork-model-economics/v1",evidenceClass:B.EVIDENCE_CLASS,candidateId:c.semanticEventId,chainId:8453,nativeAsset:"ETH",observedAtUtcMs:u,revenue:pair("30.000000","0.030000"),capital:pair("10.000000","0.010000"),costs:Object.fromEntries(B.COSTS.map(k=>[k,pair()])),capacityUsd:"100.000000",capacityNative:"1.000000",exitCapacityUsd:"100.000000",exitCapacityNative:"1.000000",fundingAvailableUsd:"100.000000",fundingAvailableNative:"1.000000",capitalZeroRationale:null}};
    return owner.completeModelExecution({reservationSeq:c.reservationSeq,bundleText:JSON.stringify(bundle)});
  };
  const forensic=()=>J.openForensicJournal({platform:p,path:file,epochId:f.EPOCH_ID,ownerInstanceId:made.ownerInstanceId});
  return {dir,p,file,owner,made,eventText,reserve,complete,forensic,starts:()=>starts,advance:n=>{u+=n;m+=n;},jump:n=>{u+=n;},fresh:()=>O.createEpochOwner({platformAdapter:p,journalPath:file,processIdentity:f.PROCESS_IDENTITY,inheritedRecordsText:"[]",clockSampler:O.createTestClockSampler(()=>({nowUtcMs:u,monotonicNowMs:m}))})};
}
const ack=e=>({schema:"trigger-fork-model-delivery-ack/v1",evidenceClass:B.EVIDENCE_CLASS,promotionId:e.promotionId,resultDigest:e.resultDigest,delivered:true});
function inject(p,fault){if(fault==="short")p.injectFault("write",{shortWritten:1});else if(fault==="readback")p.injectCheckpoint("postFlush",()=>p.injectFault("readback",{fail:"TEST_READBACK"}));else if(fault==="crash-after-flush")p.injectCheckpoint("postFlush",()=>{throw new Error("synthetic crash");});else p.injectFault(fault,{fail:"TEST_MODEL_FAULT"});}
for(const stage of ["RESERVED","RESULT","QUEUED","ATTEMPT","ACK"])for(const fault of ["write","short","fsync","readback","crash-after-flush"])test("MODEL crash boundary "+stage+"/"+fault+" holds without replay",t=>{
  const h=setup(t);let receipt=null,sends=0,result;
  if(stage==="RESERVED"){inject(h.p,fault);result=h.reserve();}
  else{assert.equal(h.reserve().ok,true);if(stage==="RESULT"){inject(h.p,fault);result=h.complete();}
    else{receipt=h.complete();assert.equal(receipt.ok,true);if(stage==="QUEUED"){inject(h.p,fault);result=h.owner.enqueueModelPromotion(receipt.receipt);}
      else{assert.equal(h.owner.enqueueModelPromotion(receipt.receipt).ok,true);if(stage==="ATTEMPT"){inject(h.p,fault);result=h.owner.deliverModelPromotion({receipt:receipt.receipt,deliver:e=>{++sends;return ack(e);}});}
        else{result=h.owner.deliverModelPromotion({receipt:receipt.receipt,deliver:e=>{++sends;inject(h.p,fault);return ack(e);}});}
      }
    }
  }
  assert.equal(result.ok,false,JSON.stringify(result));assert.equal(h.owner.snapshot().state,"HELD");assert.equal(h.owner.snapshot().deniedCount,1);assert.equal(h.starts(),stage==="RESERVED"?0:1);assert.equal(sends,stage==="ACK"?1:0);
  assert.equal(h.reserve().ok,false);if(receipt)assert.equal(h.owner.deliverModelPromotion({receipt:receipt.receipt,deliver:()=>{++sends;return null;}}).ok,false);
  const fresh=h.fresh();assert.equal(fresh.ok,true);assert.equal(fresh.owner.snapshot().state,"INACTIVE");assert.equal(fresh.owner.snapshot().promotionCount,0);assert.equal(fresh.owner.enqueueModelPromotion(receipt?receipt.receipt:{}).ok,false);assert.equal(consumer.previewRecovery(h.forensic()).code,"PLATFORM_RUNTIME_UNIMPLEMENTED");
});
test("MODEL crash after persisted RESULT before queue yields no automatic import or fork",t=>{const h=setup(t);assert.equal(h.reserve().ok,true);const receipt=h.complete();assert.equal(receipt.ok,true);assert.equal(h.forensic().importCandidates.length,0);h.p.releaseTestHandles();const fresh=h.fresh();assert.equal(fresh.owner.snapshot().state,"INACTIVE");assert.equal(fresh.owner.completeModelExecution({}).ok,false);assert.equal(h.starts(),1);});
for(const outcome of ["SUCCESS","FAILED","UNCERTAIN_HELD"])test("plain/manual/uncertain RESULT has no qualified import: "+outcome,t=>{const h=setup(t),a=h.reserve();assert.equal(a.ok,true);h.owner.recordResult({reservationSeq:a.reservationSeq,outcome});const rows=h.forensic();assert.equal(rows.ok,true);assert.equal(rows.importCandidates.length,0);assert.equal(h.starts(),1);});
for(const mutation of ["rollback","replacement","extra","partial","same-length"])test("live queued promotion byte mutation holds: "+mutation,t=>{const h=setup(t),old=fs.readFileSync(h.file);assert.equal(h.reserve().ok,true);const receipt=h.complete();assert.equal(h.owner.enqueueModelPromotion(receipt.receipt).ok,true);const bytes=fs.readFileSync(h.file);
  if(mutation==="rollback")fs.writeFileSync(h.file,old);else if(mutation==="replacement"){fs.renameSync(h.file,path.join(h.dir,"original"));fs.writeFileSync(h.file,bytes);}else if(mutation==="extra")fs.appendFileSync(h.file,"{}\n");else if(mutation==="partial")fs.appendFileSync(h.file,"{");else{const altered=Buffer.from(bytes);altered[altered.indexOf(Buffer.from("MODEL_ONLY"))]=88;fs.writeFileSync(h.file,altered);}
  let sends=0;assert.equal(h.owner.deliverModelPromotion({receipt:receipt.receipt,deliver:e=>{++sends;return ack(e);}}).ok,false);assert.equal(sends,0);assert.equal(h.owner.snapshot().state,"HELD");assert.equal(h.reserve().ok,false);assert.equal(h.starts(),1);
});
test("clock discontinuity before queue stops all promotion without rerun",t=>{const h=setup(t);h.reserve();const receipt=h.complete();h.jump(60001);assert.equal(h.owner.enqueueModelPromotion(receipt.receipt).ok,false);assert.equal(h.owner.snapshot().state,"HELD");assert.equal(h.forensic().importCandidates.length,0);assert.equal(h.starts(),1);});
test("ACK after send is not external exactly-once, exhausted uncertainty remains forensic",t=>{const h=setup(t);h.reserve();const receipt=h.complete();h.owner.enqueueModelPromotion(receipt.receipt);let sends=0;for(let n=0;n<3;n++){assert.equal(h.owner.deliverModelPromotion({receipt:receipt.receipt,deliver:()=>{++sends;return null;}}).ok,false);if(n<2)h.advance(B.BACKOFF_MS);}assert.equal(sends,3);assert.equal(h.starts(),1);const f=h.forensic();assert.equal(f.importCandidates.length,1);assert.equal(f.records.filter(r=>r.kind==="DELIVERY_ACK").length,0);assert.equal(consumer.previewRecovery(f).code,"PLATFORM_RUNTIME_UNIMPLEMENTED");});
