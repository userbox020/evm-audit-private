"use strict";
// OFFLINE byte-integrity model, never a native durability/ownership guarantee.
// appendRecord accepts bounded serialized payloads and spends a private lease.
// Event lease = RESERVED + RESULT + future QUEUED + 3 ATTEMPT + ACK (7 slots).
// Five outbox slots remain event-bound after confirmed RESULT.
// Base lease reserves OPEN + inherited entries + CLOSE/HELD (2 terminal slots).
const { createHash } = require("node:crypto");
const { parseStrictJson, canonicalize } = require("./evm-call-inventory-v2/canonical.js");
const platformModule = require("./trigger-fork-epoch-platform.js");
const core = require("./trigger-fork-epoch.js");
const ctx = require("./trigger-fork-epoch-context.js");
const outbox = require("./trigger-fork-epoch-outbox.js");
const SCHEMA = "trigger-fork-epoch-record/v1", ZERO = "0x" + "0".repeat(64);
const MAX_RECORDS = 512, MAX_BYTES = 768 * 1024, RECORD_BYTES = 16384;
const OUTCOMES = ["SUCCESS", "FAILED", "REJECTED", "UNCERTAIN_HELD", "HELD"];
const REASONS = ["OPERATOR_CLOSE", "UTC_EXPIRED", "MONOTONIC_DEADLINE_EXCEEDED", "DRAINED", "HELD"];
function fail(code) { throw new Error(code); }
function exact(o, keys) { if (!o || Object.keys(o).sort().join() !== keys.slice().sort().join()) fail("JOURNAL_PAYLOAD_INVALID"); }
function detached(o) { const c = JSON.parse(JSON.stringify(o)); const freeze = x => { if (x && typeof x === "object") { Object.values(x).forEach(freeze); Object.freeze(x); } return x; }; return freeze(c); }
function hash(o) { return "0x" + createHash("sha256").update(canonicalize(o)).digest("hex"); }
function timestamp(s) { if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s) || !Number.isSafeInteger(Date.parse(s)) || new Date(s).toISOString() !== s) fail("JOURNAL_TIMESTAMP_INVALID"); }
function bounded(text, max = RECORD_BYTES) {
  if (typeof text !== "string" || Buffer.byteLength(text) > max) fail("JOURNAL_PAYLOAD_INVALID");
  let d = 0, m = 0, q = false, esc = false;
  for (const ch of text) { if (q) { if (esc) esc=false; else if (ch === "\\") esc=true; else if (ch === '"') q=false; }
    else if (ch === '"') q=true; else if (ch === "{" || ch === "[") m=Math.max(m,++d); else if(ch === "}" || ch === "]") --d; }
  if (m > 10) fail("JOURNAL_PAYLOAD_INVALID");
  try { return parseStrictJson(text); } catch { fail("JOURNAL_RECORD_PARSE_INVALID"); }
}
function payload(kind, p, bind, seq) {
  if (kind === "EPOCH_OPEN") {
    exact(p,["manifestDigest","epochLifetimeMs"]);
    if (typeof p.manifestDigest !== "string" || !/^0x[0-9a-f]{64}$/.test(p.manifestDigest) || !Number.isSafeInteger(p.epochLifetimeMs) || p.epochLifetimeMs < 1 || p.epochLifetimeMs > 28800000) fail("JOURNAL_PAYLOAD_INVALID");
  } else if (kind === "INHERITED_CONSUMED") {
    exact(p,["record"]);
    if (!core.consumedSetDigest(JSON.stringify([p.record])).digest || p.record.provenance.source === "CURRENT_EPOCH") fail("JOURNAL_PAYLOAD_INVALID");
  } else if (kind === "RESERVED" || kind === "RESULT") {
    exact(p,kind === "RESERVED" ? ["context"] : ["contextText","outcome","reservationSeq",...(Object.hasOwn(p,"modelCompletion")?["modelCompletion"]:[])]);
    const v = ctx.validateSerializedContextStructure(kind === "RESERVED" ? p.context : p.contextText);
    if (v.status !== "VALID" || v.context.callerClass !== "EPOCH_OWNER" ||
        v.context.epochId !== bind.epochId || v.context.ownerInstanceId !== bind.ownerInstanceId ||
        v.context.reservationSeq !== (kind === "RESERVED" ? seq : p.reservationSeq)) fail("JOURNAL_CONTEXT_MISMATCH");
    if (kind === "RESULT" && !OUTCOMES.includes(p.outcome)) fail("JOURNAL_PAYLOAD_INVALID");
    if(kind==="RESULT"&&p.modelCompletion){
      if(p.outcome!=="SUCCESS"||canonicalize(p.modelCompletion.record.context)!==canonicalize(v.context))fail("JOURNAL_MODEL_RESULT_INVALID");
    }
  } else if (["PROMOTION_QUEUED","DELIVERY_ATTEMPT","DELIVERY_ACK"].includes(kind)) {
    exact(p,["reservationSeq","promotionId","resultDigest",...(kind==="PROMOTION_QUEUED"?[]:kind==="DELIVERY_ATTEMPT"?["attempt"]:["attempt","ack"])]);
    if(typeof p.reservationSeq!=="string"||! /^[1-9][0-9]*$/.test(p.reservationSeq)||! /^0x[0-9a-f]{64}$/.test(p.promotionId)||! /^0x[0-9a-f]{64}$/.test(p.resultDigest))fail("JOURNAL_PAYLOAD_INVALID");
    if(kind!=="PROMOTION_QUEUED"&&(!Number.isSafeInteger(p.attempt)||p.attempt<1||p.attempt>3))fail("JOURNAL_PAYLOAD_INVALID");
    if(kind==="DELIVERY_ACK"){
      exact(p.ack,["schema","evidenceClass","promotionId","resultDigest","delivered"]);
      if(p.ack.schema!=="trigger-fork-model-delivery-ack/v1"||p.ack.evidenceClass!==outbox.EVIDENCE_CLASS||p.ack.delivered!==true||p.ack.promotionId!==p.promotionId||p.ack.resultDigest!==p.resultDigest)fail("JOURNAL_ACK_INVALID");
    }
  } else if (kind === "EPOCH_CLOSED" || kind === "HELD") {
    exact(p,["reason"]); if (!REASONS.includes(p.reason)) fail("JOURNAL_PAYLOAD_INVALID");
  } else fail("JOURNAL_KIND_UNSUPPORTED");
}
// Forensic success means full structural AND reservation/result consistency,
// not native freshness, chain qualification, owner activation or promotion.
function parse(bytes, bind) {
  if (bytes.length > MAX_BYTES) fail("JOURNAL_CAPACITY_EXCEEDED");
  if (!Buffer.from(bytes.toString("utf8"),"utf8").equals(bytes)) fail("JOURNAL_UTF8_INVALID");
  if (!bytes.length) return [];
  if (bytes[bytes.length-1] !== 10) fail("JOURNAL_PARTIAL_TAIL");
  const lines = bytes.toString("utf8").split("\n"); lines.pop();
  if (lines.length > MAX_RECORDS) fail("JOURNAL_CAPACITY_EXCEEDED");
  let prev=ZERO, closed=false, opened=false, work=false, opening=null, sealedPolicy=null;
  const reservations=new Map(), results=new Map(), queues=new Map(), inherited=new Set(), records=[];
  const inheritedRecords=[],completedRecords=[];
  function recordedBinding(c,policy){
    if(c.epochId!==bind.epochId||c.ownerInstanceId!==bind.ownerInstanceId||c.epochId!==policy.manifest.epochId||c.ownerProposalDigest!==policy.manifest.ownerBinding.proposalDigest)fail("JOURNAL_RECORDED_POLICY_CONFLICT");
  }
  function historyFor(completion,excludeCurrent){
    const policy=completion.record.policy,wanted=completion.record.context,id=wanted.semanticEventId;
    let removed=0;const prior=[];
    for(const recorded of completedRecords){
      const c=recorded.context;recordedBinding(c,policy);
      if(recorded.epochId!==c.epochId||recorded.ownerInstanceId!==c.ownerInstanceId)fail("JOURNAL_RECORDED_POLICY_CONFLICT");
      if(excludeCurrent&&c.semanticEventId===id){if(recorded.outcome!=="SUCCESS"||canonicalize(c)!==canonicalize(wanted))fail("JOURNAL_PROMOTION_CONFLICT");++removed;}
      else prior.push({schema:core.CONSUMED_SCHEMA,identitySchemaVersion:c.identitySchemaVersion,semanticEventId:c.semanticEventId,outcome:recorded.outcome,provenance:{source:"CURRENT_EPOCH",epochId:recorded.epochId,ownerProposalDigest:c.ownerProposalDigest}});
    }
    if(excludeCurrent&&removed!==1)fail("JOURNAL_PROMOTION_CONFLICT");
    return {inheritedRecords,priorConsumed:prior};
  }
  for (let i=0; i<lines.length; ++i) {
    const r=bounded(lines[i]);
    exact(r,["schema","seq","epochId","ownerInstanceId","kind","timestampUtc","prevDigest","digest","payload"]);
    if (closed || r.schema!==SCHEMA || r.seq!==String(i+1) || r.epochId!==bind.epochId || r.ownerInstanceId!==bind.ownerInstanceId || r.prevDigest!==prev) fail("JOURNAL_CHAIN_INVALID");
    timestamp(r.timestampUtc); payload(r.kind,r.payload,bind,r.seq);
    const { digest, ...base }=r; if (digest!==hash(base)) fail("JOURNAL_HASH_MISMATCH");
    if (r.kind === "EPOCH_OPEN") { if (opened || i!==0) fail("JOURNAL_OPEN_CONFLICT"); opened=true;opening=r.payload; }
    else if (!opened) fail("JOURNAL_OPEN_MISSING");
    if (r.kind === "INHERITED_CONSUMED") { const id=r.payload.record.semanticEventId; if (work || inherited.has(id)) fail("JOURNAL_INHERITED_CONFLICT"); inherited.add(id);inheritedRecords.push(r.payload.record); }
    if (r.kind === "RESERVED") {
      work=true; const c=JSON.parse(r.payload.context);
      if(sealedPolicy)recordedBinding(c,sealedPolicy);
      if (inherited.has(c.semanticEventId) || [...reservations.values()].some(x=>x.semanticEventId===c.semanticEventId)) fail("JOURNAL_RESERVATION_CONFLICT");
      reservations.set(r.seq,c);
    }
    if (r.kind === "RESULT") {
      const c=JSON.parse(r.payload.contextText), n=r.payload.reservationSeq;
      if (!reservations.has(n) || results.has(n) || canonicalize(c)!==canonicalize(reservations.get(n))) fail("JOURNAL_RESULT_CONFLICT");
      if(sealedPolicy)recordedBinding(c,sealedPolicy);
      if(r.payload.modelCompletion){
        const completion=r.payload.modelCompletion,policy=completion.record.policy;
        if(!outbox.recheckCompletion(completion,Date.parse(r.timestampUtc),historyFor(completion,false)).ok||policy.manifestDigest!==opening.manifestDigest||opening.epochLifetimeMs!==Date.parse(policy.manifest.expiresAt)-Date.parse(policy.manifest.createdAt))fail("JOURNAL_MODEL_RESULT_INVALID");
        // A plain prefix had structural evidence only. Once a validated sealed
        // policy is available, contradictions anywhere in that prefix reject;
        // expected policy values must never overwrite actual recorded values.
        for(const reserved of reservations.values())recordedBinding(reserved,policy);
        sealedPolicy=policy;
      }
      results.set(n,r.payload);
      completedRecords.push({context:c,epochId:r.epochId,ownerInstanceId:r.ownerInstanceId,outcome:["HELD","UNCERTAIN_HELD"].includes(r.payload.outcome)?"UNCERTAIN":r.payload.outcome});
    }
    if(["PROMOTION_QUEUED","DELIVERY_ATTEMPT","DELIVERY_ACK"].includes(r.kind)){
      const p=r.payload,result=results.get(p.reservationSeq),completion=result&&result.modelCompletion;
      if(!completion||result.outcome!=="SUCCESS"||completion.promotionId!==p.promotionId||completion.resultDigest!==p.resultDigest||!outbox.recheckCompletion(completion,Date.parse(r.timestampUtc),historyFor(completion,true)).ok)fail("JOURNAL_PROMOTION_CONFLICT");
      let q=queues.get(p.reservationSeq);
      if(r.kind==="PROMOTION_QUEUED"){
        if(q||[...queues.values()].some(x=>x.id===p.promotionId))fail("JOURNAL_PROMOTION_CONFLICT");
        queues.set(p.reservationSeq,{id:p.promotionId,attempt:0,acked:false,lastAt:null,queuedAt:Date.parse(r.timestampUtc)});
      }else{
        if(!q||q.acked||q.id!==p.promotionId)fail("JOURNAL_DELIVERY_CONFLICT");
        const at=Date.parse(r.timestampUtc),deadlines=completion.record.deadlines;
        if(at<q.queuedAt||at>=Math.min(deadlines.workUtcMs,deadlines.cleanupUtcMs,deadlines.epochUtcMs))fail("JOURNAL_DELIVERY_CONFLICT");
        if(r.kind==="DELIVERY_ATTEMPT"){
          if(at+outbox.DELIVERY_BUDGET_MS>=Math.min(deadlines.workUtcMs,deadlines.cleanupUtcMs,deadlines.epochUtcMs)||p.attempt!==q.attempt+1||p.attempt>3||(q.lastAt!==null&&at-q.lastAt<outbox.BACKOFF_MS))fail("JOURNAL_DELIVERY_CONFLICT");
          q.attempt=p.attempt;q.lastAt=Date.parse(r.timestampUtc);
        }else{if(p.attempt!==q.attempt||q.attempt===0||at<q.lastAt||at-q.lastAt>=outbox.DELIVERY_BUDGET_MS)fail("JOURNAL_DELIVERY_CONFLICT");q.acked=true;}
      }
    }
    if (r.kind === "EPOCH_CLOSED" && reservations.size!==results.size) fail("JOURNAL_UNRESOLVED_CLOSE");
    if (r.kind === "EPOCH_CLOSED" || r.kind === "HELD") closed=true;
    records.push(r); prev=digest;
  }
  return records;
}
function resolveCapacityQuota({ inheritedCount, maxConsumedIdentities }) {
  if (!Number.isSafeInteger(inheritedCount) || inheritedCount<0 || !Number.isSafeInteger(maxConsumedIdentities) || maxConsumedIdentities<1 || maxConsumedIdentities>128 || inheritedCount>maxConsumedIdentities) return {ok:false,code:"JOURNAL_PARAM_INVALID"};
  const base = inheritedCount+3;
  if (base*RECORD_BYTES>MAX_BYTES || base>MAX_RECORDS) return {ok:false,code:"JOURNAL_CAPACITY_EXCEEDED"};
  return detached({ok:true,capacityQuota:{maxRecords:MAX_RECORDS,maxBytes:MAX_BYTES},baseRecords:base});
}
function createBoundJournal(i) {
  if (!i || !platformModule.isRegisteredEpochPlatformAdapter(i.platform)) return {ok:false,code:"PLATFORM_ADAPTER_UNREGISTERED"};
  const { platform:p, path, epochId, ownerInstanceId }=i;
  const q=i.capacityQuota ? {maxRecords:i.capacityQuota.maxRecords,maxBytes:i.capacityQuota.maxBytes} : null;
  if (!q || !Number.isSafeInteger(q.maxRecords) || q.maxRecords<1 || q.maxRecords>MAX_RECORDS || !Number.isSafeInteger(q.maxBytes) || q.maxBytes<1 || q.maxBytes>MAX_BYTES || !/^EP-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(epochId) || !/^OPI-[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(ownerInstanceId)) return {ok:false,code:"JOURNAL_PARAM_INVALID"};
  let fd=null, identity, expected=Buffer.alloc(0), records=[], held=null, terminal=false, usedSlots=0, usedBytes=0;
  const leases=new WeakMap(), bind={epochId,ownerInstanceId};
  const hold=code=> { if (!held) held=code; return detached({ok:false,code:held,held:true}); };
  const same=(a,b)=>a.dev===b.dev && a.ino===b.ino && a.nlink===b.nlink;
  const checked=(r,code)=> { if (!r || !r.ok) fail(code); return r; };
  function verifyBytes(want) {
    const s=checked(p.statIdentity(fd),"JOURNAL_STAT_FAILED"), t=checked(p.statIdentityByPath(path),"JOURNAL_PATH_REPLACED");
    if (!same(s,identity) || !same(s,t)) fail("JOURNAL_PATH_REPLACED");
    if (s.size!==want.length || t.size!==want.length) fail("JOURNAL_LENGTH_MISMATCH");
    const b=checked(p.readAll(fd,MAX_BYTES),"JOURNAL_READBACK_FAILED").bytes;
    if (!Buffer.isBuffer(b) || !b.equals(want)) fail("JOURNAL_BYTES_MUTATED");
    const committed=parse(b,bind);
    // Recheck after readback, immediately before committing remembered state.
    const last=checked(p.statIdentity(fd),"JOURNAL_STAT_FAILED"), lastPath=checked(p.statIdentityByPath(path),"JOURNAL_PATH_REPLACED");
    if(!same(last,identity) || !same(last,lastPath) || last.size!==want.length || lastPath.size!==want.length) fail("JOURNAL_PATH_REPLACED");
    return committed;
  }
  try {
    const c=p.createExclusiveFile(path); if (!c.ok) return {ok:false,code:c.code==="EEXIST"?"JOURNAL_EXISTS":"JOURNAL_CREATE_FAILED"};
    fd=c.fd; identity=checked(p.statIdentity(fd),"JOURNAL_PIN_FAILED");
    if (identity.size!==0) fail("JOURNAL_PIN_FAILED");
  } catch {
    held="JOURNAL_PIN_FAILED";
    if (fd!==null) { try { if (p.closeFile(fd).ok) fd=null; } catch {} }
    if (fd===null) return {ok:false,code:held};
    // Retain an accessible cleanup object when initial owned release fails.
  }
  function reserve(kinds) {
    if (held || terminal || fd===null) return {ok:false,code:held||"JOURNAL_TERMINAL"};
    const slots=kinds.length, bytes=slots*RECORD_BYTES;
    if (usedSlots+slots>q.maxRecords || usedBytes+bytes>q.maxBytes) return {ok:false,code:"JOURNAL_CAPACITY_EXCEEDED"};
    const token=Object.freeze({}); leases.set(token,{kinds:kinds.slice(),slots,bytes,binding:null}); usedSlots+=slots; usedBytes+=bytes;
    return {ok:true,token};
  }
  const api=Object.freeze({
    snapshot:()=>detached({seq:records.length,byteLength:expected.length,heldCode:held,held:!!held,terminal,released:fd===null,reservedSlots:usedSlots,reservedBytes:usedBytes}),
    reserveBase(count) { if (records.length || usedSlots || !Number.isSafeInteger(count) || count<0 || count>128) return {ok:false,code:"JOURNAL_PARAM_INVALID"}; return reserve(["EPOCH_OPEN",...Array(count).fill("INHERITED_CONSUMED"),"EPOCH_CLOSED","HELD"]); },
    reserveLifecycle:()=>reserve(["RESERVED","RESULT","PROMOTION_QUEUED","DELIVERY_ATTEMPT","DELIVERY_ATTEMPT","DELIVERY_ATTEMPT","DELIVERY_ACK"]),
    verifyBinding() { if (held) return hold(held); if(fd===null) return hold("JOURNAL_RELEASED"); try { verifyBytes(expected); return {ok:true}; } catch { return hold("JOURNAL_INTEGRITY_FAILED"); } },
    appendRecord(kind,text,at,token) {
      if (held || terminal) return {ok:false,code:held||"JOURNAL_TERMINAL",held:!!held};
      let prospective, bytes, lease;
      // Strict snapshot/validation before I/O. No arbitrary object hashing.
      try {
        lease=leases.get(token); if (!lease || !lease.kinds.includes(kind)) fail("JOURNAL_LEASE_INVALID");
        const data=bounded(text); timestamp(at);
        const base={schema:SCHEMA,seq:String(records.length+1),...bind,kind,timestampUtc:at,prevDigest:records.length?records.at(-1).digest:ZERO,payload:data};
        payload(kind,data,bind,base.seq); prospective={...base,digest:hash(base)};
        if(kind==="RESERVED" && lease.binding) fail("JOURNAL_LEASE_ALREADY_BOUND");
        if(kind==="RESULT" && (!lease.binding || lease.binding.seq!==data.reservationSeq ||
            lease.binding.context!==canonicalize(JSON.parse(data.contextText)))) fail("JOURNAL_LEASE_EVENT_MISMATCH");
        if(["PROMOTION_QUEUED","DELIVERY_ATTEMPT","DELIVERY_ACK"].includes(kind)&&(!lease.binding||lease.binding.seq!==data.reservationSeq||!lease.binding.completion||lease.binding.completion.promotionId!==data.promotionId||lease.binding.completion.resultDigest!==data.resultDigest))fail("JOURNAL_LEASE_EVENT_MISMATCH");
        bytes=Buffer.from(JSON.stringify(prospective)+"\n");
        if (bytes.length>RECORD_BYTES) fail("JOURNAL_CAPACITY_EXCEEDED");
        parse(Buffer.concat([expected,bytes]),bind); // full consistency before mutation
      } catch (e) { return {ok:false,code:/^JOURNAL_/.test(e.message)?e.message:"JOURNAL_PAYLOAD_INVALID"}; }
      try {
        verifyBytes(expected);
        const w=checked(p.append(fd,bytes),"JOURNAL_WRITE_FAILED");
        if(w.written!==bytes.length) fail("JOURNAL_SHORT_WRITE");
        checked(p.flush(fd),"JOURNAL_FLUSH_FAILED");
        const want=Buffer.concat([expected,bytes]);
        const committed=verifyBytes(want); // ALL bytes and opening identity, not tail only
        records=committed; expected=want;
        // Binding becomes authoritative only with this token's committed
        // RESERVED. Its retained RESULT/five future slots cannot serve B.
        if(kind==="RESERVED") lease.binding={seq:prospective.seq,context:canonicalize(JSON.parse(prospective.payload.context))};
        if(kind==="RESULT"&&prospective.payload.modelCompletion)lease.binding.completion={promotionId:prospective.payload.modelCompletion.promotionId,resultDigest:prospective.payload.modelCompletion.resultDigest};
        lease.kinds.splice(lease.kinds.indexOf(kind),1);
        if (kind==="EPOCH_CLOSED" || kind==="HELD") terminal=true;
        return detached({ok:true,seq:records.length,record:records.at(-1)});
      } catch { return hold("JOURNAL_IO_UNCERTAIN"); }
    },
    forensicRecords:()=>detached(records),
    releaseLeaseIfSafe() {
      if(fd===null) return {ok:true};
      if(!held && !terminal) return {ok:false,code:"JOURNAL_NOT_TERMINAL"};
      try { if(!checked(p.closeFile(fd),"JOURNAL_RELEASE_FAILED").ok) fail("JOURNAL_RELEASE_FAILED"); fd=null; return {ok:true,terminal:held||"CLOSED"}; }
      catch { return {ok:false,code:"JOURNAL_RELEASE_FAILED",held:true}; }
    },
    // Owner can stop a held epoch after integrity loss; never re-pins/rewrites.
    stopUncertain:()=>hold("JOURNAL_OWNER_STOPPED")
  });
  return held ? {ok:false,code:held,cleanup:api} : {ok:true,journal:api};
}
function openForensicJournal(i) {
  if(!i || !platformModule.isRegisteredEpochPlatformAdapter(i.platform)) return {ok:false,code:"PLATFORM_ADAPTER_UNREGISTERED"};
  let fd;
  try { const h=i.platform.openReadonlyExisting(i.path); if(!h.ok) fail("JOURNAL_READ_FAILED"); fd=h.fd;
    const all=i.platform.readAll(fd,MAX_BYTES); if(!all.ok) fail("JOURNAL_READ_FAILED");
    const records=parse(all.bytes,{epochId:i.epochId,ownerInstanceId:i.ownerInstanceId});
    return detached({ok:true,records,importCandidates:outbox.forensicCandidates(records),authority:"FORENSIC_CONSISTENCY_ONLY",policyEvidence:records.some(r=>r.kind==="RESULT"&&r.payload.modelCompletion)?"SEALED_MODEL_POLICY_BINDINGS_CHECKED":"PLAIN_STRUCTURAL_ONLY_NO_SEALED_POLICY",recoveryBlocker:"PLATFORM_RUNTIME_UNIMPLEMENTED"});
  } catch { return {ok:false,code:"JOURNAL_FORENSIC_INVALID"}; }
  finally { if(fd!==undefined) i.platform.closeFile(fd); }
}
module.exports=Object.freeze({RECORD_SCHEMA:SCHEMA,ZERO_DIGEST:ZERO,JOURNAL_MAX_RECORDS:MAX_RECORDS,JOURNAL_MAX_BYTES:MAX_BYTES,
  JOURNAL_MAX_RECORD_BYTES:RECORD_BYTES,EVENT_LIFECYCLE_SLOTS:7,FUTURE_OUTBOX_SLOTS:5,createBoundJournal,resolveCapacityQuota,openForensicJournal});
