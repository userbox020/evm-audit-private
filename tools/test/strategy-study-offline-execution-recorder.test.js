"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), vm = require("node:vm");
const recorder = require("../strategy-study/offline-execution-recorder");
const ROOT = path.resolve(__dirname, "../../reports/raw/fast/strategy-study-20261020");
const FILE = path.join(ROOT, "offline-anvil-probe-r2-result.json"), ORIGINAL = path.join(ROOT, "offline-anvil-probe-result.json");
const HASH = "77f4a7e12cf9e78dae77d64bba1dd4ba63ab7ed7e32e9c2a883ac1cb36902c98";
const OLD_HASH = "a4f07348f08143a34bc3d281deef847da36008149fdaa9ac4b64be7c7bc2c584";
const source = fs.readFileSync(FILE), originalBytes = fs.readFileSync(ORIGINAL), input = () => JSON.parse(source.toString("utf8"));
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const mutate = change => { const run = input(); change(run); return run; };
const steps = (r, n) => r.fixtures[n].opcodeTrace.structLogs;
const native = (r, n) => r.fixtures[n].nativeTrace;
const fault = r => steps(r, 4).find(s => Object.hasOwn(s, "error"));
const SENTINEL = "UNTRUSTED_ERROR_SENTINEL";
function rejects(change) {
  assert.throws(() => recorder.analyzeSyntheticRun(mutate(change)), error => {
    assert.equal(error.message, "invalid-synthetic-run"); assert.equal(error.cause, undefined); assert.ok(!String(error.stack).includes(SENTINEL)); return true;
  });
}
function frozen(v) { if (v && typeof v === "object") { assert.ok(Object.isFrozen(v)); Object.values(v).forEach(frozen); } }
function noAuthority(out, complete) {
  assert.equal(out.syntheticOnly, true); assert.equal(out.syntheticProfileComplete, complete);
  for (const key of ["completeExecutionWitness", "historicalReplayQualified", "validPilotAggregate", "validStudyAggregate"]) assert.equal(out[key], false);
  assert.equal(out.witnessProjection, null); assert.equal(out.reportedIndexDomain, "UNQUALIFIED");
}

test("module exports only the three pure APIs and imports only the crypto builtin", () => {
  assert.deepEqual(Object.keys(recorder).sort(), ["analyzeSyntheticRun", "recordPinnedR2", "validatePinnedR2"].sort()); assert.ok(Object.isFrozen(recorder));
  const text = fs.readFileSync(path.resolve(__dirname, "../strategy-study/offline-execution-recorder.js"), "utf8"), module = { exports: {} }, imports = [];
  vm.runInNewContext(text, { module, require(name) { imports.push(name); assert.equal(name, "node:crypto"); return crypto; } });
  assert.deepEqual(imports, ["node:crypto"]); assert.deepEqual(Object.keys(module.exports).sort(), Object.keys(recorder).sort());
});

test("actual hash-gated R2 derives 90 steps, 14 frames, two zero-step children and 7/6/3/4 LOG totals", () => {
  assert.equal(digest(source), HASH); assert.equal(digest(originalBytes), OLD_HASH);
  const out = recorder.recordPinnedR2(source);
  assert.equal(out.schema, "strategy-study-offline-execution-reconstruction/v1"); assert.equal(out.sourceSha256, HASH);
  assert.equal(out.sourceStatus, "FAILED"); assert.equal(out.sourceReason, "trace-error-literal-unrecognized");
  assert.deepEqual(out.totals, { fixtures: 8, traceResults: 16, steps: 90, frames: 14, zeroStepFrames: 2, logAttempts: 7, emissions: 6, committedEmissions: 3, faults: 1, nativeVisibleLogs: 4 });
  noAuthority(out, true); frozen(out);
  assert.deepEqual(recorder.validatePinnedR2(source, JSON.parse(JSON.stringify(out))), out);
  assert.equal(digest(fs.readFileSync(FILE)), HASH); assert.equal(digest(fs.readFileSync(ORIGINAL)), OLD_HASH);
});

test("every recorded step and native frame is consumed once with explicit preorder/context refs", () => {
  const run = input(), out = recorder.recordPinnedR2(source);
  for (let i = 0; i < out.fixtures.length; i++) {
    const f = out.fixtures[i], indexes = f.frames.flatMap(frame => frame.stepIndexes).sort((a, b) => a - b);
    assert.deepEqual(indexes, run.fixtures[i].opcodeTrace.structLogs.map((_, n) => n));
    assert.deepEqual(f.frames.map(frame => frame.frameId), f.frames.map((_, n) => n));
    for (const frame of f.frames.slice(1)) { assert.equal(frame.parentFrameId, 0); assert.equal(frame.depth, 2); assert.ok(frame.callStepIndex >= 0); }
  }
});

test("diagnostic computation never acquires completeness, does not mutate input, and ignores all fixture truth/PASS/assertion labels", () => {
  const run = input(), before = structuredClone(run), out = recorder.analyzeSyntheticRun(run);
  noAuthority(out, false); assert.equal(out.sourceSha256, null); assert.deepEqual(run, before); assert.equal(Object.isFrozen(run), false);
  const changed = mutate(r => {
    r.supported = { completeExecutionWitness: true, actualOpcodeAndNativePairs: 999 }; r.authority = { validPilotAggregate: true };
    for (const f of r.fixtures) { f.truth = { logAttempts: 999, successfulLogExecutions: 999 }; f.status = "PASSED"; f.reason = SENTINEL; f.observations = { steps: 0 }; f.assertions = [{ passed: true, actual: 999 }]; f.errorDiagnostics = [SENTINEL]; }
  });
  assert.deepEqual(recorder.analyzeSyntheticRun(changed), out); assert.ok(!JSON.stringify(out).includes(SENTINEL));
  assert.equal(out.context.independentTerminationProof, false); assert.equal(out.context.headerAuthenticatesEtchedState, false);
});

test("root revert preserves successful raw root emission/native log but commitment is false; child and ancestor rollbacks differ", () => {
  const f = recorder.recordPinnedR2(source).fixtures;
  assert.equal(f[1].frames[0].outcome, "revert"); assert.equal(f[1].emissions.length, 1); assert.equal(f[1].emissions[0].committed, false);
  assert.equal(f[1].nativeLogBindings.length, 1); assert.equal(f[1].nativeLogBindings[0].committed, false); assert.equal(f[1].nativeLogBindings[0].rawIndex, "0x0");
  assert.deepEqual(f[2].frames.map(x => [x.outcome, x.committed]), [["success", true], ["revert", false]]);
  assert.deepEqual(f[3].frames.map(x => [x.outcome, x.committed]), [["revert", false], ["success", false]]);
  for (const n of [2, 3]) { assert.equal(f[n].emissions.length, 1); assert.equal(f[n].emissions[0].committed, false); assert.deepEqual(f[n].nativeLogBindings, []); }
});

test("delegate code differs from execution/storage/emitter context and raw native from differs from effective caller", () => {
  const f = recorder.recordPinnedR2(source).fixtures[5], [root, child] = f.frames;
  assert.equal(child.type, "DELEGATECALL"); assert.equal(child.executionAddress, root.executionAddress);
  assert.equal(child.storageAddress, root.storageAddress); assert.equal(child.emitterAddress, root.executionAddress);
  assert.notEqual(child.codeAddress, child.executionAddress); assert.equal(child.rawNativeFrom, root.executionAddress);
  assert.equal(child.effectiveCaller, root.effectiveCaller); assert.notEqual(child.effectiveCaller, child.rawNativeFrom);
  assert.equal(f.emissions[0].address, root.executionAddress); assert.equal(child.value, "0");
});

test("pre-expansion LOG derives exactly 32 zero bytes and includes memory expansion in gas, without general missing-memory inference", () => {
  const f = recorder.recordPinnedR2(source).fixtures[6], e = f.emissions[0];
  assert.equal(e.offset, "64"); assert.equal(e.length, "32"); assert.equal(e.data, `0x${"00".repeat(32)}`);
  assert.equal(f.frames[0].gas.executionUsed, "646"); assert.equal(f.frames[0].gas.nativeUsed, "21646");
  const zeros = mutate(r => { steps(r, 6).at(-1).memory = Array(3).fill("0".repeat(64)); });
  assert.deepEqual(recorder.analyzeSyntheticRun(zeros).fixtures[6].emissions, f.emissions);
  rejects(r => { steps(r, 6).at(-1).memory = ["0".repeat(64)]; });
  rejects(r => { steps(r, 6)[2].memory = Array(3).fill("0".repeat(64)); });
  rejects(r => { steps(r, 6)[2].memory = ["1".repeat(64)]; });
  rejects(r => { delete steps(r, 6)[2].memory; });
  rejects(r => { native(r, 6).logs[0].data = `0x${"01".repeat(32)}`; });
});

test("qualified static fault is a terminal non-emitting attempt with exact Option/bare literals and full child gas consumption", () => {
  const f = recorder.recordPinnedR2(source).fixtures[4], child = f.frames[1], fault = f.faults[0];
  assert.equal(child.staticContext, true); assert.equal(child.type, "STATICCALL"); assert.equal(child.outcome, "static-write-fault");
  assert.equal(child.gas.entry, "50000"); assert.equal(child.gas.exit, "0"); assert.equal(child.gas.executionUsed, "50000"); assert.equal(child.gas.nativeUsed, "50000");
  assert.equal(fault.opcodeError, "Some(StateChangeDuringStaticCall)"); assert.equal(fault.nativeError, "StateChangeDuringStaticCall");
  assert.equal(fault.reportedStepGasCost, "0"); assert.equal(fault.remainingGasBurned, "49994"); assert.equal(fault.frameGasConsumed, "50000"); assert.equal(fault.emitted, false);
  assert.equal(child.callArguments.returnedSuccess, false); assert.equal(child.callArguments.parentResumeStepIndex, 10);
  assert.deepEqual(f.emissions, []); assert.deepEqual(f.nativeLogBindings, []);
});

test("empty code and empty-input identity precompile retain native frames but have no invented steps", () => {
  const f = recorder.recordPinnedR2(source).fixtures[7], children = f.frames.slice(1);
  assert.deepEqual(children.map(c => c.zeroStepKind), ["empty-code", "identity-precompile-empty-input"]);
  assert.deepEqual(children.map(c => c.stepIndexes), [[], []]); assert.deepEqual(children.map(c => c.terminal), [null, null]);
  assert.deepEqual(children.map(c => c.gas.executionUsed), ["0", "15"]); assert.deepEqual(children.map(c => c.childOrdinal), [0, 1]);
  assert.ok(children.every(c => c.callArguments.returnedSuccess && c.outcome === "success"));
  rejects(r => { native(r, 7).calls[0].gasUsed = "0x1"; });
  rejects(r => { native(r, 7).calls[1].gasUsed = "0x0"; });
});

test("root total gas includes intrinsic once and call resumption refunds only unspent forwarded gas", () => {
  const out = recorder.recordPinnedR2(source);
  for (const f of out.fixtures) {
    const root = f.frames[0]; assert.equal(root.gas.entry, "129000"); assert.equal(root.gas.intrinsic, "21000");
    assert.equal(BigInt(root.gas.nativeUsed), 21000n + BigInt(root.gas.executionUsed));
    for (const child of f.frames.slice(1)) {
      const c = child.callArguments; assert.equal(child.gas.intrinsic, "0");
      assert.equal(BigInt(c.parentResumeGas), BigInt(c.parentGasBefore) - BigInt(c.reportedCallCost) + BigInt(child.gas.entry) - BigInt(child.gas.executionUsed));
    }
  }
  rejects(r => { r.fixtures[0].opcodeTrace.gas--; }); rejects(r => { native(r, 0).gasUsed = "0x17d"; });
  rejects(r => { steps(r, 2)[7].gasCost--; }); rejects(r => { steps(r, 2)[14].gas++; });
  rejects(r => { steps(r, 0)[2].gasCost++; }); rejects(r => { steps(r, 0)[0].gas = 150000; });
});

test("raw output omission is preserved separately from semantically derived empty output", () => {
  const out = recorder.recordPinnedR2(source);
  for (const f of out.fixtures) for (const frame of f.frames) { assert.equal(frame.output.derived, "0x"); assert.equal(frame.output.rawPresent, false); assert.equal(frame.output.rawValue, null); }
  const present = recorder.analyzeSyntheticRun(mutate(r => { native(r, 0).output = "0x"; }));
  assert.equal(present.fixtures[0].frames[0].output.rawPresent, true); assert.equal(present.fixtures[0].frames[0].output.rawValue, "0x");
  assert.equal(out.fixtures[4].frames[1].rawNativeValue.present, false);
  rejects(r => { native(r, 0).output = "0x01"; }); rejects(r => { r.fixtures[0].opcodeTrace.returnValue = "0x01"; });
});

test("diagnostic indexes remain opaque/unqualified metadata, never deleted or converted into an inferred domain", () => {
  const changed = mutate(r => { native(r, 0).logs[0].index = "0xdeadbeef"; delete native(r, 1).logs[0].index; });
  const out = recorder.analyzeSyntheticRun(changed); noAuthority(out, false);
  assert.equal(out.fixtures[0].nativeLogBindings[0].rawIndex, "0xdeadbeef");
  assert.equal(out.fixtures[1].nativeLogBindings[0].rawIndexPresent, false); assert.equal(out.fixtures[1].nativeLogBindings[0].rawIndex, null);
  assert.ok(out.fixtures.flatMap(f => f.nativeLogBindings).every(b => b.reportedIndexDomain === "UNQUALIFIED"));
  assert.throws(() => recorder.recordPinnedR2(Buffer.from(JSON.stringify(changed))), /^Error: source-hash-mismatch$/);
});

test("hashing happens before parse, only exact original bytes are admitted, and no expected-hash override exists", () => {
  for (const bytes of [Buffer.from("not json"), Buffer.concat([source, Buffer.from("\n")]), Buffer.from(JSON.stringify(input())), originalBytes]) {
    assert.throws(() => recorder.recordPinnedR2(bytes), /^Error: source-hash-mismatch$/);
  }
  for (const bad of [null, source.toString(), {}, Buffer.alloc(16777217)]) assert.throws(() => recorder.recordPinnedR2(bad), /^Error: invalid-source-bytes$/);
  assert.throws(() => recorder.recordPinnedR2(source, { expectedHash: HASH }), /^Error: invalid-source-bytes$/);
  assert.deepEqual(recorder.recordPinnedR2(new Uint8Array(source)), recorder.recordPinnedR2(source));
});

test("strict reader completely recomputes candidates, rejecting extra fields, authority upgrades and frame/emission/fault/context forgeries", () => {
  const base = recorder.recordPinnedR2(source);
  const changes = [c => { c.extra = true; }, ...["completeExecutionWitness", "historicalReplayQualified", "validPilotAggregate", "validStudyAggregate"].map(k => c => { c[k] = true; }),
    c => { c.syntheticProfileComplete = false; }, c => { c.sourceStatus = "PASSED"; }, c => { c.sourceSha256 = "0".repeat(64); }, c => { c.sourceReason = null; },
    c => { c.witnessProjection = {}; }, c => { c.reportedIndexDomain = "GLOBAL"; }, c => { c.totals.steps--; }, c => { c.fixtures.pop(); },
    c => { c.fixtures[0].frames[0].gas.exit = "1"; }, c => { c.fixtures[1].emissions[0].committed = true; }, c => { c.fixtures[4].faults = []; },
    c => { c.fixtures[0].nativeLogBindings[0].rawIndex = "0x1"; }, c => { c.fixtures[5].frames[1].effectiveCaller = c.fixtures[5].frames[1].rawNativeFrom; },
    c => { c.fixtures[7].frames[1].stepIndexes = [0]; }, c => { c.fixtures[0].frames[0].output.rawPresent = true; },
    c => { c.context.independentTerminationProof = true; }, c => { c.context.localBlock.stateBindingClaimed = true; }];
  for (const change of changes) { const candidate = structuredClone(base); change(candidate); assert.throws(() => recorder.validatePinnedR2(source, candidate), /^Error: invalid-recorder-candidate$/); }
  const reordered = Object.fromEntries(Object.entries(base).reverse()); assert.deepEqual(recorder.validatePinnedR2(source, reordered), base);
  assert.throws(() => recorder.validatePinnedR2(source, base, { expectedHash: HASH }), /^Error: invalid-recorder-candidate$/);
});

test("candidate getters/serializers/symbols/cycles are not accepted as equivalent JSON", () => {
  const base = recorder.recordPinnedR2(source); let called = 0;
  for (const change of [c => { Object.defineProperty(c, "sourceStatus", { enumerable: true, get() { called++; throw new Error(SENTINEL); } }); },
    c => { Object.defineProperty(c, "toJSON", { value() { called++; return base; } }); }, c => { c[Symbol("hidden")] = true; }, c => { c.context.loop = c; }, c => { c.totals.steps = NaN; }]) {
    const candidate = structuredClone(base); change(candidate); assert.throws(() => recorder.validatePinnedR2(source, candidate), /^Error: invalid-recorder-candidate$/);
  }
  assert.equal(called, 0);
});

test("runtime/config/hardfork/local header/input/code pins cannot be changed even for diagnostic analysis", () => {
  for (const change of [r => { r.runtimeIdentity.version = "1.6.0"; }, r => { r.runtimeIdentity.commit = "0".repeat(40); }, r => { r.runtimeIdentity.sha256 = "0".repeat(64); },
    r => { r.configs.opcode.enableMemory = false; }, r => { r.configs.opcode.limit = 32; }, r => { r.configs.native.tracerConfig.withLog = false; },
    r => { r.localStateAssumptions.hardfork = "cancun"; }, r => { r.localBlock.hash = `0x${"00".repeat(32)}`; }, r => { r.fixtures[0].input.gas = "0x24a00"; },
    r => { r.fixtures[0].input.value = "0x1"; }, r => { r.fixtures[0].input.data = "0x00"; }, r => { r.fixtures[0].root = r.fixtures[1].root; },
    r => { r.fixtures.reverse(); }, r => { r.fixtures[0].codes[0].codeSha256 = "0".repeat(64); },
    r => { const c = r.fixtures[0].codes[0]; c.bytecode = "0x00"; c.codeSha256 = digest(Buffer.from("00", "hex")); }, r => { r.fixtures[2].codes.pop(); }]) rejects(change);
});

test("missing/reordered/extra opcode steps are rejected by bytecode/PC/stack alignment, independent of label tables", () => {
  for (const change of [r => { steps(r, 0).shift(); }, r => { steps(r, 0).pop(); }, r => { steps(r, 1).splice(2, 1); },
    r => { [steps(r, 0)[0], steps(r, 0)[1]] = [steps(r, 0)[1], steps(r, 0)[0]]; }, r => { steps(r, 0).push(structuredClone(steps(r, 0).at(-1))); },
    r => { steps(r, 2).splice(8, 6); }, r => { steps(r, 0)[1].pc = 1; }, r => { steps(r, 0)[1].op = "PUSH2"; },
    r => { steps(r, 6)[1].stack = ["0x21"]; }, r => { steps(r, 2)[7].stack[5] = "0xb104"; }, r => { steps(r, 2)[7].stack[6] = "0xc351"; },
    r => { steps(r, 0)[0].stack = ["0x0"]; }, r => { steps(r, 0)[2].stack.reverse(); steps(r, 0)[2].stack[0] = "0x1"; }]) rejects(change);
});

test("native frames are matched to each CALL in order; missing/extra/reordered frames and wrong contexts cannot be retired", () => {
  for (const change of [r => { native(r, 2).calls = []; }, r => { native(r, 7).calls.reverse(); }, r => { native(r, 0).calls = [structuredClone(native(r, 2).calls[0])]; },
    r => { native(r, 2).calls[0].to = native(r, 3).calls[0].to; }, r => { native(r, 2).calls[0].from = native(r, 2).from; },
    r => { native(r, 5).calls[0].type = "CALL"; }, r => { native(r, 2).calls[0].gas = "0xc351"; },
    r => { native(r, 2).calls[0].input = "0x00"; }, r => { native(r, 2).calls[0].value = "0x1"; }, r => { steps(r, 2)[8].depth = 1; }]) rejects(change);
});

test("call returns require immediate correct parent PC, success bit, stack and gas; native/root outcomes must match terminals", () => {
  for (const change of [r => { steps(r, 2)[14].stack = ["0x1"]; }, r => { steps(r, 3)[12].stack = ["0x0"]; },
    r => { steps(r, 2)[14].pc = 36; }, r => { steps(r, 2)[14].depth = 2; }, r => { steps(r, 2)[14].stack.push("0x0"); },
    r => { steps(r, 2)[14].gas += 387; }, r => { r.fixtures[1].opcodeTrace.failed = false; }, r => { delete native(r, 1).error; },
    r => { native(r, 0).error = "execution reverted"; }, r => { native(r, 2).calls[0].error = "StateChangeDuringStaticCall"; }]) rejects(change);
});

test("static fault wrappers are exact, never stripped; no ordinary/root/nonterminal fault or altered gas/result qualifies", () => {
  for (const literal of ["StateChangeDuringStaticCall", "Some(Some(StateChangeDuringStaticCall))", "Some(StateChangeDuringStaticCall) ", "Some(OutOfGas)", SENTINEL, null, {}]) rejects(r => { fault(r).error = literal; });
  for (const change of [r => { native(r, 4).calls[0].error = "execution reverted"; }, r => { delete native(r, 4).calls[0].error; },
    r => { fault(r).gasCost = 1; }, r => { native(r, 4).calls[0].gasUsed = "0xc34f"; }, r => { steps(r, 4)[10].stack = ["0x1"]; },
    r => { steps(r, 4).splice(10, 0, { pc: 5, op: "STOP", gas: 0, gasCost: 0, depth: 2, stack: [], memory: [] }); },
    r => { steps(r, 0)[2].error = "Some(StateChangeDuringStaticCall)"; native(r, 0).error = "StateChangeDuringStaticCall"; },
    r => { steps(r, 2)[10].error = "Some(StateChangeDuringStaticCall)"; native(r, 2).calls[0].error = "StateChangeDuringStaticCall"; },
    r => { delete fault(r).error; }]) rejects(change);
});

test("unsupported opcodes/creation/OOG/returndata and implicit or malformed terminals fail without partial output", () => {
  for (const op of ["LOG1", "LOG4", "MSTORE", "CREATE", "CALLCODE", "INVALID", "RETURN"]) rejects(r => { steps(r, 0)[2].op = op; });
  rejects(r => { native(r, 2).calls[0].type = "CREATE"; }); rejects(r => { native(r, 2).calls[0].error = "OutOfGas"; });
  rejects(r => { steps(r, 2)[9].error = "OutOfGas"; }); rejects(r => { steps(r, 0).at(-1).pc = 6; });
  rejects(r => { steps(r, 1).at(-1).stack = ["0x1", "0x0"]; }); rejects(r => { native(r, 7).calls[1].output = "0x01"; });
});

test("native log payload/emitter/topics/order/childposition and visibility must match independently reconstructed emissions", () => {
  for (const change of [r => { native(r, 0).logs = []; }, r => { native(r, 1).logs = []; }, r => { native(r, 0).logs.push(structuredClone(native(r, 0).logs[0])); },
    r => { native(r, 5).calls[0].logs[0].address = native(r, 5).calls[0].to; }, r => { native(r, 0).logs[0].topics = [`0x${"00".repeat(32)}`]; },
    r => { native(r, 0).logs[0].position = "0x1"; }, r => { delete native(r, 0).logs[0].position; }, r => { native(r, 0).logs[0].index = -1; },
    r => { native(r, 2).calls[0].logs = [structuredClone(native(r, 0).logs[0])]; }, r => { native(r, 4).calls[0].logs = [structuredClone(native(r, 0).logs[0])]; }]) rejects(change);
});

test("bounds/counts/lifecycle/isolation guards retain provenance caveats and do not accept enlarged profiles", () => {
  for (const change of [r => { r.bounds.requests++; }, r => { r.bounds.responseBytes++; }, r => { r.durationMs = 60001; }, r => { r.counts.requests = 101; },
    r => { r.counts.bytes = 67108865; }, r => { r.counts.bytes = 1; }, r => { r.counts.methods.debug_traceCall = 15; }, r => { r.counts.methods.eth_sendRawTransaction = 1; },
    r => { r.childExited = false; }, r => { r.watchdogTriggered = true; }, r => { r.childStarted = false; },
    r => { r.networkIsolation.upstreamConfigured = true; }, r => { r.networkIsolation.listenerPidVerified = false; }, r => { r.networkIsolation.osNetworkSandbox = true; },
    r => { r.localStateAssumptions.canonicalMerkleProof = true; }, r => { r.status = "PASSED"; }, r => { r.fixtures.pop(); },
    r => { while (steps(r, 7).length < 33) steps(r, 7).push(structuredClone(steps(r, 7)[0])); },
    r => { native(r, 7).calls.push(structuredClone(native(r, 7).calls[0])); },
    r => { native(r, 2).calls[0].calls = [structuredClone(native(r, 2).calls[0])]; }]) rejects(change);
});

test("malformed schemas, raw extras, accessors and cyclic records fail closed with sanitized fixed errors", () => {
  let accessed = 0;
  for (const change of [r => { steps(r, 0)[0].extra = SENTINEL; }, r => { native(r, 0).revertReason = SENTINEL; }, r => { steps(r, 0)[0].gas = "129000"; },
    r => { steps(r, 0)[1].stack = ["0x00"]; }, r => { steps(r, 0)[0].memory = null; }, r => { native(r, 0).calls = [native(r, 0)]; },
    r => { Object.defineProperty(r.fixtures[0], "opcodeTrace", { enumerable: true, get() { accessed++; throw new Error(SENTINEL); } }); }]) rejects(change);
  assert.equal(accessed, 0);
  assert.throws(() => recorder.analyzeSyntheticRun(input(), { trustTruth: true }), /^Error: invalid-synthetic-run$/);
});
