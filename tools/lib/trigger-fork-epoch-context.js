"use strict";
// Binding DATA only. Identity and route computation belong exclusively to phase 1.
const core = require("./trigger-fork-epoch.js");
const { parseStrictJson, canonicalize } = require("./evm-call-inventory-v2/canonical.js");
const { createHash } = require("node:crypto");
const SCHEMA = "trigger-fork-epoch-context/v1";
const KEYS = ["schema", "identitySchemaVersion", "callerClass", "epochId", "ownerInstanceId",
  "ownerProposalDigest", "passId", "reservationSeq", "producerId", "firedStatus", "semanticEventId",
  "routeKey", "primaryPin", "companionPins", "sourceDigest", "adapterDigest", "scenarioDigest"];
const BIND = ["callerClass", "epochId", "ownerInstanceId", "ownerProposalDigest", "reservationSeq", "passId"];
const HASH = /^0x[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const statuses = new Set(Object.values(core.ADAPTER_REGISTRY).flatMap(a => a.statuses));
function fail(code) { throw new Error(code); }
function exact(o, keys) {
  if (!o || (Object.getPrototypeOf(o) !== Object.prototype && Object.getPrototypeOf(o) !== null) ||
      Reflect.ownKeys(o).length !== keys.length) fail("CONTEXT_FIELD_UNKNOWN");
  for (const k of Reflect.ownKeys(o)) {
    const d = Object.getOwnPropertyDescriptor(o, k);
    if (!keys.includes(k) || !d.enumerable || !("value" in d)) fail("CONTEXT_FIELD_UNKNOWN");
  }
}
function frozen(o) { if (o && typeof o === "object") { Object.values(o).forEach(frozen); Object.freeze(o); } return o; }
function digest(o) { return "0x" + createHash("sha256").update(canonicalize(o)).digest("hex"); }
function guarded(fn) { try { return fn(); } catch (e) { return Object.freeze({ status: "BLOCKED", code: /^CONTEXT_/.test(e.message) ? e.message : "CONTEXT_PARSE_BLOCKED" }); } }
function bounded(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 8192) fail("CONTEXT_SIZE_TOO_LARGE");
  let depth = 0, max = 0, quoted = false, escape = false;
  for (const ch of text) {
    if (quoted) { if (escape) escape = false; else if (ch === "\\") escape = true; else if (ch === '"') quoted = false; }
    else if (ch === '"') quoted = true;
    else if (ch === "{" || ch === "[") max = Math.max(max, ++depth);
    else if (ch === "}" || ch === "]") --depth;
  }
  if (max > 6) fail("CONTEXT_DEPTH_TOO_DEEP");
  return parseStrictJson(text);
}
function qty(v, positive) {
  if (typeof v !== "string" || !/^(0|[1-9][0-9]{0,39})$/.test(v) ||
      (positive && (v === "0" || BigInt(v) > 512n))) fail("CONTEXT_SEQUENCE_INVALID");
}
function pin(p) {
  exact(p, ["chainId", "blockNumber", "blockHash", "headerTime"]);
  if (!Number.isSafeInteger(p.chainId) || p.chainId < 1 || p.chainId > 4294967295 || typeof p.blockHash !== "string" || !HASH.test(p.blockHash)) fail("CONTEXT_PIN_INVALID");
  qty(p.blockNumber, false);
  if (typeof p.headerTime !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(p.headerTime) ||
      !Number.isSafeInteger(Date.parse(p.headerTime)) || new Date(p.headerTime).toISOString() !== p.headerTime) fail("CONTEXT_PIN_INVALID");
}
function shape(c) {
  exact(c, KEYS);
  if (c.schema !== SCHEMA || c.identitySchemaVersion !== 1) fail("CONTEXT_SCHEMA_UNSUPPORTED");
  if (typeof c.passId !== "string" || !/^PASS-[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(c.passId)) fail("CONTEXT_PASS_ID_INVALID");
  if (typeof c.producerId !== "string" || !ID.test(c.producerId) || !statuses.has(c.firedStatus)) fail("CONTEXT_STATUS_NOT_SUPPORTED");
  for (const k of ["semanticEventId", "sourceDigest", "adapterDigest", "scenarioDigest"]) if (typeof c[k] !== "string" || !HASH.test(c[k])) fail("CONTEXT_HASH_INVALID");
  if (c.routeKey !== null && (typeof c.routeKey !== "string" || !HASH.test(c.routeKey))) fail("CONTEXT_HASH_INVALID");
  if (c.callerClass === "MANUAL") {
    for (const k of ["epochId", "ownerInstanceId", "ownerProposalDigest", "reservationSeq"]) if (c[k] !== null) fail("CONTEXT_MANUAL_IMPERSONATION");
  } else if (c.callerClass === "EPOCH_OWNER") {
    if (typeof c.epochId !== "string" || !/^EP-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(c.epochId) ||
        typeof c.ownerInstanceId !== "string" || !/^OPI-[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(c.ownerInstanceId) ||
        typeof c.ownerProposalDigest !== "string" || !HASH.test(c.ownerProposalDigest)) fail("CONTEXT_EPOCH_FIELD_REQUIRED");
    qty(c.reservationSeq, true);
  } else fail("CONTEXT_CALLER_INVALID");
  pin(c.primaryPin);
  if (!Array.isArray(c.companionPins) || c.companionPins.length > 8) fail("CONTEXT_PIN_INVALID");
  let prev = 0;
  for (const p of c.companionPins) { pin(p); if (p.chainId <= prev || p.chainId === c.primaryPin.chainId) fail("CONTEXT_PIN_INVALID"); prev = p.chainId; }
  return c;
}
function valid(c) { return frozen({ status: "VALID", code: "VALID", context: c, digest: digest(c) }); }
function buildEventContext(i) {
  return guarded(() => {
    exact(i, ["callerClass", "eventText", "reservationSeq", "passId", "ownerInstanceId", "epochId"]);
    const p = core.parseSourceEvent(i.eventText);
    if (!p.event) fail("CONTEXT_PARSE_BLOCKED");
    const e = p.event, owner = i.callerClass === "EPOCH_OWNER";
    if (!owner && (i.callerClass !== "MANUAL" || i.epochId !== null || i.ownerInstanceId !== null || i.reservationSeq !== null)) fail("CONTEXT_MANUAL_IMPERSONATION");
    if (owner && i.epochId !== e.epochId) fail("CONTEXT_BIND_MISMATCH");
    const cleanPin = p => ({ chainId: p.chainId, blockNumber: p.blockNumber, blockHash: p.blockHash, headerTime: p.headerTime });
    const c = { schema: SCHEMA, identitySchemaVersion: 1, callerClass: i.callerClass,
      epochId: owner ? i.epochId : null, ownerInstanceId: owner ? i.ownerInstanceId : null,
      ownerProposalDigest: owner ? e.ownerProposalDigest : null, passId: i.passId,
      reservationSeq: i.reservationSeq, producerId: e.producerId, firedStatus: e.firedStatus,
      semanticEventId: p.semanticEventId, routeKey: e.routeKey, primaryPin: cleanPin(e.primary),
      companionPins: e.companions.map(cleanPin).sort((a,b) => a.chainId-b.chainId),
      sourceDigest: e.source.digest, adapterDigest: e.adapterDigest, scenarioDigest: e.scenarioDigest };
    return valid(shape(bounded(JSON.stringify(c))));
  });
}
function validateSerializedContextStructure(text) { return guarded(() => valid(shape(bounded(text)))); }
function validateSerializedContext(text, binding) {
  return guarded(() => {
    exact(binding, BIND); // reject getters before any binding value is read
    const c = shape(bounded(text));
    for (const k of BIND) if (binding[k] !== c[k]) fail("CONTEXT_BIND_MISMATCH");
    return valid(c);
  });
}
module.exports = Object.freeze({ CONTEXT_SCHEMA: SCHEMA, CONTEXT_KEYS: Object.freeze(KEYS),
  CALLER_CLASS_EPOCH_OWNER: "EPOCH_OWNER", CALLER_CLASS_MANUAL: "MANUAL", MAX_CONTEXT_BYTES: 8192,
  buildEventContext, validateSerializedContext, validateSerializedContextStructure });
