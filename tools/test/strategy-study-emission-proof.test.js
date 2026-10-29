"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const capture = require("../strategy-study/capture"), proof = require("../strategy-study/emission-proof");
const { fixture } = require("./strategy-study-trace.test");
const H = n => `0x${BigInt(n).toString(16).padStart(64, "0")}`, Q = n => `0x${BigInt(n).toString(16)}`;
const A = `0x${"11".repeat(20)}`, B = `0x${"22".repeat(20)}`, clone = value => structuredClone(value);
function witnessFor(frames) {
  const children = frames.map(() => []); frames.forEach(f => { if (f.parent !== null) children[f.parent].push(f.index); });
  const witness = { schema: "strategy-study-emission-witness/v1", complete: true, steps: 0, rootGasUsed: frames[0].gasUsed,
    frames: frames.map(f => ({ index: f.index, parent: f.parent, depth: f.depth, childOrdinal: f.parent === null ? null : children[f.parent].indexOf(f.index),
      type: f.type, from: f.from, to: f.to || B, failed: f.error, enteredChildren: children[f.index].length,
      steps: f.type === "SELFDESTRUCT" ? 0 : f.logs.length + 1, faultObserved: false })), emissions: [] };
  witness.steps = witness.frames.reduce((n, f) => n + f.steps, 0);
  function walk(i) {
    for (let p = 0; p <= children[i].length; p++) {
      for (const log of frames[i].logs) if (Number(log.position) === p) witness.emissions.push({ index: witness.emissions.length, frameIndex: i,
        pc: witness.emissions.length * 2, topicCount: log.topics.length, position: p });
      if (p < children[i].length) walk(children[i][p]);
    }
  }
  walk(0); return witness;
}
function recordedTrace(raw) {
  raw.logs.forEach((log, i) => { log.position = i ? "0x1" : "0x0"; log.index = Q(i ? i + 4 : 0); });
  raw.calls = [{ type: "CALL", from: B, to: B, input: "0x", gas: "0x1000", gasUsed: "0x100", error: "synthetic-revert",
    logs: Array.from({ length: 4 }, (_, i) => ({ address: B, topics: [H(500 + i)], data: "0x", position: "0x0" })) }];
  return raw;
}
function makeProofFixture(options = {}) {
  const f = fixture({ n: 10, metadata: true, ...options });
  const raw = f.callTrace(9), frames = capture.normalizeCallTrace(raw), witness = witnessFor(frames), view = f.parent.views[9];
  return { ...f, raw, frames, witness, view };
}
const bind = f => proof.bindEmissionProof(f.frames, f.view.transaction, f.view.receipt, f.witness);
module.exports = { witnessFor, recordedTrace, makeProofFixture, H, Q, A, B };
if (require.main === module) {
test("full receipt-bound recorded emissions, including 0 and39 after four reverted emissions, are synthetic proof not gap arithmetic", () => {
  const f = makeProofFixture({ logAddresses: Array(36).fill(B), trace: recordedTrace }), before = clone(f.frames), bound = bind(f);
  assert.equal(bound.bindings[0].emissionOrdinal, 0); assert.equal(bound.bindings[35].emissionOrdinal, 39); assert.equal(bound.witness.emissions.length, 40);
  assert.equal(bound.bindings.length, 36); assert.ok(bound.callCore.every(frame => frame.logs.every(log => !Object.hasOwn(log, "index"))));
  assert.deepEqual(f.frames, before); assert.equal(Object.isFrozen(bound.witness), true);
  const record = proof.classifyCallObservation(f.frames, f.view.transaction, f.view.receipt, f.witness, "obs-01");
  assert.deepEqual(record.candidateDomains, ["RECORDED_EMISSION"]); assert.equal(record.bindings.at(-1).observedIndex, "39");
  const core = bound.callCore;
  assert.deepEqual(proof.restoreCallObservation(core, f.view.transaction, f.view.receipt, f.witness, record), record);
});
test("witness, receipt and call-root gas must all exactly match, with no fill, unsafe integers or intrinsic/refund adjustment", () => {
  for (const mutate of [f => { f.witness.rootGasUsed = "20999"; }, f => { f.frames[0].gasUsed = "20999"; },
    f => { f.view.receipt.gasUsed = "20999"; }, f => { f.frames[0].gasUsed = f.witness.rootGasUsed = "20999"; },
    f => { delete f.witness.rootGasUsed; }, f => { f.witness.rootGasUsed = 21000; }, f => { f.witness.rootGasUsed = "9007199254740992"; }]) {
    const f = makeProofFixture(); f.view = clone(f.view); mutate(f); assert.throws(() => bind(f), /invalid-schema|binding-mismatch/);
  }
  const f = makeProofFixture(); delete f.raw.gasUsed; assert.throws(() => capture.normalizeCallTrace(f.raw), /invalid-trace/);
});
test("nested and ancestor-reverted frames retain emissions in ordinal counting without becoming receipt logs", () => {
  const f = makeProofFixture({ trace(raw) {
    raw.logs.forEach(log => { delete log.index; });
    raw.calls = [{ type: "CALL", from: B, to: B, gas: "0x100", gasUsed: "0x10", input: "0x", error: "reverted",
      calls: [{ type: "CALL", from: B, to: B, gas: "0x10", gasUsed: "0x1", input: "0x", logs: [{ ...raw.logs[0] }] }] }];
    return raw;
  } }), result = bind(f);
  assert.equal(result.bindings.length, 2); assert.equal(result.witness.emissions.length, 3); assert.equal(result.callCore[2].committed, false);
  f.witness.frames[1].failed = false; assert.throws(() => bind(f), /binding-mismatch/);
});
test("failed creation preserves candidate-to/null distinction, while empty-code and SELFDESTRUCT children can have zero steps", () => {
  const f = makeProofFixture({ trace(raw) {
    raw.logs.forEach(log => { delete log.index; }); raw.calls = [
      { type: "CREATE2", from: B, gas: "0x100", gasUsed: "0x10", input: "0x", error: "failed" },
      { type: "CALL", from: B, to: A, gas: "0x100", gasUsed: "0x0", input: "0x" },
      { type: "SELFDESTRUCT", from: B, to: A, gas: "0x0", gasUsed: "0x0", input: "0x" }]; return raw;
  } });
  f.witness.steps -= f.witness.frames[2].steps; f.witness.frames[2].steps = 0;
  const result = bind(f); assert.equal(result.callCore[1].to, null); assert.equal(result.witness.frames[1].to, B); assert.equal(result.witness.frames[3].steps, 0);
  const bad = clone(f.witness); bad.frames[2].to = B; assert.throws(() => proof.bindEmissionProof(f.frames, f.view.transaction, f.view.receipt, bad), /binding-mismatch/);
  f.witness.frames[1].failed = false; assert.throws(() => bind(f), /binding-mismatch/);
});
test("ordered tree, child positions, outcomes, topic counts and full emission projection cannot be repaired or guessed", () => {
  const create = () => makeProofFixture({ trace: recordedTrace });
  for (const mutate of [f => { f.witness.frames[1].from = A; }, f => { f.witness.frames[1].type = "DELEGATECALL"; },
    f => { f.witness.frames[1].childOrdinal = 1; }, f => { f.witness.frames[0].failed = true; },
    f => { f.witness.emissions[0].topicCount = 0; }, f => { f.witness.emissions[0].position = 1; },
    f => { const e = f.witness.emissions.pop(); f.witness.emissions.splice(1, 0, e); f.witness.emissions.forEach((e, i) => { e.index = i; }); },
    f => { f.witness.emissions.pop(); }, f => { f.frames[0].logs[0].data = "0x00"; }, f => { f.frames[0].logs[0].address = A; },
    f => { f.witness.frames.pop(); }, f => { f.witness.frames[1].steps = 0; f.witness.steps = f.witness.frames[0].steps; }]) {
    const f = create(); mutate(f); assert.throws(() => bind(f), /invalid-schema|binding-mismatch|trace-receipt-mismatch/);
  }
});
test("all reported metadata needs one consistent domain; missing is unknown, arbitrary gaps and indexed reverted logs remain unsupported", () => {
  const f = makeProofFixture({ trace: recordedTrace });
  const classify = frames => proof.classifyCallObservation(frames, f.view.transaction, f.view.receipt, f.witness, "obs-01");
  const unknown = proof.stripIndexes(f.frames); assert.deepEqual(classify(unknown).candidateDomains, []); assert.equal(classify(unknown).unreported, 2);
  const subset = clone(f.frames); delete subset[0].logs[0].index; assert.equal(classify(subset).reported, 1); assert.equal(classify(subset).bindings[0].receiptOrdinal, 1);
  const invalid = clone(f.frames); invalid[0].logs[1].index = "4"; assert.throws(() => classify(invalid), /consensus-mismatch/);
  const reverted = clone(f.frames); reverted[1].logs[0].index = "1"; assert.throws(() => classify(reverted), /consensus-mismatch/);
});
test("reader proof reconstructs every map and rejects rehashed schema/domain/count/location/ordinal substitutions", () => {
  const f = makeProofFixture({ trace: recordedTrace }), bound = bind(f);
  const record = proof.classifyCallObservation(f.frames, f.view.transaction, f.view.receipt, f.witness, "obs-01");
  for (const mutate of [r => { r.bindings[1].emissionOrdinal = 1; }, r => { r.bindings[0].receiptLogIndex = "9"; },
    r => { r.bindings[1].receiptOrdinal = 0; }, r => { r.bindings[0].logIndex = 1; }, r => { r.candidateDomains = ["GLOBAL"]; },
    r => { r.reported = 1; }, r => { r.bindings[0].raw = "private"; }, r => { r.observationId = "provider"; }]) {
    const r = clone(record); mutate(r); assert.throws(() => proof.restoreCallObservation(bound.callCore, f.view.transaction, f.view.receipt, f.witness, r), /invalid-schema|consensus-mismatch/);
  }
  const paired = { callCore: bound.callCore, witness: bound.witness, callObservations: [record] };
  proof.validatePairedProof(paired, f.view.transaction, f.view.receipt, ["obs-01"]);
  assert.throws(() => proof.validatePairedProof(paired, f.view.transaction, f.view.receipt, ["obs-01", "obs-02"]), /invalid-schema/);
  const bad = clone(paired); bad.callCore[0].logs[0].index = "0"; assert.throws(() => proof.validatePairedProof(bad, f.view.transaction, f.view.receipt, ["obs-01"]), /invalid-schema/);
});
}
