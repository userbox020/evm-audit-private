"use strict";
// Finite OFFLINE_MODEL_TEST only. No test brand/callback/context is native
// ownership, attended UI, containment, chain proof, or promotion authority.
// Fresh clock samples occur at every boundary; caller timestamp flags are not
// clocks. Runner is bound before dispatch. All callback seams are nonreentrant.
const { randomBytes, createHash } = require("node:crypto");
const { canonicalize } = require("./evm-call-inventory-v2/canonical.js");
const core = require("./trigger-fork-epoch.js");
const platforms = require("./trigger-fork-epoch-platform.js");
const journals = require("./trigger-fork-epoch-journal.js");
const contexts = require("./trigger-fork-epoch-context.js");
const outbox = require("./trigger-fork-epoch-outbox.js");
const execution = require("./trigger-fork-epoch-execution.js");
const PROCESS="trigger-fork-epoch-owner-process-identity/v1", APPROVAL="trigger-fork-epoch-activation-approval/v1";
const DISPOSITION="trigger-fork-inert-disposition/v1";
const clocks=new WeakSet(), runners=new WeakSet();
const modelOwners=new WeakSet();
const TTL=300000, CADENCE=240000, COOLDOWN=300000, DRIFT=60000;
const outcomes=["SUCCESS","FAILED","REJECTED","UNCERTAIN_HELD","HELD"];
function fail(code) { throw new Error(code); }
function exact(o,keys) {
  if(!o || (Object.getPrototypeOf(o)!==Object.prototype && Object.getPrototypeOf(o)!==null) || Reflect.ownKeys(o).length!==keys.length) fail("OWNER_INPUT_INVALID");
  for(const k of Reflect.ownKeys(o)) { const d=Object.getOwnPropertyDescriptor(o,k); if(!keys.includes(k) || !d.enumerable || !("value" in d)) fail("OWNER_INPUT_INVALID"); }
}
function copy(o) { const c=JSON.parse(JSON.stringify(o)); const freeze=x=>{ if(x && typeof x==="object") { Object.values(x).forEach(freeze); Object.freeze(x); } return x; }; return freeze(c); }
function digest(o) { return "0x"+createHash("sha256").update(canonicalize(o)).digest("hex"); }
function safeResult(ok,code,extra={}) { return copy({ok,code,modelLabel:"OFFLINE_MODEL_TEST",...extra}); }
function createTestClockSampler(sample) {
  if(typeof sample!=="function") throw new Error("TEST_CLOCK_INVALID");
  const clock=Object.freeze({name:"TEST_CLOCK_SAMPLER",sample}); clocks.add(clock); return clock;
}
function createInertTestRunner({dispatch,cancel}) {
  if(typeof dispatch!=="function" || typeof cancel!=="function") throw new Error("TEST_RUNNER_INVALID");
  const r=Object.freeze({kind:"INERT",dispatch,cancel}); runners.add(r); return r;
}
function disposition(v) {
  try { exact(v,["schema","teardownVerified"]); return v.schema===DISPOSITION && v.teardownVerified===true; } catch { return false; }
}
function createEpochOwner(i) {
  try {
    exact(i,["platformAdapter","journalPath","processIdentity","inheritedRecordsText","clockSampler"]);
    if(!platforms.isRegisteredTestAdapter(i.platformAdapter) || !clocks.has(i.clockSampler)) fail("OWNER_TEST_BRAND_REQUIRED");
    exact(i.processIdentity,["schema","pid","creationTimeUtc"]);
    const id=i.processIdentity;
    if(id.schema!==PROCESS || !Number.isSafeInteger(id.pid) || id.pid<1 || typeof id.creationTimeUtc!=="string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(id.creationTimeUtc) || !Number.isSafeInteger(Date.parse(id.creationTimeUtc)) || new Date(id.creationTimeUtc).toISOString()!==id.creationTimeUtc) fail("OWNER_PROCESS_IDENTITY_INVALID");
    if(typeof i.inheritedRecordsText!=="string" || typeof i.journalPath!=="string" || !i.journalPath) fail("OWNER_INPUT_INVALID");
    const platform=i.platformAdapter, clock=i.clockSampler, inheritedText=i.inheritedRecordsText, journalPath=i.journalPath, processIdentity=copy(id);
    const instance="OPI-"+randomBytes(16).toString("hex"), nonce=randomBytes(16).toString("hex"), processDigest=digest(processIdentity);
    const proposal=copy({schema:"trigger-fork-epoch-owner-proposal/v1",ownerInstanceId:instance,processIdentityDigest:processDigest,nonce});
    const proposalDigest=digest(proposal);
    let state="INACTIVE", holdCode=null, busy=false, manifest=null, handle=null, challenge=null, activated=false;
    let previous=null, anchor=null, epochDeadline=null, journal=null, baseToken=null, owned=false, closing=false;
    let runner=null, flight=null, pass=0, lastPass=null;
    const denied=new Map(), consumed=[], cooldown=new Map(), dispatchLog=[];
    const receipts=new WeakMap(), promotions=new Map();
    const sealedPolicy=()=>copy({manifest,manifestDigest:handle.digest});
    const hold=code=>{ if(!holdCode) holdCode=code; state="HELD"; return safeResult(false,code,{firstHoldCode:holdCode,held:true,consumed:denied.size>0}); };
    const boundary=fn=>{ if(busy) return safeResult(false,"OWNER_REENTRANT"); busy=true;
      try { return fn(); } catch(e) { return safeResult(false,/^OWNER_/.test(e.message)?e.message:"OWNER_INTERNAL_BLOCKED",{held:state==="HELD",consumed:denied.size>0}); } finally {busy=false;} };
    function sample(mode="epoch") {
      let s;
      try { const raw=clock.sample(); exact(raw,["nowUtcMs","monotonicNowMs"]); s={nowUtcMs:raw.nowUtcMs,monotonicNowMs:raw.monotonicNowMs};
        if(!Number.isSafeInteger(s.nowUtcMs) || !Number.isSafeInteger(s.monotonicNowMs) || s.nowUtcMs<0 || s.monotonicNowMs<0) fail("OWNER_CLOCK_INVALID");
      } catch { hold("OWNER_CLOCK_INVALID"); fail("OWNER_CLOCK_INVALID"); }
      if(previous && (s.monotonicNowMs<previous.monotonicNowMs || s.nowUtcMs<previous.nowUtcMs)) {hold("OWNER_CLOCK_REVERSED");fail("OWNER_CLOCK_REVERSED");}
      const driftBase=anchor||previous; // trusted preparation anchor never slides
      if(driftBase && Math.abs((s.nowUtcMs-driftBase.nowUtcMs)-(s.monotonicNowMs-driftBase.monotonicNowMs))>DRIFT) {hold("OWNER_CLOCK_DISCONTINUITY");fail("OWNER_CLOCK_DISCONTINUITY");}
      previous=s;
      if(manifest && mode!=="cleanup") {
        if(s.nowUtcMs>=Date.parse(manifest.expiresAt) || (epochDeadline!==null && s.monotonicNowMs>=epochDeadline)) {hold("OWNER_EPOCH_EXPIRED");fail("OWNER_EPOCH_EXPIRED");}
        if(flight && (s.nowUtcMs>=flight.workUtc || s.monotonicNowMs>=flight.workMono)) {hold("OWNER_WORK_DEADLINE");fail("OWNER_WORK_DEADLINE");}
      }
      return s;
    }
    function fit(s) { const b=manifest.bounds, budget=b.forkBudgetMs+b.cleanupBudgetMs;
      if(s.nowUtcMs<Date.parse(manifest.notBefore) || Date.parse(manifest.expiresAt)-s.nowUtcMs<budget || epochDeadline-s.monotonicNowMs<budget) {hold("OWNER_BUDGET_EXHAUSTED");fail("OWNER_BUDGET_EXHAUSTED");} }
    function eligibleAt(eventText,expectedSourceDigest,s) {
      return core.admitEvent({manifest:handle,event:eventText,expectedSourceDigest,nowMs:s.nowUtcMs,
        consumed:JSON.stringify(consumed),inherited:inheritedText});
    }
    function ongoingEligibleAt(eventText,expectedSourceDigest,s) {
      // Only this privately held reservation may remain absent from the core's
      // completed-consumed set. Inherited/prior results are never filtered out.
      if(!flight || flight.resultRecorded || denied.get(flight.context.semanticEventId)!=="UNCERTAIN" ||
          consumed.some(r=>r.semanticEventId===flight.context.semanticEventId)) fail("OWNER_ONGOING_RESERVATION_INVALID");
      const rebuilt=contexts.buildEventContext({callerClass:"EPOCH_OWNER",eventText,
        reservationSeq:flight.context.reservationSeq,passId:flight.context.passId,ownerInstanceId:instance,epochId:manifest.epochId});
      if(rebuilt.status!=="VALID" || canonicalize(rebuilt.context)!==canonicalize(flight.context)) fail("OWNER_ONGOING_CONTEXT_MISMATCH");
      const fresh=eligibleAt(eventText,expectedSourceDigest,s);
      if(fresh.status!=="OFFLINE_VALID") fail("OWNER_ONGOING_ELIGIBILITY_REJECTED");
    }
    function cleanup() {
      if(!flight) return true;
      let before;
      try { before=sample("cleanup"); } catch { return false; }
      let confirmed=false;
      try { confirmed=disposition(flight.runner.cancel(copy({schema:"trigger-fork-inert-cancel/v1",context:flight.context,deadlines:flight.deadlines}))); } catch {}
      let after;
      try { after=sample("cleanup"); } catch {return false;}
      if(!confirmed || after.monotonicNowMs>flight.cleanupMono || after.nowUtcMs>flight.cleanupUtc || after.monotonicNowMs-before.monotonicNowMs>manifest.bounds.cleanupBudgetMs) {
        hold("OWNER_TEARDOWN_UNCONFIRMED"); return false;
      }
      flight.teardown=true; return true;
    }
    function record(outcome,s,completion=null) {
      const f=flight;
      if(f.resultRecorded) return hold("OWNER_RESULT_ALREADY_RECORDED");
      const r=journal.appendRecord("RESULT",JSON.stringify({reservationSeq:f.context.reservationSeq,outcome,contextText:JSON.stringify(f.context),...(completion?{modelCompletion:completion}:{})}),new Date(s.nowUtcMs).toISOString(),f.token);
      if(!r.ok) return hold("OWNER_RESULT_PERSISTENCE_UNCERTAIN");
      // Completion itself is freshly sampled; persistence across a deadline is
      // not a timely result or promotion grant, even if earlier bytes say SUCCESS.
      let completionLate=false;
      try { sample(); } catch { completionLate=true; }
      const mapped=(completionLate || outcome==="UNCERTAIN_HELD" || outcome==="HELD")?"UNCERTAIN":outcome;
      consumed.push({schema:core.CONSUMED_SCHEMA,identitySchemaVersion:1,semanticEventId:f.context.semanticEventId,outcome:mapped,
        provenance:{source:"CURRENT_EPOCH",epochId:manifest.epochId,ownerProposalDigest:proposalDigest}});
      denied.set(f.context.semanticEventId,mapped);
      cooldown.set(f.context.routeKey,s.monotonicNowMs+COOLDOWN);
      f.resultRecorded=true;
      if(f.teardown) flight=null; // uncertainty is not evidence of quiescence
      if(completionLate) return hold("OWNER_RESULT_COMPLETION_LATE");
      if(outcome==="UNCERTAIN_HELD" || outcome==="HELD") return hold("OWNER_UNCERTAIN_TERMINAL");
      return safeResult(true,"RESULT_RECORDED");
    }
    function promotionGate(entry,budget=0){
      if(state!=="ACTIVE"||closing)fail("OWNER_NOT_ACTIVE");
      if(!journal.verifyBinding().ok){hold("OWNER_JOURNAL_INTEGRITY");fail("OWNER_JOURNAL_INTEGRITY");}
      const s=sample(),d=entry.completion.record.deadlines;
      if(s.nowUtcMs+budget>=Math.min(d.workUtcMs,d.cleanupUtcMs,d.epochUtcMs)||s.monotonicNowMs+budget>=Math.min(d.workMonotonicMs,d.cleanupMonotonicMs,d.epochMonotonicMs)){
        hold("OWNER_PROMOTION_DEADLINE");fail("OWNER_PROMOTION_DEADLINE");
      }
      const r=entry.completion.record,original=entry.reservation;
      if(!original||r.eventText!==original.eventText||canonicalize(r.context)!==canonicalize(original.context)||canonicalize(r.deadlines)!==canonicalize(original.deadlines)||canonicalize(r.policy)!==canonicalize(original.policy)||r.policy.manifestDigest!==handle.digest||canonicalize(r.policy.manifest)!==canonicalize(manifest)){hold("OWNER_PROMOTION_BINDING");fail("OWNER_PROMOTION_BINDING");}
      // Notification-only revalidation removes exactly this one private receipt's
      // successful CURRENT_EPOCH record. All other/inherited identities remain.
      const expected={schema:core.CONSUMED_SCHEMA,identitySchemaVersion:1,semanticEventId:r.context.semanticEventId,outcome:"SUCCESS",provenance:{source:"CURRENT_EPOCH",epochId:manifest.epochId,ownerProposalDigest:proposalDigest}};
      let excluded=0;const others=[];
      for(const c of consumed){if(c.semanticEventId===expected.semanticEventId){if(canonicalize(c)!==canonicalize(expected)){hold("OWNER_PROMOTION_CONSUMED_MISMATCH");fail("OWNER_PROMOTION_CONSUMED_MISMATCH");}++excluded;}else others.push(c);}
      if(excluded!==1||core.admitEvent({manifest:handle,event:r.eventText,consumed:JSON.stringify(others),inherited:inheritedText,expectedSourceDigest:r.context.sourceDigest,nowMs:s.nowUtcMs}).status!=="OFFLINE_VALID"||!outbox.recheckCompletion(entry.completion,s.nowUtcMs,{priorConsumed:others,inheritedRecords:JSON.parse(inheritedText)}).ok){hold("OWNER_MODEL_PROMOTION_STALE");fail("OWNER_MODEL_PROMOTION_STALE");}
      return s;
    }
    function acknowledgedNoop(entry){
      if(state!=="ACTIVE"||closing)fail("OWNER_NOT_ACTIVE");
      const s=sample("cleanup");
      if(s.nowUtcMs>=Date.parse(manifest.expiresAt)||s.monotonicNowMs>=epochDeadline){hold("OWNER_EPOCH_EXPIRED");fail("OWNER_EPOCH_EXPIRED");}
      return safeResult(true,"MODEL_ALREADY_ACKED",{promotionId:entry.completion.promotionId,status:"ACKED"});
    }
    function receiptEntry(receipt){const e=receipts.get(receipt);if(!e)fail("OWNER_RECEIPT_INVALID");return e;}
    function appendOutbox(kind,e,extra,s){
      const p={reservationSeq:e.completion.record.context.reservationSeq,promotionId:e.completion.promotionId,resultDigest:e.completion.resultDigest,...extra};
      if(!journal.appendRecord(kind,JSON.stringify(p),new Date(s.nowUtcMs).toISOString(),e.token).ok)return hold("OWNER_OUTBOX_PERSISTENCE_UNCERTAIN");
      return safeResult(true,kind);
    }
    const api=Object.freeze({
      snapshot:()=>copy({state,holdReason:holdCode,ownerInstanceId:instance,proposalDigest,processIdentityDigest:processDigest,
        epochId:manifest?manifest.epochId:null,manifestDigest:handle?handle.digest:null,deniedCount:denied.size,inFlightSeq:flight?flight.context.reservationSeq:null,
        journalOwned:owned,challengeActive:!!challenge,promotionCount:promotions.size,journalReservedSlots:journal?journal.snapshot().reservedSlots:0,journalReservedBytes:journal?journal.snapshot().reservedBytes:0,modelLabel:"OFFLINE_MODEL_TEST"}),
      get forensicState() { return copy({state,holdReason:holdCode,denied:[...denied].map(([semanticEventId,outcome])=>({semanticEventId,outcome})),consumed,dispatchLog}); },
      sealEpochManifest:text=>boundary(()=>{ if(state!=="INACTIVE" || handle!==null) fail("OWNER_STATE_INVALID");
        const h=core.parseEpochManifest(text); if(!h.manifest || h.manifest.ownerBinding.proposalDigest!==proposalDigest) fail("OWNER_SEAL_MISMATCH");
        handle=h; manifest=h.manifest; sample(); return safeResult(true,"SEALED",{manifestDigest:h.digest}); }),
      prepareEpoch:()=>boundary(()=>{
        if(state!=="INACTIVE" || !manifest) fail("OWNER_STATE_INVALID"); const s=sample();
        if(s.nowUtcMs<Date.parse(manifest.notBefore)) fail("OWNER_NOT_BEFORE");
        anchor=s; epochDeadline=s.monotonicNowMs+(Date.parse(manifest.expiresAt)-s.nowUtcMs); fit(s);
        const dr=core.consumedSetDigest(inheritedText); if(dr.digest!==manifest.predecessor.inheritedConsumedDigest) return hold("OWNER_INHERITED_DIGEST_MISMATCH");
        const inherited=JSON.parse(inheritedText); if(inherited.length!==manifest.predecessor.inheritedConsumedCount) return hold("OWNER_INHERITED_COUNT_MISMATCH");
        for(const r of inherited) {
          const p=r.provenance;
          if(p.source==="CURRENT_EPOCH" || (p.source==="LEGACY_ARCHIVE" ? p.lineageDigest!==manifest.legacy.archiveDigest :
            !manifest.predecessor.ancestry.some(a=>a.epochId===p.epochId && a.lineageDigest===p.lineageDigest))) return hold("OWNER_INHERITED_PROVENANCE_INVALID");
          denied.set(r.semanticEventId,r.outcome);
        }
        const quota=journals.resolveCapacityQuota({inheritedCount:inherited.length,maxConsumedIdentities:manifest.bounds.maxConsumedIdentities}); if(!quota.ok) return hold("OWNER_BASE_CAPACITY_EXCEEDED");
        const made=journals.createBoundJournal({platform,path:journalPath,epochId:manifest.epochId,ownerInstanceId:instance,capacityQuota:quota.capacityQuota});
        if(!made.ok) { if(made.cleanup){journal=made.cleanup;owned=true;} return hold("OWNER_JOURNAL_CREATE_FAILED"); }
        journal=made.journal; owned=true;
        const base=journal.reserveBase(inherited.length); if(!base.ok) return hold("OWNER_BASE_CAPACITY_EXCEEDED"); baseToken=base.token;
        const at=new Date(s.nowUtcMs).toISOString();
        if(!journal.appendRecord("EPOCH_OPEN",JSON.stringify({manifestDigest:handle.digest,epochLifetimeMs:Date.parse(manifest.expiresAt)-Date.parse(manifest.createdAt)}),at,baseToken).ok) return hold("OWNER_PREPARE_PERSISTENCE_UNCERTAIN");
        for(const record of inherited) if(!journal.appendRecord("INHERITED_CONSUMED",JSON.stringify({record}),at,baseToken).ok) return hold("OWNER_PREPARE_PERSISTENCE_UNCERTAIN");
        fit(sample()); state="PREPARED"; return safeResult(true,"PREPARED",{deniedCount:denied.size});
      }),
      registerInertRunner:r=>boundary(()=>{ if(flight || closing || state==="HELD" || state==="CLOSED" || !runners.has(r)) fail("OWNER_RUNNER_INVALID"); runner=r; return safeResult(true,"RUNNER_REGISTERED"); }),
      newChallenge:()=>boundary(()=>{ if(state!=="PREPARED" || activated || challenge) fail("OWNER_STATE_INVALID"); const s=sample();
        const c={schema:"trigger-fork-epoch-activation-challenge/v1",epochId:manifest.epochId,ownerInstanceId:instance,ownerProcessIdentityDigest:processDigest,manifestDigest:handle.digest,nonce:randomBytes(16).toString("hex"),issuedAtUtcMs:s.nowUtcMs,expiresAtUtcMs:s.nowUtcMs+TTL,issuedAtMonotonicMs:s.monotonicNowMs};
        challenge=copy({...c,challengeDigest:digest(c)}); return safeResult(true,"CHALLENGE_ISSUED",{challenge}); }),
      presentApproval:input=>boundary(()=>{ if(state!=="PREPARED" || activated || !challenge) fail("OWNER_CHALLENGE_NOT_ISSUED"); const s=sample();
        if(s.nowUtcMs>=challenge.expiresAtUtcMs || s.monotonicNowMs-challenge.issuedAtMonotonicMs>=TTL) {challenge=null;return hold("OWNER_CHALLENGE_EXPIRED");}
        exact(input,["approvalRecord","interaction"]); if(input.interaction!=="TEST_LOCAL_ATTENDED") fail("OWNER_INTERACTION_REFUSED");
        const a=input.approvalRecord; exact(a,["schema","decision","decidedAtUtc","challengeDigest","epochId","interactionClass","manifestDigest","ownerInstanceId","ownerProcessIdentityDigest"]);
        if(a.schema!==APPROVAL || a.decision!=="APPROVE" || a.interactionClass!=="TEST_AGREEMENT" || a.decidedAtUtc!==new Date(s.nowUtcMs).toISOString()) fail("OWNER_APPROVAL_INVALID");
        for(const k of ["challengeDigest","epochId","manifestDigest","ownerInstanceId","ownerProcessIdentityDigest"]) if(a[k]!==challenge[k]) fail("OWNER_CHALLENGE_BIND_MISMATCH");
        fit(s); activated=true; challenge=null; state="ACTIVE"; return safeResult(true,"ACTIVATED"); }),
      admitEvent:input=>boundary(()=>{
        if(state!=="ACTIVE" || closing) fail("OWNER_NOT_ACTIVE"); if(flight) fail("OWNER_IN_FLIGHT"); if(!runner) fail("OWNER_RUNNER_INVALID");
        exact(input,["eventText","expectedSourceDigest"]); const eventText=input.eventText, expectedSourceDigest=input.expectedSourceDigest;
        sample(); // validate continuity; temporal predicates use post-I/O time
        if(!journal.verifyBinding().ok) return hold("OWNER_JOURNAL_INTEGRITY");
        const verifiedTime=sample(); fit(verifiedTime); // AFTER blocking storage check
        if(lastPass!==null && verifiedTime.monotonicNowMs-lastPass<CADENCE) fail("OWNER_CADENCE_NOT_ELAPSED");
        const admission=eligibleAt(eventText,expectedSourceDigest,verifiedTime);
        if(admission.status!=="OFFLINE_VALID") return safeResult(false,"OWNER_ADMISSION_REJECTED",{admissionCode:admission.code});
        const e=core.parseSourceEvent(eventText); if(denied.has(e.semanticEventId)) fail("OWNER_REPLAY_CONSUMED");
        if(denied.size>=manifest.bounds.maxConsumedIdentities) fail("OWNER_CAPACITY_EXCEEDED");
        if(e.event.routeKey!==null && cooldown.has(e.event.routeKey) && verifiedTime.monotonicNowMs<cooldown.get(e.event.routeKey)) fail("OWNER_ROUTE_COOLDOWN");
        const c=contexts.buildEventContext({callerClass:"EPOCH_OWNER",eventText,reservationSeq:String(journal.snapshot().seq+1),passId:"PASS-"+(pass+1),ownerInstanceId:instance,epochId:manifest.epochId});
        if(c.status!=="VALID") return hold("OWNER_CONTEXT_INVALID");
        const policy=sealedPolicy();
        if(!outbox.lifecycleFits(eventText,c.context,{workUtcMs:verifiedTime.nowUtcMs+manifest.bounds.forkBudgetMs,workMonotonicMs:verifiedTime.monotonicNowMs+manifest.bounds.forkBudgetMs,cleanupUtcMs:verifiedTime.nowUtcMs+manifest.bounds.forkBudgetMs+manifest.bounds.cleanupBudgetMs,cleanupMonotonicMs:verifiedTime.monotonicNowMs+manifest.bounds.forkBudgetMs+manifest.bounds.cleanupBudgetMs,epochUtcMs:Date.parse(manifest.expiresAt),epochMonotonicMs:epochDeadline},policy))return safeResult(false,"OWNER_PROMOTION_RECORD_CAPACITY");
        const pre=sample(); fit(pre); // fresh sample immediately before consume/reserve
        const finalAdmission=eligibleAt(eventText,expectedSourceDigest,pre);
        if(finalAdmission.status!=="OFFLINE_VALID") return safeResult(false,"OWNER_ADMISSION_REJECTED",{admissionCode:finalAdmission.code});
        if(lastPass!==null && pre.monotonicNowMs-lastPass<CADENCE) fail("OWNER_CADENCE_NOT_ELAPSED");
        if(e.event.routeKey!==null && cooldown.has(e.event.routeKey) && pre.monotonicNowMs<cooldown.get(e.event.routeKey)) fail("OWNER_ROUTE_COOLDOWN");
        if(!outbox.lifecycleFits(eventText,c.context,{workUtcMs:pre.nowUtcMs+manifest.bounds.forkBudgetMs,workMonotonicMs:pre.monotonicNowMs+manifest.bounds.forkBudgetMs,cleanupUtcMs:pre.nowUtcMs+manifest.bounds.forkBudgetMs+manifest.bounds.cleanupBudgetMs,cleanupMonotonicMs:pre.monotonicNowMs+manifest.bounds.forkBudgetMs+manifest.bounds.cleanupBudgetMs,epochUtcMs:Date.parse(manifest.expiresAt),epochMonotonicMs:epochDeadline},policy))return safeResult(false,"OWNER_PROMOTION_RECORD_CAPACITY");
        const lease=journal.reserveLifecycle(); if(!lease.ok) return hold("OWNER_LIFECYCLE_CAPACITY_EXCEEDED");
        ++pass; lastPass=pre.monotonicNowMs;
        denied.set(c.context.semanticEventId,"UNCERTAIN");
        const b=manifest.bounds;
        flight={eventText,policy,context:c.context,token:lease.token,runner,teardown:false,workUtc:pre.nowUtcMs+b.forkBudgetMs,workMono:pre.monotonicNowMs+b.forkBudgetMs,
          cleanupUtc:pre.nowUtcMs+b.forkBudgetMs+b.cleanupBudgetMs,cleanupMono:pre.monotonicNowMs+b.forkBudgetMs+b.cleanupBudgetMs};
        flight.deadlines=copy({workUtcMs:flight.workUtc,workMonotonicMs:flight.workMono,cleanupUtcMs:flight.cleanupUtc,cleanupMonotonicMs:flight.cleanupMono,epochUtcMs:Date.parse(manifest.expiresAt),epochMonotonicMs:epochDeadline});
        const saved=journal.appendRecord("RESERVED",JSON.stringify({context:JSON.stringify(c.context)}),new Date(pre.nowUtcMs).toISOString(),lease.token);
        if(!saved.ok) return hold("OWNER_RESERVATION_PERSISTENCE_UNCERTAIN");
        // Fresh post-flush gate; a failing gate retains consumed uncertainty.
        let post;
        try {
          if(!journal.verifyBinding().ok) fail("OWNER_JOURNAL_INTEGRITY");
          // Last blocking I/O precedes the last pre-dispatch sample. Everything
          // between this fresh boundary and dispatch is a non-I/O predicate.
          post=sample(); fit(post); ongoingEligibleAt(eventText,expectedSourceDigest,post);
        }
        catch { const result=record("UNCERTAIN_HELD",previous||pre); if(!result.ok) return result; return hold("OWNER_POST_RESERVE_GATE_FAILED"); }
        let confirmed=false;
        try { confirmed=disposition(flight.runner.dispatch(copy({schema:"trigger-fork-inert-work/v1",context:flight.context,deadlines:flight.deadlines}))); } catch {}
        dispatchLog.push({reservationSeq:c.context.reservationSeq,code:confirmed?"TEST_DISPATCH_CONFIRMED":"TEST_DISPATCH_UNCERTAIN"});
        if(!confirmed) { hold("OWNER_DISPATCH_UNCERTAIN"); cleanup(); return record("UNCERTAIN_HELD",previous); }
        flight.teardown=true; // explicit validated disposition, never Promise completion
        try {sample();} catch { return record("UNCERTAIN_HELD",previous||post); }
        return safeResult(true,"RESERVED",{reservationSeq:c.context.reservationSeq,semanticEventId:c.context.semanticEventId,context:c.context,deadlines:flight.deadlines});
      }),
      recordResult:input=>boundary(()=>{
        if(state!=="ACTIVE" || !flight) fail("OWNER_RESULT_REFUSED"); exact(input,["reservationSeq","outcome"]);
        if(input.reservationSeq!==flight.context.reservationSeq || !outcomes.includes(input.outcome)) fail("OWNER_RESULT_INVALID");
        let s; try{s=sample();}catch { if(!flight.teardown) cleanup(); return record("UNCERTAIN_HELD",previous); }
        if(!flight.teardown) {hold("OWNER_TEARDOWN_UNCONFIRMED"); if(!cleanup()) return hold("OWNER_TEARDOWN_UNCONFIRMED"); return record("UNCERTAIN_HELD",previous);}
        return record(input.outcome,s);
      }),
      completeModelExecution:input=>boundary(()=>{
        if(state!=="ACTIVE"||closing||!flight||!flight.teardown)fail("OWNER_MODEL_COMPLETION_REFUSED");
        exact(input,["reservationSeq","bundleText"]);if(input.reservationSeq!==flight.context.reservationSeq)fail("OWNER_RESULT_INVALID");
        if(!journal.verifyBinding().ok)return hold("OWNER_JOURNAL_INTEGRITY");
        const s=sample(),f=flight;
        ongoingEligibleAt(f.eventText,f.context.sourceDigest,s);
        const checked=outbox.validateBundle(input.bundleText,{...f,validationHistory:{inheritedRecords:JSON.parse(inheritedText),priorConsumed:consumed}},s.nowUtcMs);
        if(!checked.ok)return safeResult(false,"OWNER_MODEL_COMPLETION_INVALID");
        const completed=record("SUCCESS",s,checked.completion);if(!completed.ok)return completed;
        const e={token:f.token,reservation:{eventText:f.eventText,context:f.context,deadlines:f.deadlines,policy:f.policy},completion:checked.completion,status:"NEW",attempt:0,lastUtc:null,lastMono:null};
        promotionGate(e);
        if(promotions.has(e.completion.promotionId))return hold("OWNER_PROMOTION_ID_CONFLICT");
        const receipt=Object.freeze({});receipts.set(receipt,e);promotions.set(e.completion.promotionId,e);
        return Object.freeze({...safeResult(true,"MODEL_RECEIPT_ISSUED",{promotionId:e.completion.promotionId,resultDigest:e.completion.resultDigest,evidenceClass:outbox.EVIDENCE_CLASS}),receipt});
      }),
      enqueueModelPromotion:receipt=>boundary(()=>{
        const e=receiptEntry(receipt);if(e.status==="ACKED")return acknowledgedNoop(e);const s=promotionGate(e);
        if(e.status!=="NEW")return safeResult(true,"PROMOTION_ALREADY_KNOWN",{promotionId:e.completion.promotionId,status:e.status});
        // Remember before append; uncertainty cannot regenerate this ID.
        e.status="UNCERTAIN";const r=appendOutbox("PROMOTION_QUEUED",e,{},s);if(!r.ok)return r;
        e.status="PENDING";promotionGate(e);return safeResult(true,"MODEL_PROMOTION_QUEUED",{promotionId:e.completion.promotionId,status:e.status});
      }),
      deliverModelPromotion:input=>boundary(()=>{
        exact(input,["receipt","deliver"]);const e=receiptEntry(input.receipt);if(e.status==="ACKED")return acknowledgedNoop(e);const s=promotionGate(e,outbox.DELIVERY_BUDGET_MS);
        if(!["PENDING","UNCERTAIN","EXHAUSTED"].includes(e.status))fail("OWNER_PROMOTION_NOT_QUEUED");
        if(e.attempt>=3){e.status="EXHAUSTED";return safeResult(false,"MODEL_DELIVERY_EXHAUSTED");}
        if(e.lastUtc!==null&&(s.nowUtcMs-e.lastUtc<outbox.BACKOFF_MS||s.monotonicNowMs-e.lastMono<outbox.BACKOFF_MS))return safeResult(false,"MODEL_DELIVERY_BACKOFF");
        const attempt=e.attempt+1,r=appendOutbox("DELIVERY_ATTEMPT",e,{attempt},s);if(!r.ok)return r;
        e.attempt=attempt;e.lastUtc=s.nowUtcMs;e.lastMono=s.monotonicNowMs;e.status="UNCERTAIN";
        const dispatchTime=promotionGate(e); // persisted ATTEMPT s is the common anchor
        if(dispatchTime.nowUtcMs-s.nowUtcMs>=outbox.DELIVERY_BUDGET_MS||dispatchTime.monotonicNowMs-s.monotonicNowMs>=outbox.DELIVERY_BUDGET_MS)return hold("OWNER_DELIVERY_TIMEOUT");
        let ack=null;
        try{
          const a=execution.rejectPromise(typeof input.deliver==="function"?input.deliver(copy({schema:"trigger-fork-model-delivery/v1",evidenceClass:outbox.EVIDENCE_CLASS,promotionId:e.completion.promotionId,resultDigest:e.completion.resultDigest,attempt,context:e.completion.record.context,deadlines:e.completion.record.deadlines,derivedNet:e.completion.record.derivedNet})):null);
          exact(a,["schema","evidenceClass","promotionId","resultDigest","delivered"]);
          if(a.schema==="trigger-fork-model-delivery-ack/v1"&&a.evidenceClass===outbox.EVIDENCE_CLASS&&a.promotionId===e.completion.promotionId&&a.resultDigest===e.completion.resultDigest&&a.delivered===true)ack=copy(a);
        }catch{} // trusted callback owns unsafe Promise rejections per GateB
        const after=promotionGate(e);
        if(after.nowUtcMs-s.nowUtcMs>=outbox.DELIVERY_BUDGET_MS||after.monotonicNowMs-s.monotonicNowMs>=outbox.DELIVERY_BUDGET_MS)return hold("OWNER_DELIVERY_TIMEOUT");
        if(!ack){if(e.attempt>=3)e.status="EXHAUSTED";return safeResult(false,"MODEL_DELIVERY_UNCERTAIN",{status:e.status,attempt});}
        const saved=appendOutbox("DELIVERY_ACK",e,{attempt,ack},after);if(!saved.ok)return saved;
        const committed=promotionGate(e);if(committed.nowUtcMs-s.nowUtcMs>=outbox.DELIVERY_BUDGET_MS||committed.monotonicNowMs-s.monotonicNowMs>=outbox.DELIVERY_BUDGET_MS)return hold("OWNER_DELIVERY_TIMEOUT");e.status="ACKED";return safeResult(true,"MODEL_DELIVERY_ACKED",{promotionId:e.completion.promotionId,attempt});
      }),
      modelOutboxSnapshot:()=>copy([...promotions.values()].map(e=>({promotionId:e.completion.promotionId,resultDigest:e.completion.resultDigest,status:e.status,attempt:e.attempt,evidenceClass:outbox.EVIDENCE_CLASS}))),
      close:input=>boundary(()=>{
        if(state==="CLOSED") return safeResult(false,"OWNER_CLOSED");
        closing=true; if(state!=="HELD") state="DRAINING"; // stop before callbacks
        if(flight) { if(!cleanup()) return hold("OWNER_TEARDOWN_UNCONFIRMED");
          if(flight.resultRecorded) flight=null;
          else if(journal && !journal.snapshot().heldCode) {const r=record("UNCERTAIN_HELD",previous); if(!r.ok && r.code==="OWNER_RESULT_PERSISTENCE_UNCERTAIN") return r;}
          else flight=null;
        }
        let s; try {s=sample("cleanup");} catch {return hold("OWNER_CLOCK_INVALID");}
        if(manifest && (s.nowUtcMs>=Date.parse(manifest.expiresAt) || (epochDeadline!==null && s.monotonicNowMs>=epochDeadline))) hold("OWNER_EPOCH_EXPIRED");
        if(journal && owned && !baseToken) journal.stopUncertain();
        if(journal && owned && !journal.snapshot().terminal && !journal.snapshot().heldCode) {
          const kind=holdCode?"HELD":"EPOCH_CLOSED", reason=holdCode?"HELD":(input && input.reason);
          const r=journal.appendRecord(kind,JSON.stringify({reason}),new Date(s.nowUtcMs).toISOString(),baseToken);
          if(!r.ok) return hold("OWNER_TERMINAL_PERSISTENCE_UNCERTAIN");
          if(!journal.verifyBinding().ok) return hold("OWNER_TERMINAL_INTEGRITY");
          try {const terminalSample=sample("cleanup"); if(terminalSample.nowUtcMs>=Date.parse(manifest.expiresAt) || terminalSample.monotonicNowMs>=epochDeadline) hold("OWNER_EPOCH_EXPIRED");} catch {return hold("OWNER_CLOCK_INVALID");}
        }
        if(journal && owned) {
          const r=journal.releaseLeaseIfSafe(); if(!r.ok) return hold("OWNER_RELEASE_UNCERTAIN"); owned=false;
        }
        state=holdCode?"HELD":"CLOSED";
        return safeResult(true,holdCode?"HELD_RELEASED":"CLOSED",{held:!!holdCode});
      }),
      abandon:()=>api.close({reason:"OPERATOR_CLOSE"}),
      project:writer=>boundary(()=>{ try {writer(api.snapshot());return safeResult(true,"PROJECTED");}catch{return safeResult(false,"OWNER_PROJECTION_FAILED");} })
    });
    sample("cleanup");
    modelOwners.add(api);
    return Object.freeze({ok:true,owner:api,proposal,proposalDigest,ownerInstanceId:instance,processIdentityDigest:processDigest,modelLabel:"OFFLINE_MODEL_TEST"});
  } catch {return safeResult(false,"OWNER_CREATE_REFUSED");}
}
module.exports=Object.freeze({PROCESS_IDENTITY_SCHEMA:PROCESS,APPROVAL_SCHEMA:APPROVAL,DISPOSITION_SCHEMA:DISPOSITION,
  CHALLENGE_TTL_MS:TTL,PASS_CADENCE_MS:CADENCE,ROUTE_COOLDOWN_MS:COOLDOWN,createTestClockSampler,createInertTestRunner,createEpochOwner,isRegisteredModelOwner:owner=>modelOwners.has(owner)});
