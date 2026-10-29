"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm"), util = require("node:util");
const codec = require("../strategy-study/compound-b-native-export-codec");
const { KINDS, CONFIGS, LIMITS, normalizeNativeExport: normalize, validateNativeExport: validate } = codec;
const A = byte => `0x${byte.repeat(20)}`, W = byte => `0x${byte.repeat(32)}`;
const SENTINEL = "SECRET_ENDPOINT_FAULT_SENTINEL";
const clone = value => structuredClone(value);
const step = () => ({ pc: 0, op: "STOP", depth: 1, gas: 1000, gasCost: 0, stack: [], memory: [] });
const opcode = () => ({ failed: false, gas: 21000, returnValue: "", structLogs: [step()] });
const frame = type => ({ type: type ?? "CALL", from: A("11"), to: A("22"), gas: "0x1000", gasUsed: "0x20", input: "0x" });
const log = () => ({ address: A("22"), topics: [W("33")], data: "0xabcd", position: "0x0", index: "0x0" });
const prestate = () => ({ [A("ab")]: { balance: "0x00", nonce: 0, code: "0x6001600055", storage: { "0x0": "0x0", "0x01": "0xff" } }, [A("cd")]: {} });
const diff = () => ({ pre: prestate(), post: { [A("ab")]: { storage: { "0x0": "0x1" } }, [A("ee")]: { code: "0x" } } });
function rejects(kind, raw, code = "invalid-schema", fn = normalize) {
  assert.throws(() => fn(kind, raw), error => {
    assert.equal(error.message, code); assert.equal(error.cause, undefined);
    assert.ok(!String(error.stack).includes(SENTINEL)); assert.deepEqual(Object.keys(error), []); return true;
  });
}
function frozen(value) {
  const todo = [value]; while (todo.length) { const v = todo.pop(); if (v && typeof v === "object") { assert.ok(Object.isFrozen(v)); todo.push(...Object.values(v)); } }
}

test("exact exports/configs/kinds, immutable limits and inert builtin-only import", () => {
  assert.deepEqual(Object.keys(codec), ["KINDS", "CONFIGS", "normalizeNativeExport", "validateNativeExport", "LIMITS"]);
  assert.deepEqual(KINDS, ["opcode", "call", "prestate", "diff"]); assert.equal(LIMITS.opcodeRecords, 500000);
  assert.deepEqual(CONFIGS, {
    opcode: { disableStack: false, disableStorage: true, enableMemory: true, enableReturnData: false, limit: 0, timeout: "10s" },
    call: { tracer: "callTracer", tracerConfig: { onlyTopCall: false, withLog: true }, timeout: "10s" },
    prestate: { tracer: "prestateTracer", tracerConfig: { diffMode: false, disableCode: false, disableStorage: false }, timeout: "10s" },
    diff: { tracer: "prestateTracer", tracerConfig: { diffMode: true, disableCode: false, disableStorage: false }, timeout: "10s" },
  });
  frozen(codec); for (const value of Object.values(LIMITS)) assert.ok(Number.isSafeInteger(value) && value > 0);
  const text = fs.readFileSync(path.resolve(__dirname, "../strategy-study/compound-b-native-export-codec.js"), "utf8"), imports = [];
  const context = vm.createContext({ module: { exports: {} }, require(name) { imports.push(name); assert.equal(name, "node:util"); return util; } });
  vm.runInContext(text, context); assert.deepEqual(imports, ["node:util"]);
  // No process, filesystem, network, environment, Buffer or signing globals.
  const result = vm.runInContext('module.exports.normalizeNativeExport("opcode", {failed:false,gas:0,returnValue:"",structLogs:[]})', context);
  assert.equal(JSON.stringify(result), '{"failed":false,"gas":"0","returnValue":"0x","structLogs":[]}');
});

for (const [kind, make] of [["opcode", opcode], ["call", frame], ["prestate", prestate], ["diff", diff]]) test(`${kind}: deterministic JSON-safe frozen canonical normalization and strict idempotence`, () => {
  const raw = make(), before = clone(raw), result = normalize(kind, raw);
  assert.deepEqual(raw, before); assert.equal(Object.isFrozen(raw), false); frozen(result);
  assert.deepEqual(normalize(kind, result), result); assert.deepEqual(validate(kind, result), result);
  assert.deepEqual(validate(kind, JSON.parse(JSON.stringify(result))), result);
  assert.deepEqual(normalize(kind, clone(raw)), result);
  for (const key of ["complete", "executionComplete", "stateProved", "validStudyAggregate", "routePositive", "metadataComplete", "committed", "indexDomain"]) assert.equal(Object.hasOwn(result, key), false);
  rejects(kind, raw, "invalid-schema", validate);
});

test("opcode canonicalizes only byte/integer representation, preserves rows and does not invent snapshots", () => {
  const raw = opcode(); raw.returnValue = "ABCD";
  raw.structLogs = [
    { pc: "0x00", op: "PUSH1", depth: "0x1", gas: "0x123", gasCost: "3", stack: ["0x0", "F".repeat(64)], memory: ["00".repeat(32), W("AB")] },
    { pc: 2, op: "MSTORE", depth: 1, gas: 288, gasCost: 3 },
    { pc: 3, op: "LOG4", depth: 1, gas: 285, gasCost: 1875, stack: [], memory: [] },
  ];
  const out = normalize("opcode", raw);
  assert.equal(out.returnValue, "0xabcd"); assert.equal(out.gas, "21000"); assert.equal(out.structLogs[0].pc, "0");
  assert.deepEqual(out.structLogs[0].stack, [W("00"), W("ff")]); assert.deepEqual(out.structLogs[0].memory, [W("00"), W("ab")]);
  assert.deepEqual(out.structLogs.map(s => s.op), ["PUSH1", "MSTORE", "LOG4"]);
  assert.equal(Object.hasOwn(out.structLogs[1], "stack"), false); assert.equal(Object.hasOwn(out.structLogs[1], "memory"), false);
  assert.deepEqual(out.structLogs[2].stack, []); assert.deepEqual(out.structLogs[2].memory, []);
  // Shape acceptance does not reconcile gas, stack effects or opcode outcomes.
  assert.equal(out.structLogs[2].gasCost, "1875");
});

test("opcode required logger fields are never defaulted and unknown/disabled dialect fields fail", () => {
  for (const field of ["failed", "gas", "returnValue", "structLogs"]) { const raw = opcode(); delete raw[field]; rejects("opcode", raw); }
  for (const field of ["pc", "op", "depth", "gas", "gasCost"]) { const raw = opcode(); delete raw.structLogs[0][field]; rejects("opcode", raw); }
  for (const field of ["storage", "returnData", "memorySize", "refund", "refundCounter", "errorText"]) {
    const raw = opcode(); raw.structLogs[0][field] = {}; rejects("opcode", raw);
  }
  for (const extra of [{ truncated: true }, { timeout: true }, { error: "out of gas" }, { result: opcode() }]) rejects("opcode", { ...opcode(), ...extra });
  for (const value of [null, {}, "0x"]) for (const field of ["stack", "memory"]) { const raw = opcode(); raw.structLogs[0][field] = value; rejects("opcode", raw); }
});

test("known opcode symbols retain their literal dialect; malformed, future, dynamic and lowercase names fail", () => {
  for (const op of ["PUSH0", "PUSH32", "DUP16", "SWAP16", "LOG0", "LOG4", "MCOPY", "TLOAD", "TSTORE", "BLOBHASH", "BLOBBASEFEE", "SHA3", "KECCAK256", "DIFFICULTY", "PREVRANDAO", "INVALID"]) {
    const raw = opcode(); raw.structLogs[0].op = op; assert.equal(normalize("opcode", raw).structLogs[0].op, op);
  }
  for (const op of ["", "stop", "PUSH33", "DUP0", "LOG5", "RJUMP", "opcode 0xaa not defined", SENTINEL, 0]) { const raw = opcode(); raw.structLogs[0].op = op; rejects("opcode", raw); }
});

test("faults retain exact recognized literals only, never arbitrary text, hashes or generic Option rewriting", () => {
  for (const error of ["execution reverted", "Revert", "out of gas", "OutOfGas", "write protection", "StateChangeDuringStaticCall", "Some(StateChangeDuringStaticCall)"]) {
    const raw = opcode(); raw.structLogs[0].error = error; raw.failed = true;
    assert.equal(normalize("opcode", raw).structLogs[0].error, error);
    assert.equal(normalize("call", { ...frame(), error }).error, error);
  }
  for (const error of ["", null, {}, SENTINEL, `execution reverted: ${SENTINEL}`, "Some(OutOfGas)", "Some(Some(StateChangeDuringStaticCall))", " execution reverted", "stack underflow (0 <=> 2)"]) {
    const raw = opcode(); raw.structLogs[0].error = error; rejects("opcode", raw); rejects("call", { ...frame(), error });
  }
  for (const revertReason of ["", "execution reverted", SENTINEL, null]) rejects("call", { ...frame(), error: "execution reverted", revertReason });
});

test("call topology, types, child/log ordering and original index meaning survive without inferred commitment", () => {
  const raw = { ...frame(), value: "0x0", output: "0x", calls: [frame("DELEGATECALL"), { ...frame("STATICCALL"), error: "execution reverted" }],
    logs: [{ ...log(), index: "0x10", position: 7 }, { ...log(), index: 0, position: "0x2" }] };
  raw.calls[1].logs = [{ ...log(), index: "9007199254740993" }];
  const out = normalize("call", raw);
  assert.deepEqual(out.calls.map(c => c.type), ["DELEGATECALL", "STATICCALL"]);
  assert.deepEqual(out.logs.map(l => [l.index, l.position]), [["16", "7"], ["0", "2"]]); // no bound to children or offset conversion
  assert.equal(out.calls[1].logs[0].index, "9007199254740993"); assert.equal(out.calls[1].error, "execution reverted");
  assert.equal(Object.hasOwn(out.calls[1].logs[0], "committed"), false); assert.equal(out.value, "0");
  const noMetadata = { address: A("22"), topics: [], data: "0x" };
  const minimal = normalize("call", { ...frame(), logs: [noMetadata] }).logs[0];
  assert.equal(Object.hasOwn(minimal, "index"), false); assert.equal(Object.hasOwn(minimal, "position"), false);
});

test("call absent value/output/children/logs are distinct from zero, empty bytes and empty lists", () => {
  const omitted = normalize("call", frame()), explicit = normalize("call", { ...frame(), value: 0, output: "", calls: [], logs: [] });
  for (const key of ["value", "output", "calls", "logs"]) assert.equal(Object.hasOwn(omitted, key), false);
  assert.equal(explicit.value, "0"); assert.equal(explicit.output, "0x"); assert.deepEqual(explicit.calls, []); assert.deepEqual(explicit.logs, []);
  assert.notDeepEqual(omitted, explicit);
  for (const key of ["value", "output", "calls", "logs", "error"]) rejects("call", { ...frame(), [key]: null });
});

test("call required fields and explicit failed-creation address omission/null; no successful address invented", () => {
  for (const key of ["type", "from", "gas", "gasUsed", "input", "to"]) { const f = frame(); delete f[key]; rejects("call", f); }
  for (const type of ["CALL", "STATICCALL", "DELEGATECALL", "CALLCODE", "CREATE", "CREATE2", "SELFDESTRUCT"]) assert.equal(normalize("call", frame(type)).type, type);
  for (const type of ["call", "SUICIDE", "AUTHCALL", SENTINEL]) rejects("call", frame(type));
  for (const type of ["CREATE", "CREATE2"]) {
    const failed = { ...frame(type), error: "out of gas" }; delete failed.to;
    assert.equal(Object.hasOwn(normalize("call", failed), "to"), false);
    assert.equal(normalize("call", { ...failed, to: null }).to, null);
    delete failed.error; rejects("call", failed); rejects("call", { ...failed, to: null });
  }
  rejects("call", { ...frame(), to: null });
});

test("prestate preserves full public code/storage and empty accounts; missing, zero and empty are never conflated", () => {
  const out = normalize("prestate", prestate());
  assert.deepEqual(out[A("ab")], { balance: "0", nonce: "0", code: "0x6001600055", storage: { [W("00")]: W("00"), [`0x${"00".repeat(31)}01`]: `0x${"00".repeat(31)}ff` } });
  assert.deepEqual(out[A("cd")], {});
  const explicit = normalize("prestate", { [A("cd")]: { balance: 0, nonce: "0x0", code: "", storage: {} } });
  assert.notDeepEqual(out[A("cd")], explicit[A("cd")]);
  assert.deepEqual(normalize("prestate", {}), {});
  for (const field of ["balance", "nonce", "code", "storage"]) rejects("prestate", { [A("11")]: { [field]: null } });
  for (const field of ["codeHash", "exists", "deleted", "storageHash", "proof", SENTINEL]) rejects("prestate", { [A("11")]: { [field]: W("00") } });
});

test("pre/post diff remains separate and sparse, preserving changed code and untouched/missing state distinctions", () => {
  const out = normalize("diff", diff());
  assert.deepEqual(Object.keys(out), ["pre", "post"]); assert.equal(out.pre[A("ab")].code, "0x6001600055");
  assert.equal(Object.hasOwn(out.post[A("ab")], "code"), false); assert.equal(out.post[A("ee")].code, "0x");
  assert.equal(Object.hasOwn(out.pre, A("ee")), false); assert.equal(Object.hasOwn(out.post, A("cd")), false);
  assert.equal(out.pre[A("ab")].storage[W("00")], W("00")); assert.equal(out.post[A("ab")].storage[W("00")], `0x${"00".repeat(31)}01`);
  assert.deepEqual(normalize("diff", { pre: {}, post: {} }), { pre: {}, post: {} });
  for (const raw of [{ pre: {} }, { post: {} }, {}, { pre: {}, post: {}, extra: true }, { pre: null, post: {} }, { pre: {}, post: [] }]) rejects("diff", raw);
});

test("address/storage byte canonicalization retains insertion order and rejects normalized key collisions", () => {
  const upper = `0x${"AB".repeat(20)}`, out = normalize("prestate", { [A("cd")]: {}, [upper]: { storage: { "0xAB": "0xF", "0x0": "0x0" } } });
  assert.deepEqual(Object.keys(out), [A("cd"), A("ab")]);
  assert.deepEqual(Object.keys(out[A("ab")].storage), [`0x${"00".repeat(31)}ab`, W("00")]);
  rejects("prestate", { [A("ab")]: {}, [upper]: {} });
  rejects("prestate", { [A("11")]: { storage: { "0x0": "0x1", [W("00")]: "0x2" } } });
  rejects("prestate", { [SENTINEL]: {} }); rejects("prestate", { [A("11")]: { storage: { [SENTINEL]: "0x0" } } });
});

test("only exact finite unsigned integers are admitted; uint64 and uint256 maxima retain precision", () => {
  const u64 = ((1n << 64n) - 1n).toString(), u256 = ((1n << 256n) - 1n).toString();
  const out = normalize("prestate", { [A("11")]: { nonce: u64, balance: u256 } }); assert.equal(out[A("11")].nonce, u64); assert.equal(out[A("11")].balance, u256);
  for (const gas of [-1, -0, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, true, null, 1n, "-1", "01", "1e3", "1.0", "0x", "0X1", " 1", ((1n << 64n)).toString()]) rejects("call", { ...frame(), gas });
  rejects("prestate", { [A("11")]: { balance: (1n << 256n).toString() } });
  for (const gas of [7, "7", "0x7", "0x0007"]) assert.equal(normalize("call", { ...frame(), gas }).gas, "7");
});

test("public byte encodings are exact, bounded and never guessed from malformed memory/stack/code", () => {
  for (const input of [null, 0, {}, "0x0", "0xgg", "0X00", SENTINEL]) rejects("call", { ...frame(), input });
  rejects("call", { ...frame(), from: W("11") }); rejects("call", { ...frame(), to: "0x11" });
  for (const item of ["", "0x", "1", `0x${"11".repeat(33)}`, null]) { const raw = opcode(); raw.structLogs[0].stack = [item]; rejects("opcode", raw); }
  for (const item of ["0x0", "00", `0x${"11".repeat(33)}`, null]) { const raw = opcode(); raw.structLogs[0].memory = [item]; rejects("opcode", raw); }
  const raw = opcode(); raw.structLogs[0].memory = ["00".repeat(32)]; assert.equal(normalize("opcode", raw).structLogs[0].memory[0], W("00"));
});

test("closed allowlists reject JSON-RPC envelopes, raw error objects and authority additions atomically", () => {
  for (const [kind, make] of [["opcode", opcode], ["call", frame], ["prestate", prestate], ["diff", diff]]) {
    for (const raw of [{ jsonrpc: "2.0", id: 1, result: make() }, { error: { code: -32000, message: SENTINEL } }, { ...make(), complete: true }]) rejects(kind, raw);
  }
  const raw = opcode(); raw.structLogs.push({ ...step(), error: SENTINEL }); const before = clone(raw); rejects("opcode", raw); assert.deepEqual(raw, before);
  const call = { ...frame(), calls: [frame(), { ...frame(), logs: [{ ...log(), receiptIndex: 0 }] }] }; rejects("call", call);
});

test("canonical validator rejects equivalent but noncanonical values without normalizing them silently", () => {
  const c = normalize("call", { ...frame(), logs: [log()] });
  for (const changed of [{ ...c, gas: Number(c.gas) }, { ...c, gas: "0x1000" }, { ...c, input: "" }, { ...c, from: `0x${"AB".repeat(20)}` }]) rejects("call", changed, "invalid-schema", validate);
  rejects("prestate", { [A("ab")]: { storage: { "0x0": W("00") } } }, "invalid-schema", validate);
  const op = normalize("opcode", opcode()), noncanonical = clone(op); noncanonical.structLogs[0].pc = 0; rejects("opcode", noncanonical, "invalid-schema", validate);
  const reordered = Object.fromEntries(Object.entries(c).reverse()); assert.deepEqual(validate("call", reordered), c); // object member order is not trace order
});

test("all getters, toJSON hooks, custom prototypes and nested accessors fail before execution", () => {
  let calls = 0; const getter = () => { calls++; throw new Error(SENTINEL); };
  const getterFrame = frame(); Object.defineProperty(getterFrame, "gas", { enumerable: true, get: getter }); rejects("call", getterFrame);
  const hidden = frame(); Object.defineProperty(hidden, "secret", { get: getter }); rejects("call", hidden);
  rejects("call", { ...frame(), toJSON: getter });
  const inherited = Object.assign(Object.create({ toJSON: getter }), frame()); rejects("call", inherited);
  const raw = opcode(), stack = []; Object.defineProperty(stack, "0", { enumerable: true, get: getter }); raw.structLogs[0].stack = stack; rejects("opcode", raw);
  const account = {}; Object.defineProperty(account, "code", { enumerable: true, get: getter }); rejects("prestate", { [A("11")]: account });
  const state = {}; Object.defineProperty(state, A("11"), { enumerable: true, get: getter }); rejects("prestate", state);
  const items = [frame()]; items.map = getter; rejects("call", { ...frame(), calls: items });
  assert.equal(calls, 0);
});

test("proxies including revoked/nested proxies are rejected without invoking any traps", () => {
  let traps = 0;
  const trap = () => { traps++; throw new Error(SENTINEL); };
  const handler = { get: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap };
  rejects("call", new Proxy(frame(), handler)); rejects("call", { ...frame(), calls: new Proxy([], handler) });
  rejects("call", { ...frame(), calls: [new Proxy(frame(), handler)] });
  rejects("prestate", { [A("11")]: new Proxy({}, handler) });
  rejects("prestate", { [A("11")]: { storage: new Proxy({}, handler) } });
  const revoked = Proxy.revocable({}, handler); revoked.revoke(); rejects("call", revoked.proxy);
  assert.equal(traps, 0);
});

test("cycles, symbols, sparse/custom arrays and nonplain records are not JSON result shapes", () => {
  const cyclic = frame(); cyclic.calls = [cyclic]; rejects("call", cyclic);
  const cyc2 = frame(); cyc2.calls = [frame()]; cyc2.calls[0].calls = [cyc2]; rejects("call", cyc2);
  const symbolic = { ...frame(), [Symbol(SENTINEL)]: true }; rejects("call", symbolic);
  rejects("call", { ...frame(), calls: Array(1) });
  const a = [frame()]; a[Symbol.iterator] = () => { throw new Error(SENTINEL); }; rejects("call", { ...frame(), calls: a });
  class CustomArray extends Array {} rejects("call", { ...frame(), calls: new CustomArray() });
  for (const raw of [null, undefined, [], new Date(), new Map(), new String(SENTINEL)]) rejects("call", raw);
  const shared = frame(); assert.equal(normalize("call", { ...frame(), calls: [shared, shared] }).calls.length, 2); // no false cycle detection for sibling values
});

test("opcode bound is exactly 500000 rows and oversized arrays fail before reading elements", () => {
  const minimal = { pc: 0, op: "STOP", depth: 1, gas: 0, gasCost: 0 };
  const out = normalize("opcode", { failed: false, gas: 0, returnValue: "", structLogs: Array(LIMITS.opcodeRecords).fill(minimal) });
  assert.equal(out.structLogs.length, 500000); assert.equal(out.structLogs.at(-1).pc, "0");
  const rows = Array(LIMITS.opcodeRecords + 1); let touched = false;
  Object.defineProperty(rows, "0", { enumerable: true, get() { touched = true; throw new Error(SENTINEL); } });
  rejects("opcode", { ...opcode(), structLogs: rows }, "trace-limit-exceeded"); assert.equal(touched, false);
});

test("depth, stack, memory, topics and call-frame/log ceilings are finite and enforced", () => {
  for (const [field, length] of [["stack", LIMITS.stack + 1], ["memory", LIMITS.memoryWords + 1]]) {
    const raw = opcode(); raw.structLogs[0][field] = Array(length); rejects("opcode", raw, "trace-limit-exceeded");
  }
  const good = opcode(); good.structLogs[0].stack = Array(LIMITS.stack).fill("0x0"); assert.equal(normalize("opcode", good).structLogs[0].stack.length, LIMITS.stack);
  const tooDeep = opcode(); tooDeep.structLogs[0].depth = LIMITS.depth + 1; rejects("opcode", tooDeep, "trace-limit-exceeded");
  const zero = opcode(); zero.structLogs[0].depth = 0; rejects("opcode", zero);
  rejects("call", { ...frame(), calls: Array(LIMITS.frames + 1) }, "trace-limit-exceeded");
  rejects("call", { ...frame(), logs: Array(LIMITS.logs + 1) }, "trace-limit-exceeded");
  rejects("call", { ...frame(), logs: [{ ...log(), topics: Array(5).fill(W("00")) }] }, "trace-limit-exceeded");
  let root = frame(); for (let i = 1; i < LIMITS.depth; i++) root = { ...frame(), calls: [root] };
  const result = normalize("call", root); let depth = 1, row = result; while (row.calls) { row = row.calls[0]; depth++; } assert.equal(depth, 1024);
  assert.doesNotThrow(() => validate("call", result)); rejects("call", { ...frame(), calls: [root] }, "trace-limit-exceeded");
});

test("global frame/log totals cannot be bypassed through separate child arrays", () => {
  const shared = frame(); rejects("call", { ...frame(), calls: Array(LIMITS.frames).fill(shared) }, "trace-limit-exceeded");
  const logs = Array(Math.floor(LIMITS.logs / 2) + 1).fill({ address: A("11"), topics: [], data: "0x" });
  rejects("call", { ...frame(), calls: [{ ...frame(), logs }, { ...frame(), logs }] }, "trace-limit-exceeded");
});

test("account/storage budgets count both diff sides and nested maps, not just individual object sizes", () => {
  const accounts = {};
  for (let i = 0; i <= LIMITS.accounts; i++) accounts[`0x${i.toString(16).padStart(40, "0")}`] = {};
  rejects("prestate", accounts, "trace-limit-exceeded");
  delete accounts[`0x${LIMITS.accounts.toString(16).padStart(40, "0")}`];
  rejects("diff", { pre: accounts, post: { [A("ff")]: {} } }, "trace-limit-exceeded");
  const slots = {}; for (let i = 0; i <= LIMITS.storageSlots; i++) slots[`0x${i.toString(16)}`] = "0x0";
  rejects("prestate", { [A("11")]: { storage: slots } }, "trace-limit-exceeded");
  delete slots[`0x${LIMITS.storageSlots.toString(16)}`];
  rejects("diff", { pre: { [A("11")]: { storage: slots } }, post: { [A("11")]: { storage: { "0x0": "0x0" } } } }, "trace-limit-exceeded");
});

test("individual public byte and normalized aggregate ceilings stop expansion without increasing RPC scope", () => {
  const oversized = `0x${"00".repeat(LIMITS.dataBytes + 1)}`;
  rejects("call", { ...frame(), input: oversized }, "trace-limit-exceeded");
  rejects("call", { ...frame(), input: oversized.slice(2) }, "trace-limit-exceeded");
  rejects("prestate", { [A("11")]: { code: oversized } }, "trace-limit-exceeded");
  const max = `0x${"00".repeat(LIMITS.codeBytes)}`;
  assert.equal(normalize("prestate", { [A("11")]: { code: max } })[A("11")].code.length, max.length);
  rejects("prestate", { [A("11")]: { code: max }, [A("22")]: { code: max }, [A("33")]: { code: max }, [A("44")]: { code: max } }, "trace-limit-exceeded");
});

test("invalid kinds/extra arguments/config overrides and canonical authority tampering fail fixed codes", () => {
  for (const kind of [null, "CALL", "native", SENTINEL, {}, 0]) rejects(kind, frame());
  assert.throws(() => normalize("call", frame(), CONFIGS.call), /^Error: invalid-schema$/);
  assert.throws(() => validate("prestate", {}, { allowUnknown: true }), /^Error: invalid-schema$/);
  for (const kind of KINDS) {
    const fixtures = { opcode: opcode(), call: frame(), prestate: prestate(), diff: diff() };
    const out = clone(normalize(kind, fixtures[kind])); out.executionComplete = true; rejects(kind, out, "invalid-schema", validate);
  }
});
